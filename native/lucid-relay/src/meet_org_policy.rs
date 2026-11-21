// Phase C (ADR-0540): relay/meet_org_policy.py (contract PC-1, "Org policy") as the relay needs it: CE-1
// canonical JSON, the signed bytes and hash of an org policy, the root-signed signer policy's version 2 terms, every
// field rule and limit of an org policy, its verification (root or the signer's intermediate, the root's CRL) and
// the relay's store of signed policies. The same bytes and the same words as the Python module; the issuer-side
// signing helpers and the SSO byte layouts stay in Python (the relay never signs).
//
// SD-1 slice SD-1b (docs/storage/contract.md 6.2, 13.5): the `storage` key (`check_storage`, as a device checks
// it), `sharing` refused, the older-client gate (`storage_gate`), and the org storage map (`check_storage_map`,
// `verify_storage_map` over `lp("lucid-meet-org-storage-v1", canonical JSON)`, wire `{map, sig, chain}`) with the
// relay's `MapStore`. This relay's signer terms stop at version 2, so the registry cloud check of `storage.cloud`
// (ID-1 1.5) has no Entra provider to compare with here; the signer and devices apply it.

use indexmap::IndexMap;
use serde_json::{Map, Value};
use std::collections::HashSet;

use crate::codec::sha256_hex;
use crate::meet_json as pj;
use crate::meet_x509::{ecdsa_sha256_verified, Cert, Crl};

pub type Obj = Map<String, Value>;

const SIG_LABEL: &str = "lucid-meet-org-policy-v1";
const MAX_INT: i64 = (1 << 53) - 1;
const LABEL_MAX: usize = 64;
const DOMAINS_MAX: usize = 20;
const PRINCIPALS_MAX: usize = 200;
const APPS_MAX: usize = 100;
const COMMANDS_MAX: usize = 50;
const CROSS_ORG_MAX: usize = 64;
const LIFE_MAX: i64 = 90 * 86400; // expires - issued
const SKEW: i64 = 300; // a policy dated this far in the future is still taken
const SIGNED_MAX: usize = 64 * 1024; // the whole signed object
pub const RELAY_MAX: usize = 64; // org policies one relay holds
const RETENTION_KINDS: &[&str] = &["dm", "group", "channel", "files", "canvas", "ai"];
const RETENTION_MAX: i64 = 3650;
const APP_TYPES: &[&str] = &["bot", "webhook", "workflows", "ai"];
const SCOPES: &[&str] = &["mentions", "all"];
const EXTERNAL_ARCHIVES: &[&str] = &["allow", "refuse"];
const APPS_PREFIX: &str = "apps.";
const TOP_KEYS: &[&str] = &[
    "v", "org", "label", "domains", "seq", "issued", "expires", "admins", "archive", "archive_reviewers", "apps",
    "workflows", "external_archives", "external_apps", "retention", "notify", "video", "ai", "storage", "sharing",
];
/// BG-1 section 2.1: the camera background of the people the policy covers.
const VIDEO_KEYS: &[&str] = &["background", "team_image", "change"];
const VIDEO_BACKGROUNDS: &[&str] = &["none", "blur", "team"];
const VIDEO_CHANGES: &[&str] = &["allow", "refuse"];
// SD-1 6.2 and 13.5 (exact words and limits of relay/meet_org_policy.py)
const STORAGE_PROVIDERS: &[&str] = &["onedrive", "sharepoint", "gdrive", "dropbox", "s3", "relay_share", "local", "synced_folder"];
const STORAGE_KINDS: &[&str] = &["recording", "audio", "transcript", "notes", "attendance", "chat_file", "canvas", "slides", "export"];
/// Built-in place ids (no map entry) and the provider each one is (the same names).
const STORAGE_BUILTINS: &[&str] = &["onedrive", "gdrive", "dropbox", "local", "synced_folder"];
const STORAGE_KEYS: &[&str] =
    &["providers", "labels", "own", "group", "people_choose", "form", "keep_local_days", "expire_days", "cloud", "map_sha256"];
const STORAGE_FORMS: &[&str] = &["sealed", "plain"];
const STORAGE_DAYS_MAX: i64 = 3650;
const ENTRA_CLOUDS: &[&str] = &["global", "usgov-high", "usgov-dod"];
const PLACE_LABEL_MAX: usize = 64;
const PLACE_LABEL_MARKS: &str = " .,()&'-";
pub const SHARING_REFUSED: &str = "sharing rules are not available on this relay yet";
/// The SD-1b release of the Hub and the iPhone (older ones refuse the whole policy for its unknown top key).
const STORAGE_CLIENTS: [(&str, &str); 2] = [("hub", "0.98.0"), ("ios", "0.98.0")];
pub const STORAGE_TOO_SOON: &str =
    "Storage rules need every Meeting Hub and iPhone app at 0.98.0 or later. Raise the relay's minimum app versions first.";
const MAP_LABEL: &str = "lucid-meet-org-storage-v1";
/// The whole signed map.
const MAP_MAX: usize = 256 * 1024;
const MAP_KEYS: &[&str] = &["v", "org", "seq", "issued", "microsoft", "places"];
const MAP_REQUIRED: &[&str] = &["v", "org", "seq", "issued", "places"];
const MAP_WIRE_KEYS: &[&str] = &["map", "sig", "chain"];
const MAP_PLACES_MAX: usize = 64;
/// `channels` and `groups` of one place.
const MAP_ENTRIES_MAX: usize = 2000;
const MAP_TEXT_MAX: usize = 256;
/// `kms_key`.
const MAP_KEY_MAX: usize = 2048;
/// Orgs whose maps one relay holds.
pub const MAP_ORGS_MAX: usize = 64;
const MAP_PROVIDERS: &[&str] = &["sharepoint", "gdrive", "dropbox", "s3", "relay_share"];
const CONNECTOR_KEYS: &[&str] = &["url", "principal", "device"];
const SITE_KEYS: &[&str] = &["site", "drive", "folder"];
const TEAM_KEYS: &[&str] = &["team", "channel"];
const S3_SSE: &[&str] = &["s3", "kms", "none"];
pub const CONNECTORS_REFUSED: &str = "storage connectors are not available on this relay yet";
/// Personal Microsoft accounts.
const PERSONAL_TENANT: &str = "9188040d-6c67-4c5b-b112-36a304b66dad";
/// NT-1 section 3.9: the only `notify` the policy may carry.
const NOTIFY_SHAPE: &str = "notify must be {\"previews\": \"off\"}";
const REQUIRED: &[&str] = &["v", "org", "label", "domains", "seq", "issued", "expires"];
const ARCHIVE_KEYS: &[&str] = &["principal", "device", "host", "since"];
const APP_KEYS: &[&str] =
    &["principal", "device", "name", "type", "scope", "host", "description", "icon_sha256", "commands", "cross_org"];
const APP_REQUIRED: &[&str] = &["principal", "device", "name", "type", "scope", "host"];
const COMMAND_KEYS: &[&str] = &["name", "description", "usage"];
const WIRE_KEYS: &[&str] = &["policy", "sig", "chain"];
const SSO_SERVICE_KEYS: &[&str] = &["serial", "orgs", "domains"];

// Words (contract PC-1, exact).
pub const DOMAIN_REFUSED: &str = "that domain is not assigned to this organization";
const ONLY_JSON: &str = "only objects, arrays, strings, integers and booleans (no null)";

/// Refused: Python's Refused (and its RolledBack, TwoVersions), a 403. Bad: a ValueError, a 400.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PolicyError {
    Refused(String),
    Bad(String),
}

impl std::fmt::Display for PolicyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PolicyError::Refused(m) | PolicyError::Bad(m) => f.write_str(m),
        }
    }
}

impl From<String> for PolicyError {
    fn from(m: String) -> Self {
        PolicyError::Bad(m)
    }
}

impl From<&str> for PolicyError {
    fn from(m: &str) -> Self {
        PolicyError::Bad(m.to_string())
    }
}

fn bad(m: &str) -> PolicyError {
    PolicyError::Bad(m.to_string())
}

fn refused(m: &str) -> PolicyError {
    PolicyError::Refused(m.to_string())
}

type Res<T> = Result<T, String>;

// ---- byte encodings (CE-1, exact) -----------------------------------------------------------------------------

fn enc_str(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
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

fn enc_obj(o: &Obj, out: &mut String) -> Res<()> {
    let mut pairs: Vec<(&String, &Value)> = o.iter().collect();
    pairs.sort_by(|a, b| a.0.cmp(b.0));
    out.push('{');
    for (i, (k, v)) in pairs.into_iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        enc_str(k, out);
        out.push(':');
        enc(v, out)?;
    }
    out.push('}');
    Ok(())
}

fn enc(value: &Value, out: &mut String) -> Res<()> {
    match value {
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => {
            let i = match n.as_i64() {
                Some(i) => i,
                None if n.is_u64() => return Err("an integer is out of range".into()),
                None => return Err(ONLY_JSON.into()),
            };
            if !(-MAX_INT..=MAX_INT).contains(&i) {
                return Err("an integer is out of range".into());
            }
            out.push_str(&i.to_string());
        }
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
        Value::Object(o) => enc_obj(o, out)?,
        Value::Null => return Err(ONLY_JSON.into()),
    }
    Ok(())
}

/// CE-1 canonical JSON: keys sorted by UTF-8 bytes, no floats, no null, integers within 2**53 - 1.
pub fn canonical_json(v: &Value) -> Result<Vec<u8>, String> {
    let mut out = String::new();
    enc(v, &mut out)?;
    Ok(out.into_bytes())
}

/// Length-prefixed fields: 4-byte big-endian length, then the bytes.
pub fn lp(fields: &[&[u8]]) -> Vec<u8> {
    let mut out = Vec::new();
    for f in fields {
        out.extend_from_slice(&(f.len() as u32).to_be_bytes());
        out.extend_from_slice(f);
    }
    out
}

/// `lp("lucid-meet-org-policy-v1", canonical JSON of the policy)`. A policy canonical JSON refuses (a null or a
/// float) gives the label and empty JSON: every caller checks the policy first.
pub fn signed_bytes(policy: &Obj) -> Vec<u8> {
    let mut out = String::new();
    let json = match enc_obj(policy, &mut out) {
        Ok(()) => out.into_bytes(),
        Err(_) => Vec::new(),
    };
    lp(&[SIG_LABEL.as_bytes(), &json])
}

/// Hex SHA-256 of the signed bytes (`verify` computes it from the bytes it already holds).
#[cfg(test)]
pub fn policy_hash(policy: &Obj) -> String {
    sha256_hex(&signed_bytes(policy))
}

// ---- names ----------------------------------------------------------------------------------------------------

/// What Python's `re.match(r"^...$")` sees: `$` also matches before one trailing newline.
fn re_core(s: &str) -> &str {
    s.strip_suffix('\n').unwrap_or(s)
}

/// ORG_RE and NAME_RE: `^[a-z0-9-]{1,32}$`.
fn slug_ok(s: &str) -> bool {
    let c = re_core(s);
    (1..=32).contains(&c.len()) && c.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn hex_ok(s: &str, low: usize, high: usize) -> bool {
    let c = re_core(s);
    (low..=high).contains(&c.len()) && c.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// LABEL_RE: `^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`.
fn label_ok(s: &str) -> bool {
    let c = re_core(s).as_bytes();
    let alnum = |b: &u8| b.is_ascii_lowercase() || b.is_ascii_digit();
    match c {
        [] => false,
        [one] => alnum(one),
        [first, mid @ .., last] => {
            c.len() <= 63 && alnum(first) && alnum(last) && mid.iter().all(|b| alnum(b) || *b == b'-')
        }
    }
}

/// LOCAL_RE: `^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}$`.
fn local_ok(s: &str) -> bool {
    let c = re_core(s);
    (1..=64).contains(&c.len())
        && c.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b".!#$%&'*+/=?^_`{|}~-".contains(&b))
}

/// A lower-case DNS name with at least two labels.
pub fn is_domain(name: &str) -> bool {
    name.chars().count() <= 253 && name.contains('.') && name.split('.').all(label_ok)
}

/// repr() of a str.
fn repr_str(s: &str) -> String {
    let q = if s.contains('\'') && !s.contains('"') { '"' } else { '\'' };
    let mut out = String::from(q);
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c == q => {
                out.push('\\');
                out.push(c);
            }
            c if (c as u32) < 0x20 || c as u32 == 0x7f => out.push_str(&format!("\\x{:02x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push(q);
    out
}

/// repr() of a JSON value.
fn repr(v: &Value) -> String {
    match v {
        Value::String(s) => repr_str(s),
        other => pj::py_str(other),
    }
}

/// `(local, domain)` of a lower-case email principal.
pub fn split_principal(principal: &str) -> Result<(&str, &str), String> {
    let err = || format!("{} is not a lower-case email", repr_str(principal));
    if principal.matches('@').count() != 1 {
        return Err(err());
    }
    let Some((local, domain)) = principal.split_once('@') else { return Err(err()) };
    if !local_ok(local) || !is_domain(domain) {
        return Err(err());
    }
    Ok((local, domain))
}

fn split_value(v: &Value) -> Res<(&str, &str)> {
    match v {
        Value::String(s) => split_principal(s),
        other => Err(format!("{} is not a lower-case email", repr(other))),
    }
}

fn text<'a>(v: &'a Value, what: &str, limit: usize) -> Res<&'a str> {
    match v.as_str() {
        Some(s) if !s.is_empty() && pj::printable(s) && (limit == 0 || s.chars().count() <= limit) => Ok(s),
        _ => {
            let more = if limit > 0 { format!(" of at most {limit} characters") } else { String::new() };
            Err(format!("{what} must be printable text{more}"))
        }
    }
}

fn int(v: &Value, what: &str, low: i64, high: i64) -> Res<i64> {
    pj::as_int(Some(v))
        .filter(|n| (low..=high).contains(n))
        .ok_or_else(|| format!("{what} must be a whole number from {low} to {high}"))
}

fn list<'a>(v: &'a Value, what: &str, limit: usize, low: usize) -> Res<&'a [Value]> {
    let Some(a) = v.as_array().filter(|a| (low..=limit).contains(&a.len())) else {
        return Err(format!("{what} must be a list of {low} to {limit} entries"));
    };
    let encoded = a.iter().map(canonical_json).collect::<Res<Vec<_>>>()?;
    if encoded.iter().collect::<HashSet<_>>().len() != a.len() {
        return Err(format!("{what} lists an entry twice"));
    }
    Ok(a)
}

fn keys<'a>(v: &'a Value, allowed: &[&str], required: &[&str], what: &str) -> Res<&'a Obj> {
    let Some(o) = v.as_object() else { return Err(format!("{what} must be an object")) };
    let mut extra: Vec<&str> = o.keys().map(String::as_str).filter(|k| !allowed.contains(k)).collect();
    if !extra.is_empty() {
        extra.sort_unstable();
        return Err(format!("{what} has unknown fields: {}", extra.join(", ")));
    }
    let missing: Vec<&str> = required.iter().copied().filter(|k| !o.contains_key(*k)).collect();
    if !missing.is_empty() {
        return Err(format!("{what} needs {}", missing.join(", ")));
    }
    Ok(o)
}

/// Python's `value == n` (True == 1, 2.0 == 2).
fn py_eq(v: Option<&Value>, n: i64) -> bool {
    match v {
        Some(Value::Number(x)) => match x.as_i64() {
            Some(i) => i == n,
            None => x.as_f64() == Some(n as f64),
        },
        Some(Value::Bool(b)) => i64::from(*b) == n,
        _ => false,
    }
}

/// `int(value or 0)`.
fn int_of(v: Option<&Value>) -> i64 {
    match v {
        Some(Value::Number(n)) => n.as_i64().unwrap_or_else(|| n.as_f64().unwrap_or(0.0) as i64),
        Some(Value::Bool(b)) => i64::from(*b),
        Some(Value::String(s)) if !s.is_empty() => s.trim().parse().unwrap_or(0),
        _ => 0,
    }
}

/// meet_pki.check_device_id: exactly 16 lower-case hex digits (of `str(value or "")`).
fn check_device_id(v: &Value) -> Res<()> {
    if hex_ok(&pj::str_or(Some(v)), 16, 16) {
        Ok(())
    } else {
        Err("a device id is 16 lower-case hex digits".into())
    }
}

// ---- the root-signed signer policy, version 2 -----------------------------------------------------------------

