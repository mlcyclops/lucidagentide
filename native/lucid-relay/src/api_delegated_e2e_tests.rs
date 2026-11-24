// End-to-end tests of `api_delegated` (revision 5 18): the real token endpoint (`api_issue::token`) and Authorize
// pipeline (`authorize`) over a pinned test map, with a fake console host whose fleet link answers `api-subject` and
// `api-org-policy` from records and a policy signed under a test Meet CA root (which also issues the SSO certificate).

use super::*;
use crate::api_cjournal::Reach;
use crate::api_issue::{ClientCert, IssueState};
use crate::meet_json as pj;
use crate::meet_tls::testpki::{Ca, Key};
use aws_lc_rs::rand::SystemRandom;
use aws_lc_rs::signature::{EcdsaKeyPair, ECDSA_P256_SHA256_ASN1_SIGNING, ECDSA_P256_SHA256_FIXED_SIGNING};
use std::cell::{Cell, RefCell};
use std::time::Duration;

const ORG: &str = "acme";
const ISSUER: &str = "https://console.acme.example:7443/api/orgs/acme";
const ENDPOINT: &str = "https://console.acme.example:7443/api/orgs/acme/oauth/token";
const KID: &str = "k-2026-11";
const CLIENT: &str = "c_0b1c2d3e4f5a6b7c";
const PUBLIC: &str = "c_1a2b3c4d5e6f7a8b";
const IDP_ISS: &str = "https://acme.okta.com";
const SSO_URL: &str = "https://sso.acme.example:8443";
const K1: &str = "k_7a1b2c3d4e5f6a7b";
const CONN: &str = "https://connector.acme.example:9445";
/// Not a principal other tests revoke (the `person_revoke` copy read by validation is process-wide).
const ANN: &str = "nia.e2e@acme.example";
const OWNER: &str = "olga@acme.example";
const REDIRECT: &str = "https://app.acme.example/cb";
const VERIFIER: &str = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const ASSERTION_TYPE: &str = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

fn cm() -> String {
    connector_mcp_resource(CONN, ORG)
}

fn c_resource() -> String {
    connector_resource(CONN, ORG)
}

fn source() -> IpAddr {
    "10.40.0.9".parse().unwrap()
}

/// A standard base64 DER ECDSA P-256 SHA-256 signature by a test PKI key.
fn sign_der(key: &Key, data: &[u8]) -> String {
    let pair = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, &key.pkcs8).unwrap();
    pj::b64(pair.sign(&SystemRandom::new(), data).unwrap().as_ref())
}

fn provider() -> IdentityProvider {
    IdentityProvider { org: ORG.into(), id: "okta".into(), kind: "okta".into(), iss: IDP_ISS.into(), sso_serial: "1a".into(), cloud: String::new() }
}

/// The relay's `api-org-policy` answer: a version 3 signer policy and an org policy requiring phishing-resistant
/// sign-in (`acr:phr` for Okta), both signed by `ca`.
fn policy_answer(ca: &Ca, now: i64) -> Value {
    let mut sp = json!({"v": 3, "org_domains": {"acme": ["acme.example"]},
                        "sso_services": [{"serial": "1a", "orgs": [ORG], "domains": ["acme.example"]}],
                        "identity_providers": [{"org": ORG, "id": "okta", "kind": "okta", "iss": IDP_ISS, "sso_serial": "1a", "allowed_domains": ["acme.example"]}]});
    sp["policy_sig"] = json!(sign_der(&ca.key, &op::canonical_json(&sp).unwrap()));
    let policy = json!({"v": 1, "org": ORG, "label": "Acme", "domains": ["acme.example"], "seq": 1, "issued": now - 100, "expires": now + 30 * DAY,
                        "identity": {"v": 2, "require_phishing_resistant": true, "providers": [{"id": "okta", "iss": IDP_ISS, "phr_values": ["acr:phr"]}]}});
    let sig = sign_der(&ca.key, &op::signed_bytes(policy.as_object().unwrap()));
    let wire = json!({"policy": policy, "sig": sig, "chain": []});
    org_policy_answer(wire.as_object().cloned(), sp)
}

fn centry(action: &str, target: Value, now: i64) -> ConsoleEntry {
    ConsoleEntry { id: "k_acme_000001".into(), org: ORG.into(), cseq: 1, ts: now, action: action.into(), target, reach: Reach::Console, prev_cseq: Some(0) }
}

// ── the fake console ─────────────────────────────────────────────────────────────────────────────────────────────

struct Host {
    ca_der: Vec<u8>,
    crl_pem: RefCell<Option<String>>,
    sso_pem: String,
    /// Signed person record wires the relay holds.
    records: RefCell<Vec<Value>>,
    /// The `api-org-policy` answer.
    policy: RefCell<Value>,
    /// What a relay asked before the one answering `policy` returns, when set.
    first_relay: RefCell<Option<Result<Value, String>>>,
    /// A relay of the org is connected.
    relay_up: Cell<bool>,
    console: RefCell<Vec<ConsoleEntry>>,
    audits: RefCell<Vec<Value>>,
    /// The console role of every person (6.1, reach R0 scopes); None by default.
    role: RefCell<Option<String>>,
    /// The console's mail is on (the mailer takes mail).
    mail_on: Cell<bool>,
    /// The delegation notices the mailer took: (to, args).
    mails: RefCell<Vec<(String, Vec<(String, String)>)>>,
}

