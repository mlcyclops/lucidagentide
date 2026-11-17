// Tests of the Admin Console's HTTP side and of the core as a whole (contract AC-1 revision 4, section 12.1, ac-core).
// The pieces have their own unit tests too: console_source.rs, console_limits.rs, console_audit.rs, console_auth.rs,
// console_approvals.rs, console_settings.rs, console_password.rs, console_mds.rs, console_mail.rs, console_seal.rs and
// console_webauthn.rs; these tests drive the console end to end through `Console::http`.

use super::*;
use crate::codec::{b64u, unb64u};
use crate::console_auth::{
    hint_of, run_offline, Ceremony, Invite, InviteKind, InviteSource, Kind, KeyKind, KeyState, Offline, Passkey, PasswordMethod, Person, PersonState, Stage, TotpMethod, CONSOLE_ANCHOR, OPERATOR_ANCHOR,
    RUNNING,
};
use crate::console_mail::{SmtpConfig, SmtpTls};
use crate::console_mds::Verdict;
use crate::console_settings::Profile;
use crate::console_webauthn::testkit::Authenticator;
use std::collections::HashSet;

const ORIGIN: &str = "https://relay.example.com:8787";
const RP: &str = "relay.example.com";
const HOST: &str = "relay.example.com:8787";
const T0: i64 = 1_800_000_000_000;
/// The certificate serial of the hub that sends the tests' invites.
const HUB_SERIAL: &str = "0000000000000000000000000000000a";
const HUB_NODE: &str = "n_0123456789abcdef0123456789abcdef";
const ALICE: &str = "alice@acme.example";
const BOB: &str = "bob@acme.example";
const CAROL: &str = "carol@acme.example";
const VIC: &str = "vic@acme.example";
const ADAM: &str = "adam@acme.example";
const UMA: &str = "uma@acme.example";
const PAT: &str = "pat@acme.example";
const WES: &str = "wes@acme.example";
const BG: &str = "bg@acme.example";
const MIN: i64 = 60_000;
const HOUR: i64 = 3_600_000;
const DAY: i64 = 24 * HOUR;
/// The one sign-in refusal sentence (3.3).
const SIGNIN: &str = "Those details did not sign you in.";
/// Passwords that pass every 3.3 rule under both profiles.
const PW: &str = "Tq8$wN3&jH6*cB5y";
const BG_PASSWORD: &str = "Qz7!mR2#vK9@pL4x";
/// The test security key model: listed in the test MDS snapshot with FIPS and hardware key protection.
const AAGUID: [u8; 16] = [0x11; 16];
const SECOND_HUB: &str = "0000000000000000000000000000000b";

/// A dialed DNS name or IPv4 address, with or without a port (server.rs dialed_of for TLS).
fn dialed(host: &str) -> Dialed {
    let (hostname, port) = match host.rsplit_once(':') {
        Some((h, p)) => (h.to_owned(), p.parse().unwrap_or(443)),
        None => (host.to_owned(), 443),
    };
    Dialed { host: host.to_owned(), hostname, port }
}

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("lucid-console-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn lines_of(log: &Arc<Mutex<Vec<String>>>) -> Vec<String> {
    log.lock().clone()
}

// ── A product section for the tests ─────────────────────────────────────────────────────────────────────────

static FAKE_ROUTES: [RouteSpec; 3] = [
    RouteSpec { method: "GET", path: "fake/list", role: Role::Viewer, action: "", target: "-", stepup: false, need: Need::Any, security: false, keys: &[], body_max: BODY_MAX },
    RouteSpec { method: "POST", path: "fake/block", role: Role::Admin, action: "fake.block", target: "node", stepup: true, need: Need::Any, security: true, keys: &["node", "reason"], body_max: BODY_MAX },
    RouteSpec { method: "POST", path: "fake/widen", role: Role::Admin, action: "fake.widen", target: "node", stepup: true, need: Need::Product, security: false, keys: &["node", "reason"], body_max: BODY_MAX },
];

/// The product section of the tests. It keeps every other default method of the trait (`may_approve`, `admin_rule`,
/// `relay_lines`, `people_changed`). Its service (4.7, R42-1) follows `lic` unless a test sets `service`.
struct Fake {
    lic: Mutex<LicenseState>,
    service: Mutex<Option<ServiceView>>,
    ran: Mutex<Vec<String>>,
    installed: Mutex<Vec<String>>,
}

impl Fake {
    fn new() -> Fake {
        Fake { lic: Mutex::new(LicenseState::Valid), service: Mutex::new(None), ran: Mutex::new(Vec::new()), installed: Mutex::new(Vec::new()) }
    }
}

impl ProductSection for Fake {
    fn routes(&self) -> &'static [RouteSpec] {
        &FAKE_ROUTES
    }
    fn sections(&self, _license: LicenseState) -> Vec<&'static str> {
        vec!["hubs", "spokes"]
    }
    fn relay_info(&self, _t: i64) -> Value {
        json!({ "host": RP, "version": "test", "uptimeSeconds": 1, "fips": false, "tlsNotAfter": null })
    }
    fn license(&self, t: i64) -> LicenseView {
        let state = *self.lic.lock();
        let license = if state == LicenseState::None { Value::Null } else { json!({ "id": "l_0000000000000001", "edition": "standard", "users": 20, "used": 1, "daysLeft": 100, "exp": 1 }) };
        let service = self.service.lock().clone().map(|s| ServiceView { at: t, ..s }).unwrap_or_else(|| match state {
            LicenseState::Valid => ServiceView::on(t),
            LicenseState::Grace => ServiceView { state: ServiceState::Grace, ..ServiceView::on(t) },
            LicenseState::Expired => ServiceView { why: Some("expired"), ..ServiceView::none(t) },
            LicenseState::None => ServiceView::none(t),
        });
        LicenseView { license, problem: (state == LicenseState::None).then(|| "no license".to_owned()), state, service }
    }
    fn overview_cards(&self, _admin: bool, _t: i64) -> Vec<Value> {
        vec![json!({ "id": "hubs", "state": "ok", "n": 1 })]
    }
    fn attention(&self, _admin: bool, _t: i64) -> Vec<Value> {
        vec![json!({ "kind": "spokes-silent", "severity": "warn", "args": { "n": 1 }, "go": "#/spokes" }), json!({ "kind": "uncounted", "severity": "warn", "args": { "n": 1 }, "go": "#/spokes" })]
    }
    fn search(&self, _q: &str, _admin: bool, _t: i64) -> Vec<Value> {
        Vec::new()
    }
    fn security_actions(&self) -> &'static [&'static str] {
        &["fake.block"]
    }
    fn route(&self, call: &SectionCall) -> Result<SectionAnswer, ApiError> {
        let node = str_of(call.body.get("node")).unwrap_or("").to_owned();
        match call.spec.path {
            "fake/list" => Ok(SectionAnswer::Read(json!({ "ok": true, "rows": [] }))),
            "fake/block" => Ok(SectionAnswer::Done { answer: json!({ "ok": true }), target: node, detail: json!({ "reason": call.body.get("reason") }) }),
            _ => Ok(SectionAnswer::Second { target: node, params: call.body.clone(), detail: json!({}) }),
        }
    }
    fn execute(&self, run: &Approved) -> Result<Value, ApiError> {
        self.ran.lock().push(format!("{} {} as {}", run.action, run.target, run.requested_by));
        Ok(json!({ "ok": true }))
    }
    fn license_candidate(&self, token: &str, _t: i64) -> Result<LicenseCandidate, ApiError> {
        // "lic:<id>:<renew|change|ended>" against the reference license l_ref (exp 1000, 20 users): renew is a
        // renewal of it (same id), change and ended another id.
        let parts: Vec<&str> = token.split(':').collect();
        let [_, id, kind] = parts.as_slice() else { return Err(ApiError::with("license-refused", "This license cannot be used here: malformed.")) };
        let record = |id: &str, exp: i64| LicenseRecord { product: Product::Spokes, root: "n_root".into(), id: id.into(), edition: "standard".into(), users: 20, relays: 1, exp };
        let reference = record(if *kind == "renew" { id } else { "l_ref" }, 1000);
        Ok(LicenseCandidate { offered: record(id, 2000), valid: *kind != "ended", ended: *kind == "ended", reference: Some(reference), view: json!({ "id": id }) })
    }
    fn license_install(&self, token: &str, _t: i64) -> Result<Value, ApiError> {
        self.installed.lock().push(token.to_owned());
        Ok(json!({ "id": token }))
    }
    fn request_target(&self, _kind: &str, target: &Value) -> Result<Value, ApiError> {
        target.as_object().map(|_| target.clone()).ok_or_else(|| ApiError::with("invalid", "target"))
    }
}

// ── The console and requests ────────────────────────────────────────────────────────────────────────────────

struct Built {
    c: Arc<Console>,
    log: Arc<Mutex<Vec<String>>>,
    fake: Arc<Fake>,
    dir: PathBuf,
}

fn build_in(dir: PathBuf, pin: Option<&str>, sources: &str, fronts: &str, behind: bool) -> Result<Built, String> {
    open_in(dir, pin, sources, fronts, behind, None)
}

/// The console in `dir` started with `--console-profile` `profile` (None: not given).
fn open_in(dir: PathBuf, pin: Option<&str>, sources: &str, fronts: &str, behind: bool, profile: Option<Profile>) -> Result<Built, String> {
    open_serving(dir, pin, sources, fronts, behind, profile, None)
}

/// `open_in` with the section reporting `service` from the start, so the check at attach sees that license.
fn open_serving(dir: PathBuf, pin: Option<&str>, sources: &str, fronts: &str, behind: bool, profile: Option<Profile>, service: Option<ServiceView>) -> Result<Built, String> {
    let written = Arc::new(Mutex::new(Vec::<String>::new()));
    let w = written.clone();
    let ring = Arc::new(LineRing::default());
    let logger = Arc::new(Logger::capture("relay", Box::new(move |l, _| w.lock().push(l.to_owned()))).with_tap(ring.tap()));
    let cfg = ConsoleConfig {
        product: Product::Spokes,
        state_dir: dir.clone(),
        origin: None,
        sources: parse_cidr_list(sources, SOURCES_MAX).unwrap(),
        trusted_fronts: if fronts.is_empty() { Vec::new() } else { parse_cidr_list(fronts, FRONTS_MAX).unwrap() },
        behind_front: behind,
        first_admin: pin.map(str::to_owned),
        profile,
        host: RP.into(),
    };
    let c = Console::open(cfg, logger, ring)?;
    let fake = Arc::new(Fake::new());
    *fake.service.lock() = service;
    c.attach(fake.clone());
    Ok(Built { c, log: written, fake, dir })
}

/// A console under the Standard profile, the default (R41-3): no `--console-profile` given.
fn build(name: &str) -> Built {
    build_in(temp_dir(name), Some(ALICE), "0.0.0.0/0,::/0", "", false).unwrap()
}

/// A console set up with `--console-profile high` (R41-3; under High an admin with an unattested passkey holds viewer
/// rights and every ordinary write waits for the break-glass account), with the test MDS snapshot in force: the
/// testkit's security key model is FIPS certified with hardware key protection.
fn build_high(name: &str) -> Built {
    let b = open_in(temp_dir(name), Some(ALICE), "0.0.0.0/0,::/0", "", false, Some(Profile::High)).unwrap();
    snapshot(&b.c);
    b
}

/// The same state folder opened again (the relay restarted); when `high`, with `--console-profile high` and the test
/// snapshot.
fn reopen(dir: &std::path::Path, high: bool) -> Built {
    let b = open_in(dir.to_owned(), None, "0.0.0.0/0,::/0", "", false, high.then_some(Profile::High)).unwrap();
    if high {
        snapshot(&b.c);
    }
    b
}

fn aaguid_text() -> String {
    crate::console_mds::aaguid_text(&AAGUID)
}

fn snapshot(c: &Console) {
    let id = aaguid_text();
    c.mds.lock().set(crate::console_mds::test_snapshot(&[(id.as_str(), true, false)]));
}

fn set_profile(c: &Console, p: Profile) {
    let mut inner = c.inner.lock();
    inner.book.settings.profile = p;
    c.save_book(&mut inner).unwrap();
}

fn two_person(c: &Console, on: bool) {
    let mut inner = c.inner.lock();
    inner.book.settings.two_person = on;
    c.save_book(&mut inner).unwrap();
}

struct Call<'a> {
    method: &'a str,
    path: &'a str,
    body: Value,
    cookie: String,
    origin: Option<&'a str>,
    marker: Option<&'a str>,
    activity: bool,
    content_type: &'a str,
    peer: &'a str,
    forwarded: Vec<String>,
    host: &'a str,
}

fn call<'a>(method: &'a str, path: &'a str, body: Value, cookie: &str) -> Call<'a> {
    Call { method, path, body, cookie: cookie.to_owned(), origin: Some(ORIGIN), marker: Some("1"), activity: true, content_type: "application/json", peer: "192.0.2.7", forwarded: Vec::new(), host: HOST }
}

fn get<'a>(path: &'a str, cookie: &str) -> Call<'a> {
    call("GET", path, Value::Null, cookie)
}

fn send(c: &Console, k: Call, t: i64) -> ConsoleReply {
    let d = dialed(k.host);
    let body = if k.method == "POST" { stringify(&k.body) } else { String::new() };
    let (pathname, query) = k.path.split_once('?').unwrap_or((k.path, ""));
    let r = ConsoleRequest {
        method: k.method,
        pathname,
        query,
        cookie: &k.cookie,
        origin: k.origin,
        marker: k.marker,
        activity: k.activity,
        content_type: k.content_type,
        user_agent: "test agent",
        peer: k.peer.parse().unwrap(),
        forwarded: &k.forwarded,
        body: &body,
        dialed: &d,
        host_ok: true,
    };
    c.http(&r, t)
}

/// POST `path` with `body` from `peer`.
fn send_from(c: &Console, path: &str, body: Value, sid: &str, peer: &str, t: i64) -> ConsoleReply {
    let mut k = call("POST", path, body, sid);
    k.peer = peer;
    send(c, k, t)
}

fn json_of(r: &ConsoleReply) -> Value {
    parse_json(&String::from_utf8_lossy(&r.body)).unwrap_or(Value::Null)
}

fn text_of(r: &ConsoleReply) -> String {
    String::from_utf8_lossy(&r.body).into_owned()
}

fn header<'a>(r: &'a ConsoleReply, name: &str) -> Option<&'a str> {
    r.headers.iter().find(|(k, _)| *k == name).map(|(_, v)| v.as_str())
}

fn code(r: &ConsoleReply) -> String {
    json_of(r)["code"].as_str().unwrap_or("").to_owned()
}

/// The `__Host-lrc=<sid>` a Set-Cookie carries.
fn cookie(r: &ConsoleReply) -> String {
    header(r, "Set-Cookie").and_then(|c| c.split(';').next()).unwrap_or("").to_owned()
}

/// The hex SHA-256 the console keys a session by.
fn sid_hash(sid: &str) -> String {
    crate::console_auth::sid_hash_of(sid.split_once('=').map_or(sid, |(_, v)| v)).unwrap().0
}

fn token_of(link: &str) -> String {
    link.split_once("#join=").map(|(_, t)| t.to_owned()).unwrap_or_default()
}

/// "<state> <passkey>" of a register/finish answer.
fn states(r: &ConsoleReply) -> String {
    let v = json_of(r);
    format!("{} {}", v["state"].as_str().unwrap_or(""), v["passkey"].as_str().unwrap_or(""))
}

/// Register a passkey (or, `attested`, a FIPS hardware security key of the test model) from an invite link: the
/// register/finish answer.
fn register_with(c: &Console, a: &mut Authenticator, link: &str, t: i64, attested: bool) -> ConsoleReply {
    let begin = json_of(&send(c, call("POST", "/console/api/register/begin", json!({ "token": token_of(link) }), ""), t));
    let challenge = unb64u(begin["publicKey"]["challenge"].as_str().unwrap()).unwrap();
    let credential = if attested { a.register_full(RP, ORIGIN, &challenge, AAGUID, Some(true)) } else { a.register(RP, ORIGIN, &challenge, false) };
    send(c, call("POST", "/console/api/register/finish", json!({ "ceremony": begin["ceremony"], "credential": credential, "label": "Laptop" }), ""), t)
}

fn register(c: &Console, a: &mut Authenticator, link: &str, t: i64) -> ConsoleReply {
    register_with(c, a, link, t, false)
}

/// The first admin (the pinned email) from a hub invite: the session cookie.
fn enrol_first(c: &Console, a: &mut Authenticator, t: i64) -> String {
    let inv = c.invite(ALICE, HUB_NODE, HUB_SERIAL, &dialed(HOST), t).unwrap();
    let r = register(c, a, &inv.link, t);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    assert_eq!(json_of(&r)["state"], "active");
    cookie(&r)
}

/// The first admin under High, with an attested security key (it bootstraps the console): the session cookie.
fn enrol_first_high(c: &Console, a: &mut Authenticator, t: i64) -> String {
    let inv = c.invite(ALICE, HUB_NODE, HUB_SERIAL, &dialed(HOST), t).unwrap();
    let r = register_with(c, a, &inv.link, t, true);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    assert_eq!(states(&r), "active working");
    assert_eq!(json_of(&r)["attested"]["fips"], true);
    assert!(c.inner.lock().book.bootstrapped);
    cookie(&r)
}

fn attested_verdict() -> Verdict {
    // A stored verdict always names its chain (console_mds reads an empty one as not a verdict).
    let chain = vec![crate::codec::sha256_hex(&crate::console_webauthn::testkit::test_root_der())];
    Verdict { aaguid: aaguid_text(), description: format!("Test security key {}", aaguid_text()), fips: true, hardware_key: true, listed: false, mds_no: 1, chain_sha256: chain }
}

/// A working WebAuthn method of `a`: a passkey, or an attested security key of the test model.
fn key_of(a: &Authenticator, anchor: &str, attested: bool) -> Passkey {
    Passkey {
        id: b64u(&a.id),
        cose: b64u(&a.cose()),
        count: 0,
        label: "Key".into(),
        created: T0,
        last_used: T0,
        state: KeyState::Working,
        anchor: anchor.into(),
        invited_by: None,
        revoked_at: None,
        rk: Some(true),
        from: None,
        kind: if attested { KeyKind::SecurityKey } else { KeyKind::Passkey },
        verdict: attested.then(attested_verdict),
    }
}

/// A person put straight into the book with a working method from `a`, the account and the method anchored to
/// `anchor`.
fn add_person_with(c: &Console, a: &Authenticator, email: &str, role: PersonRole, anchor: &str, attested: bool) {
    let mut inner = c.inner.lock();
    let mut p = Person::new(format!("h-{email}"), role, PersonState::Active, anchor, T0);
    p.last_sign_in = T0;
    p.passkeys.push(key_of(a, anchor, attested));
    inner.book.people.insert(email.into(), p);
    inner.book.latch_two();
}

fn add_person(c: &Console, a: &Authenticator, email: &str, role: PersonRole, anchor: &str) {
    add_person_with(c, a, email, role, anchor, false);
}

/// A person with no sign-in method yet (methods are given with `set_password` and `set_totp`).
fn add_bare(c: &Console, email: &str, role: PersonRole) {
    let mut inner = c.inner.lock();
    inner.book.people.insert(email.into(), Person::new(format!("h-{email}"), role, PersonState::Active, CONSOLE_ANCHOR, T0));
}

fn set_password(c: &Console, email: &str, password: &str, anchor: &str) {
    let hash = crate::console_password::hash_new(password).unwrap();
    let mut inner = c.inner.lock();
    inner.book.people.get_mut(email).unwrap().password = Some(PasswordMethod { hash, anchor: anchor.into(), invited_by: None, created: T0, revoked_at: None });
}

/// An authenticator app for `email`, its secret sealed: the secret.
fn set_totp(c: &Console, email: &str, anchor: &str) -> Vec<u8> {
    let secret = vec![0x42u8; 20];
    let name = {
        let mut inner = c.inner.lock();
        let p = inner.book.people.get_mut(email).unwrap();
        p.totp = Some(TotpMethod { anchor: anchor.into(), invited_by: None, created: T0, last_step: None, revoked_at: None, unusable: false });
        p.totp_secret_name()
    };
    c.seal_put(&name, &secret).unwrap();
    secret
}

/// The break-glass account as complete under High: an attested security key of `a` and a password, anchor "operator".
fn add_break_glass(c: &Console, a: &Authenticator, email: &str, password: &str) {
    let hash = crate::console_password::hash_new(password).unwrap();
    let mut inner = c.inner.lock();
    let mut p = Person::new(format!("h-{email}"), PersonRole::Admin, PersonState::Active, OPERATOR_ANCHOR, T0);
    p.break_glass = true;
    p.invited_by = Some("operator".into());
    p.passkeys.push(key_of(a, OPERATOR_ANCHOR, true));
    p.password = Some(PasswordMethod { hash, anchor: OPERATOR_ANCHOR.into(), invited_by: None, created: T0, revoked_at: None });
    inner.book.people.insert(email.into(), p);
    inner.book.latch_two();
}

/// The RFC 6238 code at `t` (ms).
fn code_at(secret: &[u8], t: i64) -> String {
    crate::console_password::totp_at(secret, t.div_euclid(30_000))
}

/// RFC 4648 base32 (upper case, no padding) back to bytes.
fn unbase32(s: &str) -> Vec<u8> {
    let mut out = Vec::new();
    let (mut buf, mut bits) = (0u64, 0u32);
    for c in s.bytes() {
        let v = u64::from(match c {
            b'A'..=b'Z' => c - b'A',
            b'2'..=b'7' => c - b'2' + 26,
            _ => continue,
        });
        buf = (buf << 5) | v;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
            buf &= (1u64 << bits) - 1;
        }
    }
    out
}

/// Mail on (SMTP), every mail recorded instead of sent.
fn mail_on(c: &Console) {
    c.mailer.capture();
    let smtp = SmtpConfig { host: "mail.acme.example".into(), port: 587, tls: SmtpTls::StartTls, username: String::new(), password: String::new(), ca_pem: None };
    c.mailer.configure(MailConfig { mode: Mode::Smtp, from: "console@acme.example".into(), smtp: Some(smtp), graph: None });
}

/// The captured mails of `kind`: (to, args).
fn mailed(c: &Console, kind: &str) -> Vec<(String, Vec<(String, String)>)> {
    c.mailer.captured().into_iter().filter(|(k, _, _)| k == kind).map(|(_, to, args)| (to, args)).collect()
}

fn arg<'a>(args: &'a [(String, String)], name: &str) -> &'a str {
    args.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str()).unwrap_or("")
}

/// A settings/email body for SMTP at `host`, with a user name and password when `secret`.
fn smtp_body(host: &str, secret: bool) -> Value {
    let smtp = if secret {
        json!({ "host": host, "port": 587, "tls": "starttls", "username": "console", "password": "Smtp-Secret-7781" })
    } else {
        json!({ "host": host, "port": 587, "tls": "starttls" })
    };
    json!({ "mode": "smtp", "from": "console@acme.example", "smtp": smtp, "reason": "Mail for the console" })
}

/// Sign in with `a`'s passkey from `peer`, `begin` the login/begin body: the login/finish answer.
fn sign_in_with(c: &Console, a: &mut Authenticator, peer: &str, begin: Value, t: i64) -> ConsoleReply {
    let r = send_from(c, "/console/api/login/begin", begin, "", peer, t);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    let begin = json_of(&r);
    let challenge = unb64u(begin["publicKey"]["challenge"].as_str().unwrap()).unwrap();
    let got = a.assert(RP, ORIGIN, &challenge, None);
    send_from(c, "/console/api/login/finish", json!({ "ceremony": begin["ceremony"], "credential": got }), "", peer, t)
}

/// Sign in with `a`'s passkey from `peer`: the answer.
fn sign_in_from(c: &Console, a: &mut Authenticator, peer: &str, t: i64) -> ConsoleReply {
    sign_in_with(c, a, peer, json!({}), t)
}

fn sign_in(c: &Console, a: &mut Authenticator, t: i64) -> ConsoleReply {
    sign_in_from(c, a, "192.0.2.7", t)
}

fn login(c: &Console, a: &mut Authenticator, t: i64) -> String {
    let r = sign_in(c, a, t);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    cookie(&r)
}

/// Standard: the email, the password, then the authenticator app's code at `t`: the last answer.
fn sign_in_totp(c: &Console, email: &str, password: &str, secret: &[u8], peer: &str, t: i64) -> ConsoleReply {
    let begin = json_of(&send_from(c, "/console/api/login/begin", json!({ "email": email }), "", peer, t));
    let r = send_from(c, "/console/api/login/password", json!({ "ceremony": begin["ceremony"], "password": password }), "", peer, t);
    if r.status != 200 {
        return r;
    }
    assert_eq!(json_of(&r)["next"], "totp", "{}", text_of(&r));
    send_from(c, "/console/api/login/totp", json!({ "ceremony": begin["ceremony"], "code": code_at(secret, t) }), "", peer, t)
}

/// POST stepup/begin: the answer.
fn stepup_begin(c: &Console, sid: &str, action: &str, target: &str, params: &Value, t: i64) -> Value {
    let r = send(c, call("POST", "/console/api/stepup/begin", json!({ "action": action, "target": target, "params": params }), sid), t);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    json_of(&r)
}

/// The credential ids a WebAuthn options object allows.
fn allow_ids(v: &Value) -> Vec<String> {
    v["publicKey"]["allowCredentials"].as_array().unwrap().iter().map(|x| x["id"].as_str().unwrap().to_owned()).collect()
}

/// A step-up for `action`, `target` and `params` by `a` in the session `sid`: the `stepup` object.
fn stepup(c: &Console, sid: &str, a: &mut Authenticator, action: &str, target: &str, params: &Value, t: i64) -> Value {
    let v = stepup_begin(c, sid, action, target, params, t);
    let challenge = unb64u(v["publicKey"]["challenge"].as_str().unwrap()).unwrap();
    json!({ "ceremony": v["ceremony"], "credential": a.assert(RP, ORIGIN, &challenge, None) })
}

/// A step-up by an authenticator app's code: the `stepup` object.
fn stepup_code(c: &Console, sid: &str, action: &str, target: &str, params: &Value, code: &str, t: i64) -> Value {
    let v = stepup_begin(c, sid, action, target, params, t);
    json!({ "ceremony": v["ceremony"], "totp": code })
}

/// POST `path` with `body` and a step-up for it.
#[allow(clippy::too_many_arguments)]
fn post_su(c: &Console, sid: &str, a: &mut Authenticator, path: &str, action: &str, target: &str, body: Value, t: i64) -> ConsoleReply {
    let su = stepup(c, sid, a, action, target, &body, t);
    let mut b = body;
    b["stepup"] = su;
    send(c, call("POST", path, b, sid), t)
}

/// passkeys/add or account/security-key with a step-up by `by`, registering `new` (a passkey, or an attested
/// security key of the test model): the finish answer.
#[allow(clippy::too_many_arguments)]
fn add_method(c: &Console, sid: &str, by: &mut Authenticator, route: &str, action: &str, new: &mut Authenticator, attested: bool, t: i64) -> ConsoleReply {
    let r = post_su(c, sid, by, &format!("/console/api/{route}/begin"), action, "-", json!({}), t);
    assert_eq!(r.status, 200, "{route}: {}", text_of(&r));
    let begin = json_of(&r);
    let challenge = unb64u(begin["publicKey"]["challenge"].as_str().unwrap()).unwrap();
    let reg = if attested { new.register_full(RP, ORIGIN, &challenge, AAGUID, Some(true)) } else { new.register(RP, ORIGIN, &challenge, false) };
    send(c, call("POST", &format!("/console/api/{route}/finish"), json!({ "ceremony": begin["ceremony"], "credential": reg, "label": "New key" }), sid), t)
}

fn entries(c: &Console) -> Vec<Map<String, Value>> {
    c.audit.lock().entries()
}

/// The newest entry of `action`.
fn last_entry(c: &Console, action: &str) -> Map<String, Value> {
    entries(c).into_iter().rev().find(|e| e["action"] == action).unwrap_or_else(|| panic!("no {action} entry"))
}

fn attention_kinds(c: &Console, sid: &str, t: i64) -> Vec<String> {
    let v = json_of(&send(c, get("/console/api/overview", sid), t));
    v["attention"].as_array().map(|a| a.iter().filter_map(|x| x["kind"].as_str().map(str::to_owned)).collect()).unwrap_or_default()
}

fn banner_ids(c: &Console, sid: &str, t: i64) -> Vec<String> {
    let v = json_of(&send(c, get("/console/api/overview", sid), t));
    v["banners"].as_array().map(|a| a.iter().filter_map(|x| x["id"].as_str().map(str::to_owned)).collect()).unwrap_or_default()
}

fn logged(b: &Built, event: &str) -> bool {
    let needle = format!("\"event\":\"{event}\"");
    lines_of(&b.log).iter().any(|l| l.contains(&needle))
}

// ── Kept from the control panel, with AC-1's changes ────────────────────────────────────────────────────────

#[test]
fn an_invite_is_a_link_good_once_for_24_hours() {
    let b = build("invite");
    let c = &b.c;
    let inv = c.invite(ALICE, HUB_NODE, HUB_SERIAL, &dialed(HOST), T0).unwrap();
    assert_eq!(inv.origin, ORIGIN);
    assert_eq!(inv.expires, T0 + 24 * HOUR);
    let token = token_of(&inv.link);
    assert!(inv.link.starts_with("https://relay.example.com:8787/console/#join="));
    assert_eq!(token.len(), 43);
    // The book keeps the token's hash, never the token.
    let saved = std::fs::read_to_string(&c.file).unwrap();
    assert!(!saved.contains(&token) && saved.contains(&crate::codec::sha256_hex(token.as_bytes())));
    let ok = send(c, call("POST", "/console/api/join", json!({ "token": token }), ""), T0 + 1000);
    assert_eq!(json_of(&ok)["email"], ALICE);
    let late = send(c, call("POST", "/console/api/join", json!({ "token": token }), ""), T0 + 24 * HOUR);
    assert_eq!(late.status, 410);
    // A newer invite for the same person replaces the older one.
    let again = c.invite(ALICE, HUB_NODE, HUB_SERIAL, &dialed(HOST), T0 + 2000).unwrap();
    assert_eq!(send(c, call("POST", "/console/api/join", json!({ "token": token }), ""), T0 + 3000).status, 410);
    // Used once: registering a passkey spends it.
    let mut a = Authenticator::new(3);
    let t2 = token_of(&again.link);
    let begin = json_of(&send(c, call("POST", "/console/api/register/begin", json!({ "token": t2 }), ""), T0 + 4000));
    assert_eq!(begin["publicKey"]["rp"]["id"], RP);
    assert_eq!(begin["publicKey"]["authenticatorSelection"]["userVerification"], "required");
    assert_eq!(begin["publicKey"]["authenticatorSelection"]["residentKey"], "preferred");
    assert_eq!(begin["publicKey"]["extensions"]["credProps"], true);
    let challenge = unb64u(begin["publicKey"]["challenge"].as_str().unwrap()).unwrap();
    let reg = a.register(RP, ORIGIN, &challenge, true);
    let r = send(c, call("POST", "/console/api/register/finish", json!({ "ceremony": begin["ceremony"], "credential": reg }), ""), T0 + 5000);
    assert_eq!(r.status, 200);
    assert_eq!(json_of(&r), json!({ "ok": true, "state": "active", "passkey": "working", "attested": null }));
    assert!(cookie(&r).starts_with("__Host-lrc="));
    let set = header(&r, "Set-Cookie").unwrap();
    assert!(set.contains("Secure") && set.contains("HttpOnly") && set.contains("SameSite=Strict") && set.contains("Path=/"));
    // A browser session cookie (3.4): no Max-Age, no Expires, no Domain.
    assert!(!set.contains("Max-Age") && !set.contains("Expires") && !set.contains("Domain"));
    assert_eq!(send(c, call("POST", "/console/api/join", json!({ "token": t2 }), ""), T0 + 6000).status, 410);
    assert!(lines_of(&b.log).iter().any(|l| l.contains("\"event\":\"console.passkey-registered\"") && l.contains(ALICE)));
    // The person and passkey survive a restart (the relay's lock goes with the first console).
    let file = c.file.clone();
    drop(b);
    let again = build_in(file.parent().unwrap().to_owned(), None, "0.0.0.0/0", "", false).unwrap();
    assert!(again.c.inner.lock().book.people.contains_key(ALICE));
}

#[test]
fn an_invite_needs_a_dns_name_and_the_console_origin() {
    let b = build("origin");
    let c = &b.c;
    let e = c.invite(ALICE, HUB_NODE, HUB_SERIAL, &dialed("10.0.0.5:8787"), T0).err().unwrap();
    assert_eq!(e.status, 409);
    assert!(e.error.contains("IP address"));
    assert_eq!(c.invite(ALICE, HUB_NODE, HUB_SERIAL, &Dialed { host: "[::1]:8787".into(), hostname: "[::1]".into(), port: 8787 }, T0).err().unwrap().status, 409);
    // Port 443, given or not, is the same origin.
    assert_eq!(c.invite(ALICE, HUB_NODE, HUB_SERIAL, &dialed("relay.example.com:443"), T0).unwrap().origin, "https://relay.example.com");
    assert_eq!(c.invite(ALICE, HUB_NODE, HUB_SERIAL, &Dialed { host: "relay.example.com".into(), hostname: "relay.example.com".into(), port: 80 }, T0).unwrap().origin, "https://relay.example.com");
    let e = c.invite(ALICE, HUB_NODE, HUB_SERIAL, &dialed("other.example.com"), T0).err().unwrap();
    assert_eq!(e.status, 409);
    assert!(e.error.contains("https://relay.example.com"));
}

#[test]
fn posts_need_the_console_origin_and_header() {
    let b = build("posts");
    let c = &b.c;
    c.invite(ALICE, HUB_NODE, HUB_SERIAL, &dialed(HOST), T0).unwrap();
    let mut k = call("POST", "/console/api/login/begin", json!({}), "");
    k.marker = None;
    let r = send(c, k, T0);
    assert_eq!((r.status, r.close, code(&r).as_str()), (403, true, "origin"));
    let mut k = call("POST", "/console/api/login/begin", json!({}), "");
    k.origin = Some("https://evil.example");
    assert_eq!(send(c, k, T0).status, 403);
    let mut k = call("POST", "/console/api/login/begin", json!({}), "");
    k.origin = None;
    assert_eq!(send(c, k, T0).status, 403);
    let mut k = call("POST", "/console/api/login/begin", json!({}), "");
    k.content_type = "text/plain";
    assert_eq!(send(c, k, T0).status, 415);
    assert!(lines_of(&b.log).iter().filter(|l| l.contains("\"event\":\"console.refused\"")).count() >= 3);
    let ok = send(c, call("POST", "/console/api/login/begin", json!({}), ""), T0);
    assert_eq!(ok.status, 200);
    assert_eq!(json_of(&ok)["publicKey"]["rpId"], RP);
    // The API answers only at the console's origin, and only with a session.
    let mut k = get("/console/api/me", "");
    k.host = "other.example.com";
    assert_eq!(send(c, k, T0).status, 409);
    assert_eq!(send(c, get("/console/api/overview", ""), T0).status, 401);
    assert_eq!(send(c, get("/console/api/logs", ""), T0).status, 401);
    // `status` is gone (now `overview`): not served.
    assert_eq!(send(c, get("/console/api/status", ""), T0).status, 404);
    // Every answer carries the page's protections.
    let page = send(c, get("/console/", ""), T0);
    assert_eq!(page.status, 200);
    assert_eq!(header(&page, "Content-Security-Policy"), Some(CSP));
    assert_eq!(header(&page, "X-Frame-Options"), Some("DENY"));
    assert!(header(&page, "ETag").is_some_and(|e| e.len() == 66));
    assert_eq!(header(&page, "Cache-Control"), Some("no-cache"));
}

