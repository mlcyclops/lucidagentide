// Contract API-1 revision 4 (docs/api/contract-r4-1b.md) 2.5, 5.3.3 steps 1 to 7 and 9.3, the archive relay's end of
// API exports: `api-export`, `api-export-status` and `api-export-cancel` (wire contract `api-1b5-contract.md` A, B, C).
//
// The archive trusts nothing the console says beyond the request fields (Rev4Review R4-2). Before every export call
// the relay hands the archive this relay's own state for the org (`POST /v1/exports/state`): its serving pinned
// signed `api` map, the signed AI map its org policy names (absent when it holds none), the folded journal it applied
// and the owners of the map's clients it holds inactive. It sends it again after a new pin or an applied journal entry
// (`state_changed`, from `meet.rs`) and after a suspended owner (`state_changed_here`, from `meet_ops.rs`).
//
// `api-export {org, job}` passes only the request fields to `POST /v1/exports`, then asks each named reviewer's device
// to sign the archive's release body (`meet.ai.reviewer-sign`, op `export_release`, the reviewer's sealed preview
// beside the body as `preview_wraps`). The job and its asks are kept durably in
// `<state>/api-compliance/<org>/exports.json` (written and flushed before the answer), so they survive a restart; the
// console only ever learns `{"state": "waiting"}` (no counts, R4-5). Each signature goes to `POST /v1/exports/release`
// (`ask_signed`, handed here by `console_meet::ai_request_signed`). Once the archive counts two releases it builds and
// seals the package; one transfer worker per job then sends the seal (`api-export-seal`) and each part
// (`api-export-part`) to the console over the fleet channel (`fleet_agent::console_call`), and acknowledges a part to
// the archive only after the console did. The console's status poll restarts a worker that stopped.

use crate::api_compliance::{principal_ok, HOLD_REASON_MAX, MATTER_MAX};
use crate::api_holds_relay::DIR;
use crate::api_map::{TightenEntry, CEILINGS};
use crate::console::{ApiError, Console};
use crate::console_ai as ai;
use crate::console_meet::{self as cm, AI_REVIEWER_KIND, NO_REQUEST};
use crate::fleet_wire::Refusal;
use crate::meet::{Identity, Relay, E, R};
use crate::meet_json::{obj, Obj};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

/// The reviewer-sign op and label of an export release (contract B, 5.3.4).
pub const OP: &str = "export_release";
pub const LABEL: &str = "lucid-meet-archive-export-release-v1";
const EXPORTS: &str = "exports.json";
/// Jobs kept per org (the oldest ended ones go first).
const EXPORTS_MAX: usize = 500;
/// 5.3.2 `reviewers`: 2 to 5; two distinct releases free a job.
const REVIEWERS_MIN: usize = 2;
const REVIEWERS_MAX: usize = 5;
/// 5.3.6: at most 12800 parts of 4 MiB of ciphertext (plus the 16 byte tag).
const PARTS_MAX: u64 = 12_800;
const PART_MAX_BYTES: usize = 4 * 1024 * 1024 + 16;
/// How long the console has to fsync and acknowledge the seal and a part.
const SEAL_TIMEOUT: Duration = Duration::from_secs(60);
const PART_TIMEOUT: Duration = Duration::from_secs(120);
/// A worker started at release waits for the package this long, asking this often.
const BUILD_WAIT: Duration = Duration::from_secs(6 * 3600);
const BUILD_POLL: Duration = Duration::from_secs(15);
/// The relay states that end a job (contract C).
const ENDS: [&str; 5] = ["ready", "failed", "canceled", "refused", "expired"];
/// The archive status keys the console gets as they are.
const PASSED: [&str; 6] = ["released_by", "preview", "parts", "zip_bytes", "excluded_ceiling", "code"];

/// One read-modify-write of an `exports.json` at a time (taken before the request book's lock, never after).
static EXPORTS_LOCK: Mutex<()> = Mutex::new(());
/// The jobs whose transfer worker runs: `(org, job)`.
static WORKERS: Mutex<BTreeSet<(String, String)>> = Mutex::new(BTreeSet::new());
/// The relay of this process, for the threads the signing route starts (it only holds a `&Relay`).
static RELAY: Mutex<Weak<Relay>> = Mutex::new(Weak::new());

fn bad(why: &str) -> Refusal {
    Refusal::new(400, "bad-request", why)
}

fn not_found() -> Refusal {
    Refusal::new(404, "not-found", "This relay holds no such export.")
}

fn bad_answer() -> Refusal {
    Refusal::new(502, "archive-answer", "The archive's answer does not read.")
}

fn s<'a>(o: &'a Obj, k: &str) -> &'a str {
    o.get(k).and_then(Value::as_str).unwrap_or_default()
}

fn n(o: &Obj, k: &str) -> u64 {
    o.get(k).and_then(Value::as_u64).unwrap_or(0)
}

fn org_of(body: &Value) -> String {
    body.get("org").and_then(Value::as_str).unwrap_or_default().to_string()
}

