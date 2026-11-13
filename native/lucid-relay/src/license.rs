// The relay license, rule for rule from the add-on's src/license.ts: the v2 token (Ed25519 by the publisher key, or
// by a development key only with LUCID_LICENSE_DEV=1 and LUCID_LICENSE_DEV_PUB), its editions, its state (valid,
// grace, expired) and the user book `license-users.json`.

use crate::codec::{as_object, b64_decode_lenient, exact_keys, is_int, js_trim, num_is, parse_json, str_of, unb64u, utf16_len, utf8_lossy};
use crate::der::{ed25519_verify, parse_spki, Ed25519Key, P256Key, PublicKey};
use crate::identity::{is_node_id, is_serial, open_compact, NodeCert};
use indexmap::IndexMap;
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// The TECHLEAD 187 LLC license publisher key (Ed25519, SPKI DER, base64).
pub const LICENSE_PUBLISHER_SPKI: &str = "MCowBQYDK2VwAyEArNtRnkfcASRcd/drmTVEwOmoH3cwIK7GXSRuPdf3Hpw=";
pub const LICENSE_TYP: &str = "lucid-relay-license";
pub const LICENSE_USERS_FILE: &str = "license-users.json";
pub const LICENSE_V1_SEATS_FILE: &str = "license-seats.json";
/// The names these books had before the American spelling: a relay renames an old one to the new name at start.
pub const LICENSE_USERS_FILE_OLD: &str = "licence-users.json";
pub const LICENSE_V1_SEATS_FILE_OLD: &str = "licence-seats.json";
pub const LICENSE_V1_REASON: &str = "a version 1 relay license: ask for a new license (Standard or Enterprise)";
const FEATURES: [&str; 2] = ["relay", "spokes"];
const EDITIONS: [&str; 2] = ["standard", "enterprise"];
const DEFAULT_GRACE_DAYS: i64 = 14;
const MAX_GRACE_DAYS: i64 = 30;
const STANDARD_MAX_USERS: i64 = 20;
const MAX_USERS: i64 = 10_000;
/// F2 (ADR-A100): what a licensed relay answers (403) a hub with no good seat for this relay's license (seat_problem
/// says why, in its security line).
pub const UNCOUNTED_REASON: &str = "this hub was not counted under this relay's license: the org root signs it a license seat (root seat, or root renew with the license installed)";
/// F2 (ADR-A100): the request header a hub sends its license seat in.
pub const SEAT_HEADER: &str = "lucid-seat";
const SEAT_TYP: &str = "lucid-license-seat";
const SEAT_KEYS: [&str; 9] = ["v", "typ", "root", "license", "node", "serial", "user", "iat", "exp"];
const MAX_SEAT_TOKEN: usize = 2048;
/// F2 (ADR-A100): what a mailbox with no license (a spoke's LAN mailbox) answers (403) a relay directory naming more
/// than one relay.
pub const UNLICENSED_DIRECTORY_REASON: &str = "a mailbox with no license carries a relay directory of one relay at most: post it to a licensed relay";
const MAX_RELAYS: i64 = 100;
const DAY_SEC: i64 = 86_400;
const CLOCK_SKEW_SEC: i64 = 120;
const MAX_LICENSE_TOKEN: usize = 4096;
const ARMOR_BEGIN: &str = "-----BEGIN LUCID RELAY LICENSE-----";
const ARMOR_END: &str = "-----END LUCID RELAY LICENSE-----";

/// The keys a license may be signed with.
pub struct LicenseKeys {
    pub publisher: Ed25519Key,
    pub dev: Option<Ed25519Key>,
}

fn ed25519_spki(b64: &str, what: &str) -> Result<Ed25519Key, String> {
    let well_formed = {
        let body = b64.trim_end_matches('=');
        !body.is_empty() && b64.len() - body.len() <= 2 && body.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'+' || c == b'/')
    };
    match well_formed.then(|| parse_spki(&b64_decode_lenient(b64))).flatten() {
        Some(PublicKey::Ed25519(k)) => Ok(k),
        _ => Err(format!("{what} must be an Ed25519 public key (SPKI DER, base64)")),
    }
}