#[test]
fn a_console_with_no_origin_names_its_pinned_first_admin() {
    let b = build("empty");
    let r = send(&b.c, get("/console/api/me", ""), T0);
    assert_eq!((r.status, code(&r).as_str()), (409, "bootstrap-pinned"));
    assert_eq!(json_of(&r)["error"], "This console waits for its first admin, alice@acme.example.");
    assert_eq!(send(&b.c, get("/console/app.js", ""), T0).status, 200);
}

#[test]
fn a_session_signs_in_with_the_passkey_and_ends() {
    let b = build("session");
    let c = &b.c;
    let mut a = Authenticator::new(5);
    let sid = enrol_first(c, &mut a, T0);
    let me = json_of(&send(c, get("/console/api/me", &sid), T0 + 1000));
    assert_eq!(me["user"]["email"], ALICE);
    assert_eq!(me["product"], "spokes");
    assert_eq!(me["sections"], json!(["overview", "spokes", "approvals", "admins"]));
    let st = send(c, get("/console/api/overview", &sid), T0 + 2000);
    assert_eq!(st.status, 200);
    assert_eq!(json_of(&st)["relay"]["version"], "test");
    // Idle past 15 minutes: signed out.
    assert_eq!(send(c, get("/console/api/overview", &sid), T0 + 2000 + 15 * MIN + 1).status, 401);
    // Sign in again with the passkey: no email, no credentials offered.
    let t = T0 + HOUR;
    let begin = send(c, call("POST", "/console/api/login/begin", json!({}), ""), t);
    assert_eq!(json_of(&begin)["publicKey"]["allowCredentials"], json!([]));
    // With an email (revision 4): the one answer shape, exactly 4 ids.
    let r = send(c, call("POST", "/console/api/login/begin", json!({ "email": ALICE }), ""), t);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    assert_eq!(allow_ids(&json_of(&r)).len(), 4);
    let begin = json_of(&begin);
    let challenge = unb64u(begin["publicKey"]["challenge"].as_str().unwrap()).unwrap();
    let got = a.assert(RP, ORIGIN, &challenge, None);
    let r = send(c, call("POST", "/console/api/login/finish", json!({ "ceremony": begin["ceremony"], "credential": got }), ""), t);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    let sid2 = cookie(&r);
    assert_ne!(sid2, sid);
    assert_eq!(send(c, get("/console/api/overview", &sid2), t + 1).status, 200);
    assert!(lines_of(&b.log).iter().any(|l| l.contains("\"event\":\"console.signin\"")));
    // A ceremony is used once; the one sentence answers it.
    let again = send(c, call("POST", "/console/api/login/finish", json!({ "ceremony": begin["ceremony"], "credential": got }), ""), t);
    assert_eq!((again.status, code(&again).as_str(), json_of(&again)["error"].as_str()), (403, "signin-refused", Some(SIGNIN)));
    // A counter that goes backwards is a copied passkey.
    a.count = 0;
    let r = sign_in(c, &mut a, t + 3);
    assert_eq!((r.status, json_of(&r)["error"].as_str()), (403, Some(SIGNIN)));
    assert!(lines_of(&b.log).iter().any(|l| l.contains("\"event\":\"console.signin-refused\"") && l.contains("counter")));
    a.count = 100;
    // Another passkey, never registered here, is refused with the same words.
    let r = sign_in(c, &mut Authenticator::new(9), t + 4);
    assert_eq!((r.status, json_of(&r)["error"].as_str()), (403, Some(SIGNIN)));
    // Sign out: the cookie is cleared and the session is gone.
    let out = send(c, call("POST", "/console/api/logout", json!({}), &sid2), t + 6);
    assert!(header(&out, "Set-Cookie").unwrap().contains("Max-Age=0"));
    assert_eq!(send(c, get("/console/api/overview", &sid2), t + 7).status, 401);
    // At most 12 hours, however busy (activity every 10 minutes).
    let sid3 = login(c, &mut a, t + 10);
    for step in 1..=73i64 {
        let s = send(c, get("/console/api/overview", &sid3), t + 10 + step * 10 * MIN).status;
        assert_eq!(s, if step <= 72 { 200 } else { 401 }, "after {} minutes", step * 10);
    }
}

#[test]
fn only_a_persons_own_actions_keep_a_session_alive() {
    let b = build("activity");
    let c = &b.c;
    let mut a = Authenticator::new(5);
    let sid = enrol_first(c, &mut a, T0);
    // The page's own refresh (no X-Lucid-Activity) does not count.
    let mut k = get("/console/api/overview", &sid);
    k.activity = false;
    assert_eq!(send(c, k, T0 + 10 * MIN).status, 200);
    assert_eq!(send(c, get("/console/api/overview", &sid), T0 + 16 * MIN).status, 401);
}

#[test]
fn a_registration_for_another_site_is_refused() {
    let b = build("othersite");
    let c = &b.c;
    let inv = c.invite(ALICE, HUB_NODE, HUB_SERIAL, &dialed(HOST), T0).unwrap();
    let token = token_of(&inv.link);
    let begin = json_of(&send(c, call("POST", "/console/api/register/begin", json!({ "token": token }), ""), T0));
    let challenge = unb64u(begin["publicKey"]["challenge"].as_str().unwrap()).unwrap();
    let reg = Authenticator::new(4).register("evil.example", "https://evil.example", &challenge, false);
    let r = send(c, call("POST", "/console/api/register/finish", json!({ "ceremony": begin["ceremony"], "credential": reg }), ""), T0);
    assert_eq!(r.status, 403);
    assert!(header(&r, "Set-Cookie").is_none());
    // The invite is still good for the real passkey.
    assert_eq!(send(c, call("POST", "/console/api/join", json!({ "token": token }), ""), T0).status, 200);
}

#[test]
fn a_passkey_the_device_does_not_keep_signs_in_only_with_its_email() {
    let b = build("credprops");
    let c = &b.c;
    let inv = c.invite(ALICE, HUB_NODE, HUB_SERIAL, &dialed(HOST), T0).unwrap();
    let begin = json_of(&send(c, call("POST", "/console/api/register/begin", json!({ "token": token_of(&inv.link) }), ""), T0));
    let challenge = unb64u(begin["publicKey"]["challenge"].as_str().unwrap()).unwrap();
    let mut a = Authenticator::new(4);
    let reg = a.register_rk(RP, ORIGIN, &challenge, false, Some(false));
    let r = send(c, call("POST", "/console/api/register/finish", json!({ "ceremony": begin["ceremony"], "credential": reg }), ""), T0);
    // credProps.rk false is accepted (revision 4): a method that is not discoverable.
    assert_eq!(r.status, 200, "{}", text_of(&r));
    assert_eq!(c.inner.lock().book.people[ALICE].passkeys[0].rk, Some(false));
    // Without an email it signs nobody in.
    let r = sign_in(c, &mut a, T0 + 1);
    assert_eq!((r.status, code(&r).as_str(), json_of(&r)["error"].as_str()), (403, "signin-refused", Some(SIGNIN)));
    // With its email it fills the first slot of allowCredentials and signs in.
    let begin = json_of(&send(c, call("POST", "/console/api/login/begin", json!({ "email": ALICE }), ""), T0 + 2));
    let allow = allow_ids(&begin);
    assert_eq!((allow.len(), allow[0].as_str()), (4, b64u(&a.id).as_str()));
    let challenge = unb64u(begin["publicKey"]["challenge"].as_str().unwrap()).unwrap();
    let got = a.assert(RP, ORIGIN, &challenge, None);
    let r = send(c, call("POST", "/console/api/login/finish", json!({ "ceremony": begin["ceremony"], "credential": got }), ""), T0 + 2);
    assert_eq!(r.status, 200, "{}", text_of(&r));
}

#[test]
fn sign_in_attempts_are_limited_per_address() {
    let b = build("limit");
    let c = &b.c;
    c.invite(ALICE, HUB_NODE, HUB_SERIAL, &dialed(HOST), T0).unwrap();
    for i in 0..30 {
        assert_eq!(send(c, call("POST", "/console/api/login/begin", json!({}), ""), T0 + i).status, 200);
    }
    let r = send(c, call("POST", "/console/api/login/begin", json!({}), ""), T0 + 100);
    assert_eq!((r.status, code(&r).as_str()), (429, "rate"));
    assert_eq!(header(&r, "Retry-After"), Some("600"));
    let mut other = call("POST", "/console/api/login/begin", json!({}), "");
    other.peer = "198.51.100.9";
    assert_eq!(send(c, other, T0 + 100).status, 200);
    // An IPv6 source counts by its /64.
    for i in 0..30 {
        let mut k = call("POST", "/console/api/login/begin", json!({}), "");
        k.peer = if i % 2 == 0 { "2001:db8:1:2::1" } else { "2001:db8:1:2::ffff" };
        assert_eq!(send(c, k, T0 + i).status, 200);
    }
    let mut k = call("POST", "/console/api/login/begin", json!({}), "");
    k.peer = "2001:db8:1:2:abcd::9";
    assert_eq!(send(c, k, T0 + 50).status, 429);
    assert_eq!(send(c, call("POST", "/console/api/login/begin", json!({}), ""), T0 + 600_000).status, 200);
}

#[test]
fn failed_assertions_slow_one_source_for_one_passkey() {
    let b = build("slow");
    let c = &b.c;
    let mut a = Authenticator::new(5);
    enrol_first(c, &mut a, T0);
    // Five failed assertions with alice's passkey from one source (signed over the wrong challenge).
    for i in 0..5 {
        let begin = json_of(&send(c, call("POST", "/console/api/login/begin", json!({}), ""), T0 + i));
        let got = a.assert(RP, ORIGIN, b"not the challenge", None);
        let r = send(c, call("POST", "/console/api/login/finish", json!({ "ceremony": begin["ceremony"], "credential": got }), ""), T0 + i);
        assert_eq!((r.status, json_of(&r)["error"].as_str()), (403, Some(SIGNIN)));
    }
    let r = sign_in(c, &mut a, T0 + 10);
    assert_eq!((r.status, code(&r).as_str()), (429, "signin-wait"));
    assert_eq!(json_of(&r)["error"], "Too many tries. Try again in 10 minutes.");
    // Another source is never affected; nobody is locked out by name.
    assert_eq!(sign_in_from(c, &mut a, "198.51.100.9", T0 + 11).status, 200);
    assert_eq!(sign_in(c, &mut a, T0 + 10 * MIN + 10).status, 200);
}

#[test]
fn ceremony_eviction_takes_from_the_source_holding_the_most() {
    let mut inner = crate::console_auth::Inner::default();
    let mk = |source: &str| Ceremony {
        kind: Kind::Login,
        challenge: vec![0],
        expires: T0 + 1000,
        email: String::new(),
        invite: String::new(),
        handle: String::new(),
        source: source.into(),
        began: T0,
        stage: Stage::Begin,
        account: String::new(),
        method: String::new(),
        key_kind: KeyKind::Passkey,
        banner: false,
    };
    let victim = inner.ceremony(mk("victim"), T0).unwrap();
    for i in 0..249 {
        for _ in 0..4 {
            inner.ceremony(mk(&format!("s{i}")), T0).unwrap();
        }
    }
    for _ in 0..3 {
        inner.ceremony(mk("big"), T0).unwrap();
    }
    assert_eq!(inner.ceremonies.len(), 1000);
    inner.ceremony(mk("newcomer"), T0).unwrap();
    assert_eq!(inner.ceremonies.len(), 1000);
    assert!(inner.ceremonies.contains_key(&victim));
    // One source holds at most 4: its own oldest goes.
    let first = inner.ceremony(mk("one"), T0).unwrap();
    for _ in 0..4 {
        inner.ceremony(mk("one"), T0).unwrap();
    }
    assert_eq!(inner.ceremonies.values().filter(|x| x.source == "one").count(), 4);
    assert!(!inner.ceremonies.contains_key(&first) && inner.ceremonies.contains_key(&victim));
}

// ── Sources (3.1) ───────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn the_console_answers_only_its_networks() {
    let b = build_in(temp_dir("sources"), Some(ALICE), "10.0.0.0/8", "", false).unwrap();
    let c = &b.c;
    c.invite(ALICE, HUB_NODE, HUB_SERIAL, &dialed(HOST), T0).unwrap();
    let at = |peer: &str| {
        let mut k = get("/console/api/me", "");
        k.peer = peer;
        send(c, k, T0)
    };
    assert_eq!(at("10.1.2.3").status, 200);
    assert_eq!(at("::ffff:10.1.2.3").status, 200);
    let r = at("203.0.113.7");
    assert_eq!((r.status, r.close, code(&r).as_str()), (403, true, "source"));
    assert_eq!(json_of(&r)["error"], SOURCE_REFUSED);
    assert_eq!(at("::ffff:203.0.113.7").status, 403);
    // The page itself is refused outside the list too, and the refusal is logged once a minute per address.
    let mut k = get("/console/", "");
    k.peer = "203.0.113.7";
    assert_eq!(send(c, k, T0).status, 403);
    assert_eq!(lines_of(&b.log).iter().filter(|l| l.contains("\"event\":\"console.refused\"") && l.contains("203.0.113.7")).count(), 1);
}

#[test]
fn behind_a_front_only_trusted_fronts_name_the_client() {
    let b = build_in(temp_dir("fronts"), Some(ALICE), "10.0.0.0/8", "10.9.0.1,10.9.0.2", true).unwrap();
    let c = &b.c;
    c.invite(ALICE, HUB_NODE, HUB_SERIAL, &dialed(HOST), T0).unwrap();
    let at = |peer: &str, xff: &[&str]| {
        let mut k = get("/console/api/me", "");
        k.peer = peer;
        k.forwarded = xff.iter().map(|s| (*s).to_owned()).collect();
        send(c, k, T0).status
    };
    assert_eq!(at("10.9.0.1", &["10.0.0.5"]), 200);
    // A spoofed header from an untrusted peer, never judged by the peer's address (10.1.1.1 is in the list).
    assert_eq!(at("10.1.1.1", &["10.0.0.5"]), 403);
    assert_eq!(at("10.9.0.1", &[]), 403);
    assert_eq!(at("10.9.0.1", &["10.0.0.5:4444"]), 403);
    assert_eq!(at("10.9.0.1", &["junk"]), 403);
    assert_eq!(at("10.9.0.1", &["10.0.0.5, 10.9.0.2"]), 200);
    assert_eq!(at("10.9.0.1", &["10.9.0.2"]), 403);
    // The source named by the front is outside the list.
    assert_eq!(at("10.9.0.1", &["203.0.113.7"]), 403);
}

#[test]
fn the_switch_and_its_preconditions() {
    let env = |v: &'static str| move |k: &str| (k == "LUCID_RELAY_CONSOLE").then(|| v.to_owned());
    let quiet = || Logger::capture("relay", Box::new(|_, _| {}));
    let pin = ALICE.to_string();
    let on = || SpokesFlags { first_admin: None, ..SpokesFlags::default() };
    assert!(open(on(), env(""), None, false, false, RP, quiet()).unwrap().1.is_none());
    assert!(open(on(), env("yes"), Some("x"), false, false, RP, quiet()).err().unwrap().contains("1 (on) or 0 (off)"));
    assert!(open(on(), env("1"), None, false, false, RP, quiet()).err().unwrap().contains("state folder"));
    let one = "1".to_string();
    assert!(open(SpokesFlags { console: Some(&one), ..SpokesFlags::default() }, env(""), Some("x"), true, false, RP, quiet()).err().unwrap().contains("LAN mailbox"));
    let dir = temp_dir("switch");
    let d = dir.to_string_lossy().into_owned();
    let zero = "0".to_string();
    assert!(open(SpokesFlags { console: Some(&zero), ..SpokesFlags::default() }, env("1"), Some(d.as_str()), false, false, RP, quiet()).unwrap().1.is_none());
    // On, with no admin yet: the pin is required (N3).
    assert_eq!(open(on(), env("1"), Some(d.as_str()), false, false, RP, quiet()).err().unwrap(), "the console needs --console-first-admin <email> until its first admin signs in");
    // Behind a TLS front: the trusted fronts are required.
    let with_pin = || SpokesFlags { first_admin: Some(&pin), ..SpokesFlags::default() };
    assert_eq!(open(with_pin(), env("1"), Some(d.as_str()), false, true, RP, quiet()).err().unwrap(), "the console behind a TLS front needs --console-trusted-fronts (the front's addresses)");
    // --console-profile is standard or high (3.1, R41-3); any other value refuses the start.
    let medium = "medium".to_string();
    assert_eq!(open(SpokesFlags { first_admin: Some(&pin), profile: Some(&medium), ..SpokesFlags::default() }, env("1"), Some(d.as_str()), false, false, RP, quiet()).err().unwrap(), "--console-profile must be standard or high");
    let high = "high".to_string();
    let (_, c) = open(SpokesFlags { first_admin: Some(&pin), profile: Some(&high), ..SpokesFlags::default() }, env("1"), Some(d.as_str()), false, false, RP, quiet()).unwrap();
    assert_eq!(c.unwrap().settings_now().profile, Profile::High);
    let (_, c) = open(with_pin(), env("1"), Some(d.as_str()), false, false, RP, quiet()).unwrap();
    assert_eq!(c.unwrap().settings_now().profile, Profile::Standard);
    // A range wider than /24 or /64 logs a start warning.
    let wide = "10.9.0.0/16".to_string();
    let written = Arc::new(Mutex::new(Vec::<String>::new()));
    let w = written.clone();
    let logger = Logger::capture("relay", Box::new(move |l, _| w.lock().push(l.to_owned())));
    let (logger, c) = open(SpokesFlags { first_admin: Some(&pin), trusted_fronts: Some(&wide), ..SpokesFlags::default() }, env("1"), Some(d.as_str()), false, true, RP, logger).unwrap();
    let c = c.unwrap();
    assert!(written.lock().iter().any(|l| l.contains("\"event\":\"console.fronts-wide\"") && l.contains("a trusted front range of 10.9.0.0/16 lets every host in it name the client; list only the front's addresses")));
    logger.ops("probe", &Fields::new(), Level::Info);
    assert!(c.ring.lines(&Filter { cat: None, min: Level::Debug, q: None }).iter().any(|l| l.contains("\"event\":\"probe\"")));
    // The running console holds console.lock: a second relay on the same folder does not start.
    assert!(open(with_pin(), env("1"), Some(d.as_str()), false, false, RP, quiet()).err().unwrap().contains("console.lock"));
    drop(c);
    // A book that does not read back: the console starts and answers 503 on every route.
    std::fs::write(dir.join(CONSOLE_FILE), "{\"v\":9}").unwrap();
    let (_, c) = open(with_pin(), env("1"), Some(d.as_str()), false, false, RP, quiet()).unwrap();
    let c = c.unwrap();
    // The default source list: private ranges and loopback (decision 9).
    let mut k = get("/console/api/me", "");
    k.peer = "10.0.0.7";
    let r = send(&c, k, T0);
    assert_eq!((r.status, code(&r).as_str()), (503, "state-unreadable"));
    assert_eq!(json_of(&r)["error"], "The console could not read its state; see the relay's log.");
    assert_eq!(header(&r, "Content-Security-Policy"), Some(CSP));
    let mut k = get("/console/", "");
    k.peer = "10.0.0.7";
    assert_eq!(send(&c, k, T0).status, 200);
    let mut k = get("/console/", "");
    k.peer = "203.0.113.7";
    assert_eq!(send(&c, k, T0).status, 403);
}

// ── Bootstrap (N3) ──────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn bootstrap_takes_only_the_pinned_email() {
    let b = build("pinned");
    let c = &b.c;
    let e = c.invite(BOB, HUB_NODE, HUB_SERIAL, &dialed(HOST), T0).err().unwrap();
    assert_eq!((e.status, e.error.as_str(), e.event), (409, "This console waits for its first admin, alice@acme.example.", "console.invite-refused"));
    assert!(c.inner.lock().book.invites.is_empty());
    // The pinned email's invite works; me shows the pin until bootstrap.
    c.invite(ALICE, HUB_NODE, HUB_SERIAL, &dialed(HOST), T0).unwrap();
    let me = json_of(&send(c, get("/console/api/me", ""), T0));
    assert_eq!(me["bootstrap"], json!({ "pinned": ALICE, "bootstrapped": false }));
}

fn two_pinned_invites(order: [usize; 2], name: &str) {
    let b = build(name);
    let c = &b.c;
    let i1 = c.invite(ALICE, HUB_NODE, HUB_SERIAL, &dialed(HOST), T0).unwrap();
    let i2 = c.invite(ALICE, "n_0000000000000000000000000000000b", SECOND_HUB, &dialed(HOST), T0).unwrap();
    // An invite from before AC-1 for someone else (a book carried over) goes at bootstrap.
    let old = Invite { email: "old@acme.example".into(), role: PersonRole::Admin, expires: T0 + DAY, by: HUB_NODE.into(), source: InviteSource::Hub, serial: Some(HUB_SERIAL.into()), kind: InviteKind::Join, mailed: false };
    c.inner.lock().book.invites.insert("ff".repeat(32), old);
    let links = [i1.link, i2.link];
    let mut keys = [Authenticator::new(11), Authenticator::new(12)];
    let mut answers = Vec::new();
    for i in order {
        let r = register(c, &mut keys[i], &links[i], T0 + 1);
        assert_eq!(r.status, 200);
        answers.push(states(&r));
    }
    assert_eq!(answers, vec!["active working", "active waiting"]);
    let inner = c.inner.lock();
    assert!(inner.book.bootstrapped);
    assert_eq!(inner.book.people.len(), 1);
    assert_eq!(inner.book.people[ALICE].passkeys.iter().map(|k| k.state).collect::<Vec<_>>(), vec![KeyState::Working, KeyState::Waiting]);
    assert!(inner.book.invites.values().all(|i| i.email != "old@acme.example"));
}

#[test]
fn two_invites_for_the_pinned_email_make_one_admin_in_either_order() {
    two_pinned_invites([0, 1], "pin01");
    two_pinned_invites([1, 0], "pin10");
}

#[test]
fn two_registrations_at_once_make_exactly_one_active_admin() {
    let b = build("pinrace");
    let c = &b.c;
    let i1 = c.invite(ALICE, HUB_NODE, HUB_SERIAL, &dialed(HOST), T0).unwrap();
    let i2 = c.invite(ALICE, "n_0000000000000000000000000000000b", SECOND_HUB, &dialed(HOST), T0).unwrap();
    let mut prepared = Vec::new();
    for (seed, link) in [(21u8, &i1.link), (22u8, &i2.link)] {
        let begin = json_of(&send(c, call("POST", "/console/api/register/begin", json!({ "token": token_of(link) }), ""), T0));
        let challenge = unb64u(begin["publicKey"]["challenge"].as_str().unwrap()).unwrap();
        let credential = Authenticator::new(seed).register(RP, ORIGIN, &challenge, false);
        prepared.push(json!({ "ceremony": begin["ceremony"], "credential": credential, "label": "Key" }));
    }
    let answers: Vec<Value> = std::thread::scope(|s| {
        let hs: Vec<_> = prepared.iter().map(|body| s.spawn(move || json_of(&send(c, call("POST", "/console/api/register/finish", body.clone(), ""), T0 + 1)))).collect();
        hs.into_iter().map(|h| h.join().unwrap()).collect()
    });
    let working = answers.iter().filter(|a| a["passkey"] == "working").count();
    let waiting = answers.iter().filter(|a| a["passkey"] == "waiting").count();
    assert_eq!((working, waiting), (1, 1));
    assert_eq!(c.inner.lock().book.people[ALICE].passkeys.iter().filter(|k| k.works()).count(), 1);
}

#[test]
fn after_bootstrap_a_hub_invite_makes_a_waiting_viewer_even_with_no_active_admin() {
    let b = build("waitingviewer");
    let c = &b.c;
    enrol_first(c, &mut Authenticator::new(5), T0);
    c.inner.lock().book.people.get_mut(ALICE).unwrap().state = PersonState::Suspended;
    let inv = c.invite(BOB, HUB_NODE, HUB_SERIAL, &dialed(HOST), T0).unwrap();
    let mut bob = Authenticator::new(6);
    let r = register(c, &mut bob, &inv.link, T0 + 1);
    assert_eq!(states(&r), "waiting waiting");
    assert!(header(&r, "Set-Cookie").is_none());
    let r = sign_in(c, &mut bob, T0 + 2);
    assert_eq!((r.status, code(&r).as_str()), (403, "waiting"));
    assert_eq!(c.inner.lock().book.people[BOB].role, PersonRole::Viewer);
    // A suspended admin's valid passkey answers `suspended`, after the assertion verified.
    let mut alice = Authenticator::new(5);
    alice.count = 50;
    let r = sign_in(c, &mut alice, T0 + 3);
    assert_eq!((r.status, code(&r).as_str()), (403, "suspended"));
}

#[test]
fn under_high_only_an_attested_security_key_bootstraps() {
    let b = build_high("bootstrap-high");
    let c = &b.c;
    let inv = c.invite(ALICE, HUB_NODE, HUB_SERIAL, &dialed(HOST), T0).unwrap();
    // A passkey without attestation: the console still waits for its first admin.
    let r = register_with(c, &mut Authenticator::new(5), &inv.link, T0, false);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    assert!(!c.inner.lock().book.bootstrapped);
    // The same link registers the attested security key, which bootstraps it.
    let mut key = Authenticator::new(6);
    let r = register_with(c, &mut key, &inv.link, T0 + 1, true);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    assert!(c.inner.lock().book.bootstrapped);
    let sid = login(c, &mut key, T0 + 2);
    let me = json_of(&send(c, get("/console/api/me", &sid), T0 + 3));
    assert_eq!((me["user"]["rights"].as_str(), me["profile"].as_str()), (Some("admin"), Some("high")));
}

#[test]
fn a_book_from_before_ac1_starts_bootstrapped_and_audits_the_upgrade() {
    let dir = temp_dir("upgrade-start");
    let a = Authenticator::new(5);
    let old = json!({ "v": 1, "origin": ORIGIN, "invites": {}, "admins": {
        ALICE: { "handle": "h", "created": 1, "lastSignIn": 2, "serial": HUB_SERIAL, "passkeys": [{ "id": b64u(&a.id), "cose": b64u(&a.cose()), "count": 0, "label": "Laptop", "created": 1, "lastUsed": 2 }] } } });
    std::fs::write(dir.join(CONSOLE_FILE), stringify(&old)).unwrap();
    // No pin is needed: the book holds an admin.
    let b = build_in(dir, None, "0.0.0.0/0", "", false).unwrap();
    let c = &b.c;
    {
        let inner = c.inner.lock();
        assert!(inner.book.bootstrapped);
        assert!(inner.book.people[ALICE].unproven);
        assert_eq!(inner.book.people[ALICE].passkeys[0].anchor, HUB_SERIAL);
    }
    assert_eq!(last_entry(c, "console.upgrade")["actor"], "relay");
    // No flag at the upgrade start: Standard (R41-3).
    assert_eq!((c.settings_now().profile, c.settings_now().downgraded), (Profile::Standard, false));
    let mut a = a;
    assert_eq!(sign_in(c, &mut a, T0).status, 200);
    assert!(!c.inner.lock().book.people[ALICE].unproven);
}

#[test]
fn a_book_from_before_ac1_reads_the_profile_flag_once_at_its_upgrade() {
    let dir = temp_dir("upgrade-flag");
    let a = Authenticator::new(5);
    let old = json!({ "v": 1, "origin": ORIGIN, "invites": {}, "admins": {
        ALICE: { "handle": "h", "created": 1, "lastSignIn": 2, "serial": HUB_SERIAL, "passkeys": [{ "id": b64u(&a.id), "cose": b64u(&a.cose()), "count": 0, "label": "Laptop", "created": 1, "lastUsed": 2 }] } } });
    std::fs::write(dir.join(CONSOLE_FILE), stringify(&old)).unwrap();
    let b = open_in(dir.clone(), None, "0.0.0.0/0", "", false, Some(Profile::High)).unwrap();
    assert!(b.c.inner.lock().book.bootstrapped);
    assert_eq!(b.c.settings_now().profile, Profile::High);
    assert!(!logged(&b, "console.profile-ignored"));
    drop(b);
    // The next start is bootstrapped: a changed flag is ignored.
    let b = open_in(dir, None, "0.0.0.0/0", "", false, Some(Profile::Standard)).unwrap();
    assert_eq!(b.c.settings_now().profile, Profile::High);
    assert!(logged(&b, "console.profile-ignored"));
}

#[test]
fn the_profile_at_setup_is_read_only_until_bootstrap() {
    let ignored = |b: &Built| lines_of(&b.log).iter().filter(|l| l.contains("\"event\":\"console.profile-ignored\"")).count();
    // No flag: Standard, recorded as the default at bootstrap, and no profile-standard item (R41-3).
    let b = build("profile-default");
    let c = &b.c;
    assert_eq!((c.settings_now().profile, c.settings_now().downgraded), (Profile::Standard, false));
    let mut a = Authenticator::new(5);
    let sid = enrol_first(c, &mut a, T0);
    let e = last_entry(c, "console.bootstrap");
    assert_eq!((e["actor"].as_str(), e["detail"].clone()), (Some(ALICE), json!({ "profile": "standard", "profileFrom": "default" })));
    assert!(!attention_kinds(c, &sid, T0 + 1).iter().any(|k| k == "profile-standard"));
    let dir = b.dir.clone();
    drop(b);
    // Bootstrapped: a changed flag is ignored, the book keeps its profile, and cli.profile-ignored is logged once.
    let b = open_in(dir.clone(), None, "0.0.0.0/0,::/0", "", false, Some(Profile::High)).unwrap();
    assert_eq!(b.c.settings_now().profile, Profile::Standard);
    assert_eq!(ignored(&b), 1);
    let words = crate::console_settings::profile_ignored_words("--console-profile");
    assert!(lines_of(&b.log).iter().any(|l| l.contains(&words)));
    drop(b);
    // Not logged when they agree, nor when no flag is given.
    let b = open_in(dir.clone(), None, "0.0.0.0/0,::/0", "", false, Some(Profile::Standard)).unwrap();
    assert_eq!(ignored(&b), 0);
    drop(b);
    let b = open_in(dir.clone(), None, "0.0.0.0/0,::/0", "", false, None).unwrap();
    assert_eq!(ignored(&b), 0);
    drop(b);
    // reset clears bootstrap, so the flag applies again at the next start.
    let ok = |_: &str, _: &str| -> Result<(), String> { Ok(()) };
    run_offline(&dir, Offline::Reset { first_admin: ALICE.into(), typed_host: RP.into() }, RP, &ok).unwrap();
    let b = open_in(dir, None, "0.0.0.0/0,::/0", "", false, Some(Profile::High)).unwrap();
    assert_eq!(b.c.settings_now().profile, Profile::High);
    assert_eq!(ignored(&b), 0);
}

#[test]
fn a_high_flag_before_bootstrap_gives_high_and_a_downgrade_stays_flagged() {
    let b = build_high("profile-flag");
    let dir = b.dir.clone();
    assert_eq!(b.c.settings_now().profile, Profile::High);
    drop(b);
    // Before bootstrap every start writes the flag: without it the console is Standard again, never a downgrade.
    let b = open_in(dir.clone(), Some(ALICE), "0.0.0.0/0,::/0", "", false, None).unwrap();
    assert_eq!((b.c.settings_now().profile, b.c.settings_now().downgraded), (Profile::Standard, false));
    drop(b);
    let b = open_in(dir.clone(), Some(ALICE), "0.0.0.0/0,::/0", "", false, Some(Profile::High)).unwrap();
    let c = &b.c;
    snapshot(c);
    assert_eq!(c.settings_now().profile, Profile::High);
    // The High setup gate holds ordinary writes until the break-glass account is complete.
    let mut a = Authenticator::new(5);
    let sid = enrol_first_high(c, &mut a, T0);
    assert_eq!(last_entry(c, "console.bootstrap")["detail"], json!({ "profile": "high", "profileFrom": "flag" }));
    assert!(c.break_glass_gate());
    let r = post_su(c, &sid, &mut a, "/console/api/settings/links", "settings.links", "-", json!({ "links": [] }), T0 + 1);
    assert_eq!(code(&r), "break-glass-needed");
    add_break_glass(c, &Authenticator::new(40), BG, BG_PASSWORD);
    assert!(!attention_kinds(c, &sid, T0 + 2).iter().any(|k| k == "profile-standard"));
    // High to Standard in Settings latches `downgraded`; the item stays after a restart.
    let path = "/console/api/settings/profile";
    let r = post_su(c, &sid, &mut a, path, "settings.profile", "-", json!({ "profile": "standard", "reason": "Pilot" }), T0 + 3);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    drop(b);
    let b = open_in(dir.clone(), None, "0.0.0.0/0,::/0", "", false, None).unwrap();
    let c = &b.c;
    assert!(c.settings_now().downgraded);
    let sid = login(c, &mut a, T0 + 10);
    assert!(attention_kinds(c, &sid, T0 + 11).iter().any(|k| k == "profile-standard"));
    // Editing the flag cannot move it back: ignored and logged.
    drop(b);
    let b = reopen(&dir, true);
    let c = &b.c;
    assert_eq!(c.settings_now().profile, Profile::Standard);
    assert!(logged(&b, "console.profile-ignored"));
    // Standard to High in Settings clears it.
    let sid = login(c, &mut a, T0 + 20);
    let r = post_su(c, &sid, &mut a, path, "settings.profile", "-", json!({ "profile": "high", "reason": "Harden" }), T0 + 21);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    assert!(!c.settings_now().downgraded);
    assert!(!attention_kinds(c, &sid, T0 + 22).iter().any(|k| k == "profile-standard"));
}