impl DelegatedHost for Host {
    fn api_subject(&self, _org: &str, request: &Value) -> Result<Value, String> {
        if !self.relay_up.get() {
            return Err("no relay of the organization is connected".into());
        }
        let wanted = |w: &&Value| {
            let r = &w["record"];
            r["provider"] == request["provider"]
                && match (request.get("sub"), request.get("principal")) {
                    (Some(x), None) => r["sub"] == *x,
                    (None, Some(p)) => r["principal"] == *p,
                    _ => false,
                }
        };
        Ok(match self.records.borrow().iter().rev().find(wanted) {
            Some(w) => json!({"record": w, "cert_pem": self.sso_pem}),
            None => json!({"record": null}),
        })
    }
    fn root(&self) -> Option<Root> {
        Root::of(&self.ca_der, self.crl_pem.borrow().as_deref())
    }
    fn providers(&self, org: &str) -> Vec<IdentityProvider> {
        vec![provider()].into_iter().filter(|p| p.org == org).collect()
    }
    fn org_policy(&self, org: &str, root: &Root, now: i64) -> Result<Option<Obj>, String> {
        if !self.relay_up.get() {
            return Err("no relay of the organization is connected".into());
        }
        let first = self.first_relay.borrow().clone().map(|a| ("r_00".to_string(), a));
        let answers = first.into_iter().chain([("r_01".to_string(), Ok(self.policy.borrow().clone()))]);
        first_verified_policy(answers, root, org, now)
    }
    fn console_role(&self, _email: &str) -> Option<String> {
        self.role.borrow().clone()
    }
    fn console_active(&self, _org: &str) -> Vec<ConsoleEntry> {
        self.console.borrow().clone()
    }
    fn sso_url(&self, _org: &str, _provider: &str) -> Option<String> {
        Some(SSO_URL.into())
    }
    fn audit(&self, _org: &str, entry: Value) -> Result<(), String> {
        self.audits.borrow_mut().push(entry);
        Ok(())
    }
    fn mail_notice(&self, to: &str, args: &[(&str, String)]) -> bool {
        if !self.mail_on.get() {
            return false;
        }
        let args = args.iter().map(|(k, v)| ((*k).to_string(), v.clone())).collect();
        self.mails.borrow_mut().push((to.to_string(), args));
        true
    }
    fn ema_gate_open(&self) -> bool {
        true
    }
}

// ── the fixture ──────────────────────────────────────────────────────────────────────────────────────────────────

struct Fx {
    /// Real time: the test PKI's certificates are valid around it.
    now: i64,
    ca: Ca,
    sso: Key,
    issuer: EcdsaKeyPair,
    client: EcdsaKeyPair,
    dpop: EcdsaKeyPair,
    dpop_jwk: Value,
    idp: EcdsaKeyPair,
    store: ApiMapStore,
    issue: IssueState,
    fetch: FetchCache,
    state: DelegatedState,
    host: Host,
    resources: Vec<String>,
    n: Cell<u32>,
}

fn key(kid: &str) -> (EcdsaKeyPair, Value) {
    let pair = EcdsaKeyPair::generate(&ECDSA_P256_SHA256_FIXED_SIGNING).unwrap();
    let jwk = crate::api_issue::ec_public_jwk(&pair, kid);
    (pair, jwk)
}

fn client_json(id: &str, credentials: Value, now: i64) -> Value {
    json!({"id": id, "name": "claude-ops", "principal": format!("{id}@apps.acme.example"), "kind": "agent_delegated", "owner": OWNER,
           "reach": "R1", "scopes": ["content.read", "content.post"], "ceiling": "internal", "relays": ["*"], "networks": [],
           "mtls_required": false, "rate": {"per_minute_each": 120, "per_day_each": 100000}, "connectors": [K1], "apps": [], "channels": ["*"],
           "delegation": {"groups": [], "principals": [ANN], "idps": ["okta"], "consent_days": 7, "denied": ["eve@acme.example"]},
           "redirect_uris": [REDIRECT, "http://127.0.0.1/callback"], "credentials": credentials,
           "created": now - DAY, "expires": now + 300 * DAY, "state": "active"})
}

fn fx() -> Fx {
    let now = pj::now() as i64;
    let ca = Ca::new("Acme Root");
    let sso = Key::new();
    let sso_pem = crate::meet_x509::der_to_pem(&ca.leaf(&[0x1a], "sso", None, &["urn:lucid-meet:sso", "urn:lucid-meet:org:acme"], &sso, true));
    let (issuer, mut issuer_jwk) = key(KID);
    issuer_jwk["nbf"] = json!(now - DAY);
    issuer_jwk["exp"] = json!(now + 90 * DAY);
    let (client, client_jwk) = key("k1");
    let (dpop, dpop_jwk) = key("d1");
    let (idp, idp_jwk) = key("o1");
    let map = json!({"v": 1, "org": ORG, "seq": 7, "issued": now - DAY, "expires": now + 30 * DAY,
                     "issuer": {"url": ISSUER, "jwks": [issuer_jwk]},
                     "grace": {"person": 0, "app": 24, "connector": 0, "relay": 0},
                     "failover_after_s": 300, "folded": [], "cleared": [],
                     "relay_origins": {"r_01": "https://relay1.acme.example:9443"},
                     "connectors": [{"id": K1, "name": "helpdesk", "origin": CONN, "state": "active"}],
                     "idps": [{"id": "okta", "provider": "okta", "issuer": IDP_ISS, "algs": ["ES256"], "max_age_s": 300, "private_ok": false, "state": "active"}],
                     "clients": [client_json(CLIENT, json!([{"type": "private_key_jwt", "kid": "k1", "jwk": client_jwk, "expires": now + 90 * DAY}]), now),
                                 client_json(PUBLIC, json!([]), now)]});
    let wire = json!({"map": map, "sig": "", "chain": []});
    let vm = crate::api_map::VerifiedApiMap {
        wire: wire.as_object().unwrap().clone(),
        org: ORG.into(),
        seq: 7,
        expires: now + 30 * DAY,
        hash: crate::api_map::api_map_hash(&map),
        signer: "root".into(),
    };
    let mut store = ApiMapStore::load(None);
    store.pin(vm).unwrap();
    let fetch = FetchCache::new(Duration::from_secs(3600));
    let seed = |url: &str, v: Value| fetch.put(&check_url(url).unwrap(), false, v);
    seed(&format!("{IDP_ISS}/.well-known/openid-configuration"), json!({"issuer": IDP_ISS, "jwks_uri": format!("{IDP_ISS}/keys")}));
    seed(&format!("{IDP_ISS}/keys"), json!({"keys": [idp_jwk]}));
    let host = Host {
        ca_der: ca.der.clone(),
        crl_pem: RefCell::new(None),
        sso_pem,
        records: RefCell::new(Vec::new()),
        policy: RefCell::new(policy_answer(&ca, now)),
        first_relay: RefCell::new(None),
        relay_up: Cell::new(true),
        console: RefCell::new(Vec::new()),
        audits: RefCell::new(Vec::new()),
        role: RefCell::new(None),
        mail_on: Cell::new(true),
        mails: RefCell::new(Vec::new()),
    };
    let fx = Fx {
        now,
        ca,
        sso,
        issuer,
        client,
        dpop,
        dpop_jwk,
        idp,
        store,
        issue: IssueState::new(),
        fetch,
        state: DelegatedState::new(None, Arc::new(Mutex::new(crate::fleet_ca::MemVault::default()))),
        host,
        resources: vec![ISSUER.into()],
        n: Cell::new(0),
    };
    fx.hold_record(ANN, "00u1", true);
    fx
}

