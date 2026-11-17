// The Admin Console's settings book (contract AC-1 revision 4, I14): console.json `settings` with the compliance
// profile (3.3), the two-person setting (3.7), the sign-in and session values (3.3, 3.4), the login banner (3.4), the
// approved security keys (3.3), email without secrets (3.11), the seat request address (2.4) and the links to other
// consoles (2.1); the rights a session holds by profile (2.3); and the Settings routes of 4.2.

use crate::codec::{exact_keys, str_of};
use crate::console::{ApiError, Console, Done, Out};
use crate::console_auth::{clean, reason_of, Inner, PersonRole, Who};
use crate::console_limits::{Limit, MINUTE};
use crate::console_mail::{parse_mailbox, MailConfig, Mode};
use crate::log::{Fields, Level};
use serde_json::{json, Value};

/// The publisher's address for seat requests, compiled in from the release config (2.4). Until the publisher
/// address is decided it defaults to the internal test address (R41-2); a customer release must set
/// LUCID_LICENSE_REQUEST_TO to the approved publisher mailbox (tests/release_request_to.rs, R6-M3).
pub const LICENSE_REQUEST_TO: &str = match option_env!("LUCID_LICENSE_REQUEST_TO") {
    Some(v) => v,
    None => "enrique.mertins@gmail.com",
};
pub const BANNER_MAX: usize = 2000;
pub const AAGUIDS_MAX: usize = 50;
pub const LINKS_MAX: usize = 4;
/// High: fixed at the 800-63B-4 AAL3 values (3.4).
pub const HIGH_IDLE_MINUTES: i64 = 15;
pub const HIGH_MAX_HOURS: i64 = 12;
pub const IDLE_MINUTES: std::ops::RangeInclusive<i64> = 5..=60;
pub const MAX_HOURS: std::ops::RangeInclusive<i64> = 1..=24;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Profile {
    High,
    Standard,
}

impl Profile {
    pub fn as_str(self) -> &'static str {
        match self {
            Profile::High => "high",
            Profile::Standard => "standard",
        }
    }

    pub fn parse(s: &str) -> Option<Profile> {
        match s {
            "high" => Some(Profile::High),
            "standard" => Some(Profile::Standard),
            _ => None,
        }
    }
}

/// 3.1: a `--console-profile` other than standard or high refuses the start (Remote Spokes; Meeting Hub's
/// `console_profile` has its own words in meet.rs).
pub const PROFILE_FLAG_BAD: &str = "--console-profile must be standard or high";

/// What a start did with `--console-profile` or `console_profile` (3.3, R41-3).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ProfileAtStart {
    /// Not bootstrapped: written into the book; true when that changed it.
    Written(bool),
    /// Bootstrapped: ignored; true when it was given and differs from the profile in force (`cli.profile-ignored`).
    Ignored(bool),
}

/// The `<flag>` of `cli.profile-ignored`: the product's name for the setting.
pub fn profile_flag(product: crate::license::Product) -> &'static str {
    match product {
        crate::license::Product::Spokes => "--console-profile",
        crate::license::Product::Meet => "console_profile",
    }
}

/// 8.1 `cli.profile-ignored`: the start log (info) on a bootstrapped console whose flag or field differs from the
/// profile in force.
pub fn profile_ignored_words(flag: &str) -> String {
    format!("The Admin Console is already set up, so {flag} is ignored. Change the security profile in Settings, Security.")
}

/// The rights a session holds (2.3), recomputed at every request.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub enum Rights {
    Viewer,
    Manager,
    Admin,
}

impl Rights {
    pub fn as_str(self) -> &'static str {
        match self {
            Rights::Admin => "admin",
            Rights::Manager => "user-manager",
            Rights::Viewer => "viewer",
        }
    }

    /// The rights a role gives in full.
    pub fn of_role(role: PersonRole) -> Rights {
        match role {
            PersonRole::Admin => Rights::Admin,
            PersonRole::UserManager => Rights::Manager,
            PersonRole::Viewer => Rights::Viewer,
        }
    }
}

/// What console.json keeps under `settings`.
#[derive(Clone, Debug)]
pub struct Settings {
    /// Standard unless set up as a government deployment (3.3, R41-3).
    pub profile: Profile,
    /// Latched by a move from High to Standard in Settings, cleared by Standard to High (R41-3); the only trigger of the
    /// standing `profile-standard` item. A profile written from the flag or field before bootstrap never sets it.
    pub downgraded: bool,
    pub two_person: bool,
    pub require_password: bool,
    /// Standard only; High uses 15 minutes and 12 hours.
    pub idle_minutes: i64,
    pub max_hours: i64,
    pub banner: Option<String>,
    /// (AAGUID lower-case hyphenated, description).
    pub aaguids: Vec<(String, String)>,
    /// `MailConfig::to_settings`, never a secret.
    pub email: Value,
    /// None: the build's default (LICENSE_REQUEST_TO).
    pub license_request_to: Option<String>,
    /// Other consoles (2.1): label and https URL.
    pub links: Vec<(String, String)>,
    /// AC-2a 10.1: the scrape tokens (`fleet_export::TokenRecord::to_json`, hashes and hints only).
    pub tokens: Vec<Value>,
    /// AC-2a 10.2: the SIEM settings in force (`fleet_syslog::SiemSettings::to_json`, no key), null when off.
    pub siem: Value,
    /// AC-2a 10.1: CIDRs that may call `/metrics` (None: the console's `--metrics-sources` or `--sources`).
    pub metrics_sources: Option<String>,
}

/// One setup step's state (AC-2a 12.3).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum StepState {
    Open,
    Done,
    Skipped,
}

impl StepState {
    pub fn as_str(self) -> &'static str {
        match self {
            StepState::Open => "open",
            StepState::Done => "done",
            StepState::Skipped => "skipped",
        }
    }

    pub fn parse(s: &str) -> Option<StepState> {
        match s {
            "open" => Some(StepState::Open),
            "done" => Some(StepState::Done),
            "skipped" => Some(StepState::Skipped),
            _ => None,
        }
    }
}

/// The steps of 12.2 kept on the server after bootstrap, in order.
pub const SETUP_STEPS: [&str; 4] = ["signin", "email", "license", "relay"];

/// `console.json` `setup` (AC-2a 12.3): `{steps: {signin, email, license, relay}, hidden}`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Setup {
    pub steps: [StepState; 4],
    pub hidden: bool,
}

impl Default for Setup {
    fn default() -> Setup {
        Setup { steps: [StepState::Open; 4], hidden: false }
    }
}

impl Setup {
    pub fn get(&self, step: &str) -> Option<StepState> {
        SETUP_STEPS.iter().position(|s| *s == step).map(|i| self.steps[i])
    }

    /// Set a step; false for an unknown step.
    pub fn set(&mut self, step: &str, state: StepState) -> bool {
        match SETUP_STEPS.iter().position(|s| *s == step) {
            Some(i) => {
                self.steps[i] = state;
                true
            }
            None => false,
        }
    }