/// `<prefix>` and 16 lowercase hex.
fn id_ok(v: &str, prefix: &str) -> bool {
    v.len() == prefix.len() + 16 && v.starts_with(prefix) && v[prefix.len()..].bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Printable text of 1 to `max` characters.
fn text_ok(v: &str, max: usize) -> bool {
    (1..=max).contains(&v.chars().count()) && crate::meet_json::printable(v) && !v.trim().is_empty()
}

// ── the request (5.3.2, contract A.2) ───────────────────────────────────────────────────────────────────────────

/// The `job` of an `api-export` request, checked, as exactly the request fields: `{job, client, matter, reason, scope,
/// reviewers, requested_at}`. Anything else the console's record carries (owner, recipient, limits) is dropped: the
/// archive derives those itself.
pub fn request_of(v: Option<&Value>) -> Result<Obj, Refusal> {
    let o = v.and_then(Value::as_object).ok_or_else(|| bad("job is the export request."))?;
    let job = o.get("job").and_then(Value::as_str).unwrap_or_default();
    let client = o.get("client").and_then(Value::as_str).unwrap_or_default();
    if !id_ok(job, "j_") || !id_ok(client, "c_") {
        return Err(bad("job names the job and its client by id."));
    }
    let matter = o.get("matter").and_then(Value::as_str).unwrap_or_default();
    let reason = o.get("reason").and_then(Value::as_str).unwrap_or_default();
    if !text_ok(matter, MATTER_MAX) || !text_ok(reason, HOLD_REASON_MAX) {
        return Err(bad("matter is 1 to 128 characters and reason 1 to 500."));
    }
    let scope = o.get("scope").filter(|x| x.is_object()).ok_or_else(|| bad("scope is the export's scope."))?;
    let reviewers: Vec<&str> = o.get("reviewers").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect();
    let listed = o.get("reviewers").and_then(Value::as_array).map_or(0, Vec::len);
    let unique: BTreeSet<&str> = reviewers.iter().copied().collect();
    if !(REVIEWERS_MIN..=REVIEWERS_MAX).contains(&listed) || reviewers.len() != listed || unique.len() != listed || !reviewers.iter().all(|r| principal_ok(r)) {
        return Err(bad("reviewers names 2 to 5 different people."));
    }
    let requested_at = o.get("requested_at").and_then(Value::as_i64).filter(|t| *t > 0).ok_or_else(|| bad("requested_at is a time."))?;
    Ok(obj([
        ("job", Value::from(job)),
        ("client", Value::from(client)),
        ("matter", Value::from(matter)),
        ("reason", Value::from(reason)),
        ("scope", scope.clone()),
        ("reviewers", Value::from(reviewers)),
        ("requested_at", Value::from(requested_at)),
    ]))
}

/// The body of `POST /v1/exports`: the org and the request fields, nothing else.
pub fn archive_request(org: &str, req: &Obj) -> Value {
    let mut b = req.clone();
    b.insert("org".into(), Value::from(org));
    Value::Object(b)
}

fn reviewers_of(rec: &Obj) -> Vec<String> {
    rec.get("request").and_then(|r| r.get("reviewers")).and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect()
}

// ── the archive state (contract A.1) ────────────────────────────────────────────────────────────────────────────

fn ceiling_rank(c: &str) -> usize {
    CEILINGS.iter().position(|x| *x == c).unwrap_or(usize::MAX)
}

/// The A.1 `journal` of the org's active entries: suspended clients, dropped scopes, the lowest lowered ceiling and
/// the limits (each `client_limit` target without `client`, later entries over earlier ones) per client, `api_off`.
pub fn journal_of(entries: &[TightenEntry], api_off: bool) -> Value {
    let mut suspended = BTreeSet::new();
    let mut dropped: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut ceilings: BTreeMap<String, String> = BTreeMap::new();
    let mut limits: BTreeMap<String, Obj> = BTreeMap::new();
    for e in entries {
        let t = &e.target;
        let client = t.get("client").and_then(Value::as_str).unwrap_or_default().to_string();
        match e.action.as_str() {
            "client_suspend" => {
                if let Some(c) = t.as_str() {
                    suspended.insert(c.to_string());
                }
            }
            "client_drop_scope" => {
                if let Some(scope) = t.get("scope").and_then(Value::as_str) {
                    dropped.entry(client).or_default().insert(scope.to_string());
                }
            }
            "client_lower_ceiling" => {
                if let Some(c) = t.get("ceiling").and_then(Value::as_str) {
                    let held = ceilings.entry(client).or_insert_with(|| c.to_string());
                    if ceiling_rank(c) < ceiling_rank(held) {
                        *held = c.to_string();
                    }
                }
            }
            "client_limit" => {
                if let Some(o) = t.as_object() {
                    let l = limits.entry(client).or_default();
                    for (k, v) in o.iter().filter(|(k, _)| k.as_str() != "client") {
                        l.insert(k.clone(), v.clone());
                    }
                }
            }
            _ => {}
        }
    }
    // ReviewW3: the entries themselves (id and tseq), so the archive merges a later state for the same map
    // monotonically and lifts a restriction only when a newer signed map folds or clears its entry. The console-only
    // `client_lower_caps` never reaches a relay; the console refuses new exports while one is active (`api_exports`).
    let ids: Vec<Value> = entries.iter().map(|e| json!({ "id": e.id, "tseq": e.tseq, "action": e.action, "target": e.target })).collect();
    json!({ "suspended": suspended, "dropped_scopes": dropped, "ceilings": ceilings, "limits": limits, "api_off": api_off, "entries": ids })
}

/// The owners of the map's clients that `inactive` says are inactive, sorted, once each.
pub fn inactive_owners(clients: &[Value], inactive: &dyn Fn(&str) -> bool) -> Vec<String> {
    let owners: BTreeSet<&str> = clients.iter().filter_map(|c| c.get("owner").and_then(Value::as_str)).filter(|o| !o.is_empty() && inactive(o)).collect();
    owners.into_iter().map(str::to_string).collect()
}

/// The A.1 body.
pub fn state_body(org: &str, api_map: &Obj, ai_map: Option<Value>, journal: Value, owners: Vec<String>) -> Value {
    let mut b = obj([("org", Value::from(org)), ("api_map", Value::Object(api_map.clone())), ("journal", journal), ("inactive_owners", Value::from(owners))]);
    if let Some(m) = ai_map {
        b.insert("ai_map".into(), m);
    }
    Value::Object(b)
}

/// This relay's own state for the org, from its own store only.
fn state_of(relay: &Relay, org: &str) -> Result<Value, Refusal> {
    let store = relay.hub.api_org_snapshot(org).ok_or_else(|| Refusal::new(403, "org-not-served", "This relay does not serve that organization."))?;
    let map = store.get(org, "").ok_or_else(|| Refusal::new(503, "archive-state", "This relay holds no serving api map for the organization."))?;
    let journal = journal_of(store.active(org), store.is_off(org));
    let dir = crate::api_scim::state_dir(&relay.settings.state_dir);
    let owners = inactive_owners(store.clients(org), &|o: &str| dir.as_deref().is_some_and(|d| crate::api_scim::owner_inactive_in(d, org, o)) || !relay.hub.api_owner_active(o));
    let policy = cm::ai_policy(relay, org);
    let sha = policy.get("ai").and_then(|a| a.get("map_sha256")).and_then(Value::as_str).unwrap_or_default();
    let ai_map = if sha.is_empty() { None } else { relay.hub.pc_ai_get(org, sha).ok().and_then(|o| o.get("signed").cloned()) };
    Ok(state_body(org, &map.wire, ai_map, journal, owners))
}

/// A.1: the state to the archive. The jobs the new state canceled lose their open asks.
fn push_state(relay: &Relay, org: &str) -> Result<(), Refusal> {
    let body = state_of(relay, org)?;
    let answer = archive_json(relay, org, "POST", "/v1/exports/state", Some(&body))?;
    for job in answer.get("canceled").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
        let ids = update(relay, org, job, |rec| {
            if !ended(rec) {
                rec.insert("state".into(), Value::from("canceled"));
            }
            ask_ids(rec)
        })?;
        close_asks(relay, &ids.unwrap_or_default());
    }
    Ok(())
}

fn attach(relay: &Arc<Relay>) {
    let mut held = RELAY.lock();
    if !std::ptr::eq(held.as_ptr(), Arc::as_ptr(relay)) {
        *held = Arc::downgrade(relay);
    }
}

fn arc_of(relay: &Relay) -> Option<Arc<Relay>> {
    RELAY.lock().upgrade().filter(|r| std::ptr::eq(Arc::as_ptr(r), relay))
}

