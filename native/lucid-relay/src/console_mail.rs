// AC-1 3.11 and 8.4 (R4-6, R3-M7, R3-M8): the Admin Console's email. The settings (an SMTP server or Microsoft Graph
// `sendMail`, secrets kept out of console.json), the 8.4 words, a strict RFC 5321 mailbox parser, the console's own
// RFC 5322 and RFC 2047 encoder with a quoted-printable body and SMTP dot-stuffing, and a sender on its own thread and
// tokio runtime: a bounded queue (500, each mail tried 3 times over an hour) and blocking sends for "Send test email"
// and the staged, verified save. TLS is the relay's rustls on AWS-LC (TLS 1.2 or later); the Graph client assertion is
// RS256 on AWS-LC. The server certificate is checked against the webpki roots (the crate has no OS root store reader)
// plus `caPem`.
//
// Mail arguments (`render`, `send`): each key is the 8.4 placeholder name exactly ("seated", "license id",
// "attention words", "date and time", ...); the mailer fills <host> and <console> itself. `section` (the license
// reminders of R42-3) must be "spokes" or "meet". Values in a subject must hold no control character (the mail is refused); values in a body have every
// control character turned into a space and Bidi and default-ignorable characters removed.

use crate::codec::{b64u, exact_keys, hex, now_ms, sha256, str_of, stringify};
use crate::log::{Fields, Level, Logger};
use aws_lc_rs::signature::{KeyPair as _, RsaKeyPair, RSA_PKCS1_SHA256};
use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper_util::rt::TokioIo;
use parking_lot::Mutex;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName};
use rustls::{ClientConfig, RootCertStore};
use serde_json::{json, Map, Value};
use std::collections::VecDeque;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_rustls::client::TlsStream;
use tokio_rustls::TlsConnector;

/// The sender's display name (3.11).
pub const DISPLAY_NAME: &str = "Lucid Admin Console";
/// The names the mail secrets are sealed under (3.11, `console_seal.rs`).
pub const SMTP_PASSWORD: &str = "mail.smtp.password";
pub const GRAPH_KEY: &str = "mail.graph.key";
pub const GRAPH_SECRET: &str = "mail.graph.secret";
pub const SECRET_NAMES: [&str; 3] = [SMTP_PASSWORD, GRAPH_KEY, GRAPH_SECRET];

const INVALID: &str = "invalid";
const BAD_MAILBOX: &str = "bad-mailbox";
const SECRET_HIGH: &str = "mail-secret-high";
/// The 8.1 `settings.email` labels a `bad-mailbox` refusal names.
const FROM_LABEL: &str = "Sender address";
const MAILBOX_LABEL: &str = "Mailbox";
/// Why mail is failing after a switch to High turned a client secret off (`mark_failing`).
const SECRET_HIGH_REASON: &str = "a client secret is not allowed under the High security profile";

const QUEUE_MAX: usize = 500;
/// License reminders queued at most (R7-L2).
const REMINDER_MAX: usize = 64;
const ATTEMPTS: u8 = 3;
const FAILING_AFTER: u32 = 3;
/// 3 tries over an hour: now, after 30 minutes, after an hour.
const RETRY_GAP: Duration = if cfg!(test) { Duration::from_millis(200) } else { Duration::from_secs(30 * 60) };
const CONNECT: Duration = Duration::from_secs(if cfg!(test) { 5 } else { 15 });
/// Each read, write or handshake.
const STEP: Duration = Duration::from_secs(if cfg!(test) { 5 } else { 30 });
/// One whole delivery.
const SESSION: Duration = Duration::from_secs(if cfg!(test) { 20 } else { 120 });
const LINE_MAX: usize = 4096;
const REPLY_LINES_MAX: usize = 100;
const ANSWER_MAX: usize = 64 * 1024;
const PEM_MAX: usize = 64 * 1024;
const REASON_MAX: usize = 200;
const ASSERTION_TYPE: &str = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
const ASSERTION_SECONDS: i64 = 600;
const OID_RSA: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01];

// ── 8.4 words ──────────────────────────────────────────────────────────────────────────────────────────────────

/// `mail.footer`, appended to every body.
pub const FOOTER: &str = "\n\nThis message was sent by the Lucid Admin Console at <host>. It never asks for your password or a code.";

/// Every 8.4 mail: (id, subject, body).
pub const MAIL_WORDS: [(&str, &str, &str); 14] = [
    (
        "mail.invite",
        "Your invite to the Lucid Admin Console at <host>",
        "<inviter> invited you to the Lucid Admin Console at <host> as a viewer.\n\nSet up how you sign in here. The link works once, until <time>:\n<link>\n\nIf you did not expect this, ignore this email.",
    ),
    (
        "mail.reset-password",
        "Reset your Lucid Admin Console password",
        "Someone asked to reset the password of <email> on the Lucid Admin Console at <host>.\n\nChoose a new password here. The link works once, until <time>:\n<link>\n\nYour authenticator app or passkey stays the same. If you did not ask for this, ignore this email.",
    ),
    ("mail.test", "Test email from the Lucid Admin Console", "This is a test from the Lucid Admin Console at <host>. Email works."),
    (
        "mail.seats-over",
        "Meeting Hub on <host>: <seated> people, <users> seats",
        "<seated> people use Meeting Hub on <host>, and the license covers <users>.\n\nOn <date> (day 14), the relay takes seats from <n> people: first those an admin picked, then the newest. Relay admins keep their seats, and no certificate is revoked.\n\nTo keep everyone, request more seats: <console>#/meet/seats\nTo choose who gives up a seat, use the same page.",
    ),
    (
        "mail.seats-request",
        "Meeting Hub seat request, license <license id>",
        "Organization: <org>\nLicense ID: <license id>\nProduct: Meeting Hub\nSeats in the license: <users>\nSeats in use: <seated>\nSeats wanted: <wanted>\nAdmin: <name> <email>\nRelay: <host>\nSent from the Lucid Admin Console on <time>.",
    ),
    (
        "mail.unseated",
        "Your Meeting Hub seat",
        "Your organization's Meeting Hub license on <host> has fewer seats than people, so your seat was taken on <date>. Meeting Hub does not work for you until a seat is free. Ask your admin.\n\nYour devices stay enrolled. When a seat frees up, you get it back without doing anything.",
    ),
    ("mail.reseated", "Your Meeting Hub seat is back", "A Meeting Hub seat on <host> is yours again. Meeting Hub works for you now."),
    (
        "mail.upgrade-period",
        "Meeting Hub on <host> needs a license by <date and time>",
        "This Meeting Hub relay was upgraded and has no license. Service stops on <date and time> unless a Meeting Hub license is installed.\n\nInstall one in the Admin Console: <console>#/meet/license",
    ),
    (
        "mail.license-expiring",
        "<product> license on <host> ends in <n> days",
        "The <product> license of this relay ends on <date> (ID <license id>). Install a new license before then, or the relay stops serving people after at most 2 grace days.\n\nInstall a license: <console>#/<section>/license",
    ),
    (
        "mail.license-grace",
        "<product> on <host>: service stops on <date and time>",
        "The <product> license of this relay ended on <date> (ID <license id>). Service stops on <date and time> unless a new license is installed.\n\nInstall a license: <console>#/<section>/license",
    ),
    (
        "mail.license-stopped",
        "<product> on <host> has stopped serving people",
        "This relay stopped serving people on <date and time> because its <product> license is not active (<why>). The Admin Console still works.\n\nInstall a license to turn service back on: <console>#/<section>/license",
    ),
    (
        "mail.clock-uncertain",
        "Meeting Hub on <host>: confirm the relay's time",
        "The relay's clock jumped or was off for more than a day on <time>, so seat deadlines are on hold. If no admin confirms the time within <n> hours, people over the license are held without service until someone does. Time the relay is stopped counts too.\n\nConfirm it here: <console>#/admins/settings/security",
    ),
    (
        "mail.break-glass",
        "Break-glass sign-in on <host>",
        "The break-glass account <email> signed in to the Lucid Admin Console at <host> on <time> from <address>.\n\nIf this was not planned, sign in now, check the audit log, and end its sessions.",
    ),
    (
        "mail.attention",
        "Lucid Admin Console at <host>: something needs your attention",
        "<attention words>\n\nOpen: <console><go>\n\nYou get this because you chose it in Your account, Email me about.",
    ),
];

/// The AC-2a 13.5 mails of a fleet console: the license reminders it sends its own admins per relay (revision 3.4)
/// and the delegation notice of API-1 revision 5 6.3 (`fleet.mail.delegation`, to the person).
pub const FLEET_MAIL_WORDS: [(&str, &str, &str); 4] = [
    (
        "fleet.mail.license-reminder",
        "The <product> license of <relay> ends in <days> days",
        "The <product> license of <relay> ends on <date>.\nInstall a new license before then from the License page of the Admin Console.\nIf it ends, <relay> stops serving people after at most 2 days of grace.",
    ),
    (
        "fleet.mail.license-grace",
        "<relay> stops on <date and time> unless a new license is installed",
        "The <product> license of <relay> has ended.\nService stops on <date and time> unless a new license is installed.\nInstall one from the License page of the Admin Console.",
    ),
    (
        "fleet.mail.license-stopped",
        "<relay> stopped: no active license",
        "<relay> stopped serving people because it has no active <product> license.\nThe Admin Console can still reach it. Install a license from the License page and it starts again.",
    ),
    (
        "fleet.mail.delegation",
        "<client> can now act for you in the Lucid Admin Console",
        "<client> can now read Lucid Admin Console data as you, with these scopes: <scopes>.\nIt started on <date and time>.\nIf you did not expect this, tell an admin of the console. They can stop <client> from acting for you.",
    ),
];

// ── Settings ───────────────────────────────────────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    Off,
    Smtp,
    Graph,
}

impl Mode {
    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Off => "off",
            Mode::Smtp => "smtp",
            Mode::Graph => "graph",
        }
    }

    fn parse(s: &str) -> Option<Mode> {
        [Mode::Off, Mode::Smtp, Mode::Graph].into_iter().find(|m| m.as_str() == s)
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SmtpTls {
    StartTls,
    Implicit,
}

impl SmtpTls {
    pub fn as_str(self) -> &'static str {
        match self {
            SmtpTls::StartTls => "starttls",
            SmtpTls::Implicit => "implicit",
        }
    }

    fn parse(s: &str) -> Option<SmtpTls> {
        [SmtpTls::StartTls, SmtpTls::Implicit].into_iter().find(|t| t.as_str() == s)
    }

    /// 587 for STARTTLS, 465 for implicit TLS.
    fn default_port(self) -> u16 {
        match self {
            SmtpTls::StartTls => 587,
            SmtpTls::Implicit => 465,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Cloud {
    Commercial,
    UsGov,
    UsGovDod,
}

impl Cloud {
    pub fn as_str(self) -> &'static str {
        match self {
            Cloud::Commercial => "commercial",
            Cloud::UsGov => "usgov",
            Cloud::UsGovDod => "usgov-dod",
        }
    }

    fn parse(s: &str) -> Option<Cloud> {
        [Cloud::Commercial, Cloud::UsGov, Cloud::UsGovDod].into_iter().find(|c| c.as_str() == s)
    }

    /// (sign-in host, Graph host).
    pub fn hosts(self) -> (&'static str, &'static str) {
        match self {
            Cloud::Commercial => ("login.microsoftonline.com", "graph.microsoft.com"),
            Cloud::UsGov => ("login.microsoftonline.us", "graph.microsoft.us"),
            Cloud::UsGovDod => ("login.microsoftonline.us", "dod-graph.microsoft.us"),
        }
    }
}

#[derive(Clone)]
pub enum GraphCredential {
    Certificate { cert_pem: String, key_pem: String },
    Secret(String),
}

impl GraphCredential {
    pub fn kind(&self) -> &'static str {
        match self {
            GraphCredential::Certificate { .. } => "certificate",
            GraphCredential::Secret(_) => "secret",
        }
    }

    fn set(&self) -> bool {
        match self {
            GraphCredential::Certificate { key_pem, .. } => !key_pem.is_empty(),
            GraphCredential::Secret(s) => !s.is_empty(),
        }
    }
}

#[derive(Clone)]
pub struct SmtpConfig {
    pub host: String,
    pub port: u16,
    pub tls: SmtpTls,
    pub username: String,
    pub password: String,
    pub ca_pem: Option<String>,
}

#[derive(Clone)]
pub struct GraphConfig {
    pub cloud: Cloud,
    pub tenant: String,
    pub client_id: String,
    pub mailbox: String,
    pub credential: GraphCredential,
}

#[derive(Clone)]
pub struct MailConfig {
    pub mode: Mode,
    pub from: String,
    pub smtp: Option<SmtpConfig>,
    pub graph: Option<GraphConfig>,
}

/// A refusal: the 8.3 code and its detail (for `bad-mailbox` the field's label, for `invalid` the words).
type Refusal = (&'static str, String);

fn invalid(words: &str) -> Refusal {
    (INVALID, words.to_owned())
}

fn bad_mailbox(label: &str) -> Refusal {
    (BAD_MAILBOX, label.to_owned())
}

/// A text field: None when absent or null, a refusal when it is not a string.
fn field<'a>(o: &'a Map<String, Value>, key: &str, path: &str) -> Result<Option<&'a str>, Refusal> {
    match o.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.as_str())),
        Some(_) => Err(invalid(&format!("{path} must be text"))),
    }
}

/// R3-M8: no control character, and at most `max` characters.
fn plain(s: &str, path: &str, max: usize) -> Result<(), Refusal> {
    if header_value_ok(s) && s.chars().count() <= max {
        Ok(())
    } else {
        Err(invalid(&format!("{path} must have no control characters and at most {max} characters")))
    }
}

fn parse_smtp(v: &Value, cur: Option<&SmtpConfig>) -> Result<SmtpConfig, Refusal> {
    let o = v
        .as_object()
        .filter(|o| exact_keys(o, &["host", "port", "tls", "username", "password", "caPem"], &[]))
        .ok_or_else(|| invalid("smtp must be an object with host, port, tls, username, password and caPem"))?;
    let host = field(o, "host", "smtp.host")?.unwrap_or("");
    if !header_value_ok(host) || !server_host_ok(host) {
        return Err(invalid("smtp.host must be a host name or an IP address"));
    }
    let tls = field(o, "tls", "smtp.tls")?.and_then(SmtpTls::parse).ok_or_else(|| invalid("smtp.tls must be starttls or implicit"))?;
    let port = match o.get("port") {
        None | Some(Value::Null) => tls.default_port(),
        Some(p) => p.as_u64().filter(|p| (1..=65_535).contains(p)).map(|p| p as u16).ok_or_else(|| invalid("smtp.port must be a whole number from 1 to 65535"))?,
    };
    let username = field(o, "username", "smtp.username")?.unwrap_or("");
    plain(username, "smtp.username", 256)?;
    let password = match field(o, "password", "smtp.password")? {
        None | Some("") => cur.map(|c| c.password.clone()).unwrap_or_default(),
        Some(p) => p.to_owned(),
    };
    plain(&password, "smtp.password", 1024)?;
    let password = if username.is_empty() {
        String::new()
    } else if password.is_empty() {
        return Err(invalid("smtp.password is required with a user name"));
    } else {
        password
    };
    let ca_pem = match field(o, "caPem", "smtp.caPem")? {
        None | Some("") => None,
        Some(p) => {
            if pem_certs(p).is_none() {
                return Err(invalid("smtp.caPem must hold one or more PEM certificates"));
            }
            Some(p.to_owned())
        }
    };
    Ok(SmtpConfig { host: host.to_owned(), port, tls, username: username.to_owned(), password, ca_pem })
}

fn parse_graph(v: &Value, cur: Option<&GraphConfig>, high: bool) -> Result<GraphConfig, Refusal> {
    let o = v
        .as_object()
        .filter(|o| exact_keys(o, &["cloud", "tenant", "clientId", "mailbox", "credential", "certificatePem", "keyPem", "secret"], &[]))
        .ok_or_else(|| invalid("graph must be an object with cloud, tenant, clientId, mailbox, credential, certificatePem, keyPem and secret"))?;
    let cloud = field(o, "cloud", "graph.cloud")?.and_then(Cloud::parse).ok_or_else(|| invalid("graph.cloud must be commercial, usgov or usgov-dod"))?;
    let tenant = field(o, "tenant", "graph.tenant")?.unwrap_or("");
    if !header_value_ok(tenant) || !(guid_ok(tenant) || domain_ok(tenant, 2)) {
        return Err(invalid("graph.tenant must be a tenant ID or a domain name"));
    }
    let client_id = field(o, "clientId", "graph.clientId")?.unwrap_or("");
    if !guid_ok(client_id) {
        return Err(invalid("graph.clientId must be an application ID"));
    }
    let mailbox = parse_mailbox(field(o, "mailbox", "graph.mailbox")?.unwrap_or("")).map_err(|_| bad_mailbox(MAILBOX_LABEL))?;
    let credential = match field(o, "credential", "graph.credential")? {
        Some("certificate") => {
            let (cur_cert, cur_key) = match cur.map(|c| &c.credential) {
                Some(GraphCredential::Certificate { cert_pem, key_pem }) => (cert_pem.as_str(), key_pem.as_str()),
                _ => ("", ""),
            };
            let cert_pem = match field(o, "certificatePem", "graph.certificatePem")? {
                None | Some("") => cur_cert,
                Some(c) => c,
            };
            let key_pem = match field(o, "keyPem", "graph.keyPem")? {
                None | Some("") => cur_key,
                Some(k) => k,
            };
            if cert_pem.len() > PEM_MAX || key_pem.len() > PEM_MAX || graph_signer(cert_pem, key_pem).is_none() {
                return Err(invalid("graph.certificatePem and graph.keyPem must be a certificate and its RSA key of 2048 bits or more"));
            }
            GraphCredential::Certificate { cert_pem: cert_pem.to_owned(), key_pem: key_pem.to_owned() }
        }
        Some("secret") => {
            if high {
                return Err((SECRET_HIGH, String::new()));
            }
            let cur_secret = match cur.map(|c| &c.credential) {
                Some(GraphCredential::Secret(s)) => s.as_str(),
                _ => "",
            };
            let secret = match field(o, "secret", "graph.secret")? {
                None | Some("") => cur_secret,
                Some(s) => s,
            };
            if secret.is_empty() {
                return Err(invalid("graph.secret is required for a client secret"));
            }
            plain(secret, "graph.secret", 1024)?;
            GraphCredential::Secret(secret.to_owned())
        }
        _ => return Err(invalid("graph.credential must be certificate or secret")),
    };
    Ok(GraphConfig { cloud, tenant: tenant.to_owned(), client_id: client_id.to_owned(), mailbox, credential })
}

