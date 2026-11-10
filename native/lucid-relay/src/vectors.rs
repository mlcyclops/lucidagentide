// The add-on's own verdicts on certificates, CRLs, relay directories, request signatures, licenses, license seats
// and a stored envelope record (its scripts/relay-vectors.ts writes tests/vectors.json), checked here against this
// crate's.
//
//   bun scripts/relay-vectors.ts <this crate>/tests/vectors.json   (from the add-on's remote-spoke folder)

use crate::codec::{parse_json, sha256_hex, str_of, stringify, unb64u};
use crate::der::{ecdsa_verify, p256_from_spki};
use crate::identity::{DirectoryHolder, TrustStore};
use crate::license::{license_keys, license_state, license_token_of, seat_problem, verify_license};
use crate::relay::parse_envelope;
use serde_json::{json, Value};

fn vectors() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/vectors.json");
    let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{path}: {e}; write it with `bun scripts/relay-vectors.ts {path}` from the add-on"));
    parse_json(&text).expect("vectors.json is JSON")
}

fn root(v: &Value) -> TrustStore {
    let spki = unb64u(str_of(v["root"].get("spki")).unwrap()).unwrap();
    let trust = TrustStore::new(p256_from_spki(&spki).expect("root is P-256"));
    assert_eq!(trust.root_id, v["root"]["id"].as_str().unwrap());
    trust
}

fn now(v: &Value) -> i64 {
    v["now"].as_i64().unwrap()
}

fn step(result: Result<bool, String>) -> Value {
    match result {
        Ok(changed) => json!({ "ok": true, "changed": changed }),
        Err(reason) => json!({ "ok": false, "reason": reason }),
    }
}

#[test]
fn the_root_pem_reads_to_the_same_root_id() {
    let v = vectors();
    let der = crate::der::pem_blocks(v["root"]["pem"].as_str().unwrap(), "PUBLIC KEY").remove(0);
    assert_eq!(TrustStore::new(p256_from_spki(&der).unwrap()).root_id, v["root"]["id"].as_str().unwrap());
}

#[test]
fn certificates_get_the_same_verdicts() {
    let v = vectors();
    for c in v["certs"].as_array().unwrap() {
        let mut trust = root(&v);
        if c["crl"].as_bool().unwrap() {
            trust.accept_crl(v["crl"].as_str().unwrap()).expect("vector CRL");
        }
        let got = match trust.verify_cert(c.get("token"), now(&v)) {
            Ok(ok) => json!({
                "ok": true, "node": ok.cert.node, "role": ok.cert.role, "serial": ok.cert.serial,
                "user": ok.cert.user.map(|u| u.id),
            }),
            Err(reason) => json!({ "ok": false, "reason": reason }),
        };
        assert_eq!(got, c["verdict"], "certificate: {}", c["name"]);
    }
}

#[test]
fn crls_are_taken_newer_only() {
    let v = vectors();
    let mut trust = root(&v);
    for s in v["crlSteps"].as_array().unwrap() {
        assert_eq!(step(trust.accept_crl(s["token"].as_str().unwrap())), s["result"], "CRL step: {}", s["name"]);
    }
}

#[test]
fn relay_directories_are_taken_newer_only() {
    let v = vectors();
    let trust = root(&v);
    let mut holder = DirectoryHolder::default();
    for s in v["directorySteps"].as_array().unwrap() {
        assert_eq!(step(holder.accept(&trust, s["token"].as_str().unwrap(), now(&v))), s["result"], "directory step: {}", s["name"]);
    }
}

#[test]
fn request_signatures_verify_exactly_when_typescript_signed_that_string() {
    let v = vectors();
    for r in v["requests"].as_array().unwrap() {
        let key = p256_from_spki(&unb64u(r["spki"].as_str().unwrap()).unwrap()).unwrap();
        let ts = crate::codec::js_number_string(r["ts"].as_f64().unwrap());
        let s = |k: &str| r[k].as_str().unwrap().to_owned();
        let signed = format!("lucid-relay-auth/v2\n{}\n{}\n{}\n{ts}\n{}\n{}", s("audience"), s("method"), s("path"), s("nonce"), sha256_hex(s("body").as_bytes()));
        let sig = unb64u(&s("sig")).unwrap();
        assert_eq!(ecdsa_verify(&key, signed.as_bytes(), &sig), r["ok"].as_bool().unwrap(), "request {} {} for {}", s("method"), s("path"), s("audience"));
    }
}

#[test]
fn licenses_get_the_same_verdicts() {
    let v = vectors();
    let trust = root(&v);
    let dev_pub = v["license"]["devPub"].as_str().unwrap().to_owned();
    let keys = license_keys(|k| match k {
        "LUCID_LICENSE_DEV" => Some("1".into()),
        "LUCID_LICENSE_DEV_PUB" => Some(dev_pub.clone()),
        _ => None,
    })
    .unwrap_or_else(|e| panic!("{e}"));
    let first = v["license"]["cases"][0]["token"].as_str().unwrap();
    assert_eq!(license_token_of(v["license"]["armored"].as_str().unwrap()), first);
    for c in v["license"]["cases"].as_array().unwrap() {
        let got = match verify_license(c["token"].as_str().unwrap(), &trust.root_id, &keys, now(&v)) {
            Ok(ok) => {
                let (state, days_left) = license_state(&ok.license, now(&v));
                let l = ok.license;
                json!({
                    "ok": true, "dev": ok.dev, "id": l.id, "edition": l.edition, "users": l.users, "relays": l.relays, "exp": l.exp,
                    "graceDays": l.grace_days, "state": state.as_str(), "daysLeft": days_left,
                })
            }
            Err(reason) => json!({ "ok": false, "reason": reason }),
        };
        assert_eq!(got, c["verdict"], "license: {}", c["name"]);
    }
}

/// F2 (ADR-A100): a hub's license seat, judged against its own certificate and the relay's license id.
#[test]
fn license_seats_get_the_same_verdicts() {
    let v = vectors();
    let trust = root(&v);
    for c in v["seats"].as_array().unwrap() {
        let cert = trust.verify_cert(c.get("cert"), now(&v)).unwrap_or_else(|e| panic!("seat {}: {e}", c["name"])).cert;
        let got = seat_problem(c["token"].as_str(), trust.root_key(), &trust.root_id, c["license"].as_str().unwrap(), &cert, now(&v));
        assert_eq!(got, c["verdict"].as_str(), "seat: {}", c["name"]);
    }
}

#[test]
fn a_stored_envelope_record_is_the_same_bytes() {
    let v = vectors();
    let e = &v["envelope"];
    let parsed = parse_json(e["json"].as_str().unwrap()).unwrap();
    let (env, ..) = parse_envelope(Some(&parsed)).expect("the sealed envelope parses");
    let record = stringify(&json!({ "at": e["at"].as_i64().unwrap(), "env": Value::Object(env.clone()) }));
    assert_eq!(record, e["record"].as_str().unwrap());
}
