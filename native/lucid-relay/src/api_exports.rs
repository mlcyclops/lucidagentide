// Contract API-1 revision 4 (docs/api/contract-r4-1b.md) 5.3, the console end of compliance exports on the front door
// (I only; `compliance.export.request`, reach R1, class `confidential`):
//
// - `POST v1/compliance/exports` (5.3.2) with `Idempotency-Key`: the request is checked, the client's standing and
//   derived fields are taken from the console's own pinned map and journals (name, owner, recipient `kid` and RFC 7638
//   thumbprint, `max_bytes` from the caps, effective ceiling, `map_seq`), quotas and the 20 open jobs are counted, the
//   job record `<state>/api-exports/<org>/<job>/job.json` is flushed with its `compliance.export.requested` entry, and
//   only the request fields go to a connected archive relay (`api-export`). The archive derives every field again from
//   the relay's own signed maps and journal (Rev4Review R4-2); the console's record is its bookkeeping. The answer
//   carries no counts (R4-5).
// - The seal header (`api-export-seal`) and each ciphertext part (`api-export-part`) arrive from the job's archive
//   relay; the seal is checked against the job (job, client, recipient, part hashes) and kept, each part against the
//   seal's `part_sha256` before it is kept (owner-only folder, flushed before the answer). The console never holds the
//   content key or the recipient key: it stores ciphertext only. With every part held the job is `ready` for 7 days.
// - Downloads (`seal`, `parts/{n}`) need `ready`, an unexpired job (410 `expired`) and the job's ceiling at or below
//   the client's current effective ceiling (403 `ceiling`). The last part fetched appends
//   `compliance.export.downloaded`.
// - Tightenings reach open jobs (R4-2): a client suspended, without the scope, with a lowered ceiling, without its
//   recipient (`client_drop_recipient` also deletes its ready parts), with an inactive owner, or an org `api_off`,
//   cancels every job of the client that is not `ready` at once (`tightened`, called by the journals) and again each
//   minute (`tick_now`), with `api-export-cancel` to the archive relay.
// - The minute also follows each open job with `api-export-status` (release, refusal, failure), expires a job still
//   `waiting` after 72 hours and a `ready` job 7 days after it became ready (its parts deleted).

use crate::api_compliance::{no, ok, params, principal_ok, printable, Answer, Desk, Refused, Req, MATTER_MAX};
use crate::api_idempotency as idem;
use crate::api_resource::RouteId;
use crate::api_token as tok;
use crate::codec::{b64u, hex, parse_json, sha256_hex, stringify, unb64u};
use crate::console_fleet::LinkError;
use crate::fleet_wire::Refusal;
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// 5.3.2: a request body.
pub const REQUEST_MAX: usize = 64 * 1024;
/// The jobs' folder under the console's state folder.
pub const DIR: &str = "api-exports";
pub const SCOPE: &str = "compliance.export.request";
/// 5.3.5.
pub const FORMAT: &str = "lucid-export-v1";
/// 5.3.2 `reason` (the archive's `REASON_MAX`).
pub const REASON_MAX: usize = 500;
/// 5.3.2 `scope.people` and `scope.cids`.
pub const SCOPE_LIST_MAX: usize = 200;
pub const QUERY_MAX: usize = 256;
pub const SPAN_MAX_S: i64 = 3650 * DAY;
pub const REVIEWERS_MIN: usize = 2;
pub const REVIEWERS_MAX: usize = 5;
/// 5.3.8: jobs not ended per org.
pub const OPEN_MAX: usize = 20;
/// 5.3.3: a job still `waiting` after this expires.
pub const WAITING_S: i64 = 72 * 3600;
/// 5.3.8: a `ready` job expires this long after it became ready.
pub const READY_S: i64 = 7 * DAY;
/// 5.3.6: the zip's part size, the most parts, and a part's ciphertext (the part and its 16-byte tag).
pub const PART_BYTES: u64 = 4 * 1024 * 1024;
pub const PARTS_MAX: u64 = 12_800;
pub const PART_CIPHER_MAX: usize = PART_BYTES as usize + 16;
/// 5.3.8: free space kept beyond a package.
pub const STORAGE_MARGIN: u64 = 10 * 1024 * 1024 * 1024;
const DAY: i64 = 86_400;
const LINK_MS: u64 = 20_000;
const PAGE_DEFAULT: usize = 100;
const PAGE_MAX: usize = 500;
const KINDS: [&str; 3] = ["chat", "file", "ai"];
const NOT_FOUND: &str = "Nothing is here.";
/// Job states before `ready` (5.3.3).
const OPEN: [&str; 4] = ["waiting", "released", "building", "transferring"];
const JOB_FILE: &str = "job.json";
const SEAL_FILE: &str = "seal.json";

/// `j_` and 16 lowercase hex.
pub fn job_id_ok(s: &str) -> bool {
    s.len() == 18 && s.starts_with("j_") && s[2..].bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn hex64(v: &Value) -> bool {
    v.as_str().is_some_and(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or_default()
}

fn int(v: &Value, k: &str) -> i64 {
    v.get(k).and_then(Value::as_i64).unwrap_or(0)
}

fn bad(why: impl Into<String>) -> Refused {
    no(400, "bad-request", why)
}

/// 5.3.8: free bytes on the disk of `dir`.
pub fn free_bytes(dir: &Path) -> Option<u64> {
    use crate::fleet_metrics::FsOps;
    crate::fleet_metrics::RealFs.free_space(dir).map(|(avail, _)| avail)
}

// ── the client's standing, from the console's own state ─────────────────────────────────────────────────────────

/// What the console derives for a client's export (5.3.3 step 2 on the console side).
#[derive(Clone, Debug, PartialEq)]
pub struct Standing {
    pub name: String,
    pub owner: String,
    /// The effective ceiling: the map's, lowered by every `client_lower_ceiling`.
    pub ceiling: String,
    /// `{kid, jkt}`; None when the map has none or `client_drop_recipient` dropped it.
    pub recipient: Option<Value>,
    pub map_seq: i64,
    pub max_bytes: i64,
}

/// The client may request and download exports now, and what follows from it; the refusal otherwise (the narrowing
/// that also cancels its open jobs).
pub fn standing(desk: &dyn Desk, org: &str, client: &str, now: i64) -> Result<Standing, Refused> {
    let gone = || no(403, "suspended", "That client is not registered.");
    let store = desk.store(org).ok_or_else(gone)?;
    let vm = store.get(org, "").ok_or_else(|| no(401, "map-expired", "The organization has no api map in force."))?;
    if vm.expires <= now {
        return Err(no(401, "map-expired", "The organization's api map has expired."));
    }
    if store.is_off(org) {
        return Err(no(403, "api-off", "The API is off for this organization."));
    }
    let active = store.active(org);
    let c = tok::find_client(&store, org, client).ok_or_else(gone)?;
    let suspended = c.get("state").and_then(Value::as_str) != Some("active") || active.iter().any(|e| e.action == "client_suspend" && e.target.as_str() == Some(client));
    if suspended {
        return Err(no(403, "suspended", "That client is suspended."));
    }
    let scoped = tok::names(c, "scopes").any(|x| x == SCOPE) && !tok::client_entries(active, "client_drop_scope", client).any(|e| tok::target_field(e, "scope") == SCOPE);
    if !scoped {
        return Err(no(403, "scope", "This client no longer holds compliance.export.request."));
    }
    if c.get("expires").and_then(Value::as_i64).is_none_or(|e| e <= now) {
        return Err(no(401, "expired", "That client's registration has expired."));
    }
    let owner = c.get("owner").and_then(Value::as_str).unwrap_or_default().to_string();
    if !desk.owner_active(org, &owner) {
        return Err(no(403, "owner", "The client's owner is not active."));
    }
    let mut ceiling = c.get("ceiling").and_then(Value::as_str).unwrap_or("public").to_string();
    for e in tok::client_entries(active, "client_lower_ceiling", client) {
        let lower = tok::target_field(e, "ceiling");
        if tok::rank(lower).is_some_and(|l| tok::rank(&ceiling).is_none_or(|c| l < c)) {
            ceiling = lower.to_string();
        }
    }
    let recipient = c.get("compliance").and_then(|x| x.get("recipient")).and_then(|r| {
        let kid = r.get("kid")?.as_str()?;
        let jkt = tok::jwk_thumbprint(&tok::parse_jwk(r.get("jwk")?, 2048)?);
        (!crate::api_cjournal::recipient_dropped(&desk.console_active(org), client, kid)).then(|| json!({ "kid": kid, "jkt": jkt }))
    });
    let max_bytes = desk.caps(org, client).get("job_max_bytes").copied().unwrap_or(0);
    Ok(Standing { name: c.get("name").and_then(Value::as_str).unwrap_or_default().to_string(), owner, ceiling, recipient, map_seq: vm.seq, max_bytes })
}

/// Why an open job of the client must end now (5.3.3 "Tightenings reach open jobs"), or None.
fn narrowed(desk: &dyn Desk, org: &str, rec: &Value, now: i64) -> Option<&'static str> {
    match standing(desk, org, s(rec, "client"), now) {
        Err(r) => Some(r.code),
        Ok(st) if st.recipient.as_ref() != rec.get("recipient") => Some("recipient"),
        Ok(st) if tok::rank(&st.ceiling).unwrap_or(0) < tok::rank(s(rec, "ceiling")).unwrap_or(0) => Some("ceiling"),
        // ReviewW3: `client_lower_caps` below the job's derived `max_bytes`
        Ok(st) if st.max_bytes < int(rec, "max_bytes") => Some("limits"),
        Ok(_) => None,
    }
}

// ── job records ──────────────────────────────────────────────────────────────────────────────────────────────────

/// One read-modify-write of a job's files at a time.
static LOCK: parking_lot::Mutex<()> = parking_lot::Mutex::new(());

fn org_dir(desk: &dyn Desk, org: &str) -> Option<PathBuf> {
    desk.dir().map(|d| d.join(DIR).join(org))
}

fn job_dir(desk: &dyn Desk, org: &str, job: &str) -> Option<PathBuf> {
    org_dir(desk, org).map(|d| d.join(job))
}

fn part_path(dir: &Path, n: u64) -> PathBuf {
    dir.join(format!("part-{n}.bin"))
}

fn load(desk: &dyn Desk, org: &str, job: &str) -> Option<Value> {
    if !job_id_ok(job) {
        return None;
    }
    let path = job_dir(desk, org, job)?.join(JOB_FILE);
    parse_json(&std::fs::read_to_string(path).ok()?).filter(|v| v.get("job").and_then(Value::as_str) == Some(job))
}

fn save(desk: &dyn Desk, org: &str, rec: &Value) -> Result<(), String> {
    let dir = job_dir(desk, org, s(rec, "job")).ok_or("the console keeps no state folder")?;
    crate::store::make_dir(&dir).map_err(|e| e.to_string())?;
    crate::fleet_local::write_durable(&dir.join(JOB_FILE), stringify(rec).as_bytes())
}

fn save_logged(desk: &dyn Desk, org: &str, rec: &Value) {
    if let Err(e) = save(desk, org, rec) {
        crate::meet::log_error(&format!("api export org={org} job={} not kept: {e}", s(rec, "job")));
    }
}

/// The org's jobs, newest first.
fn jobs(desk: &dyn Desk, org: &str) -> Vec<Value> {
    let mut out: Vec<Value> = org_dir(desk, org)
        .and_then(|d| std::fs::read_dir(d).ok())
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| load(desk, org, &e.file_name().to_string_lossy()))
        .collect();
    out.sort_by(|a, b| (int(b, "requested_at"), s(b, "job")).cmp(&(int(a, "requested_at"), s(a, "job"))));
    out
}

/// Every job state (5.3.3), for `lucid_compliance_exports`.
const STATES: [&str; 9] = ["waiting", "released", "building", "transferring", "ready", "refused", "canceled", "expired", "failed"];

/// Revision 4 12 `lucid_compliance_exports`: the org's jobs by state (every state, 0 included).
fn publish_jobs(desk: &dyn Desk, org: &str) {
    let all = jobs(desk, org);
    for state in STATES {
        let n = all.iter().filter(|r| s(r, "state") == state).count() as u64;
        crate::api_catalog::counters::set_compliance_exports(org, state, n);
    }
}

/// The orgs with job records.
fn orgs(desk: &dyn Desk) -> Vec<String> {
    desk.dir()
        .and_then(|d| std::fs::read_dir(d.join(DIR)).ok())
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect()
}