impl Fx {
    fn jti(&self) -> String {
        self.n.set(self.n.get() + 1);
        format!("j{}", self.n.get())
    }

    /// The relay holds an SSO-signed person record (`api_subject::person_bytes`).
    fn hold_record(&self, principal: &str, sub: &str, active: bool) {
        let r = json!({"org": ORG, "provider": "okta", "iss": IDP_ISS, "sub": sub, "principal": principal, "active": active,
                       "stale_at": self.now + 3600, "groups": [], "ts": self.now - 10});
        let sig = sign_der(&self.sso, &crate::api_subject::person_bytes(&r).unwrap());
        self.host.records.borrow_mut().push(json!({"record": r, "sig": sig}));
    }

    fn jkt(&self) -> String {
        tok::jwk_thumbprint(&tok::parse_jwk(&self.dpop_jwk, tok::CLIENT_RSA_MIN_BITS).unwrap())
    }

    fn client_assertion(&self, now: i64) -> String {
        tok::sign_es256(&self.client, &json!({"alg": "ES256", "kid": "k1"}), &json!({"iss": CLIENT, "sub": CLIENT, "aud": ISSUER, "iat": now, "exp": now + 300, "jti": self.jti()})).unwrap()
    }

    /// A DPoP proof by `key` for `htu` (`ath` the access token's hash when one is given).
    fn proof_by(&self, key: &EcdsaKeyPair, jwk: &Value, htu: &str, token: Option<&str>, now: i64) -> String {
        let mut c = json!({"jti": self.jti(), "htm": "POST", "htu": htu, "iat": now});
        if let Some(t) = token {
            c["ath"] = json!(b64u(&sha256(t.as_bytes())));
        }
        tok::sign_es256(key, &json!({"typ": "dpop+jwt", "alg": "ES256", "jwk": jwk}), &c).unwrap()
    }

    fn proof(&self, now: i64) -> String {
        self.proof_by(&self.dpop, &self.dpop_jwk, ENDPOINT, None, now)
    }

    /// An ID-JAG from the IdP for `resource`; `set` replaces claims (a null removes one).
    fn id_jag(&self, resource: &str, set: Value) -> String {
        let mut c = json!({"iss": IDP_ISS, "sub": "00u1", "aud": ISSUER, "client_id": CLIENT, "jti": self.jti(), "iat": self.now - 5, "exp": self.now + 200,
                           "resource": resource, "auth_time": self.now - 100, "scope": "content.read", "acr": "phr"});
        for (k, v) in set.as_object().into_iter().flatten() {
            match v {
                Value::Null => {
                    c.as_object_mut().unwrap().remove(k);
                }
                v => c[k] = v.clone(),
            }
        }
        tok::sign_es256(&self.idp, &json!({"alg": "ES256", "typ": ID_JAG_TYP, "kid": "o1"}), &c).unwrap()
    }

    fn token_at(&self, pairs: &[(&str, &str)], dpop: Option<&str>, now: i64) -> Answer {
        let body = pairs.iter().map(|(k, v)| format!("{}={}", enc(k), enc(v))).collect::<Vec<_>>().join("&").into_bytes();
        let d = Delegated { host: &self.host, state: &self.state };
        let owner = |p: &str| p == OWNER;
        let ctx = IssueCtx {
            org: ORG,
            issuer: ISSUER,
            token_endpoint: ENDPOINT,
            resources: &self.resources,
            local_scopes: None,
            key: &self.issuer,
            kid: KID,
            store: &self.store,
            owner_active: &owner,
            fetch: &self.fetch,
            state: &self.issue,
            licensed: true,
            now,
            delegated: Some(&d),
        };
        let none: Option<&ClientCert> = None;
        crate::api_issue::token(&ctx, &TokenHttp { form: &body, authorization: None, dpop, client_cert: none, source: source() })
    }

    /// `jwt-bearer` by the confidential client with `jag`, with a DPoP proof unless `dpop` is None.
    fn ema(&self, jag: &str, dpop: Option<&str>) -> Answer {
        let a = self.client_assertion(self.now);
        self.token_at(&[("grant_type", GRANT_JWT_BEARER), ("assertion", jag), ("client_id", CLIENT), ("client_assertion_type", ASSERTION_TYPE), ("client_assertion", &a)], dpop, self.now)
    }

    fn redeem(&self, code: &str) -> Answer {
        let a = self.client_assertion(self.now);
        let p = self.proof(self.now);
        self.token_at(
            &[("grant_type", GRANT_CODE), ("code", code), ("redirect_uri", REDIRECT), ("code_verifier", VERIFIER), ("client_id", CLIENT), ("client_assertion_type", ASSERTION_TYPE), ("client_assertion", &a)],
            Some(&p),
            self.now,
        )
    }

    fn refresh_at(&self, token: &str, now: i64) -> Answer {
        let a = self.client_assertion(now);
        let p = self.proof(now);
        self.token_at(&[("grant_type", GRANT_REFRESH), ("refresh_token", token), ("client_id", CLIENT), ("client_assertion_type", ASSERTION_TYPE), ("client_assertion", &a)], Some(&p), now)
    }

    fn authz(&self, route: AuthzRoute, query: &str, form: &str, cookie: Option<&str>) -> Reply {
        let d = Delegated { host: &self.host, state: &self.state };
        let limiter = |_: IpAddr| -> Result<(), i64> { Ok(()) };
        let owner = |p: &str| p == OWNER;
        let ctx = AuthzCtx { org: ORG, store: &self.store, d: &d, fetch: &self.fetch, limiter: &limiter, owner_active: &owner, licensed: true, now: self.now };
        let r = authorize(&ctx, route, &AuthzHttp { query, form: form.as_bytes(), cookie, source: source() });
        r5_22(&r);
        r
    }

    /// `GET /oauth/authorize` with the usual parameters, `set` replacing some.
    fn authorize_get(&self, set: &[(&str, &str)]) -> Reply {
        let challenge = s256(VERIFIER);
        let (jkt, resource) = (self.jkt(), cm());
        let mut p: Vec<(&str, &str)> = vec![("response_type", "code"), ("client_id", CLIENT), ("redirect_uri", REDIRECT), ("code_challenge", &challenge),
                                            ("code_challenge_method", "S256"), ("resource", &resource), ("scope", "content.read"), ("state", "s1"), ("dpop_jkt", &jkt)];
        for &(k, v) in set {
            p.retain(|(x, _)| *x != k);
            p.push((k, v));
        }
        let q = p.iter().map(|(k, v)| format!("{}={}", enc(k), enc(v))).collect::<Vec<_>>().join("&");
        self.authz(AuthzRoute::Authorize, &q, "", None)
    }

