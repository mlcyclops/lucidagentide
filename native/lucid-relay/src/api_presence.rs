// Contract API-1 revision 8 (docs/api/contract-r8-1f.md) 1.1, 4 and 5: presence for integrations, the API end. The
// query and body rules of the routes of 4.2 to 4.5 (checked on the front door before any relay is asked), the fleet
// op bodies of 5 as a relay reads them (`ReadArgs`, `WriteArgs`, served by `Hub::api_presence_read` and
// `Hub::api_presence_write`), the merge of 4.2 across the relays that answered, the answers of 4.6 for a write sent to
// several relays, and the 4.6 rule for which clients' sessions, calendar blocks and out of office records still count
// (`writer_live`, checked before each write a relay applies and applied by `Hub::presence_retain_clients` after every
// map and journal entry and from the relay's upkeep, at start and every minute). The routes themselves
// run in `api_resource` (pipeline, audit, rate) and the fan-out in `ConsoleApi::presence_fanout` (front door) and
// `api_listener` (a relay's own hub).

use crate::api_map::ApiMapStore;
use crate::codec::{b64u, unb64u};
use crate::fleet_wire::Refusal;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

/// 4.2: `people` names 1 to 100 principals.
pub const PEOPLE_MAX: usize = 100;
/// 4.2: `limit` 1 to 500.
pub const LIMIT_MAX: usize = 500;
pub const LIMIT_DEFAULT: usize = 100;
/// 4.2, 4.6: a relay silent this long is listed in `partial`.
pub const CALL_MS: u64 = 10_000;
/// 4.6: writes a minute per client and person, on top of the client's own rate.
pub const WRITES_PER_MINUTE: usize = 60;
/// The largest write body the front door reads (the 64 KiB of `api-presence-write`, 5).
pub const BODY_MAX: usize = 64 * 1024;
/// 4.3: `expires_in` seconds.
pub const EXPIRES_MIN: i64 = 300;
pub const EXPIRES_MAX: i64 = 14_400;
/// 1.2: the longest principal and session id.
const PRINCIPAL_MAX: usize = 320;
const SESSION_MAX: usize = 64;
/// 1.2: calendar blocks a write may carry per person and client.
pub const BLOCKS_MAX: usize = 200;

/// 1.3 step 3: `availability` from the highest rank down (offline lowest, 4.2).
pub const AVAILABILITY: [&str; 5] = ["dnd", "busy", "available", "away", "offline"];
/// 1.3 step 3: `activity` from the highest rank down; `out_of_office` (1.3 step 4) just above `offline`, as
/// `meet_hub::presence_rank` ranks it.
pub const ACTIVITY: [&str; 9] = ["presenting", "in_call", "in_meeting", "dnd", "busy", "available", "away", "out_of_office", "offline"];
/// 1.2 item 5: what an application session may set.
pub const SESSION_AVAILABILITY: [&str; 4] = ["available", "busy", "dnd", "away"];
pub const SESSION_ACTIVITY: [&str; 6] = ["available", "away", "busy", "dnd", "in_call", "presenting"];
/// 4.3 to 4.5: the write kinds of `api-presence-write`.
pub const KINDS: [&str; 4] = ["session", "clear", "calendar", "ooo"];

/// 1.1: the Graph mapping, also in the OpenAPI description of every presence route.
pub const GRAPH_MAPPING: &str = "Microsoft Graph mapping: availability available = Available, busy = Busy, dnd = DoNotDisturb, away = Away, offline = Offline; activity in_call = InACall, in_meeting = InAMeeting, presenting = Presenting, out_of_office = OutOfOffice (available, busy, dnd, away and offline as for availability).";