/// The publisher key, plus the development key when LUCID_LICENSE_DEV=1 AND LUCID_LICENSE_DEV_PUB are both set.
pub fn license_keys(env: impl Fn(&str) -> Option<String>) -> Result<LicenseKeys, String> {
    let publisher = ed25519_spki(LICENSE_PUBLISHER_SPKI, "the baked license publisher key")?;
    let flag = env("LUCID_LICENSE_DEV").filter(|v| !v.is_empty()).unwrap_or_else(|| "0".into());
    if flag != "0" && flag != "1" {
        return Err("LUCID_LICENSE_DEV must be 1 (accept the development license key) or unset".into());
    }
    if flag != "1" {
        return Ok(LicenseKeys { publisher, dev: None });
    }
    let public = env("LUCID_LICENSE_DEV_PUB").unwrap_or_default();
    if public.is_empty() {
        return Err("LUCID_LICENSE_DEV=1 needs LUCID_LICENSE_DEV_PUB (the development key's SPKI, base64; `license dev-key` prints it)".into());
    }
    Ok(LicenseKeys { publisher, dev: Some(ed25519_spki(js_trim(&public), "LUCID_LICENSE_DEV_PUB")?) })
}

#[derive(Clone, Debug)]
pub struct License {
    pub id: String,
    pub org: String,
    pub root: String,
    pub edition: String,
    pub users: i64,
    pub relays: i64,
    pub exp: i64,
    pub grace_days: i64,
}

/// ORG_RE (/u): 1 to 80 code points, no control characters, no white space at either end.
fn is_org(s: &str) -> bool {
    let chars: Vec<char> = s.chars().collect();
    let control = |c: &char| (*c as u32) < 0x20 || *c == '\u{7f}';
    let edge = |c: &char| !control(c) && !crate::codec::is_js_space(*c);
    !chars.is_empty() && chars.len() <= 80 && edge(&chars[0]) && edge(&chars[chars.len() - 1]) && !chars.iter().any(control)
}

fn license_problem(p: Option<&Map<String, Value>>) -> Option<String> {
    let required = ["v", "typ", "id", "org", "root", "edition", "users", "relays", "features", "iat", "exp"];
    let mut allowed = required.to_vec();
    allowed.push("graceDays");
    let Some(p) = p.filter(|p| exact_keys(p, &allowed, &required)) else { return Some("unexpected fields".into()) };
    if !num_is(p.get("v"), 2.0) || str_of(p.get("typ")) != Some(LICENSE_TYP) {
        return Some("not a relay license".into());
    }
    let id_ok = str_of(p.get("id")).is_some_and(|i| i.len() == 18 && i.starts_with("l_") && i[2..].bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)));
    if !id_ok {
        return Some("id must be l_ and 16 hex".into());
    }
    if !str_of(p.get("org")).is_some_and(is_org) {
        return Some("org must be 1 to 80 characters with no control characters or padding spaces".into());
    }
    if !str_of(p.get("root")).is_some_and(is_node_id) {
        return Some("root must be an org root node id (n_...)".into());
    }
    let Some(edition) = str_of(p.get("edition")).filter(|e| EDITIONS.contains(e)) else { return Some(format!("edition must be {}", EDITIONS.join(" or "))) };
    let Some(users) = is_int(p.get("users")).filter(|u| (1..=MAX_USERS).contains(u)) else { return Some(format!("users must be 1 to {MAX_USERS}")) };
    let Some(relays) = is_int(p.get("relays")).filter(|r| (1..=MAX_RELAYS).contains(r)) else { return Some(format!("relays must be 1 to {MAX_RELAYS}")) };
    if edition == "standard" && users > STANDARD_MAX_USERS {
        return Some(format!("a Standard license allows 1 to {STANDARD_MAX_USERS} users; more users need an Enterprise license"));
    }
    if edition == "standard" && relays != 1 {
        return Some("a Standard license covers one relay; more relays need an Enterprise license".into());
    }
    let features_ok = p.get("features").and_then(Value::as_array).is_some_and(|f| {
        let names: Vec<Option<&str>> = f.iter().map(Value::as_str).collect();
        let set: HashSet<&Option<&str>> = names.iter().collect();
        set.len() == names.len() && names.iter().all(|n| n.is_some_and(|n| FEATURES.contains(&n))) && FEATURES.iter().all(|x| names.contains(&Some(*x)))
    });
    if !features_ok {
        return Some(format!("features must be {}", FEATURES.join(" and ")));
    }
    let (iat, exp) = (is_int(p.get("iat")), is_int(p.get("exp")));
    if !matches!((iat, exp), (Some(i), Some(e)) if e > i) {
        return Some("exp must be after iat (seconds)".into());
    }
    if let Some(g) = p.get("graceDays") {
        if !is_int(Some(g)).is_some_and(|g| g <= MAX_GRACE_DAYS) {
            return Some(format!("graceDays must be 0 to {MAX_GRACE_DAYS}"));
        }
    }
    None
}

