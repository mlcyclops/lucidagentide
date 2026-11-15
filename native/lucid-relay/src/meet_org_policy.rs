// Phase C (ADR-0540): relay/meet_org_policy.py (contract PC-1, "Org policy") as the relay needs it: CE-1
// canonical JSON, the signed bytes and hash of an org policy, the root-signed signer policy's version 2 terms, every
// field rule and limit of an org policy, its verification (root or the signer's intermediate, the root's CRL) and
// the relay's store of signed policies. The same bytes and the same words as the Python module; the issuer-side
// signing helpers and the SSO byte layouts stay in Python (the relay never signs).

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
const RETENTION_KINDS: &[&str] = &["dm", "group", "channel", "files", "canvas"];
const RETENTION_MAX: i64 = 3650;
const APP_TYPES: &[&str] = &["bot", "webhook", "workflows"];
const SCOPES: &[&str] = &["mentions", "all"];
const EXTERNAL_ARCHIVES: &[&str] = &["allow", "refuse"];
const APPS_PREFIX: &str = "apps.";
const TOP_KEYS: &[&str] = &[
    "v", "org", "label", "domains", "seq", "issued", "expires", "admins", "archive", "archive_reviewers", "apps",
    "workflows", "external_archives", "external_apps", "retention",
];
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
    Ok(SignerTerms { org_domains, org_admins, intermediate_serial: serial })
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
            return Err(bad("an app's type must be bot, webhook or workflows"));
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
    }
}
