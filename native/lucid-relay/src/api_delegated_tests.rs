// Tests of `api_delegated` (revision 5 18 "EMA", "Authorization code", "Delegated token" and the review cases).

use super::*;
use aws_lc_rs::signature::{EcdsaKeyPair, ECDSA_P256_SHA256_FIXED_SIGNING};

const NOW: i64 = 1_795_000_000;
const ORG: &str = "acme";
const ISSUER: &str = "https://console.acme.example:7443/api/orgs/acme";
const CLIENT: &str = "c_0b1c2d3e4f5a6b7c";
const IDP_ISS: &str = "https://acme.okta.com";

fn obj(v: Value) -> Obj {
    v.as_object().cloned().unwrap()
}

fn map() -> Obj {
    obj(json!({"org": ORG, "issuer": {"url": ISSUER},
        "relay_origins": {"r_01": "https://relay1.acme.example:9443"},
        "connectors": [{"id": "k_7a1b2c3d4e5f6a7b", "name": "helpdesk", "origin": "https://connector.acme.example:9445", "state": "active"},
                       {"id": "k_0000000000000001", "name": "off", "origin": "https://off.acme.example:9445", "state": "suspended"}],
        "idps": [{"id": "okta", "provider": "okta", "issuer": IDP_ISS, "algs": ["ES256"], "max_age_s": 300, "private_ok": false, "state": "active"}]}))
}

fn client(reach: &str) -> Obj {
    obj(json!({"id": CLIENT, "kind": "agent_delegated", "reach": reach, "scopes": ["content.read", "content.post"],
        "connectors": ["k_7a1b2c3d4e5f6a7b", "k_0000000000000001"], "relays": ["*"],
        "delegation": {"groups": ["00g1"], "principals": ["bob@acme.example"], "idps": ["okta"], "consent_days": 7, "denied": ["eve@acme.example"]},
        "redirect_uris": ["http://127.0.0.1/callback"]}))
}

fn record(principal: &str, groups: &[&str], active: bool) -> PersonRecord {
    PersonRecord { org: ORG.into(), provider: "okta".into(), iss: IDP_ISS.into(), sub: "00u1".into(), principal: principal.into(), active, stale_at: NOW + 3600, groups: groups.iter().map(|g| g.to_string()).collect(), ts: NOW }
}

fn entry(action: &str, target: Value) -> ConsoleEntry {
    ConsoleEntry { id: "k_acme_000001".into(), org: ORG.into(), cseq: 1, ts: NOW, action: action.into(), target, reach: crate::api_cjournal::Reach::Connector, prev_cseq: Some(0) }
}

#[test]
fn ema_is_closed_until_its_gate() {
    assert!(!ema_open(), "G-EMA-OKTA-SUB is not verified in this build");
}

#[test]
fn resources_follow_4_4() {
    let m = map();
    let c = connector_resource("https://connector.acme.example:9445", ORG);
    let cm = connector_mcp_resource("https://connector.acme.example:9445", ORG);
    let r1 = client("R1");
    assert_eq!(resolve_resource(&m, ORG, &r1, CLIENT, Some(&c), &[]).unwrap(), Resolved::Chosen(c.clone(), Target::Connector("k_7a1b2c3d4e5f6a7b".into())));
    assert_eq!(resolve_resource(&m, ORG, &r1, CLIENT, Some(&cm), &[]).unwrap(), Resolved::Chosen(cm.clone(), Target::ConnectorMcp("k_7a1b2c3d4e5f6a7b".into())));
    assert_eq!(resolve_resource(&m, ORG, &r1, CLIENT, None, &[]).unwrap_err().code, "target", "absent is target for R1");
    assert_eq!(resolve_resource(&m, ORG, &r1, CLIENT, Some(ISSUER), &[]).unwrap_err().code, "target");
    let off = connector_resource("https://off.acme.example:9445", ORG);
    assert_eq!(resolve_resource(&m, ORG, &r1, CLIENT, Some(&off), &[]).unwrap_err().code, "target", "a suspended connector gets no tokens");
    let suspended = [entry("connector_suspend", json!("k_7a1b2c3d4e5f6a7b"))];
    assert_eq!(resolve_resource(&m, ORG, &r1, CLIENT, Some(&c), &suspended).unwrap_err().code, "target", "connector_suspend stops issuing for C");
    let r0 = client("R0");
    assert_eq!(resolve_resource(&m, ORG, &r0, CLIENT, None, &[]).unwrap(), Resolved::Chosen(mcp_resource(ISSUER), Target::Mcp));
    assert_eq!(resolve_resource(&m, ORG, &r0, CLIENT, Some(ISSUER), &[]).unwrap_err().code, "target", "a delegated R0 token is for M only");
    let monitoring = obj(json!({"id": "c_1", "kind": "monitoring", "reach": "R0"}));
    assert_eq!(resolve_resource(&m, ORG, &monitoring, "c_1", Some(&mcp_resource(ISSUER)), &[]).unwrap(), Resolved::Chosen(mcp_resource(ISSUER), Target::Mcp));
    assert_eq!(resolve_resource(&m, ORG, &monitoring, "c_1", None, &[]).unwrap(), Resolved::Legacy);
    assert_eq!(resolve_resource(&m, ORG, &monitoring, "c_1", Some(&c), &[]).unwrap_err().code, "target");
}

#[test]
fn metadata_carries_the_4_4_additions() {
    let v = crate::api_issue::console_as_metadata(ISSUER);
    assert_eq!(v["authorization_endpoint"], json!(format!("{ISSUER}/oauth/authorize")));
    assert_eq!(v["code_challenge_methods_supported"], json!(["S256"]));
    assert!(v["grant_types_supported"].as_array().unwrap().contains(&json!(GRANT_JWT_BEARER)));
    assert!(v["token_endpoint_auth_methods_supported"].as_array().unwrap().contains(&json!("none")));
    assert_eq!(v["client_id_metadata_document_supported"], json!(true));
    assert_eq!(v["authorization_grant_profiles_supported"], json!([ID_JAG_PROFILE]));
    let m = mcp_metadata(ISSUER, ORG);
    assert_eq!(m["resource"], json!(format!("{ISSUER}/mcp")));
    assert_eq!(m["tls_client_certificate_bound_access_tokens"], json!(true));
    let c = connector_metadata(ISSUER, "https://connector.acme.example:9445/api/orgs/acme/mcp", ORG, "helpdesk");
    assert_eq!(c["scopes_supported"], json!(["content.read", "content.post"]));
    assert_eq!(metadata_url("https://connector.acme.example:9445/api/orgs/acme/mcp").unwrap(), "https://connector.acme.example:9445/.well-known/oauth-protected-resource/api/orgs/acme/mcp");
    assert!(www_authenticate(&mcp_resource(ISSUER), &["monitor.read"], Some("insufficient_scope")).contains("error=\"insufficient_scope\""));
}