    /// Steps 1 and 2: (req, the `Cookie` header that binds it).
    fn begin(&self) -> (String, String) {
        let r = self.authorize_get(&[]);
        assert_eq!(r.status, 302, "{:?}", r.text);
        let to = header(&r, "Location").unwrap();
        assert!(to.starts_with(&format!("{SSO_URL}/v1/sso/api/begin?")), "{to}");
        let set = header(&r, "Set-Cookie").unwrap();
        assert!(set.starts_with(&format!("{COOKIE}=")) && set.contains("Secure") && set.contains("HttpOnly"));
        (param(to, "req").unwrap(), set.split(';').next().unwrap().to_string())
    }

    /// The SSO service's `att` form value for `req`.
    fn att(&self, req: &str, ret: &str) -> String {
        let a = json!({"org": ORG, "provider": "okta", "iss": IDP_ISS, "sub": "00u1", "principal": ANN, "auth_time": self.now - 30, "methods": ["pwd"],
                       "req": req, "return": ret, "exp": self.now + 60});
        let sig = sign_der(&self.sso, &att_bytes(&a).unwrap());
        b64u(stringify(&json!({"att": a, "sig": sig, "cert_pem": self.host.sso_pem})).as_bytes())
    }

    fn sso_return(&self, req: &str, cookie: Option<&str>) -> Reply {
        let att = self.att(req, &format!("{ISSUER}/oauth/sso-return"));
        self.authz(AuthzRoute::SsoReturn, "", &format!("att={att}"), cookie)
    }

    /// Steps 3 and 4 after `begin`: signed in, the consent page shown, then the decision posted.
    fn decide(&self, req: &str, cookie: &str, decision: &str) -> Reply {
        let r = self.sso_return(req, Some(cookie));
        assert_eq!(r.status, 303, "{:?}", r.text);
        assert_eq!(header(&r, "Location"), Some(format!("{ISSUER}/oauth/consent?req={req}").as_str()));
        let page = self.authz(AuthzRoute::Consent, &format!("req={req}"), "", Some(cookie));
        assert_eq!(page.status, 200, "{:?}", page.text);
        let csrf = self.state.get_waiting(req, self.now).unwrap().csrf.unwrap();
        self.authz(AuthzRoute::ConsentPost, "", &format!("req={req}&csrf={csrf}&decision={decision}"), Some(cookie))
    }

    /// The whole code path: a code for the confidential client.
    fn code(&self) -> String {
        let (req, cookie) = self.begin();
        let r = self.decide(&req, &cookie, "allow");
        assert_eq!(r.status, 302);
        param(header(&r, "Location").unwrap(), "code").unwrap()
    }

    /// The pinned map again at the next `seq`, with `f` applied to the confidential client's entry.
    fn repin(&mut self, f: impl FnOnce(&mut Value)) {
        let mut map = Value::Object(self.store.get(ORG, "").unwrap().map().clone());
        let i = map["clients"].as_array().unwrap().iter().position(|c| c["id"] == CLIENT).unwrap();
        f(&mut map["clients"][i]);
        let seq = map["seq"].as_i64().unwrap() + 1;
        map["seq"] = json!(seq);
        let wire = json!({"map": map, "sig": "", "chain": []});
        let vm = crate::api_map::VerifiedApiMap {
            wire: wire.as_object().unwrap().clone(),
            org: ORG.into(),
            seq,
            expires: map["expires"].as_i64().unwrap(),
            hash: crate::api_map::api_map_hash(&map),
            signer: "root".into(),
        };
        self.store.pin(vm).unwrap();
    }

    fn validate(&self, token: &str, resource: &str, dpop: Option<(&str, &str, &str)>) -> Result<tok::Grant, tok::TokenError> {
        let profile = tok::Profile::console(&self.store, ORG).unwrap();
        let policy = self.state.verified_policy(ORG, self.now);
        tok::validate_access_token(token, &profile, resource, self.now, &self.store, ORG, policy.as_ref(), &|p: &str| p == OWNER, None, dpop, &mut JtiCache::dpop())
    }
}

fn header<'a>(r: &'a Reply, k: &str) -> Option<&'a str> {
    r.headers.iter().find(|(n, _)| n.eq_ignore_ascii_case(k)).map(|(_, v)| v.as_str())
}

/// R5-22: every Authorize answer.
fn r5_22(r: &Reply) {
    for (k, v) in [("X-Frame-Options", "DENY"), ("Cache-Control", "no-store"), ("Referrer-Policy", "no-referrer")] {
        assert_eq!(header(r, k), Some(v), "{k} on a {} answer", r.status);
    }
    assert!(header(r, "Content-Security-Policy").is_some_and(|c| c.contains("frame-ancestors 'none'")), "CSP on a {} answer", r.status);
}

fn param(url: &str, k: &str) -> Option<String> {
    let q = url.split_once('?')?.1;
    q.split('&').find_map(|p| p.strip_prefix(&format!("{k}=")).and_then(issue::unescape))
}

fn code_of(a: &Answer) -> &str {
    if a.status == 200 {
        "ok"
    } else {
        a.body["code"].as_str().unwrap_or_default()
    }
}

fn claims_of(a: &Answer) -> Value {
    Value::Object(tok::parse_jws(a.body["access_token"].as_str().unwrap()).unwrap().claims)
}

// ── the Authorize pipeline (6.5, R5-22) ──────────────────────────────────────────────────────────────────────────

#[test]
fn plain_pkce_is_refused_at_authorize() {
    let f = fx();
    let r = f.authorize_get(&[("code_challenge_method", "plain"), ("code_challenge", VERIFIER)]);
    assert_eq!(r.status, 302, "the redirect URI is registered, so the error goes back to the client");
    let to = header(&r, "Location").unwrap();
    assert!(to.starts_with(REDIRECT), "{to}");
    assert_eq!((param(to, "error").as_deref(), param(to, "state").as_deref(), param(to, "iss").as_deref()), (Some("invalid_request"), Some("s1"), Some(ISSUER)));
    assert!(param(to, "code").is_none() && header(&r, "Set-Cookie").is_none());
    let r = f.authorize_get(&[("code_challenge_method", "S256"), ("code_challenge", "plain-challenge")]);
    assert_eq!(param(header(&r, "Location").unwrap(), "error").as_deref(), Some("invalid_request"), "a challenge that is not an S256 hash");
}