/// A refusal of a route before or after its relays were asked: status, `code`, sentence.
pub type Problem = (u16, &'static str, String);

fn problem(status: u16, code: &'static str, why: impl Into<String>) -> Problem {
    (status, code, why.into())
}

// ── paths and queries (4.2, 6) ───────────────────────────────────────────────────────────────────────────────────

/// One `%XX`-decoded path or query component (None for a bad escape or bytes that are not UTF-8).
fn pct_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = std::str::from_utf8(b.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// A person principal as a path segment or `people` item names it (percent-decoded, lower case), or None (400
/// `query`).
pub fn principal_of(raw: &str) -> Option<String> {
    let p = pct_decode(raw)?.to_ascii_lowercase();
    ((3..=PRINCIPAL_MAX).contains(&p.len()) && crate::meet_org_policy::split_principal(&p).is_ok()).then_some(p)
}

/// 4.3: a session id, `[A-Za-z0-9_-]{1,64}`.
pub fn session_ok(s: &str) -> bool {
    (1..=SESSION_MAX).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// The person and (for a clear) the session of a write route's path `.../v1/presence/{principal}/...`.
pub fn path_parts(path: &str) -> Option<(String, Option<String>)> {
    let rest = path.split_once("/v1/presence/")?.1;
    let mut seg = rest.split('/');
    let principal = principal_of(seg.next()?)?;
    let session = match (seg.next(), seg.next(), seg.next()) {
        (Some("sessions"), Some(s), Some("clear")) => Some(s.to_string()),
        _ => None,
    };
    Some((principal, session))
}

/// 4.2: what a read asks.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReadQuery {
    /// `people` (or the one principal of `GET v1/presence/{principal}`), in the order asked, each once.
    People(Vec<String>),
    /// Every covered person sorted by principal after `after`, at most `limit`.
    Page { after: Option<String>, limit: usize },
}

/// 4.2 and 6: the list route's query. `people` with `after` (or `limit`), more than 100 people or a bad principal is
/// 400 `query`; a malformed cursor 400 `cursor`; `limit` outside 1 to 500 400 `query`.
pub fn read_query(query: &str) -> Result<ReadQuery, Problem> {
    let mut people: Option<&str> = None;
    let mut after: Option<&str> = None;
    let mut limit: Option<&str> = None;
    // a parameter without `=` is kept with an empty value, so `?people` is refused rather than read as no filter
    for (k, v) in query.split('&').filter(|p| !p.is_empty()).map(|p| p.split_once('=').unwrap_or((p, ""))) {
        let slot = match k {
            "people" => &mut people,
            "after" => &mut after,
            "limit" => &mut limit,
            _ => continue,
        };
        if slot.replace(v).is_some() {
            return Err(problem(400, "query", format!("{k} is given twice.")));
        }
    }
    if let Some(list) = people {
        if after.is_some() || limit.is_some() {
            return Err(problem(400, "query", "people cannot be given with after or limit."));
        }
        let mut out: Vec<String> = Vec::new();
        for raw in list.split(',') {
            // a comma may arrive escaped
            for item in pct_decode(raw).ok_or_else(|| problem(400, "query", "people is not a list of principals."))?.split(',') {
                let p = principal_of(item).ok_or_else(|| problem(400, "query", "people is not a list of principals."))?;
                if !out.contains(&p) {
                    out.push(p);
                }
            }
        }
        if out.is_empty() || out.len() > PEOPLE_MAX {
            return Err(problem(400, "query", "people names 1 to 100 principals."));
        }
        return Ok(ReadQuery::People(out));
    }
    let limit = match limit {
        None => LIMIT_DEFAULT,
        Some(l) => l.parse::<usize>().ok().filter(|n| (1..=LIMIT_MAX).contains(n)).ok_or_else(|| problem(400, "query", "limit must be a number from 1 to 500."))?,
    };
    let after = match after {
        None => None,
        Some(c) => Some(cursor_of(c).ok_or_else(|| problem(400, "cursor", "after is not a cursor of this list."))?),
    };
    Ok(ReadQuery::Page { after, limit })
}

/// 4.2: the opaque cursor of a page ending with `principal`.
pub fn cursor(principal: &str) -> String {
    b64u(principal.as_bytes())
}

fn cursor_of(c: &str) -> Option<String> {
    let p = String::from_utf8(unb64u(c)?).ok()?;
    principal_of(&p).filter(|x| *x == p)
}

/// The `api-presence` body of a read (5).
pub fn read_body(org: &str, q: &ReadQuery) -> Value {
    match q {
        ReadQuery::People(p) => json!({ "org": org, "people": p }),
        ReadQuery::Page { after: Some(a), limit } => json!({ "org": org, "after": a, "limit": limit }),
        ReadQuery::Page { after: None, limit } => json!({ "org": org, "limit": limit }),
    }
}

// ── the fleet op bodies as a relay reads them (5) ─────────────────────────────────────────────────────────────────

fn bad(why: &str) -> Refusal {
    Refusal::new(400, "bad-body", why)
}

/// `api-presence` `{org, people}` or `{org, after?, limit?}` (0 to 100 people; `limit` 1 to 500, default 100).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReadArgs {
    pub org: String,
    pub people: Vec<String>,
    pub after: Option<String>,
    pub limit: usize,
}

impl ReadArgs {
    pub fn of(body: &Value) -> Result<ReadArgs, Refusal> {
        let org = body.get("org").and_then(Value::as_str).ok_or_else(|| bad("org is an organization id"))?.to_string();
        let people: Vec<String> = match body.get("people") {
            None => Vec::new(),
            Some(v) => v
                .as_array()
                .filter(|a| a.len() <= PEOPLE_MAX)
                .and_then(|a| a.iter().map(|p| p.as_str().and_then(principal_of)).collect::<Option<Vec<_>>>())
                .ok_or_else(|| bad("people is a list of at most 100 principals"))?,
        };
        let after = match body.get("after") {
            None => None,
            Some(v) => Some(v.as_str().and_then(principal_of).ok_or_else(|| bad("after is a principal"))?),
        };
        let limit = match body.get("limit") {
            None => LIMIT_DEFAULT,
            Some(v) => v.as_u64().and_then(|n| usize::try_from(n).ok()).filter(|n| (1..=LIMIT_MAX).contains(n)).ok_or_else(|| bad("limit is 1 to 500"))?,
        };
        if !people.is_empty() && after.is_some() {
            return Err(bad("people and after cannot be given together"));
        }
        Ok(ReadArgs { org, people, after, limit })
    }
}

/// `api-presence-write` `{org, client: {id, name}, principal, kind, body}`.
#[derive(Clone, Debug, PartialEq)]
pub struct WriteArgs {
    pub org: String,
    pub client_id: String,
    pub client_name: String,
    pub principal: String,
    pub kind: String,
    pub body: Value,
}

impl WriteArgs {
    pub fn of(body: &Value) -> Result<WriteArgs, Refusal> {
        let s = |k: &str| body.get(k).and_then(Value::as_str);
        let org = s("org").ok_or_else(|| bad("org is an organization id"))?.to_string();
        let client = body.get("client").and_then(Value::as_object).ok_or_else(|| bad("client is {id, name}"))?;
        let cs = |k: &str| client.get(k).and_then(Value::as_str).filter(|v| !v.is_empty()).map(str::to_string);
        let (client_id, client_name) = cs("id").zip(cs("name")).ok_or_else(|| bad("client is {id, name}"))?;
        let principal = s("principal").and_then(principal_of).ok_or_else(|| bad("principal is a person principal"))?;
        let kind = s("kind").filter(|k| KINDS.contains(k)).ok_or_else(|| bad("kind is session, clear, calendar or ooo"))?.to_string();
        let inner = body.get("body").filter(|b| b.is_object()).cloned().ok_or_else(|| bad("body is an object"))?;
        Ok(WriteArgs { org, client_id, client_name, principal, kind, body: inner })
    }
}

/// The `api-presence-write` body the front door sends (5).
pub fn write_body(org: &str, client_id: &str, client_name: &str, principal: &str, kind: &str, body: &Value) -> Value {
    json!({ "org": org, "client": { "id": client_id, "name": client_name }, "principal": principal, "kind": kind, "body": body })
}

// ── write bodies (4.3 to 4.5) ─────────────────────────────────────────────────────────────────────────────────────

fn only(o: &Map<String, Value>, keys: &[&str]) -> Result<(), Problem> {
    match o.keys().find(|k| !keys.contains(&k.as_str())) {
        Some(k) => Err(problem(400, "bad-body", format!("{k} is not a field of this request."))),
        None => Ok(()),
    }
}

fn ms(v: Option<&Value>, k: &str) -> Result<Option<i64>, Problem> {
    match v {
        None => Ok(None),
        Some(x) => x.as_i64().filter(|n| *n >= 0).map(Some).ok_or_else(|| problem(400, "bad-body", format!("{k} is a time in milliseconds."))),
    }
}

/// 4.3 to 4.5: a write route's JSON body checked (unknown keys 400 `bad-body`, values of 1.2 item 5 422
/// `presence-value`, `expires_in` and the block count 422 `presence-limit`) and made the body the relay applies:
/// `session` with `expires_in` filled in, `{session}` for a clear (from the path), `calendar` and `ooo` as given.
/// The relays check the other 1.2 limits.
pub fn write_request(kind: &str, session: Option<&str>, body: &Value) -> Result<Value, Problem> {
    let o = body.as_object().ok_or_else(|| problem(400, "bad-body", "The body is a JSON object."))?;
    match kind {
        "session" => {
            only(o, &["session", "availability", "activity", "expires_in"])?;
            let id = o.get("session").and_then(Value::as_str).filter(|s| session_ok(s)).ok_or_else(|| problem(400, "bad-body", "session is 1 to 64 of A-Z, a-z, 0-9, _ and -."))?;
            let word = |k: &str, allowed: &[&str]| -> Result<String, Problem> {
                let v = o.get(k).and_then(Value::as_str).ok_or_else(|| problem(400, "bad-body", format!("{k} is required.")))?;
                if allowed.contains(&v) {
                    Ok(v.to_string())
                } else {
                    Err(problem(422, "presence-value", format!("An application session cannot set {k} {v}.")))
                }
            };
            let availability = word("availability", &SESSION_AVAILABILITY)?;
            let activity = word("activity", &SESSION_ACTIVITY)?;
            let expires_in = match o.get("expires_in") {
                None => EXPIRES_MIN,
                Some(v) => v.as_i64().ok_or_else(|| problem(400, "bad-body", "expires_in is a number of seconds."))?,
            };
            if !(EXPIRES_MIN..=EXPIRES_MAX).contains(&expires_in) {
                return Err(problem(422, "presence-limit", "expires_in is 300 to 14400 seconds."));
            }
            Ok(json!({ "session": id, "availability": availability, "activity": activity, "expires_in": expires_in }))
        }
        "clear" => {
            only(o, &[])?;
            let id = session.filter(|s| session_ok(s)).ok_or_else(|| problem(400, "bad-body", "The session is 1 to 64 of A-Z, a-z, 0-9, _ and -."))?;
            Ok(json!({ "session": id }))
        }
        "calendar" => {
            only(o, &["blocks"])?;
            let blocks = o.get("blocks").and_then(Value::as_array).ok_or_else(|| problem(400, "bad-body", "blocks is a list."))?;
            for b in blocks {
                let bo = b.as_object().ok_or_else(|| problem(400, "bad-body", "A block is {start, end, show}."))?;
                only(bo, &["start", "end", "show"])?;
                let (start, end) = (ms(bo.get("start"), "start")?, ms(bo.get("end"), "end")?);
                let show = bo.get("show").and_then(Value::as_str);
                if start.is_none() || end.is_none() || !matches!(show, Some("busy" | "oof")) {
                    return Err(problem(400, "bad-body", "A block is {start, end, show: busy or oof}."));
                }
                if start >= end {
                    return Err(problem(422, "presence-limit", "A block starts before it ends."));
                }
            }
            if blocks.len() > BLOCKS_MAX {
                return Err(problem(422, "presence-limit", "At most 200 blocks per person."));
            }
            Ok(Value::Object(o.clone()))
        }
        "ooo" => {
            only(o, &["on", "message", "from", "until"])?;
            if !o.get("on").is_some_and(Value::is_boolean) {
                return Err(problem(400, "bad-body", "on is true or false."));
            }
            if o.get("message").is_some_and(|m| !m.is_string()) {
                return Err(problem(400, "bad-body", "message is a string."));
            }
            ms(o.get("from"), "from")?;
            ms(o.get("until"), "until")?;
            Ok(Value::Object(o.clone()))
        }
        _ => Err(problem(400, "bad-body", "That is not a presence write.")),
    }
}

// ── merging the relays' answers (4.2, 4.6) ─────────────────────────────────────────────────────────────────────────

/// One relay's outcome: its answer, its refusal, or None when it stayed silent for `CALL_MS` (`partial`).
pub type Outcome = (String, Option<Result<Value, Refusal>>);

fn rank(list: &[&str], v: Option<&str>) -> usize {
    // higher is better; an unknown word ranks below offline
    v.and_then(|w| list.iter().position(|x| *x == w)).map_or(0, |i| list.len() - i)
}

/// 4.2: the presence object of one person from each relay's view: the highest `availability`, then the highest
/// `activity`, wins (its relay is `relay`); `out_of_office` is the record with the latest `set_at` of any relay
/// (`set_at` itself is not answered).
pub fn merge(views: &[(&str, &Value)]) -> Option<Value> {
    let key = |v: &Value| (rank(&AVAILABILITY, v.get("availability").and_then(Value::as_str)), rank(&ACTIVITY, v.get("activity").and_then(Value::as_str)));
    // the first relay wins a tie (relays are asked in id order)
    let (relay, best) = views.iter().fold(None::<(&str, &Value)>, |acc, &(r, v)| match acc {
        Some((_, b)) if key(b) >= key(v) => acc,
        _ => Some((r, v)),
    })?;
    let mut out = best.as_object().cloned().unwrap_or_default();
    let ooo = views
        .iter()
        .filter_map(|(_, v)| v.get("out_of_office").filter(|o| o.is_object()))
        .max_by_key(|o| o.get("set_at").and_then(Value::as_i64).unwrap_or(i64::MIN))
        .cloned()
        .map(|mut o| {
            if let Some(m) = o.as_object_mut() {
                m.remove("set_at");
            }
            o
        });
    // 1.3 step 4 again on the merged result: the winning view may come from a relay that holds another out of office
    let ooo_on = ooo.is_some();
    let quiet = |a: &str| matches!(a, "available" | "away" | "offline");
    match out.get("activity").and_then(Value::as_str) {
        Some(a) if ooo_on && quiet(a) => {
            out.insert("activity".into(), json!("out_of_office"));
        }
        Some("out_of_office") if !ooo_on => {
            let back = out.get("availability").cloned().unwrap_or_else(|| json!("offline"));
            out.insert("activity".into(), back);
        }
        _ => {}
    }
    out.insert("out_of_office".into(), ooo.unwrap_or(Value::Null));
    out.entry("status").or_insert(Value::Null);
    out.insert("relay".into(), json!(relay));
    Some(Value::Object(out))
}

/// The views of each principal across the relays' `api-presence` answers.
fn by_principal(answers: &[(String, Value)]) -> BTreeMap<String, Vec<(&str, &Value)>> {
    let mut m: BTreeMap<String, Vec<(&str, &Value)>> = BTreeMap::new();
    for (relay, a) in answers {
        for v in a.get("presence").and_then(Value::as_array).into_iter().flatten() {
            if let Some(p) = v.get("principal").and_then(Value::as_str) {
                m.entry(p.to_string()).or_default().push((relay.as_str(), v));
            }
        }
    }
    m
}

/// The answers and the silent relays of a fan-out; Err 503 `relay-unreachable` when no relay answered.
fn split(outcomes: Vec<Outcome>) -> Result<(Vec<(String, Value)>, Vec<String>, Vec<(String, Refusal)>), Problem> {
    let (mut ok, mut silent, mut refused) = (Vec::new(), Vec::new(), Vec::new());
    for (relay, o) in outcomes {
        match o {
            Some(Ok(v)) => ok.push((relay, v)),
            Some(Err(r)) => refused.push((relay, r)),
            None => silent.push(relay),
        }
    }
    if ok.is_empty() {
        // a relay's own refusal of the request (not of the link) is the answer
        if let Some((_, r)) = refused.iter().find(|(_, r)| (400..500).contains(&r.status)) {
            return Err((r.status, known_code(&r.code), r.error.clone()));
        }
        return Err(problem(503, "relay-unreachable", "No relay of this client that serves presence answered; try again later."));
    }
    Ok((ok, silent, refused))
}

/// A relay's refusal code as a route answers it (the codes of 4.6, 6 and the fleet op, and `suspended` for a writer
/// the relay's own map no longer holds live; anything else is `bad-request`).
fn known_code(code: &str) -> &'static str {
    ["not-covered", "org-not-served", "presence-value", "presence-limit", "bad-body", "not-found", "query", "cursor", "suspended"].into_iter().find(|c| *c == code).unwrap_or("bad-request")
}