#[test]
fn offline_commands_wait_for_the_relay_to_stop() {
    let b = build("offline");
    let c = b.c.clone();
    enrol_first(&c, &mut Authenticator::new(41), T0);
    let inv = c.invite(BOB, HUB_NODE, HUB_SERIAL, &dialed(HOST), T0).unwrap();
    register(&c, &mut Authenticator::new(42), &inv.link, T0);
    let ok = |_: &str, _: &str| -> Result<(), String> { Ok(()) };
    let dir = b.dir.clone();
    // A running relay holds console.lock: every offline command refuses.
    let commands = [
        Offline::RemoveAdmin(ALICE.into()),
        Offline::Unsuspend(ALICE.into()),
        Offline::ApproveJoin { email: BOB.into(), admin: false },
        Offline::Reset { first_admin: ALICE.into(), typed_host: RP.into() },
        Offline::BreakGlass { email: BG.into(), replace: false, origin: None },
        Offline::TwoPersonOff,
    ];
    for cmd in commands {
        assert_eq!(run_offline(&dir, cmd, RP, &ok).err().as_deref(), Some(RUNNING));
    }
    drop(c);
    drop(b);
    // The relay is gone: they run. approve-join --role admin asks the product's check first (Meeting Hub: a relay
    // admin with a device-anchored passkey).
    let no = |_: &str, _: &str| -> Result<(), String> { Err("not a relay admin".to_owned()) };
    assert_eq!(run_offline(&dir, Offline::ApproveJoin { email: BOB.into(), admin: true }, RP, &no).err().as_deref(), Some("not a relay admin"));
    let done = run_offline(&dir, Offline::ApproveJoin { email: BOB.into(), admin: false }, RP, &ok).unwrap();
    assert!(done.contains("active as viewer"), "{done}");
    let done = run_offline(&dir, Offline::RemoveAdmin(" Alice@acme.example ".into()), RP, &ok).unwrap();
    assert!(done.contains("removed admin alice@acme.example: 1 sign-in method(s)"), "{done}");
    assert!(run_offline(&dir, Offline::RemoveAdmin(ALICE.into()), RP, &ok).err().unwrap().contains("has no admin alice@acme.example"));
    assert_eq!(run_offline(&dir, Offline::Unsuspend(BOB.into()), RP, &ok).err().unwrap(), "bob@acme.example is not suspended");
    // The next start appends the operator's entries.
    let again = build_in(dir.clone(), Some(ALICE), "0.0.0.0/0", "", false).unwrap();
    let ops: Vec<String> = entries(&again.c).iter().filter(|e| e["actor"] == "operator").map(|e| e["action"].as_str().unwrap_or("").to_owned()).collect();
    assert_eq!(ops, vec!["admins.approve-join", "admins.remove"]);
    drop(again);
    // reset needs --first-admin, clears the people and everTwoAdmins, and writes the pin.
    let done = run_offline(&dir, Offline::Reset { first_admin: "carol@acme.example".into(), typed_host: RP.into() }, RP, &ok).unwrap();
    assert!(done.contains("carol@acme.example"));
    let book = crate::console_auth::Book::read(&dir.join(CONSOLE_FILE), T0).unwrap();
    assert!(!book.bootstrapped && !book.ever_two_admins && book.people.is_empty());
    assert_eq!(book.first_admin.as_deref(), Some("carol@acme.example"));
}

// ── Waiting passkeys and joiners ────────────────────────────────────────────────────────────────────────────

#[test]
fn a_waiting_passkey_works_only_after_confirm_or_approval() {
    let b = build("waitingkeys");
    let c = &b.c;
    let mut a = Authenticator::new(5);
    let sid = enrol_first(c, &mut a, T0);
    let mut bob = Authenticator::new(6);
    add_person(c, &bob, BOB, PersonRole::Admin, SECOND_HUB);
    let bob_sid = login(c, &mut bob, T0 + 1);
    // A hub invite for an existing admin: a waiting passkey that signs nobody in.
    let inv = c.invite(ALICE, HUB_NODE, "0000000000000000000000000000000c", &dialed(HOST), T0 + 2).unwrap();
    let mut k2 = Authenticator::new(7);
    let r = register(c, &mut k2, &inv.link, T0 + 2);
    assert_eq!(states(&r), "active waiting");
    assert!(header(&r, "Set-Cookie").is_none());
    assert_eq!(sign_in(c, &mut k2, T0 + 3).status, 403);
    // Confirmed from a session of a working passkey, with step-up by that passkey.
    let hint = hint_of(&b64u(&k2.id));
    let r = post_su(c, &sid, &mut a, "/console/api/passkeys/confirm", "passkeys.confirm", &hint, json!({ "hint": hint }), T0 + 4);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    assert_eq!(sign_in(c, &mut k2, T0 + 5).status, 200);
    // Another waiting passkey, approved by another admin (an eligible approver for alice).
    let inv = c.invite(ALICE, HUB_NODE, "0000000000000000000000000000000c", &dialed(HOST), T0 + 6).unwrap();
    let mut k3 = Authenticator::new(8);
    register(c, &mut k3, &inv.link, T0 + 6);
    let h3 = hint_of(&b64u(&k3.id));
    // Alice may not approve her own.
    let r = post_su(c, &sid, &mut a, "/console/api/admins/approve-passkey", "admins.approve-passkey", ALICE, json!({ "email": ALICE, "hint": h3 }), T0 + 7);
    assert_eq!(r.status, 403);
    let r = post_su(c, &bob_sid, &mut bob, "/console/api/admins/approve-passkey", "admins.approve-passkey", ALICE, json!({ "email": ALICE, "hint": h3 }), T0 + 7);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    assert_eq!(sign_in(c, &mut k3, T0 + 8).status, 200);
    // The fourth hub invite from one certificate in a day: 429.
    let e = c.invite(ALICE, HUB_NODE, "0000000000000000000000000000000c", &dialed(HOST), T0 + 9);
    assert!(e.is_ok());
    let e = c.invite(ALICE, HUB_NODE, "0000000000000000000000000000000c", &dialed(HOST), T0 + 10).err().unwrap();
    assert_eq!((e.status, e.error.as_str()), (429, "This hub or device has asked for 3 invites today. Try again tomorrow."));
    // At most 3 waiting passkeys: a fourth replaces the oldest.
    for (i, serial) in ["d", "e", "f", "9"].iter().enumerate() {
        let inv = c.invite(ALICE, HUB_NODE, &format!("000000000000000000000000000000{serial}{serial}"), &dialed(HOST), T0 + 20 + i as i64).unwrap();
        register(c, &mut Authenticator::new(30 + i as u8), &inv.link, T0 + 20 + i as i64);
    }
    assert_eq!(c.inner.lock().book.people[ALICE].waiting_keys(), 3);
    // Waiting passkeys never block passkeys.add.
    let r = post_su(c, &sid, &mut a, "/console/api/passkeys/add/begin", "passkeys.add", "-", json!({}), T0 + 30);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    // After 7 days a waiting passkey is deleted.
    c.inner.lock().book.sweep(T0 + 8 * DAY);
    assert_eq!(c.inner.lock().book.people[ALICE].waiting_keys(), 0);
}

#[test]
fn a_waiting_joiner_is_approved_as_a_viewer_or_discarded_without_step_up() {
    let b = build("joiners");
    let c = &b.c;
    let mut a = Authenticator::new(5);
    let sid = enrol_first(c, &mut a, T0);
    for (who, seed) in [(BOB, 6u8), ("carl@acme.example", 7u8)] {
        let inv = c.invite(who, HUB_NODE, HUB_SERIAL, &dialed(HOST), T0).unwrap();
        register(c, &mut Authenticator::new(seed), &inv.link, T0);
    }
    let r = post_su(c, &sid, &mut a, "/console/api/admins/approve-join", "admins.approve-join", BOB, json!({ "email": BOB }), T0 + 1);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    let mut bob = Authenticator::new(6);
    bob.count = 10;
    let bob_sid = login(c, &mut bob, T0 + 2);
    let me = json_of(&send(c, get("/console/api/me", &bob_sid), T0 + 3));
    assert_eq!((me["user"]["role"].as_str(), me["sections"].clone()), (Some("viewer"), json!(["overview", "spokes", "admins"])));
    // Discard: {email} alone, no step-up.
    let r = send(c, call("POST", "/console/api/admins/remove", json!({ "email": "carl@acme.example" }), &sid), T0 + 4);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    assert!(!c.inner.lock().book.people.contains_key("carl@acme.example"));
}

// ── Anchors (3.2, N2) ───────────────────────────────────────────────────────────────────────────────────────

#[test]
fn a_revoked_anchor_is_latched_and_console_invites_survive_it() {
    let b = build("anchors");
    let c = &b.c;
    let mut a = Authenticator::new(21);
    let sid_alice = enrol_first(c, &mut a, T0);
    // Alice invites a viewer from the console: its passkey is anchored to "console".
    let r = post_su(c, &sid_alice, &mut a, "/console/api/admins/invite", "admins.invite", VIC, json!({ "email": VIC, "role": "viewer" }), T0 + 1);
    let link = json_of(&r)["link"].as_str().unwrap().to_owned();
    let mut vic = Authenticator::new(22);
    let r = register(c, &mut vic, &link, T0 + 2);
    assert_eq!(json_of(&r)["passkey"], "working");
    // Carol, from another hub, adds a passkey in the console: it inherits her hub's anchor (N2).
    let mut carol = Authenticator::new(23);
    add_person(c, &carol, CAROL, PersonRole::Admin, SECOND_HUB);
    let sid_carol = login(c, &mut carol, T0 + 3);
    let mut carol2 = Authenticator::new(24);
    let r = add_method(c, &sid_carol, &mut carol, "passkeys/add", "passkeys.add", &mut carol2, false, T0 + 4);
    assert_eq!((r.status, json_of(&r)["method"]["state"].as_str()), (200, Some("working")), "{}", text_of(&r));
    let added = b64u(&carol2.id);
    assert_eq!(c.inner.lock().book.people[CAROL].passkeys.iter().find(|k| k.id == added).unwrap().anchor, SECOND_HUB);
    // The CRL revokes alice's hub: her passkey latches and her session ends; the console-invited viewer goes on.
    c.set_revoked(&[HUB_SERIAL.to_owned()].into_iter().collect());
    assert!(c.inner.lock().book.people[ALICE].passkeys[0].revoked_at.is_some());
    assert_eq!(send(c, get("/console/api/overview", &sid_alice), T0 + 6).status, 401);
    // A garbage assertion with the revoked passkey gets the one sentence, never the anchor words: those come only after
    // the last factor verified (C2).
    let begin = json_of(&send(c, call("POST", "/console/api/login/begin", json!({}), ""), T0 + 7));
    let got = a.assert(RP, ORIGIN, b"not the challenge", None);
    let r = send(c, call("POST", "/console/api/login/finish", json!({ "ceremony": begin["ceremony"], "credential": got }), ""), T0 + 7);
    assert_eq!((r.status, code(&r).as_str(), json_of(&r)["error"].as_str()), (403, "signin-refused", Some(SIGNIN)));
    let r = sign_in(c, &mut a, T0 + 7);
    assert_eq!((r.status, code(&r).as_str()), (403, "anchor-revoked"));
    assert_eq!(json_of(&r)["error"], "The hub that invited this admin was revoked: ask for a new invite from a hub that is still trusted.");
    assert_eq!(sign_in(c, &mut vic, T0 + 8).status, 200);
    // The CRL later drops the serial (or the certificate's not_after passes): still refused, latched.
    c.set_revoked(&HashSet::new());
    assert_eq!(sign_in(c, &mut a, T0 + 9).status, 403);
    // Carol's hub revoked: both her passkeys latch, the added one included.
    c.set_revoked(&[SECOND_HUB.to_owned()].into_iter().collect());
    assert_eq!(sign_in(c, &mut carol2, T0 + 10).status, 403);
    assert!(c.inner.lock().book.people[CAROL].revoked());
    assert!(lines_of(&b.log).iter().any(|l| l.contains("\"event\":\"console.admin-revoked\"")));
    // No passkey in the book has an empty anchor; the latch survives a restart.
    let file = c.file.clone();
    let inner = c.inner.lock();
    assert!(inner.book.people.values().all(|p| !p.anchor.is_empty() && p.passkeys.iter().all(|k| !k.anchor.is_empty())));
    assert!(inner.book.revoked_anchors.contains(HUB_SERIAL));
    drop(inner);
    drop(b);
    let again = build_in(file.parent().unwrap().to_owned(), None, "0.0.0.0/0", "", false).unwrap();
    assert!(again.c.inner.lock().book.people[ALICE].passkeys[0].revoked_at.is_some());
    assert_eq!(again.c.inner.lock().book.people[VIC].passkeys[0].anchor, CONSOLE_ANCHOR);
}

#[test]
fn confirmed_and_approved_waiting_passkeys_keep_the_invites_anchor() {
    let b = build("inherit");
    let c = &b.c;
    let mut a = Authenticator::new(5);
    let sid = enrol_first(c, &mut a, T0);
    let hub2 = "0000000000000000000000000000000e";
    let inv = c.invite(ALICE, HUB_NODE, hub2, &dialed(HOST), T0).unwrap();
    let mut k2 = Authenticator::new(6);
    register(c, &mut k2, &inv.link, T0);
    let hint = hint_of(&b64u(&k2.id));
    assert_eq!(post_su(c, &sid, &mut a, "/console/api/passkeys/confirm", "passkeys.confirm", &hint, json!({ "hint": hint }), T0 + 1).status, 200);
    c.set_revoked(&[hub2.to_owned()].into_iter().collect());
    assert_eq!(sign_in(c, &mut k2, T0 + 2).status, 403);
    // Alice's first passkey (another hub) still works.
    assert_eq!(sign_in(c, &mut a, T0 + 3).status, 200);
}

#[test]
fn a_password_and_an_app_take_the_step_ups_anchor_and_latch_with_it() {
    let b = build("latch-methods");
    let c = &b.c;
    let mut a = Authenticator::new(5);
    let sid = enrol_first(c, &mut a, T0);
    let r = post_su(c, &sid, &mut a, "/console/api/account/password", "account.password", "-", json!({ "current": "", "password": PW }), T0 + 1);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    let r = post_su(c, &sid, &mut a, "/console/api/account/totp/begin", "account.totp", "-", json!({}), T0 + 2);
    let v = json_of(&r);
    let secret = unbase32(v["secret"].as_str().unwrap());
    let r = send(c, call("POST", "/console/api/account/totp/finish", json!({ "enrollment": v["enrollment"], "code": code_at(&secret, T0 + 2) }), &sid), T0 + 2);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    {
        let inner = c.inner.lock();
        let p = &inner.book.people[ALICE];
        assert_eq!((p.password.as_ref().unwrap().anchor.as_str(), p.totp.as_ref().unwrap().anchor.as_str()), (HUB_SERIAL, HUB_SERIAL));
    }
    // The hub is revoked: the password and the app latch with the passkey.
    c.set_revoked(&[HUB_SERIAL.to_owned()].into_iter().collect());
    {
        let inner = c.inner.lock();
        let p = &inner.book.people[ALICE];
        assert!(p.password.as_ref().unwrap().revoked_at.is_some() && p.totp.as_ref().unwrap().revoked_at.is_some());
    }
    let r = sign_in_totp(c, ALICE, PW, &secret, "198.51.100.30", T0 + 5 * MIN);
    assert_eq!((r.status, code(&r).as_str()), (403, "signin-refused"));
}

// ── Step-up (3.6) ───────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn a_step_up_is_bound_to_its_action_target_and_parameters() {
    let b = build("stepup");
    let c = &b.c;
    let mut a = Authenticator::new(5);
    let sid = enrol_first(c, &mut a, T0);
    let links = json!({ "links": [{ "label": "Meet", "url": "https://meet-admin.acme.example/console/" }] });
    let path = "/console/api/settings/links";
    // None: 401 stepup-needed, and nothing changes.
    let r = send(c, call("POST", path, links.clone(), &sid), T0);
    assert_eq!((r.status, code(&r).as_str()), (401, "stepup-needed"));
    // For another action, another target, other parameters: 403.
    for (action, target, params) in [("audit.restart", "-", links.clone()), ("settings.links", "x", links.clone()), ("settings.links", "-", json!({ "links": [] }))] {
        let su = stepup(c, &sid, &mut a, action, target, &params, T0 + 1);
        let mut body = links.clone();
        body["stepup"] = su;
        let r = send(c, call("POST", path, body, &sid), T0 + 1);
        assert_eq!((r.status, code(&r).as_str()), (403, "stepup-failed"), "{action} {target}");
    }
    assert!(c.inner.lock().book.settings.links.is_empty());
    // The right one works once; reused, it is refused.
    let su = stepup(c, &sid, &mut a, "settings.links", "-", &links, T0 + 2);
    let mut body = links.clone();
    body["stepup"] = su;
    assert_eq!(send(c, call("POST", path, body.clone(), &sid), T0 + 2).status, 200);
    assert_eq!(c.inner.lock().book.settings.links.len(), 1);
    assert_eq!(send(c, call("POST", path, body, &sid), T0 + 3).status, 403);
    // Stale: 410.
    let su = stepup(c, &sid, &mut a, "settings.links", "-", &links, T0 + 4);
    let mut body = links.clone();
    body["stepup"] = su;
    let r = send(c, call("POST", path, body, &sid), T0 + 4 + 120_001);
    assert_eq!((r.status, code(&r).as_str()), (410, "stepup-expired"));
    // From another session of the same person: refused.
    let t = T0 + 5 * MIN;
    let sid2 = login(c, &mut a, t);
    let su = stepup(c, &sid, &mut a, "settings.links", "-", &links, t + 1);
    let mut body = links.clone();
    body["stepup"] = su;
    assert_eq!(send(c, call("POST", path, body, &sid2), t + 1).status, 403);
    // By another person's passkey: refused.
    let mut bob = Authenticator::new(6);
    add_person(c, &bob, BOB, PersonRole::Admin, HUB_SERIAL);
    let v = stepup_begin(c, &sid, "settings.links", "-", &links, t + 2);
    let challenge = unb64u(v["publicKey"]["challenge"].as_str().unwrap()).unwrap();
    let mut body = links.clone();
    body["stepup"] = json!({ "ceremony": v["ceremony"], "credential": bob.assert(RP, ORIGIN, &challenge, None) });
    assert_eq!(send(c, call("POST", path, body, &sid), t + 2).status, 403);
    // A password is never a step-up.
    let v = stepup_begin(c, &sid, "settings.links", "-", &links, t + 3);
    let mut body = links.clone();
    body["stepup"] = json!({ "ceremony": v["ceremony"], "password": PW });
    assert_eq!(code(&send(c, call("POST", path, body, &sid), t + 3)), "stepup-failed");
    // A sign count that goes backwards: refused and logged.
    a.count = 0;
    let su = stepup(c, &sid, &mut a, "settings.links", "-", &links, t + 3);
    let mut body = links.clone();
    body["stepup"] = su;
    assert_eq!(send(c, call("POST", path, body, &sid), t + 3).status, 403);
    assert!(lines_of(&b.log).iter().any(|l| l.contains("\"event\":\"console.stepup-refused\"") && l.contains("counter")));
    a.count = 500;
    // Four ceremonies per session: a fifth replaces the oldest.
    let first = stepup(c, &sid, &mut a, "settings.links", "-", &links, t + 4);
    for _ in 0..4 {
        stepup(c, &sid, &mut a, "settings.links", "-", &links, t + 4);
    }
    let mut body = links.clone();
    body["stepup"] = first;
    assert_eq!(send(c, call("POST", path, body, &sid), t + 5).status, 403);
}

fn vector(name: &str) -> Value {
    let path = format!("{}/tests/{name}", env!("CARGO_MANIFEST_DIR"));
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e} (copy it from the Meeting Hub repository's tests/vectors/)"));
    parse_json(&text).unwrap()
}

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}

#[test]
fn the_stepup_vectors_and_binding_table() {
    let v = vector("admin_console_stepup_v1.json");
    assert_eq!(v["domain"], crate::console_auth::STEPUP_LABEL);
    let sid = unhex(v["sid_sha256_hex"].as_str().unwrap());
    let nonce = unhex(v["nonce_hex"].as_str().unwrap());
    let base = &v["base"];
    let got = crate::console_auth::stepup_challenge(&sid, base["action"].as_str().unwrap(), base["target"].as_str().unwrap(), &base["params"], &nonce).unwrap();
    assert_eq!(crate::codec::hex(&got), base["challenge_hex"].as_str().unwrap());
    assert_eq!(String::from_utf8(crate::console_audit::canonical_json(&base["params"]).unwrap()).unwrap(), base["params_canonical"].as_str().unwrap());
    for x in v["extra"].as_array().unwrap() {
        let got = crate::console_auth::stepup_challenge(&sid, x["action"].as_str().unwrap(), x["target"].as_str().unwrap(), &x["params"], &nonce).unwrap();
        assert_eq!(crate::codec::hex(&got), x["challenge_hex"].as_str().unwrap(), "{}", x["name"]);
    }
    for ch in v["changed"].as_array().unwrap() {
        let (mut s, mut act, mut tgt, mut prm, mut non) = (sid.clone(), base["action"].as_str().unwrap().to_owned(), base["target"].as_str().unwrap().to_owned(), base["params"].clone(), nonce.clone());
        match ch["field"].as_str().unwrap() {
            "sid_sha256" => s = unhex(ch["value"].as_str().unwrap()),
            "action" => act = ch["value"].as_str().unwrap().to_owned(),
            "target" => tgt = ch["value"].as_str().unwrap().to_owned(),
            "params" => prm = ch["value"].clone(),
            "nonce" => non = unhex(ch["value"].as_str().unwrap()),
            _ => continue,
        }
        let got = crate::console_auth::stepup_challenge(&s, &act, &tgt, &prm, &non).unwrap();
        assert_eq!(crate::codec::hex(&got), ch["challenge_hex"].as_str().unwrap(), "{}", ch["field"]);
        assert_ne!(crate::codec::hex(&got), base["challenge_hex"].as_str().unwrap());
    }
    // Every core route of the table: the same action, and the same target field.
    for row in v["routes"].as_array().unwrap() {
        let route = row["route"].as_str().unwrap();
        let Some(path) = route.strip_prefix("POST /console/api/") else { continue };
        let Some(spec) = CORE_ROUTES.iter().find(|s| s.path == path && s.method == "POST") else {
            assert!(path.starts_with("spokes/") || path.starts_with("meet/"), "{route} is not a core route");
            continue;
        };
        let Some(action) = row["action"].as_str() else { continue };
        assert_eq!(spec.action, action, "{route}");
        let target = row["target"].as_str().unwrap_or("-");
        let mine = match target {
            "{from}-{to}" | "license.id" => "-",
            t => t,
        };
        if row["stepup"] == "always" && spec.stepup {
            assert_eq!(spec.target, mine, "{route}");
        }
        if let Some(ex) = row.get("example") {
            let body: Value = ex["body"].clone();
            let mut params = body.clone();
            params.as_object_mut().unwrap().remove("stepup");
            if spec.stepup {
                assert_eq!(target_of(spec, &params), ex["target"].as_str().unwrap(), "{route}");
                assert_eq!(params, ex["params"], "{route}");
            }
            let got = crate::console_auth::stepup_challenge(&sid, action, ex["target"].as_str().unwrap(), &ex["params"], &nonce).unwrap();
            assert_eq!(crate::codec::hex(&got), ex["challenge_hex"].as_str().unwrap(), "{route}");
        }
    }
}

#[test]
fn the_audit_vectors() {
    use crate::console_audit::{entry_hash, Audit};
    let v = vector("admin_console_audit_v1.json");
    assert_eq!(v["domain"], crate::console_audit::LABEL);
    for e in v["entries"].as_array().unwrap() {
        let mut m = e.as_object().unwrap().clone();
        let canonical = m.remove("canonical").unwrap();
        let mut without = m.clone();
        without.remove("hash");
        assert_eq!(String::from_utf8(crate::console_audit::canonical_json(&Value::Object(without)).unwrap()).unwrap(), canonical.as_str().unwrap());
        assert_eq!(entry_hash(m["prev"].as_str().unwrap(), &m).as_deref(), m["hash"].as_str());
    }
    let write_seg = |dir: &std::path::Path, name: &str, text: &str| std::fs::write(dir.join(name), text).unwrap();
    // The whole chain, and each changed byte, removed entry and reordered pair.
    let run = |lines: &[Value], name: &str| {
        let dir = temp_dir(name);
        let text: String = lines.iter().map(|l| format!("{}\n", l.as_str().unwrap())).collect();
        write_seg(&dir, "console-audit-000001.jsonl", &text);
        let (a, _) = Audit::open(&dir, T0);
        a.broken().is_none() && a.verify().verified
    };
    assert!(run(v["chain"]["lines"].as_array().unwrap(), "av-chain"));
    for (i, ch) in v["changed"].as_array().unwrap().iter().enumerate() {
        let lines = v["chain"]["lines"].as_array().unwrap();
        assert!(!run(&[lines[0].clone(), ch["line"].clone(), lines[2].clone()], &format!("av-changed{i}")), "{}", ch["field"]);
    }
    assert!(!run(v["removed"]["lines"].as_array().unwrap(), "av-removed"));
    assert!(!run(v["reordered"]["lines"].as_array().unwrap(), "av-reordered"));
    // Two segments; a dropped front recorded in the head.
    let dir = temp_dir("av-segments");
    for (name, text) in v["segments"]["files"].as_object().unwrap() {
        write_seg(&dir, name, text.as_str().unwrap());
    }
    let (a, notes) = Audit::open(&dir, T0);
    assert!(notes.is_empty() && a.verify().verified && a.head().0 == 6);
    let dir = temp_dir("av-dropped");
    let seg = v["dropped_front"]["segment"].as_str().unwrap();
    write_seg(&dir, seg, v["segments"]["files"][seg].as_str().unwrap());
    std::fs::write(dir.join(crate::console_audit::HEAD_FILE), stringify(&v["dropped_front"]["head"])).unwrap();
    let (a, notes) = Audit::open(&dir, T0);
    assert!(notes.is_empty() && a.verify().verified, "{notes:?}");
    assert_eq!(a.dropped_value(), v["dropped_front"]["head"]["dropped"]);
    // A torn tail and a broken middle line: the kept prefix, the moved bytes, the torn record, the restart entry.
    for case in ["torn_tail", "broken_middle"] {
        let x = &v[case];
        let dir = temp_dir(&format!("av-{case}"));
        write_seg(&dir, "console-audit-000001.jsonl", x["segment"].as_str().unwrap());
        let (mut a, notes) = Audit::open(&dir, 1);
        assert_eq!(notes.len(), 1);
        assert_eq!(std::fs::read_to_string(dir.join("console-audit-000001.jsonl")).unwrap(), x["kept"].as_str().unwrap(), "{case}");
        let broken = a.broken().unwrap().clone();
        assert_eq!(std::fs::read_to_string(dir.join(&broken.file)).unwrap(), x["moved"].as_str().unwrap(), "{case}");
        assert_eq!(broken.lines, x["torn"]["torn_lines"].as_u64().unwrap());
        assert_eq!(broken.sha256, x["torn"]["torn_sha256"].as_str().unwrap());
        let rs = &x["restart"];
        let mut r = crate::console_audit::Record::new(rs["actor"].as_str().unwrap(), "audit.restart", "ok");
        r.role = rs["role"].as_str().map(str::to_owned);
        r.ip = rs["ip"].as_str().map(str::to_owned);
        r.stepup = true;
        let e = a.restart(rs["ts"].as_i64().unwrap(), r).unwrap();
        assert_eq!(e["hash"], rs["hash"], "{case}");
    }
}

#[test]
fn totp_step_ups_are_bound_before_the_code_and_used_once() {
    let b = build("totp-stepup");
    let c = &b.c;
    enrol_first(c, &mut Authenticator::new(5), T0);
    add_bare(c, PAT, PersonRole::Viewer);
    set_password(c, PAT, PW, CONSOLE_ANCHOR);
    let secret = set_totp(c, PAT, CONSOLE_ANCHOR);
    let t1 = T0 + 10 * MIN;
    let r = sign_in_totp(c, PAT, PW, &secret, "198.51.100.60", t1);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    let sid = cookie(&r);
    let path = "/console/api/account/password";
    let t2 = t1 + MIN;
    let body = json!({ "current": PW, "password": "Qz7!mR2#vK9@" });
    assert_eq!(stepup_begin(c, &sid, "account.password", "-", &body, t2)["totp"], true);
    // A changed body is refused before the code is checked: the code stays good for the action it was asked for.
    let mut changed = json!({ "current": PW, "password": "Another-pass-91" });
    changed["stepup"] = stepup_code(c, &sid, "account.password", "-", &body, &code_at(&secret, t2), t2);
    let r = send(c, call("POST", path, changed, &sid), t2);
    assert_eq!((r.status, code(&r).as_str(), json_of(&r)["error"].as_str()), (403, "stepup-failed", Some("That code did not confirm this. Nothing was changed.")));
    assert_eq!(c.inner.lock().book.people[PAT].totp.as_ref().unwrap().last_step, Some(t1.div_euclid(30_000)));
    let mut ok = body.clone();
    ok["stepup"] = stepup_code(c, &sid, "account.password", "-", &body, &code_at(&secret, t2), t2);
    let r = send(c, call("POST", path, ok, &sid), t2);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    // The same code for a second action: refused.
    let body2 = json!({ "current": "Qz7!mR2#vK9@", "password": PW });
    let mut again = body2.clone();
    again["stepup"] = stepup_code(c, &sid, "account.password", "-", &body2, &code_at(&secret, t2), t2 + 1);
    let r = send(c, call("POST", path, again, &sid), t2 + 1);
    assert_eq!((r.status, code(&r).as_str()), (403, "stepup-failed"));
    // Under High the app confirms nothing: stepup/begin offers no code and a code is refused.
    set_profile(c, Profile::High);
    let t3 = t2 + 5 * MIN;
    assert_eq!(stepup_begin(c, &sid, "account.password", "-", &body2, t3)["totp"], false);
    let mut high = body2.clone();
    high["stepup"] = stepup_code(c, &sid, "account.password", "-", &body2, &code_at(&secret, t3), t3);
    let r = send(c, call("POST", path, high, &sid), t3);
    assert_eq!((r.status, code(&r).as_str()), (403, "stepup-failed"));
}

#[test]
fn under_high_an_admin_steps_up_only_with_an_attested_key() {
    let b = build_high("stepup-high");
    let c = &b.c;
    let mut a = Authenticator::new(5);
    let sid = enrol_first_high(c, &mut a, T0);
    let mut u = Authenticator::new(15);
    c.inner.lock().book.people.get_mut(ALICE).unwrap().passkeys.push(key_of(&u, HUB_SERIAL, false));
    let params = json!({ "email": ALICE });
    let v = stepup_begin(c, &sid, "sessions.end-all", ALICE, &params, T0 + 1);
    assert_eq!(allow_ids(&v), vec![b64u(&a.id)]);
    let challenge = unb64u(v["publicKey"]["challenge"].as_str().unwrap()).unwrap();
    let body = json!({ "email": ALICE, "stepup": { "ceremony": v["ceremony"], "credential": u.assert(RP, ORIGIN, &challenge, None) } });
    let r = send(c, call("POST", "/console/api/sessions/end-all", body, &sid), T0 + 1);
    assert_eq!((r.status, code(&r).as_str()), (403, "stepup-failed"));
    // The attested key confirms it.
    let r = post_su(c, &sid, &mut a, "/console/api/sessions/end-all", "sessions.end-all", ALICE, params, T0 + 2);
    assert_eq!(r.status, 200, "{}", text_of(&r));
}

// ── Roles (4.1) ─────────────────────────────────────────────────────────────────────────────────────────────

/// Every core route with the role of its 4.2 to 4.7 row.
const CORE_ROLES: [(&str, &str, Role); 71] = [
    ("GET", "me", Role::None),
    ("GET", "banner", Role::None),
    ("POST", "join", Role::None),
    ("POST", "register/begin", Role::None),
    ("POST", "register/finish", Role::None),
    ("POST", "join/password", Role::None),
    ("POST", "join/totp/begin", Role::None),
    ("POST", "join/totp/finish", Role::None),
    ("POST", "login/begin", Role::None),
    ("POST", "login/password", Role::None),
    ("POST", "login/set-password", Role::None),
    ("POST", "login/totp", Role::None),
    ("POST", "login/finish", Role::None),
    ("POST", "recover/begin", Role::None),
    ("POST", "recover/finish", Role::None),
    ("POST", "logout", Role::Any),
    ("GET", "overview", Role::Viewer),
    ("GET", "search", Role::Viewer),
    ("POST", "stepup/begin", Role::Viewer),
    ("GET", "settings", Role::Admin),
    ("POST", "settings/links", Role::Admin),
    ("POST", "settings/profile", Role::Admin),
    ("POST", "settings/two-person", Role::Admin),
    ("POST", "settings/sign-in", Role::Admin),
    ("POST", "settings/banner", Role::Admin),
    ("POST", "settings/aaguids", Role::Admin),
    ("POST", "settings/mds", Role::Admin),
    ("POST", "settings/email", Role::Admin),
    ("POST", "settings/email/test", Role::Admin),
    ("POST", "settings/license-request-to", Role::Admin),
    ("GET", "admins", Role::Manager),
    ("POST", "admins/invite", Role::Manager),
    ("POST", "admins/approve-join", Role::Admin),
    ("POST", "admins/approve-passkey", Role::Admin),
    ("POST", "admins/role", Role::Admin),
    ("POST", "admins/remove", Role::Admin),
    ("POST", "admins/suspend", Role::Manager),
    ("POST", "admins/unsuspend", Role::Manager),
    ("POST", "admins/reset-sign-in", Role::Admin),
    ("POST", "invites/revoke", Role::Manager),
    ("POST", "invites/resend", Role::Manager),
    ("GET", "sessions", Role::Viewer),
    ("POST", "sessions/end", Role::Viewer),
    ("POST", "sessions/end-all", Role::Admin),
    ("POST", "passkeys/add/begin", Role::Viewer),
    ("POST", "passkeys/add/finish", Role::Viewer),
    ("POST", "passkeys/confirm", Role::Viewer),
    ("POST", "passkeys/remove", Role::Viewer),
    ("POST", "passkeys/rename", Role::Viewer),
    ("POST", "account/security-key/begin", Role::Viewer),
    ("POST", "account/security-key/finish", Role::Viewer),
    ("POST", "account/password", Role::Viewer),
    ("POST", "account/totp/begin", Role::Viewer),
    ("POST", "account/totp/finish", Role::Viewer),
    ("POST", "account/totp/remove", Role::Viewer),
    ("POST", "account/mail", Role::Admin),
    ("GET", "approvals", Role::Admin),
    ("POST", "approvals/approve", Role::Admin),
    ("POST", "approvals/refuse", Role::Admin),
    ("POST", "approvals/cancel", Role::Admin),
    ("GET", "requests", Role::Admin),
    ("POST", "requests/new", Role::Admin),
    ("POST", "requests/cancel", Role::Admin),
    ("GET", "audit", Role::Admin),
    ("POST", "audit/export", Role::Admin),
    ("GET", "audit/verify", Role::Admin),
    ("POST", "audit/restart", Role::Admin),
    ("GET", "logs", Role::Admin),
    ("POST", "logs/export", Role::Admin),
    ("GET", "license", Role::Viewer),
    ("POST", "license/install", Role::Admin),
];

