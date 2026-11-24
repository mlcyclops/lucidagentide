// AC-2a 3.1, 3.3, 3.6, 3.8 and 5.6 (F1, F3): what travels on the management channel and how it is checked before
// anything acts on it. The enrollment code (format, checks, `fleet-code`), the enrollment and renewal proofs, the
// frame envelope and the op table (exact keys per op, direction, sizes), the limits of 3.8, large answers in parts,
// the relay's event queue, the relay-side dispatch seam (F5's `RelayFrames`), the transport both sides share (a
// WebSocket over the pinned mutual TLS stream, or the same-process `Local` channel carrying the same text frames
// through the same code), the reconnect backoff, and `Redacted`, the type every secret of 3.3 is held in.

use crate::codec::{hex, parse_json, sha256, stringify};
use crate::console_audit::canonical_json;
use crate::license::Product;
use crate::meet_org_policy::lp;
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::{Error as WsError, Message};
use tokio_tungstenite::WebSocketStream;

// ── Redacted (A1-M1) ────────────────────────────────────────────────────────────────────────────────────────

/// A secret (an enrollment code, its secret, a MAC, a preview hash, a private key): `Debug` and `Display` print
/// `<redacted>`, so no error path, log line or panic text can carry it.
#[derive(Clone, PartialEq, Eq)]
pub struct Redacted<T>(T);

impl<T> Redacted<T> {
    pub fn new(v: T) -> Redacted<T> {
        Redacted(v)
    }
    pub fn expose(&self) -> &T {
        &self.0
    }
}

impl<T> std::fmt::Debug for Redacted<T> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("<redacted>")
    }
}

impl<T> std::fmt::Display for Redacted<T> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("<redacted>")
    }
}

// ── Labels (lp domains) ─────────────────────────────────────────────────────────────────────────────────────

pub const LABEL_CODE: &str = "lucid-fleet-code-v1";
pub const LABEL_PREVIEW: &str = "lucid-fleet-preview-v1";
pub const LABEL_ENROLL: &str = "lucid-fleet-enroll-v1";
pub const LABEL_RENEW: &str = "lucid-fleet-renew-v1";
pub const LABEL_RECOVER: &str = "lucid-fleet-recover-v1";
pub const LABEL_TRUST: &str = "lucid-fleet-trust-v1";
pub const LABEL_DISTRUST: &str = "lucid-fleet-distrust-v1";

// ── The enrollment code (3.1, F1) ───────────────────────────────────────────────────────────────────────────

pub const CODE_PREFIX: &str = "LCE1-";
const CODE_BYTES: usize = 64;
const CODE_CHARS: usize = 103;
const B32: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

fn product_byte(p: Product) -> u8 {
    match p {
        Product::Spokes => 1,
        Product::Meet => 2,
    }
}

pub fn product_of(s: &str) -> Option<Product> {
    match s {
        "spokes" => Some(Product::Spokes),
        "meet" => Some(Product::Meet),
        _ => None,
    }
}

/// A parsed enrollment code. `Debug` never prints it.
pub struct Code {
    pub product: Product,
    pub id_bytes: [u8; 8],
    pub secret: Redacted<[u8; 20]>,
    pub pin: [u8; 32],
}

impl std::fmt::Debug for Code {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Code(<redacted>)")
    }
}

impl Code {
    /// The enrollment id as shown: `en_` and 16 hex.
    pub fn id(&self) -> String {
        format!("en_{}", hex(&self.id_bytes))
    }
    pub fn pin_hex(&self) -> String {
        hex(&self.pin)
    }
}

/// Why a code does not read (each answers `fleet-code` before any network call, except `Product`, which answers
/// `fleet-product` when the caller knows its own product).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CodeError {
    Prefix,
    Length,
    Alphabet,
    Check,
    Version,
    Product,
}

#[cfg(test)]
impl CodeError {
    pub fn why(self) -> &'static str {
        match self {
            CodeError::Prefix => "prefix",
            CodeError::Length => "length",
            CodeError::Alphabet => "alphabet",
            CodeError::Check => "check",
            CodeError::Version => "version",
            CodeError::Product => "product",
        }
    }
}

fn code_check(first62: &[u8]) -> [u8; 2] {
    let h = sha256(&lp(&[LABEL_CODE.as_bytes(), first62]));
    [h[0], h[1]]
}

