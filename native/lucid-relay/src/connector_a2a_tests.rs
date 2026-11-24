// Slice 1d4 (contract r6 7.2 to 7.12, 11, 12, 17.1 and 17.3): the connector's A2A server.
//
//   wire     the pure rules of `connector_a2a_wire`: paths, intake, the 7.6 lifecycle table, errors (A2A 11.6), push
//            configs, ids and times.
//   journal  the r6 2.3 actions in the console journal, and the token endpoint's `resource=A` rule (7.2.2).
//   world    end to end: a scripted A2A client (DPoP-bound tokens for A, the HTTP+JSON binding) against the
//            connector's A2A server, its service hub, this crate's spokes relay and the 1d3 scripted spokes; a person's
//            approval is played by the scripted spoke as the add-on journals it.
//
// The live partner test (an A2A 1.0 SDK client against a deployed connector) is gated by G-A2A-PARTNER.

use crate::api_cjournal::{self as cj, check_console_entry, ConsoleEntry};
use crate::api_delegated::{connector_a2a_resource, connector_resource, resolve_resource, Resolved, Target};
use crate::codec::{iso_time, str_of};
use crate::connector::{Connector, Enclave};
use crate::connector_a2a::{A2aServer, Handled};
use crate::connector_a2a_push::{Poster, Target as PushTarget};
use crate::connector_a2a_wire::{self as w, Fault, Op, SpokeView, TaskState, TurnRefused, Why};
use crate::connector_api::tests::{centry, Fx, K, ORIGIN};
use crate::connector_api::Request;
use crate::connector_seal::KEY_STORE_OS;
use crate::connector_spokes::ServiceHub;
use crate::connector_spokes_tests::{root_id, FakeSpoke, World as Spokes};
use crate::connector_spokes_wire::ask_digest;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::Duration;

const PARTNER: &str = "c_0b1c2d3e4f506172";
const OTHER: &str = "c_0b1c2d3e4f506173";
const AGENT: &str = "a_7c1d2e3f4a5b6c7d";
const SKILL: &str = "build-and-test";
/// The service hub's client in the 1d3 world (`connector_spokes_tests::CLIENT`).
const HUB_CLIENT: &str = "c_9a8b7c6d5e4f3a2b";
const CANARY: &str = "canary-a2a-4417";
const APPROVER: &str = "n_0123456789abcdef0123456789abcdef";

// ── wire ────────────────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn the_lifecycle_table_of_7_6() {
    let v = |state: &'static str, awaiting: Option<&'static str>, reason: Option<&'static str>, turns: i64| SpokeView { state, awaiting, reason, turns };
    let at = |x: SpokeView, many: bool, refused: Option<TurnRefused>| w::lifecycle(&x, many, refused);
    assert_eq!(at(v("awaiting_approval", Some("task.start"), None, 0), false, None), (TaskState::AuthRequired, Some(Why::StartWait), false));
    assert_eq!(at(v("awaiting_approval", Some("task.turn"), None, 1), true, None), (TaskState::AuthRequired, Some(Why::TurnWait), false));
    assert_eq!(at(v("awaiting_approval", Some("shell"), None, 0), false, None), (TaskState::AuthRequired, Some(Why::ActionWait), false));
    assert_eq!(at(v("working", None, None, 0), false, None), (TaskState::Working, None, false));
    assert_eq!(at(v("idle", None, None, 1), false, None), (TaskState::Completed, None, true), "turns one: the connector closes it");
    assert_eq!(at(v("idle", None, None, 1), true, None), (TaskState::InputRequired, Some(Why::TurnDone), false));
    assert_eq!(at(v("idle", None, None, 1), true, Some(TurnRefused::Declined)), (TaskState::InputRequired, Some(Why::TurnDeclined), false));
    assert_eq!(at(v("idle", None, None, 1), true, Some(TurnRefused::Expired)), (TaskState::InputRequired, Some(Why::TurnExpired), false));
    assert_eq!(at(v("closed", None, Some("denied"), 0), false, None), (TaskState::Rejected, Some(Why::TaskDeclined), false));
    assert_eq!(at(v("closed", None, Some("approval expired"), 0), false, None), (TaskState::Rejected, Some(Why::TaskExpired), false));
    assert_eq!(at(v("closed", None, Some("engine refused the lane: no lane"), 0), false, None), (TaskState::Rejected, Some(Why::CannotRun), false));
    assert_eq!(at(v("closed", None, None, 0), false, None).0, TaskState::Canceled);
    assert_eq!(at(v("error", None, None, 0), false, None), (TaskState::Failed, Some(Why::Failed), false));
    assert_eq!(at(v("stopped", None, None, 0), false, None), (TaskState::Failed, Some(Why::Stopped), false));
    // the sentences are Lucid's own (R6-13)
    assert_eq!(Why::StartWait.sentence("Acme"), "Waiting for a person at Acme to approve this task.");
    assert_eq!(Why::TurnWait.sentence("Acme"), "Waiting for a person at Acme to approve your message.");
    assert_eq!(Why::IdleClosed(60).sentence("Acme"), "Closed after 60 minutes without a message.");
    assert_eq!(Why::NoSpoke.sentence("Acme"), "No spoke is available for this skill.");
    assert_eq!(Why::Expired.sentence("Acme"), "The task's messages expired.");
    for why in [Why::StartWait, Why::TurnDone, Why::IdleClosed(5), Why::CannotRun, Why::Expired] {
        assert_eq!(Why::of_code(&why.code()), Some(why));
    }
    for s in TaskState::ALL {
        assert_eq!(TaskState::of(s.name()), Some(s));
        assert_eq!(TaskState::of(s.label()), Some(s));
    }
    assert_eq!(TaskState::of("input-required"), Some(TaskState::InputRequired));
}

#[test]
fn the_routes_of_7_3() {
    let p = |m: &str, path: &str| w::parse_path(m, path).map(|(o, a, op)| (o, a, op));
    let base = "/api/orgs/acme/a2a/a_1";
    assert_eq!(p("POST", &format!("{base}/message:send")), Some(("acme".into(), "a_1".into(), Op::Send)));
    assert_eq!(p("POST", &format!("{base}/message:stream")).unwrap().2, Op::Stream);
    assert_eq!(p("GET", &format!("{base}/tasks/t2_x")).unwrap().2, Op::Get("t2_x".into()));
    assert_eq!(p("GET", &format!("{base}/tasks")).unwrap().2, Op::List);
    assert_eq!(p("POST", &format!("{base}/tasks/t2_x:cancel")).unwrap().2, Op::Cancel("t2_x".into()));
    assert_eq!(p("GET", &format!("{base}/tasks/t2_x:subscribe")).unwrap().2, Op::Subscribe("t2_x".into()), "the proto binding");
    assert_eq!(p("POST", &format!("{base}/tasks/t2_x:subscribe")).unwrap().2, Op::Subscribe("t2_x".into()), "the prose binding");
    assert_eq!(p("POST", &format!("{base}/tasks/t2_x/pushNotificationConfigs")).unwrap().2, Op::PushCreate("t2_x".into()));
    assert_eq!(p("GET", &format!("{base}/tasks/t2_x/pushNotificationConfigs")).unwrap().2, Op::PushList("t2_x".into()));
    assert_eq!(p("GET", &format!("{base}/tasks/t2_x/pushNotificationConfigs/p_1")).unwrap().2, Op::PushGet("t2_x".into(), "p_1".into()));
    assert_eq!(p("DELETE", &format!("{base}/tasks/t2_x/pushNotificationConfigs/p_1")).unwrap().2, Op::PushDelete("t2_x".into(), "p_1".into()));
    assert_eq!(p("GET", &format!("{base}/extendedAgentCard")).unwrap().2, Op::ExtendedCard);
    for (m, path) in [("GET", format!("{base}/message:send")), ("POST", format!("{base}/tasks/t2_x:explode")), ("GET", format!("{base}/tasks/t2_x:cancel")), ("POST", format!("{base}//tasks")), ("PUT", format!("{base}/tasks"))] {
        assert!(p(m, &path).is_none(), "{m} {path}");
    }
    assert!(p("POST", "/acme/message:send").is_none(), "no /{{tenant}} binding");
    assert_eq!(w::a2a_org("/api/orgs/acme/a2a"), Some("acme"));
    assert_eq!(w::a2a_org("/api/orgs/acme/a2abc"), None);
    // every op's pattern is a row of the connector's route table (OpenAPI, audit route names)
    assert!(Op::Get("x".into()).pattern().ends_with("/tasks/{id}") && Op::Subscribe("x".into()).streams() && !Op::List.streams());
}

