// CE-1 vectors (docs/chat-e2ee/contract.md revision 9 section 14; docs/api/contract-r5-1c.md 7.4 to 7.6): every
// case of tests/chat_e2ee_v1.json the device side owns, asserted exactly as `check()` in
// tests/vectors/make_chat_e2ee_v1.py asserts it (one test per section, each case's name in the message, an empty
// section fails), plus round trips of what `check()` never signs (bundles, wraps, envelopes, log entries). The
// world (CA, devices, keys, bundles, revocation list) is the file's, as the generator's `World.load`.

use std::collections::HashMap;
use std::sync::LazyLock;

use serde_json::{json, Value};

use crate::ce_device::*;
use crate::ce_device_log::*;

static DATA: LazyLock<Value> = LazyLock::new(|| serde_json::from_str(include_str!("../tests/chat_e2ee_v1.json")).expect("the CE-1 vectors parse"));

fn data() -> &'static Value {
    &DATA
}

fn cases(section: &str) -> &'static [Value] {
    let list = data()[section].as_array().unwrap_or_else(|| panic!("no section {section}"));
    assert!(!list.is_empty(), "section {section} is empty");
    list
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or_else(|| panic!("{k} is not text in {v}"))
}

fn n(v: &Value, k: &str) -> i64 {
    v[k].as_i64().unwrap_or_else(|| panic!("{k} is not an integer in {v}"))
}

fn name(c: &Value) -> String {
    c["name"].as_str().map_or_else(|| c.to_string(), str::to_string)
}

fn unhex(h: &str) -> Vec<u8> {
    assert!(h.len() % 2 == 0, "odd hex");
    (0..h.len()).step_by(2).map(|i| u8::from_str_radix(&h[i..i + 2], 16).expect("hex")).collect()
}

fn hx(b: &[u8]) -> String {
    crate::codec::hex(b)
}

fn unb64(v: &str) -> Vec<u8> {
    crate::meet_json::b64_strict(v).expect("base64")
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array().into_iter().flatten().map(|x| x.as_str().expect("text").to_string()).collect()
}

fn outcome<T>(r: &CeResult<T>) -> (bool, &'static str) {
    match r {
        Ok(_) => (true, ""),
        Err(e) => (false, e.code),
    }
}

fn expected(c: &Value) -> (bool, &str) {
    (c["ok"].as_bool().expect("ok"), c.get("error").and_then(Value::as_str).unwrap_or(""))
}

fn now_s() -> i64 {
    n(data(), "now_s")
}

fn now_ms() -> i64 {
    n(data(), "now_ms")
}

const ANN: &str = "ann@acme.test";
const BEN: &str = "ben@acme.test";

// -- the world (World.load) --------------------------------------------------------------------------------------

fn dev(name: &str) -> &'static Value {
    let d = &data()["devices"][name];
    assert!(d.is_object(), "no device {name}");
    d
}

fn pd(name: &str) -> Pd {
    (s(dev(name), "principal").to_string(), s(dev(name), "device").to_string())
}

fn key_json(key: &str) -> &'static Value {
    let k = &data()["keys"][key];
    assert!(k.is_object(), "no key {key}");
    k
}

fn device_key(name: &str) -> DeviceKey {
    DeviceKey::from_pem(s(key_json(s(dev(name), "key")), "pem")).expect("a device key")
}

fn p384(key: &str) -> DckKey {
    DckKey::from_scalar(&unhex(s(key_json(key), "d"))).expect("a P-384 key")
}

fn dck(name: &str) -> DckKey {
    p384(s(dev(name), "dck_key"))
}

fn certs_for(principal: &str, device: &str) -> Vec<(String, String)> {
    data()["devices"]
        .as_object()
        .expect("devices")
        .values()
        .filter(|d| d["principal"] == json!(principal) && d["device"] == json!(device))
        .map(|d| (s(d, "cert").to_string(), s(d, "chain").to_string()))
        .collect()
}

fn verifier_at(use_crl: bool, require_crl: bool, now: i64) -> Verifier {
    let ca = s(data(), "ca");
    let rev = use_crl.then(|| Revocation::parse(&unb64(s(data(), "crl_b64")), ca, "").expect("the revocation list"));
    Verifier::new(ca, rev, require_crl).at(now * 1000)
}

fn verifier(use_crl: bool) -> Verifier {
    verifier_at(use_crl, false, now_s())
}

fn vb(name: &str) -> VerifiedBundle {
    verify_bundle(&data()["bundles"][name], &verifier(false), now_s(), None, None).expect("a world bundle verifies")
}

fn my_bundles(name: &str) -> Vec<(VerifiedBundle, DckKey)> {
    vec![(vb(name), dck(name))]
}