impl MailConfig {
    pub fn off() -> MailConfig {
        MailConfig { mode: Mode::Off, from: String::new(), smtp: None, graph: None }
    }

    /// The settings/email body (fields mode, from, smtp {host, port, tls "starttls"|"implicit", username, password,
    /// caPem}, graph {cloud "commercial"|"usgov"|"usgov-dod", tenant, clientId, mailbox, credential
    /// "certificate"|"secret", certificatePem, keyPem, secret}; `reason` and `stepup` allowed and ignored). A "" or
    /// absent secret (and a "" certificatePem) keeps `current`'s; an absent or "" `from`, or an absent or null `smtp`
    /// or `graph`, keeps `current`'s. Err is the 8.3 code: "bad-mailbox" (from, mailbox), "invalid" (anything else
    /// malformed, control characters included), "mail-secret-high" (a client secret while `high`).
    /// (The console uses `from_body_why`; this short form serves the module's tests.)
    #[cfg(test)]
    pub fn from_body(body: &Value, current: &MailConfig, high: bool) -> Result<MailConfig, &'static str> {
        MailConfig::from_body_why(body, current, high).map_err(|(code, _)| code)
    }

    /// `from_body` with the refusal's detail: for `bad-mailbox` the field's 8.1 label (<field> of the 8.3 words), for
    /// `invalid` the words, for `mail-secret-high` nothing.
    pub fn from_body_why(body: &Value, current: &MailConfig, high: bool) -> Result<MailConfig, (&'static str, String)> {
        let o = body
            .as_object()
            .filter(|o| exact_keys(o, &["mode", "from", "smtp", "graph", "reason", "stepup"], &["mode"]))
            .ok_or_else(|| invalid("the email settings must be an object with mode, from, smtp and graph"))?;
        let mode = str_of(o.get("mode")).and_then(Mode::parse).ok_or_else(|| invalid("mode must be off, smtp or graph"))?;
        let from = match field(o, "from", "from")? {
            None | Some("") => current.from.clone(),
            Some(f) => parse_mailbox(f).map_err(|_| bad_mailbox(FROM_LABEL))?,
        };
        let smtp = match o.get("smtp") {
            None | Some(Value::Null) => current.smtp.clone(),
            Some(v) => Some(parse_smtp(v, current.smtp.as_ref())?),
        };
        let graph = match o.get("graph") {
            None | Some(Value::Null) => current.graph.clone(),
            Some(v) => Some(parse_graph(v, current.graph.as_ref(), high)?),
        };
        let cfg = MailConfig { mode, from, smtp, graph };
        if mode != Mode::Off && cfg.from.is_empty() {
            return Err(bad_mailbox(FROM_LABEL));
        }
        if mode == Mode::Smtp && cfg.smtp.is_none() {
            return Err(invalid("smtp settings are needed to send with an SMTP server"));
        }
        if mode == Mode::Graph && cfg.graph.is_none() {
            return Err(invalid("graph settings are needed to send with Microsoft Graph"));
        }
        if high && mode == Mode::Graph && matches!(cfg.graph.as_ref().map(|g| &g.credential), Some(GraphCredential::Secret(_))) {
            return Err((SECRET_HIGH, String::new()));
        }
        Ok(cfg)
    }

    /// What console.json keeps (`settings.email`): never a secret.
    pub fn to_settings(&self) -> Value {
        let smtp = self.smtp.as_ref().map(|s| json!({ "host": s.host, "port": s.port, "tls": s.tls.as_str(), "username": s.username, "caPem": s.ca_pem }));
        let graph = self.graph.as_ref().map(|g| {
            let cert = match &g.credential {
                GraphCredential::Certificate { cert_pem, .. } => Some(cert_pem.clone()),
                GraphCredential::Secret(_) => None,
            };
            json!({ "cloud": g.cloud.as_str(), "tenant": g.tenant, "clientId": g.client_id, "mailbox": g.mailbox, "credential": g.credential.kind(), "certificatePem": cert })
        });
        json!({ "mode": self.mode.as_str(), "from": self.from, "smtp": smtp, "graph": graph })
    }

    /// Back from console.json plus the unsealed secrets by name (`SMTP_PASSWORD`, `GRAPH_KEY`, `GRAPH_SECRET`). A
    /// section that no longer checks out (a secret missing after `seal-lost`, an edited file) is dropped, and a mode
    /// whose section or sender is gone reads back as off.
    pub fn from_settings(v: &Value, secret: &dyn Fn(&str) -> Option<String>) -> MailConfig {
        let mode = str_of(v.get("mode")).and_then(Mode::parse).unwrap_or(Mode::Off);
        let from = str_of(v.get("from")).and_then(|f| parse_mailbox(f).ok()).unwrap_or_default();
        let smtp = v.get("smtp").and_then(Value::as_object).and_then(|o| {
            let mut o = o.clone();
            o.insert("password".to_owned(), Value::from(secret(SMTP_PASSWORD).unwrap_or_default()));
            parse_smtp(&Value::Object(o), None).ok()
        });
        let graph = v.get("graph").and_then(Value::as_object).and_then(|o| {
            let mut o = o.clone();
            let kind = str_of(o.get("credential")).map(str::to_owned);
            match kind.as_deref() {
                Some("certificate") => {
                    o.insert("keyPem".to_owned(), Value::from(secret(GRAPH_KEY).unwrap_or_default()));
                }
                Some("secret") => {
                    o.insert("secret".to_owned(), Value::from(secret(GRAPH_SECRET).unwrap_or_default()));
                }
                _ => {}
            }
            parse_graph(&Value::Object(o), None, false).ok()
        });
        let mut cfg = MailConfig { mode, from, smtp, graph };
        let ready = match cfg.mode {
            Mode::Off => true,
            Mode::Smtp => !cfg.from.is_empty() && cfg.smtp.is_some(),
            Mode::Graph => !cfg.from.is_empty() && cfg.graph.is_some(),
        };
        if !ready {
            cfg.mode = Mode::Off;
        }
        cfg
    }

    /// The secret values by name, to seal; a name missing here holds nothing (its sealed copy can go).
    pub fn secrets(&self) -> Vec<(&'static str, String)> {
        let mut out = Vec::new();
        if let Some(s) = self.smtp.as_ref().filter(|s| !s.password.is_empty()) {
            out.push((SMTP_PASSWORD, s.password.clone()));
        }
        match self.graph.as_ref().map(|g| &g.credential) {
            Some(GraphCredential::Certificate { key_pem, .. }) if !key_pem.is_empty() => out.push((GRAPH_KEY, key_pem.clone())),
            Some(GraphCredential::Secret(s)) if !s.is_empty() => out.push((GRAPH_SECRET, s.clone())),
            _ => {}
        }
        out
    }

    /// The 4.2 GET settings `email` view: {mode, from, smtp: null|{host, port, tls, username, passwordSet, caPem},
    /// graph: null|{cloud, tenant, clientId, mailbox, credential, credentialSet}}.
    pub fn view(&self) -> Value {
        let smtp = self.smtp.as_ref().map(|s| {
            json!({ "host": s.host, "port": s.port, "tls": s.tls.as_str(), "username": s.username, "passwordSet": !s.password.is_empty(), "caPem": s.ca_pem })
        });
        let graph = self.graph.as_ref().map(|g| {
            json!({ "cloud": g.cloud.as_str(), "tenant": g.tenant, "clientId": g.client_id, "mailbox": g.mailbox, "credential": g.credential.kind(), "credentialSet": g.credential.set() })
        });
        json!({ "mode": self.mode.as_str(), "from": self.from, "smtp": smtp, "graph": graph })
    }

    /// The changed field names (body paths, as "smtp.host"; a whole section added or removed is "smtp" or "graph");
    /// secrets are named ("smtp.password", "graph.keyPem", "graph.secret"), never valued.
    pub fn changed(&self, other: &MailConfig) -> Vec<String> {
        let mut out = Vec::new();
        let mut note = |name: &str, differs: bool| {
            if differs {
                out.push(name.to_owned());
            }
        };
        note("mode", self.mode != other.mode);
        note("from", self.from != other.from);
        match (&self.smtp, &other.smtp) {
            (None, None) => {}
            (Some(a), Some(b)) => {
                note("smtp.host", a.host != b.host);
                note("smtp.port", a.port != b.port);
                note("smtp.tls", a.tls != b.tls);
                note("smtp.username", a.username != b.username);
                note("smtp.password", a.password != b.password);
                note("smtp.caPem", a.ca_pem != b.ca_pem);
            }
            _ => note("smtp", true),
        }
        match (&self.graph, &other.graph) {
            (None, None) => {}
            (Some(a), Some(b)) => {
                note("graph.cloud", a.cloud != b.cloud);
                note("graph.tenant", a.tenant != b.tenant);
                note("graph.clientId", a.client_id != b.client_id);
                note("graph.mailbox", a.mailbox != b.mailbox);
                match (&a.credential, &b.credential) {
                    (GraphCredential::Certificate { cert_pem: c1, key_pem: k1 }, GraphCredential::Certificate { cert_pem: c2, key_pem: k2 }) => {
                        note("graph.certificatePem", c1 != c2);
                        note("graph.keyPem", k1 != k2);
                    }
                    (GraphCredential::Secret(s1), GraphCredential::Secret(s2)) => note("graph.secret", s1 != s2),
                    _ => note("graph.credential", true),
                }
            }
            _ => note("graph", true),
        }
        out
    }
}

// ── Header safety (R3-M8) ──────────────────────────────────────────────────────────────────────────────────────

/// U+0000 to U+001F, U+007F, U+0080 to U+009F, U+2028 and U+2029.
fn control(c: char) -> bool {
    matches!(c, '\u{0}'..='\u{1f}' | '\u{7f}'..='\u{9f}' | '\u{2028}' | '\u{2029}')
}

/// No control character (U+0000..U+001F, U+007F, U+0080..U+009F, U+2028, U+2029).
pub fn header_value_ok(s: &str) -> bool {
    !s.chars().any(control)
}

fn atext(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b"!#$%&'*+-/=?^_`{|}~".contains(&b)
}

/// An LDH label (A-labels are LDH too): 1 to 63, letters, digits and hyphens, no hyphen first or last.
fn label_ok(l: &str) -> bool {
    let b = l.as_bytes();
    !b.is_empty() && b.len() <= 63 && b.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'-') && b[0] != b'-' && b[b.len() - 1] != b'-'
}

/// A domain of at least `min_labels` LDH labels, no trailing dot, at most 253 bytes.
fn domain_ok(d: &str, min_labels: usize) -> bool {
    d.len() <= 253 && d.split('.').count() >= min_labels && d.split('.').all(label_ok)
}

/// R3-M8 strict RFC 5321 Mailbox: an ASCII dot-atom local part (atext only, no leading, trailing or double dot, at
/// most 64 bytes), "@", a domain of at least 2 LDH or A-labels, at most 254 bytes in all. The normalized address
/// (domain lower-cased) or Err.
pub fn parse_mailbox(s: &str) -> Result<String, ()> {
    if s.is_empty() || s.len() > 254 || !s.is_ascii() {
        return Err(());
    }
    let (local, domain) = s.split_once('@').ok_or(())?;
    if local.is_empty() || local.len() > 64 || local.split('.').any(|atom| atom.is_empty() || !atom.bytes().all(atext)) {
        return Err(());
    }
    let domain = domain.to_ascii_lowercase();
    if !domain_ok(&domain, 2) {
        return Err(());
    }
    Ok(format!("{local}@{domain}"))
}

/// An SMTP server name: a domain of LDH labels or an IP address, one TLS can check.
fn server_host_ok(h: &str) -> bool {
    !h.is_empty()
        && h.is_ascii()
        && (h.parse::<std::net::IpAddr>().is_ok() || domain_ok(h, 1))
        && ServerName::try_from(h.to_owned()).is_ok()
}

/// 8-4-4-4-12 hex digits.
fn guid_ok(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36 && b.iter().enumerate().all(|(i, c)| if matches!(i, 8 | 13 | 18 | 23) { *c == b'-' } else { c.is_ascii_hexdigit() })
}

/// Every byte outside RFC 3986 `unreserved` percent-encoded (upper-case hex).
fn pct(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for &b in s.as_bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// The Graph mailbox as one path segment: every byte outside RFC 3986 unreserved percent-encoded.
pub fn graph_path_segment(mailbox: &str) -> String {
    pct(mailbox)
}

/// The `sendMail` path of `mailbox`.
fn send_mail_path(mailbox: &str) -> String {
    format!("/v1.0/users/{}/sendMail", graph_path_segment(mailbox))
}

/// The whole `sendMail` URL in `cloud` (the vector's form).
#[cfg(test)]
fn send_mail_url(cloud: Cloud, mailbox: &str) -> String {
    format!("https://{}{}", cloud.hosts().1, send_mail_path(mailbox))
}

/// RFC 5322 folding of an ASCII header line at 78: break before the last space at index 78 or lower (never the space
/// right after "Name:", nor a continuation line's leading space), else before the first space after; a line with no
/// such space stays whole.
fn fold(line: &str, first_start: usize) -> String {
    let mut parts: Vec<&str> = Vec::new();
    let mut rest = line;
    let mut start = first_start;
    loop {
        if rest.len() <= 78 {
            parts.push(rest);
            break;
        }
        let b = rest.as_bytes();
        let last = (start..=78usize.min(b.len() - 1)).rev().find(|&i| b[i] == b' ');
        let at = last.or_else(|| (79usize.max(start)..b.len()).find(|&i| b[i] == b' '));
        match at {
            Some(i) => {
                parts.push(&rest[..i]);
                rest = &rest[i..];
                start = 1;
            }
            None => {
                parts.push(rest);
                break;
            }
        }
    }
    parts.join("\r\n")
}

fn encoded_word(bytes: &[u8]) -> String {
    format!("=?UTF-8?B?{}?=", crate::meet_json::b64(bytes))
}

/// RFC 2047 encoded-words (UTF-8, base64) for the whole value: each word takes as many whole characters as fit with
/// its line at 78 or fewer characters and the word at 75 or fewer, words joined by a fold.
fn encoded_words(name: &str, value: &str) -> String {
    let prefix = format!("{name}: ");
    let mut budget = 75usize.min(78usize.saturating_sub(prefix.len()));
    let mut words = Vec::new();
    let mut cur: Vec<u8> = Vec::new();
    for ch in value.chars() {
        let mut buf = [0u8; 4];
        let enc = ch.encode_utf8(&mut buf).as_bytes();
        let len = 12 + 4 * (cur.len() + enc.len()).div_ceil(3);
        if !cur.is_empty() && len > budget {
            words.push(encoded_word(&cur));
            cur.clear();
            budget = 75;
        }
        cur.extend_from_slice(enc);
    }
    if !cur.is_empty() || words.is_empty() {
        words.push(encoded_word(&cur));
    }
    format!("{prefix}{}", words.join("\r\n "))
}

/// One header, "Name: value" with folds and no trailing CRLF: folded ASCII, or encoded-words for any non-ASCII.
fn header(name: &str, value: &str) -> String {
    if value.is_ascii() {
        fold(&format!("{name}: {value}"), name.len() + 2)
    } else {
        encoded_words(name, value)
    }
}

/// The body ("\n" line breaks) as quoted-printable with CRLF: bytes 33 to 126 but "=" as they are, space and tab as
/// they are unless last on a line, every other byte "=XX"; soft breaks keep every line at 76 or fewer; ends with CRLF.
fn quoted_printable(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + text.len() / 8 + 2);
    for (n, line) in text.split('\n').enumerate() {
        if n > 0 {
            out.push_str("\r\n");
        }
        let b = line.as_bytes();
        let mut cur = String::new();
        for (i, &c) in b.iter().enumerate() {
            let last = i + 1 == b.len();
            let literal = ((c == b' ' || c == b'\t') && !last) || ((33..=126).contains(&c) && c != b'=');
            let token = if literal { (c as char).to_string() } else { format!("={c:02X}") };
            if cur.len() + token.len() > 75 {
                out.push_str(&cur);
                out.push_str("=\r\n");
                cur.clear();
            }
            cur.push_str(&token);
        }
        out.push_str(&cur);
    }
    out.push_str("\r\n");
    out
}

/// SMTP dot-stuffing (RFC 5321 4.5.2): a "." at the start of the data or right after CRLF gets one more ".".
pub fn dot_stuff(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() + 16);
    let mut line_start = true;
    for (i, &b) in data.iter().enumerate() {
        if line_start && b == b'.' {
            out.push(b'.');
        }
        out.push(b);
        line_start = b == b'\n' && i > 0 && data[i - 1] == b'\r';
    }
    out
}