/// Delete a job's seal and parts (5.3.8 expiry, `client_drop_recipient`, cancellation).
fn delete_package(desk: &dyn Desk, org: &str, job: &str) {
    let Some(dir) = job_dir(desk, org, job) else { return };
    for e in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if name == SEAL_FILE || (name.starts_with("part-") && name.ends_with(".bin")) {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

/// 5.3.7: a job as the routes show it.
fn resource(rec: &Value) -> Value {
    let mut v = json!({
        "job": rec["job"], "state": rec["state"], "matter": rec["matter"], "requested_at": rec["requested_at"],
        "releases": int(rec, "releases"), "reviewers": rec["reviewers"],
    });
    // the preview is content-derived: only after release (Rev4Review R4-5)
    if s(rec, "state") != "waiting" {
        if let Some(p) = rec.get("preview").filter(|p| p.is_object()) {
            v["preview"] = p.clone();
        }
    }
    for k in ["parts", "zip_bytes", "expires"] {
        if let Some(x) = rec.get(k).filter(|x| x.is_i64()) {
            v[k] = x.clone();
        }
    }
    // `refused` carries no reason that depends on content
    if s(rec, "state") != "refused" {
        if let Some(c) = rec.get("code").filter(|c| c.is_string()) {
            v["code"] = c.clone();
        }
    }
    v
}

// ── the routes ───────────────────────────────────────────────────────────────────────────────────────────────────

/// The export routes of `ROUTES` (`api_compliance::serve` hands them here).
pub fn serve(desk: &dyn Desk, req: &Req) -> Result<Answer, Refused> {
    match req.route {
        RouteId::ComplianceExportRequest => request(desk, req),
        RouteId::ComplianceExports => list(desk, req),
        RouteId::ComplianceExport => mine(desk, req).map(|r| ok(200, resource(&r))),
        RouteId::ComplianceExportSeal => seal(desk, req),
        RouteId::ComplianceExportPart => part(desk, req),
        RouteId::ComplianceExportCancel => cancel(desk, req),
        _ => Err(no(404, "not-found", NOT_FOUND)),
    }
}

/// The path's job when it is this client's (another client's job is 404).
fn mine(desk: &dyn Desk, req: &Req) -> Result<Value, Refused> {
    let job = req.id.unwrap_or_default();
    load(desk, req.org, job).filter(|r| s(r, "client") == req.client).ok_or_else(|| no(404, "not-found", NOT_FOUND))
}

/// 5.3.2 `POST v1/compliance/exports`.
fn request(desk: &dyn Desk, req: &Req) -> Result<Answer, Refused> {
    let body = req.body.ok_or_else(|| bad("This route takes a JSON body."))?;
    let key = idem::parse_key(body.key.as_deref()).map_err(|r| no(r.status, r.code, r.why()))?;
    let json = match &body.json {
        Ok(v) => v,
        Err(code) if *code == "too-large" => return Err(no(413, "too-large", "An export request is at most 64 KiB.")),
        Err(_) => return Err(bad("The body is not a JSON object.")),
    };
    match desk.idempotency().begin(req.org, req.client, &key, json, req.now) {
        idem::Begin::Replay { status, body } => return Ok(Answer { replayed: true, ..ok(status, body) }),
        idem::Begin::Refused(r) => return Err(no(r.status, r.code, r.why())),
        idem::Begin::Fresh => {}
    }
    let sha256 = idem::body_sha256(json);
    // the key of a job kept before a restart (as the holds route): its record carries the key, the body hash and, once
    // answered, the answer; records without `idem` are not matched
    let kept_before = jobs(desk, req.org).into_iter().find_map(|r| {
        let i = r.get("idem")?;
        (s(&r, "client") == req.client && i.get("client").and_then(Value::as_str) == Some(req.client) && i.get("key").and_then(Value::as_str) == Some(key.as_str())).then(|| i.clone())
    });
    if let Some(i) = kept_before.filter(|i| i.get("at").and_then(Value::as_i64).is_some_and(|at| req.now - at < idem::KEEP_S)) {
        let at = i.get("at").and_then(Value::as_i64).unwrap_or(req.now);
        let was = i.get("sha256").and_then(Value::as_str).unwrap_or_default().to_string();
        let answer = i.get("status").and_then(Value::as_u64).map(|st| (st as u16, i.get("body").cloned().unwrap_or(Value::Null)));
        desk.idempotency().recover(req.org, req.client, &key, &was, at, answer.clone());
        return match answer {
            _ if was != sha256 => Err(no(idem::MISMATCH.status, idem::MISMATCH.code, idem::MISMATCH.why())),
            Some((status, body)) => Ok(Answer { replayed: true, ..ok(status, body) }),
            None => Err(no(idem::BUSY.status, idem::BUSY.code, idem::BUSY.why())),
        };
    }
    let mut kept = false;
    let out = request_fresh(desk, req, json, &json!({ "client": req.client, "key": key, "sha256": sha256, "at": req.now }), &mut kept);
    match &out {
        // the job record already carries the answer: a failed key write leaves the key running here and replayable
        // after a restart, never free for a second job
        Ok(a) => {
            if desk.idempotency().finish(req.org, req.client, &key, a.status, &a.body).is_err() {
                return Err(no(503, "unavailable", "The console could not keep the answer of this request; try again later with the same Idempotency-Key."));
            }
        }
        // a job record carries the key: it stays running, so a retry cannot create a second job
        Err(_) if kept => {}
        Err(_) => desk.idempotency().abandon(req.org, req.client, &key),
    }
    out
}

/// A list of 0 to `max` unique strings each passing `each` (lowercased first when `lower`).
fn list_of(v: Option<&Value>, max: usize, lower: bool, each: impl Fn(&str) -> bool, what: &str) -> Result<Vec<String>, Refused> {
    let a = v.and_then(Value::as_array).filter(|a| a.len() <= max).ok_or_else(|| bad(format!("{what} is a list of at most {max}.")))?;
    let mut out: Vec<String> = Vec::with_capacity(a.len());
    for x in a {
        let x = x.as_str().map(|t| if lower { t.trim().to_lowercase() } else { t.to_string() }).filter(|t| each(t)).ok_or_else(|| bad(format!("{what} holds a value that does not fit.")))?;
        if out.contains(&x) {
            return Err(bad(format!("{what} are unique.")));
        }
        out.push(x);
    }
    Ok(out)
}

/// 5.3.2 `scope`, normalized (`query` defaults to empty).
pub fn scope_of(v: Option<&Value>, now: i64) -> Result<Value, Refused> {
    let o = v.and_then(Value::as_object).ok_or_else(|| bad("scope is an object."))?;
    if let Some(k) = o.keys().find(|k| !["people", "cids", "from", "to", "kinds", "query"].contains(&k.as_str())) {
        return Err(bad(format!("{k} is not a field of an export scope.")));
    }
    let people = list_of(o.get("people").or(Some(&json!([]))), SCOPE_LIST_MAX, true, principal_ok, "scope.people")?;
    let cid_ok = |c: &str| (1..=128).contains(&c.len()) && !c.chars().any(|x| x.is_whitespace() || x.is_control());
    let cids = list_of(o.get("cids").or(Some(&json!([]))), SCOPE_LIST_MAX, false, cid_ok, "scope.cids")?;
    if people.is_empty() && cids.is_empty() {
        return Err(bad("scope names at least one person or conversation."));
    }
    let (from, to) = (o.get("from").and_then(Value::as_i64), o.get("to").and_then(Value::as_i64));
    let (Some(from), Some(to)) = (from, to) else { return Err(bad("scope.from and scope.to are Unix seconds.")) };
    if !(0 <= from && from < to && to <= now && to - from <= SPAN_MAX_S) {
        return Err(bad("scope needs from < to <= now, at most 3650 days apart."));
    }
    let kinds = list_of(o.get("kinds"), KINDS.len(), false, |k| KINDS.contains(&k), "scope.kinds")?;
    if kinds.is_empty() {
        return Err(bad("scope.kinds names chat, file or ai."));
    }
    let query = match o.get("query") {
        None => String::new(),
        Some(q) => q.as_str().filter(|q| q.chars().count() <= QUERY_MAX && !q.chars().any(char::is_control)).ok_or_else(|| bad("scope.query is at most 256 printable characters."))?.to_string(),
    };
    Ok(json!({ "people": people, "cids": cids, "from": from, "to": to, "kinds": kinds, "query": query }))
}

fn new_job_id() -> Result<String, Refused> {
    let mut id = [0u8; 8];
    aws_lc_rs::rand::fill(&mut id).map_err(|_| no(503, "unavailable", "The console could not make a job id."))?;
    Ok(format!("j_{}", hex(&id)))
}

/// The start of the UTC day of `now`.
fn day_of(now: i64) -> i64 {
    now - now.rem_euclid(DAY)
}

/// The relay codes an `api-export` refusal may carry, answered as they are.
const RELAY_CODES: [&str; 12] = ["reviewers", "no-archive", "recipient", "suspended", "scope", "api-off", "map-expired", "jobs-full", "bad-request", "quota", "expired", "relay-outdated"];

/// An `api-export` failure as the request's refusal: the archive's own refusal where it is one of 5.3.2's, else 503
/// `archive-unreachable`.
fn relay_refusal(e: &LinkError) -> Refused {
    match e {
        LinkError::Refused { code, .. } if code == "owner-inactive" => no(403, "owner", "The client's owner is not active."),
        LinkError::Refused { status, code, error } => match RELAY_CODES.iter().find(|c| **c == code.as_str()) {
            Some(c) => no(*status, *c, error.clone()),
            None => no(503, "archive-unreachable", "The organization's archive did not take the request."),
        },
        _ => no(503, "archive-unreachable", "The organization's archive could not be reached."),
    }
}

/// `key_entry` is the request's idempotency entry (client, key, body hash, time), kept in the job record with the
/// answer; `kept` is true while a job record of this request is on disk.
fn request_fresh(desk: &dyn Desk, req: &Req, json: &Value, key_entry: &Value, kept: &mut bool) -> Result<Answer, Refused> {
    let o = json.as_object().ok_or_else(|| bad("The body is a JSON object."))?;
    if let Some(k) = o.keys().find(|k| !["matter", "reason", "scope", "reviewers"].contains(&k.as_str())) {
        return Err(bad(format!("{k} is not a field of an export request.")));
    }
    let matter = o.get("matter").and_then(Value::as_str).filter(|m| printable(m, MATTER_MAX)).ok_or_else(|| bad("matter is 1 to 128 printable characters."))?.to_string();
    let reason = o.get("reason").and_then(Value::as_str).filter(|r| printable(r, REASON_MAX)).ok_or_else(|| bad("reason is 1 to 500 printable characters."))?.to_string();
    let scope = scope_of(o.get("scope"), req.now)?;
    let reviewers = list_of(o.get("reviewers"), REVIEWERS_MAX, true, principal_ok, "reviewers")?;
    if reviewers.len() < REVIEWERS_MIN {
        return Err(no(409, "reviewers", "An export names 2 to 5 archive reviewers."));
    }
    // the client's standing and what the console derives (the archive derives it again from its own state)
    let st = standing(desk, req.org, req.client, req.now)?;
    let recipient = st.recipient.clone().ok_or_else(|| no(403, "recipient", "This client has no usable recipient key."))?;
    if reviewers.contains(&st.owner) {
        return Err(no(409, "reviewers", "The client's owner cannot be one of the reviewers."));
    }
    // ReviewW3: `client_lower_caps` is console-only, so the archive derives the signed map's larger cap until a map
    // folds the lowering; no new export while one is active
    if desk.console_active(req.org).iter().any(|e| e.action == "client_lower_caps" && e.field("client") == req.client) {
        return Err(no(409, "limits", "This client's caps were lowered; new exports wait until a signed api map carries them."));
    }
    desk.gate(req.org, &[crate::api_features::ARCHIVE]).map_err(|e| no(409, "relay-outdated", e.message))?;
    let archives = desk.archive_relays(req.org);
    if archives.is_empty() {
        return Err(no(409, "no-archive", "The organization has no archive."));
    }
    let relay = archives.iter().find(|r| desk.connected(r)).cloned().ok_or_else(|| no(503, "archive-unreachable", "No archive relay of the organization is connected."))?;
    // 5.3.8 quotas: requests per UTC day, and the bytes of jobs that reached ready today
    let caps = desk.caps(req.org, req.client);
    let all = jobs(desk, req.org);
    let day = day_of(req.now);
    let retry = day + DAY - req.now;
    let mine_today = all.iter().filter(|r| s(r, "client") == req.client && int(r, "requested_at") >= day);
    if mine_today.clone().count() as i64 >= caps.get("jobs_per_day").copied().unwrap_or(0) {
        return Err(Refused { retry: Some(retry), ..no(429, "quota", "This client made its export requests for today; see Retry-After.") });
    }
    let bytes_today: i64 = all.iter().filter(|r| s(r, "client") == req.client && int(r, "ready_at") >= day).map(|r| int(r, "zip_bytes")).sum();
    if bytes_today >= caps.get("day_max_bytes").copied().unwrap_or(0) {
        return Err(Refused { retry: Some(retry), ..no(429, "quota", "This client received its export bytes for today; see Retry-After.") });
    }
    if all.iter().filter(|r| OPEN.contains(&s(r, "state"))).count() >= OPEN_MAX {
        return Err(no(409, "jobs-full", "The organization has 20 open export jobs."));
    }
    if desk.dir().is_none() || desk.free_bytes().is_some_and(|f| f < STORAGE_MARGIN) {
        return Err(no(503, "export-storage", "The console cannot hold an export now."));
    }
    let job = new_job_id()?;
    let rec = json!({
        "job": job, "org": req.org, "client": req.client, "client_name": st.name, "owner": st.owner, "matter": matter, "reason": reason,
        "scope": scope, "format": FORMAT, "recipient": recipient, "max_bytes": st.max_bytes, "ceiling": st.ceiling, "map_seq": st.map_seq,
        "reviewers": reviewers, "requested_at": req.now, "state": "waiting", "relay": relay, "releases": 0, "idem": key_entry,
    });
    // audited and kept before the archive relay is asked
    let e = json!({ "rid": req.rid, "route": req.route_name, "action": "compliance.export.requested", "result": "ok", "job": job, "client": req.client,
                    "owner": st.owner, "reviewers": reviewers, "matter": matter });
    desk.record(req.org, e, req.now).map_err(|_| no(503, "audit-unavailable", "The audit log cannot record this request now; try again later."))?;
    {
        let _one = LOCK.lock();
        save(desk, req.org, &rec).map_err(|_| no(503, "export-storage", "The console could not keep the job; try again."))?;
        *kept = true;
    }
    // 2.5: the request fields only; the archive derives the rest itself (Rev4Review R4-2)
    let wire = json!({ "job": job, "client": req.client, "matter": matter, "reason": reason, "scope": scope, "reviewers": reviewers, "requested_at": req.now });
    if let Err(err) = desk.request(&relay, "api-export", json!({ "org": req.org, "job": wire }), LINK_MS) {
        let r = relay_refusal(&err);
        if let Some(dir) = job_dir(desk, req.org, &job) {
            let _one = LOCK.lock();
            *kept = std::fs::remove_dir_all(dir).is_err();
        }
        let _ = desk.record(req.org, json!({ "action": "compliance.export.ended", "result": "refused", "job": job, "state": "refused", "code": r.code }), req.now);
        publish_jobs(desk, req.org);
        return Err(r);
    }
    let answer = json!({ "job": job, "state": "waiting", "reviewers_needed": REVIEWERS_MIN, "expires_waiting": req.now + WAITING_S });
    // the answer joins the key in the job record, so a retry after a restart replays it
    {
        let _one = LOCK.lock();
        if let Some(mut r) = load(desk, req.org, &job) {
            r["idem"]["status"] = json!(202);
            r["idem"]["body"] = answer.clone();
            save_logged(desk, req.org, &r);
        }
    }
    publish_jobs(desk, req.org);
    desk.emit(req.org, "export.requested", json!({ "job": job, "client": req.client, "state": "waiting" }), req.now);
    Ok(ok(202, answer))
}

/// 5.3.7 `GET v1/compliance/exports?after&limit`: this client's jobs, newest first.
fn list(desk: &dyn Desk, req: &Req) -> Result<Answer, Refused> {
    let p = params(req.query)?;
    if let Some(k) = p.keys().find(|k| !["after", "limit"].contains(&k.as_str())) {
        return Err(bad(format!("{k} is not a parameter of this route.")));
    }
    let limit = match p.get("limit") {
        None => PAGE_DEFAULT,
        Some(l) => l.parse::<usize>().ok().filter(|n| (1..=PAGE_MAX).contains(n)).ok_or_else(|| bad("limit must be a number from 1 to 500."))?,
    };
    let after: Option<(i64, String)> = match p.get("after") {
        None => None,
        Some(a) => Some(unb64u(a).and_then(|b| String::from_utf8(b).ok()).and_then(|t| t.split_once(':').and_then(|(n, j)| Some((n.parse().ok()?, j.to_string())))).ok_or_else(|| bad("after is not a cursor of this list."))?),
    };
    let key = |r: &Value| (int(r, "requested_at"), s(r, "job").to_string());
    let mut page: Vec<Value> = jobs(desk, req.org).into_iter().filter(|r| s(r, "client") == req.client).filter(|r| after.as_ref().is_none_or(|a| key(r) < *a)).collect();
    let more = page.len() > limit;
    page.truncate(limit);
    let mut body = json!({ "jobs": page.iter().map(resource).collect::<Vec<_>>() });
    if let (true, Some(last)) = (more, page.last()) {
        let (n, j) = key(last);
        body["next"] = Value::from(b64u(format!("{n}:{j}").as_bytes()));
    }
    Ok(ok(200, body))
}

/// A download's checks (5.3.3, 5.3.8): `ready` (409 `job-state`), not past `expires` (410 `expired`), and the job's
/// ceiling at or below the client's current effective ceiling (403 `ceiling`).
fn downloadable(desk: &dyn Desk, req: &Req) -> Result<(Value, PathBuf), Refused> {
    let rec = mine(desk, req)?;
    let state = s(&rec, "state");
    if state == "expired" || (state == "ready" && int(&rec, "expires") <= req.now) {
        return Err(no(410, "expired", "This export has expired."));
    }
    if state != "ready" {
        return Err(no(409, "job-state", "This export is not ready."));
    }
    let st = standing(desk, req.org, req.client, req.now)?;
    if tok::rank(&st.ceiling).unwrap_or(0) < tok::rank(s(&rec, "ceiling")).unwrap_or(usize::MAX) {
        return Err(no(403, "ceiling", "This export is above the client's ceiling now."));
    }
    let dir = job_dir(desk, req.org, s(&rec, "job")).ok_or_else(|| no(503, "export-storage", "The console keeps no exports."))?;
    Ok((rec, dir))
}

fn read_seal(dir: &Path) -> Option<Value> {
    parse_json(&std::fs::read_to_string(dir.join(SEAL_FILE)).ok()?)
}

/// 5.3.7 `GET .../exports/{job}/seal`.
fn seal(desk: &dyn Desk, req: &Req) -> Result<Answer, Refused> {
    let (_, dir) = downloadable(desk, req)?;
    read_seal(&dir).map(|v| ok(200, v)).ok_or_else(|| no(503, "export-storage", "The console cannot read this export now."))
}

/// 5.3.7 `GET .../exports/{job}/parts/{n}`: one ciphertext part with its `ETag`; the last part fetched appends
/// `compliance.export.downloaded`.
fn part(desk: &dyn Desk, req: &Req) -> Result<Answer, Refused> {
    let (_, dir) = downloadable(desk, req)?;
    let seal = read_seal(&dir).ok_or_else(|| no(503, "export-storage", "The console cannot read this export now."))?;
    let parts = seal.get("parts").and_then(Value::as_u64).unwrap_or(0);
    let n = req.n.and_then(|n| n.parse::<u64>().ok()).filter(|n| *n < parts && req.n.is_some_and(|t| t == n.to_string())).ok_or_else(|| no(404, "not-found", NOT_FOUND))?;
    let data = std::fs::read(part_path(&dir, n)).map_err(|_| no(503, "export-storage", "The console cannot read this part now."))?;
    let sha = seal["part_sha256"][n as usize].as_str().unwrap_or_default().to_string();
    {
        let _one = LOCK.lock();
        if let Some(mut rec) = load(desk, req.org, s(&seal, "job")) {
            let mut fetched: Vec<u64> = rec.get("fetched").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_u64).collect();
            if !fetched.contains(&n) {
                fetched.push(n);
                fetched.sort_unstable();
                rec["fetched"] = json!(fetched);
                if fetched.len() as u64 == parts && rec.get("downloaded_at").is_none() {
                    let total: u64 = (0..parts).filter_map(|i| std::fs::metadata(part_path(&dir, i)).ok()).map(|m| m.len()).sum();
                    let e = json!({ "rid": req.rid, "route": req.route_name, "action": "compliance.export.downloaded", "result": "ok", "job": rec["job"], "bytes_out": total });
                    if desk.record(req.org, e, req.now).is_ok() {
                        rec["downloaded_at"] = json!(req.now);
                    }
                }
                save_logged(desk, req.org, &rec);
            }
        }
    }
    Ok(Answer { bytes: Some(data), etag: Some(format!("\"{sha}\"")), ..ok(200, Value::Null) })
}

/// 5.3.7 `POST .../exports/{job}/cancel`: a job that is not ready ends `canceled` (a tightening: no reviewers).
fn cancel(desk: &dyn Desk, req: &Req) -> Result<Answer, Refused> {
    let mut rec = mine(desk, req)?;
    if !OPEN.contains(&s(&rec, "state")) {
        return Err(no(409, "job-state", "Only a job that is not ready can be canceled."));
    }
    end_job(desk, req.org, &mut rec, "canceled", None, "Canceled by the client", req.now);
    Ok(ok(200, resource(&rec)))
}

// ── the console's Compliance page (13.1, 13.2) ──────────────────────────────────────────────────────────────────

pub const NO_JOB: &str = "There is no such export job.";
pub const JOB_ENDED: &str = "Nothing was changed: that export job has ended.";

/// 13.2: a job as the console's Compliance page shows it: its state, reviewers, releases, dates and bytes; never the
/// scope, reason, preview, recipient or any content (and, as 5.3.7, no code for a `refused` job).
pub fn console_row(rec: &Value) -> Value {
    let mut v = json!({
        "job": rec["job"], "client": rec["client"], "client_name": rec["client_name"], "owner": rec["owner"], "matter": rec["matter"],
        "state": rec["state"], "requested_at": rec["requested_at"], "reviewers": rec["reviewers"], "releases": int(rec, "releases"),
        "expires_waiting": int(rec, "requested_at") + WAITING_S,
    });
    for k in ["released_by", "released_at", "parts", "have", "zip_bytes", "ready_at", "expires", "ended_at", "downloaded_at"] {
        if let Some(x) = rec.get(k).filter(|x| !x.is_null()) {
            v[k] = x.clone();
        }
    }
    if s(rec, "state") != "refused" {
        if let Some(c) = rec.get("code").filter(|c| c.is_string()) {
            v["code"] = c.clone();
        }
    }
    v
}

/// 13.1 `GET compliance/exports?org=`: the org's jobs, newest first, the console's free space (`low` below the margin
/// a package needs, 5.3.8) and the org's archive relays.
pub fn console_view(desk: &dyn Desk, org: &str) -> Value {
    let free = desk.free_bytes();
    let rows: Vec<Value> = jobs(desk, org).iter().map(console_row).collect();
    json!({ "ok": true, "org": org, "jobs": rows, "storage": { "free_bytes": free, "low": free.is_some_and(|f| f < STORAGE_MARGIN) }, "archive_relays": desk.archive_relays(org) })
}

/// 13.1 `POST compliance/exports/cancel {org, job, reason}`: an open or `ready` job ends `canceled` with code `admin`
/// at once (a tightening): its package deleted, the archive relay told, `compliance.export.ended` and `export.ended`.
/// Ok is the job's row.
pub fn console_cancel(desk: &dyn Desk, org: &str, job: &str, reason: &str, now: i64) -> Result<Value, crate::console::ApiError> {
    let mut rec = load(desk, org, job).ok_or_else(|| crate::console::ApiError::with("not-found", NO_JOB))?;
    let state = s(&rec, "state");
    if !OPEN.contains(&state) && state != "ready" {
        return Err(crate::console::ApiError::with("stale", JOB_ENDED));
    }
    end_job(desk, org, &mut rec, "canceled", Some("admin"), reason, now);
    Ok(console_row(&rec))
}

/// 5.3.8 `ExportStorageLow` as an attention item: while the console's free space is below the margin, every org of
/// `known` whose pinned map lists a client with `compliance.export.request`, and every org with job records.
pub fn storage_low(desk: &dyn Desk, known: &[String]) -> Vec<String> {
    if !desk.free_bytes().is_some_and(|f| f < STORAGE_MARGIN) {
        return Vec::new();
    }
    let mut out: std::collections::BTreeSet<String> = orgs(desk).into_iter().collect();
    for org in known {
        let exports = desk.store(org).is_some_and(|store| {
            store.get(org, "").is_some_and(|vm| vm.map().get("clients").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_object).any(|c| tok::names(c, "scopes").any(|x| x == SCOPE)))
        });
        if exports {
            out.insert(org.clone());
        }
    }
    out.into_iter().collect()
}

