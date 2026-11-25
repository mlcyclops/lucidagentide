//! Sign-in methods of the Admin Console (contract 3.3, 11 I10): passwords (length, the offline
//! blocked list and context words, PBKDF2-HMAC-SHA-256 storage), the authenticator app (RFC 6238
//! TOTP with HMAC-SHA-1), decoy credential ids with fixed work (R3-L1) and the AC-7 lockout.
//! Every primitive runs on AWS-LC through `aws-lc-rs` (contract 0, crypto).

use std::collections::HashSet;
use std::num::NonZeroU32;
use std::sync::LazyLock;

use aws_lc_rs::{constant_time, hmac, pbkdf2};
use indexmap::IndexMap;
use unicode_normalization::UnicodeNormalization;

use crate::meet_org_policy::lp;

pub const PBKDF2_ITERATIONS: u32 = 600_000;
pub const PASSWORD_MAX: usize = 128;
const SALT_LEN: usize = 16;
const HASH_LEN: usize = 32;
const HASH_PREFIX: &str = "pbkdf2-sha256";
/// The largest iteration count `verify` accepts from a stored string (bounds the work per call).
const ITERATIONS_MAX: u32 = 10_000_000;

/// 15 under High, 12 under Standard (3.3 "Passwords").
pub fn min_len(high: bool) -> usize {
    if high {
        15
    } else {
        12
    }
}

/// Unicode code points after NFKC normalization.
pub fn password_len(p: &str) -> usize {
    p.nfkc().count()
}

const BLOCKED_TEXT: &str = include_str!("../data/blocked-passwords.txt");

/// The release's blocked list, lower-cased; lines starting with "# " are comments.
static BLOCKED: LazyLock<HashSet<String>> = LazyLock::new(|| {
    BLOCKED_TEXT
        .lines()
        .filter(|l| !l.starts_with("# "))
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .map(|l| l.nfkc().collect::<String>().to_lowercase())
        .collect()
});

fn blocked() -> &'static HashSet<String> {
    &BLOCKED
}

/// Product names and the word "lucid" (3.3 context words, as `context_words` in the vector).
const PRODUCT_WORDS: [&str; 7] = [
    "lucid",
    "lucid admin console",
    "admin console",
    "meeting hub",
    "lucid meeting hub",
    "remote spokes",
    "lucid remote spokes",
];

/// Context words shorter than this are ignored (the vector's rule).
const CONTEXT_PART_MIN: usize = 4;

/// 3.3 rules: Err("password-length") or Err("password-weak") (offline blocked list, or a context
/// word: product names, "lucid", host, the email's local part; case-insensitive).
pub fn check_new(password: &str, high: bool, host: &str, email: &str) -> Result<(), &'static str> {
    check_against(password, high, host, email, blocked())
}

fn check_length(password: &str, high: bool) -> Result<(), &'static str> {
    let n = password_len(password);
    if n < min_len(high) || n > PASSWORD_MAX {
        return Err("password-length");
    }
    Ok(())
}

fn check_against(
    password: &str,
    high: bool,
    host: &str,
    email: &str,
    list: &HashSet<String>,
) -> Result<(), &'static str> {
    check_length(password, high)?;
    let norm: String = password.nfkc().collect::<String>().to_lowercase();
    if list.contains(&norm) {
        return Err("password-weak");
    }
    let email = email.trim();
    let local = email.rsplit_once('@').map_or(email, |(l, _)| l);
    let words = PRODUCT_WORDS.iter().copied().chain([host.trim(), local]);
    for w in words {
        let w: String = w.nfkc().collect::<String>().to_lowercase();
        if w.chars().count() >= CONTEXT_PART_MIN && norm.contains(&w) {
            return Err("password-weak");
        }
    }
    Ok(())
}