fn policy_view(spec: &Value) -> Option<PolicyView> {
    if spec.is_null() {
        return None;
    }
    let held = strings(&spec["held"]);
    let mut view = PolicyView { now_s: n(spec, "now_s"), own_org: spec.get("own_org").and_then(Value::as_str).unwrap_or("").to_string(), ..PolicyView::default() };
    for p in cases("org_policies") {
        if held.iter().any(|h| h == s(p, "hash")) {
            view.by_hash.insert(s(p, "hash").to_string(), p["policy"].clone());
        }
    }
    for (org, h) in spec["newest"].as_object().into_iter().flatten() {
        view.newest.insert(org.clone(), h.as_str().expect("hash").to_string());
    }
    Some(view)
}

fn head_of(seq: &Value, hash: &Value) -> Head {
    Head { seq: seq.as_i64().expect("seq"), hash: unhex(hash.as_str().expect("hash")).try_into().expect("32 bytes") }
}

/// The member logs `check_logs` keeps, by case name.
fn logs() -> HashMap<String, LogState> {
    let mut out = HashMap::new();
    for c in cases("member_log") {
        if c["ok"] == json!(true) {
            let state = replay_log(s(c, "cid"), c["entries"].as_array().expect("entries"), &certs_for, &verifier(false), n(c, "now_ms"), None, None).expect("a good log");
            out.insert(name(c), state);
        }
    }
    out
}

/// `OpenedMessage(cid, mid, from_p, "0000000000000001", "1", 1, 1, 0, 0, kind, ref, payload, NOW, "", "", False,
/// ZERO_HEAD)` of an authorize case.
fn authorize_msg(c: &Value) -> OpenedMessage {
    OpenedMessage {
        cid: s(c, "cid").to_string(),
        mid: "0123456789abcdef0123456789abcdef".to_string(),
        from_p: s(c, "from_p").to_string(),
        from_d: "0000000000000001".to_string(),
        serial: "1".to_string(),
        epoch: 1,
        counter: 1,
        pe: 0,
        pc: 0,
        kind: s(c, "kind").to_string(),
        ref_: s(c, "ref").to_string(),
        payload: c["payload"].clone(),
        s: now_ms(),
        t: String::new(),
        q: String::new(),
        a: false,
        head: ZERO_HEAD,
    }
}

// -- section 2 ---------------------------------------------------------------------------------------------------

#[test]
fn canonical_json_decode() {
    for c in cases("canonical_json") {
        let got = canonical_loads(&unhex(s(c, "input_hex")));
        assert_eq!(outcome(&got), expected(c), "{}", name(c));
    }
}

#[test]
fn canonical_encode() {
    for c in cases("canonical_encode") {
        assert_eq!(hx(&canonical_json(&c["value"]).expect("encodes")), s(c, "canonical_hex"), "{}", name(c));
    }
}

#[test]
fn padding() {
    for c in cases("padding") {
        if c.get("padded_hex").is_some() && c.get("payload_hex").is_some() {
            assert_eq!(hx(&pad(&unhex(s(c, "payload_hex"))).expect("pads")), s(c, "padded_hex"), "{}", name(c));
            assert_eq!(hx(&unpad(&unhex(s(c, "padded_hex"))).expect("unpads")), s(c, "payload_hex"), "{}", name(c));
        } else if c.get("padded_hex").is_some() {
            assert_eq!(outcome(&unpad(&unhex(s(c, "padded_hex")))), (false, "padding"), "{}", name(c));
        } else {
            let got = pad(&vec![b'a'; n(c, "payload_len") as usize]);
            assert_eq!(got.is_ok(), c["ok"].as_bool().expect("ok"), "{}", name(c));
            if let Ok(padded) = got {
                assert_eq!(padded.len() as i64, n(c, "padded_len"), "{}", name(c));
            }
        }
    }
}

#[test]
fn principals() {
    for c in cases("principals") {
        assert_eq!(check_principal(s(c, "p")).is_ok(), c["ok"].as_bool().expect("ok"), "{:?}", c["p"]);
    }
}

#[test]
fn sorting() {
    for c in cases("sorting") {
        assert_eq!(sort_bytes(&strings(&c["input"])), strings(&c["sorted"]), "{c}");
    }
}

#[test]
fn dm_cids() {
    for c in cases("dm_cid") {
        let got = dm_cid(s(c, "a"), s(c, "b"));
        assert_eq!(got.is_ok(), c["ok"].as_bool().expect("ok"), "{c}");
        if let Ok(cid) = got {
            assert_eq!(cid, s(c, "cid"), "{c}");
        }
    }
}

#[test]
fn set_hashes() {
    for c in cases("set_hash") {
        let devices: Vec<Pd> = c["devices"].as_array().expect("devices").iter().map(|d| (d[0].as_str().expect("p").to_string(), d[1].as_str().expect("d").to_string())).collect();
        let got = set_hash(&devices);
        assert_eq!(got.is_ok(), c["ok"].as_bool().expect("ok"), "{c}");
        if let Ok(h) = got {
            assert_eq!(hx(&h), s(c, "hash"), "{c}");
        }
    }
}