/// What PC-1 reads from the root-signed signer policy (empty for a version 1 policy).
#[derive(Clone, Debug, Default)]
pub struct SignerTerms {
    pub org_domains: IndexMap<String, Vec<String>>,
    pub org_admins: IndexMap<String, Vec<String>>,
    pub intermediate_serial: String,
    /// The signer policy says `enclave` (AI-1 1.2: frontier only through AskSage).
    pub enclave: bool,
    /// `sso_services`: (serial, orgs, domains) of each registered SSO service (AI-1 6.4 binds its posts to them).
    pub sso_services: Vec<(String, Vec<String>, Vec<String>)>,
}

impl SignerTerms {
    /// The org the root assigned `domain` to ("" when none).
    pub fn org_of(&self, domain: &str) -> String {
        self.org_domains.iter().find(|(_, names)| names.iter().any(|n| n == domain)).map(|(o, _)| o.clone()).unwrap_or_default()
    }
}

/// The PC-1 terms of a signer policy (shape only; the caller checks the root's signature). Version 1 gives empty
/// terms. Err (a ValueError) when a version 2 field is wrong.
pub fn signer_terms(policy: &Obj) -> Result<SignerTerms, String> {
    let serial = pj::s(policy, "intermediate_serial").to_lowercase();
    if py_eq(policy.get("v"), 1) {
        return Ok(SignerTerms { intermediate_serial: serial, ..SignerTerms::default() });
    }
    if !py_eq(policy.get("v"), 2) {
        return Err("the signer policy is not version 1 or 2".into());
    }
    let empty_obj = Value::Object(Obj::new());
    let empty_list = Value::Array(Vec::new());
    let raw_domains = policy.get("org_domains").unwrap_or(&empty_obj).as_object().ok_or("org_domains must be an object")?;
    let mut org_domains: IndexMap<String, Vec<String>> = IndexMap::new();
    let mut seen: IndexMap<String, String> = IndexMap::new();
    for (org, names) in raw_domains {
        if !slug_ok(org) {
            return Err(format!("{} is not an organization id", repr_str(org)));
        }
        let mut kept = Vec::new();
        for name in list(names, &format!("org_domains[{org}]"), 1000, 1)? {
            let Some(n) = name.as_str().filter(|n| is_domain(n) && !n.starts_with(APPS_PREFIX)) else {
                return Err(format!("{} cannot be assigned to an organization", repr(name)));
            };
            if let Some(other) = seen.get(n) {
                return Err(format!("{n} is assigned to both {other} and {org}"));
            }
            seen.insert(n.to_string(), org.clone());
            kept.push(n.to_string());
        }
        org_domains.insert(org.clone(), kept);
    }
    let raw_admins = policy.get("org_admins").unwrap_or(&empty_obj).as_object().ok_or("org_admins must be an object")?;
    let mut org_admins: IndexMap<String, Vec<String>> = IndexMap::new();
    for (org, people) in raw_admins {
        if !org_domains.contains_key(org) {
            return Err(format!("org_admins names {}, which has no domains", repr_str(org)));
        }
        let mut kept = Vec::new();
        for p in list(people, &format!("org_admins[{org}]"), PRINCIPALS_MAX, 1)? {
            split_value(p)?;
            kept.push(pj::py_str(p));
        }
        org_admins.insert(org.clone(), kept);
    }
    let services = list(policy.get("sso_services").unwrap_or(&empty_list), "sso_services", 100, 0)?;
    let mut sso_services = Vec::new();
    for svc in services {
        let o = keys(svc, SSO_SERVICE_KEYS, SSO_SERVICE_KEYS, "an SSO service")?;
        if !o["serial"].as_str().is_some_and(|s| hex_ok(s, 1, 40)) {
            return Err("an SSO service's serial must be lower-case hex".into());
        }
        let orgs = list(&o["orgs"], "an SSO service's orgs", RELAY_MAX, 1)?;
        if orgs.iter().any(|x| !x.as_str().is_some_and(|x| org_domains.contains_key(x))) {
            return Err("an SSO service names an organization without domains".into());
        }
        let allowed: HashSet<&str> = orgs
            .iter()
            .filter_map(Value::as_str)
            .flat_map(|x| org_domains.get(x).into_iter().flatten().map(String::as_str))
            .collect();
        let domains = list(&o["domains"], "an SSO service's domains", 1000, 1)?;
        if domains.iter().any(|d| !d.as_str().is_some_and(|d| allowed.contains(d))) {
            return Err("an SSO service names a domain outside its organizations".into());
        }
        let texts = |l: &[Value]| l.iter().filter_map(Value::as_str).map(str::to_string).collect::<Vec<_>>();
        sso_services.push((pj::py_str(&o["serial"]), texts(orgs), texts(domains)));
    }
    // the relay checks the SSO terms (the signer and the SSO service apply them) but keeps none of them
    let raw_sso = policy.get("sso").unwrap_or(&empty_obj).as_object().ok_or("sso must be an object")?;
    for (org, terms) in raw_sso {
        if !org_domains.contains_key(org) {
            return Err(format!("sso names {}, which has no domains", repr_str(org)));
        }
        let t = keys(terms, &["auto_approve", "require_amr"], &[], &format!("sso[{org}]"))?;
        let auto = match t.get("auto_approve") {
            None => false,
            Some(Value::Bool(b)) => *b,
            Some(_) => return Err(format!("sso[{org}].auto_approve must be true or false")),
        };
        let amr = list(t.get("require_amr").unwrap_or(&empty_list), &format!("sso[{org}].require_amr"), 20, 0)?;
        if !amr.iter().all(|a| a.as_str().is_some_and(|a| !a.is_empty() && pj::printable(a))) {
            return Err(format!("sso[{org}].require_amr must list amr or acr values"));
        }
        if auto && amr.is_empty() {
            return Err(format!("sso[{org}]: auto_approve needs a non-empty require_amr (multi-factor sign-in)"));
        }
    }
    if !matches!(policy.get("enclave"), None | Some(Value::Bool(_))) {
        return Err("enclave must be true or false".into());
    }
    let enclave = policy.get("enclave") == Some(&Value::Bool(true));
    Ok(SignerTerms { org_domains, org_admins, intermediate_serial: serial, enclave, sso_services })
}

// ---- the org policy -------------------------------------------------------------------------------------------

fn covered(principal: &Value, domains: &[&str], what: &str) -> Res<()> {
    let (_, domain) = split_value(principal)?;
    if !domains.contains(&domain) {
        return Err(format!("{what}: {} is not covered by this policy's domains", pj::py_str(principal)));
    }
    Ok(())
}

fn service<'a>(principal: &'a Value, domains: &[&str], what: &str) -> Res<&'a str> {
    let (local, domain) = split_value(principal)?;
    match domain.strip_prefix(APPS_PREFIX) {
        Some(rest) if domains.contains(&rest) => Ok(local),
        _ => Err(format!("{what} must be <name>@apps.<one of this policy's domains>")),
    }
}

/// True when some entry equals an earlier one (`len(set(x)) != len(x)`).
fn has_dup<T: PartialEq>(items: &[T]) -> bool {
    (1..items.len()).any(|i| items[..i].contains(&items[i]))
}

/// Every field rule and limit of an org policy, and its domains against the root's `org_domains` (Refused with
/// DOMAIN_REFUSED). Bad for any other problem.
pub fn check_policy(policy: &Value, terms: &SignerTerms) -> Result<(), PolicyError> {
    let p = keys(policy, TOP_KEYS, REQUIRED, "the policy")?;
    canonical_json(policy)?; // no null, no float anywhere
    if !py_eq(p.get("v"), 1) {
        return Err(bad("the policy must be version 1"));
    }
    let org = p["org"].as_str().filter(|o| slug_ok(o)).ok_or("org must be 1 to 32 of a-z, 0-9 and -")?;
    text(&p["label"], "label", LABEL_MAX)?;
    let raw_domains = list(&p["domains"], "domains", DOMAINS_MAX, 1)?;
    let assigned = terms.org_domains.get(org);
    let mut domains: Vec<&str> = Vec::new();
    for d in raw_domains {
        let Some(ds) = d.as_str().filter(|x| is_domain(x)) else {
            return Err(PolicyError::Bad(format!("{} is not a lower-case DNS name", repr(d))));
        };
        if ds.starts_with(APPS_PREFIX) || !assigned.is_some_and(|a| a.iter().any(|x| x == ds)) {
            return Err(refused(DOMAIN_REFUSED));
        }
        domains.push(ds);
    }
    int(&p["seq"], "seq", 1, MAX_INT)?;
    let issued = int(&p["issued"], "issued", 1, MAX_INT)?;
    let expires = int(&p["expires"], "expires", 1, MAX_INT)?;
    if !(1..=LIFE_MAX).contains(&(expires - issued)) {
        return Err(bad("expires must be after issued, at most 90 days later"));
    }
    for key in ["admins", "archive_reviewers", "workflows"] {
        if let Some(v) = p.get(key) {
            for x in list(v, key, PRINCIPALS_MAX, 0)? {
                covered(x, &domains, key)?;
            }
        }
    }
    let mut services: Vec<&Value> = Vec::new();
    let mut devices: Vec<&Value> = Vec::new();
    if let Some(a) = p.get("archive") {
        let arch = keys(a, ARCHIVE_KEYS, ARCHIVE_KEYS, "archive")?;
        if service(&arch["principal"], &domains, "the archive principal")? != "archive" {
            return Err(bad("the archive principal must be archive@apps.<domain>"));
        }
        check_device_id(&arch["device"])?;
        if !arch["host"].as_str().is_some_and(is_domain) {
            return Err(bad("the archive host must be a DNS name"));
        }
        int(&arch["since"], "archive.since", 1, MAX_INT)?;
        services.push(&arch["principal"]);
        devices.push(&arch["device"]);
    }
    let empty = Value::Array(Vec::new());
    for app in list(p.get("apps").unwrap_or(&empty), "apps", APPS_MAX, 0)? {
        let a = keys(app, APP_KEYS, APP_REQUIRED, "an app")?;
        let local = service(&a["principal"], &domains, "an app principal")?;
        if !slug_ok(local) || local == "archive" {
            return Err(bad("an app is <name>@apps.<domain>, name not archive"));
        }
        check_device_id(&a["device"])?;
        text(&a["name"], "an app's name", LABEL_MAX)?;
        let kind = a["type"].as_str();
        if !kind.is_some_and(|t| APP_TYPES.contains(&t)) {
            return Err(bad("an app's type must be bot, webhook, workflows or ai"));
        }
        if !a["scope"].as_str().is_some_and(|s| SCOPES.contains(&s)) {
            return Err(bad("an app's scope must be mentions or all"));
        }
        if kind != Some("bot") && a["scope"].as_str() != Some("all") {
            return Err(bad("webhook and workflows apps must have scope all"));
        }
        if !a["host"].as_str().is_some_and(is_domain) {
            return Err(bad("an app's host must be a DNS name"));
        }
        if let Some(d) = a.get("description") {
            text(d, "an app's description", 0)?;
        }
        if let Some(i) = a.get("icon_sha256") {
            if !i.as_str().is_some_and(|i| hex_ok(i, 64, 64)) {
                return Err(bad("icon_sha256 must be 64 lower-case hex digits"));
            }
        }
        let mut names: Vec<&str> = Vec::new();
        for cmd in list(a.get("commands").unwrap_or(&empty), "commands", COMMANDS_MAX, 0)? {
            let c = keys(cmd, COMMAND_KEYS, &["name"], "a command")?;
            let Some(n) = c["name"].as_str().filter(|n| slug_ok(n)) else {
                return Err(bad("a command name must be 1 to 32 of a-z, 0-9 and -"));
            };
            for k in ["description", "usage"] {
                if let Some(x) = c.get(k) {
                    text(x, &format!("a command's {k}"), 0)?;
                }
            }
            names.push(n);
        }
        if has_dup(&names) {
            return Err(bad("an app lists a command twice"));
        }
        for other in list(a.get("cross_org").unwrap_or(&empty), "cross_org", CROSS_ORG_MAX, 0)? {
            if !other.as_str().is_some_and(|o| slug_ok(o) && o != org) {
                return Err(bad("cross_org lists other organizations' ids"));
            }
        }
        services.push(&a["principal"]);
        devices.push(&a["device"]);
    }
    if has_dup(&services) || has_dup(&devices) {
        return Err(bad("two services share a principal or a device"));
    }
    if let Some(x) = p.get("external_archives") {
        if !x.as_str().is_some_and(|x| EXTERNAL_ARCHIVES.contains(&x)) {
            return Err(bad("external_archives must be allow or refuse"));
        }
    }
    for x in list(p.get("external_apps").unwrap_or(&empty), "external_apps", PRINCIPALS_MAX, 0)? {
        let (_, domain) = split_value(x)?;
        match domain.strip_prefix(APPS_PREFIX) {
            Some(rest) if !domains.contains(&rest) => {}
            _ => return Err(bad("external_apps lists other organizations' app principals")),
        }
    }
    if let Some(r) = p.get("retention") {
        for (kind, days) in keys(r, RETENTION_KINDS, &[], "retention")? {
            int(days, &format!("retention.{kind}"), if kind == "canvas" { 0 } else { 1 }, RETENTION_MAX)?;
        }
    }
    if let Some(n) = p.get("notify") {
        let ok = n.as_object().is_some_and(|o| o.len() == 1 && o.get("previews").and_then(Value::as_str) == Some("off"));
        if !ok {
            return Err(bad(NOTIFY_SHAPE));
        }
    }
    if let Some(v) = p.get("video") {
        let got = keys(v, VIDEO_KEYS, &["background"], "video")?;
        let background = got["background"].as_str().filter(|b| VIDEO_BACKGROUNDS.contains(b));
        let Some(background) = background else {
            return Err(bad("video.background must be none, blur or team"));
        };
        if let Some(i) = got.get("team_image") {
            if !i.as_str().is_some_and(|i| hex_ok(i, 64, 64)) {
                return Err(bad("video.team_image must be 64 lower-case hex digits"));
            }
        }
        if background == "team" && !got.contains_key("team_image") {
            return Err(bad("a team background needs video.team_image"));
        }
        if let Some(c) = got.get("change") {
            if !c.as_str().is_some_and(|c| VIDEO_CHANGES.contains(&c)) {
                return Err(bad("video.change must be allow or refuse"));
            }
        }
    }
    if let Some(a) = p.get("ai") {
        check_ai(a, terms)?;
    }
    if p.contains_key("sharing") {
        return Err(refused(SHARING_REFUSED));
    }
    if let Some(s) = p.get("storage") {
        check_storage(s)?;
    }
    Ok(())
}

/// BG-1 section 2.1: `(background, team_image, change)` of a checked policy, with the absent values filled
/// (`team_image` "", `change` "allow"); None without `video`.
pub fn video(policy: Option<&Obj>) -> Option<(String, String, String)> {
    let v = policy?.get("video")?.as_object()?;
    let text = |k: &str, d: &str| v.get(k).and_then(Value::as_str).unwrap_or(d).to_string();
    Some((text("background", ""), text("team_image", ""), text("change", "allow")))
}

/// BG-1 section 2.3: the default marker ("", `none`, `blur` or `team:<sha256>`).
pub fn video_default(policy: Option<&Obj>) -> String {
    match video(policy) {
        None => String::new(),
        Some((b, image, _)) if b == "team" => format!("team:{image}"),
        Some((b, _, _)) => b,
    }
}

// ---- AI-1: the `ai` key, its gates and the members-only AI map (docs/ai/contract.md 1, 2) ----------------------

const AI_KEYS: &[&str] = &[
    "v", "enabled", "who", "order", "classes", "cui_classes", "default_class", "frontier_classes",
    "redact_for_frontier", "frontier", "models", "device_models", "embedding", "deadlines_ms", "budgets", "org_index",
    "map_sha256",
];
const AI_ROUTES: &[&str] = &["device", "org", "frontier"];
const AI_ACCESS: &[&str] = &["org", "personal", "either", "none"];
const AI_PLANS: &[&str] = &["business", "any"];
const AI_LIST_MAX: usize = 50;
const AI_TEXT_MAX: usize = 128;
const AI_CLASSES_MAX: usize = 8;
const AI_PROVIDERS_MAX: usize = 16;
/// The Lucid IDE provider ids personal access may name (5.2).
pub const AI_PROVIDERS: &[&str] = &["anthropic", "openai", "google", "xai", "azure", "google-vertex", "amazon-bedrock", "asksage"];
pub const AI_FRONTIER_DISAGREE: &str = "ai.order and ai.frontier.access disagree about frontier.";
pub const AI_ENCLAVE: &str = "An enclave org cannot use frontier models except through AskSage.";
pub const AI_CUI: &str = "CUI cannot go to commercial frontier models.";
pub const AI_ASKSAGE: &str = "Under the AskSage lockdown, personal access must be AskSage.";
/// The AI-1a release of the Hub and the iPhone (older ones refuse the whole policy for its unknown key).
const AI_CLIENTS: [(&str, &str); 2] = [("hub", "0.98.0"), ("ios", "0.98.0")];
pub const AI_TOO_SOON: &str =
    "AI rules need every Meeting Hub and iPhone app at 0.98.0 or later. Raise the relay's minimum app versions first.";
