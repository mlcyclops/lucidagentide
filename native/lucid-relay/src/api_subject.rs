// API-1 revision 5 (docs/api/contract-r5-1c.md) 4.3, R5-1: SSO-signed person records.
//
// The org's SSO service signs one record per person, `{org, provider, iss, sub, principal, active, stale_at, groups,
// ts}`, with its `urn:lucid-meet:sso` key over `lp("lucid-meet-sso-person-v1", canonical_json(record))`, and posts
// them to its relay (`POST /v1/sso/c/persons`). The relay keeps the newest record per (org, provider, principal)
// with the caller's certificate PEM, in state.json `ext["sso_persons"]` (meet_parity_c `sso_persons`), and answers
// the console's fleet op `api-subject` with it. The console (`verify_answer`) trusts a record only when the
// certificate is the registry's SSO service of (org, provider) issued by its root and the signature verifies; the
// relay is never trusted to say who a person is.

use crate::fleet_wire::Refusal;
use crate::meet::{bad, forbidden, log_info, Identity, E, R};
use crate::meet_hub::{pc, Hub};
use crate::meet_json::{self as pj, obj, Obj};
use crate::meet_org_policy::{self as op, IdentityProvider};
use crate::meet_x509::{ecdsa_sha256_verified, Cert};
use serde_json::{json, Value};
use std::collections::HashMap;

pub const PERSON_LABEL: &str = "lucid-meet-sso-person-v1";
/// The record's keys, exactly.
pub const RECORD_KEYS: [&str; 9] = ["org", "provider", "iss", "sub", "principal", "active", "stale_at", "groups", "ts"];
const WIRE_KEYS: [&str; 2] = ["record", "sig"];
const POST_KEYS: [&str; 3] = ["org", "provider", "records"];
/// Records in one post.
pub const RECORDS_MAX: usize = 500;
/// `POST /v1/sso/c/persons`: 500 records of at most about 1 KiB.
pub const BODY_MAX: usize = 768 * 1024;
/// The `api-subject` answer's limit (a stored record with its certificate PEM is refused at post when larger).
pub const ANSWER_MAX: usize = 8 * 1024;
/// A record's text values.
const TEXT_MAX: usize = 512;
const GROUPS_MAX: usize = 256;
const GROUP_MAX: usize = 128;
/// A DER ECDSA P-256 signature is at most 72 bytes (96 base64 characters).
const SIG_MAX: usize = 128;
const MAX_INT: i64 = (1 << 53) - 1;
/// `verify_answer`: a record may be dated at most this far ahead, and fresh for at most a day.
const SKEW: i64 = 60;
const FRESH_MAX: i64 = 86_400;

const POST_SHAPE: &str = "persons must be {org, provider, records} with 1 to 500 records";
const WIRE_SHAPE: &str = "a person record is {record: {org, provider, iss, sub, principal, active, stale_at, groups, ts}, sig}";
const OTHER_ORG: &str = "a record names another organization or provider than the post";
const TWICE: &str = "a post names a principal twice";
const TOO_BIG: &str = "a person record with the service's certificate must fit in 8 KiB";
const NOT_REGISTERED: &str = "this sign-in service is not the registered one of that organization and provider";
const ISS_BAD: &str = "a record's iss is not the registered identity provider's";
const SIG_BAD: &str = "a record's signature does not verify with this sign-in service's key";
const NO_POLICY: &str = "the organization has no current policy";
const NOT_COVERED: &str = "a record names a person the organization's policy does not cover";
const NOT_NEWER: &str = "a record is not newer than the one held";

/// One SSO-signed person record.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PersonRecord {
    pub org: String,
    pub provider: String,
    pub iss: String,
    pub sub: String,
    pub principal: String,
    pub active: bool,
    pub stale_at: i64,
    pub groups: Vec<String>,
    pub ts: i64,
}