    /// A step done by its own success (12.3); a skipped or open step becomes done, never the other way.
    pub fn done(&mut self, step: &str) -> bool {
        let before = self.get(step);
        self.set(step, StepState::Done) && before != Some(StepState::Done)
    }

    /// The first step still open (an admin lands there after sign-in).
    pub fn first_open(&self) -> Option<&'static str> {
        SETUP_STEPS.iter().zip(self.steps.iter()).find(|(_, s)| **s == StepState::Open).map(|(n, _)| *n)
    }

    /// The "Finish setup" checklist shows (and `setup-unfinished` is raised) while a step is open or skipped and the
    /// checklist is not hidden.
    pub fn unfinished(&self) -> bool {
        !self.hidden && self.steps.iter().any(|s| *s != StepState::Done)
    }

    pub fn steps_value(&self) -> Value {
        let mut o = serde_json::Map::new();
        for (n, s) in SETUP_STEPS.iter().zip(self.steps.iter()) {
            o.insert((*n).to_owned(), Value::from(s.as_str()));
        }
        Value::Object(o)
    }

    pub fn to_value(&self) -> Value {
        json!({ "steps": self.steps_value(), "hidden": self.hidden })
    }

    pub fn from_value(v: &Value) -> Option<Setup> {
        let o = v.as_object()?;
        if !exact_keys(o, &["steps", "hidden"], &["steps", "hidden"]) {
            return None;
        }
        let steps = o.get("steps")?.as_object()?;
        if !exact_keys(steps, &SETUP_STEPS, &SETUP_STEPS) {
            return None;
        }
        let mut s = Setup { hidden: o.get("hidden")?.as_bool()?, ..Setup::default() };
        for (i, n) in SETUP_STEPS.iter().enumerate() {
            s.steps[i] = StepState::parse(str_of(steps.get(*n))?)?;
        }
        Some(s)
    }
}

impl Default for Settings {
    fn default() -> Settings {
        Settings {
            profile: Profile::Standard,
            downgraded: false,
            two_person: false,
            require_password: false,
            idle_minutes: HIGH_IDLE_MINUTES,
            max_hours: HIGH_MAX_HOURS,
            banner: None,
            aaguids: Vec::new(),
            email: MailConfig::off().to_settings(),
            license_request_to: None,
            links: Vec::new(),
            tokens: Vec::new(),
            siem: Value::Null,
            metrics_sources: None,
        }
    }
}

impl Settings {
    pub fn high(&self) -> bool {
        self.profile == Profile::High
    }

    /// The standing `profile-standard` item (3.3, R41-3): only while the profile is Standard and `downgraded` is
    /// latched, so a console that started in Standard never shows it.
    pub fn profile_standard_item(&self) -> bool {
        !self.high() && self.downgraded
    }

    /// The profile at start (3.3 "Which profile a console starts in", R41-3). `given` is `--console-profile` or
    /// `console_profile` (None when not given: Standard). Not bootstrapped (or the upgrade start of a book from before
    /// AC-1): the profile is written from it and `downgraded` cleared, never a downgrade. Bootstrapped: ignored.
    pub fn profile_at_start(&mut self, given: Option<Profile>, bootstrapped: bool) -> ProfileAtStart {
        if bootstrapped {
            return ProfileAtStart::Ignored(given.is_some_and(|p| p != self.profile));
        }
        let profile = given.unwrap_or(Profile::Standard);
        let changed = self.profile != profile || self.downgraded;
        self.profile = profile;
        self.downgraded = false;
        ProfileAtStart::Written(changed)
    }

    pub fn idle_ms(&self) -> i64 {
        if self.high() {
            HIGH_IDLE_MINUTES * MINUTE
        } else {
            self.idle_minutes * MINUTE
        }
    }

    pub fn max_ms(&self) -> i64 {
        if self.high() {
            HIGH_MAX_HOURS * 60 * MINUTE
        } else {
            self.max_hours * 60 * MINUTE
        }
    }

    pub fn idle_minutes_now(&self) -> i64 {
        self.idle_ms() / MINUTE
    }

    pub fn max_hours_now(&self) -> i64 {
        self.max_ms() / (60 * MINUTE)
    }

    /// The `password` field of `login/begin` (3.3): from the profile and settings alone, the same for every email.
    pub fn password_field(&self) -> &'static str {
        match (self.profile, self.require_password) {
            (_, true) => "required",
            (Profile::High, false) => "none",
            (Profile::Standard, false) => "offered",
        }
    }

    /// The approved AAGUIDs (I11).
    pub fn aaguid_list(&self) -> Vec<String> {
        self.aaguids.iter().map(|(a, _)| a.clone()).collect()
    }

    pub fn license_request_to(&self) -> Option<String> {
        self.license_request_to.clone().or_else(|| Some(LICENSE_REQUEST_TO.to_owned())).filter(|s| !s.is_empty())
    }

    pub fn links_value(&self) -> Value {
        Value::Array(self.links.iter().map(|(l, u)| json!({ "label": l, "url": u })).collect())
    }

    pub fn to_value(&self) -> Value {
        let mut v = self.to_value_ac1();
        // A fleet console's exports (AC-2a 10): only when any is set, so an AC-1 book keeps its exact shape.
        if !self.tokens.is_empty() || !self.siem.is_null() || self.metrics_sources.is_some() {
            v["exports"] = json!({ "tokens": self.tokens, "siem": self.siem, "metricsSources": self.metrics_sources });
        }
        v
    }

    fn to_value_ac1(&self) -> Value {
        json!({
            "profile": self.profile.as_str(),
            "downgraded": self.downgraded,
            "twoPerson": if self.two_person { "on" } else { "off" },
            "signIn": { "requirePassword": self.require_password, "idleMinutes": self.idle_minutes, "maxHours": self.max_hours },
            "banner": self.banner,
            "aaguids": self.aaguids.iter().map(|(a, d)| json!({ "aaguid": a, "description": d })).collect::<Vec<_>>(),
            "email": self.email,
            "licenseRequestTo": self.license_request_to,
            "links": self.links_value(),
        })
    }

    /// Back from console.json; None when it does not read (the book is then unreadable).
    pub fn from_value(v: &Value) -> Option<Settings> {
        let o = v.as_object()?;
        let sign_in = o.get("signIn")?.as_object()?;
        let mut s = Settings {
            profile: Profile::parse(str_of(o.get("profile"))?)?,
            // A book written before revision 4.1 has no `downgraded`: never latched.
            downgraded: match o.get("downgraded") {
                None => false,
                Some(v) => v.as_bool()?,
            },
            two_person: match str_of(o.get("twoPerson"))? {
                "on" => true,
                "off" => false,
                _ => return None,
            },
            require_password: sign_in.get("requirePassword")?.as_bool()?,
            idle_minutes: sign_in.get("idleMinutes")?.as_i64()?,
            max_hours: sign_in.get("maxHours")?.as_i64()?,
            banner: str_of(o.get("banner")).map(str::to_owned),
            email: o.get("email").cloned().unwrap_or_else(|| MailConfig::off().to_settings()),
            license_request_to: str_of(o.get("licenseRequestTo")).map(str::to_owned),
            ..Settings::default()
        };
        if !IDLE_MINUTES.contains(&s.idle_minutes) || !MAX_HOURS.contains(&s.max_hours) {
            return None;
        }
        for a in o.get("aaguids")?.as_array()? {
            s.aaguids.push((str_of(a.get("aaguid"))?.to_owned(), str_of(a.get("description")).unwrap_or("").to_owned()));
        }
        for l in o.get("links")?.as_array()? {
            s.links.push((str_of(l.get("label"))?.to_owned(), str_of(l.get("url"))?.to_owned()));
        }
        if let Some(x) = o.get("exports") {
            let x = x.as_object()?;
            s.tokens = x.get("tokens")?.as_array()?.clone();
            s.siem = x.get("siem").cloned().unwrap_or(Value::Null);
            s.metrics_sources = str_of(x.get("metricsSources")).map(str::to_owned);
        }
        Some(s)
    }
}