// -- section 4 ---------------------------------------------------------------------------------------------------

#[test]
fn bundles() {
    for c in cases("bundle") {
        let got = verify_bundle(&c["bundle"], &verifier(false), n(c, "now_s"), None, None);
        assert_eq!(outcome(&got), expected(c), "{}", name(c));
        let b = &c["bundle"];
        let signed = bundle_signed_bytes(s(b, "principal"), s(b, "device"), &unb64(s(b, "dck")), n(b, "created"), n(b, "expires"), s(b, "serial"));
        assert_eq!(hx(&signed), s(c, "signed_hex"), "{}", name(c));
    }
}

// -- section 7 ---------------------------------------------------------------------------------------------------

#[test]
fn member_logs() {
    for c in cases("member_log") {
        let cid = s(c, "cid");
        let entries = c["entries"].as_array().expect("entries");
        let pinned = c.get("pinned").map(|p| head_of(&p["seq"], &p["hash"]));
        let signed: Vec<String> = entries.iter().map(|e| hx(&member_signed_bytes(cid, e).expect("signed bytes"))).collect();
        assert_eq!(json!(signed), c["signed_hex"], "{}", name(c));
        let got = replay_log(cid, entries, &certs_for, &verifier(false), n(c, "now_ms"), pinned, None);
        assert_eq!(outcome(&got), expected(c), "{}", name(c));
        if let Ok(state) = got {
            assert_eq!(json!(state.members), c["members"], "{}", name(c));
            assert_eq!(json!(state.admins), c["admins"], "{}", name(c));
            assert_eq!((json!(state.kind), json!(state.bridgeable)), (c["kind"].clone(), c["bridgeable"].clone()), "{}", name(c));
            if let Some(confirmed) = c.get("confirmed_by") {
                assert_eq!(&json!(state.confirmed_by), confirmed, "{}", name(c));
            }
            assert_eq!(json!(state.head.hash_hex()), c["hashes"][c["hashes"].as_array().expect("hashes").len() - 1], "{}", name(c));
        }
    }
}

#[test]
fn service_logs() {
    for c in cases("service_log") {
        let cid = s(c, "cid");
        let entries = c["entries"].as_array().expect("entries");
        let signed: Vec<Vec<u8>> = entries.iter().map(|e| member_signed_bytes(cid, e).expect("signed bytes")).collect();
        assert_eq!(json!(signed.iter().map(|b| hx(b)).collect::<Vec<_>>()), c["signed_hex"], "{}", name(c));
        for (e, b) in entries.iter().zip(&signed) {
            if matches!(e["op"].as_str(), Some("archive" | "unarchive")) {
                let mut tail = 32u32.to_be_bytes().to_vec();
                tail.extend(unhex(s(e, "policy")));
                assert!(b.ends_with(&tail), "{}: the policy hash is the last field", name(c));
            }
        }
        let view = policy_view(&c["policies"]);
        let pinned = c.get("pinned").map(|p| head_of(&p["seq"], &p["hash"]));
        let got = match c.get("earlier") {
            Some(earlier) => {
                let upto = n(earlier, "upto") as usize;
                let first = replay_log(cid, &entries[..upto], &certs_for, &verifier(false), n(c, "now_ms"), None, policy_view(&earlier["policies"]).as_ref());
                first.and_then(|first| extend_log(&first, entries, &certs_for, &verifier(false), n(c, "now_ms"), view.as_ref(), 0))
            }
            None => replay_log(cid, entries, &certs_for, &verifier(false), n(c, "now_ms"), pinned, view.as_ref()),
        };
        assert_eq!(outcome(&got), expected(c), "{}", name(c));
        if let Ok(state) = got {
            assert_eq!(json!(state.members), c["members"], "{}", name(c));
            assert_eq!(json!(state.admins), c["admins"], "{}", name(c));
            assert_eq!(json!(state.linked), c["linked"], "{}", name(c));
            assert_eq!(json!(state.archives), c["archives"], "{}", name(c));
            assert_eq!(json!(state.head.hash_hex()), c["hashes"][c["hashes"].as_array().expect("hashes").len() - 1], "{}", name(c));
        }
    }
}

// -- section 5 ---------------------------------------------------------------------------------------------------