#[test]
fn refusal_codes_have_their_oauth_errors() {
    for (code, status, error) in [("assertion", 400, "invalid_grant"), ("idp", 400, "invalid_grant"), ("person", 403, "access_denied"), ("consent", 400, "invalid_grant"),
                                  ("pkce", 400, "invalid_grant"), ("redirect", 400, "invalid_request"), ("target", 400, "invalid_target"),
                                  ("subject-unreachable", 503, "temporarily_unavailable"), ("grant", 400, "unsupported_grant_type"), ("client-auth", 401, "invalid_client")] {
        assert_eq!(crate::api_issue::shape(code), (status, error), "{code}");
    }
}

#[test]
fn pkce_is_s256_only() {
    let v = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    let c = s256(v);
    assert!(challenge_ok(&c) && pkce_matches(v, &c));
    assert!(!pkce_matches("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXx", &c));
    assert!(!pkce_matches(&c, &c) || s256(&c) == c, "plain is never accepted");
    assert!(!challenge_ok("plain-challenge"));
}

#[test]
fn redirects_follow_rfc_8252_and_r5_11() {
    assert!(redirect_matches("http://127.0.0.1/callback", "http://127.0.0.1:53111/callback"));
    assert!(!redirect_matches("http://127.0.0.1/callback", "http://127.0.0.1:53111/other"));
    assert!(!redirect_matches("https://app.example/cb", "https://app.example/cb?x=1"));
    assert!(!redirect_uri_ok("http://localhost/callback"));
    assert!(!redirect_uri_ok("https://localhost/cb"));
    assert!(!redirect_uri_ok("https://app.example/cb#f"));
    assert_eq!(redirect_host("https://app.example:8443/cb"), "app.example");
    let r1 = client("R1");
    assert!(loopback_refused(&r1, true, &["http://127.0.0.1/callback".into()]), "a public loopback R1 client needs loopback_ok");
    let mut ok = r1.clone();
    ok.insert("loopback_ok".into(), json!(true));
    assert!(!loopback_refused(&ok, true, &["http://127.0.0.1/callback".into()]));
    let dropped = [entry("client_drop_redirect", json!({"client": CLIENT, "uri": "http://127.0.0.1/callback"}))];
    assert!(registered_redirects(&r1, CLIENT, None, &dropped).is_empty());
}

#[test]
fn cimd_documents_are_checked() {
    let url = "https://claude.ai/oauth/mcp-client.json";
    let good = json!({"client_id": url, "client_name": "Claude", "redirect_uris": ["http://127.0.0.1/callback"], "token_endpoint_auth_method": "none"});
    assert!(check_cimd(url, &good, false).unwrap().public);
    let mut other = good.clone();
    other["client_id"] = json!("https://evil.example/c.json");
    assert!(check_cimd(url, &other, false).is_err(), "client_id mismatch");
    let mut local = good.clone();
    local["redirect_uris"] = json!(["http://localhost/callback"]);
    assert!(check_cimd(url, &local, false).is_err(), "localhost refused");
    let mut keyless = good.clone();
    keyless["token_endpoint_auth_method"] = json!("private_key_jwt");
    assert!(check_cimd(url, &keyless, false).is_err(), "private_key_jwt needs keys");
    let clients = vec![json!({"id": CLIENT, "credentials": [{"type": "cimd", "url": url, "expires": NOW + 100}]})];
    assert!(cimd_client(&clients, url, &[]).is_some());
    assert!(cimd_client(&clients, "https://claude.ai/oauth/other.json", &[]).is_none(), "an unlisted URL is client");
}

fn jag(key: &EcdsaKeyPair, header: Value, claims: Value) -> String {
    tok::sign_es256(key, &header, &claims).unwrap()
}

fn claims() -> Value {
    json!({"iss": IDP_ISS, "sub": "00u1", "aud": ISSUER, "client_id": CLIENT, "jti": "j1", "iat": NOW - 10, "exp": NOW + 200,
           "resource": "https://connector.acme.example:9445/api/orgs/acme/mcp", "auth_time": NOW - 100, "scope": "content.read"})
}

fn check_jag(token: &str, keys: &[Value], binding: Binding, cache: &mut JtiCache) -> Result<IdJag, Fail> {
    let jws = id_jag_parse(token)?;
    let idp = idp_of(&map(), IDP_ISS, &[]).unwrap();
    let alg = id_jag_alg(&jws, Some(&idp))?;
    let names = [CLIENT];
    verify_id_jag(&jws, alg, keys, &idp, &IdJagCheck { issuer: ISSUER, client_names: &names, binding, now: NOW }, cache)
}

#[test]
fn id_jag_checks_follow_6_4() {
    let key = EcdsaKeyPair::generate(&ECDSA_P256_SHA256_FIXED_SIGNING).unwrap();
    let jwk = crate::api_issue::ec_public_jwk(&key, "o1");
    let keys = [jwk];
    let h = json!({"alg": "ES256", "typ": ID_JAG_TYP, "kid": "o1"});
    let b = Binding::Jkt("thumb");
    let mut cache = JtiCache::new(JAG_JTI_WINDOW);
    let good = jag(&key, h.clone(), claims());
    assert!(check_jag(&good, &keys, b, &mut cache).is_ok());
    assert_eq!(check_jag(&good, &keys, b, &mut cache).unwrap_err().code, "assertion", "replayed jti");
    let refused = |c: Value, hd: Value| {
        let mut cache = JtiCache::new(JAG_JTI_WINDOW);
        check_jag(&jag(&key, hd, c), &keys, b, &mut cache).unwrap_err().code
    };
    let with = |k: &str, v: Value| {
        let mut c = claims();
        c[k] = v;
        c
    };
    assert_eq!(refused(claims(), json!({"alg": "ES256", "typ": "JWT", "kid": "o1"})), "assertion", "wrong typ");
    assert_eq!(refused(claims(), json!({"alg": "HS256", "typ": ID_JAG_TYP, "kid": "o1"})), "assertion", "HMAC");
    assert_eq!(refused(with("aud", json!([ISSUER, "https://other"])), h.clone()), "assertion", "aud array of two");
    assert_eq!(refused(with("exp", json!(NOW - 1)), h.clone()), "assertion", "expired");
    assert_eq!(refused(with("exp", json!(NOW + 400)), h.clone()), "assertion", "exp - iat over max_age_s");
    let mut no_resource = claims();
    no_resource.as_object_mut().unwrap().remove("resource");
    assert_eq!(refused(no_resource, h.clone()), "assertion", "missing resource");
    assert_eq!(refused(with("client_id", json!("c_ffffffffffffffff")), h.clone()), "assertion", "wrong client_id");
    assert_eq!(refused(with("tenant", json!("t1")), h.clone()), "assertion", "tenant without a configured one");
    assert_eq!(refused(with("cnf", json!({"jkt": "other"})), h.clone()), "assertion", "R5-8: a DPoP key with another thumbprint");
    assert_eq!(refused(with("cnf", json!({"x5t#S256": "thumb"})), h.clone()), "assertion", "R5-8: x5t without mTLS");
    assert_eq!(refused(with("cnf", json!({"jwk": {}})), h.clone()), "assertion", "unsupported method");
    let mut cache = JtiCache::new(JAG_JTI_WINDOW);
    assert!(check_jag(&jag(&key, h, with("cnf", json!({"jkt": "thumb"}))), &keys, b, &mut cache).is_ok(), "matching cnf");
}