/// 5.3.3: the relay pinned a new map or applied a journal entry for the org: the state goes to its archive on a
/// thread of its own (a refusal is logged; the next export call sends it again).
pub fn state_changed(relay: &Arc<Relay>, org: &str) {
    attach(relay);
    if org.is_empty() || !cm::archive_known(relay, org) {
        return;
    }
    let (r, o) = (relay.clone(), org.to_string());
    let spawned = std::thread::Builder::new().name("api-export-state".into()).spawn(move || {
        if let Err(e) = push_state(&r, &o) {
            crate::meet::log_warn(&format!("api export state org={o} code={} why={}", e.code, e.error));
        }
    });
    if let Err(e) = spawned {
        crate::meet::log_error(&format!("api export state org={org}: no thread ({e})"));
    }
}

/// `state_changed` from a route that holds only the relay (an owner suspended). Nothing until this relay served an
/// export request or a map since it started; its next export call sends the state anyway.
pub fn state_changed_here(relay: &Relay, org: &str) {
    if let Some(r) = arc_of(relay) {
        state_changed(&r, org);
    }
}

// ── the archive calls (contract A) ──────────────────────────────────────────────────────────────────────────────

/// An archive refusal `(status, {code, error})` as the fleet refusal.
pub fn refusal_of_answer(status: u16, bytes: &[u8]) -> Refusal {
    let v: Value = serde_json::from_slice(bytes).unwrap_or(Value::Null);
    let code = v.get("code").and_then(Value::as_str).filter(|c| (1..=64).contains(&c.len())).unwrap_or("archive");
    let error: String = v.get("error").and_then(Value::as_str).unwrap_or("The archive refused the request.").chars().take(500).collect();
    Refusal::new(status, code, &error)
}

/// One archive call: the raw answer of a success; a refusal as the archive gave it; 503 `archive-unreachable` when
/// it did not answer.
fn archive(relay: &Relay, org: &str, method: &str, path: &str, body: Option<&Value>) -> Result<Vec<u8>, Refusal> {
    let (status, bytes) = cm::archive_raw(relay, org, method, path, body).map_err(|e: ApiError| Refusal::new(503, "archive-unreachable", &format!("The archive did not answer: {}", e.message)))?;
    if status >= 400 {
        return Err(refusal_of_answer(status, &bytes));
    }
    Ok(bytes)
}

fn archive_json(relay: &Relay, org: &str, method: &str, path: &str, body: Option<&Value>) -> Result<Value, Refusal> {
    let bytes = archive(relay, org, method, path, body)?;
    serde_json::from_slice::<Value>(&bytes).ok().filter(Value::is_object).ok_or_else(bad_answer)
}

// ── exports.json ────────────────────────────────────────────────────────────────────────────────────────────────

fn exports_path(relay: &Relay, org: &str) -> Option<PathBuf> {
    let dir = relay.settings.state_dir.trim();
    (!dir.is_empty()).then(|| PathBuf::from(dir).join(DIR).join(org).join(EXPORTS))
}

fn load(path: Option<&PathBuf>) -> Vec<Obj> {
    let text = path.and_then(|p| std::fs::read_to_string(p).ok()).unwrap_or_default();
    crate::codec::parse_json(&text).and_then(|v| v.get("jobs").and_then(Value::as_array).cloned()).unwrap_or_default().into_iter().filter_map(|a| a.as_object().cloned()).collect()
}

fn save(path: Option<&PathBuf>, jobs: &mut Vec<Obj>) -> Result<(), Refusal> {
    let Some(path) = path else { return Ok(()) };
    if jobs.len() > EXPORTS_MAX {
        // the oldest ended jobs go first
        let mut extra = jobs.len() - EXPORTS_MAX;
        jobs.retain(|j| {
            let drop = extra > 0 && ended(j);
            extra -= usize::from(drop);
            !drop
        });
    }
    let io = |e: String| Refusal::new(500, "io", &e);
    if let Some(dir) = path.parent() {
        crate::store::make_dir(dir).map_err(|e| io(e.to_string()))?;
    }
    let text = crate::codec::stringify(&json!({ "v": 1, "jobs": jobs }));
    crate::fleet_local::write_durable(path, text.as_bytes()).map_err(io)
}

/// Whether the job ended (on this relay, or as the archive last reported it).
fn ended(rec: &Obj) -> bool {
    rec.get("end").is_some_and(Value::is_string) || ENDS.contains(&s(rec, "state"))
}

/// The job record as kept: the request, the archive's release body and sealed previews, the asks per reviewer, the
/// outcome of each signature, and the transfer progress.
pub fn new_record(req: &Obj, body: Obj, previews: Obj, requester: &str, words: &str, at: i64) -> Obj {
    obj([
        ("job", Value::from(s(req, "job"))),
        ("request", Value::Object(req.clone())),
        ("body", Value::Object(body)),
        ("previews", Value::Object(previews)),
        ("requester", Value::from(requester)),
        ("words", Value::from(words)),
        ("asks", json!({})),
        ("outcomes", json!({})),
        ("state", Value::from("waiting")),
        ("told", Value::Bool(false)),
        ("seal_sent", Value::Bool(false)),
        ("parts", Value::from(0)),
        ("acked", Value::from(0)),
        ("at", Value::from(at)),
    ])
}

/// A new job into the list, idempotent by job id: the index of the record (the held one when the same request came
/// again); 409 `job-exists` when the id is held for other fields.
pub fn keep_new(jobs: &mut Vec<Obj>, rec: Obj) -> Result<usize, Refusal> {
    let job = s(&rec, "job").to_string();
    if let Some(i) = jobs.iter().position(|j| s(j, "job") == job) {
        if jobs[i].get("request") != rec.get("request") {
            return Err(Refusal::new(409, "job-exists", "Another export already has this job id."));
        }
        return Ok(i);
    }
    jobs.push(rec);
    Ok(jobs.len() - 1)
}

/// `f` on the job's record under the lock, saved after; None when this relay holds no such job.
fn update<T>(relay: &Relay, org: &str, job: &str, f: impl FnOnce(&mut Obj) -> T) -> Result<Option<T>, Refusal> {
    let path = exports_path(relay, org);
    let _one = EXPORTS_LOCK.lock();
    let mut jobs = load(path.as_ref());
    let Some(rec) = jobs.iter_mut().find(|r| s(r, "job") == job) else { return Ok(None) };
    let out = f(rec);
    save(path.as_ref(), &mut jobs)?;
    Ok(Some(out))
}

fn get(relay: &Relay, org: &str, job: &str) -> Option<Obj> {
    let _one = EXPORTS_LOCK.lock();
    load(exports_path(relay, org).as_ref()).into_iter().find(|r| s(r, "job") == job)
}

// ── the reviewers' asks (contract B) ────────────────────────────────────────────────────────────────────────────