/// RFC 5322 date in UTC: "Tue, 17 Nov 2026 09:05:07 +0000".
fn rfc5322_date(ms: i64) -> String {
    const DAYS: [&str; 7] = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];
    const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let secs = ms.div_euclid(1000);
    let days = secs.div_euclid(86_400);
    let sod = secs.rem_euclid(86_400);
    let (y, m, d) = crate::meet_json::civil(days);
    let month = MONTHS[(m as usize).clamp(1, 12) - 1];
    format!("{}, {d:02} {month} {y:04} {:02}:{:02}:{:02} +0000", DAYS[days.rem_euclid(7) as usize], sod / 3600, sod % 3600 / 60, sod % 60)
}

/// "<left@right>", printable ASCII, no space or angle bracket inside.
fn message_id_ok(id: &str) -> bool {
    let Some(inner) = id.strip_prefix('<').and_then(|i| i.strip_suffix('>')) else { return false };
    inner.contains('@') && inner.bytes().all(|b| (0x21..=0x7e).contains(&b) && b != b'<' && b != b'>')
}

/// A fresh Message-ID on the sender's domain.
fn message_id(from: &str) -> String {
    let mut r = [0u8; 16];
    let _ = aws_lc_rs::rand::fill(&mut r);
    let domain = from.rsplit_once('@').map(|(_, d)| d).unwrap_or("localhost");
    format!("<{}@{domain}>", hex(&r))
}

/// The whole RFC 5322 message: From "Lucid Admin Console" <from>, To, Subject (RFC 2047 encoded-words for non-ASCII,
/// folded at 78), Date, Message-ID, MIME-Version, a quoted-printable text/plain; charset=utf-8 body, CRLF line ends.
/// Err is "bad-mailbox" (from or to) or "invalid" (a control character in the subject, a malformed Message-ID).
pub fn build_message(from: &str, to: &str, subject: &str, body: &str, date_ms: i64, message_id: &str) -> Result<Vec<u8>, &'static str> {
    let from = parse_mailbox(from).map_err(|_| BAD_MAILBOX)?;
    let to = parse_mailbox(to).map_err(|_| BAD_MAILBOX)?;
    if !header_value_ok(subject) || !message_id_ok(message_id) {
        return Err(INVALID);
    }
    let mut out = String::with_capacity(body.len() + 512);
    out.push_str(&format!("From: \"{DISPLAY_NAME}\" <{from}>\r\n"));
    out.push_str(&format!("To: {to}\r\n"));
    out.push_str(&header("Subject", subject));
    out.push_str("\r\n");
    out.push_str(&format!("Date: {}\r\n", rfc5322_date(date_ms)));
    out.push_str(&format!("Message-ID: {message_id}\r\n"));
    out.push_str("MIME-Version: 1.0\r\n");
    out.push_str("Content-Type: text/plain; charset=utf-8\r\n");
    out.push_str("Content-Transfer-Encoding: quoted-printable\r\n\r\n");
    out.push_str(&quoted_printable(body));
    Ok(out.into_bytes())
}

// ── Rendering ──────────────────────────────────────────────────────────────────────────────────────────────────

fn arg<'a>(args: &'a [(&str, String)], name: &str) -> Option<&'a str> {
    args.iter().find(|(k, _)| *k == name).map(|(_, v)| v.as_str())
}

/// An untrusted value for a body: control characters become spaces, Bidi and default-ignorable characters go.
fn body_text(v: &str) -> String {
    v.chars().filter(|c| !crate::console_auth::ignorable(*c)).map(|c| if control(c) { ' ' } else { c }).collect()
}

/// `template` with every <name> filled by `part`, or None when a value is refused or missing.
fn fill(template: &str, part: &dyn Fn(&str) -> Option<String>) -> Option<String> {
    let mut out = String::with_capacity(template.len() + 64);
    let mut rest = template;
    while let Some(open) = rest.find('<') {
        out.push_str(&rest[..open]);
        let tail = &rest[open + 1..];
        let close = tail.find('>')?;
        out.push_str(&part(&tail[..close])?);
        rest = &tail[close + 1..];
    }
    out.push_str(rest);
    Some(out)
}

/// The 8.4 subject and body of `kind` without `mail.footer` (the text a page shows to copy, 4.9 seat requests).
pub fn render_words(kind: &str, host: &str, console: &str, args: &[(&str, String)]) -> Option<(String, String)> {
    let subject_part = |name: &str| -> Option<String> {
        let v = if name == "host" { host } else { arg(args, name)? };
        header_value_ok(v).then(|| v.to_owned())
    };
    let body_part = |name: &str| -> Option<String> {
        let v = match name {
            "host" => host,
            "console" => console,
            _ => arg(args, name)?,
        };
        Some(body_text(v))
    };
    // The license link names a console page: only a product's.
    if arg(args, "section").is_some_and(|s| !matches!(s, "spokes" | "meet")) {
        return None;
    }
    let &(_, subject, body) = MAIL_WORDS.iter().chain(FLEET_MAIL_WORDS.iter()).find(|(id, _, _)| *id == kind)?;
    Some((fill(subject, &subject_part)?, fill(body, &body_part)?))
}

/// The 8.4 words of `kind` with args filled and `mail.footer` appended (the mailer itself fills <host> and
/// <console>, extra args ignored); None for an unknown kind or an arg that is missing or holds a control character in
/// a subject.
pub fn render(kind: &str, host: &str, console: &str, args: &[(&str, String)]) -> Option<(String, String)> {
    let (subject, mut body) = render_words(kind, host, console, args)?;
    body.push_str(&FOOTER.replace("<host>", &body_text(host)));
    Some((subject, body))
}

// ── Transport ──────────────────────────────────────────────────────────────────────────────────────────────────

/// The server's answer or the failure, one line, section 0 cleaning, at most 200 characters.
fn short(s: &str) -> String {
    let flat: String = s.chars().filter(|c| !crate::console_auth::ignorable(*c)).map(|c| if control(c) { ' ' } else { c }).collect();
    let flat = flat.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() > REASON_MAX {
        format!("{}...", flat.chars().take(REASON_MAX).collect::<String>())
    } else {
        flat
    }
}

/// A failure as callers may show and log it: the configuration's secrets hidden, then `short`.
fn scrub(reason: &str, cfg: &MailConfig) -> String {
    let mut out = reason.to_owned();
    let mut hide: Vec<&str> = Vec::new();
    if let Some(s) = &cfg.smtp {
        hide.push(&s.password);
    }
    if let Some(GraphConfig { credential: GraphCredential::Secret(s), .. }) = &cfg.graph {
        hide.push(s);
    }
    for h in hide.into_iter().filter(|h| h.len() >= 4) {
        out = out.replace(h, "[hidden]");
    }
    short(&out)
}

#[cfg(test)]
fn test_route(host: &str, port: u16) -> Option<SocketAddr> {
    test_net::route(host, port)
}

#[cfg(not(test))]
fn test_route(_: &str, _: u16) -> Option<SocketAddr> {
    None
}

#[cfg(test)]
fn test_roots() -> Vec<String> {
    test_net::roots()
}

#[cfg(not(test))]
fn test_roots() -> Vec<String> {
    Vec::new()
}

/// The certificates of a PEM text that each read as a trust root (at most 64 KiB, no control character but line
/// breaks and tabs), or None.
fn pem_certs(pem: &str) -> Option<Vec<CertificateDer<'static>>> {
    if pem.len() > PEM_MAX || pem.chars().any(|c| control(c) && !matches!(c, '\r' | '\n' | '\t')) {
        return None;
    }
    let certs = rustls_pemfile::certs(&mut pem.as_bytes()).collect::<Result<Vec<_>, _>>().ok()?;
    if certs.is_empty() {
        return None;
    }
    let mut roots = RootCertStore::empty();
    for c in &certs {
        roots.add(c.clone()).ok()?;
    }
    Some(certs)
}

/// TLS 1.2 or 1.3 on the relay's provider, trusting the webpki roots plus `extra` (a PEM of roots).
fn client_tls(extra: Option<&str>) -> Result<Arc<ClientConfig>, String> {
    let mut roots = RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    for pem in extra.map(str::to_owned).into_iter().chain(test_roots()) {
        for c in pem_certs(&pem).ok_or("the extra trusted certificate does not read")? {
            roots.add(c).map_err(|e| format!("the extra trusted certificate cannot be used: {e}"))?;
        }
    }
    let cfg = ClientConfig::builder_with_provider(Arc::new(crate::server::provider()))
        .with_protocol_versions(&[&rustls::version::TLS13, &rustls::version::TLS12])
        .map_err(|e| e.to_string())?
        .with_root_certificates(roots)
        .with_no_client_auth();
    Ok(Arc::new(cfg))
}

async fn tcp(host: &str, port: u16) -> Result<TcpStream, String> {
    let dial = async {
        match test_route(host, port) {
            Some(addr) => TcpStream::connect(addr).await,
            None => TcpStream::connect((host, port)).await,
        }
    };
    match tokio::time::timeout(CONNECT, dial).await {
        Ok(Ok(s)) => Ok(s),
        Ok(Err(e)) => Err(format!("could not connect to {host}:{port}: {e}")),
        Err(_) => Err(format!("could not connect to {host}:{port} in time")),
    }
}

/// TLS with the server's certificate checked against the roots and its name against `host`.
async fn tls_connect(cfg: &Arc<ClientConfig>, host: &str, tcp: TcpStream) -> Result<TlsStream<TcpStream>, String> {
    let name = ServerName::try_from(host.to_owned()).map_err(|_| format!("{host} is not a name TLS can check"))?;
    match tokio::time::timeout(STEP, TlsConnector::from(cfg.clone()).connect(name, tcp)).await {
        Ok(Ok(s)) => Ok(s),
        Ok(Err(e)) => Err(format!("TLS with {host} failed: {e}")),
        Err(_) => Err(format!("TLS with {host} timed out")),
    }
}

struct Reply {
    code: u16,
    lines: Vec<String>,
}

impl Reply {
    fn text(&self) -> String {
        format!("{} {}", self.code, self.lines.join(" "))
    }
}

fn expect(r: Reply, codes: &[u16]) -> Result<Reply, String> {
    if codes.contains(&r.code) {
        Ok(r)
    } else {
        Err(r.text())
    }
}

/// One SMTP connection: lines in, commands out, every step bounded by `STEP`.
struct Wire<S> {
    io: S,
    buf: Vec<u8>,
}

impl<S: AsyncRead + AsyncWrite + Unpin> Wire<S> {
    fn new(io: S) -> Wire<S> {
        Wire { io, buf: Vec::new() }
    }

    async fn line(&mut self) -> Result<String, String> {
        loop {
            if let Some(i) = self.buf.iter().position(|&b| b == b'\n') {
                let mut l: Vec<u8> = self.buf.drain(..=i).collect();
                l.pop();
                if l.last() == Some(&b'\r') {
                    l.pop();
                }
                return Ok(String::from_utf8_lossy(&l).into_owned());
            }
            if self.buf.len() > LINE_MAX {
                return Err("the mail server sent a line that is too long".into());
            }
            let mut chunk = [0u8; 2048];
            let n = match tokio::time::timeout(STEP, self.io.read(&mut chunk)).await {
                Err(_) => return Err("the mail server did not answer in time".into()),
                Ok(Err(e)) => return Err(format!("the connection to the mail server failed: {e}")),
                Ok(Ok(n)) => n,
            };
            if n == 0 {
                return Err("the mail server closed the connection".into());
            }
            self.buf.extend_from_slice(&chunk[..n]);
        }
    }

    async fn reply(&mut self) -> Result<Reply, String> {
        let mut lines = Vec::new();
        let mut code = None;
        loop {
            let l = self.line().await?;
            let b = l.as_bytes();
            let sep = b.get(3).copied();
            if b.len() < 3 || !b[..3].iter().all(u8::is_ascii_digit) || !matches!(sep, None | Some(b' ') | Some(b'-')) {
                return Err(format!("the mail server answered something that is not SMTP: {}", short(&l)));
            }
            let c = (b[0] - b'0') as u16 * 100 + (b[1] - b'0') as u16 * 10 + (b[2] - b'0') as u16;
            if code.is_some_and(|k| k != c) {
                return Err(format!("the mail server answered something that is not SMTP: {}", short(&l)));
            }
            code = Some(c);
            lines.push(l.get(4..).unwrap_or("").to_owned());
            if sep != Some(b'-') {
                return Ok(Reply { code: c, lines });
            }
            if lines.len() >= REPLY_LINES_MAX {
                return Err("the mail server answered with too many lines".into());
            }
        }
    }

    async fn put(&mut self, data: &[u8]) -> Result<(), String> {
        let io = &mut self.io;
        let write = async {
            io.write_all(data).await?;
            io.flush().await?;
            Ok::<(), std::io::Error>(())
        };
        match tokio::time::timeout(STEP, write).await {
            Err(_) => Err("the mail server did not take the data in time".into()),
            Ok(Err(e)) => Err(format!("the connection to the mail server failed: {e}")),
            Ok(Ok(())) => Ok(()),
        }
    }

    async fn cmd(&mut self, line: &str) -> Result<Reply, String> {
        self.put(format!("{line}\r\n").as_bytes()).await?;
        self.reply().await
    }

    /// The connection for TLS, refused when the server sent anything past its answer to STARTTLS (that would be read
    /// as if it came inside TLS).
    fn into_io(self) -> Result<S, String> {
        if self.buf.is_empty() {
            Ok(self.io)
        } else {
            Err("the mail server sent data before TLS started, so nothing was sent".into())
        }
    }
}

#[derive(Default)]
struct Caps {
    starttls: bool,
    plain: bool,
    login: bool,
}

async fn ehlo<S: AsyncRead + AsyncWrite + Unpin>(w: &mut Wire<S>, name: &str) -> Result<Caps, String> {
    let r = expect(w.cmd(&format!("EHLO {name}")).await?, &[250])?;
    let mut caps = Caps::default();
    for l in r.lines.iter().skip(1) {
        let u = l.to_ascii_uppercase();
        let mut words = u.split(&[' ', '='][..]).filter(|w| !w.is_empty());
        match words.next() {
            Some("STARTTLS") => caps.starttls = true,
            Some("AUTH") => {
                for m in words {
                    caps.plain |= m == "PLAIN";
                    caps.login |= m == "LOGIN";
                }
            }
            _ => {}
        }
    }
    Ok(caps)
}

/// AUTH (inside TLS only: every caller holds a TLS stream), MAIL, RCPT, DATA with dot-stuffing, QUIT.
async fn transact<S: AsyncRead + AsyncWrite + Unpin>(w: &mut Wire<S>, s: &SmtpConfig, caps: &Caps, from: &str, to: &str, message: &[u8]) -> Result<(), String> {
    if !s.username.is_empty() {
        if caps.plain {
            let token = crate::meet_json::b64(format!("\0{}\0{}", s.username, s.password).as_bytes());
            expect(w.cmd(&format!("AUTH PLAIN {token}")).await?, &[235])?;
        } else if caps.login {
            expect(w.cmd("AUTH LOGIN").await?, &[334])?;
            expect(w.cmd(&crate::meet_json::b64(s.username.as_bytes())).await?, &[334])?;
            expect(w.cmd(&crate::meet_json::b64(s.password.as_bytes())).await?, &[235])?;
        } else {
            return Err("the mail server offers neither AUTH PLAIN nor AUTH LOGIN".into());
        }
    }
    expect(w.cmd(&format!("MAIL FROM:<{from}>")).await?, &[250])?;
    expect(w.cmd(&format!("RCPT TO:<{to}>")).await?, &[250, 251])?;
    expect(w.cmd("DATA").await?, &[354])?;
    let mut data = dot_stuff(message);
    if !data.ends_with(b"\r\n") {
        data.extend_from_slice(b"\r\n");
    }
    data.extend_from_slice(b".\r\n");
    w.put(&data).await?;
    expect(w.reply().await?, &[250])?;
    let _ = w.cmd("QUIT").await;
    Ok(())
}

async fn smtp_send(s: &SmtpConfig, ehlo_name: &str, from: &str, to: &str, message: &[u8]) -> Result<(), String> {
    let tls = client_tls(s.ca_pem.as_deref())?;
    let tcp = tcp(&s.host, s.port).await?;
    match s.tls {
        SmtpTls::Implicit => {
            let mut w = Wire::new(tls_connect(&tls, &s.host, tcp).await?);
            expect(w.reply().await?, &[220])?;
            let caps = ehlo(&mut w, ehlo_name).await?;
            transact(&mut w, s, &caps, from, to, message).await
        }
        SmtpTls::StartTls => {
            let mut w = Wire::new(tcp);
            expect(w.reply().await?, &[220])?;
            let caps = ehlo(&mut w, ehlo_name).await?;
            if !caps.starttls {
                return Err("the mail server does not offer STARTTLS, so nothing was sent".into());
            }
            expect(w.cmd("STARTTLS").await?, &[220])?;
            let tcp = w.into_io()?;
            let mut w = Wire::new(tls_connect(&tls, &s.host, tcp).await?);
            let caps = ehlo(&mut w, ehlo_name).await?;
            transact(&mut w, s, &caps, from, to, message).await
        }
    }
}

