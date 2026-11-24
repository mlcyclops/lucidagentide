// Slice 1d3 (contract r6 7.2.3, 16): the connector's service hub against the add-on and against this crate's own
// spokes relay.
//
//   vectors   the add-on's interop vectors, `tests/spokes_hub_v1.json`, written by the add-on's own code
//             (`bun scripts/spokes-hub-vectors.ts <this crate>/tests/spokes_hub_v1.json` from its remote-spoke folder):
//             canonical JSON, the node key and request, request plaintexts, envelopes the add-on sealed (and each
//             verdict its `open` gave), RelayClient requests it signed, its spoke journal runs and ask digests.
//   world     the service hub end to end: a `relay::State` (the Rust spokes relay) behind an in-process mailbox, and
//             scripted spokes that speak the add-on's request and reply shapes with this crate's envelopes.

use crate::codec::{b64u, hex, now_ms, parse_json, sha256, sha256_hex, str_of, stringify, unb64u, utf16_len, utf8_lossy};
use crate::connector_seal::{FixedSource, SealedStore, Sealer, KEY_STORE_OS, KEY_STORE_TPM};
use crate::connector_spokes::{
    add_spoke_in, identity_problem, install_in, keygen_in, root_key, HubConfig, HubError, HubEvents, HubParts, HubTask, Op, Rejected, ServiceHub, Submit, SubmitError, CLIENT_BAD, ENCLAVE,
    HUB_KEYS_BAD, KEY_EXISTS, KEY_NAME, NOT_SERVICE_HUB, NO_API_RELAY, OWNER_PAUSED, ROOT_FILE, SCOPES_BAD, SPOKES_DIR, CANCEL_RETRY_MS, SEEN_FILE, TASKS_NAME, BUNDLE_FILE,
};
use crate::connector_spokes_relay::{api_relays, granted, relay_grant, ApiRelay, HttpsMailbox, Mailbox, RelayClient, PRESENCE_PAGES_MAX, PRESENCE_ROWS_MAX};
use crate::connector_spokes_wire::{
    ask_digest, audience_of, auth_string, authorization, canonical, check_code, connector_header, held_text, node_request, object_of, open, request_plaintext, seal, task_name, verify_run,
    Envelope, JournalEntry, NodeKey, OpenError, Partner, ReplayGuard, HEADER_MAX, HEADER_PREFIX, MAX_TEXT, REPLY_CAP_BYTES,
};
use crate::der::{ecdsa_verify, p256_from_spki, p256_spki_der, P256Key};
use crate::identity::{node_id_of, peek_compact, user_id_of, TrustStore};
use crate::log::{Fields, Logger};
use crate::meet_org_policy::Obj;
use crate::relay::{Dialed, Options, Request, State};
use p256::ecdsa::signature::Signer;
use p256::ecdsa::{Signature, SigningKey};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::Duration;

// ── the add-on's vectors ────────────────────────────────────────────────────────────────────────────────────

fn vectors() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/spokes_hub_v1.json");
    let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{path}: {e}; write it with `bun scripts/spokes-hub-vectors.ts {path}` from the add-on's remote-spoke folder"));
    parse_json(&text).expect("spokes_hub_v1.json is JSON")
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or_else(|| panic!("vector field {k}"))
}

fn vector_key(v: &Value, who: &str) -> NodeKey {
    let k = NodeKey::from_scalar(&unb64u(s(&v[who], "d")).unwrap()).expect("a P-256 scalar");
    assert_eq!(b64u(k.spki()), s(&v[who], "spki"), "{who}: the Rust key's SPKI is Node's");
    assert_eq!(k.node(), s(&v[who], "node"), "{who}: node id");
    k
}

fn vector_trust(v: &Value) -> TrustStore {
    let mut t = TrustStore::new(p256_from_spki(&unb64u(s(&v["root"], "spki")).unwrap()).unwrap());
    t.accept_crl(s(v, "crl")).expect("the vector CRL");
    t
}

#[test]
fn canonical_json_is_the_add_ons() {
    let v = vectors();
    for c in v["canonical"].as_array().unwrap() {
        assert_eq!(canonical(&c["value"]), s(c, "text"), "{}", c["value"]);
    }
}

#[test]
fn the_node_key_request_and_check_code_are_the_add_ons() {
    let v = vectors();
    let hub = vector_key(&v, "hub");
    vector_key(&v, "spoke");
    assert_eq!(check_code(hub.spki()), s(&v, "check_code"));
    let r = &v["request"];
    let theirs = s(r, "token");
    let mine = node_request(&hub, s(r, "label"), r["iat"].as_i64().unwrap()).unwrap();
    let (their_body, their_sig) = theirs.split_once('.').unwrap();
    let (my_body, my_sig) = mine.split_once('.').unwrap();
    assert_eq!(my_body, their_body, "the request payload is byte for byte the add-on's");
    let body = unb64u(their_body).unwrap();
    assert!(ecdsa_verify(hub.public(), &body, &unb64u(their_sig).unwrap()), "the add-on's signature verifies with the Rust key");
    assert!(ecdsa_verify(hub.public(), &body, &unb64u(my_sig).unwrap()), "the Rust signature verifies");
    let root = root_key(s(&v["root"], "pem")).unwrap();
    assert_eq!(node_id_of(&p256_spki_der(&root)), s(&v["root"], "id"));
}

#[test]
fn the_vector_hub_certificate_is_a_service_hubs_and_its_peers_are_not() {
    let v = vectors();
    let hub = vector_key(&v, "hub");
    let trust = vector_trust(&v);
    let now_s = v["now"].as_i64().unwrap() / 1000;
    let domains = vec!["acme.example".to_string()];
    let own = trust.verify_cert(Some(&v["hub"]["cert"]), now_s).unwrap().cert;
    assert_eq!(own.serial, s(&v["hub"], "serial"));
    assert_eq!(identity_problem(&own, &hub, Some(domains.as_slice())), None);
    let human = trust.verify_cert(Some(&v["certs"]["human"]), now_s).unwrap().cert;
    assert!(identity_problem(&human, &hub, Some(domains.as_slice())).is_some(), "another key's certificate");
    let elsewhere = vec!["example.org".to_string()];
    assert_eq!(identity_problem(&own, &hub, Some(elsewhere.as_slice())), Some(NOT_SERVICE_HUB.to_string()), "apps.acme.example under other org domains");
}

#[test]
fn request_plaintexts_are_the_add_ons() {
    let v = vectors();
    for p in v["plaintexts"].as_array().unwrap() {
        assert_eq!(request_plaintext(s(p, "rid"), s(p, "op"), &p["args"], p["crl"].as_str()), s(p, "text"), "{}", s(p, "op"));
    }
}

#[test]
fn envelopes_the_add_on_sealed_get_its_verdicts() {
    let v = vectors();
    let (hub, spoke) = (vector_key(&v, "hub"), vector_key(&v, "spoke"));
    let trust = vector_trust(&v);
    let mut guards: HashMap<String, ReplayGuard> = HashMap::new();
    let mut opened = 0;
    for c in v["envelopes"].as_array().unwrap() {
        let name = s(c, "name");
        let parsed = Envelope::parse(&c["env"]);
        assert_eq!(parsed.is_some(), c["parsed"].as_bool().unwrap(), "{name}: parseEnvelope");
        let Some(env) = parsed else { continue };
        assert_eq!(stringify(&env.to_json()), stringify(&c["env"]), "{name}: the envelope writes back as the add-on wrote it");
        let opener = s(c, "opener");
        let me = if opener == "hub" { &hub } else { &spoke };
        let roles: Vec<&str> = c["roles"].as_array().unwrap().iter().map(|r| r.as_str().unwrap()).collect();
        let guard = guards.entry(opener.to_owned()).or_insert_with(ReplayGuard::memory);
        let got = match open(me, &trust, &env, &roles, guard, c["now"].as_i64().unwrap()) {
            Ok(o) => {
                opened += 1;
                json!({ "ok": true, "from": o.from.node, "plaintext": o.plaintext })
            }
            Err(OpenError::Refused(reason)) => json!({ "ok": false, "reason": reason }),
            Err(OpenError::Unavailable(e)) => panic!("{name}: a memory guard is always available: {e}"),
        };
        assert_eq!(got, c["verdict"], "{name}");
    }
    assert!(opened >= 4, "the vectors open some envelopes");
}

#[test]
fn what_the_rust_side_seals_opens_with_the_add_on_construction() {
    // The add-on's envelopes open here (above), so the derivation, the header and the signed bytes are the add-on's;
    // the same functions seal, so what Rust seals opens there. Here: a Rust round trip with the vector keys.
    let v = vectors();
    let (hub, spoke) = (vector_key(&v, "hub"), vector_key(&v, "spoke"));
    let trust = vector_trust(&v);
    let now = v["now"].as_i64().unwrap();
    let text = request_plaintext("0123456789abcdef", "hello", &json!({}), None);
    let env = seal(&hub, s(&v["hub"], "cert"), spoke.node(), spoke.public(), &text, now).unwrap();
    assert!(crate::relay::parse_envelope(Some(&env.to_json())).is_some(), "the relay takes its shape");
    let mut guard = ReplayGuard::memory();
    let o = open(&spoke, &trust, &env, &["hub"], &mut guard, now + 1).unwrap();
    assert_eq!((o.from.node.as_str(), o.plaintext.as_str()), (hub.node(), text.as_str()));
    assert_eq!(open(&spoke, &trust, &env, &["hub"], &mut guard, now + 2).err().unwrap(), OpenError::Refused("envelope already opened (replay)".into()));
    let mut other = env.clone();
    other.id = "f".repeat(32);
    assert_eq!(open(&spoke, &trust, &other, &["hub"], &mut ReplayGuard::memory(), now).err().unwrap(), OpenError::Refused("envelope signature does not match the sender".into()));
}