#[test]
fn an_unregistered_redirect_gets_an_error_page() {
    let f = fx();
    for uri in ["https://evil.example/cb", "https://app.acme.example/cb/other", "http://localhost/callback"] {
        let r = f.authorize_get(&[("redirect_uri", uri)]);
        assert_eq!(r.status, 400, "{uri}");
        assert!(header(&r, "Location").is_none(), "never a redirect to {uri}");
        assert!(r.text.as_deref().is_some_and(|t| t.contains("not registered")), "{:?}", r.text);
    }
    let r = f.authorize_get(&[("redirect_uri", "http://127.0.0.1:53111/callback")]);
    assert_eq!(r.status, 302, "a loopback redirect matches whatever its port");
}

#[test]
fn the_code_flow_allows_and_denies_with_iss() {
    let f = fx();
    // Allow: code, state, iss
    let (req, cookie) = f.begin();
    let r = f.decide(&req, &cookie, "allow");
    assert_eq!(r.status, 302);
    let to = header(&r, "Location").unwrap();
    assert!(to.starts_with(&format!("{REDIRECT}?")), "{to}");
    assert!(param(to, "code").is_some_and(|c| c.len() == 43));
    assert_eq!((param(to, "state").as_deref(), param(to, "iss").as_deref(), param(to, "error")), (Some("s1"), Some(ISSUER), None));
    assert!(f.host.audits.borrow().iter().any(|e| e["action"] == json!("api.authorize") && e["result"] == json!("allowed") && e["person"] == json!(ANN)));
    // the consent step is single use
    let csrf = "x".repeat(43);
    let again = f.authz(AuthzRoute::ConsentPost, "", &format!("req={req}&csrf={csrf}&decision=allow"), Some(&cookie));
    assert_eq!(again.status, 400);
    // Deny: error=access_denied, state, iss
    let (req, cookie) = f.begin();
    let r = f.decide(&req, &cookie, "deny");
    assert_eq!(r.status, 302);
    let to = header(&r, "Location").unwrap();
    assert_eq!((param(to, "error").as_deref(), param(to, "state").as_deref(), param(to, "iss").as_deref(), param(to, "code")), (Some("access_denied"), Some("s1"), Some(ISSUER), None));
}

#[test]
fn sso_return_is_bound_to_the_browser_and_the_request() {
    let f = fx();
    let (req, cookie) = f.begin();
    // R5-2: no cookie, or another browser's cookie
    assert_eq!(f.sso_return(&req, None).status, 400);
    assert_eq!(f.sso_return(&req, Some(&format!("{COOKIE}=another-browser"))).status, 400);
    // an attestation made for another console's return URL
    let wrong = f.att(&req, "https://console.evil.example:7443/api/orgs/acme/oauth/sso-return");
    let r = f.authz(AuthzRoute::SsoReturn, "", &format!("att={wrong}"), Some(&cookie));
    assert_eq!(r.status, 400);
    assert!(header(&r, "Location").is_none());
    assert!(r.text.as_deref().is_some_and(|t| t.contains("another console")), "{:?}", r.text);
    // a replayed req: the request it named is used up
    let (req, cookie) = f.begin();
    assert_eq!(f.sso_return(&req, Some(&cookie)).status, 303);
    let replay = f.sso_return(&req, Some(&cookie));
    assert_eq!(replay.status, 400, "the same req a second time");
    assert!(replay.text.as_deref().is_some_and(|t| t.contains("already returned")), "{:?}", replay.text);
}

// ── codes and refresh tokens (6.5) ───────────────────────────────────────────────────────────────────────────────

#[test]
fn a_code_gives_bound_tokens_once_and_a_second_use_revokes_its_family() {
    let f = fx();
    let code = f.code();
    let a = f.redeem(&code);
    assert_eq!(code_of(&a), "ok", "{}", a.body);
    assert_eq!((a.body["token_type"].as_str(), a.body["scope"].as_str()), (Some("DPoP"), Some("content.read")));
    assert!(a.body["refresh_token"].as_str().is_some_and(|t| t.starts_with(REFRESH_PREFIX)));
    let c = claims_of(&a);
    assert_eq!((c["sub"].as_str(), c["act"]["sub"].as_str(), c["aud"].as_str(), c["grant"].as_str()), (Some(ANN), Some(CLIENT), Some(cm().as_str()), Some("authorization_code")));
    assert_eq!(c["cnf"]["jkt"].as_str(), Some(f.jkt().as_str()));
    assert_eq!(f.state.live_families(ORG, f.now).unwrap().len(), 1);
    // the same code again: refused, and the family its first use made is revoked
    let again = f.redeem(&code);
    assert_eq!((again.status, code_of(&again)), (400, "consent"));
    assert!(f.state.live_families(ORG, f.now).unwrap().is_empty(), "the family is revoked");
    let rt = a.body["refresh_token"].as_str().unwrap();
    assert_eq!(code_of(&f.refresh_at(rt, f.now)), "consent", "its refresh token is dead");
    // a wrong verifier is pkce
    let code = f.code();
    let a = f.client_assertion(f.now);
    let p = f.proof(f.now);
    let bad = f.token_at(&[("grant_type", GRANT_CODE), ("code", &code), ("redirect_uri", REDIRECT), ("code_verifier", &"A".repeat(43)), ("client_id", CLIENT),
                          ("client_assertion_type", ASSERTION_TYPE), ("client_assertion", &a)], Some(&p), f.now);
    assert_eq!(code_of(&bad), "pkce");
}

#[test]
fn refresh_rotates_reuse_revokes_and_the_family_ends_at_consent_days() {
    let f = fx();
    let a = f.redeem(&f.code());
    let rt1 = a.body["refresh_token"].as_str().unwrap().to_string();
    let b = f.refresh_at(&rt1, f.now);
    assert_eq!(code_of(&b), "ok", "{}", b.body);
    let rt2 = b.body["refresh_token"].as_str().unwrap().to_string();
    assert_ne!(rt1, rt2, "rotated");
    assert_eq!(claims_of(&b)["grant"].as_str(), Some("refresh_token"));
    // the rotated token presented again revokes the family; the live one dies with it
    assert_eq!(code_of(&f.refresh_at(&rt1, f.now)), "consent");
    assert!(f.host.audits.borrow().iter().any(|e| e["action"] == json!("api.refresh") && e["result"] == json!("reuse-revoked")));
    assert_eq!(code_of(&f.refresh_at(&rt2, f.now)), "consent");
    // the pinned consent_days (7): no refresh after it
    let rt = f.redeem(&f.code()).body["refresh_token"].as_str().unwrap().to_string();
    assert_eq!(code_of(&f.refresh_at(&rt, f.now + 7 * DAY + 1)), "consent");
    // client_limit_delegation shortens a live family to its consent_at plus the new days
    let rt = f.redeem(&f.code()).body["refresh_token"].as_str().unwrap().to_string();
    f.host.console.borrow_mut().push(centry("client_limit_delegation", json!({"client": CLIENT, "consent_days": 1}), f.now));
    let later = f.now + DAY + 10;
    assert_eq!(code_of(&f.refresh_at(&rt, later)), "consent");
    assert!(f.state.live_families(ORG, later).unwrap().is_empty(), "the family ended at consent_days");
}