/// The rights a session of `role` holds (2.3): under High an admin or user manager whose session method is not an
/// attested hardware authenticator holds viewer rights ("not-attested"); a Meeting Hub admin whose session method does
/// not carry the device anchor holds viewer rights ("not-device-anchored"). The break-glass account is the one
/// exception to the device anchor (anchor "operator").
pub fn rights_of(role: PersonRole, high: bool, attested: bool, device_ok: bool, break_glass: bool) -> (Rights, Option<&'static str>) {
    let full = Rights::of_role(role);
    if full == Rights::Viewer {
        return (Rights::Viewer, None);
    }
    if high && !attested {
        return (Rights::Viewer, Some("not-attested"));
    }
    if role == PersonRole::Admin && !device_ok && !break_glass {
        return (Rights::Viewer, Some("not-device-anchored"));
    }
    (full, None)
}

/// A banner (3.4): 0 to 2,000 characters, cleaned, line breaks kept. None when empty.
pub fn banner_of(text: &str) -> Result<Option<String>, ApiError> {
    let lines: Vec<String> = text.replace("\r\n", "\n").split('\n').map(clean).collect();
    let kept = lines.join("\n").trim().to_owned();
    if kept.chars().count() > BANNER_MAX {
        return Err(ApiError::with("invalid", "The banner holds at most 2,000 characters."));
    }
    Ok(Some(kept).filter(|s| !s.is_empty()))
}

/// An AAGUID as the list keeps it: 36 characters, lower-case hex, hyphens at 8, 13, 18 and 23.
pub fn aaguid_of(s: &str) -> Option<String> {
    let s = s.trim().to_ascii_lowercase();
    let ok = s.len() == 36 && s.char_indices().all(|(i, c)| if matches!(i, 8 | 13 | 18 | 23) { c == '-' } else { c.is_ascii_hexdigit() });
    ok.then_some(s)
}

/// Links to other consoles (2.1): at most 4, https only, a host named.
pub fn links_of(params: &Value) -> Result<Vec<(String, String)>, ApiError> {
    let list = params.get("links").and_then(Value::as_array).ok_or_else(|| ApiError::of("bad-url"))?;
    if list.len() > LINKS_MAX {
        return Err(ApiError::with("invalid", "At most 4 links."));
    }
    let mut links = Vec::new();
    for l in list {
        let o = l.as_object().filter(|o| exact_keys(o, &["label", "url"], &["label", "url"])).ok_or_else(|| ApiError::of("bad-url"))?;
        let label: String = clean(str_of(o.get("label")).unwrap_or("")).chars().take(60).collect();
        let url = str_of(o.get("url")).unwrap_or("").trim().to_owned();
        let host = url.strip_prefix("https://").map(|r| r.split(&['/', '?', '#'][..]).next().unwrap_or(""));
        let ok = host.is_some_and(|h| !h.is_empty() && !h.contains('@') && h.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':' | '[' | ']')));
        if !ok || label.is_empty() || url.len() > 500 || url.chars().any(|c| c.is_whitespace() || c.is_control()) {
            return Err(ApiError::of("bad-url"));
        }
        links.push((label, url));
    }
    Ok(links)
}

fn bool_of(v: Option<&Value>, name: &str) -> Result<bool, ApiError> {
    v.and_then(Value::as_bool).ok_or_else(|| ApiError::with("invalid", format!("{name} is true or false.")))
}

fn int_of(v: Option<&Value>, name: &str) -> Result<i64, ApiError> {
    v.and_then(Value::as_i64).ok_or_else(|| ApiError::with("invalid", format!("{name} is a whole number.")))
}

impl Console {
    /// The settings in force (a copy).
    pub fn settings_now(&self) -> crate::console_settings::Settings {
        self.inner.lock().book.settings.clone()
    }

    /// Whether the console runs the High profile (I14).
    pub fn profile_high(&self) -> bool {
        self.inner.lock().book.settings.high()
    }

    /// `console.bootstrap` (6, R41-3): the registration that bootstraps the console, actor the first admin, with the
    /// profile the console started in and where it came from (`"flag"`: `--console-profile` or `console_profile` was
    /// given at this start; `"default"`: not given, Standard).
    pub(crate) fn record_bootstrap(&self, email: &str, ip: &str, t: i64) {
        let profile = self.inner.lock().book.settings.profile;
        let mut r = crate::console_audit::Record::new(email, "console.bootstrap", "ok");
        r.ip = Some(ip.to_owned());
        r.detail = json!({ "profile": profile.as_str(), "profileFrom": if self.cfg.profile.is_some() { "flag" } else { "default" } });
        self.record(r, t);
    }

    /// Whether two-person control is on (I14).
    pub fn two_person_on(&self) -> bool {
        self.inner.lock().book.settings.two_person
    }

    /// Where Meeting Hub seat requests go (2.4, I14): the setting, else the build's default; None when neither.
    pub fn license_request_to(&self) -> Option<String> {
        self.inner.lock().book.settings.license_request_to()
    }

