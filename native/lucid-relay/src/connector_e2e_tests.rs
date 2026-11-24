// Contract API-1 revision 5 (phase 1c), section 18, slice 1c4 end to end: one connector serving its API app against
// the recorded relay of slice 1c2 (`connector_session::tests::World`: the CE-1 vectors' Ann and Helpdesk app, member
// logs, wraps and envelopes verified by the app's own member device), through the real connector resource pipeline
// (`connector_api`), the approvals (`connector_approvals`), the content events (`connector_events`), the synced map
// and journals (`connector_sync::SyncState`) and the connector's own audit chain (`connector_sync::open_audit`).
//
// The person's approval answer enters exactly where a verified `apra` from the session does (`Approvals::answer`,
// the `ContentHooks::approval_answer` call), at the vectors' clock.

use crate::api_audit::{ApiAudit, Repr};
use crate::api_map::{api_map_hash, ApiMapStore, VerifiedApiMap};
use crate::api_token::{self as tok, Cnf, Delegation};
use crate::codec::{b64u, sha256};
use crate::connector::{Connector, Hooks};
use crate::connector_api::{ConnectorApi, Request};
use crate::connector_approvals::Approvals;
use crate::connector_session::tests::{World, APP, M1};
use crate::connector_session::ContentHooks;
use crate::connector_store::Purged;
use crate::connector_sync::SyncState;
use aws_lc_rs::signature::{EcdsaKeyPair, KeyPair, ECDSA_P256_SHA256_FIXED_SIGNING};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::net::IpAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

const ORG: &str = "acme";
const K: &str = "k_7a1b2c3d4e5f6a7b";
const ORIGIN: &str = "https://connector.acme.test:9445";
const ISSUER: &str = "https://console.acme.test:9443/api/orgs/acme";
const KID: &str = "ik-1";
/// A program (`app`) without `confirm`: posts at once.
const PROGRAM: &str = "c_0000000000000001";
/// A person-delegated agent: every post waits for the person's approval.
const AGENT: &str = "c_0000000000000002";
const CANARY: &str = "canary-text-7f3a hello ops";
const POSTED: &str = "canary-post-91c2 we picked the north lot";

static DPOP_N: AtomicU64 = AtomicU64::new(0);

fn key() -> (EcdsaKeyPair, Value) {
    let pair = EcdsaKeyPair::generate(&ECDSA_P256_SHA256_FIXED_SIGNING).unwrap();
    let p = pair.public_key().as_ref().to_vec();
    let jwk = json!({"kty": "EC", "crv": "P-256", "x": b64u(&p[1..33]), "y": b64u(&p[33..65])});
    (pair, jwk)
}

fn client(id: &str, name: &str, kind: &str, app_p: &str, confirm: Value, now_s: i64) -> Value {
    let mut c = json!({
        "id": id, "name": name, "principal": format!("{name}@apps.acme.test"), "kind": kind, "owner": "ann@acme.test", "reach": "R1",
        "scopes": ["content.read", "content.post"], "ceiling": "confidential", "connectors": [K], "apps": [app_p], "channels": ["*"],
        "confirm": confirm, "networks": [], "mtls_required": false, "rate": {"per_minute_each": 600, "per_day_each": 100000},
        "credentials": [], "created": now_s - 86_400, "expires": now_s + 30 * 86_400, "state": "active",
    });
    if kind == "agent_delegated" {
        c["delegation"] = json!({"groups": [], "principals": ["ann@acme.test"], "idps": [], "consent_days": 7, "denied": []});
    }
    c
}