pub const AI_BIG_ORG: &str = "A big organization's AI needs the organization archive with at least 3 archive reviewers.";
pub const AI_ONE_REVIEWER: &str = "With an archive, at least one archive reviewer is needed.";

/// 1 to `limit` printable ASCII characters.
fn ascii_text(v: &Value, limit: usize) -> bool {
    v.as_str().is_some_and(|s| (1..=limit).contains(&s.len()) && s.bytes().all(|b| (0x20..0x7f).contains(&b)))
}

/// `sha256:` + 64 lower-case hex.
fn digest_ok(v: &Value) -> bool {
    v.as_str().and_then(|s| s.strip_prefix("sha256:")).is_some_and(|h| hex_ok(h, 64, 64))
}

/// `[a-z0-9-]{1,32}` as a full match.
fn ai_label(v: &Value) -> Option<&str> {
    v.as_str().filter(|s| !s.ends_with('\n') && slug_ok(s))
}

/// 0 to `most` distinct strings, each passing `ok`; None otherwise.
fn ai_strs<'a>(v: Option<&'a Value>, low: usize, most: usize, ok: impl Fn(&Value) -> bool) -> Option<Vec<&'a str>> {
    let a = v?.as_array().filter(|a| (low..=most).contains(&a.len()))?;
    let out: Vec<&str> = a.iter().filter(|x| ok(x)).filter_map(Value::as_str).collect();
    (out.len() == a.len() && !has_dup(&out)).then_some(out)
}

/// `_ai_list(..., distinct=False)`: 0 to `most` strings, each passing `ok`.
fn ai_strs_any(v: Option<&Value>, most: usize, ok: impl Fn(&Value) -> bool) -> bool {
    v.and_then(Value::as_array).is_some_and(|a| a.len() <= most && a.iter().all(|x| x.is_string() && ok(x)))
}

fn ai_obj<'a>(v: Option<&'a Value>, allowed: &[&str], required: &[&str], words: &str) -> Result<&'a Obj, PolicyError> {
    v.and_then(Value::as_object)
        .filter(|o| o.keys().all(|k| allowed.contains(&k.as_str())) && required.iter().all(|k| o.contains_key(*k)))
        .ok_or_else(|| bad(words))
}

fn ai_bool(v: Option<&Value>, words: &str) -> Result<bool, PolicyError> {
    v.and_then(Value::as_bool).ok_or_else(|| bad(words))
}

fn ai_int(v: Option<&Value>, low: i64, high: i64, words: &str) -> Result<i64, PolicyError> {
    pj::as_int(v).filter(|n| (low..=high).contains(n)).ok_or_else(|| bad(words))
}

/// Contract AI-1 1.2: every field and limit of the `ai` key, then the cross-field rules, each with its own words.
pub fn check_ai(ai: &Value, terms: &SignerTerms) -> Result<(), PolicyError> {
    let a = keys(ai, AI_KEYS, &[], "ai")?;
    if pj::as_int(a.get("v")) != Some(1) {
        return Err(bad("ai.v must be 1"));
    }
    ai_bool(a.get("enabled"), "ai.enabled must be true or false")?;
    const WHO: &str = "ai.who.groups must list immutable group ids";
    let w = ai_obj(a.get("who"), &["groups"], &["groups"], WHO)?;
    let group_ok = |x: &Value| ascii_text(x, AI_TEXT_MAX) && !x.as_str().is_some_and(|s| s.starts_with("name:"));
    ai_strs(w.get("groups"), 0, AI_LIST_MAX, group_ok).ok_or_else(|| bad(WHO))?;
    let order = ai_strs(a.get("order"), 1, 3, |x| x.as_str().is_some_and(|s| AI_ROUTES.contains(&s)))
        .ok_or_else(|| bad("ai.order must list device, org or frontier, each once"))?;
    let classes = ai_strs(a.get("classes"), 1, AI_CLASSES_MAX, |x| ai_label(x).is_some())
        .ok_or_else(|| bad("ai.classes must be 1 to 8 distinct labels"))?;
    let of_classes = |key: &str, words: &str| -> Result<Vec<&str>, PolicyError> {
        match a.get(key) {
            None => Ok(Vec::new()),
            v => ai_strs(v, 0, AI_CLASSES_MAX, |x| x.as_str().is_some_and(|s| classes.contains(&s))).ok_or_else(|| bad(words)),
        }
    };
    let cui = of_classes("cui_classes", "ai.cui_classes must be classes")?;
    if !a.get("default_class").and_then(Value::as_str).is_some_and(|d| classes.contains(&d)) {
        return Err(bad("ai.default_class must be one of ai.classes"));
    }
    let frontier_classes = of_classes("frontier_classes", "ai.frontier_classes must be classes")?;
    let f = ai_obj(a.get("frontier"), &["access", "personal"], &["access"], "ai.frontier.access must be org, personal, either or none")?;
    let Some(access) = f.get("access").and_then(Value::as_str).filter(|s| AI_ACCESS.contains(s)) else {
        return Err(bad("ai.frontier.access must be org, personal, either or none"));
    };
    let wants_personal = access == "personal" || access == "either";
    if wants_personal != f.contains_key("personal") {
        return Err(bad("ai.frontier.personal is needed only for personal or either"));
    }
    let mut personal_classes: Vec<&str> = Vec::new();
    let mut personal_providers: Vec<&str> = Vec::new();
    if let Some(pv) = f.get("personal") {
        let pk = &["api_keys", "oauth", "providers", "classes", "plans"];
        let po = ai_obj(Some(pv), pk, &[], "ai.frontier.personal is needed only for personal or either")?;
        let (keys_ok, oauth) = (po.get("api_keys").and_then(Value::as_bool), po.get("oauth").and_then(Value::as_bool));
        if keys_ok.is_none() || oauth.is_none() || (keys_ok == Some(false) && oauth == Some(false)) {
            return Err(bad("ai.frontier.personal must allow keys, OAuth or both"));
        }
        personal_providers = ai_strs(po.get("providers"), 1, AI_PROVIDERS_MAX, |x| x.as_str().is_some_and(|s| AI_PROVIDERS.contains(&s)))
            .ok_or_else(|| bad("ai.frontier.personal.providers must be provider ids"))?;
        personal_classes = ai_strs(po.get("classes"), 0, AI_CLASSES_MAX, |x| x.as_str().is_some_and(|s| classes.contains(&s)))
            .ok_or_else(|| bad("ai.frontier.personal.classes must be classes"))?;
        if !po.get("plans").and_then(Value::as_str).is_some_and(|p| AI_PLANS.contains(&p)) {
            return Err(bad("ai.frontier.personal.plans must be business or any"));
        }
    }
    if let Some(r) = a.get("redact_for_frontier") {
        let ok = |x: &Value| x.as_str().is_some_and(|s| frontier_classes.contains(&s) || personal_classes.contains(&s));
        ai_strs(Some(r), 0, AI_CLASSES_MAX, ok).ok_or_else(|| bad("ai.redact_for_frontier must be frontier classes"))?;
    }
    const MODELS_WORDS: &str = "ai.models must use the Lucid IDE models fields";
    let mut asksage_only = false;
    if let Some(mv) = a.get("models") {
        let mo = ai_obj(Some(mv), &["asksageOnly", "allowed", "denied", "lock"], &[], MODELS_WORDS)?;
        for k in ["asksageOnly", "lock"] {
            if let Some(b) = mo.get(k) {
                let b = ai_bool(Some(b), MODELS_WORDS)?;
                if k == "asksageOnly" {
                    asksage_only = b;
                }
            }
        }
        for k in ["allowed", "denied"] {
            if mo.contains_key(k) && !ai_strs_any(mo.get(k), AI_LIST_MAX, |x| ascii_text(x, AI_TEXT_MAX)) {
                return Err(bad(MODELS_WORDS));
            }
        }
    }
    if let Some(dv) = a.get("device_models") {
        const W: &str = "ai.device_models.allow_digests must be sha256 digests";
        let d = ai_obj(Some(dv), &["allow_digests"], &["allow_digests"], W)?;
        if !ai_strs_any(d.get("allow_digests"), AI_LIST_MAX, digest_ok) {
            return Err(bad(W));
        }
    }
    if let Some(ev) = a.get("embedding") {
        const W: &str = "ai.embedding must name a model, digest and dims";
        let e = ai_obj(Some(ev), &["model", "digest", "dims"], &["model", "digest", "dims"], W)?;
        if !ascii_text(&e["model"], AI_TEXT_MAX) || !digest_ok(&e["digest"]) {
            return Err(bad(W));
        }
        ai_int(e.get("dims"), 64, 4096, W)?;
    }
    {
        const W: &str = "ai.deadlines_ms must be 2000 to 300000";
        let d = ai_obj(a.get("deadlines_ms"), &["search", "catch_up"], &["search", "catch_up"], W)?;
        for v in d.values() {
            ai_int(Some(v), 2000, 300_000, W)?;
        }
    }
    {
        const W: &str = "ai.budgets must be whole dollars";
        const B: &[&str] = &["frontier_usd_month", "frontier_usd_user_day"];
        let b = ai_obj(a.get("budgets"), B, B, W)?;
        ai_int(b.get("frontier_usd_month"), 0, 10_000_000, W)?;
        ai_int(b.get("frontier_usd_user_day"), 0, 100_000, W)?;
    }
    if let Some(v) = a.get("org_index") {
        ai_bool(Some(v), "ai.org_index must be true or false")?;
    }
    if !a.get("map_sha256").and_then(Value::as_str).is_some_and(|h| !h.ends_with('\n') && hex_ok(h, 64, 64)) {
        return Err(bad("ai.map_sha256 must name the AI map"));
    }
    // cross-field rules
    let frontier_in_order = order.contains(&"frontier");
    if frontier_in_order != (access != "none") {
        return Err(bad(AI_FRONTIER_DISAGREE));
    }
    if terms.enclave && frontier_in_order && !asksage_only {
        return Err(bad(AI_ENCLAVE));
    }
    if !asksage_only && cui.iter().any(|c| frontier_classes.contains(c) || personal_classes.contains(c)) {
        return Err(bad(AI_CUI));
    }
    if asksage_only && f.contains_key("personal") && personal_providers != ["asksage"] {
        return Err(bad(AI_ASKSAGE));
    }
    Ok(())
}

fn version_ready(clients: &[(&str, &str)], minimums: &Obj) -> bool {
    clients.iter().all(|(app, least)| {
        minimums.get(*app).map(|v| crate::meet::version_key(&pj::py_str(v)) >= crate::meet::version_key(least)).unwrap_or(false)
    })
}

/// ai_gate (1.3): a policy with `ai`, or with `retention.ai`, is taken only once the relay's minimums reach the AI-1a
/// release of both the Hub and the iPhone.
pub fn ai_gate(policy: Option<&Value>, minimums: &Obj) -> Result<(), String> {
    let p = policy.and_then(Value::as_object);
    let wants = p.is_some_and(|p| p.contains_key("ai") || p.get("retention").and_then(|r| r.get("ai")).is_some());
    if wants && !version_ready(&AI_CLIENTS, minimums) {
        return Err(AI_TOO_SOON.into());
    }
    Ok(())
}

/// ai_edition_gate (1.5): with `ai.enabled` true, a big organization (`enterprise`) needs the archive and at least 3
/// archive reviewers; a small one (`standard`) with an archive needs at least one reviewer. Any edition other than
/// `standard`, and no license at all (`None`), is big.
pub fn ai_edition_gate(policy: &Obj, edition: Option<&str>) -> Result<(), String> {
    let enabled = policy.get("ai").and_then(|a| a.get("enabled")).and_then(Value::as_bool) == Some(true);
    if !enabled {
        return Ok(());
    }
    let reviewers = policy.get("archive_reviewers").and_then(Value::as_array).map_or(0, Vec::len);
    let archive = policy.contains_key("archive");
    let small = edition == Some("standard");
    if !small && (!archive || reviewers < 3) {
        return Err(AI_BIG_ORG.into());
    }
    if small && archive && reviewers < 1 {
        return Err(AI_ONE_REVIEWER.into());
    }
    Ok(())
}

const AI_MAP_LABEL: &str = "lucid-meet-org-ai-v1";
/// The whole signed AI map.
const AI_MAP_MAX: usize = 256 * 1024;
const AI_MAP_KEYS: &[&str] = &["v", "org", "seq", "issued", "gateways", "channel_classes", "excluded_channels", "who_principals"];
const AI_MAP_REQUIRED: &[&str] = &["v", "org", "seq", "issued"];
const AI_GATEWAY_KEYS: &[&str] = &["url", "principal", "device", "spki", "region"];
const AI_GATEWAY_REQUIRED: &[&str] = &["url", "principal", "device", "spki"];
const AI_GATEWAYS_MAX: usize = 8;
const AI_URL_MAX: usize = 256;
const AI_CHANNELS_MAX: usize = 5000;
const AI_PEOPLE_MAX: usize = 5000;
/// Orgs whose AI maps one relay holds.
pub const AI_MAP_ORGS_MAX: usize = 64;

const AI_MAP_V: &str = "the AI map must be version 1";
const AI_MAP_ORG_ID: &str = "the AI map's org must be 1 to 32 of a-z, 0-9 and -";
const AI_MAP_GATEWAYS: &str = "the AI map's gateways must be 0 to 8 gateways {url, principal, device, spki}";
const AI_MAP_URL: &str = "a gateway url must be https:// with a DNS name or IP and a port";
const AI_MAP_PRINCIPAL: &str = "a gateway principal must be <name>@apps.<one of the policy's domains>";
const AI_MAP_DEVICE: &str = "a gateway must be an ai app of the policy, with its device";
const AI_MAP_SPKI: &str = "a gateway spki must be 64 lower-case hex digits";
const AI_MAP_REGION: &str = "a gateway region must be 1 to 32 of a-z, 0-9 and -";
const AI_MAP_NEEDS_GATEWAY: &str = "the AI map needs a gateway for the org route";
const AI_MAP_CLASSES: &str = "channel_classes must map ch: cids to the policy's classes";
const AI_MAP_EXCLUDED: &str = "excluded_channels must list ch: cids";
const AI_MAP_WHO: &str = "who_principals must list people of the policy's domains, each once";
const AI_MAP_ORG: &str = "the AI map is for another organization";
pub const AI_MAP_NOT_NAMED: &str = "{label}'s AI map is not the one its policy names, so it was not used.";

/// AI_CID_RE: `ch:[a-z0-9-]{1,64}` (a full match).
fn ai_cid_ok(s: &str) -> bool {
    s.strip_prefix("ch:").is_some_and(|r| (1..=64).contains(&r.len()) && r.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'))
}

/// `[0-9a-f]{n}` as a full match.
fn hex_full(v: &Value, n: usize) -> bool {
    v.as_str().is_some_and(|s| !s.ends_with('\n') && hex_ok(s, n, n))
}

/// `_ai_url`: `https://` + a DNS name, IPv4 address or bracketed IPv6 address + `:port` (1 to 65535, no leading
/// zero), nothing after it, at most 256 characters.
fn gateway_url_ok(v: &Value) -> bool {
    let Some(s) = v.as_str().filter(|s| s.chars().count() <= AI_URL_MAX) else { return false };
    let Some(rest) = s.strip_prefix("https://") else { return false };
    let Some((host, port)) = rest.rsplit_once(':') else { return false };
    let port_ok = !port.is_empty()
        && port.len() <= 5
        && port.bytes().all(|b| b.is_ascii_digit())
        && !port.starts_with('0')
        && port.parse::<u32>().is_ok_and(|n| (1..=65535).contains(&n));
    if !port_ok {
        return false;
    }
    if let Some(inner) = host.strip_prefix('[').and_then(|h| h.strip_suffix(']')) {
        return inner.parse::<std::net::Ipv6Addr>().is_ok();
    }
    is_domain(host) || ipv4_strict(host)
}

/// Python's `ipaddress.IPv4Address`: four decimal octets, no leading zeros.
fn ipv4_strict(s: &str) -> bool {
    let parts: Vec<&str> = s.split('.').collect();
    parts.len() == 4
        && parts.iter().all(|p| {
            (1..=3).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_digit()) && !(p.len() > 1 && p.starts_with('0')) && p.parse::<u16>().is_ok_and(|n| n <= 255)
        })
}

