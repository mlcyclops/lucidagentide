// The add-on's own ID-1 verdicts (Remote Spokes, contract 4.2, 5.1, 5.3 to 5.5), checked here against this crate's:
// the anchored bundle, the rules lowering wire and the current-rules selection, renewed leaves, the size bounds, the
// signed-in envelope and PIV and FIDO2 presence provenance. Each file is a copy of the add-on's
// remote-spoke/test/vectors/<name>.json (scripts/identity-vectors.ts and scripts/presence-vectors.ts write them).

use crate::codec::{str_of, unb64u};
use crate::der::p256_from_spki;
use crate::identity::{open_compact, parse_bundle, Refusal, TrustStore};
use crate::idp::{current_rules, decision_size_problem, read_idp_envelope, LeafRefusal, MAX_DECISION_BYTES, TOKEN_LIMITS_MAP};
use crate::presence::{verify_fido2_provenance, verify_piv_provenance};
use serde_json::{json, Value};

const ORG: &str = "Acme";

fn vector(name: &str) -> Value {
    let path = format!("{}/tests/{name}", env!("CARGO_MANIFEST_DIR"));
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}; copy it from the add-on's remote-spoke/test/vectors/"));
    crate::codec::parse_json(&text).unwrap_or_else(|| panic!("{path} is JSON"))
}

/// The gates a file names `verified`.
fn gates(v: &Value) -> Vec<String> {
    v["gates"].as_object().map(|g| g.iter().filter(|(_, s)| s.as_str() == Some("verified")).map(|(k, _)| k.clone()).collect()).unwrap_or_default()
}

/// A holder of `root_pub` with the file's gates and the org name in the words.
fn holder(root_pub: &Value, gates: &[String]) -> TrustStore {
    let spki = unb64u(root_pub.as_str().unwrap()).unwrap();
    let mut t = TrustStore::new(p256_from_spki(&spki).expect("root is P-256"));
    let names: Vec<&str> = gates.iter().map(String::as_str).collect();
    t.set_gates(&names);
    t.org_name = ORG.into();
    t
}

fn verdict<T>(r: Result<T, Refusal>) -> Value {
    match r {
        Ok(_) => json!({ "ok": true }),
        Err(Refusal { reason, event: Some(e) }) => json!({ "ok": false, "event": e, "words": reason }),
        Err(Refusal { reason, event: None }) => json!({ "ok": false, "words": reason }),
    }
}

fn leaf_verdict<T>(r: Result<T, LeafRefusal>) -> Value {
    match r {
        Ok(_) => json!({ "ok": true }),
        Err(LeafRefusal { event, reason }) => json!({ "ok": false, "event": event, "words": reason }),
    }
}

/// A holder as a node loads one: the whole bundle, or else the CRL alone.
fn load(t: &mut TrustStore, bundle: &Value) {
    let b = parse_bundle(Some(bundle)).expect("a well-formed bundle");
    if t.accept_bundle(&b).is_err() {
        let _ = t.accept_crl(&b.crl);
    }
}

#[test]
fn renewed_leaves_get_the_same_verdicts() {
    for file in ["idp-renew-v1.json", "idp-renew-max.json"] {
        let v = vector(file);
        let g = gates(&v);
        let cases = v["cases"].as_array().unwrap();
        assert!(!cases.is_empty(), "{file}");
        for c in cases {
            let mut t = holder(c.get("root_pub").unwrap_or(&v["root_pub"]), &g);
            load(&mut t, &c["bundle"]);
            let now = c["now"].as_i64().unwrap_or_else(|| v["now"].as_i64().unwrap());
            assert_eq!(verdict(t.check_cert(c.get("cert"), now)), c["expect"], "{file}: {}", c["name"]);
        }
    }
}

#[test]
fn renewed_leaves_are_refused_while_g_engine_is_off() {
    // This build holds no gates (G-RUST is off): the anchored CRL is malformed and a renewed leaf never verifies.
    let v = vector("idp-renew-v1.json");
    let c = &v["cases"][0];
    assert_eq!(c["expect"], json!({ "ok": true }));
    let mut t = holder(&c["root_pub"], &[]);
    let b = parse_bundle(Some(&c["bundle"])).unwrap();
    assert_eq!(t.accept_bundle(&b).unwrap_err().reason, "malformed CRL");
    assert!(t.check_cert(c.get("cert"), c["now"].as_i64().unwrap()).is_err());
}