thread_local! {
    static PBKDF2_CALLS: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
    static DECOY_HMACS: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

/// Thread-local count of PBKDF2 runs (console tests count them).
#[cfg(test)]
pub fn pbkdf2_calls() -> u64 {
    PBKDF2_CALLS.with(|c| c.get())
}

/// Thread-local count of decoy HMACs (console tests count them).
#[cfg(test)]
pub fn decoy_hmacs() -> u64 {
    DECOY_HMACS.with(|c| c.get())
}

/// The one place PBKDF2 runs. The password is hashed as the UTF-8 of its NFKC form.
fn derive(password: &str, salt: &[u8], iterations: NonZeroU32) -> [u8; HASH_LEN] {
    PBKDF2_CALLS.with(|c| c.set(c.get() + 1));
    let secret: String = password.nfkc().collect();
    let mut out = [0u8; HASH_LEN];
    pbkdf2::derive(pbkdf2::PBKDF2_HMAC_SHA256, iterations, salt, secret.as_bytes(), &mut out);
    out
}

/// `pbkdf2-sha256$600000$<salt>$<hash>` with a 16-byte random salt; None when the DRBG fails.
pub fn hash_new(password: &str) -> Option<String> {
    let salt = crate::console_auth::random(SALT_LEN)?;
    Some(hash_with(password, &salt, PBKDF2_ITERATIONS))
}

/// The stored string for a given salt and iteration count (0 iterations is taken as 1).
pub fn hash_with(password: &str, salt: &[u8], iterations: u32) -> String {
    let it = NonZeroU32::new(iterations).unwrap_or(NonZeroU32::MIN);
    let h = derive(password, salt, it);
    format!("{HASH_PREFIX}${}${}${}", it.get(), b64(salt), b64(&h))
}

fn parse_stored(stored: &str) -> Option<(NonZeroU32, Vec<u8>, Vec<u8>)> {
    let mut parts = stored.split('$');
    if parts.next()? != HASH_PREFIX {
        return None;
    }
    let it_text = parts.next()?;
    if it_text.is_empty() || !it_text.bytes().all(|b| b.is_ascii_digit()) || it_text.starts_with('0') {
        return None;
    }
    let it: u32 = it_text.parse().ok()?;
    if it > ITERATIONS_MAX {
        return None;
    }
    let salt = unb64(parts.next()?)?;
    let hash = unb64(parts.next()?)?;
    if parts.next().is_some() || salt.is_empty() || hash.len() != HASH_LEN {
        return None;
    }
    Some((NonZeroU32::new(it)?, salt, hash))
}

/// Exactly one PBKDF2 per call: against `stored`, or a fixed dummy hash when None or unparsable
/// (then always false); constant-time compare.
pub fn verify(password: &str, stored: Option<&str>) -> bool {
    match stored.and_then(parse_stored) {
        Some((it, salt, hash)) => {
            let got = derive(password, &salt, it);
            constant_time::verify_slices_are_equal(&got, &hash).is_ok()
        }
        None => {
            const DUMMY_SALT: [u8; SALT_LEN] = *b"lucid-dummy-salt";
            let it = NonZeroU32::new(PBKDF2_ITERATIONS).unwrap_or(NonZeroU32::MIN);
            let got = derive(password, &DUMMY_SALT, it);
            let _ = constant_time::verify_slices_are_equal(&got, &[0u8; HASH_LEN]);
            false
        }
    }
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Standard base64 (RFC 4648 section 4) with padding.
fn b64(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(B64[((n >> (18 - 6 * i)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// Strict standard base64 with padding; anything else is None.
fn unb64(s: &str) -> Option<Vec<u8>> {
    let bytes = s.as_bytes();
    if bytes.is_empty() || !bytes.len().is_multiple_of(4) {
        return None;
    }
    let pad = bytes.iter().rev().take_while(|&&c| c == b'=').count();
    if pad > 2 {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    for (ci, chunk) in bytes.chunks(4).enumerate() {
        let last = ci == bytes.len() / 4 - 1;
        let mut n: u32 = 0;
        for (i, &c) in chunk.iter().enumerate() {
            let v = if c == b'=' {
                if !last || i < 4 - pad {
                    return None;
                }
                0
            } else {
                B64.iter().position(|&a| a == c)? as u32
            };
            n = (n << 6) | v;
        }
        let b = [(n >> 16) as u8, (n >> 8) as u8, n as u8];
        let keep = if last { 3 - pad } else { 3 };
        // Non-canonical trailing bits are refused.
        if last && pad > 0 && b[keep..].iter().any(|&x| x != 0) {
            return None;
        }
        out.extend_from_slice(&b[..keep]);
    }
    Some(out)
}

pub const TOTP_SECRET_LEN: usize = 20;
const TOTP_STEP_MS: i64 = 30_000;

/// RFC 6238 with HMAC-SHA-1, 6 digits, 30-second steps: the code of one time step.
pub fn totp_at(secret: &[u8], step: i64) -> String {
    let key = hmac::Key::new(hmac::HMAC_SHA1_FOR_LEGACY_USE_ONLY, secret);
    let tag = hmac::sign(&key, &(step as u64).to_be_bytes());
    let h = tag.as_ref();
    let off = (h[h.len() - 1] & 0x0f) as usize;
    let bin = (u32::from(h[off] & 0x7f) << 24)
        | (u32::from(h[off + 1]) << 16)
        | (u32::from(h[off + 2]) << 8)
        | u32::from(h[off + 3]);
    format!("{:06}", bin % 1_000_000)
}

/// The time step a code matches at t_ms (step-1..=step+1), never a step <= last_used.
/// All three codes are computed and compared in constant time on every call.
pub fn totp_match(secret: &[u8], code: &str, t_ms: i64, last_used: Option<i64>) -> Option<i64> {
    let ok_shape = code.len() == 6 && code.bytes().all(|b| b.is_ascii_digit());
    let now = t_ms.div_euclid(TOTP_STEP_MS);
    let mut found = None;
    for step in [now - 1, now, now + 1] {
        let want = totp_at(secret, step);
        let same = constant_time::verify_slices_are_equal(want.as_bytes(), code.as_bytes()).is_ok();
        let fresh = last_used.is_none_or(|l| step > l);
        if ok_shape && same && fresh && found.is_none() {
            found = Some(step);
        }
    }
    found
}

/// RFC 4648 base32, upper case, no padding.
pub fn base32(b: &[u8]) -> String {
    const A: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let mut out = String::with_capacity(b.len().div_ceil(5) * 8);
    let mut buf: u64 = 0;
    let mut bits = 0u32;
    for &x in b {
        buf = (buf << 8) | u64::from(x);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(A[((buf >> bits) & 31) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(A[((buf << (5 - bits)) & 31) as usize] as char);
    }
    out
}

/// RFC 3986 percent-encoding of everything outside the unreserved set.
fn pct(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for &b in s.as_bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

pub const TOTP_ISSUER: &str = "Lucid Admin Console";

/// `otpauth://totp/<host>:<email>?secret=...&issuer=Lucid%20Admin%20Console&...`, each value
/// percent-encoded (the label's separating colon stays literal).
pub fn otpauth_uri(secret: &[u8], host: &str, email: &str) -> String {
    format!(
        "otpauth://totp/{}:{}?secret={}&issuer={}&algorithm=SHA1&digits=6&period=30",
        pct(host),
        pct(email),
        base32(secret),
        pct(TOTP_ISSUER)
    )
}

/// Decoy length while the console has no registered non-discoverable ids.
pub const DECOY_DEFAULT_LEN: usize = 64;

/// R3-L1: always exactly 4 mac_i = HMAC-SHA-256(key, lp(email, [i])) (fixed work), the email
/// with ASCII whitespace trimmed and A-Z lower-cased, `i` one byte; each decoy's length is
/// `lengths` (one per registered id, sorted ascending) at index u32_be(mac_i[0..4]) mod
/// `lengths.len()`, 64 bytes when empty. The id is the first `length` bytes of
/// SHA-256(mac_i || u32_be(0)) || SHA-256(mac_i || u32_be(1)) || ...
pub fn decoy_ids(key: &[u8], email: &str, lengths: &[usize]) -> [Vec<u8>; 4] {
    let k = hmac::Key::new(hmac::HMAC_SHA256, key);
    let email = email.trim_matches(|c: char| c.is_ascii_whitespace()).to_ascii_lowercase();
    let mut sorted: Vec<usize> = lengths.to_vec();
    sorted.sort_unstable();
    std::array::from_fn(|i| {
        DECOY_HMACS.with(|c| c.set(c.get() + 1));
        let tag = hmac::sign(&k, &lp(&[email.as_bytes(), &[i as u8]]));
        let h = tag.as_ref();
        let len = if sorted.is_empty() {
            DECOY_DEFAULT_LEN
        } else {
            let pick = u32::from_be_bytes([h[0], h[1], h[2], h[3]]) as usize;
            sorted[pick % sorted.len()]
        };
        let mut id = Vec::with_capacity(len.div_ceil(32) * 32);
        let mut j: u32 = 0;
        let mut block = [0u8; 36];
        block[..32].copy_from_slice(h);
        while id.len() < len {
            block[32..].copy_from_slice(&j.to_be_bytes());
            id.extend_from_slice(&crate::codec::sha256(&block));
            j += 1;
        }
        id.truncate(len);
        id
    })
}

pub const LOCKOUT_FAILURES: usize = 10;
pub const LOCKOUT_WINDOW_MS: i64 = 15 * 60 * 1000;
pub const LOCKOUT_WAIT_MS: i64 = 15 * 60 * 1000;
pub const LOCKOUT_MAX_KEYS: usize = 10_000;

#[derive(Default)]
struct Entry {
    /// Failure times inside the window, oldest first.
    fails: Vec<i64>,
    /// When the current (or last) wait began.
    locked: Option<i64>,
}

/// AC-7, 3.3: per email as typed (trimmed, lower-cased), 10 failures in 15 min -> 15 min wait;
/// at most 10,000 emails, the least recently failed dropped; memory only. Times are milliseconds
/// (`codec::now_ms`).
#[derive(Default)]
pub struct Lockout {
    map: IndexMap<String, Entry>,
}

impl Lockout {
    pub fn key(email: &str) -> String {
        email.trim().to_lowercase()
    }

    fn waiting(&self, key: &str, t: i64) -> Option<i64> {
        let at = self.map.get(key)?.locked?;
        (t >= at && t < at + LOCKOUT_WAIT_MS).then_some(at)
    }

    /// Whole seconds left (rounded up) while this key waits.
    pub fn wait(&self, key: &str, t: i64) -> Option<i64> {
        let at = self.waiting(key, t)?;
        let left = at + LOCKOUT_WAIT_MS - t;
        Some((left + 999) / 1000)
    }

    /// When the current wait began (a WebAuthn ceremony begun before it still completes).
    pub fn locked_at(&self, key: &str, t: i64) -> Option<i64> {
        self.waiting(key, t)
    }

    /// Records a failure; true when this failure starts a wait.
    pub fn fail(&mut self, key: &str, t: i64) -> bool {
        let waiting = self.waiting(key, t).is_some();
        let mut e = self.map.shift_remove(key).unwrap_or_default();
        e.fails.retain(|&f| f > t - LOCKOUT_WINDOW_MS && f <= t);
        let started = if waiting {
            false
        } else {
            e.fails.push(t);
            if e.fails.len() >= LOCKOUT_FAILURES {
                e.fails.clear();
                e.locked = Some(t);
                true
            } else {
                false
            }
        };
        self.map.insert(key.to_string(), e);
        while self.map.len() > LOCKOUT_MAX_KEYS {
            self.map.shift_remove_index(0);
        }
        started
    }

    /// Keys whose wait began at or after `since`.
    pub fn locked_since(&self, since: i64) -> Vec<String> {
        self.map
            .iter()
            .filter(|(_, e)| e.locked.is_some_and(|l| l >= since))
            .map(|(k, _)| k.clone())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codec::{hex, parse_json, str_of, unb64u};
    use serde_json::Value;

    fn vector(name: &str) -> Value {
        let path = format!("{}/tests/{name}", env!("CARGO_MANIFEST_DIR"));
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("{path}: {e} (copy it from the Meeting Hub repository's tests/vectors/)"));
        parse_json(&text).unwrap()
    }

    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }

    fn arr<'a>(v: &'a Value, k: &str) -> &'a Vec<Value> {
        v.get(k).and_then(Value::as_array).unwrap_or_else(|| panic!("vector key {k}"))
    }

    fn int(v: &Value, k: &str) -> i64 {
        v.get(k).and_then(Value::as_i64).unwrap_or_else(|| panic!("vector key {k}"))
    }

    fn code_of(v: &Value) -> &str {
        str_of(v.get("code")).unwrap_or("ok")
    }

    #[test]
    fn vector_pbkdf2_outputs() {
        let v = vector("admin_console_password_v1.json");
        assert_eq!(int(&v, "iterations"), i64::from(PBKDF2_ITERATIONS));
        assert_eq!(int(&v, "salt_bytes") as usize, SALT_LEN);
        assert_eq!(int(&v, "hash_bytes") as usize, HASH_LEN);
        for c in arr(&v, "pbkdf2") {
            let pw = str_of(c.get("password")).unwrap();
            let salt = unb64(str_of(c.get("salt_b64")).unwrap()).unwrap();
            let it = int(c, "iterations") as u32;
            let stored = str_of(c.get("stored")).unwrap();
            assert_eq!(hash_with(pw, &salt, it), stored, "{:?}", c.get("name"));
            assert_eq!(stored.rsplit('$').next(), str_of(c.get("hash_b64")));
            assert_eq!(str_of(c.get("nfkc")).unwrap(), pw.nfkc().collect::<String>());
            assert!(verify(pw, Some(stored)));
            assert!(!verify(&format!("{pw}x"), Some(stored)));
        }
        let dummy = str_of(v.get("dummy_stored")).unwrap();
        assert!(parse_stored(dummy).is_some());
    }

    #[test]
    fn vector_length_cases() {
        let v = vector("admin_console_password_v1.json");
        for c in arr(&v, "length") {
            let pw = str_of(c.get("password")).unwrap();
            let high = str_of(c.get("profile")) == Some("high");
            assert_eq!(password_len(pw) as i64, int(c, "codepoints"), "{pw:?}");
            let got = check_length(pw, high).err().unwrap_or("ok");
            assert_eq!(got, code_of(c), "{pw:?}");
        }
    }

    #[test]
    fn vector_blocked_cases() {
        let v = vector("admin_console_password_v1.json");
        let words: Vec<&str> = arr(&v, "context_words").iter().map(|w| w.as_str().unwrap()).collect();
        assert_eq!(words, PRODUCT_WORDS.to_vec());
        let sample: HashSet<String> = arr(&v, "blocked_list_sample")
            .iter()
            .map(|w| w.as_str().unwrap().nfkc().collect::<String>().to_lowercase())
            .collect();
        for c in arr(&v, "blocked") {
            let pw = str_of(c.get("password")).unwrap();
            let ctx = c.get("context").unwrap();
            let host = str_of(ctx.get("host")).unwrap();
            let email = str_of(ctx.get("email")).unwrap();
            let got = check_against(pw, true, host, email, &sample).err().unwrap_or("ok");
            assert_eq!(got, code_of(c), "{:?}", c.get("name"));
        }
        // The sample stands in for the list in these cases; the shipped list is the release's own (3.3: the 100,000
        // most common from SecLists NCSC, MIT), so only its size and a well-known entry are checked here.
        assert!(blocked().len() > 90_000, "the shipped list holds {} lines", blocked().len());
        assert!(blocked().contains("password"));
    }

    #[test]
    fn vector_decoy_ids() {
        let v = vector("admin_console_password_v1.json");
        let d = v.get("decoy").unwrap();
        let key = unhex(str_of(d.get("key_hex")).unwrap());
        let lens = |c: &Value| -> Vec<usize> { arr(c, "lengths").iter().map(|n| n.as_u64().unwrap() as usize).collect() };
        for c in arr(d, "cases") {
            let email = str_of(c.get("email")).unwrap();
            let i = int(c, "i") as usize;
            let before = decoy_hmacs();
            let got = decoy_ids(&key, email, &lens(c));
            assert_eq!(decoy_hmacs() - before, 4);
            assert_eq!(got[i].len() as i64, int(c, "length"));
            assert_eq!(got[i], unb64u(str_of(c.get("id_b64url")).unwrap()).unwrap(), "{email} {i}");
        }
        for c in arr(d, "answers") {
            let email = str_of(c.get("email")).unwrap();
            let real: Vec<Vec<u8>> = arr(c, "real_b64url").iter().map(|s| unb64u(s.as_str().unwrap()).unwrap()).collect();
            let want: Vec<Vec<u8>> = arr(c, "ids_b64url").iter().map(|s| unb64u(s.as_str().unwrap()).unwrap()).collect();
            let before = decoy_hmacs();
            let mut got = decoy_ids(&key, email, &lens(c)).to_vec();
            assert_eq!(decoy_hmacs() - before, 4);
            for (j, r) in real.into_iter().enumerate() {
                got[j] = r;
            }
            assert_eq!(got, want, "{:?}", c.get("name"));
        }
    }

    #[test]
    fn vector_totp() {
        let v = vector("admin_console_totp_v1.json");
        let secret = unhex(str_of(v.get("secret_hex")).unwrap());
        assert_eq!(base32(&secret), str_of(v.get("secret_b32")).unwrap());
        for c in arr(&v, "cases") {
            let step = int(c, "step");
            assert_eq!(int(c, "time").div_euclid(30), step);
            let code = str_of(c.get("code")).unwrap();
            assert_eq!(totp_at(&secret, step), code);
            assert!(str_of(c.get("code8")).unwrap().ends_with(code));
        }
        let w = v.get("window").unwrap();
        let t_ms = int(w, "time") * 1000;
        for c in arr(w, "cases") {
            let code = str_of(c.get("code")).unwrap();
            let ok = c.get("ok").and_then(Value::as_bool).unwrap();
            assert_eq!(totp_match(&secret, code, t_ms, None), ok.then(|| int(c, "step")), "{c}");
        }
        let r = v.get("reused").unwrap();
        let t_ms = int(r, "time") * 1000;
        let last = int(r, "last_step");
        for c in arr(r, "cases") {
            let code = str_of(c.get("code")).unwrap();
            let ok = c.get("ok").and_then(Value::as_bool).unwrap();
            assert_eq!(totp_match(&secret, code, t_ms, Some(last)).is_some(), ok, "{c}");
        }
        let u = v.get("uri").unwrap();
        assert_eq!(str_of(u.get("issuer")), Some(TOTP_ISSUER));
        // The URI case carries a secret of its own.
        let usecret = unhex(str_of(u.get("secret_hex")).unwrap());
        assert_eq!(base32(&usecret), str_of(u.get("secret_b32")).unwrap());
        assert_eq!(
            otpauth_uri(&usecret, str_of(u.get("host")).unwrap(), str_of(u.get("email")).unwrap()),
            str_of(u.get("uri")).unwrap()
        );
    }

    #[test]
    fn hash_format_and_verify() {
        let s = hash_with("correct horse battery staple", &[7u8; 16], 1000);
        let parts: Vec<&str> = s.split('$').collect();
        assert_eq!(parts.len(), 4);
        assert_eq!(parts[0], "pbkdf2-sha256");
        assert_eq!(parts[1], "1000");
        assert_eq!(unb64(parts[2]).unwrap(), vec![7u8; 16]);
        assert_eq!(unb64(parts[3]).unwrap().len(), 32);
        assert!(verify("correct horse battery staple", Some(&s)));
        assert!(!verify("correct horse battery stapl", Some(&s)));
        let fresh = hash_new("another long passphrase").unwrap();
        assert!(fresh.starts_with("pbkdf2-sha256$600000$"));
        assert_eq!(unb64(fresh.split('$').nth(2).unwrap()).unwrap().len(), 16);
    }

    #[test]
    fn pbkdf2_known_answer() {
        // RFC 7914 section 11, PBKDF2-HMAC-SHA-256 ("passwd", "salt", c = 1), first 32 bytes.
        let s = hash_with("passwd", b"salt", 1);
        let h = unb64(s.split('$').nth(3).unwrap()).unwrap();
        assert_eq!(hex(&h), "55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc");
    }

    #[test]
    fn verify_runs_exactly_one_pbkdf2() {
        let s = hash_with("one two three four five", &[1u8; 16], 1000);
        for stored in [Some(s.as_str()), None, Some("garbage"), Some("pbkdf2-sha256$0$AA==$AA=="), Some("")] {
            let before = pbkdf2_calls();
            let _ = verify("one two three four five", stored);
            assert_eq!(pbkdf2_calls() - before, 1, "{stored:?}");
        }
        assert!(!verify("anything at all here", None));
        assert!(!verify("anything at all here", Some("garbage")));
    }

    #[test]
    fn length_rules() {
        let h = "unrelated";
        let e = "zed@example.com";
        assert_eq!(check_new(&"q".repeat(14), true, h, e), Err("password-length"));
        assert_eq!(check_new("xkcdhorsebatte1", true, h, e), Ok(()));
        assert_eq!(check_new(&"q".repeat(11), false, h, e), Err("password-length"));
        assert_eq!(check_new("xkcdhorsebat", false, h, e), Ok(()));
        assert_eq!(check_new(&"q".repeat(129), false, h, e), Err("password-length"));
        assert_eq!(check_new(&"q".repeat(129), true, h, e), Err("password-length"));
        let at_max: String = "qwfp".repeat(32);
        assert_eq!(password_len(&at_max), 128);
        assert_eq!(check_new(&at_max, true, h, e), Ok(()));
    }

    #[test]
    fn nfkc_counting() {
        // U+FB03 (ffi ligature) is one code point and three after NFKC.
        assert_eq!(password_len("\u{FB03}"), 3);
        // Full-width letters fold to ASCII; the count stays one per letter.
        assert_eq!(password_len("\u{FF21}\u{FF22}"), 2);
        // Decomposed e + combining acute composes to one code point.
        assert_eq!(password_len("e\u{0301}"), 1);
        // Five ligatures (5 code points typed) count 15: accepted under High.
        let lig = "\u{FB03}\u{FB04}\u{FB03}\u{FB04}\u{FB03}";
        assert_eq!(lig.chars().count(), 5);
        assert_eq!(password_len(lig), 15);
        assert_eq!(check_new(lig, true, "unrelated", "zed@example.com"), Ok(()));
        // A full-width spelling of a blocked password is still blocked.
        let fw: String = "password1234".chars().map(|c| char::from_u32(c as u32 - 0x21 + 0xFF01).unwrap()).collect();
        assert!(blocked().contains("password1234"));
        assert_eq!(check_new(&fw, false, "unrelated", "zed@example.com"), Err("password-weak"));
    }

    #[test]
    fn blocked_and_context_words() {
        let h = "console.acme-relay.net";
        let e = "Jonathan.Smith@acme.example";
        // Lower-casing merges case variants of the 10,000 source lines.
        assert!(blocked().len() >= 9_000);
        assert_eq!(check_new("1q2w3e4r5t6y7u8i9o0p", true, "x", "z@y"), Err("password-weak"));
        assert_eq!(check_new("PASSWORD1234", false, "x", "z@y"), Err("password-weak"));
        assert_eq!(check_new("i love Lucid every day", true, "x", "z@y"), Err("password-weak"));
        assert_eq!(check_new("my Meeting Hub pass", true, "x", "z@y"), Err("password-weak"));
        assert_eq!(check_new("Remote Spokes rocks", true, "x", "z@y"), Err("password-weak"));
        // Context words under 4 characters are ignored.
        assert_eq!(check_new("bob violet tractor", true, "x", "bob@y"), Ok(()));
        assert_eq!(check_new("CONSOLE.ACME-RELAY.NET", true, h, "z@y"), Err("password-weak"));
        assert_eq!(check_new("jonathan.smith2026!", true, h, e), Err("password-weak"));
        assert_eq!(check_new("violet tractor ocean", true, h, e), Ok(()));
    }

    #[test]
    fn rfc6238_sha1_vectors() {
        let seed = b"12345678901234567890";
        // RFC 6238 appendix B, SHA-1; 6 digits are the last 6 of the 8-digit values.
        for (t, code) in [
            (59i64, "287082"),
            (1_111_111_109, "081804"),
            (1_111_111_111, "050471"),
            (1_234_567_890, "005924"),
            (2_000_000_000, "279037"),
            (20_000_000_000, "353130"),
        ] {
            assert_eq!(totp_at(seed, t / 30), code);
            assert_eq!(totp_match(seed, code, t * 1000, None), Some(t / 30));
        }
    }

    #[test]
    fn totp_window_and_reuse() {
        let secret = [9u8; TOTP_SECRET_LEN];
        let t_ms = 1_700_000_000_000i64;
        let now = t_ms / 30_000;
        assert_eq!(totp_match(&secret, &totp_at(&secret, now - 1), t_ms, None), Some(now - 1));
        assert_eq!(totp_match(&secret, &totp_at(&secret, now + 1), t_ms, None), Some(now + 1));
        let two_back = totp_at(&secret, now - 2);
        if two_back != totp_at(&secret, now - 1) && two_back != totp_at(&secret, now) && two_back != totp_at(&secret, now + 1) {
            assert_eq!(totp_match(&secret, &two_back, t_ms, None), None);
        }
        let code = totp_at(&secret, now);
        assert_eq!(totp_match(&secret, &code, t_ms, None), Some(now));
        assert_eq!(totp_match(&secret, &code, t_ms, Some(now)), None);
        assert_eq!(totp_match(&secret, &totp_at(&secret, now - 1), t_ms, Some(now)), None);
        assert_eq!(totp_match(&secret, &totp_at(&secret, now + 1), t_ms, Some(now)), Some(now + 1));
        assert_eq!(totp_match(&secret, "12345", t_ms, None), None);
        assert_eq!(totp_match(&secret, "abcdef", t_ms, None), None);
    }

    #[test]
    fn base32_and_uri() {
        assert_eq!(base32(b""), "");
        assert_eq!(base32(b"f"), "MY");
        assert_eq!(base32(b"foobar"), "MZXW6YTBOI");
        assert_eq!(base32(b"12345678901234567890"), "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
        let uri = otpauth_uri(b"12345678901234567890", "relay.example.com", "ann+x@example.com");
        assert_eq!(
            uri,
            "otpauth://totp/relay.example.com:ann%2Bx%40example.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Lucid%20Admin%20Console&algorithm=SHA1&digits=6&period=30"
        );
    }

    #[test]
    fn decoys_fixed_work_and_lengths() {
        let key = [3u8; 32];
        let before = decoy_hmacs();
        let a = decoy_ids(&key, "a@example.com", &[]);
        assert_eq!(decoy_hmacs() - before, 4);
        assert!(a.iter().all(|d| d.len() == 64));
        let before = decoy_hmacs();
        let b = decoy_ids(&key, "", &[16, 48, 48, 100]);
        assert_eq!(decoy_hmacs() - before, 4);
        assert!(b.iter().all(|d| [16, 48, 100].contains(&d.len())));
        // Deterministic, independent of the order of `lengths`, different per email.
        assert_eq!(decoy_ids(&key, "", &[100, 48, 16, 48]), b);
        assert_ne!(decoy_ids(&key, "b@example.com", &[]), a);
        let one = decoy_ids(&key, "a@example.com", &[20]);
        assert!(one.iter().all(|d| d.len() == 20));
        assert_eq!(one[0], a[0][..20].to_vec());
    }

    #[test]
    fn lockout_rules() {
        let mut l = Lockout::default();
        let k = Lockout::key("  Nobody@Example.COM ");
        assert_eq!(k, "nobody@example.com");
        let t0 = 1_000_000i64;
        for i in 0..9 {
            assert!(!l.fail(&k, t0 + i * 60_000));
        }
        assert_eq!(l.wait(&k, t0 + 9 * 60_000), None);
        assert!(l.fail(&k, t0 + 9 * 60_000));
        let at = t0 + 9 * 60_000;
        assert_eq!(l.locked_at(&k, at + 1), Some(at));
        assert_eq!(l.wait(&k, at), Some(900));
        assert_eq!(l.wait(&k, at + 1), Some(900));
        assert_eq!(l.wait(&k, at + LOCKOUT_WAIT_MS - 1), Some(1));
        assert!(!l.fail(&k, at + 1000));
        assert_eq!(l.locked_since(at), vec![k.clone()]);
        assert!(l.locked_since(at + 1).is_empty());
        assert_eq!(l.wait(&k, at + LOCKOUT_WAIT_MS), None);
        assert_eq!(l.locked_at(&k, at + LOCKOUT_WAIT_MS), None);

        // Failures spread over more than 15 minutes never lock.
        let mut l = Lockout::default();
        for i in 0..30 {
            assert!(!l.fail("slow@x", i * 100_001));
        }
        assert_eq!(l.wait("slow@x", 30 * 100_001), None);

        // 10,001 keys: the oldest is dropped.
        let mut l = Lockout::default();
        for _ in 0..9 {
            l.fail("first@x", 0);
        }
        for i in 0..LOCKOUT_MAX_KEYS {
            l.fail(&format!("k{i}@x"), 1);
        }
        assert_eq!(l.map.len(), LOCKOUT_MAX_KEYS);
        assert!(!l.map.contains_key("first@x"));
        assert!(!l.fail("first@x", 2));
    }

    #[test]
    fn no_long_dashes() {
        let src = include_str!("console_password.rs");
        assert!(!src.contains('\u{2014}') && !src.contains('\u{2013}'));
        assert!(!BLOCKED_TEXT.contains('\u{2014}') && !BLOCKED_TEXT.contains('\u{2013}'));
        let all = [TOTP_ISSUER, HASH_PREFIX, "password-length", "password-weak"].concat();
        assert!(!all.contains('\u{2014}') && !all.contains('\u{2013}'));
    }
}