/// `_ai_gateway_domain`: the org domain of an app principal `<name>@apps.<domain>` ("" when it is not one).
fn gateway_domain(v: &Value) -> &str {
    match split_value(v) {
        Ok((local, domain)) if slug_ok(local) && local != "archive" => domain.strip_prefix(APPS_PREFIX).unwrap_or(""),
        _ => "",
    }
}

/// `ai_needs_gateway`: the policy's `ai` routes to the org (`org` in `order`) or the org frontier (`access` org or
/// either).
pub fn ai_needs_gateway(policy: &Obj) -> bool {
    let Some(ai) = policy.get("ai").and_then(Value::as_object) else { return false };
    let access = ai.get("frontier").and_then(|f| f.get("access")).and_then(Value::as_str);
    ai.get("order").and_then(Value::as_array).is_some_and(|o| o.iter().any(|x| x.as_str() == Some("org"))) || matches!(access, Some("org" | "either"))
}

/// Contract AI-1 2: the AI map's field rules (Bad). With the org's `policy` also: the same org, each gateway an `ai`
/// app of the policy (principal and device) on one of its domains, a gateway when the policy needs one,
/// `channel_classes` values among `ai.classes` and `who_principals` inside its `domains`. A relay stores a map with
/// the shape checks only; devices and the gateway pass the policy.
pub fn check_ai_map(ai_map: &Value, policy: Option<&Obj>) -> Result<(), PolicyError> {
    let m = keys(ai_map, AI_MAP_KEYS, AI_MAP_REQUIRED, "the AI map")?;
    canonical_json(ai_map)?;
    if !matches!(&m["v"], Value::Number(n) if n.as_i64() == Some(1)) {
        return Err(bad(AI_MAP_V));
    }
    let Some(org) = m["org"].as_str().filter(|o| slug_ok(o)) else { return Err(bad(AI_MAP_ORG_ID)) };
    int(&m["seq"], "seq", 1, MAX_INT)?;
    int(&m["issued"], "issued", 1, MAX_INT)?;
    let empty_list = Value::Array(Vec::new());
    let Some(gateways) = m.get("gateways").unwrap_or(&empty_list).as_array().filter(|g| g.len() <= AI_GATEWAYS_MAX) else {
        return Err(bad(AI_MAP_GATEWAYS));
    };
    for g in gateways {
        let ok = g.as_object().is_some_and(|o| o.keys().all(|k| AI_GATEWAY_KEYS.contains(&k.as_str())) && AI_GATEWAY_REQUIRED.iter().all(|k| o.contains_key(*k)));
        if !ok {
            return Err(bad(AI_MAP_GATEWAYS));
        }
        if !gateway_url_ok(&g["url"]) {
            return Err(bad(AI_MAP_URL));
        }
        if gateway_domain(&g["principal"]).is_empty() {
            return Err(bad(AI_MAP_PRINCIPAL));
        }
        if !hex_full(&g["device"], 16) {
            return Err(bad(AI_MAP_DEVICE));
        }
        if !hex_full(&g["spki"], 64) {
            return Err(bad(AI_MAP_SPKI));
        }
        if g.get("region").is_some_and(|r| ai_label(r).is_none()) {
            return Err(bad(AI_MAP_REGION));
        }
    }
    let urls: Vec<&Value> = gateways.iter().map(|g| &g["url"]).collect();
    let devices: Vec<&Value> = gateways.iter().map(|g| &g["device"]).collect();
    if has_dup(&urls) || has_dup(&devices) {
        return Err(bad(AI_MAP_GATEWAYS));
    }
    let empty_obj = Value::Object(Obj::new());
    let classes_ok = m.get("channel_classes").unwrap_or(&empty_obj).as_object().filter(|o| {
        o.len() <= AI_CHANNELS_MAX && o.iter().all(|(k, v)| ai_cid_ok(k) && ai_label(v).is_some())
    });
    let Some(channel_classes) = classes_ok else { return Err(bad(AI_MAP_CLASSES)) };
    ai_strs(Some(m.get("excluded_channels").unwrap_or(&empty_list)), 0, AI_CHANNELS_MAX, |v| v.as_str().is_some_and(ai_cid_ok))
        .ok_or_else(|| bad(AI_MAP_EXCLUDED))?;
    let person = |v: &Value| split_value(v).is_ok_and(|(_, d)| !d.starts_with(APPS_PREFIX));
    let who = ai_strs(Some(m.get("who_principals").unwrap_or(&empty_list)), 0, AI_PEOPLE_MAX, person).ok_or_else(|| bad(AI_MAP_WHO))?;
    let Some(policy) = policy else { return Ok(()) };
    if policy.get("org").and_then(Value::as_str) != Some(org) {
        return Err(bad(AI_MAP_ORG));
    }
    let domains: Vec<&str> = policy.get("domains").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect();
    for g in gateways {
        if !domains.contains(&gateway_domain(&g["principal"])) {
            return Err(bad(AI_MAP_PRINCIPAL));
        }
        let named = policy.get("apps").and_then(Value::as_array).into_iter().flatten().any(|a| {
            a.get("type").and_then(Value::as_str) == Some("ai") && a.get("principal") == Some(&g["principal"]) && a.get("device") == Some(&g["device"])
        });
        if !named {
            return Err(bad(AI_MAP_DEVICE));
        }
    }
    if gateways.is_empty() && ai_needs_gateway(policy) {
        return Err(bad(AI_MAP_NEEDS_GATEWAY));
    }
    let classes: Vec<&Value> = policy.get("ai").and_then(|a| a.get("classes")).and_then(Value::as_array).into_iter().flatten().collect();
    if channel_classes.values().any(|v| !classes.contains(&v)) {
        return Err(bad(AI_MAP_CLASSES));
    }
    if who.iter().any(|p| !p.split_once('@').is_some_and(|(_, d)| domains.contains(&d))) {
        return Err(bad(AI_MAP_WHO));
    }
    Ok(())
}

/// `check_ai_map_named`: a device uses only the map its pinned policy names (Refused).
pub fn check_ai_map_named(policy: &Obj, map_hash: &str) -> Result<(), PolicyError> {
    let named = policy.get("ai").and_then(|a| a.get("map_sha256")).and_then(Value::as_str);
    if named != Some(map_hash) {
        return Err(PolicyError::Refused(AI_MAP_NOT_NAMED.replace("{label}", &pj::s(policy, "label"))));
    }
    Ok(())
}

// ---- AI-1 6.4: who may use org AI ------------------------------------------------------------------------------

const AI_GROUPS_KEYS: &[&str] = &["org", "provider", "records", "sso_attestation"];
const AI_GROUP_RECORD_KEYS: &[&str] = &["principal", "listed", "read_at"];
const AI_GROUPS_RECORDS_MAX: usize = 1000;
const AI_ATTESTATION_MAX: usize = 16384;
/// ID-1 `poll_minutes` + `outage_minutes` defaults (seconds).
pub const AI_GROUPS_FRESH_S: i64 = (15 + 30) * 60;
const AI_GROUPS_SHAPE: &str = "ai-groups must be {org, provider, records, sso_attestation}";
const AI_GROUPS_RECORD: &str = "each record must be {principal, listed, read_at}";
const AI_GROUPS_UNLISTED: &str = "listed may name only groups in ai.who.groups";
const AI_GROUPS_FUTURE: &str = "read_at is in the future";

/// One stored `ai-groups` record.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AiGroupRecord {
    pub principal: String,
    pub listed: Vec<String>,
    pub read_at: i64,
}

fn same_keys(v: &Value, keys: &[&str]) -> bool {
    v.as_object().is_some_and(|o| o.len() == keys.len() && keys.iter().all(|k| o.contains_key(*k)))
}

/// `check_ai_groups`: the records of `POST /v1/sso/c/ai-groups` to store, all or nothing. `policy`: the org's current
/// policy; `held`: the stored `read_at` per principal. Bad (shape, 400) or Refused (the service, a principal, a
/// `read_at` not newer than the held one, 403).
pub fn check_ai_groups(
    post: &Value,
    caller_serial: &str,
    terms: &SignerTerms,
    policy: Option<&Obj>,
    held: &dyn Fn(&str) -> i64,
    now: f64,
) -> Result<Vec<AiGroupRecord>, PolicyError> {
    if !same_keys(post, AI_GROUPS_KEYS) {
        return Err(bad(AI_GROUPS_SHAPE));
    }
    let (org, provider, records, att) = (&post["org"], &post["provider"], &post["records"], &post["sso_attestation"]);
    let shape_ok = org.as_str().is_some_and(slug_ok)
        && provider.as_str().is_some_and(slug_ok)
        && att.as_str().is_some_and(|a| (1..=AI_ATTESTATION_MAX).contains(&a.chars().count()) && pj::printable(a))
        && records.as_array().is_some_and(|r| (1..=AI_GROUPS_RECORDS_MAX).contains(&r.len()));
    if !shape_ok {
        return Err(bad(AI_GROUPS_SHAPE));
    }
    let org = org.as_str().unwrap_or_default();
    let serial = caller_serial.to_lowercase();
    let served: Vec<&(String, Vec<String>, Vec<String>)> =
        terms.sso_services.iter().filter(|(s, orgs, _)| *s == serial && orgs.iter().any(|o| o == org)).collect();
    if serial.is_empty() || served.is_empty() {
        return Err(PolicyError::Refused(format!("this sign-in service is not registered for {org}")));
    }
    let service_domains: Vec<&str> = served.iter().flat_map(|(_, _, d)| d.iter().map(String::as_str)).collect();
    let groups: Vec<&str> = policy
        .filter(|p| p.get("org").and_then(Value::as_str) == Some(org))
        .and_then(|p| p.get("ai"))
        .and_then(|a| a.get("who"))
        .and_then(|w| w.get("groups"))
        .and_then(Value::as_array)
        .map(|g| g.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let (Some(policy), false) = (policy, groups.is_empty()) else {
        return Err(PolicyError::Refused(format!("{org}'s policy lists no AI groups")));
    };
    let mut out: Vec<AiGroupRecord> = Vec::new();
    for rec in records.as_array().into_iter().flatten() {
        if !same_keys(rec, AI_GROUP_RECORD_KEYS) {
            return Err(bad(AI_GROUPS_RECORD));
        }
        let Some((principal, domain)) = rec["principal"].as_str().and_then(|p| split_principal(p).ok().map(|(_, d)| (p, d))) else {
            return Err(bad(AI_GROUPS_RECORD));
        };
        if out.iter().any(|r| r.principal == principal) {
            return Err(PolicyError::Bad(format!("a record names {principal} twice")));
        }
        if !service_domains.contains(&domain) || !covers(policy, principal) {
            return Err(PolicyError::Refused(format!("{principal} is not a person this sign-in service serves for {org}")));
        }
        let Some(listed) = ai_strs(Some(&rec["listed"]), 0, AI_LIST_MAX, |x| ascii_text(x, AI_TEXT_MAX)) else {
            return Err(bad(AI_GROUPS_RECORD));
        };
        if listed.iter().any(|g| !groups.contains(g)) {
            return Err(bad(AI_GROUPS_UNLISTED));
        }
        let Some(read_at) = pj::as_int(Some(&rec["read_at"])).filter(|n| (1..=MAX_INT).contains(n)) else {
            return Err(bad(AI_GROUPS_RECORD));
        };
        if read_at as f64 > now + SKEW as f64 {
            return Err(bad(AI_GROUPS_FUTURE));
        }
        if read_at <= held(principal) {
            return Err(PolicyError::Refused(format!("the record for {principal} is not newer than the one held")));
        }
        let mut sorted: Vec<String> = listed.iter().map(|s| s.to_string()).collect();
        sorted.sort();
        out.push(AiGroupRecord { principal: principal.to_string(), listed: sorted, read_at });
    }
    Ok(out)
}

/// `ai_allowed` (6.4) at answer time: `(allowed, read_at)`. Allowed when the stored `listed` meets the current
/// policy's `who.groups` and `read_at` is at most `fresh_s` old, or when the principal is in the current AI map's
/// `who_principals` (then `read_at` is the map's `issued`).
pub fn ai_allowed(principal: &str, policy: Option<&Obj>, ai_map: Option<&Obj>, record: Option<&AiGroupRecord>, now: f64, fresh_s: i64) -> (bool, i64) {
    let read_at = record.map_or(0, |r| r.read_at);
    let Some(policy) = policy.filter(|p| p.get("ai").is_some_and(Value::is_object) && covers(p, principal)) else {
        return (false, read_at);
    };
    let groups: Vec<&str> = policy["ai"].get("who").and_then(|w| w.get("groups")).and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect();
    if let Some(r) = record {
        if r.listed.iter().any(|g| groups.contains(&g.as_str())) && now - read_at as f64 <= fresh_s as f64 {
            return (true, read_at);
        }
    }
    if let Some(m) = ai_map {
        if m.get("who_principals").and_then(Value::as_array).is_some_and(|w| w.iter().any(|p| p.as_str() == Some(principal))) {
            return (true, pj::as_int(m.get("issued")).unwrap_or(0));
        }
    }
    (false, read_at)
}

/// `lp("lucid-meet-org-ai-v1", canonical JSON of the map)` (empty JSON for a map canonical JSON refuses: every caller
/// checks the map first).
pub fn ai_map_bytes(ai_map: &Obj) -> Vec<u8> {
    let mut out = String::new();
    let json = match enc_obj(ai_map, &mut out) {
        Ok(()) => out.into_bytes(),
        Err(_) => Vec::new(),
    };
    lp(&[AI_MAP_LABEL.as_bytes(), &json])
}

/// Hex SHA-256 of the AI map's signed bytes (what `ai.map_sha256` names).
pub fn ai_map_hash(ai_map: &Obj) -> String {
    sha256_hex(&ai_map_bytes(ai_map))
}

/// A verified signed AI map.
#[derive(Clone, Debug)]
pub struct VerifiedAiMap {
    pub wire: Obj,
    pub org: String,
    pub seq: i64,
    pub hash: String,
    /// "root" or the intermediate's serial (hex).
    pub signer: String,
}

/// A relay's or device's check of a signed AI map, as `verify` checks a policy: the root-signed signer policy, the
/// signature by the root or the signer's current (or previous) intermediate valid at `issued` and not in the root's
/// CRL, `check_ai_map` (with the org's `policy` when given), then an org the root assigned domains to. A device then
/// calls `check_ai_map_named` and pins the `seq`.
pub fn verify_ai_map(
    wire: &Value,
    root: &Cert,
    signer_policy: &Obj,
    root_crl: Option<&Crl>,
    previous_serial: &str,
    now: f64,
    policy: Option<&Obj>,
) -> Result<VerifiedAiMap, PolicyError> {
    let w = keys(wire, WIRE_MAP_KEYS, WIRE_MAP_KEYS, "the signed AI map")?;
    if canonical_json(wire)?.len() > AI_MAP_MAX {
        return Err(bad("the signed AI map is larger than 256 KB"));
    }
    if !verify_signer_policy(root, signer_policy) {
        return Err(refused("the signer policy is not signed by the root"));
    }
    let terms = signer_terms(signer_policy)?;
    let m = keys(&w["map"], AI_MAP_KEYS, AI_MAP_REQUIRED, "the AI map")?;
    let issued = int(&m["issued"], "issued", 1, MAX_INT)?;
    if issued as f64 > now + SKEW as f64 {
        return Err(refused("the AI map is dated in the future"));
    }
    let sig = pj::b64_strict(&pj::py_str(&w["sig"])).ok_or("sig must be base64")?;
    canonical_json(&w["map"])?;
    let data = ai_map_bytes(m);
    let chain = match &w["chain"] {
        Value::Array(c) if c.len() <= 1 && c.iter().all(Value::is_string) => c,
        _ => return Err(bad("chain must be [] or [one intermediate PEM]")),
    };
    let inter = chain
        .first()
        .and_then(Value::as_str)
        .map(|pem| Some(pem).filter(|p| p.is_ascii()).and_then(Cert::from_pem).ok_or("the chain is not a certificate"))
        .transpose()?;
    let signer = match &inter {
        Some(c) => check_intermediate(c, root, &terms, previous_serial, issued, root_crl)?,
        None => "root".to_string(),
    };
    let spki = inter.as_ref().map_or(&root.spki, |c| &c.spki);
    if !ecdsa_sha256_verified(spki, &data, &sig) {
        return Err(refused("the AI map's signature does not verify"));
    }
    check_ai_map(&w["map"], policy)?;
    let org = pj::text_of(m, "org");
    if !terms.org_domains.contains_key(&org) {
        return Err(refused(DOMAIN_REFUSED));
    }
    Ok(VerifiedAiMap { wire: w.clone(), org, seq: pj::as_int(m.get("seq")).unwrap_or(0), hash: sha256_hex(&data), signer })
}

const WIRE_MAP_KEYS: &[&str] = &["map", "sig", "chain"]; // a policy's wire has `policy` in place of `map`

/// What a relay keeps (AI-1 2): per org the newest AI map and the one the org's current policy names by
/// `ai.map_sha256` (at most 2 per org, 64 orgs).
#[derive(Default)]
pub struct AiMapStore {
    pub newest: IndexMap<String, VerifiedAiMap>,
    pub kept: IndexMap<String, IndexMap<String, VerifiedAiMap>>,
}

impl AiMapStore {
    /// Verify and keep one signed map. `named`: the `ai.map_sha256` of the org's current policy ("" when none). A
    /// `seq` not above the newest is refused unless it is that named map.
    #[allow(clippy::too_many_arguments)]
    pub fn accept_at(
        &mut self,
        wire: &Value,
        root: &Cert,
        signer_policy: &Obj,
        root_crl: Option<&Crl>,
        previous_serial: &str,
        now: f64,
        named: &str,
    ) -> Result<VerifiedAiMap, PolicyError> {
        let vm = verify_ai_map(wire, root, signer_policy, root_crl, previous_serial, now, None)?;
        if let Some(held) = self.kept.get(&vm.org).and_then(|h| h.get(&vm.hash)) {
            return Ok(held.clone());
        }
        match self.newest.get(&vm.org) {
            None if !self.kept.contains_key(&vm.org) && self.kept.len() >= AI_MAP_ORGS_MAX => {
                return Err(refused("this relay already holds the AI maps of 64 organizations"));
            }
            Some(cur) if vm.seq <= cur.seq && vm.hash != named => {
                return Err(PolicyError::Refused(format!("that AI map's seq is not higher than {}", cur.seq)));
            }
            _ => {}
        }
        if self.newest.get(&vm.org).is_none_or(|cur| vm.seq > cur.seq) {
            self.newest.insert(vm.org.clone(), vm.clone());
        }
        self.kept.entry(vm.org.clone()).or_default().insert(vm.hash.clone(), vm.clone());
        self.prune(&vm.org, named);
        Ok(vm)
    }

    /// Keep only the org's newest map and the one its current policy names.
    pub fn prune(&mut self, org: &str, named: &str) {
        let newest = self.newest.get(org).map(|v| v.hash.clone()).unwrap_or_default();
        if let Some(held) = self.kept.get_mut(org) {
            held.retain(|h, _| *h == newest || h == named);
        }
    }

    /// `GET /v1/org/ai?org=` (the newest) or `&sha256=` (that kept map).
    pub fn get(&self, org: &str, sha256: &str) -> Option<&VerifiedAiMap> {
        if sha256.is_empty() {
            self.newest.get(org)
        } else {
            self.kept.get(org).and_then(|h| h.get(&sha256.to_lowercase()))
        }
    }

    /// Every kept map, by org and `seq` (what `ext["pc"]["ai_maps"]` holds).
    pub fn persisted(&self) -> Vec<Value> {
        let mut orgs: Vec<&String> = self.kept.keys().collect();
        orgs.sort();
        let mut out = Vec::new();
        for org in orgs {
            let mut maps: Vec<&VerifiedAiMap> = self.kept[org].values().collect();
            maps.sort_by_key(|v| v.seq);
            out.extend(maps.into_iter().map(|v| Value::Object(v.wire.clone())));
        }
        out
    }
}

// ---- SD-1: the `storage` key and the org storage map (docs/storage/contract.md 6.2) ------------------------------

/// `_place_id`: `[a-z0-9-]{1,32}` (a full match: no trailing newline).
fn place_ok(s: &str) -> bool {
    !s.ends_with('\n') && slug_ok(s)
}

fn place_id<'a>(v: &'a Value, what: &str) -> Res<&'a str> {
    v.as_str().filter(|s| place_ok(s)).ok_or_else(|| format!("{what} must be a place id (1 to 32 of a-z, 0-9 and -)"))
}

