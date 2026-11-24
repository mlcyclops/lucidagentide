// CE-1 end-to-end encrypted chat, the device side (docs/chat-e2ee/contract.md revision 11: section 2 encodings,
// 3 signature validity over time, 4 device chat key bundles, 5 wraps, 6 envelopes, payloads and who may send them,
// 7.3 call-room catch-up, 8 own-device history share, 11 folding; docs/api/contract-r5-1c.md 2.1 to 2.8 device side
// and 7.4 to 7.6: API apps, approvals, delegated posts and Stop). A port of `src/meet_chat_e2ee.py` (and of the
// parts of `src/meet_e2ee.py` it needs: `lp`, `u64`, `check_cert`, `Revocation`, `sign`, `verify_sig`). Member and
// service logs, org policies, key stores and sender keys are in `ce_device_log.rs`; files and documents in
// `ce_device_files.rs` and `ce_device_docs.rs`.
//
// No network and no storage: keys, stores and lookups come in as arguments, and every state type converts to and
// from `serde_json::Value` for the caller to seal at rest. Every refusal is a `CeError` whose text is safe to log.
// Algorithms (AWS-LC): P-384 ECDH, HKDF-SHA-384 (salt 32 zero bytes, 32 bytes out), AES-256-GCM, ECDSA with the
// device certificate key (P-256 with SHA-256, P-384 with SHA-384, DER signatures in base64).

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use aws_lc_rs::rand::SystemRandom;
use aws_lc_rs::{aead, agreement, digest, hkdf, signature};
use serde_json::{json, Map, Value};

use crate::ce_device_log::{LogState, PolicyView};
use crate::codec::{hex, sha256};
use crate::der::tlv;
use crate::meet_json::{b64 as b64_encode, b64_strict, days_from_civil, random_bytes, token_hex};
use crate::meet_x509::{int_hex, pem_blocks, Cert, Crl};

pub type Obj = Map<String, Value>;
/// A device: (principal, device id).
pub type Pd = (String, String);
/// The certificates (certificate PEM, chain PEM) this device holds for a (principal, device).
pub type CertSource<'a> = &'a dyn Fn(&str, &str) -> Vec<(String, String)>;

// -- errors ------------------------------------------------------------------------------------------------------

/// A refusal with the CE-1 error code the vectors name (`encoding`, `padding`, `signature`, `rules`, `time`, `file`,
/// ...).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CeError {
    pub code: &'static str,
    pub message: String,
}

pub type CeResult<T> = Result<T, CeError>;

pub fn fail<T>(code: &'static str, message: impl Into<String>) -> CeResult<T> {
    Err(CeError { code, message: message.into() })
}

impl CeError {
    pub fn new(code: &'static str, message: impl Into<String>) -> CeError {
        CeError { code, message: message.into() }
    }
}

impl fmt::Display for CeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for CeError {}

fn rules<T>(message: impl Into<String>) -> CeResult<T> {
    fail("rules", message)
}

fn encoding<T>(message: impl Into<String>) -> CeResult<T> {
    fail("encoding", message)
}

/// An `encoding` refusal.
pub fn encoding_error(message: impl Into<String>) -> CeError {
    CeError::new("encoding", message)
}

/// The refusal of a member log that is shorter than, or does not extend, the head this device pinned.
pub fn log_refused() -> CeError {
    CeError::new("log_refused", TEXT_LOG_CHANGED)
}

/// The refusal of a repeated epoch with a different key (raise the repeated-key alarm).
pub fn repeated_key() -> CeError {
    CeError::new("repeated_key", "a repeated epoch came with a different key")
}

// -- constants ---------------------------------------------------------------------------------------------------

pub const DCK: &str = "lucid-meet-chat-dck-v1";
pub const WRAP: &str = "lucid-meet-chat-wrap-v1";
pub const WRAPSIG: &str = "lucid-meet-chat-wrapsig-v1";
// Used by the CE-1 vectors only (section 8 history share is for people, never an app).
#[cfg_attr(not(test), allow(dead_code))]
pub const SHARE: &str = "lucid-meet-chat-share-v1";
// Used by the CE-1 vectors only (section 8 history share is for people, never an app).
#[cfg_attr(not(test), allow(dead_code))]
pub const SHARESIG: &str = "lucid-meet-chat-sharesig-v1";
pub const MKEY: &str = "lucid-meet-chat-key-v1";
pub const MSG: &str = "lucid-meet-chat-msg-v1";
pub const MSGSIG: &str = "lucid-meet-chat-sig-v1";
pub const MEMBER: &str = "lucid-meet-chat-member-v1";
pub const SET: &str = "lucid-meet-chat-set-v1";
// Used by the CE-1 vectors only (section 7.3 catch-up is call-room chat, where apps never are).
#[cfg_attr(not(test), allow(dead_code))]
pub const CATCHUP: &str = "lucid-meet-chat-catchup-v1";
pub const AI_HISTORY: &str = "lucid-meet-ai-history-v1";

pub const BUCKETS: [usize; 5] = [256, 1024, 4096, 16384, 65536];
pub const PAYLOAD_MAX: usize = 65535;
pub const TAG: usize = 16;
pub const MAX_INT: i64 = (1 << 53) - 1;
pub const SKEW_MS: i64 = 10 * 60 * 1000;
pub const DAY_S: i64 = 24 * 3600;
pub const BUNDLE_LIFE_MAX_S: i64 = 35 * DAY_S;
pub const BUNDLE_EVERY_S: i64 = 30 * DAY_S;
pub const ROTATE_S: i64 = 7 * DAY_S;
pub const ROTATE_MESSAGES: i64 = 5000;
pub const JOIN_EPOCH_MAX_S: i64 = DAY_S;
pub const CHANNEL_MAX: usize = 1000;
pub const WRAP_BLOB_LEN: usize = 12 + 32 + TAG;
pub const ZERO_HASH: [u8; 32] = [0; 32];

pub const KINDS: [&str; 12] = ["post", "edit", "delete", "react", "vote", "close", "pin", "doc", "docsnap", "docaware", "wf", "ai"];
/// Revision 8: the only kinds in an `ai:` cid.
pub const AI_CONV_KINDS: [&str; 2] = ["ai", "delete"];
pub const DOC_KINDS: [&str; 3] = ["doc", "docsnap", "docaware"];
pub const APPS_PREFIX: &str = "apps.";
/// KeyStore sender suffix of the document counters.
pub const DOC_STREAM: &str = ":doc";
/// Doc updates per epoch (posts: ROTATE_MESSAGES).
pub const DOC_ROTATE: i64 = 50000;
pub const CMD_ARGS_MAX: usize = 4000;
pub const WFS_STATES: [&str; 6] = ["refused", "active", "stopped", "ask", "answered", "expired"];
pub const ROLE_OPS: [&str; 4] = ["remove", "leave", "admin", "unadmin"];

pub const TEXT_WAITING_KEY: &str = "Waiting for the key to this message";
pub const TEXT_LOG_CHANGED: &str = "This conversation's member list was changed in a way that could not be verified";
pub const TEXT_MEMBER_LIST_NOT_VERIFIED: &str = "The member list of this conversation could not be verified";
// revision 11 (API-1c 2.3, 7.4 to 7.6): API apps, approvals, delegated posts and Stop
pub const API_APP_TYPE: &str = "api";
pub const REV11_EXTRAS: [&str; 5] = ["apr", "apra", "dlg", "dlgn", "stop"];
pub const APR_ACTIONS: [&str; 1] = ["post"];
/// Characters.
pub const APR_TEXT_MAX: usize = 4000;
pub const APR_AGENT_MAX: usize = 64;
pub const APR_CONV_NAME_MAX: usize = 100;
pub const DLGN_SCOPES_MAX: usize = 32;

// certificate URIs (shared/meet_pki.py)
pub const DEVICE_URI_PREFIX: &str = "urn:lucid-meet:device:";
pub const SEED_URI_PREFIX: &str = "urn:lucid-meet:enroll:";
pub const RELAY_URI: &str = "urn:lucid-meet:relay";
pub const CONSOLE_URI: &str = "urn:lucid-meet:console";
pub const CONNECTOR_URI: &str = "urn:lucid-meet:connector";
pub const APP_URI: &str = "urn:lucid-meet:app";
pub const ARCHIVE_URI: &str = "urn:lucid-meet:archive";
pub const SSO_URI: &str = "urn:lucid-meet:sso";
pub const ORG_URI_PREFIX: &str = "urn:lucid-meet:org:";
// Used by the CE-1 vectors only (the SSO marker is shown to people, never read by the connector).
#[cfg_attr(not(test), allow(dead_code))]
pub const VIA_SSO_URI: &str = "urn:lucid-meet:via:sso";

// -- small encodings ---------------------------------------------------------------------------------------------

/// Length-prefixed fields: 4-byte big-endian length, then the bytes.
pub fn lp(fields: &[&[u8]]) -> Vec<u8> {
    let mut out = Vec::with_capacity(fields.iter().map(|f| 4 + f.len()).sum());
    for f in fields {
        out.extend_from_slice(&(f.len() as u32).to_be_bytes());
        out.extend_from_slice(f);
    }
    out
}

/// An 8-byte big-endian integer (the values here are checked to be 0 to 2^53 - 1 first).
pub fn u64b(n: i64) -> [u8; 8] {
    (n as u64).to_be_bytes()
}

/// `lp` built field by field (for layouts with optional fields).
#[derive(Default)]
struct Lp(Vec<u8>);

impl Lp {
    fn b(&mut self, f: &[u8]) {
        self.0.extend_from_slice(&(f.len() as u32).to_be_bytes());
        self.0.extend_from_slice(f);
    }
    fn s(&mut self, s: &str) {
        self.b(s.as_bytes());
    }
    fn n(&mut self, n: i64) {
        self.b(&u64b(n));
    }
}

/// Standard base64 with padding.
pub fn b64(data: &[u8]) -> String {
    b64_encode(data)
}

/// Canonical standard base64 of `what` (`_unb64`): `length` exact when given, at least `minimum` bytes.
pub fn unb64(value: &Value, what: &str, length: Option<usize>, minimum: usize) -> CeResult<Vec<u8>> {
    let Some(s) = value.as_str() else { return encoding(format!("{what} is not base64")) };
    unb64_str(s, what, length, minimum)
}

pub fn unb64_str(s: &str, what: &str, length: Option<usize>, minimum: usize) -> CeResult<Vec<u8>> {
    let Some(raw) = b64_strict(s) else { return encoding(format!("{what} is not base64")) };
    if b64(&raw) != s {
        return encoding(format!("{what} is not canonical base64"));
    }
    if length.is_some_and(|n| raw.len() != n) {
        return encoding(format!("{what} has the wrong length"));
    }
    if raw.len() < minimum {
        return encoding(format!("{what} is too short"));
    }
    Ok(raw)
}

fn is_hex_lower(s: &str) -> bool {
    s.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

fn from_hex(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 || !s.is_ascii() {
        return None;
    }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok()).collect()
}

/// `length` bytes of lower-case hex (`_unhex`).
pub fn unhex(value: &Value, what: &str, length: usize) -> CeResult<Vec<u8>> {
    match value.as_str() {
        Some(s) if s.len() == 2 * length && is_hex_lower(s) => Ok(from_hex(s).unwrap_or_default()),
        _ => encoding(format!("{what} is not {length} bytes of lower-case hex")),
    }
}

fn hash32(b: &[u8]) -> CeResult<[u8; 32]> {
    b.try_into().map_err(|_| CeError::new("encoding", "a hash is 32 bytes"))
}

fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// A JSON integer (never a bool or a float).
pub fn int_of(v: &Value) -> Option<i64> {
    match v {
        Value::Number(n) => n.as_i64(),
        _ => None,
    }
}

/// Python's `int(x or 0)` for the JSON integers of a verified object.
pub(crate) fn int_or0(v: Option<&Value>) -> i64 {
    v.and_then(int_of).unwrap_or(0)
}

/// An integer `low..MAX_INT` (`check_int`).
pub fn check_int(v: &Value, name: &str, low: i64) -> CeResult<i64> {
    match int_of(v) {
        Some(n) => check_n(n, name, low),
        None => encoding(format!("{name} out of range")),
    }
}

/// `check_int` of a number already typed.
pub fn check_n(n: i64, name: &str, low: i64) -> CeResult<i64> {
    if n < low || n > MAX_INT {
        return encoding(format!("{name} out of range"));
    }
    Ok(n)
}

fn principal_ok(p: &str) -> bool {
    !p.is_empty() && p.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b".!#$%&'*+/=?^_`{|}~@-".contains(&c))
}

/// ASCII, lower case, `a-z0-9` and `.!#$%&'*+/=?^_`{|}~-@`; refused before any crypto.
pub fn check_principal(p: &str) -> CeResult<()> {
    if !principal_ok(p) {
        return fail("principal", "not a valid principal");
    }
    Ok(())
}

pub fn principal_value(v: &Value) -> CeResult<String> {
    match v.as_str() {
        Some(p) if principal_ok(p) => Ok(p.to_string()),
        _ => fail("principal", "not a valid principal"),
    }
}

fn device_ok(d: &str) -> bool {
    d.len() == 16 && is_hex_lower(d)
}

pub fn check_device(d: &str) -> CeResult<()> {
    if !device_ok(d) {
        return encoding("not a device id");
    }
    Ok(())
}

pub fn device_value(v: &Value) -> CeResult<String> {
    match v.as_str() {
        Some(d) if device_ok(d) => Ok(d.to_string()),
        _ => encoding("not a device id"),
    }
}

pub(crate) fn mid_ok(m: &str) -> bool {
    m.len() == 32 && is_hex_lower(m)
}

pub fn check_mid(m: &str) -> CeResult<()> {
    if !mid_ok(m) {
        return encoding("not a message id");
    }
    Ok(())
}

/// "" or a message id.
pub fn check_ref(m: &str) -> CeResult<()> {
    if m.is_empty() {
        return Ok(());
    }
    check_mid(m)
}

fn ref_value(v: &Value) -> CeResult<String> {
    match v.as_str() {
        Some(s) => check_ref(s).map(|_| s.to_string()),
        None => encoding("not a message id"),
    }
}

fn serial_ok(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty() && (b[0].is_ascii_digit() && b[0] != b'0' || (b'a'..=b'f').contains(&b[0])) && is_hex_lower(s)
}

pub fn check_serial(s: &str) -> CeResult<()> {
    if !serial_ok(s) {
        return encoding("not a certificate serial");
    }
    Ok(())
}

fn serial_value(v: &Value) -> CeResult<String> {
    match v.as_str() {
        Some(s) if serial_ok(s) => Ok(s.to_string()),
        _ => encoding("not a certificate serial"),
    }
}

/// Sorted by raw UTF-8 bytes (never by locale or code-unit order).
// Used by the CE-1 vectors only (pins the section 2 byte order the connector gets from `String` ordering).
#[cfg_attr(not(test), allow(dead_code))]
pub fn sort_bytes<S: AsRef<str>>(items: &[S]) -> Vec<String> {
    let mut out: Vec<String> = items.iter().map(|s| s.as_ref().to_string()).collect();
    out.sort();
    out
}

/// HKDF-SHA-384, salt 32 zero bytes, 32 bytes out.
pub fn hkdf32(ikm: &[u8], info: &[u8]) -> CeResult<[u8; 32]> {
    struct Len32;
    impl hkdf::KeyType for Len32 {
        fn len(&self) -> usize {
            32
        }
    }
    let prk = hkdf::Salt::new(hkdf::HKDF_SHA384, &ZERO_HASH).extract(ikm);
    let parts = [info];
    let mut out = [0u8; 32];
    prk.expand(&parts, Len32).and_then(|okm| okm.fill(&mut out)).map_err(|_| CeError::new("encoding", "a key could not be derived"))?;
    Ok(out)
}

pub fn new_mid() -> String {
    token_hex(16)
}

// -- canonical JSON (section 2) ----------------------------------------------------------------------------------

