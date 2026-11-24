// Contract API-1 revision 4 (docs/api/contract-r4-1b.md) 2.5 and 5.2.3, the relay end of API compliance requests:
// `api-compliance-read` (the hub's `api_compliance_read`), `api-hold` and `api-hold-status`.
//
// `api-hold {org, hold, ask_reviewer}` places the relay hold at once through the hub's API entry
// (`pc_holds_prepare_api` checks it, idempotent by the hold id, `by` the client's principal; for a new hold
// `compliance.hold.placed` is appended to this relay's chain for the org first, 503 `audit-unavailable` when it cannot
// be; `pc_holds_commit_api` then keeps it and syncs state.json before the answer), and on the archive relay
// (`ask_reviewer`) asks the named reviewer's device to sign the AI-1 7.5 archive hold body
// (`meet.ai.reviewer-sign`, op `hold`, label `lucid-meet-archive-hold-v1`, body unchanged). Unlike the
// console's own asks, which live in memory, the ask is kept durably in `<state>/api-compliance/<org>/asks.json`
// (written and flushed before the answer), so it survives a restart: when the reviewer signs
// (`console_meet::ai_request_signed` hands an ask it does not hold here), the signed body goes to
// the archive's `POST /v1/holds` as the console flow sends it, and the outcome is kept for `api-hold-status`. The
// relay hold stays placed whatever the reviewer or the archive answers.
//
// The `hold` record the console sends: `{hold, on, principals, reason, matter?, reviewer?, client, client_name,
// owner, by, at}` (`by` the client's principal, `client_name` its map name for the reviewer's reason line).

use crate::api_compliance::{hold_id_ok, principal_ok, HOLD_PRINCIPALS_MAX, HOLD_REASON_MAX};
use crate::console::{ApiError, Console};
use crate::console_ai as ai;
use crate::console_meet::{self as cm, AI_REVIEWER_KIND, NO_REQUEST};
use crate::fleet_wire::Refusal;
use crate::meet::{Identity, Relay, E, R};
use crate::meet_hub::pc::ApiHold;
use crate::meet_hub::Hub;
use crate::meet_json::{obj, Obj};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::path::PathBuf;

/// The folder of the durable asks, one sub-folder per org.
pub const DIR: &str = "api-compliance";
const ASKS: &str = "asks.json";
/// Asks kept per org (the oldest settled ones go first).
const ASKS_MAX: usize = 2000;

/// One read-modify-write of an `asks.json` at a time.
static ASKS_LOCK: Mutex<()> = Mutex::new(());

/// The API hold a relay places, as the console sent it.
#[derive(Clone, Debug, PartialEq)]
pub struct HoldAsk {
    pub hold: String,
    pub principals: Vec<String>,
    pub reason: String,
    pub reviewer: Option<String>,
    pub owner: String,
    pub by: String,
    pub client_name: String,
}

fn bad(why: &str) -> Refusal {
    Refusal::new(400, "bad-request", why)
}

/// The `hold` of an `api-hold` request, checked.
pub fn hold_of(v: Option<&Value>) -> Result<HoldAsk, Refusal> {
    let o = v.and_then(Value::as_object).ok_or_else(|| bad("hold is the hold record."))?;
    let s = |k: &str| o.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
    let hold = s("hold");
    if !hold_id_ok(&hold) || s("on") != "people" {
        return Err(bad("hold is the hold record."));
    }
    let principals: Vec<String> = o.get("principals").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect();
    if principals.is_empty() || principals.len() > HOLD_PRINCIPALS_MAX || !principals.iter().all(|p| principal_ok(p)) {
        return Err(bad("principals names 1 to 200 people."));
    }
    let reason = s("reason");
    if reason.is_empty() || reason.chars().count() > HOLD_REASON_MAX {
        return Err(bad("reason is 1 to 500 characters."));
    }
    let reviewer = o.get("reviewer").and_then(Value::as_str).map(str::to_string);
    let (owner, by) = (s("owner"), s("by"));
    if !principal_ok(&owner) || !principal_ok(&by) || reviewer.as_deref().is_some_and(|r| !principal_ok(r)) {
        return Err(bad("hold names its client, owner and reviewer by principal."));
    }
    Ok(HoldAsk { hold, principals, reason, reviewer, owner, by, client_name: s("client_name") })
}