/// The reviewer-sign target of one reviewer: the archive's body with the reviewer, the reviewer's sealed preview beside
/// it (outside the signed body), carried as the archive gave it.
pub fn ask_target(org: &str, body: &Value, reviewer: &str, wraps: Value) -> Value {
    let mut b = body.as_object().cloned().unwrap_or_default();
    b.insert("reviewer".into(), Value::from(reviewer));
    json!({ "principal": reviewer, "org": org, "op": OP, "label": LABEL, "body": b, "preview_wraps": wraps })
}

fn words_of(req: &Obj, body: &Obj) -> String {
    format!(
        "Release API export {} for matter {}: {} (requested by API client {}, owner {})",
        s(req, "job"),
        s(req, "matter"),
        s(req, "reason"),
        s(body, "client_name"),
        s(body, "owner")
    )
}

/// The request ids of the job's asks.
fn ask_ids(rec: &Obj) -> Vec<String> {
    rec.get("asks").and_then(Value::as_object).map(|a| a.values().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default()
}

/// The asks still waiting in the request book end (`cancelled`); the others are left as they are.
fn close_asks(relay: &Relay, ids: &[String]) {
    if ids.is_empty() {
        return;
    }
    let Some(book) = cm::request_book(relay) else { return };
    let t = crate::codec::now_ms();
    for id in ids {
        let _ = book.requests_cancel(&json!({ "id": id }), t);
    }
}

/// The asks a waiting job lacks (the book was full, or a signature could not reach the archive), made now. Whether
/// any was made.
fn fill_asks(relay: &Relay, org: &str, rec: &mut Obj) -> bool {
    if ended(rec) || s(rec, "state") != "waiting" {
        return false;
    }
    let Some(book) = cm::request_book(relay) else { return false };
    let t = crate::codec::now_ms();
    let (requester, words) = (s(rec, "requester").to_string(), s(rec, "words").to_string());
    let body = rec.get("body").cloned().unwrap_or(Value::Null);
    let previews = rec.get("previews").and_then(Value::as_object).cloned().unwrap_or_default();
    let mut asks = rec.get("asks").and_then(Value::as_object).cloned().unwrap_or_default();
    let mut made = false;
    for r in reviewers_of(rec) {
        if asks.contains_key(&r) {
            continue;
        }
        let target = ask_target(org, &body, &r, previews.get(&r).cloned().unwrap_or_else(|| json!({})));
        let id = match book.new_request(&requester, AI_REVIEWER_KIND, target.clone(), &words, t) {
            Ok(q) => q.get("id").and_then(Value::as_str).map(str::to_string),
            // the same ask already waits (an exports.json lost with its state folder): that one
            Err(_) => book.requests_waiting("meet.ai.", t).into_iter().find(|q| q.get("kind").and_then(Value::as_str) == Some(AI_REVIEWER_KIND) && q.get("target") == Some(&target)).and_then(|q| q.get("id").and_then(Value::as_str).map(str::to_string)),
        };
        if let Some(id) = id {
            asks.insert(r, Value::from(id));
            made = true;
        }
    }
    if made {
        rec.insert("asks".into(), Value::Object(asks));
    }
    made
}

/// The client's principal in this relay's serving map (the asks are made in its name, as API hold asks are).
fn client_principal(relay: &Relay, org: &str, client: &str) -> Option<String> {
    let store = relay.hub.api_org_snapshot(org)?;
    store.clients(org).iter().find(|c| c.get("id").and_then(Value::as_str) == Some(client)).and_then(|c| c.get("principal").and_then(Value::as_str)).map(str::to_string)
}

// ── the fleet ops (contract C) ──────────────────────────────────────────────────────────────────────────────────

/// The ops this module answers (the agent checked the org is served).
pub fn request(relay: &Arc<Relay>, op: &str, body: &Value) -> Result<Value, Refusal> {
    attach(relay);
    match op {
        "api-export" => export(relay, body),
        "api-export-status" => status(relay, body),
        "api-export-cancel" => cancel(relay, body),
        _ => Err(Refusal::of("fleet-op")),
    }
}

fn job_of(body: &Value) -> Result<String, Refusal> {
    body.get("job").and_then(Value::as_str).filter(|j| id_ok(j, "j_")).map(str::to_string).ok_or_else(|| bad("job is a job id."))
}

/// 2.5 `api-export`: `{"state": "waiting"}` once the archive registered the job and the asks are kept.
fn export(relay: &Relay, body: &Value) -> Result<Value, Refusal> {
    let org = org_of(body);
    let req = request_of(body.get("job"))?;
    if !cm::archive_known(relay, &org) {
        return Err(Refusal::new(409, "no-archive", "This relay does not hold the organization's archive address."));
    }
    let job = s(&req, "job").to_string();
    let path = exports_path(relay, &org);
    let waiting = json!({ "state": "waiting" });
    {
        let _one = EXPORTS_LOCK.lock();
        let mut jobs = load(path.as_ref());
        if let Some(i) = jobs.iter().position(|j| s(j, "job") == job) {
            if jobs[i].get("request").and_then(Value::as_object) != Some(&req) {
                return Err(Refusal::new(409, "job-exists", "Another export already has this job id."));
            }
            if fill_asks(relay, &org, &mut jobs[i]) {
                save(path.as_ref(), &mut jobs)?;
            }
            return Ok(waiting);
        }
    }
    push_state(relay, &org)?;
    let answer = archive_json(relay, &org, "POST", "/v1/exports", Some(&archive_request(&org, &req)))?;
    let release = answer.get("body").and_then(Value::as_object).filter(|b| s(b, "job") == job && s(b, "op") == OP && b.get("reviewer").is_none()).cloned().ok_or_else(bad_answer)?;
    let previews = answer.get("previews").and_then(Value::as_object).cloned().unwrap_or_default();
    let client = s(&req, "client").to_string();
    let requester = client_principal(relay, &org, &client).unwrap_or(client);
    let words = words_of(&req, &release);
    let rec = new_record(&req, release, previews, &requester, &words, crate::codec::now_ms() / 1000);
    let _one = EXPORTS_LOCK.lock();
    let mut jobs = load(path.as_ref());
    let i = keep_new(&mut jobs, rec)?;
    fill_asks(relay, &org, &mut jobs[i]);
    save(path.as_ref(), &mut jobs)?;
    crate::meet::log_info(&format!("api export org={org} job={job} state=waiting asks={}", ask_ids(&jobs[i]).len()));
    Ok(waiting)
}

/// How many named reviewers can still release: those whose release the archive took or is taking, and those whose
/// ask still waits (or is not known: no book, or not made yet). A declined, failed, expired or cancelled ask, or a
/// signature the archive refused, cannot.
pub fn possible(reviewers: &[String], outcomes: &Obj, ask_states: &BTreeMap<String, Option<String>>) -> usize {
    reviewers
        .iter()
        .filter(|r| match outcomes.get(r.as_str()).and_then(|o| o.get("result")).and_then(Value::as_str) {
            Some("accepted" | "posting") => true,
            Some(_) => false,
            None => matches!(ask_states.get(r.as_str()), None | Some(None)) || ask_states.get(r.as_str()).is_some_and(|x| x.as_deref() == Some("waiting")),
        })
        .count()
}

fn possible_of(relay: &Relay, rec: &Obj) -> usize {
    let book = cm::request_book(relay);
    let t = crate::codec::now_ms();
    let asks = rec.get("asks").and_then(Value::as_object).cloned().unwrap_or_default();
    let reviewers = reviewers_of(rec);
    let states: BTreeMap<String, Option<String>> = reviewers
        .iter()
        .map(|r| {
            let state = match (&book, asks.get(r).and_then(Value::as_str)) {
                (Some(b), Some(id)) => b.request_by_id(id, t).and_then(|q| q.get("state").and_then(Value::as_str).map(str::to_string)),
                _ => None,
            };
            (r.clone(), state)
        })
        .collect();
    let outcomes = rec.get("outcomes").and_then(Value::as_object).cloned().unwrap_or_default();
    possible(&reviewers, &outcomes, &states)
}

/// Contract C: the relay state of an archive state. `possible` (waiting only) the reviewers who can still release;
/// `acked` the parts the console acknowledged.
pub fn relay_state(archive: &str, parts: Option<u64>, acked: u64, possible: Option<usize>) -> &'static str {
    match archive {
        "waiting" if possible.is_some_and(|p| p < REVIEWERS_MIN) => "refused",
        "waiting" => "waiting",
        "released" => "released",
        "building" => "building",
        "sealed" if parts.is_some_and(|p| p > 0 && acked >= p) => "ready",
        "sealed" => "transferring",
        "done" => "ready",
        "canceled" => "canceled",
        "refused" => "refused",
        "expired" => "expired",
        _ => "failed",
    }
}