/// The org's api map as the console signed it (pinned here as verified, as the token tests do).
fn store_of(issuer_jwk: &Value, app_p: &str, now_s: i64) -> ApiMapStore {
    let mut ik = issuer_jwk.clone();
    ik["kid"] = json!(KID);
    ik["use"] = json!("sig");
    ik["alg"] = json!("ES256");
    ik["nbf"] = json!(now_s - 86_400);
    ik["exp"] = json!(now_s + 90 * 86_400);
    let map = json!({
        "v": 1, "org": ORG, "seq": 3, "issued": now_s - 3600, "expires": now_s + 30 * 86_400,
        "issuer": {"url": ISSUER, "jwks": [ik]}, "grace": {"person": 0, "app": 0, "connector": 0, "relay": 0},
        "failover_after_s": 300, "folded": [], "cleared": [], "relay_origins": {},
        "connectors": [{"id": K, "name": "helpdesk", "origin": ORIGIN, "apps": [app_p], "networks": [], "stale_s": 60, "state": "active"}],
        "clients": [
            client(PROGRAM, "ops-bot", "app", app_p, json!([]), now_s),
            client(AGENT, "claude-ops", "agent_delegated", app_p, json!(["content.post"]), now_s),
        ],
    });
    let wire = json!({"map": map, "sig": "", "chain": []});
    let vm = VerifiedApiMap { wire: wire.as_object().unwrap().clone(), org: ORG.into(), seq: 3, expires: now_s + 30 * 86_400, hash: api_map_hash(&map), signer: "root".into() };
    let mut s = ApiMapStore::load(None);
    s.pin(vm).unwrap();
    s
}

struct Rig {
    w: World,
    issuer: EcdsaKeyPair,
    dpop: (EcdsaKeyPair, Value),
    conn: Arc<Connector>,
    audit: Arc<ApiAudit>,
    approvals: Arc<Approvals>,
    hooks: Arc<Hooks>,
    api: ConnectorApi,
    cid: String,
}

impl Rig {
    /// Ann's group chat `ch:ops1` with the app, one verified message from Ann in it, and the connector synced now.
    fn new() -> Rig {
        let w = World::new();
        let now_s = w.now / 1000;
        let k = [9u8; 32];
        let (cid, head) = w.conversation("ops1", &k);
        let env = w.envelope(&cid, M1, 1, "post", "", json!({"t": CANARY, "m": []}), head, &k);
        w.session.deliver(&[json!({"seq": 1, "type": "chat_keys"}), w.post_event(2, &cid, M1, env)], w.now).unwrap();
        assert!(w.store.get(APP, &cid, M1).unwrap().is_some(), "the recorded message verified and is kept");
        let (issuer, ijwk) = key();
        let keys = BTreeMap::from([(PROGRAM.to_string(), [1u8; 32]), (AGENT.to_string(), [2u8; 32])]);
        let sync = Arc::new(SyncState::for_test(ORG, K, store_of(&ijwk, &w.app_p, now_s), Vec::new(), keys, w.now));
        let conn = Arc::new(Connector::for_test(&w.dir, w.session.shared().clone(), BTreeMap::from([(APP.to_string(), w.session.clone())])));
        let audit = crate::connector_sync::open_audit(&w.dir, K, w.session.shared().sealed.clone(), sync.clone(), now_s);
        let hooks = Arc::new(Hooks::new(ORG));
        hooks.set_audit(audit.clone());
        let approvals = Arc::new(Approvals::open(conn.clone(), sync.clone(), audit.clone()).unwrap());
        hooks.set_approvals(approvals.clone());
        // what the session hands its hooks from now on reaches the connector's own
        *w.hooks.1.write() = Some(hooks.clone() as Arc<dyn ContentHooks>);
        let api = ConnectorApi::new(conn.clone(), sync, audit.clone(), approvals.clone(), hooks.events.clone());
        Rig { w, issuer, dpop: key(), conn, audit, approvals, hooks, api, cid }
    }

    fn now_s(&self) -> i64 {
        self.w.now / 1000
    }

    /// A machine token (`sub` the client) for C.
    fn program_token(&self) -> String {
        let scopes = vec!["content.post".to_string(), "content.read".to_string()];
        let aud = crate::api_delegated::connector_resource(ORIGIN, ORG);
        tok::mint_access_token(&self.issuer, KID, ISSUER, &aud, PROGRAM, ORG, &scopes, "R1", "confidential", 3, &Cnf::None, self.now_s(), self.now_s() + 600).unwrap().token
    }