/// Unicode general category Cf (format characters: bidi controls, zero-width marks, tags).
fn is_format_char(c: char) -> bool {
    matches!(c as u32,
        0xad | 0x600..=0x605 | 0x61c | 0x6dd | 0x70f | 0x890..=0x891 | 0x8e2 | 0x180e | 0x200b..=0x200f
        | 0x202a..=0x202e | 0x2060..=0x2064 | 0x2066..=0x206f | 0xfeff | 0xfff9..=0xfffb | 0x110bd | 0x110cd
        | 0x13430..=0x1343f | 0x1bca0..=0x1bca3 | 0x1d173..=0x1d17a | 0xe0001 | 0xe0020..=0xe007f)
}

/// `check_place_label`: 1 to 64 characters of Unicode letters, digits, spaces and `.,()&'-`; no Unicode format
/// characters. Rust's std has no general categories: letters and digits are `is_alphabetic` and `is_numeric`, a
/// little wider than Python's L* and Nd (combining vowel signs, Roman numerals, superscripts also pass here).
pub fn check_place_label(v: &Value, what: &str) -> Res<()> {
    let Some(s) = v.as_str().filter(|s| (1..=PLACE_LABEL_MAX).contains(&s.chars().count())) else {
        return Err(format!("{what} must be 1 to {PLACE_LABEL_MAX} characters"));
    };
    for c in s.chars() {
        if is_format_char(c) {
            return Err(format!("{what} must not contain Unicode format characters"));
        }
        if !(c.is_alphabetic() || c.is_numeric() || PLACE_LABEL_MARKS.contains(c)) {
            return Err(format!("{what} may hold only letters, digits, spaces and .,()&'-"));
        }
    }
    Ok(())
}

/// The map place ids `own` and `group` name (sorted, each once; built-in ids left out).
fn storage_map_places(s: &Obj) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for key in ["own", "group"] {
        for place in s.get(key).and_then(Value::as_object).into_iter().flat_map(|o| o.values()).filter_map(Value::as_str) {
            if !STORAGE_BUILTINS.contains(&place) && !out.iter().any(|p| p == place) {
                out.push(place.to_string());
            }
        }
    }
    out.sort();
    out
}

/// `check_storage` as a device runs it (no maps): 6.2's field table, `map_sha256` required when `own` or `group`
/// names a map place. Bad naming the field.
pub fn check_storage(storage: &Value) -> Result<(), PolicyError> {
    let s = keys(storage, STORAGE_KEYS, &[], "storage")?;
    let mut providers: Option<Vec<&str>> = None;
    if let Some(p) = s.get("providers") {
        let mut names = Vec::new();
        for x in list(p, "storage.providers", STORAGE_PROVIDERS.len(), 0)? {
            match x.as_str().filter(|x| STORAGE_PROVIDERS.contains(x)) {
                Some(n) => names.push(n),
                None => return Err(PolicyError::Bad(format!("storage.providers may list only {}", STORAGE_PROVIDERS.join(", ")))),
            }
        }
        providers = Some(names);
    }
    for key in ["own", "group"] {
        let Some(v) = s.get(key) else { continue };
        for (kind, place) in keys(v, STORAGE_KINDS, &[], &format!("storage.{key}"))? {
            let place = place_id(place, &format!("storage.{key}.{kind}"))?;
            if STORAGE_BUILTINS.contains(&place) && providers.as_ref().is_some_and(|p| !p.contains(&place)) {
                return Err(PolicyError::Bad(format!("storage.{key}.{kind}: {place} is not in storage.providers")));
            }
        }
    }
    let empty = Obj::new();
    let mut labels = &empty;
    if let Some(l) = s.get("labels") {
        let Some(o) = l.as_object().filter(|o| o.len() <= MAP_PLACES_MAX + STORAGE_BUILTINS.len()) else {
            return Err(bad("storage.labels must be an object of place ids to labels"));
        };
        for (place, label) in o {
            if !place_ok(place) {
                return Err(PolicyError::Bad(format!("storage.labels.{place} must be a place id (1 to 32 of a-z, 0-9 and -)")));
            }
            check_place_label(label, &format!("storage.labels.{place}"))?;
        }
        labels = o;
    }
    let named = storage_map_places(s);
    let missing: Vec<&str> = named.iter().map(String::as_str).filter(|p| !labels.contains_key(*p)).collect();
    if !missing.is_empty() {
        return Err(PolicyError::Bad(format!("storage.labels needs a label for {}", missing.join(", "))));
    }
    if let Some(v) = s.get("people_choose") {
        for kind in list(v, "storage.people_choose", STORAGE_KINDS.len(), 0)? {
            if !kind.as_str().is_some_and(|k| STORAGE_KINDS.contains(&k)) {
                return Err(PolicyError::Bad(format!("storage.people_choose may list only {}", STORAGE_KINDS.join(", "))));
            }
        }
    }
    if let Some(v) = s.get("form") {
        for (kind, form) in keys(v, STORAGE_KINDS, &[], "storage.form")? {
            if !form.as_str().is_some_and(|f| STORAGE_FORMS.contains(&f)) {
                return Err(PolicyError::Bad(format!("storage.form.{kind} must be sealed or plain")));
            }
        }
    }
    if let Some(v) = s.get("keep_local_days") {
        int(v, "storage.keep_local_days", -1, STORAGE_DAYS_MAX)?;
    }
    if let Some(v) = s.get("expire_days") {
        for (kind, days) in keys(v, STORAGE_KINDS, &[], "storage.expire_days")? {
            int(days, &format!("storage.expire_days.{kind}"), 1, STORAGE_DAYS_MAX)?;
        }
    }
    if let Some(c) = s.get("cloud") {
        if !c.as_str().is_some_and(|c| ENTRA_CLOUDS.contains(&c)) {
            return Err(bad("storage.cloud must be global, usgov-high or usgov-dod"));
        }
    }
    if let Some(d) = s.get("map_sha256") {
        if !d.as_str().is_some_and(|d| !d.ends_with('\n') && hex_ok(d, 64, 64)) {
            return Err(bad("storage.map_sha256 must be 64 lower-case hex digits"));
        }
    }
    if !named.is_empty() && !s.contains_key("map_sha256") {
        return Err(bad("storage.map_sha256 is required when own or group names a map place"));
    }
    Ok(())
}

/// SD-1 13.5 (SD1-R2): a policy with `storage` is signed only once the relay's minimums reach the SD-1b release of
/// both the Hub and the iPhone (older apps refuse the whole policy for its unknown top key).
pub fn storage_gate(policy: Option<&Value>, minimums: &Obj) -> Result<(), String> {
    let wants = policy.and_then(Value::as_object).is_some_and(|p| p.contains_key("storage"));
    let ready = STORAGE_CLIENTS.iter().all(|(app, least)| minimums.get(*app).map(|v| crate::meet::version_key(&pj::py_str(v)) >= crate::meet::version_key(least)).unwrap_or(false));
    if wants && !ready {
        return Err(STORAGE_TOO_SOON.into());
    }
    Ok(())
}

/// A lower-case GUID (a full match).
fn guid_ok(s: &str) -> bool {
    let parts: Vec<&str> = s.split('-').collect();
    parts.len() == 5
        && parts.iter().zip([8, 4, 4, 4, 12]).all(|(p, n)| p.len() == n && p.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}

fn map_text<'a>(v: &'a Value, what: &str, limit: usize, path: bool) -> Res<&'a str> {
    let t = text(v, what, limit)?;
    if path && t.split(['/', '\\']).any(|part| part == "..") {
        return Err(format!("{what} must not hold a .. segment"));
    }
    Ok(t)
}

/// `_https_origin`: what Python's `urlsplit` reads as an `https` URL with a host, no user, no path other than "/",
/// no query or fragment, and a port (when given) from 1 to 65535.
fn https_origin(v: &Value, what: &str) -> Res<()> {
    let err = || format!("{what} must be an https:// origin");
    let Some(s) = v.as_str().filter(|s| s.chars().count() <= MAP_TEXT_MAX) else { return Err(err()) };
    let Some((scheme, rest)) = s.split_once(':') else { return Err(err()) };
    if !scheme.eq_ignore_ascii_case("https") {
        return Err(err());
    }
    let Some(rest) = rest.strip_prefix("//") else { return Err(err()) };
    let (rest, fragment) = rest.split_once('#').unwrap_or((rest, ""));
    let (rest, query) = rest.split_once('?').unwrap_or((rest, ""));
    let (netloc, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, ""),
    };
    if !fragment.is_empty() || !query.is_empty() || !(path.is_empty() || path == "/") || netloc.contains('@') {
        return Err(err());
    }
    let (host, port) = if let Some(inner) = netloc.strip_prefix('[') {
        let Some((h, after)) = inner.split_once(']') else { return Err(err()) };
        match after {
            "" => (h, None),
            a => match a.strip_prefix(':') {
                Some(p) => (h, Some(p)),
                None => return Err(err()),
            },
        }
    } else {
        match netloc.split_once(':') {
            Some((h, p)) => (h, Some(p)),
            None => (netloc, None),
        }
    };
    if host.is_empty() {
        return Err(err());
    }
    if let Some(p) = port.filter(|p| !p.is_empty()) {
        let ok = p.bytes().all(|b| b.is_ascii_digit()) && p.parse::<u32>().is_ok_and(|n| (1..65536).contains(&n));
        if !ok {
            return Err(err());
        }
    }
    Ok(())
}

/// `{}` (false) or `{url, principal, device}` (true, shape checked; refused by the caller until SD-1e).
fn check_connector(v: &Value, what: &str, policy: Option<&Obj>) -> Res<bool> {
    if v.as_object().is_some_and(Obj::is_empty) {
        return Ok(false);
    }
    let con = keys(v, CONNECTOR_KEYS, CONNECTOR_KEYS, what)?;
    https_origin(&con["url"], &format!("{what}.url"))?;
    let (local, domain) = split_value(&con["principal"])?;
    let domains = policy.and_then(|p| p.get("domains")).and_then(Value::as_array);
    let ok = local == "storage"
        && domain.strip_prefix(APPS_PREFIX).is_some_and(|rest| domains.is_none_or(|d| d.iter().any(|x| x.as_str() == Some(rest))));
    if !ok {
        return Err(format!("{what}.principal must be storage@apps.<one of the policy's domains>"));
    }
    check_device_id(&con["device"])?;
    Ok(true)
}

fn check_site(v: &Value, what: &str) -> Res<()> {
    let site = keys(v, SITE_KEYS, &["site", "drive"], what)?;
    map_text(&site["site"], &format!("{what}.site"), MAP_TEXT_MAX, false)?;
    map_text(&site["drive"], &format!("{what}.drive"), MAP_TEXT_MAX, false)?;
    if let Some(f) = site.get("folder") {
        map_text(f, &format!("{what}.folder"), MAP_TEXT_MAX, true)?;
    }
    Ok(())
}

/// The fields one map place of `provider` may have, and those it needs besides `id` and `provider`.
fn place_keys(provider: &str) -> (&'static [&'static str], &'static [&'static str]) {
    const SHAREPOINT: &[&str] = &["id", "provider", "connector", "channels", "groups", "site"];
    const SHAREPOINT_NEEDS: &[&str] = &["id", "provider"];
    const GDRIVE: &[&str] = &["id", "provider", "connector", "drive", "folder"];
    const GDRIVE_NEEDS: &[&str] = &["id", "provider", "drive"];
    const DROPBOX: &[&str] = &["id", "provider", "connector", "folder"];
    const DROPBOX_NEEDS: &[&str] = &["id", "provider", "folder"];
    const S3: &[&str] = &["id", "provider", "connector", "endpoint", "region", "bucket", "prefix", "sse", "kms_key"];
    const S3_NEEDS: &[&str] = &["id", "provider", "endpoint", "region", "bucket", "sse"];
    const RELAY_SHARE: &[&str] = &["id", "provider", "share", "folder"];
    const RELAY_SHARE_NEEDS: &[&str] = &["id", "provider", "share"];
    match provider {
        "sharepoint" => (SHAREPOINT, SHAREPOINT_NEEDS),
        "gdrive" => (GDRIVE, GDRIVE_NEEDS),
        "dropbox" => (DROPBOX, DROPBOX_NEEDS),
        "s3" => (S3, S3_NEEDS),
        _ => (RELAY_SHARE, RELAY_SHARE_NEEDS),
    }
}