/// 4.2: a read's answer. `People`: the objects in the order asked, uncovered people (no relay answered for them) left
/// out; a page: the merged list sorted by principal, at most `limit`, with `next` when any relay has more. `partial`
/// lists the silent relays.
pub fn read_answer(q: &ReadQuery, outcomes: Vec<Outcome>) -> Result<Value, Problem> {
    let (answers, silent, _) = split(outcomes)?;
    let views = by_principal(&answers);
    let mut body = match q {
        ReadQuery::People(asked) => json!({ "presence": asked.iter().filter_map(|p| views.get(p).and_then(|v| merge(v))).collect::<Vec<_>>() }),
        ReadQuery::Page { after, limit } => {
            let rows: Vec<Value> = views
                .iter()
                .filter(|(p, _)| after.as_ref().is_none_or(|a| p.as_str() > a.as_str()))
                .filter_map(|(_, v)| merge(v))
                .collect();
            let more = rows.len() > *limit || answers.iter().any(|(_, a)| a.get("next").is_some());
            let rows: Vec<Value> = rows.into_iter().take(*limit).collect();
            let last = rows.last().and_then(|r| r.get("principal")).and_then(Value::as_str).filter(|_| more).map(cursor);
            let mut b = json!({ "presence": rows });
            if let Some(next) = last {
                b["next"] = json!(next);
            }
            b
        }
    };
    if !silent.is_empty() {
        body["partial"] = json!(silent);
    }
    Ok(body)
}