#[test]
fn the_dispatcher_table_gives_every_route_its_contract_role() {
    assert_eq!(CORE_ROUTES.len(), CORE_ROLES.len());
    let unique: HashSet<(&str, &str)> = CORE_ROUTES.iter().map(|s| (s.method, s.path)).collect();
    assert_eq!(unique.len(), CORE_ROUTES.len(), "a route is listed twice");
    for spec in CORE_ROUTES.iter() {
        let row = CORE_ROLES.iter().find(|(m, p, _)| *m == spec.method && *p == spec.path);
        let Some((_, _, role)) = row else { panic!("{} {} has no role row: a route added without its role", spec.method, spec.path) };
        assert_eq!(*role, spec.role, "{} {}", spec.method, spec.path);
    }
    // Every write a person makes names its audit action.
    for s in CORE_ROUTES.iter().filter(|s| s.method == "POST" && s.role != Role::None && !matches!(s.path, "logout" | "stepup/begin")) {
        assert!(!s.action.is_empty(), "{} has no audit action", s.path);
    }
    // The break-glass account is the operator's (3.3): no route makes it.
    assert!(CORE_ROUTES.iter().all(|s| !s.path.contains("break-glass")));
}

/// Call every route as `who` (none, waiting, suspended, viewer, user-manager, admin, admin-viewer-rights,
/// manager-viewer-rights) and check what its role allows.
fn check_roles(c: &Console, routes: &[&RouteSpec], who: &str, sid: &str, peer: &str, t: i64) {
    for (i, spec) in routes.iter().enumerate() {
        if spec.path == "logout" && !sid.is_empty() {
            continue;
        }
        let path = format!("/console/api/{}", spec.path);
        let mut k = call(spec.method, &path, json!({}), sid);
        k.peer = peer;
        let r = send(c, k, t + i as i64 * 1000);
        let v = json_of(&r);
        let got = v["code"].as_str().unwrap_or("");
        assert!(r.status != 500 && v["error"] != "There is no such page.", "{who} {} {}: {}", spec.method, spec.path, text_of(&r));
        assert_eq!(header(&r, "Content-Security-Policy"), Some(CSP));
        let signed_out = matches!(who, "none" | "waiting" | "suspended");
        let expected = match spec.role {
            Role::None => None,
            _ if signed_out => Some("signin-first"),
            Role::Admin if who != "admin" => Some("role"),
            Role::Manager if who != "admin" && who != "user-manager" => Some("role"),
            _ => None,
        };
        match expected {
            Some(x) => assert_eq!(got, x, "{who} {} {}", spec.method, spec.path),
            None => assert!(got != "signin-first" && got != "role", "{who} {} {}: {got}", spec.method, spec.path),
        }
    }
}

#[test]
fn every_route_answers_as_its_role_says() {
    let b = build("roles");
    let c = &b.c;
    let mut a = Authenticator::new(5);
    let admin = enrol_first(c, &mut a, T0);
    let mut vic = Authenticator::new(6);
    add_person(c, &vic, VIC, PersonRole::Viewer, CONSOLE_ANCHOR);
    let viewer = login(c, &mut vic, T0);
    let mut uma = Authenticator::new(9);
    add_person(c, &uma, UMA, PersonRole::UserManager, CONSOLE_ANCHOR);
    let manager = login(c, &mut uma, T0);
    // A waiting joiner and a suspended person hold no session: the ones they had end, and a new sign-in is refused.
    let mut wes = Authenticator::new(7);
    add_person(c, &wes, WES, PersonRole::Viewer, HUB_SERIAL);
    let waiting = login(c, &mut wes, T0);
    c.inner.lock().book.people.get_mut(WES).unwrap().state = PersonState::Waiting;
    assert_eq!(code(&sign_in(c, &mut wes, T0)), "waiting");
    let mut sue = Authenticator::new(8);
    add_person(c, &sue, "sue@acme.example", PersonRole::Admin, HUB_SERIAL);
    let suspended = login(c, &mut sue, T0);
    c.inner.lock().book.people.get_mut("sue@acme.example").unwrap().state = PersonState::Suspended;
    assert_eq!(code(&sign_in(c, &mut sue, T0)), "suspended");
    let routes: Vec<&RouteSpec> = CORE_ROUTES.iter().chain(FAKE_ROUTES.iter()).collect();
    let callers = [
        ("none", "", "192.0.2.10"),
        ("waiting", waiting.as_str(), "192.0.2.13"),
        ("suspended", suspended.as_str(), "192.0.2.14"),
        ("viewer", viewer.as_str(), "192.0.2.11"),
        ("user-manager", manager.as_str(), "192.0.2.15"),
        ("admin", admin.as_str(), "192.0.2.12"),
    ];
    for (i, (who, sid, peer)) in callers.into_iter().enumerate() {
        check_roles(c, &routes, who, sid, peer, T0 + 1 + i as i64 * 100_000);
    }
    let t = T0 + 700_000;
    let admin = login(c, &mut a, t);
    // A route in no table is never served.
    assert_eq!(send(c, call("POST", "/console/api/nothing/here", json!({}), &admin), t + 1).status, 404);
    assert_eq!(send(c, get("/console/api/status", &admin), t + 1).status, 404);
    // Unknown filters and fields are refused.
    let r = send(c, get("/console/api/audit?nope=1", &admin), t + 2);
    assert_eq!((r.status, json_of(&r)["error"].as_str()), (400, Some("Unknown filter: nope.")));
    let r = send(c, get("/console/api/logs?source=relay&format=jsonl", &admin), t + 2);
    assert_eq!(r.status, 400);
    let r = send(c, call("POST", "/console/api/invites/revoke", json!({ "email": "x@acme.example", "extra": 1 }), &admin), t + 2);
    assert_eq!((r.status, code(&r).as_str(), json_of(&r)["error"].as_str()), (400, "unknown-field", Some("Unknown field: extra.")));

    // Under High, an admin and a user manager signed in with an unattested passkey hold viewer rights.
    let h = build_high("roles-high");
    let c = &h.c;
    enrol_first_high(c, &mut Authenticator::new(5), T0);
    let mut adam = Authenticator::new(6);
    add_person(c, &adam, ADAM, PersonRole::Admin, HUB_SERIAL);
    let admin_low = login(c, &mut adam, T0);
    let mut ula = Authenticator::new(7);
    add_person(c, &ula, "ula@acme.example", PersonRole::UserManager, CONSOLE_ANCHOR);
    let manager_low = login(c, &mut ula, T0);
    for sid in [&admin_low, &manager_low] {
        let me = json_of(&send(c, get("/console/api/me", sid), T0 + 1));
        assert_eq!((me["user"]["rights"].as_str(), me["user"]["rightsWhy"].as_str()), (Some("viewer"), Some("not-attested")));
    }
    check_roles(c, &routes, "admin-viewer-rights", &admin_low, "192.0.2.20", T0 + 2);
    check_roles(c, &routes, "manager-viewer-rights", &manager_low, "192.0.2.21", T0 + 200_000);
}

// ── One answer shape and sign-in (3.3, R3-L1, R3-M1) ────────────────────────────────────────────────────────

#[test]
fn login_begin_gives_one_answer_shape_with_fixed_decoy_work() {
    let b = build("oneshape");
    let c = &b.c;
    let mut a = Authenticator::new(5);
    enrol_first(c, &mut a, T0);
    let begin = |email: &str, peer: &str, t: i64| -> (Value, u64, u64) {
        let (h0, l0) = (crate::console_password::decoy_hmacs(), crate::console_auth::ACCOUNT_LOOKUPS.with(|n| n.get()));
        let r = send_from(c, "/console/api/login/begin", json!({ "email": email }), "", peer, t);
        assert_eq!(r.status, 200, "{}", text_of(&r));
        (json_of(&r), crate::console_password::decoy_hmacs() - h0, crate::console_auth::ACCOUNT_LOOKUPS.with(|n| n.get()) - l0)
    };
    let shape = |v: &Value| -> (Vec<String>, Vec<String>) {
        let mut top: Vec<String> = v.as_object().unwrap().keys().cloned().collect();
        let mut pk: Vec<String> = v["publicKey"].as_object().unwrap().keys().cloned().collect();
        top.sort();
        pk.sort();
        (top, pk)
    };
    let lengths = |v: &Value| -> Vec<usize> { allow_ids(v).iter().map(|id| unb64u(id).unwrap().len()).collect() };
    // No registered id that is not discoverable: decoys of 64 bytes.
    let (unknown, hmacs, lookups) = begin("nobody@acme.example", "198.51.100.1", T0 + 1);
    assert_eq!((hmacs, lookups), (4, 1));
    assert_eq!(lengths(&unknown), vec![64; 4]);
    let (only_discoverable, hmacs, lookups) = begin(ALICE, "198.51.100.1", T0 + 2);
    assert_eq!((hmacs, lookups), (4, 1));
    assert_eq!(lengths(&only_discoverable), vec![64; 4]);
    assert_eq!(shape(&unknown), shape(&only_discoverable));
    // The decoys are the same for an email every time (keyed, never random).
    assert_eq!(allow_ids(&begin("nobody@acme.example", "198.51.100.1", T0 + 3).0), allow_ids(&unknown));
    // An account with a method that is not discoverable: its id fills the first slot; decoys take the console's lengths.
    let nd = Authenticator::new(8);
    add_person(c, &nd, "nd@acme.example", PersonRole::Viewer, CONSOLE_ANCHOR);
    c.inner.lock().book.people.get_mut("nd@acme.example").unwrap().passkeys[0].rk = Some(false);
    let (known, hmacs, lookups) = begin("nd@acme.example", "198.51.100.2", T0 + 4);
    assert_eq!((hmacs, lookups), (4, 1));
    assert_eq!(allow_ids(&known)[0], b64u(&nd.id));
    assert_eq!(lengths(&known), vec![32; 4]);
    let (unknown, _, _) = begin("nobody@acme.example", "198.51.100.2", T0 + 5);
    assert_eq!(lengths(&unknown), vec![32; 4]);
    assert_eq!(shape(&known), shape(&unknown));
    // The `password` field depends on the profile only.
    for v in [&known, &unknown, &only_discoverable] {
        assert_eq!(v["password"], "offered");
    }
    // An empty email: no ids, no decoy work.
    let h0 = crate::console_password::decoy_hmacs();
    let r = send_from(c, "/console/api/login/begin", json!({}), "", "198.51.100.3", T0 + 6);
    assert_eq!(json_of(&r)["publicKey"]["allowCredentials"], json!([]));
    assert_eq!(crate::console_password::decoy_hmacs() - h0, 0);
    // login/password: an unknown email, a known one without a password and a wrong password each run one PBKDF2 and
    // answer the one sentence.
    add_bare(c, PAT, PersonRole::Viewer);
    set_password(c, PAT, PW, CONSOLE_ANCHOR);
    let mut answers = Vec::new();
    for (i, email) in ["nobody@acme.example", ALICE, PAT].iter().enumerate() {
        let peer = format!("198.51.100.{}", 10 + i);
        let v = json_of(&send_from(c, "/console/api/login/begin", json!({ "email": email }), "", &peer, T0 + 10));
        let before = crate::console_password::pbkdf2_calls();
        let r = send_from(c, "/console/api/login/password", json!({ "ceremony": v["ceremony"], "password": "Wrong-password-123" }), "", &peer, T0 + 10);
        assert_eq!(crate::console_password::pbkdf2_calls() - before, 1, "{email}");
        assert_eq!((r.status, code(&r).as_str(), json_of(&r)["error"].as_str()), (403, "signin-refused", Some(SIGNIN)), "{email}");
        answers.push(json_of(&r));
    }
    assert!(answers.iter().all(|x| *x == answers[0]));
    // Under High the field is "none"; with requirePassword "required"; the same for every email.
    set_profile(c, Profile::High);
    assert_eq!(begin("nd@acme.example", "198.51.100.4", T0 + 20).0["password"], "none");
    assert_eq!(begin("nobody@acme.example", "198.51.100.4", T0 + 21).0["password"], "none");
    c.inner.lock().book.settings.require_password = true;
    assert_eq!(begin("nd@acme.example", "198.51.100.4", T0 + 22).0["password"], "required");
    assert_eq!(begin("nobody@acme.example", "198.51.100.4", T0 + 23).0["password"], "required");
}

#[test]
fn high_with_require_password_takes_the_passkey_then_the_password() {
    let b = build_high("r3m1");
    let c = &b.c;
    let mut a = Authenticator::new(5);
    enrol_first_high(c, &mut a, T0);
    let mut nd = Authenticator::new(8);
    add_person(c, &nd, "nd@acme.example", PersonRole::Viewer, CONSOLE_ANCHOR);
    {
        let mut inner = c.inner.lock();
        inner.book.people.get_mut("nd@acme.example").unwrap().passkeys[0].rk = Some(false);
        inner.book.settings.require_password = true;
    }
    set_password(c, "nd@acme.example", PW, CONSOLE_ANCHOR);
    let first = |a: &mut Authenticator, email: Option<&str>, t: i64| -> (Value, ConsoleReply) {
        let body = email.map_or(json!({}), |e| json!({ "email": e }));
        let begin = json_of(&send(c, call("POST", "/console/api/login/begin", body, ""), t));
        assert_eq!(begin["password"], "required");
        let challenge = unb64u(begin["publicKey"]["challenge"].as_str().unwrap()).unwrap();
        let got = a.assert(RP, ORIGIN, &challenge, None);
        let r = send(c, call("POST", "/console/api/login/finish", json!({ "ceremony": begin["ceremony"], "credential": got }), ""), t);
        (begin, r)
    };
    let password = |begin: &Value, pw: &str, t: i64| send(c, call("POST", "/console/api/login/password", json!({ "ceremony": begin["ceremony"], "password": pw }), ""), t);
    let set_pw = |begin: &Value, pw: &str, t: i64| send(c, call("POST", "/console/api/login/set-password", json!({ "ceremony": begin["ceremony"], "password": pw }), ""), t);
    let t = T0 + MIN;
    // Alice has no password: WebAuthn first, then only the setup session. No cookie before both steps.
    let (begin, r) = first(&mut a, None, t);
    assert_eq!(json_of(&r), json!({ "ok": true, "next": "password" }));
    assert!(header(&r, "Set-Cookie").is_none());
    let before = crate::console_password::pbkdf2_calls();
    let r = password(&begin, "anything at all here", t);
    assert_eq!(crate::console_password::pbkdf2_calls() - before, 1);
    assert_eq!(json_of(&r), json!({ "ok": true, "next": "set-password" }));
    assert!(header(&r, "Set-Cookie").is_none());
    // The setup session can do nothing but login/set-password: at any other step it is refused (and gone).
    let r = send(c, call("POST", "/console/api/login/totp", json!({ "ceremony": begin["ceremony"], "code": "123456" }), ""), t);
    assert_eq!((r.status, code(&r).as_str()), (403, "signin-refused"));
    assert_eq!(code(&set_pw(&begin, PW, t)), "signin-refused");
    // Again: a password too short for High keeps the setup session for another try; then the session starts.
    let (begin, _) = first(&mut a, None, t + 1);
    assert_eq!(json_of(&password(&begin, "anything at all here", t + 1))["next"], "set-password");
    let r = set_pw(&begin, "Qz7!mR2#vK9@pL", t + 1);
    assert_eq!((r.status, code(&r).as_str()), (400, "password-length"));
    let r = set_pw(&begin, PW, t + 1);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    let sid = cookie(&r);
    assert_eq!(json_of(&send(c, get("/console/api/me", &sid), t + 2))["user"]["email"], ALICE);
    assert_eq!(last_entry(c, "signin.ok")["detail"]["methods"], json!(["webauthn", "password"]));
    // Each ceremony is used once.
    assert_eq!(code(&set_pw(&begin, PW, t + 2)), "signin-refused");
    assert_eq!(code(&password(&begin, PW, t + 2)), "signin-refused");
    // With a stored password: the same answer after the passkey, one PBKDF2, the one sentence for a wrong password.
    let (begin, r) = first(&mut a, None, t + 3);
    assert_eq!(json_of(&r), json!({ "ok": true, "next": "password" }));
    let before = crate::console_password::pbkdf2_calls();
    let r = password(&begin, "Wrong-password-123", t + 3);
    assert_eq!(crate::console_password::pbkdf2_calls() - before, 1);
    assert_eq!((r.status, json_of(&r)["error"].as_str()), (403, Some(SIGNIN)));
    assert_eq!(code(&password(&begin, PW, t + 3)), "signin-refused");
    let (begin, _) = first(&mut a, None, t + 4);
    let r = password(&begin, PW, t + 4);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    assert!(cookie(&r).starts_with("__Host-lrc="));
    // A typed email with a method that is not discoverable: its id first, then the password.
    let (begin, r) = first(&mut nd, Some("nd@acme.example"), t + 5);
    assert_eq!(allow_ids(&begin)[0], b64u(&nd.id));
    assert_eq!(json_of(&r), json!({ "ok": true, "next": "password" }));
    assert!(header(&r, "Set-Cookie").is_none());
    let r = password(&begin, PW, t + 5);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    // Under High a password is never the first step.
    let begin = json_of(&send(c, call("POST", "/console/api/login/begin", json!({ "email": "nd@acme.example" }), ""), t + 6));
    assert_eq!(code(&password(&begin, PW, t + 6)), "signin-refused");
}

// ── Lockout, passwords and authenticator apps (3.3) ─────────────────────────────────────────────────────────

#[test]
fn ten_failed_sign_ins_lock_an_email_for_15_minutes() {
    let b = build("lockout");
    let c = &b.c;
    let mut a = Authenticator::new(5);
    enrol_first(c, &mut a, T0);
    let mut vic = Authenticator::new(6);
    add_person(c, &vic, VIC, PersonRole::Viewer, CONSOLE_ANCHOR);
    set_password(c, VIC, PW, CONSOLE_ANCHOR);
    let t = T0 + MIN;
    let fail = |email: &str, peer: &str, t: i64| {
        let v = json_of(&send_from(c, "/console/api/login/begin", json!({ "email": email }), "", peer, t));
        let r = send_from(c, "/console/api/login/password", json!({ "ceremony": v["ceremony"], "password": "Not-the-password-1" }), "", peer, t);
        assert_eq!(code(&r), "signin-refused", "{email}");
    };
    // A WebAuthn ceremony begun before the wait.
    let early = json_of(&send_from(c, "/console/api/login/begin", json!({ "email": VIC }), "", "198.51.100.40", t));
    for i in 0..10 {
        fail(VIC, "198.51.100.41", t + i);
        fail("ghost@acme.example", "198.51.100.42", t + i);
    }
    // A known and an unknown email both wait 15 minutes.
    for email in [VIC, "ghost@acme.example"] {
        let r = send_from(c, "/console/api/login/begin", json!({ "email": email }), "", "198.51.100.43", t + 20);
        assert_eq!((r.status, code(&r).as_str(), json_of(&r)["error"].as_str()), (429, "signin-wait", Some("Too many tries. Try again in 15 minutes.")), "{email}");
        assert!(header(&r, "Retry-After").is_some());
    }
    // The ceremony begun before the wait completes.
    let challenge = unb64u(early["publicKey"]["challenge"].as_str().unwrap()).unwrap();
    let got = vic.assert(RP, ORIGIN, &challenge, None);
    let r = send_from(c, "/console/api/login/finish", json!({ "ceremony": early["ceremony"], "credential": got }), "", "198.51.100.40", t + 30);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    // A new one, begun after the wait began, is refused (here a discoverable sign-in: it counts against its account).
    let r = sign_in_from(c, &mut vic, "198.51.100.44", t + 40);
    assert_eq!((r.status, code(&r).as_str()), (429, "signin-wait"));
    // signin.locked only for the existing account.
    let locked: Vec<Map<String, Value>> = entries(c).into_iter().filter(|e| e["action"] == "signin.locked").collect();
    assert_eq!(locked.len(), 1);
    assert_eq!((locked[0]["actor"].as_str(), locked[0]["target"].as_str()), (Some("relay"), Some(VIC)));
    let sid = login(c, &mut a, t + 50);
    assert!(attention_kinds(c, &sid, t + 51).iter().any(|k| k == "signin-locked"));
    // After 15 minutes the email signs in again.
    let r = send_from(c, "/console/api/login/begin", json!({ "email": VIC }), "", "198.51.100.45", t + 9 + 15 * MIN + 1);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    // Failed discoverable sign-ins count against the account the passkey belongs to.
    let mut carl = Authenticator::new(7);
    add_person(c, &carl, "carl@acme.example", PersonRole::Viewer, CONSOLE_ANCHOR);
    let t2 = t + HOUR;
    for i in 0..10 {
        let peer = if i < 5 { "198.51.100.50" } else { "198.51.100.51" };
        let begin = json_of(&send_from(c, "/console/api/login/begin", json!({}), "", peer, t2 + i));
        let got = carl.assert(RP, ORIGIN, b"not the challenge", None);
        let r = send_from(c, "/console/api/login/finish", json!({ "ceremony": begin["ceremony"], "credential": got }), "", peer, t2 + i);
        assert_eq!(code(&r), "signin-refused");
    }
    let r = send_from(c, "/console/api/login/begin", json!({ "email": "carl@acme.example" }), "", "198.51.100.52", t2 + 20);
    assert_eq!((r.status, code(&r).as_str()), (429, "signin-wait"));
}

#[test]
fn passwords_follow_the_profile_and_never_sign_in_alone() {
    let b = build("passwords");
    let c = &b.c;
    let mut a = Authenticator::new(5);
    let sid = enrol_first(c, &mut a, T0);
    let path = "/console/api/account/password";
    let set = |a: &mut Authenticator, current: &str, pw: &str, t: i64| post_su(c, &sid, a, path, "account.password", "-", json!({ "current": current, "password": pw }), t);
    // Standard: 11 refused, 12 accepted; 129 refused; NFKC counts code points after normalizing.
    let r = set(&mut a, "", "Qz7!mR2#vK9", T0 + 1);
    assert_eq!((r.status, code(&r).as_str(), json_of(&r)["error"].as_str()), (400, "password-length", Some("A password here needs 12 to 128 characters.")));
    assert_eq!(code(&set(&mut a, "", &"Qz7!".repeat(33)[..129], T0 + 2)), "password-length");
    // A blocked-list or context word: refused.
    assert_eq!(code(&set(&mut a, "", "lucid-Qz7!mR2#vK9", T0 + 3)), "password-weak");
    assert_eq!(code(&set(&mut a, "", "alice-Qz7!mR2#vK9", T0 + 4)), "password-weak");
    // 10 characters and U+FB03 (three after NFKC): 13 code points.
    let r = set(&mut a, "", "Qz7!mR2#vK\u{FB03}", T0 + 5);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    // Changing it needs the current password.
    assert_eq!(code(&set(&mut a, "", PW, T0 + 6)), "password-wrong");
    let r = set(&mut a, "Wrong-current-1", PW, T0 + 7);
    assert_eq!((r.status, code(&r).as_str()), (403, "password-wrong"));
    let r = set(&mut a, "Qz7!mR2#vK\u{FB03}", PW, T0 + 8);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    let stored = c.inner.lock().book.people[ALICE].password.as_ref().unwrap().hash.clone();
    assert!(crate::console_password::verify(PW, Some(stored.as_str())));
    // A password alone never signs in.
    add_bare(c, PAT, PersonRole::Viewer);
    set_password(c, PAT, PW, CONSOLE_ANCHOR);
    let begin = json_of(&send(c, call("POST", "/console/api/login/begin", json!({ "email": PAT }), ""), T0 + 9));
    let r = send(c, call("POST", "/console/api/login/password", json!({ "ceremony": begin["ceremony"], "password": PW }), ""), T0 + 9);
    assert_eq!((r.status, json_of(&r)["error"].as_str()), (403, Some(SIGNIN)));
    assert!(header(&r, "Set-Cookie").is_none());
    // Under High: 14 refused, 15 accepted; a password first is never a sign-in.
    let h = build_high("passwords-high");
    let c = &h.c;
    let mut a = Authenticator::new(5);
    let sid = enrol_first_high(c, &mut a, T0);
    let r = post_su(c, &sid, &mut a, path, "account.password", "-", json!({ "current": "", "password": "Qz7!mR2#vK9@pL" }), T0 + 1);
    assert_eq!((r.status, json_of(&r)["error"].as_str()), (400, Some("A password here needs 15 to 128 characters.")));
    let r = post_su(c, &sid, &mut a, path, "account.password", "-", json!({ "current": "", "password": "Qz7!mR2#vK9@pL4" }), T0 + 2);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    let begin = json_of(&send(c, call("POST", "/console/api/login/begin", json!({ "email": ALICE }), ""), T0 + 3));
    let r = send(c, call("POST", "/console/api/login/password", json!({ "ceremony": begin["ceremony"], "password": "Qz7!mR2#vK9@pL4" }), ""), T0 + 3);
    assert_eq!((r.status, json_of(&r)["error"].as_str()), (403, Some(SIGNIN)));
}

#[test]
fn authenticator_apps_end_to_end() {
    let b = build("totp");
    let c = &b.c;
    let mut a = Authenticator::new(5);
    let admin = enrol_first(c, &mut a, T0);
    let mut vic = Authenticator::new(6);
    add_person(c, &vic, VIC, PersonRole::Viewer, CONSOLE_ANCHOR);
    let sid = login(c, &mut vic, T0);
    // Set up with a step-up; the secret is shown once.
    let r = post_su(c, &sid, &mut vic, "/console/api/account/totp/begin", "account.totp", "-", json!({}), T0 + 1);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    let v = json_of(&r);
    let shown = v["secret"].as_str().unwrap().to_owned();
    let secret = unbase32(&shown);
    assert_eq!(secret.len(), 20);
    assert!(v["uri"].as_str().unwrap().starts_with("otpauth://totp/") && v["uri"].as_str().unwrap().contains(&shown));
    let finish = |code: &str, t: i64| send(c, call("POST", "/console/api/account/totp/finish", json!({ "enrollment": v["enrollment"], "code": code }), &sid), t);
    // It needs a current code: a wrong one is refused and the setup stays for another try.
    let t = T0 + 2 * MIN;
    let wrong = if code_at(&secret, t) == "000000" { "111111" } else { "000000" };
    let r = finish(wrong, t);
    assert_eq!((r.status, code(&r).as_str()), (403, "totp-wrong"));
    // One step either side: the code of the previous step still confirms it.
    let r = finish(&code_at(&secret, t - 30_000), t);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    assert!(c.inner.lock().book.people[VIC].has_totp());
    // The secret is sealed and never in any answer after `begin`.
    let answers = [send(c, get("/console/api/me", &sid), t + 1), send(c, get("/console/api/admins", &admin), t + 1), send(c, get("/console/api/settings", &admin), t + 1)];
    for r in &answers {
        assert_eq!(r.status, 200);
        assert!(!text_of(r).contains(&shown));
    }
    assert!(!std::fs::read_to_string(&c.file).unwrap().contains(&shown));
    assert!(!std::fs::read_to_string(b.dir.join(crate::console_seal::SECRETS_FILE)).unwrap().contains(&shown));
    // Sign-in with a password and the app; the same code again is refused.
    add_bare(c, PAT, PersonRole::Viewer);
    set_password(c, PAT, PW, CONSOLE_ANCHOR);
    let pat_secret = set_totp(c, PAT, CONSOLE_ANCHOR);
    let t1 = T0 + 10 * MIN;
    let r = sign_in_totp(c, PAT, PW, &pat_secret, "198.51.100.60", t1);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    assert_eq!(last_entry(c, "signin.ok")["detail"]["methods"], json!(["password", "totp"]));
    let r = sign_in_totp(c, PAT, PW, &pat_secret, "198.51.100.61", t1 + 1);
    assert_eq!((r.status, code(&r).as_str()), (403, "signin-refused"));
    // Under High: refused for sign-in, for enrollment (`profile-high`), and at the join flow.
    set_profile(c, Profile::High);
    let t3 = t1 + 5 * MIN;
    let r = sign_in_totp(c, PAT, PW, &pat_secret, "198.51.100.62", t3);
    assert_eq!((r.status, code(&r).as_str()), (403, "signin-refused"));
    let sid = login(c, &mut vic, t3);
    let r = post_su(c, &sid, &mut vic, "/console/api/account/totp/begin", "account.totp", "-", json!({}), t3 + 1);
    assert_eq!((r.status, code(&r).as_str()), (409, "profile-high"));
    let (link, _) = c.mint_console_token("new@acme.example", PersonRole::Viewer, ALICE, InviteKind::Join, false, t3).unwrap();
    let r = send(c, call("POST", "/console/api/join/totp/begin", json!({ "token": token_of(&link) }), ""), t3 + 2);
    assert_eq!((r.status, code(&r).as_str()), (409, "profile-high"));
}

// ── Attestation and adding methods (3.3, R3-H1, R3-H2) ──────────────────────────────────────────────────────

#[test]
fn under_high_an_unattested_admin_holds_viewer_rights() {
    let b = build_high("attest");
    let c = &b.c;
    let mut a = Authenticator::new(5);
    let sid = enrol_first_high(c, &mut a, T0);
    let me = json_of(&send(c, get("/console/api/me", &sid), T0 + 1));
    assert_eq!((me["user"]["rights"].as_str(), me["user"]["rightsWhy"].clone()), (Some("admin"), Value::Null));
    let mut adam = Authenticator::new(6);
    add_person(c, &adam, ADAM, PersonRole::Admin, HUB_SERIAL);
    let low = login(c, &mut adam, T0 + 1);
    let me = json_of(&send(c, get("/console/api/me", &low), T0 + 2));
    assert_eq!((me["user"]["role"].as_str(), me["user"]["rights"].as_str(), me["user"]["rightsWhy"].as_str()), (Some("admin"), Some("viewer"), Some("not-attested")));
    assert!(banner_ids(c, &low, T0 + 3).iter().any(|id| id == "high.viewer-rights"));
    let r = send(c, get("/console/api/settings", &low), T0 + 4);
    assert_eq!((r.status, code(&r).as_str()), (403, "role"));
    assert!(attention_kinds(c, &sid, T0 + 5).iter().any(|k| k == "key-unattested"));
    // A compromise status turns a stored method unattested at its next request.
    let id = aaguid_text();
    c.mds.lock().set(crate::console_mds::test_snapshot(&[(id.as_str(), true, true)]));
    let me = json_of(&send(c, get("/console/api/me", &sid), T0 + 6));
    assert_eq!((me["user"]["rights"].as_str(), me["user"]["rightsWhy"].as_str()), (Some("viewer"), Some("not-attested")));
}

#[test]
fn under_high_a_reduced_session_enrolls_only_waiting_methods() {
    let b = build_high("enroll");
    let c = &b.c;
    let mut a = Authenticator::new(5);
    let alice = enrol_first_high(c, &mut a, T0);
    add_break_glass(c, &Authenticator::new(40), BG, BG_PASSWORD);
    let mut adam = Authenticator::new(6);
    add_person(c, &adam, ADAM, PersonRole::Admin, HUB_SERIAL);
    let low = login(c, &mut adam, T0 + 1);
    // The enrollment step-up: from methods carrying the account's anchor.
    let v = stepup_begin(c, &low, "passkeys.add", "-", &json!({}), T0 + 2);
    assert_eq!((v["enrollment"].as_bool(), allow_ids(&v)), (Some(true), vec![b64u(&adam.id)]));
    // A FIPS hardware key through passkeys.add, and a security key through account/security-key: both waiting.
    let mut k1 = Authenticator::new(61);
    let r = add_method(c, &low, &mut adam, "passkeys/add", "passkeys.add", &mut k1, true, T0 + 3);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    assert_eq!((json_of(&r)["method"]["state"].as_str(), json_of(&r)["method"]["attested"]["fips"].as_bool()), (Some("waiting"), Some(true)));
    let mut k2 = Authenticator::new(62);
    let r = add_method(c, &low, &mut adam, "account/security-key", "account.security-key", &mut k2, true, T0 + 4);
    assert_eq!((json_of(&r)["method"]["state"].as_str(), json_of(&r)["method"]["kind"].as_str()), (Some("waiting"), Some("security-key")), "{}", text_of(&r));
    {
        let inner = c.inner.lock();
        for k in [&k1, &k2] {
            let m = inner.book.people[ADAM].passkeys.iter().find(|x| x.id == b64u(&k.id)).unwrap();
            assert_eq!((m.state, m.anchor.as_str()), (KeyState::Waiting, HUB_SERIAL));
        }
    }
    // Waiting methods sign nobody in, and adam cannot make them work himself.
    assert_eq!(sign_in_from(c, &mut k1, "198.51.100.70", T0 + 5).status, 403);
    let h1 = hint_of(&b64u(&k1.id));
    let r = post_su(c, &low, &mut adam, "/console/api/passkeys/confirm", "passkeys.confirm", &h1, json!({ "hint": h1 }), T0 + 6);
    assert_eq!(r.status, 403);
    // The enrollment step-up confirms nothing else, and a step-up for anything else is never one.
    let hint_adam = hint_of(&b64u(&adam.id));
    let su = stepup(c, &low, &mut adam, "passkeys.add", "-", &json!({}), T0 + 7);
    let r = send(c, call("POST", "/console/api/passkeys/remove", json!({ "hint": hint_adam, "stepup": su }), &low), T0 + 7);
    assert_eq!((r.status, code(&r).as_str()), (403, "stepup-failed"));
    let v = stepup_begin(c, &low, "passkeys.remove", &hint_adam, &json!({ "hint": hint_adam }), T0 + 8);
    assert_eq!((v["enrollment"].as_bool(), allow_ids(&v).len()), (Some(false), 0));
    // A method without the account's anchor makes no enrollment step-up.
    let mut other = Authenticator::new(63);
    c.inner.lock().book.people.get_mut(ADAM).unwrap().passkeys.push(key_of(&other, SECOND_HUB, false));
    let low2 = login(c, &mut other, T0 + 9);
    let v = stepup_begin(c, &low2, "passkeys.add", "-", &json!({}), T0 + 10);
    assert!(!allow_ids(&v).contains(&b64u(&other.id)));
    let challenge = unb64u(v["publicKey"]["challenge"].as_str().unwrap()).unwrap();
    let body = json!({ "stepup": { "ceremony": v["ceremony"], "credential": other.assert(RP, ORIGIN, &challenge, None) } });
    let r = send(c, call("POST", "/console/api/passkeys/add/begin", body, &low2), T0 + 10);
    assert_eq!((r.status, code(&r).as_str()), (403, "stepup-failed"));
    // Another admin approves one: it works, with admin rights (FIPS hardware).
    let r = post_su(c, &alice, &mut a, "/console/api/admins/approve-passkey", "admins.approve-passkey", ADAM, json!({ "email": ADAM, "hint": h1 }), T0 + 11);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    let s1 = login(c, &mut k1, T0 + 12);
    assert_eq!(json_of(&send(c, get("/console/api/me", &s1), T0 + 12))["user"]["rights"], "admin");
    // The operator activates the other with the relay stopped (`console approve-join`).
    let dir = b.dir.clone();
    drop(b);
    let done = run_offline(&dir, Offline::ApproveJoin { email: ADAM.into(), admin: false }, RP, &|_, _| Ok(())).unwrap();
    assert!(done.contains("active as admin"), "{done}");
    let b = reopen(&dir, true);
    let c = &b.c;
    assert_eq!(c.inner.lock().book.people[ADAM].passkeys.iter().find(|k| k.id == b64u(&k2.id)).unwrap().state, KeyState::Working);
    assert_eq!(sign_in(c, &mut k2, T0 + 20).status, 200);
    // A session holding privileged rights through an attested method enrolls working methods on both routes, each
    // inheriting the anchor of the step-up's method.
    let sid = login(c, &mut a, T0 + 21);
    let mut k3 = Authenticator::new(64);
    let r = add_method(c, &sid, &mut a, "passkeys/add", "passkeys.add", &mut k3, false, T0 + 22);
    assert_eq!(json_of(&r)["method"]["state"], "working", "{}", text_of(&r));
    let mut k4 = Authenticator::new(65);
    let r = add_method(c, &sid, &mut a, "account/security-key", "account.security-key", &mut k4, true, T0 + 23);
    assert_eq!(json_of(&r)["method"]["state"], "working", "{}", text_of(&r));
    let inner = c.inner.lock();
    for k in [&k3, &k4] {
        let m = inner.book.people[ALICE].passkeys.iter().find(|x| x.id == b64u(&k.id)).unwrap();
        assert_eq!((m.state, m.anchor.as_str()), (KeyState::Working, HUB_SERIAL));
    }
}