/// The answer of a job this relay ended.
fn ended_answer(rec: &Obj) -> Value {
    let releases = rec.get("outcomes").and_then(Value::as_object).map_or(0, |o| o.values().filter(|x| x.get("result").and_then(Value::as_str) == Some("accepted")).count());
    let mut out = json!({ "state": s(rec, "end"), "releases": releases });
    if let Some(c) = rec.get("code").filter(|c| c.is_string()) {
        out["code"] = c.clone();
    }
    out
}

/// A.8: the archive learns the end of a job this relay ended (best effort: the next status or cancel tries again).
fn tell_archive(relay: &Relay, org: &str, job: &str, reason: &str) {
    let _ = push_state(relay, org);
    let told = match archive_json(relay, org, "POST", &format!("/v1/exports/{job}/cancel"), Some(&json!({ "reason": reason }))) {
        Ok(_) => true,
        Err(r) => r.status == 404,
    };
    if told {
        if let Err(r) = update(relay, org, job, |rec| rec.insert("told".into(), Value::Bool(true))) {
            crate::meet::log_error(&format!("api export org={org} job={job}: {}", r.error));
        }
    }
}

/// 2.5 `api-export-status`.
fn status(relay: &Arc<Relay>, body: &Value) -> Result<Value, Refusal> {
    let org = org_of(body);
    let job = job_of(body)?;
    let rec = get(relay, &org, &job).ok_or_else(not_found)?;
    if rec.get("end").is_some_and(Value::is_string) {
        if rec.get("told") != Some(&Value::Bool(true)) {
            tell_archive(relay, &org, &job, &format!("the job ended on the relay: {}", s(&rec, "end")));
        }
        return Ok(ended_answer(&rec));
    }
    push_state(relay, &org)?;
    let a = archive_json(relay, &org, "GET", &format!("/v1/exports/{job}"), None)?;
    let archive_state = a.get("state").and_then(Value::as_str).unwrap_or_default();
    let maybe = (archive_state == "waiting").then(|| possible_of(relay, &rec));
    let acked = n(&rec, "acked").max(a.get("acked").and_then(Value::as_u64).unwrap_or(0));
    let state = relay_state(archive_state, a.get("parts").and_then(Value::as_u64), acked, maybe);
    let mut out = json!({ "state": state, "releases": a.get("releases").and_then(Value::as_u64).unwrap_or(0) });
    for k in PASSED {
        if let Some(v) = a.get(k).filter(|v| !v.is_null()) {
            out[k] = v.clone();
        }
    }
    let ids = update(relay, &org, &job, |r| {
        r.insert("state".into(), Value::from(state));
        if state == "refused" && archive_state == "waiting" {
            r.insert("end".into(), Value::from("refused"));
            r.insert("told".into(), Value::Bool(false));
        }
        if state == "waiting" {
            fill_asks(relay, &org, r);
        }
        if ENDS.contains(&state) && state != "ready" {
            ask_ids(r)
        } else {
            Vec::new()
        }
    })?
    .unwrap_or_default();
    close_asks(relay, &ids);
    if state == "refused" && archive_state == "waiting" {
        tell_archive(relay, &org, &job, "fewer than two reviewers can still release");
    }
    if state == "transferring" {
        ensure_worker(relay.clone(), &org, &job);
    }
    Ok(out)
}

/// 2.5 `api-export-cancel`: `{"state": "canceled"}`, the asks done, the archive told (now, or at the next status).
fn cancel(relay: &Relay, body: &Value) -> Result<Value, Refusal> {
    let org = org_of(body);
    let job = job_of(body)?;
    let reason: String = body.get("reason").and_then(Value::as_str).unwrap_or_default().chars().take(HOLD_REASON_MAX).collect();
    let held = update(relay, &org, &job, |rec| {
        if !rec.get("end").is_some_and(Value::is_string) {
            rec.insert("end".into(), Value::from("canceled"));
            rec.insert("told".into(), Value::Bool(false));
        }
        (ask_ids(rec), rec.get("told") == Some(&Value::Bool(true)))
    })?;
    let reason = if reason.trim().is_empty() { "canceled by the console".to_string() } else { reason };
    match held {
        Some((ids, told)) => {
            close_asks(relay, &ids);
            if !told {
                tell_archive(relay, &org, &job, &reason);
            }
        }
        // a job this relay never registered: the archive is told if it holds one
        None => {
            let _ = archive(relay, &org, "POST", &format!("/v1/exports/{job}/cancel"), Some(&json!({ "reason": reason })));
        }
    }
    crate::meet::log_info(&format!("api export org={org} job={job} state=canceled"));
    Ok(json!({ "state": "canceled" }))
}

fn api_e(e: ApiError) -> E {
    E::Status(e.status, e.message, false)
}