// ── ends ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/// End a job: its state and code, the package deleted, the archive relay told (`api-export-cancel`, again from the
/// minute while it is not connected) when the job was still open there, `compliance.export.ended` and its event.
fn end_job(desk: &dyn Desk, org: &str, rec: &mut Value, state: &str, code: Option<&str>, reason: &str, now: i64) {
    let _one = LOCK.lock();
    let was_open = OPEN.contains(&s(rec, "state"));
    rec["state"] = json!(state);
    rec["ended_at"] = json!(now);
    match code {
        Some(c) => rec["code"] = json!(c),
        None => {
            if let Some(o) = rec.as_object_mut() {
                o.remove("code");
            }
        }
    }
    delete_package(desk, org, s(rec, "job"));
    // the archive deletes its sealed copy (a job the archive already ended answers its state)
    if was_open && matches!(state, "canceled" | "expired" | "failed") {
        rec["cancel_pending"] = json!(reason);
        send_cancel(desk, org, rec);
    }
    let mut e = json!({ "action": "compliance.export.ended", "result": "ok", "job": rec["job"], "state": state });
    let mut ev = json!({ "job": rec["job"], "client": rec["client"], "state": state });
    if let Some(c) = code.filter(|_| state != "refused") {
        e["code"] = json!(c);
        ev["code"] = json!(c);
    }
    if let Err(err) = desk.record(org, e, now) {
        crate::meet::log_error(&format!("api export org={org} job={} ended={state}, not audited: {err}", s(rec, "job")));
    }
    desk.emit(org, "export.ended", ev, now);
    save_logged(desk, org, rec);
    publish_jobs(desk, org);
}