// ── Profiles, two-person control, user managers (2.3, 3.3, 3.7) ─────────────────────────────────────────────

#[test]
fn profiles_switch_with_their_rules() {
    let b = build_high("profiles");
    let c = &b.c;
    let mut a = Authenticator::new(5);
    let sid = enrol_first_high(c, &mut a, T0);
    add_person_with(c, &Authenticator::new(6), BOB, PersonRole::Admin, SECOND_HUB, true);
    add_break_glass(c, &Authenticator::new(40), BG, BG_PASSWORD);
    assert!(!attention_kinds(c, &sid, T0 + 1).iter().any(|k| k == "profile-standard"));
    // High to Standard with two-person control off: at once, flagged.
    let path = "/console/api/settings/profile";
    let r = post_su(c, &sid, &mut a, path, "settings.profile", "-", json!({ "profile": "standard", "reason": "Pilot" }), T0 + 2);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    assert_eq!(c.settings_now().profile, Profile::Standard);
    let e = last_entry(c, "settings.profile");
    assert_eq!((e["approval"].as_str(), e["detail"]["from"].as_str(), e["detail"]["to"].as_str()), (Some("single-admin-setting"), Some("high"), Some("standard")));
    // The move latches `downgraded` (R41-3), the only trigger of profile-standard.
    assert_eq!(e["detail"]["downgraded"], true);
    assert!(c.settings_now().downgraded);
    assert!(attention_kinds(c, &sid, T0 + 3).iter().any(|k| k == "profile-standard"));
    // A viewer signed in with a password and an app.
    add_bare(c, PAT, PersonRole::Viewer);
    set_password(c, PAT, PW, CONSOLE_ANCHOR);
    let secret = set_totp(c, PAT, CONSOLE_ANCHOR);
    let r = sign_in_totp(c, PAT, PW, &secret, "198.51.100.80", T0 + 4);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    let pat = cookie(&r);
    // Standard to High: one admin; the sessions High refuses end.
    let r = post_su(c, &sid, &mut a, path, "settings.profile", "-", json!({ "profile": "high", "reason": "Harden" }), T0 + 5);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    assert_eq!(last_entry(c, "settings.profile")["approval"], Value::Null);
    assert_eq!(last_entry(c, "settings.profile")["detail"]["downgraded"], false);
    assert!(!c.settings_now().downgraded);
    assert_eq!(send(c, get("/console/api/overview", &pat), T0 + 6).status, 401);
    assert_eq!(send(c, get("/console/api/overview", &sid), T0 + 6).status, 200);
    assert!(!attention_kinds(c, &sid, T0 + 7).iter().any(|k| k == "profile-standard"));
    // With two-person control on, High to Standard is an approval.
    let r = post_su(c, &sid, &mut a, "/console/api/settings/two-person", "settings.two-person", "-", json!({ "twoPerson": "on", "reason": "Policy" }), T0 + 8);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    let r = post_su(c, &sid, &mut a, path, "settings.profile", "-", json!({ "profile": "standard", "reason": "Pilot" }), T0 + 9);
    assert_eq!(json_of(&r)["approval"]["state"], "waiting", "{}", text_of(&r));
    assert_eq!(c.settings_now().profile, Profile::High);
}

#[test]
fn two_person_control_is_off_by_default_and_turned_off_only_by_an_approval() {
    let b = build("twoperson");
    let c = &b.c;
    let mut a = Authenticator::new(5);
    let sid = enrol_first(c, &mut a, T0);
    assert_eq!(json_of(&send(c, get("/console/api/settings", &sid), T0 + 1))["twoPerson"], "off");
    let path = "/console/api/settings/two-person";
    // On by one admin.
    let r = post_su(c, &sid, &mut a, path, "settings.two-person", "-", json!({ "twoPerson": "on", "reason": "Policy" }), T0 + 2);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    assert!(c.two_person_on());
    // Off: never the sole-admin path, even for a lone admin.
    let off = json!({ "twoPerson": "off", "reason": "Too slow" });
    let r = post_su(c, &sid, &mut a, path, "settings.two-person", "-", off.clone(), T0 + 3);
    assert_eq!((r.status, code(&r).as_str()), (409, "no-approver"));
    assert!(c.two_person_on());
    assert!(entries(c).iter().all(|e| e["approval"] != "sole-admin"));
    // With a second admin: an approval, which the other admin approves.
    let mut bob = Authenticator::new(6);
    add_person(c, &bob, BOB, PersonRole::Admin, SECOND_HUB);
    let sid_b = login(c, &mut bob, T0 + 4);
    let r = post_su(c, &sid, &mut a, path, "settings.two-person", "-", off, T0 + 5);
    let approval = json_of(&r)["approval"].clone();
    assert_eq!(approval["state"], "waiting", "{}", text_of(&r));
    assert!(c.two_person_on());
    let id = approval["id"].as_str().unwrap().to_owned();
    let su = stepup(c, &sid_b, &mut bob, "approvals.approve", &id, &approval["params"], T0 + 6);
    let r = send(c, call("POST", "/console/api/approvals/approve", json!({ "id": id, "stepup": su }), &sid_b), T0 + 6);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    assert!(!c.two_person_on());
    // The operator turns it off with the relay stopped.
    two_person(c, true);
    let dir = b.dir.clone();
    drop(b);
    let done = run_offline(&dir, Offline::TwoPersonOff, RP, &|_, _| Ok(())).unwrap();
    assert_eq!(done, crate::console_auth::TWO_PERSON_OFF);
    let b = reopen(&dir, false);
    assert!(!b.c.two_person_on());
    let e = last_entry(&b.c, "two-person.off");
    assert_eq!(e["actor"], "operator");
}

#[test]
fn with_two_person_control_off_every_second_admin_row_runs_at_once() {
    let b = build("singleadmin");
    let c = &b.c;
    let mut a = Authenticator::new(5);
    let sid = enrol_first(c, &mut a, T0);
    add_person(c, &Authenticator::new(6), BOB, PersonRole::Admin, SECOND_HUB);
    add_person(c, &Authenticator::new(7), CAROL, PersonRole::Admin, "0000000000000000000000000000000c");
    add_person(c, &Authenticator::new(8), VIC, PersonRole::Viewer, CONSOLE_ANCHOR);
    // Three active admins with two-person control off.
    let ov = json_of(&send(c, get("/console/api/overview", &sid), T0 + 1));
    let item = ov["attention"].as_array().unwrap().iter().find(|x| x["kind"] == "two-person-off").cloned().unwrap();
    assert_eq!(item["args"]["n"], 3);
    mail_on(c);
    let rows: Vec<(&str, &str, String, Value)> = vec![
        ("admins/invite", "admins.invite", "dave@acme.example".into(), json!({ "email": "dave@acme.example", "role": "admin" })),
        ("admins/role", "admins.role", VIC.into(), json!({ "email": VIC, "role": "admin", "reason": "Promote" })),
        ("admins/role", "admins.role", CAROL.into(), json!({ "email": CAROL, "role": "viewer", "reason": "Demote" })),
        ("admins/suspend", "admins.suspend", VIC.into(), json!({ "email": VIC, "reason": "Away" })),
        ("admins/reset-sign-in", "admins.reset-sign-in", BOB.into(), json!({ "email": BOB, "reason": "Lost key" })),
        ("settings/aaguids", "settings.aaguids", "-".into(), json!({ "aaguids": [aaguid_text()], "reason": "Keys" })),
        ("settings/sign-in", "settings.sign-in", "-".into(), json!({ "requirePassword": false, "idleMinutes": 30, "maxHours": 12, "reason": "Longer" })),
        ("settings/email", "settings.email", "-".into(), json!({ "mode": "off", "reason": "Off" })),
        ("license/install", "license.install", "l_2".into(), json!({ "license": "lic:l_2:change", "reason": "New" })),
        ("fake/widen", "fake.widen", "n_1".into(), json!({ "node": "n_1", "reason": "x" })),
        ("admins/remove", "admins.remove", BOB.into(), json!({ "email": BOB, "reason": "Left" })),
    ];
    for (i, (path, action, target, body)) in rows.into_iter().enumerate() {
        let t = T0 + 10 + i as i64 * 5_000;
        let r = post_su(c, &sid, &mut a, &format!("/console/api/{path}"), action, &target, body, t);
        assert_eq!(r.status, 200, "{path}: {}", text_of(&r));
        let e = last_entry(c, action);
        assert_eq!((e["approval"].as_str(), e["result"].as_str()), (Some("single-admin-setting"), Some("ok")), "{path}");
    }
    assert!(c.inner.lock().book.approvals.is_empty());
    assert_eq!(*b.fake.ran.lock(), vec![format!("fake.widen n_1 as {ALICE}")]);
}

#[test]
fn a_user_manager_manages_viewers_and_user_managers_only() {
    let b = build("usermanager");
    let c = &b.c;
    let mut a = Authenticator::new(5);
    let sid_a = enrol_first(c, &mut a, T0);
    let mut uma = Authenticator::new(9);
    add_person(c, &uma, UMA, PersonRole::UserManager, CONSOLE_ANCHOR);
    let sid = login(c, &mut uma, T0);
    add_person(c, &Authenticator::new(6), BOB, PersonRole::Admin, SECOND_HUB);
    add_person(c, &Authenticator::new(7), VIC, PersonRole::Viewer, CONSOLE_ANCHOR);
    let invite = |role: &str, email: &str, t: i64, uma: &mut Authenticator| post_su(c, &sid, uma, "/console/api/admins/invite", "admins.invite", email, json!({ "email": email, "role": role }), t);
    assert_eq!(invite("viewer", "v2@acme.example", T0 + 1, &mut uma).status, 200);
    assert_eq!(invite("user-manager", "u2@acme.example", T0 + 2, &mut uma).status, 200);
    let r = invite("admin", "a2@acme.example", T0 + 3, &mut uma);
    assert_eq!((r.status, code(&r).as_str()), (403, "invite-role"));
    // Suspend and unsuspend viewers; never admins.
    let r = post_su(c, &sid, &mut uma, "/console/api/admins/suspend", "admins.suspend", VIC, json!({ "email": VIC, "reason": "Away" }), T0 + 4);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    let r = post_su(c, &sid, &mut uma, "/console/api/admins/unsuspend", "admins.unsuspend", VIC, json!({ "email": VIC }), T0 + 5);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    let r = post_su(c, &sid, &mut uma, "/console/api/admins/suspend", "admins.suspend", BOB, json!({ "email": BOB, "reason": "Away" }), T0 + 6);
    assert_eq!((r.status, code(&r).as_str()), (403, "not-manageable"));
    let r = post_su(c, &sid_a, &mut a, "/console/api/admins/suspend", "admins.suspend", BOB, json!({ "email": BOB, "reason": "Away" }), T0 + 7);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    let r = post_su(c, &sid, &mut uma, "/console/api/admins/unsuspend", "admins.unsuspend", BOB, json!({ "email": BOB }), T0 + 8);
    assert_eq!((r.status, code(&r).as_str()), (403, "not-manageable"));
    // Resend and cancel viewer and user manager invites; never an admin's.
    let r = post_su(c, &sid_a, &mut a, "/console/api/admins/invite", "admins.invite", "dan@acme.example", json!({ "email": "dan@acme.example", "role": "admin" }), T0 + 9);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    let r = post_su(c, &sid, &mut uma, "/console/api/invites/resend", "invites.resend", "dan@acme.example", json!({ "email": "dan@acme.example" }), T0 + 10);
    assert_eq!((r.status, code(&r).as_str()), (403, "not-manageable"));
    let r = post_su(c, &sid, &mut uma, "/console/api/invites/resend", "invites.resend", "v2@acme.example", json!({ "email": "v2@acme.example" }), T0 + 11);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    let r = send(c, call("POST", "/console/api/invites/revoke", json!({ "email": "dan@acme.example" }), &sid), T0 + 12);
    assert_eq!((r.status, code(&r).as_str()), (403, "not-manageable"));
    let r = send(c, call("POST", "/console/api/invites/revoke", json!({ "email": "u2@acme.example" }), &sid), T0 + 13);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    // People without anchors.
    let v = json_of(&send(c, get("/console/api/admins", &sid), T0 + 14));
    let people = v["people"].as_array().unwrap();
    assert!(!people.is_empty());
    for p in people {
        assert!(p.get("invitedBy").is_none() && p.get("verifiedByHub").is_none(), "{p}");
        assert!(p["methods"]["webauthn"].as_array().unwrap().iter().all(|k| k.get("anchor").is_none() && k.get("invitedBy").is_none()), "{p}");
    }
    // Every admin route: `role`.
    let r = send(c, get("/console/api/settings", &sid), T0 + 15);
    assert_eq!((r.status, code(&r).as_str(), json_of(&r)["error"].as_str()), (403, "role", Some("Only an admin can do this.")));
    assert_eq!(code(&send(c, get("/console/api/approvals", &sid), T0 + 16)), "role");
    assert_eq!(code(&send(c, call("POST", "/console/api/admins/remove", json!({ "email": VIC }), &sid), T0 + 17)), "role");
}

// ── Break-glass (3.3, R3-M9) ────────────────────────────────────────────────────────────────────────────────

#[test]
fn under_high_the_setup_gate_holds_until_the_break_glass_account_is_complete() {
    let b = build_high("gate");
    let c = &b.c;
    let mut a = Authenticator::new(5);
    let sid = enrol_first_high(c, &mut a, T0);
    assert!(lines_of(&b.log).iter().any(|l| l.contains("\"event\":\"console.break-glass-missing\"") && l.contains(crate::console_auth::BREAK_GLASS_MISSING)));
    let gate = code_words("break-glass-needed").unwrap().1;
    // Every ordinary write waits.
    let links = json!({ "links": [] });
    let r = post_su(c, &sid, &mut a, "/console/api/settings/links", "settings.links", "-", links.clone(), T0 + 1);
    assert_eq!((r.status, code(&r).as_str(), json_of(&r)["error"].as_str()), (409, "break-glass-needed", Some(gate)));
    // Sign-in, own methods and sessions, approving a waiting passkey and the security actions go through.
    let not_gated = |r: &ConsoleReply, what: &str| assert!(code(r) != "break-glass-needed", "{what}: {}", text_of(r));
    not_gated(&send(c, call("POST", "/console/api/passkeys/rename", json!({ "hint": "x", "label": "y" }), &sid), T0 + 2), "passkeys.rename");
    not_gated(&send(c, call("POST", "/console/api/sessions/end", json!({ "id_hint": "zzzzzzzz" }), &sid), T0 + 2), "sessions.end");
    not_gated(&post_su(c, &sid, &mut a, "/console/api/admins/approve-passkey", "admins.approve-passkey", BOB, json!({ "email": BOB, "hint": "x" }), T0 + 3), "approve-passkey");
    let r = post_su(c, &sid, &mut a, "/console/api/fake/block", "fake.block", "n_1", json!({ "node": "n_1", "reason": "x" }), T0 + 4);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    let r = send(c, call("POST", "/console/api/requests/new", json!({ "kind": "rs.revoke", "target": { "node": "n_1" }, "reason": "Stolen" }), &sid), T0 + 5);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    assert_eq!(sign_in(c, &mut a, T0 + 6).status, 200);
    // The banner shows to everyone, viewers too; the item blocks.
    assert!(banner_ids(c, &sid, T0 + 7).iter().any(|id| id == "breakglass.gate"));
    let ov = json_of(&send(c, get("/console/api/overview", &sid), T0 + 7));
    assert_eq!((ov["attention"][0]["kind"].as_str(), ov["attention"][0]["blocking"].as_bool()), (Some("break-glass-missing"), Some(true)));
    let mut vic = Authenticator::new(7);
    add_person(c, &vic, VIC, PersonRole::Viewer, CONSOLE_ANCHOR);
    let sid_v = login(c, &mut vic, T0 + 8);
    assert!(banner_ids(c, &sid_v, T0 + 8).iter().any(|id| id == "breakglass.gate"));
    // The CLI creates it (no route does).
    let dir = b.dir.clone();
    drop(b);
    let out = run_offline(&dir, Offline::BreakGlass { email: BG.into(), replace: false, origin: None }, RP, &|_, _| Ok(())).unwrap();
    assert!(out.starts_with(crate::console_auth::BREAK_GLASS_LINK), "{out}");
    let link = out.lines().nth(1).unwrap().to_owned();
    let b = reopen(&dir, true);
    let c = &b.c;
    assert!(logged(&b, "console.break-glass-missing"));
    // The offline command dates its link by the wall clock; these tests run on the fixed clock T0.
    for i in c.inner.lock().book.invites.values_mut().filter(|i| i.source == crate::console_auth::InviteSource::Operator) {
        i.expires = T0 + DAY;
    }
    // Its security key, then its password: complete, and the gate opens.
    let mut bg = Authenticator::new(40);
    let r = register_with(c, &mut bg, &link, T0 + 10, true);
    assert_eq!(states(&r), "active working", "{}", text_of(&r));
    assert!(header(&r, "Set-Cookie").is_none());
    assert!(c.break_glass_gate());
    let r = send(c, call("POST", "/console/api/join/password", json!({ "token": token_of(&link), "password": BG_PASSWORD }), ""), T0 + 11);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    assert!(cookie(&r).starts_with("__Host-lrc="));
    assert!(!c.break_glass_gate());
    let sid = login(c, &mut a, T0 + 12);
    let r = post_su(c, &sid, &mut a, "/console/api/settings/links", "settings.links", "-", links.clone(), T0 + 13);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    // It never signs in without its password; its sign-in mails every active admin and raises break-glass-used.
    mail_on(c);
    let finish = |bg: &mut Authenticator, t: i64| {
        let r = sign_in(c, bg, t);
        assert_eq!(json_of(&r), json!({ "ok": true, "next": "password" }), "{}", text_of(&r));
        assert!(header(&r, "Set-Cookie").is_none());
    };
    let begin = json_of(&send(c, call("POST", "/console/api/login/begin", json!({}), ""), T0 + 14));
    let challenge = unb64u(begin["publicKey"]["challenge"].as_str().unwrap()).unwrap();
    let got = bg.assert(RP, ORIGIN, &challenge, None);
    let r = send(c, call("POST", "/console/api/login/finish", json!({ "ceremony": begin["ceremony"], "credential": got }), ""), T0 + 14);
    assert_eq!(json_of(&r), json!({ "ok": true, "next": "password" }));
    let r = send(c, call("POST", "/console/api/login/password", json!({ "ceremony": begin["ceremony"], "password": "Wrong-password-123" }), ""), T0 + 14);
    assert_eq!((r.status, json_of(&r)["error"].as_str()), (403, Some(SIGNIN)));
    assert!(mailed(c, "mail.break-glass").is_empty());
    finish(&mut bg, T0 + 15);
    let begin = json_of(&send(c, call("POST", "/console/api/login/begin", json!({}), ""), T0 + 16));
    let challenge = unb64u(begin["publicKey"]["challenge"].as_str().unwrap()).unwrap();
    let got = bg.assert(RP, ORIGIN, &challenge, None);
    send(c, call("POST", "/console/api/login/finish", json!({ "ceremony": begin["ceremony"], "credential": got }), ""), T0 + 16);
    let r = send(c, call("POST", "/console/api/login/password", json!({ "ceremony": begin["ceremony"], "password": BG_PASSWORD }), ""), T0 + 16);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    assert!(mailed(c, "mail.break-glass").iter().any(|(to, args)| to == ALICE && arg(args, "email") == BG));
    assert!(attention_kinds(c, &sid, T0 + 17).iter().any(|k| k == "break-glass-used"));
    assert_eq!(last_entry(c, "signin.ok")["detail"]["breakGlass"], true);
    // A second one is refused without --replace; with it the gate is on again until the new one is complete.
    drop(b);
    let ok = |_: &str, _: &str| -> Result<(), String> { Ok(()) };
    assert_eq!(run_offline(&dir, Offline::BreakGlass { email: "bg2@acme.example".into(), replace: false, origin: None }, RP, &ok).err().as_deref(), Some(crate::console_auth::BREAK_GLASS_EXISTS));
    run_offline(&dir, Offline::BreakGlass { email: "bg2@acme.example".into(), replace: true, origin: None }, RP, &ok).unwrap();
    let b = reopen(&dir, true);
    let c = &b.c;
    assert!(logged(&b, "console.break-glass-missing"));
    let sid = login(c, &mut a, T0 + 20);
    let r = post_su(c, &sid, &mut a, "/console/api/settings/links", "settings.links", "-", links, T0 + 21);
    assert_eq!(code(&r), "break-glass-needed");
}

#[test]
fn under_standard_the_break_glass_account_needs_its_password_and_app() {
    let b = build("bg-standard");
    let c = &b.c;
    let mut a = Authenticator::new(5);
    enrol_first(c, &mut a, T0);
    let dir = b.dir.clone();
    drop(b);
    // A Standard start never logs the gate; only the attention item stays.
    let b = reopen(&dir, false);
    let c = &b.c;
    assert!(!logged(&b, "console.break-glass-missing"));
    let sid = login(c, &mut a, T0 + 1);
    let ov = json_of(&send(c, get("/console/api/overview", &sid), T0 + 2));
    let item = ov["attention"].as_array().unwrap().iter().find(|x| x["kind"] == "break-glass-missing").cloned().unwrap();
    assert!(item.get("blocking").is_none());
    assert!(!banner_ids(c, &sid, T0 + 2).iter().any(|id| id == "breakglass.gate"));
    assert_eq!(post_su(c, &sid, &mut a, "/console/api/settings/links", "settings.links", "-", json!({ "links": [] }), T0 + 3).status, 200);
    // The break-glass account: a passkey, a password and an app; complete under Standard with the password and app.
    let mut bgk = Authenticator::new(40);
    {
        let mut inner = c.inner.lock();
        let mut p = Person::new("h-bg".into(), PersonRole::Admin, PersonState::Active, OPERATOR_ANCHOR, T0);
        p.break_glass = true;
        p.passkeys.push(key_of(&bgk, OPERATOR_ANCHOR, false));
        inner.book.people.insert(BG.into(), p);
    }
    set_password(c, BG, BG_PASSWORD, OPERATOR_ANCHOR);
    let secret = set_totp(c, BG, OPERATOR_ANCHOR);
    assert!(!attention_kinds(c, &sid, T0 + 4).iter().any(|k| k == "break-glass-missing"));
    // Its passkey alone never signs it in, nor its password alone.
    assert_eq!(code(&sign_in(c, &mut bgk, T0 + 5)), "signin-refused");
    mail_on(c);
    let t = T0 + 10 * MIN;
    let r = sign_in_totp(c, BG, BG_PASSWORD, &secret, "198.51.100.95", t);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    let bg_sid = cookie(&r);
    assert!(mailed(c, "mail.break-glass").iter().any(|(to, _)| to == ALICE));
    let sid = login(c, &mut a, t + 1);
    assert!(attention_kinds(c, &sid, t + 2).iter().any(|k| k == "break-glass-used"));
    // Not removable as the only active admin.
    c.inner.lock().book.people.get_mut(ALICE).unwrap().state = PersonState::Suspended;
    let body = json!({ "email": BG, "reason": "Done" });
    let t2 = t + MIN;
    let mut remove = body.clone();
    remove["stepup"] = stepup_code(c, &bg_sid, "admins.remove", BG, &body, &code_at(&secret, t2), t2);
    let r = send(c, call("POST", "/console/api/admins/remove", remove, &bg_sid), t2);
    assert_eq!((r.status, code(&r).as_str()), (409, "last-admin"));
}

// ── Recovery (3.3, R3-L2) ───────────────────────────────────────────────────────────────────────────────────

#[test]
fn recovery_links_follow_their_kind_and_mail_rules() {
    let b = build("recovery");
    let c = &b.c;
    let mut a = Authenticator::new(5);
    let sid = enrol_first(c, &mut a, T0);
    mail_on(c);
    add_person(c, &Authenticator::new(6), BOB, PersonRole::Admin, SECOND_HUB);
    add_person(c, &Authenticator::new(8), CAROL, PersonRole::Admin, "0000000000000000000000000000000c");
    let mut vic = Authenticator::new(7);
    add_person(c, &vic, VIC, PersonRole::Viewer, CONSOLE_ANCHOR);
    set_password(c, VIC, PW, CONSOLE_ANCHOR);
    let vic_sid = login(c, &mut vic, T0 + 1);
    let reset = |email: &str, t: i64, a: &mut Authenticator| post_su(c, &sid, a, "/console/api/admins/reset-sign-in", "admins.reset-sign-in", email, json!({ "email": email, "reason": "Lost the phone" }), t);
    // A viewer's sign-in reset: every method and session goes; the link is shown, never mailed.
    let r = reset(VIC, T0 + 2, &mut a);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    let link = json_of(&r)["link"].as_str().unwrap().to_owned();
    assert!(link.contains("#join="));
    {
        let inner = c.inner.lock();
        let p = &inner.book.people[VIC];
        assert!(p.passkeys.is_empty() && p.password.is_none() && p.totp.is_none());
        assert!(inner.sessions.values().all(|s| s.email != VIC));
    }
    assert_eq!(send(c, get("/console/api/overview", &vic_sid), T0 + 3).status, 401);
    // Its token is a sign-in reset: the join flow takes it, recover/finish never does.
    let token = token_of(&link);
    let r = send(c, call("POST", "/console/api/recover/finish", json!({ "token": token, "password": PW }), ""), T0 + 4);
    assert_eq!(r.status, 410);
    let r = send(c, call("POST", "/console/api/join", json!({ "token": token }), ""), T0 + 4);
    assert_eq!((r.status, json_of(&r)["reset"].as_bool()), (200, Some(true)));
    // An admin's sign-in reset with two-person control off: at once, never mailed.
    let r = reset(BOB, T0 + 5, &mut a);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    assert!(json_of(&r)["link"].as_str().is_some_and(|l| l.contains("#join=")));
    assert_eq!(last_entry(c, "admins.reset-sign-in")["approval"], "single-admin-setting");
    assert!(c.mailer.captured().is_empty(), "a reset-sign-in link was mailed");
    // With two-person control on: an approval.
    two_person(c, true);
    let r = reset(CAROL, T0 + 6, &mut a);
    assert_eq!(json_of(&r)["approval"]["state"], "waiting", "{}", text_of(&r));
    two_person(c, false);
    // recover/begin answers the same for every email and mails only an active viewer under Standard, once an hour.
    add_person(c, &Authenticator::new(9), WES, PersonRole::Viewer, CONSOLE_ANCHOR);
    set_password(c, WES, PW, CONSOLE_ANCHOR);
    let ask = |email: &str, t: i64| {
        let r = send_from(c, "/console/api/recover/begin", json!({ "email": email }), "", "198.51.100.90", t);
        assert_eq!(r.status, 200, "{}", text_of(&r));
        json_of(&r)
    };
    let answers = [ask(WES, T0 + 10), ask(WES, T0 + 11), ask("nobody@acme.example", T0 + 12), ask(ALICE, T0 + 13)];
    assert!(answers.iter().all(|x| *x == json!({ "ok": true })));
    let sent = mailed(c, "mail.reset-password");
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].0, WES);
    let link = arg(&sent[0].1, "link").to_owned();
    let token = link.split_once("#reset=").map(|(_, t)| t.to_owned()).unwrap();
    // A reset-password token never opens the join flow; at recover/finish it sets a password only.
    assert_eq!(send(c, call("POST", "/console/api/join", json!({ "token": token }), ""), T0 + 14).status, 410);
    let r = send(c, call("POST", "/console/api/recover/finish", json!({ "token": token, "password": "Qz7!mR2#vK9@" }), ""), T0 + 15);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    {
        let inner = c.inner.lock();
        let p = &inner.book.people[WES];
        assert!(crate::console_password::verify("Qz7!mR2#vK9@", Some(p.password.as_ref().unwrap().hash.as_str())));
        assert_eq!(p.passkeys.len(), 1);
    }
    assert_eq!(last_entry(c, "recover.done")["actor"], WES);
    assert_eq!(send(c, call("POST", "/console/api/recover/finish", json!({ "token": token, "password": PW }), ""), T0 + 16).status, 410);
    // Under High: no mail.
    set_profile(c, Profile::High);
    assert_eq!(ask(WES, T0 + 2 * HOUR), json!({ "ok": true }));
    assert_eq!(mailed(c, "mail.reset-password").len(), 1);
}

// ── Sessions per profile (3.4) ──────────────────────────────────────────────────────────────────────────────

#[test]
fn session_lifetimes_follow_the_profile_and_the_banner_is_accepted_once() {
    // High: 15 minutes idle and 12 hours, fixed.
    let h = build_high("sessions-high");
    let c = &h.c;
    let mut a = Authenticator::new(5);
    let sid = enrol_first_high(c, &mut a, T0);
    add_break_glass(c, &Authenticator::new(40), BG, BG_PASSWORD);
    let path = "/console/api/settings/sign-in";
    let body = |idle: i64, max: i64| json!({ "requirePassword": false, "idleMinutes": idle, "maxHours": max, "reason": "Sessions" });
    for (i, (idle, max)) in [(30, 12), (15, 24), (10, 12)].into_iter().enumerate() {
        let r = post_su(c, &sid, &mut a, path, "settings.sign-in", "-", body(idle, max), T0 + 1 + i as i64);
        assert_eq!((r.status, code(&r).as_str()), (409, "profile-high"), "{idle} {max}");
    }
    let me = json_of(&send(c, get("/console/api/me", &sid), T0 + 5));
    assert_eq!(me["idle"], json!({ "minutes": 15, "maxHours": 12 }));
    // Standard: 5 to 60 minutes and 1 to 24 hours.
    let b = build("sessions-standard");
    let c = &b.c;
    let mut a = Authenticator::new(5);
    let sid = enrol_first(c, &mut a, T0);
    for (i, (idle, max)) in [(4, 12), (61, 12), (15, 0), (15, 25)].into_iter().enumerate() {
        let r = post_su(c, &sid, &mut a, path, "settings.sign-in", "-", body(idle, max), T0 + 1 + i as i64);
        assert_eq!((r.status, code(&r).as_str()), (400, "invalid"), "{idle} {max}");
    }
    let r = post_su(c, &sid, &mut a, path, "settings.sign-in", "-", body(5, 12), T0 + 10);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    assert_eq!(send(c, get("/console/api/overview", &sid), T0 + 10 + 6 * MIN).status, 401);
    let t = T0 + HOUR;
    let sid = login(c, &mut a, t);
    let r = post_su(c, &sid, &mut a, path, "settings.sign-in", "-", body(60, 24), t + 1);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    assert_eq!(last_entry(c, "settings.sign-in")["approval"], "single-admin-setting");
    assert_eq!(send(c, get("/console/api/overview", &sid), t + 59 * MIN).status, 200);
    assert_eq!(send(c, get("/console/api/overview", &sid), t + 59 * MIN + 61 * MIN).status, 401);
    // A banner: login/begin needs `banner: true`, and the session records when it was accepted.
    let t = T0 + 4 * HOUR;
    let sid = login(c, &mut a, t);
    let r = post_su(c, &sid, &mut a, "/console/api/settings/banner", "settings.banner", "-", json!({ "text": "Authorized use only.\nAll activity is logged." }), t + 1);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    assert_eq!(json_of(&send(c, get("/console/api/banner", ""), t + 2))["banner"], "Authorized use only.\nAll activity is logged.");
    let r = send(c, call("POST", "/console/api/login/begin", json!({}), ""), t + 3);
    assert_eq!((r.status, code(&r).as_str()), (400, "banner-needed"));
    let r = sign_in_with(c, &mut a, "192.0.2.7", json!({ "banner": true }), t + 4);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    let hash = sid_hash(&cookie(&r));
    assert_eq!(c.inner.lock().sessions[&hash].banner_at, Some(t + 4));
    assert_eq!(last_entry(c, "signin.ok")["detail"]["banner"], true);
}

// ── Email and sealed secrets (3.11) ─────────────────────────────────────────────────────────────────────────