#[test]
fn relay_requests_are_signed_as_the_add_on_signs_them() {
    let v = vectors();
    let hub = vector_key(&v, "hub");
    let cert = s(&v["hub"], "cert");
    let a = &v["auth"];
    let audience = s(a, "audience");
    assert_eq!(audience_of(s(a, "url")).as_deref(), Some(audience));
    let requests = a["requests"].as_array().unwrap();
    assert_eq!(requests.len(), 6);
    for r in requests {
        let (method, path, body) = (s(r, "method"), s(r, "path"), s(r, "body"));
        assert_eq!(r["seat"], json!("seat-token-for-the-vectors"), "{method} {path}: the seat rides along");
        let theirs = parse_json(&utf8_lossy(&unb64u(s(r, "authorization").strip_prefix("LucidNode ").unwrap()).unwrap())).unwrap();
        let keys: Vec<&String> = theirs.as_object().unwrap().keys().collect();
        assert_eq!(keys, ["cert", "ts", "nonce", "sig"], "{method} {path}: the legacy header");
        assert_eq!(s(&theirs, "cert"), cert);
        let (ts, nonce) = (theirs["ts"].as_i64().unwrap(), s(&theirs, "nonce"));
        let signed = auth_string(audience, method, path, ts, nonce, body.as_bytes(), None);
        assert!(ecdsa_verify(hub.public(), signed.as_bytes(), &unb64u(s(&theirs, "sig")).unwrap()), "{method} {path}: the add-on signed the Rust string");
        let mine = authorization(&hub, cert, false, audience, method, path, body.as_bytes(), ts, nonce).unwrap();
        let mine = parse_json(&utf8_lossy(&unb64u(mine.strip_prefix("LucidNode ").unwrap()).unwrap())).unwrap();
        assert!(ecdsa_verify(hub.public(), signed.as_bytes(), &unb64u(s(&mine, "sig")).unwrap()));
        let strip = |x: &Value| {
            let mut o = x.as_object().unwrap().clone();
            o.remove("sig");
            stringify(&Value::Object(o))
        };
        assert_eq!(strip(&mine), strip(&theirs), "{method} {path}: the same header around the signature");
        if path == "/v1/send" {
            let env = Envelope::parse(&parse_json(body).unwrap()).unwrap();
            assert_eq!(stringify(&env.to_json()), body, "a sent envelope's body is byte for byte the add-on's");
        }
    }
    let paths: Vec<&str> = requests.iter().map(|r| s(r, "path")).collect();
    assert_eq!(paths, ["/v1/send", "/v1/inbox", "/v1/ack", "/v1/presence?limit=4000", "/v1/crl", "/v1/directory"]);
    assert_eq!(s(&requests[2], "body"), stringify(&json!({ "ids": ["0123456789abcdef0123456789abcdef"] })));
}

#[test]
fn spoke_journal_runs_get_the_add_ons_verdicts() {
    let v = vectors();
    let key = p256_from_spki(&unb64u(s(&v["journal"], "spoke_spki")).unwrap()).unwrap();
    for r in v["journal"]["runs"].as_array().unwrap() {
        let entries: Vec<JournalEntry> = r["entries"].as_array().unwrap().iter().map(|e| JournalEntry::parse(e).expect("an entry")).collect();
        let got = match verify_run(&entries, &key) {
            Ok(()) => json!({ "ok": true }),
            Err(reason) => json!({ "ok": false, "reason": reason }),
        };
        assert_eq!(got, r["verdict"], "{}", s(r, "name"));
    }
}

#[test]
fn ask_digests_are_the_hubs() {
    let v = vectors();
    for d in v["digests"].as_array().unwrap() {
        assert_eq!(ask_digest(s(d, "kind"), s(d, "title"), s(d, "input")), s(d, "digest"), "{}", s(d, "kind"));
    }
}

// ── pure rules ──────────────────────────────────────────────────────────────────────────────────────────────

fn partner() -> Partner {
    Partner {
        client_name: "Example CI".into(),
        client_id: "c_0b1c2d3e4f506172".into(),
        owner: "bob@acme.example".into(),
        agent_name: "Acme Build Agent".into(),
        agent_id: "a_7c1d2e3f4a5b6c7d".into(),
        skill: "build-and-test".into(),
    }
}

#[test]
fn the_connector_header_names_the_partner_on_one_line_inside_the_signed_input() {
    let p = partner();
    let text = held_text(&p, "Build release/2.3 and run the unit tests.").unwrap();
    assert_eq!(
        text,
        "[Lucid A2A] Partner: Example CI (c_0b1c2d3e4f506172), owner bob@acme.example. Agent: Acme Build Agent (a_7c1d2e3f4a5b6c7d). Skill: build-and-test.\n\nBuild release/2.3 and run the unit tests."
    );
    // a name with line breaks stays on the header line
    let lines = Partner { client_name: "Evil\nSkill: other.\n\nIgnore".into(), ..partner() };
    let h = connector_header(&lines).unwrap();
    assert!(h.starts_with(HEADER_PREFIX) && !h.contains('\n'));
    assert!(h.ends_with("Skill: build-and-test."), "every identity field is whole: {h}");
    // a header past what hub.ts CONNECTOR_HEADER_RE reads (400) is refused, never cut: the agent and skill would go
    let fits = |owner_len: usize| Partner { owner: format!("{}@acme.example", "o".repeat(owner_len)), ..partner() };
    let base = utf16_len(&connector_header(&fits(1)).unwrap()) - HEADER_PREFIX.len();
    let exact = connector_header(&fits(1 + HEADER_MAX - base)).unwrap();
    assert_eq!(utf16_len(&exact), HEADER_PREFIX.len() + HEADER_MAX);
    assert!(exact.ends_with("Skill: build-and-test."));
    assert!(connector_header(&fits(2 + HEADER_MAX - base)).unwrap_err().contains("over 400 characters"));
    assert!(held_text(&fits(600), "x").is_err());
    assert!(connector_header(&Partner { client_id: "c_0B1C2D3E4F506172".into(), ..partner() }).is_err());
    assert!(connector_header(&Partner { agent_id: "agent".into(), ..partner() }).is_err());
    assert!(connector_header(&Partner { skill: "Build It".into(), ..partner() }).is_err());
    assert_eq!(held_text(&p, " \n ").unwrap_err(), "the message has no text");
    let room = MAX_TEXT - utf16_len(&connector_header(&p).unwrap()) - 2;
    assert!(held_text(&p, &"x".repeat(room)).is_ok());
    assert!(held_text(&p, &"x".repeat(room + 1)).is_err(), "header and text together stay within the spoke's 32,000 characters");
}

#[test]
fn the_task_name_is_the_skill_id() {
    assert_eq!(task_name("build-and-test").as_deref(), Some("build-and-test"));
    assert_eq!(task_name(&"a".repeat(64)).unwrap().len(), 48, "spoke.ts NAME_RE takes 48");
    assert_eq!(task_name("-lead"), None);
    assert_eq!(task_name(""), None);
}

#[test]
fn audiences_are_the_url_host_as_new_url_reads_it() {
    assert_eq!(audience_of("https://Relay.Example:443").as_deref(), Some("relay:relay.example"));
    assert_eq!(audience_of("https://relay.example:8443/").as_deref(), Some("relay:relay.example:8443"));
    assert_eq!(audience_of("https://[2001:DB8::1]:8443").as_deref(), Some("relay:[2001:db8::1]:8443"));
    assert_eq!(audience_of("http://127.0.0.1:8787").as_deref(), Some("relay:127.0.0.1:8787"));
    assert_eq!(audience_of("ftp://relay.example"), None);
    assert_eq!(audience_of("https://user@relay.example"), None);
}

#[test]
fn the_spokes_hub_config_key_is_exact() {
    let base = Path::new("/etc/lucid-api-connector");
    let good = json!({"client": "c_9a8b7c6d5e4f3a2b", "cert": "hub.cert", "directory": "/var/lib/relay-directory"});
    let c = HubConfig::parse(&good, base).unwrap();
    assert_eq!(c, HubConfig { client: "c_9a8b7c6d5e4f3a2b".into(), cert: base.join("hub.cert"), directory: PathBuf::from("/var/lib/relay-directory") });
    let mut extra = good.clone();
    extra["root"] = json!("root.pub");
    assert_eq!(HubConfig::parse(&extra, base).unwrap_err(), HUB_KEYS_BAD);
    let mut bad = good.clone();
    bad["client"] = json!("c_9A8B7C6D5E4F3A2B");
    assert_eq!(HubConfig::parse(&bad, base).unwrap_err(), CLIENT_BAD);
    let mut empty = good;
    empty["cert"] = json!(" ");
    assert_eq!(HubConfig::parse(&empty, base).unwrap_err(), "spokes_hub.cert must be a non-empty string");
}

#[test]
fn a_service_hub_sends_only_its_own_ops() {
    let names: Vec<&str> = [Op::Hello, Op::Status, Op::Recall, Op::Approvals, Op::Submit, Op::Followup, Op::Cancel, Op::Close, Op::Deny].iter().map(|o| o.name()).collect();
    for never in ["decide", "modelLogin", "modelFinish", "modelLogout", "modelUse", "modelKey", "custody", "standby", "handoffNote", "restore", "renew"] {
        assert!(!names.contains(&never), "{never}");
    }
}

#[test]
fn the_replay_guard_survives_a_restart() {
    let dir = temp("replay");
    let file = dir.join("seen.json");
    let mut g = ReplayGuard::persisted(file.clone());
    assert_eq!(g.admit("a", 1_000), Ok(true));
    let mut again = ReplayGuard::persisted(file);
    assert_eq!(again.admit("a", 2_000), Ok(false), "an id opened before a restart stays opened");
    assert_eq!(again.admit("a", 1_000 + 2 * 600_000 + 1), Ok(true), "until twice the clock window has passed");
}