/// R5-6 at the issuance tracker's cap: the grant's key is reserved before any family is made or rotated, so a refused
/// grant (503 `journal`, `Retry-After: 60`) leaves no new family and no rotated refresh token.
#[test]
fn grants_at_the_tracker_cap_change_no_family() {
    let fill = |f: &Fx, n: usize| {
        for i in 0..n {
            f.state.track(ORG, CLIENT, &format!("filler{i}@acme.example"), "jwt_bearer", &[], &[], f.now).unwrap();
        }
    };
    let refused = |a: &Answer| {
        assert_eq!((a.status, code_of(a)), (503, "journal"), "{}", a.body);
        assert_eq!(a.body["error"].as_str(), Some("temporarily_unavailable"));
        assert!(a.headers.iter().any(|(k, v)| *k == "Retry-After" && v == "60"));
    };
    // authorization_code at the cap: refused, and no family exists
    let f = fx();
    fill(&f, HELD_MAX);
    refused(&f.redeem(&f.code()));
    assert!(f.state.live_families(ORG, f.now).unwrap().is_empty(), "no family was made");
    // refresh_token at the cap: refused before the rotation; the family's token stays current
    let f = fx();
    let rt = f.redeem(&f.code()).body["refresh_token"].as_str().unwrap().to_string();
    fill(&f, HELD_MAX - 1);
    refused(&f.refresh_at(&rt, f.now));
    assert!(matches!(f.state.redeem_refresh(ORG, &rt, CLIENT, f.now, None).unwrap(), Redeemed::Live(_, None)), "the token was not rotated");
    assert!(!f.host.audits.borrow().iter().any(|e| e["action"] == json!("api.refresh") && e["result"] == json!("rotated")));
    // room again: the same token is redeemed and rotates
    f.state.issued.lock().retain(|k, _| !k.2.starts_with("filler"));
    let b = f.refresh_at(&rt, f.now);
    assert_eq!(code_of(&b), "ok", "{}", b.body);
    assert_ne!(b.body["refresh_token"].as_str(), Some(rt.as_str()), "rotated");
}

// ── EMA (6.4) with the gate passed in as open ────────────────────────────────────────────────────────────────────

#[test]
fn ema_gives_a_dpop_bound_token_for_the_requested_resource() {
    let f = fx();
    let p = f.proof(f.now);
    let a = f.ema(&f.id_jag(&cm(), json!({})), Some(&p));
    assert_eq!(code_of(&a), "ok", "{}", a.body);
    assert_eq!(a.body["token_type"].as_str(), Some("DPoP"));
    assert!(a.body.get("refresh_token").is_none(), "EMA gives no refresh token");
    let c = claims_of(&a);
    assert_eq!((c["aud"].as_str(), c["sub"].as_str(), c["act"]["sub"].as_str(), c["idp"].as_str(), c["grant"].as_str()),
               (Some(cm().as_str()), Some(ANN), Some(CLIENT), Some("okta"), Some("jwt_bearer")));
    assert_eq!(c["cnf"]["jkt"].as_str(), Some(f.jkt().as_str()));
    assert_eq!(a.event.as_ref().map(|(n, _)| *n), Some("api.delegated"));
    let token = a.body["access_token"].as_str().unwrap();
    // valid at CM with its proof, refused at C (and the reverse below)
    let cm = cm();
    let proof = f.proof_by(&f.dpop, &f.dpop_jwk, &cm, Some(token), f.now);
    let g = f.validate(token, &cm, Some((proof.as_str(), "POST", cm.as_str()))).unwrap();
    assert_eq!((g.client.as_str(), g.person.as_deref()), (CLIENT, Some(ANN)));
    assert_eq!(f.validate(token, &c_resource(), None).unwrap_err().code, "token", "a CM token at C");
    let p = f.proof(f.now);
    let a = f.ema(&f.id_jag(&c_resource(), json!({})), Some(&p));
    assert_eq!(claims_of(&a)["aud"].as_str(), Some(c_resource().as_str()));
    assert_eq!(f.validate(a.body["access_token"].as_str().unwrap(), &cm, None).unwrap_err().code, "token", "a C token at CM");
}

#[test]
fn a_public_ema_client_is_invalid_client() {
    let f = fx();
    let p = f.proof(f.now);
    let jag = f.id_jag(&cm(), json!({"client_id": PUBLIC}));
    let a = f.token_at(&[("grant_type", GRANT_JWT_BEARER), ("assertion", &jag), ("client_id", PUBLIC)], Some(&p), f.now);
    assert_eq!((a.status, a.body["error"].as_str(), code_of(&a)), (401, Some("invalid_client"), "client-auth"));
}

#[test]
fn an_id_jag_cnf_needs_the_proof_it_names() {
    let f = fx();
    let jag = f.id_jag(&cm(), json!({"cnf": {"jkt": f.jkt()}}));
    let a = f.ema(&jag, None);
    assert_eq!((a.status, code_of(&a)), (400, "dpop-required"), "no DPoP proof at all");
    let (other, other_jwk) = key("d2");
    let p = f.proof_by(&other, &other_jwk, ENDPOINT, None, f.now);
    let a = f.ema(&f.id_jag(&cm(), json!({"cnf": {"jkt": f.jkt()}})), Some(&p));
    assert_eq!((a.status, code_of(&a)), (400, "assertion"), "a proof by another key");
}

#[test]
fn a_delegated_token_naming_its_client_as_sub_is_refused() {
    let f = fx();
    let act = json!({"sub": CLIENT});
    let dl = tok::Delegation { person: CLIENT, grant: "jwt_bearer", idp: Some("okta"), auth_time: f.now, act: &act };
    let m = tok::mint_delegated_token(&f.issuer, KID, ISSUER, &cm(), CLIENT, ORG, &["content.read".to_string()], "R1", "internal", 7, &Cnf::Jkt(f.jkt()), &dl, f.now, f.now + 300).unwrap();
    assert_eq!(f.validate(&m.token, &cm(), None).unwrap_err().code, "token");
}