/// One map place: (id, provider, has a connector).
fn check_place(place: &Value, policy: Option<&Obj>) -> Res<(String, String, bool)> {
    let Some(po) = place.as_object() else { return Err("each place must be an object".into()) };
    let null = Value::Null;
    let pid = place_id(po.get("id").unwrap_or(&null), "a place's id")?;
    let what = format!("places.{pid}");
    if STORAGE_BUILTINS.contains(&pid) {
        return Err(format!("{what}: {pid} is a built-in place id"));
    }
    let Some(provider) = po.get("provider").and_then(Value::as_str).filter(|p| MAP_PROVIDERS.contains(p)) else {
        return Err(format!("{what}.provider must be one of {}", MAP_PROVIDERS.join(", ")));
    };
    let (allowed, required) = place_keys(provider);
    keys(place, allowed, required, &what)?;
    let connector = match po.get("connector") {
        Some(c) => check_connector(c, &format!("{what}.connector"), policy)?,
        None => false,
    };
    match provider {
        "sharepoint" => {
            if let Some(channels) = po.get("channels") {
                let Some(c) = channels.as_object().filter(|c| c.len() <= MAP_ENTRIES_MAX) else {
                    return Err(format!("{what}.channels must be an object of at most {MAP_ENTRIES_MAX} entries"));
                };
                for (cid, team) in c {
                    let ok = (1..=64).contains(&cid.len()) && cid.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
                    if !ok {
                        return Err(format!("{what}.channels: {} is not a channel id", repr_str(cid)));
                    }
                    let t = keys(team, TEAM_KEYS, TEAM_KEYS, &format!("{what}.channels.{cid}"))?;
                    map_text(&t["team"], &format!("{what}.channels.{cid}.team"), MAP_TEXT_MAX, false)?;
                    map_text(&t["channel"], &format!("{what}.channels.{cid}.channel"), MAP_TEXT_MAX, false)?;
                }
            }
            if let Some(groups) = po.get("groups") {
                let Some(g) = groups.as_object().filter(|g| g.len() <= MAP_ENTRIES_MAX) else {
                    return Err(format!("{what}.groups must be an object of at most {MAP_ENTRIES_MAX} entries"));
                };
                for (gid, site) in g {
                    if !guid_ok(gid) {
                        return Err(format!("{what}.groups: {} is not a lower-case GUID", repr_str(gid)));
                    }
                    check_site(site, &format!("{what}.groups.{gid}"))?;
                }
            }
            if let Some(site) = po.get("site") {
                check_site(site, &format!("{what}.site"))?;
            }
        }
        "gdrive" => {
            map_text(&po["drive"], &format!("{what}.drive"), MAP_TEXT_MAX, false)?;
            if let Some(f) = po.get("folder") {
                map_text(f, &format!("{what}.folder"), MAP_TEXT_MAX, true)?;
            }
        }
        "dropbox" => {
            map_text(&po["folder"], &format!("{what}.folder"), MAP_TEXT_MAX, true)?;
        }
        "s3" => {
            https_origin(&po["endpoint"], &format!("{what}.endpoint"))?;
            let region_ok = po["region"].as_str().is_some_and(|r| (1..=32).contains(&r.len()) && r.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'));
            if !region_ok {
                return Err(format!("{what}.region must be 1 to 32 of a-z, 0-9 and -"));
            }
            let bucket_ok = po["bucket"].as_str().is_some_and(|b| {
                let x = b.as_bytes();
                let edge = |c: &u8| c.is_ascii_lowercase() || c.is_ascii_digit();
                (3..=63).contains(&x.len()) && edge(&x[0]) && edge(&x[x.len() - 1]) && x.iter().all(|c| edge(c) || *c == b'.' || *c == b'-')
            });
            if !bucket_ok {
                return Err(format!("{what}.bucket must be an S3 bucket name"));
            }
            if let Some(p) = po.get("prefix") {
                map_text(p, &format!("{what}.prefix"), MAP_TEXT_MAX, true)?;
            }
            let sse = po["sse"].as_str().filter(|s| S3_SSE.contains(s));
            if sse.is_none() {
                return Err(format!("{what}.sse must be s3, kms or none"));
            }
            if (sse == Some("kms")) != po.contains_key("kms_key") {
                return Err(format!("{what}.kms_key is needed with sse kms, and only then"));
            }
            if let Some(k) = po.get("kms_key") {
                map_text(k, &format!("{what}.kms_key"), MAP_KEY_MAX, false)?;
            }
        }
        _ => {
            if !po["share"].as_str().is_some_and(place_ok) {
                return Err(format!("{what}.share must be 1 to 32 of a-z, 0-9 and -"));
            }
            if let Some(f) = po.get("folder") {
                map_text(f, &format!("{what}.folder"), MAP_TEXT_MAX, true)?;
            }
        }
    }
    Ok((pid.to_string(), provider.to_string(), connector))
}

/// 6.2's map rules (Bad naming the field). With the org's current `policy`: `org` must be the policy's and every
/// `connector` principal an `apps.` name of its domains. A non-empty `connector` is then refused (until SD-1e).
pub fn check_storage_map(storage_map: &Value, policy: Option<&Obj>) -> Result<(), PolicyError> {
    let m = keys(storage_map, MAP_KEYS, MAP_REQUIRED, "the storage map")?;
    canonical_json(storage_map)?; // no null, no float anywhere
    if pj::as_int(m.get("v")) != Some(1) {
        return Err(bad("the storage map must be version 1"));
    }
    let Some(org) = m["org"].as_str().filter(|o| place_ok(o)) else {
        return Err(bad("org must be 1 to 32 of a-z, 0-9 and -"));
    };
    if policy.is_some_and(|p| p.get("org").and_then(Value::as_str) != Some(org)) {
        return Err(bad("the storage map's org is not the policy's"));
    }
    int(&m["seq"], "seq", 1, MAX_INT)?;
    int(&m["issued"], "issued", 1, MAX_INT)?;
    if let Some(ms) = m.get("microsoft") {
        let ms = keys(ms, &["client_id", "tenant"], &["client_id", "tenant"], "microsoft")?;
        for k in ["client_id", "tenant"] {
            if !ms[k].as_str().is_some_and(guid_ok) {
                return Err(PolicyError::Bad(format!("microsoft.{k} must be a lower-case GUID")));
            }
        }
        if ms["tenant"].as_str() == Some(PERSONAL_TENANT) {
            return Err(bad("microsoft.tenant cannot be the personal Microsoft accounts tenant"));
        }
    }
    let mut ids: Vec<String> = Vec::new();
    let (mut connectors, mut sharepoint) = (false, false);
    for place in list(&m["places"], "places", MAP_PLACES_MAX, 0)? {
        let (pid, provider, connector) = check_place(place, policy)?;
        if ids.contains(&pid) {
            return Err(PolicyError::Bad(format!("places lists {pid} twice")));
        }
        ids.push(pid);
        connectors |= connector;
        sharepoint |= provider == "sharepoint";
    }
    if sharepoint && !m.contains_key("microsoft") {
        return Err(bad("microsoft (client_id and tenant) is required for a sharepoint place"));
    }
    if connectors {
        return Err(refused(CONNECTORS_REFUSED));
    }
    Ok(())
}

/// `lp("lucid-meet-org-storage-v1", canonical JSON of the map)` (empty JSON for a map canonical JSON refuses: every
/// caller checks the map first).
pub fn storage_map_bytes(storage_map: &Obj) -> Vec<u8> {
    let mut out = String::new();
    let json = match enc_obj(storage_map, &mut out) {
        Ok(()) => out.into_bytes(),
        Err(_) => Vec::new(),
    };
    lp(&[MAP_LABEL.as_bytes(), &json])
}

/// A verified signed org storage map.
#[derive(Clone, Debug)]
pub struct VerifiedMap {
    pub wire: Obj,
    pub org: String,
    pub seq: i64,
    pub hash: String,
    /// "root" or the intermediate's serial (hex).
    pub signer: String,
}

/// A relay's or device's check of a signed storage map, as `verify` checks a policy: the root-signed signer policy,
/// the signature by the root or the signer's current (or previous) intermediate valid at `issued` and not in the
/// root's CRL, `check_storage_map`, then an org the root assigned domains to.
pub fn verify_storage_map(
    wire: &Value,
    root: &Cert,
    signer_policy: &Obj,
    root_crl: Option<&Crl>,
    previous_serial: &str,
    now: f64,
) -> Result<VerifiedMap, PolicyError> {
    let w = keys(wire, MAP_WIRE_KEYS, MAP_WIRE_KEYS, "the signed storage map")?;
    if canonical_json(wire)?.len() > MAP_MAX {
        return Err(bad("the signed storage map is larger than 256 KB"));
    }
    if !verify_signer_policy(root, signer_policy) {
        return Err(refused("the signer policy is not signed by the root"));
    }
    let terms = signer_terms(signer_policy)?;
    let m = keys(&w["map"], MAP_KEYS, MAP_REQUIRED, "the storage map")?;
    let issued = int(&m["issued"], "issued", 1, MAX_INT)?;
    if issued as f64 > now + SKEW as f64 {
        return Err(refused("the storage map is dated in the future"));
    }
    let sig = pj::b64_strict(&pj::py_str(&w["sig"])).ok_or("sig must be base64")?;
    canonical_json(&w["map"])?;
    let data = storage_map_bytes(m);
    let chain = match &w["chain"] {
        Value::Array(c) if c.len() <= 1 && c.iter().all(Value::is_string) => c,
        _ => return Err(bad("chain must be [] or [one intermediate PEM]")),
    };
    let inter = chain
        .first()
        .and_then(Value::as_str)
        .map(|pem| Some(pem).filter(|p| p.is_ascii()).and_then(Cert::from_pem).ok_or("the chain is not a certificate"))
        .transpose()?;
    let signer = match &inter {
        Some(c) => check_intermediate(c, root, &terms, previous_serial, issued, root_crl)?,
        None => "root".to_string(),
    };
    let spki = inter.as_ref().map_or(&root.spki, |c| &c.spki);
    if !ecdsa_sha256_verified(spki, &data, &sig) {
        return Err(refused("the storage map's signature does not verify"));
    }
    check_storage_map(&w["map"], None)?;
    let org = pj::text_of(m, "org");
    if !terms.org_domains.contains_key(&org) {
        return Err(refused(DOMAIN_REFUSED));
    }
    Ok(VerifiedMap {
        wire: w.clone(),
        org,
        seq: pj::as_int(m.get("seq")).unwrap_or(0),
        hash: sha256_hex(&data),
        signer,
    })
}

/// What a relay keeps (13.5, SD1-R14): per org the newest storage map and the one the org's current policy names by
/// `map_sha256` (at most 2 per org, 64 orgs), so a map uploaded before the policy is re-signed breaks nobody.
#[derive(Default)]
pub struct MapStore {
    pub newest: IndexMap<String, VerifiedMap>,
    pub kept: IndexMap<String, IndexMap<String, VerifiedMap>>,
}

impl MapStore {
    /// Verify and keep one signed map. `named`: the `map_sha256` of the org's current policy ("" when none), kept
    /// even when it is not the newest. A `seq` not above the newest is refused unless it is that named map.
    #[allow(clippy::too_many_arguments)]
    pub fn accept_at(
        &mut self,
        wire: &Value,
        root: &Cert,
        signer_policy: &Obj,
        root_crl: Option<&Crl>,
        previous_serial: &str,
        now: f64,
        named: &str,
    ) -> Result<VerifiedMap, PolicyError> {
        let vm = verify_storage_map(wire, root, signer_policy, root_crl, previous_serial, now)?;
        if let Some(held) = self.kept.get(&vm.org).and_then(|h| h.get(&vm.hash)) {
            return Ok(held.clone());
        }
        match self.newest.get(&vm.org) {
            None if !self.kept.contains_key(&vm.org) && self.kept.len() >= MAP_ORGS_MAX => {
                return Err(refused("this relay already holds the storage maps of 64 organizations"));
            }
            Some(cur) if vm.seq <= cur.seq && vm.hash != named => {
                return Err(PolicyError::Refused(format!("that storage map's seq is not higher than {}", cur.seq)));
            }
            _ => {}
        }
        if self.newest.get(&vm.org).is_none_or(|cur| vm.seq > cur.seq) {
            self.newest.insert(vm.org.clone(), vm.clone());
        }
        self.kept.entry(vm.org.clone()).or_default().insert(vm.hash.clone(), vm.clone());
        self.prune(&vm.org, named);
        Ok(vm)
    }

    /// Keep only the org's newest map and the one its current policy names.
    pub fn prune(&mut self, org: &str, named: &str) {
        let newest = self.newest.get(org).map(|v| v.hash.clone()).unwrap_or_default();
        if let Some(held) = self.kept.get_mut(org) {
            held.retain(|h, _| *h == newest || h == named);
        }
    }

    /// `GET /v1/org/storage?org=` (the newest) or `&sha256=` (that kept map).
    pub fn get(&self, org: &str, sha256: &str) -> Option<&Obj> {
        if sha256.is_empty() {
            self.newest.get(org).map(|v| &v.wire)
        } else {
            self.kept.get(org).and_then(|h| h.get(&sha256.to_lowercase())).map(|v| &v.wire)
        }
    }

    /// Every kept map, by org and `seq` (what `ext["pc"]["maps"]` holds).
    pub fn persisted(&self) -> Vec<Value> {
        let mut orgs: Vec<&String> = self.kept.keys().collect();
        orgs.sort();
        let mut out = Vec::new();
        for org in orgs {
            let mut maps: Vec<&VerifiedMap> = self.kept[org].values().collect();
            maps.sort_by_key(|v| v.seq);
            out.extend(maps.into_iter().map(|v| Value::Object(v.wire.clone())));
        }
        out
    }
}

/// NT-1 section 3.9: the policy turns message previews off for the people it covers.
pub fn previews_off(policy: &Obj) -> bool {
    policy.get("notify").and_then(|n| n.get("previews")).and_then(Value::as_str) == Some("off")
}

pub const NOTIFY_TOO_SOON: &str = "Message previews can be turned off by policy once every Hub and iPhone runs 0.97.0 or later";
pub const VIDEO_TOO_SOON: &str = "A team background can be set by policy once every Hub and iPhone runs 0.98.0 or later";
/// NT-1 section 3.9 and BG-1 section 2.2: each gated key, the Hub and iPhone releases that first read it (older
/// devices refuse unknown keys), and the refusal.
const CLIENT_GATES: [(&str, [(&str, &str); 2], &str); 2] = [
    ("notify", [("hub", "0.97.0"), ("ios", "0.97.0")], NOTIFY_TOO_SOON),
    ("video", [("hub", "0.98.0"), ("ios", "0.98.0")], VIDEO_TOO_SOON),
];

/// client_gate: a policy with a key in CLIENT_GATES is signed only once the relay's minimums (`min_client` and the
/// release's) reach that key's release of both the Hub and the iPhone.
pub fn client_gate(policy: Option<&Value>, minimums: &Obj) -> Result<(), String> {
    let Some(p) = policy.and_then(Value::as_object) else { return Ok(()) };
    for (key, clients, needs) in CLIENT_GATES {
        let ready = clients.iter().all(|(app, least)| minimums.get(*app).map(|v| crate::meet::version_key(&pj::py_str(v)) >= crate::meet::version_key(least)).unwrap_or(false));
        if p.contains_key(key) && !ready {
            return Err(needs.into());
        }
    }
    Ok(())
}

/// True when the principal's domain is one of the policy's (never an `apps.` one).
pub fn covers(policy: &Obj, principal: &str) -> bool {
    let Ok((_, domain)) = split_principal(principal) else { return false };
    policy.get("domains").and_then(Value::as_array).is_some_and(|a| a.iter().any(|d| d.as_str() == Some(domain)))
}

/// One service a policy names.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Service {
    pub kind: String,
    pub principal: String,
    pub device: String,
}