/// Review W5b 3: an id is admitted only once the file holds it; one that cannot be written is an error, admits nothing,
/// and `forget` lets a batch that was not acknowledged open again.
#[test]
fn a_replay_guard_that_cannot_write_admits_nothing() {
    let dir = temp("replay-broken");
    let file = dir.join("seen.json");
    std::fs::create_dir_all(&file).unwrap(); // a folder where the file goes: it cannot be written
    let mut g = ReplayGuard::persisted(file.clone());
    assert!(g.admit("a", 1_000).unwrap_err().contains("could not be saved"));
    std::fs::remove_dir(&file).unwrap();
    assert_eq!(g.admit("a", 1_000), Ok(true), "nothing was admitted by the failed write");
    g.forget(&["a".to_string()]).unwrap();
    assert_eq!(g.admit("a", 1_000), Ok(true), "forgotten, it opens again");
    assert_eq!(ReplayGuard::persisted(file).admit("a", 1_000), Ok(false), "and the file holds it");
}

// ── the world: the Rust spokes relay, scripted spokes and the service hub ───────────────────────────────────

const RELAY_URL: &str = "https://relay.example.com";
/// The relay's id in the map's `spokes.relays` and the directory entry's `relay` (5.8 as amended).
const RELAY_ID: &str = "r_21";
const SERVICE_EMAIL: &str = "build-hub@apps.acme.example";
const CLIENT: &str = "c_9a8b7c6d5e4f3a2b";
const HUB_SEED: u8 = 2;

fn temp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("lucid-connector-spokes-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn compact(root: &SigningKey, payload: &Value) -> String {
    let body = stringify(payload);
    let sig: Signature = root.sign(body.as_bytes());
    format!("{}.{}", b64u(body.as_bytes()), b64u(sig.to_der().as_bytes()))
}

fn root_p256(root: &SigningKey) -> P256Key {
    root.verifying_key().into()
}

pub(crate) fn root_id(root: &SigningKey) -> String {
    node_id_of(&p256_spki_der(&root_p256(root)))
}

/// A root-signed node certificate valid around `now_s`.
#[allow(clippy::too_many_arguments)]
fn cert(root: &SigningKey, spki: &[u8], serial: u32, role: &str, scopes: &[&str], email: Option<&str>, classification: Option<&str>, now_s: i64) -> String {
    let mut p = json!({
        "v": 1, "typ": "lucid-node-cert", "serial": format!("{serial:032x}"), "root": root_id(root), "node": node_id_of(spki), "role": role,
        "label": format!("{role} {serial}"), "spki": b64u(spki), "scopes": scopes, "iat": now_s - 60, "exp": now_s + 86_400,
    });
    if let Some(e) = email {
        p["user"] = json!({ "id": user_id_of(e), "email": e });
    }
    if let Some(c) = classification {
        p["classification"] = json!(c);
    }
    compact(root, &p)
}

fn directory(root: &SigningKey, version: i64, api: bool, domains: &[&str], now_s: i64) -> String {
    let mut entry = json!({ "url": RELAY_URL, "region": "eu", "priority": 0 });
    if api {
        entry["api"] = json!(true);
        entry["relay"] = json!(RELAY_ID);
    }
    compact(root, &json!({ "v": 1, "typ": "lucid-relay-directory", "root": root_id(root), "version": version, "relays": [entry], "iat": now_s - 60, "exp": now_s + 86_400, "org_domains": domains }))
}

fn pem(spki: &[u8]) -> String {
    format!("-----BEGIN PUBLIC KEY-----\n{}\n-----END PUBLIC KEY-----\n", crate::meet_json::b64(spki))
}

type SendHook = Arc<dyn Fn(&str) + Send + Sync>;

/// The Rust spokes relay behind the mailbox trait: every request goes through `State::serve` as the relay's server
/// hands it over (dialed host `relay.example.com`). A send to a scripted spoke lets that spoke answer at once.
struct InProcess {
    state: Mutex<State>,
    clock: Arc<AtomicI64>,
    after_send: Mutex<Option<SendHook>>,
    /// Every stored send: (to, envelope id).
    sent: Mutex<Vec<(String, String)>>,
    /// With `book` set, every ack: (ids, the task ids the hub's sealed book held when the ack arrived).
    book: Mutex<Option<Arc<SealedStore>>>,
    acks: Mutex<Vec<(Vec<String>, Vec<String>)>>,
}

/// The task ids and the request records of a hub's sealed book.
fn sealed_book(sealed: &SealedStore) -> (Vec<String>, Vec<Value>) {
    let v = sealed.get(TASKS_NAME).unwrap().unwrap_or(json!({}));
    let tasks = v["tasks"].as_array().into_iter().flatten().filter_map(|t| t["id"].as_str().map(str::to_owned)).collect();
    (tasks, v["requests"].as_array().cloned().unwrap_or_default())
}

impl Mailbox for InProcess {
    fn url(&self) -> &str {
        RELAY_URL
    }

    fn exchange(&self, method: &str, path: &str, headers: &[(&'static str, String)], body: Option<&[u8]>) -> Result<(u16, Vec<u8>), String> {
        let header = |name: &str| headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.clone());
        let authorization = header("authorization").unwrap_or_default();
        let seat = header(crate::license::SEAT_HEADER);
        let text = String::from_utf8(body.unwrap_or_default().to_vec()).map_err(|_| "not UTF-8".to_string())?;
        let dialed = Dialed { host: "relay.example.com".into(), hostname: "relay.example.com".into(), port: 443 };
        let where_ = Fields::new();
        let pathname = path.split('?').next().unwrap_or(path);
        let r = Request { method, pathname, path, authorization: &authorization, seat: seat.as_deref(), dialed: &dialed, body: &text, where_: &where_ };
        if method == "POST" && pathname == "/v1/ack" {
            let book = self.book.lock().clone();
            if let Some(sealed) = book {
                let ids = parse_json(&text).and_then(|v| v["ids"].as_array().map(|a| a.iter().filter_map(|i| i.as_str().map(str::to_owned)).collect())).unwrap_or_default();
                self.acks.lock().push((ids, sealed_book(&sealed).0));
            }
        }
        let reply = self.state.lock().serve(&r, self.clock.load(Ordering::SeqCst), true)?;
        if method == "POST" && pathname == "/v1/send" && reply.status == 200 {
            let parsed = parse_json(&text);
            let to = parsed.as_ref().and_then(|v| str_of(v.get("to")).map(str::to_owned)).unwrap_or_default();
            let id = parsed.as_ref().and_then(|v| str_of(v.get("id")).map(str::to_owned)).unwrap_or_default();
            self.sent.lock().push((to.clone(), id));
            let hook = self.after_send.lock().clone();
            if let Some(h) = hook {
                h(&to);
            }
        }
        Ok((reply.status, reply.body.into_bytes()))
    }
}

/// A scripted spoke: it opens the hub's sealed requests and answers them with spoke.ts's reply and note shapes
/// (held submits, own-task checks, a signed journal), through the same relay.
pub(crate) struct FakeSpoke {
    key: Arc<NodeKey>,
    cert: String,
    pub(crate) node: String,
    trust: TrustStore,
    client: RelayClient,
    clock: Arc<AtomicI64>,
    pub(crate) st: Mutex<SpokeState>,
}

pub(crate) struct SpokeState {
    replay: ReplayGuard,
    hubs: HashMap<String, P256Key>,
    pub(crate) tasks: BTreeMap<String, Value>,
    pub(crate) journal: Vec<JournalEntry>,
    ops: Vec<(String, Value)>,
    pub(crate) refuse: Option<String>,
    hold: bool,
    held: Vec<(String, String, String, Value)>,
    tamper: bool,
    next: u64,
    /// Cancels refused before the spoke takes one.
    fail_cancels: u32,
}

impl FakeSpoke {
    fn now(&self) -> i64 {
        self.clock.load(Ordering::SeqCst)
    }

    pub(crate) fn append(&self, st: &mut SpokeState, task: &str, kind: &str, data: Value) {
        let (seq, ts) = (st.journal.len() as i64 + 1, self.now());
        let prev = st.journal.last().map(|e| e.hash.clone()).unwrap_or_else(|| "0".repeat(64));
        let digest = sha256(canonical(&json!({ "seq": seq, "ts": ts, "task": task, "kind": kind, "data": data, "prev": prev })).as_bytes());
        st.journal.push(JournalEntry { seq, ts, task: task.into(), kind: kind.into(), data: data.as_object().unwrap().clone(), prev, hash: hex(&digest), sig: b64u(&self.key.sign(&digest).unwrap()) });
    }

    pub(crate) fn send_to(&self, st: &SpokeState, hub: &str, body: &Value) {
        let key = st.hubs.get(hub).expect("a hub this spoke heard");
        let env = seal(&self.key, &self.cert, hub, key, &stringify(body), self.now()).unwrap();
        self.client.send(&env, self.now()).unwrap();
    }

    /// Collect, answer (or hold) and acknowledge.
    pub(crate) fn poll(&self) {
        let now = self.now();
        let (envs, _) = self.client.inbox(now).expect("the spoke's inbox");
        let mut st = self.st.lock();
        for env in &envs {
            let o = open(&self.key, &self.trust, env, &["hub"], &mut st.replay, now).expect("the spoke opens the hub's request");
            st.hubs.insert(o.from.node.clone(), o.from_key.clone());
            let m = object_of(&o.plaintext).unwrap();
            assert_eq!(str_of(m.get("t")), Some("req"));
            let (rid, op, args) = (str_of(m.get("rid")).unwrap().to_owned(), str_of(m.get("op")).unwrap().to_owned(), m.get("args").cloned().unwrap_or(json!({})));
            assert!(rid.len() == 16 && rid.bytes().all(|c| c.is_ascii_hexdigit()), "spoke.ts takes a 16 hex rid");
            st.ops.push((op.clone(), args.clone()));
            if st.hold {
                st.held.push((o.from.node.clone(), rid, op, args));
                continue;
            }
            self.answer_one(&mut st, &o.from.node, &rid, &op, &args);
        }
        let ids: Vec<String> = envs.iter().map(|e| e.id.clone()).collect();
        drop(st);
        self.client.ack(&ids, now).unwrap();
    }