    /// GET settings (4.2): every value, never a secret.
    pub(crate) fn settings_view(&self, t: i64) -> Out {
        let (s, break_glass) = {
            let inner = self.inner.lock();
            (inner.book.settings.clone(), self.break_glass_view(&inner))
        };
        let mds = {
            let m = self.mds.lock();
            m.current.as_ref().map(|c| json!({ "no": c.no, "nextUpdate": c.next_update, "source": if c.uploaded { "uploaded" } else { "shipped" } })).unwrap_or(Value::Null)
        };
        let mut email = self.mailer.config().view();
        email["failing"] = Value::Bool(self.mailer.failing());
        let seal = match self.seal.lock().as_ref() {
            Some(seal) => {
                let refused: Vec<Value> = seal.refused_providers().into_iter().map(|(p, why)| json!({ "provider": p, "why": why })).collect();
                json!({ "provider": seal.provider().as_str(), "keyMode": seal.key_mode(), "refused": refused, "lost": seal.lost() })
            }
            None => json!({ "provider": null, "keyMode": null, "refused": [], "lost": false }),
        };
        let _ = t;
        Out::ok(json!({
            "ok": true, "links": s.links_value(), "profile": s.profile.as_str(), "twoPerson": if s.two_person { "on" } else { "off" },
            "signIn": { "requirePassword": s.require_password, "idleMinutes": s.idle_minutes_now(), "maxHours": s.max_hours_now() },
            "banner": s.banner, "aaguids": s.aaguids.iter().map(|(a, d)| json!({ "aaguid": a, "description": d })).collect::<Vec<_>>(),
            "mds": mds, "email": email, "licenseRequestTo": s.license_request_to(), "breakGlass": break_glass, "seal": seal,
        }))
    }

    fn break_glass_view(&self, inner: &Inner) -> Value {
        match inner.book.people.iter().find(|(_, p)| p.break_glass) {
            Some((e, p)) => json!({ "email": e, "lastUsedAt": inner.book.break_glass_used_at, "complete": self.break_glass_complete_of(p, &inner.book.settings) }),
            None => Value::Null,
        }
    }

    /// Save the settings with `f` applied.
    fn save_settings(&self, f: impl FnOnce(&mut crate::console_settings::Settings)) -> Result<(), ApiError> {
        let mut inner = self.inner.lock();
        f(&mut inner.book.settings);
        self.save_book(&mut inner)
    }

    /// POST settings/links {links, stepup}.
    pub(crate) fn settings_links(&self, params: &Value) -> Result<Done, ApiError> {
        let links = links_of(params)?;
        self.save_settings(|s| s.links = links)?;
        let shown = self.inner.lock().book.settings.links_value();
        Ok(Done::ok(Out::ok(json!({ "ok": true, "links": shown.clone() })), None, json!({ "links": shown })))
    }

    /// POST settings/profile {profile, reason, stepup}: to Standard a second admin (two-person on); to High one admin,
    /// refused while key-file sealing holds mail secrets.
    pub(crate) fn settings_profile(&self, who: &Who, params: &Value, t: i64) -> Result<Done, ApiError> {
        let profile = str_of(params.get("profile")).and_then(Profile::parse).ok_or_else(|| ApiError::with("invalid", "profile is high or standard."))?;
        let reason = reason_of(params.get("reason"))?;
        let now = self.inner.lock().book.settings.profile;
        if now == profile {
            return Err(ApiError::with("stale", format!("Nothing was changed: the profile is already {}.", profile.as_str())));
        }
        let p = json!({ "profile": profile.as_str(), "reason": reason });
        if profile == Profile::High {
            self.check_high_sealing()?;
            let v = self.run_profile(Profile::High, t)?;
            return Ok(Done::ok(Out::ok(v), Some("-".into()), json!({ "from": now.as_str(), "to": "high", "downgraded": false, "reason": reason })));
        }
        // AC-2a 4.5: on a fleet console a loosening reaches relays only with two admins' assertions, so it always
        // waits for a second admin here too (the stricter reading of AC-1 R4-3 and 4.5).
        if self.is_fleet() {
            let mut d = self.second_always(who, "settings.profile", "-", &p, t)?;
            d.detail = json!({ "from": now.as_str(), "to": "standard", "downgraded": false, "reason": reason });
            return Ok(d);
        }
        let mut d = self.second_or_run(who, "settings.profile", "-", &p, t, || self.run_profile(Profile::Standard, t))?;
        // `downgraded`: latched now (true), or still waiting for a second admin (false).
        let downgraded = self.inner.lock().book.settings.downgraded;
        d.detail = json!({ "from": now.as_str(), "to": "standard", "downgraded": downgraded, "reason": reason });
        Ok(d)
    }

    /// A switch to High with key-file sealing and mail secrets stored is refused (3.11, R3-M2).
    fn check_high_sealing(&self) -> Result<(), ApiError> {
        let seal = self.seal.lock();
        let Some(seal) = seal.as_ref() else { return Err(ApiError::of("state-unreadable")) };
        if !seal.compliant() && seal.names().iter().any(|n| n.starts_with("mail.")) {
            return Err(ApiError::of("seal-provider-needed"));
        }
        Ok(())
    }

    /// Carry out a profile change: to High, sessions whose methods High refuses end, TOTP stops working, and a Graph
    /// client secret turns mail off (`mail-failing`).
    pub(crate) fn run_profile(&self, profile: Profile, t: i64) -> Result<Value, ApiError> {
        if profile == Profile::High {
            self.check_high_sealing().map_err(|e| ApiError::with("stale", format!("Nothing was changed: {}", e.message)))?;
        }
        {
            let mut inner = self.inner.lock();
            // High to Standard latches `downgraded`; Standard to High clears it (R41-3).
            if inner.book.settings.profile != profile {
                inner.book.settings.downgraded = profile == Profile::Standard;
            }
            inner.book.settings.profile = profile;
            if profile == Profile::High {
                // Sessions started with a password and an authenticator app (or that never held a WebAuthn method).
                inner.sessions.retain(|_, s| s.webauthn);
            }
            self.save_book(&mut inner)?;
        }
        if profile == Profile::High {
            let cfg = self.mailer.config();
            let secret = cfg.graph.as_ref().is_some_and(|g| matches!(g.credential, crate::console_mail::GraphCredential::Secret(_)));
            if cfg.mode == Mode::Graph && secret {
                self.set_mail(MailConfig::off(), t)?;
                self.mailer.mark_failing();
                self.logger.security("console.mail-off", &Fields::new().with("why", "a Graph client secret is not allowed under the High profile"), Level::Warn);
            }
        }
        Ok(json!({ "ok": true }))
    }

    /// POST settings/two-person {twoPerson, reason, stepup}: on with one admin; off always needs a second admin, never
    /// the sole-admin path (3.7).
    pub(crate) fn settings_two_person(&self, who: &Who, params: &Value, t: i64) -> Result<Done, ApiError> {
        let on = match str_of(params.get("twoPerson")) {
            Some("on") => true,
            Some("off") => false,
            _ => return Err(ApiError::with("invalid", "twoPerson is on or off.")),
        };
        let reason = reason_of(params.get("reason"))?;
        if self.two_person_on() == on {
            return Err(ApiError::with("stale", format!("Nothing was changed: two-person control is already {}.", if on { "on" } else { "off" })));
        }
        if on {
            self.save_settings(|s| s.two_person = true)?;
            return Ok(Done::ok(Out::ok(json!({ "ok": true })), Some("-".into()), json!({ "twoPerson": "on", "reason": reason })));
        }
        let p = json!({ "twoPerson": "off", "reason": reason });
        self.second_always(who, "settings.two-person", "-", &p, t)
    }