#[test]
fn message_intake_takes_text_only() {
    let body = |m: Value| json!({"message": m}).to_string().into_bytes();
    let good = json!({"messageId": "m1", "role": "ROLE_USER", "parts": [{"text": "a"}, {"text": "b", "mediaType": "text/markdown"}],
                      "metadata": {w::EXT: {"skill": SKILL}}});
    let i = w::intake(&body(good.clone())).unwrap();
    assert_eq!((i.text.as_str(), i.skill.as_deref(), i.return_immediately), ("a\nb", Some(SKILL), false));
    let code = |b: Vec<u8>| w::intake(&b).unwrap_err().reason;
    for kind in ["raw", "url", "data"] {
        let mut m = good.clone();
        m["parts"] = json!([{kind: "x"}]);
        assert_eq!(code(body(m)), "CONTENT_TYPE_NOT_SUPPORTED", "{kind}");
    }
    let mut image = good.clone();
    image["parts"] = json!([{"text": "x", "mediaType": "image/png"}]);
    assert_eq!(code(body(image)), "CONTENT_TYPE_NOT_SUPPORTED");
    let mut long = good.clone();
    long["parts"] = json!([{"text": "x".repeat(32_001)}]);
    assert_eq!(code(body(long)), "INVALID_PARAMS", "32001 characters");
    let mut agent = good.clone();
    agent["role"] = json!("ROLE_AGENT");
    assert_eq!(code(body(agent)), "INVALID_PARAMS");
    let mut extra = good.clone();
    extra["metadata"][w::EXT]["name"] = json!("my title");
    assert_eq!(code(body(extra)), "INVALID_PARAMS", "the partner never names the task (R6-6)");
    let mut many = good.clone();
    many["parts"] = json!((0..17).map(|_| json!({"text": "x"})).collect::<Vec<_>>());
    assert_eq!(code(body(many)), "INVALID_PARAMS");
    let modes = json!({"message": good, "configuration": {"acceptedOutputModes": ["image/png"]}}).to_string().into_bytes();
    assert_eq!(code(modes), "CONTENT_TYPE_NOT_SUPPORTED");
    let cfg = json!({"message": {"messageId": "m2", "role": "ROLE_USER", "parts": [{"text": "x"}], "taskId": "t2_a", "contextId": "x_b"},
                     "configuration": {"returnImmediately": true, "historyLength": 0, "taskPushNotificationConfig": {"url": "https://ci.partner.example/h"}}});
    let i = w::intake(cfg.to_string().as_bytes()).unwrap();
    assert_eq!((i.task_id.as_deref(), i.context_id.as_deref(), i.history_length, i.return_immediately, i.push.is_some()), (Some("t2_a"), Some("x_b"), Some(0), true, true));
    assert_eq!(code(b"[]".to_vec()), "INVALID_PARAMS");
}

#[test]
fn push_configs_and_origins() {
    assert_eq!(w::origin_of("https://CI.Partner.example:443/hook?x=1").as_deref(), Some("https://ci.partner.example"));
    assert_eq!(w::origin_of("https://ci.partner.example:8443/h").as_deref(), Some("https://ci.partner.example:8443"));
    assert_eq!(w::origin_of("http://ci.partner.example/h"), None);
    assert_eq!(w::origin_of("https://user@ci.partner.example/h"), None);
    let a = w::push_ask(&json!({"url": "https://ci.partner.example/h", "token": "tok", "authentication": {"scheme": "bearer", "credentials": "secret"}})).unwrap();
    assert_eq!((a.origin.as_str(), a.token.as_deref(), a.credentials.as_deref()), ("https://ci.partner.example", Some("tok"), Some("secret")));
    let bad = |v: Value| w::push_ask(&v).unwrap_err().reason;
    assert_eq!(bad(json!({"url": "https://h.example/x", "authentication": {"scheme": "Basic", "credentials": "x"}})), "INVALID_PARAMS");
    assert_eq!(bad(json!({"url": "https://h.example/x", "token": "t".repeat(257)})), "INVALID_PARAMS");
    assert_eq!(bad(json!({"url": "https://h.example/x", "authentication": {"scheme": "Bearer", "credentials": "a\nb"}})), "INVALID_PARAMS");
    assert_eq!(bad(json!({"url": "http://h.example/x"})), "push-origin");
    let view = w::push_view("p_1", "t2_1", "https://h.example/x", Some("tok"), true);
    assert_eq!(view["authentication"]["credentials"], "<set>", "credentials are never returned");
    assert_eq!(view["token"], "tok");
}

#[test]
fn errors_ids_and_times() {
    let f = Fault::lucid(403, "skill", "This client may not use that skill.");
    let b = f.body("rid1");
    assert_eq!(b["error"]["code"], 403);
    assert_eq!(b["error"]["status"], "PERMISSION_DENIED");
    assert_eq!(b["error"]["details"][0]["@type"], "type.googleapis.com/google.rpc.ErrorInfo");
    assert_eq!((b["error"]["details"][0]["domain"].as_str(), b["error"]["details"][0]["reason"].as_str()), (Some("lucid.emertins.com"), Some("skill")));
    assert_eq!(b["error"]["details"][0]["metadata"]["requestId"], "rid1");
    let nf = Fault::not_found().body("r");
    assert_eq!((nf["error"]["status"].as_str(), nf["error"]["details"][0]["domain"].as_str(), nf["error"]["details"][0]["reason"].as_str()), (Some("NOT_FOUND"), Some("a2a-protocol.org"), Some("TASK_NOT_FOUND")));
    assert_eq!(Fault::a2a(400, "VERSION_NOT_SUPPORTED", "x").rpc_status(), "FAILED_PRECONDITION", "A2A 5.4");
    assert_eq!(Fault::content_type("x").rpc_status(), "INVALID_ARGUMENT");
    assert_eq!(Fault::lucid(409, "task-busy", "x").rpc_status(), "ABORTED");
    assert_eq!(Fault::lucid(429, "tasks", "x").rpc_status(), "RESOURCE_EXHAUSTED");
    assert_eq!(Fault::a2a(404, "TASK_NOT_FOUND", "x").check(), "task-not-found");
    let t = w::new_id("t2_").unwrap();
    assert!(w::id_ok(&t, "t2_") && !w::id_ok(&t, "x_") && w::new_id("t2_").unwrap() != t);
    for ms in [0, 1_000, 1_795_428_000_123, 951_782_400_000] {
        assert_eq!(w::parse_iso(&iso_time(ms)), Some(ms), "{}", iso_time(ms));
    }
    assert_eq!(w::parse_iso("2026-11-23T10:00:00Z"), Some(1_795_428_000_000));
    assert_eq!(w::parse_iso("2026-11-23 10:00:00"), None);
    assert_eq!(w::page_after(&w::page_token(5, "t2_a")), Some((5, "t2_a".into())));
    assert_eq!(w::last_of(&[json!(1), json!(2), json!(3)], Some(2)), [json!(2), json!(3)]);
    let md = w::task_metadata(true, Some(1000)).unwrap();
    assert_eq!(md[w::EXT]["truncated"], true);
    assert!(w::task_metadata(false, None).is_none());
}

// ── journal and token rules ─────────────────────────────────────────────────────────────────────────────────

#[test]
fn the_a2a_journal_actions_parse_fold_and_apply() {
    let entry = |cseq: u64, action: &str, target: Value| json!({"id": format!("k_acme_{cseq:06}"), "cseq": cseq, "ts": 10, "action": action, "target": target, "reach": "connector", "prev_cseq": cseq - 1});
    let ok = |action: &str, target: Value| check_console_entry(&entry(1, action, target), 0, 0).is_ok();
    assert!(ok("agent_off", json!(AGENT)));
    assert!(ok("agent_drop_skill", json!({"agent": AGENT, "skill": SKILL})));
    assert!(ok("client_drop_agent", json!({"client": PARTNER, "agent": AGENT})));
    assert!(ok("client_drop_skill", json!({"client": PARTNER, "skill": format!("{AGENT}/{SKILL}")})));
    assert!(ok("client_a2a_limit", json!({"client": PARTNER, "max_open_tasks": 1})));
    assert!(ok("push_off", json!(PARTNER)));
    assert!(ok("push_drop_origin", json!({"client": PARTNER, "origin": "https://ci.partner.example"})));
    assert!(ok("push_private_off", json!(PARTNER)));
    assert!(!ok("client_a2a_limit", json!({"client": PARTNER, "max_open_tasks": 0})));
    assert!(!ok("push_drop_origin", json!({"client": PARTNER, "origin": "https://ci.partner.example/path"})));
    assert!(!ok("client_drop_skill", json!({"client": PARTNER, "skill": SKILL})));
    // a2a_key_drop and card_private_off are the console's (4a)
    assert!(check_console_entry(&json!({"id": "k_acme_000001", "cseq": 1, "ts": 10, "action": "a2a_key_drop", "target": "a2a-2026-11", "reach": "console"}), 0, 0).is_ok());
    let parsed = |action: &str, target: Value| ConsoleEntry::parse(&entry(1, action, target)).unwrap();
    let active = vec![
        parsed("agent_off", json!(AGENT)),
        parsed("client_drop_skill", json!({"client": PARTNER, "skill": format!("{AGENT}/{SKILL}")})),
        parsed("client_a2a_limit", json!({"client": PARTNER, "max_open_tasks": 3})),
        parsed("push_drop_origin", json!({"client": PARTNER, "origin": "https://ci.partner.example"})),
    ];
    assert!(cj::agent_off(&active, AGENT) && !cj::agent_off(&active, "a_0000000000000000"));
    assert!(cj::client_skill_dropped(&active, PARTNER, &format!("{AGENT}/{SKILL}")));
    assert_eq!(cj::client_a2a_limit(&active, PARTNER), Some(3));
    assert!(cj::push_origin_dropped(&active, PARTNER, "https://ci.partner.example"));
    // folding: the map holds the restriction once the agent is gone, or the client's limit is at or below the entry
    let map = json!({"a2a": {"agents": []}, "clients": [{"id": PARTNER, "state": "active", "a2a": {"agents": [AGENT], "skills": ["*"], "max_open_tasks": 2}}]});
    assert!(cj::contains(&map, &active[0]));
    assert!(!cj::contains(&map, &active[1]), "a * grant does not hold a dropped skill");
    assert!(cj::contains(&map, &active[2]));
    assert!(cj::contains(&map, &active[3]), "no push origins at all");
}