/// What `api-subject` asks for: the newest record with this `sub`, or of this principal.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ask<'a> {
    Sub(&'a str),
    Principal(&'a str),
}

impl Ask<'_> {
    fn matches(&self, r: &PersonRecord) -> bool {
        match self {
            Ask::Sub(s) => r.sub == *s,
            Ask::Principal(p) => r.principal == *p,
        }
    }
}

fn text(v: &Value) -> Option<String> {
    v.as_str().filter(|t| (1..=TEXT_MAX).contains(&t.chars().count()) && pj::printable(t)).map(str::to_string)
}

fn int(v: &Value) -> Option<i64> {
    v.as_i64().filter(|n| (1..=MAX_INT).contains(n))
}

/// The record shape: exactly the 9 keys, texts, a principal, `active` a boolean, positive integers, `groups` sorted
/// and distinct.
pub fn record_of(v: &Value) -> Option<PersonRecord> {
    let o = v.as_object()?;
    if o.len() != RECORD_KEYS.len() || !RECORD_KEYS.iter().all(|k| o.contains_key(*k)) {
        return None;
    }
    let principal = text(&o["principal"]).filter(|p| op::split_principal(p).is_ok())?;
    let groups = o["groups"].as_array().filter(|g| g.len() <= GROUPS_MAX)?;
    let groups: Vec<String> = groups.iter().map(|g| g.as_str().filter(|t| (1..=GROUP_MAX).contains(&t.len()) && pj::printable(t)).map(str::to_string)).collect::<Option<_>>()?;
    if groups.windows(2).any(|w| w[0] >= w[1]) {
        return None;
    }
    Some(PersonRecord {
        org: text(&o["org"])?,
        provider: text(&o["provider"])?,
        iss: text(&o["iss"])?,
        sub: text(&o["sub"])?,
        principal,
        active: o["active"].as_bool()?,
        stale_at: int(&o["stale_at"])?,
        groups,
        ts: int(&o["ts"])?,
    })
}

/// A signed wire `{record, sig}`: the record and the decoded signature.
fn wire_of(v: &Value) -> Option<(PersonRecord, Vec<u8>)> {
    let o = v.as_object()?;
    if o.len() != WIRE_KEYS.len() || !WIRE_KEYS.iter().all(|k| o.contains_key(*k)) {
        return None;
    }
    let sig = o["sig"].as_str().filter(|s| s.len() <= SIG_MAX).and_then(pj::b64_strict)?;
    Some((record_of(&o["record"])?, sig))
}

/// `lp("lucid-meet-sso-person-v1", canonical_json(record))`.
pub fn person_bytes(record: &Value) -> Option<Vec<u8>> {
    op::canonical_json(record).ok().map(|j| op::lp(&[PERSON_LABEL.as_bytes(), &j]))
}

fn signed_by(cert: &Cert, record: &Value, sig: &[u8]) -> bool {
    person_bytes(record).is_some_and(|data| ecdsa_sha256_verified(&cert.spki, &data, sig))
}

// ── the relay ──

/// One checked record to store.
#[derive(Clone, Debug, PartialEq)]
pub struct Checked {
    pub principal: String,
    pub ts: i64,
    /// The signed wire `{record, sig}` as posted.
    pub wire: Value,
}

/// The stored value of one principal.
fn stored(wire: &Value, cert_pem: &str) -> Value {
    json!({ "record": wire["record"], "sig": wire["sig"], "cert_pem": cert_pem })
}

/// The `api-subject` answer for a stored value.
fn answer_of(s: &Value) -> Value {
    json!({ "record": { "record": s["record"], "sig": s["sig"] }, "cert_pem": s["cert_pem"] })
}