    /// The held requests answered now.
    fn release(&self) {
        let mut st = self.st.lock();
        st.hold = false;
        for (hub, rid, op, args) in std::mem::take(&mut st.held) {
            self.answer_one(&mut st, &hub, &rid, &op, &args);
        }
    }

    fn answer_one(&self, st: &mut SpokeState, hub: &str, rid: &str, op: &str, args: &Value) {
        let (reply, notes) = self.answer(st, hub, op, args);
        let mut res = json!({ "t": "res", "rid": rid });
        for (k, v) in reply.as_object().unwrap() {
            res[k] = v.clone();
        }
        self.send_to(st, hub, &res);
        for n in notes {
            self.send_to(st, hub, &n);
        }
    }

    fn public(t: &Value) -> Value {
        let mut p = json!({ "id": t["id"], "name": t["name"], "state": t["state"], "origin": t["origin"], "createdAt": t["createdAt"], "updatedAt": t["updatedAt"], "turns": t["turns"] });
        for k in ["awaiting", "reason"] {
            if !t[k].is_null() {
                p[k] = t[k].clone();
            }
        }
        p
    }

    fn approval(&self, t: &Value, kind: &str, ask: &str, input: &str, within_s: i64) -> Value {
        let name = s(t, "name");
        json!({ "t": "approval", "task": t["id"], "name": name, "lane": format!("held:{}", s(t, "id")), "ask": {
            "id": ask, "kind": kind, "title": name, "input": input, "tier": "task", "reason": format!("submitted by hub ({SERVICE_EMAIL})"),
            "digest": ask_digest(kind, name, input), "openedAt": self.now(), "expiresAt": self.now() + within_s * 1000,
        }})
    }

    /// spoke.ts `#run` for the ops a service hub sends: (`{ok, data}` or `{ok: false, error}`, notes to send after).
    fn answer(&self, st: &mut SpokeState, hub: &str, op: &str, args: &Value) -> (Value, Vec<Value>) {
        let err = |e: &str| (json!({ "ok": false, "error": e }), Vec::new());
        let ok = |d: Value| (json!({ "ok": true, "data": d }), Vec::new());
        let named = args.get("task").and_then(Value::as_str).map(str::to_owned);
        if let Some(t) = &named {
            if st.tasks.get(t).is_none_or(|x| x["origin"] != json!(hub)) {
                return err("unknown task");
            }
        }
        let now = self.now();
        match op {
            "hello" => {
                let tasks: Vec<Value> = st.tasks.values().filter(|t| t["origin"] == json!(hub)).map(Self::public).collect();
                ok(json!({ "node": self.node, "journalHead": st.journal.len(), "tasks": tasks }))
            }
            "submit" => {
                if let Some(e) = &st.refuse {
                    return err(&e.clone());
                }
                st.next += 1;
                let (id, ask) = (format!("t_{:016x}", st.next), format!("s_{:016x}", st.next));
                let (name, text, within) = (s(args, "name").to_owned(), s(args, "text").to_owned(), args["hold"]["within_s"].as_i64().unwrap());
                let t = json!({ "id": id, "name": name, "origin": hub, "state": "awaiting_approval", "awaiting": "task.start", "createdAt": now, "updatedAt": now, "turns": 0 });
                self.append(st, &id, "task.created", json!({ "origin": hub, "name": name, "held": true, "holdS": within }));
                self.append(st, &id, "approval.requested", json!({ "ask": ask, "kind": "task.start", "title": name, "inputSha256": sha256_hex(text.as_bytes()), "chars": utf16_len(&text) }));
                let note = self.approval(&t, "task.start", &ask, &text, within);
                st.tasks.insert(id.clone(), t);
                (json!({ "ok": true, "data": { "task": id, "state": "awaiting_approval", "awaiting": "task.start", "ask": ask } }), vec![note])
            }
            "followup" => {
                let id = named.unwrap();
                let t = st.tasks.get(&id).unwrap().clone();
                if t["state"] != json!("idle") {
                    return err("wait until the current step ends");
                }
                st.next += 1;
                let ask = format!("u_{:016x}", st.next);
                let text = s(args, "text").to_owned();
                let mut t2 = t.clone();
                t2["state"] = json!("awaiting_approval");
                t2["awaiting"] = json!("task.turn");
                let note = self.approval(&t2, "task.turn", &ask, &text, 3600);
                st.tasks.insert(id.clone(), t2);
                (json!({ "ok": true, "data": { "task": id, "state": "awaiting_approval", "awaiting": "task.turn", "ask": ask } }), vec![note])
            }
            "cancel" if st.fail_cancels > 0 => {
                st.fail_cancels -= 1;
                err("the engine refused the cancel: busy")
            }
            "cancel" | "close" => {
                let id = named.unwrap();
                let t = st.tasks.get_mut(&id).unwrap();
                let held = t["awaiting"] == json!("task.start") || t["awaiting"] == json!("task.turn");
                t["state"] = json!("closed");
                t["awaiting"] = Value::Null;
                let mut data = json!({ "task": id, "state": "closed" });
                if op == "cancel" && held {
                    t["reason"] = json!("canceled");
                    data["reason"] = json!("canceled");
                }
                ok(data)
            }
            "status" => {
                let id = named.unwrap();
                ok(json!({ "journalHead": st.journal.len(), "tasks": [Self::public(&st.tasks[&id])] }))
            }
            "recall" => {
                let id = named.unwrap();
                let since = args["since"].as_i64().unwrap();
                let mut entries: Vec<Value> = st
                    .journal
                    .iter()
                    .filter(|e| e.task == id && e.seq > since)
                    .map(|e| json!({ "seq": e.seq, "ts": e.ts, "task": e.task, "kind": e.kind, "data": e.data, "prev": e.prev, "hash": e.hash, "sig": e.sig }))
                    .collect();
                if st.tamper {
                    if let Some(e) = entries.iter_mut().find(|e| e["kind"] == json!("task.turn")) {
                        e["data"]["text"] = json!("a different result");
                    }
                }
                ok(json!({ "entries": entries, "head": st.journal.len(), "more": false }))
            }
            "approvals" => ok(json!({ "approvals": [] })),
            "deny" => {
                let id = named.unwrap();
                let t = st.tasks.get_mut(&id).unwrap();
                t["state"] = json!("closed");
                t["reason"] = json!("denied");
                ok(json!({ "task": id, "allow": false, "state": "closed" }))
            }
            other => err(&format!("unknown op {other}")),
        }
    }

    /// A person approved and the turn ran: the task is idle with its turn journaled, and the origin hears a note.
    pub(crate) fn finish_turn(&self, task: &str, text: &str) {
        let mut st = self.st.lock();
        let turns = st.tasks[task]["turns"].as_i64().unwrap();
        self.append(&mut st, task, "task.turn", json!({ "index": turns, "text": text }));
        let head = st.journal.len();
        let t = st.tasks.get_mut(task).unwrap();
        t["state"] = json!("idle");
        t["awaiting"] = Value::Null;
        t["turns"] = json!(turns + 1);
        let (origin, name) = (s(t, "origin").to_owned(), s(t, "name").to_owned());
        let note = json!({ "t": "note", "task": task, "name": name, "state": "idle", "journalHead": head });
        self.send_to(&st, &origin, &note);
    }

    pub(crate) fn ops(&self) -> Vec<String> {
        self.st.lock().ops.iter().map(|(op, _)| op.clone()).collect()
    }

    pub(crate) fn last_args(&self) -> Value {
        self.st.lock().ops.last().map(|(_, a)| a.clone()).unwrap()
    }
}

#[derive(Default)]
struct Recorder {
    seen: Mutex<Vec<String>>,
}

impl HubEvents for Recorder {
    fn task_changed(&self, t: &HubTask) {
        self.seen.lock().push(format!("changed {} {}", t.id, t.state));
    }