/// 4.6: a write's answer from the relays that stored it: the first relay's answer fields (`cleared` true when any
/// relay cleared the session), `relays` the ones that stored it, `partial` the silent ones. None stored: the relays'
/// refusal of the write, else 503 `relay-unreachable`.
pub fn write_answer(kind: &str, outcomes: Vec<Outcome>) -> Result<Value, Problem> {
    let (stored, silent, _) = split(outcomes)?;
    let mut body = stored.first().and_then(|(_, a)| a.as_object()).cloned().unwrap_or_default();
    body.remove("relays");
    body.remove("partial");
    if kind == "clear" {
        body.insert("cleared".into(), json!(stored.iter().any(|(_, a)| a.get("cleared").and_then(Value::as_bool) == Some(true))));
    }
    body.insert("relays".into(), json!(stored.iter().map(|(r, _)| r.as_str()).collect::<Vec<_>>()));
    if !silent.is_empty() {
        body.insert("partial".into(), json!(silent));
    }
    Ok(Value::Object(body))
}

// ── which clients' writes count (4.6) ──────────────────────────────────────────────────────────────────────────────

/// 4.6: whether the writes of `client` still count in `org`: it is in the pinned map, active and not suspended by the
/// journal, its registration not expired (with the app grace), and it holds `presence.write` not dropped by a
/// `client_drop_scope`.
pub fn writer_live(store: &ApiMapStore, org: &str, client: &str, now_s: i64) -> bool {
    use crate::api_token::{client_entries, find_client, names, target_field};
    let Some(c) = find_client(store, org, client) else { return false };
    let active = store.active(org);
    let suspended = c.get("state").and_then(Value::as_str) != Some("active") || active.iter().any(|e| e.action == "client_suspend" && e.target.as_str() == Some(client));
    let end = crate::api_map::effective_end(c.get("expires").and_then(Value::as_i64).unwrap_or(i64::MIN), &[store.grace_hours(org, "app", now_s)]);
    let holds = names(c, "scopes").any(|s| s == "presence.write") && !client_entries(active, "client_drop_scope", client).any(|e| target_field(e, "scope") == "presence.write");
    !suspended && now_s <= end && holds
}