fn enc_str(s: &str, out: &mut String) {
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

/// The length of one character in canonical JSON (inside its string).
// Used by `make_ai_record` only, which the CE-1 vectors pin.
#[cfg_attr(not(test), allow(dead_code))]
fn enc_len(c: char) -> usize {
    match c {
        '"' | '\\' | '\u{8}' | '\u{c}' | '\n' | '\r' | '\t' => 2,
        c if (c as u32) < 0x20 => 6,
        c => c.len_utf8(),
    }
}

fn enc(v: &Value, out: &mut String) -> CeResult<()> {
    match v {
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(n) => match n.as_i64() {
            Some(i) if (-MAX_INT..=MAX_INT).contains(&i) => out.push_str(&i.to_string()),
            Some(_) => return encoding("an integer is out of range"),
            None if n.is_u64() => return encoding("an integer is out of range"),
            None => return encoding("only objects, arrays, strings, integers and booleans"),
        },
        Value::String(s) => enc_str(s, out),
        Value::Array(a) => {
            out.push('[');
            for (i, item) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                enc(item, out)?;
            }
            out.push(']');
        }
        Value::Object(m) => {
            let mut keys: Vec<&String> = m.keys().collect();
            keys.sort();
            out.push('{');
            for (i, k) in keys.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                enc_str(k, out);
                out.push(':');
                enc(&m[k.as_str()], out)?;
            }
            out.push('}');
        }
        Value::Null => return encoding("only objects, arrays, strings, integers and booleans"),
    }
    Ok(())
}

/// The one canonical encoding (contract section 2).
pub fn canonical_json(v: &Value) -> CeResult<Vec<u8>> {
    let mut out = String::new();
    enc(v, &mut out)?;
    Ok(out.into_bytes())
}

/// Decode strictly, re-encode canonically and require byte equality.
pub fn canonical_loads(data: &[u8]) -> CeResult<Value> {
    let Ok(text) = std::str::from_utf8(data) else { return encoding("payload is not UTF-8") };
    let Ok(value) = serde_json::from_str::<Value>(text) else { return encoding("payload is not JSON") };
    if canonical_json(&value)? != data {
        return encoding("payload is not canonical");
    }
    Ok(value)
}

// -- padding -----------------------------------------------------------------------------------------------------

pub fn pad(payload: &[u8]) -> CeResult<Vec<u8>> {
    let n = payload.len();
    if n > PAYLOAD_MAX {
        return fail("padding", "payload too large");
    }
    for bucket in BUCKETS {
        if n < bucket {
            let mut out = Vec::with_capacity(bucket);
            out.extend_from_slice(payload);
            out.push(0x80);
            out.resize(bucket, 0);
            return Ok(out);
        }
    }
    fail("padding", "payload too large")
}

/// The last non-zero byte must be 0x80 and every byte after it zero.
pub fn unpad(padded: &[u8]) -> CeResult<Vec<u8>> {
    let end = padded.iter().rposition(|&b| b != 0);
    match end {
        Some(i) if padded[i] == 0x80 => Ok(padded[..i].to_vec()),
        _ => fail("padding", "bad padding"),
    }
}

// -- principals and conversation ids -----------------------------------------------------------------------------

/// `person`, `app` or `archive` by the principal's shape (`cert_kind` cross-checks it on every signature).
pub fn principal_kind(p: &str) -> CeResult<&'static str> {
    check_principal(p)?;
    let (local, domain) = match p.rfind('@') {
        Some(i) => (&p[..i], &p[i + 1..]),
        None => ("", p),
    };
    if !domain.starts_with(APPS_PREFIX) {
        return Ok("person");
    }
    Ok(if local == "archive" { "archive" } else { "app" })
}

/// The domain a service principal belongs to (`apps.` taken off), or a person's.
pub fn principal_domain(p: &str) -> CeResult<String> {
    check_principal(p)?;
    let domain = match p.rfind('@') {
        Some(i) => &p[i + 1..],
        None => p,
    };
    Ok(domain.strip_prefix(APPS_PREFIX).unwrap_or(domain).to_string())
}

pub fn dm_cid(a: &str, b: &str) -> CeResult<String> {
    check_principal(a)?;
    check_principal(b)?;
    let (p1, p2) = if a.as_bytes() <= b.as_bytes() { (a, b) } else { (b, a) };
    Ok(format!("dm:{}", hex(&sha256(&lp(&[p1.as_bytes(), p2.as_bytes()])))))
}

pub fn channel_cid(channel_id: &str) -> CeResult<String> {
    if channel_id.is_empty() {
        return encoding("not a channel id");
    }
    Ok(format!("ch:{channel_id}"))
}

/// Revision 8 (AI-1 7.1): a person's own AI history conversation.
pub fn ai_cid(principal: &str) -> CeResult<String> {
    check_principal(principal)?;
    Ok(format!("ai:{}", hex(&sha256(&lp(&[AI_HISTORY.as_bytes(), principal.as_bytes()])))))
}

fn hex64_after(cid: &str, prefix: &str) -> bool {
    cid.strip_prefix(prefix).is_some_and(|h| h.len() == 64 && is_hex_lower(h))
}

/// `dm`, `ai`, `ch` or `room`.
pub fn cid_kind(cid: &str) -> CeResult<&'static str> {
    if hex64_after(cid, "dm:") {
        return Ok("dm");
    }
    if hex64_after(cid, "ai:") {
        return Ok("ai");
    }
    if cid.len() > 3 && cid.starts_with("ch:") {
        return Ok("ch");
    }
    if let Some(rest) = cid.strip_prefix("room:") {
        if rest.find(':').is_some_and(|i| i > 0) && !cid.ends_with(':') {
            return Ok("room");
        }
    }
    encoding("not a conversation id")
}

fn cid_value(v: Option<&Value>) -> CeResult<String> {
    match v.and_then(Value::as_str) {
        Some(c) => cid_kind(c).map(|_| c.to_string()),
        None => encoding("not a conversation id"),
    }
}

/// Only the principal whose `ai:` cid this is sends in it (keys or messages); the archive never sends.
pub fn check_ai_sender(cid: &str, from_p: &str) -> CeResult<()> {
    check_principal(from_p)?;
    if cid_kind(cid)? == "ai" && (principal_kind(from_p)? != "person" || ai_cid(from_p)? != cid) {
        return rules("only its own person sends in an AI history");
    }
    Ok(())
}

/// Revision 8: an `ai:` cid holds only `ai` and `delete`; `ai` only an `ai:` cid. Refused as `encoding`.
pub fn check_cid_kind(cid: &str, kind: &str) -> CeResult<()> {
    let in_ai = cid_kind(cid)? == "ai";
    if in_ai && !AI_CONV_KINDS.contains(&kind) {
        return encoding("an AI history holds only AI records and their deletes");
    }
    if !in_ai && kind == "ai" {
        return encoding("an AI record outside an AI history");
    }
    Ok(())
}

/// The policy's retention kind of a conversation: `dm`, `group`, `channel` or `ai`.
pub fn retention_kind(cid: &str, log_kind: &str) -> CeResult<&'static str> {
    let kind = cid_kind(cid)?;
    if kind == "dm" || kind == "ai" {
        return Ok(kind);
    }
    Ok(if log_kind == "group" { "group" } else { "channel" })
}

pub fn check_policy_hash(h: &str) -> CeResult<()> {
    if h.len() != 64 || !is_hex_lower(h) {
        return encoding("a policy hash is 64 lower-case hex digits");
    }
    Ok(())
}

/// True for the ref of every message of a document: `doc:<32 hex>`.
pub fn is_doc_ref(r: &str) -> bool {
    r.strip_prefix("doc:").is_some_and(mid_ok)
}

fn pd_check(devices: &[Pd]) -> CeResult<()> {
    for (p, d) in devices {
        check_principal(p)?;
        check_device(d)?;
    }
    Ok(())
}

/// Devices as JSON `[[principal, device], ...]`.
pub fn pds_value(v: &Value) -> CeResult<Vec<Pd>> {
    let Some(items) = v.as_array() else { return encoding("a device is (principal, device)") };
    items
        .iter()
        .map(|item| match item.as_array().map(Vec::as_slice) {
            Some([p, d]) => Ok((principal_value(p)?, device_value(d)?)),
            _ => encoding("a device is (principal, device)"),
        })
        .collect()
}

fn pd_sort_key(pd: &Pd) -> String {
    format!("{}\n{}", pd.0, pd.1)
}

/// Sorted by `principal + "\n" + device` bytes.
pub fn sort_pds(pds: &mut [Pd]) {
    pds.sort_by_key(pd_sort_key);
}

pub fn set_hash(devices: &[Pd]) -> CeResult<[u8; 32]> {
    pd_check(devices)?;
    let mut pairs = devices.to_vec();
    sort_pds(&mut pairs);
    if pairs.windows(2).any(|w| w[0] == w[1]) {
        return encoding("a device is listed twice");
    }
    let mut b = Lp::default();
    b.s(SET);
    b.n(pairs.len() as i64);
    for (p, d) in &pairs {
        b.s(p);
        b.s(d);
    }
    Ok(sha256(&b.0))
}

/// A member log head: (seq, hash of the entry at seq); (0, 32 zero bytes) before the first entry and for every
/// conversation without a log.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Head {
    pub seq: i64,
    pub hash: [u8; 32],
}

pub const ZERO_HEAD: Head = Head { seq: 0, hash: ZERO_HASH };

impl Head {
    pub fn hash_hex(&self) -> String {
        hex(&self.hash)
    }
}

pub fn check_head(cid: &str, head: Head) -> CeResult<Head> {
    if cid_kind(cid)? == "ch" {
        check_n(head.seq, "log seq", 1)?;
        return Ok(head);
    }
    if head != ZERO_HEAD {
        return fail("head", "this conversation has no member log");
    }
    Ok(ZERO_HEAD)
}

// -- keys --------------------------------------------------------------------------------------------------------

/// A P-384 key for ECDH: a device chat key (DCK) or an ephemeral key. Debug never prints the scalar.
#[derive(Clone)]
pub struct DckKey {
    d: Vec<u8>,
    public: Vec<u8>,
}

impl fmt::Debug for DckKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "DckKey({}, <redacted>)", b64(&self.public))
    }
}

impl DckKey {
    /// A fresh key from AWS-LC's random bytes.
    pub fn generate() -> CeResult<DckKey> {
        for _ in 0..16 {
            if let Ok(k) = DckKey::from_scalar(&random_bytes(48)) {
                return Ok(k);
            }
        }
        encoding("a chat key could not be drawn")
    }

    /// From the 48-byte big-endian private scalar.
    pub fn from_scalar(d: &[u8]) -> CeResult<DckKey> {
        if d.len() != 48 {
            return encoding("a chat key is 48 bytes");
        }
        let k = agreement::PrivateKey::from_private_key(&agreement::ECDH_P384, d).map_err(|_| CeError::new("encoding", "unreadable chat key"))?;
        let public = k.compute_public_key().map_err(|_| CeError::new("encoding", "unreadable chat key"))?.as_ref().to_vec();
        Ok(DckKey { d: d.to_vec(), public })
    }

    /// `load_dck`: canonical base64 of the 48-byte scalar.
    pub fn from_b64(value: &str) -> CeResult<DckKey> {
        DckKey::from_scalar(&unb64_str(value, "chat key", Some(48), 0)?)
    }

    /// `dck_private_b64`, for the sealed store only.
    pub fn private_b64(&self) -> String {
        b64(&self.d)
    }

    /// `dck_raw`: the uncompressed point (97 bytes).
    pub fn raw(&self) -> &[u8] {
        &self.public
    }

    fn exchange(&self, peer: &[u8]) -> CeResult<Vec<u8>> {
        let k = agreement::PrivateKey::from_private_key(&agreement::ECDH_P384, &self.d).map_err(|_| CeError::new("encoding", "unreadable chat key"))?;
        agreement::agree(&k, agreement::UnparsedPublicKey::new(&agreement::ECDH_P384, peer), CeError::new("encoding", "not a P-384 point"), |z| Ok(z.to_vec()))
    }
}

/// A raw P-384 point (`_point`): 97 bytes, uncompressed, on the curve.
pub fn check_point(raw: &[u8]) -> CeResult<()> {
    if raw.len() != 97 || raw[0] != 4 || agreement::ParsedPublicKey::try_from(agreement::UnparsedPublicKey::new(&agreement::ECDH_P384, raw)).is_err() {
        return encoding("not a P-384 point");
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Curve {
    P256,
    P384,
}

/// A device's ECDSA certificate key: P-256 signs with SHA-256, P-384 with SHA-384 (`meet_e2ee.sign`), DER
/// signatures. Debug never prints it.
pub struct DeviceKey {
    pair: signature::EcdsaKeyPair,
    curve: Curve,
}

impl fmt::Debug for DeviceKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "DeviceKey({:?}, <redacted>)", self.curve)
    }
}

fn signing_alg(curve: Curve) -> &'static signature::EcdsaSigningAlgorithm {
    match curve {
        Curve::P256 => &signature::ECDSA_P256_SHA256_ASN1_SIGNING,
        Curve::P384 => &signature::ECDSA_P384_SHA384_ASN1_SIGNING,
    }
}

impl DeviceKey {
    /// From unencrypted PKCS#8 or SEC1 `ECPrivateKey` DER, P-256 or P-384.
    pub fn from_der(der: &[u8]) -> CeResult<DeviceKey> {
        for curve in [Curve::P256, Curve::P384] {
            if let Ok(pair) = signature::EcdsaKeyPair::from_private_key_der(signing_alg(curve), der) {
                return Ok(DeviceKey { pair, curve });
            }
        }
        encoding("the device key is not a P-256 or P-384 key")
    }

    /// From a PEM `PRIVATE KEY` or `EC PRIVATE KEY` block.
    // Used by the CE-1 vectors and connector_session tests only (the connector loads DER from its enrollment).
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn from_pem(pem: &str) -> CeResult<DeviceKey> {
        for label in ["PRIVATE KEY", "EC PRIVATE KEY"] {
            if let Some((_, der)) = pem_blocks(pem.as_bytes(), label).into_iter().next() {
                return DeviceKey::from_der(&der);
            }
        }
        encoding("no private key in the PEM text")
    }

    /// Base64 DER ECDSA over `data`.
    pub fn sign(&self, data: &[u8]) -> CeResult<String> {
        let sig = self.pair.sign(&SystemRandom::new(), data).map_err(|_| CeError::new("signature", "could not sign"))?;
        Ok(b64(sig.as_ref()))
    }
}

fn gcm_seal(key: &[u8], nonce: [u8; 12], aad: &[u8], plain: &[u8]) -> CeResult<Vec<u8>> {
    let k = aead::LessSafeKey::new(aead::UnboundKey::new(&aead::AES_256_GCM, key).map_err(|_| CeError::new("encoding", "a key is 32 bytes"))?);
    let mut buf = plain.to_vec();
    k.seal_in_place_append_tag(aead::Nonce::assume_unique_for_key(nonce), aead::Aad::from(aad), &mut buf).map_err(|_| CeError::new("encoding", "could not seal"))?;
    Ok(buf)
}

fn gcm_open(key: &[u8], nonce: &[u8], aad: &[u8], sealed: &[u8]) -> Option<Vec<u8>> {
    let nonce: [u8; 12] = nonce.try_into().ok()?;
    let k = aead::LessSafeKey::new(aead::UnboundKey::new(&aead::AES_256_GCM, key).ok()?);
    let mut buf = sealed.to_vec();
    let n = k.open_in_place(aead::Nonce::assume_unique_for_key(nonce), aead::Aad::from(aad), &mut buf).ok()?.len();
    buf.truncate(n);
    Some(buf)
}

fn seal_key(esk: &DckKey, recipient_raw: &[u8], info: &[u8], key: &[u8], nonce: [u8; 12]) -> CeResult<Vec<u8>> {
    let wk = hkdf32(&esk.exchange(recipient_raw)?, info)?;
    let mut out = nonce.to_vec();
    out.extend_from_slice(&gcm_seal(&wk, nonce, info, key)?);
    Ok(out)
}

fn open_key(private: &DckKey, eph_raw: &[u8], info: &[u8], blob: &[u8]) -> CeResult<Vec<u8>> {
    let wk = hkdf32(&private.exchange(eph_raw)?, info)?;
    if blob.len() < 12 {
        return fail("decrypt", "the key blob does not open");
    }
    let Some(key) = gcm_open(&wk, &blob[..12], info, &blob[12..]) else { return fail("decrypt", "the key blob does not open") };
    if key.len() != 32 {
        return fail("decrypt", "the key has the wrong size");
    }
    Ok(key)
}

fn esk_nonce(esk: Option<&DckKey>, nonce: Option<[u8; 12]>) -> CeResult<(DckKey, [u8; 12])> {
    let esk = match esk {
        Some(k) => k.clone(),
        None => DckKey::generate()?,
    };
    let nonce = match nonce {
        Some(n) => n,
        None => random_bytes(12).try_into().map_err(|_| CeError::new("encoding", "a nonce is 12 bytes"))?,
    };
    Ok((esk, nonce))
}

