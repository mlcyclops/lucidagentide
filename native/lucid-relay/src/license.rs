// The relay license, rule for rule from the add-on's src/license.ts: the v2 token (Ed25519 by the publisher key, or,
// only in a `dev-license` build, by a development key with LUCID_LICENSE_DEV=1 and LUCID_LICENSE_DEV_PUB), its
// editions, its state (valid, grace, expired) and the user book `license-users.json`.
//
// AC-1 (contract 2.4): two products in the one v2 token format. `features` is exactly one of two arrays:
// `["relay", "spokes"]` (Remote Spokes, `root` the org root node id `n_...`, accepted by `lucid-relay`) or `["meet"]`
// (Meeting Hub, `root` the Meet root id `m_` and the first 32 hex of the SHA-256 of a Meet root CA certificate's
// SubjectPublicKeyInfo DER, accepted by `lucid-relay meet` when it equals the id of any self-signed certificate in its
// `client_ca`). Every Remote Spokes license keeps its meaning. The check is a compliance check, not a security boundary.

use crate::codec::{as_object, b64_decode_lenient, exact_keys, is_int, js_trim, num_is, parse_json, str_of, unb64u, utf16_len, utf8_lossy};
use crate::der::{ed25519_verify, parse_spki, Ed25519Key, P256Key, PublicKey};
use crate::identity::{is_node_id, is_serial, open_compact, NodeCert};
use indexmap::IndexMap;
use serde_json::{json, Map, Value};
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
const SPOKES_FEATURES: [&str; 2] = ["relay", "spokes"];
const MEET_FEATURES: [&str; 1] = ["meet"];
/// What a Meeting Hub license gets on a Meet relay whose `client_ca` holds no self-signed certificate (AC-1 2.4).
pub const NO_MEET_ROOT: &str = "this relay's client_ca has no root certificate";
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

// AC-1 2.4 "Development licenses" (R4-H1, decision 51): a license's purpose is its signing key. A production build
// (the release profile, and every fips build) holds only the publisher key and has no development-key path; the
// `dev-license` feature, which release CI never enables, adds it. The stricter reading: `dev-license` with either the
// release profile (no debug assertions) or `fips` does not compile.
#[cfg(all(feature = "dev-license", any(not(debug_assertions), feature = "fips")))]
compile_error!("the dev-license feature accepts development licenses: never build it with the release profile or the fips feature");

/// The marker the release artifact scan rejects (decision 48): in every `dev-license` binary, in none other.
#[cfg(feature = "dev-license")]
#[used]
static DEV_LICENSE_MARKER: [u8; 17] = *b"lucid-dev-license";

/// What a `dev-license` build logs at every start (words `cli.dev-license`); None in every other build.
pub fn dev_license_notice() -> Option<&'static str> {
    // Read the marker so no linker drops it: the artifact scan must find it in every dev-license binary.
    #[cfg(feature = "dev-license")]
    return std::hint::black_box(&DEV_LICENSE_MARKER).first().map(|_| "This build accepts development licenses. Not for production.");
    #[cfg(not(feature = "dev-license"))]
    None
}

/// What a verifier holding only the development key answers a token that key did not sign (a publisher license).
pub const NOT_DEV_SIGNED: &str = "license is not signed by the development key";

/// The keys a license may be signed with: the publisher key (absent only in the test binaries, which hold the
/// development key alone, LicenseKeys::development_only), and a development key only in builds that have that path.
pub struct LicenseKeys {
    publisher: Option<Ed25519Key>,
    #[cfg(any(test, feature = "dev-license", feature = "live-check-clock"))]
    dev: Option<Ed25519Key>,
}

impl LicenseKeys {
    /// The publisher key alone: every production build.
    pub fn publisher_only() -> Result<LicenseKeys, String> {
        Ok(LicenseKeys {
            publisher: Some(ed25519_spki(LICENSE_PUBLISHER_SPKI, "the baked license publisher key")?),
            #[cfg(any(test, feature = "dev-license", feature = "live-check-clock"))]
            dev: None,
        })
    }