#[test]
fn the_idp_must_be_usable() {
    let c = client("R1");
    assert_eq!(idp_usable(None, &c, CLIENT, &[]).unwrap_err().code, "idp", "unknown iss");
    let idp = idp_of(&map(), IDP_ISS, &[]).unwrap();
    assert_eq!(idp_usable(Some(&idp), &c, CLIENT, &[]).unwrap(), "okta");
    let suspended = [entry("idp_suspend", json!("okta"))];
    assert_eq!(idp_usable(Some(&idp), &c, CLIENT, &suspended).unwrap_err().code, "idp", "suspended IdP");
}

#[test]
fn sign_in_strength_follows_r5_10() {
    let mut j = IdJag { iss: IDP_ISS.into(), sub: "00u1".into(), client_id: CLIENT.into(), jti: "j".into(), iat: NOW, exp: NOW + 60, auth_time: Some(NOW - 60),
                        resource: String::new(), scope: None, act: None, acr: None, amr: vec!["pwd".into()] };
    let identity = json!({"require_phishing_resistant": true, "providers": [{"id": "okta", "iss": IDP_ISS, "phr_values": ["phr"]}]});
    assert_eq!(strength_ok(Some(&identity), "okta", &j, AUTH_MAX_DEFAULT, NOW).unwrap_err().code, "assertion", "amr pwd refused");
    j.amr = vec!["phr".into()];
    assert!(strength_ok(Some(&identity), "okta", &j, AUTH_MAX_DEFAULT, NOW).is_ok());
    j.auth_time = Some(NOW - AUTH_MAX_DEFAULT - 1);
    assert_eq!(strength_ok(None, "okta", &j, AUTH_MAX_DEFAULT, NOW).unwrap_err().code, "assertion", "auth_time older than auth_max_s");
    j.auth_time = None;
    assert_eq!(strength_ok(None, "okta", &j, AUTH_MAX_DEFAULT, NOW).unwrap_err().code, "assertion", "auth_time required");
}

#[test]
fn the_idp_actor_is_nested_r5_21() {
    let a = nested_act(CLIENT, Some(&json!({"sub": "agent-1", "sub_profile": "ai_agent"}))).unwrap();
    assert_eq!(a, json!({"sub": CLIENT, "act": {"sub": "agent-1", "sub_profile": "ai_agent"}}));
    assert_eq!(nested_act(CLIENT, None).unwrap(), json!({"sub": CLIENT}));
    assert_eq!(nested_act(CLIENT, Some(&json!({"sub": "x".repeat(2000)}))).unwrap_err().code, "assertion");
    assert_eq!(nested_act(CLIENT, Some(&json!("agent"))).unwrap_err().code, "assertion");
}

#[test]
fn who_may_delegate_follows_6_1() {
    let c = client("R1");
    assert_eq!(ways_in(&c, CLIENT, &record("ann@acme.example", &["00g1"], true), &[]).unwrap(), vec!["group:00g1".to_string()]);
    assert_eq!(ways_in(&c, CLIENT, &record("bob@acme.example", &[], true), &[]).unwrap(), vec!["principal:bob@acme.example".to_string()]);
    assert_eq!(ways_in(&c, CLIENT, &record("ann@acme.example", &["00g1"], false), &[]).unwrap_err().code, "person", "inactive person");
    assert_eq!(ways_in(&c, CLIENT, &record("cat@acme.example", &["other"], true), &[]).unwrap_err().code, "person", "outside delegation groups");
    assert_eq!(ways_in(&c, CLIENT, &record("eve@acme.example", &["00g1"], true), &[]).unwrap_err().code, "person", "denied");
    let revoked = [entry("person_revoke", json!({"client": "*", "principal": "ann@acme.example"}))];
    assert_eq!(ways_in(&c, CLIENT, &record("ann@acme.example", &["00g1"], true), &revoked).unwrap_err().code, "person", "R5-3: person_revoke holds against a fresh grant");
    let dropped = [entry("client_drop_delegation", json!({"client": CLIENT, "group": "00g1"}))];
    assert!(!still_allowed(&c, CLIENT, "ann@acme.example", &["00g1".into()], &dropped), "R5-6: came only through the group");
    assert!(still_allowed(&c, CLIENT, "bob@acme.example", &["00g1".into()], &dropped), "still listed by principal");
    assert!(role_allows(Some("viewer"), "monitor.read") && !role_allows(Some("viewer"), "audit.read") && role_allows(Some("admin"), "audit.read") && !role_allows(None, "fleet.read"));
}

#[test]
fn person_revoke_reaches_offline_validation() {
    let org = "acme-revoke-test";
    assert!(!person_revoked_now(org, CLIENT, "ann@acme.example"));
    publish_revokes(org, &[ConsoleEntry { org: org.into(), ..entry("person_revoke", json!({"client": CLIENT, "principal": "ann@acme.example"})) }]);
    assert!(person_revoked_now(org, CLIENT, "ann@acme.example"));
    publish_revokes(org, &[]);
    assert!(!person_revoked_now(org, CLIENT, "ann@acme.example"));
}

fn family(id: &str) -> Family {
    Family { id: id.into(), client: CLIENT.into(), person: "ann@acme.example".into(), provider: "okta".into(), scopes: vec!["content.read".into()],
             resource: "r".into(), cnf: ("jkt".into(), "t".into()), consent_at: NOW, ends: NOW + 7 * DAY, auth_time: NOW, ways: vec!["group:00g1".into()],
             groups: vec!["00g1".into()], current: String::new(), used: Vec::new(), ended: None }
}

fn state() -> DelegatedState {
    DelegatedState::new(None, Arc::new(Mutex::new(crate::fleet_ca::MemVault::default())))
}