#[test]
fn email_saves_are_staged_and_secrets_stay_sealed() {
    let b = build("email");
    let c = &b.c;
    let mut a = Authenticator::new(5);
    let sid = enrol_first(c, &mut a, T0);
    c.mailer.capture();
    let path = "/console/api/settings/email";
    let r = post_su(c, &sid, &mut a, path, "settings.email", "-", smtp_body("smtp.acme.example", true), T0 + 1);
    assert_eq!((r.status, json_of(&r)["verified"].as_bool()), (200, Some(true)), "{}", text_of(&r));
    assert_eq!(c.mailer.config().smtp.unwrap().host, "smtp.acme.example");
    assert!(mailed(c, "mail.test").iter().any(|(to, _)| to == ALICE));
    let e = last_entry(c, "settings.email");
    assert_eq!(e["detail"]["verified"], true);
    // A staged save that fails leaves the working configuration delivering and answers mail-failed.
    c.mailer.fail_next("535 authentication failed");
    let r = post_su(c, &sid, &mut a, path, "settings.email", "-", smtp_body("wrong.acme.example", true), T0 + 2);
    assert_eq!((r.status, code(&r).as_str()), (502, "mail-failed"));
    assert!(json_of(&r)["error"].as_str().unwrap().contains("535"));
    let cfg = c.mailer.config();
    assert_eq!((cfg.mode, cfg.smtp.unwrap().host), (Mode::Smtp, "smtp.acme.example".to_owned()));
    // The test mail goes only to the caller.
    let before = c.mailer.captured().len();
    let r = send(c, call("POST", "/console/api/settings/email/test", json!({}), &sid), T0 + 3);
    assert_eq!((r.status, json_of(&r)["to"].as_str()), (200, Some(ALICE)));
    let after = c.mailer.captured();
    assert_eq!(after.len(), before + 1);
    assert_eq!((after[before].0.as_str(), after[before].1.as_str()), ("mail.test", ALICE));
    // No secret in an answer, the book, a log line or an entry.
    let settings = text_of(&send(c, get("/console/api/settings", &sid), T0 + 4));
    assert!(settings.contains("passwordSet"));
    let mut all: Vec<String> = vec![settings, std::fs::read_to_string(&c.file).unwrap(), std::fs::read_to_string(b.dir.join(crate::console_seal::SECRETS_FILE)).unwrap()];
    all.extend(entries(c).into_iter().map(|e| stringify(&Value::Object(e))));
    all.extend(lines_of(&b.log));
    assert!(all.iter().all(|l| !l.contains("Smtp-Secret-7781")));
    // Viewer invites are mailed; user manager and admin invites never.
    for (i, (role, email, mail)) in [("viewer", "v1@acme.example", true), ("user-manager", "u1@acme.example", false), ("admin", "a1@acme.example", false)].into_iter().enumerate() {
        let r = post_su(c, &sid, &mut a, "/console/api/admins/invite", "admins.invite", email, json!({ "email": email, "role": role }), T0 + 5 + i as i64);
        assert_eq!((r.status, json_of(&r)["mailed"].as_bool()), (200, Some(mail)), "{role}: {}", text_of(&r));
        assert_eq!(mailed(c, "mail.invite").iter().any(|(to, _)| to == email), mail, "{role}");
    }
    // Under High: a Graph client secret is refused; a mail secret needs a compliant seal provider.
    let h = build_high("email-high");
    let c = &h.c;
    let mut a = Authenticator::new(5);
    let sid = enrol_first_high(c, &mut a, T0);
    add_break_glass(c, &Authenticator::new(40), BG, BG_PASSWORD);
    c.mailer.capture();
    let graph = json!({ "mode": "graph", "from": "console@acme.example", "graph": { "cloud": "commercial", "tenant": "acme.example", "clientId": "00000000-0000-0000-0000-000000000001", "mailbox": "console@acme.example", "credential": "secret", "secret": "Graph-Secret-1" }, "reason": "Mail" });
    let r = post_su(c, &sid, &mut a, path, "settings.email", "-", graph, T0 + 1);
    assert_eq!((r.status, code(&r).as_str()), (400, "mail-secret-high"), "{}", text_of(&r));
    let compliant = c.seal.lock().as_ref().unwrap().compliant();
    let r = post_su(c, &sid, &mut a, path, "settings.email", "-", smtp_body("smtp.acme.example", true), T0 + 2);
    if compliant {
        assert_eq!(r.status, 200, "{}", text_of(&r));
    } else {
        assert_eq!((r.status, code(&r).as_str()), (409, "seal-provider-needed"), "{}", text_of(&r));
        assert_eq!(c.mailer.config().mode, Mode::Off);
        assert!(c.seal.lock().as_ref().unwrap().names().iter().all(|n| !n.starts_with("mail.")));
    }
}

// ── State files (3.11, R3-M2) ───────────────────────────────────────────────────────────────────────────────

#[test]
fn unreadable_or_lost_secrets_and_a_bad_metadata_file() {
    // console-secrets.json that does not read back: 503 like the book, the page still served.
    let b = build("secrets-unreadable");
    enrol_first(&b.c, &mut Authenticator::new(5), T0);
    let dir = b.dir.clone();
    drop(b);
    std::fs::write(dir.join(crate::console_seal::SECRETS_FILE), "{not json").unwrap();
    let b = reopen(&dir, false);
    let r = send(&b.c, get("/console/api/me", ""), T0);
    assert_eq!((r.status, code(&r).as_str()), (503, "state-unreadable"));
    assert_eq!(send(&b.c, get("/console/", ""), T0).status, 200);
    drop(b);
    // A data key that does not unwrap: seal-lost, a new decoy key, mail off, authenticator apps unusable; a bad
    // console-mds.jwt falls back with mds-old.
    // The wrapped data key is replaced with bytes no provider unwraps, so the loss happens whichever provider this
    // host picks (machine DPAPI on Windows, the key file elsewhere).
    let b = build("seal-lost");
    let c = &b.c;
    let mut a = Authenticator::new(5);
    enrol_first(c, &mut a, T0);
    set_totp(c, ALICE, HUB_SERIAL);
    {
        let mut inner = c.inner.lock();
        c.save_book(&mut inner).unwrap();
    }
    let old = c.seal_get(crate::console_auth::DECOY_SECRET).unwrap();
    let dir = b.dir.clone();
    drop(b);
    let secrets = dir.join(crate::console_seal::SECRETS_FILE);
    let mut v = crate::codec::parse_json(&std::fs::read_to_string(&secrets).unwrap()).unwrap();
    v["dataKey"] = Value::from(crate::codec::b64u(&[9u8; 200]));
    std::fs::write(&secrets, stringify(&v)).unwrap();
    std::fs::write(dir.join(crate::console_mds::MDS_FILE), "not a metadata blob").unwrap();
    let b = reopen(&dir, false);
    let c = &b.c;
    assert!(c.seal.lock().as_ref().unwrap().lost());
    assert!(logged(&b, "console.seal-lost"));
    assert_eq!(last_entry(c, "console.seal-lost")["actor"], "relay");
    assert_ne!(c.seal_get(crate::console_auth::DECOY_SECRET).unwrap(), old);
    assert!(c.inner.lock().book.people[ALICE].totp.as_ref().unwrap().unusable);
    assert_eq!(c.mailer.config().mode, Mode::Off);
    assert!(c.mds.lock().stored_refused);
    let sid = login(c, &mut a, T0 + 1);
    let kinds = attention_kinds(c, &sid, T0 + 2);
    assert!(kinds.iter().any(|k| k == "seal-lost") && kinds.iter().any(|k| k == "mds-old"), "{kinds:?}");
}

// ── Two admins and the sole-admin path (3.7, H1, N1), two-person control on ────────────────────────────────

#[test]
fn a_lone_admin_invites_the_second_on_the_sole_admin_path_and_the_latch_holds() {
    let b = build("lone");
    let c = &b.c;
    two_person(c, true);
    let mut a = Authenticator::new(5);
    let sid = enrol_first(c, &mut a, T0);
    let r = post_su(c, &sid, &mut a, "/console/api/admins/invite", "admins.invite", BOB, json!({ "email": BOB, "role": "admin" }), T0 + 1);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    let link = json_of(&r)["link"].as_str().unwrap().to_owned();
    let e = last_entry(c, "admins.invite");
    assert_eq!((e["approval"].as_str(), e["result"].as_str()), (Some("sole-admin"), Some("ok")));
    assert!(!stringify(&Value::Object(e)).contains(&token_of(&link)));
    assert!(!c.inner.lock().book.ever_two_admins);
    let r = register(c, &mut Authenticator::new(6), &link, T0 + 2);
    assert_eq!(json_of(&r)["state"], "active");
    let inner = c.inner.lock();
    assert!(inner.book.ever_two_admins);
    assert_eq!(inner.book.people[BOB].passkeys[0].anchor, CONSOLE_ANCHOR);
    assert_eq!(inner.book.people[BOB].invited_by.as_deref(), Some(ALICE));
}

#[test]
fn two_admins_never_remove_or_demote_each_other_alone() {
    let b = build("twoadmins");
    let c = &b.c;
    two_person(c, true);
    let mut a = Authenticator::new(5);
    let sid = enrol_first(c, &mut a, T0);
    let mut bob = Authenticator::new(6);
    add_person(c, &bob, BOB, PersonRole::Admin, SECOND_HUB);
    let removal = "Another admin must approve this. With no other admin, the person who runs this relay can do it with the relay stopped.";
    // A removes or demotes B at once: no-approver.
    let r = post_su(c, &sid, &mut a, "/console/api/admins/remove", "admins.remove", BOB, json!({ "email": BOB, "reason": "Left" }), T0 + 1);
    assert_eq!((r.status, code(&r).as_str(), json_of(&r)["error"].as_str()), (409, "no-approver", Some(removal)));
    let r = post_su(c, &sid, &mut a, "/console/api/admins/role", "admins.role", BOB, json!({ "email": BOB, "role": "viewer", "reason": "x" }), T0 + 2);
    assert_eq!(code(&r), "no-approver");
    // A suspends B: the sole-admin path (it can be undone).
    let r = post_su(c, &sid, &mut a, "/console/api/admins/suspend", "admins.suspend", BOB, json!({ "email": BOB, "reason": "Away" }), T0 + 3);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    assert_eq!(last_entry(c, "admins.suspend")["approval"], "sole-admin");
    // While B is suspended the sole-admin path is closed: an admin invite has no approver.
    let r = post_su(c, &sid, &mut a, "/console/api/admins/invite", "admins.invite", CAROL, json!({ "email": CAROL, "role": "admin" }), T0 + 4);
    assert_eq!((r.status, code(&r).as_str(), json_of(&r)["error"].as_str()), (409, "no-approver", Some("Another admin must approve this. Unsuspend or add an admin first.")));
    // Eight days later, removing B is still no-approver.
    let t = T0 + 8 * DAY;
    let sid = login(c, &mut a, t);
    let r = post_su(c, &sid, &mut a, "/console/api/admins/remove", "admins.remove", BOB, json!({ "email": BOB, "reason": "Left" }), t + 1);
    assert_eq!(code(&r), "no-approver");
    // A unsuspends B.
    let r = post_su(c, &sid, &mut a, "/console/api/admins/unsuspend", "admins.unsuspend", BOB, json!({ "email": BOB }), t + 2);
    assert_eq!(r.status, 200);
    assert_eq!(sign_in(c, &mut bob, t + 3).status, 200);
    // The operator removes B with the relay stopped.
    let dir = b.dir.clone();
    drop(b);
    let done = run_offline(&dir, Offline::RemoveAdmin(BOB.into()), RP, &|_, _| Ok(())).unwrap();
    assert!(done.contains("removed admin bob@acme.example"));
}

#[test]
fn four_admins_suspensions_keep_two_active_and_never_open_the_sole_admin_path() {
    let b = build("four");
    let c = &b.c;
    two_person(c, true);
    let mut a = Authenticator::new(5);
    let sid_a = enrol_first(c, &mut a, T0);
    let mut keys = Vec::new();
    for (i, email) in [BOB, CAROL, "dan@acme.example"].iter().enumerate() {
        let k = Authenticator::new(6 + i as u8);
        add_person(c, &k, email, PersonRole::Admin, SECOND_HUB);
        keys.push(k);
    }
    let mut dan = keys.pop().unwrap();
    let sid_d = login(c, &mut dan, T0);
    let susp = |sid: &str, k: &mut Authenticator, email: &str, t: i64| post_su(c, sid, k, "/console/api/admins/suspend", "admins.suspend", email, json!({ "email": email, "reason": "Check" }), t);
    // A suspends B: 3 active admins remain.
    assert_eq!(susp(&sid_a, &mut a, BOB, T0 + 1).status, 200);
    // A's second single-admin suspension within 24 hours: refused.
    let r = susp(&sid_a, &mut a, CAROL, T0 + 2);
    assert_eq!((r.status, code(&r).as_str()), (429, "rate"));
    assert!(header(&r, "Retry-After").is_some());
    // D suspends C: A and D stay active.
    assert_eq!(susp(&sid_d, &mut dan, CAROL, T0 + 3).status, 200);
    // A suspending D would leave one active admin: a second admin, and nobody can approve; never sole-admin.
    let t = T0 + 2 * DAY;
    let sid_a = login(c, &mut a, t);
    let r = susp(&sid_a, &mut a, "dan@acme.example", t + 1);
    assert_eq!((r.status, code(&r).as_str()), (409, "no-approver"));
    // Another two-admin action while D is active: an approval D can make, never the sole-admin path.
    let r = post_su(c, &sid_a, &mut a, "/console/api/admins/invite", "admins.invite", "erin@acme.example", json!({ "email": "erin@acme.example", "role": "admin" }), t + 2);
    assert_eq!(json_of(&r)["approval"]["state"], "waiting", "{}", text_of(&r));
    // Suspended admins still count (2.3): there are four admin-role people, two of them active.
    {
        let inner = c.inner.lock();
        assert_eq!((inner.book.people.values().filter(|p| p.admin_role()).count(), inner.book.active_admins()), (4, 2));
    }
    // With every other admin suspended, a two-admin action answers no-approver, never sole-admin.
    c.inner.lock().book.people.get_mut("dan@acme.example").unwrap().state = PersonState::Suspended;
    let r = post_su(c, &sid_a, &mut a, "/console/api/admins/invite", "admins.invite", "frank@acme.example", json!({ "email": "frank@acme.example", "role": "admin" }), t + 3);
    assert_eq!((r.status, code(&r).as_str()), (409, "no-approver"));
    assert!(entries(c).iter().all(|e| e["approval"] != "sole-admin"));
}

#[test]
fn approvals_are_unique_rechecked_and_cancelled_with_their_requester() {
    let b = build("approvals");
    let c = &b.c;
    two_person(c, true);
    let mut a = Authenticator::new(5);
    let sid_a = enrol_first(c, &mut a, T0);
    let mut bob = Authenticator::new(6);
    let mut carol = Authenticator::new(7);
    add_person(c, &bob, BOB, PersonRole::Admin, SECOND_HUB);
    add_person(c, &carol, CAROL, PersonRole::Admin, "0000000000000000000000000000000c");
    let sid_b = login(c, &mut bob, T0);
    let sid_c = login(c, &mut carol, T0);
    // A asks to remove C: an approval; the same again answers the existing one.
    let body = json!({ "email": CAROL, "reason": "Left" });
    let r = post_su(c, &sid_a, &mut a, "/console/api/admins/remove", "admins.remove", CAROL, body.clone(), T0 + 1);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    let approval = json_of(&r)["approval"].clone();
    assert_eq!((approval["state"].as_str(), approval["requested_by"].as_str()), (Some("waiting"), Some(ALICE)));
    assert!(approval["id"].as_str().unwrap().starts_with("ap_") && approval["id"].as_str().unwrap().len() == 19);
    assert_eq!(approval["expires_at"].as_i64(), Some(T0 + 1 + DAY));
    let r = post_su(c, &sid_a, &mut a, "/console/api/admins/remove", "admins.remove", CAROL, body, T0 + 2);
    assert_eq!((r.status, code(&r).as_str()), (409, "approval-exists"));
    assert_eq!(json_of(&r)["approval"]["id"], approval["id"]);
    let e = entries(c).into_iter().rev().find(|e| e["action"] == "admins.remove" && e["result"] == "waiting").unwrap();
    assert_eq!(e["approval"], approval["id"]);
    // C, the target, may not approve; A, the requester, may not either.
    let id = approval["id"].as_str().unwrap().to_owned();
    let params = approval["params"].clone();
    let approve = |sid: &str, k: &mut Authenticator, t: i64| {
        let su = stepup(c, sid, k, "approvals.approve", &id, &params, t);
        send(c, call("POST", "/console/api/approvals/approve", json!({ "id": id, "stepup": su }), sid), t)
    };
    assert_eq!(code(&approve(&sid_c, &mut carol, T0 + 3)), "not-eligible");
    assert_eq!(code(&approve(&sid_a, &mut a, T0 + 3)), "not-eligible");
    // A is demoted (here: straight in the book): B's approval finds the requester changed, `stale`.
    c.inner.lock().book.people.get_mut(ALICE).unwrap().role = PersonRole::Viewer;
    let r = approve(&sid_b, &mut bob, T0 + 4);
    assert_eq!((r.status, code(&r).as_str()), (409, "stale"));
    assert_eq!(c.inner.lock().book.approvals.iter().find(|a| a["id"] == id.as_str()).unwrap()["state"], "failed");
    c.inner.lock().book.people.get_mut(ALICE).unwrap().role = PersonRole::Admin;
    // A asks again; B suspends A (3 admins: two stay active): A's approval is cancelled.
    let sid_a = login(c, &mut a, T0 + 5);
    let r = post_su(c, &sid_a, &mut a, "/console/api/admins/remove", "admins.remove", CAROL, json!({ "email": CAROL, "reason": "Left again" }), T0 + 6);
    let id2 = json_of(&r)["approval"]["id"].as_str().unwrap().to_owned();
    let r = post_su(c, &sid_b, &mut bob, "/console/api/admins/suspend", "admins.suspend", ALICE, json!({ "email": ALICE, "reason": "Check" }), T0 + 7);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    assert_eq!(c.inner.lock().book.approvals.iter().find(|a| a["id"] == id2.as_str()).unwrap()["state"], "cancelled");
    // C unsuspends A; then B suspends A again within 7 days: that needs a second admin, and C approves.
    let r = post_su(c, &sid_c, &mut carol, "/console/api/admins/unsuspend", "admins.unsuspend", ALICE, json!({ "email": ALICE }), T0 + 8);
    assert_eq!(r.status, 200);
    let sid_a = login(c, &mut a, T0 + DAY + 9);
    let sid_b = login(c, &mut bob, T0 + DAY + 9);
    let sid_c = login(c, &mut carol, T0 + DAY + 9);
    let r = post_su(c, &sid_b, &mut bob, "/console/api/admins/suspend", "admins.suspend", ALICE, json!({ "email": ALICE, "reason": "Again" }), T0 + DAY + 10);
    assert_eq!(json_of(&r)["approval"]["state"], "waiting", "{}", text_of(&r));
    let id3 = json_of(&r)["approval"]["id"].as_str().unwrap().to_owned();
    let params3 = json_of(&r)["approval"]["params"].clone();
    let su = stepup(c, &sid_c, &mut carol, "approvals.approve", &id3, &params3, T0 + DAY + 11);
    let r = send(c, call("POST", "/console/api/approvals/approve", json!({ "id": id3, "stepup": su }), &sid_c), T0 + DAY + 11);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    assert_eq!(json_of(&r)["approval"]["state"], "done");
    assert_eq!(c.inner.lock().book.people[ALICE].state, PersonState::Suspended);
    assert_eq!(send(c, get("/console/api/overview", &sid_a), T0 + DAY + 12).status, 401);
}

#[test]
fn the_last_active_admin_stays() {
    let b = build("lastadmin");
    let c = &b.c;
    let mut a = Authenticator::new(5);
    let sid = enrol_first(c, &mut a, T0);
    let r = post_su(c, &sid, &mut a, "/console/api/admins/remove", "admins.remove", ALICE, json!({ "email": ALICE, "reason": "Bye" }), T0 + 1);
    assert_eq!((r.status, code(&r).as_str()), (409, "last-admin"));
    let r = post_su(c, &sid, &mut a, "/console/api/admins/role", "admins.role", ALICE, json!({ "email": ALICE, "role": "viewer", "reason": "x" }), T0 + 2);
    assert_eq!(code(&r), "last-admin");
    let r = post_su(c, &sid, &mut a, "/console/api/admins/suspend", "admins.suspend", ALICE, json!({ "email": ALICE, "reason": "x" }), T0 + 3);
    assert_eq!(r.status, 400);
    // A viewer approves nothing: one admin removes one with step-up, and their sessions end.
    let mut vic = Authenticator::new(6);
    add_person(c, &vic, VIC, PersonRole::Viewer, CONSOLE_ANCHOR);
    let sid_v = login(c, &mut vic, T0 + 4);
    let r = post_su(c, &sid, &mut a, "/console/api/admins/remove", "admins.remove", VIC, json!({ "email": VIC, "reason": "Done" }), T0 + 5);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    assert_eq!(send(c, get("/console/api/overview", &sid_v), T0 + 6).status, 401);
}

// ── Every section 5 row of the core ─────────────────────────────────────────────────────────────────────────

#[test]
fn every_core_step_up_row_is_refused_without_it_and_runs_with_it() {
    let b = build("rows");
    let c = &b.c;
    let mut a = Authenticator::new(5);
    let sid = enrol_first(c, &mut a, T0);
    mail_on(c);
    add_person(c, &Authenticator::new(6), BOB, PersonRole::Admin, SECOND_HUB);
    add_person(c, &Authenticator::new(7), VIC, PersonRole::Viewer, CONSOLE_ANCHOR);
    // A waiting joiner, a waiting passkey of bob's and one of alice's (hub invites after bootstrap).
    let jo = "jo@acme.example";
    let inv = c.invite(jo, HUB_NODE, "000000000000000000000000000000d1", &dialed(HOST), T0).unwrap();
    register(c, &mut Authenticator::new(20), &inv.link, T0);
    let inv = c.invite(BOB, HUB_NODE, "000000000000000000000000000000d2", &dialed(HOST), T0).unwrap();
    let mut bob2 = Authenticator::new(21);
    register(c, &mut bob2, &inv.link, T0);
    let inv = c.invite(ALICE, HUB_NODE, "000000000000000000000000000000d3", &dialed(HOST), T0).unwrap();
    let mut alice2 = Authenticator::new(22);
    register(c, &mut alice2, &inv.link, T0);
    let (h_bob2, h_alice2) = (hint_of(&b64u(&bob2.id)), hint_of(&b64u(&alice2.id)));
    let newbie = "new@acme.example";
    let links = json!({ "links": [{ "label": "Meet", "url": "https://meet-admin.acme.example/console/" }] });
    let rows: Vec<(&str, &str, String, Value, u16)> = vec![
        ("settings/links", "settings.links", "-".into(), links, 200),
        ("settings/sign-in", "settings.sign-in", "-".into(), json!({ "requirePassword": false, "idleMinutes": 10, "maxHours": 12, "reason": "Shorter" }), 200),
        ("settings/banner", "settings.banner", "-".into(), json!({ "text": "Authorized use only." }), 200),
        ("settings/aaguids", "settings.aaguids", "-".into(), json!({ "aaguids": [aaguid_text()], "reason": "Keys" }), 200),
        ("settings/mds", "settings.mds", "-".into(), json!({ "blob": "not a metadata blob" }), 400),
        ("settings/email", "settings.email", "-".into(), smtp_body("smtp.acme.example", false), 200),
        ("settings/license-request-to", "settings.license-request-to", "-".into(), json!({ "address": "seats@acme.example" }), 200),
        ("admins/invite", "admins.invite", newbie.into(), json!({ "email": newbie, "role": "viewer" }), 200),
        ("invites/resend", "invites.resend", newbie.into(), json!({ "email": newbie }), 200),
        ("admins/approve-join", "admins.approve-join", jo.into(), json!({ "email": jo }), 200),
        ("admins/approve-passkey", "admins.approve-passkey", BOB.into(), json!({ "email": BOB, "hint": h_bob2 }), 200),
        ("admins/role", "admins.role", VIC.into(), json!({ "email": VIC, "role": "user-manager", "reason": "Helps" }), 200),
        ("admins/suspend", "admins.suspend", VIC.into(), json!({ "email": VIC, "reason": "Away" }), 200),
        ("admins/unsuspend", "admins.unsuspend", VIC.into(), json!({ "email": VIC }), 200),
        ("admins/reset-sign-in", "admins.reset-sign-in", VIC.into(), json!({ "email": VIC, "reason": "Lost" }), 200),
        ("sessions/end-all", "sessions.end-all", BOB.into(), json!({ "email": BOB }), 200),
        ("passkeys/confirm", "passkeys.confirm", h_alice2.clone(), json!({ "hint": h_alice2 }), 200),
        ("passkeys/remove", "passkeys.remove", h_alice2.clone(), json!({ "hint": h_alice2 }), 200),
        ("passkeys/add/begin", "passkeys.add", "-".into(), json!({}), 200),
        ("account/security-key/begin", "account.security-key", "-".into(), json!({}), 200),
        ("account/password", "account.password", "-".into(), json!({ "current": "", "password": PW }), 200),
        ("account/totp/begin", "account.totp", "-".into(), json!({}), 200),
        ("account/totp/remove", "account.totp-remove", "-".into(), json!({}), 404),
        ("logs/export", "logs.export", "relay".into(), json!({ "source": "relay", "cat": "all", "level": "debug" }), 200),
        ("audit/restart", "audit.restart", "-".into(), json!({}), 409),
        ("admins/remove", "admins.remove", VIC.into(), json!({ "email": VIC, "reason": "Left" }), 200),
        ("audit/export", "audit.export", "1-2".into(), json!({ "from": 1, "to": 2 }), 200),
        ("license/install", "license.install", "l_1".into(), json!({ "license": "lic:l_1:renew", "reason": "Renewal" }), 200),
        ("settings/two-person", "settings.two-person", "-".into(), json!({ "twoPerson": "on", "reason": "Policy" }), 200),
        ("settings/profile", "settings.profile", "-".into(), json!({ "profile": "high", "reason": "Harden" }), 200),
    ];
    for (i, (path, action, target, body, status)) in rows.into_iter().enumerate() {
        let t = T0 + 10 + i as i64 * 5_000;
        let url = format!("/console/api/{path}");
        let r = send(c, call("POST", &url, body.clone(), &sid), t);
        assert_eq!((r.status, code(&r).as_str()), (401, "stepup-needed"), "{path} without its step-up");
        let r = post_su(c, &sid, &mut a, &url, action, &target, body, t + 1);
        assert_eq!(r.status, status, "{path} with its step-up: {}", text_of(&r));
        assert!(!code(&r).starts_with("stepup"), "{path}");
    }
    let inner = c.inner.lock();
    let s = &inner.book.settings;
    assert_eq!((s.links.len(), s.idle_minutes, s.banner.as_deref(), s.aaguids.len()), (1, 10, Some("Authorized use only."), 1));
    assert_eq!(s.license_request_to.as_deref(), Some("seats@acme.example"));
    assert!(s.two_person && s.profile == Profile::High);
    assert!(inner.book.invites.values().any(|i| i.email == newbie));
    assert_eq!(inner.book.people[jo].state, PersonState::Active);
    assert!(inner.book.people[BOB].passkeys.iter().all(|k| k.state == KeyState::Working));
    assert!(!inner.book.people.contains_key(VIC));
    assert!(inner.book.people[ALICE].passkeys.iter().all(|k| k.id != b64u(&alice2.id)));
    assert!(inner.book.people[ALICE].has_password());
    drop(inner);
    assert_eq!(*b.fake.installed.lock(), vec!["lic:l_1:renew".to_owned()]);
}

// ── Sessions ────────────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn sessions_are_capped_listed_ended_and_bound_to_their_origin() {
    let b = build("sessions");
    let c = &b.c;
    let mut a = Authenticator::new(5);
    let first = enrol_first(c, &mut a, T0);
    let mut sids = vec![first.clone()];
    for i in 1..=5 {
        sids.push(login(c, &mut a, T0 + i));
    }
    // A sixth session ends the oldest.
    assert_eq!(send(c, get("/console/api/me", &first), T0 + 10).status, 200);
    assert!(json_of(&send(c, get("/console/api/me", &first), T0 + 10))["user"].is_null());
    let list = json_of(&send(c, get("/console/api/sessions", &sids[5]), T0 + 11));
    assert_eq!(list["sessions"].as_array().unwrap().len(), 5);
    let row = list["sessions"].as_array().unwrap().iter().find(|s| s["current"] == false).unwrap().clone();
    assert_eq!(row["agent"], "test agent");
    assert_eq!(row["ip"], "192.0.2.7");
    // End one of my own by its hint.
    let ended = row["id_hint"].as_str().unwrap().to_owned();
    let r = send(c, call("POST", "/console/api/sessions/end", json!({ "id_hint": ended }), &sids[5]), T0 + 12);
    assert_eq!((r.status, json_of(&r)["ended"].as_i64()), (200, Some(1)));
    let r = send(c, call("POST", "/console/api/sessions/end", json!({ "id_hint": "zzzzzzzz" }), &sids[5]), T0 + 13);
    assert_eq!(code(&r), "not-found");
    // A session presented at another origin is refused and ended (here: one another console's page made).
    let other = sids[1..5].iter().map(|s| sid_hash(s)).find(|h| !h.starts_with(&ended) && c.inner.lock().sessions.contains_key(h)).unwrap();
    let sid_other = sids[1..5].iter().find(|s| sid_hash(s) == other).unwrap().clone();
    c.inner.lock().sessions.get_mut(&other).unwrap().origin = "https://other.example".into();
    let r = send(c, get("/console/api/overview", &sid_other), T0 + 14);
    assert_eq!((r.status, code(&r).as_str()), (409, "origin-session"));
    assert!(!c.inner.lock().sessions.contains_key(&other));
    // Sign out everywhere (a security action).
    let r = post_su(c, &sids[5], &mut a, "/console/api/sessions/end-all", "sessions.end-all", ALICE, json!({ "email": ALICE }), T0 + 15);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    assert!(c.inner.lock().sessions.is_empty());
}

#[test]
fn post_routes_are_limited_per_session() {
    let b = build("postlimit");
    let c = &b.c;
    let mut a = Authenticator::new(5);
    let sid = enrol_first(c, &mut a, T0);
    for i in 0..60 {
        let r = send(c, call("POST", "/console/api/passkeys/rename", json!({ "hint": "x", "label": "y" }), &sid), T0 + i);
        assert_eq!(r.status, 404, "{i}");
    }
    let r = send(c, call("POST", "/console/api/passkeys/rename", json!({ "hint": "x", "label": "y" }), &sid), T0 + 100);
    assert_eq!((r.status, code(&r).as_str()), (429, "rate"));
    assert_eq!(header(&r, "Retry-After"), Some("60"));
    assert_eq!(json_of(&r)["error"], "Too many requests. Try again in 1 minute.");
}

// ── Rate limits (3.9) ───────────────────────────────────────────────────────────────────────────────────────

#[test]
fn every_core_rate_limit_answers_429_with_retry_after() {
    let b = build("rates");
    let c = &b.c;
    let mut a = Authenticator::new(5);
    let sid = enrol_first(c, &mut a, T0);
    let limited = |r: &ConsoleReply, what: &str| {
        assert_eq!(r.status, 429, "{what}: {}", text_of(r));
        assert!(header(r, "Retry-After").is_some_and(|s| s.parse::<i64>().is_ok_and(|n| n >= 1)), "{what}: no Retry-After");
    };
    // Any API request: 600 a minute per session.
    let t = T0 + MIN;
    let s_api = login(c, &mut a, t);
    for i in 0..600 {
        assert_eq!(send(c, get("/console/api/me", &s_api), t + i).status, 200, "{i}");
    }
    limited(&send(c, get("/console/api/me", &s_api), t + 700), "api");
    // Search: 60 a minute per session.
    let s_search = login(c, &mut a, t);
    for i in 0..60 {
        assert_eq!(send(c, get("/console/api/search?q=al", &s_search), t + i).status, 200, "{i}");
    }
    limited(&send(c, get("/console/api/search?q=al", &s_search), t + 100), "search");
    // stepup/begin: 20 a minute per session.
    let s_step = login(c, &mut a, t);
    let params = json!({ "links": [] });
    for i in 0..20 {
        stepup_begin(c, &s_step, "settings.links", "-", &params, t + i);
    }
    let r = send(c, call("POST", "/console/api/stepup/begin", json!({ "action": "settings.links", "target": "-", "params": params }), &s_step), t + 30);
    limited(&r, "stepup");
    // recover/begin: 10 an hour per source.
    for i in 0..10 {
        assert_eq!(send_from(c, "/console/api/recover/begin", json!({ "email": "x@acme.example" }), "", "198.51.100.200", t + i).status, 200);
    }
    limited(&send_from(c, "/console/api/recover/begin", json!({ "email": "x@acme.example" }), "", "198.51.100.200", t + 20), "recover/begin");
    // Invites: 10 a day per admin.
    let t = T0 + 2 * MIN;
    for i in 0..10 {
        let email = format!("i{i}@acme.example");
        let r = post_su(c, &sid, &mut a, "/console/api/admins/invite", "admins.invite", &email, json!({ "email": email, "role": "viewer" }), t + i * 4_000);
        assert_eq!(r.status, 200, "{}", text_of(&r));
    }
    let r = post_su(c, &sid, &mut a, "/console/api/admins/invite", "admins.invite", "i10@acme.example", json!({ "email": "i10@acme.example", "role": "viewer" }), t + 44_000);
    assert_eq!(code(&r), "invite-limit");
    limited(&r, "invites");
    // Test emails: 5 an hour per admin.
    mail_on(c);
    let t = T0 + 4 * MIN;
    for i in 0..5 {
        assert_eq!(send(c, call("POST", "/console/api/settings/email/test", json!({}), &sid), t + i * 1_000).status, 200);
    }
    limited(&send(c, call("POST", "/console/api/settings/email/test", json!({}), &sid), t + 6_000), "email-test");
    // Requests: 30 an hour per admin.
    let t = T0 + 5 * MIN;
    for i in 0..30 {
        let body = json!({ "kind": "rs.revoke", "target": { "node": format!("n_{i:032x}") }, "reason": "Stolen" });
        assert_eq!(send(c, call("POST", "/console/api/requests/new", body, &sid), t + i * 1_500).status, 200);
    }
    let body = json!({ "kind": "rs.revoke", "target": { "node": "n_ffffffffffffffffffffffffffffffff" }, "reason": "Stolen" });
    limited(&send(c, call("POST", "/console/api/requests/new", body, &sid), t + 46_000), "requests");
    // Approvals: 5 waiting per requester.
    two_person(c, true);
    add_person(c, &Authenticator::new(6), BOB, PersonRole::Admin, SECOND_HUB);
    let t = T0 + 7 * MIN;
    for i in 0..5 {
        let body = json!({ "aaguids": [format!("{:08x}-1111-1111-1111-111111111111", i)], "reason": "Keys" });
        let r = post_su(c, &sid, &mut a, "/console/api/settings/aaguids", "settings.aaguids", "-", body, t + i * 4_000);
        assert_eq!(json_of(&r)["approval"]["state"], "waiting", "{}", text_of(&r));
    }
    let body = json!({ "aaguids": ["ffffffff-1111-1111-1111-111111111111"], "reason": "Keys" });
    limited(&post_su(c, &sid, &mut a, "/console/api/settings/aaguids", "settings.aaguids", "-", body, t + 24_000), "approvals");
    two_person(c, false);
    // Ending someone else's sessions: 10 an hour per admin.
    let t = T0 + 9 * MIN;
    for i in 0..10 {
        let r = post_su(c, &sid, &mut a, "/console/api/sessions/end-all", "sessions.end-all", BOB, json!({ "email": BOB }), t + i * 4_000);
        assert_eq!(r.status, 200, "{}", text_of(&r));
    }
    limited(&post_su(c, &sid, &mut a, "/console/api/sessions/end-all", "sessions.end-all", BOB, json!({ "email": BOB }), t + 44_000), "end-all");
    // Exports: 10 an hour per admin.
    let t = T0 + 11 * MIN;
    let body = json!({ "source": "relay", "cat": "all", "level": "debug" });
    for i in 0..10 {
        let r = post_su(c, &sid, &mut a, "/console/api/logs/export", "logs.export", "relay", body.clone(), t + i * 4_000);
        assert_eq!(r.status, 200, "{}", text_of(&r));
    }
    limited(&post_su(c, &sid, &mut a, "/console/api/logs/export", "logs.export", "relay", body, t + 44_000), "exports");
}