/// 4.3: the records of `POST /v1/sso/c/persons` to store, all or nothing. `entry`: the registry entry of the body's
/// (org, provider); `policy`: the org's current policy; `held`: the stored `ts` of a principal. 400 for a shape or a
/// principal twice, 403 for the caller, a record's org, provider or `iss`, a signature or a principal, 409 for a `ts` not newer than the held one.
pub fn check_post(body: &Obj, who: &Identity, entry: Option<&IdentityProvider>, policy: Option<&Obj>, held: &dyn Fn(&str) -> Option<i64>) -> R<Vec<Checked>> {
    if who.kind != "sso" {
        return forbidden(pc::SSO_ONLY);
    }
    let shape_ok = body.len() == POST_KEYS.len()
        && POST_KEYS.iter().all(|k| body.contains_key(*k))
        && body["org"].as_str().is_some_and(|o| !o.is_empty())
        && body["provider"].as_str().is_some_and(|p| !p.is_empty())
        && body["records"].as_array().is_some_and(|r| (1..=RECORDS_MAX).contains(&r.len()));
    if !shape_ok {
        return bad(POST_SHAPE);
    }
    let (org, provider) = (pj::s(body, "org"), pj::s(body, "provider"));
    let registered = entry.filter(|p| {
        p.org == org && p.id == provider && who.orgs.contains(&org) && !who.serial.is_empty() && crate::meet::serial(&p.sso_serial) == crate::meet::serial(&who.serial)
    });
    let (Some(entry), Some(cert)) = (registered, Cert::from_pem(&who.cert_pem)) else {
        return forbidden(NOT_REGISTERED);
    };
    let Some(policy) = policy.filter(|p| p.get("org").and_then(Value::as_str) == Some(org.as_str())) else {
        return forbidden(NO_POLICY);
    };
    let mut out: Vec<Checked> = Vec::new();
    for wire in body["records"].as_array().into_iter().flatten() {
        let Some((rec, sig)) = wire_of(wire) else { return bad(WIRE_SHAPE) };
        if rec.org != org || rec.provider != provider {
            return forbidden(OTHER_ORG);
        }
        if out.iter().any(|c| c.principal == rec.principal) {
            return bad(TWICE);
        }
        if serde_json::to_string(&answer_of(&stored(wire, &who.cert_pem))).map_or(true, |t| t.len() > ANSWER_MAX) {
            return bad(TOO_BIG);
        }
        if rec.iss != entry.iss {
            return forbidden(ISS_BAD);
        }
        if !signed_by(&cert, &wire["record"], &sig) {
            return forbidden(SIG_BAD);
        }
        if !op::covers(policy, &rec.principal) {
            return forbidden(NOT_COVERED);
        }
        out.push(Checked { principal: rec.principal, ts: rec.ts, wire: wire.clone() });
    }
    if out.iter().any(|c| held(&c.principal).is_some_and(|t| c.ts <= t)) {
        return Err(E::Conflict(NOT_NEWER.into()));
    }
    Ok(out)
}

/// The stored records of (org, provider): principal to stored value.
fn rows<'a>(persons: &'a Obj, org: &str, provider: &str) -> Option<&'a Obj> {
    persons.get(org)?.get(provider)?.as_object()
}

/// The held `ts` per principal of (org, provider).
pub fn held_ts(persons: &Obj, org: &str, provider: &str) -> HashMap<String, i64> {
    rows(persons, org, provider)
        .into_iter()
        .flatten()
        .filter_map(|(p, s)| record_of(&s["record"]).map(|r| (p.clone(), r.ts)))
        .collect()
}

/// Keep the checked records (each replaces the principal's) with the caller's certificate PEM.
pub fn store(persons: &mut Obj, org: &str, provider: &str, cert_pem: &str, records: &[Checked]) {
    let by_org = persons.entry(org.to_string()).or_insert_with(|| Value::Object(Obj::new()));
    if !by_org.is_object() {
        *by_org = Value::Object(Obj::new());
    }
    let by_provider = by_org.as_object_mut().expect("org rows").entry(provider.to_string()).or_insert_with(|| Value::Object(Obj::new()));
    if !by_provider.is_object() {
        *by_provider = Value::Object(Obj::new());
    }
    let rows = by_provider.as_object_mut().expect("provider rows");
    for c in records {
        rows.insert(c.principal.clone(), stored(&c.wire, cert_pem));
    }
}