#[cfg(test)]
mod tests {
    use super::*;

    const ANN: &str = "ann@acme.example";
    const BO: &str = "bo@acme.example";
    const R1: &str = "r_00000000000000a1";
    const R2: &str = "r_00000000000000b2";

    fn view(p: &str, availability: &str, activity: &str, ooo: Value) -> Value {
        json!({"principal": p, "availability": availability, "activity": activity, "out_of_office": ooo, "status": null, "presence": "available", "mobile": false})
    }

    #[test]
    fn the_merge_takes_the_highest_availability_then_activity_and_the_latest_out_of_office() {
        let a = view(ANN, "available", "available", json!({"message": "old", "by": "self", "set_at": 10}));
        let b = view(ANN, "busy", "in_meeting", json!({"message": "new", "until": 99, "by": "Mail", "set_at": 20}));
        let m = merge(&[(R1, &a), (R2, &b)]).unwrap();
        assert_eq!((m["availability"].as_str(), m["activity"].as_str(), m["relay"].as_str()), (Some("busy"), Some("in_meeting"), Some(R2)));
        assert_eq!(m["out_of_office"], json!({"message": "new", "until": 99, "by": "Mail"}), "set_at is not answered");
        // dnd beats busy, offline loses to everything; on equal availability the activity decides
        let dnd = view(ANN, "dnd", "presenting", Value::Null);
        let off = view(ANN, "offline", "offline", Value::Null);
        assert_eq!(merge(&[(R1, &off), (R2, &dnd)]).unwrap()["relay"], R2);
        let call = view(ANN, "busy", "in_call", Value::Null);
        assert_eq!(merge(&[(R1, &b), (R2, &call)]).unwrap()["activity"], "in_call");
        // a tie keeps the first relay; no record anywhere is null
        let t = merge(&[(R1, &off), (R2, &off)]).unwrap();
        assert_eq!((t["relay"].as_str(), &t["out_of_office"]), (Some(R1), &Value::Null));
    }