pub struct LicenseCheck {
    pub license: License,
    pub dev: bool,
}

/// Verify a license token: the signature (publisher first), the shape, the root, and not issued in the future.
pub fn verify_license(token: &str, root: &str, keys: &LicenseKeys, now: i64) -> Result<LicenseCheck, String> {
    let bad = || Err("malformed license".to_string());
    if utf16_len(token) > MAX_LICENSE_TOKEN {
        return bad();
    }
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 2 {
        return bad();
    }
    let (Some(body), Some(sig)) = (unb64u(parts[0]), unb64u(parts[1])) else { return bad() };
    if sig.len() != 64 {
        return bad();
    }
    let dev = if ed25519_verify(&keys.publisher, &body, &sig) {
        false
    } else if keys.dev.as_ref().is_some_and(|k| ed25519_verify(k, &body, &sig)) {
        true
    } else {
        return Err("license is not signed by the license publisher".into());
    };
    let parsed = parse_json(&utf8_lossy(&body));
    let p = parsed.as_ref().and_then(as_object);
    if let Some(p) = p {
        if num_is(p.get("v"), 1.0) && str_of(p.get("typ")) == Some(LICENSE_TYP) {
            return Err(LICENSE_V1_REASON.into());
        }
    }
    if let Some(problem) = license_problem(p) {
        return Err(format!("malformed license: {problem}"));
    }
    let p = p.expect("checked by license_problem");
    let int = |k: &str| is_int(p.get(k)).unwrap_or(0);
    let s = |k: &str| str_of(p.get(k)).unwrap_or_default().to_owned();
    let license = License {
        id: s("id"),
        org: s("org"),
        root: s("root"),
        edition: s("edition"),
        users: int("users"),
        relays: int("relays"),
        exp: int("exp"),
        grace_days: is_int(p.get("graceDays")).unwrap_or(DEFAULT_GRACE_DAYS),
    };
    if license.root != root {
        return Err(format!("license is for another root ({}, this relay trusts {root})", license.root));
    }
    if int("iat") > now + CLOCK_SKEW_SEC {
        return Err("license is not valid yet".into());
    }
    Ok(LicenseCheck { license, dev })
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum LicenseStateName {
    Valid,
    Grace,
    Expired,
}

impl LicenseStateName {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Valid => "valid",
            Self::Grace => "grace",
            Self::Expired => "expired",
        }
    }
}

/// Where a license stands at `now` (seconds): valid until exp, then grace for graceDays, then expired.
pub fn license_state(l: &License, now: i64) -> (LicenseStateName, i64) {
    let ceil_days = |s: i64| (s + DAY_SEC - 1).div_euclid(DAY_SEC);
    if now < l.exp {
        return (LicenseStateName::Valid, ceil_days(l.exp - now));
    }
    let grace_ends = l.exp + l.grace_days * DAY_SEC;
    if now < grace_ends {
        return (LicenseStateName::Grace, ceil_days(grace_ends - now));
    }
    (LicenseStateName::Expired, 0)
}

/// The token inside a license file or value: armored, or the bare token.
pub fn license_token_of(text: &str) -> String {
    let t = js_trim(text);
    let Some(inner) = t.strip_prefix(ARMOR_BEGIN) else { return t.to_owned() };
    let inner = js_trim(inner);
    match inner.strip_suffix(ARMOR_END) {
        Some(body) => body.chars().filter(|c| !crate::codec::is_js_space(*c)).collect(),
        None => String::new(),
    }
}

/// The person a hub certificate counts as: the user it names, else the hub node itself.
pub fn license_user_of(cert: &NodeCert) -> String {
    cert.user.as_ref().map_or_else(|| cert.node.clone(), |u| u.id.clone())
}

