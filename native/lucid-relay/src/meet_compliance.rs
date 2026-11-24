// Contract API-1 revision 4 (docs/api/contract-r4-1b.md) 5.1, the relay end of `api-compliance-read`: one page of
// this relay's compliance metadata for one org it serves, from what the relay already keeps in plain text (the
// attendance store, scheduled meetings, channel member logs and DM pairs, kept file records, the org policy, the hold
// store). Never message text, file names or hashes, meeting descriptions, channel topics, poll votes, captions or
// transcripts.
//
// Owning org (Rev4Review R4-8), decided here because a relay may serve several orgs: a scheduled meeting and a
// meeting room's session belong to the organizer's org, an ad hoc call to the org of its first host; a conversation to
// the org that covers every person in its member log, now and before (AI-1 7.7); a file to its conversation's or
// room's owner. An item the path org owns is answered in full. One it does not own is answered only when a person the
// path org covers took part, reduced to `"owner": "outside"`, the item id and the covered persons' own joins or
// intervals. A file of a conversation or room the path org does not own is skipped. A filter naming a person the path
// org does not cover matches nothing.
//
// The relay's cursor (`after`) is the sort key of the last item it answered: `<ms>:<id>` (attendance, meetings,
// files, holds) or the cid (conversations). The console adds `relay` to each item. A child module of meet_hub: it
// reads the hub's state under its one lock.

use super::*;
use crate::fleet_wire::Refusal;
use crate::meet_org_policy as op;
use serde_json::{json, Map};
use std::collections::BTreeMap;

/// 5.1: one page holds at most this many items.
pub const PAGE_MAX: usize = 500;
/// 5.1: `to - from` spans at most 400 days.
pub const SPAN_MAX_S: i64 = 400 * 86_400;
/// The kinds of `api-compliance-read` (2.5), plus `holds`: the console-placed people holds of the org this relay
/// keeps, which `GET v1/compliance/holds` lists beside the API holds (5.1, 5.2.4).
pub const KINDS: [&str; 6] = ["attendance", "meetings", "conversations", "files", "retention", "holds"];
const AFTER_MAX: usize = 256;
const PRINCIPAL_MAX: usize = 320;

/// One read as the console asked it.
struct Query {
    kind: String,
    from_ms: i64,
    to_ms: i64,
    limit: usize,
    person: Option<String>,
    room: Option<String>,
    organizer: Option<String>,
    cid: Option<String>,
    after: Option<(i64, String)>,
}

fn refused(code: &str, why: &str) -> Refusal {
    Refusal::new(400, code, why)
}

fn text(p: &Map<String, Value>, k: &str, max: usize) -> Result<Option<String>, Refusal> {
    match p.get(k) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if (1..=max).contains(&s.len()) && !s.chars().any(char::is_control) => Ok(Some(s.trim().to_lowercase())),
        _ => Err(refused("bad-request", &format!("{k} is not valid."))),
    }
}

/// The relay cursor of a sort key.
fn cursor_of(key: &(i64, String)) -> String {
    format!("{}:{}", key.0, key.1)
}

fn parse_cursor(s: &str) -> Option<(i64, String)> {
    let (n, id) = s.split_once(':')?;
    Some((n.parse().ok()?, id.to_string()))
}

impl Query {
    fn of(body: &Value) -> Result<Query, Refusal> {
        let kind = body.get("kind").and_then(Value::as_str).filter(|k| KINDS.contains(k)).ok_or_else(|| refused("bad-request", "kind is not a compliance read."))?.to_string();
        let empty = Map::new();
        let p = match body.get("params") {
            None | Some(Value::Null) => &empty,
            Some(Value::Object(o)) => o,
            Some(_) => return Err(refused("bad-request", "params is an object.")),
        };
        let int = |k: &str| p.get(k).map(|v| v.as_i64().ok_or_else(|| refused("bad-request", &format!("{k} is a number of seconds.")))).transpose();
        let (from, to) = (int("from")?, int("to")?);
        let now = pj::now() as i64;
        let to = to.unwrap_or(now);
        let from = from.unwrap_or(to - 30 * 86_400);
        if from > to || to - from > SPAN_MAX_S {
            return Err(refused("bad-request", "from and to span at most 400 days, from first."));
        }
        let limit = match p.get("limit") {
            None => 100,
            Some(v) => v.as_u64().and_then(|n| usize::try_from(n).ok()).filter(|n| (1..=PAGE_MAX).contains(n)).ok_or_else(|| refused("bad-request", "limit is 1 to 500."))?,
        };
        let after = match body.get("after") {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) if s.len() <= AFTER_MAX => {
                if kind == "conversations" {
                    Some((0, s.clone()))
                } else {
                    Some(parse_cursor(s).ok_or_else(|| refused("bad-request", "after is not a cursor of this list."))?)
                }
            }
            Some(_) => return Err(refused("bad-request", "after is not a cursor of this list.")),
        };
        Ok(Query {
            kind,
            from_ms: from.saturating_mul(1000),
            to_ms: to.saturating_mul(1000),
            limit,
            person: text(p, "person", PRINCIPAL_MAX)?,
            room: p.get("room").and_then(Value::as_str).filter(|r| (1..=128).contains(&r.len())).map(str::to_string),
            organizer: text(p, "organizer", PRINCIPAL_MAX)?,
            cid: p.get("cid").and_then(Value::as_str).filter(|c| (1..=128).contains(&c.len())).map(str::to_string),
            after,
        })
    }
}