#[test]
fn wraps() {
    let logs = logs();
    let good = logs.get("good_create").expect("the good_create log");
    for c in cases("wrap") {
        let me = pd(s(c, "recipient"));
        let devices: Vec<Pd> = pds_value(&c["members_devices"]).expect("devices");
        let members_for = |cid: &str, head: &Head, _pols: &[String]| -> CeResult<Option<Vec<Pd>>> {
            if cid.starts_with("ch:") && !good.has_head(head) {
                return Ok(None);
            }
            Ok(Some(devices.clone()))
        };
        let got = open_wrap(&c["wrap"], &me.0, &me.1, &my_bundles(s(c, "recipient")), &certs_for, &verifier(c["use_crl"] == json!(true)), n(c, "observed_ms"), &members_for);
        assert_eq!(outcome(&got), expected(c), "{}", name(c));
        if let Ok(opened) = got {
            assert_eq!(hx(&opened.key), s(c, "key_hex"), "{}", name(c));
            assert_eq!(json!(opened.members_ok), c["members_ok"], "{}", name(c));
            let wire = &c["wrap"];
            let recipient = vb(s(c, "recipient"));
            let info = wrap_info(s(wire, "cid"), s(&wire["from"], "principal"), s(&wire["from"], "device"), n(wire, "epoch"), &me.0, &me.1, &unb64(s(wire, "eph")), &recipient.dck_raw);
            assert_eq!(hx(&info), s(c, "info_hex"), "{}", name(c));
        }
    }
}

/// `check_dm_wraps`: the `dm_wrap` and `ai_wrap` sections.
fn check_dm_wraps(section: &str) {
    for c in cases(section) {
        let me = pd(s(c, "recipient"));
        let view = policy_view(&c["policies"]).expect("a policy view");
        let principals = strings(&c["principals"]);
        let people: Vec<Pd> = pds_value(&c["person_devices"]).expect("devices");
        let members_for = |_cid: &str, _head: &Head, pols: &[String]| -> CeResult<Option<Vec<Pd>>> {
            let mut devices = people.clone();
            devices.extend(dm_archives(&principals, pols, &view)?);
            Ok(Some(devices))
        };
        let got = open_wrap(&c["wrap"], &me.0, &me.1, &my_bundles(s(c, "recipient")), &certs_for, &verifier(false), n(c, "observed_ms"), &members_for);
        assert_eq!(outcome(&got), expected(c), "{}", name(c));
        let Ok(opened) = got else { continue };
        let wire = &c["wrap"];
        assert_eq!(hx(&opened.key), s(c, "key_hex"), "{}", name(c));
        assert_eq!(json!(opened.members_ok), c["members_ok"], "{}", name(c));
        let wire_pols = wire.get("pols").map(strings);
        assert_eq!(opened.pols, wire_pols.clone().unwrap_or_default(), "{}", name(c));
        let recipient = vb(s(c, "recipient"));
        let signed = wrap_signed_bytes(
            s(wire, "cid"),
            s(&wire["from"], "principal"),
            s(&wire["from"], "device"),
            n(wire, "epoch"),
            &me.0,
            &me.1,
            &unb64(s(wire, "eph")),
            &recipient.dck_raw,
            &unb64(s(wire, "blob")),
            &unhex(s(wire, "members")),
            &head_of(&wire["log_seq"], &wire["log_hash"]),
            n(wire, "ts"),
            s(&wire["from"], "serial"),
            wire_pols.as_deref(),
        )
        .expect("signed bytes");
        assert_eq!(hx(&signed), s(c, "signed_hex"), "{}", name(c));
        if let Some(archives) = c.get("archives") {
            let got: Vec<Value> = dm_archives(&principals, &opened.pols, &view).expect("archives").into_iter().map(|(p, d)| json!([p, d])).collect();
            assert_eq!(&json!(got), archives, "{}", name(c));
        }
    }
}

#[test]
fn dm_wraps() {
    check_dm_wraps("dm_wrap");
}

// -- section 6 ---------------------------------------------------------------------------------------------------