fn base32(data: &[u8]) -> String {
    let mut out = String::new();
    let (mut acc, mut bits) = (0u32, 0u32);
    for &b in data {
        acc = (acc << 8) | u32::from(b);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(B32[((acc >> bits) & 31) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(B32[((acc << (5 - bits)) & 31) as usize] as char);
    }
    out
}

/// F1: the code text for these fields (`LCE1-` then base32 of the 64 bytes in groups of 5 joined by `-`).
pub fn code_encode(product: Product, id: &[u8; 8], secret: &[u8; 20], pin: &[u8; 32]) -> String {
    let mut b = Vec::with_capacity(CODE_BYTES);
    b.push(1);
    b.push(product_byte(product));
    b.extend_from_slice(id);
    b.extend_from_slice(secret);
    b.extend_from_slice(pin);
    let c = code_check(&b);
    b.extend_from_slice(&c);
    code_encode_bytes(&b)
}

/// The text of 64 raw code bytes.
pub fn code_encode_bytes(b: &[u8]) -> String {
    let body = base32(b);
    let groups: Vec<&str> = body.as_bytes().chunks(5).map(|c| std::str::from_utf8(c).unwrap_or_default()).collect();
    format!("{CODE_PREFIX}{}", groups.join("-"))
}

/// F1: read a code as typed or pasted (spaces and `-` removed, letters upper-cased). Errors name the field only.
pub fn code_parse(input: &str) -> Result<Code, CodeError> {
    let s: String = input.chars().filter(|c| !c.is_whitespace() && *c != '-').collect::<String>().to_ascii_uppercase();
    let body = s.strip_prefix("LCE1").ok_or(CodeError::Prefix)?;
    if body.len() != CODE_CHARS {
        return Err(CodeError::Length);
    }
    let mut bytes = Vec::with_capacity(CODE_BYTES + 1);
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in body.bytes() {
        let v = B32.iter().position(|x| *x == c).ok_or(CodeError::Alphabet)? as u32;
        acc = (acc << 5) | v;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            bytes.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    // 103 characters carry 515 bits: the 3 left over must be zero.
    if bytes.len() != CODE_BYTES || acc != 0 {
        return Err(CodeError::Alphabet);
    }
    if code_check(&bytes[..62]) != bytes[62..64] {
        return Err(CodeError::Check);
    }
    if bytes[0] != 1 {
        return Err(CodeError::Version);
    }
    let product = match bytes[1] {
        1 => Product::Spokes,
        2 => Product::Meet,
        _ => return Err(CodeError::Product),
    };
    let arr = |r: std::ops::Range<usize>| bytes[r].to_vec();
    Ok(Code {
        product,
        id_bytes: arr(2..10).try_into().map_err(|_| CodeError::Length)?,
        secret: Redacted::new(arr(10..30).try_into().map_err(|_| CodeError::Length)?),
        pin: arr(30..62).try_into().map_err(|_| CodeError::Length)?,
    })
}

/// An enrollment id as shown (`en_` and 16 hex).
pub fn is_enrollment_id(s: &str) -> bool {
    s.len() == 19 && s.starts_with("en_") && s[3..].bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

// ── Proofs (3.3, 3.4, 3.10, 3.11) ───────────────────────────────────────────────────────────────────────────

fn hmac(secret: &[u8], msg: &[u8]) -> [u8; 32] {
    let k = aws_lc_rs::hmac::Key::new(aws_lc_rs::hmac::HMAC_SHA256, secret);
    let tag = aws_lc_rs::hmac::sign(&k, msg);
    let mut out = [0u8; 32];
    out.copy_from_slice(tag.as_ref());
    out
}

/// Constant-time equality (MACs, digests).
pub fn same_bytes(a: &[u8], b: &[u8]) -> bool {
    aws_lc_rs::constant_time::verify_slices_are_equal(a, b).is_ok()
}

/// The preview proof: `HMAC-SHA-256(secret, lp("lucid-fleet-preview-v1", id, host))`.
pub fn preview_mac(secret: &[u8], id: &str, host: &str) -> Redacted<[u8; 32]> {
    Redacted::new(hmac(secret, &lp(&[LABEL_PREVIEW.as_bytes(), id.as_bytes(), host.as_bytes()])))
}

/// `previewHash = SHA-256(canonical_json(the answer without "ok" and "previewHash"))`.
pub fn preview_hash(answer: &Value) -> Result<Redacted<[u8; 32]>, String> {
    let mut o = answer.as_object().cloned().ok_or("the preview is not an object")?;
    o.remove("ok");
    o.remove("previewHash");
    Ok(Redacted::new(sha256(&canonical_json(&Value::Object(o))?)))
}

/// `T = lp("lucid-fleet-enroll-v1", id, previewHash, spki, canonical_json(relay))`.
pub fn enroll_input(id: &str, preview_hash: &[u8; 32], spki: &[u8], relay: &Value) -> Result<Vec<u8>, String> {
    Ok(lp(&[LABEL_ENROLL.as_bytes(), id.as_bytes(), preview_hash, spki, &canonical_json(relay)?]))
}

/// The enroll MAC over `T`.
pub fn enroll_mac(secret: &[u8], input: &[u8]) -> Redacted<[u8; 32]> {
    Redacted::new(hmac(secret, input))
}

/// `lp("lucid-fleet-renew-v1", relayId, oldSerial, spki)` (serial as its INTEGER content bytes).
pub fn renew_input(relay_id: &str, old_serial_hex: &str, spki: &[u8]) -> Option<Vec<u8>> {
    let serial = crate::fleet_x509::serial_bytes(old_serial_hex)?;
    Some(lp(&[LABEL_RENEW.as_bytes(), relay_id.as_bytes(), &serial, spki]))
}

/// `lp("lucid-fleet-recover-v1", consoleId, relayId, oldSerial, spkiNew, newGeneration)`.
pub fn recover_input(console_id: &str, relay_id: &str, old_serial_hex: &str, spki_new: &[u8], generation: u64) -> Option<Vec<u8>> {
    let serial = crate::fleet_x509::serial_bytes(old_serial_hex)?;
    Some(lp(&[LABEL_RECOVER.as_bytes(), console_id.as_bytes(), relay_id.as_bytes(), &serial, spki_new, generation.to_string().as_bytes()]))
}

/// `lp("lucid-fleet-distrust-v1", consoleId, generation)`.
pub fn distrust_input(console_id: &str, generation: u64) -> Vec<u8> {
    lp(&[LABEL_DISTRUST.as_bytes(), console_id.as_bytes(), generation.to_string().as_bytes()])
}

/// `lp("lucid-fleet-trust-v1", canonical_json(manifest without "sig"))`.
pub fn trust_input(manifest: &Value) -> Result<Vec<u8>, String> {
    let mut o = manifest.as_object().cloned().ok_or("the manifest is not an object")?;
    o.remove("sig");
    Ok(lp(&[LABEL_TRUST.as_bytes(), &canonical_json(&Value::Object(o))?]))
}

/// Lowercase hex of 32 bytes from a JSON string, or None.
pub fn hash_of(v: Option<&Value>) -> Option<[u8; 32]> {
    let s = v?.as_str()?;
    if s.len() != 64 || !s.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, o) in out.iter_mut().enumerate() {
        *o = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

/// Bytes from hex (either case), or None.
pub fn unhex(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) {
        return None;
    }
    (0..s.len()).step_by(2).map(|i| s.get(i..i + 2).and_then(|p| u8::from_str_radix(p, 16).ok())).collect()
}

pub fn b64u_of(v: Option<&Value>) -> Option<Vec<u8>> {
    crate::codec::unb64u(v?.as_str()?)
}

// ── Refusals and words (13.3, 13.4) ─────────────────────────────────────────────────────────────────────────

/// A refusal on the management port or in a `res` frame (5.1 envelope, 13.3 codes).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refusal {
    pub status: u16,
    pub code: String,
    pub error: String,
}

/// The 13.3 codes this slice answers with, their status and exact words (`<...>` filled by the caller).
pub const REFUSALS: &[(&str, u16, &str)] = &[
    ("fleet-code", 400, "That enrollment code is not complete. Copy it again from the Admin Console."),
    ("fleet-code-expired", 410, "That enrollment code has ended or was already used. Ask for a new one."),
    ("fleet-product", 409, "This code is for a <product> relay. Run it on a <product> relay."),
    ("fleet-pin", 403, "This console's identity does not match the code. Ask the console's admin for a new code."),
    ("fleet-preview-changed", 409, "The console changed since you checked it. Run the command again."),
    ("fleet-profile", 409, "This console and this relay are not in the same security profile. A High relay works only with a High console, and a High console only with High relays in FIPS mode."),
    ("fleet-limit", 409, "This console already manages 200 relays."),
    ("fleet-op", 400, "The relay did not understand the console. Check that both run supported versions."),
    ("fleet-roster-duplicate", 409, "Two admin entries use the same key. The relay trusts none of them."),
    ("recovery-refused", 403, "This relay cannot replace its certificate this way. Enroll it again with a Replace code."),
    ("trust-time-refused", 409, "The time was not reset: the console did not send a newer trust list, signed by its CA and dated within 10 minutes of this host's clock."),
    ("relay-offline", 503, "<relay> is not connected right now."),
    ("relay-timeout", 504, "<relay> did not answer in time."),
    ("relay-busy", 429, "<relay> is busy. Try again in a moment."),
    // AC-2b-D 13.3: the download routes (4), the Meeting Hub certificate requests (6.5, 8.4) and 8.7.
    ("deploy-host", 400, "Enter a DNS name of letters, digits, dots and dashes, or an IP address where allowed."),
    ("deploy-clients", 400, "Enter networks as addresses with a prefix, such as 203.0.113.0/24."),
    ("deploy-high", 403, "Under the High profile this console does not hand out the relay program. Install it from your verified release media."),
    ("deploy-unavailable", 404, "This console cannot hand out the Linux relay program."),
    ("deploy-rate", 429, "Too many downloads from this address. Try again in <minutes> minutes."),
    ("deploy-busy", 503, "The console is sending the relay program to other hosts. Try again in a minute."),
    ("deploy-csr", 400, "The relay's certificate request is not for <names>."),
    ("meet-cert-wait", 429, "This relay renewed its certificate less than a day ago."),
    ("fleet-ca-held", 409, "This console holds the organization CA this High relay trusts, so the relay cannot join it."),
];

/// Port answers outside 13.3 (the AC-1 envelope's generic codes).
pub const NOT_FOUND: &str = "Not found.";
pub const FORBIDDEN: &str = "Forbidden.";

impl Refusal {
    /// The refusal for a 13.3 code with its table words.
    pub fn of(code: &str) -> Refusal {
        match REFUSALS.iter().find(|(c, _, _)| *c == code) {
            Some((c, s, w)) => Refusal { status: *s, code: (*c).to_owned(), error: (*w).to_owned() },
            None => Refusal { status: 500, code: code.to_owned(), error: "The console could not answer.".to_owned() },
        }
    }

    /// The refusal with `<name>` placeholders filled.
    pub fn filled(code: &str, fills: &[(&str, &str)]) -> Refusal {
        let mut r = Refusal::of(code);
        r.error = fill(&r.error, fills);
        r
    }

    pub fn new(status: u16, code: &str, error: &str) -> Refusal {
        Refusal { status, code: code.to_owned(), error: error.to_owned() }
    }

    /// The 5.1 envelope.
    pub fn body(&self) -> Value {
        json!({ "ok": false, "code": self.code, "error": self.error })
    }
}

impl From<crate::console::ApiError> for Refusal {
    fn from(e: crate::console::ApiError) -> Refusal {
        Refusal { status: e.status, code: e.code.to_owned(), error: e.message }
    }
}

/// Fill `<name>` placeholders.
pub fn fill(words: &str, fills: &[(&str, &str)]) -> String {
    let mut out = words.to_owned();
    for (k, v) in fills {
        out = out.replace(&format!("<{k}>"), v);
    }
    out
}

/// The 13.4 command words this slice prints (`<...>` filled by the caller).
pub const CLI_WORDS: &[(&str, &str)] = &[
    ("cli.enroll-preview", "Console: <origin>\nThis relay: <name> (<site>), <product>\nScopes: <scopes>\nProfile: <profile>, two-person control <on or off>\nAdmin keys the console offers (none is trusted until its admin endorses it or you list its fingerprint):\n<one line per entry: email, role, key hint, verified as a security key or not>"),
    ("cli.enroll-ask", "Join this console? Type yes to continue: "),
    ("cli.enroll-next", "Saved. Start the relay within the hour; it joins the console at start and prints its fingerprint."),
    ("cli.enrolled", "Joined the Lucid Admin Console at <origin> as <relayId>. Fingerprint: <fingerprint>. An admin there confirms it."),
    ("cli.enroll-failed", "Could not join the console: <why>"),
    ("cli.enroll-high-standard", "This relay is in the High profile and that console is Standard. A High relay joins only a High console."),
    ("cli.fleet-state-needed", "Joining a console needs the relay's state folder (--state)."),
    ("cli.enroll-ask-code", "Enrollment code (it is not shown as you type or paste): "),
    ("cli.code-file", "The code file must be a regular file only you can read."),
    ("cli.bootstrap-wait", "This relay trusts no admin key yet. Each admin endorses their key from the IDE plugin or the Hub app (Endorse my Admin Console key), or you add their key fingerprints with --fleet-admin-key when enrolling."),
    ("cli.trust-ca", "New management CA fingerprint: <fingerprint>. Confirm only if a console admin read you the same one by phone or in person."),
    ("cli.trust-time-reset", "Trusted time: <T>\nStored trust list: number <storedSeq>, issued <storedIssuedAt>\nNewer trust list from the console: number <seq>, issued <issuedAt>\nThis host's clock: <wall>\nUse the newer trust list and set trusted time to <issuedAt>? Type yes to continue: "),
    ("cli.with-console-high", "Under the High profile the console and the relay must run as two services with separate accounts. Drop --with-console or with_console."),
    ("cli.recover", "This relay's management key is lost. Ask a console admin for a Replace code for <name>, then run lucid-relay enroll again."),
    ("cli.connect-dns", "The console's host name did not resolve."),
    ("cli.connect-tcp", "The console's management port did not answer."),
    ("cli.connect-proxy", "The proxy refused the connection."),
    ("cli.connect-tls-protocol", "The console and this relay share no allowed TLS settings."),
    ("cli.connect-server-untrusted", "The server is not the console this relay trusts (its certificate, name or trust list did not match)."),
    ("cli.connect-server-expired", "The console's certificate has ended."),
    ("cli.connect-certificate-refused", "The console refused this relay's certificate. It may have been removed from the console, or its certificate ended."),
    ("cli.connect-upgrade-refused", "The console answered but did not open the channel."),
    ("cli.connect-closed", "The connection closed before the channel opened."),
    // AC-2b-D 13.4.
    ("cli.deploy-preview", "Relay DNS name: <host>\nTURN: <turnHost>\nRelay admins: <admins>\nProfile on this host: <profile>\nCertificate: <certificate source>\nOrganization root: <id> (<root source>)\nLicense: <license line>"),
    ("cli.deploy-source-console-ca", "from the organization CA held by this console"),
    ("cli.deploy-source-placed", "placed on this host"),
    ("cli.deploy-source-delivered", "delivered by this console"),
    ("cli.deploy-license-line", "<org>, <edition>, <users> users, ends <date>"),
    ("cli.deploy-license-none", "none: the relay starts stopped until a license is installed"),
    ("cli.deploy-ask-admins", "Relay admins: their email addresses, separated by commas: "),
    ("cli.deploy-admins-needed", "Without a terminal, give the relay admins with --admins."),
    ("cli.deploy-ask-fingerprints", "Admin key fingerprints, one per line, as each admin read them from Your account, Key fingerprints for relays (an empty line ends; none is fine): "),
    ("cli.deploy-offered-key", "The console offers the key of <email> (<hint>), who made this code, as this relay's first admin key. This console's installer put this relay's program here for this code, so trusting its key adds nothing it could not already do.\nFingerprint: <fingerprint>\nType yes to trust it (anything else skips it): "),
    ("cli.deploy-not-offered", "The console offered an admin key, but this relay does not take it (no installer mark from this console for this code, it is High, it already has state, or that admin is not in this relay's admins). Use fingerprints or endorse from the IDE plugin or the Hub app."),
    ("cli.deploy-ask-host", "This relay's DNS name: "),
    ("cli.deploy-ask-turn-host", "TURN name or address (Enter for the DNS name): "),
    ("cli.deploy-ask-clients", "Networks that may reach this relay (addresses with a prefix, separated by commas): "),
    ("cli.deploy-host-differs", "The console's code says <field> is <console value>, but this host says <host value>. Nothing was saved."),
    ("cli.deploy-root-id", "Organization root: <id>. Check it against your own records."),
    ("cli.deploy-root-differs", "The console names root <id>, but the root placed on this host is <placed id>. Nothing was saved."),
    ("cli.deploy-anchor", "This relay does not take an organization root from the console (High, or its program did not come from the console). Place it with --root or --pki-dir. Nothing was saved."),
    ("cli.deploy-profile", "This relay is Standard and that console is High. A High console takes only High relays."),
    ("cli.deploy-profile-changed", "This host was installed with the <profile> profile. Uninstall with --purge to change it."),
    ("cli.deploy-pki", "The code says the certificate comes from <source>, but this host was set up for <other>."),
    ("cli.deploy-high-preview", "This High relay was offered a certificate, root or admin key by the console. A High relay takes none of these from the console. Nothing was saved."),
    ("cli.deploy-next", "Saved. The installer now starts the relay; it joins the console and prints its fingerprint."),
    ("cli.deploy-fingerprint", "Relay fingerprint: <fingerprint>\nIn the Admin Console, check that it shows the same fingerprint, then press Confirm relay."),
    ("cli.deploy-not-deploy", "This code was made for a relay that is already installed. Run the command without --deploy."),
    ("cli.deploy-needs-deploy", "This code was made for a new install. Run the install command from the Admin Console, or ask for a code for an already installed relay."),
    ("cli.deploy-env", "This code was made for <env>, not <this env>."),
    ("cli.deploy-pki-high", "Under the High profile a relay does not take its certificate from the Admin Console. Set fleet_pki to false and place the certificate files."),
    ("cli.deploy-no-cert", "This relay has no certificate yet. Run the install command again with a new code, or place its certificate files."),
    ("cli.deploy-no-root", "This relay has no organization root yet. Run the install command again with --root <file>."),
    ("cli.deploy-marker-other", "This installer was fetched for a different code (<marker enrollment>), so it does not count as installed by the console for this one. Run the command shown with this code."),
    ("cli.profile-locked", "This host is locked to the High profile (<lock path>), but the relay's configuration says <configured>. Set the profile to high; the relay does not start otherwise."),
];

pub fn cli_words(id: &str) -> &'static str {
    CLI_WORDS.iter().find(|(i, _)| *i == id).map(|(_, w)| *w).unwrap_or("")
}

// ── Limits (3.6, 3.8) ───────────────────────────────────────────────────────────────────────────────────────

pub const RELAYS_MAX: usize = 200;
pub const PORT_CONNECTIONS: usize = 512;
pub const UNVERIFIED_PER_SOURCE: usize = 8;
pub const HANDSHAKE: Duration = Duration::from_secs(10);
pub const UPGRADE_WAIT: Duration = Duration::from_secs(10);
pub const BODY_MAX: usize = 16 * 1024;
pub const ENROLL_CALLS: usize = 30;
pub const ENROLL_WINDOW_MS: i64 = 15 * 60_000;
pub const CODE_FAILS: u32 = 5;
pub const TO_RELAY_MAX: usize = 512 * 1024;
pub const TO_CONSOLE_MAX: usize = 1024 * 1024;
pub const PARTS_TOTAL: usize = 64 * 1024 * 1024;
pub const IN_FLIGHT: usize = 16;
pub const CALL_TIMEOUT: Duration = Duration::from_secs(20);
pub const EXPORT_TIMEOUT: Duration = Duration::from_secs(120);
pub const METRICS_EVERY_MS: i64 = 50_000;
pub const EVENTS_PER_MINUTE: u32 = 600;
pub const PING_EVERY: Duration = Duration::from_secs(30);
pub const IDLE: Duration = Duration::from_secs(90);
pub const REPLACED_MAX_PER_HOUR: usize = 10;
pub const DEFAULT_PORT: u16 = 7443;
/// Close codes (3.5, 3.6).
pub const CLOSE_REPLACED: u16 = 4001;
pub const CLOSE_BYE: u16 = 4003;
pub const CLOSE_BINARY: u16 = 1003;
pub const CLOSE_TOO_BIG: u16 = 1009;
pub const CLOSE_PROTOCOL: u16 = 1008;
pub const SUBPROTOCOL: &str = "lucid-fleet.v1";
pub const CHANNEL_PATH: &str = "/fleet/v1/channel";

// ── Frames and the op table (5.6) ───────────────────────────────────────────────────────────────────────────

/// Which side receives a frame.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Side {
    Relay,
    Console,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Req,
    Evt,
}

/// One op: its kind, which side receives it (None: either), the exact keys of its body, and the keys it may carry
/// besides them (AC-2b-D 9.3: the Meeting Hub fields of `hello` and `state`, `welcome.meetCaId`).
pub struct OpSpec {
    pub op: &'static str,
    pub kind: Kind,
    pub to: Option<Side>,
    pub keys: &'static [&'static str],
    pub opt: &'static [&'static str],
}