    /// Ann's delegated token for the agent, bound to the rig's DPoP key.
    fn delegated_token(&self) -> String {
        let scopes = vec!["content.post".to_string(), "content.read".to_string()];
        let aud = crate::api_delegated::connector_resource(ORIGIN, ORG);
        let jkt = tok::jwk_thumbprint(&tok::parse_jwk(&self.dpop.1, tok::CLIENT_RSA_MIN_BITS).unwrap());
        let act = json!({"sub": AGENT});
        let d = Delegation { person: &self.w.ann_p, grant: "authorization_code", idp: None, auth_time: self.now_s() - 60, act: &act };
        tok::mint_delegated_token(&self.issuer, KID, ISSUER, &aud, AGENT, ORG, &scopes, "R1", "confidential", 3, &Cnf::Jkt(jkt), &d, self.now_s(), self.now_s() + 600).unwrap().token
    }

    fn proof(&self, method: &str, path: &str, token: &str) -> String {
        let n = DPOP_N.fetch_add(1, Ordering::Relaxed);
        let claims = json!({"jti": format!("dpop-{n}-{}", self.now_s()), "htm": method, "htu": format!("{ORIGIN}{path}"), "iat": self.now_s(), "ath": b64u(&sha256(token.as_bytes()))});
        tok::sign_es256(&self.dpop.0, &json!({"typ": "dpop+jwt", "alg": "ES256", "jwk": self.dpop.1}), &claims).unwrap()
    }

    fn at(&self, api: &ConnectorApi, method: &str, path: &str, query: &str, token: Option<&str>, delegated: bool, idem: Option<&str>, body: Option<&Value>) -> (u16, Value) {
        let path = format!("/api/orgs/{ORG}{path}");
        let auth = token.map(|t| if delegated { format!("DPoP {t}") } else { format!("Bearer {t}") });
        let proof = token.filter(|_| delegated).map(|t| self.proof(method, &path, t));
        let raw = body.map(|b| serde_json::to_vec(b).unwrap());
        let req = Request {
            method,
            path: &path,
            query,
            authorization: auth.as_deref(),
            dpop: proof.as_deref(),
            idempotency_key: idem,
            body: raw.as_deref().map(Ok),
            source: IpAddr::from([10, 40, 0, 7]),
            now_ms: self.w.now,
        };
        let a = api.answer(&req);
        (a.status, serde_json::from_slice(&a.body).unwrap_or(Value::Null))
    }

    fn get(&self, path: &str, query: &str, token: &str, delegated: bool) -> (u16, Value) {
        self.at(&self.api, "GET", path, query, Some(token), delegated, None, None)
    }

    fn post(&self, path: &str, token: &str, delegated: bool, idem: &str, body: &Value) -> (u16, Value) {
        self.at(&self.api, "POST", path, "", Some(token), delegated, Some(idem), Some(body))
    }

    fn sent(&self, route: &str) -> usize {
        self.w.fake.sent.lock().iter().filter(|(r, _)| r == route).count()
    }

    fn chain(&self) -> Vec<Value> {
        self.audit.read(ORG, K, Repr::AsIs, 0, 1000).unwrap()["entries"].as_array().cloned().unwrap_or_default()
    }
}