    #[test]
    fn reads_merge_two_relays_keep_the_asked_order_and_list_silent_relays() {
        let r1 = json!({"presence": [view(BO, "away", "away", Value::Null), view(ANN, "available", "available", Value::Null)]});
        let r2 = json!({"presence": [view(ANN, "busy", "in_call", Value::Null)]});
        let q = ReadQuery::People(vec![BO.into(), ANN.into(), "cy@acme.example".into()]);
        let out = read_answer(&q, vec![(R1.into(), Some(Ok(r1.clone()))), (R2.into(), Some(Ok(r2.clone()))), ("r_00000000000000c3".into(), None)]).unwrap();
        let names: Vec<&str> = out["presence"].as_array().unwrap().iter().map(|v| v["principal"].as_str().unwrap()).collect();
        assert_eq!(names, [BO, ANN], "the uncovered person is left out");
        assert_eq!(out["presence"][1]["activity"], "in_call");
        assert_eq!(out["partial"], json!(["r_00000000000000c3"]));
        // a page: sorted, at most limit, next is the cursor of the last
        let page = read_answer(&ReadQuery::Page { after: None, limit: 1 }, vec![(R1.into(), Some(Ok(r1))), (R2.into(), Some(Ok(r2)))]).unwrap();
        assert_eq!(page["presence"][0]["principal"], ANN);
        assert_eq!(page["next"], json!(cursor(ANN)));
        assert!(page.get("partial").is_none());
        assert_eq!(read_query(&format!("after={}&limit=1", cursor(ANN))).unwrap(), ReadQuery::Page { after: Some(ANN.into()), limit: 1 });
        // nobody answered
        assert_eq!(read_answer(&q, vec![(R1.into(), None)]).unwrap_err().1, "relay-unreachable");
    }