// -- certificates (meet_e2ee.check_cert, meet_pki) ---------------------------------------------------------------

const OID_EC_KEY: &[u8] = &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01];
const OID_P256: &[u8] = &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07];
const OID_P384: &[u8] = &[0x2b, 0x81, 0x04, 0x00, 0x22];
const OID_BC: &[u8] = &[0x55, 0x1d, 0x13];
const OID_KU: &[u8] = &[0x55, 0x1d, 0x0f];
const OID_EKU: &[u8] = &[0x55, 0x1d, 0x25];
const OID_INVALIDITY: &[u8] = &[0x55, 0x1d, 0x18];
const OID_CLIENT_AUTH: &[u8] = &[0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x02];

struct Der<'a> {
    tag: u8,
    value: &'a [u8],
}

fn der_one(d: &[u8]) -> Option<Der<'_>> {
    let t = tlv(d)?;
    Some(Der { tag: t.tag, value: t.value })
}

fn der_items(d: &[u8]) -> Option<Vec<Der<'_>>> {
    let mut d = d;
    let mut out = Vec::new();
    while !d.is_empty() {
        let t = tlv(d)?;
        out.push(Der { tag: t.tag, value: t.value });
        d = t.rest;
    }
    Some(out)
}

/// A DER time (UTCTime or GeneralizedTime, `Z`, fractions dropped) as unix seconds.
fn der_time(i: &Der) -> Option<i64> {
    let t = std::str::from_utf8(i.value).ok()?.strip_suffix('Z')?;
    let t = t.split('.').next()?;
    let (year, rest) = match i.tag {
        0x17 => {
            let yy: i64 = t.get(0..2)?.parse().ok()?;
            (if yy >= 50 { 1900 + yy } else { 2000 + yy }, t.get(2..)?)
        }
        0x18 => (t.get(0..4)?.parse().ok()?, t.get(4..)?),
        _ => return None,
    };
    let n = |a: usize| -> Option<i64> { rest.get(a..a + 2)?.parse().ok() };
    let (mo, d, h, mi) = (n(0)?, n(2)?, n(4)?, n(6)?);
    let sec = if rest.len() >= 10 { n(8)? } else { 0 };
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) {
        return None;
    }
    Some(days_from_civil(year, mo as u32, d as u32) * 86_400 + h * 3600 + mi * 60 + sec)
}

/// Every extension of a certificate: (OID, the OCTET STRING's contents).
fn cert_extensions(der: &[u8]) -> Option<Vec<(Vec<u8>, Vec<u8>)>> {
    let outer = der_one(der)?;
    let tbs = der_items(outer.value)?.into_iter().next()?;
    let mut out = Vec::new();
    for it in der_items(tbs.value)? {
        if it.tag != 0xa3 {
            continue;
        }
        let seq = der_one(it.value)?;
        for ext in der_items(seq.value)? {
            let f = der_items(ext.value)?;
            out.push((f.first()?.value.to_vec(), f.last()?.value.to_vec()));
        }
    }
    Some(out)
}

/// A SubjectPublicKeyInfo's EC curve and point.
fn spki_ec(spki: &[u8]) -> Option<(Curve, Vec<u8>)> {
    let seq = der_one(spki)?;
    let parts = der_items(seq.value)?;
    let alg = der_items(parts.first()?.value)?;
    if alg.first()?.value != OID_EC_KEY {
        return None;
    }
    let curve = match alg.get(1)?.value {
        OID_P256 => Curve::P256,
        OID_P384 => Curve::P384,
        _ => return None,
    };
    let bits = parts.get(1)?;
    if bits.tag != 0x03 {
        return None;
    }
    Some((curve, bits.value.get(1..)?.to_vec()))
}

/// A certificate with what CE-1 checks on it.
#[derive(Clone, Debug)]
pub struct CeCert {
    pub x: Cert,
    /// BasicConstraints (cA, pathLen), None without the extension.
    pub basic: Option<(bool, Option<i64>)>,
    /// KeyUsage (digitalSignature, keyCertSign), None without the extension.
    pub key_usage: Option<(bool, bool)>,
    /// ExtendedKeyUsage names clientAuth, None without the extension.
    pub client_auth: Option<bool>,
}

impl CeCert {
    pub fn from_der(der: &[u8]) -> CeResult<CeCert> {
        let bad = || CeError::new("certificate", "unreadable certificate");
        let x = Cert::from_der(der).ok_or_else(bad)?;
        let exts = cert_extensions(der).ok_or_else(bad)?;
        let (mut basic, mut key_usage, mut client_auth) = (None, None, None);
        for (oid, value) in exts {
            if oid == OID_BC {
                let seq = der_one(&value).ok_or_else(bad)?;
                let (mut ca, mut len) = (false, None);
                for f in der_items(seq.value).ok_or_else(bad)? {
                    match f.tag {
                        0x01 => ca = f.value.iter().any(|&b| b != 0),
                        0x02 if f.value.len() <= 4 => len = Some(f.value.iter().fold(0i64, |acc, &b| acc << 8 | b as i64)),
                        _ => {}
                    }
                }
                basic = Some((ca, len));
            } else if oid == OID_KU {
                let bits = der_one(&value).ok_or_else(bad)?;
                let first = bits.value.get(1).copied().unwrap_or(0);
                key_usage = Some((first & 0x80 != 0, first & 0x04 != 0));
            } else if oid == OID_EKU {
                let seq = der_one(&value).ok_or_else(bad)?;
                client_auth = Some(der_items(seq.value).ok_or_else(bad)?.iter().any(|o| o.value == OID_CLIENT_AUTH));
            }
        }
        Ok(CeCert { x, basic, key_usage, client_auth })
    }

    /// The first CERTIFICATE of a PEM text.
    pub fn from_pem(pem: &str) -> CeResult<CeCert> {
        match pem_blocks(pem.as_bytes(), "CERTIFICATE").into_iter().next() {
            Some((_, der)) => CeCert::from_der(&der),
            None => fail("certificate", "unreadable certificate"),
        }
    }

    /// Every certificate of a chain PEM ("" or an unreadable chain gives none, as `meet_e2ee._chain`).
    pub fn chain(pem: &str) -> Vec<CeCert> {
        if pem.trim().is_empty() {
            return Vec::new();
        }
        let mut out = Vec::new();
        for (_, der) in pem_blocks(pem.as_bytes(), "CERTIFICATE") {
            match CeCert::from_der(&der) {
                Ok(c) => out.push(c),
                Err(_) => return Vec::new(),
            }
        }
        out
    }

    /// `format(serial, "x")`.
    pub fn serial_hex(&self) -> &str {
        &self.x.serial
    }

    pub fn uris(&self) -> &[String] {
        &self.x.names.uris
    }

    /// SAN emails, stripped and lower case.
    pub fn emails(&self) -> Vec<String> {
        self.x.names.emails.iter().map(|e| e.trim().to_lowercase()).collect()
    }

    /// `cert_principal`: the first SAN email ("" when none).
    pub fn principal(&self) -> String {
        self.emails().into_iter().next().unwrap_or_default()
    }

    fn uri_value(&self, prefix: &str) -> String {
        self.uris().iter().filter_map(|u| u.strip_prefix(prefix)).find(|v| device_ok(v)).unwrap_or_default().to_string()
    }

    /// `cert_device_id`: the device URI's id ("" for a seed, a legacy certificate or none).
    pub fn device_id(&self) -> String {
        if !self.uri_value(SEED_URI_PREFIX).is_empty() {
            return String::new();
        }
        self.uri_value(DEVICE_URI_PREFIX)
    }

    /// The certificate's issuer name and `issuer`'s key signature.
    pub fn signed_by(&self, issuer: &CeCert) -> bool {
        self.x.issued_by(&issuer.x)
    }

    fn valid_at(&self, at_ms: i64) -> bool {
        self.x.not_before * 1000 <= at_ms && at_ms <= self.x.not_after * 1000
    }

    /// The org ids of the `urn:lucid-meet:org:<id>` URIs.
    pub fn orgs(&self) -> Vec<String> {
        self.uris().iter().filter_map(|u| u.strip_prefix(ORG_URI_PREFIX)).map(str::to_string).collect()
    }
}

/// `meet_pki.verify_chain` at `at_ms`: issued by the root directly or by one intermediate (pathLen 0, keyCertSign)
/// the root issued; every certificate valid then.
pub fn verify_chain(leaf: &CeCert, chain: &[CeCert], root: &CeCert, at_ms: i64) -> bool {
    if !leaf.valid_at(at_ms) || !root.valid_at(at_ms) {
        return false;
    }
    let Some((true, root_len)) = root.basic else { return false };
    if leaf.signed_by(root) {
        return true;
    }
    for inter in chain {
        if inter.x.spki == root.x.spki {
            continue;
        }
        if inter.basic != Some((true, Some(0))) || !inter.valid_at(at_ms) {
            continue;
        }
        if root_len.is_some_and(|l| l < 1) {
            continue;
        }
        if !inter.key_usage.is_some_and(|ku| ku.1) {
            continue;
        }
        if inter.signed_by(root) && leaf.signed_by(inter) {
            return true;
        }
    }
    false
}

/// `meet_e2ee.check_cert` at `at_ms` (revocation is judged by `Verifier`): a member's leaf certificate issued by
/// the Meet CA, valid then, a client signing certificate naming `principal` and a device.
pub fn check_cert(cert_pem: &str, ca: &CeCert, chain_pem: &str, principal: &str, at_ms: i64) -> CeResult<CeCert> {
    let bad = |m: &str| CeError::new("certificate", m);
    if cert_pem.trim().is_empty() {
        return Err(bad("no certificate"));
    }
    let cert = CeCert::from_pem(cert_pem).map_err(|_| bad("unreadable certificate"))?;
    if !(cert.x.not_before * 1000 <= at_ms && at_ms < cert.x.not_after * 1000) {
        return Err(bad("certificate not valid now"));
    }
    if !verify_chain(&cert, &CeCert::chain(chain_pem), ca, at_ms) {
        return Err(bad("certificate not issued by this Meet CA"));
    }
    match cert.basic {
        None => return Err(bad("certificate lacks a required extension")),
        Some((true, _)) => return Err(bad("a CA certificate is not a person")),
        _ => {}
    }
    match cert.key_usage {
        None => return Err(bad("certificate lacks a required extension")),
        Some((false, _)) => return Err(bad("certificate may not sign")),
        _ => {}
    }
    match cert.client_auth {
        None => return Err(bad("certificate lacks a required extension")),
        Some(false) => return Err(bad("certificate is not for a client")),
        _ => {}
    }
    if cert.emails().first().map(String::as_str) != Some(principal.trim().to_lowercase().as_str()) {
        return Err(bad("certificate names someone else"));
    }
    if !cert.uri_value(SEED_URI_PREFIX).is_empty() {
        return Err(bad("a new-device ticket is not a device certificate"));
    }
    if cert.uri_value(DEVICE_URI_PREFIX).is_empty() {
        return Err(bad("certificate names no device"));
    }
    if cert.uris().iter().any(|u| u == CONSOLE_URI || u == RELAY_URI) {
        return Err(bad("a service certificate is not a person"));
    }
    if spki_ec(&cert.x.spki).is_none() {
        return Err(bad("certificate key is not an elliptic curve key"));
    }
    Ok(cert)
}

/// `(kind, org)` of a chat member's certificate, from the certificate only: `person` (org ""), `app` or `archive`
/// with exactly one org URI. Console, relay, connector and SSO certificates never take part in chat.
pub fn cert_kind(cert: &CeCert) -> CeResult<(&'static str, String)> {
    let uris = cert.uris();
    if [CONSOLE_URI, RELAY_URI, CONNECTOR_URI, SSO_URI].iter().any(|r| uris.iter().any(|u| u == r)) {
        return fail("certificate", "a service certificate that is not an app or archive");
    }
    let has = |uri: &str| uris.iter().any(|u| u == uri);
    let kind = if has(APP_URI) {
        "app"
    } else if has(ARCHIVE_URI) {
        "archive"
    } else {
        return Ok(("person", String::new()));
    };
    let orgs = cert.orgs();
    if orgs.len() != 1 {
        return fail("certificate", "a service certificate names exactly one organization");
    }
    Ok((kind, orgs[0].clone()))
}

/// True for a person certificate added by signing in with SSO (the marker URI).
// Used by the CE-1 vectors only (the SSO marker is shown to people, never read by the connector).
#[cfg_attr(not(test), allow(dead_code))]
pub fn cert_via_sso(cert: &CeCert) -> bool {
    cert.uris().iter().any(|u| u == VIA_SSO_URI)
}

/// `meet_e2ee.verify_sig`: base64 DER ECDSA by the certificate's key (SHA-256 on P-256, SHA-384 on P-384).
pub fn verify_sig(cert: &CeCert, data: &[u8], sig_b64: &Value) -> bool {
    let (Some((curve, point)), Some(sig)) = (spki_ec(&cert.x.spki), sig_b64.as_str().and_then(b64_strict)) else { return false };
    let alg: &'static signature::EcdsaVerificationAlgorithm = match curve {
        Curve::P256 => &signature::ECDSA_P256_SHA256_ASN1,
        Curve::P384 => &signature::ECDSA_P384_SHA384_ASN1,
    };
    signature::UnparsedPublicKey::new(alg, &point).verify(data, &sig).is_ok()
}

// -- revocation (meet_e2ee.Revocation) ---------------------------------------------------------------------------

/// One revocation list with each entry's serial and the time its revocation counts from (invalidityDate when
/// present, else revocationDate), unix seconds.
#[derive(Clone, Debug)]
pub struct RevList {
    pub crl: Crl,
    pub entries: Vec<(String, i64)>,
}

fn crl_entries(der: &[u8]) -> Option<Vec<(String, i64)>> {
    let outer = der_one(der)?;
    let tbs = der_items(outer.value)?.into_iter().next()?;
    let mut seen_time = false;
    let mut out = Vec::new();
    for it in der_items(tbs.value)? {
        match it.tag {
            0x17 | 0x18 => seen_time = true,
            0x30 if seen_time => {
                for entry in der_items(it.value)? {
                    let f = der_items(entry.value)?;
                    let serial = int_hex(f.first()?.value);
                    let mut from = der_time(f.get(1)?)?;
                    if let Some(exts) = f.get(2) {
                        for ext in der_items(exts.value)? {
                            let g = der_items(ext.value)?;
                            if g.first()?.value == OID_INVALIDITY {
                                from = der_time(&der_one(g.last()?.value)?)?;
                            }
                        }
                    }
                    out.push((serial, from));
                }
            }
            _ => {}
        }
    }
    Some(out)
}

impl RevList {
    pub fn from_der(der: &[u8]) -> Option<RevList> {
        Some(RevList { crl: Crl::from_der(der)?, entries: crl_entries(der)? })
    }

    /// When the revocation of `serial` (hex) counts from, None when not listed.
    pub fn revoked_from(&self, serial: &str) -> Option<i64> {
        self.entries.iter().find(|(s, _)| s == serial).map(|(_, t)| *t)
    }

    /// nextUpdate in the future, lastUpdate not (beyond 10 minutes of clock skew).
    pub fn fresh(&self, now_ms: i64) -> bool {
        self.crl.next_update.is_some_and(|n| n * 1000 > now_ms) && self.crl.this_update * 1000 <= now_ms + 600_000
    }

    fn signed_by(&self, issuer: &CeCert) -> bool {
        self.crl.issuer == issuer.x.subject && self.crl.signature_valid(&issuer.x.spki)
    }
}

/// Back-to-back DER structures (each an outer SEQUENCE).
pub fn split_der(data: &[u8]) -> CeResult<Vec<Vec<u8>>> {
    let mut out = Vec::new();
    let mut d = data;
    while !d.is_empty() {
        if d[0] != 0x30 {
            return encoding("unreadable revocation list");
        }
        let Some(t) = tlv(d) else { return encoding("unreadable revocation list") };
        let used = d.len() - t.rest.len();
        out.push(d[..used].to_vec());
        d = t.rest;
    }
    Ok(out)
}

/// The revocation lists this device could verify: each signed by the Meet CA or by an intermediate of the given
/// chain. Lists nobody here can verify are ignored.
#[derive(Clone, Debug, Default)]
pub struct Revocation {
    pub crls: Vec<(CeCert, RevList)>,
}