#[test]
fn a_connector_serves_its_app_to_a_program_end_to_end() {
    let r = Rig::new();
    let t = r.program_token();
    // only the conversation the app is a verified member of is listed
    let (status, list) = r.get("/v1/content/conversations", "", &t, false);
    assert_eq!(status, 200, "{list}");
    let cids: Vec<&str> = list["conversations"].as_array().unwrap().iter().filter_map(|c| c["cid"].as_str()).collect();
    assert_eq!(cids, [r.cid.as_str()]);
    // the verified message, with the client's own pseudonymous id for Ann
    let (status, page) = r.get(&format!("/v1/content/conversations/{}/messages", r.cid), "", &t, false);
    assert_eq!(status, 200, "{page}");
    let m = &page["messages"][0];
    assert_eq!((m["id"].as_str(), m["text"].as_str()), (Some(M1), Some(CANARY)));
    assert_eq!(m["from"]["id"], json!(crate::connector_view::face_id(&[1u8; 32], &r.w.ann_p)));
    assert_eq!(m["from"]["email"], json!(r.w.ann_p), "Ann is a person of the org's own policy");
    // a conversation the app never joined answers exactly as one that does not exist
    let (s1, b1) = r.get("/v1/content/conversations/ch:ops2", "", &t, false);
    let (s2, b2) = r.get("/v1/content/conversations/ch:zzz9", "", &t, false);
    assert_eq!((s1, s2), (404, 404));
    assert_eq!((b1["code"].clone(), b1["detail"].clone()), (b2["code"].clone(), b2["detail"].clone()));
    // a client's first content events poll starts at the log's head (7.6): its cursor, before anything is posted
    let (status, start) = r.get("/v1/content/events", "wait=0", &t, false);
    assert_eq!(status, 200, "{start}");
    let next = start["next"].as_str().unwrap().to_string();
    // a program without `confirm` posts at once, once per Idempotency-Key
    let before = r.sent("/v1/channels/post");
    let body = json!({"text": POSTED});
    let (status, first) = r.post(&format!("/v1/content/conversations/{}/messages", r.cid), &t, false, "post-1", &body);
    assert_eq!(status, 201, "{first}");
    assert_eq!(r.sent("/v1/channels/post"), before + 1);
    let (status, again) = r.post(&format!("/v1/content/conversations/{}/messages", r.cid), &t, false, "post-1", &body);
    assert_eq!((status, again["message"]["id"].clone()), (201, first["message"]["id"].clone()), "the first result again");
    assert_eq!(r.sent("/v1/channels/post"), before + 1, "posted once");
    let (status, _) = r.post(&format!("/v1/content/conversations/{}/messages", r.cid), &t, false, "post-1", &json!({"text": "another"}));
    assert_eq!(status, 409, "the same key with another body");
    // the post's content event, by long poll from that cursor
    let (status, ev) = r.get("/v1/content/events", &format!("after={next}&wait=0"), &t, false);
    assert_eq!(status, 200, "{ev}");
    assert!(ev["events"].as_array().unwrap().iter().any(|e| e["type"] == "message.created" && e["conv"] == json!(r.cid)), "{ev}");
    // every call is in the chain before its answer, with the conversation but never its text
    let chain = r.chain();
    assert!(chain.iter().any(|e| e["action"] == "api.call" && e["conv"] == json!(r.cid) && e["client"] == PROGRAM), "{chain:?}");
    assert!(chain.iter().all(|e| e["source"] == "connector" && e["connector"] == K));
    let all = serde_json::to_string(&chain).unwrap();
    assert!(!all.contains("canary-text-7f3a") && !all.contains("canary-post-91c2"), "no message text in the audit");
}