/// `POST /v1/admin/console/requests/sign` for an export release ask (`console_meet::ai_request_signed`, the request
/// found waiting and its principal checked): the signed body to the archive's `POST /v1/exports/release`, the outcome
/// kept for `api-export-status`, the request done. Once the archive counts two releases the other asks end and the
/// transfer worker starts.
pub fn ask_signed(relay: &Relay, book: &Console, who: &Identity, request: &Value, sig: Option<&Value>, t: i64) -> R<Obj> {
    let id = request.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
    let target = request.get("target").cloned().unwrap_or(Value::Null);
    let org = target.get("org").and_then(Value::as_str).unwrap_or_default().to_string();
    let reviewer = who.principal.clone();
    let path = exports_path(relay, &org);
    let (job, body) = {
        let _one = EXPORTS_LOCK.lock();
        let jobs = load(path.as_ref());
        let rec = jobs
            .iter()
            .find(|r| r.get("asks").and_then(|a| a.get(&reviewer)).and_then(Value::as_str) == Some(id.as_str()) && !ended(r) && !r.get("outcomes").is_some_and(|o| o.get(&reviewer).is_some()))
            .ok_or_else(|| E::NotFound(NO_REQUEST.into()))?;
        let mut body = rec.get("body").and_then(Value::as_object).cloned().unwrap_or_default();
        body.insert("reviewer".into(), Value::from(reviewer.clone()));
        (s(rec, "job").to_string(), Value::Object(body))
    };
    let sig = sig.ok_or_else(|| E::Bad("sig is {ts, sig}".into()))?;
    let ts = sig.get("ts").and_then(Value::as_i64).ok_or_else(|| E::Bad("sig is {ts, sig}".into()))?;
    let signed = ai::signed_body(&body, ts, sig.get("sig").and_then(Value::as_str).unwrap_or(""), t.div_euclid(1000)).map_err(api_e)?;
    let keep = |rec: &mut Obj, outcome: Value| {
        let mut o = rec.get("outcomes").and_then(Value::as_object).cloned().unwrap_or_default();
        o.insert(reviewer.clone(), outcome);
        rec.insert("outcomes".into(), Value::Object(o));
    };
    // the signature counts as possible while it is posted (a status poll must not refuse the job meanwhile)
    update(relay, &org, &job, |rec| keep(rec, json!({ "result": "posting", "at": t / 1000 }))).map_err(|r| E::Internal(r.error))?;
    book.observe_requests(AI_REVIEWER_KIND, &reviewer, t, &|x: &Value| *x == target);
    let posted = push_state(relay, &org).and_then(|_| archive_json(relay, &org, "POST", "/v1/exports/release", Some(&signed)));
    let released = posted.as_ref().is_ok_and(|v| v.get("state").and_then(Value::as_str) == Some("released"));
    let others = update(relay, &org, &job, |rec| {
        match &posted {
            Ok(_) => keep(rec, json!({ "result": "accepted", "at": t / 1000 })),
            // the archive never saw it: the reviewer is asked again (`fill_asks`)
            Err(r) if r.code == "archive-unreachable" => {
                if let Some(o) = rec.get_mut("outcomes").and_then(Value::as_object_mut) {
                    o.remove(&reviewer);
                }
                if let Some(a) = rec.get_mut("asks").and_then(Value::as_object_mut) {
                    a.remove(&reviewer);
                }
            }
            Err(r) => keep(rec, json!({ "result": "failed", "code": r.code, "error": r.error, "at": t / 1000 })),
        }
        if released {
            rec.insert("state".into(), Value::from("released"));
            let mine = Value::from(id.clone());
            rec.get("asks").and_then(Value::as_object).map(|a| a.values().filter(|x| **x != mine).filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default()
        } else {
            Vec::new()
        }
    })
    .map_err(|r| E::Internal(r.error))?
    .unwrap_or_default();
    if released {
        close_asks(relay, &others);
        if let Some(r) = arc_of(relay) {
            ensure_worker(r, &org, &job);
        }
    }
    let outcome = match &posted {
        Ok(_) if released => "released",
        Ok(_) => "waiting",
        Err(_) => "failed",
    };
    crate::meet::log_info(&format!("api export org={org} job={job} release={outcome} reviewer={reviewer}"));
    let mut out = obj([("ok", Value::Bool(true)), ("job", Value::from(job)), ("archive", Value::from(outcome))]);
    if let Err(r) = posted {
        out.insert("error".into(), Value::from(r.error));
    }
    Ok(out)
}

// ── the transfer (5.3.3 step 7) ─────────────────────────────────────────────────────────────────────────────────

/// Removes the job from `WORKERS` when its worker ends (or never started).
struct Running(String, String);

impl Drop for Running {
    fn drop(&mut self) {
        WORKERS.lock().remove(&(self.0.clone(), self.1.clone()));
    }
}

/// The job's transfer worker, unless one runs.
fn ensure_worker(relay: Arc<Relay>, org: &str, job: &str) {
    if !WORKERS.lock().insert((org.to_string(), job.to_string())) {
        return;
    }
    let running = Running(org.to_string(), job.to_string());
    let spawned = std::thread::Builder::new().name("api-export-transfer".into()).spawn(move || {
        let (org, job) = (running.0.clone(), running.1.clone());
        if let Err(r) = transfer(&relay, &org, &job) {
            crate::meet::log_warn(&format!("api export transfer org={org} job={job} code={} why={}", r.code, r.error));
        }
        drop(running);
    });
    if let Err(e) = spawned {
        crate::meet::log_error(&format!("api export transfer org={org} job={job}: no thread ({e})"));
    }
}

/// A console refusal that sending again cannot fix (contract C): the job fails and the archive cancels it.
fn permanent(r: &Refusal) -> bool {
    matches!(r.code.as_str(), "part-hash" | "seal")
}

fn fail(relay: &Relay, org: &str, job: &str, r: Refusal) -> Result<(), Refusal> {
    update(relay, org, job, |rec| {
        rec.insert("end".into(), Value::from("failed"));
        rec.insert("code".into(), Value::from(r.code.clone()));
        rec.insert("told".into(), Value::Bool(false));
    })?;
    tell_archive(relay, org, job, &format!("the console refused the transfer ({})", r.code));
    Err(r)
}

fn still_on(relay: &Relay, org: &str, job: &str) -> Option<Obj> {
    get(relay, org, job).filter(|r| !ended(r))
}

/// Wait for the sealed package, send the seal, then each part not yet acknowledged: the console first, the archive's
/// acknowledgement only after the console's. Progress is kept after each part; any other error stops the worker
/// (the console's next status poll starts it again).
fn transfer(relay: &Relay, org: &str, job: &str) -> Result<(), Refusal> {
    let started = Instant::now();
    push_state(relay, org)?;
    loop {
        if still_on(relay, org, job).is_none() {
            return Ok(());
        }
        let a = archive_json(relay, org, "GET", &format!("/v1/exports/{job}"), None)?;
        match a.get("state").and_then(Value::as_str).unwrap_or_default() {
            "sealed" => break,
            "released" | "building" if started.elapsed() < BUILD_WAIT => std::thread::sleep(BUILD_POLL),
            _ => return Ok(()),
        }
    }
    let seal = archive_json(relay, org, "GET", &format!("/v1/exports/{job}/seal"), None)?;
    let parts = seal.get("parts").and_then(Value::as_u64).filter(|p| (1..=PARTS_MAX).contains(p)).ok_or_else(bad_answer)?;
    let hashes: Vec<&str> = seal.get("part_sha256").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect();
    if seal.get("job").and_then(Value::as_str) != Some(job) || hashes.len() as u64 != parts {
        return Err(bad_answer());
    }
    let Some(rec) = still_on(relay, org, job) else { return Ok(()) };
    if rec.get("seal_sent") != Some(&Value::Bool(true)) {
        match crate::fleet_agent::console_call("api-export-seal", json!({ "org": org, "job": job, "seal": seal }), SEAL_TIMEOUT) {
            Ok(_) => {}
            Err(r) if permanent(&r) => return fail(relay, org, job, r),
            Err(r) => return Err(r),
        }
        update(relay, org, job, |rec| {
            rec.insert("seal_sent".into(), Value::Bool(true));
            rec.insert("parts".into(), Value::from(parts));
        })?;
    }
    let mut at = n(&rec, "acked");
    while at < parts {
        if still_on(relay, org, job).is_none() {
            return Ok(());
        }
        let data = archive(relay, org, "GET", &format!("/v1/exports/{job}/parts/{at}"), None)?;
        let sha = crate::codec::sha256_hex(&data);
        if data.is_empty() || data.len() > PART_MAX_BYTES || hashes.get(at as usize).copied() != Some(sha.as_str()) {
            return Err(Refusal::new(502, "archive-answer", &format!("Part {at} from the archive does not match its seal.")));
        }
        let part = json!({ "org": org, "job": job, "n": at, "data": crate::meet_json::b64(&data), "sha256": sha });
        drop(data);
        match crate::fleet_agent::console_call("api-export-part", part, PART_TIMEOUT) {
            Ok(_) => {}
            Err(r) if permanent(&r) => return fail(relay, org, job, r),
            Err(r) => return Err(r),
        }
        archive_json(relay, org, "POST", &format!("/v1/exports/{job}/ack"), Some(&json!({ "n": at })))?;
        at += 1;
        let acked = at;
        update(relay, org, job, |rec| rec.insert("acked".into(), Value::from(acked)))?;
    }
    crate::meet::log_info(&format!("api export org={org} job={job} parts={parts} transferred"));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job() -> Value {
        json!({"job": "j_7c6b5a4938271605", "client": "c_1b2c3d4e5f607182", "matter": "2026-114", "reason": "Production for matter 2026-114",
               "scope": {"people": ["ann@acme.example"], "cids": [], "from": 1790000000, "to": 1795000000, "kinds": ["chat"], "query": ""},
               "reviewers": ["rita@acme.example", "sam@acme.example", "tom@acme.example"], "requested_at": 1795700100})
    }

    fn entry(tseq: u64, action: &str, target: Value) -> TightenEntry {
        TightenEntry { id: format!("t_acme_{tseq:06}"), org: "acme".into(), tseq, ts: 1_795_000_000, action: action.into(), target, until: None }
    }

    #[test]
    fn only_the_request_fields_reach_the_archive() {
        let mut j = job();
        for (k, v) in [("owner", json!("lee@acme.example")), ("max_bytes", json!(1u64 << 40)), ("recipient", json!({"kid": "evil", "jkt": "x"})), ("ceiling", json!("cui")), ("client_name", json!("x")), ("map_seq", json!(99))] {
            j[k] = v;
        }
        let req = request_of(Some(&j)).unwrap();
        let keys: BTreeSet<&str> = req.keys().map(String::as_str).collect();
        assert_eq!(keys, BTreeSet::from(["job", "client", "matter", "reason", "scope", "reviewers", "requested_at"]));
        let sent = archive_request("acme", &req);
        let sent_keys: BTreeSet<&str> = sent.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(sent_keys, BTreeSet::from(["org", "job", "client", "matter", "reason", "scope", "reviewers", "requested_at"]));
        assert_eq!(sent["scope"], job()["scope"]);
    }

    #[test]
    fn the_request_shape_is_checked() {
        for (k, v) in [
            ("job", json!("j_7C6B5A4938271605")),
            ("job", json!("h_7c6b5a4938271605")),
            ("client", json!("c_1b2c")),
            ("matter", json!("")),
            ("reason", json!("x".repeat(501))),
            ("scope", json!([])),
            ("reviewers", json!(["rita@acme.example"])),
            ("reviewers", json!(["a@x.example", "b@x.example", "c@x.example", "d@x.example", "e@x.example", "f@x.example"])),
            ("reviewers", json!(["rita@acme.example", "rita@acme.example"])),
            ("reviewers", json!(["rita@acme.example", "nobody"])),
            ("requested_at", json!("soon")),
        ] {
            let mut j = job();
            j[k] = v;
            assert_eq!(request_of(Some(&j)).err().map(|e| e.code), Some("bad-request".to_string()), "{k}");
        }
    }

    #[test]
    fn the_state_carries_the_journal_and_inactive_owners() {
        let entries = [
            entry(1, "client_suspend", json!("c_000000000000000a")),
            entry(2, "client_drop_scope", json!({"client": "c_000000000000000b", "scope": "compliance.export.request"})),
            entry(3, "client_lower_ceiling", json!({"client": "c_000000000000000b", "ceiling": "confidential"})),
            entry(4, "client_lower_ceiling", json!({"client": "c_000000000000000b", "ceiling": "internal"})),
            entry(5, "client_lower_ceiling", json!({"client": "c_000000000000000b", "ceiling": "confidential"})),
            entry(6, "client_limit", json!({"client": "c_000000000000000c", "rate": 10})),
            entry(7, "token_deny", json!({"client": "c_000000000000000a", "jti": "x"})),
            entry(8, "api_off", json!("acme")),
        ];
        let mut journal = journal_of(&entries, true);
        // ReviewW3: every active entry travels with its id and tseq, in order
        let ids: Vec<Value> = journal["entries"].as_array().unwrap().iter().map(|e| json!([e["id"], e["tseq"]])).collect();
        assert_eq!(ids, (1..=8u64).map(|i| json!([format!("t_acme_{i:06}"), i])).collect::<Vec<_>>());
        assert_eq!(journal["entries"][0]["action"], "client_suspend");
        journal.as_object_mut().unwrap().remove("entries");
        assert_eq!(
            journal,
            json!({"suspended": ["c_000000000000000a"], "dropped_scopes": {"c_000000000000000b": ["compliance.export.request"]},
                   "ceilings": {"c_000000000000000b": "internal"}, "limits": {"c_000000000000000c": {"rate": 10}}, "api_off": true})
        );
        let clients = [json!({"id": "c_000000000000000a", "owner": "ann@acme.example"}), json!({"id": "c_000000000000000b", "owner": "bo@acme.example"}), json!({"id": "c_000000000000000c", "owner": "ann@acme.example"})];
        let owners = inactive_owners(&clients, &|o: &str| o == "ann@acme.example");
        assert_eq!(owners, vec!["ann@acme.example".to_string()]);
        let map = obj([("map", json!({"org": "acme", "seq": 12})), ("sig", json!("s")), ("chain", json!([]))]);
        let without = state_body("acme", &map, None, journal.clone(), owners.clone());
        assert!(without.get("ai_map").is_none());
        assert_eq!(without["api_map"]["map"]["seq"], 12);
        assert_eq!(without["inactive_owners"], json!(["ann@acme.example"]));
        let with = state_body("acme", &map, Some(json!({"map": {}, "sig": "s", "chain": []})), journal, owners);
        assert!(with.get("ai_map").is_some());
        assert_eq!(journal_of(&[], false)["api_off"], false);
    }

    #[test]
    fn archive_states_map_to_relay_states() {
        assert_eq!(relay_state("waiting", None, 0, Some(3)), "waiting");
        assert_eq!(relay_state("waiting", None, 0, Some(1)), "refused");
        assert_eq!(relay_state("released", None, 0, None), "released");
        assert_eq!(relay_state("building", None, 0, None), "building");
        assert_eq!(relay_state("sealed", Some(3), 2, None), "transferring");
        assert_eq!(relay_state("sealed", Some(3), 3, None), "ready");
        assert_eq!(relay_state("sealed", None, 0, None), "transferring");
        assert_eq!(relay_state("done", Some(3), 3, None), "ready");
        for end in ["canceled", "refused", "expired"] {
            assert_eq!(relay_state(end, None, 0, None), end);
        }
        assert_eq!(relay_state("failed", None, 0, None), "failed");
        assert_eq!(relay_state("unheard-of", None, 0, None), "failed");

        let reviewers: Vec<String> = ["rita@acme.example", "sam@acme.example", "tom@acme.example"].map(String::from).to_vec();
        let st = |v: [Option<&str>; 3]| -> BTreeMap<String, Option<String>> { reviewers.iter().cloned().zip(v.map(|x| x.map(String::from))).collect() };
        let none = Obj::new();
        assert_eq!(possible(&reviewers, &none, &st([Some("waiting"), Some("waiting"), Some("waiting")])), 3);
        // two declined: one left, the job is refused
        let left = possible(&reviewers, &none, &st([Some("waiting"), Some("declined"), Some("failed")]));
        assert_eq!(relay_state("waiting", None, 0, Some(left)), "refused");
        // one released, one declined, one waiting: still two
        let outcomes = obj([("rita@acme.example", json!({"result": "accepted"}))]);
        let two = possible(&reviewers, &outcomes, &st([Some("done"), Some("declined"), Some("waiting")]));
        assert_eq!((two, relay_state("waiting", None, 0, Some(two))), (2, "waiting"));
        // a signature being posted counts; one the archive refused does not; an unknown ask counts
        let outcomes = obj([("rita@acme.example", json!({"result": "posting"})), ("sam@acme.example", json!({"result": "failed"}))]);
        assert_eq!(possible(&reviewers, &outcomes, &st([Some("done"), Some("done"), None])), 2);
    }

    #[test]
    fn jobs_are_kept_and_registered_once() {
        let dir = std::env::temp_dir().join(format!("lucid-api-exports-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = Some(dir.join("acme").join(EXPORTS));
        let req = request_of(Some(&job())).unwrap();
        let body = obj([("op", json!(OP)), ("job", json!("j_7c6b5a4938271605")), ("client_name", json!("ediscovery-export")), ("owner", json!("lee@acme.example"))]);
        let previews = obj([("rita@acme.example", json!({"0123456789abcdef": {"epk": "e", "nonce": "n", "ct": "c"}}))]);
        let words = words_of(&req, &body);
        assert!(words.contains("ediscovery-export") && words.contains("lee@acme.example"));
        let rec = new_record(&req, body.clone(), previews.clone(), "ediscovery-export@apps.acme.example", &words, 1_795_700_100);
        let mut jobs = Vec::new();
        assert_eq!(keep_new(&mut jobs, rec.clone()), Ok(0));
        jobs[0].insert("asks".into(), json!({"rita@acme.example": "rq_1"}));
        // the same job again: the held record, its asks untouched
        assert_eq!(keep_new(&mut jobs, rec.clone()), Ok(0));
        assert_eq!(jobs.len(), 1);
        let mut other = job();
        other["matter"] = json!("2026-115");
        let other = new_record(&request_of(Some(&other)).unwrap(), body, previews, "x@apps.acme.example", &words, 1);
        assert_eq!(keep_new(&mut jobs, other).err().map(|e| e.code), Some("job-exists".to_string()));
        save(path.as_ref(), &mut jobs).unwrap();
        let back = load(path.as_ref());
        assert_eq!(back, jobs);
        assert_eq!(ask_ids(&back[0]), vec!["rq_1".to_string()]);
        assert!(!ended(&back[0]));
        let target = ask_target("acme", &back[0]["body"], "rita@acme.example", back[0]["previews"]["rita@acme.example"].clone());
        assert_eq!((target["op"].as_str(), target["label"].as_str(), target["body"]["reviewer"].as_str()), (Some(OP), Some(LABEL), Some("rita@acme.example")));
        assert_eq!(target["preview_wraps"]["0123456789abcdef"]["epk"], "e");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_oldest_ended_jobs_go_first() {
        let dir = std::env::temp_dir().join(format!("lucid-api-exports-max-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = Some(dir.join("acme").join(EXPORTS));
        let mut jobs: Vec<Obj> = (0..EXPORTS_MAX + 2).map(|i| obj([("job", Value::from(format!("j_{i:016x}"))), ("state", json!("waiting"))])).collect();
        jobs[0].insert("state".into(), json!("ready"));
        jobs[3].insert("end".into(), json!("canceled"));
        save(path.as_ref(), &mut jobs).unwrap();
        let back = load(path.as_ref());
        assert_eq!(back.len(), EXPORTS_MAX);
        assert!(back.iter().all(|j| !ended(j)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn archive_refusals_pass_as_they_are() {
        let r = refusal_of_answer(409, br#"{"error": "That reviewer cannot release this job.", "code": "reviewers"}"#);
        assert_eq!((r.status, r.code.as_str(), r.error.as_str()), (409, "reviewers", "That reviewer cannot release this job."));
        let r = refusal_of_answer(500, b"not json");
        assert_eq!((r.status, r.code.as_str()), (500, "archive"));
    }

    #[test]
    fn console_call_without_a_channel_is_fleet_offline() {
        let r = crate::fleet_agent::console_call("api-export-seal", json!({}), Duration::from_millis(10));
        assert_eq!(r.err().map(|e| (e.status, e.code)), Some((503, "fleet-offline".to_string())));
    }
}