/// What the read knows of the orgs: every current policy, and the path org's.
struct Orgs {
    org: String,
    policies: Vec<Obj>,
    mine: Option<Obj>,
}

impl Orgs {
    /// The org whose policy covers a person (services and guests: none).
    fn of(&self, principal: &str) -> Option<String> {
        if !pc::service_kind(principal).is_empty() || principal.starts_with("guest:") {
            return None;
        }
        pc::covering(&self.policies, principal).and_then(|p| p.get("org")).and_then(Value::as_str).map(str::to_string)
    }

    /// A person the path org's policy covers (never a service or a guest).
    fn covered(&self, principal: &str) -> bool {
        pc::service_kind(principal).is_empty() && !principal.starts_with("guest:") && self.mine.as_ref().is_some_and(|p| op::covers(p, principal))
    }

    /// A service the path org's policy names (its app or archive).
    fn own_service(&self, principal: &str) -> bool {
        self.mine.as_ref().is_some_and(|p| op::services(p).iter().any(|s| s.principal == principal))
    }

    fn owns(&self, owner: Option<&str>) -> bool {
        owner == Some(self.org.as_str())
    }

    /// 5.1: a person as the path org sees them: the principal when covered (or its own service), `guest:<id>` for a web
    /// guest, else `{"outside": <domain>}`.
    fn name(&self, principal: &str) -> Value {
        if principal.starts_with("guest:") || self.covered(principal) || self.own_service(principal) {
            return Value::from(principal);
        }
        json!({ "outside": principal.rsplit_once('@').map_or("", |(_, d)| d) })
    }

    /// The same as one field of a person object: `principal`, `guest` or `outside`.
    fn person(&self, principal: &str) -> Obj {
        match principal.strip_prefix("guest:") {
            Some(id) => obj([("guest", Value::from(id))]),
            None if self.covered(principal) || self.own_service(principal) => obj([("principal", Value::from(principal))]),
            None => obj([("outside", Value::from(principal.rsplit_once('@').map_or("", |(_, d)| d)))]),
        }
    }

    /// AI-1 7.7: the org that covers every person ever in a conversation (services aside); None for any other.
    fn owner_of_all<'a>(&self, people: impl IntoIterator<Item = &'a String>) -> Option<String> {
        let mut owner: Option<String> = None;
        for p in people.into_iter().filter(|p| pc::service_kind(p).is_empty()) {
            let o = self.of(p)?;
            match &owner {
                None => owner = Some(o),
                Some(x) if *x == o => {}
                Some(_) => return None,
            }
        }
        owner
    }
}

/// Per person, the intervals `[from_ms, to_ms or null]` they were a member (a log replayed, or the members since
/// `created`).
type Intervals = BTreeMap<String, Vec<(i64, Option<i64>)>>;

fn intervals_of(log: &[Value], members: &[String], created_ms: i64) -> Intervals {
    let mut out: Intervals = BTreeMap::new();
    if log.is_empty() {
        for m in members {
            out.entry(m.clone()).or_default().push((created_ms, None));
        }
        return out;
    }
    for e in log.iter().filter_map(Value::as_object) {
        let at = pj::as_int(e.get("rts")).or_else(|| pj::as_int(e.get("ts"))).unwrap_or(0);
        let who: Vec<String> = e.get("who").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect();
        let open = match pj::text_of(e, "op").as_str() {
            "create" | "baseline" | "add" | "join" => true,
            "leave" | "remove" => false,
            _ => continue,
        };
        for p in who {
            let list = out.entry(p).or_default();
            let is_open = list.last().is_some_and(|(_, end)| end.is_none());
            if open && !is_open {
                list.push((at, None));
            } else if !open && is_open {
                if let Some(last) = list.last_mut() {
                    last.1 = Some(at);
                }
            }
        }
    }
    out
}

fn overlaps(list: &[(i64, Option<i64>)], from_ms: i64, to_ms: i64) -> bool {
    list.iter().any(|(a, b)| *a <= to_ms && b.is_none_or(|b| b >= from_ms))
}

fn intervals_value(list: &[(i64, Option<i64>)]) -> Value {
    Value::Array(list.iter().map(|(a, b)| json!([a, b])).collect())
}

/// One conversation as the read needs it.
struct Conversation {
    cid: String,
    kind: &'static str,
    name: Option<String>,
    members: Intervals,
    current: Vec<String>,
}