const MANIFEST_KEYS: &[&str] = &["v", "consoleId", "caGeneration", "seq", "issuedAt", "expiresAt", "leaves", "revoked", "nextCa", "sig"];

pub const OPS: &[OpSpec] = &[
    OpSpec { op: "hello", kind: Kind::Evt, to: Some(Side::Console), keys: &["relayId", "version", "fips", "profile", "os", "localConsole", "scopes", "scopeGeneration", "readOnly", "confirm", "bootstrap", "policySeq", "rosterSeq", "trustSeq", "pins", "certNotAfter"], opt: &["meetRoots", "meetCrl", "meetPki"] },
    OpSpec { op: "welcome", kind: Kind::Evt, to: Some(Side::Relay), keys: &["consoleId", "time", "policySeq", "rosterSeq", "trustSeq"], opt: &["meetCaId"] },
    OpSpec { op: "trust", kind: Kind::Evt, to: Some(Side::Relay), keys: MANIFEST_KEYS, opt: &[] },
    OpSpec { op: "ca-distrust", kind: Kind::Evt, to: Some(Side::Relay), keys: &["generation", "sig"], opt: &[] },
    OpSpec { op: "nonce", kind: Kind::Req, to: Some(Side::Relay), keys: &["n"], opt: &[] },
    OpSpec { op: "call", kind: Kind::Req, to: Some(Side::Relay), keys: &["method", "path", "query", "body", "caller", "auth"], opt: &[] },
    OpSpec { op: "people", kind: Kind::Req, to: Some(Side::Relay), keys: &["action", "subject", "params", "auth"], opt: &[] },
    OpSpec { op: "roster", kind: Kind::Req, to: Some(Side::Relay), keys: &["seq", "prev", "change", "endorsements"], opt: &[] },
    OpSpec { op: "roster-cancel", kind: Kind::Req, to: Some(Side::Relay), keys: &["hint", "auth"], opt: &[] },
    OpSpec { op: "policy", kind: Kind::Req, to: Some(Side::Relay), keys: &["seq", "prev", "policy", "endorsements"], opt: &[] },
    OpSpec { op: "scopes", kind: Kind::Req, to: Some(Side::Relay), keys: &["scopes", "request"], opt: &[] },
    OpSpec { op: "renew", kind: Kind::Req, to: Some(Side::Console), keys: &["spki", "sigOld", "sigNew"], opt: &[] },
    OpSpec { op: "bye", kind: Kind::Evt, to: None, keys: &["reason"], opt: &[] },
    OpSpec { op: "metrics", kind: Kind::Evt, to: Some(Side::Console), keys: &["v", "seq", "ts", "interval", "m"], opt: &[] },
    OpSpec { op: "attention", kind: Kind::Evt, to: Some(Side::Console), keys: &["items"], opt: &[] },
    OpSpec { op: "audit", kind: Kind::Evt, to: Some(Side::Console), keys: &["entries"], opt: &[] },
    OpSpec { op: "state", kind: Kind::Evt, to: Some(Side::Console), keys: &["readOnly", "confirm", "scopes", "scopeGeneration", "scopeRequest", "profile", "bootstrap", "held", "unattested", "pins", "trustSeq", "version", "license"], opt: &["meetCrl", "meetPki"] },
    OpSpec { op: "confirm-done", kind: Kind::Evt, to: Some(Side::Console), keys: &["id", "result", "answer"], opt: &[] },
    // AC-2b-D 9.3: Meeting Hub relay certificates and the organization CA's revocation list.
    OpSpec { op: "meet-cert", kind: Kind::Req, to: Some(Side::Console), keys: &["csr", "signerCsr"], opt: &[] },
    OpSpec { op: "meet-crl", kind: Kind::Evt, to: Some(Side::Relay), keys: &["crl"], opt: &[] },
    OpSpec { op: "meet-crl-get", kind: Kind::Req, to: Some(Side::Relay), keys: &[], opt: &[] },
    // API-1 2.6: the relay's api heads (asked first after `welcome`; an older relay answers fleet-op), the org api
    // map, its tightening journal and the pseudonym key.
    OpSpec { op: "api-heads", kind: Kind::Req, to: Some(Side::Relay), keys: &[], opt: &[] },
    // API-1d 2.4: `trust` `{root, signer_policy, crl?}` only to a spokes relay, which holds no Meet org CA (the root
    // and signer policy the console verified the map with; the spokes relay pins the root per bound org).
    OpSpec { op: "api-map", kind: Kind::Req, to: Some(Side::Relay), keys: &["org", "map"], opt: &["base", "trust"] },
    OpSpec { op: "api-tighten", kind: Kind::Req, to: Some(Side::Relay), keys: &["org", "entry"], opt: &[] },
    OpSpec { op: "api-pseudonym-key", kind: Kind::Req, to: Some(Side::Relay), keys: &["org", "pkv", "key", "not_before"], opt: &[] },
    // API-1 2.6, 9.3, 12.2: the relay's audit chains shipped to the console (`api-audit`, acknowledged once durable),
    // pulled back after a reconnect (`api-chains`), and its per-org checkpoint key certified by the console.
    OpSpec { op: "api-audit", kind: Kind::Req, to: Some(Side::Console), keys: &["org", "repr", "first", "last", "entries"], opt: &[] },
    OpSpec { op: "api-chains", kind: Kind::Req, to: Some(Side::Relay), keys: &["org", "after"], opt: &[] },
    OpSpec { op: "api-checkpoint-csr", kind: Kind::Req, to: Some(Side::Relay), keys: &["org"], opt: &[] },
    OpSpec { op: "api-checkpoint-cert", kind: Kind::Req, to: Some(Side::Relay), keys: &["org", "cert", "chain"], opt: &[] },
    // API-1 12.3: a destination's failover credential on one relay (csr, install, delete); an older relay answers fleet-op.
    OpSpec { op: "api-failover", kind: Kind::Req, to: Some(Side::Relay), keys: &["org", "destination", "action", "params"], opt: &[] },
    // API-1 2.5, 12.2: the end of a catch-up that fully succeeded, `orgs` `{org: {seq, tseq}}` as the console holds
    // them; the relay answers ok only when it holds at least that much (else `not-synced`).
    OpSpec { op: "api-synced", kind: Kind::Req, to: Some(Side::Relay), keys: &["orgs"], opt: &[] },
    // API-1 2.3 (slice 1a6): a console save asks an admin's device on this relay to sign the org api map
    // (`meet.api.sign` in the relay's request book), then polls the request; an older relay answers fleet-op.
    OpSpec { op: "api-sign-request", kind: Kind::Req, to: Some(Side::Relay), keys: &["org", "principal", "map", "map_sha256", "reason", "requested_by"], opt: &[] },
    OpSpec { op: "api-sign-status", kind: Kind::Req, to: Some(Side::Relay), keys: &["org", "request"], opt: &[] },
    // API-1 revision 4 2.3: the map versions and features the relay takes; the one request allowed before the
    // reconnect catch-up (read-only); an older relay answers fleet-op (map version 1, no features).
    OpSpec { op: "api-features", kind: Kind::Req, to: Some(Side::Relay), keys: &[], opt: &[] },
    // API-1 revision 4 2.5, 6.7: a relay reports a principal deprovisioned or active again (`api_people`).
    OpSpec { op: "api-person", kind: Kind::Req, to: Some(Side::Console), keys: &["org", "principal", "state", "at", "provider", "source"], opt: &[] },
    // API-1 revision 5 4.3: the console asks a relay for the newest SSO-signed person record (`api_subject`).
    OpSpec { op: "api-subject", kind: Kind::Req, to: Some(Side::Relay), keys: &["org", "provider"], opt: &["sub", "principal"] },
    // API-1 revision 4 13.1: the console asks a relay for its SSO services' directory status reports (`api_sso_status`).
    OpSpec { op: "api-directory-status", kind: Kind::Req, to: Some(Side::Relay), keys: &["org"], opt: &[] },
    // API-1 revision 5 6.1, 6.4: the console asks a relay for the org's current signed policy and the root-signed
    // signer policy (read-only; the console verifies both under its Meet CA root).
    OpSpec { op: "api-org-policy", kind: Kind::Req, to: Some(Side::Relay), keys: &["org"], opt: &[] },
    // API-1 revision 4 2.5, 7.3: the relay's event chains, as `api-audit` and `api-chains` for its audit chains.
    OpSpec { op: "api-events", kind: Kind::Req, to: Some(Side::Console), keys: &["org", "repr", "first", "last", "entries"], opt: &[] },
    OpSpec { op: "api-event-chains", kind: Kind::Req, to: Some(Side::Relay), keys: &["org", "after"], opt: &[] },
    // API-1 revision 4 2.5, 5.1, 5.2: one page of the relay's compliance metadata for an org; an API hold (the relay
    // hold at once, the reviewer's ask on the archive relay) and its state.
    OpSpec { op: "api-compliance-read", kind: Kind::Req, to: Some(Side::Relay), keys: &["org", "kind", "params", "after"], opt: &[] },
    OpSpec { op: "api-hold", kind: Kind::Req, to: Some(Side::Relay), keys: &["org", "hold", "ask_reviewer"], opt: &[] },
    OpSpec { op: "api-hold-status", kind: Kind::Req, to: Some(Side::Relay), keys: &["org", "hold"], opt: &[] },
    // API-1 revision 4 2.5, 5.3: compliance exports. The console asks the archive relay for a job, its state and its
    // cancellation; the archive relay sends the seal header, then each ciphertext part, to the console.
    OpSpec { op: "api-export", kind: Kind::Req, to: Some(Side::Relay), keys: &["org", "job"], opt: &[] },
    OpSpec { op: "api-export-status", kind: Kind::Req, to: Some(Side::Relay), keys: &["org", "job"], opt: &[] },
    OpSpec { op: "api-export-cancel", kind: Kind::Req, to: Some(Side::Relay), keys: &["org", "job", "reason"], opt: &[] },
    OpSpec { op: "api-export-seal", kind: Kind::Req, to: Some(Side::Console), keys: &["org", "job", "seal"], opt: &[] },
    OpSpec { op: "api-export-part", kind: Kind::Req, to: Some(Side::Console), keys: &["org", "job", "n", "data", "sha256"], opt: &[] },
    // API-1d 2.4: the orgs a spokes relay is bound to (sent first in every reconnect sync; a Meeting Hub relay answers
    // 409 `not-spokes`; `generation` is the console's binding generation, an older one refused, and `release_roots` the
    // orgs whose pinned Meet org CA root that generation releases), and a 6.2 view of a bound org from the spokes
    // relay's own state (`spokes.read`).
    OpSpec { op: "api-orgs", kind: Kind::Req, to: Some(Side::Relay), keys: &["orgs", "generation"], opt: &["release_roots"] },
    OpSpec { op: "api-spokes", kind: Kind::Req, to: Some(Side::Relay), keys: &["org", "view", "query", "people"], opt: &[] },
];