/// The ops this module answers (the agent checked the org is served).
pub fn request(relay: &Relay, op: &str, body: &Value) -> Result<Value, Refusal> {
    match op {
        "api-compliance-read" => relay.hub.api_compliance_read(body),
        "api-hold" => hold(relay, body),
        "api-hold-status" => status(relay, body),
        _ => Err(Refusal::of("fleet-op")),
    }
}

/// 2.3 item 1: the served orgs whose archive address this relay holds.
pub fn archive_orgs(relay: &Relay) -> Vec<String> {
    relay.hub.api_hello_heads().as_object().map(|o| o.keys().filter(|org| cm::archive_known(relay, org)).cloned().collect()).unwrap_or_default()
}

fn refusal_of(e: E) -> Refusal {
    match e {
        E::Coded(status, code, why) => Refusal::new(status, code, &why),
        other => bad(&other.message()),
    }
}

fn org_of(body: &Value) -> String {
    body.get("org").and_then(Value::as_str).unwrap_or_default().to_string()
}

/// The org policy's archive, and its reviewers.
fn archive_of(relay: &Relay, org: &str) -> (bool, Vec<String>) {
    let policy = cm::ai_policy(relay, org);
    let present = policy.get("archive").and_then(Value::as_object).is_some_and(|a| !a.is_empty());
    let reviewers = policy.get("archive_reviewers").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect();
    (present, reviewers)
}

/// 2.5 `api-hold`: `{relay_hold, archive: waiting | none, request?}`. 409 `reviewers` when the named reviewer does not
/// fit the org's archive (named without one, missing with one, not in `archive_reviewers`, or the client's owner);
/// 409 `holds-off`; 403 `not-covered`.
fn hold(relay: &Relay, body: &Value) -> Result<Value, Refusal> {
    let org = org_of(body);
    let h = hold_of(body.get("hold"))?;
    let (archive, reviewers) = archive_of(relay, &org);
    let fits = match (&h.reviewer, archive) {
        (Some(r), true) => reviewers.contains(r) && *r != h.owner,
        (None, false) => true,
        _ => false,
    };
    if !fits {
        return Err(Refusal::new(409, "reviewers", "The reviewer does not fit the organization's archive."));
    }
    let chain = relay.api_audit();
    let relay_hold = place(&relay.hub, &org, &h, |e| match &chain {
        Some(a) => a.record(&org, e, crate::meet_json::now() as i64).map(|_| ()).map_err(|err| err.message),
        None => Err("no chain".into()),
    })?;
    let mut out = json!({ "relay_hold": relay_hold, "archive": if archive { "waiting" } else { "none" } });
    if archive && body.get("ask_reviewer") == Some(&Value::Bool(true)) && cm::archive_known(relay, &org) {
        if let Some(request) = ask(relay, &org, &h)? {
            out["request"] = Value::from(request);
        }
    }
    Ok(out)
}

/// 5.2.3 step 2 on this relay: the hold checked, then for a new hold `compliance.hold.placed` appended to the org's
/// chain by `audit`, and only then the hold kept (state.json synced). 503 `audit-unavailable`, nothing kept, when the
/// append fails; the console asks again. A hold kept before is not audited again.
fn place(hub: &Hub, org: &str, h: &HoldAsk, audit: impl FnOnce(Value) -> Result<(), String>) -> Result<String, Refusal> {
    let plan = hub.pc_holds_prepare_api(org, &h.hold, &h.principals, &h.reason, &h.by).map_err(refusal_of)?;
    if matches!(plan, ApiHold::New(_)) {
        let e = json!({ "action": "compliance.hold.placed", "result": "ok", "hold": h.hold, "relay_hold": plan.id(), "count": h.principals.len() });
        if let Err(why) = audit(e) {
            crate::meet::log_error(&format!("api audit org={org} action=compliance.hold.placed: {why}"));
            return Err(Refusal::new(503, "audit-unavailable", "The audit log cannot record this hold now; try again later."));
        }
    }
    hub.pc_holds_commit_api(plan).map(|(id, _)| id).map_err(refusal_of)
}