// ── License (4.7) ───────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn license_installs_by_one_admin_only_for_a_renewal() {
    let b = build("license");
    let c = &b.c;
    two_person(c, true);
    let mut a = Authenticator::new(5);
    let sid = enrol_first(c, &mut a, T0);
    let bob = Authenticator::new(6);
    add_person(c, &bob, BOB, PersonRole::Admin, SECOND_HUB);
    let install = |token: &str, id: &str, t: i64, a: &mut Authenticator| post_su(c, &sid, a, "/console/api/license/install", "license.install", id, json!({ "license": token, "reason": "Renewal" }), t);
    // A token past its grace days: refused.
    let r = install("lic:l_1:ended", "l_1", T0 + 1, &mut a);
    assert_eq!((r.status, code(&r).as_str()), (400, "license-ended"));
    let r = install("lic:l_1:renew", "l_1", T0 + 2, &mut a);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    assert_eq!(*b.fake.installed.lock(), vec!["lic:l_1:renew".to_owned()]);
    // A new id (or an earlier end, fewer users or relays, a token in grace): an approval.
    let r = install("lic:l_2:change", "l_2", T0 + 3, &mut a);
    assert_eq!(json_of(&r)["approval"]["state"], "waiting", "{}", text_of(&r));
    assert_eq!(b.fake.installed.lock().len(), 1);
    // The step-up is bound to the token's license id.
    let r = install("lic:l_3:renew", "l_9", T0 + 4, &mut a);
    assert_eq!(code(&r), "stepup-failed");
    // No license token in any audit entry, only its id.
    assert!(entries(c).iter().all(|e| !stringify(&Value::Object(e.clone())).contains("lic:")));
}

#[test]
fn product_writes_follow_the_license_state_and_security_actions_never_do() {
    let b = build("productlicense");
    let c = &b.c;
    let mut a = Authenticator::new(5);
    let sid = enrol_first(c, &mut a, T0);
    *b.fake.lic.lock() = LicenseState::Expired;
    let r = post_su(c, &sid, &mut a, "/console/api/fake/widen", "fake.widen", "n_1", json!({ "node": "n_1", "reason": "x" }), T0 + 1);
    assert_eq!((r.status, code(&r).as_str()), (402, "license-expired"));
    *b.fake.lic.lock() = LicenseState::None;
    let r = post_su(c, &sid, &mut a, "/console/api/fake/widen", "fake.widen", "n_1", json!({ "node": "n_1", "reason": "x" }), T0 + 2);
    assert_eq!((r.status, json_of(&r)["error"].as_str()), (402, Some("This needs a license that includes Remote Spokes.")));
    let r = post_su(c, &sid, &mut a, "/console/api/fake/block", "fake.block", "n_1", json!({ "node": "n_1", "reason": "x" }), T0 + 3);
    assert_eq!(r.status, 200);
    let me = json_of(&send(c, get("/console/api/me", &sid), T0 + 4));
    assert_eq!((me["locked"].as_bool(), me["sections"].clone()), (Some(true), json!(["overview", "security", "spokes", "approvals", "admins"])));
    assert_eq!(me["securityActions"], json!(["fake.block"]));
    // A product's second-admin write runs at once for a lone admin (two-person control off), as the requester.
    *b.fake.lic.lock() = LicenseState::Valid;
    let r = post_su(c, &sid, &mut a, "/console/api/fake/widen", "fake.widen", "n_1", json!({ "node": "n_1", "reason": "x" }), T0 + 5);
    assert_eq!(r.status, 200);
    assert_eq!(*b.fake.ran.lock(), vec![format!("fake.widen n_1 as {ALICE}")]);
}

#[test]
fn one_admin_installs_only_a_first_license_or_a_renewal_of_the_reference_license() {
    let reference = LicenseRecord { product: Product::Meet, root: "m_root".into(), id: "l_1".into(), edition: "standard".into(), users: 100, relays: 1, exp: 1000 };
    let renewal = LicenseRecord { exp: 2000, ..reference.clone() };
    // No reference license (Remote Spokes with no current license, Meeting Hub with no lastLicense): a first license.
    assert!(one_admin_install(None, &renewal, true));
    assert!(one_admin_install(Some(&reference), &renewal, true));
    // A reference license that is only lastLicense (R6-M1) is compared the same way: a smaller one needs a second admin.
    assert!(!one_admin_install(Some(&reference), &LicenseRecord { users: 1, ..renewal.clone() }, true));
    assert!(!one_admin_install(Some(&reference), &renewal, false), "a token in grace");
    assert!(!one_admin_install(Some(&reference), &LicenseRecord { id: "l_2".into(), ..renewal.clone() }, true));
    assert!(!one_admin_install(Some(&reference), &LicenseRecord { exp: 900, ..reference.clone() }, true));
    assert!(!one_admin_install(Some(&reference), &LicenseRecord { relays: 0, ..renewal.clone() }, true));
    assert!(!one_admin_install(Some(&reference), &LicenseRecord { edition: "enterprise".into(), ..renewal.clone() }, true));
    assert!(!one_admin_install(Some(&reference), &LicenseRecord { root: "m_other".into(), ..renewal.clone() }, true));
    assert!(!one_admin_install(Some(&reference), &LicenseRecord { product: Product::Spokes, ..renewal }, true));
}

// ── License service and reminders (2.4, 4.7, R42-1, R42-3, R7-L2) ─────────────────────────────────────────────

const DAY_MS: i64 = 86_400_000;

/// A service on license `l_1` ending at `exp`, judged at `at`, as the section reports it.
fn svc(state: ServiceState, exp: i64, at: i64) -> ServiceView {
    let stops_at = (state == ServiceState::Grace).then_some(exp + 2 * DAY_MS);
    let why = (state == ServiceState::Stopped).then_some("expired");
    ServiceView { state, stops_at, why, reason: None, upgrade_period_ends: None, license_id: Some("l_1".into()), exp: Some(exp), at }
}

fn reminder_kinds(c: &Console) -> Vec<String> {
    entries(c).into_iter().filter(|e| e["action"] == "license.reminder").map(|e| e["detail"]["kind"].as_str().unwrap().to_owned()).collect()
}

#[test]
fn reminders_go_to_every_active_admin_once_per_step_and_survive_a_restart() {
    let dir = temp_dir("reminders");
    let exp = T0 + 40 * DAY_MS;
    let b = build_in(dir.clone(), Some(ALICE), "0.0.0.0/0,::/0", "", false).unwrap();
    let c = &b.c;
    let mut a = Authenticator::new(5);
    enrol_first(c, &mut a, T0);
    mail_on(c);
    let steps = [
        (ServiceState::On, exp - 30 * DAY_MS, Some("days-30")),
        (ServiceState::On, exp - 29 * DAY_MS, None),
        (ServiceState::On, exp - 7 * DAY_MS, Some("days-7")),
    ];
    for (state, at, want) in steps {
        let before = reminder_kinds(c).len();
        c.license_check_with(&svc(state, exp, at));
        assert_eq!(reminder_kinds(c).len(), before + usize::from(want.is_some()), "{at}");
    }
    let mails = c.mailer.captured();
    assert_eq!(mails.iter().filter(|m| m.0 == "mail.license-expiring" && m.1 == ALICE).count(), 2);
    assert!(mails.iter().all(|m| !m.2.iter().any(|(_, v)| v.contains("lic:") || v.contains("eyJ"))), "no mail holds a license token");
    assert_eq!(last_entry(c, "license.reminder")["detail"]["mailed"], 1);
    // a restart between two moments (on the same license) neither repeats nor skips one
    drop(b);
    let b = open_serving(dir.clone(), Some(ALICE), "0.0.0.0/0,::/0", "", false, None, Some(svc(ServiceState::On, exp, 0))).unwrap();
    let c = &b.c;
    mail_on(c);
    c.license_check_with(&svc(ServiceState::On, exp, exp - 6 * DAY_MS));
    assert!(c.mailer.captured().is_empty(), "the 7-day step is not sent again: {:?}", c.mailer.captured());
    c.license_check_with(&svc(ServiceState::On, exp, exp - 3 * DAY_MS));
    c.license_check_with(&svc(ServiceState::Grace, exp, exp));
    c.license_check_with(&svc(ServiceState::Grace, exp, exp + 12 * 3_600_000));
    c.license_check_with(&svc(ServiceState::Stopped, exp, exp + 2 * DAY_MS));
    c.license_check_with(&svc(ServiceState::Stopped, exp, exp + 3 * DAY_MS));
    let kinds: Vec<String> = c.mailer.captured().into_iter().map(|m| m.0).collect();
    assert_eq!(kinds, ["mail.license-expiring", "mail.license-grace", "mail.license-grace", "mail.license-stopped"]);
    // each change of the service state is audited
    let services: Vec<String> = entries(c).into_iter().filter(|e| e["action"] == "license.service").map(|e| e["detail"]["state"].as_str().unwrap().to_owned()).collect();
    assert_eq!(services, ["grace", "stopped"]);
    // a new license id starts a new schedule
    let mut renewed = svc(ServiceState::On, exp + 400 * DAY_MS, exp + 3 * DAY_MS);
    renewed.license_id = Some("l_2".into());
    c.license_check_with(&renewed);
    renewed.at = exp + 371 * DAY_MS;
    c.license_check_with(&renewed);
    assert_eq!(c.mailer.captured().last().unwrap().0, "mail.license-expiring");
}

#[test]
fn an_unreadable_reminder_record_replays_nothing_and_banners_still_show() {
    let dir = temp_dir("reminders-bad");
    let exp = T0 + 40 * DAY_MS;
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(crate::license_reminders::FILE), b"{torn").unwrap();
    let b = build_in(dir.clone(), Some(ALICE), "0.0.0.0/0,::/0", "", false).unwrap();
    let c = &b.c;
    let mut a = Authenticator::new(5);
    let sid = enrol_first(c, &mut a, T0);
    mail_on(c);
    // the file was read at attach (now) or is read now: either way no past step is mailed
    *c.reminders.lock() = None;
    std::fs::write(dir.join(crate::license_reminders::FILE), b"{torn").unwrap();
    c.license_check_with(&svc(ServiceState::Grace, exp, exp + 13 * 3_600_000));
    assert!(c.mailer.captured().is_empty(), "past steps are marked sent without mail");
    assert!(lines_of(&b.log).iter().any(|l| l.contains("license.reminders-unreadable")));
    // the next step still goes out, and service never depended on the file
    c.license_check_with(&svc(ServiceState::Grace, exp, exp + 24 * 3_600_000));
    assert_eq!(c.mailer.captured().len(), 1);
    // with email off the banner and item still show
    c.mailer.configure(MailConfig::off());
    *b.fake.service.lock() = Some(svc(ServiceState::Grace, exp, 0));
    let v = json_of(&send(c, get("/console/api/overview", &sid), T0 + 1));
    assert!(v["attention"].as_array().unwrap().iter().any(|x| x["kind"] == "license-grace"));
    assert!(v["banners"].as_array().unwrap().iter().any(|x| x["id"] == "banner.grace"));
}

#[test]
fn fleet_license_items_render_for_the_attention_mail() {
    // AC-2a 13.1 words, filled as mail.attention fills them; times given in ms read as UTC.
    let at = crate::meet_json::days_from_civil(2026, 11, 18) * DAY_MS + 10 * 3_600_000;
    assert_eq!(attention_words("relay-license-stopped", &json!({ "relay": "Berlin", "why": "expired" })).as_deref(), Some("Berlin stopped: no active license. It serves no one until a license is installed."));
    assert_eq!(
        attention_words("relay-license-grace", &json!({ "relay": "Berlin", "date and time": at })).as_deref(),
        Some("The license of Berlin has ended. Service stops on 2026-11-18 10:00 UTC unless a new license is installed.")
    );
    assert_eq!(attention_words("relay-license-expiring", &json!({ "relay": "Berlin", "days": 7 })).as_deref(), Some("The license of Berlin ends in 7 days."));
    let mail = crate::console_mail::render("mail.attention", RP, "https://relay.example.com/console/", &[("attention words", attention_words("relay-license-stopped", &json!({ "relay": "Berlin" })).unwrap()), ("go", "#/licenses".into())]);
    assert!(mail.is_some_and(|(_, body)| body.starts_with("Berlin stopped: no active license.")));
}

#[test]
fn the_license_view_answers_service_in_each_state_and_a_stop_is_blocking() {
    let b = build("license-service");
    let c = &b.c;
    let mut a = Authenticator::new(5);
    let sid = enrol_first(c, &mut a, T0);
    let exp = T0 + 5 * DAY_MS;
    for (state, want, why) in [(ServiceState::On, "on", None), (ServiceState::Grace, "grace", None), (ServiceState::Stopped, "stopped", Some("expired"))] {
        *b.fake.service.lock() = Some(svc(state, exp, 0));
        let v = json_of(&send(c, get("/console/api/license", &sid), T0 + 1));
        assert_eq!(v["service"]["state"], want);
        assert_eq!(v["service"]["why"].as_str(), why);
        assert!(v.get("adding").is_none(), "no growth gate (R42-1)");
        if state == ServiceState::Grace {
            assert_eq!(v["service"]["stopsAt"], exp + 2 * DAY_MS);
        }
    }
    let v = json_of(&send(c, get("/console/api/overview", &sid), T0 + 2));
    let banner = v["banners"].as_array().unwrap().iter().find(|x| x["id"] == "banner.license-stopped").cloned().expect("the stop banner");
    assert_eq!(banner["args"]["why"], "expired");
    assert!(v["attention"][0]["blocking"].as_bool().unwrap_or(false) || v["attention"].as_array().unwrap().iter().any(|x| x["kind"] == "license-stopped"));
    // installing a fitting license turns service on at once: the section reports on and the stop item is gone
    *b.fake.service.lock() = None;
    *b.fake.lic.lock() = LicenseState::Valid;
    assert!(!attention_kinds(c, &sid, T0 + 3).iter().any(|k| k == "license-stopped"));
}

// ── Overview and viewers (7.3) ──────────────────────────────────────────────────────────────────────────────

#[test]
fn viewers_see_no_people_approvals_or_requests() {
    let b = build("viewers");
    let c = &b.c;
    let mut a = Authenticator::new(5);
    let sid = enrol_first(c, &mut a, T0);
    let mut vic = Authenticator::new(6);
    add_person(c, &vic, VIC, PersonRole::Viewer, CONSOLE_ANCHOR);
    let sid_v = login(c, &mut vic, T0);
    let ov = json_of(&send(c, get("/console/api/overview", &sid_v), T0 + 1));
    assert!(ov.get("approvals").is_none() && ov.get("requests").is_none() && ov.get("links").is_none());
    let kinds: Vec<&str> = ov["attention"].as_array().unwrap().iter().map(|a| a["kind"].as_str().unwrap()).collect();
    assert_eq!(kinds, vec!["spokes-silent"]);
    let ov = json_of(&send(c, get("/console/api/overview", &sid), T0 + 2));
    let kinds: Vec<&str> = ov["attention"].as_array().unwrap().iter().map(|a| a["kind"].as_str().unwrap()).collect();
    assert!(kinds.contains(&"admins-few") && kinds.contains(&"uncounted") && kinds.contains(&"anchor-single"));
    // A console that started in Standard never shows profile-standard (R41-3).
    assert!(!kinds.contains(&"profile-standard"));
    assert_eq!(ov["cards"][0]["id"], "health");
    // Viewers' sessions list only their own; search gives them no people.
    let s = json_of(&send(c, get("/console/api/sessions", &sid_v), T0 + 3));
    assert!(s["sessions"].as_array().unwrap().iter().all(|r| r["email"] == VIC));
    let s = json_of(&send(c, get("/console/api/search?q=acme", &sid_v), T0 + 4));
    assert_eq!(s["hits"], json!([]));
    let s = json_of(&send(c, get("/console/api/search?q=alice", &sid), T0 + 4));
    assert_eq!(s["hits"][0]["id"], ALICE);
}

// ── Audit (6) ───────────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn signed_in_refusals_are_appended_and_summarized() {
    let b = build("refusals");
    let c = &b.c;
    let mut a = Authenticator::new(5);
    let sid = enrol_first(c, &mut a, 60_000 * 30_000_000);
    let t = 60_000 * 30_000_000 + 1000;
    let before = entries(c).len();
    let r = send(c, call("POST", "/console/api/settings/links", json!({ "links": [] }), &sid), t);
    assert_eq!(r.status, 401);
    let e = entries(c).last().cloned().unwrap();
    assert_eq!((e["action"].as_str(), e["result"].as_str(), e["detail"]["code"].as_str(), e["actor"].as_str()), (Some("settings.links"), Some("refused"), Some("stepup-needed"), Some(ALICE)));
    // Past 60 a minute (and GET refusals): one summary for the person.
    for i in 0..59 {
        send(c, call("POST", "/console/api/settings/links", json!({ "links": [] }), &sid), t + i);
    }
    let own = entries(c).len() - before;
    assert_eq!(own, 60);
    for i in 0..5 {
        send(c, call("POST", "/console/api/settings/links", json!({ "links": [] }), &sid), t + 100 + i);
    }
    assert_eq!(entries(c).len() - before, 60);
    // The next minute brings the summary (written before the next entry).
    send(c, call("POST", "/console/api/settings/links", json!({ "links": [] }), &sid), t + MIN);
    let s = entries(c).into_iter().find(|e| e["action"] == "refusals.summary" && e["actor"] == ALICE).unwrap();
    assert_eq!(s["detail"]["count"], 5);
    // Every shipped console.audit line carries seq and hash.
    let shipped: Vec<String> = lines_of(&b.log).into_iter().filter(|l| l.contains("\"event\":\"console.audit\"")).collect();
    assert!(!shipped.is_empty() && shipped.iter().all(|l| l.contains("\"seq\":") && l.contains("\"hash\":\"")));
}

#[test]
fn refusals_from_outside_add_one_entry_a_minute_in_all() {
    let b = build_in(temp_dir("outside"), Some(ALICE), "10.0.0.0/8", "", false).unwrap();
    let c = &b.c;
    c.invite(ALICE, HUB_NODE, HUB_SERIAL, &dialed(HOST), 0).unwrap();
    let t = 60_000 * 30_000_000;
    let before = entries(c).len();
    for i in 0..10_000u32 {
        let peer = format!("203.0.{}.{}", i / 256, i % 256);
        let mut k = get("/console/api/me", "");
        k.peer = &peer;
        assert_eq!(send(c, k, t + i64::from(i % 50_000)).status, 403);
        // A failed sign-in from inside the list.
        let peer2 = format!("10.{}.{}.1", i / 256, i % 256);
        let mut k = call("POST", "/console/api/login/finish", json!({ "ceremony": "x", "credential": {} }), "");
        k.peer = &peer2;
        assert_eq!(send(c, k, t + i64::from(i % 50_000)).status, 403);
    }
    assert_eq!(entries(c).len(), before);
    // The minute is over: one global summary, its sources counted, no address in it.
    let mut k = get("/console/api/me", "");
    k.peer = "203.0.113.200";
    send(c, k, t + MIN);
    let added: Vec<Map<String, Value>> = entries(c).into_iter().skip(before).collect();
    assert_eq!(added.len(), 1);
    assert_eq!((added[0]["actor"].as_str(), added[0]["action"].as_str()), (Some("relay"), Some("refusals.summary")));
    assert_eq!(added[0]["detail"]["count"], 20_000);
    assert_eq!(added[0]["detail"]["sources"], 20_000);
    let text = stringify(&Value::Object(added[0].clone()));
    assert!(!text.contains("203.0.") && !text.contains("10.0."));
}

#[test]
fn a_broken_audit_pauses_ordinary_writes_but_not_security_actions() {
    let b = build("broken");
    let mut a = Authenticator::new(5);
    let sid = enrol_first(&b.c, &mut a, T0);
    drop(sid);
    let dir = b.dir.clone();
    drop(b);
    // A torn last line.
    let seg = dir.join("console-audit-000001.jsonl");
    let text = std::fs::read_to_string(&seg).unwrap();
    std::fs::write(&seg, &text[..text.len() - 20]).unwrap();
    let b = build_in(dir.clone(), None, "0.0.0.0/0", "", false).unwrap();
    let c = &b.c;
    assert!(lines_of(&b.log).iter().any(|l| l.contains("\"event\":\"console.audit-broken\"")));
    a.count = 100;
    let sid = login(c, &mut a, T0 + 1);
    let ov = json_of(&send(c, get("/console/api/overview", &sid), T0 + 2));
    assert!(ov["attention"].as_array().unwrap().iter().any(|x| x["kind"] == "audit-broken"));
    let links = json!({ "links": [] });
    let r = post_su(c, &sid, &mut a, "/console/api/settings/links", "settings.links", "-", links.clone(), T0 + 3);
    assert_eq!((r.status, code(&r).as_str()), (503, "audit-broken"));
    // A security action goes through, its entry marked after_torn.
    let r = post_su(c, &sid, &mut a, "/console/api/fake/block", "fake.block", "n_1", json!({ "node": "n_1", "reason": "x" }), T0 + 4);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    let e = last_entry(c, "fake.block");
    assert_eq!(e["detail"]["after_torn"], true);
    // Start a new chain; ordinary writes work again.
    let r = post_su(c, &sid, &mut a, "/console/api/audit/restart", "audit.restart", "-", json!({}), T0 + 5);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    assert_eq!(json_of(&r)["entry"]["detail"]["torn_lines"], 1);
    assert_eq!(post_su(c, &sid, &mut a, "/console/api/settings/links", "settings.links", "-", links, T0 + 6).status, 200);
    let v = json_of(&send(c, get("/console/api/audit/verify", &sid), T0 + 7));
    assert_eq!(v["verified"], true);
}

#[test]
fn the_audit_exports_with_step_up_and_moves_exported_through() {
    let b = build("export");
    let c = &b.c;
    let mut a = Authenticator::new(5);
    let sid = enrol_first(c, &mut a, T0);
    let head = json_of(&send(c, get("/console/api/audit", &sid), T0 + 1))["head"]["seq"].as_u64().unwrap();
    let r = post_su(c, &sid, &mut a, "/console/api/audit/export", "audit.export", &format!("1-{head}"), json!({ "from": 1, "to": head }), T0 + 2);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    assert_eq!(r.content_type, "application/x-ndjson");
    assert_eq!(header(&r, "Content-Disposition").unwrap(), format!("attachment; filename=\"lucid-console-audit-relay.example.com-1-{head}.jsonl\""));
    assert_eq!(String::from_utf8_lossy(&r.body).lines().count() as u64, head);
    let v = json_of(&send(c, get("/console/api/audit", &sid), T0 + 3));
    assert_eq!(v["exportedThrough"], head);
    // A step-up for another range is refused.
    let su = stepup(c, &sid, &mut a, "audit.export", "1-2", &json!({ "from": 1, "to": 2 }), T0 + 4);
    let r = send(c, call("POST", "/console/api/audit/export", json!({ "from": 1, "to": 3, "stepup": su }), &sid), T0 + 4);
    assert_eq!(r.status, 403);
}

/// The detail keys an entry must carry.
fn has_detail(e: &Map<String, Value>, keys: &[&str]) {
    let d = e.get("detail").and_then(Value::as_object).unwrap_or_else(|| panic!("{} has no detail object", e["action"]));
    for k in keys {
        assert!(d.contains_key(*k), "{} lacks detail.{k}: {d:?}", e["action"]);
    }
}

#[test]
fn every_revision_4_event_is_appended_with_its_keys() {
    let b = build("events");
    let c = &b.c;
    let mut a = Authenticator::new(5);
    enrol_first(c, &mut a, T0);
    c.mailer.capture();
    let sid = login(c, &mut a, T0 + 1);
    // Every entry has exactly the 6 keys.
    let keys = ["seq", "ts", "actor", "role", "ip", "action", "target", "result", "approval", "stepup", "detail", "prev", "hash"];
    let e = last_entry(c, "signin.ok");
    let mut got: Vec<&str> = e.keys().map(String::as_str).collect();
    got.sort_unstable();
    let mut want = keys.to_vec();
    want.sort_unstable();
    assert_eq!(got, want);
    has_detail(&e, &["methods", "rights", "profile", "banner", "breakGlass"]);
    assert_eq!(e["actor"], ALICE);
    let step = |path: &str, action: &str, target: &str, body: Value, a: &mut Authenticator, t: i64| -> (u16, Value) {
        let r = post_su(c, &sid, a, &format!("/console/api/{path}"), action, target, body, t);
        (r.status, json_of(&r))
    };
    assert_eq!(step("account/password", "account.password", "-", json!({ "current": "", "password": PW }), &mut a, T0 + 5_000).0, 200);
    has_detail(&last_entry(c, "account.password"), &["changed", "anchor"]);
    let (status, v) = step("account/totp/begin", "account.totp", "-", json!({}), &mut a, T0 + 10_000);
    assert_eq!(status, 200, "{v}");
    let secret = unbase32(v["secret"].as_str().unwrap());
    let tt = T0 + 10 * MIN;
    let r = send(c, call("POST", "/console/api/account/totp/finish", json!({ "enrollment": v["enrollment"], "code": code_at(&secret, tt) }), &sid), tt);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    has_detail(&last_entry(c, "account.totp"), &["anchor"]);
    let mut key = Authenticator::new(30);
    let r = add_method(c, &sid, &mut a, "account/security-key", "account.security-key", &mut key, false, tt + 1);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    has_detail(&last_entry(c, "account.security-key"), &["credential_hint", "anchor", "kind", "state", "aaguid"]);
    let r = send(c, call("POST", "/console/api/account/mail", json!({ "kinds": ["mail-failing"] }), &sid), tt + 2);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    assert_eq!(last_entry(c, "account.mail")["detail"]["kinds"], json!(["mail-failing"]));
    let r = post_su(c, &sid, &mut a, "/console/api/account/totp/remove", "account.totp-remove", "-", json!({}), tt + 3);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    last_entry(c, "account.totp-remove");
    let mut at = tt + 10;
    let mut next = || {
        at += 5_000;
        at
    };
    assert_eq!(step("settings/sign-in", "settings.sign-in", "-", json!({ "requirePassword": false, "idleMinutes": 10, "maxHours": 12, "reason": "Shorter" }), &mut a, next()).0, 200);
    has_detail(&last_entry(c, "settings.sign-in"), &["requirePassword", "idleMinutes", "maxHours", "reason"]);
    assert_eq!(step("settings/banner", "settings.banner", "-", json!({ "text": "Notice" }), &mut a, next()).0, 200);
    assert_eq!(last_entry(c, "settings.banner")["detail"]["characters"], 6);
    assert_eq!(step("settings/banner", "settings.banner", "-", json!({ "text": "" }), &mut a, next()).0, 200);
    assert_eq!(step("settings/aaguids", "settings.aaguids", "-", json!({ "aaguids": [aaguid_text()], "reason": "Keys" }), &mut a, next()).0, 200);
    has_detail(&last_entry(c, "settings.aaguids"), &["aaguids", "reason"]);
    assert_eq!(step("settings/mds", "settings.mds", "-", json!({ "blob": "junk" }), &mut a, next()).0, 400);
    let e = last_entry(c, "settings.mds");
    assert_eq!((e["result"].as_str(), e["detail"]["code"].as_str()), (Some("refused"), Some("mds-refused")));
    assert_eq!(step("settings/email", "settings.email", "-", smtp_body("smtp.acme.example", true), &mut a, next()).0, 200);
    let e = last_entry(c, "settings.email");
    has_detail(&e, &["changed", "reason", "verified"]);
    assert!(!stringify(&Value::Object(e)).contains("Smtp-Secret-7781"));
    let r = send(c, call("POST", "/console/api/settings/email/test", json!({}), &sid), next());
    assert_eq!(r.status, 200, "{}", text_of(&r));
    has_detail(&last_entry(c, "settings.email-test"), &["sent"]);
    assert_eq!(step("settings/license-request-to", "settings.license-request-to", "-", json!({ "address": "seats@acme.example" }), &mut a, next()).0, 200);
    assert_eq!(last_entry(c, "settings.license-request-to")["detail"]["address"], "seats@acme.example");
    assert_eq!(step("settings/two-person", "settings.two-person", "-", json!({ "twoPerson": "on", "reason": "Policy" }), &mut a, next()).0, 200);
    has_detail(&last_entry(c, "settings.two-person"), &["twoPerson", "reason"]);
    two_person(c, false);
    // invites.resend and admins.reset-sign-in.
    assert_eq!(step("admins/invite", "admins.invite", "v9@acme.example", json!({ "email": "v9@acme.example", "role": "viewer" }), &mut a, next()).0, 200);
    assert_eq!(step("invites/resend", "invites.resend", "v9@acme.example", json!({ "email": "v9@acme.example" }), &mut a, next()).0, 200);
    has_detail(&last_entry(c, "invites.resend"), &["role", "mailed"]);
    add_person(c, &Authenticator::new(7), VIC, PersonRole::Viewer, CONSOLE_ANCHOR);
    assert_eq!(step("admins/reset-sign-in", "admins.reset-sign-in", VIC, json!({ "email": VIC, "reason": "Lost" }), &mut a, next()).0, 200);
    has_detail(&last_entry(c, "admins.reset-sign-in"), &["reason", "role"]);
    // recover.done and signin.locked.
    add_person(c, &Authenticator::new(9), WES, PersonRole::Viewer, CONSOLE_ANCHOR);
    set_password(c, WES, PW, CONSOLE_ANCHOR);
    send_from(c, "/console/api/recover/begin", json!({ "email": WES }), "", "198.51.100.110", next());
    let link = mailed(c, "mail.reset-password").first().map(|(_, args)| arg(args, "link").to_owned()).unwrap();
    let token = link.split_once("#reset=").unwrap().1.to_owned();
    assert_eq!(send(c, call("POST", "/console/api/recover/finish", json!({ "token": token, "password": "Qz7!mR2#vK9@" }), ""), next()).status, 200);
    assert_eq!(last_entry(c, "recover.done")["actor"], WES);
    for _ in 0..10 {
        let t = next();
        let v = json_of(&send_from(c, "/console/api/login/begin", json!({ "email": WES }), "", "198.51.100.111", t));
        send_from(c, "/console/api/login/password", json!({ "ceremony": v["ceremony"], "password": "Not-the-password-1" }), "", "198.51.100.111", t);
    }
    let e = last_entry(c, "signin.locked");
    assert_eq!((e["actor"].as_str(), e["target"].as_str()), (Some("relay"), Some(WES)));
    // settings.profile (mail off first: under High a mail secret needs a compliant seal provider), then the operator's
    // break-glass.create and two-person.off at the next start.
    assert_eq!(step("settings/email", "settings.email", "-", json!({ "mode": "off", "reason": "Off" }), &mut a, next()).0, 200);
    assert_eq!(step("settings/profile", "settings.profile", "-", json!({ "profile": "high", "reason": "Harden" }), &mut a, next()).0, 200);
    has_detail(&last_entry(c, "settings.profile"), &["from", "to", "downgraded", "reason"]);
    // console.bootstrap (R41-3): the first admin's registration, with the profile the console started in.
    let e = last_entry(c, "console.bootstrap");
    assert_eq!(e["actor"], ALICE);
    has_detail(&e, &["profile", "profileFrom"]);
    has_detail(&last_entry(c, "console.seal"), &["provider", "keyMode", "refused"]);
    let dir = b.dir.clone();
    drop(b);
    let ok = |_: &str, _: &str| -> Result<(), String> { Ok(()) };
    run_offline(&dir, Offline::BreakGlass { email: BG.into(), replace: false, origin: None }, RP, &ok).unwrap();
    {
        let mut book = crate::console_auth::Book::read(&dir.join(CONSOLE_FILE), T0).unwrap();
        book.settings.two_person = true;
        book.save(&dir.join(CONSOLE_FILE)).unwrap();
    }
    run_offline(&dir, Offline::TwoPersonOff, RP, &ok).unwrap();
    let b = reopen(&dir, true);
    let e = last_entry(&b.c, "break-glass.create");
    assert_eq!((e["actor"].as_str(), e["target"].as_str()), (Some("operator"), Some(BG)));
    has_detail(&e, &["replaced"]);
    assert_eq!(last_entry(&b.c, "two-person.off")["actor"], "operator");
}