pub fn op_spec(op: &str) -> Option<&'static OpSpec> {
    OPS.iter().find(|s| s.op == op)
}

/// API-1 2.6: an `api-audit` request frame, and each `api-chains` answer page (both 1 MiB, the console's frame limit).
pub const API_AUDIT_MAX: usize = TO_CONSOLE_MAX;
/// API-1 9.3: an `api-checkpoint-cert` request frame (a certificate and its chain to the org CA).
pub const API_CHECKPOINT_CERT_MAX: usize = 32 * 1024;
/// API-1 12.3: an `api-failover` request frame (a certificate with its chain, or a token).
pub const API_FAILOVER_MAX: usize = 64 * 1024;

/// API-1 2.3 (slice 1a6): an `api-sign-request` frame (an unsigned map of at most 256 KiB and its hash), the side's
/// whole frame limit.
pub const API_SIGN_REQUEST_MAX: usize = TO_RELAY_MAX;

/// API-1 revision 4 2.5: an `api-export-seal` frame (a seal header of at most 2 MiB).
pub const API_EXPORT_SEAL_MAX: usize = 2 * 1024 * 1024;
/// API-1 revision 4 2.5: an `api-export-part` frame (4 MiB of ciphertext in standard base64, with its keys); the
/// console's WebSocket message cap, which only these two ops may use beyond `TO_CONSOLE_MAX`.
pub const API_EXPORT_PART_MAX: usize = 6 * 1024 * 1024;

/// API-1 2.6: the size limit of an op's whole request frame, below the side's frame limit (3.8).
pub fn op_frame_max(op: &str) -> Option<usize> {
    match op {
        "api-map" => Some(300 * 1024),
        "api-tighten" => Some(8 * 1024),
        "api-pseudonym-key" => Some(1024),
        "api-audit" => Some(API_AUDIT_MAX),
        "api-chains" => Some(256),
        "api-checkpoint-csr" => Some(256),
        "api-checkpoint-cert" => Some(API_CHECKPOINT_CERT_MAX),
        "api-failover" => Some(API_FAILOVER_MAX),
        "api-synced" => Some(4 * 1024),
        "api-sign-request" => Some(API_SIGN_REQUEST_MAX),
        "api-sign-status" => Some(256),
        // revision 4 2.5: 64 B in (the answer is at most 4 KiB)
        "api-features" => Some(64),
        // revision 4 2.5: 1 KiB
        "api-person" => Some(1024),
        // revision 5 4.3: 1 KiB in (the answer is at most 8 KiB, `api_subject::ANSWER_MAX`)
        "api-subject" => Some(1024),
        // revision 4 13.1: 256 B in (the answer is at most 16 reports of 48 KiB, `api_sso_status`)
        "api-directory-status" => Some(256),
        // revision 5 6.1: 256 B in (the answer is a signed policy of at most 64 KiB and the signer policy)
        "api-org-policy" => Some(256),
        // revision 4 2.5: as `api-audit` and `api-chains`
        "api-events" => Some(API_AUDIT_MAX),
        "api-event-chains" => Some(256),
        // revision 4 2.5: 4 KiB in (1 MiB out), 32 KiB, 256 B
        "api-compliance-read" => Some(4 * 1024),
        "api-hold" => Some(32 * 1024),
        "api-hold-status" => Some(256),
        // revision 4 2.5: 64 KiB, 256 B, 1 KiB in; 2 MiB and 6 MiB to the console
        "api-export" => Some(64 * 1024),
        "api-export-status" => Some(256),
        "api-export-cancel" => Some(1024),
        "api-export-seal" => Some(API_EXPORT_SEAL_MAX),
        "api-export-part" => Some(API_EXPORT_PART_MAX),
        // API-1d 2.4: 2 KiB and 1 KiB in (the `api-spokes` answer is at most 1 MiB, the console's frame limit)
        "api-orgs" => Some(2 * 1024),
        "api-spokes" => Some(1024),
        _ => None,
    }
}