/// One HTTPS POST (HTTP/1.1, its own connection): the status and the answer (at most 64 KiB).
async fn https(tls: &Arc<ClientConfig>, host: &str, path: &str, headers: &[(&str, String)], body: Vec<u8>) -> Result<(u16, Bytes), String> {
    let tcp = tcp(host, 443).await?;
    let io = tls_connect(tls, host, tcp).await?;
    let (mut sender, conn) = match tokio::time::timeout(STEP, hyper::client::conn::http1::handshake::<_, Full<Bytes>>(TokioIo::new(io))).await {
        Ok(Ok(pair)) => pair,
        Ok(Err(e)) => return Err(format!("HTTP with {host} failed: {e}")),
        Err(_) => return Err(format!("HTTP with {host} timed out")),
    };
    tokio::spawn(async move {
        let _ = conn.await;
    });
    let mut req = hyper::Request::builder().method("POST").uri(path).header("host", host).header("accept", "application/json").header("user-agent", "lucid-relay");
    for (k, v) in headers {
        req = req.header(*k, v.as_str());
    }
    let req = req.body(Full::new(Bytes::from(body))).map_err(|e| format!("HTTP with {host} failed: {e}"))?;
    let work = async {
        sender.ready().await.map_err(|e| format!("HTTP with {host} failed: {e}"))?;
        let res = sender.send_request(req).await.map_err(|e| format!("HTTP with {host} failed: {e}"))?;
        let status = res.status().as_u16();
        let answer = Limited::new(res.into_body(), ANSWER_MAX).collect().await.map_err(|e| format!("HTTP with {host} failed: {e}"))?.to_bytes();
        Ok::<_, String>((status, answer))
    };
    tokio::time::timeout(STEP, work).await.map_err(|_| format!("{host} did not answer in time"))?
}

/// An OAuth (`{error, error_description}`) or Graph (`{error: {code, message}}`) failure: status, code and the first
/// line of the words.
fn answer_error(status: u16, body: &[u8]) -> String {
    let v = serde_json::from_slice::<Value>(body).ok();
    let (code, words) = match &v {
        Some(v) if v.get("error").is_some_and(Value::is_object) => (str_of(v["error"].get("code")), str_of(v["error"].get("message"))),
        Some(v) => (str_of(v.get("error")), str_of(v.get("error_description"))),
        None => (None, None),
    };
    let words = words.map(|w| w.lines().next().unwrap_or(""));
    short(&match (code, words) {
        (Some(c), Some(w)) => format!("{status} {c}: {w}"),
        (Some(c), None) => format!("{status} {c}"),
        _ => format!("{status}"),
    })
}

/// The Graph certificate credential: its RSA key (2048 bits or more, PKCS#8 or PKCS#1) that fits the certificate,
/// and the certificate's `x5t#S256` (base64url SHA-256 of its DER).
struct Signer {
    pair: RsaKeyPair,
    thumb: String,
}

/// The RSAPublicKey of a certificate's rsaEncryption SubjectPublicKeyInfo.
fn cert_rsa_key(cert: &[u8]) -> Option<Vec<u8>> {
    use crate::der::tlv;
    let c = tlv(cert).filter(|c| c.tag == 0x30)?;
    let tbs = tlv(c.value).filter(|t| t.tag == 0x30)?;
    let mut fields = Vec::new();
    let mut rest = tbs.value;
    while !rest.is_empty() {
        let t = tlv(rest)?;
        rest = t.rest;
        fields.push((t.tag, t.value));
    }
    let skip = usize::from(fields.first()?.0 == 0xa0);
    // serial, signature, issuer, validity, subject, then the key.
    let &(tag, spki) = fields.get(skip + 5)?;
    if tag != 0x30 {
        return None;
    }
    let alg = tlv(spki).filter(|a| a.tag == 0x30)?;
    let bits = tlv(alg.rest).filter(|b| b.tag == 0x03)?;
    let oid = tlv(alg.value).filter(|o| o.tag == 0x06)?;
    if oid.value != OID_RSA {
        return None;
    }
    let (&unused, key) = bits.value.split_first()?;
    (unused == 0).then(|| key.to_vec())
}

fn graph_signer(cert_pem: &str, key_pem: &str) -> Option<Signer> {
    let cert = rustls_pemfile::certs(&mut cert_pem.as_bytes()).next()?.ok()?;
    let der: &[u8] = &cert;
    let public = cert_rsa_key(der)?;
    let key = rustls_pemfile::private_key(&mut key_pem.as_bytes()).ok()??;
    let pair = match &key {
        PrivateKeyDer::Pkcs8(k) => RsaKeyPair::from_pkcs8(k.secret_pkcs8_der()).ok()?,
        PrivateKeyDer::Pkcs1(k) => RsaKeyPair::from_der(k.secret_pkcs1_der()).ok()?,
        _ => return None,
    };
    if pair.public_modulus_len() < 256 || pair.public_key().as_ref() != public.as_slice() {
        return None;
    }
    Some(Signer { pair, thumb: b64u(&sha256(der)) })
}

/// A random version 4 UUID (the assertion's `jti`).
fn uuid() -> String {
    let mut b = [0u8; 16];
    let _ = aws_lc_rs::rand::fill(&mut b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h = hex(&b);
    format!("{}-{}-{}-{}-{}", &h[..8], &h[8..12], &h[12..16], &h[16..20], &h[20..])
}

/// The client assertion (RS256 JWT, RSASSA-PKCS1-v1_5 with SHA-256 on AWS-LC): header {alg, typ, x5t#S256}, claims
/// {aud (the token endpoint), iss and sub (the application ID), jti, nbf, iat, exp (10 minutes)}.
fn client_assertion(g: &GraphConfig, cert_pem: &str, key_pem: &str, now: i64) -> Result<String, String> {
    let signer = graph_signer(cert_pem, key_pem).ok_or("the Graph certificate or its key does not read")?;
    let header = json!({ "alg": "RS256", "typ": "JWT", "x5t#S256": signer.thumb });
    let aud = format!("https://{}/{}/oauth2/v2.0/token", g.cloud.hosts().0, g.tenant);
    let claims = json!({ "aud": aud, "iss": g.client_id, "sub": g.client_id, "jti": uuid(), "nbf": now, "iat": now, "exp": now + ASSERTION_SECONDS });
    let input = format!("{}.{}", b64u(stringify(&header).as_bytes()), b64u(stringify(&claims).as_bytes()));
    let mut sig = vec![0u8; signer.pair.public_modulus_len()];
    signer.pair.sign(&RSA_PKCS1_SHA256, &aws_lc_rs::rand::SystemRandom::new(), input.as_bytes(), &mut sig).map_err(|_| "the Graph client assertion could not be signed".to_string())?;
    Ok(format!("{input}.{}", b64u(&sig)))
}

/// An app-only token (client credentials), then `sendMail` as `mailbox` with a text body, not saved to Sent Items.
async fn graph_send(g: &GraphConfig, from: &str, to: &str, subject: &str, body: &str) -> Result<(), String> {
    let (login, graph) = g.cloud.hosts();
    let tls = client_tls(None)?;
    let mut form = format!("client_id={}&scope={}&grant_type=client_credentials", pct(&g.client_id), pct(&format!("https://{graph}/.default")));
    match &g.credential {
        GraphCredential::Secret(s) => {
            form.push_str("&client_secret=");
            form.push_str(&pct(s));
        }
        GraphCredential::Certificate { cert_pem, key_pem } => {
            let jwt = client_assertion(g, cert_pem, key_pem, now_ms().div_euclid(1000))?;
            form.push_str("&client_assertion_type=");
            form.push_str(&pct(ASSERTION_TYPE));
            form.push_str("&client_assertion=");
            form.push_str(&jwt);
        }
    }
    let token_path = format!("/{}/oauth2/v2.0/token", pct(&g.tenant));
    let (status, answer) = https(&tls, login, &token_path, &[("content-type", "application/x-www-form-urlencoded".to_owned())], form.into_bytes()).await?;
    if status != 200 {
        return Err(format!("Microsoft sign-in refused the application: {}", answer_error(status, &answer)));
    }
    let token = serde_json::from_slice::<Value>(&answer)
        .ok()
        .and_then(|v| str_of(v.get("access_token")).map(str::to_owned))
        .filter(|t| !t.is_empty() && t.bytes().all(|b| (0x21..=0x7e).contains(&b)))
        .ok_or("Microsoft sign-in answered without a token")?;
    let message = json!({
        "message": {
            "subject": subject,
            "body": { "contentType": "Text", "content": body },
            "from": { "emailAddress": { "name": DISPLAY_NAME, "address": from } },
            "toRecipients": [{ "emailAddress": { "address": to } }]
        },
        "saveToSentItems": false
    });
    let path = send_mail_path(&g.mailbox);
    let headers = [("authorization", format!("Bearer {token}")), ("content-type", "application/json".to_owned())];
    let (status, answer) = https(&tls, graph, &path, &headers, stringify(&message).into_bytes()).await?;
    if (200..300).contains(&status) {
        Ok(())
    } else {
        Err(answer_error(status, &answer))
    }
}

/// One mail through `cfg`, or why not (cleaned, short, secrets hidden).
async fn deliver(cfg: MailConfig, ehlo_name: String, to: String, subject: String, body: String) -> Result<(), String> {
    let result = deliver_through(&cfg, &ehlo_name, &to, &subject, &body).await;
    result.map_err(|e| scrub(&e, &cfg))
}

async fn deliver_through(cfg: &MailConfig, ehlo_name: &str, to: &str, subject: &str, body: &str) -> Result<(), String> {
    let from = parse_mailbox(&cfg.from).map_err(|_| "the sender address cannot be used".to_string())?;
    let to = parse_mailbox(to).map_err(|_| "the address cannot be mailed".to_string())?;
    match cfg.mode {
        Mode::Off => Err("email is off".to_string()),
        Mode::Smtp => {
            let s = cfg.smtp.as_ref().ok_or("there are no SMTP settings")?;
            let message = build_message(&from, &to, subject, body, now_ms(), &message_id(&from)).map_err(|code| format!("the message could not be built ({code})"))?;
            match tokio::time::timeout(SESSION, smtp_send(s, ehlo_name, &from, &to, &message)).await {
                Ok(r) => r,
                Err(_) => Err("the mail server took too long".to_string()),
            }
        }
        Mode::Graph => {
            let g = cfg.graph.as_ref().ok_or("there are no Microsoft Graph settings")?;
            if !header_value_ok(subject) {
                return Err("the message could not be built (invalid)".to_string());
            }
            match tokio::time::timeout(SESSION, graph_send(g, &from, &to, subject, body)).await {
                Ok(r) => r,
                Err(_) => Err("Microsoft Graph took too long".to_string()),
            }
        }
    }
}

/// The EHLO name: the relay's host without a port, when it is a domain.
fn ehlo_name(host: &str) -> String {
    let bare = host.rsplit_once(':').filter(|(_, p)| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit())).map(|(h, _)| h).unwrap_or(host).to_ascii_lowercase();
    if domain_ok(&bare, 1) {
        bare
    } else {
        "localhost".to_owned()
    }
}

// ── The mailer ─────────────────────────────────────────────────────────────────────────────────────────────────

struct Job {
    kind: String,
    to: String,
    subject: String,
    body: String,
    attempts: u8,
    due: Instant,
    /// A license reminder (R7-L2): its own bounded, coalescing class that never evicts other mail.
    reminder: bool,
}

#[derive(Default)]
struct Health {
    in_row: u32,
    failing: bool,
    reason: Option<String>,
}

struct Inner {
    ehlo: String,
    logger: Arc<Logger>,
    cfg: Mutex<MailConfig>,
    queue: Mutex<VecDeque<Job>>,
    health: Mutex<Health>,
    wake: tokio::sync::Notify,
    closed: AtomicBool,
    #[cfg(test)]
    capture: Mutex<Capture>,
}

/// One recorded mail: (kind, to, args).
#[cfg(test)]
pub type CapturedMail = (String, String, Vec<(String, String)>);

/// Test hooks for other modules' tests (`Mailer::capture`): mails recorded instead of sent.
#[cfg(test)]
#[derive(Default)]
struct Capture {
    on: bool,
    mails: Vec<CapturedMail>,
    fail_next: Option<String>,
}

#[cfg(test)]
fn owned_args(args: &[(&str, String)]) -> Vec<(String, String)> {
    args.iter().map(|(k, v)| ((*k).to_owned(), v.clone())).collect()
}

enum Next {
    Job(Job),
    Wait(Option<Instant>),
}

impl Inner {
    /// Queue a job past 500 dropping (and logging) the oldest reminder, else the oldest job. A reminder (R7-L2)
    /// replaces a queued one to the same address (one per recipient), is itself dropped past REMINDER_MAX queued
    /// reminders or a full queue, and so never evicts other mail.
    fn push(&self, job: Job) {
        let dropped = {
            let mut q = self.queue.lock();
            if job.reminder {
                if let Some(i) = q.iter().position(|j| j.reminder && j.to == job.to) {
                    q[i] = job;
                    None
                } else if q.len() >= QUEUE_MAX || q.iter().filter(|j| j.reminder).count() >= REMINDER_MAX {
                    Some((job.kind, "reminder-cap"))
                } else {
                    q.push_back(job);
                    None
                }
            } else {
                let dropped = if q.len() >= QUEUE_MAX {
                    let i = q.iter().position(|j| j.reminder).unwrap_or(0);
                    q.remove(i).map(|d| (d.kind, "queue-full"))
                } else {
                    None
                };
                q.push_back(job);
                dropped
            }
        };
        if let Some((kind, why)) = dropped {
            self.logger.security("console.mail-dropped", &Fields::new().with("kind", kind.as_str()).with("why", why), Level::Warn);
        }
        self.wake.notify_one();
    }

    fn delivered(&self) {
        *self.health.lock() = Health::default();
    }

    fn failed(&self, reason: &str) {
        let mut h = self.health.lock();
        h.in_row = h.in_row.saturating_add(1);
        h.reason = Some(reason.to_owned());
        if h.in_row >= FAILING_AFTER {
            h.failing = true;
        }
    }

    async fn attempt(&self, mut job: Job) {
        let cfg = self.cfg.lock().clone();
        if cfg.mode == Mode::Off {
            return;
        }
        job.attempts += 1;
        match deliver(cfg, self.ehlo.clone(), job.to.clone(), job.subject.clone(), job.body.clone()).await {
            Ok(()) => self.delivered(),
            Err(reason) => {
                let last = job.attempts >= ATTEMPTS;
                let fields = Fields::new().with("kind", job.kind.as_str()).with("to", job.to.as_str()).with("attempt", u64::from(job.attempts)).with("final", last).with("reason", reason.as_str());
                self.logger.security("console.mail-failed", &fields, Level::Warn);
                self.failed(&reason);
                if !last {
                    job.due = Instant::now() + RETRY_GAP;
                    self.push(job);
                }
            }
        }
    }
}

/// The sender thread: due jobs one at a time, in queue order; it ends when its Mailer is dropped.
async fn run(inner: Arc<Inner>) {
    loop {
        if inner.closed.load(Ordering::SeqCst) {
            return;
        }
        let next = {
            let mut q = inner.queue.lock();
            let now = Instant::now();
            let due = q.iter().position(|j| j.due <= now);
            match due.and_then(|i| q.remove(i)) {
                Some(job) => Next::Job(job),
                None => Next::Wait(q.iter().map(|j| j.due).min()),
            }
        };
        match next {
            Next::Job(job) => inner.attempt(job).await,
            Next::Wait(Some(at)) => {
                tokio::select! {
                    _ = inner.wake.notified() => {}
                    _ = tokio::time::sleep_until(tokio::time::Instant::from_std(at)) => {}
                }
            }
            Next::Wait(None) => inner.wake.notified().await,
        }
    }
}

/// The console's mail sender: the configuration in force, the queue and its own thread and tokio runtime, so a
/// blocking `send_now` never waits on the caller's runtime.
pub struct Mailer {
    host: String,
    console_url: String,
    inner: Arc<Inner>,
    handle: Option<tokio::runtime::Handle>,
}

/// The process mailer `send` uses.
static INSTALLED: std::sync::Mutex<Option<Weak<Mailer>>> = std::sync::Mutex::new(None);