/// F2 (ADR-A100), license.ts seatProblem word for word: why `seat` (the request's `lucid-seat` header) does not count
/// hub certificate `cert` under license `license` at `now` (seconds), or None. A seat is the org root's word that it
/// counted that one certificate's user: { v: 1, typ: "lucid-license-seat", root, license, node, serial, user, iat, exp }.
pub fn seat_problem(seat: Option<&str>, root: &P256Key, root_id: &str, license: &str, cert: &NodeCert, now: i64) -> Option<&'static str> {
    let Some(token) = seat.filter(|s| !s.is_empty()) else { return Some("no license seat") };
    let Some(p) = open_compact(Some(&Value::String(token.to_owned())), root, MAX_SEAT_TOKEN) else { return Some("license seat is not signed by this root") };
    const MALFORMED: Option<&str> = Some("malformed license seat");
    if !exact_keys(&p, &SEAT_KEYS, &SEAT_KEYS) || !num_is(p.get("v"), 1.0) || str_of(p.get("typ")) != Some(SEAT_TYP) || str_of(p.get("root")) != Some(root_id) {
        return MALFORMED;
    }
    let (Some(id), Some(node), Some(serial), Some(user)) = (str_of(p.get("license")), str_of(p.get("node")), str_of(p.get("serial")), str_of(p.get("user"))) else { return MALFORMED };
    let (Some(iat), Some(exp)) = (is_int(p.get("iat")), is_int(p.get("exp"))) else { return MALFORMED };
    if id != license {
        return Some("license seat is for another license");
    }
    if node != cert.node || serial != cert.serial || user != license_user_of(cert) {
        return Some("license seat is for another certificate");
    }
    if iat > now + CLOCK_SKEW_SEC {
        return Some("license seat is not valid yet");
    }
    if exp <= now {
        return Some("license seat expired");
    }
    None
}