#[test]
fn refresh_families_rotate_and_reuse_revokes() {
    let s = state();
    let t1 = s.new_family(ORG, family("f1"), NOW).unwrap();
    assert!(t1.starts_with(REFRESH_PREFIX) && t1.len() == 4 + 43);
    let ok = |_: &Family| -> Result<(), Fail> { Ok(()) };
    assert!(matches!(s.redeem_refresh(ORG, &t1, CLIENT, NOW, None).unwrap(), Redeemed::Live(_, None)), "a check alone does not rotate");
    assert!(matches!(s.redeem_refresh(ORG, &t1, "c_other", NOW, Some(&ok)).unwrap(), Redeemed::Unknown), "another client's token is unknown");
    let Redeemed::Live(_, Some(t2)) = s.redeem_refresh(ORG, &t1, CLIENT, NOW, Some(&ok)).unwrap() else { panic!("rotates") };
    let refuse = |_: &Family| -> Result<(), Fail> { Err(Fail::new("audit-unavailable", "no audit")) };
    assert_eq!(s.redeem_refresh(ORG, &t2, CLIENT, NOW, Some(&refuse)).unwrap_err().code, "audit-unavailable");
    assert!(matches!(s.redeem_refresh(ORG, &t2, CLIENT, NOW, None).unwrap(), Redeemed::Live(_, None)), "a failed hook keeps no rotation");
    assert!(matches!(s.redeem_refresh(ORG, &t1, CLIENT, NOW, None).unwrap(), Redeemed::Reused(_, true)), "a used refresh token is reuse");
    assert!(s.live_families(ORG, NOW).unwrap().is_empty(), "reuse revokes the family");
    assert!(matches!(s.redeem_refresh(ORG, &t1, CLIENT, NOW, None).unwrap(), Redeemed::Reused(_, false)));
    assert!(matches!(s.redeem_refresh(ORG, &t2, CLIENT, NOW, Some(&ok)).unwrap(), Redeemed::Unknown), "an ended family does not rotate");
    assert!(matches!(s.redeem_refresh(ORG, "lrt_unknown", CLIENT, NOW, None).unwrap(), Redeemed::Unknown));
    assert_eq!(family("f").end_at(7), NOW + 7 * DAY);
    assert_eq!(family("f").end_at(1), NOW + DAY, "client_limit_delegation shortens the family");
    let _ = s.new_family(ORG, family("f2"), NOW).unwrap();
    assert_eq!(s.end_families(ORG, NOW, &|f| f.person == "ann@acme.example", "person_revoke").unwrap(), 1);
    let _ = s.new_family(ORG, family("f3"), NOW).unwrap();
    assert!(s.live_families(ORG, NOW + 8 * DAY).unwrap().is_empty(), "a family past its end is gone");
}

/// Review P1: two concurrent uses of one refresh token never both rotate; the loser is reuse and ends the family.
#[test]
fn concurrent_refreshes_rotate_once() {
    for _ in 0..50 {
        let s = Arc::new(state());
        let t1 = s.new_family(ORG, family("f1"), NOW).unwrap();
        let gate = Arc::new(std::sync::Barrier::new(2));
        let runs: Vec<_> = (0..2)
            .map(|_| {
                let (s, t1, gate) = (s.clone(), t1.clone(), gate.clone());
                std::thread::spawn(move || {
                    let slow = |_: &Family| -> Result<(), Fail> {
                        std::thread::sleep(std::time::Duration::from_millis(1));
                        Ok(())
                    };
                    gate.wait();
                    s.redeem_refresh(ORG, &t1, CLIENT, NOW, Some(&slow)).unwrap()
                })
            })
            .collect();
        let got: Vec<Redeemed> = runs.into_iter().map(|h| h.join().unwrap()).collect();
        let rotated = got.iter().filter(|r| matches!(r, Redeemed::Live(_, Some(_)))).count();
        let reused = got.iter().filter(|r| matches!(r, Redeemed::Reused(_, true))).count();
        assert_eq!((rotated, reused), (1, 1), "one use rotates, the other is reuse: {got:?}");
        assert!(s.live_families(ORG, NOW).unwrap().is_empty(), "the reuse ends the family, so the rotated token is dead too");
        let next = got.iter().find_map(|r| if let Redeemed::Live(_, Some(t)) = r { Some(t.clone()) } else { None }).unwrap();
        assert!(matches!(s.redeem_refresh(ORG, &next, CLIENT, NOW, None).unwrap(), Redeemed::Unknown));
    }
}

#[test]
fn a_code_is_single_use() {
    let s = state();
    let c = Code { org: ORG.into(), client_id: CLIENT.into(), redirect_uri: "http://127.0.0.1/callback".into(), challenge: s256("v"), resource: "r".into(),
                   scopes: vec![], principal: "ann@acme.example".into(), provider: "okta".into(), auth_time: NOW, dpop_jkt: None, at: NOW, used: false, family: None };
    s.put_code(token_hash("code"), c, NOW).unwrap();
    assert!(matches!(s.take_code(&token_hash("code")), Taken::Fresh(_)));
    s.code_family(&token_hash("code"), "f9");
    assert_eq!(s.take_code(&token_hash("code")), Taken::Used(Some("f9".into())), "a second use names the family to revoke");
    assert_eq!(s.take_code(&token_hash("other")), Taken::Unknown);
}

#[test]
fn recent_issuance_is_tracked_for_drops() {
    let s = state();
    s.track(ORG, CLIENT, "ann@acme.example", "jwt_bearer", &["group:00g1".into(), "idp:okta".into()], &["00g1".into()], NOW).unwrap();
    assert_eq!(s.through(ORG, CLIENT, "group:00g1", NOW + 60).unwrap(), vec![("ann@acme.example".to_string(), vec!["00g1".to_string()])]);
    assert!(s.through(ORG, CLIENT, "group:00g1", NOW + TRACK_WINDOW).unwrap().is_empty(), "only the last 10 minutes");
}