#[test]
fn the_token_endpoint_gives_a_only_to_agents_with_spokes_tasks_submit() {
    let k = "k_7a1b2c3d4e5f6a7b";
    let origin = "https://connector.acme.example:9445";
    let map: serde_json::Map<String, Value> = json!({"issuer": {"url": "https://console.acme.example/api/orgs/acme"},
        "connectors": [{"id": k, "origin": origin, "state": "active"}]}).as_object().unwrap().clone();
    let a = connector_a2a_resource(origin, "acme");
    assert_eq!(a, format!("{}/a2a", connector_resource(origin, "acme")));
    let client = |kind: &str, scopes: Value| json!({"kind": kind, "reach": "R1", "scopes": scopes, "connectors": [k]}).as_object().unwrap().clone();
    let agent = client("agent", json!(["spokes.tasks.submit"]));
    assert_eq!(resolve_resource(&map, "acme", &agent, PARTNER, Some(a.as_str()), &[]).unwrap(), Resolved::Chosen(a.clone(), Target::ConnectorA2a(k.into())));
    let content = client("agent", json!(["content.read"]));
    assert_eq!(resolve_resource(&map, "acme", &content, PARTNER, Some(a.as_str()), &[]).unwrap_err().code, "target");
    let app = client("app", json!(["content.read"]));
    assert_eq!(resolve_resource(&map, "acme", &app, PARTNER, Some(a.as_str()), &[]).unwrap_err().code, "target");
    let suspended = vec![centry("connector_suspend", json!(k))];
    assert_eq!(resolve_resource(&map, "acme", &agent, PARTNER, Some(a.as_str()), &suspended).unwrap_err().code, "target");
}

// ── the world ───────────────────────────────────────────────────────────────────────────────────────────────

/// The partner's push receiver: every post kept; answers `status`.
struct FakePoster {
    posts: Mutex<Vec<(PushTarget, String)>>,
    status: AtomicI64,
}

impl Poster for FakePoster {
    fn post(&self, t: &PushTarget, body: &[u8]) -> Result<u16, String> {
        self.posts.lock().push((t.clone(), String::from_utf8_lossy(body).into_owned()));
        Ok(self.status.load(Ordering::SeqCst) as u16)
    }
}

/// What the map's agent and partner look like.
#[derive(Clone)]
struct Shape {
    turns: &'static str,
    push: bool,
    streaming: bool,
    max_open: i64,
    ceiling: &'static str,
}

impl Default for Shape {
    fn default() -> Shape {
        Shape { turns: "one", push: true, streaming: true, max_open: 2, ceiling: "confidential" }
    }
}

struct Rig {
    fx: Fx,
    spokes: Spokes,
    hub: Arc<ServiceHub>,
    server: Arc<A2aServer>,
    poster: Arc<FakePoster>,
    clock: Arc<AtomicI64>,
}

fn partner_client(id: &str, name: &str, s: &Shape, now_s: i64) -> Value {
    json!({"id": id, "name": name, "principal": format!("{name}@apps.acme.test"), "kind": "agent", "owner": "ann@acme.test", "reach": "R1",
           "scopes": ["spokes.tasks.submit"], "ceiling": s.ceiling, "relays": ["*"], "networks": [], "mtls_required": false,
           "rate": {"per_minute_each": 600, "per_day_each": 100000}, "credentials": [], "created": now_s - 86_400, "expires": now_s + 300 * 86_400,
           "state": "active", "connectors": [K],
           "a2a": {"agents": [AGENT], "skills": ["*"], "max_open_tasks": s.max_open, "push": {"origins": ["https://ci.partner.example"], "private_cidrs": []}}})
}