/// `api-export-cancel` for a job with `cancel_pending`, cleared once the relay answered.
fn send_cancel(desk: &dyn Desk, org: &str, rec: &mut Value) {
    let relay = s(rec, "relay").to_string();
    let Some(reason) = rec.get("cancel_pending").and_then(Value::as_str).map(str::to_string) else { return };
    if relay.is_empty() || !desk.connected(&relay) {
        return;
    }
    let answered = match desk.request(&relay, "api-export-cancel", json!({ "org": org, "job": rec["job"], "reason": reason }), LINK_MS) {
        Ok(_) => true,
        // a relay or archive that holds nothing for the job has nothing to cancel
        Err(LinkError::Refused { code, .. }) => code == "not-found",
        Err(_) => false,
    };
    if answered {
        if let Some(o) = rec.as_object_mut() {
            o.remove("cancel_pending");
        }
    }
}

// ── from the archive relay ───────────────────────────────────────────────────────────────────────────────────────

fn refused(status: u16, code: &str, why: &str) -> Refusal {
    Refusal::new(status, code, why)
}

/// 2.5 `api-export-seal` and `api-export-part` from a relay (fleet_port hands them here).
pub fn fleet_in(desk: &dyn Desk, relay: &str, op: &str, body: &Value, now: i64) -> Result<Value, Refusal> {
    let org = s(body, "org");
    let job = s(body, "job");
    let mut rec = load(desk, org, job).filter(|r| s(r, "relay") == relay).ok_or_else(|| refused(404, "not-found", "The console holds no such job from this relay."))?;
    let dir = job_dir(desk, org, job).ok_or_else(|| refused(503, "export-storage", "The console keeps no exports."))?;
    match op {
        "api-export-seal" => take_seal(desk, org, &mut rec, &dir, body.get("seal").unwrap_or(&Value::Null), now),
        "api-export-part" => take_part(desk, org, &mut rec, &dir, body, now),
        _ => Err(Refusal::of("fleet-op")),
    }
}

/// 5.3.6: the seal header names this job, client and recipient, and its part list fits its sizes; Ok is `(parts,
/// zip_bytes)`. The client checks the signatures and certificates itself (R4-6).
pub fn check_seal(rec: &Value, seal: &Value) -> Result<(u64, u64), String> {
    let o = seal.as_object().ok_or("the seal is an object")?;
    if o.get("v").and_then(Value::as_i64) != Some(1) {
        return Err("the seal's v is 1".into());
    }
    for k in ["org", "job", "client"] {
        if o.get(k) != rec.get(k) {
            return Err(format!("the seal names another {k}"));
        }
    }
    if o.get("recipient") != rec.get("recipient") {
        return Err("the seal is for another recipient key".into());
    }
    let parts = o.get("parts").and_then(Value::as_u64).filter(|n| (1..=PARTS_MAX).contains(n)).ok_or("parts is 1 to 12800")?;
    if o.get("part_bytes").and_then(Value::as_u64) != Some(PART_BYTES) {
        return Err("part_bytes is 4194304".into());
    }
    let zip = o.get("zip_bytes").and_then(Value::as_u64).filter(|z| (parts - 1) * PART_BYTES < *z && *z <= parts * PART_BYTES).ok_or("zip_bytes does not fit parts")?;
    if !o.get("zip_sha256").is_some_and(hex64) {
        return Err("zip_sha256 is 64 hex".into());
    }
    if !o.get("part_sha256").and_then(Value::as_array).is_some_and(|a| a.len() as u64 == parts && a.iter().all(hex64)) {
        return Err("part_sha256 lists one hash per part".into());
    }
    if !o.get("wrap").and_then(Value::as_str).is_some_and(|w| w.split('.').count() == 5) {
        return Err("wrap is a compact JWE".into());
    }
    if !o.get("sig").and_then(Value::as_str).is_some_and(|x| !x.is_empty()) || !o.get("cert").and_then(Value::as_str).is_some_and(|x| !x.is_empty()) {
        return Err("the seal is signed by the archive".into());
    }
    let release = o.get("release").and_then(Value::as_object).ok_or("the seal carries its release")?;
    let body = release.get("body").ok_or("the release has its body")?;
    for k in ["job", "client", "recipient", "owner"] {
        if body.get(k) != rec.get(k) {
            return Err(format!("the release body names another {k}"));
        }
    }
    let reviewers: Vec<&str> = release.get("reviewers").and_then(Value::as_array).into_iter().flatten().filter_map(|r| r.get("reviewer").and_then(Value::as_str)).collect();
    let owner = s(rec, "owner");
    if reviewers.len() < REVIEWERS_MIN || reviewers.iter().any(|r| *r == owner) || reviewers.iter().enumerate().any(|(i, r)| reviewers[..i].contains(r)) {
        return Err("the release needs two distinct reviewers, neither the owner".into());
    }
    Ok((parts, zip))
}

fn take_seal(desk: &dyn Desk, org: &str, rec: &mut Value, dir: &Path, seal: &Value, now: i64) -> Result<Value, Refusal> {
    if !OPEN.contains(&s(rec, "state")) {
        return Err(refused(409, "job-state", "That job takes no seal now."));
    }
    if let Some(held) = read_seal(dir) {
        return if held == *seal { Ok(json!({ "ok": true })) } else { Err(refused(409, "job-state", "That job holds another seal.")) };
    }
    let (parts, zip) = check_seal(rec, seal).map_err(|why| refused(400, "seal", &why))?;
    // the job's derived limit, lowered since by `client_lower_caps`
    let cap = desk.caps(org, s(rec, "client")).get("job_max_bytes").copied().unwrap_or(0).min(int(rec, "max_bytes"));
    if zip as i64 > cap {
        end_job(desk, org, rec, "failed", Some("too-large"), "too-large", now);
        return Err(refused(409, "too-large", "The package is larger than the client may receive."));
    }
    if desk.free_bytes().is_some_and(|f| f < zip + STORAGE_MARGIN) {
        crate::meet::log_warn(&format!("ExportStorageLow org={org} job={} zip_bytes={zip}", s(rec, "job")));
        return Err(refused(503, "export-storage", "The console cannot hold this package now."));
    }
    let _one = LOCK.lock();
    crate::store::make_dir(dir).map_err(|e| refused(503, "export-storage", &e.to_string()))?;
    crate::fleet_local::write_durable(&dir.join(SEAL_FILE), stringify(seal).as_bytes()).map_err(|e| refused(503, "export-storage", &e))?;
    rec["state"] = json!("transferring");
    rec["parts"] = json!(parts);
    rec["zip_bytes"] = json!(zip);
    rec["have"] = json!(0);
    rec["got"] = json!(b64u(&vec![0u8; parts.div_ceil(8) as usize]));
    save(desk, org, rec).map_err(|e| refused(503, "export-storage", &e))?;
    publish_jobs(desk, org);
    Ok(json!({ "ok": true }))
}

fn take_part(desk: &dyn Desk, org: &str, rec: &mut Value, dir: &Path, body: &Value, now: i64) -> Result<Value, Refusal> {
    let seal = read_seal(dir).ok_or_else(|| refused(409, "no-seal", "The console holds no seal for that job yet."))?;
    let parts = seal.get("parts").and_then(Value::as_u64).unwrap_or(0);
    let n = body.get("n").and_then(Value::as_u64).filter(|n| *n < parts).ok_or_else(|| refused(400, "bad-request", "n is not a part of the seal."))?;
    let want = seal["part_sha256"][n as usize].as_str().unwrap_or_default();
    let state = s(rec, "state");
    let path = part_path(dir, n);
    if state == "ready" && path.exists() && s(body, "sha256") == want {
        return Ok(json!({ "ok": true, "have": parts, "ready": true }));
    }
    if state != "transferring" {
        return Err(refused(409, "job-state", "That job takes no part now."));
    }
    let data = body.get("data").and_then(Value::as_str).and_then(crate::meet_json::b64_strict).filter(|d| !d.is_empty() && d.len() <= PART_CIPHER_MAX).ok_or_else(|| refused(400, "bad-request", "data is standard base64 of one part."))?;
    let got = sha256_hex(&data);
    if got != want || s(body, "sha256") != want {
        return Err(refused(400, "part-hash", "The part does not match the seal's hash."));
    }
    let _one = LOCK.lock();
    // the caller's copy was read before the lock: reload and recheck, so two final parts cannot both move a stale
    // `transferring` copy to `ready` (and count the bytes twice)
    if let Some(fresh) = load(desk, org, s(rec, "job")) {
        *rec = fresh;
    }
    match s(rec, "state") {
        "transferring" => {}
        "ready" if s(body, "sha256") == want => return Ok(json!({ "ok": true, "have": parts, "ready": true })),
        _ => return Err(refused(409, "job-state", "That job takes no part now.")),
    }
    // ReviewW3: which parts are held is a bitmap saved after each part's file is flushed, so a part written before a
    // crash (its bit not saved) counts when it is sent again; a file alone never counts
    let size = parts.div_ceil(8) as usize;
    let mut held = rec.get("got").and_then(Value::as_str).and_then(unb64u).filter(|g| g.len() == size).unwrap_or_else(|| vec![0u8; size]);
    crate::fleet_local::write_durable(&path, &data).map_err(|e| refused(503, "export-storage", &e))?;
    held[(n / 8) as usize] |= 1 << (n % 8);
    let have = held.iter().map(|b| u64::from(b.count_ones())).sum::<u64>();
    rec["got"] = json!(b64u(&held));
    rec["have"] = json!(have);
    let ready = have == parts;
    if ready {
        rec["state"] = json!("ready");
        rec["ready_at"] = json!(now);
        rec["expires"] = json!(now + READY_S);
    }
    save(desk, org, rec).map_err(|e| refused(503, "export-storage", &e))?;
    if ready {
        // revision 4 12: counted once, by the part that made the job ready (a resent part answers above)
        crate::api_catalog::counters::compliance_export_bytes(org, s(rec, "client"), rec["zip_bytes"].as_u64().unwrap_or(0));
        publish_jobs(desk, org);
        let e = json!({ "action": "compliance.export.ready", "result": "ok", "job": rec["job"], "parts": parts, "zip_bytes": rec["zip_bytes"] });
        if let Err(err) = desk.record(org, e, now) {
            crate::meet::log_error(&format!("api export org={org} job={} ready, not audited: {err}", s(rec, "job")));
        }
        desk.emit(org, "export.ready", json!({ "job": rec["job"], "client": rec["client"], "state": "ready" }), now);
    }
    Ok(json!({ "ok": true, "have": have, "ready": ready }))
}

// ── the minute, and tightenings at once ──────────────────────────────────────────────────────────────────────────

/// The desk `tightened` uses (set each minute by `api_compliance::tick`).
static DESK: parking_lot::Mutex<Option<Arc<dyn Desk>>> = parking_lot::Mutex::new(None);

pub fn set_desk(desk: Arc<dyn Desk>) {
    *DESK.lock() = Some(desk);
}

/// A journal entry (relay or console journal) was appended for the org: its narrowed clients' jobs end at once, on
/// their own thread (the caller holds no lock the desk takes).
pub fn tightened(org: &str, now: i64) {
    let Some(desk) = DESK.lock().clone() else { return };
    let org = org.to_string();
    let _ = std::thread::Builder::new().name("api-exports".into()).spawn(move || cancel_narrowed(&*desk, &org, now));
}