fn asks_path(relay: &Relay, org: &str) -> Option<PathBuf> {
    let dir = relay.settings.state_dir.trim();
    (!dir.is_empty()).then(|| PathBuf::from(dir).join(DIR).join(org).join(ASKS))
}

fn load(path: Option<&PathBuf>) -> Vec<Obj> {
    let text = path.and_then(|p| std::fs::read_to_string(p).ok()).unwrap_or_default();
    crate::codec::parse_json(&text).and_then(|v| v.get("asks").and_then(Value::as_array).cloned()).unwrap_or_default().into_iter().filter_map(|a| a.as_object().cloned()).collect()
}

fn save(path: Option<&PathBuf>, asks: &mut Vec<Obj>) -> Result<(), Refusal> {
    let Some(path) = path else { return Ok(()) };
    if asks.len() > ASKS_MAX {
        // the oldest settled asks go first
        let mut extra = asks.len() - ASKS_MAX;
        asks.retain(|a| {
            let drop = extra > 0 && a.contains_key("outcome");
            extra -= usize::from(drop);
            !drop
        });
    }
    let io = |e: String| Refusal::new(500, "io", &e);
    if let Some(dir) = path.parent() {
        crate::store::make_dir(dir).map_err(|e| io(e.to_string()))?;
    }
    let text = crate::codec::stringify(&json!({ "v": 1, "asks": asks }));
    crate::fleet_local::write_durable(path, text.as_bytes()).map_err(io)
}

/// 5.2.3 step 3: the reviewer's ask of an API hold, made once (its request id), kept durably before it is answered.
/// None when the request book cannot take it now (the console asks again).
fn ask(relay: &Relay, org: &str, h: &HoldAsk) -> Result<Option<String>, Refusal> {
    let reviewer = h.reviewer.clone().unwrap_or_default();
    let path = asks_path(relay, org);
    let _one = ASKS_LOCK.lock();
    let mut asks = load(path.as_ref());
    if let Some(a) = asks.iter().find(|a| a.get("hold").and_then(Value::as_str) == Some(h.hold.as_str())) {
        return Ok(a.get("request").and_then(Value::as_str).map(str::to_string));
    }
    let Some(book) = cm::request_book(relay) else { return Ok(None) };
    let body = ai::hold_body(&h.principals, &h.reason, &reviewer);
    let target = json!({ "principal": reviewer, "org": org, "op": "hold", "label": ai::HOLD_LABEL, "body": body });
    let words = format!("{} (requested by API client {}, owner {})", h.reason, h.client_name, h.owner);
    let t = crate::codec::now_ms();
    let id = match book.new_request(&h.by, AI_REVIEWER_KIND, target.clone(), &words, t) {
        Ok(r) => r.get("id").and_then(Value::as_str).map(str::to_string),
        // the same ask already waits (an asks.json lost with its state folder): that one
        Err(_) => book.requests_waiting("meet.ai.", t).into_iter().find(|r| r.get("kind").and_then(Value::as_str) == Some(AI_REVIEWER_KIND) && r.get("target") == Some(&target)).and_then(|r| r.get("id").and_then(Value::as_str).map(str::to_string)),
    };
    let Some(id) = id else { return Ok(None) };
    asks.push(obj([("hold", Value::from(h.hold.clone())), ("request", Value::from(id.clone())), ("reviewer", Value::from(reviewer)), ("body", body), ("at", Value::from(t / 1000))]));
    save(path.as_ref(), &mut asks)?;
    Ok(Some(id))
}

fn api_e(e: ApiError) -> E {
    E::Status(e.status, e.message, false)
}