impl Revocation {
    pub fn parse(data: &[u8], ca_pem: &str, chain_pem: &str) -> CeResult<Revocation> {
        let ca = CeCert::from_pem(ca_pem)?;
        let mut issuers = vec![ca];
        issuers.extend(CeCert::chain(chain_pem));
        let mut crls = Vec::new();
        for der in split_der(data)? {
            let Some(list) = RevList::from_der(&der) else { continue };
            if let Some(issuer) = issuers.iter().find(|i| list.signed_by(i)) {
                crls.push((issuer.clone(), list));
            }
        }
        Ok(Revocation { crls })
    }

    /// At least one list here verified.
    pub fn usable(&self) -> bool {
        !self.crls.is_empty()
    }

    /// Per issuer the newer list (lastUpdate) of the two: an older list served again never replaces a newer one.
    pub fn merge(&self, other: Option<&Revocation>) -> Revocation {
        let mut best: Vec<(CeCert, RevList)> = Vec::new();
        for (who, list) in self.crls.iter().chain(other.map(|o| o.crls.iter()).into_iter().flatten()) {
            match best.iter_mut().find(|(w, _)| w.x.subject == who.x.subject && w.x.spki == who.x.spki) {
                Some(held) => {
                    if list.crl.this_update > held.1.crl.this_update {
                        *held = (who.clone(), list.clone());
                    }
                }
                None => best.push((who.clone(), list.clone())),
            }
        }
        Revocation { crls: best }
    }
}

// -- section 3: signature validity over time ---------------------------------------------------------------------

fn rank(code: &str) -> u8 {
    match code {
        "revocation_unknown" => 1,
        "revoked" => 2,
        "signature" => 3,
        _ => 0,
    }
}

/// Judges a signer at its signed time (contract section 3) against the Meet CA this device holds, the revocation
/// lists it verified, and `require_crl`.
#[derive(Clone, Debug)]
pub struct Verifier {
    ca: Option<CeCert>,
    pub revocation: Option<Revocation>,
    pub require_crl: bool,
    /// The clock revocation lists are judged fresh by (ms); None reads the system clock.
    pub now_ms: Option<i64>,
}

impl Verifier {
    pub fn new(ca_pem: &str, revocation: Option<Revocation>, require_crl: bool) -> Verifier {
        Verifier { ca: CeCert::from_pem(ca_pem).ok(), revocation, require_crl, now_ms: None }
    }

    /// The same verifier with a fixed clock.
    // Used by the CE-1 vectors only (they judge revocation lists at the vectors' fixed time).
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn at(mut self, now_ms: i64) -> Verifier {
        self.now_ms = Some(now_ms);
        self
    }

    fn now(&self) -> i64 {
        self.now_ms.unwrap_or_else(crate::codec::now_ms)
    }

    pub fn check_time(&self, signed_ms: i64, observed_ms: i64) -> CeResult<()> {
        check_n(signed_ms, "signed time", 0)?;
        check_n(observed_ms, "observed time", 0)?;
        if (observed_ms - signed_ms).abs() > SKEW_MS {
            return fail("time", "the signed time is too far from when it was first seen");
        }
        Ok(())
    }

    /// The signer's certificate after `check_time` and `judge`.
    #[allow(clippy::too_many_arguments)]
    pub fn signer(&self, certs: &[(String, String)], principal: &str, device: &str, serial: Option<&str>, signed_ms: i64, observed_ms: i64, data: &[u8], sig: &Value) -> CeResult<CeCert> {
        self.check_time(signed_ms, observed_ms)?;
        self.judge(certs, principal, device, serial, signed_ms, data, sig)
    }

    /// The certificate and signature at `signed_ms` (no observation bound); the most telling refusal of all the
    /// certificates tried.
    #[allow(clippy::too_many_arguments)]
    pub fn judge(&self, certs: &[(String, String)], principal: &str, device: &str, serial: Option<&str>, signed_ms: i64, data: &[u8], sig: &Value) -> CeResult<CeCert> {
        check_principal(principal)?;
        check_device(device)?;
        check_n(signed_ms, "signed time", 0)?;
        let mut best = CeError::new("certificate", "no certificate for this device");
        for (cert_pem, chain_pem) in certs {
            match self.one(cert_pem, chain_pem, principal, device, serial, signed_ms, data, sig) {
                Ok(cert) => return Ok(cert),
                Err(e) => {
                    if rank(e.code) >= rank(best.code) {
                        best = e;
                    }
                }
            }
        }
        Err(best)
    }

    #[allow(clippy::too_many_arguments)]
    fn one(&self, cert_pem: &str, chain_pem: &str, principal: &str, device: &str, serial: Option<&str>, at_ms: i64, data: &[u8], sig: &Value) -> CeResult<CeCert> {
        let Some(ca) = self.ca.as_ref() else { return fail("certificate", "unreadable certificate") };
        let cert = check_cert(cert_pem, ca, chain_pem, principal, at_ms)?;
        if serial.is_some_and(|s| cert.serial_hex() != s) {
            return fail("certificate", "the certificate serial differs");
        }
        if cert.device_id() != device {
            return fail("certificate", "the certificate names another device");
        }
        if cert_kind(&cert)?.0 != principal_kind(principal)? {
            return fail("certificate", "the certificate's kind does not fit the principal");
        }
        self.revocation_check(&cert, ca, chain_pem, at_ms)?;
        if !verify_sig(&cert, data, sig) {
            return fail("signature", "the signature does not verify");
        }
        Ok(cert)
    }

    fn revocation_check(&self, cert: &CeCert, ca: &CeCert, chain_pem: &str, at_ms: i64) -> CeResult<()> {
        let chain = CeCert::chain(chain_pem);
        let links: Vec<(&CeCert, &CeCert)> = if cert.signed_by(ca) {
            vec![(cert, ca)]
        } else {
            let Some(inter) = chain.iter().find(|c| cert.signed_by(c)) else { return fail("certificate", "certificate not issued by this Meet CA") };
            vec![(cert, inter), (inter, ca)]
        };
        let now = self.now();
        for (item, issuer) in links {
            let mut fresh = false;
            for (who, list) in self.revocation.iter().flat_map(|r| r.crls.iter()) {
                if who.x.subject != issuer.x.subject || who.x.spki != issuer.x.spki {
                    continue;
                }
                if list.revoked_from(item.serial_hex()).is_some_and(|from| from * 1000 <= at_ms) {
                    return fail("revoked", "the certificate was revoked when this was signed");
                }
                fresh = fresh || list.fresh(now);
            }
            if !fresh && self.require_crl {
                return fail("revocation_unknown", "no fresh revocation list");
            }
        }
        Ok(())
    }
}

// -- section 4: device chat key bundles --------------------------------------------------------------------------

pub fn bundle_signed_bytes(principal: &str, device: &str, dck_raw: &[u8], created: i64, expires: i64, serial: &str) -> Vec<u8> {
    lp(&[DCK.as_bytes(), principal.as_bytes(), device.as_bytes(), dck_raw, &u64b(created), &u64b(expires), serial.as_bytes()])
}

/// A bundle this device verified (its own, or another device's it wraps keys to).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerifiedBundle {
    pub principal: String,
    pub device: String,
    pub dck_raw: Vec<u8>,
    pub dck_sha256: [u8; 32],
    pub created: i64,
    pub expires: i64,
    pub serial: String,
    pub cert_pem: String,
    pub chain_pem: String,
}

/// Python's `str(x or "")` of a JSON field.
fn str_or_empty(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(v) if !falsy(v) => v.to_string(),
        _ => String::new(),
    }
}

/// Python truthiness of a JSON value.
fn falsy(v: &Value) -> bool {
    match v {
        Value::Null => true,
        Value::Bool(b) => !b,
        Value::Number(n) => n.as_f64() == Some(0.0),
        Value::String(s) => s.is_empty(),
        Value::Array(a) => a.is_empty(),
        Value::Object(o) => o.is_empty(),
    }
}

impl VerifiedBundle {
    pub fn valid_at_ms(&self, ts_ms: i64) -> bool {
        self.created * 1000 - SKEW_MS <= ts_ms && ts_ms < self.expires * 1000
    }

    pub fn dck_b64(&self) -> String {
        b64(&self.dck_raw)
    }

    pub fn to_value(&self) -> Value {
        json!({"principal": self.principal, "device": self.device, "dck": self.dck_b64(), "created": self.created,
               "expires": self.expires, "serial": self.serial, "cert": self.cert_pem, "chain": self.chain_pem})
    }

    pub fn from_value(data: &Value) -> CeResult<VerifiedBundle> {
        let raw = unb64(data.get("dck").unwrap_or(&Value::Null), "chat key", Some(97), 0)?;
        let field = |k: &str| data.get(k).unwrap_or(&Value::Null);
        Ok(VerifiedBundle {
            principal: principal_value(field("principal"))?,
            device: device_value(field("device"))?,
            dck_sha256: sha256(&raw),
            dck_raw: raw,
            created: check_int(field("created"), "created", 0)?,
            expires: check_int(field("expires"), "expires", 0)?,
            serial: serial_value(field("serial"))?,
            cert_pem: str_or_empty(data.get("cert")),
            chain_pem: str_or_empty(data.get("chain")),
        })
    }
}

/// This device's bundle: its chat key signed with its certificate key (a new one every 30 days and on renewal).
pub fn make_bundle(device_key: &DeviceKey, cert_pem: &str, chain_pem: &str, dck: &DckKey, created: i64, expires: Option<i64>) -> CeResult<Value> {
    let cert = CeCert::from_pem(cert_pem)?;
    let principal = cert.principal();
    check_principal(&principal)?;
    let device = cert.device_id();
    check_device(&device)?;
    let serial = cert.serial_hex().to_string();
    check_n(created, "created", 0)?;
    let expires = match expires {
        None => created + BUNDLE_EVERY_S,
        Some(e) => check_n(e, "expires", 1)?,
    };
    let raw = dck.raw();
    let sig = device_key.sign(&bundle_signed_bytes(&principal, &device, raw, created, expires, &serial))?;
    Ok(json!({"principal": principal, "device": device, "dck": b64(raw), "created": created, "expires": expires,
              "serial": serial, "cert": cert_pem, "chain": chain_pem, "sig": sig}))
}

/// A bundle as received: shape, life (at most 35 days), not from the future, not expired at `at_ms` (default
/// now), signed by the device's certificate at `created`.
pub fn verify_bundle(bundle: &Value, verifier: &Verifier, now_s: i64, observed_s: Option<i64>, at_ms: Option<i64>) -> CeResult<VerifiedBundle> {
    let Some(b) = bundle.as_object() else { return encoding("a bundle is an object") };
    let field = |k: &str| b.get(k).unwrap_or(&Value::Null);
    let principal = principal_value(field("principal"))?;
    let device = device_value(field("device"))?;
    let raw = unb64(field("dck"), "chat key", Some(97), 0)?;
    check_point(&raw)?;
    let created = check_int(field("created"), "created", 0)?;
    let expires = check_int(field("expires"), "expires", 0)?;
    let serial = serial_value(field("serial"))?;
    let Some(cert_pem) = field("cert").as_str() else { return encoding("bundle certificate") };
    let chain_pem = match b.get("chain") {
        Some(v) if !falsy(v) => match v.as_str() {
            Some(s) => s,
            None => return encoding("bundle certificate"),
        },
        _ => "",
    };
    if expires <= created || expires - created > BUNDLE_LIFE_MAX_S {
        return rules("a bundle lives at most 35 days");
    }
    let observed = observed_s.unwrap_or(now_s);
    if created > observed + SKEW_MS / 1000 {
        return fail("time", "the bundle is from the future");
    }
    let judge_ms = at_ms.unwrap_or(now_s * 1000);
    if judge_ms >= expires * 1000 {
        return fail("time", "the bundle expired");
    }
    let certs = [(cert_pem.to_string(), chain_pem.to_string())];
    verifier.judge(&certs, &principal, &device, Some(serial.as_str()), created * 1000, &bundle_signed_bytes(&principal, &device, &raw, created, expires, &serial), field("sig"))?;
    Ok(VerifiedBundle { principal, device, dck_sha256: sha256(&raw), dck_raw: raw, created, expires, serial, cert_pem: cert_pem.to_string(), chain_pem: chain_pem.to_string() })
}

/// A new bundle every 30 days and on certificate renewal.
pub fn bundle_due(current: Option<&VerifiedBundle>, cert_serial: &str, now_s: i64) -> bool {
    match current {
        None => true,
        Some(c) => c.serial != cert_serial || now_s - c.created >= BUNDLE_EVERY_S,
    }
}

// -- section 5: wraps --------------------------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
pub fn wrap_info(cid: &str, from_p: &str, from_d: &str, epoch: i64, to_p: &str, to_d: &str, eph_raw: &[u8], dck_raw: &[u8]) -> Vec<u8> {
    lp(&[WRAP.as_bytes(), cid.as_bytes(), from_p.as_bytes(), from_d.as_bytes(), &u64b(epoch), to_p.as_bytes(), to_d.as_bytes(), eph_raw, dck_raw])
}

/// Revision 6: a wrap with `pols` signs `u64(len(pols))` then each policy hash (32 raw bytes, its own field) after
/// `log_hash`; `pols` None is the revision 3 layout.
#[allow(clippy::too_many_arguments)]
pub fn wrap_signed_bytes(cid: &str, from_p: &str, from_d: &str, epoch: i64, to_p: &str, to_d: &str, eph_raw: &[u8], dck_raw: &[u8], blob: &[u8], members: &[u8], head: &Head, ts: i64, serial: &str, pols: Option<&[String]>) -> CeResult<Vec<u8>> {
    let mut b = Lp::default();
    for f in [WRAPSIG, cid, from_p, from_d] {
        b.s(f);
    }
    b.n(epoch);
    b.s(to_p);
    b.s(to_d);
    b.b(eph_raw);
    b.b(&sha256(dck_raw));
    b.b(blob);
    b.b(members);
    b.n(head.seq);
    b.b(&head.hash);
    if let Some(pols) = pols {
        b.n(pols.len() as i64);
        for h in pols {
            check_policy_hash(h)?;
            b.b(&from_hex(h).unwrap_or_default());
        }
    }
    b.n(ts);
    b.s(serial);
    Ok(b.0)
}

fn check_pols_list(cid: &str, pols: Option<Vec<String>>) -> CeResult<Option<Vec<String>>> {
    let kind = cid_kind(cid)?;
    let Some(pols) = pols else {
        if kind == "ai" {
            return encoding("an AI history wrap names its policies");
        }
        return Ok(None);
    };
    if kind != "dm" && kind != "ai" {
        return encoding("only a direct message or AI history wrap names policies");
    }
    for h in &pols {
        check_policy_hash(h)?;
    }
    if pols.windows(2).any(|w| w[0] >= w[1]) {
        return encoding("pols are sorted and distinct");
    }
    Ok(Some(pols))
}

/// A wrap's `pols`: only on `dm:` and `ai:` cids, sorted, distinct policy hashes; an `ai:` wrap always carries them.
pub fn check_pols(cid: &str, pols: Option<&Value>) -> CeResult<Option<Vec<String>>> {
    let list = match pols {
        None | Some(Value::Null) => None,
        Some(Value::Array(a)) => {
            cid_kind(cid)?;
            let mut out = Vec::with_capacity(a.len());
            for h in a {
                match h.as_str() {
                    Some(s) => out.push(s.to_string()),
                    None => return encoding("a policy hash is 64 lower-case hex digits"),
                }
            }
            Some(out)
        }
        Some(_) => {
            let kind = cid_kind(cid)?;
            if kind != "dm" && kind != "ai" {
                return encoding("only a direct message or AI history wrap names policies");
            }
            return encoding("pols is a list");
        }
    };
    check_pols_list(cid, list)
}