    /// The publisher key and the development key `dev_spki_b64` (SPKI DER, base64): the env path of a `dev-license`
    /// build, and tests (`what` names the key in the refusal).
    #[cfg(any(test, feature = "dev-license"))]
    pub fn with_dev(dev_spki_b64: &str, what: &str) -> Result<LicenseKeys, String> {
        Ok(LicenseKeys { dev: Some(ed25519_spki(js_trim(dev_spki_b64), what)?), ..LicenseKeys::publisher_only()? })
    }

    /// The development public key alone, no publisher key (I15): the test binaries (`lucid-relay-seatclock-check`)
    /// load `remote-spoke/test/vectors/license-dev-pub.pem` (a PEM `PUBLIC KEY` block), so every publisher-signed
    /// license is refused (NOT_DEV_SIGNED).
    #[cfg(any(test, feature = "dev-license", feature = "live-check-clock"))]
    pub fn development_only(dev_pub_pem: &str) -> Result<LicenseKeys, String> {
        let blocks = crate::meet_x509::pem_blocks(dev_pub_pem.as_bytes(), "PUBLIC KEY");
        match blocks.as_slice() {
            [(_, der)] => match parse_spki(der) {
                Some(PublicKey::Ed25519(k)) => Ok(LicenseKeys { publisher: None, dev: Some(k) }),
                _ => Err("the development public key must be an Ed25519 public key (PEM)".into()),
            },
            _ => Err("the development public key file must hold exactly one PUBLIC KEY block".into()),
        }
    }

    #[cfg(any(test, feature = "dev-license", feature = "live-check-clock"))]
    fn dev_key(&self) -> Option<&Ed25519Key> {
        self.dev.as_ref()
    }

    #[cfg(not(any(test, feature = "dev-license", feature = "live-check-clock")))]
    fn dev_key(&self) -> Option<&Ed25519Key> {
        None
    }
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

/// The keys this build verifies with. A production build: the publisher key alone, and `env` is never read (neither
/// variable name is in the binary). A `dev-license` build: plus the development key when LUCID_LICENSE_DEV=1 AND
/// LUCID_LICENSE_DEV_PUB are both set.
#[cfg(not(feature = "dev-license"))]
pub fn license_keys(_env: impl Fn(&str) -> Option<String>) -> Result<LicenseKeys, String> {
    LicenseKeys::publisher_only()
}

/// The keys this build verifies with. A production build: the publisher key alone, and `env` is never read (neither
/// variable name is in the binary). A `dev-license` build: plus the development key when LUCID_LICENSE_DEV=1 AND
/// LUCID_LICENSE_DEV_PUB are both set.
#[cfg(feature = "dev-license")]
pub fn license_keys(env: impl Fn(&str) -> Option<String>) -> Result<LicenseKeys, String> {
    let flag = env("LUCID_LICENSE_DEV").filter(|v| !v.is_empty()).unwrap_or_else(|| "0".into());
    if flag != "0" && flag != "1" {
        return Err("LUCID_LICENSE_DEV must be 1 (accept the development license key) or unset".into());
    }
    if flag != "1" {
        return LicenseKeys::publisher_only();
    }
    let public = env("LUCID_LICENSE_DEV_PUB").unwrap_or_default();
    if public.is_empty() {
        return Err("LUCID_LICENSE_DEV=1 needs LUCID_LICENSE_DEV_PUB (the development key's SPKI, base64; `license dev-key` prints it)".into());
    }
    LicenseKeys::with_dev(&public, "LUCID_LICENSE_DEV_PUB")
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

/// A license's product (AC-1 2.4): which of the two `features` arrays it carries.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Product {
    /// `["relay", "spokes"]`, root `n_...`: `lucid-relay`.
    Spokes,
    /// `["meet"]`, root `m_...`: `lucid-relay meet`.
    Meet,
}

impl Product {
    /// The console API's word: "spokes" or "meet".
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Spokes => "spokes",
            Self::Meet => "meet",
        }
    }

    /// The product's name in words: "Remote Spokes" or "Meeting Hub".
    pub fn name(self) -> &'static str {
        match self {
            Self::Spokes => "Remote Spokes",
            Self::Meet => "Meeting Hub",
        }
    }

    /// The product a `features` value names: exactly `relay` and `spokes` (any order) or exactly `meet`, no repeats.
    fn of_features(features: Option<&Value>) -> Option<Product> {
        let f = features?.as_array()?;
        let names: Vec<&str> = f.iter().map(Value::as_str).collect::<Option<_>>()?;
        if names.len() == SPOKES_FEATURES.len() && SPOKES_FEATURES.iter().all(|x| names.contains(x)) {
            return Some(Self::Spokes);
        }
        (names == MEET_FEATURES).then_some(Self::Meet)
    }
}