/// `POST /v1/admin/console/requests/sign` for an API hold's ask (`console_meet::ai_request_signed`, the request
/// found waiting and its principal checked): the signed body to the archive's `POST /v1/holds`, the outcome kept for
/// `api-hold-status`, the request done.
pub fn ask_signed(relay: &Relay, book: &Console, who: &Identity, request: &Value, sig: Option<&Value>, t: i64) -> R<Obj> {
    let id = request.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
    let target = request.get("target").cloned().unwrap_or(Value::Null);
    let org = target.get("org").and_then(Value::as_str).unwrap_or_default().to_string();
    let path = asks_path(relay, &org);
    let (hold, body) = {
        let _one = ASKS_LOCK.lock();
        let asks = load(path.as_ref());
        let a = asks.iter().find(|a| a.get("request").and_then(Value::as_str) == Some(id.as_str()) && !a.contains_key("outcome")).ok_or_else(|| E::NotFound(NO_REQUEST.into()))?;
        (a.get("hold").and_then(Value::as_str).unwrap_or_default().to_string(), a.get("body").cloned().unwrap_or(Value::Null))
    };
    let sig = sig.ok_or_else(|| E::Bad("sig is {ts, sig}".into()))?;
    let ts = sig.get("ts").and_then(Value::as_i64).ok_or_else(|| E::Bad("sig is {ts, sig}".into()))?;
    let signed = ai::signed_body(&body, ts, sig.get("sig").and_then(Value::as_str).unwrap_or(""), t.div_euclid(1000)).map_err(api_e)?;
    book.observe_requests(AI_REVIEWER_KIND, &who.principal, t, &|x: &Value| *x == target);
    let (outcome, error) = match cm::archive_call(relay, &org, "POST", "/v1/holds", Some(&signed)) {
        Ok(_) => ("placed", None),
        Err(e) => ("failed", Some(e.message)),
    };
    {
        let _one = ASKS_LOCK.lock();
        let mut asks = load(path.as_ref());
        if let Some(a) = asks.iter_mut().find(|a| a.get("request").and_then(Value::as_str) == Some(id.as_str())) {
            a.insert("outcome".into(), Value::from(outcome));
            if let Some(e) = &error {
                a.insert("error".into(), Value::from(e.clone()));
            }
        }
        save(path.as_ref(), &mut asks).map_err(|r| E::Internal(r.error))?;
    }
    crate::meet::log_info(&format!("api hold org={org} hold={hold} archive={outcome} reviewer={}", who.principal));
    let mut out = obj([("ok", Value::Bool(true)), ("hold", Value::from(hold)), ("archive", Value::from(outcome))]);
    if let Some(e) = error {
        out.insert("error".into(), Value::from(e));
    }
    Ok(out)
}