    #[test]
    fn queries_are_checked_before_any_relay_is_asked() {
        assert_eq!(read_query("people=ann%40acme.example,bo@acme.example").unwrap(), ReadQuery::People(vec![ANN.into(), BO.into()]));
        assert_eq!(read_query("").unwrap(), ReadQuery::Page { after: None, limit: LIMIT_DEFAULT });
        assert_eq!(read_query(&format!("people={ANN}&after={}", cursor(BO))).unwrap_err().1, "query");
        assert_eq!(read_query("people=not-a-principal").unwrap_err().1, "query");
        let many: Vec<String> = (0..101).map(|i| format!("p{i}@acme.example")).collect();
        assert_eq!(read_query(&format!("people={}", many.join(","))).unwrap_err().1, "query");
        assert_eq!(read_query("after=%%%").unwrap_err().1, "cursor");
        assert_eq!(read_query("after=bm90IGEgcHJpbmNpcGFs").unwrap_err().1, "cursor");
        assert_eq!(read_query("limit=501").unwrap_err().1, "query");
        assert_eq!(path_parts("/api/orgs/acme/v1/presence/ann%40acme.example/sessions/s-1/clear"), Some((ANN.into(), Some("s-1".into()))));
        assert_eq!(path_parts("/api/orgs/acme/v1/presence/ann@acme.example/calendar"), Some((ANN.into(), None)));
    }

    #[test]
    fn r8_valueless_query_parameters_are_refused_not_ignored() {
        // `?people` is not the whole directory, and a bare `after` or `limit` is not the default
        assert_eq!(read_query("people").unwrap_err().1, "query");
        assert_eq!(read_query("people&people=ann@acme.example").unwrap_err().1, "query", "given twice");
        assert_eq!(read_query("limit").unwrap_err().1, "query");
        assert_eq!(read_query("after").unwrap_err().1, "cursor");
        assert_eq!(read_query(&format!("people={ANN}&limit")).unwrap_err().1, "query");
        // unknown parameters, with or without a value, are still ignored
        assert_eq!(read_query("verbose&x=1").unwrap(), ReadQuery::Page { after: None, limit: LIMIT_DEFAULT });
    }