impl License {
    /// When the license's grace ends (seconds): exp plus graceDays.
    pub fn grace_end(&self) -> i64 {
        self.exp + self.grace_days * DAY_SEC
    }

    /// The license's product. A verified license's root has its product's form (`m_` for Meeting Hub, `n_` for Remote
    /// Spokes), so the root says it.
    pub fn product(&self) -> Product {
        if self.root.starts_with("m_") {
            Product::Meet
        } else {
            Product::Spokes
        }
    }
}

/// /^m_[0-9a-f]{32}$/: a Meet root id.
fn is_meet_root_id(s: &str) -> bool {
    s.len() == 34 && s.starts_with("m_") && s[2..].bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

/// The Meet root id of a certificate's SubjectPublicKeyInfo (DER): `m_` and the first 32 hex of its SHA-256.
pub fn meet_root_id(spki_der: &[u8]) -> String {
    let mut id = crate::codec::sha256_hex(spki_der);
    id.truncate(32);
    format!("m_{id}")
}

/// The Meet root ids of every self-signed certificate (its issuer is its subject and its own key verifies its
/// signature) in a `client_ca` file's PEM text, in file order, each once. A license fits any of them (AC-1 decision
/// 21), so a root rollover with two roots in `client_ca` keeps it valid.
pub fn meet_roots(client_ca_pem: &[u8]) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    for (_, der) in crate::meet_x509::pem_blocks(client_ca_pem, "CERTIFICATE") {
        let Some(cert) = crate::meet_x509::Cert::from_der(&der) else { continue };
        if cert.issued_by(&cert) {
            let id = meet_root_id(&cert.spki);
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
    }
    ids
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
    // The root's form follows the product; with no product yet (bad features) either form passes here and the
    // features check below names the problem.
    let product = Product::of_features(p.get("features"));
    let root = str_of(p.get("root"));
    if product == Some(Product::Meet) {
        if !root.is_some_and(is_meet_root_id) {
            return Some("root must be a Meet root id (m_...)".into());
        }
    } else if !root.is_some_and(|r| is_node_id(r) || (product.is_none() && is_meet_root_id(r))) {
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
    if product.is_none() {
        return Some(format!("features must be {} (Remote Spokes) or {} (Meeting Hub)", SPOKES_FEATURES.join(" and "), MEET_FEATURES.join(" and ")));
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

/// Verify a Remote Spokes license token for a relay that trusts org root `root` (`lucid-relay`, the hub plugin, `root
/// approve`): a Meeting Hub license is refused ("this license is for Meeting Hub, not Remote Spokes").
pub fn verify_license(token: &str, root: &str, keys: &LicenseKeys, now: i64) -> Result<LicenseCheck, String> {
    verify_license_for(token, Product::Spokes, &[root], keys, now)
}

/// Verify a Meeting Hub license token for a Meet relay whose `client_ca` holds the self-signed roots `meet_roots`
/// (meet_roots): any of them fits; none refuses every Meeting Hub license (NO_MEET_ROOT). A Remote Spokes license is
/// refused ("this license is for Remote Spokes, not Meeting Hub").
pub fn verify_meet_license<R: AsRef<str>>(token: &str, meet_roots: &[R], keys: &LicenseKeys, now: i64) -> Result<LicenseCheck, String> {
    verify_license_for(token, Product::Meet, meet_roots, keys, now)
}

/// Verify a license token for a relay process of `product` that trusts `roots` (Remote Spokes: its one org root id;
/// Meeting Hub: the ids of every self-signed certificate in `client_ca`): the signature (publisher first), the shape,
/// the product, the root, and not issued in the future. Expiry is not a refusal here: license_state says valid, grace
/// or expired.
pub fn verify_license_for<R: AsRef<str>>(token: &str, product: Product, roots: &[R], keys: &LicenseKeys, now: i64) -> Result<LicenseCheck, String> {
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
    let dev = if keys.publisher.as_ref().is_some_and(|k| ed25519_verify(k, &body, &sig)) {
        false
    } else if keys.dev_key().is_some_and(|k| ed25519_verify(k, &body, &sig)) {
        true
    } else if keys.publisher.is_none() {
        return Err(NOT_DEV_SIGNED.into());
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
    let got = license.product();
    if got != product {
        return Err(format!("this license is for {}, not {}", got.name(), product.name()));
    }
    if product == Product::Meet && roots.is_empty() {
        return Err(NO_MEET_ROOT.into());
    }
    if !roots.iter().any(|r| <R as AsRef<str>>::as_ref(r) == license.root) {
        let trusted: Vec<&str> = roots.iter().map(<R as AsRef<str>>::as_ref).collect();
        return Err(format!("license is for another root ({}, this relay trusts {})", license.root, trusted.join(" or ")));
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
    let grace_ends = l.grace_end();
    if now < grace_ends {
        return (LicenseStateName::Grace, ceil_days(grace_ends - now));
    }
    (LicenseStateName::Expired, 0)
}

/// AC-1 2.4 revision 4: what the Meeting Hub service gate and seats read from the license in force (no new token
/// field). `state` None means no fitting license (none, wrong product or wrong root: the caller keeps the refused
/// token's reason); `grace_end` is in seconds.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct LicenseStanding {
    pub state: Option<LicenseStateName>,
    pub grace_end: Option<i64>,
    pub users: i64,
}

impl LicenseStanding {
    /// "valid", "grace", "expired" or "none".
    pub fn state_str(&self) -> &'static str {
        self.state.map_or("none", LicenseStateName::as_str)
    }
}

/// The standing of `l` (the license in force, None with none) at `now` (seconds): license.ts licenseStanding.
pub fn license_standing(l: Option<&License>, now: i64) -> LicenseStanding {
    match l {
        None => LicenseStanding { state: None, grace_end: None, users: 0 },
        Some(l) => LicenseStanding { state: Some(license_state(l, now).0), grace_end: Some(l.grace_end()), users: l.users },
    }
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
        // Any well-formed Ed25519 SPKI serves to show which keys are held; the baked one is at hand.
        let dev_pub = LICENSE_PUBLISHER_SPKI;
        #[cfg(feature = "dev-license")]
        {
            assert!(license_keys(env(&[("LUCID_LICENSE_DEV", "1")])).err().unwrap().contains("needs LUCID_LICENSE_DEV_PUB"));
            assert!(license_keys(env(&[("LUCID_LICENSE_DEV", "yes")])).err().unwrap().contains("must be 1"));
            assert!(license_keys(env(&[("LUCID_LICENSE_DEV", "1"), ("LUCID_LICENSE_DEV_PUB", "AAAA")])).err().unwrap().contains("Ed25519"));
            assert!(license_keys(move |k| (k == "LUCID_LICENSE_DEV").then(|| "1".into()).or_else(|| (k == "LUCID_LICENSE_DEV_PUB").then(|| dev_pub.into()))).unwrap().dev.is_some());
            assert_eq!(dev_license_notice(), Some("This build accepts development licenses. Not for production."));
        }
        // R4-H1: a production build ignores LUCID_LICENSE_DEV and LUCID_LICENSE_DEV_PUB entirely (even malformed).
        #[cfg(not(feature = "dev-license"))]
        {
            for vals in [&[("LUCID_LICENSE_DEV", "1")][..], &[("LUCID_LICENSE_DEV", "yes")], &[("LUCID_LICENSE_DEV", "1"), ("LUCID_LICENSE_DEV_PUB", "AAAA")]] {
                let keys = license_keys(env(vals)).unwrap();
                assert!(keys.dev.is_none() && keys.publisher.is_some());
            }
            assert!(license_keys(move |k| (k == "LUCID_LICENSE_DEV").then(|| "1".into()).or_else(|| (k == "LUCID_LICENSE_DEV_PUB").then(|| dev_pub.into()))).unwrap().dev.is_none());
            assert_eq!(dev_license_notice(), None);
        }
        assert!(LicenseKeys::with_dev(dev_pub, "the test key").unwrap().dev.is_some());
        assert!(LicenseKeys::with_dev("AAAA", "the test key").err().unwrap().contains("Ed25519"));
        assert!(is_org("Acme Robotics"));
        assert!(!is_org(" Acme"));
        assert!(!is_org("Acme\u{7}"));
    }

    /// AC-1 2.4: the two `features` arrays, the product words, and the Meet root id's form.
    #[test]
    fn products_and_meet_root_ids() {
        assert_eq!(Product::of_features(Some(&json!(["relay", "spokes"]))), Some(Product::Spokes));
        assert_eq!(Product::of_features(Some(&json!(["spokes", "relay"]))), Some(Product::Spokes));
        assert_eq!(Product::of_features(Some(&json!(["meet"]))), Some(Product::Meet));
        for bad in [json!(["meet", "spokes"]), json!(["meet", "meet"]), json!([]), json!(["relay", "relay"]), json!(["relay", "spokes", "meet"]), json!([1]), json!("meet")] {
            assert_eq!(Product::of_features(Some(&bad)), None, "{bad}");
        }
        assert_eq!(Product::of_features(None), None);
        assert_eq!((Product::Spokes.as_str(), Product::Meet.as_str()), ("spokes", "meet"));
        assert_eq!((Product::Spokes.name(), Product::Meet.name()), ("Remote Spokes", "Meeting Hub"));
        let id = meet_root_id(b"spki");
        assert!(is_meet_root_id(&id), "{id}");
        assert!(!is_meet_root_id(&format!("n_{}", &id[2..])));
        assert!(meet_roots(b"no certificate here").is_empty());
        let l = |root: &str| License { id: String::new(), org: String::new(), root: root.into(), edition: "standard".into(), users: 1, relays: 1, exp: 0, grace_days: 14 };
        assert_eq!((l(&format!("n_{}", "0".repeat(32))).product(), l(&id).product()), (Product::Spokes, Product::Meet));
    }

    /// AC-1 2.4, without the vectors: tokens signed here by a test Ed25519 key, judged by each product's verifier.
    #[test]
    fn each_product_only_on_its_own_relay() {
        use aws_lc_rs::signature::{Ed25519KeyPair, KeyPair};
        use crate::codec::{b64u, stringify};
        let pair = Ed25519KeyPair::from_seed_unchecked(&[9u8; 32]).unwrap();
        let mut spki = vec![0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00];
        spki.extend_from_slice(pair.public_key().as_ref());
        let Some(PublicKey::Ed25519(dev)) = parse_spki(&spki) else { panic!("the test key is Ed25519") };
        let keys = LicenseKeys { publisher: Some(ed25519_spki(LICENSE_PUBLISHER_SPKI, "the publisher key").unwrap()), dev: Some(dev) };
        let now = 1_800_000_000;
        let (org_root, root_a, root_b) = (format!("n_{}", "1".repeat(32)), format!("m_{}", "a".repeat(32)), format!("m_{}", "b".repeat(32)));
        let token = |edit: &dyn Fn(&mut Value)| {
            let mut p = json!({
                "v": 2, "typ": LICENSE_TYP, "id": "l_00000000000000b1", "org": "Acme Robotics", "root": root_a, "edition": "standard", "users": 5,
                "relays": 1, "features": ["meet"], "iat": now - 60, "exp": now + 30 * DAY_SEC,
            });
            edit(&mut p);
            let body = stringify(&p);
            format!("{}.{}", b64u(body.as_bytes()), b64u(pair.sign(body.as_bytes()).as_ref()))
        };
        let set = |key: &'static str, v: Value| move |p: &mut Value| p[key] = v.clone();
        let err = |r: Result<LicenseCheck, String>| r.err().unwrap_or_default();
        let meet = token(&|_: &mut Value| {});
        let spokes = token(&|p: &mut Value| {
            p["root"] = json!(org_root);
            p["features"] = json!(["relay", "spokes"]);
        });
        let roots = [root_a.clone(), root_b.clone()];

        assert_eq!(err(verify_license(&meet, &org_root, &keys, now)), "this license is for Meeting Hub, not Remote Spokes");
        assert_eq!(err(verify_meet_license(&spokes, &roots, &keys, now)), "this license is for Remote Spokes, not Meeting Hub");
        assert_eq!(err(verify_meet_license(&meet, &[] as &[&str], &keys, now)), NO_MEET_ROOT);
        let one = verify_meet_license(&meet, &roots[..1], &keys, now).expect("root A fits a client_ca with root A");
        assert_eq!((one.license.product(), one.license.root.as_str(), one.dev), (Product::Meet, root_a.as_str(), true));
        assert!(verify_meet_license(&meet, &roots, &keys, now).is_ok(), "either of two roots fits");
        assert_eq!(err(verify_meet_license(&meet, &roots[1..], &keys, now)), format!("license is for another root ({root_a}, this relay trusts {root_b})"));
        assert_eq!(verify_license(&spokes, &org_root, &keys, now).map(|c| c.license.product()).ok(), Some(Product::Spokes));
        assert_eq!(verify_license_for(&meet, Product::Meet, &roots, &keys, now).map(|c| c.license.id).ok(), Some("l_00000000000000b1".to_owned()));
        let features = "malformed license: features must be relay and spokes (Remote Spokes) or meet (Meeting Hub)";
        for bad in [json!(["meet", "spokes"]), json!(["meet", "meet"]), json!([])] {
            let t = token(&set("features", bad.clone()));
            assert_eq!(err(verify_meet_license(&t, &roots, &keys, now)), features, "{bad}");
            assert_eq!(err(verify_license(&t, &org_root, &keys, now)), features, "{bad}");
        }
        assert_eq!(err(verify_meet_license(&token(&set("root", json!(org_root))), &roots, &keys, now)), "malformed license: root must be a Meet root id (m_...)");
        assert_eq!(
            err(verify_license(&token(&set("features", json!(["relay", "spokes"]))), &org_root, &keys, now)),
            "malformed license: root must be an org root node id (n_...)"
        );
        assert_eq!(err(verify_meet_license(&token(&set("iat", json!(now + 3600))), &roots, &keys, now)), "license is not valid yet");
    }

    /// AC-1 I1: the license product vectors the add-on writes (remote-spoke/scripts/license-products-vectors.ts, which
    /// also writes this crate's copy) get the same verdicts here: Remote Spokes, and a Meet relay whose client_ca holds
    /// zero, one and two self-signed roots.
    #[test]
    fn license_products_get_the_same_verdicts() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/license-v2-products.json");
        let text = std::fs::read_to_string(path)
            .unwrap_or_else(|e| panic!("{path}: {e}; write it with `bun scripts/license-products-vectors.ts {path}` from the add-on's remote-spoke folder"));
        let v = parse_json(&text).expect("license-v2-products.json is JSON");
        let now = v["now"].as_i64().unwrap();
        let dev_pub = v["devPub"].as_str().unwrap().to_owned();
        // The verdicts of a verifier that holds the development key (a dev-license build, as the add-on judges with
        // LUCID_LICENSE_DEV=1); `production` and `developmentOnly` below hold the other two key sets.
        let keys = LicenseKeys::with_dev(&dev_pub, "devPub").unwrap_or_else(|e| panic!("{e}"));
        let verdict = |r: Result<LicenseCheck, String>| match r {
            Ok(ok) => {
                let (state, days_left) = license_state(&ok.license, now);
                let product = ok.license.product().as_str();
                let l = ok.license;
                json!({
                    "ok": true, "dev": ok.dev, "product": product, "id": l.id, "root": l.root, "edition": l.edition, "users": l.users,
                    "relays": l.relays, "exp": l.exp, "graceDays": l.grace_days, "state": state.as_str(), "daysLeft": days_left,
                })
            }
            Err(reason) => json!({ "ok": false, "reason": reason }),
        };
        for c in v["meetRootCerts"].as_array().unwrap() {
            assert_eq!(meet_roots(c["pem"].as_str().unwrap().as_bytes()), [c["id"].as_str().unwrap()], "root certificate {}", c["name"]);
        }
        let cas: Vec<(&str, Vec<String>)> = v["clientCas"]
            .as_array()
            .unwrap()
            .iter()
            .map(|ca| {
                let roots = meet_roots(ca["pem"].as_str().unwrap().as_bytes());
                let want: Vec<&str> = ca["roots"].as_array().unwrap().iter().map(|r| r.as_str().unwrap()).collect();
                assert_eq!(roots, want, "client_ca {}", ca["name"]);
                (ca["name"].as_str().unwrap(), roots)
            })
            .collect();
        assert_eq!(cas.iter().map(|(_, r)| r.len()).collect::<Vec<_>>(), [0, 1, 2]);
        let spokes_root = v["spokesRoot"].as_str().unwrap();
        let production = LicenseKeys::publisher_only().unwrap();
        let dev_only = LicenseKeys::development_only(v["devPubPem"].as_str().unwrap()).unwrap_or_else(|e| panic!("{e}"));
        let from_env = license_keys(|k| match k {
            "LUCID_LICENSE_DEV" => Some("1".into()),
            "LUCID_LICENSE_DEV_PUB" => Some(dev_pub.clone()),
            _ => None,
        })
        .unwrap_or_else(|e| panic!("{e}"));
        let mut seen = std::collections::BTreeSet::new();
        for c in v["cases"].as_array().unwrap() {
            let token = c["token"].as_str().unwrap();
            assert_eq!(verdict(verify_license(token, spokes_root, &keys, now)), c["spokes"], "Remote Spokes verifier: {}", c["name"]);
            for (name, roots) in &cas {
                assert_eq!(verdict(verify_meet_license(token, roots.as_slice(), &keys, now)), c["meet"][*name], "Meet relay, client_ca {name}: {}", c["name"]);
            }
            // Revision 4: what the Meet gate and seats read with this token installed beside a client_ca holding root A.
            let root_a = [v["meetRootCerts"][0]["id"].as_str().unwrap()];
            let installed = verify_meet_license(token, &root_a, &keys, now).ok().map(|c| c.license);
            let s = license_standing(installed.as_ref(), now);
            assert_eq!(json!({ "state": s.state_str(), "graceEnd": s.grace_end, "users": s.users }), c["meetStanding"], "Meet standing: {}", c["name"]);
            seen.insert(s.state_str());
            // R4-H1, one direction: a production build (publisher key alone) refuses every development-key license,
            // and it does so even with LUCID_LICENSE_DEV=1 and LUCID_LICENSE_DEV_PUB set (it never reads them).
            let both = |k: &LicenseKeys| json!({ "spokes": verdict(verify_license(token, spokes_root, k, now)), "meet": verdict(verify_meet_license(token, cas[2].1.as_slice(), k, now)) });
            assert_eq!(both(&production), c["production"], "production build: {}", c["name"]);
            #[cfg(not(feature = "dev-license"))]
            assert_eq!(both(&from_env), c["production"], "production build with the development variables set: {}", c["name"]);
            #[cfg(feature = "dev-license")]
            assert_eq!(both(&from_env), json!({ "spokes": c["spokes"], "meet": c["meet"]["two"] }), "dev-license build: {}", c["name"]);
            // The other direction's verifier: the development key alone (the test binaries).
            assert_eq!(both(&dev_only), c["developmentOnly"], "development key alone: {}", c["name"]);
        }
        assert_eq!(seen, ["valid", "grace", "expired", "none"].into_iter().collect::<std::collections::BTreeSet<&str>>(), "the vectors hold every standing the gate reads");
        // R4-H1, the other direction: every publisher Standard and Enterprise license of both products is refused by
        // the development key alone, and (when the publisher signed the vectors) accepted by a production build.
        let pubs = v["publisherCases"].as_array().unwrap();
        let mut kinds = std::collections::BTreeSet::new();
        for c in pubs {
            let token = c["token"].as_str().unwrap();
            let (product, edition) = (c["product"].as_str().unwrap(), c["edition"].as_str().unwrap());
            kinds.insert((product, edition));
            let (p, root) = if product == "meet" { (Product::Meet, cas[2].1[0].as_str()) } else { (Product::Spokes, spokes_root) };
            assert_eq!(verdict(verify_license_for(token, p, &[root], &dev_only, now)), json!({ "ok": false, "reason": NOT_DEV_SIGNED }), "development key alone, publisher case {}", c["name"]);
            assert_eq!(verdict(verify_license_for(token, p, &[root], &dev_only, now)), c["developmentOnly"], "publisher case {}", c["name"]);
            if c["signer"] == "publisher" {
                let ok = verify_license_for(token, p, &[root], &production, now);
                assert!(ok.is_ok_and(|ok| !ok.dev), "production build accepts publisher case {}", c["name"]);
            }
        }
        assert_eq!(kinds.len(), 4, "a publisher Standard and Enterprise license of both products");
    }

    /// R4-H1: `dev-license` with the release profile does not compile (the compile_error! guard). Runs `cargo check`
    /// in a target folder of its own, so it takes the time of a release check of every dependency.
    #[test]
    fn dev_license_with_the_release_profile_does_not_compile() {
        let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
        let manifest = concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.toml");
        let target = concat!(env!("CARGO_MANIFEST_DIR"), "/target/dev-license-guard");
        let out = std::process::Command::new(cargo)
            .args(["check", "--release", "--features", "dev-license", "--bins", "--manifest-path", manifest, "--target-dir", target])
            .output()
            .expect("cargo runs");
        let err = String::from_utf8_lossy(&out.stderr);
        assert!(!out.status.success(), "a release dev-license build compiled");
        assert!(err.contains("the dev-license feature accepts development licenses"), "{err}");
    }

    /// Revision 4: the state, grace end and `users` the Meet gate and seats read, for valid, grace, expired and none.
    #[test]
    fn license_standing_for_valid_grace_expired_and_none() {
        let l = License { id: String::new(), org: String::new(), root: String::new(), edition: "standard".into(), users: 7, relays: 1, exp: 1_800_000_000, grace_days: 14 };
        let end = l.exp + 14 * DAY_SEC;
        assert_eq!(l.grace_end(), end);
        let at = |now| license_standing(Some(&l), now);
        assert_eq!(at(l.exp - 1), LicenseStanding { state: Some(LicenseStateName::Valid), grace_end: Some(end), users: 7 });
        assert_eq!(at(l.exp), LicenseStanding { state: Some(LicenseStateName::Grace), grace_end: Some(end), users: 7 });
        assert_eq!(at(end - 1).state_str(), "grace");
        assert_eq!(at(end), LicenseStanding { state: Some(LicenseStateName::Expired), grace_end: Some(end), users: 7 });
        let none = license_standing(None, l.exp);
        assert_eq!((none, none.state_str()), (LicenseStanding { state: None, grace_end: None, users: 0 }, "none"));
    }
}