/// `check_envelopes`: the `envelope` and `ai_envelope` sections.
fn check_envelopes(section: &str) {
    let logs = logs();
    for c in cases(section) {
        let key = unhex(s(c, "key_hex"));
        let slot = &c["key_slot"];
        let key_for = |cid: &str, p: &str, d: &str, e: i64| -> Option<Vec<u8>> { (json!([cid, p, d, e]) == *slot).then(|| key.clone()) };
        let log = c.get("log").and_then(Value::as_str).and_then(|l| logs.get(l));
        let row = &c["row"];
        let got = open_envelope(&c["envelope"], s(c, "cid"), s(c, "mid"), s(c, "from_p"), Some(row), &key_for, &certs_for, &verifier(c["use_crl"] == json!(true)), n(c, "observed_ms"), log);
        assert_eq!(outcome(&got), expected(c), "{}", name(c));
        let Ok(opened) = got else { continue };
        assert_eq!(hx(&canonical_json(&opened.payload).expect("canonical")), s(c, "payload_hex"), "{}", name(c));
        let env = &c["envelope"];
        let header = OpenedMessage {
            cid: s(c, "cid").to_string(),
            mid: s(c, "mid").to_string(),
            from_p: s(c, "from_p").to_string(),
            from_d: s(env, "d").to_string(),
            serial: s(env, "sr").to_string(),
            epoch: n(env, "e"),
            counter: n(env, "c"),
            pe: n(env, "pe"),
            pc: n(env, "pc"),
            kind: s(env, "k").to_string(),
            ref_: s(env, "r").to_string(),
            payload: Value::Null,
            s: n(env, "s"),
            t: s(env, "t").to_string(),
            q: s(env, "q").to_string(),
            a: env["a"].as_bool().expect("a"),
            head: head_of(&env["ls"], &env["lh"]),
        };
        let aad = msg_aad(&header);
        assert_eq!(hx(&aad), s(c, "aad_hex"), "{}", name(c));
        assert_eq!(hx(&msg_key(&key, s(c, "cid"), s(c, "mid"), s(env, "k")).expect("message key")), s(c, "mk_hex"), "{}", name(c));
        assert_eq!(hx(&msg_sig_bytes(&aad, &unb64(s(env, "n")), &unb64(s(env, "x")))), s(c, "sig_input_hex"), "{}", name(c));
        assert_eq!(hx(&pad(&unhex(s(c, "payload_hex"))).expect("pads")), s(c, "padded_hex"), "{}", name(c));
    }
}

#[test]
fn envelopes() {
    check_envelopes("envelope");
}

// -- folding -----------------------------------------------------------------------------------------------------

#[test]
fn fold() {
    for c in cases("fold") {
        let mut fold = Fold::new();
        for ev in c["events"].as_array().expect("events") {
            fold.add(&OpenedMessage {
                cid: format!("dm:{}", "0".repeat(64)),
                mid: s(ev, "mid").to_string(),
                from_p: s(ev, "principal").to_string(),
                from_d: s(ev, "device").to_string(),
                serial: "1".to_string(),
                epoch: 1,
                counter: 1,
                pe: 0,
                pc: 0,
                kind: s(ev, "kind").to_string(),
                ref_: s(ev, "ref").to_string(),
                payload: ev["payload"].clone(),
                s: n(ev, "s"),
                t: String::new(),
                q: String::new(),
                a: false,
                head: ZERO_HEAD,
            });
        }
        let (t, ex) = (s(c, "target"), &c["expect"]);
        if let Some(want) = ex.get("reactions") {
            assert_eq!(&json!(fold.reactions(t)), want, "{}", name(c));
        }
        if let Some(want) = ex.get("votes") {
            assert_eq!(&json!(fold.votes(t)), want, "{}", name(c));
        }
        if let Some(want) = ex.get("closed") {
            assert_eq!(&json!(fold.closed(t)), want, "{}", name(c));
        }
        if let Some(want) = ex.get("pinned") {
            assert_eq!(&json!(fold.pinned(t)), want, "{}", name(c));
        }
        if let Some(want) = ex.get("edit_mid") {
            assert_eq!(&json!(fold.edit(t).expect("an edit").mid), want, "{}", name(c));
        }
        if let Some(want) = ex.get("deleted") {
            assert_eq!(&json!(fold.deleted(t)), want, "{}", name(c));
        }
    }
}

// -- section 8 and 7.3 -------------------------------------------------------------------------------------------

#[test]
fn shares() {
    for c in cases("share") {
        let me = pd(s(c, "recipient"));
        let got = open_share(&c["share"], &me.0, &me.1, &my_bundles(s(c, "recipient")), &certs_for, &verifier(false), n(c, "observed_ms"));
        assert_eq!(outcome(&got), expected(c), "{}", name(c));
        if let Ok(opened) = got {
            assert_eq!(hx(&opened.key), s(c, "key_hex"), "{}", name(c));
            assert_eq!((opened.orig_p.as_str(), opened.epoch), (BEN, 3), "{}", name(c));
        }
    }
}

#[test]
fn catchups() {
    for c in cases("catchup") {
        let o = &c["option"];
        assert_eq!(hx(&catchup_signed_bytes(s(c, "room"), "s1", s(o, "by"), s(o, "by_device"), true, n(o, "ts"))), s(c, "signed_hex"), "{}", name(c));
        let allowed = c.get("allowed").filter(|v| !v.is_null()).map(strings);
        let got = verify_catchup(o, s(c, "room"), s(c, "stay"), &certs_for, &verifier(false), n(c, "observed_ms"), allowed.as_deref());
        assert_eq!(outcome(&got), expected(c), "{}", name(c));
    }
}

// -- revision 6 (PC-1) -------------------------------------------------------------------------------------------

#[test]
fn org_policies() {
    for c in cases("org_policies") {
        let policy = c["policy"].as_object().expect("a policy object");
        assert_eq!(crate::meet_org_policy::policy_hash(policy), s(c, "hash"), "{}", name(c));
        assert_eq!(org_policy_hash(policy), s(c, "hash"), "{}", name(c));
    }
}