/// 5.3.3: every open job of a narrowed client ends `canceled` with the narrowing as its code; a `ready` job whose
/// recipient was dropped loses its parts (2.4 `client_drop_recipient`).
pub fn cancel_narrowed(desk: &dyn Desk, org: &str, now: i64) {
    for mut rec in jobs(desk, org) {
        let state = s(&rec, "state").to_string();
        let open = OPEN.contains(&state.as_str());
        if !open && state != "ready" {
            continue;
        }
        match narrowed(desk, org, &rec, now) {
            Some(code) if open => end_job(desk, org, &mut rec, "canceled", Some(code), "The client was narrowed", now),
            Some("recipient") => end_job(desk, org, &mut rec, "canceled", Some("recipient"), "The recipient was dropped", now),
            _ => {}
        }
    }
}

/// The minute (`api_compliance::tick`'s thread): narrowed clients' jobs end, waiting jobs expire after 72 hours,
/// open jobs follow their archive relay (`api-export-status`), ready jobs expire after 7 days, and pending cancels are
/// sent again.
pub fn tick_now(desk: &dyn Desk, now: i64) {
    for org in orgs(desk) {
        cancel_narrowed(desk, &org, now);
        for mut rec in jobs(desk, &org) {
            let state = s(&rec, "state").to_string();
            if state == "waiting" && now - int(&rec, "requested_at") >= WAITING_S {
                end_job(desk, &org, &mut rec, "expired", None, "Not released within 72 hours", now);
            } else if OPEN.contains(&state.as_str()) {
                follow(desk, &org, &mut rec, now);
            } else if state == "ready" && now >= int(&rec, "expires") {
                end_job(desk, &org, &mut rec, "expired", None, "Expired", now);
            } else if state == "ready" && rec.get("released_at").is_none() {
                // every part arrived before a status poll saw the release: its audit entry still follows
                follow(desk, &org, &mut rec, now);
            } else if rec.get("cancel_pending").is_some() {
                let before = rec.clone();
                send_cancel(desk, &org, &mut rec);
                if rec != before {
                    let _one = LOCK.lock();
                    save_logged(desk, &org, &rec);
                }
            }
        }
        // revision 4 12: also after a restart, before any job moves
        publish_jobs(desk, &org);
    }
}

/// The preview counts the archive reports after release, and nothing else.
fn preview_of(v: &Value) -> Option<Value> {
    let o = v.as_object()?;
    let mut out = Map::new();
    for k in ["messages", "files", "ai", "bytes"] {
        out.insert(k.into(), Value::from(o.get(k)?.as_u64()?));
    }
    out.insert("over_limit".into(), Value::from(o.get("over_limit")?.as_bool()?));
    Some(Value::Object(out))
}

/// One `api-export-status` for an open job, and what it changes.
fn follow(desk: &dyn Desk, org: &str, rec: &mut Value, now: i64) {
    let relay = s(rec, "relay").to_string();
    if !desk.connected(&relay) {
        return;
    }
    let v = match desk.request(&relay, "api-export-status", json!({ "org": org, "job": rec["job"] }), LINK_MS) {
        Ok(v) => v,
        // the relay lost the job: nothing will release or carry it
        Err(LinkError::Refused { code, .. }) if code == "not-found" && OPEN.contains(&s(rec, "state")) => {
            end_job(desk, org, rec, "failed", Some("lost"), "The archive relay holds no such job", now);
            return;
        }
        Err(_) => return,
    };
    apply_status(desk, org, rec, &v, now);
}