#[test]
fn person_revoke_refuses_a_fresh_id_jag_r5_3() {
    let f = fx();
    f.host.console.borrow_mut().push(centry("person_revoke", json!({"client": "*", "principal": ANN}), f.now));
    let p = f.proof(f.now);
    let a = f.ema(&f.id_jag(&cm(), json!({})), Some(&p));
    assert_eq!((a.status, a.body["error"].as_str(), code_of(&a)), (403, Some("access_denied"), "person"));
}

#[test]
fn a_password_id_jag_is_refused_where_phishing_resistance_is_required_r5_10() {
    let f = fx();
    let p = f.proof(f.now);
    let a = f.ema(&f.id_jag(&cm(), json!({"acr": null, "amr": ["pwd"]})), Some(&p));
    assert_eq!((a.status, code_of(&a)), (400, "assertion"));
    let p = f.proof(f.now);
    assert_eq!(code_of(&f.ema(&f.id_jag(&cm(), json!({"acr": null, "amr": ["phr"]})), Some(&p))), "assertion", "amr is not the acr the policy names");
}

// ── the org policy and the root (6.1, 6.4, 4.3) ──────────────────────────────────────────────────────────────────

#[test]
fn the_org_policy_comes_verified_from_a_relay() {
    // no relay connected
    let f = fx();
    f.host.relay_up.set(false);
    let p = f.proof(f.now);
    let a = f.ema(&f.id_jag(&cm(), json!({})), Some(&p));
    assert_eq!((a.status, code_of(&a)), (503, "subject-unreachable"));
    // a policy signed under another root
    let f = fx();
    *f.host.policy.borrow_mut() = policy_answer(&Ca::new("Other Root"), f.now);
    let p = f.proof(f.now);
    assert_eq!(code_of(&f.ema(&f.id_jag(&cm(), json!({})), Some(&p))), "subject-unreachable");
    // the relay holds no policy for the org
    let f = fx();
    *f.host.policy.borrow_mut() = json!({"signed": null});
    let p = f.proof(f.now);
    assert_eq!(code_of(&f.ema(&f.id_jag(&cm(), json!({})), Some(&p))), "person");
    // the verified policy is reused within 60 s
    let f = fx();
    let p = f.proof(f.now);
    assert_eq!(code_of(&f.ema(&f.id_jag(&cm(), json!({})), Some(&p))), "ok");
    *f.host.policy.borrow_mut() = json!({"signed": null});
    let d = Delegated { host: &f.host, state: &f.state };
    assert!(d.policy(ORG, f.now + POLICY_CACHE - 1).is_ok());
    assert_eq!(d.policy(ORG, f.now + POLICY_CACHE).unwrap_err().code, "person");
    assert!(f.state.verified_policy(ORG, f.now).is_none(), "no policy drops the one validation reads");
}

/// Review P2: a relay whose `api-org-policy` answer fails or does not verify passes to the next relay.
#[test]
fn a_bad_relay_answer_passes_to_the_next_relay() {
    let other = |f: &Fx| policy_answer(&Ca::new("Other Root"), f.now);
    for (name, first) in [
        ("another root", Some(Ok(Value::Null))),
        ("a transport failure", Some(Err("timeout".to_string()))),
        ("an unreadable answer", Some(Ok(json!({"signed": {"policy": {}}, "signer_policy": {}})))),
    ] {
        let f = fx();
        let first = first.map(|a| a.map(|v| if v.is_null() { other(&f) } else { v }));
        *f.host.first_relay.borrow_mut() = first;
        let p = f.proof(f.now);
        assert_eq!(code_of(&f.ema(&f.id_jag(&cm(), json!({})), Some(&p))), "ok", "{name} first, then a relay with a good policy");
    }
    let f = fx();
    *f.host.first_relay.borrow_mut() = Some(Ok(other(&f)));
    *f.host.policy.borrow_mut() = other(&f);
    let p = f.proof(f.now);
    assert_eq!(code_of(&f.ema(&f.id_jag(&cm(), json!({})), Some(&p))), "subject-unreachable", "no relay answers with a policy that verifies");
    // the relays are asked in turn, and no further than the first verified answer
    let root = f.host.root().unwrap();
    let good = policy_answer(&f.ca, f.now);
    let asked = Cell::new(0);
    let answers = [Ok::<Value, String>(other(&f)), Ok(good.clone()), Ok(good)].into_iter().enumerate().map(|(i, a)| {
        asked.set(asked.get() + 1);
        (format!("r_0{i}"), a)
    });
    assert!(first_verified_policy(answers, &root, ORG, f.now).unwrap().is_some());
    assert_eq!(asked.get(), 2);
    let none = [Ok::<Value, String>(json!({"signed": null})), Ok(other(&f))].into_iter().map(|a| ("r".to_string(), a));
    assert_eq!(first_verified_policy(none, &root, ORG, f.now).unwrap(), None, "a relay holding none, another failing");
    let bad = [(String::from("r_01"), Err::<Value, String>("down".into()))];
    assert_eq!(first_verified_policy(bad, &root, ORG, f.now).unwrap_err(), "r_01: down");
}

/// Review P2: offline validation checks a delegated token's `sub` against the current verified policy's domains.
#[test]
fn a_delegated_token_ends_with_its_persons_domain() {
    let f = fx();
    let p = f.proof(f.now);
    let a = f.ema(&f.id_jag(&cm(), json!({})), Some(&p));
    assert_eq!(code_of(&a), "ok", "{}", a.body);
    let token = a.body["access_token"].as_str().unwrap();
    let cm = cm();
    let proof = f.proof_by(&f.dpop, &f.dpop_jwk, &cm, Some(token), f.now);
    let at = || f.validate(token, &cm, Some((proof.as_str(), "POST", cm.as_str())));
    assert_eq!(at().unwrap().person.as_deref(), Some(ANN), "the issuance verified the policy the console now holds");
    // the console verifies a newer policy that no longer lists the person's domain
    let held = f.state.verified_policy(ORG, f.now).unwrap();
    let mut newer = held.clone();
    newer.insert("domains".into(), json!(["globex.example"]));
    f.state.policies.lock().insert(ORG.into(), (newer, f.now));
    assert_eq!(at().unwrap_err().code, "person");
    // an expired policy counts as none
    let mut expired = held;
    expired.insert("expires".into(), json!(f.now - 1));
    f.state.policies.lock().insert(ORG.into(), (expired, f.now));
    assert!(f.state.verified_policy(ORG, f.now).is_none());
    assert_eq!(at().unwrap_err().code, "token");
    // no verified policy held (a console restart): refused until an issuance verifies one again
    f.state.policies.lock().clear();
    assert_eq!(at().unwrap_err().code, "token");
}