#[test]
fn no_entry_or_log_line_holds_a_secret() {
    let b = build("redaction");
    let c = &b.c;
    let mut secrets: Vec<String> = Vec::new();
    let mut a = Authenticator::new(5);
    let inv = c.invite(ALICE, HUB_NODE, HUB_SERIAL, &dialed(HOST), T0).unwrap();
    secrets.push(token_of(&inv.link));
    let begin = json_of(&send(c, call("POST", "/console/api/register/begin", json!({ "token": token_of(&inv.link) }), ""), T0));
    secrets.push(begin["ceremony"].as_str().unwrap().to_owned());
    secrets.push(begin["publicKey"]["challenge"].as_str().unwrap().to_owned());
    let challenge = unb64u(begin["publicKey"]["challenge"].as_str().unwrap()).unwrap();
    let reg = a.register(RP, ORIGIN, &challenge, false);
    let r = send(c, call("POST", "/console/api/register/finish", json!({ "ceremony": begin["ceremony"], "credential": reg }), ""), T0);
    let sid = cookie(&r);
    secrets.push(sid.split_once('=').unwrap().1.to_owned());
    secrets.push(sid_hash(&sid));
    secrets.push(b64u(&a.id));
    secrets.push(b64u(&a.cose()));
    let su = stepup(c, &sid, &mut a, "admins.invite", VIC, &json!({ "email": VIC, "role": "viewer" }), T0 + 1);
    secrets.push(su["ceremony"].as_str().unwrap().to_owned());
    let r = send(c, call("POST", "/console/api/admins/invite", json!({ "email": VIC, "role": "viewer", "stepup": su }), &sid), T0 + 1);
    secrets.push(token_of(json_of(&r)["link"].as_str().unwrap()));
    post_su(c, &sid, &mut a, "/console/api/license/install", "license.install", "l_7", json!({ "license": "lic:l_7:renew", "reason": "r" }), T0 + 2);
    secrets.push("lic:l_7:renew".into());
    // Revision 4: passwords and their hashes, TOTP secrets and codes, reset tokens, the decoy key, mail secrets.
    let r = post_su(c, &sid, &mut a, "/console/api/account/password", "account.password", "-", json!({ "current": "", "password": PW }), T0 + 3);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    secrets.push(PW.into());
    let hash = c.inner.lock().book.people[ALICE].password.as_ref().unwrap().hash.clone();
    secrets.push(hash.rsplit('$').next().unwrap().to_owned());
    secrets.push(hash.clone());
    let v = json_of(&post_su(c, &sid, &mut a, "/console/api/account/totp/begin", "account.totp", "-", json!({}), T0 + 4));
    let shown = v["secret"].as_str().unwrap().to_owned();
    let secret = unbase32(&shown);
    secrets.push(shown);
    secrets.push(crate::codec::hex(&secret));
    let t = T0 + 5 * MIN;
    let code1 = code_at(&secret, t);
    send(c, call("POST", "/console/api/account/totp/finish", json!({ "enrollment": v["enrollment"], "code": code1 }), &sid), t);
    secrets.push(format!("\"{code1}\""));
    add_bare(c, PAT, PersonRole::Viewer);
    set_password(c, PAT, "Pat-Password-5521", CONSOLE_ANCHOR);
    let pat_secret = set_totp(c, PAT, CONSOLE_ANCHOR);
    let t2 = t + MIN;
    assert_eq!(sign_in_totp(c, PAT, "Pat-Password-5521", &pat_secret, "198.51.100.120", t2).status, 200);
    secrets.push("Pat-Password-5521".into());
    secrets.push(format!("\"{}\"", code_at(&pat_secret, t2)));
    add_person(c, &Authenticator::new(9), WES, PersonRole::Viewer, CONSOLE_ANCHOR);
    let r = post_su(c, &sid, &mut a, "/console/api/admins/reset-sign-in", "admins.reset-sign-in", WES, json!({ "email": WES, "reason": "Lost" }), t2 + 1);
    secrets.push(token_of(json_of(&r)["link"].as_str().unwrap()));
    c.mailer.capture();
    let r = post_su(c, &sid, &mut a, "/console/api/settings/email", "settings.email", "-", smtp_body("smtp.acme.example", true), t2 + 2);
    assert_eq!(r.status, 200, "{}", text_of(&r));
    secrets.push("Smtp-Secret-7781".into());
    add_person(c, &Authenticator::new(10), "rex@acme.example", PersonRole::Viewer, CONSOLE_ANCHOR);
    set_password(c, "rex@acme.example", PW, CONSOLE_ANCHOR);
    send_from(c, "/console/api/recover/begin", json!({ "email": "rex@acme.example" }), "", "198.51.100.121", t2 + 3);
    let link = mailed(c, "mail.reset-password").first().map(|(_, args)| arg(args, "link").to_owned()).unwrap();
    secrets.push(link.split_once("#reset=").unwrap().1.to_owned());
    let decoy = c.seal_get(crate::console_auth::DECOY_SECRET).unwrap();
    secrets.push(crate::codec::hex(&decoy));
    secrets.push(b64u(&decoy));
    let all: Vec<String> = entries(c).into_iter().map(|e| stringify(&Value::Object(e))).chain(lines_of(&b.log)).chain(c.ring.lines(&Filter { cat: None, min: Level::Debug, q: None })).collect();
    for s in &secrets {
        assert!(all.iter().all(|l| !l.contains(s.as_str())), "a secret ({s}) is in an entry or a log line");
    }
}

// ── Words, headers, fields and dashes ───────────────────────────────────────────────────────────────────────

#[test]
fn every_answer_carries_the_security_headers() {
    let b = build_in(temp_dir("headers"), Some(ALICE), "10.0.0.0/8", "", false).unwrap();
    let c = &b.c;
    c.invite(ALICE, HUB_NODE, HUB_SERIAL, &dialed(HOST), T0).unwrap();
    let inside = |mut k: Call| {
        k.peer = "10.0.0.5";
        send(c, k, T0)
    };
    let mut answers = vec![inside(get("/console/", "")), inside(get("/console/missing.js", "")), inside(get("/console/api/overview", "")), send(c, get("/console/api/me", ""), T0)];
    answers.push(inside(call("PUT", "/console/api/me", json!({}), "")));
    let mut k = call("POST", "/console/api/login/begin", json!({}), "");
    k.marker = None;
    answers.push(inside(k));
    let mut k = call("POST", "/console/api/login/begin", json!({}), "");
    k.content_type = "text/plain";
    answers.push(inside(k));
    answers.push(inside(call("POST", "/console/api/login/begin", json!({ "email": "x".repeat(70_000) }), "")));
    answers.push(inside(call("POST", "/console/api/login/begin", json!({ "zzz": 1 }), "")));
    answers.push(inside(get("/console/api/nothing", "")));
    let mut k = get("/console/api/me", "");
    k.host = "other.example.com";
    answers.push(inside(k));
    for i in 0..31 {
        let r = inside(call("POST", "/console/api/login/begin", json!({}), ""));
        if i == 30 {
            answers.push(r);
        }
    }
    let dir = temp_dir("headers-503");
    std::fs::write(dir.join(CONSOLE_FILE), "{\"v\":9}").unwrap();
    let broken = build_in(dir, Some(ALICE), "0.0.0.0/0", "", false).unwrap();
    answers.push(send(&broken.c, get("/console/api/me", ""), T0));
    let statuses: Vec<u16> = answers.iter().map(|r| r.status).collect();
    for want in [200, 401, 403, 404, 405, 409, 413, 415, 400, 429, 503] {
        assert!(statuses.contains(&want), "no {want} answer in {statuses:?}");
    }
    for r in &answers {
        for (name, value) in SECURITY_HEADERS.iter() {
            assert_eq!(header(r, name), Some(*value), "{} answer lacks {name}", r.status);
        }
        assert!(header(r, "Cache-Control").is_some(), "{}", r.status);
    }
}

#[test]
fn every_post_route_refuses_unknown_fields() {
    let b = build("unknownfields");
    let c = &b.c;
    c.invite(ALICE, HUB_NODE, HUB_SERIAL, &dialed(HOST), T0).unwrap();
    for spec in CORE_ROUTES.iter().chain(FAKE_ROUTES.iter()).filter(|s| s.method == "POST") {
        let path = format!("/console/api/{}", spec.path);
        let r = send(c, call("POST", &path, json!({ "zzz": 1 }), ""), T0);
        assert_eq!((r.status, code(&r).as_str(), json_of(&r)["error"].as_str()), (400, "unknown-field", Some("Unknown field: zzz.")), "{}", spec.path);
        // `stepup` only where the route takes one.
        if !spec.stepup && !spec.keys.contains(&"stepup") {
            let r = send(c, call("POST", &path, json!({ "stepup": {} }), ""), T0);
            assert_eq!(code(&r), "unknown-field", "{}", spec.path);
        }
    }
}

#[test]
fn every_refusal_word_matches_the_words_vector() {
    let v = vector("admin_console_words_v1.json");
    let refusals = v["refusals"].as_object().expect("refusals by code");
    for (code, r) in refusals {
        let (status, words) = code_words(code).unwrap_or_else(|| panic!("{code} is in the words vector but not in code_words"));
        assert_eq!(Some(i64::from(status)), r["status"].as_i64(), "{code}");
        let first = r["words"][0].as_str().unwrap_or("");
        // `invalid` carries the underlying function's own words.
        if !first.contains('<') && code != "invalid" {
            assert_eq!(words, first, "{code}");
        }
    }
    assert_eq!(refusals["signin-refused"]["words"][0], SIGNIN);
    assert_eq!(code_words("signin-refused").unwrap().1, SIGNIN);
    // The relay's own sentences.
    assert_eq!(v["relay"]["start.fronts-needed"], "the console behind a TLS front needs --console-trusted-fronts (the front's addresses)");
    assert_eq!(v["relay"]["start.first-admin-needed"], "the console needs --console-first-admin <email> until its first admin signs in");
    let page = &v["page"];
    assert_eq!(page["cli.running"], RUNNING);
    assert_eq!(page["cli.break-glass-missing"], crate::console_auth::BREAK_GLASS_MISSING);
    assert_eq!(page["cli.break-glass-link"], crate::console_auth::BREAK_GLASS_LINK);
    assert_eq!(page["cli.break-glass-exists"], crate::console_auth::BREAK_GLASS_EXISTS);
    assert_eq!(page["cli.two-person-off"], crate::console_auth::TWO_PERSON_OFF);
    assert_eq!(page["cli.profile-ignored"].as_str(), Some(crate::console_settings::profile_ignored_words("<flag>").as_str()));
    assert_eq!(page["breakglass.gate"], code_words("break-glass-needed").unwrap().1);
    assert!(page["high.viewer-rights"].as_str().is_some());
    // Every attention item the relay mails has the page's words.
    for (kind, words) in ATTENTION_WORDS.iter() {
        let id = format!("attention.{kind}");
        assert_eq!(page[id.as_str()].as_str(), Some(*words), "{id}");
    }
    // (R3-L5) meet.viewer-rights ends with the sign-out instruction.
    assert_eq!(page["meet.viewer-rights"], "Signed in with a passkey that does not come from your Meeting Hub device, so admin actions are off. Sign out, then sign in with a passkey you added from your own Meeting Hub device.");
    // (R3-L3) With two-person control off, no dialog but the one that turns it off says "Ask for approval".
    for (key, d) in v["dialogs"].as_object().unwrap() {
        if d["second"] == true {
            let single = d["button_single"].as_str().unwrap_or("");
            assert_eq!(single == "Ask for approval", key == "two-person-off", "{key}: {single}");
        }
    }
    // (R3-L4) The license dialog: the hub reseating line for Remote Spokes, and one group per Meeting Hub case.
    let lic = &v["dialogs"]["license"];
    assert!(lic["spokes"].as_array().is_some_and(|l| l.len() == 1 && l[0].as_str().unwrap().contains("license seat")));
    for group in ["upgrade", "seats"] {
        assert!(lic["meet"][group].as_array().is_some_and(|l| !l.is_empty()), "{group}");
    }
    assert!(lic["meet"].get("adding").is_none(), "no growth gate (R42-1)");
}

#[test]
fn no_long_dashes_in_any_console_source_or_constant() {
    let dashes = ['\u{2014}', '\u{2013}'];
    let clean = |s: &str| !s.chars().any(|ch| dashes.contains(&ch));
    for (name, text) in [
        ("console.rs", include_str!("console.rs")),
        ("console_auth.rs", include_str!("console_auth.rs")),
        ("console_approvals.rs", include_str!("console_approvals.rs")),
        ("console_audit.rs", include_str!("console_audit.rs")),
        ("console_limits.rs", include_str!("console_limits.rs")),
        ("console_source.rs", include_str!("console_source.rs")),
        ("console_settings.rs", include_str!("console_settings.rs")),
        ("console_password.rs", include_str!("console_password.rs")),
        ("console_mds.rs", include_str!("console_mds.rs")),
        ("console_mail.rs", include_str!("console_mail.rs")),
        ("console_seal.rs", include_str!("console_seal.rs")),
        ("console_tests.rs", include_str!("console_tests.rs")),
        ("console_webauthn.rs", include_str!("console_webauthn.rs")),
    ] {
        assert!(clean(text), "{name} has a long dash");
        // Escapes are allowed only in a file's own test module, where dash checks must name the characters.
        let code = text.split("#[cfg(test)]").next().unwrap_or(text);
        for entity in ["&mdash;", "&ndash;", "\\u{2014}", "\\u{2013}"] {
            assert!(!code.contains(entity) || name == "console_tests.rs", "{name} has {entity}");
        }
    }
    const CODES: [&str; 69] = [
        "signin-first", "signin-refused", "signin-wait", "banner-needed", "password-length", "password-weak", "password-wrong", "totp-wrong", "profile-high", "not-manageable", "invite-role",
        "last-method", "seat-protected", "not-over", "mail-off", "mail-secret-high", "mail-failed", "mds-refused", "break-glass-needed", "seal-provider-needed", "bad-mailbox", "clock-disagree",
        "license-inactive", "no-seat", "waiting", "suspended", "anchor-revoked", "role", "stepup-needed", "stepup-expired", "stepup-failed", "not-eligible", "no-approver", "gone",
        "approval-exists", "request-exists", "exists", "not-waiting", "not-relay-admin", "not-device-anchored", "last-admin", "passkey-limit", "invite-limit", "people-limit", "joiner-limit",
        "bootstrap-pinned", "bad-url", "license-refused", "license-ended", "license-path", "license-needed", "license-expired", "crl-refused", "directory-refused", "not-found", "rate", "source",
        "origin", "origin-session", "stale", "unknown-field", "audit-broken", "state-unreadable", "write-failed", "invalid", "host", "method", "too-large", "json",
    ];
    for code in CODES {
        let (_, words) = code_words(code).unwrap_or_else(|| panic!("{code} has no words"));
        assert!(clean(words), "{code}");
    }
    for (kind, words) in ATTENTION_WORDS.iter() {
        assert!(clean(kind) && clean(words), "attention.{kind}");
    }
    use crate::console_auth::{BREAK_GLASS_EXISTS, BREAK_GLASS_LINK, BREAK_GLASS_MISSING, REVOKED_MEET, REVOKED_SPOKES, SIGNIN_REFUSED, TWO_PERSON_OFF};
    for words in [SIGNIN_REFUSED, REVOKED_SPOKES, REVOKED_MEET, BREAK_GLASS_MISSING, BREAK_GLASS_LINK, BREAK_GLASS_EXISTS, TWO_PERSON_OFF, RUNNING, SOURCE_REFUSED, CONSOLE_OFF, CSP] {
        assert!(clean(words), "{words}");
    }
    for (id, subject, body) in crate::console_mail::MAIL_WORDS.iter() {
        assert!(clean(subject) && clean(body), "{id}");
    }
    assert!(clean(crate::console_mail::FOOTER));
}

// ── Logs and the signed ops (kept) ──────────────────────────────────────────────────────────────────────────

#[test]
fn the_relay_ring_keeps_the_newest_lines_and_filters_them() {
    let b = build("ring");
    let c = &b.c;
    for i in 0..RELAY_LINES + 5 {
        let level = if i % 2 == 0 { Level::Info } else { Level::Warn };
        c.logger.log(if i % 3 == 0 { "security" } else { "ops" }, level, &format!("e{i}"), &Fields::new());
    }
    c.logger.security("store.full", &Fields::new(), Level::Warn);
    let all = c.ring.lines(&Filter { cat: None, min: Level::Debug, q: None });
    assert_eq!(all.len(), RELAY_LINES);
    assert!(all[0].contains("\"event\":\"store.full\""));
    assert!(all[1].contains(&format!("\"event\":\"e{}\"", RELAY_LINES + 4)));
    assert!(!all.iter().any(|l| l.contains("\"event\":\"e5\"")));
    let warn_ops = c.ring.lines(&Filter { cat: Some("ops".into()), min: Level::Warn, q: None });
    assert!(!warn_ops.is_empty() && warn_ops.iter().all(|l| l.contains("\"cat\":\"ops\"") && l.contains("\"level\":\"warn\"")));
    assert_eq!(c.ring.hits()["store.full"], 1);
    // Signed in: newest first, a page, a search, and the download (a POST with step-up).
    let mut a = Authenticator::new(6);
    let sid = enrol_first(c, &mut a, T0);
    let page = json_of(&send(c, get("/console/api/logs?source=relay&cat=security&level=warn&limit=3", &sid), T0));
    assert_eq!(page["lines"].as_array().unwrap().len(), 3);
    assert!(page["lines"].as_array().unwrap().iter().all(|l| l["cat"] == "security" && l["level"] != "info"));
    let found = json_of(&send(c, get("/console/api/logs?source=relay&q=store.full", &sid), T0));
    assert_eq!(found["total"], 1);
    let body = json!({ "source": "relay", "cat": "all", "level": "debug" });
    let file = post_su(c, &sid, &mut a, "/console/api/logs/export", "logs.export", "relay", body, T0);
    assert_eq!(file.status, 200, "{}", text_of(&file));
    assert!(header(&file, "Content-Disposition").unwrap().starts_with("attachment;"));
    let text = String::from_utf8_lossy(&file.body).into_owned();
    assert!(text.lines().all(|l| parse_json(l).is_some()));
    assert_eq!(send(c, get("/console/api/logs?cat=nope", &sid), T0).status, 400);
}

fn post(n: usize, cat: &str, pad: usize) -> String {
    let lines: Vec<Value> = (0..n).map(|i| json!({ "ts": "2026-11-09T00:00:00.000Z", "level": "warn", "cat": cat, "component": "spoke", "event": format!("e{i}"), "token": "drop me", "pad": "x".repeat(pad) })).collect();
    stringify(&json!({ "lines": lines }))
}

#[test]
fn spoke_logs_are_bounded_and_rate_limited() {
    let b = build("spokes");
    let c = &b.c;
    let all = Filter { cat: None, min: Level::Debug, q: None };
    let node = "n_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    assert_eq!(c.take_logs(node, &post(3, "security", 0), T0), Ok(3));
    let kept = c.spokes.lock().lines(node, &all);
    assert_eq!(kept.len(), 3);
    assert!(kept[0].contains("\"event\":\"e2\"") && !kept[0].contains("drop me"));
    assert_eq!(c.spoke_log_counts()[node], 3);
    let e = c.take_logs(node, &post(101, "ops", 0), T0 + 1).err().unwrap();
    assert_eq!((e.status, e.error.as_str()), (400, "a post carries 1 to 100 log lines"));
    assert_eq!(c.take_logs(node, &post(1, "ops", 2100), T0 + 2).err().unwrap().error, "a log line is at most 2048 bytes");
    assert_eq!(c.take_logs(node, &post(1, "perf", 0), T0 + 3).err().unwrap().error, "only security and ops log lines are taken");
    assert_eq!(c.take_logs(node, &post(40, "ops", 1700), T0 + 4).err().unwrap().error, "a post carries at most 64 KiB of log lines");
    // Six posts a minute, malformed ones counted: the seventh waits until the first is a minute old.
    assert_eq!(c.take_logs(node, &post(1, "ops", 0), T0 + 5), Ok(1));
    let e = c.take_logs(node, &post(1, "ops", 0), T0 + 6).err().unwrap();
    assert_eq!((e.status, e.event), (429, "logs.rate-limited"));
    assert_eq!(c.take_logs(node, &post(1, "ops", 0), T0 + 60_000), Ok(1));
    // The ring per node keeps the newest SPOKE_LINES.
    let mut t = T0 + 120_000;
    for _ in 0..6 {
        c.take_logs(node, &post(100, "ops", 0), t).unwrap();
        t += 60_000;
    }
    assert_eq!(c.spokes.lock().lines(node, &all).len(), SPOKE_LINES);
    // Past SPOKE_NODES spokes, the one that posted least recently goes.
    for i in 0..SPOKE_NODES {
        c.take_logs(&format!("n_{i:032x}"), &post(1, "security", 0), t + i as i64).unwrap();
    }
    let s = c.spokes.lock();
    assert_eq!(s.nodes.len(), SPOKE_NODES);
    assert!(!s.nodes.contains_key(node));
}

use crate::codec::{js_number_string, sha256_hex};
use crate::der::p256_spki_der;
use crate::identity::{node_id_of, user_id_of};
use crate::relay::{Options, Request, State, SENDER_BYTES, STORE_BYTES};
use p256::ecdsa::signature::Signer;
use p256::ecdsa::{Signature, SigningKey};

fn compact(key: &SigningKey, payload: &Value) -> String {
    let body = stringify(payload);
    let sig: Signature = key.sign(body.as_bytes());
    format!("{}.{}", b64u(body.as_bytes()), b64u(sig.to_der().as_bytes()))
}

struct Node {
    key: SigningKey,
    cert: String,
    id: String,
}

/// A node certificate signed by `root` (identity.ts issueCert's shape).
fn node(root: &SigningKey, seed: u8, role: &str, scopes: &[&str], email: Option<&str>) -> Node {
    let root_id = node_id_of(&p256_spki_der(&root.verifying_key().into()));
    let key = SigningKey::from_slice(&[seed; 32]).unwrap();
    let spki = p256_spki_der(&key.verifying_key().into());
    let id = node_id_of(&spki);
    let now = T0 / 1000;
    let mut p = json!({
        "v": 1, "typ": "lucid-node-cert", "serial": format!("{seed:032x}"), "root": root_id, "node": id, "role": role,
        "label": format!("{role} {seed}"), "spki": b64u(&spki), "scopes": scopes, "iat": now - 60, "exp": now + 86_400,
    });
    if let Some(e) = email {
        p["user"] = json!({ "id": user_id_of(e), "email": e });
    }
    Node { cert: compact(root, &p), key, id }
}

fn relay(console: Option<Arc<Console>>, root: &SigningKey) -> State {
    let logger = Arc::new(Logger::capture("relay", Box::new(|_, _| {})));
    let opts = Options {
        root: root.verifying_key().into(),
        owner: None,
        license: None,
        crl_file: None,
        store: None,
        seen_file: None,
        directory_file: None,
        users_file: None,
        store_bytes: STORE_BYTES,
        sender_bytes: SENDER_BYTES,
        console,
        state_dir: None,
        license_file: None,
    };
    State::new(opts, logger).unwrap()
}

/// POST `sent` to `path`, signed by `n` over `signed` (the same body unless a test tampers with it).
fn signed_post(st: &mut State, n: &Node, path: &str, signed: &str, sent: &str, t: i64, nonce: u32) -> (u16, Value) {
    let nonce = format!("{nonce:032x}");
    let line = format!("lucid-relay-auth/v2\nrelay:{HOST}\nPOST\n{path}\n{}\n{nonce}\n{}", js_number_string(t as f64), sha256_hex(signed.as_bytes()));
    let sig: Signature = n.key.sign(line.as_bytes());
    let a = json!({ "cert": n.cert, "ts": t, "nonce": nonce, "sig": b64u(sig.to_der().as_bytes()) });
    let authorization = format!("LucidNode {}", b64u(stringify(&a).as_bytes()));
    let d = dialed(HOST);
    let where_ = Fields::new();
    let r = Request { method: "POST", pathname: path, path, authorization: &authorization, seat: None, dialed: &d, body: sent, where_: &where_ };
    let reply = st.serve(&r, t, true).unwrap();
    (reply.status, parse_json(&reply.body).unwrap_or(Value::Null))
}

fn op(st: &mut State, n: &Node, path: &str, body: &str, t: i64, nonce: u32) -> (u16, Value) {
    signed_post(st, n, path, body, body, t, nonce)
}

/// GET `path` signed by `n`.
fn signed_get(st: &mut State, n: &Node, path: &str, t: i64, nonce: u32) -> (u16, Value) {
    let nonce = format!("{nonce:032x}");
    let line = format!("lucid-relay-auth/v2\nrelay:{HOST}\nGET\n{path}\n{}\n{nonce}\n{}", js_number_string(t as f64), sha256_hex(b""));
    let sig: Signature = n.key.sign(line.as_bytes());
    let a = json!({ "cert": n.cert, "ts": t, "nonce": nonce, "sig": b64u(sig.to_der().as_bytes()) });
    let authorization = format!("LucidNode {}", b64u(stringify(&a).as_bytes()));
    let d = dialed(HOST);
    let where_ = Fields::new();
    let r = Request { method: "GET", pathname: path, path, authorization: &authorization, seat: None, dialed: &d, body: "", where_: &where_ };
    let reply = st.serve(&r, t, true).unwrap();
    (reply.status, parse_json(&reply.body).unwrap_or(Value::Null))
}

#[test]
fn a_malformed_license_at_start_shows_why_invalid_and_the_verifier_words() {
    // R42-1 (4.2.1): the relay starts stopped; the console shows why, with the verifier's words, never the token.
    let root = SigningKey::from_slice(&[1u8; 32]).unwrap();
    let dir = temp_dir("verifier-words");
    let ring = Arc::new(LineRing::default());
    let logger = Arc::new(Logger::capture("relay", Box::new(|_, _| {})).with_tap(ring.tap()));
    let cfg = ConsoleConfig {
        product: Product::Spokes,
        state_dir: dir.clone(),
        origin: None,
        sources: parse_cidr_list("0.0.0.0/0,::/0", SOURCES_MAX).unwrap(),
        trusted_fronts: Vec::new(),
        behind_front: false,
        first_admin: Some(ALICE.to_owned()),
        profile: None,
        host: RP.into(),
    };
    let c = Console::open(cfg, logger.clone(), ring).unwrap();
    let token = "not.a-license";
    let opts = Options {
        root: root.verifying_key().into(),
        owner: None,
        license: Some(token.into()),
        crl_file: None,
        store: None,
        seen_file: None,
        directory_file: None,
        users_file: None,
        store_bytes: STORE_BYTES,
        sender_bytes: SENDER_BYTES,
        console: Some(c.clone()),
        state_dir: None,
        license_file: None,
    };
    let st = Arc::new(parking_lot::Mutex::new(State::new(opts, logger).expect("the relay starts stopped")));
    c.attach(crate::console_spokes::section(Arc::downgrade(&st)));
    let mut a = Authenticator::new(5);
    let sid = enrol_first(&c, &mut a, T0);
    let lic = json_of(&send(&c, get("/console/api/license", &sid), T0 + 1));
    assert_eq!((lic["service"]["state"].as_str(), lic["service"]["why"].as_str()), (Some("stopped"), Some("invalid")));
    let problem = lic["problem"].as_str().unwrap().to_owned();
    assert!(problem.starts_with("This license cannot be used here: "), "{problem}");
    let v = json_of(&send(&c, get("/console/api/overview", &sid), T0 + 2));
    let banner = v["banners"].as_array().unwrap().iter().find(|b| b["id"] == "banner.license-stopped").cloned().expect("the stop banner");
    assert_eq!(banner["args"]["why"], "invalid");
    let words = banner["args"]["verifier words"].as_str().expect("the verifier words").to_owned();
    assert!(!words.is_empty() && problem.contains(&words), "{words} / {problem}");
    assert!(!stringify(&v).contains(token) && !stringify(&lic).contains(token), "never the token");
    // the stop mail names the full why
    let s = st.lock().service_view(T0 + 3);
    let (_, args) = crate::license_reminders::mail_of("stopped", &s, Product::Spokes);
    assert!(args.iter().any(|(k, w)| *k == "why" && w.starts_with("the license file could not be used: ")));
}

#[test]
fn only_a_console_admins_hub_reads_requests_and_never_its_own() {
    let root = SigningKey::from_slice(&[1u8; 32]).unwrap();
    let hub = node(&root, 3, "hub", &["drive"], Some(ALICE));
    let other = node(&root, 4, "hub", &["drive"], Some(BOB));
    let spoke = node(&root, 5, "spoke", &[], None);
    let b = build("route-requests");
    let c = b.c.clone();
    let mut st = relay(Some(c.clone()), &root);
    let mut a = Authenticator::new(5);
    let sid = enrol_first(&c, &mut a, T0);
    for (n, reason) in [(&spoke.id, "Laptop stolen"), (&hub.id, "About the asker")] {
        let body = json!({ "kind": "rs.revoke", "target": { "node": n, "serial": "5f3a" }, "reason": reason });
        let r = send(&c, call("POST", "/console/api/requests/new", body, &sid), T0 + 1);
        assert_eq!(r.status, 200, "{}", text_of(&r));
        let rq = json_of(&r)["request"].clone();
        assert!(rq["id"].as_str().unwrap().starts_with("rq_") && rq["expires_at"].as_i64() == Some(T0 + 1 + 14 * DAY));
    }
    // One waiting request per (kind, target).
    let body = json!({ "kind": "rs.revoke", "target": { "node": spoke.id, "serial": "5f3a" }, "reason": "Again" });
    assert_eq!(code(&send(&c, call("POST", "/console/api/requests/new", body, &sid), T0 + 2)), "request-exists");
    // Alice's hub reads the waiting rs.* requests, never the one about itself.
    let (s, v) = signed_get(&mut st, &hub, "/v1/console/requests", T0 + 3, 1);
    assert_eq!(s, 200);
    let targets: Vec<&str> = v["requests"].as_array().unwrap().iter().map(|r| r["target"]["node"].as_str().unwrap()).collect();
    assert_eq!(targets, vec![spoke.id.as_str()]);
    // Another hub (its user is no console admin) and a spoke are refused.
    assert_eq!(signed_get(&mut st, &other, "/v1/console/requests", T0 + 4, 2).0, 403);
    assert_eq!(signed_get(&mut st, &spoke, "/v1/console/requests", T0 + 5, 3).0, 403);
    // Done only by what the relay observes; there is no route to claim it.
    assert_ne!(op(&mut st, &hub, "/v1/console/requests", "{}", T0 + 6, 4).0, 200);
    assert_eq!(c.requests_waiting("rs.", T0 + 7).len(), 2);
}

#[test]
fn spoke_logs_need_a_signed_spoke_and_the_console_on() {
    let root = SigningKey::from_slice(&[1u8; 32]).unwrap();
    let spoke = node(&root, 2, "spoke", &[], None);
    let hub = node(&root, 3, "hub", &["drive"], Some(ALICE));
    // Off: 409 with how to turn it on (a 2.x relay, so not the 404 an older relay gives).
    let mut off = relay(None, &root);
    let (s, v) = op(&mut off, &spoke, "/v1/logs", &post(1, "ops", 0), T0, 1);
    assert_eq!((s, v["error"].as_str()), (409, Some(CONSOLE_OFF)));
    let b = build("route-logs");
    let c = b.c.clone();
    let mut st = relay(Some(c.clone()), &root);
    let (s, v) = op(&mut st, &spoke, "/v1/logs", &post(2, "security", 0), T0, 2);
    assert_eq!((s, v["kept"].as_i64()), (200, Some(2)));
    assert_eq!(c.spokes.lock().lines(&spoke.id, &Filter { cat: None, min: Level::Debug, q: None }).len(), 2);
    // A hub is not a spoke; a body other than the one signed, or a replay, is not this spoke.
    assert_eq!(op(&mut st, &hub, "/v1/logs", &post(1, "ops", 0), T0, 3).0, 403);
    assert_eq!(signed_post(&mut st, &spoke, "/v1/logs", &post(1, "ops", 0), &post(1, "security", 0), T0, 4).0, 401);
    assert_eq!(op(&mut st, &spoke, "/v1/logs", &post(2, "security", 0), T0, 2).0, 401);
    assert_eq!(op(&mut st, &spoke, "/v1/logs", "{\"lines\":[]}", T0, 5).0, 400);
    // Six posts a minute per node (two so far).
    for i in 0..4 {
        assert_eq!(op(&mut st, &spoke, "/v1/logs", &post(1, "ops", 0), T0 + 1 + i, 10 + i as u32).0, 200);
    }
    assert_eq!(op(&mut st, &spoke, "/v1/logs", &post(1, "ops", 0), T0 + 10, 20).0, 429);
}

#[test]
fn an_invite_needs_a_hub_with_drive_naming_a_person() {
    let root = SigningKey::from_slice(&[1u8; 32]).unwrap();
    let hub = node(&root, 3, "hub", &["drive"], Some(ALICE));
    let recall = node(&root, 4, "hub", &["recall"], Some(BOB));
    let nobody = node(&root, 5, "hub", &["drive"], None);
    let spoke = node(&root, 6, "spoke", &[], None);
    assert_eq!(op(&mut relay(None, &root), &hub, "/v1/console/invite", "{}", T0, 1).0, 409);
    let b = build("route-invite");
    let c = b.c.clone();
    let mut st = relay(Some(c.clone()), &root);
    let (s, v) = op(&mut st, &hub, "/v1/console/invite", "{}", T0, 2);
    assert_eq!(s, 200);
    assert_eq!((v["email"].as_str(), v["origin"].as_str(), v["expires"].as_i64()), (Some(ALICE), Some(ORIGIN), Some(T0 + crate::console_auth::INVITE_MS)));
    let token = token_of(v["link"].as_str().unwrap());
    assert_eq!(v["link"].as_str().unwrap(), format!("{ORIGIN}/console/#join={token}"));
    assert_eq!(json_of(&send(&c, call("POST", "/console/api/join", json!({ "token": token }), ""), T0))["email"], ALICE);
    assert_eq!(op(&mut st, &recall, "/v1/console/invite", "{}", T0, 3).0, 403);
    assert_eq!(op(&mut st, &nobody, "/v1/console/invite", "{}", T0, 4).0, 403);
    assert_eq!(op(&mut st, &spoke, "/v1/console/invite", "{}", T0, 5).0, 403);
    assert_eq!(op(&mut st, &hub, "/v1/console/invite", "{\"email\":\"eve@evil.example\"}", T0, 6).0, 400);
    assert_eq!(op(&mut st, &hub, "/v1/console/invite", "{}", T0, 2).0, 401);
    // The hub's invite is audited with its actor, never its link.
    let e = entries(&c).into_iter().find(|e| e["action"] == "invites.new").unwrap();
    assert_eq!(e["actor"].as_str(), Some(format!("hub {}", hub.id).as_str()));
    assert!(!stringify(&Value::Object(e)).contains(&token));
}

#[test]
fn a_newer_crl_on_the_relay_signs_out_the_admins_its_hubs_invited() {
    let root = SigningKey::from_slice(&[1u8; 32]).unwrap();
    let spoke = node(&root, 2, "spoke", &[], None);
    let hub_serial = format!("{:032x}", 3);
    let b = build("route-crl");
    let c = b.c.clone();
    let mut st = relay(Some(c.clone()), &root);
    let inv = c.invite(ALICE, HUB_NODE, &hub_serial, &dialed(HOST), T0).unwrap();
    let mut a = Authenticator::new(51);
    let sid = cookie(&register(&c, &mut a, &inv.link, T0));
    assert_eq!(send(&c, get("/console/api/overview", &sid), T0 + 1).status, 200);
    let root_id = node_id_of(&p256_spki_der(&root.verifying_key().into()));
    let crl = compact(&root, &json!({ "v": 1, "typ": "lucid-crl", "root": root_id, "version": 1, "serials": [hub_serial], "iat": T0 / 1000 }));
    let (s, _) = op(&mut st, &spoke, "/v1/crl", &stringify(&json!({ "crl": crl })), T0 + 2, 1);
    assert_eq!(s, 200);
    assert_eq!(send(&c, get("/console/api/overview", &sid), T0 + 3).status, 401);
    assert!(c.inner.lock().book.people[ALICE].passkeys[0].revoked_at.is_some());
}