#[test]
fn the_anchored_bundle_gets_the_same_verdicts() {
    let v = vector("anchored-bundle-v1.json");
    let g = gates(&v);
    for c in v["cases"].as_array().unwrap() {
        let mut t = holder(&v["root_pub"], &g);
        for (i, s) in c["steps"].as_array().unwrap().iter().enumerate() {
            let b = parse_bundle(Some(&s["bundle"])).expect("a well-formed bundle");
            let r = t.accept_bundle(&b);
            let refused = r.is_err();
            assert_eq!(verdict(r), s["expect"], "{} step {i}", c["name"]);
            // On a refusal the holder keeps the CRL alone when it is newer.
            if refused {
                let _ = t.accept_crl(&b.crl);
            }
        }
        let got = match c.get("cert") {
            Some(cert) => verdict(t.check_cert(Some(cert), v["now"].as_i64().unwrap())),
            None => json!({ "ok": true }),
        };
        assert_eq!(got, c["expect"], "{}", c["name"]);
    }
}

#[test]
fn the_rules_lowering_gets_the_same_verdicts() {
    let v = vector("rs-rules-lowering-v1.json");
    let g = gates(&v);
    for c in v["cases"].as_array().unwrap() {
        let mut t = holder(&v["root_pub"], &g);
        for s in c["steps"].as_array().unwrap() {
            let b = parse_bundle(Some(&s["bundle"])).expect("a well-formed bundle");
            assert_eq!(verdict(t.accept_bundle(&b)), s["expect"], "{}", c["name"]);
        }
        for k in c["checks"].as_array().into_iter().flatten() {
            let got = match current_rules(&t, k["now"].as_i64().unwrap()) {
                Ok(r) => json!({ "ok": true, "carrier": r.carrier, "version": r.version }),
                Err(r) => leaf_verdict::<()>(Err(r)),
            };
            assert_eq!(got, k["expect"], "{} at {}", c["name"], k["now"]);
        }
        let got = match c.get("wire").and_then(Value::as_str) {
            Some(wire) => verdict(t.accept_rules_lowering(wire)),
            None => json!({ "ok": true }),
        };
        assert_eq!(got, c["expect"], "{}", c["name"]);
    }
}

#[test]
fn the_map_size_bound_gets_the_same_verdicts() {
    let v = vector("idp-map-max.json");
    let g = gates(&v);
    for c in v["cases"].as_array().unwrap() {
        let mut t = holder(&v["root_pub"], &g);
        t.accept_crl(c["crl"].as_str().unwrap()).expect("the case's CRL");
        let token = c["token"].as_str().unwrap();
        assert_eq!(token.len() as i64, c["length"].as_i64().unwrap());
        assert_eq!(verdict(t.accept_idp_map(token)), c["expect"], "{}", c["name"]);
    }
}

#[test]
fn signed_in_envelopes_get_the_same_verdicts() {
    let v = vector("idp-envelope-v1.json");
    let g = gates(&v);
    let t = holder(&v["root_pub"], &g);
    let now = v["now"].as_i64().unwrap();
    for c in v["cases"].as_array().unwrap() {
        let map = open_compact(c.get("idpMap"), t.root_key(), TOKEN_LIMITS_MAP).expect("the root signed the map");
        let got = leaf_verdict(read_idp_envelope(c["envelope"].as_str().unwrap(), &map, now, ORG, &g));
        assert_eq!(got, c["expect"], "{}", c["name"]);
    }
}

#[test]
fn the_decision_size_bound_gets_the_same_verdicts() {
    let v = vector("decision-max.json");
    for c in v["cases"].as_array().unwrap() {
        let body = c["body"].as_str().unwrap();
        assert_eq!(body.len() as i64, c["bytes"].as_i64().unwrap(), "{}", c["name"]);
        let got = decision_size_problem(body).map_or_else(|| json!({ "ok": true }), |r| leaf_verdict::<()>(Err(r)));
        assert_eq!(got, c["expect"], "{}", c["name"]);
    }
    assert_eq!(MAX_DECISION_BYTES, 262_144);
}

#[test]
fn presence_provenance_gets_the_same_verdicts() {
    let v = vector("presence-provenance-v1.json");
    let g: Vec<String> = ["G-PRES-PIV", "G-PRES-FIDO2", "G-ENGINE"].iter().map(|s| (*s).to_owned()).collect();
    let map = v["map"].as_object().unwrap();
    let (now, org) = (v["now"].as_i64().unwrap(), v["org"].as_str().unwrap());
    for c in v["piv"].as_array().unwrap() {
        let status = unb64u(str_of(c.get("status")).unwrap_or_default()).unwrap_or_default();
        let got = verify_piv_provenance(&c["presence"], map, c["email"].as_str().unwrap(), now, &status, org, &g);
        assert_eq!(got.err().map(|r| r.event), c["expect"]["event"].as_str(), "piv: {}", c["name"]);
    }
    for c in v["fido2"].as_array().unwrap() {
        let r = &c["request"];
        let got = verify_fido2_provenance(&c["presence"], r["spki"].as_str().unwrap(), r["role"].as_str().unwrap(), r["label"].as_str().unwrap(), map, now, org, &g);
        assert_eq!(got.err().map(|r| r.event), c["expect"]["event"].as_str(), "fido2: {}", c["name"]);
    }
}