#[test]
fn ways_under_the_policy_need_its_domains_and_ai_groups() {
    let now = pj::now() as i64;
    let mut client = client_json(CLIENT, json!([]), now);
    client["delegation"]["groups"] = json!(["00g1"]);
    client["delegation"]["principals"] = json!([ANN, "zed@globex.example"]);
    let client = client.as_object().cloned().unwrap();
    let record = |principal: &str, groups: &[&str]| PersonRecord {
        org: ORG.into(),
        provider: "okta".into(),
        iss: IDP_ISS.into(),
        sub: "00u9".into(),
        principal: principal.into(),
        active: true,
        stale_at: now + 3600,
        groups: groups.iter().map(|g| g.to_string()).collect(),
        ts: now,
    };
    let plain = json!({"org": ORG, "domains": ["acme.example"]}).as_object().cloned().unwrap();
    let with_ai = json!({"org": ORG, "domains": ["acme.example"], "ai": {"who": {"groups": ["00g1"]}}}).as_object().cloned().unwrap();
    assert_eq!(ways_under(&plain, &client, CLIENT, &record(ANN, &[]), &[]).unwrap(), vec![format!("principal:{ANN}")]);
    assert_eq!(ways_under(&plain, &client, CLIENT, &record("zed@globex.example", &[]), &[]).unwrap_err().code, "person", "outside the policy's domains");
    assert_eq!(ways_under(&plain, &client, CLIENT, &record("bob@acme.example", &["00g1"]), &[]).unwrap_err().code, "person", "a group outside ai.who.groups");
    assert_eq!(ways_under(&with_ai, &client, CLIENT, &record("bob@acme.example", &["00g1"]), &[]).unwrap(), vec!["group:00g1".to_string()]);
}

#[test]
fn the_meet_ca_root_serves_without_a_crl_and_applies_one_when_present() {
    // no CRL: the person record verifies (the fixture's root has none)
    let f = fx();
    let p = f.proof(f.now);
    assert_eq!(code_of(&f.ema(&f.id_jag(&cm(), json!({})), Some(&p))), "ok");
    // a CRL of the root that does not list the SSO certificate
    let f = fx();
    *f.host.crl_pem.borrow_mut() = Some(f.ca.crl_pem(f.now - 60, f.now + DAY, &[&[0x2b]], Some(&[1])));
    let p = f.proof(f.now);
    assert_eq!(code_of(&f.ema(&f.id_jag(&cm(), json!({})), Some(&p))), "ok");
    // a CRL listing it: the record is bad-signature, so the person is refused
    let f = fx();
    *f.host.crl_pem.borrow_mut() = Some(f.ca.crl_pem(f.now - 60, f.now + DAY, &[&[0x1a]], Some(&[2])));
    let p = f.proof(f.now);
    assert_eq!(code_of(&f.ema(&f.id_jag(&cm(), json!({})), Some(&p))), "person");
    assert!(f.host.audits.borrow().iter().any(|e| e["action"] == json!("api.person.record") && e["result"] == json!("bad-signature")));
    // ... and the attestation is refused at sso-return
    let (req, cookie) = f.begin();
    let r = f.sso_return(&req, Some(&cookie));
    assert!(r.status == 400 && r.text.as_deref().is_some_and(|t| t.contains("revoked")), "{:?}", r.text);
    // a CRL that is not the root's leaves no usable root
    let other = Ca::new("Acme Root");
    let foreign = other.crl_pem(f.now - 60, f.now + DAY, &[], None);
    assert!(Root::of(&f.ca.der, Some(foreign.as_str())).is_none());
}

/// r5 6.3 (reach R0): the first delegated token of a client for a person mails the person once
/// (`fleet.mail.delegation`); a mail the mailer did not take is tried again with the next token; a reach R1 client
/// mails nothing (its connector posts the CE-1 `dlgn`).
#[test]
fn an_r0_delegation_mails_the_person_once() {
    let mut f = fx();
    let p = f.proof(f.now);
    assert_eq!(code_of(&f.ema(&f.id_jag(&cm(), json!({})), Some(&p))), "ok");
    assert!(f.host.mails.borrow().is_empty(), "reach R1 mails nothing");
    f.repin(|c| {
        c["reach"] = json!("R0");
        c["scopes"] = json!(["monitor.read"]);
    });
    *f.host.role.borrow_mut() = Some("admin".into());
    let m = mcp_resource(ISSUER);
    let r0 = |f: &Fx| {
        let p = f.proof(f.now);
        f.ema(&f.id_jag(&m, json!({"scope": "monitor.read"})), Some(&p))
    };
    // the console's mail is off: the token is issued, nothing is marked
    f.host.mail_on.set(false);
    let a = r0(&f);
    assert_eq!(code_of(&a), "ok", "{}", a.body);
    assert_eq!(claims_of(&a)["reach"].as_str(), Some("R0"));
    assert!(f.host.mails.borrow().is_empty());
    // mail on: the next token mails, the ones after it do not
    f.host.mail_on.set(true);
    assert_eq!(code_of(&r0(&f)), "ok");
    assert_eq!(code_of(&r0(&f)), "ok");
    let mails = f.host.mails.borrow();
    assert_eq!(mails.len(), 1, "one mail per client and person");
    assert_eq!(mails[0].0, ANN);
    let args: Vec<(&str, String)> = mails[0].1.iter().map(|(k, v)| (k.as_str(), v.clone())).collect();
    let arg = |k: &str| args.iter().find(|(n, _)| *n == k).map(|(_, v)| v.as_str());
    assert_eq!((arg("client"), arg("scopes")), (Some("claude-ops"), Some("monitor.read")));
    // the AC-2a 13.5 words render with them
    let (subject, body) = crate::console_mail::render("fleet.mail.delegation", "console.acme.example", "https://console.acme.example/console/", &args).unwrap();
    assert_eq!(subject, "claude-ops can now act for you in the Lucid Admin Console");
    assert!(body.starts_with("claude-ops can now read Lucid Admin Console data as you, with these scopes: monitor.read.\nIt started on "), "{body}");
}