#[test]
fn a_delegated_post_waits_for_the_person_and_posts_once_after_the_recheck() {
    let r = Rig::new();
    let path = format!("/v1/content/conversations/{}/messages", r.cid);
    let before = r.sent("/v1/channels/post");
    let t = r.delegated_token();
    let (status, a) = r.post(&path, &t, true, "ask-1", &json!({"text": POSTED}));
    assert_eq!(status, 202, "{a}");
    let id = a["approval"]["id"].as_str().unwrap().to_string();
    assert_eq!(a["approval"]["state"], "waiting");
    assert_eq!(r.sent("/v1/dm"), 1, "the apr went to Ann's DM with the app");
    assert_eq!(r.sent("/v1/channels/post"), before, "nothing posted yet");
    let apr = r.approvals.apr_for_test(&id).expect("the apr as sent");
    // an answer for another text (a wrong h) or from another person changes nothing
    let mut other = apr.clone();
    other["text"] = json!("something else");
    let wrong = crate::ce_device::make_apra(&other, true).unwrap()["apra"].clone();
    r.approvals.answer(APP, &r.w.ann_p, "00000000000000000000000000000001", &wrong, r.w.now);
    let good = crate::ce_device::make_apra(&apr, true).unwrap()["apra"].clone();
    r.approvals.answer(APP, "ben@acme.test", "00000000000000000000000000000002", &good, r.w.now);
    let (status, waiting) = r.get(&format!("/v1/content/approvals/{id}"), "", &r.delegated_token(), true);
    assert_eq!((status, waiting["state"].as_str()), (200, Some("waiting")), "{waiting}");
    assert_eq!(r.sent("/v1/channels/post"), before);
    // Ann approves on her own device: the grant is checked again, audited, then posted exactly once
    r.approvals.answer(APP, &r.w.ann_p, "00000000000000000000000000000003", &good, r.w.now);
    r.approvals.answer(APP, &r.w.ann_p, "00000000000000000000000000000004", &good, r.w.now);
    // the answer settles on a worker thread (the hook runs under the session); this waits for it
    r.approvals.settle(r.w.now);
    r.approvals.settle(r.w.now);
    assert_eq!(r.sent("/v1/channels/post"), before + 1, "posted once");
    let (status, done) = r.get(&format!("/v1/content/approvals/{id}"), "", &r.delegated_token(), true);
    assert_eq!((status, done["state"].as_str()), (200, Some("posted")), "{done}");
    assert_eq!(done["message"]["via"]["client"], json!("claude-ops"), "{done}");
    // the program client cannot read another client's approval
    let (status, _) = r.get(&format!("/v1/content/approvals/{id}"), "", &r.program_token(), false);
    assert_ne!(status, 200);
    // requested, answered and posted are in the chain, each naming the approval, never the text
    let chain = r.chain();
    let actions: Vec<&str> = chain.iter().filter(|e| e["approval"] == json!(id)).filter_map(|e| e["action"].as_str()).collect();
    for a in ["content.approval.requested", "content.approval.answered", "content.approval.posted"] {
        assert!(actions.contains(&a), "{a} in {actions:?}");
    }
    let posted_at = actions.iter().position(|a| *a == "content.approval.posted").unwrap();
    let answered_at = actions.iter().position(|a| *a == "content.approval.answered").unwrap();
    assert!(answered_at < posted_at, "answered before posted");
    assert!(!serde_json::to_string(&chain).unwrap().contains("canary-post-91c2"));
}

#[test]
fn a_connector_past_stale_s_refuses_every_content_call() {
    let r = Rig::new();
    let now_s = r.now_s();
    let keys = BTreeMap::from([(PROGRAM.to_string(), [1u8; 32])]);
    let p = r.issuer.public_key().as_ref().to_vec();
    let ijwk = json!({"kty": "EC", "crv": "P-256", "x": b64u(&p[1..33]), "y": b64u(&p[33..65])});
    let stale = Arc::new(SyncState::for_test(ORG, K, store_of(&ijwk, &r.w.app_p, now_s), Vec::new(), keys, r.w.now - 61_000));
    let api = ConnectorApi::new(r.conn.clone(), stale, r.audit.clone(), r.approvals.clone(), r.hooks.events.clone());
    let (status, b) = r.at(&api, "GET", "/v1/content/conversations", "", Some(&r.program_token()), false, None, None);
    assert_eq!((status, b["code"].as_str()), (503, Some("connector-stale")), "{b}");
}

#[test]
fn a_store_purge_is_audited_without_content() {
    let r = Rig::new();
    let p = Purged { app: APP.into(), cid: Some(r.cid.clone()), reason: "removed", records: 3, bytes: 900 };
    r.w.session.shared().hooks.purged(&r.w.app_p, &p, r.w.now);
    let chain = r.chain();
    let e = chain.iter().find(|e| e["action"] == "connector.store.purged").expect("the purge is audited");
    assert_eq!((e["app"].clone(), e["conv"].clone(), e["items"].clone()), (json!(r.w.app_p), json!(r.cid), json!(3)));
}