/// A wrap of `key` (this device's epoch `epoch` key of `cid`) to `to`. `pols`: the policy hashes the sender used for
/// a `dm:` or `ai:` device set (always carried there, None meaning none); other cids never carry them. `esk` and
/// `nonce` are fixed only by the vectors.
#[allow(clippy::too_many_arguments)]
pub fn make_wrap(device_key: &DeviceKey, cid: &str, from_p: &str, from_d: &str, serial: &str, epoch: i64, key: &[u8], to: &VerifiedBundle, members: &[u8], head: Head, ts: i64, esk: Option<&DckKey>, nonce: Option<[u8; 12]>, pols: Option<&[String]>) -> CeResult<Value> {
    let kind = cid_kind(cid)?;
    let pols = if kind == "dm" || kind == "ai" {
        let set: BTreeSet<String> = pols.unwrap_or_default().iter().cloned().collect();
        check_pols_list(cid, Some(set.into_iter().collect()))?
    } else if pols.is_some_and(|p| !p.is_empty()) {
        return encoding("only a direct message or AI history wrap names policies");
    } else {
        None
    };
    check_ai_sender(cid, from_p)?;
    check_device(from_d)?;
    check_serial(serial)?;
    check_n(epoch, "epoch", 1)?;
    check_n(ts, "ts", 0)?;
    let head = check_head(cid, head)?;
    if key.len() != 32 || members.len() != 32 {
        return encoding("key and members are 32 bytes");
    }
    if to.principal == from_p && to.device == from_d {
        return rules("a device does not wrap to itself");
    }
    let (esk, nonce) = esk_nonce(esk, nonce)?;
    let eph = esk.raw().to_vec();
    let info = wrap_info(cid, from_p, from_d, epoch, &to.principal, &to.device, &eph, &to.dck_raw);
    let blob = seal_key(&esk, &to.dck_raw, &info, key, nonce)?;
    let sig = device_key.sign(&wrap_signed_bytes(cid, from_p, from_d, epoch, &to.principal, &to.device, &eph, &to.dck_raw, &blob, members, &head, ts, serial, pols.as_deref())?)?;
    let mut out = json!({"cid": cid, "from": {"principal": from_p, "device": from_d, "serial": serial}, "epoch": epoch,
                         "to": {"principal": to.principal, "device": to.device}, "eph": b64(&eph),
                         "dck_sha256": hex(&to.dck_sha256), "blob": b64(&blob), "members": hex(members),
                         "log_seq": head.seq, "log_hash": head.hash_hex(), "ts": ts, "sig": sig});
    if let Some(p) = pols {
        out["pols"] = json!(p);
    }
    Ok(out)
}

/// A party `{principal, device}` (and `serial` when asked).
fn party(value: Option<&Value>, with_serial: bool) -> CeResult<(String, String, String)> {
    let want: &[&str] = if with_serial { &["principal", "device", "serial"] } else { &["principal", "device"] };
    let Some(o) = value.and_then(Value::as_object) else { return encoding("a party is {principal, device}") };
    if o.len() != want.len() || !want.iter().all(|k| o.contains_key(*k)) {
        return encoding("a party is {principal, device}");
    }
    let p = principal_value(&o["principal"])?;
    let d = device_value(&o["device"])?;
    let s = if with_serial { serial_value(&o["serial"])? } else { String::new() };
    Ok((p, d, s))
}

/// An opened wrap: the sender's epoch key and whether the device set it was made for is the one this device
/// verifies.
#[derive(Clone, PartialEq, Eq)]
pub struct OpenedWrap {
    pub cid: String,
    pub from_p: String,
    pub from_d: String,
    pub epoch: i64,
    pub key: Vec<u8>,
    pub head: Head,
    pub ts: i64,
    pub members_ok: bool,
    pub pols: Vec<String>,
}

impl fmt::Debug for OpenedWrap {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OpenedWrap").field("cid", &self.cid).field("from_p", &self.from_p).field("from_d", &self.from_d).field("epoch", &self.epoch).field("head", &self.head).field("ts", &self.ts).field("members_ok", &self.members_ok).field("pols", &self.pols).finish_non_exhaustive()
    }
}

/// The device set this device verifies for a wrap: `(cid, head, pols)` to devices (for a DM both principals'
/// devices plus the archive devices of the named policies), None when unknown; an error counts as unknown.
pub type MembersFor<'a> = &'a dyn Fn(&str, &Head, &[String]) -> CeResult<Option<Vec<Pd>>>;

fn my_bundle<'a>(my_bundles: &'a [(VerifiedBundle, DckKey)], me_p: &str, me_d: &str, dck_sha: &[u8], ts: i64) -> CeResult<&'a (VerifiedBundle, DckKey)> {
    for item in my_bundles {
        let vb = &item.0;
        if vb.dck_sha256[..] == *dck_sha && vb.principal == me_p && vb.device == me_d {
            if !vb.valid_at_ms(ts) {
                return fail("time", "my chat key was not valid when this was signed");
            }
            return Ok(item);
        }
    }
    fail("no_key", "no chat key of mine matches")
}

/// Opens a wrap addressed to this device (`me_p`, `me_d`) with one of its bundles' chat keys, after the sender's
/// signature at the wrap's time.
#[allow(clippy::too_many_arguments)]
pub fn open_wrap(wrap: &Value, me_p: &str, me_d: &str, my_bundles: &[(VerifiedBundle, DckKey)], certs_for: CertSource, verifier: &Verifier, observed_ms: i64, members_for: MembersFor) -> CeResult<OpenedWrap> {
    let Some(w) = wrap.as_object() else { return encoding("a wrap is an object") };
    if w.get("share") == Some(&Value::Bool(true)) {
        return encoding("a wrap is an object");
    }
    let field = |k: &str| w.get(k).unwrap_or(&Value::Null);
    let cid = cid_value(w.get("cid"))?;
    let (from_p, from_d, serial) = party(w.get("from"), true)?;
    let (to_p, to_d, _) = party(w.get("to"), false)?;
    check_ai_sender(&cid, &from_p)?;
    if to_p != me_p || to_d != me_d {
        return rules("this wrap is for another device");
    }
    if from_p == me_p && from_d == me_d {
        return rules("a device does not wrap to itself");
    }
    let epoch = check_int(field("epoch"), "epoch", 1)?;
    let ts = check_int(field("ts"), "ts", 0)?;
    let eph = unb64(field("eph"), "ephemeral key", Some(97), 0)?;
    check_point(&eph)?;
    let dck_sha = unhex(field("dck_sha256"), "dck_sha256", 32)?;
    let blob = unb64(field("blob"), "key blob", Some(WRAP_BLOB_LEN), 0)?;
    let members = unhex(field("members"), "members", 32)?;
    let seq = check_int(field("log_seq"), "log seq", 0)?;
    let head = check_head(&cid, Head { seq, hash: hash32(&unhex(field("log_hash"), "log hash", 32)?)? })?;
    let pols = check_pols(&cid, w.get("pols"))?;
    let (vb, private) = my_bundle(my_bundles, me_p, me_d, &dck_sha, ts)?;
    let data = wrap_signed_bytes(&cid, &from_p, &from_d, epoch, &to_p, &to_d, &eph, &vb.dck_raw, &blob, &members, &head, ts, &serial, pols.as_deref())?;
    verifier.signer(&certs_for(&from_p, &from_d), &from_p, &from_d, Some(serial.as_str()), ts, observed_ms, &data, field("sig"))?;
    let key = open_key(private, &eph, &wrap_info(&cid, &from_p, &from_d, epoch, &to_p, &to_d, &eph, &vb.dck_raw), &blob)?;
    let named = pols.unwrap_or_default();
    let members_ok = match members_for(&cid, &head, &named) {
        Ok(Some(devices)) => set_hash(&devices).is_ok_and(|h| ct_eq(&h, &members)),
        _ => false,
    };
    Ok(OpenedWrap { cid, from_p, from_d, epoch, key, head, ts, members_ok, pols: named })
}

// -- section 6: envelopes ----------------------------------------------------------------------------------------

pub const ENVELOPE_KEYS: [&str; 18] = ["v", "d", "sr", "e", "c", "pe", "pc", "k", "r", "s", "t", "q", "a", "ls", "lh", "n", "x", "g"];

pub fn msg_key(key: &[u8], cid: &str, mid: &str, kind: &str) -> CeResult<[u8; 32]> {
    hkdf32(key, &lp(&[MKEY.as_bytes(), cid.as_bytes(), mid.as_bytes(), kind.as_bytes()]))
}

/// A message: what `seal` takes (the payload included) and what `open_envelope` gives.
#[derive(Clone, Debug, PartialEq)]
pub struct OpenedMessage {
    pub cid: String,
    pub mid: String,
    pub from_p: String,
    pub from_d: String,
    pub serial: String,
    pub epoch: i64,
    pub counter: i64,
    pub pe: i64,
    pub pc: i64,
    pub kind: String,
    pub ref_: String,
    pub payload: Value,
    pub s: i64,
    pub t: String,
    pub q: String,
    pub a: bool,
    pub head: Head,
}

/// The additional data of a message (every header field, never the payload).
pub fn msg_aad(m: &OpenedMessage) -> Vec<u8> {
    let mut b = Lp::default();
    for f in [MSG, m.cid.as_str(), m.from_p.as_str(), m.from_d.as_str(), m.serial.as_str()] {
        b.s(f);
    }
    for n in [m.epoch, m.counter, m.pe, m.pc] {
        b.n(n);
    }
    b.s(&m.mid);
    b.s(&m.kind);
    b.s(&m.ref_);
    b.n(m.s);
    b.s(&m.t);
    b.s(&m.q);
    b.s(if m.a { "1" } else { "0" });
    b.n(m.head.seq);
    b.b(&m.head.hash);
    b.0
}

pub fn msg_sig_bytes(aad: &[u8], nonce: &[u8], x: &[u8]) -> Vec<u8> {
    lp(&[MSGSIG.as_bytes(), digest::digest(&digest::SHA384, aad).as_ref(), nonce, x])
}

fn check_epoch_tail(epoch: i64, counter: i64, pe: i64, pc: i64) -> CeResult<()> {
    check_n(pe, "previous epoch", 0)?;
    check_n(pc, "previous counter", 0)?;
    if counter != 1 && (pe, pc) != (0, 0) {
        return rules("only the first message of an epoch names the previous one");
    }
    if pe == 0 && pc != 0 {
        return rules("a previous counter without a previous epoch");
    }
    if pe >= epoch {
        return rules("the previous epoch is not earlier");
    }
    Ok(())
}

/// Seals `m` (its payload checked, canonical and padded) under the epoch `key`; `nonce` is fixed only by the
/// vectors.
pub fn seal(device_key: &DeviceKey, key: &[u8], m: &OpenedMessage, nonce: Option<[u8; 12]>) -> CeResult<Value> {
    check_cid_kind(&m.cid, &m.kind)?;
    check_mid(&m.mid)?;
    check_ai_sender(&m.cid, &m.from_p)?;
    check_device(&m.from_d)?;
    check_serial(&m.serial)?;
    check_n(m.epoch, "epoch", 1)?;
    check_n(m.counter, "counter", 1)?;
    check_epoch_tail(m.epoch, m.counter, m.pe, m.pc)?;
    check_n(m.s, "time", 0)?;
    check_ref(&m.t)?;
    check_ref(&m.q)?;
    let head = check_head(&m.cid, m.head)?;
    check_payload(&m.kind, &m.ref_, &m.payload)?;
    let padded = pad(&canonical_json(&m.payload)?)?;
    let nonce = match nonce {
        Some(n) => n,
        None => random_bytes(12).try_into().map_err(|_| CeError::new("encoding", "a nonce is 12 bytes"))?,
    };
    let mut h = m.clone();
    h.head = head;
    let aad = msg_aad(&h);
    let x = gcm_seal(&msg_key(key, &m.cid, &m.mid, &m.kind)?, nonce, &aad, &padded)?;
    let g = device_key.sign(&msg_sig_bytes(&aad, &nonce, &x))?;
    Ok(json!({"v": 1, "d": m.from_d, "sr": m.serial, "e": m.epoch, "c": m.counter, "pe": m.pe, "pc": m.pc, "k": m.kind,
              "r": m.ref_, "s": m.s, "t": m.t, "q": m.q, "a": m.a, "ls": head.seq, "lh": head.hash_hex(),
              "n": b64(&nonce), "x": b64(&x), "g": g}))
}

/// `(device, epoch, counter)` of a shape-checked envelope.
pub fn envelope_header(env: &Value) -> CeResult<(String, i64, i64)> {
    let Some(o) = env.as_object() else { return encoding("not an envelope") };
    if o.len() != ENVELOPE_KEYS.len() || !ENVELOPE_KEYS.iter().all(|k| o.contains_key(*k)) {
        return encoding("not an envelope");
    }
    if int_of(&o["v"]) != Some(1) {
        return encoding("unknown envelope version");
    }
    Ok((device_value(&o["d"])?, check_int(&o["e"], "epoch", 1)?, check_int(&o["c"], "counter", 1)?))
}

fn row_value<'a>(row: Option<&'a Value>, name: &str) -> Option<&'a Value> {
    row.and_then(|r| r.get(name)).filter(|v| !v.is_null())
}

fn check_reader_head(cid: &str, head: Head, log: Option<&LogState>) -> CeResult<Head> {
    if cid_kind(cid)? != "ch" {
        if head != ZERO_HEAD {
            return fail("head", "this conversation has no member log");
        }
        return Ok(ZERO_HEAD);
    }
    check_n(head.seq, "log seq", 1)?;
    let Some(log) = log.filter(|l| head.seq <= l.head.seq) else { return fail("head_ahead", "the member log is behind this message") };
    if !ct_eq(&log.hash_at(head.seq)?, &head.hash) {
        return fail("head", "this message names another member log");
    }
    Ok(head)
}

/// The epoch key of `(cid, sender principal, sender device, epoch)`, None while it has not arrived.
pub type KeyFor<'a> = &'a dyn Fn(&str, &str, &str, i64) -> Option<Vec<u8>>;

/// Opens and checks the envelope of message `mid` from `from_p` in `cid` (the relay's row: `thread`, `reply_to`,
/// `also_channel`), after the sender's signature at its signed time. `log` is the verified member log of a `ch:`
/// cid.
#[allow(clippy::too_many_arguments)]
pub fn open_envelope(env: &Value, cid: &str, mid: &str, from_p: &str, row: Option<&Value>, key_for: KeyFor, certs_for: CertSource, verifier: &Verifier, observed_ms: i64, log: Option<&LogState>) -> CeResult<OpenedMessage> {
    let (from_d, epoch, counter) = envelope_header(env)?;
    cid_kind(cid)?;
    check_mid(mid)?;
    check_principal(from_p)?;
    let sr = serial_value(&env["sr"])?;
    let pe = check_int(&env["pe"], "previous epoch", 0)?;
    let pc = check_int(&env["pc"], "previous counter", 0)?;
    check_epoch_tail(epoch, counter, pe, pc)?;
    // a kind or ref that is not text fails as an unknown kind or a missing target
    let kind = env["k"].as_str().unwrap_or("").to_string();
    let ref_ = env["r"].as_str().unwrap_or("\u{1}").to_string();
    check_cid_kind(cid, &kind)?;
    check_kind_ref(&kind, &ref_)?;
    check_ai_sender(cid, from_p)?;
    let s = check_int(&env["s"], "time", 0)?;
    let t = ref_value(&env["t"])?;
    let q = ref_value(&env["q"])?;
    let Some(a) = env["a"].as_bool() else { return encoding("also-channel is true or false") };
    let ls = check_int(&env["ls"], "log seq", 0)?;
    let head = Head { seq: ls, hash: hash32(&unhex(&env["lh"], "log hash", 32)?)? };
    let nonce = unb64(&env["n"], "nonce", Some(12), 0)?;
    let x = unb64(&env["x"], "ciphertext", None, TAG + 256)?;
    let thread = row_value(row, "thread").cloned().unwrap_or_else(|| json!(""));
    let reply_to = row_value(row, "reply_to").cloned().unwrap_or_else(|| json!(""));
    let also = row_value(row, "also_channel").cloned().unwrap_or(Value::Bool(false));
    if thread != json!(t) || reply_to != json!(q) || also != Value::Bool(a) {
        return fail("row", "the relay row differs from the signed message");
    }
    let head = check_reader_head(cid, head, log)?;
    let mut msg = OpenedMessage { cid: cid.to_string(), mid: mid.to_string(), from_p: from_p.to_string(), from_d, serial: sr, epoch, counter, pe, pc, kind, ref_, payload: Value::Null, s, t, q, a, head };
    let aad = msg_aad(&msg);
    verifier.signer(&certs_for(from_p, &msg.from_d), from_p, &msg.from_d, Some(msg.serial.as_str()), s, observed_ms, &msg_sig_bytes(&aad, &nonce, &x), &env["g"])?;
    let Some(key) = key_for(cid, from_p, &msg.from_d, epoch) else { return fail("no_key", TEXT_WAITING_KEY) };
    let mk = msg_key(&key, cid, mid, &msg.kind)?;
    let Some(padded) = gcm_open(&mk, &nonce, &aad, &x) else { return fail("decrypt", "the message does not open") };
    let payload = canonical_loads(&unpad(&padded)?)?;
    check_payload(&msg.kind, &msg.ref_, &payload)?;
    msg.payload = payload;
    Ok(msg)
}