/// The services the policy names (archive first).
pub fn services(policy: &Obj) -> Vec<Service> {
    let mut out = Vec::new();
    if let Some(a) = policy.get("archive").and_then(Value::as_object).filter(|a| !a.is_empty()) {
        out.push(Service { kind: "archive".into(), principal: pj::text_of(a, "principal"), device: pj::text_of(a, "device") });
    }
    for app in policy.get("apps").and_then(Value::as_array).into_iter().flatten() {
        if let Some(a) = app.as_object() {
            out.push(Service { kind: "app".into(), principal: pj::text_of(a, "principal"), device: pj::text_of(a, "device") });
        }
    }
    out
}

pub fn names_service(policy: &Obj, kind: &str, principal: &str, device: &str) -> bool {
    services(policy).iter().any(|s| s.kind == kind && s.principal == principal && s.device == device)
}

pub fn expired(policy: &Obj, now: f64) -> bool {
    int_of(policy.get("expires")) as f64 <= now
}

/// True when another org's current (unexpired) policy lists one of this policy's domains (`domain_claims`).
fn domain_claimed<'a>(policy: &Obj, others: impl Iterator<Item = &'a Obj>, now: f64) -> bool {
    let Some(mine) = policy.get("domains").and_then(Value::as_array) else { return false };
    others
        .filter(|o| o.get("org") != policy.get("org") && !expired(o, now))
        .any(|o| o.get("domains").and_then(Value::as_array).is_some_and(|d| d.iter().any(|x| mine.contains(x))))
}

// ---- verifying ------------------------------------------------------------------------------------------------

/// Python json.dumps(v, sort_keys=True, separators=(",", ":")) (ensure_ascii).
fn dumps_sorted(v: &Value, out: &mut String) {
    match v {
        Value::Object(o) => dumps_sorted_obj(o, "", out),
        Value::Array(a) => {
            out.push('[');
            for (i, item) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                dumps_sorted(item, out);
            }
            out.push(']');
        }
        other => out.push_str(&pj::dumps_compact(other)),
    }
}

fn dumps_sorted_obj(o: &Obj, skip: &str, out: &mut String) {
    let mut pairs: Vec<(&String, &Value)> = o.iter().filter(|(k, _)| skip.is_empty() || k.as_str() != skip).collect();
    pairs.sort_by(|a, b| a.0.cmp(b.0));
    out.push('{');
    for (i, (k, item)) in pairs.into_iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        pj::string_text(k, true, out);
        out.push(':');
        dumps_sorted(item, out);
    }
    out.push('}');
}

/// meet_pki.verify_policy: `policy_sig` is the root's ECDSA P-256 SHA-256 signature (base64 DER) over the
/// policy's compact sorted JSON without `policy_sig`.
pub fn verify_signer_policy(root: &Cert, policy: &Obj) -> bool {
    let Some(sig) = pj::b64_strict(&pj::s(policy, "policy_sig")) else { return false };
    let mut body = String::new();
    dumps_sorted_obj(policy, "policy_sig", &mut body);
    ecdsa_sha256_verified(&root.spki, body.as_bytes(), &sig)
}

/// A verified signed policy.
#[derive(Clone, Debug)]
pub struct Verified {
    pub wire: Obj,
    pub policy: Obj,
    pub org: String,
    pub label: String,
    pub seq: i64,
    pub hash: String,
    /// "root" or the intermediate's serial (hex).
    pub signer: String,
}

fn check_intermediate(
    inter: &Cert,
    root: &Cert,
    terms: &SignerTerms,
    previous_serial: &str,
    issued: i64,
    root_crl: Option<&Crl>,
) -> Result<String, PolicyError> {
    if !inter.ca {
        return Err(refused("an end-entity certificate never signs a policy"));
    }
    if !inter.issued_directly_by_root(root) {
        return Err(refused("the policy's signing certificate was not issued by the root"));
    }
    let previous = previous_serial.to_lowercase();
    if ![terms.intermediate_serial.as_str(), previous.as_str()].iter().any(|s| !s.is_empty() && *s == inter.serial) {
        return Err(refused("the policy was not signed by the signer's current signing certificate"));
    }
    if !(inter.not_before..=inter.not_after).contains(&issued) {
        return Err(refused("the policy's signing certificate was not valid when it was issued"));
    }
    let Some(crl) = root_crl else {
        return Err(refused("the root's revocation list is needed to check the signing certificate"));
    };
    if crl.issuer != root.subject || !crl.signature_valid(&root.spki) {
        return Err(refused("that revocation list is not the root's"));
    }
    if crl.serials.contains(&inter.serial) {
        return Err(refused("the policy's signing certificate was revoked"));
    }
    Ok(inter.serial.clone())
}

/// A device's (and the relay's) check of a signed policy: the root-signed signer policy, the signature by the root
/// or by the signer's current (or previous) intermediate valid at `issued` and not in the root's CRL, then every
/// field rule and the domains against `org_domains`.
pub fn verify(
    wire: &Value,
    root: &Cert,
    signer_policy: &Obj,
    root_crl: Option<&Crl>,
    previous_serial: &str,
    now: f64,
) -> Result<Verified, PolicyError> {
    let w = keys(wire, WIRE_KEYS, WIRE_KEYS, "the signed policy")?;
    if canonical_json(wire)?.len() > SIGNED_MAX {
        return Err(bad("the signed policy is larger than 64 KB"));
    }
    let chain = match &w["chain"] {
        Value::Array(c) if c.len() <= 1 && c.iter().all(Value::is_string) => c,
        _ => return Err(bad("chain must be [] or [one intermediate PEM]")),
    };
    if !verify_signer_policy(root, signer_policy) {
        return Err(refused("the signer policy is not signed by the root"));
    }
    let terms = signer_terms(signer_policy)?;
    let p = keys(&w["policy"], TOP_KEYS, REQUIRED, "the policy")?;
    let issued = int(&p["issued"], "issued", 1, MAX_INT)?;
    if issued as f64 > now + SKEW as f64 {
        return Err(refused("the policy is dated in the future"));
    }
    let sig = pj::b64_strict(&pj::py_str(&w["sig"])).ok_or("sig must be base64")?;
    let data = signed_bytes(p);
    let inter = chain
        .first()
        .and_then(Value::as_str)
        .map(|pem| Some(pem).filter(|p| p.is_ascii()).and_then(Cert::from_pem).ok_or("the chain is not a certificate"))
        .transpose()?;
    let signer = match &inter {
        Some(c) => check_intermediate(c, root, &terms, previous_serial, issued, root_crl)?,
        None => "root".to_string(),
    };
    let spki = inter.as_ref().map_or(&root.spki, |c| &c.spki);
    if !ecdsa_sha256_verified(spki, &data, &sig) {
        return Err(refused("the policy's signature does not verify"));
    }
    check_policy(&w["policy"], &terms)?;
    Ok(Verified {
        wire: w.clone(),
        policy: p.clone(),
        org: pj::text_of(p, "org"),
        label: pj::text_of(p, "label"),
        seq: pj::as_int(p.get("seq")).unwrap_or(0),
        hash: sha256_hex(&data),
        signer,
    })
}

// ---- the relay's store ----------------------------------------------------------------------------------------

/// What a relay keeps: the newest policy per org (at most 64 orgs) and older ones by `policy_hash` while a
/// member-log entry or DM wrap still names them (the wires, in Python dict insertion order).
#[derive(Default)]
pub struct Store {
    pub newest: IndexMap<String, Verified>,
    pub by_hash: IndexMap<String, Obj>,
}

impl Store {
    pub fn accept(
        &mut self,
        wire: &Value,
        root: &Cert,
        signer_policy: &Obj,
        root_crl: Option<&Crl>,
        previous_serial: &str,
    ) -> Result<Verified, PolicyError> {
        self.accept_at(wire, root, signer_policy, root_crl, previous_serial, pj::now())
    }

    pub fn accept_at(
        &mut self,
        wire: &Value,
        root: &Cert,
        signer_policy: &Obj,
        root_crl: Option<&Crl>,
        previous_serial: &str,
        now: f64,
    ) -> Result<Verified, PolicyError> {
        let v = verify(wire, root, signer_policy, root_crl, previous_serial, now)?;
        match self.newest.get(&v.org) {
            Some(cur) if v.hash == cur.hash => return Ok(cur.clone()),
            Some(cur) if v.seq <= cur.seq => {
                return Err(PolicyError::Refused(format!("that policy's seq is not higher than {}", cur.seq)));
            }
            Some(_) => {}
            None if self.newest.len() >= RELAY_MAX => {
                return Err(refused("this relay already holds 64 organization policies"));
            }
            None => {}
        }
        let others = self.newest.iter().filter(|(o, _)| **o != v.org).map(|(_, n)| &n.policy);
        if domain_claimed(&v.policy, others, now) {
            return Err(refused(DOMAIN_REFUSED));
        }
        self.newest.insert(v.org.clone(), v.clone());
        self.by_hash.insert(v.hash.clone(), v.wire.clone());
        Ok(v)
    }

    /// `GET /v1/org/policy?org=`: the newest.
    pub fn get_org(&self, org: &str) -> Option<&Obj> {
        self.newest.get(org).map(|v| &v.wire)
    }

    /// `GET /v1/org/policy?sha256=`: any kept.
    pub fn get_sha256(&self, digest: &str) -> Option<&Obj> {
        self.by_hash.get(&digest.to_lowercase())
    }

    /// `org_policies` for `/v1/hello`: every org's newest, by org id.
    pub fn current(&self) -> Vec<Value> {
        let mut all: Vec<&Verified> = self.newest.values().collect();
        all.sort_by(|a, b| a.org.cmp(&b.org));
        all.into_iter().map(|v| Value::Object(v.wire.clone())).collect()
    }