/// R5-6: the groups `through` gives a principal are those of their newest tracked issuance across every grant, else
/// of their newest live family, never whichever snapshot sorts first.
#[test]
fn through_uses_the_newest_group_snapshot() {
    let s = state();
    // older code-grant token through group 00g1 (still a member of 00g2 then); newer jwt-bearer token, no longer in 00g2
    s.track(ORG, CLIENT, "ann@acme.example", "authorization_code", &["group:00g1".into()], &["00g1".into(), "00g2".into()], NOW).unwrap();
    s.track(ORG, CLIENT, "ann@acme.example", "jwt_bearer", &["group:00g1".into()], &["00g1".into()], NOW + 30).unwrap();
    assert_eq!(s.through(ORG, CLIENT, "group:00g1", NOW + 60).unwrap(), vec![("ann@acme.example".to_string(), vec!["00g1".to_string()])]);
    // the newest snapshot wins even when it came by another grant and through another way
    let s = state();
    s.track(ORG, CLIENT, "ann@acme.example", "jwt_bearer", &["group:00g1".into()], &["00g1".into(), "00g2".into()], NOW).unwrap();
    s.track(ORG, CLIENT, "ann@acme.example", "authorization_code", &["group:00g3".into()], &["00g3".into()], NOW + 120).unwrap();
    assert_eq!(s.through(ORG, CLIENT, "group:00g1", NOW + 130).unwrap(), vec![("ann@acme.example".to_string(), vec!["00g3".to_string()])]);
    // no tracked issuance: the newest live family's groups
    let s = state();
    s.new_family(ORG, Family { groups: vec!["00g1".into(), "00g2".into()], ..family("f1") }, NOW).unwrap();
    s.new_family(ORG, Family { groups: vec!["00g1".into()], consent_at: NOW + 50, ..family("f2") }, NOW + 50).unwrap();
    assert_eq!(s.through(ORG, CLIENT, "group:00g1", NOW + 60).unwrap(), vec![("ann@acme.example".to_string(), vec!["00g1".to_string()])]);
}

/// R5-6: a full tracker refuses a new key (503 `journal`, OAuth `temporarily_unavailable`) instead of dropping it, so
/// no delegated token is issued untracked; a key it holds is still updated.
#[test]
fn a_full_tracker_refuses_new_issuances() {
    let s = state();
    for n in 0..HELD_MAX {
        s.track(ORG, CLIENT, &format!("p{n}@acme.example"), "jwt_bearer", &[], &[], NOW).unwrap();
    }
    let full = s.track(ORG, CLIENT, "late@acme.example", "jwt_bearer", &["group:00g1".into()], &[], NOW + 1).unwrap_err();
    assert_eq!((full.code, full.why.as_str()), ("journal", TRACK_FULL));
    assert_eq!(issue::shape(full.code), (503, "temporarily_unavailable"));
    s.track(ORG, CLIENT, "p0@acme.example", "jwt_bearer", &["group:00g1".into()], &[], NOW + 2).unwrap();
    assert_eq!(s.through(ORG, CLIENT, "group:00g1", NOW + 3).unwrap().len(), 1, "the held key was updated");
    // keys older than 24 hours make room again
    s.track(ORG, CLIENT, "late@acme.example", "jwt_bearer", &[], &[], NOW + USE_WINDOW).unwrap();
}

#[test]
fn delegated_uses_are_kept_24_hours_per_grant() {
    let s = state();
    s.track(ORG, CLIENT, "ann@acme.example", "jwt_bearer", &["group:00g1".into()], &["00g1".into()], NOW).unwrap();
    s.track(ORG, CLIENT, "ann@acme.example", "jwt_bearer", &["group:00g1".into()], &["00g1".into()], NOW + 120).unwrap();
    s.track(ORG, CLIENT, "bob@acme.example", "authorization_code", &["principal:bob@acme.example".into()], &[], NOW + 60).unwrap();
    let later = NOW + TRACK_WINDOW + 300;
    assert!(s.through(ORG, CLIENT, "group:00g1", later).unwrap().is_empty(), "through keeps its 10-minute rule");
    let uses = s.uses(ORG, Some(CLIENT), later).unwrap();
    assert_eq!(uses.len(), 2);
    assert_eq!((uses[0].person.as_str(), uses[0].grant.as_str(), uses[0].first, uses[0].last), ("ann@acme.example", "jwt_bearer", NOW, NOW + 120), "newest last use first");
    assert_eq!((uses[1].person.as_str(), uses[1].grant.as_str(), uses[1].ends), ("bob@acme.example", "authorization_code", None));
    assert!(s.uses(ORG, Some("c_ffffffffffffffff"), later).unwrap().is_empty(), "another client's list is empty");
    assert!(s.uses(ORG, None, NOW + 120 + USE_WINDOW).unwrap().is_empty(), "only the last 24 hours");
    // live refresh families give their uses an end, and are listed on their own without a recent token
    let s = state();
    s.track(ORG, CLIENT, "ann@acme.example", "authorization_code", &[], &[], NOW + 30).unwrap();
    s.new_family(ORG, family("f1"), NOW).unwrap();
    s.new_family(ORG, Family { person: "cy@acme.example".into(), ..family("f2") }, NOW).unwrap();
    let u = s.uses(ORG, None, NOW + 60).unwrap();
    assert_eq!(u.len(), 2);
    assert_eq!((u[0].person.as_str(), u[0].ends), ("ann@acme.example", Some(NOW + 7 * DAY)));
    assert_eq!((u[1].person.as_str(), u[1].grant.as_str(), u[1].first, u[1].ends), ("cy@acme.example", "authorization_code", NOW, Some(NOW + 7 * DAY)));
}

#[test]
fn authorize_answers_carry_r5_22_headers() {
    let h = authz_headers("frame-ancestors 'none'");
    for (k, v) in [("Content-Security-Policy", "frame-ancestors 'none'"), ("X-Frame-Options", "DENY"), ("Cache-Control", "no-store"), ("Referrer-Policy", "no-referrer")] {
        assert!(h.iter().any(|(a, b)| *a == k && b == v), "{k}");
    }
    let r = error_page(400, "x");
    assert!(r.headers.iter().any(|(k, v)| *k == "Content-Security-Policy" && v.contains("frame-ancestors 'none'")));
    let deny = back("https://app.example/cb", &[("error", "access_denied")], Some("s1"), ISSUER);
    assert!(deny.contains("error=access_denied") && deny.contains("state=s1") && deny.contains("iss="), "R5-22: iss on the Deny redirect");
    assert_eq!(cookie_value(Some("a=b; __Host-lucid-authz=xyz; c=d")), Some("xyz"));
}

#[test]
fn the_authorize_routes_are_in_the_table() {
    use crate::api_resource::{route_of, RouteId, Side};
    let id = |m: &str, p: &str| route_of(Side::FrontDoor, m, p).map(|x| x.route.id);
    assert_eq!(id("GET", "/api/orgs/acme/oauth/authorize"), Some(RouteId::Authorize));
    assert_eq!(id("POST", "/api/orgs/acme/oauth/sso-return"), Some(RouteId::SsoReturn));
    assert_eq!(id("GET", "/api/orgs/acme/oauth/consent"), Some(RouteId::Consent));
    assert_eq!(id("POST", "/api/orgs/acme/oauth/consent"), Some(RouteId::ConsentPost));
    assert_eq!(id("GET", "/.well-known/oauth-protected-resource/api/orgs/acme/mcp"), Some(RouteId::McpMetadata));
    assert_eq!(route_of(Side::Relay, "GET", "/api/orgs/acme/oauth/authorize").map(|x| x.route.id), None, "never on a relay");
}