    pub(crate) fn run_two_person(&self, params: &Value) -> Result<Value, ApiError> {
        let on = str_of(params.get("twoPerson")) == Some("on");
        self.save_settings(|s| s.two_person = on)?;
        Ok(json!({ "ok": true }))
    }

    /// POST settings/sign-in {requirePassword, idleMinutes, maxHours, reason, stepup}: tightening with one admin,
    /// loosening with a second admin (two-person on); session values Standard only.
    pub(crate) fn settings_sign_in(&self, who: &Who, params: &Value, t: i64) -> Result<Done, ApiError> {
        let require = bool_of(params.get("requirePassword"), "requirePassword")?;
        let idle = int_of(params.get("idleMinutes"), "idleMinutes")?;
        let max = int_of(params.get("maxHours"), "maxHours")?;
        let reason = reason_of(params.get("reason"))?;
        let s = self.settings_now();
        if s.high() {
            if idle != HIGH_IDLE_MINUTES || max != HIGH_MAX_HOURS {
                return Err(ApiError::of("profile-high"));
            }
        } else if !IDLE_MINUTES.contains(&idle) || !MAX_HOURS.contains(&max) {
            return Err(ApiError::with("invalid", "Idle time is 5 to 60 minutes and the longest session 1 to 24 hours."));
        }
        let (old_idle, old_max) = (s.idle_minutes_now(), s.max_hours_now());
        if require == s.require_password && idle == old_idle && max == old_max {
            return Err(ApiError::with("stale", "Nothing was changed: the sign-in settings are the same."));
        }
        let loosen = (s.require_password && !require) || idle > old_idle || max > old_max;
        let p = json!({ "requirePassword": require, "idleMinutes": idle, "maxHours": max, "reason": reason });
        if !loosen {
            self.run_sign_in(&p)?;
            return Ok(Done::ok(Out::ok(json!({ "ok": true })), Some("-".into()), p));
        }
        let mut d = self.second_or_run(who, "settings.sign-in", "-", &p, t, || self.run_sign_in(&p))?;
        d.detail = p.clone();
        Ok(d)
    }

    pub(crate) fn run_sign_in(&self, params: &Value) -> Result<Value, ApiError> {
        let require = params.get("requirePassword").and_then(Value::as_bool).unwrap_or(false);
        let idle = params.get("idleMinutes").and_then(Value::as_i64).unwrap_or(HIGH_IDLE_MINUTES);
        let max = params.get("maxHours").and_then(Value::as_i64).unwrap_or(HIGH_MAX_HOURS);
        self.save_settings(|s| {
            s.require_password = require;
            if !s.high() {
                s.idle_minutes = idle;
                s.max_hours = max;
            }
        })?;
        Ok(json!({ "ok": true }))
    }

    /// POST settings/banner {text, stepup}.
    pub(crate) fn settings_banner(&self, params: &Value) -> Result<Done, ApiError> {
        let text = str_of(params.get("text")).ok_or_else(|| ApiError::with("invalid", "text is the banner's words."))?;
        let banner = banner_of(text)?;
        let n = banner.as_ref().map_or(0, |b| b.chars().count());
        self.save_settings(|s| s.banner = banner)?;
        Ok(Done::ok(Out::ok(json!({ "ok": true })), Some("-".into()), json!({ "characters": n })))
    }

    /// POST settings/aaguids {aaguids, reason, stepup}: every change is a second-admin action (two-person on).
    pub(crate) fn settings_aaguids(&self, who: &Who, params: &Value, t: i64) -> Result<Done, ApiError> {
        let list = params.get("aaguids").and_then(Value::as_array).ok_or_else(|| ApiError::with("invalid", "aaguids is a list."))?;
        if list.len() > AAGUIDS_MAX {
            return Err(ApiError::with("invalid", "At most 50 approved security keys."));
        }
        let reason = reason_of(params.get("reason"))?;
        let mut ids = Vec::new();
        for v in list {
            let raw = str_of(Some(v)).or_else(|| str_of(v.get("aaguid"))).unwrap_or("");
            let id = aaguid_of(raw).ok_or_else(|| ApiError::with("invalid", "Each approved security key is an AAGUID (36 characters)."))?;
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
        let p = json!({ "aaguids": ids, "reason": reason });
        let mut d = self.second_or_run(who, "settings.aaguids", "-", &p, t, || self.run_aaguids(&p))?;
        d.detail = p.clone();
        Ok(d)
    }

    pub(crate) fn run_aaguids(&self, params: &Value) -> Result<Value, ApiError> {
        let ids: Vec<String> = params.get("aaguids").and_then(Value::as_array).map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect()).unwrap_or_default();
        let named: Vec<(String, String)> = {
            let mds = self.mds.lock();
            ids.into_iter().map(|a| {
                let d = mds.current.as_ref().and_then(|s| s.description(&a)).unwrap_or_default();
                (a, d)
            }).collect()
        };
        self.save_settings(|s| s.aaguids = named)?;
        Ok(json!({ "ok": true }))
    }

    /// POST settings/mds {blob, stepup}: a newer FIDO MDS3 blob that verifies against the pinned root.
    pub(crate) fn settings_mds(&self, params: &Value, t: i64) -> Result<Done, ApiError> {
        let blob = str_of(params.get("blob")).unwrap_or("").trim().as_bytes().to_vec();
        let installed = self.mds.lock().install(&self.cfg.state_dir, &blob, t);
        match installed {
            Ok(s) => Ok(Done::ok(Out::ok(json!({ "ok": true, "mds": { "no": s.no, "nextUpdate": s.next_update } })), Some("-".into()), json!({ "no": s.no, "sha256": s.sha256 }))),
            Err(why) => {
                let shown: String = clean(&why).chars().take(200).collect();
                Err(ApiError::with("mds-refused", format!("This metadata file cannot be used: {shown}.")))
            }
        }
    }

    /// Put mail settings in force: book (no secrets), sealed secrets, the mailer.
    pub(crate) fn set_mail(&self, cfg: MailConfig, _t: i64) -> Result<(), ApiError> {
        {
            let mut seal = self.seal.lock();
            let seal = seal.as_mut().ok_or_else(|| ApiError::of("state-unreadable"))?;
            for name in crate::console_mail::SECRET_NAMES {
                seal.remove(name).map_err(|e| self.seal_failed(&e))?;
            }
            for (name, value) in cfg.secrets() {
                seal.put(name, value.as_bytes()).map_err(|e| self.seal_failed(&e))?;
            }
        }
        let settings = cfg.to_settings();
        self.save_settings(|s| s.email = settings)?;
        self.mailer.configure(cfg);
        Ok(())
    }