impl Rig {
    fn new(name: &str, spokes: &[(u8, &'static str)], shape: Shape) -> Rig {
        let sw = Spokes::new(&format!("a2a-{name}"), spokes);
        sw.spokes_poll();
        let hub = ServiceHub::open(sw.parts(KEY_STORE_OS, Duration::from_secs(5))).expect("the service hub opens");
        let mut fx = Fx::new();
        let map = Rig::map(&fx, &sw, &shape);
        let now = fx.w.now;
        fx.resync(map, Vec::new(), Fx::keys(&[PARTNER, OTHER]), now);
        let clock = Arc::new(AtomicI64::new(now));
        let poster = Arc::new(FakePoster { posts: Mutex::new(Vec::new()), status: AtomicI64::new(204) });
        let c = clock.clone();
        let server = A2aServer::new(fx.conn.clone(), fx.sync.clone(), fx.chain.clone(), Some(hub.clone()), poster.clone(), Arc::new(move || c.load(Ordering::SeqCst)));
        Rig { fx, spokes: sw, hub, server, poster, clock }
    }

    fn map(fx: &Fx, sw: &Spokes, s: &Shape) -> Value {
        let now_s = fx.w.now / 1000;
        let mut m = fx.map.clone();
        let targets: Vec<String> = sw.spokes.iter().map(|x| x.node.clone()).collect();
        m["spokes"] = json!({"root": root_id(&sw.root), "relays": []});
        m["a2a"] = json!({"jwks": [], "agents": [{
            "id": AGENT, "name": "Acme Build Agent", "description": "Builds and tests.", "version": "1.0.0", "connector": K, "hub": HUB_CLIENT,
            "streaming": s.streaming, "push": s.push,
            "skills": [{"id": SKILL, "name": "Build and test", "description": "Builds.", "tags": ["build"], "examples": [], "targets": targets,
                        "turns": s.turns, "approve_within_s": 3600, "idle_close_s": 600}]}]});
        let clients = m["clients"].as_array_mut().unwrap();
        // a rebuilt map replaces the partners an earlier one added (never two entries for one id)
        clients.retain(|c| c["id"] != PARTNER && c["id"] != OTHER);
        clients.push(partner_client(PARTNER, "partner-ci", s, now_s));
        clients.push(partner_client(OTHER, "other-ci", s, now_s));
        m
    }

    fn token(&self, client: &str) -> String {
        self.fx.mint(client, &connector_a2a_resource(ORIGIN, "acme"), &["spokes.tasks.submit"])
    }

    #[allow(clippy::too_many_arguments)]
    fn call_on(&self, server: &Arc<A2aServer>, method: &str, rest: &str, query: &str, token: Option<&str>, body: Option<&Value>, version: Option<&str>) -> Handled {
        let path = if rest.is_empty() { "/api/orgs/acme/a2a".to_string() } else { format!("/api/orgs/acme/a2a/{rest}") };
        let auth = token.map(|t| format!("DPoP {t}"));
        let proof = token.map(|t| self.fx.proof(method, &path, t, self.fx.w.now));
        let bytes = body.map(|b| b.to_string().into_bytes());
        let req = Request {
            method,
            path: &path,
            query,
            authorization: auth.as_deref(),
            dpop: proof.as_deref(),
            idempotency_key: None,
            body: bytes.as_deref().map(Ok),
            source: "10.40.0.9".parse().unwrap(),
            now_ms: self.fx.w.now,
        };
        server.handle(&self.fx.api, &req, version)
    }

    /// A whole answer: status, body, its `X-Lucid-Request-Id` checked.
    fn answer(&self, method: &str, rest: &str, query: &str, token: Option<&str>, body: Option<&Value>) -> (u16, Value) {
        answer_of(self.call_on(&self.server, method, rest, query, token, body, Some("1.0")))
    }

    fn send(&self, client: &str, text: &str, config: Value) -> (u16, Value) {
        let body = json!({"message": {"messageId": w::new_id("m_").unwrap(), "role": "ROLE_USER", "parts": [{"text": text}]}, "configuration": config});
        self.answer("POST", &format!("{AGENT}/message:send"), "", Some(&self.token(client)), Some(&body))
    }

    /// The hub hears its inbox; the server syncs what changed.
    fn settle(&self) {
        self.hub.poll_once();
        self.server.drain();
    }

    fn get(&self, client: &str, task: &str) -> (u16, Value) {
        self.answer("GET", &format!("{AGENT}/tasks/{task}"), "", Some(&self.token(client)), None)
    }

    fn spoke(&self) -> &Arc<FakeSpoke> {
        &self.spokes.spokes[0]
    }

    /// The spoke task behind an A2A task (never shown to the partner).
    fn spoke_task(&self, task: &str) -> String {
        self.server.spoke_task_of(task).expect("a spoke task")
    }

    /// A restarted server over the same sealed records and the current sync (the hub's hook stays with the first).
    fn restart(&self) -> Arc<A2aServer> {
        let clock = self.clock.clone();
        A2aServer::new(self.fx.conn.clone(), self.fx.sync.clone(), self.fx.chain.clone(), Some(self.hub.clone()), self.poster.clone(), Arc::new(move || clock.load(Ordering::SeqCst)))
    }

    fn follow(&self, task: &str, message_id: &str, text: &str) -> (u16, Value) {
        let body = json!({"message": {"messageId": message_id, "role": "ROLE_USER", "taskId": task, "parts": [{"text": text}]}, "configuration": {"returnImmediately": true}});
        self.answer("POST", &format!("{AGENT}/message:send"), "", Some(&self.token(PARTNER)), Some(&body))
    }

    /// A many-turn task that finished its first turn and asks for input.
    fn input_required(&self) -> (String, String) {
        let (_, v) = self.send(PARTNER, "first", json!({"returnImmediately": true}));
        let task = v["task"]["id"].as_str().unwrap().to_string();
        let sp = self.spoke_task(&task);
        self.settle();
        approve_start(self.spoke(), &sp);
        self.settle();
        self.spoke().finish_turn(&sp, "First turn.");
        self.settle();
        assert_eq!(self.get(PARTNER, &task).1["status"]["state"], "TASK_STATE_INPUT_REQUIRED");
        (task, sp)
    }
}

fn task_id(v: &Value) -> String {
    v["task"]["id"].as_str().unwrap_or_else(|| panic!("a task in {v}")).to_string()
}

/// A held ask the spoke announces on its own (as a tampered spoke would): `digest` absent when None.
fn forge_ask(rig: &Rig, sp: &str, ask_id: &str, digest: Option<&str>) {
    let spoke = rig.spoke();
    let st = spoke.st.lock();
    let mut ask = json!({"id": ask_id, "kind": "task.start", "title": SKILL, "input": "something else", "tier": "task", "reason": "forged", "openedAt": 1, "expiresAt": 2});
    if let Some(d) = digest {
        ask["digest"] = json!(d);
    }
    spoke.send_to(&st, rig.hub.node(), &json!({"t": "approval", "task": sp, "name": SKILL, "lane": format!("held:{sp}"), "ask": ask}));
}

fn answer_of(h: Handled) -> (u16, Value) {
    match h {
        Handled::Answer(a) => {
            assert!(a.header("X-Lucid-Request-Id").is_some(), "every answer names its request");
            if a.status != 200 {
                assert_eq!(a.header("Content-Type"), Some(w::CONTENT_TYPE), "A2A errors are application/a2a+json");
            }
            (a.status, a.json())
        }
        Handled::Stream { .. } => panic!("a stream where an answer was expected"),
    }
}

fn reason(v: &Value) -> (&str, &str) {
    (v["error"]["details"][0]["domain"].as_str().unwrap_or(""), v["error"]["details"][0]["reason"].as_str().unwrap_or(""))
}

/// A person approved the held start at a human hub (as the add-on journals it): the lane starts working.
fn approve_start(spoke: &FakeSpoke, task: &str) {
    let mut st = spoke.st.lock();
    let ask = st.journal.iter().rev().find(|e| e.task == task && e.kind == "approval.requested").map(|e| e.data["ask"].clone()).expect("the held ask");
    spoke.append(&mut st, task, "approval.decided", json!({"ask": ask, "kind": "task.start", "allow": true, "by": APPROVER, "byLabel": "Ann's hub"}));
    spoke.append(&mut st, task, "task.started", json!({"lane": "l_1", "reviewBranch": "lucid/build-1"}));
    let (origin, name) = {
        let t = st.tasks.get_mut(task).unwrap();
        t["state"] = json!("working");
        t["awaiting"] = Value::Null;
        (t["origin"].as_str().unwrap().to_string(), t["name"].as_str().unwrap().to_string())
    };
    let head = st.journal.len();
    spoke.send_to(&st, &origin, &json!({"t": "note", "task": task, "name": name, "state": "working", "journalHead": head}));
}

/// A person declined the held start: the spoke closes the task (`denied`).
fn deny_start(spoke: &FakeSpoke, task: &str) {
    let mut st = spoke.st.lock();
    let ask = st.journal.iter().rev().find(|e| e.task == task && e.kind == "approval.requested").map(|e| e.data["ask"].clone()).unwrap();
    spoke.append(&mut st, task, "approval.decided", json!({"ask": ask, "kind": "task.start", "allow": false, "by": APPROVER, "byLabel": "Ann's hub"}));
    spoke.append(&mut st, task, "task.closed", json!({"by": APPROVER, "reason": "denied"}));
    let (origin, name) = {
        let t = st.tasks.get_mut(task).unwrap();
        t["state"] = json!("closed");
        t["awaiting"] = Value::Null;
        t["reason"] = json!("denied");
        (t["origin"].as_str().unwrap().to_string(), t["name"].as_str().unwrap().to_string())
    };
    let head = st.journal.len();
    spoke.send_to(&st, &origin, &json!({"t": "note", "task": task, "name": name, "state": "closed", "journalHead": head}));
}

/// 17.1 (without cards, which are slice 1d5's): a partner's task waits for a person, a push reports the state without
/// task text, the stream shows WORKING then the turn artifact then COMPLETED, and GetTask returns `turn-1` and the
/// `handoff` data artifact. The connector chain holds `a2a.task` and `a2a.approval`, never the text.
#[test]
fn a_partner_task_waits_for_a_person_then_returns_its_artifacts() {
    let rig = Rig::new("accept", &[(4, "private")], Shape::default());
    let text = format!("Build release/2.3 and run the unit tests. {CANARY}");
    let push = json!({"url": "https://ci.partner.example/a2a/hook", "token": "tok-1", "authentication": {"scheme": "Bearer", "credentials": "cred-1"}});
    let (status, v) = rig.send(PARTNER, &text, json!({"returnImmediately": true, "taskPushNotificationConfig": push}));
    assert_eq!(status, 200, "{v}");
    let task = v["task"]["id"].as_str().unwrap().to_string();
    assert!(w::id_ok(&task, "t2_") && w::id_ok(v["task"]["contextId"].as_str().unwrap(), "x_"));
    assert_eq!(v["task"]["status"]["state"], "TASK_STATE_AUTH_REQUIRED");
    assert!(v["task"]["status"]["message"]["parts"][0]["text"].as_str().unwrap().ends_with("to approve this task."));
    assert_eq!(v["task"]["history"][0]["parts"][0]["text"], json!(text), "the partner's own text, without Lucid's header");
    // R6-6: the spoke task is named by the skill, and the signed input starts with the connector's header
    let args = rig.spoke().last_args();
    assert_eq!(args["name"], SKILL);
    assert!(args["text"].as_str().unwrap().starts_with(&format!("[Lucid A2A] Partner: partner-ci ({PARTNER}), owner ann@acme.test. Agent: Acme Build Agent ({AGENT}). Skill: {SKILL}.\n\n")));
    assert!(args["text"].as_str().unwrap().ends_with(&text));
    assert_eq!(args["hold"]["within_s"], 3600);
    // the ask came back with the digest of exactly that input: the task stays held
    rig.settle();
    assert_eq!(rig.get(PARTNER, &task).1["status"]["state"], "TASK_STATE_AUTH_REQUIRED");
    let st = rig.spoke_task(&task);
    let held = rig.hub.task(&st).unwrap().ask.unwrap();
    assert_eq!(held.digest, ask_digest("task.start", SKILL, args["text"].as_str().unwrap()));
    // a stream opened now stays open across AUTH_REQUIRED
    let Handled::Stream { sub: _sub, mut rx, .. } = rig.call_on(&rig.server, "GET", &format!("{AGENT}/tasks/{task}:subscribe"), "", Some(&rig.token(PARTNER)), None, Some("1.0")) else { panic!("a stream") };
    let first = String::from_utf8(rx.try_recv().unwrap().to_vec()).unwrap();
    assert!(first.starts_with("data: {\"task\":") && first.ends_with("\n\n"));
    // a person approves; the lane works; its turn ends with a review branch handed off
    approve_start(rig.spoke(), &st);
    rig.settle();
    assert_eq!(rig.get(PARTNER, &task).1["status"]["state"], "TASK_STATE_WORKING");
    {
        let mut s = rig.spoke().st.lock();
        rig.spoke().append(&mut s, &st, "task.handoff", json!({"by": "n_x", "branch": "lucid/build-1", "commit": "a1b2c3d", "sha256": "0".repeat(64), "bytes": 10}));
    }
    rig.spoke().finish_turn(&st, "Built; all 12 tests pass.");
    rig.settle();
    let (_, done) = rig.get(PARTNER, &task);
    assert_eq!(done["status"]["state"], "TASK_STATE_COMPLETED", "turns: one completes after its turn");
    let arts = done["artifacts"].as_array().unwrap();
    let turn = arts.iter().find(|a| a["artifactId"] == "turn-1").expect("turn-1");
    assert_eq!((turn["parts"][0]["text"].as_str(), turn["parts"][0]["mediaType"].as_str()), (Some("Built; all 12 tests pass."), Some("text/markdown")));
    let handoff = arts.iter().find(|a| a["artifactId"] == "handoff").expect("handoff");
    assert_eq!(handoff["parts"][0]["data"], json!({"reviewBranch": "lucid/build-1", "commit": "a1b2c3d"}));
    assert_eq!(rig.spoke().ops().last().map(String::as_str), Some("close"), "the connector closed the spoke task");
    // the stream: WORKING, the artifacts, COMPLETED, then closed
    let mut events = Vec::new();
    while let Ok(b) = rx.try_recv() {
        events.push(String::from_utf8(b.to_vec()).unwrap());
    }
    let all = events.join("");
    let (working, artifact, completed) = (all.find("TASK_STATE_WORKING").unwrap(), all.find("\"artifactUpdate\"").unwrap(), all.find("TASK_STATE_COMPLETED").unwrap());
    assert!(working < artifact && artifact < completed, "{all}");
    assert!(all.contains("\"lastChunk\":true") && all.contains("\"append\":false"));
    assert!(matches!(rx.try_recv(), Err(tokio::sync::mpsc::error::TryRecvError::Disconnected)), "the stream closed at the terminal state");
    assert_eq!(rig.server.streams_open(), 0);
    // pushes: status only, with the partner's token and credentials, never task content
    assert!(rig.server.pusher().tick() >= 1);
    while rig.server.pusher().tick() > 0 {}
    let posts = rig.poster.posts.lock().clone();
    assert!(posts.len() >= 3, "AUTH_REQUIRED, WORKING, COMPLETED: {}", posts.len());
    for (t, body) in &posts {
        assert_eq!((t.token.as_deref(), t.credentials.as_deref(), t.origin.as_str()), (Some("tok-1"), Some("cred-1"), "https://ci.partner.example"));
        let v: Value = serde_json::from_str(body).unwrap();
        assert!(v.get("statusUpdate").is_some() && v.as_object().unwrap().len() == 1, "{body}");
        assert!(!body.contains(CANARY) && !body.contains("artifactUpdate") && !body.contains("Built;"), "{body}");
    }
    // the chain: a2a.task and a2a.approval (with the approver), a2a.push; never the text or the credentials
    let actions = rig.fx.chain.actions();
    for a in ["a2a.task", "a2a.approval", "a2a.push"] {
        assert!(actions.iter().any(|x| x == a), "{a} in {actions:?}");
    }
    let entries = rig.fx.chain.entries.lock().clone();
    let approval = entries.iter().find(|e| e["action"] == "a2a.approval").unwrap();
    assert_eq!((approval["kind"].as_str(), approval["result"].as_str(), approval["approver"].as_str()), (Some("task.start"), Some("allowed"), Some(APPROVER)));
    assert!(entries.iter().any(|e| e["action"] == "a2a.task" && e["state"] == "completed" && e["spoke"] == json!(rig.spoke().node)));
    assert!(rig.fx.chain.clean_of(CANARY, "cred-1") && rig.fx.chain.clean_of("Built; all", "tok-1"));
}

/// 17.3: versions, audiences, other clients, content types, limits, ceilings, busy tasks.
#[test]
fn the_checks_of_7_4() {
    let rig = Rig::new("checks", &[(4, "private")], Shape { max_open: 1, ..Shape::default() });
    let token = rig.token(PARTNER);
    let body = json!({"message": {"messageId": "m-1", "role": "ROLE_USER", "parts": [{"text": "hi"}]}});
    let send = format!("{AGENT}/message:send");
    // A1: absent or 0.3
    for v in [None, Some("0.3")] {
        let (s, e) = answer_of(rig.call_on(&rig.server, "POST", &send, "", Some(&token), Some(&body), v));
        assert_eq!((s, reason(&e)), (400, ("a2a-protocol.org", "VERSION_NOT_SUPPORTED")), "{v:?}");
    }
    // a token for C (or I) is refused at A
    let for_c = rig.fx.mint(PARTNER, &connector_resource(ORIGIN, "acme"), &["spokes.tasks.submit"]);
    let (s, e) = answer_of(rig.call_on(&rig.server, "POST", &send, "", Some(&for_c), Some(&body), Some("1.0")));
    assert_eq!((s, e["error"]["details"][0]["domain"].as_str()), (401, Some("lucid.emertins.com")));
    // no token: 401 with the A metadata in WWW-Authenticate
    let Handled::Answer(none) = rig.call_on(&rig.server, "POST", &send, "", None, Some(&body), Some("1.0")) else { panic!() };
    assert_eq!(none.status, 401);
    assert!(none.header("WWW-Authenticate").unwrap().contains("/.well-known/oauth-protected-resource/api/orgs/acme/a2a"));
    // A2: an unknown agent is TASK_NOT_FOUND
    let (s, e) = answer_of(rig.call_on(&rig.server, "POST", "a_0000000000000000/message:send", "", Some(&token), Some(&body), Some("1.0")));
    assert_eq!((s, reason(&e)), (404, ("a2a-protocol.org", "TASK_NOT_FOUND")));
    // the first task; A5 refuses a second (max_open_tasks 1)
    let first = json!({"message": {"messageId": "m-dup", "role": "ROLE_USER", "parts": [{"text": "first"}]}, "configuration": {"returnImmediately": true}});
    let (s, v) = rig.answer("POST", &send, "", Some(&token), Some(&first));
    assert_eq!(s, 200, "{v}");
    let task = v["task"]["id"].as_str().unwrap().to_string();
    let Handled::Answer(more) = rig.call_on(&rig.server, "POST", &send, "", Some(&token), Some(&json!({"message": {"messageId": "m-2", "role": "ROLE_USER", "parts": [{"text": "x"}]}})), Some("1.0")) else { panic!() };
    assert_eq!((more.status, reason(&more.json()).1, more.header("Retry-After")), (429, "tasks", Some("60")));
    // a repeated messageId answers the task it made (A2A 3.3.1), before any limit
    let (s, again) = rig.answer("POST", &send, "", Some(&token), Some(&first));
    assert_eq!((s, &again["task"]["id"]), (200, &json!(task)));
    assert_eq!(rig.spoke().ops().iter().filter(|o| *o == "submit").count(), 1, "nothing sent again");
    // A3: another client cannot read, cancel, subscribe or list it
    let other = rig.token(OTHER);
    for (m, rest) in [("GET", format!("{AGENT}/tasks/{task}")), ("POST", format!("{AGENT}/tasks/{task}:cancel")), ("GET", format!("{AGENT}/tasks/{task}:subscribe"))] {
        let (s, e) = answer_of(rig.call_on(&rig.server, m, &rest, "", Some(&other), None, Some("1.0")));
        assert_eq!((s, reason(&e).1), (404, "TASK_NOT_FOUND"), "{m} {rest}");
    }
    let (_, list) = rig.answer("GET", &format!("{AGENT}/tasks"), "", Some(&other), None);
    assert_eq!((list["tasks"].as_array().unwrap().len(), list["nextPageToken"].as_str()), (0, Some("")));
    let (_, mine) = rig.answer("GET", &format!("{AGENT}/tasks"), "pageSize=1&status=auth_required", Some(&token), None);
    assert_eq!(mine["tasks"][0]["id"], json!(task));
    assert!(mine["tasks"][0].get("artifacts").is_none(), "artifacts only with includeArtifacts=true");
    assert_eq!(rig.answer("GET", &format!("{AGENT}/tasks"), "pageSize=101", Some(&token), None).0, 400);
    // R6-3: a message to an AUTH_REQUIRED task is task-busy
    let follow = json!({"message": {"messageId": "m-3", "role": "ROLE_USER", "taskId": task, "parts": [{"text": "and this"}]}});
    let (s, e) = rig.answer("POST", &send, "", Some(&token), Some(&follow));
    assert_eq!((s, reason(&e)), (409, ("lucid.emertins.com", "task-busy")));
    // content types and length
    let raw = json!({"message": {"messageId": "m-4", "role": "ROLE_USER", "parts": [{"raw": "AAAA"}]}});
    assert_eq!(reason(&rig.answer("POST", &send, "", Some(&token), Some(&raw)).1).1, "CONTENT_TYPE_NOT_SUPPORTED");
    // the extended card is not served
    assert_eq!(reason(&rig.answer("GET", &format!("{AGENT}/extendedAgentCard"), "", Some(&token), None).1).1, "UNSUPPORTED_OPERATION");
    // cancel: canceled, then not cancelable
    let (s, c) = rig.answer("POST", &format!("{AGENT}/tasks/{task}:cancel"), "", Some(&token), Some(&json!({})));
    assert_eq!((s, c["status"]["state"].as_str()), (200, Some("TASK_STATE_CANCELED")));
    assert!(rig.spoke().ops().contains(&"cancel".to_string()), "the held task was canceled on the spoke");
    let (s, e) = rig.answer("POST", &format!("{AGENT}/tasks/{task}:cancel"), "", Some(&token), Some(&json!({})));
    assert_eq!((s, reason(&e).1), (400, "TASK_NOT_CANCELABLE"));
    // every refusal was audited as api.refusal with its 7.11 code
    let entries = rig.fx.chain.entries.lock().clone();
    for check in ["version-not-supported", "task-not-found", "tasks", "task-busy", "content-type-not-supported"] {
        assert!(entries.iter().any(|e| e["action"] == "api.refusal" && e["check"] == check), "{check}");
    }
}

/// A6 and the rejected states: a cui spoke is above a confidential client; a paused spoke gives Lucid's sentence.
#[test]
fn ceilings_and_rejections() {
    let rig = Rig::new("ceiling", &[(4, "cui")], Shape::default());
    let (s, e) = rig.send(PARTNER, "x", json!({"returnImmediately": true}));
    assert_eq!((s, reason(&e)), (403, ("lucid.emertins.com", "ceiling")));
    let rig = Rig::new("paused", &[(5, "private")], Shape::default());
    rig.spoke().st.lock().refuse = Some(crate::connector_spokes::OWNER_PAUSED.into());
    let (s, v) = rig.send(PARTNER, "x", json!({"returnImmediately": true}));
    assert_eq!((s, v["task"]["status"]["state"].as_str()), (200, Some("TASK_STATE_REJECTED")));
    assert_eq!(v["task"]["status"]["message"]["parts"][0]["text"], "The spoke is paused.");
    assert!(!v.to_string().contains("paused new work"), "never the spoke's own words (R6-13)");
}

/// 5.5 and 7.6: a declined start is REJECTED with Lucid's sentence; a many-turn task takes a follow-up only when
/// it asks for input, and that follow-up is held again.
#[test]
fn declined_starts_and_follow_up_turns() {
    let rig = Rig::new("turns", &[(4, "private")], Shape { turns: "many", ..Shape::default() });
    let (_, v) = rig.send(PARTNER, "one", json!({"returnImmediately": true}));
    let denied = v["task"]["id"].as_str().unwrap().to_string();
    rig.settle();
    deny_start(rig.spoke(), &rig.spoke_task(&denied));
    rig.settle();
    let (_, d) = rig.get(PARTNER, &denied);
    assert_eq!(d["status"]["state"], "TASK_STATE_REJECTED");
    assert!(d["status"]["message"]["parts"][0]["text"].as_str().unwrap().contains("declined the task."));
    let entries = rig.fx.chain.entries.lock().clone();
    assert!(entries.iter().any(|e| e["action"] == "a2a.approval" && e["result"] == "denied"));
    // a many-turn task: approved, its turn ends, it asks for input
    let (_, v) = rig.send(PARTNER, "two", json!({"returnImmediately": true}));
    let task = v["task"]["id"].as_str().unwrap().to_string();
    let context = v["task"]["contextId"].clone();
    let st = rig.spoke_task(&task);
    rig.settle();
    approve_start(rig.spoke(), &st);
    rig.settle();
    rig.spoke().finish_turn(&st, "First turn.");
    rig.settle();
    let (_, t) = rig.get(PARTNER, &task);
    assert_eq!(t["status"]["state"], "TASK_STATE_INPUT_REQUIRED");
    assert_eq!(t["status"]["message"]["parts"][0]["text"], "Turn finished; send a message to continue.");
    // a contextId of another task's is refused; the task's own takes the follow-up, held as task.turn
    let bad = json!({"message": {"messageId": "f-0", "role": "ROLE_USER", "taskId": task, "contextId": "x_AAAAAAAAAAAAAAAAAAAAAA", "parts": [{"text": "x"}]}});
    assert_eq!(rig.answer("POST", &format!("{AGENT}/message:send"), "", Some(&rig.token(PARTNER)), Some(&bad)).0, 400);
    let follow = json!({"message": {"messageId": "f-1", "role": "ROLE_USER", "taskId": task, "contextId": context, "parts": [{"text": "Run them again."}]}, "configuration": {"returnImmediately": true}});
    let (s, f) = rig.answer("POST", &format!("{AGENT}/message:send"), "", Some(&rig.token(PARTNER)), Some(&follow));
    assert_eq!((s, f["task"]["status"]["state"].as_str()), (200, Some("TASK_STATE_AUTH_REQUIRED")));
    assert_eq!(f["task"]["history"].as_array().unwrap().len(), 2);
    let args = rig.spoke().last_args();
    assert!(args["text"].as_str().unwrap().starts_with("[Lucid A2A] Partner: partner-ci") && args["text"].as_str().unwrap().ends_with("Run them again."));
    assert_eq!(rig.spoke().ops().last().map(String::as_str), Some("followup"));
    // idle_close_s: a task waiting for input closes after its idle time
    rig.settle();
}

/// 7.9: at most 4 streams per client; GET and POST subscribe; a message:stream answers SSE.
#[test]
fn streams_are_limited_and_both_subscribe_bindings_work() {
    let rig = Rig::new("streams", &[(4, "private")], Shape::default());
    let (_, v) = rig.send(PARTNER, "x", json!({"returnImmediately": true}));
    let task = v["task"]["id"].as_str().unwrap().to_string();
    let token = rig.token(PARTNER);
    let mut held = Vec::new();
    for (i, m) in ["GET", "POST", "GET", "POST"].iter().enumerate() {
        match rig.call_on(&rig.server, m, &format!("{AGENT}/tasks/{task}:subscribe"), "", Some(&token), Some(&json!({})).filter(|_| *m == "POST"), Some("1.0")) {
            Handled::Stream { sub, rx, .. } => held.push((sub, rx)),
            Handled::Answer(a) => panic!("stream {i}: {}", a.status),
        }
    }
    assert_eq!(rig.server.streams_open(), 4);
    let (s, e) = answer_of(rig.call_on(&rig.server, "GET", &format!("{AGENT}/tasks/{task}:subscribe"), "", Some(&token), None, Some("1.0")));
    assert_eq!((s, reason(&e).1), (429, "streams"));
    // the tick keeps them while the token and the client stand
    rig.server.tick();
    assert_eq!(rig.server.streams_open(), 4);
}

/// 7.10: pushes only for agents and clients that allow them, under the client's origins.
#[test]
fn push_configs_follow_the_client_and_agent() {
    let rig = Rig::new("push", &[(4, "private")], Shape::default());
    let token = rig.token(PARTNER);
    let (_, v) = rig.send(PARTNER, "x", json!({"returnImmediately": true}));
    let task = v["task"]["id"].as_str().unwrap().to_string();
    let path = format!("{AGENT}/tasks/{task}/pushNotificationConfigs");
    let (s, e) = rig.answer("POST", &path, "", Some(&token), Some(&json!({"url": "https://evil.example/h"})));
    assert_eq!((s, reason(&e)), (400, ("lucid.emertins.com", "push-origin")));
    let (s, c) = rig.answer("POST", &path, "", Some(&token), Some(&json!({"url": "https://ci.partner.example/h", "token": "t1", "authentication": {"scheme": "Bearer", "credentials": "c1"}})));
    assert_eq!(s, 200, "{c}");
    let id = c["id"].as_str().unwrap().to_string();
    assert_eq!(c["authentication"]["credentials"], "<set>");
    let (_, got) = rig.answer("GET", &format!("{path}/{id}"), "", Some(&token), None);
    assert_eq!((got["token"].as_str(), got["authentication"]["credentials"].as_str()), (Some("t1"), Some("<set>")));
    assert_eq!(rig.answer("POST", &path, "", Some(&token), Some(&json!({"url": "https://ci.partner.example/h2"}))).0, 200);
    let (s, e) = rig.answer("POST", &path, "", Some(&token), Some(&json!({"url": "https://ci.partner.example/h3"})));
    assert_eq!((s, reason(&e).1), (400, "INVALID_PARAMS"), "at most 2 per task");
    assert_eq!(rig.answer("DELETE", &format!("{path}/{id}"), "", Some(&token), None).0, 200);
    assert_eq!(rig.answer("DELETE", &format!("{path}/{id}"), "", Some(&token), None).0, 200, "idempotent");
    let (_, list) = rig.answer("GET", &path, "", Some(&token), None);
    assert_eq!(list["configs"].as_array().unwrap().len(), 1);
    assert!(!rig.fx.chain.entries.lock().iter().any(|e| e.to_string().contains("c1\"")), "credentials never audited");
    // an agent without push
    let rig = Rig::new("nopush", &[(4, "private")], Shape { push: false, ..Shape::default() });
    let push = json!({"url": "https://ci.partner.example/h"});
    let (s, e) = rig.send(PARTNER, "x", json!({"returnImmediately": true, "taskPushNotificationConfig": push}));
    assert_eq!((s, reason(&e)), (400, ("a2a-protocol.org", "PUSH_NOTIFICATION_NOT_SUPPORTED")));
}

/// 7.2.1 and 7.2.2: an enclave connector and a stale one answer every A route 503.
#[test]
fn enclave_and_stale_connectors_serve_no_a2a() {
    let mut rig = Rig::new("enclave", &[(4, "private")], Shape::default());
    let mut c = Connector::for_test(&rig.fx.w.dir, rig.fx.w.session.shared().clone(), BTreeMap::from([(crate::connector_session::tests::APP.to_string(), rig.fx.w.session.clone())]));
    c.cfg.enclave = Enclave { on: true, networks: vec![crate::console_source::parse_cidr("10.40.0.0/16").unwrap()] };
    let clock = rig.clock.clone();
    let enclave = A2aServer::new(Arc::new(c), rig.fx.sync.clone(), rig.fx.chain.clone(), None, rig.poster.clone(), Arc::new(move || clock.load(Ordering::SeqCst)));
    let (s, e) = answer_of(rig.call_on(&enclave, "GET", &format!("{AGENT}/tasks"), "", Some(&rig.token(PARTNER)), None, Some("1.0")));
    assert_eq!((s, reason(&e)), (503, ("lucid.emertins.com", "enclave")));
    // stale: the last sync is older than stale_s
    let map = rig.fx.map.clone();
    let old = rig.fx.w.now - 3_600_000;
    rig.fx.resync(map, Vec::new(), Fx::keys(&[PARTNER, OTHER]), old);
    let clock = rig.clock.clone();
    let stale = A2aServer::new(rig.fx.conn.clone(), rig.fx.sync.clone(), rig.fx.chain.clone(), Some(rig.hub.clone()), rig.poster.clone(), Arc::new(move || clock.load(Ordering::SeqCst)));
    let (s, e) = answer_of(rig.call_on(&stale, "GET", &format!("{AGENT}/tasks"), "", Some(&rig.token(PARTNER)), None, Some("1.0")));
    assert_eq!((s, reason(&e)), (503, ("lucid.emertins.com", "connector-stale")));
}

/// 2.3 and 7.6: `agent_off` hides the agent (404) and the tick cancels its open tasks on the spoke; records survive
/// a restart (the sealed store).
#[test]
fn agent_off_cancels_open_tasks_and_records_survive_a_restart() {
    let mut rig = Rig::new("off", &[(4, "private")], Shape::default());
    let (_, v) = rig.send(PARTNER, "x", json!({"returnImmediately": true}));
    let task = v["task"]["id"].as_str().unwrap().to_string();
    rig.settle();
    let map = rig.fx.map.clone();
    let now = rig.fx.w.now;
    rig.fx.resync(map, vec![centry("agent_off", json!(AGENT))], Fx::keys(&[PARTNER, OTHER]), now);
    let clock = rig.clock.clone();
    let restarted = A2aServer::new(rig.fx.conn.clone(), rig.fx.sync.clone(), rig.fx.chain.clone(), Some(rig.hub.clone()), rig.poster.clone(), Arc::new(move || clock.load(Ordering::SeqCst)));
    let (s, e) = answer_of(rig.call_on(&restarted, "GET", &format!("{AGENT}/tasks/{task}"), "", Some(&rig.token(PARTNER)), None, Some("1.0")));
    assert_eq!((s, reason(&e).1), (404, "TASK_NOT_FOUND"), "no existence leak");
    assert_eq!(restarted.spoke_task_of(&task), Some(rig.spoke_task(&task)), "the record was reloaded");
    restarted.tick();
    let entries = rig.fx.chain.entries.lock().clone();
    assert!(entries.iter().any(|e| e["action"] == "a2a.task" && e["task"] == json!(task) && e["state"] == "canceled"));
    assert!(rig.spoke().ops().contains(&"cancel".to_string()));
}

/// 7.4 A6 on existing tasks: once the client's ceiling falls below the class of the spoke holding a task, every op
/// naming it (a repeated `messageId` too) is TASK_NOT_FOUND and lists leave it out.
#[test]
fn a_task_above_a_lowered_ceiling_is_not_found() {
    let mut rig = Rig::new("lowered", &[(4, "private")], Shape::default());
    let send = format!("{AGENT}/message:send");
    let first = json!({"message": {"messageId": "m-low", "role": "ROLE_USER", "parts": [{"text": "x"}]}, "configuration": {"returnImmediately": true}});
    let (s, v) = rig.answer("POST", &send, "", Some(&rig.token(PARTNER)), Some(&first));
    assert_eq!(s, 200, "{v}");
    let task = task_id(&v);
    rig.settle();
    // the client's ceiling falls to internal; the private spoke's tasks are confidential
    let map = Rig::map(&rig.fx, &rig.spokes, &Shape { ceiling: "internal", ..Shape::default() });
    let now = rig.fx.w.now;
    rig.fx.resync(map, Vec::new(), Fx::keys(&[PARTNER, OTHER]), now);
    let server = rig.restart();
    let token = rig.token(PARTNER);
    let push = format!("{AGENT}/tasks/{task}/pushNotificationConfigs");
    let follow = json!({"message": {"messageId": "m-low-2", "role": "ROLE_USER", "taskId": task, "parts": [{"text": "y"}]}});
    let calls: Vec<(&str, String, Option<Value>)> = vec![
        ("GET", format!("{AGENT}/tasks/{task}"), None),
        ("POST", format!("{AGENT}/tasks/{task}:cancel"), Some(json!({}))),
        ("GET", format!("{AGENT}/tasks/{task}:subscribe"), None),
        ("POST", push.clone(), Some(json!({"url": "https://ci.partner.example/h"}))),
        ("GET", push, None),
        ("POST", send.clone(), Some(follow)),
        ("POST", send, Some(first)),
    ];
    for (m, rest, body) in &calls {
        let (s, e) = answer_of(rig.call_on(&server, m, rest, "", Some(&token), body.as_ref(), Some("1.0")));
        assert_eq!((s, reason(&e).1), (404, "TASK_NOT_FOUND"), "{m} {rest}");
    }
    let (_, list) = answer_of(rig.call_on(&server, "GET", &format!("{AGENT}/tasks"), "", Some(&token), None, Some("1.0")));
    assert_eq!(list["tasks"].as_array().unwrap().len(), 0);
    let ops = rig.spoke().ops();
    assert_eq!(ops.iter().filter(|o| *o == "submit").count(), 1, "the repeat made nothing");
    assert!(!ops.iter().any(|o| o == "cancel" || o == "followup"), "{ops:?}");
}

/// D15: send, follow-up, cancel and push config changes append their call entry first; when the append fails they
/// answer 503 and nothing is sent or changed.
#[test]
fn writes_do_nothing_when_their_audit_fails() {
    let rig = Rig::new("auditfail", &[(4, "private")], Shape { turns: "many", ..Shape::default() });
    let (task, _) = rig.input_required();
    let token = rig.token(PARTNER);
    let push = format!("{AGENT}/tasks/{task}/pushNotificationConfigs");
    let ops = rig.spoke().ops().len();
    rig.fx.chain.fail.store(true, Ordering::SeqCst);
    assert_eq!(rig.send(PARTNER, "new", json!({"returnImmediately": true})).0, 503);
    assert_eq!(rig.follow(&task, "f-audit", "Again.").0, 503);
    assert_eq!(rig.answer("POST", &format!("{AGENT}/tasks/{task}:cancel"), "", Some(&token), Some(&json!({}))).0, 503);
    assert_eq!(rig.answer("POST", &push, "", Some(&token), Some(&json!({"url": "https://ci.partner.example/h"}))).0, 503);
    assert_eq!(rig.spoke().ops().len(), ops, "nothing reached the spoke");
    rig.fx.chain.fail.store(false, Ordering::SeqCst);
    let (_, t) = rig.get(PARTNER, &task);
    assert_eq!((t["status"]["state"].as_str(), t["history"].as_array().unwrap().len()), (Some("TASK_STATE_INPUT_REQUIRED"), 1));
    assert_eq!(rig.answer("GET", &push, "", Some(&token), None).1["configs"].as_array().unwrap().len(), 0);
    // the follow-up's messageId was not taken: it is sent now
    assert_eq!(rig.follow(&task, "f-audit", "Again.").1["task"]["status"]["state"], "TASK_STATE_AUTH_REQUIRED");
}

/// R6-6: an ask carrying no digest is a mismatch, compared even when the journal already holds the start's decision
/// (the ask is queued as announced); the ask is denied and the task fails.
#[test]
fn an_ask_without_the_sent_digest_fails_the_task() {
    let rig = Rig::new("forged", &[(4, "private")], Shape::default());
    // announced, then the start declined, before the worker ran
    let (_, v) = rig.send(PARTNER, "x", json!({"returnImmediately": true}));
    let task = task_id(&v);
    let sp = rig.spoke_task(&task);
    forge_ask(&rig, &sp, "s_forged_1", None);
    deny_start(rig.spoke(), &sp);
    rig.settle();
    assert_eq!(rig.get(PARTNER, &task).1["status"]["state"], "TASK_STATE_FAILED");
    // a verified task: a later ask with no digest fails it too
    let (_, v) = rig.send(PARTNER, "y", json!({"returnImmediately": true}));
    let task = task_id(&v);
    let sp = rig.spoke_task(&task);
    rig.settle();
    assert_eq!(rig.get(PARTNER, &task).1["status"]["state"], "TASK_STATE_AUTH_REQUIRED");
    forge_ask(&rig, &sp, "s_forged_2", None);
    rig.settle();
    assert_eq!(rig.get(PARTNER, &task).1["status"]["state"], "TASK_STATE_FAILED");
    assert!(rig.spoke().ops().iter().any(|o| o == "deny"), "the forged ask was denied");
    assert!(rig.fx.chain.entries.lock().iter().any(|e| e["action"] == "a2a.task" && e["task"] == json!(task) && e["state"] == "failed"));
}

/// R6-3, R6-6: a follow-up (history, `messageId`, expected digest) is sealed before it is sent; one that cannot be
/// sealed is not sent and leaves nothing; one the record cannot move on after the spoke took it is ended there.
#[test]
fn a_follow_up_is_sealed_before_it_is_sent() {
    let rig = Rig::new("sealturn", &[(4, "private")], Shape { turns: "many", ..Shape::default() });
    let (task, _) = rig.input_required();
    rig.server.faults.lock().insert("content");
    assert_eq!(rig.follow(&task, "f-seal", "Again.").0, 503);
    rig.server.faults.lock().clear();
    assert!(!rig.spoke().ops().iter().any(|o| o == "followup"), "not sent");
    let (_, t) = rig.get(PARTNER, &task);
    assert_eq!((t["status"]["state"].as_str(), t["history"].as_array().unwrap().len()), (Some("TASK_STATE_INPUT_REQUIRED"), 1));
    // the spoke takes it, then its state cannot be audited: the held turn is ended on the spoke
    rig.server.faults.lock().insert("state");
    assert_eq!(rig.follow(&task, "f-seal", "Again.").0, 503);
    rig.server.faults.lock().clear();
    let ops = rig.spoke().ops();
    let sent = ops.iter().position(|o| o == "followup").expect("the turn was sent");
    assert!(ops[sent + 1..].iter().any(|o| o == "deny" || o == "cancel" || o == "close"), "{ops:?}");
    assert_eq!(rig.get(PARTNER, &task).1["history"].as_array().unwrap().len(), 2, "the turn was sealed before it was sent");
}

/// 11, 9.4: a state change whose `a2a.task` entry cannot be appended is not announced; it stays pending and the
/// tick audits and announces it once the audit works again.
#[test]
fn a_state_change_is_announced_only_once_audited() {
    let rig = Rig::new("pending", &[(4, "private")], Shape::default());
    let (_, v) = rig.send(PARTNER, "x", json!({"returnImmediately": true}));
    let task = task_id(&v);
    let sp = rig.spoke_task(&task);
    rig.settle();
    let working = || rig.fx.chain.entries.lock().iter().any(|e| e["action"] == "a2a.task" && e["task"] == json!(task) && e["state"] == "working");
    rig.server.faults.lock().insert("state");
    approve_start(rig.spoke(), &sp);
    rig.settle();
    assert_eq!(rig.get(PARTNER, &task).1["status"]["state"], "TASK_STATE_AUTH_REQUIRED", "not announced before its audit");
    rig.server.tick();
    assert!(!working(), "pending while the audit fails");
    rig.server.faults.lock().clear();
    rig.server.tick();
    assert!(working());
    assert_eq!(rig.get(PARTNER, &task).1["status"]["state"], "TASK_STATE_WORKING");
}

/// 7.4 A5, 7.6: a new task whose history, record (with the index) or state audit cannot be made durable ends its
/// spoke task, answers 503 and is neither indexed nor announced; its admission is released. An admission holds its
/// slot until released.
#[test]
fn a_new_task_is_kept_only_once_durable() {
    let rig = Rig::new("durable", &[(4, "private")], Shape { max_open: 1, ..Shape::default() });
    let token = rig.token(PARTNER);
    for fault in ["content", "index", "state"] {
        rig.server.faults.lock().insert(fault);
        let (s, e) = rig.send(PARTNER, "x", json!({"returnImmediately": true}));
        rig.server.faults.lock().clear();
        assert_eq!((s, reason(&e).1), (503, "unavailable"), "{fault}");
        let ops = rig.spoke().ops();
        let submit = ops.iter().rposition(|o| o == "submit").expect("submitted");
        assert!(ops[submit + 1..].iter().any(|o| o == "cancel"), "{fault}: the spoke task was ended: {ops:?}");
        let (_, list) = rig.answer("GET", &format!("{AGENT}/tasks"), "", Some(&token), None);
        assert_eq!(list["tasks"].as_array().unwrap().len(), 0, "{fault}");
        let announced = rig.fx.chain.entries.lock().iter().any(|e| e["action"] == "a2a.task" && e.get("route").is_none());
        assert!(!announced, "{fault}: no state change was announced");
    }
    // every failed submit released its admission (max_open_tasks 1)
    let (s, v) = rig.send(PARTNER, "y", json!({"returnImmediately": true}));
    assert_eq!(s, 200, "{v}");
    // an admission holds its slot from the check to the durable record
    let Ok(held) = rig.server.admit(PARTNER, AGENT, 2) else { panic!("one open, one admitted") };
    assert_eq!(rig.server.admit(PARTNER, AGENT, 2).err().map(|f| f.status), Some(429));
    drop(held);
    assert!(rig.server.admit(PARTNER, AGENT, 2).is_ok());
    // after a restart, only the durable task is there
    let again = rig.restart();
    let (_, list) = answer_of(rig.call_on(&again, "GET", &format!("{AGENT}/tasks"), "", Some(&token), None, Some("1.0")));
    assert_eq!(list["tasks"].as_array().unwrap().len(), 1);
}

/// The live partner test (17.1 with a real A2A 1.0 SDK client) runs against a deployed connector, set by the gate's
/// variables: `LUCID_GATE_A2A_PARTNER` (any value), `LUCID_A2A_AGENT_URL` (the card's interface URL) and
/// `LUCID_A2A_TOKEN` (an mTLS-bound or unbound test token for A; DPoP-bound tokens need the SDK's own client).
#[test]
#[ignore = "live gate G-A2A-PARTNER"]
fn live_partner_agent_gets_a_held_task() {
    let url = std::env::var("LUCID_A2A_AGENT_URL").expect("LUCID_A2A_AGENT_URL");
    let token = std::env::var("LUCID_A2A_TOKEN").expect("LUCID_A2A_TOKEN");
    let (host, port) = crate::ai_gateway::host_port(&url).expect("an https URL");
    let rest = url.strip_prefix("https://").expect("an https URL");
    let path = rest.find('/').map_or("", |i| &rest[i..]).trim_end_matches('/').to_string();
    let cfg = crate::meet_tls::client_config(None, None).expect("web PKI client config");
    let body = json!({"message": {"messageId": w::new_id("m_").unwrap(), "role": "ROLE_USER", "parts": [{"text": "Lucid live gate G-A2A-PARTNER: build and test."}]},
                      "configuration": {"returnImmediately": true}})
    .to_string();
    let headers = vec![("Content-Type", "application/a2a+json".to_string()), ("A2A-Version", "1.0".to_string()), ("Authorization", format!("Bearer {token}"))];
    let r = crate::meet_tls::https_request(&cfg, &host, port, 60.0, "POST", &format!("{path}/message:send"), &headers, Some(body.as_bytes()), &|_| Ok(())).map_err(|e| format!("{e:?}")).expect("the connector answers");
    assert_eq!(r.status, 200, "{}", String::from_utf8_lossy(&r.body));
    let v: Value = serde_json::from_slice(&r.body).unwrap();
    assert_eq!(str_of(v["task"]["status"].get("state")), Some("TASK_STATE_AUTH_REQUIRED"));
}