/// 2.5 `api-hold-status {org, hold}`: `{relay: placed | released, archive: waiting | placed | declined | failed |
/// none}`; 404 `not-found` when this relay holds nothing for the hold.
fn status(relay: &Relay, body: &Value) -> Result<Value, Refusal> {
    let org = org_of(body);
    let hold = body.get("hold").and_then(Value::as_str).filter(|h| hold_id_ok(h)).ok_or_else(|| bad("hold is a hold id."))?;
    let released = relay.hub.pc_api_hold_released(hold).ok_or_else(|| Refusal::new(404, "not-found", "This relay holds nothing for that hold."))?;
    let asked = {
        let _one = ASKS_LOCK.lock();
        load(asks_path(relay, &org).as_ref()).into_iter().find(|a| a.get("hold").and_then(Value::as_str) == Some(hold))
    };
    let archive = match asked {
        Some(a) => match a.get("outcome").and_then(Value::as_str) {
            Some(o) => o.to_string(),
            None => {
                let request = a.get("request").and_then(Value::as_str).unwrap_or_default();
                let state = cm::request_book(relay).and_then(|b| b.request_by_id(request, crate::codec::now_ms())).and_then(|r| r.get("state").and_then(Value::as_str).map(str::to_string));
                match state.as_deref() {
                    Some("waiting" | "done") => "waiting".into(),
                    Some("declined") => "declined".into(),
                    _ => "failed".into(),
                }
            }
        },
        None if archive_of(relay, &org).0 => "waiting".into(),
        None => "none".into(),
    };
    Ok(json!({ "relay": if released { "released" } else { "placed" }, "archive": archive }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record() -> Value {
        json!({"hold": "h_9f8e7d6c5b4a3921", "on": "people", "principals": ["ann@acme.example", "bo@acme.example"], "reason": "Matter 2026-114",
               "reviewer": "rita@acme.example", "client": "c_0a1b2c3d4e5f6071", "client_name": "ediscovery-meta", "owner": "lee@acme.example",
               "by": "ediscovery-meta@apps.acme.example", "at": 1795700000})
    }

    #[test]
    fn the_hold_record_is_checked() {
        let h = hold_of(Some(&record())).unwrap();
        assert_eq!((h.hold.as_str(), h.principals.len(), h.reviewer.as_deref()), ("h_9f8e7d6c5b4a3921", 2, Some("rita@acme.example")));
        for (k, v) in [("hold", json!("h_short")), ("on", json!("conversations")), ("principals", json!([])), ("reason", json!("")), ("reason", json!("x".repeat(501))), ("owner", json!("nobody"))] {
            let mut r = record();
            r[k] = v;
            assert_eq!(hold_of(Some(&r)).err().map(|e| e.code), Some("bad-request".to_string()), "{k}");
        }
        let mut no_reviewer = record();
        no_reviewer.as_object_mut().unwrap().remove("reviewer");
        assert_eq!(hold_of(Some(&no_reviewer)).unwrap().reviewer, None);
    }

    /// 5.2.3: `compliance.hold.placed` is appended before the hold is kept; a failed append keeps nothing.
    #[test]
    fn a_hold_is_kept_only_after_its_audit_is_appended() {
        let dir = std::env::temp_dir().join(format!("lucid-api-holds-relay-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let hub = Hub::new(Some(dir.clone()), &[], 168.0, 30.0, 365.0, None, std::sync::Arc::new(crate::meet_console::LinkStats::new()));
        hub.pc_test_holds("acme", "acme.example");
        let h = hold_of(Some(&record())).unwrap();
        let r = place(&hub, "acme", &h, |_| Err("disk full".into())).unwrap_err();
        assert_eq!((r.status, r.code.as_str()), (503, "audit-unavailable"));
        assert_eq!(hub.pc_api_hold_released(&h.hold), None, "nothing kept");
        let seen = Mutex::new(Vec::new());
        let id = place(&hub, "acme", &h, |e| {
            seen.lock().push(e);
            Ok(())
        })
        .unwrap();
        assert_eq!(hub.pc_api_hold_released(&h.hold), Some(false), "kept after the append");
        let seen = seen.into_inner();
        assert_eq!((seen.len(), &seen[0]["action"], &seen[0]["relay_hold"]), (1, &json!("compliance.hold.placed"), &json!(id)));
        // the console's retry: the same relay hold, not audited again
        assert_eq!(place(&hub, "acme", &h, |_| panic!("audited twice")).unwrap(), id);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn asks_are_kept_and_the_oldest_settled_go_first() {
        let dir = std::env::temp_dir().join(format!("lucid-api-asks-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = Some(dir.join("acme").join(ASKS));
        let mut asks: Vec<Obj> = (0..ASKS_MAX + 2).map(|i| obj([("hold", Value::from(format!("h_{i:016x}"))), ("request", Value::from(format!("rq_{i}")))])).collect();
        asks[0].insert("outcome".into(), Value::from("placed"));
        asks[5].insert("outcome".into(), Value::from("failed"));
        save(path.as_ref(), &mut asks).unwrap();
        let back = load(path.as_ref());
        assert_eq!(back.len(), ASKS_MAX);
        assert!(back.iter().all(|a| !a.contains_key("outcome")), "the settled ones went first");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