/// A frame that passed the 4.8 step 2 shape check.
#[derive(Debug, Clone, PartialEq)]
pub enum Frame {
    Req { id: u32, op: &'static str, body: Map<String, Value> },
    Res { id: u32, answer: Result<Value, Refusal> },
    Part { id: u32, i: u32, of: u32, data: String },
    Evt { op: &'static str, body: Map<String, Value> },
}

/// Why a frame was refused; `id` when the frame was a request, so it can be answered `fleet-op`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrameError {
    pub id: Option<u32>,
    pub why: &'static str,
    /// The frame's op once known (a `body` refusal names it in the log), else "".
    pub op: &'static str,
}

fn frame_id(v: Option<&Value>) -> Option<u32> {
    let n = v?.as_i64()?;
    (1..=(1i64 << 31)).contains(&n).then_some(n as u32)
}

fn exact(o: &Map<String, Value>, keys: &[&str]) -> bool {
    o.len() == keys.len() && keys.iter().all(|k| o.contains_key(*k))
}

/// Every key of `keys`, and nothing besides them and `opt`.
fn exact_opt(o: &Map<String, Value>, keys: &[&str], opt: &[&str]) -> bool {
    keys.iter().all(|k| o.contains_key(*k)) && o.keys().all(|k| keys.contains(&k.as_str()) || opt.contains(&k.as_str()))
}

/// The closed value sets of the event bodies 5.6 spells out: `bye.reason` and `confirm-done.result` (revision 3.2:
/// `unknown` is one of them and carries `answer: null`); any other value is `fleet-op`.
fn event_values_ok(op: &str, body: &Map<String, Value>) -> bool {
    match op {
        "bye" => matches!(body.get("reason").and_then(Value::as_str), Some("removed" | "left")),
        "confirm-done" => match body.get("result").and_then(Value::as_str) {
            Some("unknown") => body.get("answer") == Some(&Value::Null),
            Some("ok" | "refused" | "expired" | "failed") => true,
            _ => false,
        },
        _ => true,
    }
}

/// The receiving side's WebSocket message cap (3.8). On the console only `api-export-seal` and `api-export-part`
/// (revision 4 2.5) may pass `TO_CONSOLE_MAX`; `parse_frame` holds every other frame to `frame_base`.
pub fn frame_limit(at: Side) -> usize {
    match at {
        Side::Relay => TO_RELAY_MAX,
        Side::Console => API_EXPORT_PART_MAX,
    }
}

/// The receiving side's size limit for a frame whose op sets none (3.8).
pub fn frame_base(at: Side) -> usize {
    match at {
        Side::Relay => TO_RELAY_MAX,
        Side::Console => TO_CONSOLE_MAX,
    }
}

/// Parse and shape-check one text frame received at `at` (4.8 steps 1 and 2: size, `t`, `op`, direction, exact keys).
pub fn parse_frame(text: &str, at: Side) -> Result<Frame, FrameError> {
    let bad = |id, why| Err(FrameError { id, why, op: "" });
    let bad_body = |id, op| Err(FrameError { id, why: "body", op });
    if text.len() > frame_limit(at) {
        return bad(None, "size");
    }
    let Some(Value::Object(o)) = parse_json(text) else { return bad(None, "json") };
    let id = frame_id(o.get("id"));
    match o.get("t").and_then(Value::as_str) {
        Some("req") => {
            if !exact(&o, &["t", "id", "op", "body"]) || id.is_none() {
                return bad(id, "keys");
            }
            let Some(spec) = o.get("op").and_then(Value::as_str).and_then(op_spec) else { return bad(id, "op") };
            if spec.kind != Kind::Req || spec.to.is_some_and(|s| s != at) {
                return bad(id, "op");
            }
            if text.len() > op_frame_max(spec.op).unwrap_or(frame_base(at)) {
                return bad(id, "size");
            }
            let Some(Value::Object(body)) = o.get("body") else { return bad(id, "body") };
            if !exact_opt(body, spec.keys, spec.opt) {
                return bad_body(id, spec.op);
            }
            Ok(Frame::Req { id: id.unwrap_or_default(), op: spec.op, body: body.clone() })
        }
        Some("evt") => {
            if text.len() > frame_base(at) {
                return bad(None, "size");
            }
            if !exact(&o, &["t", "op", "body"]) {
                return bad(None, "keys");
            }
            let Some(spec) = o.get("op").and_then(Value::as_str).and_then(op_spec) else { return bad(None, "op") };
            if spec.kind != Kind::Evt || spec.to.is_some_and(|s| s != at) {
                return bad(None, "op");
            }
            let Some(Value::Object(body)) = o.get("body") else { return bad(None, "body") };
            if !exact_opt(body, spec.keys, spec.opt) || !event_values_ok(spec.op, body) {
                return bad_body(None, spec.op);
            }
            Ok(Frame::Evt { op: spec.op, body: body.clone() })
        }
        Some("res") => {
            if text.len() > frame_base(at) {
                return bad(None, "size");
            }
            let Some(id) = id else { return bad(None, "keys") };
            match o.get("ok") {
                Some(Value::Bool(true)) if exact(&o, &["t", "id", "ok", "body"]) => Ok(Frame::Res { id, answer: Ok(o["body"].clone()) }),
                Some(Value::Bool(true)) if exact(&o, &["t", "id", "ok", "part", "data"]) && at == Side::Console => {
                    let p = o["part"].as_object().filter(|p| exact(p, &["i", "of"]));
                    let (i, of) = match p.map(|p| (p["i"].as_u64(), p["of"].as_u64())) {
                        Some((Some(i), Some(of))) if of >= 2 && i < of && of <= (PARTS_TOTAL / (TO_CONSOLE_MAX / 2)) as u64 => (i as u32, of as u32),
                        _ => return bad(None, "part"),
                    };
                    let Some(data) = o["data"].as_str() else { return bad(None, "part") };
                    Ok(Frame::Part { id, i, of, data: data.to_owned() })
                }
                Some(Value::Bool(false)) if exact(&o, &["t", "id", "ok", "status", "code", "error"]) => {
                    let status = o["status"].as_u64().filter(|s| (100..600).contains(s));
                    match (status, o["code"].as_str(), o["error"].as_str()) {
                        (Some(s), Some(c), Some(e)) => Ok(Frame::Res { id, answer: Err(Refusal { status: s as u16, code: c.to_owned(), error: e.to_owned() }) }),
                        _ => bad(None, "keys"),
                    }
                }
                _ => bad(None, "keys"),
            }
        }
        _ => bad(id, "t"),
    }
}

pub fn req_text(id: u32, op: &str, body: Value) -> String {
    stringify(&json!({ "t": "req", "id": id, "op": op, "body": body }))
}

pub fn evt_text(op: &str, body: Value) -> String {
    stringify(&json!({ "t": "evt", "op": op, "body": body }))
}

pub fn res_ok_text(id: u32, body: Value) -> String {
    stringify(&json!({ "t": "res", "id": id, "ok": true, "body": body }))
}

pub fn res_err_text(id: u32, r: &Refusal) -> String {
    stringify(&json!({ "t": "res", "id": id, "ok": false, "status": r.status, "code": r.code, "error": r.error }))
}

/// A relay's answer as frames (3.8): one frame when it fits in 1 MiB, else the body's JSON text in parts of at most
/// 1 MiB, at most 64 MiB in all (`{"t":"res","id":n,"ok":true,"part":{"i":k,"of":N},"data":"<slice>"}`).
pub fn answer_frames(id: u32, body: Value) -> Vec<String> {
    let whole = res_ok_text(id, body.clone());
    if whole.len() <= TO_CONSOLE_MAX {
        return vec![whole];
    }
    let text = stringify(&body);
    if text.len() > PARTS_TOTAL {
        return vec![res_err_text(id, &Refusal::of("fleet-op"))];
    }
    // JSON escaping of a slice can at most double it (quotes, backslashes, controls as \u00XX take more, so slices stay
    // at a quarter of the frame limit).
    let chunk = TO_CONSOLE_MAX / 4;
    let mut parts = Vec::new();
    let mut rest = text.as_str();
    while !rest.is_empty() {
        let mut end = chunk.min(rest.len());
        while !rest.is_char_boundary(end) {
            end -= 1;
        }
        parts.push(&rest[..end]);
        rest = &rest[end..];
    }
    let of = parts.len() as u32;
    parts.iter().enumerate().map(|(i, p)| stringify(&json!({ "t": "res", "id": id, "ok": true, "part": { "i": i, "of": of }, "data": p }))).collect()
}

/// Reassembles answers sent in parts (console side), within 64 MiB pending in all.
#[derive(Default)]
pub struct Parts {
    open: HashMap<u32, (u32, u32, String)>,
    total: usize,
}

impl Parts {
    /// One part; Ok(Some(body)) when the answer is complete, Err when the parts are out of order or over the cap.
    pub fn push(&mut self, id: u32, i: u32, of: u32, data: &str) -> Result<Option<Value>, ()> {
        let entry = self.open.entry(id).or_insert((of, 0, String::new()));
        if entry.0 != of || entry.1 != i || self.total + data.len() > PARTS_TOTAL {
            if let Some((_, _, s)) = self.open.remove(&id) {
                self.total -= s.len();
            }
            return Err(());
        }
        entry.1 += 1;
        entry.2.push_str(data);
        self.total += data.len();
        if entry.1 < of {
            return Ok(None);
        }
        let (_, _, text) = self.open.remove(&id).unwrap_or_default();
        self.total -= text.len();
        parse_json(&text).map(Some).ok_or(())
    }

    pub fn drop_id(&mut self, id: u32) {
        if let Some((_, _, s)) = self.open.remove(&id) {
            self.total -= s.len();
        }
    }
}

// ── Relay events (F3) and the relay-side dispatch seam (F5) ─────────────────────────────────────────────────

#[derive(Clone)]
enum EventSink {
    Chan(mpsc::Sender<(String, Value)>),
    #[cfg(test)]
    Capture(Captured),
}

/// The events a test captured, in order.
#[cfg(test)]
pub type Captured = std::sync::Arc<parking_lot::Mutex<Vec<(String, Value)>>>;

/// The relay's outgoing events (`state`, `attention`, `audit`, `confirm-done`, `metrics`, `bye`): queued for the
/// channel; dropped when the queue is full or the relay is not connected (`bye` excepted, it is sent at the next
/// connection while the link exists).
#[derive(Clone)]
pub struct Events {
    sink: EventSink,
}

pub const EVENTS_QUEUE: usize = 1024;

impl Events {
    pub fn channel() -> (Events, mpsc::Receiver<(String, Value)>) {
        let (tx, rx) = mpsc::channel(EVENTS_QUEUE);
        (Events { sink: EventSink::Chan(tx) }, rx)
    }

    pub fn send(&self, op: &str, body: Value) {
        match &self.sink {
            EventSink::Chan(tx) => {
                let _ = tx.try_send((op.to_owned(), body));
            }
            #[cfg(test)]
            EventSink::Capture(log) => log.lock().push((op.to_owned(), body)),
        }
    }

    #[cfg(test)]
    pub fn capture() -> (Events, Captured) {
        let log = std::sync::Arc::new(parking_lot::Mutex::new(Vec::new()));
        (Events { sink: EventSink::Capture(log.clone()) }, log)
    }
}

/// F5: the relay side of every console request. The agent shape-checks the envelope, op, keys and size first
/// (4.8 steps 1 and 2) and calls `request` for `nonce`, `call`, `people`, `roster`, `roster-cancel`, `policy` and
/// `scopes` (f-trust's checks and execution, steps 3 to 8). `hello_fields` gives the hello keys f-trust owns.
pub trait RelayFrames: Send + Sync {
    fn request(&self, op: &str, body: &Value, t: i64) -> Result<Value, Refusal>;
    fn hello_fields(&self) -> Map<String, Value>;
}

// ── The transport: a WebSocket over the pinned mutual TLS stream, or the same-process Local channel ─────────

pub trait Io: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send {}
impl<T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send> Io for T {}
pub type BoxIo = Box<dyn Io>;

/// What the Local channel carries: the same text frames, and the close.
#[derive(Debug)]
pub enum LocalMsg {
    Text(String),
    Close(u16),
}

/// One end of the same-process channel (2.2): the frames go through the same parse and checks as on the network.
pub struct LocalEnd {
    tx: mpsc::UnboundedSender<LocalMsg>,
    rx: mpsc::UnboundedReceiver<LocalMsg>,
}

/// F3: the two ends of a Local channel (console end, relay end).
pub fn local_pair() -> (LocalEnd, LocalEnd) {
    let (a_tx, a_rx) = mpsc::unbounded_channel();
    let (b_tx, b_rx) = mpsc::unbounded_channel();
    (LocalEnd { tx: a_tx, rx: b_rx }, LocalEnd { tx: b_tx, rx: a_rx })
}

pub enum Wire {
    Ws(Box<WebSocketStream<BoxIo>>),
    Local(LocalEnd),
}

/// What one read gave.
#[derive(Debug)]
pub enum In {
    Text(String),
    Binary,
    Pong(Vec<u8>),
    Closed(Option<u16>),
    TooBig,
    Failed,
}

pub enum WireTx {
    Ws(SplitSink<WebSocketStream<BoxIo>, Message>),
    Local(mpsc::UnboundedSender<LocalMsg>),
}

pub enum WireRx {
    Ws(SplitStream<WebSocketStream<BoxIo>>),
    Local(mpsc::UnboundedReceiver<LocalMsg>),
}

impl Wire {
    pub fn split(self) -> (WireTx, WireRx) {
        match self {
            Wire::Ws(ws) => {
                let (tx, rx) = (*ws).split();
                (WireTx::Ws(tx), WireRx::Ws(rx))
            }
            Wire::Local(l) => (WireTx::Local(l.tx), WireRx::Local(l.rx)),
        }
    }

    pub fn is_local(&self) -> bool {
        matches!(self, Wire::Local(_))
    }
}

impl WireTx {
    pub async fn text(&mut self, s: String) -> bool {
        match self {
            WireTx::Ws(w) => w.send(Message::text(s)).await.is_ok(),
            WireTx::Local(tx) => tx.send(LocalMsg::Text(s)).is_ok(),
        }
    }

    /// A WebSocket ping (the Local channel has no liveness to measure).
    pub async fn ping(&mut self, payload: Vec<u8>) -> bool {
        match self {
            WireTx::Ws(w) => w.send(Message::Ping(payload.into())).await.is_ok(),
            WireTx::Local(_) => true,
        }
    }