#[test]
fn authorize_cases() {
    for c in cases("authorize") {
        check_payload(s(c, "kind"), s(c, "ref"), &c["payload"]).unwrap_or_else(|e| panic!("{}: {e}", name(c)));
        let (members, admins) = (strings(&c["members"]), strings(&c["admins"]));
        let ctx = AuthorizeContext { admins: &admins, target_author: c.get("target_author").and_then(Value::as_str), ..AuthorizeContext::default() };
        let got = authorize(&authorize_msg(c), &members, &ctx);
        assert_eq!(outcome(&got), expected(c), "{}", name(c));
    }
}

#[test]
fn cert_kinds() {
    for c in cases("cert_kind") {
        let cert = CeCert::from_pem(s(c, "cert")).unwrap_or_else(|e| panic!("{}: {e}", name(c)));
        let got = cert_kind(&cert);
        assert_eq!(outcome(&got), expected(c), "{}", name(c));
        if let Ok((kind, org)) = got {
            assert_eq!((kind, org.as_str()), (s(c, "kind"), s(c, "org")), "{}", name(c));
            assert_eq!(json!(cert_via_sso(&cert)), c["via_sso"], "{}", name(c));
        }
    }
}

#[test]
fn doc_payloads() {
    for c in cases("doc_payload") {
        let payload = &c["payload"];
        let got = check_payload(s(c, "kind"), s(c, "ref"), payload).and_then(|_| canonical_json(payload)).and_then(|b| pad(&b));
        assert_eq!(outcome(&got), expected(c), "{}", name(c));
    }
}

// -- revision 8 (AI-1 section 7) ---------------------------------------------------------------------------------

#[test]
fn ai_cids() {
    for c in cases("ai_cid") {
        let got = ai_cid(s(c, "principal"));
        assert_eq!(got.is_ok(), c["ok"].as_bool().expect("ok"), "{c}");
        if let Ok(cid) = got {
            assert_eq!(cid, s(c, "cid"), "{c}");
            assert_eq!(cid_kind(&cid), Ok("ai"), "{c}");
            assert_eq!(retention_kind(&cid, ""), Ok("ai"), "{c}");
        }
    }
}

#[test]
fn ai_records() {
    for c in cases("ai_record") {
        assert_eq!(outcome(&check_ai_record(&c["payload"])), expected(c), "{}", name(c));
    }
}

#[test]
fn ai_truncate() {
    for c in cases("ai_truncate") {
        let args = &c["args"];
        let a = format!("{}{}", s(c, "a_prefix"), s(c, "a_char").repeat(n(c, "a_count") as usize));
        let cites = args["cites"].as_array().expect("cites").clone();
        let code = args.get("code").and_then(Value::as_str).unwrap_or("");
        let got = make_ai_record(s(args, "q"), &a, &cites, s(args, "tier"), s(args, "card"), s(args, "model"), s(args, "class_"), s(args, "activity"), s(args, "outcome"), &strings(&args["rids"]), &args["route"], &args["usage"], code)
            .unwrap_or_else(|e| panic!("{}: {e}", name(c)));
        assert_eq!(json!(got.get("trunc") == Some(&json!(true))), c["trunc"], "{}", name(c));
        let got_a = s(&got, "a");
        assert_eq!(got_a.len() as i64, n(c, "a_bytes"), "{}", name(c));
        assert_eq!(canonical_json(&got).expect("canonical").len() as i64, n(c, "payload_bytes"), "{}", name(c));
        assert!(a.starts_with(got_a), "{}", name(c));
    }
}

#[test]
fn ai_authorize() {
    for c in cases("ai_authorize") {
        check_payload(s(c, "kind"), s(c, "ref"), &c["payload"]).unwrap_or_else(|e| panic!("{}: {e}", name(c)));
        let members = strings(&c["members"]);
        let ctx = AuthorizeContext { target_author: c.get("target_author").and_then(Value::as_str), target_kind: c.get("target_kind").and_then(Value::as_str), ..AuthorizeContext::default() };
        let got = authorize(&authorize_msg(c), &members, &ctx);
        assert_eq!(outcome(&got), expected(c), "{}", name(c));
    }
}

#[test]
fn ai_envelopes() {
    check_envelopes("ai_envelope");
}

#[test]
fn ai_wraps() {
    check_dm_wraps("ai_wrap");
}

// -- revision 9 (API-1c 7.4 to 7.6) ------------------------------------------------------------------------------

#[test]
fn rev9_payloads() {
    for c in cases("rev9_payload") {
        assert_eq!(outcome(&check_payload("post", "", &c["payload"])), expected(c), "{}", name(c));
    }
}