// -- section 6: payloads -----------------------------------------------------------------------------------------

fn keys<'a>(v: &'a Value, required: &[&str], optional: &[&str]) -> CeResult<&'a Obj> {
    let Some(o) = v.as_object() else { return rules("an object was expected") };
    if !required.iter().all(|k| o.contains_key(*k)) || !o.keys().all(|k| required.contains(&k.as_str()) || optional.contains(&k.as_str())) {
        return rules("unexpected or missing fields");
    }
    Ok(o)
}

fn text(v: &Value, nonempty: bool) -> CeResult<&str> {
    match v.as_str() {
        Some(s) if !(nonempty && s.is_empty()) => Ok(s),
        _ => rules("text expected"),
    }
}

fn boolean(v: &Value) -> CeResult<bool> {
    v.as_bool().map_or_else(|| rules("true or false expected"), Ok)
}

fn counter(v: &Value) -> CeResult<i64> {
    match int_of(v) {
        Some(n) if (1..=MAX_INT).contains(&n) => Ok(n),
        _ => rules("a counter is 1 to 2^53 - 1"),
    }
}

fn nonneg(v: &Value, message: &str) -> CeResult<i64> {
    match int_of(v) {
        Some(n) if (0..=MAX_INT).contains(&n) => Ok(n),
        _ => rules(message),
    }
}

fn chars(s: &str) -> usize {
    s.chars().count()
}

fn mentions(v: &Value) -> CeResult<()> {
    let Some(a) = v.as_array() else { return rules("mentions are a list") };
    if !a.iter().all(|p| p.as_str().is_some_and(principal_ok)) {
        return rules("a mention is not a principal");
    }
    Ok(())
}

fn preview(v: &Value) -> CeResult<()> {
    match v.as_object() {
        Some(o) if o.values().all(Value::is_string) => Ok(()),
        _ => rules("a link preview is an object of texts"),
    }
}

pub const CLIP_WAVE_BYTES: usize = 64;
/// Code points.
pub const CLIP_TRANSCRIPT_MAX: usize = 4000;

/// A file descriptor's `clip` (revision 5): `{k: "a"|"v", d: ms (1 to 300000 audio, 1 to 180000 video), w: 64 peak
/// levels in canonical base64, tx: transcript (optional, at most 4000 code points)}`.
pub fn check_clip(v: &Value) -> CeResult<()> {
    let o = keys(v, &["k", "d", "w"], &["tx"])?;
    let max = match o["k"].as_str() {
        Some("a") => 300_000,
        Some("v") => 180_000,
        _ => return rules("a clip is audio (a) or video (v)"),
    };
    if !int_of(&o["d"]).is_some_and(|d| (1..=max).contains(&d)) {
        return rules("a clip lasts 1 ms to 5 minutes (audio) or 3 minutes (video)");
    }
    if unb64(&o["w"], "clip waveform", Some(CLIP_WAVE_BYTES), 0).is_err() {
        return rules("a clip waveform is 64 bytes of base64");
    }
    if let Some(tx) = o.get("tx") {
        if chars(text(tx, false)?) > CLIP_TRANSCRIPT_MAX {
            return rules("a clip transcript is over 4000 characters");
        }
    }
    Ok(())
}

pub fn check_file_descriptor(d: &Value) -> CeResult<()> {
    let o = keys(d, &["fid", "id", "name", "mime", "size", "sha256", "key"], &["clip"])?;
    if let Some(clip) = o.get("clip") {
        check_clip(clip)?;
    }
    let fid_ok = o["fid"].as_str().is_some_and(mid_ok);
    if !fid_ok || unhex(&o["sha256"], "sha256", 32).is_err() || unb64(&o["key"], "file key", Some(32), 0).is_err() {
        return rules("a file descriptor is malformed");
    }
    text(&o["id"], true)?;
    text(&o["name"], false)?;
    text(&o["mime"], false)?;
    nonneg(&o["size"], "a file size is 0 to 2^53 - 1")?;
    Ok(())
}

fn poll(v: &Value) -> CeResult<()> {
    let o = keys(v, &["question", "options", "multiple"], &[])?;
    text(&o["question"], false)?;
    boolean(&o["multiple"])?;
    let options = match o["options"].as_array() {
        Some(a) if !a.is_empty() => a,
        _ => return rules("a poll has options"),
    };
    let mut ids = BTreeSet::new();
    for opt in options {
        let p = keys(opt, &["id", "text"], &[])?;
        ids.insert(text(&p["id"], true)?.to_string());
        text(&p["text"], false)?;
    }
    if ids.len() != options.len() {
        return rules("poll option ids repeat");
    }
    Ok(())
}

pub const FORWARD_KINDS: [&str; 5] = ["dm", "group", "channel", "room", "meeting"];
pub const FORWARD_TEXT_MAX: usize = 100;

/// A post's `fw` (revision 4): `{n: sender name, c: conversation title, ts: original time in ms, k: kind}`.
pub fn check_forward(v: &Value) -> CeResult<()> {
    let o = keys(v, &["n", "c", "ts", "k"], &[])?;
    if chars(text(&o["n"], false)?) > FORWARD_TEXT_MAX || chars(text(&o["c"], false)?) > FORWARD_TEXT_MAX {
        return rules("a forwarded name or title is over 100 characters");
    }
    nonneg(&o["ts"], "a forwarded time is 0 to 2^53 - 1")?;
    if !o["k"].as_str().is_some_and(|k| FORWARD_KINDS.contains(&k)) {
        return rules("a forwarded kind is dm, group, channel, room or meeting");
    }
    Ok(())
}

// revision 8: AI history records (docs/ai/contract.md 7.2)
pub const AI_TIERS: [&str; 4] = ["device", "org", "frontier", "personal"];
pub const AI_ACTIVITIES: [&str; 6] = ["search", "catch_up", "notes", "summary", "brief", "assist"];
pub const AI_OUTCOMES: [&str; 3] = ["answered", "refused", "failed"];
/// UTF-8 bytes.
pub const AI_Q_MAX: usize = 16000;
pub const AI_A_MAX: usize = 48000;
pub const AI_ROUTE_ID_MAX: usize = 64;
pub const AI_ROUTE_LIST_MAX: usize = 16;
/// Canonical JSON bytes of one cites entry.
pub const AI_CITE_MAX: usize = 160;
pub const AI_CITES_MAX: usize = 40;
pub const AI_CARD_MAX: usize = 64;
pub const AI_MODEL_MAX: usize = 128;
pub const AI_RIDS_MAX: usize = 2;
const AI_REQUIRED: [&str; 12] = ["q", "a", "cites", "tier", "card", "model", "class", "activity", "outcome", "rids", "route", "usage"];

fn capped<'a>(v: &'a Value, cap: usize, what: &str, nonempty: bool) -> CeResult<&'a str> {
    let Some(s) = v.as_str().filter(|s| !(nonempty && s.is_empty())) else { return rules(format!("{what} is text")) };
    if s.len() > cap {
        return rules(format!("{what} is over {cap} bytes"));
    }
    Ok(s)
}

fn route_id(v: &Value) -> CeResult<()> {
    capped(v, AI_ROUTE_ID_MAX, "a route id", true).map(|_| ())
}

fn cid_field(v: &Value, kinds: &[&str]) -> CeResult<()> {
    let Some(kind) = v.as_str().and_then(|c| cid_kind(c).ok()) else { return rules("not a conversation") };
    if !kinds.contains(&kind) {
        return rules("not that kind of conversation");
    }
    Ok(())
}

fn ai_cite(v: &Value) -> CeResult<()> {
    if v.as_object().is_some_and(|o| o.contains_key("cid")) {
        let o = keys(v, &["cid", "mid"], &[])?;
        cid_field(&o["cid"], &["dm", "ch", "room"])?;
        if !o["mid"].as_str().is_some_and(mid_ok) {
            return rules("a cited message is a message id");
        }
    } else {
        let o = keys(v, &["meeting", "at_ms"], &[])?;
        text(&o["meeting"], true)?;
        nonneg(&o["at_ms"], "a cited time is 0 to 2^53 - 1")?;
    }
    if canonical_json(v)?.len() > AI_CITE_MAX {
        return rules(format!("a cite is over {AI_CITE_MAX} bytes"));
    }
    Ok(())
}

fn ai_route(v: &Value) -> CeResult<()> {
    let o = keys(v, &["decision_id", "feasible", "chosen", "alternatives"], &[])?;
    route_id(&o["decision_id"])?;
    route_id(&o["chosen"])?;
    for name in ["feasible", "alternatives"] {
        if !o[name].as_array().is_some_and(|a| a.len() <= AI_ROUTE_LIST_MAX) {
            return rules(format!("route {name} is a list of at most {AI_ROUTE_LIST_MAX}"));
        }
    }
    for x in o["feasible"].as_array().into_iter().flatten() {
        route_id(x)?;
    }
    for alt in o["alternatives"].as_array().into_iter().flatten() {
        let a = keys(alt, &["capability_id", "why_not"], &[])?;
        route_id(&a["capability_id"])?;
        route_id(&a["why_not"])?;
    }
    Ok(())
}

fn ai_usage(v: &Value) -> CeResult<()> {
    let o = keys(v, &["tokens_in", "tokens_out", "usd_micro"], &[])?;
    for n in o.values() {
        nonneg(n, "usage numbers are 0 to 2^53 - 1")?;
    }
    Ok(())
}

/// An `ai` payload (revision 8, AI-1 7.2): every field, enum and byte cap, and the whole canonical payload at most
/// `PAYLOAD_MAX` bytes. Refused as `rules`.
pub fn check_ai_record(payload: &Value) -> CeResult<()> {
    let o = keys(payload, &AI_REQUIRED, &["trunc", "code"])?;
    capped(&o["q"], AI_Q_MAX, "the question", false)?;
    capped(&o["a"], AI_A_MAX, "the answer", false)?;
    if o.get("trunc").is_some_and(|t| t != &Value::Bool(true)) {
        return rules("trunc is present only as true");
    }
    let Some(cites) = o["cites"].as_array().filter(|c| c.len() <= AI_CITES_MAX) else { return rules(format!("cites are a list of at most {AI_CITES_MAX}")) };
    for c in cites {
        ai_cite(c)?;
    }
    if !o["tier"].as_str().is_some_and(|t| AI_TIERS.contains(&t)) {
        return rules("unknown tier");
    }
    capped(&o["card"], AI_CARD_MAX, "the card", true)?;
    capped(&o["model"], AI_MODEL_MAX, "the model", true)?;
    text(&o["class"], true)?;
    if !o["activity"].as_str().is_some_and(|t| AI_ACTIVITIES.contains(&t)) {
        return rules("unknown activity");
    }
    let Some(outcome) = o["outcome"].as_str().filter(|t| AI_OUTCOMES.contains(t)) else { return rules("unknown outcome") };
    if (outcome == "answered") == o.contains_key("code") {
        return rules("a code is given exactly when the request was not answered");
    }
    if let Some(code) = o.get("code") {
        text(code, true)?;
    }
    let rids_ok = o["rids"].as_array().is_some_and(|r| r.len() <= AI_RIDS_MAX && r.iter().all(|x| x.as_str().is_some_and(mid_ok)));
    if !rids_ok {
        return rules(format!("rids are at most {AI_RIDS_MAX} ids of 32 hex"));
    }
    ai_route(&o["route"])?;
    ai_usage(&o["usage"])?;
    if canonical_json(payload)?.len() > PAYLOAD_MAX {
        return rules(format!("an AI record is over {PAYLOAD_MAX} bytes"));
    }
    Ok(())
}

/// A checked `ai` payload. `a` is cut at a character boundary when it is over `AI_A_MAX` bytes or the payload
/// would pass `PAYLOAD_MAX`, and then `trunc` is true; everything else must already fit.
// Used by the CE-1 vectors only (AI history records are written by a person's device, never an app).
#[cfg_attr(not(test), allow(dead_code))]
#[allow(clippy::too_many_arguments)]
pub fn make_ai_record(q: &str, a: &str, cites: &[Value], tier: &str, card: &str, model: &str, class: &str, activity: &str, outcome: &str, rids: &[String], route: &Value, usage: &Value, code: &str) -> CeResult<Value> {
    let mut record = json!({"q": q, "a": a, "cites": cites, "tier": tier, "card": card, "model": model, "class": class,
                            "activity": activity, "outcome": outcome, "rids": rids, "route": route, "usage": usage});
    if !code.is_empty() {
        record["code"] = json!(code);
    }
    if a.len() > AI_A_MAX || canonical_json(&record)?.len() > PAYLOAD_MAX {
        let mut probe = record.clone();
        probe["a"] = json!("");
        probe["trunc"] = Value::Bool(true);
        let room = PAYLOAD_MAX.saturating_sub(canonical_json(&probe)?.len());
        let (mut size, mut used, mut cut) = (0usize, 0usize, 0usize);
        for ch in a.chars() {
            let (e, w) = (enc_len(ch), ch.len_utf8());
            if size + e > room || used + w > AI_A_MAX {
                break;
            }
            size += e;
            used += w;
            cut += w;
        }
        record["a"] = json!(&a[..cut]);
        record["trunc"] = Value::Bool(true);
    }
    check_ai_record(&record)?;
    Ok(record)
}

/// Which ref each kind takes: `post`, `wf` and `ai` none (""); the document kinds a `doc:<id>` ref; `delete` a
/// message id or a `doc:<id>` (a canvas); other events a message id.
pub fn check_kind_ref(kind: &str, ref_: &str) -> CeResult<()> {
    if !KINDS.contains(&kind) {
        return rules("unknown kind");
    }
    if matches!(kind, "post" | "wf" | "ai") {
        if !ref_.is_empty() {
            return rules("a post has no target");
        }
    } else if DOC_KINDS.contains(&kind) {
        if !is_doc_ref(ref_) {
            return rules("a document message names its document");
        }
    } else if !(mid_ok(ref_) || (kind == "delete" && is_doc_ref(ref_))) {
        return rules("an event needs a target");
    }
    Ok(())
}

fn cmd_name_ok(s: &str) -> bool {
    (1..=32).contains(&s.len()) && s.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
}

fn scope_ok(s: &str) -> bool {
    (1..=64).contains(&s.len()) && s.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'.' || c == b'_' || c == b'-')
}

pub const WF_TRIGGERS: [&str; 4] = ["words", "join", "schedule", "webhook"];
pub const WF_STEPS: [&str; 4] = ["post", "dm", "ask", "webhook"];
pub const WF_STEPS_MAX: usize = 20;
pub const WF_NAME_MAX: usize = 100;

fn b64_field(v: &Value, what: &str) -> CeResult<Vec<u8>> {
    let Ok(raw) = unb64(v, what, None, 0) else { return rules(format!("{what} is not base64")) };
    if raw.is_empty() {
        return rules(format!("{what} is empty"));
    }
    Ok(raw)
}

fn is_person(v: &Value) -> bool {
    v.as_str().and_then(|p| principal_kind(p).ok()) == Some("person")
}