/// /^[un]_[0-9a-f]{32}$/
fn is_user_key(s: &str) -> bool {
    s.len() == 34 && (s.starts_with("u_") || s.starts_with("n_")) && s[2..].bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

struct UserSeat {
    since: i64,
    certs: IndexMap<String, i64>,
}

#[derive(PartialEq, Eq, Debug)]
pub enum Admission {
    Held,
    Taken,
    Refused,
}

pub struct Freed {
    pub user: String,
    pub why: &'static str,
}

pub struct SeatView {
    pub user: String,
    pub since: i64,
    pub certificates: usize,
    pub exp: i64,
}

/// The people a licensed relay admitted, each with every certificate it was seen with (license.ts LicenseUsers).
pub struct LicenseUsers {
    file: Option<PathBuf>,
    users: IndexMap<String, UserSeat>,
}

/// In `dir`, rename `from` to `to` when `to` is absent and `from` exists (license.ts migrateLicenseFile). True when it
/// renamed; Err when the rename failed.
pub fn migrate_license_file(dir: &Path, from: &str, to: &str) -> Result<bool, String> {
    let (old, new) = (dir.join(from), dir.join(to));
    if new.exists() || !old.exists() {
        return Ok(false);
    }
    std::fs::rename(&old, &new).map_err(|e| format!("cannot rename {} to {}: {e}", old.display(), new.display()))?;
    Ok(true)
}

impl LicenseUsers {
    pub fn open(file: Option<&Path>) -> Result<LicenseUsers, String> {
        let mut book = LicenseUsers { file: file.map(Path::to_path_buf), users: IndexMap::new() };
        let Some(file) = file else { return Ok(book) };
        let Some(raw) = crate::store::read_text(file) else { return Ok(book) };
        let broken = || format!("{} is not a license user book: fix it, or remove it so every live hub takes its seat again", file.display());
        let parsed = parse_json(&raw);
        let o = parsed.as_ref().and_then(as_object).ok_or_else(broken)?;
        let users = o.get("users").and_then(as_object);
        let Some(users) = users.filter(|_| exact_keys(o, &["v", "users"], &["v", "users"]) && num_is(o.get("v"), 2.0)) else { return Err(broken()) };
        for (user, v) in users {
            let s = v.as_object().filter(|s| is_user_key(user) && exact_keys(s, &["since", "certs"], &["since", "certs"])).ok_or_else(broken)?;
            let since = is_int(s.get("since")).ok_or_else(broken)?;
            let certs = s.get("certs").and_then(as_object).ok_or_else(broken)?;
            let mut seat = UserSeat { since, certs: IndexMap::new() };
            for (serial, exp) in certs {
                let exp = is_int(Some(exp)).filter(|_| is_serial(serial)).ok_or_else(broken)?;
                seat.certs.insert(serial.clone(), exp);
            }
            if seat.certs.is_empty() {
                return Err(broken());
            }
            book.users.insert(user.clone(), seat);
        }
        Ok(book)
    }

    pub fn used(&self) -> i64 {
        self.users.len() as i64
    }

    /// The seats as the control panel shows them (ADR-A094): the user key, since when (seconds), how many
    /// certificates, and when the last of them ends (seconds).
    pub fn seats(&self) -> Vec<SeatView> {
        self.users.iter().map(|(u, s)| SeatView { user: u.clone(), since: s.since, certificates: s.certs.len(), exp: s.certs.values().copied().max().unwrap_or(0) }).collect()
    }

    fn save(&self) -> Result<(), String> {
        let Some(file) = &self.file else { return Ok(()) };
        let mut users = Map::new();
        for (user, s) in &self.users {
            let certs: Map<String, Value> = s.certs.iter().map(|(k, v)| (k.clone(), Value::from(*v))).collect();
            users.insert(user.clone(), json!({ "since": s.since, "certs": certs }));
        }
        let text = format!("{}\n", crate::codec::stringify(&json!({ "v": 2, "users": users })));
        crate::store::write_private(file, text.as_bytes()).map_err(|e| e.to_string())
    }

    /// Drop every certificate revoked or expired at `now`; a user left with none frees its seat.
    pub fn prune(&mut self, is_revoked: impl Fn(&str) -> bool, now: i64) -> Result<Vec<Freed>, String> {
        let mut freed = Vec::new();
        let mut changed = false;
        self.users.retain(|user, s| {
            let mut revoked = false;
            s.certs.retain(|serial, exp| {
                let gone = is_revoked(serial);
                if !gone && *exp > now {
                    return true;
                }
                revoked |= gone;
                changed = true;
                false
            });
            if !s.certs.is_empty() {
                return true;
            }
            freed.push(Freed { user: user.clone(), why: if revoked { "revoked" } else { "expired" } });
            false
        });
        if changed {
            self.save()?;
        }
        Ok(freed)
    }

    /// Admit a hub whose certificate the relay just verified: its user's seat, a free one, or none.
    pub fn admit(&mut self, cert: &NodeCert, users: i64, now: i64) -> Result<Admission, String> {
        let user = license_user_of(cert);
        if !is_user_key(&user) {
            return Ok(Admission::Refused);
        }
        if !self.users.contains_key(&user) {
            if self.used() >= users {
                return Ok(Admission::Refused);
            }
            let mut certs = IndexMap::new();
            certs.insert(cert.serial.clone(), cert.exp);
            self.users.insert(user, UserSeat { since: now, certs });
            self.save()?;
            return Ok(Admission::Taken);
        }
        let Some(mine) = self.users.get_mut(&user) else { return Ok(Admission::Refused) };
        let since = mine.since;
        if mine.certs.get(&cert.serial) != Some(&cert.exp) {
            mine.certs.insert(cert.serial.clone(), cert.exp);
            self.save()?;
        }
        if self.used() <= users {
            return Ok(Admission::Held);
        }
        let earlier = self.users.iter().filter(|(u, s)| s.since < since || (s.since == since && u.as_str() < user.as_str())).count() as i64;
        Ok(if earlier < users { Admission::Held } else { Admission::Refused })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// F2 (ADR-A100): a seat counts one hub certificate under one license, signed by this root, in date.
    #[test]
    fn f2_a_seat_counts_one_certificate_under_one_license() {
        use crate::codec::{b64u, stringify};
        use crate::der::p256_spki_der;
        use crate::identity::node_id_of;
        use p256::ecdsa::signature::Signer;
        use p256::ecdsa::{Signature, SigningKey};
        let root = SigningKey::from_slice(&[7u8; 32]).unwrap();
        let other = SigningKey::from_slice(&[8u8; 32]).unwrap();
        let root_key: crate::der::P256Key = root.verifying_key().into();
        let root_id = node_id_of(&p256_spki_der(&root_key));
        let now = 1_800_000_000;
        let cert = NodeCert {
            serial: "a".repeat(32),
            node: format!("n_{}", "1".repeat(32)),
            role: "hub".into(),
            label: "Desk".into(),
            scopes: vec!["recall".into()],
            iat: now - 60,
            exp: now + 86_400,
            user: None,
            classification: None,
            region: None,
        };
        let seat = |key: &SigningKey, edit: &dyn Fn(&mut Value)| {
            let mut p = json!({
                "v": 1, "typ": "lucid-license-seat", "root": root_id, "license": "l_0123456789abcdef", "node": cert.node, "serial": cert.serial,
                "user": cert.node, "iat": now, "exp": cert.exp,
            });
            edit(&mut p);
            let body = stringify(&p);
            let sig: Signature = key.sign(body.as_bytes());
            format!("{}.{}", b64u(body.as_bytes()), b64u(sig.to_der().as_bytes()))
        };
        let judge = |token: Option<&str>| seat_problem(token, &root_key, &root_id, "l_0123456789abcdef", &cert, now);
        let set = |key: &'static str, v: Value| move |p: &mut Value| p[key] = v.clone();
        assert_eq!(judge(Some(seat(&root, &|_: &mut Value| {}).as_str())), None);
        assert_eq!(judge(None), Some("no license seat"));
        assert_eq!(judge(Some("")), Some("no license seat"));
        assert_eq!(judge(Some(seat(&other, &|_: &mut Value| {}).as_str())), Some("license seat is not signed by this root"));
        assert_eq!(judge(Some(seat(&root, &set("extra", json!(1))).as_str())), Some("malformed license seat"));
        assert_eq!(judge(Some(seat(&root, &set("license", json!("l_fedcba9876543210"))).as_str())), Some("license seat is for another license"));
        assert_eq!(judge(Some(seat(&root, &set("serial", json!("b".repeat(32)))).as_str())), Some("license seat is for another certificate"));
        assert_eq!(judge(Some(seat(&root, &set("iat", json!(now + 3600))).as_str())), Some("license seat is not valid yet"));
        assert_eq!(judge(Some(seat(&root, &set("exp", json!(now))).as_str())), Some("license seat expired"));
    }

    #[test]
    fn states_and_days_left() {
        let l = License { id: String::new(), org: String::new(), root: String::new(), edition: "standard".into(), users: 1, relays: 1, exp: 1_800_000_000 + 10 * DAY_SEC, grace_days: 14 };
        assert_eq!(license_state(&l, 1_800_000_000), (LicenseStateName::Valid, 10));
        assert_eq!(license_state(&l, l.exp - 1), (LicenseStateName::Valid, 1));
        assert_eq!(license_state(&l, l.exp), (LicenseStateName::Grace, 14));
        assert_eq!(license_state(&l, l.exp + 13 * DAY_SEC + 1), (LicenseStateName::Grace, 1));
        assert_eq!(license_state(&l, l.exp + 14 * DAY_SEC), (LicenseStateName::Expired, 0));
    }

    #[test]
    fn old_named_user_book_is_renamed_and_read() {
        let dir = std::env::temp_dir().join(format!("lucid-relay-users-migrate-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let book = r#"{"v":2,"users":{"u_00112233445566778899aabbccddeeff":{"since":1800000000,"certs":{"0a1b2c3d4e5f60718293a4b5c6d7e8f9":1900000000}}}}"#;
        std::fs::write(dir.join(LICENSE_USERS_FILE_OLD), book).unwrap();
        let file = dir.join(LICENSE_USERS_FILE);
        assert!(migrate_license_file(&dir, LICENSE_USERS_FILE_OLD, LICENSE_USERS_FILE).unwrap());
        assert!(file.exists() && !dir.join(LICENSE_USERS_FILE_OLD).exists());
        assert!(!migrate_license_file(&dir, LICENSE_USERS_FILE_OLD, LICENSE_USERS_FILE).unwrap());
        let users = LicenseUsers::open(Some(&file)).unwrap();
        assert_eq!(users.used(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn armor_and_keys() {
        assert_eq!(license_token_of(&format!("{ARMOR_BEGIN}\nabc.\n def\n{ARMOR_END}\n")), "abc.def");
        assert_eq!(license_token_of(" tok.en\n"), "tok.en");
        assert_eq!(license_token_of(&format!("{ARMOR_BEGIN}\nabc.def\n-----BROKEN")), "");
        let env = |vals: &'static [(&'static str, &'static str)]| move |k: &str| vals.iter().find(|(n, _)| *n == k).map(|(_, v)| v.to_string());
        assert!(license_keys(env(&[])).unwrap().dev.is_none());
        assert!(license_keys(env(&[("LUCID_LICENSE_DEV", "1")])).err().unwrap().contains("needs LUCID_LICENSE_DEV_PUB"));
        assert!(license_keys(env(&[("LUCID_LICENSE_DEV", "yes")])).err().unwrap().contains("must be 1"));
        assert!(license_keys(env(&[("LUCID_LICENSE_DEV", "1"), ("LUCID_LICENSE_DEV_PUB", "AAAA")])).err().unwrap().contains("Ed25519"));
        assert!(is_org("Acme Robotics"));
        assert!(!is_org(" Acme"));
        assert!(!is_org("Acme\u{7}"));
    }
}