    pub async fn close(&mut self, code: u16) {
        match self {
            WireTx::Ws(w) => {
                let _ = w.send(Message::Close(Some(CloseFrame { code: CloseCode::from(code), reason: "".into() }))).await;
                let _ = w.close().await;
            }
            WireTx::Local(tx) => {
                let _ = tx.send(LocalMsg::Close(code));
            }
        }
    }
}

impl WireRx {
    pub async fn next(&mut self) -> In {
        match self {
            WireRx::Ws(r) => loop {
                match r.next().await {
                    None => return In::Closed(None),
                    Some(Err(WsError::Capacity(_))) => return In::TooBig,
                    Some(Err(_)) => return In::Failed,
                    Some(Ok(Message::Text(t))) => return In::Text(t.as_str().to_owned()),
                    Some(Ok(Message::Binary(_))) => return In::Binary,
                    Some(Ok(Message::Pong(p))) => return In::Pong(p.to_vec()),
                    Some(Ok(Message::Close(c))) => return In::Closed(c.map(|c| u16::from(c.code))),
                    Some(Ok(_)) => continue,
                }
            },
            WireRx::Local(rx) => match rx.recv().await {
                Some(LocalMsg::Text(t)) => In::Text(t),
                Some(LocalMsg::Close(c)) => In::Closed(Some(c)),
                None => In::Closed(None),
            },
        }
    }
}

/// The WebSocket settings of each side: the receiving side's frame limit (3.8).
pub fn ws_config(at: Side) -> tokio_tungstenite::tungstenite::protocol::WebSocketConfig {
    let mut cfg = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default();
    cfg.max_message_size = Some(frame_limit(at));
    cfg.max_frame_size = Some(frame_limit(at));
    cfg
}

// ── Reconnect backoff (3.6) ─────────────────────────────────────────────────────────────────────────────────

pub const BACKOFF_FIRST: Duration = Duration::from_secs(1);
pub const BACKOFF_MAX: Duration = Duration::from_secs(60);
pub const BACKOFF_RESET_AFTER: Duration = Duration::from_secs(600);

/// 1 s doubling to at most 60 s, each wait varied by plus or minus 20%, never outside 1 to 60 s.
#[derive(Default, Debug)]
pub struct Backoff {
    step: u32,
}

impl Backoff {
    /// The next wait for a random `r` in [0, 1).
    pub fn next_with(&mut self, r: f64) -> Duration {
        let base = (BACKOFF_FIRST.as_secs_f64() * f64::from(1u32 << self.step.min(6))).min(BACKOFF_MAX.as_secs_f64());
        self.step = (self.step + 1).min(6);
        let factor = 0.8 + 0.4 * r.clamp(0.0, 1.0);
        Duration::from_secs_f64((base * factor).clamp(BACKOFF_FIRST.as_secs_f64(), BACKOFF_MAX.as_secs_f64()))
    }

    pub fn next(&mut self) -> Duration {
        self.next_with(random_unit())
    }