    #[test]
    fn r8_a_relays_suspended_refusal_of_a_write_is_passed_on() {
        let refused = |code: &str| vec![(R1.to_string(), Some(Err(Refusal::new(403, code, "refused"))))];
        assert_eq!(write_answer("ooo", refused("suspended")).unwrap_err(), (403, "suspended", "refused".to_string()));
        assert_eq!(write_answer("ooo", refused("something-else")).unwrap_err().1, "bad-request");
    }

    #[test]
    fn write_bodies_follow_4_3_to_4_5() {
        let s = write_request("session", None, &json!({"session": "teams-1", "availability": "busy", "activity": "in_call"})).unwrap();
        assert_eq!(s["expires_in"], EXPIRES_MIN);
        let code = |k: &str, b: Value| write_request(k, Some("s1"), &b).unwrap_err().1;
        assert_eq!(code("session", json!({"session": "a", "availability": "busy", "activity": "in_meeting"})), "presence-value");
        assert_eq!(code("session", json!({"session": "a", "availability": "offline", "activity": "busy"})), "presence-value");
        assert_eq!(code("session", json!({"session": "a", "availability": "busy", "activity": "busy", "expires_in": 60})), "presence-limit");
        assert_eq!(code("session", json!({"session": "a b", "availability": "busy", "activity": "busy"})), "bad-body");
        assert_eq!(write_request("clear", Some("s1"), &json!({})).unwrap(), json!({"session": "s1"}));
        // titles, attendees and bodies are never accepted
        assert_eq!(code("calendar", json!({"blocks": [{"start": 1, "end": 2, "show": "busy", "title": "Review"}]})), "bad-body");
        assert_eq!(code("calendar", json!({"blocks": [{"start": 2, "end": 1, "show": "busy"}]})), "presence-limit");
        assert!(write_request("calendar", None, &json!({"blocks": []})).is_ok());
        assert_eq!(code("ooo", json!({"message": "x"})), "bad-body");
        assert!(write_request("ooo", None, &json!({"on": true, "message": "Back Monday", "until": 5})).is_ok());
    }

    #[test]
    fn writes_name_the_relays_that_stored_them() {
        let ok = |v: Value| Some(Ok(v));
        let out = write_answer("session", vec![(R1.into(), ok(json!({"session": "s1", "expires": 5}))), (R2.into(), None)]).unwrap();
        assert_eq!(out, json!({"session": "s1", "expires": 5, "relays": [R1], "partial": [R2]}));
        let cleared = write_answer("clear", vec![(R1.into(), ok(json!({"cleared": false}))), (R2.into(), ok(json!({"cleared": true})))]).unwrap();
        assert_eq!(cleared, json!({"cleared": true, "relays": [R1, R2]}));
        // none stored: the relays' own refusal, else 503
        let not_covered = Some(Err(Refusal::new(403, "not-covered", "That person is not covered.")));
        assert_eq!(write_answer("ooo", vec![(R1.into(), not_covered)]).unwrap_err().0, 403);
        assert_eq!(write_answer("ooo", vec![(R1.into(), None)]).unwrap_err().1, "relay-unreachable");
        // the fleet op body round trips
        let b = write_body("acme", "c_1", "mail", ANN, "clear", &json!({"session": "s1"}));
        let a = WriteArgs::of(&b).unwrap();
        assert_eq!((a.client_name.as_str(), a.kind.as_str(), a.body["session"].as_str()), ("mail", "clear", Some("s1")));
        assert_eq!(ReadArgs::of(&read_body("acme", &ReadQuery::People(vec![ANN.into()]))).unwrap().people, [ANN]);
        assert!(ReadArgs::of(&json!({"org": "acme", "people": [ANN], "after": BO})).is_err());
    }

    #[test]
    fn presence_changed_is_a_relay_event_of_the_registry() {
        let data = json!({"principal": ANN, "availability": "busy", "activity": "in_meeting", "out_of_office": false});
        assert!(crate::api_events::check_emit(R1, "presence.changed", &data).is_ok());
        assert!(crate::api_events::check_emit("console", "presence.changed", &data).is_err(), "only relays emit it");
        assert!(crate::api_events::check_emit(R1, "presence.changed", &json!({"principal": ANN, "message": "x"})).is_err(), "never the message");
        assert!(crate::api_map::EVENT_TYPES.contains(&"presence.changed"));
    }
}