impl Mailer {
    /// `host`: the relay's host name (8.4 <host>); `console_url`: "https://<console host>/console/" (8.4 <console>).
    /// Mail starts off.
    pub fn new(host: String, console_url: String, logger: Arc<Logger>) -> Arc<Mailer> {
        let inner = Arc::new(Inner {
            ehlo: ehlo_name(&host),
            logger,
            cfg: Mutex::new(MailConfig::off()),
            queue: Mutex::new(VecDeque::new()),
            health: Mutex::new(Health::default()),
            wake: tokio::sync::Notify::new(),
            closed: AtomicBool::new(false),
            #[cfg(test)]
            capture: Mutex::new(Capture::default()),
        });
        let handle = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
            Ok(rt) => {
                let handle = rt.handle().clone();
                let worker = inner.clone();
                match std::thread::Builder::new().name("console-mail".into()).spawn(move || rt.block_on(run(worker))) {
                    Ok(_) => Some(handle),
                    Err(e) => {
                        inner.logger.ops("console.mail-thread-failed", &Fields::new().with("reason", e.to_string()), Level::Error);
                        None
                    }
                }
            }
            Err(e) => {
                inner.logger.ops("console.mail-thread-failed", &Fields::new().with("reason", e.to_string()), Level::Error);
                None
            }
        };
        Arc::new(Mailer { host, console_url, inner, handle })
    }

    /// Make this the process mailer `send` uses (held weakly).
    pub fn install(self: &Arc<Self>) {
        if let Ok(mut m) = INSTALLED.lock() {
            *m = Some(Arc::downgrade(self));
        }
    }

    /// The configuration in force. Off stops sending and drops (and logs) whatever is queued; a mail queued under one
    /// configuration goes out through the next one that is on.
    pub fn configure(&self, cfg: MailConfig) {
        let off = cfg.mode == Mode::Off;
        *self.inner.cfg.lock() = cfg;
        if off {
            let dropped = {
                let mut q = self.inner.queue.lock();
                let n = q.len();
                q.clear();
                n
            };
            if dropped > 0 {
                self.inner.logger.security("console.mail-dropped", &Fields::new().with("count", dropped).with("why", "off"), Level::Warn);
            }
        }
        self.inner.wake.notify_one();
    }

    pub fn config(&self) -> MailConfig {
        self.inner.cfg.lock().clone()
    }

    /// Queue one mail (rendered now) off the request path; nothing while mail is off. An address or arguments that
    /// cannot be mailed are logged (`console.mail-failed`), never queued.
    pub fn enqueue(&self, kind: &str, to: &str, args: &[(&str, String)]) {
        self.enqueue_as(kind, to, args, false);
    }

    /// `enqueue` that says whether the mail was taken into the queue of a running sender: false while mail is off,
    /// when the sender's thread never started or this mailer is closing, and when the address or arguments cannot be
    /// mailed (API-1 r5 6.3: a delegation notice counts as sent only once taken).
    pub fn enqueue_taken(&self, kind: &str, to: &str, args: &[(&str, String)]) -> bool {
        self.sending() && self.enqueue_as(kind, to, args, false)
    }

    /// A sender worker runs: its thread started and this mailer is not closed.
    fn sending(&self) -> bool {
        self.handle.is_some() && !self.inner.closed.load(Ordering::SeqCst)
    }

    /// `enqueue` in the license reminder class (R42-3, R7-L2): bounded and coalescing, never evicting other mail.
    pub fn enqueue_reminder(&self, kind: &str, to: &str, args: &[(&str, String)]) {
        self.enqueue_as(kind, to, args, true);
    }

    fn enqueue_as(&self, kind: &str, to: &str, args: &[(&str, String)], reminder: bool) -> bool {
        if self.inner.cfg.lock().mode == Mode::Off {
            return false;
        }
        #[cfg(test)]
        {
            let mut c = self.inner.capture.lock();
            if c.on {
                c.mails.push((kind.to_owned(), to.to_owned(), owned_args(args)));
                return true;
            }
        }
        let refused = |why: &str| {
            let fields = Fields::new().with("kind", kind).with("attempt", 0u64).with("final", true).with("reason", why);
            self.inner.logger.security("console.mail-failed", &fields, Level::Warn);
            false
        };
        let Ok(to) = parse_mailbox(to) else { return refused("the address cannot be mailed") };
        let Some((subject, body)) = render(kind, &self.host, &self.console_url, args) else { return refused("the message could not be built") };
        self.inner.push(Job { kind: kind.to_owned(), to, subject, body, attempts: 0, due: Instant::now(), reminder });
        true
    }

    /// Blocking send through `cfg` now (the test mail, the staged save): Ok, or Err(the server's answer, cleaned,
    /// short, secrets hidden) for `mail-failed`. The configuration in force is untouched; a success clears `failing`.
    pub fn send_now(&self, cfg: &MailConfig, kind: &str, to: &str, args: &[(&str, String)]) -> Result<(), String> {
        let result = self.send_now_inner(cfg, kind, to, args);
        match &result {
            Ok(()) => self.inner.delivered(),
            Err(reason) => {
                let fields = Fields::new().with("kind", kind).with("attempt", 1u64).with("final", true).with("direct", true).with("reason", reason.as_str());
                self.inner.logger.security("console.mail-failed", &fields, Level::Warn);
            }
        }
        result
    }

    fn send_now_inner(&self, cfg: &MailConfig, kind: &str, to: &str, args: &[(&str, String)]) -> Result<(), String> {
        #[cfg(test)]
        {
            let mut c = self.inner.capture.lock();
            if let Some(reason) = c.fail_next.take() {
                return Err(reason);
            }
            if c.on {
                c.mails.push((kind.to_owned(), to.to_owned(), owned_args(args)));
                return Ok(());
            }
        }
        if cfg.mode == Mode::Off {
            return Err("email is off".into());
        }
        let to = parse_mailbox(to).map_err(|_| "the address cannot be mailed".to_string())?;
        let (subject, body) = render(kind, &self.host, &self.console_url, args).ok_or_else(|| "the message could not be built".to_string())?;
        let handle = self.handle.as_ref().ok_or_else(|| "the mail sender is not running".to_string())?;
        let (tx, rx) = std::sync::mpsc::channel();
        let work = deliver(cfg.clone(), self.inner.ehlo.clone(), to, subject, body);
        handle.spawn(async move {
            let _ = tx.send(work.await);
        });
        rx.recv_timeout(SESSION + Duration::from_secs(10)).unwrap_or_else(|_| Err("the mail server took too long".into()))
    }

    /// Blocking send of a subject and body written whole by the caller (the Meet account emails keep the words the
    /// Meet console sent, no 8.4 template or footer) through the configuration in force. Err as `send_now`.
    pub fn send_text_now(&self, kind: &str, to: &str, subject: &str, body: &str) -> Result<(), String> {
        let cfg = self.config();
        let args = [("subject", subject.to_owned()), ("body", body.to_owned())];
        let result = self.send_text_inner(&cfg, kind, to, subject, body, &args);
        match &result {
            Ok(()) => self.inner.delivered(),
            Err(reason) => {
                let fields = Fields::new().with("kind", kind).with("attempt", 1u64).with("final", true).with("direct", true).with("reason", reason.as_str());
                self.inner.logger.security("console.mail-failed", &fields, Level::Warn);
            }
        }
        result
    }

    fn send_text_inner(&self, cfg: &MailConfig, kind: &str, to: &str, subject: &str, body: &str, args: &[(&str, String)]) -> Result<(), String> {
        #[cfg(test)]
        {
            let mut c = self.inner.capture.lock();
            if let Some(reason) = c.fail_next.take() {
                return Err(reason);
            }
            if c.on {
                c.mails.push((kind.to_owned(), to.to_owned(), owned_args(args)));
                return Ok(());
            }
        }
        let _ = (kind, args);
        if cfg.mode == Mode::Off {
            return Err("email is off".into());
        }
        let to = parse_mailbox(to).map_err(|_| "the address cannot be mailed".to_string())?;
        let handle = self.handle.as_ref().ok_or_else(|| "the mail sender is not running".to_string())?;
        let (tx, rx) = std::sync::mpsc::channel();
        let work = deliver(cfg.clone(), self.inner.ehlo.clone(), to, subject.to_owned(), body.to_owned());
        handle.spawn(async move {
            let _ = tx.send(work.await);
        });
        rx.recv_timeout(SESSION + Duration::from_secs(10)).unwrap_or_else(|_| Err("the mail server took too long".into()))
    }

    /// `mail-failing`: 3 failed tries in a row (or `mark_failing`), until the next mail goes through.
    pub fn failing(&self) -> bool {
        self.inner.health.lock().failing
    }

    /// The last failure while failing (attention.mail-failing <reason>).
    pub fn failing_reason(&self) -> Option<String> {
        let h = self.inner.health.lock();
        if h.failing {
            Some(h.reason.clone().unwrap_or_default())
        } else {
            None
        }
    }

    /// Raise `mail-failing` at once (a switch to High turned a Graph client secret off, 3.11).
    pub fn mark_failing(&self) {
        let mut h = self.inner.health.lock();
        h.failing = true;
        h.reason = Some(SECRET_HIGH_REASON.to_owned());
    }

    #[cfg(test)]
    fn queued(&self) -> Vec<String> {
        self.inner.queue.lock().iter().map(|j| j.to.clone()).collect()
    }

    /// Test hook: from now on `enqueue` records (kind, to, args) instead of sending (still nothing while mail is
    /// off), and `send_now` records and succeeds (unless `fail_next` is set); `configure` and `config` work as ever.
    #[cfg(test)]
    pub fn capture(&self) {
        self.inner.capture.lock().on = true;
    }

    /// Test hook: what `capture` recorded, in order: (kind, to, args).
    #[cfg(test)]
    pub fn captured(&self) -> Vec<CapturedMail> {
        self.inner.capture.lock().mails.clone()
    }

    /// Test hook: the next `send_now` answers Err(reason) (captured or not).
    #[cfg(test)]
    pub fn fail_next(&self, reason: &str) {
        self.inner.capture.lock().fail_next = Some(reason.to_owned());
    }
}

impl Drop for Mailer {
    fn drop(&mut self) {
        self.inner.closed.store(true, Ordering::SeqCst);
        self.inner.wake.notify_one();
    }
}

/// I12 for other slices: queue through the installed mailer; nothing when none is installed or mail is off.
pub fn send(kind: &str, to: &str, args: &[(&str, String)]) {
    let mailer = INSTALLED.lock().ok().and_then(|m| m.as_ref().and_then(Weak::upgrade));
    if let Some(m) = mailer {
        m.enqueue(kind, to, args);
    }
}

/// Tests reach their in-process servers by name: (host, port) to a local address, and extra trusted roots.
#[cfg(test)]
mod test_net {
    use std::net::SocketAddr;
    use std::sync::Mutex;

    static ROUTES: Mutex<Vec<(String, u16, SocketAddr)>> = Mutex::new(Vec::new());
    static ROOTS: Mutex<Vec<String>> = Mutex::new(Vec::new());

    pub fn route(host: &str, port: u16) -> Option<SocketAddr> {
        ROUTES.lock().ok()?.iter().find(|(h, p, _)| h == host && *p == port).map(|r| r.2)
    }

    pub fn add_route(host: &str, port: u16, to: SocketAddr) {
        let mut r = ROUTES.lock().unwrap();
        r.retain(|(h, p, _)| !(h == host && *p == port));
        r.push((host.to_owned(), port, to));
    }

    pub fn roots() -> Vec<String> {
        ROOTS.lock().map(|r| r.clone()).unwrap_or_default()
    }

    pub fn add_root(pem: &str) {
        ROOTS.lock().unwrap().push(pem.to_owned());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codec::{b64_decode_lenient, parse_json, unb64u, utf8_lossy};
    use aws_lc_rs::encoding::{AsDer, Pkcs8V1Der, PublicKeyX509Der};
    use aws_lc_rs::rand::SystemRandom;
    use aws_lc_rs::rsa::KeySize;
    use aws_lc_rs::signature::{EcdsaKeyPair, KeyPair, UnparsedPublicKey, ECDSA_P256_SHA256_ASN1_SIGNING, RSA_PKCS1_2048_8192_SHA256};
    use std::convert::Infallible;
    use tokio::io::{AsyncBufReadExt, BufReader};
    use tokio::net::TcpListener;
    use tokio::runtime::Runtime;

    const HOST: &str = "relay.acme.example";
    const CONSOLE: &str = "https://console.acme.example/console/";
    const USER: &str = "relay";
    const PASSWORD: &str = "pw-SECRET-1";
    const SECRET: &str = "gs-SECRET-2";
    const TENANT: &str = "11111111-2222-3333-4444-555555555555";
    const CLIENT: &str = "66666666-7777-8888-9999-aaaaaaaaaaaa";
    const LINK: &str = "https://console.acme.example/console/#/join/LINK-TOKEN-1";

    /// The shared vectors (tests/vectors in the Meeting Hub, copied next to this crate's other vectors).
    fn vector(name: &str) -> Value {
        let path = format!("{}/tests/{name}", env!("CARGO_MANIFEST_DIR"));
        let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e} (copy it from the Meeting Hub repository's tests/vectors/)"));
        parse_json(&text).unwrap()
    }

    fn arr(v: &Value) -> &Vec<Value> {
        v.as_array().expect("a list in the vector")
    }

    fn text(v: &Value) -> String {
        v.as_str().map(str::to_owned).unwrap_or_else(|| v.to_string())
    }

    /// One value for every 8.4 placeholder.
    fn sample() -> Vec<(String, String)> {
        [
            ("inviter", "Ann Admin"),
            ("time", "2026-11-18 10:00 UTC"),
            ("link", LINK),
            ("email", "bob@acme.example"),
            ("seated", "25"),
            ("users", "20"),
            ("date", "2026-12-01"),
            ("n", "5"),
            ("license id", "l_0123456789abcdef"),
            ("org", "Acme"),
            ("wanted", "30"),
            ("name", "Ann Admin"),
            ("address", "203.0.113.7"),
            ("attention words", "Email is failing: 451 try later. Check Settings, Email."),
            ("go", "#/settings/email"),
            ("product", "Meeting Hub"),
            ("date and time", "2026-12-03 10:00 UTC"),
            ("why", "no license is installed"),
            ("section", "meet"),
        ]
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
    }

    fn set(a: &mut Vec<(String, String)>, k: &str, v: &str) {
        a.retain(|(n, _)| n != k);
        a.push((k.to_owned(), v.to_owned()));
    }

    fn refs(a: &[(String, String)]) -> Vec<(&str, String)> {
        a.iter().map(|(k, v)| (k.as_str(), v.clone())).collect()
    }

    fn test_fill(template: &str, value: &dyn Fn(&str) -> String) -> String {
        let mut out = String::new();
        let mut rest = template;
        while let Some(open) = rest.find('<') {
            out.push_str(&rest[..open]);
            let tail = &rest[open + 1..];
            let close = tail.find('>').unwrap();
            out.push_str(&value(&tail[..close]));
            rest = &tail[close + 1..];
        }
        out.push_str(rest);
        out
    }

    fn qp_decode(s: &str) -> String {
        let s = s.replace("=\r\n", "");
        let b = s.as_bytes();
        let mut out = Vec::new();
        let mut i = 0;
        while i < b.len() {
            if b[i] == b'=' && i + 3 <= b.len() {
                if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                    out.push(v);
                    i += 3;
                    continue;
                }
            }
            out.push(b[i]);
            i += 1;
        }
        String::from_utf8_lossy(&out).into_owned()
    }

    fn base_body() -> Value {
        json!({
            "mode": "smtp",
            "from": "relay@acme.example",
            "smtp": { "host": "smtp.acme.example", "port": 587, "tls": "starttls", "username": USER, "password": PASSWORD, "caPem": null },
            "graph": { "cloud": "commercial", "tenant": TENANT, "clientId": CLIENT, "mailbox": "relay@acme.example", "credential": "secret", "secret": SECRET }
        })
    }

    /// The base body with the field at `path` ("from", "smtp.host", ...) set to `value`.
    fn body_with(path: &str, value: &str) -> Value {
        let mut b = base_body();
        let parts: Vec<&str> = path.split('.').collect();
        let mut at = &mut b;
        for p in &parts[..parts.len() - 1] {
            at = at.get_mut(*p).unwrap();
        }
        at[parts[parts.len() - 1]] = Value::from(value);
        b
    }

    // ── Certificates ──

    fn der(tag: u8, body: &[u8]) -> Vec<u8> {
        let mut out = vec![tag];
        let n = body.len();
        if n < 0x80 {
            out.push(n as u8);
        } else if n < 0x100 {
            out.extend([0x81, n as u8]);
        } else {
            out.extend([0x82, (n >> 8) as u8, n as u8]);
        }
        out.extend_from_slice(body);
        out
    }

    fn pem(label: &str, data: &[u8]) -> String {
        let b = crate::meet_json::b64(data);
        let lines: Vec<&str> = b.as_bytes().chunks(64).map(|c| std::str::from_utf8(c).unwrap()).collect();
        format!("-----BEGIN {label}-----\n{}\n-----END {label}-----\n", lines.join("\n"))
    }

    fn name(cn: &str) -> Vec<u8> {
        der(0x30, &der(0x31, &der(0x30, &[der(0x06, &[0x55, 0x04, 0x03]), der(0x0c, cn.as_bytes())].concat())))
    }

    fn validity() -> Vec<u8> {
        der(0x30, &[der(0x17, b"250101000000Z"), der(0x17, b"491231235959Z")].concat())
    }