/// The page of `rows` (sort key, item) after the cursor: (items, next).
fn page(mut rows: Vec<((i64, String), Value)>, q: &Query) -> (Vec<Value>, Option<String>) {
    rows.sort_by(|a, b| a.0.cmp(&b.0));
    let mut rows: Vec<((i64, String), Value)> = rows.into_iter().filter(|(k, _)| q.after.as_ref().is_none_or(|a| k > a)).collect();
    let more = rows.len() > q.limit;
    rows.truncate(q.limit);
    let next = more.then(|| rows.last().map(|(k, _)| if q.kind == "conversations" { k.1.clone() } else { cursor_of(k) })).flatten();
    (rows.into_iter().map(|(_, v)| v).collect(), next)
}

impl State {
    /// The org that owns what a room held at `ts_ms`: its scheduled meeting's organizer's, else the first host's of the
    /// one attendance session that contains `ts_ms` (an ad-hoc room is reused by other organizers). None when no
    /// session or more than one contains it.
    fn api_room_owner_at(&self, orgs: &Orgs, room: &str, ts_ms: i64) -> Option<String> {
        if let Some(m) = as_obj(self.meetings.get(room)) {
            return orgs.of(&pj::text_of(as_obj(m.get("organizer"))?, "principal"));
        }
        let sessions = self.attendance.get(room).and_then(Value::as_array)?;
        let mut holding = sessions.iter().filter(|s| pj::as_int(s.get("start")).is_some_and(|start| start <= ts_ms) && pj::as_int(s.get("end")).is_none_or(|end| ts_ms <= end));
        let one = holding.next()?;
        if holding.next().is_some() {
            return None;
        }
        Self::api_first_host(one).and_then(|h| orgs.of(&h))
    }

    fn api_first_host(session: &Value) -> Option<String> {
        session.get("people").and_then(Value::as_array)?.iter().find(|p| p.get("role").and_then(Value::as_str) == Some("host")).and_then(|p| p.get("principal")).and_then(Value::as_str).map(str::to_string)
    }

    /// Every conversation: channels and group chats from their member logs, DMs from their pairs.
    fn api_conversations(&mut self) -> Vec<Conversation> {
        let mut out = Vec::new();
        let ids: Vec<String> = self.channels.keys().cloned().collect();
        for id in ids {
            let Some(ch) = as_obj(self.channels.get(&id)).cloned() else { continue };
            let current = channels::members_of(Some(&ch));
            let created_ms = (pj::num(&ch, "created") * 1000.0) as i64;
            let log = self.ce_log(&id).to_vec();
            let group = pj::text_of(&ch, "kind") == "group";
            out.push(Conversation {
                cid: format!("ch:{id}"),
                kind: if group { "group" } else { "channel" },
                name: (!group).then(|| pj::s(&ch, "name")),
                members: intervals_of(&log, &current, created_ms),
                current,
            });
        }
        for (key, msgs) in &self.dms {
            let pair: Vec<String> = key.split(' ').map(str::to_string).collect();
            if pair.len() != 2 {
                continue;
            }
            let first = msgs.iter().map(|m| (pj::num(m, "ts") * 1000.0) as i64).min().unwrap_or(0);
            out.push(Conversation { cid: ce::dm_cid(&pair[0], &pair[1]), kind: "dm", name: None, members: intervals_of(&[], &pair, first), current: pair });
        }
        out
    }
}

impl Hub {
    /// API-1 revision 4 2.5 `api-compliance-read {org, kind, params, after}` (the agent checked the org is served):
    /// `{items, next?}`, with `kept_days` for attendance. 400 `bad-request` for a read this relay cannot take.
    pub fn api_compliance_read(&self, body: &Value) -> Result<Value, Refusal> {
        let org = body.get("org").and_then(Value::as_str).unwrap_or_default().to_string();
        let q = Query::of(body)?;
        let mut st = self.st.lock();
        let policies = st.pc_current();
        let mine = policies.iter().find(|p| p.get("org").and_then(Value::as_str) == Some(org.as_str())).cloned();
        let orgs = Orgs { org, policies, mine };
        // a filter naming a person the path org does not cover matches nothing
        let foreign = [&q.person, &q.organizer].into_iter().flatten().any(|p| !orgs.covered(p));
        let rows = if foreign && q.kind != "retention" && q.kind != "holds" {
            Vec::new()
        } else {
            match q.kind.as_str() {
                "attendance" => Self::api_attendance(&st, &orgs, &q),
                "meetings" => Self::api_meetings(&st, &orgs, &q),
                "conversations" => {
                    let Some(person) = q.person.clone() else { return Err(refused("bad-request", "person is required.")) };
                    Self::api_conversation_rows(&mut st, &orgs, &q, &person)
                }
                "files" => Self::api_files(&mut st, &orgs, &q)?,
                "holds" => Self::api_holds(&mut st, &orgs),
                _ => return Ok(json!({ "items": [Self::api_retention(&mut st, &orgs)] })),
            }
        };
        let (items, next) = page(rows, &q);
        let mut out = json!({ "items": items });
        if let Some(n) = next {
            out["next"] = Value::from(n);
        }
        if q.kind == "attendance" {
            out["kept_days"] = Value::from(st.pa_kept_days());
        }
        Ok(out)
    }