// ── the vectors of 19 (`delegated_vectors`) ──

fn dv_list(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or_default()
}

fn dv_str<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or_default()
}

fn dv_int(v: &Value, k: &str) -> i64 {
    v.get(k).and_then(Value::as_i64).unwrap_or_else(|| panic!("{k} of {v}"))
}

/// The active console journal entries of a case (`{action, target}`).
fn dv_console(v: &Value) -> Vec<ConsoleEntry> {
    dv_list(v).iter().map(|e| entry(dv_str(e, "action"), e["target"].clone())).collect()
}

/// The request's proof: `{"jkt"}` of its DPoP key or `{"x5t#S256"}` of its certificate.
fn dv_binding(b: &Value) -> Binding<'_> {
    match (b.get("jkt").and_then(Value::as_str), b.get("x5t#S256").and_then(Value::as_str)) {
        (Some(j), None) => Binding::Jkt(j),
        (None, Some(x)) => Binding::X5t(x),
        _ => panic!("a binding is one of jkt and x5t#S256: {b}"),
    }
}

fn dv_ask(a: &Value) -> Ask<'_> {
    match (a.get("sub").and_then(Value::as_str), a.get("principal").and_then(Value::as_str)) {
        (Some(s), None) => Ask::Sub(s),
        (None, Some(p)) => Ask::Principal(p),
        _ => panic!("an ask is one of sub and principal: {a}"),
    }
}

fn dv_registry(v: &Value) -> Vec<IdentityProvider> {
    dv_list(&v["registry"])
        .iter()
        .map(|e| IdentityProvider {
            org: dv_str(e, "org").into(),
            id: dv_str(e, "id").into(),
            kind: dv_str(e, "kind").into(),
            iss: dv_str(e, "iss").into(),
            sso_serial: dv_str(e, "sso_serial").into(),
            cloud: String::new(),
        })
        .collect()
}

/// One `idjag` case through the EMA checks in `ema`'s order (6.4 steps 3 to 5): the code and, for `ok`, the token's
/// `act`.
fn dv_idjag(v: &Value, c: &Value, root: &Cert, registry: &[IdentityProvider]) -> (&'static str, Option<Value>) {
    let env = &v["idjag_env"];
    let (now, issuer, org, id) = (dv_int(v, "now"), dv_str(v, "issuer"), dv_str(v, "org"), dv_str(v, "client_id"));
    let presented = dv_str(c, "client");
    let console = dv_console(&c["console"]);
    if dv_str(c, "auth") == "none" {
        // O17, R5-8: `ema` refuses a public (keyless) client before it reads the assertion; `grant` is closed by the
        // G-EMA-OKTA-SUB gate, so the vector checks that the client is public and the code's OAuth shape
        let doc = check_cimd(presented, &env["cimd"][presented], false).unwrap_or_else(|e| panic!("{}: {e}", c["name"]));
        assert!(doc.public, "{}: the client is public", c["name"]);
        assert_eq!(crate::api_issue::shape("client-auth"), (401, "invalid_client"));
        return ("client-auth", None);
    }
    let map = obj(env["map"].clone());
    let client = obj(env["client"].clone());
    let jws = match id_jag_parse(dv_str(c, "token")) {
        Ok(j) => j,
        Err(f) => return (f.code, None),
    };
    let iss = jws.claims.get("iss").and_then(Value::as_str).unwrap_or_default();
    let idp = idp_of(&map, iss, &console);
    let alg = match id_jag_alg(&jws, idp.as_ref()) {
        Ok(a) => a,
        Err(f) => return (f.code, None),
    };
    let idp_id = match idp_usable(idp.as_ref(), &client, id, &console) {
        Ok(x) => x,
        Err(f) => return (f.code, None),
    };
    let idp = idp.unwrap_or_default();
    let keys = dv_list(&env["jwks"][iss]).to_vec();
    let mut cache = JtiCache::new(JAG_JTI_WINDOW);
    for j in dv_list(&c["seen"]) {
        tok::admit_jti(&mut cache, &idp_id, j.as_str().unwrap(), now).unwrap();
    }
    let names = [id, presented];
    let check = IdJagCheck { issuer, client_names: &names, binding: dv_binding(&c["binding"]), now };
    let jag = match verify_id_jag(&jws, alg, &keys, &idp, &check, &mut cache) {
        Ok(j) => j,
        Err(f) => return (f.code, None),
    };
    match resolve_resource(&map, org, &client, id, Some(&jag.resource), &console) {
        Ok(Resolved::Chosen(aud, _)) => assert_eq!(aud, jag.resource, "{}: aud is the requested resource only", c["name"]),
        Ok(Resolved::Legacy) => return ("target", None),
        Err(f) => return (f.code, None),
    }
    let provider = idp.get("provider").and_then(Value::as_str).unwrap_or_default();
    let Some(entry) = registry.iter().find(|p| p.org == org && p.id == provider) else { return ("idp", None) };
    let none = json!({"record": null});
    let answer = dv_list(&env["subjects"]).iter().find(|s| dv_str(s, "provider") == entry.id && dv_str(s, "sub") == jag.sub).map_or(&none, |s| &s["answer"]);
    let Ok(record) = subject::verify_answer(answer, root, entry, org, &Ask::Sub(&jag.sub), now) else { return ("person", None) };
    if let Err(f) = ways_under(&obj(v["policy"].clone()), &client, id, &record, &console) {
        return (f.code, None);
    }
    let auth_max = idp.get("auth_max_s").and_then(Value::as_i64).unwrap_or(AUTH_MAX_DEFAULT);
    if let Err(f) = strength_ok(env.get("identity").filter(|i| !i.is_null()), &entry.id, &jag, auth_max, now) {
        return (f.code, None);
    }
    match nested_act(id, jag.act.as_ref()) {
        Ok(a) => ("ok", Some(a)),
        Err(f) => (f.code, None),
    }
}

/// What each step of a `codes` or `refresh` sequence should give.
fn dv_expected(seq: &Value) -> Vec<String> {
    dv_list(&seq["steps"])
        .iter()
        .map(|s| match dv_str(s, "op") {
            "redeem" | "refresh" => dv_str(s, "expect").to_string(),
            "live" => {
                let mut ids: Vec<&str> = dv_list(&s["families"]).iter().filter_map(Value::as_str).collect();
                ids.sort_unstable();
                ids.join(",")
            }
            _ => String::new(),
        })
        .collect()
}