/// `POST /v1/sso/c/persons {org, provider, records}` (4.3) over the SSO service's mTLS identity: `{ok, stored}`.
pub fn persons_post(hub: &Hub, who: &Identity, body: &Obj) -> R<Obj> {
    let (org, provider) = (pj::s(body, "org"), pj::s(body, "provider"));
    let mut st = hub.st.lock();
    let terms = st.pc_terms();
    let entry = terms.provider(&org, &provider).cloned();
    let policy = st.ai_newest(&org);
    let held = held_ts(st.sso_persons(), &org, &provider);
    let records = check_post(body, who, entry.as_ref(), policy.as_ref(), &|p| held.get(p).copied())?;
    store(st.sso_persons(), &org, &provider, &who.cert_pem, &records);
    st.dirty = true;
    drop(st);
    log_info(&format!("sso_persons org={org} provider={provider} service={} records={}", who.serial, records.len()));
    Ok(obj([("ok", Value::Bool(true)), ("stored", Value::from(records.len()))]))
}

/// 4.3 `api-subject`: `{record: <signed wire>, cert_pem}` for the newest stored record of (org, provider) matching
/// `ask`, or `{record: null}`.
pub fn api_subject(persons: &Obj, org: &str, provider: &str, ask: &Ask) -> Value {
    let newest = rows(persons, org, provider)
        .into_iter()
        .flatten()
        .filter_map(|(_, s)| record_of(&s["record"]).filter(|r| ask.matches(r)).map(|r| (r.ts, s)))
        .max_by_key(|(ts, _)| *ts);
    match newest {
        Some((_, s)) => answer_of(s),
        None => json!({ "record": null }),
    }
}

/// The relay's `api-subject` handler (the wire checked the keys and the size): exactly one of `sub` and `principal`.
pub fn fleet_answer(persons: &Obj, body: &Value) -> Result<Value, Refusal> {
    let s = |k: &str| body.get(k).and_then(Value::as_str).filter(|t| !t.is_empty());
    let (org, provider) = (s("org").unwrap_or_default(), s("provider").unwrap_or_default());
    let ask = match (s("sub"), s("principal"), body.get("sub").is_some() && body.get("principal").is_some()) {
        (Some(sub), None, false) => Ask::Sub(sub),
        (None, Some(p), false) => Ask::Principal(p),
        _ => return Err(Refusal::new(400, "fleet-op", "api-subject needs exactly one of sub and principal.")),
    };
    Ok(api_subject(persons, org, provider, &ask))
}

// ── the console ──

/// The `api-subject` request body.
pub fn subject_request(org: &str, provider: &str, ask: &Ask) -> Value {
    match ask {
        Ask::Sub(s) => json!({ "org": org, "provider": provider, "sub": s }),
        Ask::Principal(p) => json!({ "org": org, "provider": provider, "principal": p }),
    }
}