    fn seal_failed(&self, why: &str) -> ApiError {
        self.logger.ops("console.write-failed", &Fields::new().with("file", crate::console_seal::SECRETS_FILE).with("reason", why), Level::Error);
        ApiError::of("write-failed")
    }

    /// POST settings/email {mode, from, smtp, graph, reason, stepup}: a staged save verified by a test mail through the
    /// new settings to the saving admin (R3-M7); turning mail off is a second-admin action.
    pub(crate) fn settings_email(&self, who: &Who, params: &Value, t: i64) -> Result<Done, ApiError> {
        let reason = reason_of(params.get("reason"))?;
        let high = self.profile_high();
        let current = self.mailer.config();
        let mut body = params.clone();
        if let Some(o) = body.as_object_mut() {
            o.remove("reason");
        }
        let new = MailConfig::from_body_why(&body, &current, high).map_err(|(code, words)| match code {
            "bad-mailbox" => ApiError::with("bad-mailbox", format!("That is not an email address this console can send to or from: {words}.")),
            "mail-secret-high" => ApiError::of("mail-secret-high"),
            _ => ApiError::with("invalid", words),
        })?;
        let changed = new.changed(&current);
        if new.mode == Mode::Off {
            if current.mode == Mode::Off {
                return Err(ApiError::with("stale", "Nothing was changed: email is already off."));
            }
            let p = json!({ "mode": "off", "reason": reason });
            let mut d = self.second_or_run(who, "settings.email", "-", &p, t, || {
                self.set_mail(MailConfig::off(), t)?;
                Ok(json!({ "ok": true }))
            })?;
            d.detail = json!({ "changed": changed, "mode": "off", "reason": reason, "verified": false });
            return Ok(d);
        }
        if !new.secrets().is_empty() {
            let compliant = self.seal.lock().as_ref().map(|s| s.compliant()).ok_or_else(|| ApiError::of("state-unreadable"))?;
            if high && !compliant {
                return Err(ApiError::of("seal-provider-needed"));
            }
        }
        // Staged: the new settings carry a test mail to the saving admin before they replace the old.
        if let Err(why) = self.mailer.send_now(&new, "mail.test", &who.email, &[]) {
            let shown: String = clean(&why).chars().take(300).collect();
            return Err(ApiError::with("mail-failed", format!("The mail server did not accept the message: {shown}.")));
        }
        self.set_mail(new, t)?;
        Ok(Done::ok(Out::ok(json!({ "ok": true, "verified": true })), Some("-".into()), json!({ "changed": changed, "reason": reason, "verified": true })))
    }

    /// POST settings/email/test {}: `mail.test` to the signed-in admin's own address.
    pub(crate) fn settings_email_test(&self, who: &Who, t: i64) -> Result<Done, ApiError> {
        let cfg = self.mailer.config();
        if cfg.mode == Mode::Off {
            return Err(ApiError::of("mail-off"));
        }
        self.limit(Limit::EmailTest, &who.email, t)?;
        match self.mailer.send_now(&cfg, "mail.test", &who.email, &[]) {
            Ok(()) => Ok(Done::ok(Out::ok(json!({ "ok": true, "to": who.email })), Some("-".into()), json!({ "sent": true }))),
            Err(why) => {
                let shown: String = clean(&why).chars().take(300).collect();
                Err(ApiError::with("mail-failed", format!("The mail server did not accept the message: {shown}.")))
            }
        }
    }

    /// POST settings/license-request-to {address, stepup}: "" goes back to the build's default.
    pub(crate) fn settings_license_request_to(&self, params: &Value) -> Result<Done, ApiError> {
        let raw = str_of(params.get("address")).unwrap_or("").trim().to_owned();
        let address = if raw.is_empty() { None } else { Some(parse_mailbox(&raw).map_err(|_| ApiError::with("bad-mailbox", "That is not an email address this console can send to or from: address."))?) };
        let shown = address.clone();
        self.save_settings(|s| s.license_request_to = address)?;
        Ok(Done::ok(Out::ok(json!({ "ok": true })), Some("-".into()), json!({ "address": shown })))
    }
}

// ── Exports (AC-2a 5.3, 10): scrape tokens and SIEM forwarding, fleet console only ──────────────────────────

/// The sealed name of the SIEM client key (2.4).
pub const SIEM_KEY_SECRET: &str = "siem-client-key";
/// A scrape token's label: 1 to 64 characters after cleaning; its life 1 to 365 days.
const TOKEN_LABEL_MAX: usize = 64;
const TOKEN_DAYS: std::ops::RangeInclusive<i64> = 1..=365;

impl Console {
    fn exports_fleet(&self) -> Result<std::sync::Arc<crate::console_fleet::Fleet>, ApiError> {
        self.fleet().ok_or_else(|| ApiError::of("not-found"))
    }

    fn token_records(&self) -> Vec<crate::fleet_export::TokenRecord> {
        self.inner.lock().book.settings.tokens.iter().filter_map(crate::fleet_export::TokenRecord::from_json).collect()
    }

    /// GET settings/exports.
    pub(crate) fn exports_view(&self) -> Result<Out, ApiError> {
        let fleet = self.exports_fleet()?;
        let tokens: Vec<Value> = self.token_records().iter().map(crate::fleet_export::TokenRecord::view).collect();
        let (siem_json, sources) = {
            let inner = self.inner.lock();
            (inner.book.settings.siem.clone(), inner.book.settings.metrics_sources.clone())
        };
        let siem = match crate::fleet_syslog::SiemSettings::from_json(&siem_json) {
            Some(s) => {
                let mut v = s.view();
                if let (Some(o), Some(st)) = (v.as_object_mut(), fleet.siem.status().as_object()) {
                    for (k, x) in st {
                        o.insert(k.clone(), x.clone());
                    }
                }
                v
            }
            None => Value::Null,
        };
        let sources = sources.unwrap_or_else(|| fleet.metrics_sources_text());
        Ok(Out::ok(json!({ "ok": true, "tokens": tokens, "siem": siem, "metricsSources": sources })))
    }