    fn approval_asked(&self, t: &HubTask, ask: &Value) {
        self.seen.lock().push(format!("asked {} {}", t.id, ask["kind"].as_str().unwrap_or("?")));
    }
}

pub(crate) struct World {
    dir: PathBuf,
    pub(crate) root: SigningKey,
    now_s: i64,
    pub(crate) clock: Arc<AtomicI64>,
    mailbox: Arc<InProcess>,
    hub_key: NodeKey,
    hub_cert: String,
    sealed: Arc<SealedStore>,
    pub(crate) spokes: Vec<Arc<FakeSpoke>>,
    map: Arc<Mutex<Option<Obj>>>,
    events: Arc<Recorder>,
}

impl World {
    /// A relay holding an older directory without the org's domain (so it serves the hub like a human hub; the 5.3
    /// service hub checks are slice 1d1's tests), the connector's newer directory marking it `api`, a service hub and
    /// the spokes given (seed, classification), each with its certificate on the connector.
    pub(crate) fn new(name: &str, spokes: &[(u8, &'static str)]) -> World {
        let dir = temp(name);
        let root = SigningKey::from_slice(&[1u8; 32]).unwrap();
        let now_ms_rounded = now_ms() / 1000 * 1000;
        let now_s = now_ms_rounded / 1000;
        let clock = Arc::new(AtomicI64::new(now_ms_rounded));
        std::fs::write(dir.join("relay-directory"), directory(&root, 1, false, &["example.org"], now_s)).unwrap();
        let opts = Options {
            root: root_p256(&root),
            owner: None,
            license: None,
            crl_file: None,
            store: None,
            seen_file: None,
            directory_file: Some(dir.join("relay-directory")),
            users_file: None,
            store_bytes: crate::relay::STORE_BYTES,
            sender_bytes: crate::relay::SENDER_BYTES,
            cert_store_bytes: crate::relay::CERT_STORE_BYTES,
            cert_dir: None,
            console: None,
            state_dir: None,
            license_file: None,
        };
        let state = State::new(opts, Arc::new(Logger::capture("relay", Box::new(|_, _| {})))).unwrap();
        let mailbox = Arc::new(InProcess {
            state: Mutex::new(state),
            clock: clock.clone(),
            after_send: Mutex::new(None),
            sent: Mutex::new(Vec::new()),
            book: Mutex::new(None),
            acks: Mutex::new(Vec::new()),
        });
        let hub_key = NodeKey::from_scalar(&[HUB_SEED; 32]).unwrap();
        let hub_cert = cert(&root, hub_key.spki(), u32::from(HUB_SEED), "hub", &["drive", "recall"], Some(SERVICE_EMAIL), None, now_s);
        let hub_dir = dir.join("hub");
        let sealed = Arc::new(SealedStore::open(Sealer::from_source(&FixedSource([9; 32])).unwrap(), hub_dir.clone()).unwrap());
        sealed.put_bytes(KEY_NAME, &[HUB_SEED; 32]).unwrap();
        std::fs::write(hub_dir.join(ROOT_FILE), pem(&p256_spki_der(&root_p256(&root)))).unwrap();
        std::fs::write(dir.join("hub.cert"), &hub_cert).unwrap();
        std::fs::write(dir.join("directory"), directory(&root, 2, true, &["acme.example"], now_s)).unwrap();
        std::fs::create_dir_all(hub_dir.join(SPOKES_DIR)).unwrap();
        let mut made = Vec::new();
        for (seed, class) in spokes {
            let key = Arc::new(NodeKey::from_scalar(&[*seed; 32]).unwrap());
            let token = cert(&root, key.spki(), u32::from(*seed), "spoke", &[], None, Some(*class), now_s);
            std::fs::write(hub_dir.join(SPOKES_DIR).join(format!("{}.cert", key.node())), &token).unwrap();
            let client = RelayClient::new(mailbox.clone(), key.clone(), &token, None).unwrap();
            let st = SpokeState { replay: ReplayGuard::memory(), hubs: HashMap::new(), tasks: BTreeMap::new(), journal: Vec::new(), ops: Vec::new(), refuse: None, hold: false, held: Vec::new(), tamper: false, next: 0, fail_cancels: 0 };
            made.push(Arc::new(FakeSpoke { node: key.node().to_owned(), key, cert: token, trust: TrustStore::new(root_p256(&root)), client, clock: clock.clone(), st: Mutex::new(st) }));
        }
        let hook_spokes = made.clone();
        let hook: SendHook = Arc::new(move |to: &str| {
            for s in hook_spokes.iter().filter(|s| s.node == to) {
                s.poll();
            }
        });
        *mailbox.after_send.lock() = Some(hook);
        let w = World { dir, root, now_s, clock, mailbox, hub_key, hub_cert, sealed, spokes: made, map: Arc::new(Mutex::new(None)), events: Arc::new(Recorder::default()) };
        w.register(json!(["*"]));
        w
    }

    /// The pinned map registering the hub's certificate for `targets`, granted every spokes relay of the map (`*`).
    pub(crate) fn register(&self, targets: Value) {
        let serial = format!("{:032x}", HUB_SEED);
        self.set_map(json!({
            "spokes": { "root": root_id(&self.root), "root_spki": sha256_hex(&p256_spki_der(&root_p256(&self.root))), "relays": [RELAY_ID] },
            "clients": [{ "id": CLIENT, "kind": "spokes_hub", "state": "active", "relays": ["*"], "spokes": { "targets": targets },
                          "credentials": [{ "type": "spokes_node", "node": self.hub_key.node(), "serial": serial, "spki": sha256_hex(self.hub_key.spki()), "key_store": "os_store" }] }],
        }));
    }

    fn set_map(&self, map: Value) {
        *self.map.lock() = map.as_object().cloned();
    }

    pub(crate) fn parts(&self, key_store: &'static str, timeout: Duration) -> HubParts {
        let mailbox = self.mailbox.clone();
        let map = self.map.clone();
        let clock = self.clock.clone();
        HubParts {
            org: "acme".into(),
            client: CLIENT.into(),
            key_store,
            dir: self.dir.join("hub"),
            cert_file: self.dir.join("hub.cert"),
            directory_file: self.dir.join("directory"),
            sealed: self.sealed.clone(),
            enclave: false,
            clock: Arc::new(move || clock.load(Ordering::SeqCst)),
            mailbox: Arc::new(move |_: &ApiRelay| Ok::<Arc<dyn Mailbox>, String>(mailbox.clone())),
            pinned: Arc::new(move || map.lock().clone()),
            request_timeout: timeout,
        }
    }

    fn hub(&self) -> Arc<ServiceHub> {
        self.hub_with(KEY_STORE_OS)
    }

    fn hub_with(&self, key_store: &'static str) -> Arc<ServiceHub> {
        let h = ServiceHub::open(self.parts(key_store, Duration::from_secs(5))).expect("the service hub opens");
        h.set_events(self.events.clone());
        h
    }

    /// Every spoke collects once, so the relay knows it (presence, and mail may be left for it).
    pub(crate) fn spokes_poll(&self) {
        for s in &self.spokes {
            s.poll();
        }
    }

    fn submit(&self, targets: &[&Arc<FakeSpoke>], text: &str) -> Submit {
        Submit { targets: targets.iter().map(|s| s.node.clone()).collect(), name: task_name("build-and-test").unwrap(), text: held_text(&partner(), text).unwrap(), within_s: 3600, model: None }
    }

    /// A signed `POST` to the relay by the first spoke (a CRL or a directory, which the relay takes from any node).
    fn post(&self, path: &str, body: &Value) -> u16 {
        let s = &self.spokes[0];
        let text = stringify(body);
        let now = self.clock.load(Ordering::SeqCst);
        let nonce = crate::connector_spokes_wire::random_hex(16).unwrap();
        let auth = authorization(&s.key, &s.cert, false, "relay:relay.example.com", "POST", path, text.as_bytes(), now, &nonce).unwrap();
        self.mailbox.exchange("POST", path, &[("Authorization", auth), ("Content-Type", "application/json".into())], Some(text.as_bytes())).unwrap().0
    }

    fn crl_revoking(&self, version: i64, serial: u32) -> String {
        compact(&self.root, &json!({ "v": 1, "typ": "lucid-crl", "root": root_id(&self.root), "version": version, "serials": [format!("{serial:032x}")], "iat": self.now_s - 60 }))
    }
}

#[test]
fn a_held_submit_reaches_the_first_present_spoke_through_the_api_relay_and_its_ask_comes_back() {
    let w = World::new("submit", &[(4, "private"), (5, "private")]);
    // only the second spoke has polled the relay: the first is not present
    w.spokes[1].poll();
    let hub = w.hub();
    let sub = w.submit(&[&w.spokes[0], &w.spokes[1]], "Build release/2.3 and run the unit tests.");
    let t = hub.submit(&sub).unwrap();
    assert_eq!((t.spoke.as_str(), t.state.as_str(), t.awaiting.as_deref(), t.name.as_str()), (w.spokes[1].node.as_str(), "awaiting_approval", Some("task.start"), "build-and-test"));
    assert!(w.spokes[0].ops().is_empty(), "the absent spoke was sent nothing");
    assert_eq!(w.spokes[1].ops(), ["submit"]);
    assert_eq!(w.spokes[1].last_args(), json!({ "text": sub.text, "name": "build-and-test", "hold": { "within_s": 3600 } }), "held, named by the skill, the header inside the text");
    assert!(sub.text.starts_with("[Lucid A2A] Partner: Example CI (c_0b1c2d3e4f506172), owner bob@acme.example. Agent: Acme Build Agent (a_7c1d2e3f4a5b6c7d). Skill: build-and-test.\n\n"));
    // the spoke's approval note (in the reply's batch): the ask kept without its text, digest over the signed input
    hub.poll_once();
    let t = hub.task(&t.id).unwrap();
    let ask = t.ask.clone().expect("the pending ask");
    assert_eq!((ask.kind.as_str(), ask.digest.clone()), ("task.start", ask_digest("task.start", "build-and-test", &sub.text)));
    assert!(w.events.seen.lock().iter().any(|e| e == &format!("asked {} task.start", t.id)));
    // the book is sealed: a restarted hub has the task
    drop(hub);
    assert_eq!(w.hub().task(&t.id), Some(t));
}

#[test]
fn only_its_own_tasks_are_named_and_a_waiting_task_takes_no_follow_up() {
    let w = World::new("own", &[(4, "private")]);
    w.spokes_poll();
    let hub = w.hub();
    let spoke = &w.spokes[0];
    let t = hub.submit(&w.submit(&[spoke], "Build it.")).unwrap();
    hub.poll_once();
    let other = "t_00000000000000ff";
    assert_eq!(hub.followup(other, "x").unwrap_err(), HubError::NotOwn);
    assert_eq!(hub.cancel(other).unwrap_err(), HubError::NotOwn);
    assert_eq!(hub.close(other).unwrap_err(), HubError::NotOwn);
    assert_eq!(hub.deny(other, "s_0000000000000001").unwrap_err(), HubError::NotOwn);
    assert_eq!(hub.recall(other, 0).unwrap_err(), HubError::NotOwn);
    assert_eq!(hub.approvals(other).unwrap_err(), HubError::NotOwn);
    assert_eq!(hub.status(other).unwrap_err(), HubError::NotOwn);
    assert_eq!(hub.followup(&t.id, "and also this").unwrap_err(), HubError::Busy, "while the start waits (R6-3)");
    assert_eq!(spoke.ops(), ["submit"], "nothing was sent for any of them");
    // approved, the turn ran: the note makes the task idle, and a follow-up becomes a held task.turn
    spoke.finish_turn(&t.id, "Built and all 12 tests pass.");
    hub.poll_once();
    assert_eq!(hub.task(&t.id).unwrap().state, "idle");
    let header = held_text(&partner(), "Run them again.").unwrap();
    let t2 = hub.followup(&t.id, &header).unwrap();
    assert_eq!((t2.state.as_str(), t2.awaiting.as_deref()), ("awaiting_approval", Some("task.turn")));
    assert_eq!(spoke.last_args(), json!({ "task": t.id, "text": header }));
    // its journal, verified against the spoke's certified key
    let page = hub.recall(&t.id, 0).unwrap();
    assert!(page.entries.iter().any(|e| e.kind == "task.turn" && e.data["text"] == json!("Built and all 12 tests pass.")));
    assert!(page.entries.iter().all(|e| e.task == t.id));
    spoke.st.lock().tamper = true;
    match hub.recall(&t.id, 0).unwrap_err() {
        HubError::Refused(m) => assert!(m.contains("failed verification"), "{m}"),
        e => panic!("{e:?}"),
    }
    let closed = hub.cancel(&t.id).unwrap();
    assert_eq!((closed.state.as_str(), closed.reason.as_deref()), ("closed", Some("canceled")));
    assert_eq!(spoke.ops(), ["submit", "followup", "recall", "recall", "cancel"]);
}

#[test]
fn the_spoke_class_and_the_key_store_choose_the_spoke() {
    let w = World::new("class", &[(4, "cui"), (5, "private")]);
    w.spokes_poll();
    let hub = w.hub();
    assert_eq!(hub.spoke_class(&w.spokes[0].node), Some("cui"));
    assert_eq!(hub.spoke_class(&w.spokes[1].node), Some("confidential"));
    // cui work needs a hardware key store (2.2): an os_store hub skips the cui spoke
    assert_eq!(hub.submit(&w.submit(&[&w.spokes[0]], "x")).unwrap_err(), SubmitError::Rejected(Rejected::NoSpoke));
    assert!(w.spokes[0].ops().is_empty());
    let t = w.hub_with(KEY_STORE_TPM).submit(&w.submit(&[&w.spokes[0], &w.spokes[1]], "x")).unwrap();
    assert_eq!(t.spoke, w.spokes[0].node, "a tpm key reaches cui");
    // a target the pinned map does not register for the client is never chosen
    w.register(json!([w.spokes[0].node]));
    assert_eq!(hub.submit(&w.submit(&[&w.spokes[1]], "x")).unwrap_err(), SubmitError::Rejected(Rejected::NoSpoke));
    assert_eq!(w.spokes[1].ops(), Vec::<String>::new());
}

#[test]
fn a_refusing_spoke_gives_a_fixed_lucid_sentence() {
    let w = World::new("refuse", &[(4, "private")]);
    w.spokes_poll();
    let hub = w.hub();
    w.spokes[0].st.lock().refuse = Some(OWNER_PAUSED.into());
    assert_eq!(hub.submit(&w.submit(&[&w.spokes[0]], "x")).unwrap_err(), SubmitError::Rejected(Rejected::Paused));
    w.spokes[0].st.lock().refuse = Some("engine refused the lane: no free lane".into());
    assert_eq!(hub.submit(&w.submit(&[&w.spokes[0]], "x")).unwrap_err(), SubmitError::Rejected(Rejected::CannotRun));
    assert!(hub.tasks().is_empty());
}

#[test]
fn a_submit_answered_after_its_wait_is_canceled_on_arrival() {
    let w = World::new("late", &[(4, "private")]);
    w.spokes_poll();
    let hub = ServiceHub::open(w.parts(KEY_STORE_OS, Duration::from_millis(300))).unwrap();
    w.spokes[0].st.lock().hold = true;
    assert_eq!(hub.submit(&w.submit(&[&w.spokes[0]], "x")).unwrap_err(), SubmitError::Rejected(Rejected::NoSpoke));
    w.spokes[0].release();
    hub.poll_once();
    let st = w.spokes[0].st.lock();
    let (id, t) = st.tasks.iter().next().expect("the late task");
    assert_eq!((t["state"].clone(), t["reason"].clone()), (json!("closed"), json!("canceled")), "{id}");
    assert_eq!(st.ops.iter().map(|(o, _)| o.as_str()).collect::<Vec<_>>(), ["submit", "cancel"]);
    drop(st);
    assert!(hub.tasks().is_empty(), "the hub tracks no task it did not get in time");
}

#[test]
fn the_pinned_map_must_register_this_certificate_under_this_root() {
    let w = World::new("map", &[(4, "private")]);
    w.spokes_poll();
    let hub = w.hub();
    let unavailable = |e: SubmitError| match e {
        SubmitError::Hub(HubError::Unavailable(m)) => m,
        e => panic!("{e:?}"),
    };
    *w.map.lock() = None;
    assert!(unavailable(hub.submit(&w.submit(&[&w.spokes[0]], "x")).unwrap_err()).contains("no pinned API map"));
    w.register(json!(["*"]));
    let mut m = Value::Object(w.map.lock().clone().unwrap());
    m["clients"][0]["credentials"][0]["serial"] = json!("ff".repeat(16));
    w.set_map(m.clone());
    assert!(unavailable(hub.submit(&w.submit(&[&w.spokes[0]], "x")).unwrap_err()).contains("does not register this service hub's certificate"));
    w.register(json!(["*"]));
    let mut m = Value::Object(w.map.lock().clone().unwrap());
    m["spokes"]["root_spki"] = json!("00".repeat(32));
    w.set_map(m);
    assert!(unavailable(hub.submit(&w.submit(&[&w.spokes[0]], "x")).unwrap_err()).contains("root"));
    w.register(json!(["*"]));
    let mut m = Value::Object(w.map.lock().clone().unwrap());
    m["clients"][0]["state"] = json!("suspended");
    w.set_map(m);
    assert!(unavailable(hub.submit(&w.submit(&[&w.spokes[0]], "x")).unwrap_err()).contains("not an active spokes_hub client"));
    assert!(w.spokes[0].ops().is_empty());
}

#[test]
fn the_hub_opens_only_outside_an_enclave_with_an_api_relay_and_a_service_hub_certificate() {
    let w = World::new("open", &[(4, "private")]);
    let mut p = w.parts(KEY_STORE_OS, Duration::from_secs(1));
    p.enclave = true;
    assert_eq!(ServiceHub::open(p).err().unwrap(), ENCLAVE);
    // rule M: a directory that marks no relay `api`
    std::fs::write(w.dir.join("directory"), directory(&w.root, 3, false, &["acme.example"], w.now_s)).unwrap();
    assert_eq!(ServiceHub::open(w.parts(KEY_STORE_OS, Duration::from_secs(1))).err().unwrap(), NO_API_RELAY);
    std::fs::write(w.dir.join("directory"), directory(&w.root, 4, true, &["acme.example"], w.now_s)).unwrap();
    // a person's email, an approve scope: not this connector's certificate
    std::fs::write(w.dir.join("hub.cert"), cert(&w.root, w.hub_key.spki(), 3, "hub", &["drive", "recall"], Some("ann@acme.example"), None, w.now_s)).unwrap();
    assert_eq!(ServiceHub::open(w.parts(KEY_STORE_OS, Duration::from_secs(1))).err().unwrap(), NOT_SERVICE_HUB);
    std::fs::write(w.dir.join("hub.cert"), cert(&w.root, w.hub_key.spki(), 3, "hub", &["approve", "drive", "recall"], Some(SERVICE_EMAIL), None, w.now_s)).unwrap();
    assert_eq!(ServiceHub::open(w.parts(KEY_STORE_OS, Duration::from_secs(1))).err().unwrap(), SCOPES_BAD);
    std::fs::write(w.dir.join("hub.cert"), &w.hub_cert).unwrap();
    assert!(ServiceHub::open(w.parts(KEY_STORE_OS, Duration::from_secs(1))).is_ok());
}

#[test]
fn spokes_without_a_certificate_here_are_dropped_and_acknowledged() {
    let w = World::new("unknown", &[(4, "private"), (6, "private")]);
    w.spokes_poll();
    // the second spoke's certificate leaves the connector before the hub opens
    std::fs::remove_file(w.dir.join("hub").join(SPOKES_DIR).join(format!("{}.cert", w.spokes[1].node))).unwrap();
    let hub = w.hub();
    let t = hub.submit(&w.submit(&[&w.spokes[0]], "x")).unwrap();
    hub.poll_once();
    {
        // the unknown spoke learned the hub's key from no request; seal to it directly
        let stranger = &w.spokes[1];
        let mut st = stranger.st.lock();
        st.hubs.insert(w.hub_key.node().to_owned(), w.hub_key.public().clone());
        let note = json!({ "t": "note", "task": t.id, "name": "x", "state": "closed", "journalHead": 1 });
        stranger.send_to(&st, w.hub_key.node(), &note);
    }
    assert_eq!(hub.poll_once(), 1, "taken (and acknowledged)");
    assert_eq!(hub.poll_once(), 0, "it does not come back");
    assert_eq!(hub.task(&t.id).unwrap().state, "awaiting_approval", "a stranger's note changes nothing");
}

#[test]
fn keygen_install_and_add_spoke_check_what_they_keep() {
    let w = World::new("cli", &[(4, "private")]);
    let dir = temp("cli-hub");
    let sealed = SealedStore::open(Sealer::from_source(&FixedSource([3; 32])).unwrap(), dir.clone()).unwrap();
    let hub_cfg = HubConfig { client: CLIENT.into(), cert: dir.join("hub.cert"), directory: w.dir.join("directory") };
    let k = keygen_in(&dir, &sealed, KEY_STORE_OS, &hub_cfg.cert, "connector k_7a1b2c3d4e5f6a7b", w.now_s).unwrap();
    let request = std::fs::read_to_string(&k.request).unwrap();
    let payload = peek_compact(request.trim()).unwrap();
    assert_eq!(Value::Object(payload.clone()), json!({ "v": 1, "typ": "lucid-node-request", "role": "hub", "label": "connector k_7a1b2c3d4e5f6a7b", "spki": payload["spki"], "iat": w.now_s }));
    let spki = unb64u(str_of(payload.get("spki")).unwrap()).unwrap();
    assert_eq!(node_id_of(&spki), k.node);
    assert_eq!(k.check_code, check_code(&spki));
    let (body, sig) = request.trim().split_once('.').unwrap();
    assert!(ecdsa_verify(&p256_from_spki(&spki).unwrap(), &unb64u(body).unwrap(), &unb64u(sig).unwrap()), "signed by the key it names");
    // a second keygen before the certificate keeps the key
    assert_eq!(keygen_in(&dir, &sealed, KEY_STORE_OS, &hub_cfg.cert, "connector k_7a1b2c3d4e5f6a7b", w.now_s).unwrap().node, k.node);
    let root_file = w.dir.join("root.pub");
    std::fs::write(&root_file, pem(&p256_spki_der(&root_p256(&w.root)))).unwrap();
    let root_pub = Some(root_file.as_path());
    let human = cert(&w.root, &spki, 7, "hub", &["drive", "recall"], Some("ann@acme.example"), None, w.now_s);
    assert_eq!(install_in(&dir, &sealed, &hub_cfg, &human, root_pub, None, w.now_s).unwrap_err(), NOT_SERVICE_HUB);
    assert!(install_in(&dir, &sealed, &hub_cfg, &w.hub_cert, root_pub, None, w.now_s).unwrap_err().contains("not this host's service hub key"));
    let good = cert(&w.root, &spki, 8, "hub", &["drive", "recall"], Some(SERVICE_EMAIL), None, w.now_s);
    let cert_file = dir.join("issued.cert");
    std::fs::write(&cert_file, format!("{good}\n")).unwrap();
    let seat = dir.join("seat.txt");
    std::fs::write(&seat, "seat-token\n").unwrap();
    let c = install_in(&dir, &sealed, &hub_cfg, cert_file.to_str().unwrap(), root_pub, Some(seat.as_path()), w.now_s).unwrap();
    assert_eq!(c.node, k.node);
    assert_eq!(std::fs::read_to_string(&hub_cfg.cert).unwrap().trim(), good);
    assert_eq!(std::fs::read_to_string(dir.join(crate::connector_spokes::SEAT_FILE)).unwrap().trim(), "seat-token");
    assert!(dir.join(ROOT_FILE).is_file());
    assert_eq!(keygen_in(&dir, &sealed, KEY_STORE_OS, &hub_cfg.cert, "connector k_7a1b2c3d4e5f6a7b", w.now_s).unwrap_err(), KEY_EXISTS);
    // spokes: a spoke's certificate is kept by node id; a hub's is not a spoke's
    let added = add_spoke_in(&dir, &w.spokes[0].cert, w.now_s).unwrap();
    assert!(dir.join(SPOKES_DIR).join(format!("{}.cert", added.node)).is_file());
    assert_eq!(add_spoke_in(&dir, &good, w.now_s).unwrap_err(), "that certificate is a hub, not a spoke");
}

/// 7.2.1: `connector serve` starts no service hub in an enclave (before anything is unsealed or dialed).
#[test]
fn an_enclave_connector_starts_no_service_hub() {
    let v = json!({
        "org": "acme", "connector_id": "k_7a1b2c3d4e5f6a7b", "state_dir": "state", "tls_cert": "server.crt", "tls_key": "server.key",
        "client_ca": "meet-ca.pem", "relay": "https://relay.acme.example:8443", "console": "https://console.acme.example:9443",
        "console_spki": "ab".repeat(32), "seal": {"source": "systemd-creds", "credential": "lucid-api-seal", "encrypted_file": "seal.cred"},
        "apps": [{"name": "helpdesk-api"}], "enclave": true, "enclave_networks": ["10.20.0.0/16"],
        "spokes_hub": {"client": CLIENT, "cert": "hub.cert", "directory": "relay-directory"},
    });
    let cfg = crate::connector::Config::parse(&v, Path::new("/etc/lucid-api-connector")).unwrap();
    assert_eq!(crate::connector_spokes::start(&cfg, Arc::new(|| None::<Obj>)).err().unwrap(), ENCLAVE);
}

#[test]
fn only_directory_relays_marked_api_and_in_date_are_used() {
    let root = SigningKey::from_slice(&[1u8; 32]).unwrap();
    let now_s = 1_800_000_000;
    let token = compact(&root, &json!({
        "v": 1, "typ": "lucid-relay-directory", "root": root_id(&root), "version": 1, "iat": now_s - 60, "exp": now_s + 3600,
        "relays": [{ "url": "https://a.example", "region": "eu", "priority": 0 }, { "url": "https://b.example", "region": "eu", "priority": 1, "api": true, "relay": "r_b", "spki": "A".repeat(43) }],
    }));
    assert_eq!(api_relays(&token, now_s), vec![ApiRelay { relay: "r_b".into(), url: "https://b.example".into(), ca: None, spki: Some("A".repeat(43)) }]);
    assert!(api_relays(&token, now_s + 3600).is_empty(), "an expired directory marks nothing");
}

/// Review W5b 7 (5.8 as amended, ruling A): the add-on's grant rows of `tests/spokes_directory_v1.json`: the relays a
/// service hub dials for a `relays` grant (`*`: the map's `spokes.relays`) are the marked entries named in it, lowest
/// `priority` first.
#[test]
fn the_relays_dialed_for_a_grant_are_the_add_ons() {
    let file: Value = serde_json::from_str(include_str!("../tests/spokes_directory_v1.json")).unwrap();
    let now = file["now"].as_i64().unwrap();
    let dirs = file["directories"].as_array().unwrap();
    let rows = file["grants"].as_array().unwrap();
    assert!(!rows.is_empty());
    for g in rows {
        let name = s(g, "directory");
        let token = dirs.iter().find(|d| d["name"] == json!(name)).map(|d| s(d, "token")).unwrap_or_else(|| panic!("no directory {name}"));
        let mut map = json!({ "clients": [{ "id": CLIENT, "kind": "spokes_hub", "relays": g["grant"] }] });
        if let Some(bound) = g.get("map_relays") {
            map["spokes"] = json!({ "relays": bound });
        }
        let grant = relay_grant(map.as_object().unwrap(), CLIENT);
        let dialed: Vec<String> = granted(api_relays(token, now), &grant).into_iter().map(|r| r.url).collect();
        let expect: Vec<String> = serde_json::from_value(g["dials"].clone()).unwrap();
        assert_eq!(dialed, expect, "{name} under {} (map {})", g["grant"], g.get("map_relays").unwrap_or(&Value::Null));
    }
    assert!(relay_grant(json!({ "clients": [] }).as_object().unwrap(), CLIENT).is_empty(), "a client the map does not list is granted nothing");
}

/// Review W5b 7 (5.8 as amended, ruling A): a relay the directory marks `api` but outside the hub client's `relays`
/// grant is never dialed, though it comes first by priority; widening the grant to it (`*` over a map binding it)
/// makes it the first relay used.
#[test]
fn a_marked_relay_outside_the_grant_is_never_dialed() {
    const OTHER: &str = "https://other-spokes.example";
    let w = World::new("grant", &[(4, "private")]);
    w.spokes_poll();
    let both = compact(&w.root, &json!({
        "v": 1, "typ": "lucid-relay-directory", "root": root_id(&w.root), "version": 3, "iat": w.now_s - 60, "exp": w.now_s + 86_400,
        "org_domains": ["acme.example"],
        "relays": [
            { "url": OTHER, "region": "eu", "priority": 0, "api": true, "relay": "r_99" },
            { "url": RELAY_URL, "region": "eu", "priority": 1, "api": true, "relay": RELAY_ID },
        ],
    }));
    std::fs::write(w.dir.join("directory"), both).unwrap();
    let mut m = Value::Object(w.map.lock().clone().unwrap());
    m["spokes"]["relays"] = json!([RELAY_ID, "r_99"]);
    m["clients"][0]["relays"] = json!([RELAY_ID]);
    w.set_map(m.clone());
    let dialed = Arc::new(Mutex::new(Vec::<String>::new()));
    let mut p = w.parts(KEY_STORE_OS, Duration::from_secs(5));
    let (mailbox, seen) = (w.mailbox.clone(), dialed.clone());
    p.mailbox = Arc::new(move |r: &ApiRelay| {
        seen.lock().push(r.url.clone());
        Ok::<Arc<dyn Mailbox>, String>(mailbox.clone())
    });
    let hub = ServiceHub::open(p).expect("the service hub opens");
    hub.set_events(w.events.clone());
    let made = hub.submit(&w.submit(&[&w.spokes[0]], "x")).expect("the submit goes through the granted relay");
    assert!(hub.task(&made.id).is_some());
    hub.refresh_trust();
    assert!(!dialed.lock().is_empty());
    assert!(dialed.lock().iter().all(|u| u == RELAY_URL), "dialed {:?}", dialed.lock());
    // the whole grant, `*`, over a map that does not bind r_99: still never dialed
    m["spokes"]["relays"] = json!([RELAY_ID]);
    m["clients"][0]["relays"] = json!(["*"]);
    w.set_map(m.clone());
    hub.status(&made.id).expect("status through the granted relay");
    assert!(!dialed.lock().iter().any(|u| u == OTHER));
    // a map binding r_99 under `*`: the lower priority relay is the first one used
    m["spokes"]["relays"] = json!([RELAY_ID, "r_99"]);
    w.set_map(m.clone());
    hub.status(&made.id).expect("status");
    assert_eq!(dialed.lock().iter().filter(|u| *u == OTHER).count(), 1);
}

// ── review W5b ──────────────────────────────────────────────────────────────────────────────────────────────

/// Review W5b 1: the submit's reply is acknowledged only once the task it made is in the sealed book.
#[test]
fn a_submit_reply_is_acknowledged_only_after_its_task_is_sealed() {
    let w = World::new("sealed-before-ack", &[(4, "private")]);
    w.spokes_poll();
    *w.mailbox.book.lock() = Some(w.sealed.clone());
    let hub = w.hub();
    let t = hub.submit(&w.submit(&[&w.spokes[0]], "x")).unwrap();
    let reply = w.mailbox.sent.lock().iter().find(|(to, _)| to == w.hub_key.node()).map(|(_, id)| id.clone()).expect("the spoke replied");
    let acks = w.mailbox.acks.lock();
    let (_, sealed) = acks.iter().find(|(ids, _)| ids.contains(&reply)).expect("the reply was acknowledged");
    assert!(sealed.contains(&t.id), "the task was sealed before its reply was acknowledged");
    assert!(sealed_book(&w.sealed).1.is_empty(), "and the submit's record left the table in the same write");
}

/// Review W5b 2: a submit whose wait ended is cancel-required in the sealed table; after a restart the task its late
/// reply made is canceled, sent again after CANCEL_RETRY_MS when refused, and the record leaves only once confirmed.
#[test]
fn a_late_submits_cancel_survives_a_restart_and_is_sent_again_until_confirmed() {
    let w = World::new("late-restart", &[(4, "private")]);
    w.spokes_poll();
    let hub = ServiceHub::open(w.parts(KEY_STORE_OS, Duration::from_millis(300))).unwrap();
    w.spokes[0].st.lock().hold = true;
    assert_eq!(hub.submit(&w.submit(&[&w.spokes[0]], "x")).unwrap_err(), SubmitError::Rejected(Rejected::NoSpoke));
    let records = sealed_book(&w.sealed).1;
    assert_eq!((records.len(), records[0]["cancel"].clone()), (1, json!(true)), "cancel-required, sealed");
    drop(hub);
    w.spokes[0].st.lock().fail_cancels = 1;
    w.spokes[0].release(); // the late reply waits for the restarted hub
    let hub = w.hub();
    let cancels = |w: &World| w.spokes[0].ops().iter().filter(|o| *o == "cancel").count();
    hub.poll_once(); // the late reply: its task is noted and canceled; the spoke refuses this cancel
    assert_eq!(cancels(&w), 1);
    assert!(sealed_book(&w.sealed).1[0]["task"].is_string(), "the task to cancel is sealed");
    hub.poll_once(); // the refusal: the cancel goes again only after CANCEL_RETRY_MS
    assert_eq!(cancels(&w), 1);
    w.clock.fetch_add(CANCEL_RETRY_MS, Ordering::SeqCst);
    hub.poll_once();
    assert_eq!(cancels(&w), 2, "sent again");
    hub.poll_once(); // its confirmation
    assert!(sealed_book(&w.sealed).1.is_empty(), "confirmed: the record leaves");
    let st = w.spokes[0].st.lock();
    let t = st.tasks.values().next().unwrap();
    assert_eq!((t["state"].clone(), t["reason"].clone()), (json!("closed"), json!("canceled")));
    drop(st);
    assert!(hub.tasks().is_empty());
}

/// Review W5b 3: a replay guard that cannot be written leaves the batch unacknowledged; once it can, the same batch
/// opens and is taken.
#[test]
fn a_hub_whose_replay_guard_cannot_write_leaves_the_batch_unacknowledged() {
    let w = World::new("replay-hub", &[(4, "private")]);
    w.spokes_poll();
    let seen = w.dir.join("hub").join(SEEN_FILE);
    std::fs::create_dir_all(&seen).unwrap();
    let hub = ServiceHub::open(w.parts(KEY_STORE_OS, Duration::from_millis(300))).unwrap();
    w.spokes[0].st.lock().hold = true;
    assert_eq!(hub.submit(&w.submit(&[&w.spokes[0]], "x")).unwrap_err(), SubmitError::Rejected(Rejected::NoSpoke));
    w.spokes[0].release(); // its reply and ask note wait for the hub
    assert_eq!(hub.poll_once(), 0);
    assert_eq!(hub.poll_once(), 0, "still there, still unacknowledged");
    std::fs::remove_dir(&seen).unwrap();
    assert_eq!(hub.poll_once(), 2, "taken once the guard keeps their ids");
    assert_eq!(w.spokes[0].ops().last().map(String::as_str), Some("cancel"), "and the late task is canceled");
}

/// Review W5b 4: after a refresh, a directory under which this certificate is no longer a service hub's stops the
/// hub: no inbox is read or acknowledged and no op is sent. An expired certificate stops it too.
#[test]
fn a_hub_that_no_longer_holds_its_identity_stops_reading() {
    let w = World::new("identity-lost", &[(4, "private")]);
    w.spokes_poll();
    let hub = w.hub();
    let t = hub.submit(&w.submit(&[&w.spokes[0]], "x")).unwrap();
    hub.poll_once();
    // a newer directory whose org domains do not cover apps.acme.example
    assert_eq!(w.post("/v1/directory", &json!({ "directory": directory(&w.root, 3, true, &["example.org"], w.now_s) })), 200);
    w.spokes[0].finish_turn(&t.id, "done");
    hub.refresh_trust();
    assert_eq!(hub.stopped().as_deref(), Some(NOT_SERVICE_HUB));
    assert_eq!(hub.poll_once(), 0, "a stopped hub reads nothing");
    assert_eq!(hub.task(&t.id).unwrap().state, "awaiting_approval", "the note waits, unread");
    assert!(matches!(hub.submit(&w.submit(&[&w.spokes[0]], "x")).unwrap_err(), SubmitError::Hub(HubError::Unavailable(_))));
    assert!(std::fs::read_to_string(w.dir.join("directory")).unwrap().contains(&directory(&w.root, 3, true, &["example.org"], w.now_s)), "the newer directory was saved first");

    let w = World::new("expired", &[(4, "private")]);
    let hub = w.hub();
    w.clock.fetch_add(2 * 86_400_000, Ordering::SeqCst);
    hub.refresh_trust();
    assert!(hub.stopped().unwrap().starts_with("this service hub's certificate:"), "{:?}", hub.stopped());
    assert_eq!(hub.poll_once(), 0);
}

/// Review W5b 5: a newer CRL or directory that cannot be written is not used, and the hub stops (fail closed).
#[test]
fn a_newer_crl_or_directory_that_cannot_be_saved_stops_the_hub() {
    let w = World::new("crl-unsaved", &[(4, "private")]);
    w.spokes_poll();
    let hub = w.hub();
    std::fs::create_dir_all(w.dir.join("hub").join(BUNDLE_FILE)).unwrap();
    assert_eq!(w.post("/v1/crl", &json!({ "crl": w.crl_revoking(1, 0x77) })), 200);
    hub.refresh_trust();
    assert!(hub.stopped().unwrap().starts_with("a newer revocation list could not be saved"), "{:?}", hub.stopped());
    assert_eq!(hub.poll_once(), 0);

    let w = World::new("directory-unsaved", &[(4, "private")]);
    w.spokes_poll();
    let hub = w.hub();
    std::fs::remove_file(w.dir.join("directory")).unwrap();
    std::fs::create_dir_all(w.dir.join("directory")).unwrap();
    assert_eq!(w.post("/v1/directory", &json!({ "directory": directory(&w.root, 3, true, &["example.org"], w.now_s) })), 200);
    hub.refresh_trust();
    assert!(hub.stopped().unwrap().starts_with("a newer relay directory could not be saved"), "{:?}", hub.stopped());
}

/// Review W5b 6: a relay answer over REPLY_CAP_BYTES is refused while it is read (here: on its claimed length).
#[test]
fn an_oversized_relay_answer_is_refused_while_reading() {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = std::thread::spawn(move || {
        if let Ok((mut s, _)) = listener.accept() {
            let mut buf = [0u8; 4096];
            let _ = s.read(&mut buf);
            let _ = s.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", REPLY_CAP_BYTES + 1).as_bytes());
            let _ = s.write_all(&vec![b'x'; 65_536]);
        }
    });
    let m = HttpsMailbox::new(&ApiRelay { relay: "r_21".into(), url: format!("http://127.0.0.1:{port}"), ca: None, spki: None }).unwrap();
    let e = m.exchange("GET", "/v1/inbox", &[], None).unwrap_err();
    assert!(e.ends_with("reply too large"), "{e}");
    let _ = server.join();
}

/// Presence pages from a relay that answers whatever it is asked: `rows` per page, a `next` on every page (`endless`)
/// or on the first two.
struct Pages {
    rows: usize,
    endless: bool,
    served: std::sync::atomic::AtomicUsize,
}

impl Mailbox for Pages {
    fn url(&self) -> &str {
        RELAY_URL
    }

    fn exchange(&self, _: &str, _: &str, _: &[(&'static str, String)], _: Option<&[u8]>) -> Result<(u16, Vec<u8>), String> {
        let page = self.served.fetch_add(1, Ordering::SeqCst);
        let nodes: Vec<Value> = (0..self.rows).map(|i| json!({ "node": format!("n_{:032x}", page * self.rows + i + 1), "lastPollAt": 1 })).collect();
        let mut v = json!({ "ok": true, "nodes": nodes });
        if self.endless || page < 2 {
            v["next"] = json!(format!("n_{:032x}", (page + 1) * self.rows));
        }
        Ok((200, stringify(&v).into_bytes()))
    }
}

/// Review W5b 8: presence paging stops at PRESENCE_PAGES_MAX pages and PRESENCE_ROWS_MAX rows, refused past either.
#[test]
fn presence_paging_is_bounded() {
    let key = Arc::new(NodeKey::from_scalar(&[HUB_SEED; 32]).unwrap());
    let client = |rows: usize, endless: bool| RelayClient::new(Arc::new(Pages { rows, endless, served: Default::default() }), key.clone(), "a.b", None).unwrap();
    assert_eq!(client(2, false).presence(1).unwrap().len(), 6, "three honest pages");
    assert!(client(1, true).presence(1).unwrap_err().message.contains(&format!("past {PRESENCE_PAGES_MAX} pages")));
    let rows = PRESENCE_ROWS_MAX / (PRESENCE_PAGES_MAX - 1) + 1;
    assert!(client(rows, true).presence(1).unwrap_err().message.contains(&format!("more than {PRESENCE_ROWS_MAX} spokes")));
}