    pub fn reset(&mut self) {
        self.step = 0;
    }
}

/// A random number in [0, 1) from AWS-LC.
pub fn random_unit() -> f64 {
    let b = crate::console_auth::random(4).unwrap_or_else(|| vec![0; 4]);
    f64::from(u32::from_be_bytes([b[0], b[1], b[2], b[3]])) / 4_294_967_296.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codec::b64u;
    use crate::fleet_x509::tests::unhex;

    fn vector(name: &str) -> Value {
        let path = format!("{}/tests/{name}", env!("CARGO_MANIFEST_DIR"));
        let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e} (copy it from the Meeting Hub repository's tests/vectors/)"));
        parse_json(&text).unwrap()
    }

    fn s(v: &Value) -> &str {
        v.as_str().unwrap()
    }

    #[test]
    fn codes_encode_and_decode_with_every_vector_case() {
        let v = vector("admin_console_fleet_code_v1.json");
        assert_eq!(s(&v["prefix"]), CODE_PREFIX);
        assert_eq!(s(&v["label"]), LABEL_CODE);
        for c in v["cases"].as_array().unwrap() {
            let name = s(&c["name"]);
            let bytes = unhex(s(&c["bytes_hex"]));
            assert_eq!(code_encode_bytes(&bytes), s(&c["code"]), "{name}");
            let code = code_parse(s(&c["code"])).unwrap_or_else(|e| panic!("{name}: {e:?}"));
            assert_eq!(code.product.as_str(), s(&c["product"]), "{name}");
            assert_eq!(code.id(), s(&c["id"]), "{name}");
            assert_eq!(hex(code.secret.expose()), s(&c["secret_hex"]), "{name}");
            assert_eq!(code.pin_hex(), s(&c["pin_hex"]), "{name}");
            let id: [u8; 8] = unhex(&s(&c["id"])[3..]).try_into().unwrap();
            let secret: [u8; 20] = unhex(s(&c["secret_hex"])).try_into().unwrap();
            let pin: [u8; 32] = unhex(s(&c["pin_hex"])).try_into().unwrap();
            assert_eq!(code_encode(code.product, &id, &secret, &pin), s(&c["code"]), "{name}");
            let text = s(&c["code"]);
            // `LCE1-`, 103 base32 characters in 21 groups of 5 joined by 20 dashes
            assert_eq!(text.len(), 5 + 103 + 20);
            assert_eq!(text.split('-').count(), 22, "LCE1 and 21 groups");
        }
        for c in v["inputs"].as_array().into_iter().flatten() {
            let a = code_parse(s(&c["input"])).unwrap_or_else(|e| panic!("{}: {e:?}", s(&c["name"])));
            let b = code_parse(s(&c["code"])).unwrap();
            assert_eq!((a.id(), a.secret.expose(), a.pin), (b.id(), b.secret.expose(), b.pin));
        }
        for c in v["broken"].as_array().unwrap() {
            let got = code_parse(s(&c["input"])).err().map(CodeError::why);
            assert_eq!(got, Some(s(&c["why"])), "{}", s(&c["name"]));
        }
    }

    #[test]
    fn proofs_match_the_vector() {
        let v = vector("admin_console_fleet_code_v1.json");
        let p = &v["proofs"];
        let pv = &p["preview"];
        let c = v["cases"].as_array().unwrap().iter().find(|c| c["id"] == pv["id"]).unwrap();
        let code = code_parse(s(&c["code"])).unwrap();
        let mac = preview_mac(code.secret.expose(), &code.id(), s(&pv["host"]));
        assert_eq!(b64u(mac.expose()), s(&pv["mac_b64u"]));
        assert_eq!(hex(&lp(&[LABEL_PREVIEW.as_bytes(), code.id().as_bytes(), s(&pv["host"]).as_bytes()])), s(&pv["input_hex"]));
        // the preview hash covers the answer without ok and previewHash
        let answer = &pv["answer"];
        assert_eq!(hex(preview_hash(answer).unwrap().expose()), s(&answer["previewHash"]));
        let e = &p["enroll"];
        let body = &e["body"];
        let ph = hash_of(body.get("previewHash")).unwrap();
        let spki = crate::codec::unb64u(s(&body["spki"])).unwrap();
        assert_eq!(hex(&spki), s(&e["relay_spki_hex"]));
        let t = enroll_input(&code.id(), &ph, &spki, &body["relay"]).unwrap();
        assert_eq!(hex(&t), s(&e["t_hex"]));
        assert_eq!(b64u(enroll_mac(code.secret.expose(), &t).expose()), s(&body["mac"]));
        assert!(crate::fleet_x509::verify_p256(&spki, &t, &crate::codec::unb64u(s(&body["sig"])).unwrap()));
        let f = &p["fingerprint"];
        assert_eq!(crate::fleet_x509::relay_fingerprint(&unhex(s(&f["spki_hex"]))), s(&f["fingerprint"]));
        let r = &p["renew"];
        let input = renew_input(s(&r["relay_id"]), s(&r["old_serial_hex"]), &unhex(s(&r["spki_hex"]))).unwrap();
        assert_eq!(hex(&input), s(&r["input_hex"]));
    }

    #[test]
    fn code_errors_and_debug_never_show_the_code() {
        let code = code_encode(Product::Meet, &[7; 8], &[9; 20], &[3; 32]);
        let parsed = code_parse(&code.to_lowercase().replace('-', " ")).unwrap();
        assert_eq!(parsed.product, Product::Meet);
        let secret_hex = hex(&[9u8; 20]);
        for text in [format!("{parsed:?}"), format!("{:?}", parsed.secret), format!("{}", parsed.secret), format!("{:?}", preview_mac(&[9; 20], "en_x", "h"))] {
            assert!(!text.contains(&secret_hex) && !text.contains(&code[5..30]), "{text}");
        }
        // a forced panic that formats the parsed code carries no part of it
        let p = std::panic::catch_unwind(|| panic!("enroll failed for {parsed:?} with {:?}", parsed.secret)).unwrap_err();
        let text = p.downcast_ref::<String>().cloned().unwrap_or_default();
        assert!(text.contains("<redacted>") && !text.contains(&secret_hex) && !text.contains(&code[5..30]), "{text}");
        assert_eq!(code_parse("LCE2-AAAAA").err(), Some(CodeError::Prefix));
        assert_eq!(code_parse(&code[..100]).err(), Some(CodeError::Length));
        let mut broken = code.clone().into_bytes();
        broken[7] = b'1';
        assert_eq!(code_parse(std::str::from_utf8(&broken).unwrap()).err(), Some(CodeError::Alphabet));
        let mut flipped = code.clone().into_bytes();
        flipped[8] = if flipped[8] == b'A' { b'B' } else { b'A' };
        assert_eq!(code_parse(std::str::from_utf8(&flipped).unwrap()).err(), Some(CodeError::Check));
    }

    #[test]
    fn frames_are_checked_for_shape_size_and_direction() {
        let hello = json!({"relayId": "r_0123456789abcdef", "version": "1", "fips": false, "profile": "standard", "os": "linux", "localConsole": false, "scopes": [], "scopeGeneration": 1, "readOnly": false, "confirm": [], "bootstrap": {}, "policySeq": 0, "rosterSeq": 0, "trustSeq": 1, "pins": [], "certNotAfter": 0});
        let text = evt_text("hello", hello.clone());
        assert!(matches!(parse_frame(&text, Side::Console), Ok(Frame::Evt { op: "hello", .. })));
        // hello goes to the console only
        assert_eq!(parse_frame(&text, Side::Relay).err().unwrap().why, "op");
        // an extra key in the body, a missing key, an extra envelope key
        let mut extra = hello.clone();
        extra["attested"] = json!(true);
        assert_eq!(parse_frame(&evt_text("hello", extra), Side::Console).err().unwrap().why, "body");
        let mut missing = hello.clone();
        missing.as_object_mut().unwrap().remove("pins");
        assert_eq!(parse_frame(&evt_text("hello", missing), Side::Console).err().unwrap().why, "body");
        assert_eq!(parse_frame(r#"{"t":"evt","op":"bye","body":{"reason":"left"},"x":1}"#, Side::Console).err().unwrap().why, "keys");
        // unknown op and unknown t; a request keeps its id so it can be answered fleet-op
        let e = parse_frame(r#"{"t":"req","id":7,"op":"format-disk","body":{}}"#, Side::Relay).err().unwrap();
        assert_eq!((e.id, e.why), (Some(7), "op"));
        assert_eq!(parse_frame(r#"{"t":"push","id":1}"#, Side::Relay).err().unwrap().why, "t");
        // ids from 1 to 2^31
        assert!(parse_frame(&req_text(1, "nonce", json!({"n": 1})), Side::Relay).is_ok());
        assert!(parse_frame(r#"{"t":"req","id":2147483648,"op":"nonce","body":{"n":1}}"#, Side::Relay).is_ok());
        assert_eq!(parse_frame(r#"{"t":"req","id":2147483649,"op":"nonce","body":{"n":1}}"#, Side::Relay).err().unwrap().why, "keys");
        assert_eq!(parse_frame(r#"{"t":"req","id":0,"op":"nonce","body":{"n":1}}"#, Side::Relay).err().unwrap().why, "keys");
        // a request the relay may not receive
        assert_eq!(parse_frame(&req_text(3, "renew", json!({"spki": "", "sigOld": "", "sigNew": ""})), Side::Relay).err().unwrap().why, "op");
        // sizes: 512 KiB to the relay, 1 MiB to the console
        let big = req_text(4, "call", json!({"method": "POST", "path": "x", "query": "", "body": "a".repeat(TO_RELAY_MAX), "caller": {}, "auth": null}));
        assert_eq!(parse_frame(&big, Side::Relay).err().unwrap().why, "size");
        let fits = evt_text("audit", json!({"entries": ["a".repeat(TO_RELAY_MAX)]}));
        assert!(parse_frame(&fits, Side::Console).is_ok());
        assert_eq!(parse_frame(&evt_text("audit", json!({"entries": ["a".repeat(TO_CONSOLE_MAX)]})), Side::Console).err().unwrap().why, "size");
        // confirm-done's result union (revision 3.2): `unknown` with answer null; any other value is fleet-op
        for r in ["ok", "refused", "expired", "failed"] {
            assert!(parse_frame(&evt_text("confirm-done", json!({"id": "cf_1", "result": r, "answer": {}})), Side::Console).is_ok(), "{r}");
        }
        assert!(parse_frame(&evt_text("confirm-done", json!({"id": "cf_1", "result": "unknown", "answer": null})), Side::Console).is_ok());
        assert_eq!(parse_frame(&evt_text("confirm-done", json!({"id": "cf_1", "result": "unknown", "answer": {}})), Side::Console).err().unwrap().why, "body");
        assert_eq!(parse_frame(&evt_text("confirm-done", json!({"id": "cf_1", "result": "maybe", "answer": null})), Side::Console).err().unwrap().why, "body");
        assert_eq!(parse_frame(&evt_text("bye", json!({"reason": "bored"})), Side::Relay).err().unwrap().why, "body");
        // answers
        assert_eq!(parse_frame(&res_err_text(5, &Refusal::of("fleet-op")), Side::Console).unwrap(), Frame::Res { id: 5, answer: Err(Refusal::of("fleet-op")) });
        assert!(matches!(parse_frame(&res_ok_text(5, json!({})), Side::Relay), Ok(Frame::Res { id: 5, answer: Ok(_) })));
    }

    #[test]
    fn api_ops_have_their_keys_directions_and_size_limits() {
        let entry = json!({"id": "t_acme_000001", "tseq": 1, "ts": 1, "action": "client_suspend", "target": "c_5f1a2b3c4d5e6f70"});
        assert!(matches!(parse_frame(&req_text(1, "api-tighten", json!({"org": "acme", "entry": entry.clone()})), Side::Relay), Ok(Frame::Req { op: "api-tighten", .. })));
        assert_eq!(parse_frame(&req_text(1, "api-tighten", json!({"org": "acme", "entry": entry})), Side::Console).err().unwrap().why, "op");
        assert_eq!(parse_frame(&req_text(1, "api-tighten", json!({"org": "acme"})), Side::Relay).err().unwrap().why, "body");
        assert_eq!(parse_frame(&req_text(1, "api-tighten", json!({"org": "acme", "entry": "x".repeat(8 * 1024)})), Side::Relay).err().unwrap().why, "size");
        assert_eq!(parse_frame(&req_text(1, "api-map", json!({"org": "acme", "map": "x".repeat(300 * 1024)})), Side::Relay).err().unwrap().why, "size");
        assert!(parse_frame(&req_text(1, "api-map", json!({"org": "acme", "map": "x".repeat(200 * 1024)})), Side::Relay).is_ok());
        let key = json!({"org": "acme", "pkv": 1, "key": "A".repeat(43), "not_before": 1});
        assert!(parse_frame(&req_text(1, "api-pseudonym-key", key), Side::Relay).is_ok());
        assert_eq!(parse_frame(&req_text(1, "api-pseudonym-key", json!({"org": "acme", "pkv": 1, "key": "A".repeat(1024), "not_before": 1})), Side::Relay).err().unwrap().why, "size");
        // api-heads has no body keys; hello and welcome carry no api key (mixed versions)
        assert!(matches!(parse_frame(&req_text(1, "api-heads", json!({})), Side::Relay), Ok(Frame::Req { op: "api-heads", .. })));
        assert_eq!(parse_frame(&req_text(1, "api-heads", json!({"org": "acme"})), Side::Relay).err().unwrap().why, "body");
        let welcome = json!({"consoleId": "c_0123456789abcdef", "time": 1, "policySeq": 0, "rosterSeq": 0, "trustSeq": 1, "api": {"acme": {"seq": 0, "tseq": 0}}});
        assert_eq!(parse_frame(&evt_text("welcome", welcome), Side::Relay).err().unwrap().why, "body");
    }

    #[test]
    fn api_audit_ops_have_their_keys_directions_and_size_limits() {
        // api-audit goes relay to console, at most 1 MiB
        let batch = |n: usize| json!({"org": "acme", "repr": "as_is", "first": 1, "last": 1, "entries": ["x".repeat(n)]});
        assert!(matches!(parse_frame(&req_text(1, "api-audit", batch(10)), Side::Console), Ok(Frame::Req { op: "api-audit", .. })));
        assert_eq!(parse_frame(&req_text(1, "api-audit", batch(10)), Side::Relay).err().unwrap().why, "op");
        assert!(parse_frame(&req_text(1, "api-audit", batch(1000 * 1024)), Side::Console).is_ok());
        assert_eq!(parse_frame(&req_text(1, "api-audit", batch(API_AUDIT_MAX)), Side::Console).err().unwrap().why, "size");
        assert_eq!(parse_frame(&req_text(1, "api-audit", json!({"org": "acme", "repr": "as_is", "first": 1, "entries": []})), Side::Console).err().unwrap().why, "body");
        // api-chains goes console to relay, 256 B in
        let after = json!({"as_is": 0, "pseudonymized": 0, "removed": 0});
        assert!(matches!(parse_frame(&req_text(1, "api-chains", json!({"org": "acme", "after": after.clone()})), Side::Relay), Ok(Frame::Req { op: "api-chains", .. })));
        assert_eq!(parse_frame(&req_text(1, "api-chains", json!({"org": "acme", "after": after})), Side::Console).err().unwrap().why, "op");
        assert_eq!(parse_frame(&req_text(1, "api-chains", json!({"org": "a".repeat(200), "after": {}})), Side::Relay).err().unwrap().why, "size");
        // checkpoint certificates go console to relay
        assert!(matches!(parse_frame(&req_text(1, "api-checkpoint-csr", json!({"org": "acme"})), Side::Relay), Ok(Frame::Req { op: "api-checkpoint-csr", .. })));
        assert_eq!(parse_frame(&req_text(1, "api-checkpoint-csr", json!({"org": "acme"})), Side::Console).err().unwrap().why, "op");
        let cert = json!({"org": "acme", "cert": "A".repeat(2000), "chain": ["A".repeat(2000)]});
        assert!(matches!(parse_frame(&req_text(1, "api-checkpoint-cert", cert), Side::Relay), Ok(Frame::Req { op: "api-checkpoint-cert", .. })));
        assert_eq!(parse_frame(&req_text(1, "api-checkpoint-cert", json!({"org": "acme", "cert": "A"})), Side::Relay).err().unwrap().why, "body");
        assert_eq!(parse_frame(&req_text(1, "api-checkpoint-cert", json!({"org": "acme", "cert": "A".repeat(API_CHECKPOINT_CERT_MAX), "chain": []})), Side::Relay).err().unwrap().why, "size");
    }

    #[test]
    fn api_failover_goes_console_to_relay_within_64_kib() {
        let ok = json!({"org": "acme", "destination": "siem", "action": "csr", "params": {}});
        assert!(matches!(parse_frame(&req_text(1, "api-failover", ok.clone()), Side::Relay), Ok(Frame::Req { op: "api-failover", .. })));
        assert_eq!(parse_frame(&req_text(1, "api-failover", ok), Side::Console).err().unwrap().why, "op");
        assert_eq!(parse_frame(&req_text(1, "api-failover", json!({"org": "acme", "destination": "siem", "action": "csr"})), Side::Relay).err().unwrap().why, "body");
        let big = json!({"org": "acme", "destination": "siem", "action": "install", "params": {"cert_pem": "A".repeat(API_FAILOVER_MAX)}});
        assert_eq!(parse_frame(&req_text(1, "api-failover", big), Side::Relay).err().unwrap().why, "size");
        let fits = json!({"org": "acme", "destination": "siem", "action": "install", "params": {"cert_pem": "A".repeat(40 * 1024)}});
        assert!(parse_frame(&req_text(1, "api-failover", fits), Side::Relay).is_ok());
    }

    #[test]
    fn api_synced_goes_console_to_relay_within_4_kib() {
        let ok = json!({"orgs": {"acme": {"seq": 3, "tseq": 7}}});
        assert!(matches!(parse_frame(&req_text(1, "api-synced", ok.clone()), Side::Relay), Ok(Frame::Req { op: "api-synced", .. })));
        assert_eq!(parse_frame(&req_text(1, "api-synced", ok), Side::Console).err().unwrap().why, "op");
        assert_eq!(parse_frame(&req_text(1, "api-synced", json!({"acme": {"seq": 3, "tseq": 7}})), Side::Relay).err().unwrap().why, "body");
        let big: Map<String, Value> = (0..200).map(|i| (format!("org-{i:04}-{}", "x".repeat(10)), json!({"seq": 1, "tseq": 1}))).collect();
        assert_eq!(parse_frame(&req_text(1, "api-synced", json!({"orgs": big})), Side::Relay).err().unwrap().why, "size");
    }

    /// API-1d 2.4: `api-orgs` (2 KiB) and `api-spokes` (1 KiB) go console to relay; `api-map` may carry `trust`.
    #[test]
    fn api_spokes_ops_go_console_to_relay_within_their_limits() {
        let orgs = json!({"orgs": ["acme", "globex"], "generation": 3});
        assert!(matches!(parse_frame(&req_text(1, "api-orgs", orgs.clone()), Side::Relay), Ok(Frame::Req { op: "api-orgs", .. })));
        assert_eq!(parse_frame(&req_text(1, "api-orgs", orgs), Side::Console).err().unwrap().why, "op");
        assert_eq!(parse_frame(&req_text(1, "api-orgs", json!({})), Side::Relay).err().unwrap().why, "body");
        // the binding generation is required; a root release is optional
        assert_eq!(parse_frame(&req_text(1, "api-orgs", json!({"orgs": ["acme"]})), Side::Relay).err().unwrap().why, "body");
        let released = json!({"orgs": ["acme"], "generation": 4, "release_roots": ["acme"]});
        assert!(matches!(parse_frame(&req_text(1, "api-orgs", released), Side::Relay), Ok(Frame::Req { op: "api-orgs", .. })));
        let many: Vec<String> = (0..64).map(|i| format!("org-{i:02}-{}", "x".repeat(26))).collect();
        assert_eq!(parse_frame(&req_text(1, "api-orgs", json!({"orgs": many, "generation": 1})), Side::Relay).err().unwrap().why, "size");
        let view = json!({"org": "acme", "view": "nodes", "query": "relay=r_21&limit=50", "people": false});
        assert!(matches!(parse_frame(&req_text(1, "api-spokes", view.clone()), Side::Relay), Ok(Frame::Req { op: "api-spokes", .. })));
        assert_eq!(parse_frame(&req_text(1, "api-spokes", view), Side::Console).err().unwrap().why, "op");
        assert_eq!(parse_frame(&req_text(1, "api-spokes", json!({"org": "acme", "view": "nodes", "query": ""})), Side::Relay).err().unwrap().why, "body");
        let long = json!({"org": "acme", "view": "nodes", "query": "q=".to_string() + &"x".repeat(1024), "people": true});
        assert_eq!(parse_frame(&req_text(1, "api-spokes", long), Side::Relay).err().unwrap().why, "size");
        let trusted = json!({"org": "acme", "map": {}, "trust": {"root": "-----BEGIN CERTIFICATE-----", "signer_policy": {}}});
        assert!(matches!(parse_frame(&req_text(1, "api-map", trusted), Side::Relay), Ok(Frame::Req { op: "api-map", .. })));
        assert_eq!(parse_frame(&req_text(1, "api-map", json!({"org": "acme", "map": {}, "roots": {}})), Side::Relay).err().unwrap().why, "body");
    }

    #[test]
    fn export_parts_pass_the_console_cap_and_nothing_else_does() {
        // revision 4 2.5: a 4 MiB part in base64 fits `api-export-part`; every other frame to the console keeps 1 MiB
        let part = json!({"org": "acme", "job": "j_7c6b5a4938271605", "n": 0, "data": "A".repeat(4 * 1024 * 1024 / 3 * 4 + 32), "sha256": "a".repeat(64)});
        assert!(matches!(parse_frame(&req_text(1, "api-export-part", part.clone()), Side::Console), Ok(Frame::Req { op: "api-export-part", .. })));
        // the relay's own message cap refuses the full part before its op is read; a small part shows the direction
        assert_eq!(parse_frame(&req_text(1, "api-export-part", part), Side::Relay).err().unwrap().why, "size");
        let small = json!({"org": "acme", "job": "j_7c6b5a4938271605", "n": 0, "data": "AAAA", "sha256": "a".repeat(64)});
        assert_eq!(parse_frame(&req_text(1, "api-export-part", small), Side::Relay).err().unwrap().why, "op");
        let seal = json!({"org": "acme", "job": "j_7c6b5a4938271605", "seal": {"part_sha256": vec!["a".repeat(64); 12800]}});
        assert!(parse_frame(&req_text(1, "api-export-seal", seal), Side::Console).is_ok());
        let too_big = json!({"org": "acme", "job": "j_7c6b5a4938271605", "seal": {"x": "a".repeat(API_EXPORT_SEAL_MAX)}});
        assert_eq!(parse_frame(&req_text(1, "api-export-seal", too_big), Side::Console).err().unwrap().why, "size");
        assert_eq!(parse_frame(&req_text(1, "api-audit", json!({"org": "acme", "repr": "as_is", "first": 1, "last": 1, "entries": ["a".repeat(2 * 1024 * 1024)]})), Side::Console).err().unwrap().why, "size");
        assert_eq!(parse_frame(&res_ok_text(1, json!({"x": "a".repeat(2 * 1024 * 1024)})), Side::Console).err().unwrap().why, "size");
        assert_eq!(parse_frame(&evt_text("audit", json!({"entries": ["a".repeat(2 * 1024 * 1024)]})), Side::Console).err().unwrap().why, "size");
        assert_eq!(frame_limit(Side::Console), API_EXPORT_PART_MAX);
        assert_eq!(frame_base(Side::Console), TO_CONSOLE_MAX);
        for (op, max) in [("api-export", 64 * 1024), ("api-export-status", 256), ("api-export-cancel", 1024)] {
            assert_eq!(op_frame_max(op), Some(max), "{op}");
        }
        let status = json!({"org": "acme", "job": "j_7c6b5a4938271605"});
        assert!(matches!(parse_frame(&req_text(1, "api-export-status", status.clone()), Side::Relay), Ok(Frame::Req { .. })));
        assert_eq!(parse_frame(&req_text(1, "api-export-status", status), Side::Console).err().unwrap().why, "op");
    }

    #[test]
    fn large_answers_travel_in_parts() {
        let body = json!({"lines": (0..40_000).map(|i| format!("line {i} \"quoted\" \\ {}", "x".repeat(40))).collect::<Vec<_>>()});
        let frames = answer_frames(9, body.clone());
        assert!(frames.len() > 1);
        let mut parts = Parts::default();
        let mut done = None;
        for f in &frames {
            assert!(f.len() <= TO_CONSOLE_MAX);
            match parse_frame(f, Side::Console).unwrap() {
                Frame::Part { id, i, of, data } => done = parts.push(id, i, of, &data).unwrap(),
                other => panic!("{other:?}"),
            }
        }
        assert_eq!(done, Some(body));
        assert_eq!(answer_frames(1, json!({"a": 1})).len(), 1);
        // out of order is refused
        let mut p = Parts::default();
        assert!(p.push(1, 1, 3, "x").is_err());
    }

    #[test]
    fn dropped_parts_free_their_share_of_the_total() {
        let mut p = Parts::default();
        assert_eq!(p.push(4, 0, 3, "abc"), Ok(None));
        assert_eq!(p.push(5, 0, 2, "1"), Ok(None));
        assert_eq!(p.total, 4);
        // a call that timed out (3.8): its parts are dropped, the others stay
        p.drop_id(4);
        assert_eq!(p.total, 1);
        assert!(!p.open.contains_key(&4));
        p.drop_id(4);
        assert_eq!(p.total, 1);
        assert_eq!(p.push(5, 1, 2, "2"), Ok(Some(json!(12))));
        // a late part of the dropped call starts a new, out of order answer and is refused
        assert!(p.push(4, 1, 3, "x").is_err());
        assert_eq!(p.total, 0);
    }

    #[test]
    fn backoff_stays_within_1_to_60_seconds_and_its_jitter() {
        let mut b = Backoff::default();
        let mut base = 1.0f64;
        for _ in 0..20 {
            let (lo, hi) = ((base * 0.8).max(1.0), (base * 1.2).min(60.0));
            let low = Backoff { step: b.step }.next_with(0.0).as_secs_f64();
            let high = Backoff { step: b.step }.next_with(0.999_999).as_secs_f64();
            let d = b.next().as_secs_f64();
            assert!((1.0..=60.0).contains(&d), "{d}");
            assert!(d >= lo - 1e-9 && d <= hi + 1e-9, "{d} not in {lo}..{hi}");
            assert!((low - lo).abs() < 1e-6 && (high - hi).abs() < 1e-3, "{low} {high} {lo} {hi}");
            base = (base * 2.0).min(60.0);
        }
        b.reset();
        assert!(b.next_with(0.5).as_secs_f64() <= 1.2);
    }

    #[tokio::test]
    async fn the_local_channel_carries_the_same_frames() {
        let (a, b) = local_pair();
        let (mut atx, mut arx) = Wire::Local(a).split();
        let (mut btx, mut brx) = Wire::Local(b).split();
        assert!(atx.text(req_text(1, "nonce", json!({"n": 2}))).await);
        let In::Text(t) = brx.next().await else { panic!() };
        assert!(matches!(parse_frame(&t, Side::Relay), Ok(Frame::Req { id: 1, op: "nonce", .. })));
        btx.close(CLOSE_BYE).await;
        assert!(matches!(arx.next().await, In::Closed(Some(CLOSE_BYE))));
    }

    #[test]
    fn events_capture_records_every_send() {
        let (e, log) = Events::capture();
        e.clone().send("state", json!({}));
        assert_eq!(log.lock().len(), 1);
    }

    /// Every word this slice ships equals the fleet words vector (13.3, 13.4).
    #[test]
    fn words_match_the_fleet_words_vector() {
        let v = vector("admin_console_fleet_words_v1.json");
        for (code, status, words) in REFUSALS {
            let r = &v["refusals"][*code];
            assert_eq!(r["status"].as_u64(), Some(u64::from(*status)), "{code} missing or with another status");
            assert_eq!(r["words"].as_str(), Some(*words), "{code}");
        }
        for (id, words) in CLI_WORDS {
            assert_eq!(v["cli"][*id].as_str(), Some(*words), "{id}");
        }
    }

    /// AC-2b-D 9.3: the three new ops, their directions and keys, and the optional Meeting Hub fields.
    #[test]
    fn the_deploy_frames_of_9_3() {
        let hello = json!({"relayId": "r_0123456789abcdef", "version": "1", "fips": false, "profile": "standard", "os": "linux", "localConsole": false, "scopes": [], "scopeGeneration": 1, "readOnly": false, "confirm": [], "bootstrap": {}, "policySeq": 0, "rosterSeq": 0, "trustSeq": 1, "pins": [], "certNotAfter": 0});
        // Remote Spokes: without the Meeting Hub fields; Meeting Hub: with them
        assert!(parse_frame(&evt_text("hello", hello.clone()), Side::Console).is_ok());
        let mut meet = hello.clone();
        meet["meetRoots"] = json!(["m_0123456789abcdef0123456789abcdef"]);
        meet["meetCrl"] = json!({"source": "none", "thisUpdate": null, "number": null, "issuer": null, "sha256": null, "pending": null});
        meet["meetPki"] = Value::Null;
        assert!(parse_frame(&evt_text("hello", meet.clone()), Side::Console).is_ok());
        meet["meetSomething"] = json!(1);
        assert_eq!(parse_frame(&evt_text("hello", meet), Side::Console).err().unwrap().why, "body");
        let welcome = json!({"consoleId": "c_0123456789abcdef", "time": 1, "policySeq": 0, "rosterSeq": 0, "trustSeq": 1, "meetCaId": null});
        assert!(parse_frame(&evt_text("welcome", welcome), Side::Relay).is_ok());
        // meet-cert goes to the console only, with exactly csr and signerCsr
        let req = req_text(5, "meet-cert", json!({"csr": "AA", "signerCsr": null}));
        assert!(matches!(parse_frame(&req, Side::Console), Ok(Frame::Req { id: 5, op: "meet-cert", .. })));
        assert_eq!(parse_frame(&req, Side::Relay).err().unwrap().why, "op");
        assert_eq!(parse_frame(&req_text(6, "meet-cert", json!({"csr": "AA"})), Side::Console).err().unwrap().why, "body");
        // meet-crl (event) and meet-crl-get (request) go to the relay only
        let crl = evt_text("meet-crl", json!({"crl": "-----BEGIN X509 CRL-----"}));
        assert!(matches!(parse_frame(&crl, Side::Relay), Ok(Frame::Evt { op: "meet-crl", .. })));
        assert_eq!(parse_frame(&crl, Side::Console).err().unwrap().why, "op");
        assert!(matches!(parse_frame(&req_text(7, "meet-crl-get", json!({})), Side::Relay), Ok(Frame::Req { id: 7, op: "meet-crl-get", .. })));
        assert_eq!(parse_frame(&req_text(8, "meet-crl-get", json!({"x": 1})), Side::Relay).err().unwrap().why, "body");
        // a CRL of 320 KiB fits a frame to the relay (AC-1 3.5)
        assert!(parse_frame(&evt_text("meet-crl", json!({"crl": "a".repeat(320 * 1024)})), Side::Relay).is_ok());
    }

    #[test]
    fn no_long_dashes() {
        let src = include_str!("fleet_wire.rs");
        assert!(!src.contains('\u{2014}') && !src.contains('\u{2013}'));
        for (_, _, w) in REFUSALS {
            assert!(!w.contains('\u{2014}') && !w.contains('\u{2013}'));
        }
    }
}