/// 2.5 `api-export-status` applied to the console's record.
pub fn apply_status(desk: &dyn Desk, org: &str, rec: &mut Value, v: &Value, now: i64) {
    let before = rec.clone();
    if let Some(n) = v.get("releases").and_then(Value::as_u64) {
        rec["releases"] = json!(n);
    }
    let relay_state = s(v, "state");
    match relay_state {
        "released" | "building" | "transferring" | "ready" => {
            if let Some(p) = v.get("preview").and_then(preview_of) {
                rec["preview"] = p;
            }
            if let Some(x) = v.get("excluded_ceiling").and_then(Value::as_u64) {
                rec["excluded_ceiling"] = json!(x);
            }
            if s(rec, "state") == "waiting" {
                rec["state"] = json!(if relay_state == "building" { "building" } else { "released" });
            } else if s(rec, "state") == "released" && relay_state == "building" {
                rec["state"] = json!("building");
            }
            // once, whatever the console's state (the seal may arrive before the first status after release)
            if rec.get("released_at").is_none() {
                let by: Vec<String> = v.get("released_by").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect();
                rec["released_at"] = json!(now);
                rec["released_by"] = json!(by);
                let mut e = json!({ "action": "compliance.export.released", "result": "ok", "job": rec["job"] });
                if !by.is_empty() {
                    e["reviewers"] = json!(by);
                }
                if let Err(err) = desk.record(org, e, now) {
                    crate::meet::log_error(&format!("api export org={org} job={} released, not audited: {err}", s(rec, "job")));
                }
                desk.emit(org, "export.released", json!({ "job": rec["job"], "client": rec["client"], "state": "released" }), now);
                if desk.free_bytes().is_some_and(|f| f < STORAGE_MARGIN) {
                    crate::meet::log_warn(&format!("ExportStorageLow org={org} job={}", s(rec, "job")));
                }
            }
        }
        // a job the console holds whole is the console's to end
        "failed" | "refused" | "canceled" | "expired" if !OPEN.contains(&s(rec, "state")) => {}
        "failed" => {
            let code = v.get("code").and_then(Value::as_str).filter(|c| (1..=32).contains(&c.len()) && c.bytes().all(|b| b.is_ascii_lowercase() || b == b'-')).unwrap_or("failed").to_string();
            end_job(desk, org, rec, "failed", Some(&code), "Failed at the archive", now);
            return;
        }
        "refused" | "canceled" | "expired" => {
            let state = relay_state.to_string();
            end_job(desk, org, rec, &state, None, "Ended at the archive", now);
            return;
        }
        _ => {}
    }
    if *rec != before {
        let _one = LOCK.lock();
        save_logged(desk, org, rec);
    }
    if rec["state"] != before["state"] {
        publish_jobs(desk, org);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api_idempotency::IdemStore;
    use crate::api_map::{ApiMapError, ApiMapStore, VerifiedApiMap};
    use crate::api_resource::Body;
    use parking_lot::Mutex;
    use std::collections::{BTreeMap, HashMap};

    const ORG: &str = "acme";
    const NOW: i64 = 1_795_700_000;
    const KEY: &str = "\"ExportKey1234567890\"";
    const RA: &str = "r_00000000000000a1";
    const CLIENT: &str = "c_1b2c3d4e5f607182";
    /// A P-256 public point (the RFC 7515 A.3 example key).
    const X: &str = "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU";
    const Y: &str = "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0";

    type Answerer = Box<dyn Fn(&str, &str, &Value) -> Result<Value, LinkError> + Send + Sync>;

    struct Mock {
        dir: PathBuf,
        store: Mutex<ApiMapStore>,
        console: Mutex<Vec<crate::api_cjournal::ConsoleEntry>>,
        up: Mutex<HashMap<String, bool>>,
        answer: Answerer,
        sent: Mutex<Vec<(String, String, Value)>>,
        audit: Mutex<Vec<Value>>,
        events: Mutex<Vec<(String, Value)>>,
        idem: IdemStore,
        caps: Mutex<BTreeMap<String, i64>>,
        inactive: Mutex<Vec<String>>,
        free: Mutex<Option<u64>>,
    }

    impl Desk for Mock {
        fn relays(&self, _: &str) -> Vec<String> {
            vec![RA.into()]
        }
        fn connected(&self, relay: &str) -> bool {
            self.up.lock().get(relay).copied().unwrap_or(false)
        }
        fn request(&self, relay: &str, op: &str, body: Value, _: u64) -> Result<Value, LinkError> {
            self.sent.lock().push((relay.into(), op.into(), body.clone()));
            (self.answer)(relay, op, &body)
        }
        fn archive_relays(&self, _: &str) -> Vec<String> {
            vec![RA.into()]
        }
        fn gate(&self, _: &str, _: &[&str]) -> Result<(), ApiMapError> {
            Ok(())
        }
        fn caps(&self, _: &str, _: &str) -> BTreeMap<String, i64> {
            self.caps.lock().clone()
        }
        fn idempotency(&self) -> &IdemStore {
            &self.idem
        }
        fn dir(&self) -> Option<PathBuf> {
            Some(self.dir.clone())
        }
        fn record(&self, _: &str, entry: Value, _: i64) -> Result<(), String> {
            self.audit.lock().push(entry);
            Ok(())
        }
        fn emit(&self, _: &str, kind: &str, data: Value, _: i64) {
            self.events.lock().push((kind.into(), data));
        }
        fn store(&self, org: &str) -> Option<ApiMapStore> {
            Some(self.store.lock().org_snapshot(org))
        }
        fn console_active(&self, _: &str) -> Vec<crate::api_cjournal::ConsoleEntry> {
            self.console.lock().clone()
        }
        fn owner_active(&self, _: &str, principal: &str) -> bool {
            !self.inactive.lock().iter().any(|p| p == principal)
        }
        fn free_bytes(&self) -> Option<u64> {
            *self.free.lock()
        }
    }

    fn client_entry() -> Value {
        json!({"id": CLIENT, "name": "ediscovery-export", "principal": "ediscovery-export@apps.acme.example", "kind": "compliance",
               "owner": "lee@acme.example", "reach": "R1", "scopes": [SCOPE], "ceiling": "confidential", "relays": ["*"],
               "compliance": {"recipient": {"kid": "rcpt-2026-11", "jwk": {"kty": "EC", "crv": "P-256", "x": X, "y": Y}},
                              "job_max_bytes": 5368709120i64, "day_max_bytes": 21474836480i64, "jobs_per_day": 5},
               "created": NOW - 100, "expires": NOW + 365 * DAY, "state": "active"})
    }

    fn pinned_store() -> ApiMapStore {
        let map = json!({"v": 2, "org": ORG, "seq": 12, "issued": NOW - 100, "expires": NOW + 30 * DAY, "clients": [client_entry()]});
        let wire = json!({"map": map, "sig": "x", "chain": []}).as_object().unwrap().clone();
        let vm = VerifiedApiMap { wire, org: ORG.into(), seq: 12, expires: NOW + 30 * DAY, hash: "h12".into(), signer: "root".into() };
        let mut store = ApiMapStore::load(None);
        store.pin(vm).unwrap();
        store
    }

    fn mock(name: &str, answer: Answerer) -> Mock {
        let dir = std::env::temp_dir().join(format!("lucid-api-exports-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        Mock {
            dir,
            store: Mutex::new(pinned_store()),
            console: Mutex::default(),
            up: Mutex::new(HashMap::from([(RA.to_string(), true)])),
            answer,
            sent: Mutex::default(),
            audit: Mutex::default(),
            events: Mutex::default(),
            idem: IdemStore::load(None),
            caps: Mutex::new(BTreeMap::from([("job_max_bytes".to_string(), 5368709120i64), ("day_max_bytes".to_string(), 21474836480i64), ("jobs_per_day".to_string(), 5)])),
            inactive: Mutex::default(),
            free: Mutex::new(None),
        }
    }

    fn waiting() -> Answerer {
        Box::new(|_, op, _| match op {
            "api-export" => Ok(json!({"state": "waiting"})),
            "api-export-cancel" => Ok(json!({"state": "canceled"})),
            "api-export-status" => Ok(json!({"state": "waiting", "releases": 0})),
            _ => Err(LinkError::Refused { status: 400, code: "fleet-op".into(), error: "".into() }),
        })
    }

    fn request_body() -> Value {
        json!({"matter": "2026-114", "reason": "Production for matter 2026-114",
               "scope": {"people": ["Ann@acme.example"], "cids": [], "from": 1790000000, "to": 1795000000, "kinds": ["chat", "file", "ai"], "query": ""},
               "reviewers": ["rita@acme.example", "sam@acme.example", "tom@acme.example"]})
    }

    fn call(desk: &dyn Desk, route: RouteId, id: Option<&str>, n: Option<&str>, body: Option<Value>, key: Option<&str>, now: i64) -> Result<Answer, Refused> {
        let e = client_entry();
        let b = body.map(|j| Body { json: Ok(j), key: key.map(str::to_string) });
        let req = Req { org: ORG, route, route_name: "R", id, n, query: "", client: CLIENT, reach: &["*".to_string()], entry: e.as_object(), body: b.as_ref(), rid: "rid", now };
        serve(desk, &req)
    }

    fn post(desk: &dyn Desk, body: Value, key: &str) -> Result<Answer, Refused> {
        call(desk, RouteId::ComplianceExportRequest, None, None, Some(body), Some(key), NOW)
    }

    /// A seal of `parts` parts over `data` (each part's ciphertext), as the archive would send it.
    fn seal_for(rec: &Value, data: &[Vec<u8>]) -> Value {
        let parts = data.len() as u64;
        json!({"v": 1, "org": ORG, "job": rec["job"], "client": CLIENT, "made": NOW, "parts": parts, "part_bytes": PART_BYTES,
               "zip_bytes": (parts - 1) * PART_BYTES + 100, "zip_sha256": "a".repeat(64),
               "part_sha256": data.iter().map(|d| sha256_hex(d)).collect::<Vec<_>>(), "wrap": "h.k.i.c.t", "recipient": rec["recipient"],
               "release": {"body": {"op": "export_release", "job": rec["job"], "client": CLIENT, "owner": "lee@acme.example", "recipient": rec["recipient"]},
                           "body_sha256": "b".repeat(64),
                           "reviewers": [{"reviewer": "rita@acme.example", "ts": NOW, "sig": "s", "cert": "c"}, {"reviewer": "sam@acme.example", "ts": NOW, "sig": "s", "cert": "c"}],
                           "policy": "p"},
               "excluded_ceiling": 0, "cert": "pem", "sig": "sig"})
    }

    /// A fresh job (each with its own `Idempotency-Key`).
    fn requested(m: &Mock) -> Value {
        static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let key = format!("\"req-key-{:010}-abc\"", N.fetch_add(1, std::sync::atomic::Ordering::SeqCst));
        let a = post(m, request_body(), &key).unwrap();
        load(m, ORG, a.body["job"].as_str().unwrap()).unwrap()
    }

    #[test]
    fn a_request_sends_only_its_fields_audits_and_answers_without_counts() {
        let m = mock("request", waiting());
        let a = post(&m, request_body(), KEY).unwrap();
        assert_eq!(a.status, 202);
        assert_eq!((a.body["state"].as_str(), a.body["reviewers_needed"].as_u64(), a.body["expires_waiting"].as_i64()), (Some("waiting"), Some(2), Some(NOW + WAITING_S)));
        assert_eq!(a.body.as_object().unwrap().len(), 4, "no counts or derived fields: {}", a.body);
        let sent = m.sent.lock()[0].clone();
        assert_eq!((sent.0.as_str(), sent.1.as_str()), (RA, "api-export"));
        let wire = sent.2["job"].as_object().unwrap();
        let mut keys: Vec<&str> = wire.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["client", "job", "matter", "reason", "requested_at", "reviewers", "scope"], "never derived fields (R4-2)");
        assert_eq!(wire["scope"]["people"], json!(["ann@acme.example"]));
        // the record's derived fields come from the console's own map
        let rec = load(&m, ORG, a.body["job"].as_str().unwrap()).unwrap();
        assert_eq!((rec["owner"].as_str(), rec["ceiling"].as_str(), rec["max_bytes"].as_i64(), rec["map_seq"].as_i64()), (Some("lee@acme.example"), Some("confidential"), Some(5368709120), Some(12)));
        assert_eq!(rec["recipient"]["kid"], "rcpt-2026-11");
        assert_eq!(rec["recipient"]["jkt"].as_str().map(str::len), Some(43));
        let audit = m.audit.lock()[0].clone();
        assert_eq!((audit["action"].as_str(), audit["reviewers"].clone(), audit["matter"].as_str()), (Some("compliance.export.requested"), json!(["rita@acme.example", "sam@acme.example", "tom@acme.example"]), Some("2026-114")));
        assert_eq!(m.events.lock()[0].0, "export.requested");
        // the same key and body: the same job, nothing sent again
        let again = post(&m, request_body(), KEY).unwrap();
        assert!(again.replayed && again.body["job"] == a.body["job"]);
        assert_eq!(m.sent.lock().len(), 1);
        // readable, without a preview while waiting
        let one = call(&m, RouteId::ComplianceExport, a.body["job"].as_str(), None, None, None, NOW).unwrap();
        assert!(one.body.get("preview").is_none() && one.body["state"] == "waiting");
        let _ = std::fs::remove_dir_all(&m.dir);
    }

    #[test]
    fn a_retry_after_a_restart_finds_the_key_in_the_job_record() {
        let m = mock("restart", waiting());
        let a = post(&m, request_body(), KEY).unwrap();
        let job = a.body["job"].as_str().unwrap().to_string();
        // a restart: the key is gone from memory, the job record stays on disk
        let after = || Mock { dir: m.dir.clone(), ..mock("restart-fresh", waiting()) };
        let r = after();
        let again = post(&r, request_body(), KEY).unwrap();
        assert!(again.replayed && again.body == a.body, "the kept answer is replayed: {}", again.body);
        assert!(r.sent.lock().is_empty(), "nothing sent again");
        let r = after();
        let mut other = request_body();
        other["matter"] = json!("2026-115");
        let e = post(&r, other.clone(), KEY).err().unwrap();
        assert_eq!((e.status, e.code), (422, idem::MISMATCH.code));
        // a crash between the job save and the answer: the record has the key without the answer, so a retry is busy
        let mut rec = load(&m, ORG, &job).unwrap();
        rec["idem"].as_object_mut().unwrap().retain(|k, _| !["status", "body"].contains(&k.as_str()));
        save(&m, ORG, &rec).unwrap();
        let r = after();
        let e = post(&r, request_body(), KEY).err().unwrap();
        assert_eq!((e.status, e.code), (idem::BUSY.status, idem::BUSY.code));
        assert!(r.sent.lock().is_empty());
        let r = after();
        assert_eq!(post(&r, other, KEY).err().unwrap().status, 422);
        assert_eq!(jobs(&m, ORG).len(), 1, "never a second job");
        let _ = std::fs::remove_dir_all(&m.dir);
    }

    #[test]
    fn requests_are_checked_before_anything_is_kept() {
        let m = mock("checks", waiting());
        let cases: Vec<(Value, &str)> = vec![
            (json!({"reviewers": ["rita@acme.example"]}), "reviewers"),
            (json!({"reviewers": ["rita@acme.example", "lee@acme.example"]}), "reviewers"),
            (json!({"matter": ""}), "bad-request"),
            (json!({"reason": "x".repeat(501)}), "bad-request"),
            (json!({"scope": {"people": [], "cids": [], "from": 1, "to": 2, "kinds": ["chat"]}}), "bad-request"),
            (json!({"scope": {"people": ["a@acme.example"], "from": 5, "to": 5, "kinds": ["chat"]}}), "bad-request"),
            (json!({"scope": {"people": ["a@acme.example"], "from": 1, "to": NOW + 10, "kinds": ["chat"]}}), "bad-request"),
            (json!({"scope": {"people": ["a@acme.example"], "from": 1, "to": 2, "kinds": []}}), "bad-request"),
            (json!({"scope": {"people": ["a@acme.example"], "from": 1, "to": 2, "kinds": ["mail"]}}), "bad-request"),
            (json!({"owner": "x@acme.example"}), "bad-request"),
            (json!({"max_bytes": 1}), "bad-request"),
        ];
        for (i, (patch, code)) in cases.into_iter().enumerate() {
            let mut b = request_body();
            for (k, v) in patch.as_object().unwrap() {
                b[k] = v.clone();
            }
            assert_eq!(post(&m, b, &format!("\"check-key-{i:04}-abcdefgh\"")).err().unwrap().code, code, "case {i}");
        }
        assert!(m.sent.lock().is_empty() && m.audit.lock().is_empty());
        assert!(jobs(&m, ORG).is_empty());
        let _ = std::fs::remove_dir_all(&m.dir);
    }

    #[test]
    fn standing_refuses_a_narrowed_client_and_a_dropped_recipient() {
        let m = mock("standing", waiting());
        assert!(standing(&m, ORG, CLIENT, NOW).is_ok());
        m.inactive.lock().push("lee@acme.example".into());
        assert_eq!(post(&m, request_body(), KEY).err().unwrap().code, "owner");
        m.inactive.lock().clear();
        let drop = crate::api_cjournal::ConsoleEntry::parse(&json!({"id": "k_acme_000001", "cseq": 1, "ts": NOW, "action": "client_drop_recipient",
                                                                      "target": {"client": CLIENT, "kid": "rcpt-2026-11"}, "reach": "console"})).unwrap();
        m.console.lock().push(drop);
        assert_eq!(post(&m, request_body(), "\"second-key-123456789\"").err().unwrap().code, "recipient");
        m.console.lock().clear();
        m.store.lock().apply_tighten(ORG, &json!({"id": "t_acme_000001", "tseq": 1, "ts": NOW, "action": "client_lower_ceiling", "target": {"client": CLIENT, "ceiling": "internal"}})).unwrap();
        assert_eq!(standing(&m, ORG, CLIENT, NOW).unwrap().ceiling, "internal");
        m.store.lock().apply_tighten(ORG, &json!({"id": "t_acme_000002", "tseq": 2, "ts": NOW, "action": "client_drop_scope", "target": {"client": CLIENT, "scope": SCOPE}})).unwrap();
        assert_eq!(standing(&m, ORG, CLIENT, NOW).err().unwrap().code, "scope");
        m.store.lock().apply_tighten(ORG, &json!({"id": "t_acme_000003", "tseq": 3, "ts": NOW, "action": "client_suspend", "target": CLIENT})).unwrap();
        assert_eq!(standing(&m, ORG, CLIENT, NOW).err().unwrap().code, "suspended");
        let _ = std::fs::remove_dir_all(&m.dir);
    }

    #[test]
    fn an_archive_refusal_withdraws_the_job_and_quotas_count_the_day() {
        let m = mock("refused", Box::new(|_, _, _| Err(LinkError::Refused { status: 409, code: "reviewers".into(), error: "not a reviewer".into() })));
        assert_eq!(post(&m, request_body(), KEY).err().unwrap().code, "reviewers");
        assert!(jobs(&m, ORG).is_empty(), "nothing kept");
        assert!(m.audit.lock().iter().any(|e| e["action"] == "compliance.export.ended" && e["state"] == "refused"));
        let _ = std::fs::remove_dir_all(&m.dir);
        let q = mock("quota", waiting());
        q.caps.lock().insert("jobs_per_day".into(), 1);
        assert_eq!(post(&q, request_body(), KEY).unwrap().status, 202);
        let r = post(&q, request_body(), "\"quota-key-1234567890\"").err().unwrap();
        assert_eq!((r.status, r.code, r.retry), (429, "quota", Some(day_of(NOW) + DAY - NOW)));
        let _ = std::fs::remove_dir_all(&q.dir);
        let off = mock("offline", waiting());
        off.up.lock().clear();
        assert_eq!(post(&off, request_body(), KEY).err().unwrap().code, "archive-unreachable");
        let _ = std::fs::remove_dir_all(&off.dir);
    }

    #[test]
    fn release_seal_parts_ready_and_download() {
        let m = mock("flow", Box::new(|_, op, _| match op {
            "api-export" => Ok(json!({"state": "waiting"})),
            "api-export-status" => Ok(json!({"state": "released", "releases": 2, "released_by": ["rita@acme.example", "sam@acme.example"],
                                             "preview": {"messages": 3, "files": 1, "ai": 0, "bytes": 2048, "over_limit": false, "nonce": "n"}})),
            _ => Ok(json!({})),
        }));
        let rec = requested(&m);
        let job = rec["job"].as_str().unwrap().to_string();
        // a part before the seal is refused
        let data = vec![vec![1u8; 64], vec![2u8; 32]];
        let part0 = json!({"org": ORG, "job": job, "n": 0, "data": crate::meet_json::b64(&data[0]), "sha256": sha256_hex(&data[0])});
        assert_eq!(fleet_in(&m, RA, "api-export-part", &part0, NOW).err().unwrap().code, "no-seal");
        // another relay cannot push to it
        assert_eq!(fleet_in(&m, "r_00000000000000ff", "api-export-seal", &json!({"org": ORG, "job": job, "seal": seal_for(&rec, &data)}), NOW).err().unwrap().code, "not-found");
        tick_now(&m, NOW + 60);
        let after = load(&m, ORG, &job).unwrap();
        assert_eq!((after["state"].as_str(), after["releases"].as_u64()), (Some("released"), Some(2)));
        assert_eq!(after["preview"], json!({"messages": 3, "files": 1, "ai": 0, "bytes": 2048, "over_limit": false}), "no nonce kept");
        assert!(m.audit.lock().iter().any(|e| e["action"] == "compliance.export.released" && e["reviewers"] == json!(["rita@acme.example", "sam@acme.example"])));
        // a seal for another recipient or client is refused; the right one is kept
        let mut other = seal_for(&rec, &data);
        other["recipient"]["jkt"] = json!("other");
        assert_eq!(fleet_in(&m, RA, "api-export-seal", &json!({"org": ORG, "job": job, "seal": other}), NOW).err().unwrap().code, "seal");
        let mut owner = seal_for(&rec, &data);
        owner["release"]["reviewers"][1]["reviewer"] = json!("lee@acme.example");
        assert_eq!(fleet_in(&m, RA, "api-export-seal", &json!({"org": ORG, "job": job, "seal": owner}), NOW).err().unwrap().code, "seal");
        fleet_in(&m, RA, "api-export-seal", &json!({"org": ORG, "job": job, "seal": seal_for(&rec, &data)}), NOW).unwrap();
        // a part with a wrong hash is refused
        let mut wrong = part0.clone();
        wrong["data"] = json!(crate::meet_json::b64(&[9u8; 64]));
        assert_eq!(fleet_in(&m, RA, "api-export-part", &wrong, NOW).err().unwrap().code, "part-hash");
        assert_eq!(fleet_in(&m, RA, "api-export-part", &part0, NOW).unwrap()["ready"], false);
        // not ready yet: no download
        assert_eq!(call(&m, RouteId::ComplianceExportSeal, Some(&job), None, None, None, NOW).err().unwrap().code, "job-state");
        let part1 = json!({"org": ORG, "job": job, "n": 1, "data": crate::meet_json::b64(&data[1]), "sha256": sha256_hex(&data[1])});
        assert_eq!(fleet_in(&m, RA, "api-export-part", &part1, NOW).unwrap()["ready"], true);
        assert!(m.audit.lock().iter().any(|e| e["action"] == "compliance.export.ready" && e["parts"] == 2));
        // the console holds ciphertext only: exactly the bytes it was sent
        let dir = job_dir(&m, ORG, &job).unwrap();
        assert_eq!(std::fs::read(part_path(&dir, 0)).unwrap(), data[0]);
        // downloads
        let s = call(&m, RouteId::ComplianceExportSeal, Some(&job), None, None, None, NOW).unwrap();
        assert_eq!(s.body["parts"], 2);
        let p = call(&m, RouteId::ComplianceExportPart, Some(&job), Some("1"), None, None, NOW).unwrap();
        assert_eq!((p.bytes.as_deref(), p.etag.clone()), (Some(&data[1][..]), Some(format!("\"{}\"", sha256_hex(&data[1])))));
        assert!(call(&m, RouteId::ComplianceExportPart, Some(&job), Some("2"), None, None, NOW).is_err());
        assert!(call(&m, RouteId::ComplianceExportPart, Some(&job), Some("01"), None, None, NOW).is_err());
        call(&m, RouteId::ComplianceExportPart, Some(&job), Some("0"), None, None, NOW).unwrap();
        assert_eq!(m.audit.lock().iter().filter(|e| e["action"] == "compliance.export.downloaded").count(), 1);
        // a lowered ceiling refuses downloads of the ready job (it stays)
        m.store.lock().apply_tighten(ORG, &json!({"id": "t_acme_000001", "tseq": 1, "ts": NOW, "action": "client_lower_ceiling", "target": {"client": CLIENT, "ceiling": "internal"}})).unwrap();
        assert_eq!(call(&m, RouteId::ComplianceExportPart, Some(&job), Some("0"), None, None, NOW).err().unwrap().code, "ceiling");
        // 7 days after ready: expired, parts gone, 410
        tick_now(&m, NOW + READY_S + 1);
        assert!(!part_path(&dir, 0).exists() && !dir.join(SEAL_FILE).exists());
        assert_eq!(call(&m, RouteId::ComplianceExportSeal, Some(&job), None, None, None, NOW + READY_S + 2).err().unwrap().code, "expired");
        let _ = std::fs::remove_dir_all(&m.dir);
    }

    #[test]
    fn tightenings_cancel_open_jobs_and_waiting_jobs_expire() {
        let m = mock("tighten", waiting());
        let rec = requested(&m);
        let job = rec["job"].as_str().unwrap().to_string();
        // a recipient dropped: canceled at once, the archive told
        let drop = crate::api_cjournal::ConsoleEntry::parse(&json!({"id": "k_acme_000001", "cseq": 1, "ts": NOW, "action": "client_drop_recipient",
                                                                      "target": {"client": CLIENT, "kid": "rcpt-2026-11"}, "reach": "console"})).unwrap();
        m.console.lock().push(drop);
        cancel_narrowed(&m, ORG, NOW + 1);
        let after = load(&m, ORG, &job).unwrap();
        assert_eq!((after["state"].as_str(), after["code"].as_str()), (Some("canceled"), Some("recipient")));
        assert!(m.sent.lock().iter().any(|(_, op, b)| op == "api-export-cancel" && b["job"] == json!(job)));
        assert!(m.audit.lock().iter().any(|e| e["action"] == "compliance.export.ended" && e["state"] == "canceled" && e["code"] == "recipient"));
        m.console.lock().clear();
        // api_off cancels; a waiting job expires after 72 hours
        let rec2 = requested(&m);
        m.store.lock().apply_tighten(ORG, &json!({"id": "t_acme_000001", "tseq": 1, "ts": NOW, "action": "api_off", "target": ORG})).unwrap();
        tick_now(&m, NOW + 60);
        assert_eq!(load(&m, ORG, rec2["job"].as_str().unwrap()).unwrap()["code"], "api-off");
        let _ = std::fs::remove_dir_all(&m.dir);
        let w = mock("waiting", waiting());
        let rec3 = requested(&w);
        tick_now(&w, NOW + WAITING_S - 1);
        assert_eq!(load(&w, ORG, rec3["job"].as_str().unwrap()).unwrap()["state"], "waiting");
        tick_now(&w, NOW + WAITING_S);
        assert_eq!(load(&w, ORG, rec3["job"].as_str().unwrap()).unwrap()["state"], "expired");
        // the client cancels its own open job; a second cancel is job-state
        let rec4 = requested(&w);
        let c = call(&w, RouteId::ComplianceExportCancel, rec4["job"].as_str(), None, None, None, NOW).unwrap();
        assert_eq!(c.body["state"], "canceled");
        assert_eq!(call(&w, RouteId::ComplianceExportCancel, rec4["job"].as_str(), None, None, None, NOW).err().unwrap().code, "job-state");
        let _ = std::fs::remove_dir_all(&w.dir);
    }

    #[test]
    fn a_package_above_the_lowered_cap_fails_too_large() {
        let m = mock("too-large", waiting());
        let rec = requested(&m);
        let job = rec["job"].as_str().unwrap().to_string();
        m.caps.lock().insert("job_max_bytes".into(), 50);
        let data = vec![vec![1u8; 64]];
        assert_eq!(fleet_in(&m, RA, "api-export-seal", &json!({"org": ORG, "job": job, "seal": seal_for(&rec, &data)}), NOW).err().unwrap().code, "too-large");
        let after = load(&m, ORG, &job).unwrap();
        assert_eq!((after["state"].as_str(), after["code"].as_str()), (Some("failed"), Some("too-large")));
        let _ = std::fs::remove_dir_all(&m.dir);
    }

    #[test]
    fn a_refused_job_shows_no_reason_and_the_list_pages() {
        let m = mock("list", Box::new(|_, op, _| match op {
            "api-export" => Ok(json!({"state": "waiting"})),
            "api-export-status" => Ok(json!({"state": "refused", "code": "declined"})),
            _ => Ok(json!({})),
        }));
        let a = requested(&m);
        let b = post(&m, request_body(), "\"list-key-2-123456789\"").unwrap();
        tick_now(&m, NOW + 60);
        let one = call(&m, RouteId::ComplianceExport, a["job"].as_str(), None, None, None, NOW).unwrap();
        assert!(one.body["state"] == "refused" && one.body.get("code").is_none());
        let e = Req { org: ORG, route: RouteId::ComplianceExports, route_name: "R", id: None, n: None, query: "limit=1", client: CLIENT, reach: &[], entry: None, body: None, rid: "rid", now: NOW };
        let page = serve(&m, &e).unwrap().body;
        assert_eq!(page["jobs"].as_array().unwrap().len(), 1);
        let next = format!("limit=1&after={}", page["next"].as_str().unwrap());
        let e2 = Req { query: &next, ..e };
        let page2 = serve(&m, &e2).unwrap().body;
        assert_eq!(page2["jobs"].as_array().unwrap().len(), 1);
        assert_ne!(page["jobs"][0]["job"], page2["jobs"][0]["job"]);
        let _ = b;
        let _ = std::fs::remove_dir_all(&m.dir);
    }

    fn lower_caps(client: &str, cap: i64) -> crate::api_cjournal::ConsoleEntry {
        crate::api_cjournal::ConsoleEntry::parse(&json!({"id": "k_acme_000001", "cseq": 1, "ts": NOW, "action": "client_lower_caps",
                                                         "target": {"client": client, "job_max_bytes": cap}, "reach": "console"})).unwrap()
    }

    #[test]
    fn a_lowered_cap_cancels_open_jobs_with_limits() {
        // ReviewW3 3: `Standing.max_bytes` below the job's derived `max_bytes` narrows the job
        let m = mock("limits", waiting());
        let rec = requested(&m);
        m.caps.lock().insert("job_max_bytes".into(), 1_048_576);
        cancel_narrowed(&m, ORG, NOW + 1);
        let after = load(&m, ORG, rec["job"].as_str().unwrap()).unwrap();
        assert_eq!((after["state"].as_str(), after["code"].as_str()), (Some("canceled"), Some("limits")));
        let _ = std::fs::remove_dir_all(&m.dir);
    }

    #[test]
    fn no_new_export_while_a_caps_lowering_is_not_in_a_signed_map() {
        // ReviewW3 4: the archive would derive the map's larger cap, so the console refuses until a map folds it
        let m = mock("unfolded", waiting());
        m.console.lock().push(lower_caps(CLIENT, 1_048_576));
        assert_eq!(post(&m, request_body(), KEY).err().unwrap().code, "limits");
        assert!(m.sent.lock().is_empty() && jobs(&m, ORG).is_empty());
        // another client's lowering does not stop this one; a folded entry is no longer active
        m.console.lock().clear();
        m.console.lock().push(lower_caps("c_00000000000000ff", 1_048_576));
        assert_eq!(post(&m, request_body(), "\"unfolded-key-1234567\"").unwrap().status, 202);
        let _ = std::fs::remove_dir_all(&m.dir);
    }

    #[test]
    fn a_part_written_before_a_crash_counts_when_sent_again() {
        // ReviewW3 5: the file is on disk but the record never saved its bit; the resend completes the job
        let m = mock("crash", waiting());
        let rec = requested(&m);
        let job = rec["job"].as_str().unwrap().to_string();
        let data = vec![vec![1u8; 64], vec![2u8; 32]];
        fleet_in(&m, RA, "api-export-seal", &json!({"org": ORG, "job": job, "seal": seal_for(&rec, &data)}), NOW).unwrap();
        let dir = job_dir(&m, ORG, &job).unwrap();
        std::fs::write(part_path(&dir, 0), &data[0]).unwrap();
        let part = |n: usize| json!({"org": ORG, "job": job, "n": n, "data": crate::meet_json::b64(&data[n]), "sha256": sha256_hex(&data[n])});
        assert_eq!(fleet_in(&m, RA, "api-export-part", &part(1), NOW).unwrap()["have"], 1, "a file alone does not count");
        let again = fleet_in(&m, RA, "api-export-part", &part(0), NOW).unwrap();
        assert_eq!((again["have"].as_u64(), again["ready"].as_bool()), (Some(2), Some(true)));
        // a part sent twice counts once
        assert_eq!(fleet_in(&m, RA, "api-export-part", &part(1), NOW).unwrap()["have"], 2);
        let _ = std::fs::remove_dir_all(&m.dir);
    }

    fn releasing() -> Answerer {
        Box::new(|_, op, _| match op {
            "api-export" => Ok(json!({"state": "waiting"})),
            "api-export-status" => Ok(json!({"state": "released", "releases": 2, "released_by": ["rita@acme.example", "sam@acme.example"],
                                             "preview": {"messages": 3, "files": 1, "ai": 0, "bytes": 2048, "over_limit": false}})),
            _ => Ok(json!({})),
        })
    }

    /// A job taken to `ready` with one part; Ok also the part's path.
    fn ready_job(m: &Mock) -> (String, PathBuf) {
        let rec = requested(m);
        let job = rec["job"].as_str().unwrap().to_string();
        tick_now(m, NOW + 60);
        let data = vec![vec![1u8; 64]];
        fleet_in(m, RA, "api-export-seal", &json!({"org": ORG, "job": job, "seal": seal_for(&rec, &data)}), NOW + 61).unwrap();
        let part = json!({"org": ORG, "job": job, "n": 0, "data": crate::meet_json::b64(&data[0]), "sha256": sha256_hex(&data[0])});
        assert_eq!(fleet_in(m, RA, "api-export-part", &part, NOW + 62).unwrap()["ready"], true);
        let path = part_path(&job_dir(m, ORG, &job).unwrap(), 0);
        assert!(path.exists());
        (job, path)
    }

    #[test]
    fn the_console_list_shows_states_and_bytes_never_content() {
        let m = mock("console-list", releasing());
        let (job, _) = ready_job(&m);
        let waiting = requested(&m);
        *m.free.lock() = Some(STORAGE_MARGIN - 1);
        let v = console_view(&m, ORG);
        assert_eq!((v["ok"].clone(), v["org"].as_str()), (json!(true), Some(ORG)));
        assert_eq!(v["storage"], json!({"free_bytes": STORAGE_MARGIN - 1, "low": true}));
        assert_eq!(v["archive_relays"], json!([RA]));
        let rows = v["jobs"].as_array().unwrap();
        assert_eq!(rows.len(), 2);
        let ready = rows.iter().find(|r| r["job"] == json!(job)).unwrap();
        let mut keys: Vec<&str> = ready.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["client", "client_name", "expires", "expires_waiting", "have", "job", "matter", "owner", "parts", "ready_at", "released_at", "released_by", "releases", "requested_at", "reviewers", "state", "zip_bytes"]);
        assert_eq!((ready["state"].as_str(), ready["parts"].as_u64(), ready["zip_bytes"].as_u64(), ready["releases"].as_u64()), (Some("ready"), Some(1), Some(100), Some(2)));
        assert_eq!((ready["client_name"].as_str(), ready["owner"].as_str()), (Some("ediscovery-export"), Some("lee@acme.example")));
        assert_eq!(ready["expires_waiting"].as_i64(), Some(NOW + WAITING_S));
        let w = rows.iter().find(|r| r["job"] == waiting["job"]).unwrap();
        assert_eq!(w["state"], "waiting");
        let all = stringify(&v);
        for never in ["scope", "reason", "preview", "recipient", "Production for matter", "ann@acme.example", "rcpt-2026-11", "messages"] {
            assert!(!all.contains(never), "{never} in {all}");
        }
        *m.free.lock() = Some(STORAGE_MARGIN);
        assert_eq!(console_view(&m, ORG)["storage"]["low"], false);
        let _ = std::fs::remove_dir_all(&m.dir);
    }

    #[test]
    fn an_admin_cancels_a_waiting_or_a_ready_job() {
        let m = mock("console-cancel", releasing());
        // waiting: canceled with code admin, the archive told, audited and an event
        let rec = requested(&m);
        let job = rec["job"].as_str().unwrap().to_string();
        let row = console_cancel(&m, ORG, &job, "Matter closed", NOW + 5).unwrap();
        assert_eq!((row["state"].as_str(), row["code"].as_str(), row["ended_at"].as_i64()), (Some("canceled"), Some("admin"), Some(NOW + 5)));
        assert!(m.sent.lock().iter().any(|(_, op, b)| op == "api-export-cancel" && b["job"] == json!(job) && b["reason"] == "Matter closed"));
        assert!(m.audit.lock().iter().any(|e| e["action"] == "compliance.export.ended" && e["job"] == json!(job) && e["state"] == "canceled" && e["code"] == "admin"));
        assert!(m.events.lock().iter().any(|(k, d)| k == "export.ended" && d["job"] == json!(job) && d["code"] == "admin"));
        // ended: stale; unknown: not-found
        assert_eq!(console_cancel(&m, ORG, &job, "again", NOW + 6).unwrap_err().code, "stale");
        assert_eq!(console_cancel(&m, ORG, "j_0000000000000000", "x", NOW).unwrap_err().code, "not-found");
        assert_eq!(console_cancel(&m, ORG, "../x", "x", NOW).unwrap_err().code, "not-found");
        // ready: canceled with code admin, its package deleted
        let (ready, part) = ready_job(&m);
        let dir = job_dir(&m, ORG, &ready).unwrap();
        let row = console_cancel(&m, ORG, &ready, "Sent to the wrong archive", NOW + 70).unwrap();
        assert_eq!((row["state"].as_str(), row["code"].as_str()), (Some("canceled"), Some("admin")));
        assert!(!part.exists() && !dir.join(SEAL_FILE).exists(), "the package is deleted");
        assert_eq!(load(&m, ORG, &ready).unwrap()["state"], "canceled");
        assert_eq!(call(&m, RouteId::ComplianceExportSeal, Some(&ready), None, None, None, NOW + 71).err().unwrap().code, "job-state");
        let _ = std::fs::remove_dir_all(&m.dir);
    }

    #[test]
    fn storage_low_names_the_orgs_that_use_exports() {
        let m = mock("storage-low", waiting());
        let known = vec![ORG.to_string(), "other".to_string()];
        assert!(storage_low(&m, &known).is_empty(), "free space unknown");
        *m.free.lock() = Some(STORAGE_MARGIN);
        assert!(storage_low(&m, &known).is_empty(), "at the margin");
        *m.free.lock() = Some(STORAGE_MARGIN - 1);
        assert_eq!(storage_low(&m, &known), vec![ORG.to_string()], "the org whose map lists an export client");
        assert_eq!(storage_low(&m, &[]), Vec::<String>::new());
        // an org with job records is named too
        *m.free.lock() = None;
        requested(&m);
        *m.free.lock() = Some(1);
        assert_eq!(storage_low(&m, &[]), vec![ORG.to_string()]);
        let _ = std::fs::remove_dir_all(&m.dir);
    }

    #[test]
    fn helpers() {
        assert!(job_id_ok("j_7c6b5a4938271605") && !job_id_ok("j_7C6B5A4938271605") && !job_id_ok("h_7c6b5a4938271605"));
        assert_eq!(preview_of(&json!({"messages": 1, "files": 2, "ai": 3, "bytes": 4, "over_limit": true, "nonce": "x"})), Some(json!({"messages": 1, "files": 2, "ai": 3, "bytes": 4, "over_limit": true})));
        assert!(preview_of(&json!({"messages": 1})).is_none());
        assert_eq!(relay_refusal(&LinkError::Timeout).code, "archive-unreachable");
        assert_eq!(relay_refusal(&LinkError::Refused { status: 403, code: "owner-inactive".into(), error: "".into() }).code, "owner");
        assert_eq!(relay_refusal(&LinkError::Refused { status: 418, code: "odd".into(), error: "".into() }).code, "archive-unreachable");
    }

    /// Revision 4 12: `lucid_compliance_exports` follows each job's state and `lucid_compliance_export_bytes_total`
    /// counts a package once, when its job reaches `ready`.
    #[test]
    fn the_export_families_follow_job_states_and_ready_bytes() {
        const ORG3: &str = "metrics-exports";
        let m = mock("metrics", Box::new(|_, _, _| Ok(json!({}))));
        let rows = || crate::api_catalog::counters::rows(Some(ORG3), NOW);
        let jobs_in = |state: &str| rows().into_iter().find(|r| r.prom == "lucid_compliance_exports" && r.labels == [("state".to_string(), state.to_string())]).map(|r| r.value);
        let bytes = || rows().into_iter().find(|r| r.prom == "lucid_compliance_export_bytes_total" && r.labels == [("client".to_string(), CLIENT.to_string())]).map(|r| r.value);
        let job = "j_00000000000000e1";
        let rec = json!({"job": job, "org": ORG3, "client": CLIENT, "client_name": "ediscovery-export", "owner": "lee@acme.example", "recipient": {"kid": "rcpt-2026-11", "jkt": "t"},
                         "max_bytes": 5368709120i64, "ceiling": "confidential", "reviewers": ["rita@acme.example", "sam@acme.example"], "requested_at": NOW,
                         "state": "waiting", "relay": RA, "releases": 0});
        save(&m, ORG3, &rec).unwrap();
        // the archive released it
        let mut r = rec.clone();
        apply_status(&m, ORG3, &mut r, &json!({"state": "released", "releases": 2, "released_by": ["rita@acme.example", "sam@acme.example"]}), NOW + 60);
        assert_eq!((jobs_in("waiting"), jobs_in("released")), (Some(0.0), Some(1.0)));
        let data = vec![vec![1u8; 64]];
        let mut seal = seal_for(&rec, &data);
        seal["org"] = json!(ORG3);
        fleet_in(&m, RA, "api-export-seal", &json!({"org": ORG3, "job": job, "seal": seal}), NOW + 61).unwrap();
        assert_eq!((jobs_in("released"), jobs_in("transferring")), (Some(0.0), Some(1.0)));
        assert_eq!(bytes(), None, "nothing delivered yet");
        let part = json!({"org": ORG3, "job": job, "n": 0, "data": crate::meet_json::b64(&data[0]), "sha256": sha256_hex(&data[0])});
        assert_eq!(fleet_in(&m, RA, "api-export-part", &part, NOW + 62).unwrap()["ready"], true);
        assert_eq!((jobs_in("transferring"), jobs_in("ready"), bytes()), (Some(0.0), Some(1.0), Some(100.0)));
        // the same part again: counted once
        fleet_in(&m, RA, "api-export-part", &part, NOW + 63).unwrap();
        assert_eq!(bytes(), Some(100.0));
        console_cancel(&m, ORG3, job, "Matter closed", NOW + 70).unwrap();
        assert_eq!((jobs_in("ready"), jobs_in("canceled"), bytes()), (Some(0.0), Some(1.0), Some(100.0)));
        let _ = std::fs::remove_dir_all(&m.dir);
    }

    /// Two final parts at once: each read its job as `transferring` before the lock; only the one that moves the
    /// persisted job to `ready` counts its bytes and audits.
    #[test]
    fn concurrent_final_parts_count_the_bytes_once() {
        const ORG4: &str = "metrics-exports-race";
        let m = mock("race", Box::new(|_, _, _| Ok(json!({}))));
        let bytes = || crate::api_catalog::counters::rows(Some(ORG4), NOW).into_iter()
            .find(|r| r.prom == "lucid_compliance_export_bytes_total" && r.labels == [("client".to_string(), CLIENT.to_string())]).map(|r| r.value);
        let readies = || m.audit.lock().iter().filter(|e| e["action"] == "compliance.export.ready").count();
        let data = vec![vec![1u8; 64]];
        let part = |job: &str| json!({"org": ORG4, "job": job, "n": 0, "data": crate::meet_json::b64(&data[0]), "sha256": sha256_hex(&data[0])});
        let sealed = |job: &str| {
            let rec = json!({"job": job, "org": ORG4, "client": CLIENT, "client_name": "ediscovery-export", "owner": "lee@acme.example", "recipient": {"kid": "rcpt-2026-11", "jkt": "t"},
                             "max_bytes": 5368709120i64, "ceiling": "confidential", "reviewers": ["rita@acme.example", "sam@acme.example"], "requested_at": NOW,
                             "state": "released", "relay": RA, "releases": 2});
            save(&m, ORG4, &rec).unwrap();
            let mut seal = seal_for(&rec, &data);
            seal["org"] = json!(ORG4);
            fleet_in(&m, RA, "api-export-seal", &json!({"org": ORG4, "job": job, "seal": seal}), NOW + 61).unwrap();
        };
        // the interleaving itself: both copies loaded before either takes the lock
        let job = "j_00000000000000e2";
        sealed(job);
        let dir = job_dir(&m, ORG4, job).unwrap();
        let (mut a, mut b) = (load(&m, ORG4, job).unwrap(), load(&m, ORG4, job).unwrap());
        assert_eq!(take_part(&m, ORG4, &mut a, &dir, &part(job), NOW + 62).unwrap()["ready"], true);
        assert_eq!(take_part(&m, ORG4, &mut b, &dir, &part(job), NOW + 62).unwrap()["ready"], true);
        assert_eq!((bytes(), readies()), (Some(100.0), 1));
        // and on two threads through fleet_in
        let job = "j_00000000000000e3";
        sealed(job);
        let go = std::sync::Barrier::new(2);
        std::thread::scope(|t| {
            for _ in 0..2 {
                t.spawn(|| {
                    go.wait();
                    assert_eq!(fleet_in(&m, RA, "api-export-part", &part(job), NOW + 62).unwrap()["ready"], true);
                });
            }
        });
        assert_eq!((bytes(), readies()), (Some(200.0), 2));
        assert_eq!(s(&load(&m, ORG4, job).unwrap(), "state"), "ready");
        let _ = std::fs::remove_dir_all(&m.dir);
    }
}