/// Err is the `api.person.record` result word: "missing", "bad-signature" or "stale".
pub fn verify_answer(answer: &Value, root: &Cert, entry: &IdentityProvider, org: &str, ask: &Ask, now: i64) -> Result<PersonRecord, &'static str> {
    let wire = answer.get("record").filter(|r| !r.is_null()).ok_or("missing")?;
    let (rec, sig) = wire_of(wire).ok_or("bad-signature")?;
    let cert = answer.get("cert_pem").and_then(Value::as_str).and_then(Cert::from_pem).ok_or("bad-signature")?;
    let (kind, orgs) = pc::cert_kind(&cert.names.uris).map_err(|_| "bad-signature")?;
    let cert_ok = cert.issued_directly_by_root(root)
        && kind == "sso"
        && crate::fleet_x509::is_p256_spki(&cert.spki)
        && cert.not_before <= rec.ts
        && rec.ts <= cert.not_after
        && orgs.iter().any(|o| o == org)
        && !entry.sso_serial.is_empty()
        && crate::meet::serial(&cert.serial) == crate::meet::serial(&entry.sso_serial);
    if !cert_ok || !signed_by(&cert, &wire["record"], &sig) {
        return Err("bad-signature");
    }
    if rec.org != org || entry.org != org || rec.provider != entry.id || rec.iss != entry.iss || !ask.matches(&rec) {
        return Err("bad-signature");
    }
    if rec.stale_at <= now || rec.ts > now + SKEW || rec.stale_at - rec.ts > FRESH_MAX {
        return Err("stale");
    }
    Ok(rec)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fleet_wire::{op_frame_max, parse_frame, req_text, Frame, Side};
    use crate::meet_tls::testpki::{Ca, Key};
    use aws_lc_rs::rand::SystemRandom;
    use aws_lc_rs::signature::{EcdsaKeyPair, ECDSA_P256_SHA256_ASN1_SIGNING};

    const ORG: &str = "acme";
    const PROVIDER: &str = "okta";
    const ISS: &str = "https://acme.okta.com";
    const ANN: &str = "ann@acme.com";
    const BOB: &str = "bob@acme.com";

    struct Fix {
        root: Ca,
        key: Key,
        pem: String,
    }

    fn pem_of(der: &[u8]) -> String {
        crate::meet_x509::der_to_pem(der)
    }

    fn fix() -> Fix {
        let root = Ca::new("Acme Root");
        let key = Key::new();
        let der = root.leaf(&[0x1a], "sso", None, &[pc::SSO_URI, "urn:lucid-meet:org:acme"], &key, true);
        Fix { pem: pem_of(&der), root, key }
    }

    fn root_cert(f: &Fix) -> Cert {
        Cert::from_der(&f.root.der).unwrap()
    }

    fn entry() -> IdentityProvider {
        IdentityProvider { org: ORG.into(), id: PROVIDER.into(), kind: "okta".into(), iss: ISS.into(), sso_serial: "1a".into(), cloud: String::new() }
    }

    fn who(f: &Fix) -> Identity {
        Identity { kind: "sso".into(), serial: "1a".into(), orgs: vec![ORG.into()], cert_pem: f.pem.clone(), ..Default::default() }
    }

    fn policy() -> Obj {
        json!({ "org": ORG, "domains": ["acme.com"] }).as_object().unwrap().clone()
    }

    fn now() -> i64 {
        pj::now() as i64
    }

    fn record(principal: &str, sub: &str, ts: i64, active: bool) -> Value {
        json!({ "org": ORG, "provider": PROVIDER, "iss": ISS, "sub": sub, "principal": principal, "active": active,
            "stale_at": ts + 3600, "groups": ["eng", "ops"], "ts": ts })
    }

    fn sign(key: &Key, record: &Value) -> Value {
        let pair = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, &key.pkcs8).unwrap();
        let sig = pair.sign(&SystemRandom::new(), &person_bytes(record).unwrap()).unwrap();
        json!({ "record": record, "sig": pj::b64(sig.as_ref()) })
    }

    fn post(records: Vec<Value>) -> Obj {
        json!({ "org": ORG, "provider": PROVIDER, "records": records }).as_object().unwrap().clone()
    }

    fn check(_f: &Fix, w: &Identity, body: &Obj, persons: &Obj) -> R<Vec<Checked>> {
        let held = held_ts(persons, ORG, PROVIDER);
        check_post(body, w, Some(&entry()), Some(&policy()), &|p| held.get(p).copied())
    }

    /// Post `body` the way `persons_post` does, on a plain store.
    fn post_into(f: &Fix, persons: &mut Obj, body: &Obj) -> R<usize> {
        let w = who(f);
        let records = check(f, &w, body, persons)?;
        store(persons, ORG, PROVIDER, &w.cert_pem, &records);
        Ok(records.len())
    }

    #[test]
    fn a_post_is_accepted_and_stored() {
        let f = fix();
        let mut persons = Obj::new();
        let t = now() - 100;
        let body = post(vec![sign(&f.key, &record(ANN, "u1", t, true)), sign(&f.key, &record(BOB, "u2", t, true))]);
        assert_eq!(post_into(&f, &mut persons, &body).unwrap(), 2);
        let held = held_ts(&persons, ORG, PROVIDER);
        assert_eq!((held.get(ANN), held.get(BOB)), (Some(&t), Some(&t)));
        assert_eq!(persons[ORG][PROVIDER][ANN]["cert_pem"], json!(f.pem));
        assert_eq!(persons[ORG][PROVIDER][ANN]["record"], record(ANN, "u1", t, true));
    }

    #[test]
    fn a_post_from_another_caller_is_refused() {
        let f = fix();
        let persons = Obj::new();
        let body = post(vec![sign(&f.key, &record(ANN, "u1", now() - 100, true))]);
        let mut person = who(&f);
        person.kind = "person".into();
        assert!(matches!(check(&f, &person, &body, &persons), Err(E::Forbidden(_))), "wrong kind");
        let mut other_org = who(&f);
        other_org.orgs = vec!["globex".into()];
        assert!(matches!(check(&f, &other_org, &body, &persons), Err(E::Forbidden(_))), "other org");
        let mut other_serial = who(&f);
        other_serial.serial = "2b".into();
        assert!(matches!(check(&f, &other_serial, &body, &persons), Err(E::Forbidden(_))), "serial not the registry's");
        let held = HashMap::<String, i64>::new();
        let w = who(&f);
        assert!(matches!(check_post(&body, &w, None, Some(&policy()), &|p| held.get(p).copied()), Err(E::Forbidden(_))), "no registry entry");
        assert!(matches!(check_post(&body, &w, Some(&entry()), None, &|p| held.get(p).copied()), Err(E::Forbidden(_))), "no policy");
    }

    #[test]
    fn a_post_with_a_bad_record_stores_nothing() {
        let f = fix();
        let w = who(&f);
        let persons = Obj::new();
        let t = now() - 100;
        let good = sign(&f.key, &record(ANN, "u1", t, true));
        let mut iss = record(BOB, "u2", t, true);
        iss["iss"] = json!("https://evil.okta.com");
        assert!(matches!(check(&f, &w, &post(vec![good.clone(), sign(&f.key, &iss)]), &persons), Err(E::Forbidden(_))), "iss mismatch");
        let mut forged = sign(&f.key, &record(BOB, "u2", t, true));
        forged["record"]["active"] = json!(false);
        assert!(matches!(check(&f, &w, &post(vec![good.clone(), forged]), &persons), Err(E::Forbidden(_))), "bad signature");
        let other_key = sign(&Key::new(), &record(BOB, "u2", t, true));
        assert!(matches!(check(&f, &w, &post(vec![good.clone(), other_key]), &persons), Err(E::Forbidden(_))), "another key");
        for (k, v) in [("org", "globex"), ("provider", "entra")] {
            let mut r = record(BOB, "u2", t, true);
            r[k] = json!(v);
            assert!(matches!(check(&f, &w, &post(vec![good.clone(), sign(&f.key, &r)]), &persons), Err(E::Forbidden(_))), "{k} mismatch");
        }
        let mut unsorted = record(BOB, "u2", t, true);
        unsorted["groups"] = json!(["ops", "eng"]);
        assert!(matches!(check(&f, &w, &post(vec![sign(&f.key, &unsorted)]), &persons), Err(E::Bad(_))), "groups unsorted");
        let uncovered = record("eve@globex.com", "u9", t, true);
        assert!(matches!(check(&f, &w, &post(vec![sign(&f.key, &uncovered)]), &persons), Err(E::Forbidden(_))), "not covered");
        assert!(matches!(check(&f, &w, &post(vec![good.clone(), good]), &persons), Err(E::Bad(_))), "twice");
    }

    #[test]
    fn an_older_or_equal_ts_is_409_and_nothing_is_stored() {
        let f = fix();
        let mut persons = Obj::new();
        let t = now() - 100;
        post_into(&f, &mut persons, &post(vec![sign(&f.key, &record(ANN, "u1", t, true))])).unwrap();
        let before = persons.clone();
        for ts in [t, t - 1] {
            let body = post(vec![sign(&f.key, &record(BOB, "u2", t + 5, true)), sign(&f.key, &record(ANN, "u1", ts, false))]);
            assert!(matches!(post_into(&f, &mut persons, &body), Err(E::Conflict(_))), "ts {ts}");
            assert_eq!(persons, before, "all or nothing");
        }
    }

    #[test]
    fn api_subject_answers_the_newest_by_sub_and_by_principal() {
        let f = fix();
        let mut persons = Obj::new();
        let t = now() - 100;
        post_into(&f, &mut persons, &post(vec![sign(&f.key, &record(ANN, "u1", t, true))])).unwrap();
        // the same sub moved to another principal later: the newest wins by sub
        post_into(&f, &mut persons, &post(vec![sign(&f.key, &record(BOB, "u1", t + 10, true))])).unwrap();
        let by_sub = api_subject(&persons, ORG, PROVIDER, &Ask::Sub("u1"));
        assert_eq!(by_sub["record"]["record"]["principal"], json!(BOB));
        assert_eq!(by_sub["cert_pem"], json!(f.pem));
        let by_principal = api_subject(&persons, ORG, PROVIDER, &Ask::Principal(ANN));
        assert_eq!(by_principal["record"]["record"]["ts"], json!(t));
        assert_eq!(api_subject(&persons, ORG, PROVIDER, &Ask::Sub("nobody")), json!({ "record": null }));
        assert_eq!(api_subject(&persons, ORG, "entra", &Ask::Principal(ANN)), json!({ "record": null }));
        let asked = fleet_answer(&persons, &subject_request(ORG, PROVIDER, &Ask::Principal(ANN))).unwrap();
        assert_eq!(asked, by_principal);
        assert!(fleet_answer(&persons, &json!({ "org": ORG, "provider": PROVIDER })).is_err());
        assert!(fleet_answer(&persons, &json!({ "org": ORG, "provider": PROVIDER, "sub": "u1", "principal": ANN })).is_err());
    }

    #[test]
    fn verify_answer_checks_the_certificate_the_signature_and_freshness() {
        let f = fix();
        let root = root_cert(&f);
        let e = entry();
        let t = now() - 100;
        let answer = |wire: Value, pem: &str| json!({ "record": wire, "cert_pem": pem });
        let good = answer(sign(&f.key, &record(ANN, "u1", t, true)), &f.pem);
        let ok = verify_answer(&good, &root, &e, ORG, &Ask::Sub("u1"), now()).unwrap();
        assert_eq!((ok.principal.as_str(), ok.active, ok.groups.clone()), (ANN, true, vec!["eng".to_string(), "ops".to_string()]));
        assert!(verify_answer(&good, &root, &e, ORG, &Ask::Principal(ANN), now()).is_ok());
        // unsigned
        let unsigned = answer(json!({ "record": record(ANN, "u1", t, true), "sig": "" }), &f.pem);
        assert_eq!(verify_answer(&unsigned, &root, &e, ORG, &Ask::Sub("u1"), now()), Err("bad-signature"));
        // another SSO certificate (another serial) under the same root
        let other = Key::new();
        let other_pem = pem_of(&f.root.leaf(&[0x2b], "sso2", None, &[pc::SSO_URI, "urn:lucid-meet:org:acme"], &other, true));
        assert_eq!(verify_answer(&answer(sign(&other, &record(ANN, "u1", t, true)), &other_pem), &root, &e, ORG, &Ask::Sub("u1"), now()), Err("bad-signature"));
        // a relay's (not an SSO service's) key
        let relay = Key::new();
        let relay_pem = pem_of(&f.root.leaf(&[0x1a], "relay", None, &["urn:lucid-meet:org:acme"], &relay, true));
        assert_eq!(verify_answer(&answer(sign(&relay, &record(ANN, "u1", t, true)), &relay_pem), &root, &e, ORG, &Ask::Sub("u1"), now()), Err("bad-signature"));
        // another root
        let foreign = Cert::from_der(&Ca::new("Other Root").der).unwrap();
        assert_eq!(verify_answer(&good, &foreign, &e, ORG, &Ask::Sub("u1"), now()), Err("bad-signature"));
        // another sub, another principal
        assert_eq!(verify_answer(&good, &root, &e, ORG, &Ask::Sub("u2"), now()), Err("bad-signature"));
        assert_eq!(verify_answer(&good, &root, &e, ORG, &Ask::Principal(BOB), now()), Err("bad-signature"));
        // stale: stale_at <= now
        let mut stale = record(ANN, "u1", t, true);
        stale["stale_at"] = json!(t + 50);
        assert_eq!(verify_answer(&answer(sign(&f.key, &stale), &f.pem), &root, &e, ORG, &Ask::Sub("u1"), now()), Err("stale"));
        assert_eq!(verify_answer(&good, &root, &e, ORG, &Ask::Sub("u1"), t + 3600), Err("stale"));
        // ts far in the future
        let ahead = record(ANN, "u1", now() + 600, true);
        assert_eq!(verify_answer(&answer(sign(&f.key, &ahead), &f.pem), &root, &e, ORG, &Ask::Sub("u1"), now()), Err("stale"));
        // fresh for more than a day
        let mut long = record(ANN, "u1", t, true);
        long["stale_at"] = json!(t + FRESH_MAX + 1);
        assert_eq!(verify_answer(&answer(sign(&f.key, &long), &f.pem), &root, &e, ORG, &Ask::Sub("u1"), now()), Err("stale"));
        // active false is returned Ok
        let off = verify_answer(&answer(sign(&f.key, &record(ANN, "u1", t, false)), &f.pem), &root, &e, ORG, &Ask::Sub("u1"), now()).unwrap();
        assert!(!off.active);
        // null is missing
        assert_eq!(verify_answer(&json!({ "record": null }), &root, &e, ORG, &Ask::Sub("u1"), now()), Err("missing"));
    }

    #[test]
    fn an_older_valid_record_never_replaces_a_newer_suspension() {
        let f = fix();
        let mut persons = Obj::new();
        let t = now() - 100;
        let older = sign(&f.key, &record(ANN, "u1", t - 50, true));
        post_into(&f, &mut persons, &post(vec![sign(&f.key, &record(ANN, "u1", t, false))])).unwrap();
        assert!(matches!(post_into(&f, &mut persons, &post(vec![older])), Err(E::Conflict(_))));
        let answer = api_subject(&persons, ORG, PROVIDER, &Ask::Principal(ANN));
        let rec = verify_answer(&answer, &root_cert(&f), &entry(), ORG, &Ask::Principal(ANN), now()).unwrap();
        assert_eq!((rec.active, rec.ts), (false, t));
    }

    #[test]
    fn the_api_subject_op_goes_console_to_relay_within_1_kib() {
        let ok = subject_request(ORG, PROVIDER, &Ask::Sub("u1"));
        assert!(matches!(parse_frame(&req_text(1, "api-subject", ok.clone()), Side::Relay), Ok(Frame::Req { op: "api-subject", .. })));
        assert_eq!(parse_frame(&req_text(1, "api-subject", ok.clone()), Side::Console).err().unwrap().why, "op", "the wrong side refuses it");
        let by_principal = subject_request(ORG, PROVIDER, &Ask::Principal(ANN));
        assert!(parse_frame(&req_text(1, "api-subject", by_principal), Side::Relay).is_ok());
        let mut missing = ok.clone();
        missing.as_object_mut().unwrap().remove("provider");
        assert_eq!(parse_frame(&req_text(1, "api-subject", missing), Side::Relay).err().unwrap().why, "body");
        let mut extra = ok.clone();
        extra["reason"] = json!("x");
        assert_eq!(parse_frame(&req_text(1, "api-subject", extra), Side::Relay).err().unwrap().why, "body");
        let mut big = ok;
        big["sub"] = json!("s".repeat(1024));
        assert_eq!(parse_frame(&req_text(1, "api-subject", big), Side::Relay).err().unwrap().why, "size");
        assert_eq!(op_frame_max("api-subject"), Some(1024));
    }
}