/// Revision 6 post fields: `mf` (a mention forwarded to a linked app), `cmd` (a slash command), `used_by` (an app's
/// answer to a command) and `wfs` (a workflow status); then the revision 11 extras.
fn check_post_extras(payload: &Obj) -> CeResult<()> {
    if let Some(mf) = payload.get("mf") {
        let mf = keys(mf, &["conv", "ref", "th"], &[])?;
        cid_field(&mf["conv"], &["ch"])?;
        let ok = mf["ref"].as_str().is_some_and(mid_ok) && mf["th"].as_str().is_some_and(|t| t.is_empty() || mid_ok(t));
        if !ok {
            return rules("a forwarded mention names a message");
        }
    }
    if let Some(cmd) = payload.get("cmd") {
        let cmd = keys(cmd, &["name", "args", "conv"], &[])?;
        if !cmd["name"].as_str().is_some_and(cmd_name_ok) {
            return rules("a command name is 1 to 32 of a-z, 0-9 and -");
        }
        if chars(text(&cmd["args"], false)?) > CMD_ARGS_MAX {
            return rules("command arguments are at most 4000 characters");
        }
        cid_field(&cmd["conv"], &["ch", "dm"])?;
        if payload["t"] != json!("") || payload["m"] != json!([]) || payload.keys().any(|k| !matches!(k.as_str(), "t" | "m" | "cmd")) {
            return rules("a command carries nothing else");
        }
    }
    if let Some(u) = payload.get("used_by") {
        if !is_person(u) {
            return rules("a command is used by a person");
        }
    }
    if let Some(wfs) = payload.get("wfs") {
        let Some(w) = wfs.as_object().filter(|w| ["id", "n", "state"].iter().all(|k| w.contains_key(*k))) else { return rules("a workflow status has id, n and state") };
        if !w["id"].as_str().is_some_and(mid_ok) {
            return rules("a workflow id is 32 hex");
        }
        counter(&w["n"])?;
        if !w["state"].as_str().is_some_and(|s| WFS_STATES.contains(&s)) {
            return rules("unknown workflow state");
        }
    }
    check_rev11_extras(payload)
}

fn chars_in(v: &Value, low: usize, high: usize, what: &str) -> CeResult<()> {
    match v.as_str() {
        Some(s) if (low..=high).contains(&chars(s)) => Ok(()),
        _ => rules(format!("{what} is {low} to {high} characters")),
    }
}

fn client_name(v: &Value) -> CeResult<()> {
    if !v.as_str().is_some_and(cmd_name_ok) {
        return rules("a client name is 1 to 32 of a-z, 0-9 and -");
    }
    Ok(())
}

fn hex32(v: &Value, what: &str) -> CeResult<()> {
    if !v.as_str().is_some_and(mid_ok) {
        return rules(format!("{what} is 32 hex"));
    }
    Ok(())
}

/// Revision 11 `apr` (approval request): `id` 32 hex, `client` an API client name, `agent` 1 to 64 characters,
/// `action` "post", `conv` a `ch:` cid, `conv_name` 1 to 100 characters, `thread` "" or a message id, `text` 1 to
/// 4000 characters, `exp` ms.
pub fn check_apr(apr: &Value) -> CeResult<()> {
    let o = keys(apr, &["id", "client", "agent", "action", "conv", "conv_name", "thread", "text", "exp"], &[])?;
    hex32(&o["id"], "an approval id")?;
    client_name(&o["client"])?;
    chars_in(&o["agent"], 1, APR_AGENT_MAX, "an agent's name")?;
    if !o["action"].as_str().is_some_and(|a| APR_ACTIONS.contains(&a)) {
        return rules("an approval asks to post");
    }
    cid_field(&o["conv"], &["ch"])?;
    chars_in(&o["conv_name"], 1, APR_CONV_NAME_MAX, "a conversation name")?;
    if o["thread"] != json!("") {
        hex32(&o["thread"], "a thread")?;
    }
    chars_in(&o["text"], 1, APR_TEXT_MAX, "the text to approve")?;
    counter(&o["exp"])?;
    Ok(())
}

/// `apra.h`: hex SHA-256 of the canonical JSON of the `apr` object.
pub fn apr_hash(apr: &Value) -> CeResult<String> {
    Ok(hex(&sha256(&canonical_json(apr)?)))
}

/// Revision 11 post fields (API-1c 7.4): at most one of `apr`, `apra`, `dlg`, `dlgn` and `stop`, never with `mf`,
/// `cmd`, `used_by` or `wfs`. `apr`, `apra` and `stop` carry nothing else (`t` "", `m` []).
fn check_rev11_extras(payload: &Obj) -> CeResult<()> {
    let present: Vec<&str> = REV11_EXTRAS.iter().copied().filter(|k| payload.contains_key(*k)).collect();
    let Some(&kind) = present.first() else { return Ok(()) };
    if present.len() > 1 || ["mf", "cmd", "used_by", "wfs"].iter().any(|k| payload.contains_key(*k)) {
        return rules("a message carries one app extra");
    }
    if matches!(kind, "apr" | "apra" | "stop") && (payload["t"] != json!("") || payload["m"] != json!([]) || payload.keys().any(|k| k != "t" && k != "m" && k != kind)) {
        return rules("an approval or stop carries nothing else");
    }
    let value = &payload[kind];
    match kind {
        "apr" => check_apr(value)?,
        "apra" => {
            let o = keys(value, &["id", "ok", "h"], &[])?;
            hex32(&o["id"], "an approval id")?;
            boolean(&o["ok"])?;
            if !o["h"].as_str().is_some_and(|h| h.len() == 64 && is_hex_lower(h)) {
                return rules("an approval hash is 64 hex");
            }
        }
        "dlg" => {
            let o = keys(value, &["client"], &["person", "approval"])?;
            client_name(&o["client"])?;
            if let Some(p) = o.get("person") {
                if !is_person(p) {
                    return rules("a delegated post is for a person");
                }
            }
            if let Some(a) = o.get("approval") {
                hex32(a, "an approval id")?;
            }
        }
        "dlgn" => {
            let o = keys(value, &["client", "scopes", "since"], &[])?;
            client_name(&o["client"])?;
            let ok = o["scopes"].as_array().is_some_and(|s| {
                (1..=DLGN_SCOPES_MAX).contains(&s.len()) && s.iter().all(|x| x.as_str().is_some_and(scope_ok)) && s.iter().filter_map(Value::as_str).collect::<BTreeSet<&str>>().len() == s.len()
            });
            if !ok {
                return rules("a delegation notice names 1 to 32 scopes once each");
            }
            counter(&o["since"])?;
        }
        _ => {
            let o = keys(value, &["client"], &[])?;
            client_name(&o["client"])?;
        }
    }
    Ok(())
}

/// A workflow definition's shape (the Workflows app checks what it may do).
fn check_wf(payload: &Value) -> CeResult<()> {
    let Some(p) = payload.as_object() else { return rules("an object was expected") };
    let op = p.get("op").and_then(Value::as_str);
    match op {
        Some("delete") => keys(payload, &["op", "id", "n"], &[])?,
        Some("set") => keys(payload, &["op", "id", "n", "name", "convs", "trigger", "steps"], &[])?,
        _ => return rules("a workflow op is set or delete"),
    };
    if !p["id"].as_str().is_some_and(mid_ok) {
        return rules("a workflow id is 32 hex");
    }
    counter(&p["n"])?;
    if op == Some("delete") {
        return Ok(());
    }
    if chars(text(&p["name"], true)?) > WF_NAME_MAX {
        return rules("a workflow name is 1 to 100 characters");
    }
    let convs = match p["convs"].as_array() {
        Some(c) if !c.is_empty() && c.iter().map(|x| x.as_str().map_or_else(|| x.to_string(), str::to_string)).collect::<BTreeSet<_>>().len() == c.len() => c,
        _ => return rules("a workflow names its conversations once each"),
    };
    for cid in convs {
        cid_field(cid, &["ch"])?;
    }
    let trigger = &p["trigger"];
    if !trigger.as_object().is_some_and(|t| t.get("type").and_then(Value::as_str).is_some_and(|x| WF_TRIGGERS.contains(&x))) {
        return rules("unknown workflow trigger");
    }
    if !convs.contains(trigger.get("conv").unwrap_or(&Value::Null)) {
        return rules("the trigger's conversation is not in convs");
    }
    let steps = match p["steps"].as_array() {
        Some(s) if (1..=WF_STEPS_MAX).contains(&s.len()) => s,
        _ => return rules("a workflow has 1 to 20 steps"),
    };
    for step in steps {
        let Some(st) = step.as_object().filter(|s| s.get("type").and_then(Value::as_str).is_some_and(|x| WF_STEPS.contains(&x))) else { return rules("unknown workflow step") };
        if st.get("conv").is_some_and(|c| !convs.contains(c)) {
            return rules("a step's conversation is not in convs");
        }
    }
    Ok(())
}

fn check_doc_payload(kind: &str, payload: &Value) -> CeResult<()> {
    match kind {
        "doc" => {
            let o = keys(payload, &["u", "g"], &["new"])?;
            b64_field(&o["u"], "an update")?;
            counter(&o["g"])?;
            if let Some(new) = o.get("new") {
                let n = keys(new, &["type"], &[])?;
                if !matches!(n["type"].as_str(), Some("canvas" | "list")) {
                    return rules("a document is a canvas or a list");
                }
            }
        }
        "docsnap" => {
            let o = keys(payload, &["sv", "upto"], &["u", "f"])?;
            if o.contains_key("u") == o.contains_key("f") {
                return rules("a snapshot is an update or a file");
            }
            match o.get("u") {
                Some(u) => {
                    b64_field(u, "a snapshot")?;
                }
                None => check_file_descriptor(&o["f"])?,
            }
            b64_field(&o["sv"], "a state vector")?;
            let Some(upto) = o["upto"].as_array() else { return rules("upto is a list") };
            let mut devices = BTreeSet::new();
            for item in upto {
                let Some([d, e, c]) = item.as_array().map(Vec::as_slice) else { return rules("upto items are [device, epoch, counter]") };
                let Some(d) = d.as_str().filter(|d| device_ok(d)) else { return rules("upto names a device") };
                counter(e)?;
                counter(c)?;
                devices.insert(d.to_string());
            }
            if devices.len() != upto.len() {
                return rules("upto names a device twice");
            }
        }
        _ => {
            let o = keys(payload, &["a", "h", "n"], &[])?;
            b64_field(&o["a"], "an anchor")?;
            b64_field(&o["h"], "a head")?;
            counter(&o["n"])?;
        }
    }
    Ok(())
}

/// The payload schema of each kind (contract section 6).
pub fn check_payload(kind: &str, ref_: &str, payload: &Value) -> CeResult<()> {
    check_kind_ref(kind, ref_)?;
    match kind {
        "post" => {
            let o = keys(payload, &["t", "m"], &["p", "f", "poll", "fw", "mf", "cmd", "used_by", "wfs", "apr", "apra", "dlg", "dlgn", "stop"])?;
            text(&o["t"], false)?;
            mentions(&o["m"])?;
            if let Some(p) = o.get("p") {
                preview(p)?;
            }
            if let Some(f) = o.get("f") {
                let Some(files) = f.as_array() else { return rules("files are a list") };
                for d in files {
                    check_file_descriptor(d)?;
                }
            }
            if let Some(p) = o.get("poll") {
                poll(p)?;
            }
            if let Some(fw) = o.get("fw") {
                check_forward(fw)?;
            }
            check_post_extras(o)?;
        }
        "wf" => check_wf(payload)?,
        "ai" => check_ai_record(payload)?,
        "doc" | "docsnap" | "docaware" => check_doc_payload(kind, payload)?,
        "edit" => {
            let o = keys(payload, &["t", "m", "n"], &["p"])?;
            text(&o["t"], false)?;
            mentions(&o["m"])?;
            if let Some(p) = o.get("p") {
                preview(p)?;
            }
            counter(&o["n"])?;
        }
        "delete" => {
            let o = keys(payload, &["n"], &[])?;
            if int_of(&o["n"]) != Some(1) {
                return rules("a delete is {n: 1}");
            }
        }
        "react" => {
            let o = keys(payload, &["emoji", "on", "n"], &[])?;
            text(&o["emoji"], true)?;
            boolean(&o["on"])?;
            counter(&o["n"])?;
        }
        "vote" => {
            let o = keys(payload, &["options", "n"], &[])?;
            let Some(options) = o["options"].as_array() else { return rules("vote options are a list") };
            let mut seen = BTreeSet::new();
            for opt in options {
                seen.insert(text(opt, true)?.to_string());
            }
            if seen.len() != options.len() {
                return rules("a vote repeats an option");
            }
            counter(&o["n"])?;
        }
        "close" => {
            let o = keys(payload, &["n"], &[])?;
            counter(&o["n"])?;
        }
        _ => {
            let o = keys(payload, &["on", "n"], &[])?;
            boolean(&o["on"])?;
            counter(&o["n"])?;
        }
    }
    Ok(())
}

// -- section 6: who may send what --------------------------------------------------------------------------------

/// What `authorize` needs beyond the members: the admins, the target's author and kind (edit, delete), the poll's
/// author and payload (close, vote), and (revision 11) the principals the reader's verified org policies list as
/// `api` apps (`api_app_principals`).
#[derive(Clone, Copy, Debug, Default)]
pub struct AuthorizeContext<'a> {
    pub admins: &'a [String],
    pub target_author: Option<&'a str>,
    pub poll_author: Option<&'a str>,
    pub poll: Option<&'a Value>,
    pub target_kind: Option<&'a str>,
    pub api_apps: &'a [String],
}

fn has(list: &[String], p: &str) -> bool {
    list.iter().any(|x| x == p)
}

/// Revision 11 sender and cid rules of a `post`.
fn authorize_rev11(msg: &OpenedMessage, kind: &str, sender: &str, members: &[String], api_apps: &[String]) -> CeResult<()> {
    let Some(extra) = REV11_EXTRAS.iter().copied().find(|k| msg.payload.get(*k).is_some()) else { return Ok(()) };
    if extra == "dlg" {
        if kind != "ch" || !has(api_apps, &msg.from_p) {
            return rules("only an API app posts for a client, in a channel or group chat");
        }
        return Ok(());
    }
    let mut others = Vec::new();
    for p in members {
        if p != &msg.from_p && principal_kind(p)? != "archive" {
            others.push(p.as_str());
        }
    }
    if kind != "dm" || others.len() != 1 || dm_cid(&msg.from_p, others[0])? != msg.cid {
        return rules("approvals, notices and stops go in a DM with an API app");
    }
    if extra == "apr" || extra == "dlgn" {
        if !has(api_apps, &msg.from_p) || principal_kind(others[0])? != "person" {
            return rules("only an API app asks or tells the person in its DM");
        }
    } else if sender != "person" || !has(api_apps, others[0]) {
        return rules("only the person answers or stops in their DM with an API app");
    }
    Ok(())
}

/// Who may send each kind (contract section 6 table; revision 6: documents by members, never in call-room chat;
/// `wf`, `mf` and `cmd` only in a DM; `used_by` and `wfs` only from an app; the archive never sends. Revision 8: in
/// an `ai:` cid only its own person sends `ai`, and `delete` only of its own `ai` records. Revision 11: `apr` and
/// `dlgn` only from an API app in its DM with a person, `apra` and `stop` only from the person in that DM, `dlg`
/// only from an API app in a `ch:` conversation).
pub fn authorize(msg: &OpenedMessage, members: &[String], ctx: &AuthorizeContext) -> CeResult<()> {
    if !has(members, &msg.from_p) {
        return rules("the sender is not a member");
    }
    let kind = cid_kind(&msg.cid)?;
    let sender = principal_kind(&msg.from_p)?;
    if sender == "archive" {
        return rules("the archive never sends");
    }
    check_cid_kind(&msg.cid, &msg.kind)?;
    if kind == "ai" {
        check_ai_sender(&msg.cid, &msg.from_p)?;
        if msg.kind == "delete" && (ctx.target_kind != Some("ai") || ctx.target_author != Some(msg.from_p.as_str())) {
            return rules("a delete in an AI history targets one's own AI record");
        }
    }
    if DOC_KINDS.contains(&msg.kind.as_str()) && kind == "room" {
        return rules("call-room chat has no documents");
    }
    if msg.kind == "wf" && kind != "dm" {
        return rules("a workflow is defined in a DM with the Workflows app");
    }
    if msg.kind == "post" {
        let p = &msg.payload;
        if (p.get("mf").is_some() || p.get("cmd").is_some()) && kind != "dm" {
            return rules("a mention forward or command goes in a DM with the app");
        }
        if (p.get("used_by").is_some() || p.get("wfs").is_some()) && sender != "app" {
            return rules("only an app answers a command or reports a workflow");
        }
        authorize_rev11(msg, kind, sender, members, ctx.api_apps)?;
    }
    if sender == "app" && kind == "room" {
        return rules("apps are not in call-room chat");
    }
    if msg.kind == "edit" && ctx.target_author != Some(msg.from_p.as_str()) {
        return rules("only the author edits");
    }
    if msg.kind == "delete" && !ctx.target_author.is_some_and(|ta| ta == msg.from_p || has(ctx.admins, &msg.from_p)) {
        return rules("only the author or an admin deletes");
    }
    if msg.kind == "close" && ctx.poll_author != Some(msg.from_p.as_str()) {
        return rules("only the poll's author closes it");
    }
    if msg.kind == "vote" {
        if let Some(poll) = ctx.poll {
            let ids: Vec<&Value> = poll.get("options").and_then(Value::as_array).into_iter().flatten().filter_map(|o| o.as_object().map(|o| o.get("id").unwrap_or(&Value::Null))).collect();
            let chosen = msg.payload.get("options").and_then(Value::as_array).cloned().unwrap_or_default();
            let multiple = poll.get("multiple").is_some_and(|m| !falsy(m));
            if !chosen.iter().all(|c| ids.contains(&c)) || (!multiple && chosen.len() > 1) {
                return rules("the vote does not fit the poll");
            }
        }
    }
    Ok(())
}