/// A `codes` or `refresh` sequence on a fresh state: codes taken as `code_grant` takes them (single use, a second use
/// ends the family its first made, 60 s, client and redirect, then the S256 verifier) and refresh tokens as
/// `refresh_grant` finds, ends and rotates them. Refresh tokens are random, so the labels of the vector map to them.
fn dv_steps(seq: &Value, id: &str) -> Vec<String> {
    let s = state();
    let pinned = dv_int(seq, "consent_days");
    let mut console: Vec<ConsoleEntry> = Vec::new();
    let mut tokens: HashMap<String, String> = HashMap::new();
    let start = |s: &DelegatedState, console: &[ConsoleEntry], fid: &str, at: i64| -> String {
        let days = cj::consent_days(pinned, console, id);
        let f = Family { id: fid.into(), client: id.into(), consent_at: at, ends: at + days * DAY, auth_time: at, ..family(fid) };
        s.new_family(ORG, f, at).unwrap()
    };
    let mut out = Vec::new();
    for step in dv_list(&seq["steps"]) {
        let at = step.get("at").and_then(Value::as_i64).unwrap_or_default();
        let text = |k: &str| dv_str(step, k).to_string();
        let got = match dv_str(step, "op") {
            "issue" => {
                let c = Code { org: ORG.into(), client_id: text("client_id"), redirect_uri: text("redirect_uri"), challenge: text("challenge"), resource: String::new(),
                               scopes: vec![], principal: "ann@acme.example".into(), provider: "okta".into(), auth_time: at, dpop_jkt: None, at, used: false, family: None };
                s.put_code(token_hash(dv_str(step, "code")), c, at).unwrap();
                String::new()
            }
            "redeem" => {
                let hash = token_hash(dv_str(step, "code"));
                match s.take_code(&hash) {
                    Taken::Fresh(c) if c.at + CODE_LIFE <= at || c.client_id != dv_str(step, "client_id") || c.redirect_uri != dv_str(step, "redirect_uri") => "consent".into(),
                    Taken::Fresh(c) if !pkce_matches(dv_str(step, "verifier"), &c.challenge) => "pkce".into(),
                    Taken::Fresh(_) => {
                        let fid = dv_str(step, "family");
                        tokens.insert(text("next"), start(&s, &console, fid, at));
                        s.code_family(&hash, fid);
                        "ok".into()
                    }
                    Taken::Used(made) => {
                        if let Some(f) = made {
                            s.end_family(ORG, &f, "code-reuse", at).unwrap();
                        }
                        "consent".into()
                    }
                    Taken::Unknown => "consent".into(),
                }
            }
            "start" => {
                tokens.insert(text("next"), start(&s, &console, dv_str(step, "family"), at));
                String::new()
            }
            "refresh" => {
                let presented = tokens.get(dv_str(step, "token")).cloned().unwrap_or_else(|| text("token"));
                match s.redeem_refresh(ORG, &presented, id, at, None).unwrap() {
                    Redeemed::Live(f, _) => {
                        if at >= f.end_at(cj::consent_days(pinned, &console, id)) {
                            s.end_family(ORG, &f.id, "consent_days", at).unwrap();
                            "consent".into()
                        } else {
                            let ok = |_: &Family| -> Result<(), Fail> { Ok(()) };
                            let Redeemed::Live(_, Some(next)) = s.redeem_refresh(ORG, &presented, id, at, Some(&ok)).unwrap() else { panic!("rotates") };
                            tokens.insert(text("next"), next);
                            "ok".into()
                        }
                    }
                    _ => "consent".into(),
                }
            }
            "limit" => {
                console.push(entry("client_limit_delegation", json!({"client": id, "consent_days": step["consent_days"]})));
                String::new()
            }
            "live" => {
                let mut ids: Vec<String> = s.live_families(ORG, at).unwrap().into_iter().map(|f| f.id).collect();
                ids.sort_unstable();
                ids.join(",")
            }
            op => panic!("{}: unknown step {op}", seq["name"]),
        };
        out.push(got);
    }
    out
}

/// A request waiting for its SSO attestation (6.5 step 2).
fn dv_waiting(org: &str, client: &str, now: i64) -> Waiting {
    Waiting { org: org.into(), client: client.into(), client_id: client.into(), redirect_uri: "http://127.0.0.1/callback".into(), challenge: String::new(),
              resource: String::new(), scopes: vec![], state: None, dpop_jkt: None, cookie: String::new(), provider: "okta".into(), at: now, person: None, csrf: None }
}