    /// A self-signed P-256 TLS certificate naming each of `names` (SAN DNS) and its PKCS#8 key, as PEM.
    fn tls_cert(names: &[&str]) -> (String, String) {
        let rng = SystemRandom::new();
        let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, &rng).unwrap();
        let pair = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, pkcs8.as_ref()).unwrap();
        let spki = crate::der::p256_spki_der(&crate::der::P256Key::from_sec1(pair.public_key().as_ref()).unwrap());
        let alg = der(0x30, &der(0x06, &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02]));
        let sans: Vec<u8> = names.iter().flat_map(|n| der(0x82, n.as_bytes())).collect();
        let san = der(0x30, &[der(0x06, &[0x55, 0x1d, 0x11]), der(0x04, &der(0x30, &sans))].concat());
        let tbs = der(0x30, &[der(0xa0, &der(0x02, &[2])), der(0x02, &[1]), alg.clone(), name(names[0]), validity(), name(names[0]), spki, der(0xa3, &der(0x30, &san))].concat());
        let sig = pair.sign(&rng, &tbs).unwrap();
        let cert = der(0x30, &[tbs, alg, der(0x03, &[&[0u8][..], sig.as_ref()].concat())].concat());
        (pem("CERTIFICATE", &cert), pem("PRIVATE KEY", pkcs8.as_ref()))
    }

    /// A Graph certificate credential: a self-signed certificate for a fresh RSA 2048 key (PEM), the key (PKCS#8 PEM)
    /// and its RSAPublicKey DER.
    fn rsa_credential() -> (String, String, Vec<u8>) {
        let pair = RsaKeyPair::generate(KeySize::Rsa2048).unwrap();
        let pkcs8_der = AsDer::<Pkcs8V1Der>::as_der(&pair).unwrap();
        let pkcs8: &[u8] = pkcs8_der.as_ref();
        let spki_der = AsDer::<PublicKeyX509Der>::as_der(pair.public_key()).unwrap();
        let spki: &[u8] = spki_der.as_ref();
        let alg = der(0x30, &[der(0x06, &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b]), vec![0x05, 0x00]].concat());
        let tbs = der(0x30, &[der(0xa0, &der(0x02, &[2])), der(0x02, &[7]), alg.clone(), name("lucid-mail-test"), validity(), name("lucid-mail-test"), spki.to_vec()].concat());
        let mut sig = vec![0u8; pair.public_modulus_len()];
        pair.sign(&RSA_PKCS1_SHA256, &SystemRandom::new(), &tbs, &mut sig).unwrap();
        let cert = der(0x30, &[tbs, alg, der(0x03, &[&[0u8][..], &sig[..]].concat())].concat());
        (pem("CERTIFICATE", &cert), pem("PRIVATE KEY", pkcs8), pair.public_key().as_ref().to_vec())
    }

    fn first_der(cert_pem: &str) -> Vec<u8> {
        rustls_pemfile::certs(&mut cert_pem.as_bytes()).next().unwrap().unwrap().to_vec()
    }

    // ── In-process servers ──

    fn runtime() -> Runtime {
        tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap()
    }

    fn listen(rt: &Runtime) -> (TcpListener, u16) {
        rt.block_on(async {
            let l = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            let port = l.local_addr().unwrap().port();
            (l, port)
        })
    }

    fn local(port: u16) -> SocketAddr {
        SocketAddr::from(([127, 0, 0, 1], port))
    }

    fn wait_until(what: &str, done: impl Fn() -> bool) {
        let end = Instant::now() + Duration::from_secs(30);
        while !done() {
            assert!(Instant::now() < end, "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn mailer() -> (Arc<Mailer>, Arc<Mutex<Vec<String>>>) {
        let lines = Arc::new(Mutex::new(Vec::new()));
        let sink = lines.clone();
        let logger = Logger::capture("relay", Box::new(move |line: &str, _: Level| sink.lock().push(line.to_owned())));
        (Mailer::new(HOST.into(), CONSOLE.into(), Arc::new(logger)), lines)
    }

    fn smtp_cfg(host: &str, port: u16, tls: SmtpTls, ca: Option<String>) -> MailConfig {
        MailConfig {
            mode: Mode::Smtp,
            from: "relay@acme.example".into(),
            smtp: Some(SmtpConfig { host: host.into(), port, tls, username: USER.into(), password: PASSWORD.into(), ca_pem: ca }),
            graph: None,
        }
    }

    fn graph_cfg(cloud: Cloud, credential: GraphCredential) -> MailConfig {
        MailConfig {
            mode: Mode::Graph,
            from: "relay@acme.example".into(),
            smtp: None,
            graph: Some(GraphConfig { cloud, tenant: TENANT.into(), client_id: CLIENT.into(), mailbox: "relay@acme.example".into(), credential }),
        }
    }

    fn failed_lines(lines: &Mutex<Vec<String>>) -> Vec<String> {
        lines.lock().iter().filter(|x| x.contains("\"event\":\"console.mail-failed\"")).cloned().collect()
    }

    /// What the test SMTP server offers: STARTTLS in plain text, implicit TLS, the AUTH mechanisms, and how many
    /// sessions refuse the recipient (451) before it accepts.
    #[derive(Clone, Copy)]
    struct Plan {
        starttls: bool,
        implicit: bool,
        auth: &'static str,
        fail: usize,
    }

    const STARTTLS_PLAN: Plan = Plan { starttls: true, implicit: false, auth: "PLAIN LOGIN", fail: 0 };

    /// Every command ("plain ..." or "tls ...") and every message the server took.
    #[derive(Default)]
    struct Seen {
        sessions: usize,
        commands: Vec<String>,
        mails: Vec<String>,
    }

    async fn say<S: AsyncRead + AsyncWrite + Unpin>(r: &mut BufReader<S>, words: &str) -> std::io::Result<()> {
        r.get_mut().write_all(format!("{words}\r\n").as_bytes()).await?;
        r.get_mut().flush().await
    }

    async fn read_one<S: AsyncRead + AsyncWrite + Unpin>(r: &mut BufReader<S>) -> std::io::Result<String> {
        let mut l = String::new();
        r.read_line(&mut l).await?;
        Ok(l.trim_end().to_owned())
    }

    /// One SMTP session; Some(connection) when the client asked for STARTTLS.
    async fn smtp_session<S: AsyncRead + AsyncWrite + Unpin>(io: S, tls: bool, greet: bool, plan: Plan, seen: &Mutex<Seen>, fail: bool) -> std::io::Result<Option<S>> {
        let mut r = BufReader::new(io);
        if greet {
            say(&mut r, "220 mail.test ESMTP").await?;
        }
        loop {
            let mut line = String::new();
            if r.read_line(&mut line).await? == 0 {
                return Ok(None);
            }
            let line = line.trim_end().to_owned();
            seen.lock().commands.push(format!("{} {line}", if tls { "tls" } else { "plain" }));
            let up = line.to_ascii_uppercase();
            if up.starts_with("EHLO ") {
                let starttls = if !tls && plan.starttls { "250-STARTTLS\r\n" } else { "" };
                say(&mut r, &format!("250-mail.test\r\n{starttls}250 AUTH {}", plan.auth)).await?;
            } else if up == "STARTTLS" {
                say(&mut r, "220 2.0.0 ready").await?;
                return Ok(Some(r.into_inner()));
            } else if let Some(token) = line.strip_prefix("AUTH PLAIN ") {
                let ok = b64_decode_lenient(token) == format!("\0{USER}\0{PASSWORD}").into_bytes();
                say(&mut r, if ok { "235 2.7.0 ok" } else { "535 5.7.8 bad credentials" }).await?;
            } else if up == "AUTH LOGIN" {
                say(&mut r, "334 VXNlcm5hbWU6").await?;
                let user = read_one(&mut r).await?;
                say(&mut r, "334 UGFzc3dvcmQ6").await?;
                let pass = read_one(&mut r).await?;
                let ok = b64_decode_lenient(&user) == USER.as_bytes() && b64_decode_lenient(&pass) == PASSWORD.as_bytes();
                say(&mut r, if ok { "235 2.7.0 ok" } else { "535 5.7.8 bad credentials" }).await?;
            } else if up.starts_with("MAIL FROM:") {
                say(&mut r, "250 2.1.0 ok").await?;
            } else if up.starts_with("RCPT TO:") {
                say(&mut r, if fail { "451 4.3.0 try again later" } else { "250 2.1.5 ok" }).await?;
            } else if up == "DATA" {
                say(&mut r, "354 go ahead").await?;
                let mut data = String::new();
                loop {
                    let mut l = String::new();
                    if r.read_line(&mut l).await? == 0 {
                        return Ok(None);
                    }
                    if l == ".\r\n" {
                        break;
                    }
                    // RFC 5321 4.5.2: a server takes one leading dot away.
                    data.push_str(l.strip_prefix('.').unwrap_or(&l));
                }
                seen.lock().mails.push(data);
                say(&mut r, "250 2.0.0 queued").await?;
            } else if up == "QUIT" {
                say(&mut r, "221 2.0.0 bye").await?;
                return Ok(None);
            } else {
                say(&mut r, "502 5.5.2 not here").await?;
            }
        }
    }

    async fn smtp_server(listener: TcpListener, acceptor: tokio_rustls::TlsAcceptor, plan: Plan, seen: Arc<Mutex<Seen>>) {
        while let Ok((tcp, _)) = listener.accept().await {
            let (acceptor, seen) = (acceptor.clone(), seen.clone());
            tokio::spawn(async move {
                let fail = {
                    let mut s = seen.lock();
                    s.sessions += 1;
                    s.sessions <= plan.fail
                };
                if plan.implicit {
                    if let Ok(tls) = acceptor.accept(tcp).await {
                        let _ = smtp_session(tls, true, true, plan, &seen, fail).await;
                    }
                } else if let Ok(Some(tcp)) = smtp_session(tcp, false, true, plan, &seen, fail).await {
                    if let Ok(tls) = acceptor.accept(tcp).await {
                        let _ = smtp_session(tls, true, false, plan, &seen, fail).await;
                    }
                }
            });
        }
    }

    /// A test SMTP server reached as `host`, its certificate naming `names`: (port, certificate PEM, what it saw).
    fn start_smtp(rt: &Runtime, host: &str, names: &[&str], plan: Plan) -> (u16, String, Arc<Mutex<Seen>>) {
        let (cert, key) = tls_cert(names);
        let acceptor = crate::server::tls_acceptor(&cert, &key).unwrap();
        let (listener, port) = listen(rt);
        let seen = Arc::new(Mutex::new(Seen::default()));
        rt.spawn(smtp_server(listener, acceptor, plan, seen.clone()));
        test_net::add_route(host, port, local(port));
        (port, cert, seen)
    }

    /// Accepts and never answers.
    async fn hold(listener: TcpListener, accepted: std::sync::mpsc::Sender<()>) {
        let mut held = Vec::new();
        while let Ok((s, _)) = listener.accept().await {
            held.push(s);
            let _ = accepted.send(());
        }
    }

    /// A fake Microsoft sign-in and Graph: client credentials (a client secret or a checked RS256 assertion), then
    /// `sendMail` with the token it gave.
    struct Fake {
        rsa_pub: Vec<u8>,
        thumb: String,
        seen: Mutex<Vec<Value>>,
    }

    fn pct_decode(s: &str) -> String {
        let b = s.as_bytes();
        let mut out = Vec::new();
        let mut i = 0;
        while i < b.len() {
            if b[i] == b'%' && i + 3 <= b.len() {
                if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                    out.push(v);
                    i += 3;
                    continue;
                }
            }
            out.push(if b[i] == b'+' { b' ' } else { b[i] });
            i += 1;
        }
        String::from_utf8_lossy(&out).into_owned()
    }

    fn form_of(body: &[u8]) -> Vec<(String, String)> {
        utf8_lossy(body).split('&').filter_map(|p| p.split_once('=')).map(|(k, v)| (pct_decode(k), pct_decode(v))).collect()
    }

    /// The client assertion as Entra checks it: header, claims for this sign-in host, and the RS256 signature by the
    /// certificate's key.
    fn check_assertion(f: &Fake, host: &str, jwt: &str) -> Result<(), String> {
        let parts: Vec<&str> = jwt.split('.').collect();
        if parts.len() != 3 {
            return Err("not three parts".into());
        }
        let json_of = |p: &str| unb64u(p).and_then(|b| parse_json(&utf8_lossy(&b))).ok_or_else(|| "not JSON".to_string());
        let header = json_of(parts[0])?;
        let claims = json_of(parts[1])?;
        if header != json!({ "alg": "RS256", "typ": "JWT", "x5t#S256": f.thumb }) {
            return Err(format!("header {header}"));
        }
        let num = |k: &str| claims.get(k).and_then(Value::as_i64).ok_or_else(|| format!("claim {k}"));
        let (nbf, iat, exp) = (num("nbf")?, num("iat")?, num("exp")?);
        let now = now_ms() / 1000;
        if claims["aud"] != format!("https://{host}/{TENANT}/oauth2/v2.0/token") || claims["iss"] != CLIENT || claims["sub"] != CLIENT {
            return Err(format!("claims {claims}"));
        }
        if claims["jti"].as_str().is_none_or(str::is_empty) || nbf > now + 5 || iat > now + 5 || exp <= now || exp - nbf > 600 {
            return Err(format!("claims {claims}"));
        }
        let sig = unb64u(parts[2]).ok_or("signature encoding")?;
        UnparsedPublicKey::new(&RSA_PKCS1_2048_8192_SHA256, &f.rsa_pub).verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &sig).map_err(|_| "signature".to_string())
    }

    async fn fake_graph(f: Arc<Fake>, req: hyper::Request<hyper::body::Incoming>) -> hyper::Response<Full<Bytes>> {
        let host = req.headers().get("host").and_then(|v| v.to_str().ok()).unwrap_or("").to_owned();
        let path = req.uri().path().to_owned();
        let auth = req.headers().get("authorization").and_then(|v| v.to_str().ok()).unwrap_or("").to_owned();
        let body = req.into_body().collect().await.map(|b| b.to_bytes()).unwrap_or_default();
        let json_reply = |status: u16, v: Value| hyper::Response::builder().status(status).header("content-type", "application/json").body(Full::new(Bytes::from(stringify(&v)))).unwrap();
        if path.ends_with("/oauth2/v2.0/token") {
            let form = form_of(&body);
            let get = |k: &str| form.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
            let assertion = get("client_assertion").map(|a| check_assertion(&f, &host, &a));
            let credential_ok = match &assertion {
                Some(r) => r.is_ok() && get("client_assertion_type").as_deref() == Some(ASSERTION_TYPE),
                None => get("client_secret").as_deref() == Some(SECRET),
            };
            let ok = credential_ok && path == format!("/{TENANT}/oauth2/v2.0/token") && get("grant_type").as_deref() == Some("client_credentials") && get("client_id").as_deref() == Some(CLIENT);
            let assertion = assertion.map(|r| r.err().unwrap_or_else(|| "ok".to_owned()));
            f.seen.lock().push(json!({ "host": host, "kind": "token", "scope": get("scope"), "assertion": assertion, "ok": ok }));
            if ok {
                json_reply(200, json!({ "token_type": "Bearer", "expires_in": 3599, "access_token": format!("tok-{host}") }))
            } else {
                json_reply(401, json!({ "error": "invalid_client", "error_description": "AADSTS7000215: Invalid client secret provided.\r\nTrace ID: 0" }))
            }
        } else {
            let message = serde_json::from_slice::<Value>(&body).unwrap_or(Value::Null);
            f.seen.lock().push(json!({ "host": host, "kind": "send", "path": path, "auth": auth, "message": message }));
            hyper::Response::builder().status(if auth.starts_with("Bearer tok-") { 202 } else { 401 }).body(Full::new(Bytes::new())).unwrap()
        }
    }

    async fn serve_fake(listener: TcpListener, acceptor: tokio_rustls::TlsAcceptor, f: Arc<Fake>) {
        while let Ok((tcp, _)) = listener.accept().await {
            let (acceptor, f) = (acceptor.clone(), f.clone());
            tokio::spawn(async move {
                let Ok(tls) = acceptor.accept(tcp).await else { return };
                let svc = hyper::service::service_fn(move |req| {
                    let f = f.clone();
                    async move { Ok::<_, Infallible>(fake_graph(f, req).await) }
                });
                let _ = hyper::server::conn::http1::Builder::new().serve_connection(TokioIo::new(tls), svc).await;
            });
        }
    }

    // ── Words ──

    #[test]
    fn mail_words_match_the_words_vector_and_render_from_it() {
        let w = vector("admin_console_words_v1.json");
        let mail = w["mail"].as_object().expect("the words vector has no \"mail\"");
        let mut ours: Vec<&str> = MAIL_WORDS.iter().map(|(id, _, _)| *id).collect();
        ours.push("mail.footer");
        let mut theirs: Vec<&str> = mail.keys().map(String::as_str).collect();
        ours.sort_unstable();
        theirs.sort_unstable();
        assert_eq!(ours, theirs, "the 8.4 mail ids");
        assert!(mail["mail.footer"]["subject"].is_null());
        assert_eq!(mail["mail.footer"]["body"], FOOTER);
        for (id, subject, body) in MAIL_WORDS {
            assert_eq!(mail[id]["subject"], subject, "{id}");
            assert_eq!(mail[id]["body"], body, "{id}");
        }

        // Every mail rendered equals the vector's words filled with the same values, footer included.
        let args = sample();
        let value = |name: &str| -> String {
            match name {
                "host" => HOST.to_owned(),
                "console" => CONSOLE.to_owned(),
                _ => args.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone()).unwrap(),
            }
        };
        let footer = test_fill(mail["mail.footer"]["body"].as_str().unwrap(), &value);
        for (id, _, _) in MAIL_WORDS {
            let (subject, body) = render(id, HOST, CONSOLE, &refs(&args)).unwrap();
            assert_eq!(subject, test_fill(mail[id]["subject"].as_str().unwrap(), &value), "{id}");
            assert_eq!(body, format!("{}{footer}", test_fill(mail[id]["body"].as_str().unwrap(), &value)), "{id}");
        }
    }

    #[test]
    fn every_kind_renders_safely_and_no_word_has_a_long_dash() {
        let dashes = ['\u{2014}', '\u{2013}'];
        let mut words: Vec<&str> = vec![FOOTER, DISPLAY_NAME];
        for (id, s, b) in MAIL_WORDS {
            words.extend([id, s, b]);
        }
        for w in &words {
            assert!(!w.contains(&dashes[..]), "{w}");
        }
        assert!(!include_str!("console_mail.rs").contains(&dashes[..]));

        let args = sample();
        for (id, _, _) in MAIL_WORDS {
            let (subject, body) = render(id, HOST, CONSOLE, &refs(&args)).unwrap_or_else(|| panic!("{id}"));
            assert!(header_value_ok(&subject), "{id}");
            assert!(!body.contains('\r'), "{id}");
            assert!(body.ends_with(&FOOTER.replace("<host>", HOST)), "{id}");
            // No 8.4 word carries a password, session, step-up, TOTP, license token or reset-sign-in placeholder.
            assert!(!body.contains(PASSWORD) && !subject.contains(PASSWORD), "{id}");
        }
        assert_eq!(render("mail.nope", HOST, CONSOLE, &refs(&args)), None);
        assert_eq!(render("mail.invite", HOST, CONSOLE, &[("inviter", "Ann".to_owned()), ("time", "soon".to_owned())]), None, "a missing link");
        // A subject argument (or host) with a line break refuses the mail.
        let mut a = sample();
        set(&mut a, "license id", "l_1\r\nBcc: eve@acme.example");
        assert_eq!(render("mail.seats-request", HOST, CONSOLE, &refs(&a)), None);
        assert_eq!(render("mail.break-glass", "relay\n.acme.example", CONSOLE, &refs(&args)), None);
        let mut a = sample();
        set(&mut a, "seated", "25\u{2028}");
        assert_eq!(render("mail.seats-over", HOST, CONSOLE, &refs(&a)), None);
        // Untrusted words stay in the body, on their line.
        let mut a = sample();
        set(&mut a, "org", "Acme\r\nBcc: eve@acme.example\u{2028}x\u{202e}");
        let (subject, body) = render("mail.seats-request", HOST, CONSOLE, &refs(&a)).unwrap();
        assert_eq!(subject, "Meeting Hub seat request, license l_0123456789abcdef");
        assert!(body.starts_with("Organization: Acme  Bcc: eve@acme.example x\nLicense ID: "), "{body}");
        // Remote Spokes and Meeting Hub license mails.
        let mut a = sample();
        set(&mut a, "product", "Remote Spokes");
        set(&mut a, "section", "spokes");
        let (subject, body) = render("mail.license-stopped", HOST, CONSOLE, &refs(&a)).unwrap();
        assert_eq!(subject, "Remote Spokes on relay.acme.example has stopped serving people");
        assert!(body.starts_with("This relay stopped serving people on 2026-12-03 10:00 UTC because its Remote Spokes license is not active (no license is installed). The Admin Console still works.\n\nInstall a license to turn service back on: https://console.acme.example/console/#/spokes/license"), "{body}");
        set(&mut a, "section", "elsewhere");
        assert_eq!(render("mail.license-stopped", HOST, CONSOLE, &refs(&a)), None);
        // The page's copy of a seat request has no footer.
        let (_, words_only) = render_words("mail.seats-request", HOST, CONSOLE, &refs(&args)).unwrap();
        assert!(words_only.ends_with("Sent from the Lucid Admin Console on 2026-11-18 10:00 UTC."));
    }

    // ── Header safety and encodings ──

    #[test]
    fn messages_keep_headers_safe_and_bodies_quoted_printable() {
        let t = crate::meet_json::days_from_civil(2026, 11, 17) * 86_400_000 + (9 * 3600 + 5 * 60 + 7) * 1000;
        let msg = build_message("relay@ACME.example", "bob@acme.example", "H\u{e9}llo", "a.\n.b \nc=d", t, "<id1@acme.example>").unwrap();
        assert_eq!(
            String::from_utf8(msg.clone()).unwrap(),
            "From: \"Lucid Admin Console\" <relay@acme.example>\r\nTo: bob@acme.example\r\nSubject: =?UTF-8?B?SMOpbGxv?=\r\nDate: Tue, 17 Nov 2026 09:05:07 +0000\r\nMessage-ID: <id1@acme.example>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\na.\r\n.b=20\r\nc=3Dd\r\n"
        );
        assert!(String::from_utf8(dot_stuff(&msg)).unwrap().ends_with("\r\n\r\na.\r\n..b=20\r\nc=3Dd\r\n"));
        assert_eq!(dot_stuff(b".a\r\n.\r\nb\n.c"), b"..a\r\n..\r\nb\n.c".to_vec());
        assert_eq!(build_message("relay@acme.example", "bob@acme.example", "Hi\r\nBcc: eve@acme.example", "x", t, "<a@b.example>"), Err("invalid"));
        assert_eq!(build_message("relay@acme.example", "bob@acme.example\r\nBcc: eve@acme.example", "Hi", "x", t, "<a@b.example>"), Err("bad-mailbox"));
        assert_eq!(build_message("\"Eve\" <relay@acme.example>", "bob@acme.example", "Hi", "x", t, "<a@b.example>"), Err("bad-mailbox"));
        assert_eq!(build_message("relay@acme.example", "bob@acme.example", "Hi", "x", t, "<a@b.example>\r\nBcc: x"), Err("invalid"));
        assert_eq!(rfc5322_date(0), "Thu, 01 Jan 1970 00:00:00 +0000");
        // Folding and encoded words keep every line at 78 or fewer.
        let long = "word ".repeat(30);
        let folded = header("Subject", long.trim_end());
        assert!(folded.split("\r\n").all(|l| l.len() <= 78) && folded.contains("\r\n "), "{folded}");
        let wide = "\u{e9}t\u{e9} ".repeat(20);
        let encoded = header("Subject", &wide);
        assert!(encoded.split("\r\n").all(|l| l.len() <= 78 && (l.starts_with(" =?UTF-8?B?") || l.starts_with("Subject: =?UTF-8?B?"))), "{encoded}");
        // Quoted-printable lines stay at 76 or fewer.
        let qp = quoted_printable(&"x".repeat(200));
        assert!(qp.split("\r\n").all(|l| l.len() <= 76), "{qp}");
        assert_eq!(qp_decode(&qp), format!("{}\r\n", "x".repeat(200)));
        // Strict mailboxes.
        for good in ["a@b.example", "first.last+tag@sub.example.org", "x@xn--bcher-kva.example", "o'neil@acme.example"] {
            assert!(parse_mailbox(good).is_ok(), "{good}");
        }
        for bad in ["", "a@b", "a@localhost", "\"a\"@b.example", "a..b@c.example", ".a@b.example", "a.@b.example", "a@-b.example", "a@b-.example", "a@b.example.", "a b@c.example", "a@b.example\r\n", "(c)a@b.example", "a@[127.0.0.1]", "j\u{f6}@b.example", "a@b@c.example", "a@b..example"] {
            assert!(parse_mailbox(bad).is_err(), "{bad:?}");
        }
        assert!(parse_mailbox(&format!("{}@b.example", "a".repeat(65))).is_err());
        assert!(parse_mailbox(&format!("a@{}.example", "b".repeat(64))).is_err());
        assert_eq!(parse_mailbox("Ann@ACME.Example"), Ok("Ann@acme.example".to_owned()));
        assert_eq!(graph_path_segment("a/b?c#d%e@f.example"), "a%2Fb%3Fc%23d%25e%40f.example");
        assert_eq!(send_mail_url(Cloud::UsGovDod, "relay@acme.example"), "https://dod-graph.microsoft.us/v1.0/users/relay%40acme.example/sendMail");
        assert!(header_value_ok("plain words, \u{e9}t\u{e9}") && !header_value_ok("a\u{85}b") && !header_value_ok("a\u{2029}b") && !header_value_ok("a\tb") && !header_value_ok("a\u{7f}"));
    }

    #[test]
    fn mail_vector_mailboxes_encodings_and_graph_paths() {
        let v = vector("admin_console_mail_v1.json");
        for c in arr(&v["mailbox"]) {
            let input = c["in"].as_str().unwrap();
            assert_eq!(parse_mailbox(input).is_ok(), c["ok"].as_bool().unwrap(), "mailbox {input:?}");
        }
        for c in arr(&v["fold"]).iter().chain(arr(&v["encoded_words"])) {
            let (input, out) = (c["in"].as_str().unwrap(), c["out"].as_str().unwrap());
            let name = out.split_once(": ").unwrap().0;
            assert_eq!(header(name, input), out, "{}", c["name"]);
        }
        for c in arr(&v["qp"]) {
            assert_eq!(quoted_printable(c["in"].as_str().unwrap()), c["out"].as_str().unwrap(), "qp {}", c["in"]);
        }
        for c in arr(&v["dot_stuff"]) {
            assert_eq!(dot_stuff(c["in"].as_str().unwrap().as_bytes()), c["out"].as_str().unwrap().as_bytes(), "dot-stuff {}", c["in"]);
        }
        for c in arr(&v["graph_path"]) {
            let m = c["mailbox"].as_str().unwrap();
            assert_eq!(graph_path_segment(m), c["segment"].as_str().unwrap(), "{m}");
            for cloud in [Cloud::Commercial, Cloud::UsGov, Cloud::UsGovDod] {
                assert_eq!(send_mail_url(cloud, m), c["urls"][cloud.as_str()].as_str().unwrap(), "{m} {cloud:?}");
            }
        }
        for c in arr(&v["subjects"]) {
            let id = c["id"].as_str().unwrap();
            let mut a = sample();
            let mut host = HOST.to_owned();
            for (k, val) in c["args"].as_object().unwrap() {
                let val = text(val);
                match k.as_str() {
                    "host" => host = val,
                    _ => set(&mut a, k, &val),
                }
            }
            let (subject, _) = render(id, &host, CONSOLE, &refs(&a)).unwrap_or_else(|| panic!("{id}"));
            assert_eq!(header("Subject", &subject), c["header"].as_str().unwrap(), "{id}");
        }
    }

    #[test]
    fn mail_vector_header_values_are_refused_or_kept_out_of_headers() {
        let v = vector("admin_console_mail_v1.json");
        let t = crate::meet_json::days_from_civil(2026, 11, 17) * 86_400_000;
        for c in arr(&v["header"]) {
            let field = c["field"].as_str().unwrap();
            let value = c["value"].as_str().unwrap();
            let ok = c["ok"].as_bool().unwrap();
            let code = c["code"].as_str();
            let why = format!("{field} {value:?}");
            match field {
                "to" => {
                    let built = build_message("relay@acme.example", value, "Hello", "Hi", t, "<a@acme.example>");
                    assert_eq!(built.is_ok(), ok, "{why}");
                    if let Err(e) = built {
                        assert_eq!(Some(e), code, "{why}");
                    }
                }
                "licenseRequestTo" => {
                    assert_eq!(parse_mailbox(value).is_ok(), ok, "{why}");
                    if !ok {
                        assert_eq!(code, Some(BAD_MAILBOX), "{why}");
                    }
                }
                f if f.contains(':') => {
                    let (id, ph) = f.split_once(':').unwrap();
                    let mut a = sample();
                    let mut host = HOST.to_owned();
                    match ph {
                        "host" => host = value.to_owned(),
                        _ => set(&mut a, ph, value),
                    }
                    match render(id, &host, CONSOLE, &refs(&a)) {
                        Some((subject, _)) => {
                            assert!(ok, "{why}: rendered {subject:?}");
                            assert!(!header("Subject", &subject).replace("\r\n ", " ").contains(&['\r', '\n', '\0'][..]), "{why}");
                        }
                        None => assert!(!ok, "{why}: refused"),
                    }
                }
                _ => {
                    let got = MailConfig::from_body_why(&body_with(field, value), &MailConfig::off(), false);
                    assert_eq!(got.is_ok(), ok, "{why}");
                    if let Err((e, _)) = got {
                        assert_eq!(e, code.unwrap_or(INVALID), "{why}");
                    }
                }
            }
        }
    }

    // ── Settings ──

    #[test]
    fn settings_keep_secrets_out_round_trip_and_name_changes() {
        let (cert, key, _) = rsa_credential();
        let body = json!({
            "mode": "graph",
            "from": "Relay@ACME.example",
            "smtp": { "host": "smtp.acme.example", "tls": "implicit", "username": USER, "password": PASSWORD },
            "graph": { "cloud": "usgov-dod", "tenant": "contoso.onmicrosoft.us", "clientId": CLIENT, "mailbox": "relay@acme.example", "credential": "certificate", "certificatePem": cert, "keyPem": key },
            "reason": "new mail server",
            "stepup": {}
        });
        let cfg = MailConfig::from_body(&body, &MailConfig::off(), true).unwrap();
        assert_eq!((cfg.mode, cfg.from.as_str()), (Mode::Graph, "Relay@acme.example"));
        assert_eq!(cfg.smtp.as_ref().map(|s| (s.port, s.tls)), Some((465, SmtpTls::Implicit)));
        let settings = cfg.to_settings();
        let view = cfg.view();
        for shown in [stringify(&settings), stringify(&view)] {
            assert!(!shown.contains(PASSWORD) && !shown.contains("PRIVATE KEY"), "{shown}");
        }
        assert_eq!(view["smtp"]["passwordSet"], true);
        assert_eq!(view["graph"], json!({ "cloud": "usgov-dod", "tenant": "contoso.onmicrosoft.us", "clientId": CLIENT, "mailbox": "relay@acme.example", "credential": "certificate", "credentialSet": true }));
        let secrets = cfg.secrets();
        assert_eq!(secrets.iter().map(|(n, _)| *n).collect::<Vec<_>>(), vec![SMTP_PASSWORD, GRAPH_KEY]);
        let unsealed = |n: &str| secrets.iter().find(|(k, _)| *k == n).map(|(_, v)| v.clone());
        let back = MailConfig::from_settings(&settings, &unsealed);
        assert_eq!(back.mode, Mode::Graph);
        assert!(back.changed(&cfg).is_empty(), "{:?}", back.changed(&cfg));
        // The secrets lost (seal-lost): what cannot send reads back off.
        assert_eq!(MailConfig::from_settings(&settings, &|_: &str| -> Option<String> { None }).mode, Mode::Off);
        // Empty secrets keep the stored ones; a change names fields, never secret values.
        let mut kept = body.clone();
        kept["smtp"]["password"] = json!("");
        kept["graph"]["keyPem"] = json!("");
        kept["graph"]["certificatePem"] = json!("");
        kept["smtp"]["port"] = json!(2465);
        let kept = MailConfig::from_body(&kept, &cfg, true).unwrap();
        assert_eq!(cfg.changed(&kept), vec!["smtp.port".to_owned()]);
        let mut fresh = body.clone();
        fresh["smtp"]["password"] = json!("pw-NEW-4");
        let changed = cfg.changed(&MailConfig::from_body(&fresh, &cfg, true).unwrap());
        assert_eq!(changed, vec!["smtp.password".to_owned()]);
        assert_eq!(cfg.changed(&MailConfig::from_body(&json!({ "mode": "off" }), &cfg, true).unwrap()), vec!["mode".to_owned()]);
        // A key that does not fit its certificate, a bad root, a bad sender.
        let (other_cert, _, _) = rsa_credential();
        let mut mismatched = body.clone();
        mismatched["graph"]["certificatePem"] = json!(other_cert);
        assert_eq!(MailConfig::from_body(&mismatched, &MailConfig::off(), true).err(), Some("invalid"));
        let mut root = body.clone();
        root["smtp"]["caPem"] = json!("-----BEGIN CERTIFICATE-----\nnot one\n-----END CERTIFICATE-----\n");
        assert_eq!(MailConfig::from_body(&root, &MailConfig::off(), true).err(), Some("invalid"));
        let sender = json!({ "mode": "smtp", "from": "relay@acme.example\nBcc: eve@acme.example", "smtp": body["smtp"] });
        assert_eq!(MailConfig::from_body_why(&sender, &MailConfig::off(), true).err(), Some(("bad-mailbox", "Sender address".to_owned())));
        let mut mailbox = body.clone();
        mailbox["graph"]["mailbox"] = json!("relay@acme");
        assert_eq!(MailConfig::from_body_why(&mailbox, &MailConfig::off(), true).err(), Some(("bad-mailbox", "Mailbox".to_owned())));
        // Under High a client secret is refused, new or kept.
        let secret = json!({ "mode": "graph", "from": "relay@acme.example", "graph": { "cloud": "commercial", "tenant": TENANT, "clientId": CLIENT, "mailbox": "relay@acme.example", "credential": "secret", "secret": SECRET } });
        assert_eq!(MailConfig::from_body(&secret, &MailConfig::off(), true).err(), Some("mail-secret-high"));
        let standard = MailConfig::from_body(&secret, &MailConfig::off(), false).unwrap();
        assert_eq!(standard.secrets(), vec![(GRAPH_SECRET, SECRET.to_owned())]);
        assert_eq!(MailConfig::from_body(&json!({ "mode": "graph" }), &standard, true).err(), Some("mail-secret-high"));
        assert!(!stringify(&standard.view()).contains(SECRET) && !stringify(&standard.to_settings()).contains(SECRET));
        // Mail on needs a sender and its section.
        assert_eq!(MailConfig::from_body(&json!({ "mode": "smtp", "smtp": body["smtp"] }), &MailConfig::off(), false).err(), Some("bad-mailbox"));
        assert_eq!(MailConfig::from_body(&json!({ "mode": "smtp", "from": "relay@acme.example" }), &MailConfig::off(), false).err(), Some("invalid"));
        assert_eq!(MailConfig::from_body(&json!({ "mode": "smtp", "extra": 1 }), &MailConfig::off(), false).err(), Some("invalid"));
    }

    // ── SMTP ──

    #[test]
    fn smtp_delivers_with_starttls_and_implicit_tls_and_authenticates_only_inside_tls() {
        let rt = runtime();
        let (m, lines) = mailer();
        let (port, cert, seen) = start_smtp(&rt, "mail-starttls.test", &["mail-starttls.test"], STARTTLS_PLAN);
        let cfg = smtp_cfg("mail-starttls.test", port, SmtpTls::StartTls, Some(cert));
        assert_eq!(m.send_now(&cfg, "mail.test", "Ann@ACME.example", &[]), Ok(()));
        {
            let s = seen.lock();
            let plain: Vec<&str> = s.commands.iter().filter(|c| c.starts_with("plain ")).map(String::as_str).collect();
            assert_eq!(plain, vec!["plain EHLO relay.acme.example", "plain STARTTLS"]);
            assert!(s.commands.iter().any(|c| c.starts_with("tls AUTH PLAIN ")));
            assert!(s.commands.contains(&"tls MAIL FROM:<relay@acme.example>".to_owned()));
            assert!(s.commands.contains(&"tls RCPT TO:<Ann@acme.example>".to_owned()));
            assert_eq!(s.mails.len(), 1);
            let (head, body) = s.mails[0].split_once("\r\n\r\n").unwrap();
            assert!(head.starts_with("From: \"Lucid Admin Console\" <relay@acme.example>\r\nTo: Ann@acme.example\r\nSubject: Test email from the Lucid Admin Console\r\nDate: "), "{head}");
            assert!(head.ends_with("MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable"), "{head}");
            assert!(s.mails[0].split("\r\n").all(|l| l.len() <= 78));
            assert_eq!(qp_decode(body), format!("This is a test from the Lucid Admin Console at {HOST}. Email works.\r\n\r\nThis message was sent by the Lucid Admin Console at {HOST}. It never asks for your password or a code.\r\n"));
            assert!(!s.mails[0].contains(PASSWORD));
        }
        // Implicit TLS on a server that offers only AUTH LOGIN.
        let implicit = Plan { starttls: false, implicit: true, auth: "LOGIN", fail: 0 };
        let (port, cert, seen) = start_smtp(&rt, "mail-implicit.test", &["mail-implicit.test"], implicit);
        assert_eq!(m.send_now(&smtp_cfg("mail-implicit.test", port, SmtpTls::Implicit, Some(cert)), "mail.reseated", "ann@acme.example", &[]), Ok(()));
        {
            let s = seen.lock();
            assert!(s.commands.iter().all(|c| c.starts_with("tls ")), "{:?}", s.commands);
            assert!(s.commands.contains(&"tls AUTH LOGIN".to_owned()));
            assert_eq!(s.mails.len(), 1);
            assert!(s.mails[0].contains("Subject: Your Meeting Hub seat is back\r\n"));
        }
        // A wrong password: the server's answer comes back, never the password.
        let (port, cert, _) = start_smtp(&rt, "mail-auth.test", &["mail-auth.test"], STARTTLS_PLAN);
        let mut wrong = smtp_cfg("mail-auth.test", port, SmtpTls::StartTls, Some(cert));
        if let Some(s) = wrong.smtp.as_mut() {
            s.password = "pw-WRONG-5".into();
        }
        assert_eq!(m.send_now(&wrong, "mail.test", "ann@acme.example", &[]), Err("535 5.7.8 bad credentials".to_owned()));
        assert!(!lines.lock().iter().any(|l| l.contains(PASSWORD) || l.contains("pw-WRONG-5")));
        assert_eq!(m.config().mode, Mode::Off, "send_now never touches the configuration in force");
    }

    #[test]
    fn smtp_refuses_a_server_without_starttls_and_certificates_that_do_not_verify() {
        let rt = runtime();
        let (m, lines) = mailer();
        let no_starttls = Plan { starttls: false, implicit: false, auth: "PLAIN", fail: 0 };
        let (port, cert, seen) = start_smtp(&rt, "mail-plain.test", &["mail-plain.test"], no_starttls);
        let err = m.send_now(&smtp_cfg("mail-plain.test", port, SmtpTls::StartTls, Some(cert)), "mail.test", "ann@acme.example", &[]).unwrap_err();
        assert!(err.contains("STARTTLS"), "{err}");
        wait_until("the server to see the client leave", || seen.lock().sessions == 1);
        {
            let s = seen.lock();
            assert_eq!(s.commands, vec!["plain EHLO relay.acme.example".to_owned()], "no AUTH, no MAIL in plain text");
            assert!(s.mails.is_empty());
        }
        // A root that did not issue the server's certificate.
        let (port, _, seen) = start_smtp(&rt, "mail-untrusted.test", &["mail-untrusted.test"], STARTTLS_PLAN);
        let (other_root, _) = tls_cert(&["other-root.test"]);
        let err = m.send_now(&smtp_cfg("mail-untrusted.test", port, SmtpTls::StartTls, Some(other_root)), "mail.test", "ann@acme.example", &[]).unwrap_err();
        assert!(err.contains("certificate"), "{err}");
        assert!(seen.lock().commands.iter().all(|c| c.starts_with("plain ")), "nothing after a failed handshake");
        assert!(seen.lock().mails.is_empty());
        // A certificate that does not name the host.
        let implicit = Plan { starttls: false, implicit: true, auth: "PLAIN", fail: 0 };
        let (port, cert, seen) = start_smtp(&rt, "mail-wrongname.test", &["elsewhere.test"], implicit);
        let err = m.send_now(&smtp_cfg("mail-wrongname.test", port, SmtpTls::Implicit, Some(cert)), "mail.test", "ann@acme.example", &[]).unwrap_err();
        assert!(err.contains("certificate"), "{err}");
        assert!(seen.lock().commands.is_empty());
        let failed = failed_lines(&lines);
        assert_eq!(failed.len(), 3, "{failed:?}");
        assert!(!lines.lock().iter().any(|l| l.contains(PASSWORD)));
    }

    // ── Microsoft Graph ──

    #[test]
    fn graph_sends_through_each_cloud_with_a_checked_rs256_client_assertion() {
        let rt = runtime();
        let hosts = ["login.microsoftonline.com", "graph.microsoft.com", "login.microsoftonline.us", "graph.microsoft.us", "dod-graph.microsoft.us"];
        let (cert, key) = tls_cert(&hosts);
        let (cred_cert, cred_key, rsa_pub) = rsa_credential();
        let thumb = b64u(&sha256(&first_der(&cred_cert)));
        let f = Arc::new(Fake { rsa_pub, thumb, seen: Mutex::new(Vec::new()) });
        let (listener, port) = listen(&rt);
        rt.spawn(serve_fake(listener, crate::server::tls_acceptor(&cert, &key).unwrap(), f.clone()));
        test_net::add_root(&cert);
        for h in hosts {
            test_net::add_route(h, 443, local(port));
        }
        let (m, lines) = mailer();
        for (cloud, login, graph) in [(Cloud::Commercial, hosts[0], hosts[1]), (Cloud::UsGov, hosts[2], hosts[3]), (Cloud::UsGovDod, hosts[2], hosts[4])] {
            f.seen.lock().clear();
            let cfg = graph_cfg(cloud, GraphCredential::Certificate { cert_pem: cred_cert.clone(), key_pem: cred_key.clone() });
            assert_eq!(m.send_now(&cfg, "mail.test", "Ann@ACME.example", &[]), Ok(()), "{cloud:?}");
            let seen = f.seen.lock().clone();
            assert_eq!(seen.len(), 2, "{seen:?}");
            assert_eq!(seen[0]["host"], login);
            assert_eq!(seen[0]["kind"], "token");
            assert_eq!(seen[0]["scope"], format!("https://{graph}/.default"));
            assert_eq!(seen[0]["assertion"], "ok", "{cloud:?}");
            assert_eq!(seen[1]["host"], graph);
            assert_eq!(seen[1]["path"], "/v1.0/users/relay%40acme.example/sendMail");
            assert_eq!(seen[1]["auth"], format!("Bearer tok-{login}"));
            let msg = &seen[1]["message"];
            assert_eq!(msg["saveToSentItems"], false);
            assert_eq!(msg["message"]["subject"], "Test email from the Lucid Admin Console");
            assert_eq!(msg["message"]["body"]["contentType"], "Text");
            let content = format!("This is a test from the Lucid Admin Console at {HOST}. Email works.\n\nThis message was sent by the Lucid Admin Console at {HOST}. It never asks for your password or a code.");
            assert_eq!(msg["message"]["body"]["content"], content);
            assert_eq!(msg["message"]["toRecipients"], json!([{ "emailAddress": { "address": "Ann@acme.example" } }]));
            assert_eq!(msg["message"]["from"]["emailAddress"], json!({ "name": DISPLAY_NAME, "address": "relay@acme.example" }));
        }
        // A client secret (Standard), then a wrong one: Entra's answer, never the secret.
        let good = graph_cfg(Cloud::Commercial, GraphCredential::Secret(SECRET.into()));
        assert_eq!(m.send_now(&good, "mail.test", "ann@acme.example", &[]), Ok(()));
        let wrong = graph_cfg(Cloud::Commercial, GraphCredential::Secret("gs-WRONG-3".into()));
        let err = m.send_now(&wrong, "mail.test", "ann@acme.example", &[]).unwrap_err();
        assert!(err.contains("401 invalid_client: AADSTS7000215"), "{err}");
        assert!(!err.contains("Trace ID") && !err.contains("gs-"), "{err}");
        assert!(!lines.lock().iter().any(|l| l.contains("gs-") || l.contains("PRIVATE KEY") || l.contains("tok-")));
    }

    // ── The queue ──

    #[test]
    fn queued_mail_is_tried_three_times_and_three_failures_raise_failing() {
        let rt = runtime();
        let (m, lines) = mailer();
        let flaky = Plan { fail: 2, ..STARTTLS_PLAN };
        let (good_port, good_cert, seen) = start_smtp(&rt, "mail-retry.test", &["mail-retry.test"], flaky);
        let good = smtp_cfg("mail-retry.test", good_port, SmtpTls::StartTls, Some(good_cert));
        m.configure(good.clone());
        let invite = [("inviter", "Ann Admin".to_owned()), ("time", "2026-11-18 10:00 UTC".to_owned()), ("link", LINK.to_owned())];
        m.enqueue("mail.invite", "erin@acme.example", &invite);
        wait_until("the third try", || seen.lock().mails.len() == 1);
        let failed = failed_lines(&lines);
        assert_eq!(failed.len(), 2, "{failed:?}");
        assert!(failed[0].contains("\"attempt\":1") && failed[1].contains("\"attempt\":2"), "{failed:?}");
        assert!(failed.iter().all(|l| l.contains("451 4.3.0 try again later") && l.contains("\"final\":false")), "{failed:?}");
        assert!(!m.failing());
        assert!(seen.lock().mails[0].contains(LINK));
        assert!(!lines.lock().iter().any(|l| l.contains("LINK-TOKEN") || l.contains("invited you") || l.contains(PASSWORD)), "never the body or a link");

        // A server that always refuses: three tries, then mail-failing with its answer.
        let broken = Plan { fail: usize::MAX, ..STARTTLS_PLAN };
        let (port, cert, _) = start_smtp(&rt, "mail-broken.test", &["mail-broken.test"], broken);
        m.configure(smtp_cfg("mail-broken.test", port, SmtpTls::StartTls, Some(cert)));
        m.enqueue("mail.reseated", "erin@acme.example", &[]);
        wait_until("three failures", || m.failing());
        let failed = failed_lines(&lines);
        assert_eq!(failed.len(), 5, "{failed:?}");
        assert!(failed[4].contains("\"attempt\":3") && failed[4].contains("\"final\":true"), "{failed:?}");
        assert!(m.failing_reason().unwrap().contains("451"));
        wait_until("the queue to empty", || m.queued().is_empty());

        // The next delivery clears it.
        m.configure(good.clone());
        m.enqueue("mail.reseated", "erin@acme.example", &[]);
        wait_until("a delivery", || !m.failing());
        assert_eq!(m.failing_reason(), None);
        // A switch to High that turned a client secret off raises it at once, until mail goes through again.
        m.mark_failing();
        assert!(m.failing());
        assert_eq!(m.failing_reason().as_deref(), Some(SECRET_HIGH_REASON));
        m.enqueue("mail.reseated", "erin@acme.example", &[]);
        wait_until("a delivery", || !m.failing());
        assert_eq!(seen.lock().mails.len(), 3);
    }

    /// API-1 r5 6.3 (review P2): `enqueue_taken` is true only when a running sender took the mail, so a delegation
    /// notice is never marked sent by a mailer that cannot send it.
    #[test]
    fn enqueue_taken_needs_mail_on_and_a_running_sender() {
        let (m, _) = mailer();
        let args = [("client", "claude-ops".to_owned()), ("scopes", "monitor.read".to_owned()), ("date and time", "2026-11-24 10:00 UTC".to_owned())];
        assert!(!m.enqueue_taken("fleet.mail.delegation", "ann@acme.example", &args), "mail is off");
        m.configure(smtp_cfg("mail-taken.test", 25, SmtpTls::StartTls, None));
        m.capture();
        assert!(m.enqueue_taken("fleet.mail.delegation", "ann@acme.example", &args), "mail on and a sender running");
        assert_eq!(m.captured().len(), 1);
        // a mailer whose sender thread never started takes nothing
        let dead = Mailer { host: HOST.into(), console_url: CONSOLE.into(), inner: m.inner.clone(), handle: None };
        assert!(!dead.enqueue_taken("fleet.mail.delegation", "ann@acme.example", &args));
        assert_eq!(m.captured().len(), 1);
        // nor one that is closing (dropping a mailer closes its sender)
        drop(dead);
        assert!(!m.enqueue_taken("fleet.mail.delegation", "ann@acme.example", &args));
        assert_eq!(m.captured().len(), 1);
    }

    #[test]
    fn the_queue_keeps_the_newest_500_and_turning_mail_off_empties_it() {
        let rt = runtime();
        let (m, lines) = mailer();
        let (listener, port) = listen(&rt);
        let (tx, rx) = std::sync::mpsc::channel();
        rt.spawn(hold(listener, tx));
        test_net::add_route("mail-hold.test", port, local(port));
        m.configure(smtp_cfg("mail-hold.test", port, SmtpTls::StartTls, None));
        m.enqueue("mail.test", "u0@acme.example", &[]);
        rx.recv_timeout(Duration::from_secs(10)).expect("the sender connects");
        for i in 1..=502 {
            m.enqueue("mail.test", &format!("u{i}@acme.example"), &[]);
        }
        let q = m.queued();
        assert_eq!(q.len(), 500);
        assert_eq!((q[0].as_str(), q[499].as_str()), ("u3@acme.example", "u502@acme.example"));
        let dropped = lines.lock().iter().filter(|l| l.contains("\"event\":\"console.mail-dropped\"") && l.contains("\"why\":\"queue-full\"")).count();
        assert_eq!(dropped, 2);
        m.configure(MailConfig::off());
        assert!(m.queued().is_empty());
        assert!(lines.lock().iter().any(|l| l.contains("\"event\":\"console.mail-dropped\"") && l.contains("\"count\":500") && l.contains("\"why\":\"off\"")));
        m.enqueue("mail.test", "u9@acme.example", &[]);
        assert!(m.queued().is_empty(), "nothing is queued while mail is off");
    }

    #[test]
    fn license_reminders_never_evict_other_mail_and_coalesce() {
        // R7-L2: more than 500 active admins and repeated reminder passes
        let rt = runtime();
        let (m, lines) = mailer();
        let (listener, port) = listen(&rt);
        let (tx, rx) = std::sync::mpsc::channel();
        rt.spawn(hold(listener, tx));
        test_net::add_route("mail-hold-r.test", port, local(port));
        m.configure(smtp_cfg("mail-hold-r.test", port, SmtpTls::StartTls, None));
        m.enqueue("mail.test", "u0@acme.example", &[]);
        rx.recv_timeout(Duration::from_secs(10)).expect("the sender connects");
        let mut args = sample();
        set(&mut args, "section", "spokes");
        for i in 1..=450 {
            m.enqueue("mail.break-glass", &format!("s{i}@acme.example"), &refs(&args));
        }
        for _pass in 0..3 {
            for i in 0..600 {
                m.enqueue_reminder("mail.license-stopped", &format!("a{i}@acme.example"), &refs(&args));
            }
        }
        let q = m.queued();
        assert_eq!(q.iter().filter(|t| t.starts_with('s')).count(), 450, "no security mail evicted");
        assert_eq!(q.iter().filter(|t| t.starts_with('a')).count(), REMINDER_MAX.min(QUEUE_MAX - 450));
        assert!(lines.lock().iter().any(|l| l.contains("\"why\":\"reminder-cap\"")));
        // other mail still enters a full queue by evicting a reminder first
        for i in 0..60 {
            m.enqueue("mail.break-glass", &format!("t{i}@acme.example"), &refs(&args));
        }
        let q = m.queued();
        assert_eq!(q.len(), QUEUE_MAX);
        assert_eq!(q.iter().filter(|t| t.starts_with('a')).count(), 0, "the 50 reminders went first");
        assert_eq!(q.iter().filter(|t| t.starts_with('t')).count(), 60);
        m.configure(MailConfig::off());
    }

    #[test]
    fn send_goes_through_the_installed_mailer_only_while_mail_is_on() {
        let rt = runtime();
        let (m, lines) = mailer();
        let (port, cert, seen) = start_smtp(&rt, "mail-installed.test", &["mail-installed.test"], STARTTLS_PLAN);
        m.install();
        send("mail.reseated", "ann@acme.example", &[]);
        assert!(m.queued().is_empty(), "mail is off");
        m.configure(smtp_cfg("mail-installed.test", port, SmtpTls::StartTls, Some(cert)));
        // Other tests' consoles install their own mailers too: install again before each try.
        let delivered = || seen.lock().mails.iter().any(|x| x.contains("Subject: Your Meeting Hub seat is back\r\n"));
        for _ in 0..50 {
            m.install();
            send("mail.reseated", "ann@acme.example", &[]);
            if (0..25).any(|_| {
                std::thread::sleep(Duration::from_millis(20));
                delivered()
            }) {
                break;
            }
        }
        assert!(delivered(), "the installed mailer delivers");
        // What cannot be mailed is logged, never queued.
        m.enqueue("mail.nope", "ann@acme.example", &[]);
        m.enqueue("mail.reseated", "not an address", &[]);
        assert!(m.queued().is_empty());
        let refused = failed_lines(&lines);
        assert!(refused.iter().any(|l| l.contains("the message could not be built")) && refused.iter().any(|l| l.contains("the address cannot be mailed")), "{refused:?}");
    }

    #[test]
    fn capture_records_instead_of_sending() {
        let (m, _) = mailer();
        m.capture();
        m.enqueue("mail.test", "a@acme.example", &[]);
        m.configure(smtp_cfg("mail-nowhere.test", 25, SmtpTls::StartTls, None));
        assert_eq!(m.config().mode, Mode::Smtp);
        m.enqueue("mail.reseated", "a@acme.example", &[("x", "1".to_owned())]);
        assert_eq!(m.send_now(&m.config(), "mail.test", "b@acme.example", &[]), Ok(()));
        m.fail_next("535 nope");
        assert_eq!(m.send_now(&m.config(), "mail.test", "b@acme.example", &[]), Err("535 nope".to_owned()));
        assert_eq!(
            m.captured(),
            vec![
                ("mail.reseated".to_owned(), "a@acme.example".to_owned(), vec![("x".to_owned(), "1".to_owned())]),
                ("mail.test".to_owned(), "b@acme.example".to_owned(), vec![]),
            ]
        );
        assert!(m.queued().is_empty());
    }
}