    /// POST settings/exports/token {label, relays, days, stepup}: the token only in this answer (10.1).
    pub(crate) fn exports_token(&self, who: &Who, params: &Value, t: i64) -> Result<Done, ApiError> {
        let fleet = self.exports_fleet()?;
        let label: String = clean(str_of(params.get("label")).unwrap_or("")).chars().take(TOKEN_LABEL_MAX + 1).collect();
        if label.is_empty() || label.chars().count() > TOKEN_LABEL_MAX {
            return Err(ApiError::with("invalid", "Give the token a label of 1 to 64 characters."));
        }
        let days = int_of(params.get("days"), "days")?;
        if !TOKEN_DAYS.contains(&days) {
            return Err(ApiError::with("invalid", "A token lasts 1 to 365 days."));
        }
        let relays = match params.get("relays") {
            Some(Value::String(s)) if s == "all" => crate::fleet_export::TokenRelays::All,
            Some(Value::Array(a)) if !a.is_empty() => {
                let known = fleet.relay_ids();
                let mut ids = Vec::new();
                for v in a {
                    let id = v.as_str().filter(|id| known.iter().any(|k| k == id)).ok_or_else(|| ApiError::with("invalid", "relays names relays of this console, or all."))?;
                    if !ids.iter().any(|x: &String| x == id) {
                        ids.push(id.to_owned());
                    }
                }
                crate::fleet_export::TokenRelays::List(ids)
            }
            _ => return Err(ApiError::with("invalid", "relays names relays of this console, or all.")),
        };
        let records = self.token_records();
        let (token, record) = crate::fleet_export::mint_token(&label, &relays, Some(days), &who.email, t, &records)?;
        let (hint, expires) = (record.hint.clone(), record.expires);
        {
            let mut inner = self.inner.lock();
            inner.book.settings.tokens.push(record.to_json());
            self.save_book(&mut inner)?;
        }
        let shown = match &relays {
            crate::fleet_export::TokenRelays::All => json!("all"),
            crate::fleet_export::TokenRelays::List(l) => json!(l),
        };
        Ok(Done::ok(Out::ok(json!({ "ok": true, "token": token, "hint": hint, "expires": expires })), Some(label.clone()), json!({ "hint": hint, "label": label, "relays": shown, "expires": expires })))
    }

    /// POST settings/exports/token/revoke {hint}.
    pub(crate) fn exports_token_revoke(&self, params: &Value) -> Result<Done, ApiError> {
        self.exports_fleet()?;
        let hint = str_of(params.get("hint")).unwrap_or("").to_owned();
        let mut inner = self.inner.lock();
        let before = inner.book.settings.tokens.len();
        inner.book.settings.tokens.retain(|v| crate::fleet_export::TokenRecord::from_json(v).is_none_or(|r| r.hint != hint));
        if inner.book.settings.tokens.len() == before {
            return Err(ApiError::with("not-found", "There is no such token."));
        }
        self.save_book(&mut inner)?;
        Ok(Done::ok(Out::ok(json!({ "ok": true })), Some(hint.clone()), json!({ "hint": hint })))
    }

    /// The scrape token used last (10.1 `lastUsedAt`), written by the `/metrics` route.
    pub(crate) fn token_used(&self, hint: &str, t: i64) {
        let mut inner = self.inner.lock();
        let mut changed = false;
        for v in inner.book.settings.tokens.iter_mut() {
            if let Some(mut r) = crate::fleet_export::TokenRecord::from_json(v).filter(|r| r.hint == hint) {
                // At most one write a minute per token.
                if r.last_used_at.is_none_or(|at| t - at >= MINUTE) {
                    r.last_used_at = Some(t);
                    *v = r.to_json();
                    changed = true;
                }
            }
        }
        if changed {
            let _ = self.save_book(&mut inner);
        }
    }

    /// POST settings/exports/siem {host, port, caPem, clientCertPem, clientKeyPem, events, includeReasons, reason,
    /// stepup} or {off: true, reason, stepup} (10.2): a staged save verified by a test message; turning it off is a
    /// second-admin action.
    pub(crate) fn exports_siem(&self, who: &Who, params: &Value, t: i64) -> Result<Done, ApiError> {
        let fleet = self.exports_fleet()?;
        let reason = reason_of(params.get("reason"))?;
        let high = self.profile_high();
        if params.get("off").and_then(Value::as_bool) == Some(true) {
            if self.inner.lock().book.settings.siem.is_null() {
                return Err(ApiError::with("stale", "Nothing was changed: SIEM forwarding is already off."));
            }
            let p = json!({ "off": true, "reason": reason });
            let mut d = self.second_or_run(who, "exports.siem", "-", &p, t, || self.run_siem_off())?;
            d.detail = json!({ "off": true, "reason": reason, "verified": false });
            return Ok(d);
        }
        let fips = cfg!(feature = "fips");
        if high && !fips {
            return Err(ApiError::of("fips-needed"));
        }
        let key = str_of(params.get("clientKeyPem")).map(str::trim).filter(|k| !k.is_empty()).map(str::to_owned);
        if key.is_some() {
            let compliant = self.seal.lock().as_ref().map(|s| s.compliant()).ok_or_else(|| ApiError::of("state-unreadable"))?;
            if high && !compliant {
                return Err(ApiError::of("seal-provider-needed"));
            }
        }
        let mut body = params.clone();
        if let Some(o) = body.as_object_mut() {
            o.remove("reason");
            o.remove("clientKeyPem");
        }
        let settings = crate::fleet_syslog::SiemSettings::from_body(&body, high, fips)?;
        // A new key goes with the new settings; else the sealed one stays in use.
        let key_pem = key.clone().or_else(|| self.seal_get(SIEM_KEY_SECRET).and_then(|b| String::from_utf8(b).ok()));
        if let Err(why) = fleet.siem.stage(settings.clone(), key_pem) {
            let shown: String = clean(&why).chars().take(300).collect();
            return Err(ApiError::with("siem-failed", format!("The test message did not reach the SIEM: {shown}. Nothing was changed.")));
        }
        if let Some(k) = &key {
            self.seal_put(SIEM_KEY_SECRET, k.as_bytes())?;
        }
        let saved = settings.to_json();
        let view = settings.view();
        {
            let mut inner = self.inner.lock();
            inner.book.settings.siem = saved;
            self.save_book(&mut inner)?;
        }
        let detail = json!({ "host": view.get("host"), "port": view.get("port"), "events": view.get("events"), "includeReasons": view.get("includeReasons"), "verified": true, "off": false, "reason": reason });
        Ok(Done::ok(Out::ok(json!({ "ok": true, "verified": true })), Some("-".into()), detail))
    }

    /// SIEM forwarding off (after a second admin when two-person is on).
    pub(crate) fn run_siem_off(&self) -> Result<Value, ApiError> {
        let fleet = self.exports_fleet()?;
        fleet.siem.off();
        {
            let mut inner = self.inner.lock();
            inner.book.settings.siem = Value::Null;
            self.save_book(&mut inner)?;
        }
        if let Some(s) = self.seal.lock().as_mut() {
            let _ = s.remove(SIEM_KEY_SECRET);
        }
        Ok(json!({ "ok": true }))
    }