/// 19: `api_delegated_v1.json` (Hub `tests/vectors/make_api_delegated_v1.py`), read from the crate copy; each section
/// through the functions that implement it.
#[test]
fn delegated_vectors() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/api_delegated_v1.json");
    let Ok(text) = std::fs::read_to_string(&path) else {
        eprintln!("skipped: {} is absent (run the Hub's tests/vectors/make_api_delegated_v1.py and copy it here)", path.display());
        return;
    };
    let v: Value = serde_json::from_str(&text).unwrap();
    let (now, org, id) = (dv_int(&v, "now"), dv_str(&v, "org"), dv_str(&v, "client_id"));
    let root = Cert::from_pem(v["certs"]["root_pem"].as_str().unwrap()).unwrap();
    let registry = dv_registry(&v);
    let want = |c: &Value| dv_str(c, "expect").to_string();

    // 6.4 EMA (18 "EMA", R5-3, R5-8, R5-21)
    for c in dv_list(&v["idjag"]) {
        let (code, act) = dv_idjag(&v, c, &root, &registry);
        assert_eq!(code, want(c), "idjag/{}", c["name"]);
        if code == "ok" {
            assert_eq!(act.as_ref(), Some(&c["act"]), "idjag/{}: act", c["name"]);
        }
    }

    // R5-8: cnf
    for c in dv_list(&v["cnf"]) {
        let got = cnf_ok(c.get("cnf").filter(|x| !x.is_null()), &dv_binding(&c["binding"]));
        assert_eq!(got.map_or_else(|f| f.code, |()| "ok"), want(c), "cnf/{}", c["name"]);
    }

    // R5-10: sign-in strength (`method_matches` over amr and acr, auth_time against auth_max_s)
    for c in dv_list(&v["method_matches"]) {
        let jag = IdJag { iss: String::new(), sub: "s".into(), client_id: id.into(), jti: String::new(), iat: now, exp: now + 60, auth_time: c["auth_time"].as_i64(),
                          resource: String::new(), scope: None, act: None, acr: c["acr"].as_str().map(str::to_string), amr: strings(c.get("amr")) };
        let got = strength_ok(c.get("identity").filter(|i| !i.is_null()), dv_str(c, "provider"), &jag, dv_int(c, "auth_max_s"), now);
        assert_eq!(got.map_or_else(|f| f.code, |()| "ok"), want(c), "method_matches/{}", c["name"]);
    }

    // 4.1 CIMD: the fetch's address check (8.1), the document, the presented redirect (RFC 8252 7.3)
    for c in dv_list(&v["cimd"]) {
        let (url, private_ok) = (dv_str(c, "url"), c["private_ok"].as_bool().unwrap());
        let reachable = crate::api_fetch::check_url(url).is_ok_and(|u| match u.host {
            crate::api_fetch::Host::Ip(ip) => crate::api_fetch::address_allowed(ip, private_ok),
            crate::api_fetch::Host::Name(_) => true,
        });
        let got = match check_cimd(url, &c["doc"], private_ok) {
            _ if !reachable => "client",
            Err(_) => "client",
            Ok(doc) if registered_redirects(&Obj::new(), id, Some(&doc), &[]).iter().any(|r| redirect_matches(r, dv_str(c, "redirect_uri"))) => "ok",
            Ok(_) => "redirect",
        };
        assert_eq!(got, want(c), "cimd/{}", c["name"]);
    }

    // PKCE: `authorize_get` takes S256 with a well formed challenge only; `code_grant` the verifier
    for c in dv_list(&v["pkce"]) {
        let (verifier, challenge) = (dv_str(c, "verifier"), dv_str(c, "challenge"));
        let ok = dv_str(c, "method") == "S256" && challenge_ok(challenge) && pkce_matches(verifier, challenge);
        assert_eq!(if ok { "ok" } else { "pkce" }, want(c), "pkce/{}", c["name"]);
    }

    // 6.5 codes and refresh families
    for section in ["codes", "refresh"] {
        for seq in dv_list(&v[section]) {
            assert_eq!(dv_steps(seq, id), dv_expected(seq), "{section}/{}", seq["name"]);
        }
    }

    // 6.6 and R5-21: the token's act, and the check of a delegated token's sub and act
    let client = obj(v["idjag_env"]["client"].clone());
    for c in dv_list(&v["delegated_tokens"]) {
        let cid = dv_str(c, "client_id");
        let code = match nested_act(cid, c.get("idjag_act").filter(|a| !a.is_null())) {
            Err(f) => {
                assert!(c["act"].is_null(), "delegated_tokens/{}: no act", c["name"]);
                f.code
            }
            Ok(act) => {
                assert_eq!(act, c["act"], "delegated_tokens/{}: act", c["name"]);
                let jws = tok::parse_jws(dv_str(c, "token")).unwrap();
                match tok::delegated_subject(&jws, &client, org, cid) {
                    Ok((person, got)) => {
                        assert_eq!(person.as_deref(), jws.claims.get("sub").and_then(Value::as_str), "delegated_tokens/{}: person", c["name"]);
                        assert_eq!(got.as_ref(), Some(&act), "delegated_tokens/{}: the token's act", c["name"]);
                        "ok"
                    }
                    Err(e) => e.code,
                }
            }
        };
        assert_eq!(code, want(c), "delegated_tokens/{}", c["name"]);
    }

    // R5-2: the attestation as `sso_return` takes it (the waiting request first, single use, then the attestation)
    let okta = registry.iter().find(|p| p.id == "okta").unwrap();
    let sso_return = dv_str(&v, "sso_return");
    for c in dv_list(&v["sso_api_att"]) {
        assert_eq!(att_bytes(&c["wire"]["att"]).map(|b| b64u(&b)).as_deref(), c["bytes_b64u"].as_str(), "sso_api_att/{}: bytes", c["name"]);
        let s = state();
        for r in dv_list(&c["waiting"]) {
            s.put_waiting(r.as_str().unwrap(), dv_waiting(org, id, now), now).unwrap();
        }
        let att = dv_str(c, "att");
        let codes: Vec<&str> = (0..dv_int(c, "uses"))
            .map(|_| {
                let Some(req) = att_req(att) else { return "assertion" };
                if s.get_waiting(&req, now).is_none() {
                    return "consent";
                }
                s.take_waiting(&req);
                verify_attestation(att, &root, okta, org, sso_return, &req, now).map_or_else(|f| f.code, |_| "ok")
            })
            .collect();
        let expect: Vec<&str> = dv_list(&c["expect"]).iter().filter_map(Value::as_str).collect();
        assert_eq!(codes, expect, "sso_api_att/{}", c["name"]);
    }

    // R5-1: person records at the console (`verify_answer`) and at the relay (`check_post`)
    let policy = obj(v["policy"].clone());
    for c in dv_list(&v["sso_person"]) {
        let provider = dv_str(c, "provider");
        let entry = registry.iter().find(|p| p.org == org && p.id == provider).unwrap();
        let got = if dv_str(c, "stage") == "relay" {
            let (answer, w) = (&c["answer"], &c["who"]);
            let who = crate::meet::Identity { kind: dv_str(w, "kind").into(), serial: dv_str(w, "serial").into(), orgs: strings(w.get("orgs")), cert_pem: dv_str(answer, "cert_pem").into(), ..Default::default() };
            let body = obj(json!({"org": org, "provider": provider, "records": [answer["record"].clone()]}));
            let held = c["held_ts"].as_i64();
            match subject::check_post(&body, &who, Some(entry), Some(&policy), &|_| held) {
                Ok(_) => "stored",
                Err(crate::meet::E::Conflict(_)) => "conflict",
                Err(crate::meet::E::Forbidden(_)) => "forbidden",
                Err(crate::meet::E::Bad(_)) => "bad",
                Err(e) => panic!("sso_person/{}: {e:?}", c["name"]),
            }
        } else {
            subject::verify_answer(&c["answer"], &root, entry, org, &dv_ask(&c["ask"]), now).map_or_else(|w| w, |_| "verified")
        };
        assert_eq!(got, want(c), "sso_person/{}", c["name"]);
    }
}

/// 6.4 acceptance: an ID-JAG minted by a live Okta tenant (Cross App Access) for this console.
#[test]
#[ignore = "live gate G-EMA-OKTA-SUB"]
fn live_okta_id_jag() {
    let token = std::env::var("LUCID_GATE_EMA_OKTA_SUB_IDJAG").expect("an ID-JAG from the test tenant");
    let jws = id_jag_parse(&token).unwrap();
    assert_eq!(jws.header.get("alg").and_then(Value::as_str), Some("RS256"));
    assert!(jws.claims.get("sub").and_then(Value::as_str).is_some_and(|s| s.starts_with("00u")), "the Okta user id is the sub (G-EMA-OKTA-SUB)");
}