    fn api_attendance(st: &State, orgs: &Orgs, q: &Query) -> Vec<((i64, String), Value)> {
        let mut rows = Vec::new();
        for (room, list) in &st.attendance {
            if q.room.as_ref().is_some_and(|r| r != room) {
                continue;
            }
            for s in list.as_array().into_iter().flatten().filter_map(Value::as_object) {
                let start = pj::as_int(s.get("start")).unwrap_or(0);
                if start < q.from_ms || start > q.to_ms {
                    continue;
                }
                let people: Vec<&Obj> = s.get("people").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_object).collect();
                let key_of = |p: &Obj| pj::text_of(p, "principal");
                if let Some(person) = &q.person {
                    if !people.iter().any(|p| key_of(p) == *person) {
                        continue;
                    }
                }
                let meeting = s.get("meeting_id").and_then(Value::as_str);
                let owner = match meeting.and_then(|m| as_obj(st.meetings.get(m))) {
                    Some(m) => as_obj(m.get("organizer")).and_then(|o| orgs.of(&pj::text_of(o, "principal"))),
                    None => State::api_first_host(&Value::Object(s.clone())).and_then(|h| orgs.of(&h)),
                };
                let id = pj::s(s, "id");
                let joins = |p: &Obj| p.get("joins").cloned().unwrap_or_else(|| json!([]));
                let item = if orgs.owns(owner.as_deref()) {
                    let rows: Vec<Value> = people
                        .iter()
                        .map(|p| {
                            let mut row = orgs.person(&key_of(p));
                            row.insert("role".into(), p.get("role").cloned().unwrap_or(Value::Null));
                            row.insert("joins".into(), joins(p));
                            Value::Object(row)
                        })
                        .collect();
                    let mut item = obj([("room", Value::from(room.clone())), ("session", Value::from(id.clone()))]);
                    if let Some(m) = meeting {
                        item.insert("meeting".into(), Value::from(m));
                        if let Some(t) = s.get("title").and_then(Value::as_str) {
                            item.insert("title".into(), Value::from(t));
                        }
                    }
                    item.insert("start_ms".into(), Value::from(start));
                    if let Some(end) = pj::as_int(s.get("end")) {
                        item.insert("end_ms".into(), Value::from(end));
                    }
                    item.insert("people".into(), Value::Array(rows));
                    item
                } else {
                    let mine: Vec<Value> = people.iter().filter(|p| orgs.covered(&key_of(p))).map(|p| json!({ "principal": key_of(p), "joins": joins(p) })).collect();
                    if mine.is_empty() {
                        continue;
                    }
                    obj([("owner", Value::from("outside")), ("session", Value::from(id.clone())), ("people", Value::Array(mine))])
                };
                rows.push(((start, id), Value::Object(item)));
            }
        }
        rows
    }

    fn api_meetings(st: &State, orgs: &Orgs, q: &Query) -> Vec<((i64, String), Value)> {
        let (lo, hi) = (q.from_ms as f64 / 1000.0, q.to_ms as f64 / 1000.0);
        let mut rows = Vec::new();
        for (id, m) in &st.meetings {
            let Some(m) = m.as_object() else { continue };
            let (start, end) = (pj::num(m, "start"), pj::num(m, "end"));
            if meetings::meeting_occurrences(start, end, &pj::text_of(m, "recurrence"), &pj::text_of(m, "tz"), lo, hi, 1).is_empty() {
                continue;
            }
            let organizer = as_obj(m.get("organizer")).map(|o| pj::text_of(o, "principal")).unwrap_or_default();
            let attendees: Vec<String> = m.get("attendees").and_then(Value::as_array).into_iter().flatten().filter_map(|a| a.get("principal").and_then(Value::as_str)).map(str::to_string).collect();
            if q.organizer.as_ref().is_some_and(|o| *o != organizer) || q.person.as_ref().is_some_and(|p| *p != organizer && !attendees.contains(p)) {
                continue;
            }
            let owner = orgs.of(&organizer);
            let item = if orgs.owns(owner.as_deref()) {
                json!({
                    "meeting": id, "title": m.get("title").cloned().unwrap_or(Value::Null), "organizer": orgs.name(&organizer),
                    "attendees": attendees.iter().map(|a| orgs.name(a)).collect::<Vec<_>>(),
                    "start": m.get("start").cloned().unwrap_or(Value::Null), "end": m.get("end").cloned().unwrap_or(Value::Null),
                    "tz": pj::text_of(m, "tz"), "recurrence": pj::text_of(m, "recurrence"), "canceled": pj::truthy(m.get("canceled")),
                })
            } else if orgs.covered(&organizer) || attendees.iter().any(|a| orgs.covered(a)) {
                json!({ "owner": "outside", "meeting": id })
            } else {
                continue;
            };
            rows.push((((start * 1000.0) as i64, id.clone()), item));
        }
        rows
    }

    fn api_conversation_rows(st: &mut State, orgs: &Orgs, q: &Query, person: &str) -> Vec<((i64, String), Value)> {
        let archive = orgs.mine.as_ref().and_then(|p| p.get("archive")).and_then(|a| a.get("principal")).and_then(Value::as_str).map(str::to_string);
        let mut rows = Vec::new();
        for c in st.api_conversations() {
            let Some(mine) = c.members.get(person) else { continue };
            if !overlaps(mine, q.from_ms, q.to_ms) {
                continue;
            }
            let owner = orgs.owner_of_all(c.members.keys());
            let item = if orgs.owns(owner.as_deref()) {
                let members: Vec<Value> = c
                    .members
                    .iter()
                    .map(|(p, list)| {
                        let mut row = orgs.person(p);
                        row.insert("intervals".into(), intervals_value(list));
                        Value::Object(row)
                    })
                    .collect();
                let covered = match (&archive, c.kind) {
                    (Some(_), "dm") => true,
                    (Some(a), _) => c.current.contains(a),
                    (None, _) => false,
                };
                let mut item = obj([("cid", Value::from(c.cid.clone())), ("kind", Value::from(c.kind))]);
                if let Some(n) = &c.name {
                    item.insert("name".into(), Value::from(n.clone()));
                }
                item.insert("members".into(), Value::Array(members));
                item.insert("covered_by_archive".into(), Value::Bool(covered));
                Value::Object(item)
            } else {
                let members: Vec<Value> = c.members.iter().filter(|(p, _)| orgs.covered(p)).map(|(p, list)| json!({ "principal": p, "intervals": intervals_value(list) })).collect();
                json!({ "owner": "outside", "cid": c.cid, "members": members })
            };
            rows.push(((0, c.cid), item));
        }
        rows
    }

    fn api_files(st: &mut State, orgs: &Orgs, q: &Query) -> Result<Vec<((i64, String), Value)>, Refusal> {
        // the place asked for, and whether the path org owns it (a room: per file, below)
        let (wanted, owned): (Box<dyn Fn(&Obj) -> bool>, bool) = match (&q.cid, &q.room) {
            (Some(cid), None) => {
                let conv = st.api_conversations().into_iter().find(|c| c.cid == *cid);
                let Some(c) = conv else { return Ok(Vec::new()) };
                let owned = orgs.owns(orgs.owner_of_all(c.members.keys()).as_deref());
                match cid.strip_prefix("ch:") {
                    Some(id) => {
                        let id = id.to_string();
                        (Box::new(move |m: &Obj| pj::text_of(m, "scope") == "channel" && pj::text_of(m, "channel") == id), owned)
                    }
                    None => {
                        let mut pair = c.current.clone();
                        pair.sort();
                        let pair = Value::Array(pair.into_iter().map(Value::from).collect());
                        (Box::new(move |m: &Obj| pj::text_of(m, "scope") == "dm" && m.get("pair") == Some(&pair)), owned)
                    }
                }
            }
            (None, Some(room)) => {
                let room = room.clone();
                (Box::new(move |m: &Obj| pj::text_of(m, "scope") == "room" && pj::text_of(m, "room") == room), true)
            }
            _ => return Err(refused("bad-request", "Name one of cid or room.")),
        };
        if !owned {
            return Ok(Vec::new());
        }
        let store = st.ext.get("files").and_then(|f| f.get("files")).and_then(Value::as_object).cloned().unwrap_or_default();
        let mut rows = Vec::new();
        for (fid, meta) in &store {
            let Some(meta) = meta.as_object().filter(|m| wanted(m)) else { continue };
            let ts_ms = (pj::num(meta, "ts") * 1000.0) as i64;
            if ts_ms < q.from_ms || ts_ms > q.to_ms {
                continue;
            }
            // a room file belongs to the session it was shared in: skipped unless the path org owns that one session
            if q.room.as_deref().is_some_and(|room| !orgs.owns(st.api_room_owner_at(orgs, room, ts_ms).as_deref())) {
                continue;
            }
            let mut item = obj([("fid", Value::from(fid.clone()))]);
            match (&q.cid, &q.room) {
                (Some(c), _) => item.insert("cid".into(), Value::from(c.clone())),
                (_, Some(r)) => item.insert("room".into(), Value::from(r.clone())),
                _ => None,
            };
            item.insert("from".into(), orgs.name(&pj::text_of(meta, "from")));
            item.insert("size".into(), meta.get("size").cloned().unwrap_or(Value::Null));
            item.insert("ts".into(), meta.get("ts").cloned().unwrap_or(Value::Null));
            item.insert("scope".into(), meta.get("scope").cloned().unwrap_or(Value::Null));
            rows.push(((ts_ms, fid.clone()), Value::Object(item)));
        }
        Ok(rows)
    }

    /// The console-placed people holds of the org (the API's own, marked `api`, are the console's records).
    fn api_holds(st: &mut State, orgs: &Orgs) -> Vec<((i64, String), Value)> {
        let holds: Vec<Obj> = st.pc_part().get("holds").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_object).cloned().collect();
        holds
            .iter()
            .filter(|h| pj::text_of(h, "on") == "people" && pj::text_of(h, "org") == orgs.org && !h.contains_key("api"))
            .map(|h| {
                let placed = pj::as_int(h.get("placed")).unwrap_or(0);
                let principals = h.get("principals").cloned().unwrap_or_else(|| json!([]));
                let mut item = json!({
                    "hold": pj::s(h, "id"), "on": "people", "count": principals.as_array().map_or(0, Vec::len), "principals": principals,
                    "reason": pj::s(h, "reason"), "placed_at": placed, "by": { "admin": pj::s(h, "by") },
                });
                if let Some(r) = pj::as_int(h.get("released")) {
                    item["released_at"] = Value::from(r);
                }
                ((placed.saturating_mul(1000), pj::s(h, "id")), item)
            })
            .collect()
    }

    /// 5.1 `retention` as this relay holds it; `holds_active` counts the console-placed people holds only (the
    /// console adds its API holds).
    fn api_retention(st: &mut State, orgs: &Orgs) -> Value {
        let policy = orgs.mine.clone().unwrap_or_default();
        let holds_on = st.pc_holds_on();
        let active = st
            .pc_part()
            .get("holds")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_object)
            .filter(|h| pj::text_of(h, "on") == "people" && pj::text_of(h, "org") == orgs.org && !h.contains_key("api") && !pj::truthy(h.get("released")))
            .count();
        let archive = policy.get("archive").and_then(Value::as_object).is_some_and(|a| !a.is_empty());
        json!({
            "policy_seq": pj::as_int(policy.get("seq")).unwrap_or(0),
            "retention": policy.get("retention").filter(|r| r.is_object()).cloned().unwrap_or_else(|| json!({})),
            "archive": { "present": archive, "reviewers": policy.get("archive_reviewers").and_then(Value::as_array).map_or(0, Vec::len) },
            "legal_holds": holds_on,
            "holds_active": active,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn member_logs_replay_into_intervals() {
        let log = vec![
            json!({"seq": 1, "op": "create", "who": ["ann@a.example", "bo@a.example"], "ts": 1000, "rts": 1100}),
            json!({"seq": 2, "op": "add", "who": ["cy@b.example"], "ts": 2000}),
            json!({"seq": 3, "op": "leave", "who": ["bo@a.example"], "ts": 3000, "rts": 3100}),
            json!({"seq": 4, "op": "admin", "who": ["ann@a.example"], "ts": 3500}),
            json!({"seq": 5, "op": "join", "who": ["bo@a.example"], "ts": 4000}),
        ];
        let iv = intervals_of(&log, &[], 0);
        assert_eq!(iv["ann@a.example"], vec![(1100, None)]);
        assert_eq!(iv["bo@a.example"], vec![(1100, Some(3100)), (4000, None)]);
        assert_eq!(iv["cy@b.example"], vec![(2000, None)]);
        // without a log: the members since the conversation was made
        let plain = intervals_of(&[], &["ann@a.example".to_string()], 500);
        assert_eq!(plain["ann@a.example"], vec![(500, None)]);
        assert!(!overlaps(&iv["bo@a.example"], 3200, 3900) && overlaps(&iv["bo@a.example"], 3000, 3050));
    }

    fn orgs() -> Orgs {
        let a = json!({"org": "acme", "domains": ["acme.example"], "archive": {"principal": "archive@apps.acme.example", "device": "d"}}).as_object().unwrap().clone();
        let b = json!({"org": "bolt", "domains": ["bolt.example"]}).as_object().unwrap().clone();
        Orgs { org: "acme".into(), policies: vec![a.clone(), b], mine: Some(a) }
    }

    #[test]
    fn owners_and_names_follow_the_path_org() {
        let o = orgs();
        let people = |l: &[&str]| l.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(o.owner_of_all(&people(&["ann@acme.example", "bo@acme.example", "archive@apps.acme.example"])), Some("acme".into()));
        assert_eq!(o.owner_of_all(&people(&["ann@acme.example", "cy@bolt.example"])), None, "a mixed conversation has no owner");
        assert_eq!(o.owner_of_all(&people(&["ann@acme.example", "zed@nowhere.example"])), None);
        assert_eq!(o.name("ann@acme.example"), json!("ann@acme.example"));
        assert_eq!(o.name("cy@bolt.example"), json!({"outside": "bolt.example"}));
        assert_eq!(o.name("archive@apps.acme.example"), json!("archive@apps.acme.example"), "a service the policy lists");
        assert_eq!(o.name("bot@apps.acme.example"), json!({"outside": "apps.acme.example"}), "a service it does not list");
        assert_eq!(o.person("guest:g1"), obj([("guest", json!("g1"))]));
        assert!(!o.covered("guest:g1") && !o.covered("cy@bolt.example") && o.covered("ann@acme.example"));
    }

    const T: f64 = 1_795_600_000.0;

    /// A relay shared by acme and bolt, with canaries in every content field it keeps.
    fn planted() -> Hub {
        let hub = Hub::new(None, &["admin@acme.example".to_string()], 168.0, 30.0, 365.0, None, std::sync::Arc::new(crate::meet_console::LinkStats::new()));
        {
            let mut st = hub.st.lock();
            let ms = (T * 1000.0) as i64;
            st.meetings.insert("m-aaaaaaaaaa".into(), json!({"id": "m-aaaaaaaaaa", "room": "m-aaaaaaaaaa", "title": "Board review", "description": "CANARY-DESC",
                "start": T, "end": T + 3600.0, "recurrence": "none", "tz": "", "organizer": {"principal": "ann@acme.example", "name": "Ann"},
                "attendees": [{"principal": "cy@bolt.example", "name": "Cy", "response": "accept"}], "canceled": null}));
            st.meetings.insert("m-bbbbbbbbbb".into(), json!({"id": "m-bbbbbbbbbb", "room": "m-bbbbbbbbbb", "title": "BOLT-TITLE", "description": "CANARY-DESC",
                "start": T, "end": T + 3600.0, "recurrence": "none", "tz": "", "organizer": {"principal": "cy@bolt.example", "name": "Cy"},
                "attendees": [{"principal": "ann@acme.example", "name": "Ann", "response": "none"}], "canceled": null}));
            st.attendance.insert("m-aaaaaaaaaa".into(), json!([{"id": "s1", "start": ms, "end": ms + 60_000, "meeting_id": "m-aaaaaaaaaa", "title": "Board review",
                "people": [{"principal": "ann@acme.example", "name": "Ann", "role": "host", "joins": [[ms, ms + 60_000]]},
                           {"principal": "cy@bolt.example", "name": "Cy", "role": "attendee", "joins": [[ms + 10, ms + 50]]}]}]));
            st.attendance.insert("bolt-room".into(), json!([{"id": "s2", "start": ms + 1, "end": null,
                "people": [{"principal": "cy@bolt.example", "name": "Cy", "role": "host", "joins": [[ms + 1, null]]},
                           {"principal": "ann@acme.example", "name": "Ann", "role": "attendee", "joins": [[ms + 5, ms + 9]]}]}]));
            for (id, name, members) in [("c1", "acme-general", ["ann@acme.example", "bo@acme.example"]), ("c2", "BOLT-SECRET", ["ann@acme.example", "cy@bolt.example"])] {
                st.channels.insert(id.into(), json!({"id": id, "kind": "public", "name": name, "topic": "CANARY-TOPIC", "members": members, "created": T,
                                                     "archived": false, "e2ee": false, "bridgeable": true, "e2ee_since": null}));
            }
            st.channel_msgs.insert("c1".into(), vec![obj([("text", json!("CANARY-TEXT")), ("ts", json!(T))])]);
            st.dms.insert("ann@acme.example bo@acme.example".into(), vec![obj([("text", json!("CANARY-TEXT")), ("ts", json!(T))])]);
            st.ext.insert("files".into(), json!({"v": 1, "files": {
                "f1": {"name": "CANARY-NAME.pdf", "sha256": "CANARY-HASH", "size": 10, "type": "application/pdf", "from": "ann@acme.example", "from_name": "Ann", "ts": T, "scope": "channel", "channel": "c1"},
                "f2": {"name": "CANARY-NAME2.pdf", "sha256": "CANARY-HASH2", "size": 11, "type": "application/pdf", "from": "cy@bolt.example", "from_name": "Cy", "ts": T, "scope": "channel", "channel": "c2"}}}));
        }
        hub
    }

    fn q(kind: &str, person: Option<&str>, cid: Option<&str>) -> Query {
        Query { kind: kind.into(), from_ms: 0, to_ms: i64::MAX / 2, limit: PAGE_MAX, person: person.map(str::to_string), room: None, organizer: None, cid: cid.map(str::to_string), after: None }
    }

    #[test]
    fn answers_carry_no_content_and_other_orgs_items_are_reduced() {
        let hub = planted();
        let o = orgs();
        let ms = (T * 1000.0) as i64;
        let mut st = hub.st.lock();
        let mut all = Vec::new();
        all.extend(Hub::api_attendance(&st, &o, &q("attendance", None, None)));
        all.extend(Hub::api_meetings(&st, &o, &q("meetings", None, None)));
        all.extend(Hub::api_conversation_rows(&mut st, &o, &q("conversations", Some("ann@acme.example"), None), "ann@acme.example"));
        all.extend(Hub::api_files(&mut st, &o, &q("files", None, Some("ch:c1"))).unwrap());
        assert!(Hub::api_files(&mut st, &o, &q("files", None, Some("ch:c2"))).unwrap().is_empty(), "files of a conversation acme does not own");
        let items: Vec<Value> = all.iter().map(|(_, v)| v.clone()).collect();
        let text = serde_json::to_string(&items).unwrap();
        // D1: no message text, file name or hash, description or topic; R4-8: no other org's title, name or principal
        for canary in ["CANARY", "BOLT-SECRET", "BOLT-TITLE", "cy@bolt.example"] {
            assert!(!text.contains(canary), "{canary} in {text}");
        }
        let by = |id: &str| all.iter().find(|(k, _)| k.1 == id).map(|(_, v)| v.clone()).unwrap();
        let s1 = by("s1");
        assert_eq!((s1["title"].as_str(), s1["people"][1].clone()), (Some("Board review"), json!({"outside": "bolt.example", "role": "attendee", "joins": [[ms + 10, ms + 50]]})));
        assert_eq!(by("s2"), json!({"owner": "outside", "session": "s2", "people": [{"principal": "ann@acme.example", "joins": [[ms + 5, ms + 9]]}]}));
        assert_eq!(by("m-bbbbbbbbbb"), json!({"owner": "outside", "meeting": "m-bbbbbbbbbb"}));
        assert_eq!(by("m-aaaaaaaaaa")["attendees"], json!([{"outside": "bolt.example"}]));
        assert_eq!(by("ch:c2"), json!({"owner": "outside", "cid": "ch:c2", "members": [{"principal": "ann@acme.example", "intervals": [[ms, null]]}]}));
        let c1 = by("ch:c1");
        assert_eq!((c1["kind"].as_str(), c1["name"].as_str(), c1["covered_by_archive"].as_bool()), (Some("channel"), Some("acme-general"), Some(false)));
        let dm = by(&ce::dm_cid("ann@acme.example", "bo@acme.example"));
        assert_eq!((dm["kind"].as_str(), dm["covered_by_archive"].as_bool(), dm.get("name").is_none()), (Some("dm"), Some(true), true));
        assert_eq!(by("f1"), json!({"fid": "f1", "cid": "ch:c1", "from": "ann@acme.example", "size": 10, "ts": T, "scope": "channel"}));
    }

    /// A reused ad-hoc room: each file goes with the session it was shared in, so the latest organizer's org gets no
    /// earlier session's files, and a file in no session or in two is skipped.
    #[test]
    fn room_files_follow_the_session_they_were_shared_in() {
        let hub = planted();
        let o = orgs();
        let ms = (T * 1000.0) as i64;
        let mut st = hub.st.lock();
        let host = |p: &str| json!([{"principal": p, "name": "H", "role": "host", "joins": []}]);
        st.attendance.insert("reused-room".into(), json!([
            {"id": "s3", "start": ms + 100_000, "end": ms + 200_000, "people": host("cy@bolt.example")},
            {"id": "s4", "start": ms + 300_000, "end": null, "people": host("ann@acme.example")},
            {"id": "s5", "start": ms + 350_000, "end": null, "people": host("ann@acme.example")}]));
        let file = |offset_ms: i64| json!({"name": "CANARY-NAME.pdf", "size": 1, "from": "ann@acme.example", "ts": T + offset_ms as f64 / 1000.0, "scope": "room", "room": "reused-room"});
        let files = st.ext.get_mut("files").and_then(|f| f.get_mut("files")).and_then(Value::as_object_mut).unwrap();
        for (fid, offset) in [("bolt-session", 150_000), ("between", 250_000), ("acme-session", 310_000), ("two-sessions", 400_000)] {
            files.insert(fid.into(), file(offset));
        }
        let mut query = q("files", None, None);
        query.room = Some("reused-room".into());
        let fids: Vec<String> = Hub::api_files(&mut st, &o, &query).unwrap().into_iter().map(|(k, _)| k.1).collect();
        assert_eq!(fids, vec!["acme-session".to_string()]);
    }

    #[test]
    fn pages_follow_the_cursor() {
        let q = |after: Option<(i64, String)>| Query { kind: "files".into(), from_ms: 0, to_ms: i64::MAX, limit: 2, person: None, room: None, organizer: None, cid: None, after };
        let rows = || (0..5).map(|i| ((i as i64, format!("f{i}")), json!(i))).collect::<Vec<_>>();
        let (items, next) = page(rows(), &q(None));
        assert_eq!((items, next.as_deref()), (vec![json!(0), json!(1)], Some("1:f1")));
        let (items, next) = page(rows(), &q(parse_cursor("3:f3")));
        assert_eq!((items, next), (vec![json!(4)], None));
    }

    #[test]
    fn queries_are_checked() {
        let base = |params: Value| json!({"org": "acme", "kind": "attendance", "params": params, "after": null});
        assert!(Query::of(&base(json!({"from": 0, "to": SPAN_MAX_S}))).is_ok());
        assert_eq!(Query::of(&base(json!({"from": 0, "to": SPAN_MAX_S + 1}))).err().unwrap().code, "bad-request");
        assert_eq!(Query::of(&base(json!({"limit": 501}))).err().unwrap().code, "bad-request");
        assert_eq!(Query::of(&json!({"org": "acme", "kind": "messages"})).err().unwrap().code, "bad-request");
        assert!(Query::of(&json!({"org": "acme", "kind": "attendance", "after": "nonsense"})).is_err());
    }
}