    /// POST settings/exports/siem/test {} (one a minute per admin).
    pub(crate) fn exports_siem_test(&self, who: &Who, t: i64) -> Result<Done, ApiError> {
        let fleet = self.exports_fleet()?;
        self.limit(Limit::EmailTest, &format!("siem|{}", who.email), t)?;
        fleet.siem.test().map_err(|why| {
            let shown: String = clean(&why).chars().take(300).collect();
            ApiError::with("siem-failed", format!("The test message did not reach the SIEM: {shown}. Nothing was changed."))
        })?;
        Ok(Done::ok(Out::ok(json!({ "ok": true })), Some("-".into()), json!({})))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn setup_steps_round_trip_and_the_checklist_shows_until_done_or_hidden() {
        let mut s = Setup::default();
        assert!(s.unfinished());
        assert_eq!(s.first_open(), Some("signin"));
        assert!(s.done("signin"));
        assert!(!s.done("signin"), "done once");
        assert!(s.set("email", StepState::Skipped));
        assert!(!s.set("nope", StepState::Done));
        assert_eq!(s.first_open(), Some("license"));
        assert_eq!(Setup::from_value(&s.to_value()), Some(s.clone()));
        assert_eq!(s.to_value()["steps"]["email"], "skipped");
        s.set("license", StepState::Done);
        s.set("relay", StepState::Done);
        assert!(s.unfinished(), "a skipped step keeps the checklist");
        s.set("email", StepState::Done);
        assert!(!s.unfinished());
        let mut h = Setup::default();
        h.hidden = true;
        assert!(!h.unfinished());
        assert!(Setup::from_value(&json!({ "steps": { "signin": "open" }, "hidden": false })).is_none());
    }

    #[test]
    fn exports_are_kept_only_when_set() {
        let s = Settings::default();
        assert!(s.to_value().get("exports").is_none(), "an AC-1 book keeps its exact shape");
        let mut x = s.clone();
        x.tokens.push(json!({ "hint": "abcd1234" }));
        x.metrics_sources = Some("10.0.0.0/8".into());
        let back = Settings::from_value(&x.to_value()).unwrap();
        assert_eq!(back.tokens, x.tokens);
        assert_eq!(back.metrics_sources.as_deref(), Some("10.0.0.0/8"));
    }

    #[test]
    fn the_settings_round_trip_and_default_to_standard_and_off() {
        let s = Settings::default();
        assert_eq!((s.profile, s.downgraded, s.two_person, s.require_password), (Profile::Standard, false, false, false));
        assert_eq!(s.password_field(), "offered");
        assert_eq!((s.idle_ms(), s.max_ms()), (15 * MINUTE, 12 * 60 * MINUTE));
        assert!(!s.profile_standard_item());
        let mut h = s.clone();
        h.profile = Profile::High;
        assert_eq!(h.password_field(), "none");
        let mut t = s.clone();
        t.downgraded = true;
        assert!(t.profile_standard_item());
        t.idle_minutes = 30;
        t.max_hours = 24;
        t.banner = Some("Line one\nline two".into());
        t.aaguids.push(("ee882879-721c-4913-9775-3dfcce97072a".into(), "A key".into()));
        t.links.push(("Other".into(), "https://other.example/console/".into()));
        let back = Settings::from_value(&t.to_value()).unwrap();
        assert_eq!(back.to_value(), t.to_value());
        assert_eq!(back.password_field(), "offered");
        assert_eq!((back.idle_ms(), back.max_ms()), (30 * MINUTE, 24 * 60 * MINUTE));
        let mut r = back.clone();
        r.require_password = true;
        assert_eq!(r.password_field(), "required");
    }

    #[test]
    fn the_profile_at_start_is_written_only_before_bootstrap() {
        let mut s = Settings::default();
        // Not bootstrapped: no flag is Standard (unchanged), high is written, and a written profile is never a downgrade.
        assert_eq!(s.profile_at_start(None, false), ProfileAtStart::Written(false));
        assert_eq!(s.profile_at_start(Some(Profile::High), false), ProfileAtStart::Written(true));
        assert_eq!((s.profile, s.downgraded), (Profile::High, false));
        s.downgraded = true;
        assert_eq!(s.profile_at_start(Some(Profile::Standard), false), ProfileAtStart::Written(true));
        assert_eq!((s.profile, s.downgraded), (Profile::Standard, false));
        // Bootstrapped: ignored; differs only when given and not the profile in force.
        s.profile = Profile::High;
        assert_eq!(s.profile_at_start(Some(Profile::Standard), true), ProfileAtStart::Ignored(true));
        assert_eq!(s.profile_at_start(Some(Profile::High), true), ProfileAtStart::Ignored(false));
        assert_eq!(s.profile_at_start(None, true), ProfileAtStart::Ignored(false));
        assert_eq!(s.profile, Profile::High);
        assert_eq!(profile_ignored_words(profile_flag(crate::license::Product::Meet)), "The Admin Console is already set up, so console_profile is ignored. Change the security profile in Settings, Security.");
        // `downgraded` survives the book.
        let d = Settings { profile: Profile::Standard, downgraded: true, ..Settings::default() };
        assert!(Settings::from_value(&d.to_value()).unwrap().profile_standard_item());
    }

    /// R6-M3: the approved publisher mailbox (tests/release_request_to.rs compares the build's address with it) is
    /// empty until the owner sets it, and then a mailbox the console's own parser accepts unchanged.
    #[test]
    fn the_approved_publisher_mailbox_is_empty_or_a_mailbox() {
        let raw = include_str!("../release/approved-publisher-mailbox.txt");
        let approved = raw.strip_suffix("\r\n").or_else(|| raw.strip_suffix('\n')).unwrap_or(raw);
        if !approved.is_empty() {
            assert_eq!(parse_mailbox(approved).as_deref(), Ok(approved), "approved-publisher-mailbox.txt: {approved:?}");
        }
    }

    #[test]
    fn rights_follow_the_profile_the_attestation_and_the_device_anchor() {
        assert_eq!(rights_of(PersonRole::Admin, true, false, true, false), (Rights::Viewer, Some("not-attested")));
        assert_eq!(rights_of(PersonRole::UserManager, true, false, true, false), (Rights::Viewer, Some("not-attested")));
        assert_eq!(rights_of(PersonRole::Admin, true, true, true, false), (Rights::Admin, None));
        assert_eq!(rights_of(PersonRole::Admin, false, false, true, false), (Rights::Admin, None));
        assert_eq!(rights_of(PersonRole::Admin, false, false, false, false), (Rights::Viewer, Some("not-device-anchored")));
        assert_eq!(rights_of(PersonRole::Admin, false, false, false, true), (Rights::Admin, None));
        assert_eq!(rights_of(PersonRole::UserManager, false, false, false, false), (Rights::Manager, None));
        assert_eq!(rights_of(PersonRole::Viewer, true, false, false, false), (Rights::Viewer, None));
    }

    #[test]
    fn banners_keep_line_breaks_and_drop_controls() {
        assert_eq!(banner_of("  Authorized use only.\r\nAll activity is logged.\u{202E}  ").unwrap().as_deref(), Some("Authorized use only.\nAll activity is logged."));
        assert_eq!(banner_of("").unwrap(), None);
        assert!(banner_of(&"x".repeat(2001)).is_err());
        assert!(aaguid_of("EE882879-721C-4913-9775-3DFCCE97072A").is_some());
        assert!(aaguid_of("ee882879721c491397753dfcce97072a").is_none());
    }
}