    /// Drop older policies no log entry or wrap names any more (newest ones stay).
    pub fn prune(&mut self, named: &HashSet<String>) {
        let keep: HashSet<String> =
            named.iter().map(|h| h.to_lowercase()).chain(self.newest.values().map(|v| v.hash.clone())).collect();
        self.by_hash.retain(|h, _| keep.contains(h));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const VECTORS: &str = include_str!("../tests/org_policy_v1.json");

    struct Doc {
        doc: Value,
        root: Cert,
        crl: Crl,
        now: f64,
    }

    fn doc() -> Doc {
        let doc: Value = serde_json::from_str(VECTORS).unwrap();
        let root = Cert::from_pem(doc["root_pem"].as_str().unwrap()).unwrap();
        let crl = Crl::from_pem(doc["root_crl_pem"].as_str().unwrap().as_bytes()).unwrap();
        let now = doc["now"].as_f64().unwrap();
        Doc { doc, root, crl, now }
    }

    #[test]
    fn the_org_policy_vectors_give_the_expected_verdicts() {
        let d = doc();
        let cases = d.doc["cases"].as_array().unwrap();
        let names: HashSet<&str> = cases.iter().filter_map(|c| c["name"].as_str()).collect();
        for n in ["root_signed", "intermediate_signed", "person_certificate_signed", "expired_intermediate", "domain_outside_org_domains"] {
            assert!(names.contains(n), "{n}");
        }
        for case in cases {
            let sp = case["signer_policy"].as_object().unwrap();
            assert!(verify_signer_policy(&d.root, sp), "{}", case["name"]);
            let (verdict, digest) = match verify(&case["signed"], &d.root, sp, Some(&d.crl), "", d.now) {
                Ok(v) => ("ok".to_string(), v.hash),
                Err(e) => (e.to_string(), String::new()),
            };
            assert_eq!(verdict, case["expect"].as_str().unwrap(), "{}", case["name"]);
            if !digest.is_empty() {
                assert_eq!(digest, case["policy_hash"].as_str().unwrap());
                assert_eq!(policy_hash(case["signed"]["policy"].as_object().unwrap()), digest);
            }
        }
    }

    #[test]
    fn the_root_and_the_intermediate_sign_and_the_crl_is_needed() {
        let d = doc();
        let cases = d.doc["cases"].as_array().unwrap();
        let root = &cases[0];
        let v = verify(&root["signed"], &d.root, root["signer_policy"].as_object().unwrap(), None, "", d.now).unwrap();
        assert_eq!((v.signer.as_str(), v.org.as_str(), v.label.as_str(), v.seq), ("root", "acme", "Acme", 7));
        let inter = &cases[1];
        let sp = inter["signer_policy"].as_object().unwrap();
        let v = verify(&inter["signed"], &d.root, sp, Some(&d.crl), "", d.now).unwrap();
        assert_eq!(v.signer, "2001");
        let e = verify(&inter["signed"], &d.root, sp, None, "", d.now).unwrap_err();
        assert_eq!(e, PolicyError::Refused("the root's revocation list is needed to check the signing certificate".into()));
        // Signed before it was issued: dated in the future.
        let e = verify(&root["signed"], &d.root, root["signer_policy"].as_object().unwrap(), None, "", 1_700_000_000.0).unwrap_err();
        assert_eq!(e, PolicyError::Refused("the policy is dated in the future".into()));
    }

    #[test]
    fn the_store_keeps_the_newest_and_old_ones_by_hash() {
        let d = doc();
        let case = &d.doc["cases"][0];
        let sp = case["signer_policy"].as_object().unwrap();
        let mut store = Store::default();
        let v = store.accept_at(&case["signed"], &d.root, sp, Some(&d.crl), "", d.now).unwrap();
        let again = store.accept_at(&case["signed"], &d.root, sp, Some(&d.crl), "", d.now).unwrap();
        assert_eq!(again.hash, v.hash);
        assert_eq!(store.current().len(), 1);
        assert!(store.get_org("acme").is_some());
        assert!(store.get_sha256(&v.hash.to_uppercase()).is_some());
        store.prune(&HashSet::new());
        assert_eq!(store.by_hash.len(), 1);
        let p = v.policy;
        assert!(covers(&p, "ann@acme.com") && !covers(&p, "ann@apps.acme.com") && !covers(&p, "nobody"));
        assert!(names_service(&p, "archive", "archive@apps.acme.com", "e5e5e5e5e5e5e5e5"));
        assert!(!expired(&p, d.now) && expired(&p, 1_796_592_000.0));
    }

    #[test]
    fn canonical_json_sorts_escapes_and_refuses() {
        let v = json!({"b": 1, "a": [true, "\u{1}\n\"\\\u{7f}é"], "": -5});
        assert_eq!(String::from_utf8(canonical_json(&v).unwrap()).unwrap(), "{\"\":-5,\"a\":[true,\"\\u0001\\n\\\"\\\\\u{7f}é\"],\"b\":1}");
        assert_eq!(canonical_json(&json!({"a": null})).unwrap_err(), ONLY_JSON);
        assert_eq!(canonical_json(&json!(1.5)).unwrap_err(), ONLY_JSON);
        assert_eq!(canonical_json(&json!(9_007_199_254_740_992_i64)).unwrap_err(), "an integer is out of range");
        assert_eq!(canonical_json(&json!(u64::MAX)).unwrap_err(), "an integer is out of range");
        assert_eq!(lp(&[b"ab", b""]), vec![0, 0, 0, 2, b'a', b'b', 0, 0, 0, 0]);
    }

    #[test]
    fn field_rules_give_the_python_words() {
        let d = doc();
        let case = &d.doc["cases"][0];
        let terms = signer_terms(case["signer_policy"].as_object().unwrap()).unwrap();
        assert_eq!(terms.org_of("beta.com"), "beta");
        let base = case["signed"]["policy"].as_object().unwrap().clone();
        let check = |extra: Value| {
            let mut p = base.clone();
            for (k, v) in extra.as_object().unwrap() {
                p.insert(k.clone(), v.clone());
            }
            check_policy(&Value::Object(p), &terms).err().map(|e| e.to_string()).unwrap_or_default()
        };
        assert_eq!(check(json!({})), "");
        assert_eq!(check(json!({"zz": 1, "aa": 2})), "the policy has unknown fields: aa, zz");
        assert_eq!(check(json!({"seq": 0})), "seq must be a whole number from 1 to 9007199254740991");
        assert_eq!(check(json!({"admins": ["Bob@acme.com"]})), "'Bob@acme.com' is not a lower-case email");
        assert_eq!(check(json!({"admins": ["bob@beta.com"]})), "admins: bob@beta.com is not covered by this policy's domains");
        assert_eq!(check(json!({"admins": ["a@acme.com", "a@acme.com"]})), "admins lists an entry twice");
        assert_eq!(check(json!({"domains": ["beta.com"]})), DOMAIN_REFUSED);
        assert_eq!(check(json!({"label": ""})), "label must be printable text of at most 64 characters");
        assert_eq!(check(json!({"expires": 1794000000})), "expires must be after issued, at most 90 days later");
        assert_eq!(check(json!({"retention": {"canvas": -1}})), "retention.canvas must be a whole number from 0 to 3650");
        // NT-1 section 3.9: notify is {"previews": "off"} and nothing else
        assert_eq!(check(json!({"notify": {"previews": "off"}})), "");
        for refused in [json!({"previews": "on"}), json!({}), json!({"previews": "off", "x": 1}), json!("off"), json!({"previews": true})] {
            assert_eq!(check(json!({ "notify": refused })), "notify must be {\"previews\": \"off\"}");
        }
        let mut off = base.clone();
        assert!(!previews_off(&off));
        off.insert("notify".into(), json!({"previews": "off"}));
        assert!(previews_off(&off));
        // signing one waits for the NT-1 Hub and iPhone releases in the relay's minimums
        let mins = |v: Value| v.as_object().unwrap().clone();
        let with_notify = Value::Object(off.clone());
        assert_eq!(client_gate(Some(&with_notify), &mins(json!({"hub": "0.97.0", "ios": "0.97.1"}))), Ok(()));
        for early in [json!({}), json!({"hub": "0.97.0"}), json!({"hub": "0.96.9", "ios": "0.97.0"}), json!({"hub": "0.97", "ios": "0.9.70"})] {
            assert_eq!(client_gate(Some(&with_notify), &mins(early)).unwrap_err(), NOTIFY_TOO_SOON);
        }
        assert_eq!(client_gate(Some(&Value::Object(base.clone())), &Obj::new()), Ok(()));
        assert_eq!(client_gate(None, &Obj::new()), Ok(()));

        // BG-1 section 2.1: video
        let img = "ab".repeat(32);
        for ok in [json!({"background": "none"}), json!({"background": "blur", "change": "refuse"}), json!({"background": "team", "team_image": img, "change": "allow"}), json!({"background": "blur", "team_image": img})] {
            assert_eq!(check(json!({ "video": ok })), "");
        }
        assert_eq!(check(json!({"video": {"background": "none", "zz": 1}})), "video has unknown fields: zz");
        assert_eq!(check(json!({"video": {"background": "photo"}})), "video.background must be none, blur or team");
        assert_eq!(check(json!({"video": {"background": 1}})), "video.background must be none, blur or team");
        assert_eq!(check(json!({"video": {"background": "blur", "team_image": "AB".repeat(32)}})), "video.team_image must be 64 lower-case hex digits");
        assert_eq!(check(json!({"video": {"background": "blur", "team_image": "ab"}})), "video.team_image must be 64 lower-case hex digits");
        assert_eq!(check(json!({"video": {"background": "team"}})), "a team background needs video.team_image");
        assert_eq!(check(json!({"video": {"background": "none", "change": "deny"}})), "video.change must be allow or refuse");
        let mut v = base.clone();
        assert_eq!(video(Some(&v)), None);
        assert_eq!(video_default(Some(&v)), "");
        assert_eq!(video_default(None), "");
        v.insert("video".into(), json!({"background": "team", "team_image": img}));
        assert_eq!(video(Some(&v)), Some(("team".into(), img.clone(), "allow".into())));
        assert_eq!(video_default(Some(&v)), format!("team:{img}"));
        v.insert("video".into(), json!({"background": "blur", "change": "refuse"}));
        assert_eq!(video_default(Some(&v)), "blur");
        // BG-1 section 2.2: signing one waits for 0.98.0, and notify still waits for 0.97.0
        let with_video = Value::Object(v.clone());
        assert_eq!(client_gate(Some(&with_video), &mins(json!({"hub": "0.98.0", "ios": "0.98.1"}))), Ok(()));
        for early in [json!({}), json!({"hub": "0.98.0"}), json!({"hub": "0.97.9", "ios": "0.98.0"})] {
            assert_eq!(client_gate(Some(&with_video), &mins(early)).unwrap_err(), VIDEO_TOO_SOON);
        }
        v.insert("notify".into(), json!({"previews": "off"}));
        assert_eq!(client_gate(Some(&Value::Object(v)), &mins(json!({"hub": "0.96.0", "ios": "0.96.0"}))).unwrap_err(), NOTIFY_TOO_SOON);
    }

    // ---- AI-1: tests/vectors/ai_policy_v1.json of Meeting Hub (copied here as tests/ai_policy_v1.json) ----

    const AI_VECTORS: &str = include_str!("../tests/ai_policy_v1.json");

    fn verdict<T, E: std::fmt::Display>(r: Result<T, E>) -> String {
        r.err().map(|e| e.to_string()).unwrap_or_else(|| "ok".into())
    }

    #[test]
    fn the_ai_policy_vectors_give_the_expected_verdicts() {
        let doc: Value = serde_json::from_str(AI_VECTORS).unwrap();
        let root = Cert::from_pem(doc["root_pem"].as_str().unwrap()).unwrap();
        let sp = doc["signer_policy"].as_object().unwrap();
        assert!(verify_signer_policy(&root, sp));
        let terms = signer_terms(sp).unwrap();
        let now = doc["now"].as_f64().unwrap();
        let mut seen = 0;
        for c in doc["policies"].as_array().unwrap() {
            let t = SignerTerms { enclave: c["enclave"].as_bool().unwrap(), ..terms.clone() };
            assert_eq!(verdict(check_policy(&c["policy"], &t)), c["expect"].as_str().unwrap(), "policies/{}", c["name"]);
            seen += 1;
        }
        for c in doc["gates"].as_array().unwrap() {
            let got = verdict(ai_gate(Some(&c["policy"]), c["min_client"].as_object().unwrap()));
            assert_eq!(got, c["expect"].as_str().unwrap(), "gates/{}", c["name"]);
            seen += 1;
        }
        for c in doc["editions"].as_array().unwrap() {
            let edition = c["license"].get("edition").and_then(Value::as_str);
            let got = verdict(ai_edition_gate(c["policy"].as_object().unwrap(), edition));
            assert_eq!(got, c["expect"].as_str().unwrap(), "editions/{}", c["name"]);
            seen += 1;
        }
        for c in doc["maps"].as_array().unwrap() {
            let policy = c["policy"].as_object().unwrap();
            let label = pj::s(policy, "label");
            let got = (|| -> Result<(), PolicyError> {
                let vm = verify_ai_map(&c["signed"], &root, sp, None, "", now, Some(policy))?;
                check_ai_map_named(policy, &vm.hash)?;
                // AiMapPins.apply against a pin of `pinned_seq` with another hash
                let pinned = c["pinned_seq"].as_i64().unwrap();
                if pinned > 0 && vm.seq < pinned {
                    return Err(PolicyError::Refused(format!("{label}'s AI map was rolled back, so it was not used.")));
                }
                if pinned > 0 && vm.seq == pinned {
                    return Err(PolicyError::Refused(format!("{label}'s AI map could not be verified: two different versions were seen.")));
                }
                Ok(())
            })();
            assert_eq!(verdict(got), c["expect"].as_str().unwrap(), "maps/{}", c["name"]);
            seen += 1;
        }
        for c in doc["sso_ai_groups"].as_array().unwrap() {
            let org = c["post"].get("org");
            let policy = c["policies"].as_array().unwrap().iter().filter_map(Value::as_object).find(|p| p.get("org") == org);
            let stored = c["stored"].as_object().unwrap();
            let held = |p: &str| stored.get(p).and_then(Value::as_i64).unwrap_or(0);
            let got = verdict(check_ai_groups(&c["post"], c["caller_serial"].as_str().unwrap(), &terms, policy, &held, c["now"].as_f64().unwrap()));
            assert_eq!(got, c["expect"].as_str().unwrap(), "sso_ai_groups/{}", c["name"]);
            seen += 1;
        }
        for c in doc["allowed"].as_array().unwrap() {
            let record = c["record"].as_object().map(|r| AiGroupRecord {
                principal: c["principal"].as_str().unwrap().into(),
                listed: r["listed"].as_array().unwrap().iter().map(|g| g.as_str().unwrap().to_string()).collect(),
                read_at: r["read_at"].as_i64().unwrap(),
            });
            let (allowed, read_at) = ai_allowed(
                c["principal"].as_str().unwrap(),
                c["policy"].as_object(),
                c["map"].as_object(),
                record.as_ref(),
                c["now"].as_f64().unwrap(),
                AI_GROUPS_FRESH_S,
            );
            assert_eq!(json!({"allowed": allowed, "read_at": read_at}), c["expect"], "allowed/{}", c["name"]);
            seen += 1;
        }
        assert!(seen > 50, "only {seen} cases");
        assert!(doc["ai_max_bytes"].as_u64().unwrap() < 32 * 1024);
    }

    #[test]
    fn the_ai_map_store_keeps_the_newest_and_the_named_map() {
        let doc: Value = serde_json::from_str(AI_VECTORS).unwrap();
        let root = Cert::from_pem(doc["root_pem"].as_str().unwrap()).unwrap();
        let sp = doc["signer_policy"].as_object().unwrap();
        let now = doc["now"].as_f64().unwrap();
        let ok: Vec<&Value> = doc["maps"].as_array().unwrap().iter().filter(|c| c["expect"] == "ok").collect();
        assert!(!ok.is_empty());
        let mut store = AiMapStore::default();
        let v = store.accept_at(&ok[0]["signed"], &root, sp, None, "", now, "").unwrap();
        // the same map again is kept once
        assert_eq!(store.accept_at(&ok[0]["signed"], &root, sp, None, "", now, "").unwrap().hash, v.hash);
        assert_eq!(store.get(&v.org, "").map(|m| m.hash.clone()), Some(v.hash.clone()));
        assert_eq!(store.get(&v.org, &v.hash.to_uppercase()).map(|m| m.seq), Some(v.seq));
        assert!(store.get(&v.org, &"0".repeat(64)).is_none());
        assert_eq!(store.persisted(), vec![Value::Object(v.wire.clone())]);
        assert_eq!(ai_map_hash(v.wire["map"].as_object().unwrap()), v.hash);
    }

    // ---- SD-1b: tests/vectors/org_storage_v1.json of the add-on (copied here as tests/org_storage_v1.json) ----

    const STORAGE_VECTORS: &str = include_str!("../tests/org_storage_v1.json");

    fn storage_doc() -> Doc {
        let doc: Value = serde_json::from_str(STORAGE_VECTORS).unwrap();
        let root = Cert::from_pem(doc["root_pem"].as_str().unwrap()).unwrap();
        let crl = Crl::from_pem(doc["root_crl_pem"].as_str().unwrap().as_bytes()).unwrap();
        let now = doc["now"].as_f64().unwrap();
        Doc { doc, root, crl, now }
    }

    #[test]
    fn the_org_storage_vectors_give_the_expected_verdicts() {
        let d = storage_doc();
        // the policy's `storage` and `sharing` as a device checks them; this relay's signer terms stop at version 2,
        // so the version 3 cases (the registry cloud check) are the signer's and the devices'
        let mut skipped: Vec<&str> = Vec::new();
        for case in d.doc["policy_cases"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let Ok(terms) = signer_terms(case["signer_policy"].as_object().unwrap()) else {
                skipped.push(name);
                continue;
            };
            let verdict = check_policy(&case["policy"], &terms).err().map(|e| e.to_string()).unwrap_or_else(|| "ok".into());
            assert_eq!(verdict, case["expect"].as_str().unwrap(), "{name}");
        }
        skipped.sort_unstable();
        assert_eq!(skipped, ["cloud_differs_from_the_entra_provider", "cloud_matches_the_entra_provider"]);
        for case in d.doc["gate_cases"].as_array().unwrap() {
            let verdict = storage_gate(Some(&case["policy"]), case["min_client"].as_object().unwrap()).err().unwrap_or_else(|| "ok".into());
            assert_eq!(verdict, case["expect"].as_str().unwrap(), "{}", case["name"]);
        }
        for case in d.doc["map_cases"].as_array().unwrap() {
            let sp = case["signer_policy"].as_object().unwrap();
            assert!(verify_signer_policy(&d.root, sp), "{}", case["name"]);
            let verdict = match verify_storage_map(&case["signed"], &d.root, sp, Some(&d.crl), "", d.now) {
                Ok(v) if Some(v.hash.as_str()) == case["map_sha256"].as_str() => "ok".to_string(),
                Ok(_) => "hash differs".to_string(),
                Err(e) => e.to_string(),
            };
            assert_eq!(verdict, case["expect"].as_str().unwrap(), "{}", case["name"]);
        }
    }

    #[test]
    fn the_map_store_keeps_a_map_once_and_refuses_an_org_without_domains() {
        let d = storage_doc();
        let cases = d.doc["map_cases"].as_array().unwrap();
        let case = |name: &str| cases.iter().find(|c| c["name"] == name).unwrap();
        let root_signed = case("root_signed");
        let sp = root_signed["signer_policy"].as_object().unwrap();
        let mut store = MapStore::default();
        let v = store.accept_at(&root_signed["signed"], &d.root, sp, Some(&d.crl), "", d.now, "").unwrap();
        assert_eq!((v.org.as_str(), v.seq, v.signer.as_str()), ("acme", 3, "root"));
        let inter = case("intermediate_signed");
        let again = store
            .accept_at(&inter["signed"], &d.root, inter["signer_policy"].as_object().unwrap(), Some(&d.crl), "", d.now, "")
            .unwrap();
        assert_eq!(again.hash, v.hash); // the same map: kept once
        assert_eq!(store.get("acme", ""), Some(&v.wire));
        assert_eq!(store.get("acme", &v.hash.to_uppercase()), Some(&v.wire));
        assert_eq!(store.get("acme", &"0".repeat(64)), None);
        assert_eq!(store.get("beta", ""), None);
        assert_eq!(store.persisted(), vec![Value::Object(v.wire.clone())]);
        let gamma = case("org_without_domains");
        let e = store.accept_at(&gamma["signed"], &d.root, sp, Some(&d.crl), "", d.now, "").unwrap_err();
        assert_eq!(e, PolicyError::Refused(DOMAIN_REFUSED.into()));
        store.prune("acme", "");
        assert_eq!(store.kept["acme"].len(), 1);
    }

    #[test]
    fn labels_origins_and_the_storage_gate() {
        for (text, words) in [
            ("Acme SharePoint", ""),
            ("\u{c9}quipe (Paris) & Co.'s-sites 2", ""),
            ("Acme\u{202e}NAS", "must not contain Unicode format characters"),
            ("Acme\u{200b}NAS", "must not contain Unicode format characters"),
            ("\u{2066}Acme\u{2069}", "must not contain Unicode format characters"),
            ("\u{feff}Acme", "must not contain Unicode format characters"),
            ("Acme NAS!", "may hold only letters, digits, spaces and .,()&'-"),
            ("Acme\tNAS", "may hold only letters, digits, spaces and .,()&'-"),
            ("", "must be 1 to 64 characters"),
        ] {
            let got = check_place_label(&json!(text), "x").err().unwrap_or_default();
            let want = if words.is_empty() { String::new() } else { format!("x {words}") };
            assert_eq!(got, want, "{text:?}");
        }
        assert_eq!(check_place_label(&json!("N".repeat(64)), "x"), Ok(()));
        assert!(check_place_label(&json!("N".repeat(65)), "x").is_err());
        for ok in ["https://s3.example.com", "https://s3.example.com/", "HTTPS://c.acme.internal:9443", "https://[::1]:443"] {
            assert_eq!(https_origin(&json!(ok), "u"), Ok(()), "{ok}");
        }
        for no in ["http://s3.example.com", "https://s3.example.com/a", "https://u@h", "https://h?x=1", "https://h#f", "https://h:0", "https://h:99999", "https://h:x", "https://", "https:h", "s3.example.com"] {
            assert_eq!(https_origin(&json!(no), "u"), Err("u must be an https:// origin".to_string()), "{no}");
        }
        let mins = |v: Value| v.as_object().unwrap().clone();
        let with_storage = json!({"storage": {}});
        assert_eq!(storage_gate(Some(&with_storage), &mins(json!({"hub": "0.98.0", "ios": "1.0.0"}))), Ok(()));
        for early in [json!({}), json!({"hub": "0.98.0"}), json!({"ios": "0.98.0"}), json!({"hub": "0.97.9", "ios": "0.98.0"})] {
            assert_eq!(storage_gate(Some(&with_storage), &mins(early)).unwrap_err(), STORAGE_TOO_SOON);
        }
        assert_eq!(storage_gate(Some(&json!({"seq": 1})), &Obj::new()), Ok(()));
    }
}