// -- folding and gaps --------------------------------------------------------------------------------------------

// Used by `Fold` only, which the CE-1 vectors pin (the connector folds in `connector_store`).
#[cfg_attr(not(test), allow(dead_code))]
fn fold_rank(n: i64, device: &str, mid: &str) -> (i64, Vec<u8>, Vec<u8>) {
    (n, device.as_bytes().to_vec(), mid.as_bytes().to_vec())
}

// Used by `Fold` only, which the CE-1 vectors pin (the connector folds in `connector_store`).
#[cfg_attr(not(test), allow(dead_code))]
fn payload_n(m: &OpenedMessage) -> i64 {
    m.payload.get("n").and_then(int_of).unwrap_or(0)
}

/// Events folded per contract section 6: edits, votes and closes per (principal, target, kind), reactions per
/// (principal, target, emoji), each by the largest (n, device, mid); pins per target by the largest (s, device,
/// mid); deletes stick.
// Used by the CE-1 vectors only (the connector folds edits and deletes in `connector_store`).
#[cfg_attr(not(test), allow(dead_code))]
#[derive(Clone, Debug, Default)]
pub struct Fold {
    groups: BTreeMap<String, BTreeMap<(String, String, String), OpenedMessage>>,
    pins: BTreeMap<String, OpenedMessage>,
    deleted: BTreeSet<String>,
}

// Used by the CE-1 vectors only (the connector folds edits and deletes in `connector_store`).
#[cfg_attr(not(test), allow(dead_code))]
impl Fold {
    pub fn new() -> Fold {
        Fold::default()
    }

    /// True when the event changed what is shown.
    pub fn add(&mut self, msg: &OpenedMessage) -> bool {
        let target = msg.ref_.clone();
        match msg.kind.as_str() {
            "post" => return false,
            "delete" => return self.deleted.insert(target),
            "pin" => {
                let wins = self.pins.get(&target).map_or(true, |held| fold_rank(msg.s, &msg.from_d, &msg.mid) > fold_rank(held.s, &held.from_d, &held.mid));
                if wins {
                    self.pins.insert(target, msg.clone());
                }
                return wins;
            }
            _ => {}
        }
        let emoji = if msg.kind == "react" { msg.payload.get("emoji").and_then(Value::as_str).unwrap_or("").to_string() } else { String::new() };
        let key = (msg.from_p.clone(), msg.kind.clone(), emoji);
        let group = self.groups.entry(target).or_default();
        let wins = group.get(&key).map_or(true, |held| fold_rank(payload_n(msg), &msg.from_d, &msg.mid) > fold_rank(payload_n(held), &held.from_d, &held.mid));
        if wins {
            group.insert(key, msg.clone());
        }
        wins
    }

    fn winners(&self, target: &str, kind: &str) -> Vec<&OpenedMessage> {
        self.groups.get(target).into_iter().flat_map(|g| g.iter()).filter(|(k, _)| k.1 == kind).map(|(_, m)| m).collect()
    }

    pub fn deleted(&self, target: &str) -> bool {
        self.deleted.contains(target)
    }

    pub fn edit(&self, target: &str) -> Option<&OpenedMessage> {
        self.winners(target, "edit").into_iter().max_by_key(|m| fold_rank(payload_n(m), &m.from_d, &m.mid))
    }

    /// Emoji to the principals whose newest reaction with it is on, sorted by bytes.
    pub fn reactions(&self, target: &str) -> BTreeMap<String, Vec<String>> {
        let mut out: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for m in self.winners(target, "react") {
            if m.payload.get("on") == Some(&Value::Bool(true)) {
                let emoji = m.payload.get("emoji").and_then(Value::as_str).unwrap_or("").to_string();
                out.entry(emoji).or_default().push(m.from_p.clone());
            }
        }
        for who in out.values_mut() {
            who.sort();
        }
        out
    }

    /// Principal to the options of its newest vote.
    pub fn votes(&self, target: &str) -> BTreeMap<String, Vec<String>> {
        self.winners(target, "vote")
            .into_iter()
            .map(|m| (m.from_p.clone(), m.payload.get("options").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect()))
            .collect()
    }

    pub fn closed(&self, target: &str) -> bool {
        !self.winners(target, "close").is_empty()
    }

    pub fn pinned(&self, target: &str) -> bool {
        self.pins.get(target).is_some_and(|m| m.payload.get("on") == Some(&Value::Bool(true)))
    }
}

// -- section 7.3: call-room catch-up option ----------------------------------------------------------------------

// Used by the CE-1 vectors only (section 7.3 catch-up is call-room chat, where apps never are).
#[cfg_attr(not(test), allow(dead_code))]
pub fn catchup_signed_bytes(room: &str, stay: &str, principal: &str, device: &str, on: bool, ts: i64) -> Vec<u8> {
    let flag: &[u8] = if on { b"1" } else { b"0" };
    lp(&[CATCHUP.as_bytes(), room.as_bytes(), stay.as_bytes(), principal.as_bytes(), device.as_bytes(), flag, &u64b(ts)])
}

// Used by the CE-1 vectors only (section 7.3 catch-up is call-room chat, where apps never are).
#[cfg_attr(not(test), allow(dead_code))]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CatchUpOption {
    pub on: bool,
    pub ts: i64,
    pub by: String,
    pub by_device: String,
}

// Used by the CE-1 vectors only (section 7.3 catch-up is call-room chat, where apps never are).
#[cfg_attr(not(test), allow(dead_code))]
#[allow(clippy::too_many_arguments)]
pub fn verify_catchup(option: &Value, room: &str, stay: &str, certs_for: CertSource, verifier: &Verifier, observed_ms: i64, allowed: Option<&[String]>) -> CeResult<CatchUpOption> {
    let o = keys(option, &["room", "stay", "by", "by_device", "serial", "on", "ts", "sig"], &[])?;
    if o["room"] != json!(room) || o["stay"] != json!(stay) {
        return rules("the option is for another call");
    }
    let by = principal_value(&o["by"])?;
    let device = device_value(&o["by_device"])?;
    let serial = serial_value(&o["serial"])?;
    let on = boolean(&o["on"])?;
    let ts = check_int(&o["ts"], "ts", 0)?;
    if allowed.is_some_and(|a| !has(a, &by)) {
        return rules("the signer is not a member of this conversation");
    }
    verifier.signer(&certs_for(&by, &device), &by, &device, Some(serial.as_str()), ts, observed_ms, &catchup_signed_bytes(room, stay, &by, &device, on, ts), &o["sig"])?;
    Ok(CatchUpOption { on, ts, by, by_device: device })
}

// -- section 8: own-device history share -------------------------------------------------------------------------

// Used by the CE-1 vectors only (section 8 history share is for people, never an app).
#[cfg_attr(not(test), allow(dead_code))]
#[allow(clippy::too_many_arguments)]
pub fn share_info(cid: &str, orig_p: &str, orig_d: &str, epoch: i64, sharing_d: &str, to_d: &str, eph_raw: &[u8], dck_raw: &[u8]) -> Vec<u8> {
    lp(&[SHARE.as_bytes(), cid.as_bytes(), orig_p.as_bytes(), orig_d.as_bytes(), &u64b(epoch), sharing_d.as_bytes(), to_d.as_bytes(), eph_raw, dck_raw])
}

// Used by the CE-1 vectors only (section 8 history share is for people, never an app).
#[cfg_attr(not(test), allow(dead_code))]
#[allow(clippy::too_many_arguments)]
pub fn share_signed_bytes(cid: &str, orig_p: &str, orig_d: &str, epoch: i64, sharing_d: &str, to_d: &str, eph_raw: &[u8], dck_raw: &[u8], blob: &[u8], ts: i64, serial: &str) -> Vec<u8> {
    lp(&[SHARESIG.as_bytes(), cid.as_bytes(), orig_p.as_bytes(), orig_d.as_bytes(), &u64b(epoch), sharing_d.as_bytes(), to_d.as_bytes(), eph_raw, &sha256(dck_raw), blob, &u64b(ts), serial.as_bytes()])
}

// Used by the CE-1 vectors only (section 8 history share is for people, never an app).
#[cfg_attr(not(test), allow(dead_code))]
#[derive(Clone, PartialEq, Eq)]
pub struct OpenedShare {
    pub cid: String,
    pub orig_p: String,
    pub orig_d: String,
    pub epoch: i64,
    pub key: Vec<u8>,
    pub from_d: String,
    pub ts: i64,
}

impl fmt::Debug for OpenedShare {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OpenedShare").field("cid", &self.cid).field("orig_p", &self.orig_p).field("orig_d", &self.orig_d).field("epoch", &self.epoch).field("from_d", &self.from_d).field("ts", &self.ts).finish_non_exhaustive()
    }
}

// Used by the CE-1 vectors only (section 8 history share is for people, never an app).
#[cfg_attr(not(test), allow(dead_code))]
#[allow(clippy::too_many_arguments)]
pub fn open_share(share: &Value, me_p: &str, me_d: &str, my_bundles: &[(VerifiedBundle, DckKey)], certs_for: CertSource, verifier: &Verifier, observed_ms: i64) -> CeResult<OpenedShare> {
    let Some(s) = share.as_object().filter(|s| s.get("share") == Some(&Value::Bool(true))) else { return encoding("not a share") };
    let field = |k: &str| s.get(k).unwrap_or(&Value::Null);
    let cid = cid_value(s.get("cid"))?;
    let (orig_p, orig_d, _) = party(s.get("orig"), false)?;
    let (from_p, from_d, serial) = party(s.get("from"), true)?;
    let (to_p, to_d, _) = party(s.get("to"), false)?;
    if to_p != me_p || to_d != me_d {
        return rules("this share is for another device");
    }
    if from_p != me_p || from_d == me_d {
        return rules("shares come only from my own other devices");
    }
    if principal_kind(me_p)? != "person" {
        return rules("history share is for people only");
    }
    let epoch = check_int(field("epoch"), "epoch", 1)?;
    let ts = check_int(field("ts"), "ts", 0)?;
    let eph = unb64(field("eph"), "ephemeral key", Some(97), 0)?;
    check_point(&eph)?;
    let dck_sha = unhex(field("dck_sha256"), "dck_sha256", 32)?;
    let blob = unb64(field("blob"), "key blob", Some(WRAP_BLOB_LEN), 0)?;
    let (vb, private) = my_bundle(my_bundles, me_p, me_d, &dck_sha, ts)?;
    let data = share_signed_bytes(&cid, &orig_p, &orig_d, epoch, &from_d, &to_d, &eph, &vb.dck_raw, &blob, ts, &serial);
    verifier.signer(&certs_for(&from_p, &from_d), &from_p, &from_d, Some(serial.as_str()), ts, observed_ms, &data, field("sig"))?;
    let key = open_key(private, &eph, &share_info(&cid, &orig_p, &orig_d, epoch, &from_d, &to_d, &eph, &vb.dck_raw), &blob)?;
    Ok(OpenedShare { cid, orig_p, orig_d, epoch, key, from_d, ts })
}

// -- revision 11 (API-1c 2.3, 7.4 to 7.6): API apps, approvals, delegated posts, Stop ----------------------------

/// The principals the in-force org policies list as `api` apps (`authorize`'s `api_apps`), sorted.
pub fn api_app_principals(view: &PolicyView) -> Vec<String> {
    let mut out = BTreeSet::new();
    for org in view.newest.keys() {
        let Some(policy) = view.in_force(org) else { continue };
        for app in policy.get("apps").and_then(Value::as_array).into_iter().flatten() {
            if app.get("type").and_then(Value::as_str) == Some(API_APP_TYPE) {
                out.insert(str_or_empty(app.get("principal")));
            }
        }
    }
    out.into_iter().collect()
}

/// The person's answer to `apr` (a `post` payload in their DM with the app).
// Used by the connector_approvals, connector_e2e and mcp_e2e tests only (the person's device sends `apra`).
#[cfg_attr(not(test), allow(dead_code))]
pub fn make_apra(apr: &Value, ok: bool) -> CeResult<Value> {
    check_apr(apr)?;
    Ok(json!({"t": "", "m": [], "apra": {"id": apr["id"], "ok": ok, "h": apr_hash(apr)?}}))
}

/// A card's state: `approved` or `declined` by the first verified `apra` of the person (`answers`, in order) with
/// this `id` and hash, else `expired` from `exp`, else `waiting`.
// Used by the CE-1 vectors only (the connector tracks approvals in `connector_approvals`).
#[cfg_attr(not(test), allow(dead_code))]
pub fn apr_state(apr: &Value, answers: &[Value], now_ms: i64) -> CeResult<&'static str> {
    let h = json!(apr_hash(apr)?);
    for a in answers {
        if a.get("id") == apr.get("id") && a.get("h") == Some(&h) {
            return Ok(if a.get("ok") == Some(&Value::Bool(true)) { "approved" } else { "declined" });
        }
    }
    Ok(if now_ms >= int_or0(apr.get("exp")) { "expired" } else { "waiting" })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_json_sorts_by_bytes_and_refuses_null_and_floats() {
        let v = json!({"b": 1, "a": [true, "x\n\u{1}"], "\u{e9}": {}, "B": -3});
        assert_eq!(canonical_json(&v).unwrap(), "{\"B\":-3,\"a\":[true,\"x\\n\\u0001\"],\"b\":1,\"\u{e9}\":{}}".as_bytes());
        assert_eq!(canonical_loads(&canonical_json(&v).unwrap()).unwrap(), v);
        assert_eq!(canonical_json(&json!({"a": null})).unwrap_err().code, "encoding");
        assert_eq!(canonical_loads(b"1.5").unwrap_err().code, "encoding");
        assert_eq!(canonical_loads(b"{\"a\":1,\"a\":1}").unwrap_err().code, "encoding");
    }

    #[test]
    fn padding_buckets() {
        assert_eq!(pad(b"").unwrap().len(), 256);
        assert_eq!(pad(&[1; 255]).unwrap().len(), 256);
        assert_eq!(pad(&[1; 256]).unwrap().len(), 1024);
        assert_eq!(unpad(&pad(b"abc").unwrap()).unwrap(), b"abc");
        assert_eq!(pad(&vec![0; PAYLOAD_MAX + 1]).unwrap_err().code, "padding");
    }

    #[test]
    fn conversation_ids() {
        assert_eq!(cid_kind("ch:x"), Ok("ch"));
        assert_eq!(cid_kind("room:a:b"), Ok("room"));
        assert!(cid_kind("room::b").is_err() && cid_kind("room:a:").is_err() && cid_kind("ch:").is_err());
        assert_eq!(dm_cid("b@x", "a@x").unwrap(), dm_cid("a@x", "b@x").unwrap());
        assert_eq!(principal_kind("archive@apps.acme.test"), Ok("archive"));
        assert_eq!(principal_kind("bot@apps.acme.test"), Ok("app"));
        assert_eq!(principal_domain("bot@apps.acme.test").unwrap(), "acme.test");
        assert!(is_doc_ref(&format!("doc:{}", "a".repeat(32))));
    }

    #[test]
    fn key_wrap_round_trip() {
        let me = DckKey::generate().unwrap();
        assert_eq!(DckKey::from_b64(&me.private_b64()).unwrap().raw(), me.raw());
        check_point(me.raw()).unwrap();
        let esk = DckKey::generate().unwrap();
        let key = [7u8; 32];
        let blob = seal_key(&esk, me.raw(), b"info", &key, [1; 12]).unwrap();
        assert_eq!(blob.len(), WRAP_BLOB_LEN);
        assert_eq!(open_key(&me, esk.raw(), b"info", &blob).unwrap(), key);
        assert_eq!(open_key(&me, esk.raw(), b"other", &blob).unwrap_err().code, "decrypt");
    }
}