#[test]
fn rev9_apr_hashes() {
    for c in cases("rev9_apr_hash") {
        let canonical = canonical_json(&c["apr"]).expect("canonical");
        assert_eq!(hx(&canonical), s(c, "canonical_hex"), "{}", name(c));
        let h = apr_hash(&c["apr"]).expect("a hash");
        assert_eq!(h, s(c, "h"), "{}", name(c));
        assert_eq!(h, crate::codec::sha256_hex(&unhex(s(c, "canonical_hex"))), "{}", name(c));
    }
}

#[test]
fn rev9_authorize() {
    for c in cases("rev9_authorize") {
        check_payload(s(c, "kind"), s(c, "ref"), &c["payload"]).unwrap_or_else(|e| panic!("{}: {e}", name(c)));
        let (members, api_apps) = (strings(&c["members"]), strings(&c["api_apps"]));
        let ctx = AuthorizeContext { api_apps: &api_apps, ..AuthorizeContext::default() };
        let got = authorize(&authorize_msg(c), &members, &ctx);
        assert_eq!(outcome(&got), expected(c), "{}", name(c));
    }
}

#[test]
fn rev9_apr_states() {
    for c in cases("rev9_apr_state") {
        let answers = c["answers"].as_array().expect("answers");
        assert_eq!(apr_state(&c["apr"], answers, n(c, "now_ms")), Ok(s(c, "state")), "{}", name(c));
    }
}

#[test]
fn rev9_member_intervals() {
    for c in cases("rev9_member_intervals") {
        let view = policy_view(&c["policies"]);
        let state = replay_log(s(c, "cid"), c["entries"].as_array().expect("entries"), &certs_for, &verifier(false), n(c, "now_ms"), None, view.as_ref()).unwrap_or_else(|e| panic!("{}: {e}", name(c)));
        let intervals = c["intervals"].as_object().expect("intervals");
        assert!(!intervals.is_empty(), "{}: no intervals", name(c));
        for (p, want) in intervals {
            let got: Vec<Value> = state.member_intervals(p).into_iter().map(|(a, b)| json!([a, b])).collect();
            assert_eq!(&json!(got), want, "{} {p}", name(c));
        }
        for x in c["inside"].as_array().expect("inside") {
            let got = in_intervals(&state.member_intervals(s(x, "principal")), n(x, "s"));
            assert_eq!(json!(got), x["in"], "{} {x}", name(c));
        }
    }
}

// -- round trips (what check() verifies but never signs here) ----------------------------------------------------

#[test]
fn bundle_round_trip_p256_and_p384() {
    for device in ["ann1", "ben1"] {
        let d = dev(device);
        let bundle = make_bundle(&device_key(device), s(d, "cert"), "", &dck(device), now_s() - 300 - 86400, None).expect("a bundle");
        let got = verify_bundle(&bundle, &verifier(false), now_s(), None, None).unwrap_or_else(|e| panic!("{device}: {e}"));
        assert_eq!(got.dck_raw, dck(device).raw(), "{device}");
        assert_eq!(VerifiedBundle::from_value(&got.to_value()).expect("from_value"), got, "{device}");
    }
}

#[test]
fn wrap_reproduces_the_vector_bytes() {
    let c = cases("wrap").iter().find(|c| c["name"] == json!("good")).expect("the good wrap");
    let wire = &c["wrap"];
    let to = vb("ben1");
    let members: Vec<Pd> = pds_value(&c["members_devices"]).expect("devices");
    let nonce: [u8; 12] = unhex(s(c, "nonce_hex")).try_into().expect("12 bytes");
    let (p, d) = pd("ann1");
    let made = make_wrap(&device_key("ann1"), s(wire, "cid"), &p, &d, s(dev("ann1"), "serial"), 1, &unhex(s(c, "key_hex")), &to, &set_hash(&members).expect("set"), ZERO_HEAD, n(wire, "ts"), Some(&p384(s(c, "esk_key"))), Some(nonce), None).expect("a wrap");
    assert_eq!((&made["eph"], &made["blob"], &made["members"]), (&wire["eph"], &wire["blob"], &wire["members"]));
    assert_eq!(made["pols"], json!([]));
    let all = |_: &str, _: &Head, _: &[String]| -> CeResult<Option<Vec<Pd>>> { Ok(Some(members.clone())) };
    let me = pd("ben1");
    let opened = open_wrap(&made, &me.0, &me.1, &my_bundles("ben1"), &certs_for, &verifier(false), now_ms(), &all).expect("opens");
    assert_eq!(hx(&opened.key), s(c, "key_hex"));
    assert!(opened.members_ok);
}

#[test]
fn seal_reproduces_the_vector_bytes_and_opens() {
    for want in ["post_text", "first_of_epoch", "doc", "post_workflow_status"] {
        let c = cases("envelope").iter().find(|c| c["name"] == json!(want)).expect("the case");
        let env = &c["envelope"];
        let payload = canonical_loads(&unhex(s(c, "payload_hex"))).expect("a payload");
        let msg = OpenedMessage {
            cid: s(c, "cid").to_string(),
            mid: s(c, "mid").to_string(),
            from_p: s(c, "from_p").to_string(),
            from_d: s(env, "d").to_string(),
            serial: s(env, "sr").to_string(),
            epoch: n(env, "e"),
            counter: n(env, "c"),
            pe: n(env, "pe"),
            pc: n(env, "pc"),
            kind: s(env, "k").to_string(),
            ref_: s(env, "r").to_string(),
            payload,
            s: n(env, "s"),
            t: s(env, "t").to_string(),
            q: s(env, "q").to_string(),
            a: env["a"].as_bool().expect("a"),
            head: head_of(&env["ls"], &env["lh"]),
        };
        let key = unhex(s(c, "key_hex"));
        let nonce: [u8; 12] = unb64(s(env, "n")).try_into().expect("12 bytes");
        let sender = if msg.from_p == ANN { "ann1" } else { "app1" };
        let sealed = seal(&device_key(sender), &key, &msg, Some(nonce)).unwrap_or_else(|e| panic!("{want}: {e}"));
        assert_eq!(sealed["x"], env["x"], "{want}");
        let key_for = |_: &str, _: &str, _: &str, _: i64| -> Option<Vec<u8>> { Some(key.clone()) };
        let opened = open_envelope(&sealed, &msg.cid, &msg.mid, &msg.from_p, Some(&c["row"]), &key_for, &certs_for, &verifier(false), n(c, "observed_ms"), None).unwrap_or_else(|e| panic!("{want}: {e}"));
        assert_eq!(opened, msg, "{want}");
    }
}

#[test]
fn log_entries_round_trip_and_extend() {
    let cid = "ch:round-trip";
    let (ann, ben) = (pd("ann1"), pd("ben1"));
    let t = now_ms() - 30_000;
    let create = make_entry(&device_key("ann1"), cid, 1, "create", &ann.0, &ann.1, &[ANN.to_string(), BEN.to_string()], t, &[0; 32], "public", false, &[ANN.to_string()], "").expect("create");
    let prev = entry_hash(cid, &create).expect("hash");
    let leave = make_entry(&device_key("ben1"), cid, 2, "leave", &ben.0, &ben.1, &[BEN.to_string()], t + 1000, &prev, "", false, &[], "").expect("leave");
    let first = replay_log(cid, std::slice::from_ref(&create), &certs_for, &verifier(false), now_ms(), None, None).expect("replays");
    let pinned = first.head;
    let state = extend_log(&first, &[create.clone(), leave.clone()], &certs_for, &verifier(false), now_ms(), None, 0).expect("extends");
    assert_eq!(state.members.iter().cloned().collect::<Vec<_>>(), vec![ANN.to_string()]);
    assert_eq!(state.member_intervals(BEN), vec![(t, t + 1000)]);
    let again = replay_log(cid, &[create, leave], &certs_for, &verifier(false), now_ms(), Some(pinned), None).expect("replays past the pin");
    assert_eq!(again, state);
    assert_eq!(LogState::from_value(cid, &state.to_value()).expect("from_value"), state);
}

#[test]
fn sender_keys_plan_wrap_and_send() {
    let (ann, ben) = (pd("ann1"), pd("ben1"));
    let cid = dm_cid(ANN, BEN).expect("cid");
    let mut store = KeyStore::new();
    store.add_dck(dck("ann1"), vb("ann1")).expect("my chat key");
    let mut keys = SenderKeys::new(&ann.0, &ann.1).expect("sender keys");
    let plan = keys.plan(&mut store, &cid, &[ben.clone()], now_s(), None).expect("a plan");
    assert!(plan.rotated);
    assert_eq!(plan.wrap_to, vec![ben.clone()]);
    assert_eq!(store.get_key(&cid, &ann.0, &ann.1, plan.epoch), Some(plan.key.clone()));
    keys.mark_wrapped(&cid, plan.epoch, &[ben.clone()]).expect("wrapped");
    let again = keys.plan(&mut store, &cid, &[ben.clone()], now_s() + 1, None).expect("the same epoch");
    assert!(!again.rotated && again.wrap_to.is_empty() && again.epoch == plan.epoch);
    let next = keys.next_counter(&cid, now_ms(), "post").expect("a counter");
    assert_eq!((next.epoch, next.counter, next.pe, next.pc), (plan.epoch, 1, 0, 0));
    let restored = SenderKeys::from_value(&keys.to_value(), &ann.0, &ann.1).expect("from_value");
    assert_eq!(restored.to_value(), keys.to_value());
    let restored_store = KeyStore::from_value(&store.to_value()).expect("from_value");
    assert_eq!(restored_store.to_value(), store.to_value());
    assert_eq!(restored_store.my_bundles().len(), 1);
}
