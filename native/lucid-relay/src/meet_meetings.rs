// Phase C (ADR-0540): scheduled meetings of the Meet relay (meet_relay.Hub.meeting_* and meeting_occurrences): a
// title, times, an optional daily, weekday or weekly recurrence at the same wall-clock time in the organizer's IANA
// zone, and attendees from the directory, each meeting in its own room `m-` + 10 base32 characters (the meeting id).
// Only the organizer changes or cancels one, only attendees answer it, everyone involved hears a `meeting` event, and
// the organizer hosts the call when they join its room. A child module of meet_hub: it shares the one lock.

use super::*;
use chrono::{Datelike, Offset, TimeZone};

const MEETING_TITLE_MAX: usize = 200;
/// A meeting's description.
const MEETING_TEXT_MAX: usize = 4000;
const MEETING_ATTENDEES_MAX: usize = 100;
const MEETING_RECURRENCES: [&str; 4] = ["none", "daily", "weekdays", "weekly"];
const MEETING_RESPONSES: [&str; 3] = ["accept", "tentative", "decline"];
/// GET /v1/meetings: from..to spans at most this.
const MEETING_WINDOW_MAX: f64 = 400.0 * 86400.0;
/// Occurrences one GET /v1/meetings answers.
pub(super) const MEETING_LIST_MAX: usize = 1000;
const NOT_ORGANIZER: &str = "only the organizer can change this meeting";
const NOT_ORGANIZER_CANCEL: &str = "only the organizer can cancel this meeting";
const NOT_ATTENDEE: &str = "only the people invited to this meeting can answer it";
const NO_MEETING: &str = "that meeting is not on this relay";
const MEETING_CANCELED: &str = "that meeting was canceled";
const BASE32: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";

/// A Python `re.match(r"^[...]{1,max}$")`: `$` also matches before one final newline.
pub(super) fn re_like(s: &str, max: usize, ok: impl Fn(char) -> bool) -> bool {
    let body = s.strip_suffix('\n').unwrap_or(s);
    let n = body.chars().count();
    (1..=max).contains(&n) && body.chars().all(ok)
}

/// MEETING_ROOM_RE: `m-` + 10 of `[a-z2-7]`.
fn meeting_room_ok(s: &str) -> bool {
    let body = s.strip_suffix('\n').unwrap_or(s);
    body.len() == 12 && body.starts_with("m-") && body[2..].bytes().all(|c| BASE32.contains(&c))
}

/// _meeting_room: a new meeting id, which is also its room: `m-` + 10 random base32 characters.
fn meeting_room() -> String {
    let bytes = pj::random_bytes(10);
    let mut bits: u64 = 0;
    for b in &bytes[..7] {
        bits = (bits << 8) | u64::from(*b);
    }
    // the first 50 of these 56 bits, 5 at a time (base32's first 10 characters)
    let mut out = String::from("m-");
    for i in 0..10 {
        let shift = 56 - 5 * (i + 1);
        out.push(BASE32[((bits >> shift) & 31) as usize] as char);
    }
    out
}

/// _meeting_title.
fn meeting_title(v: Option<&Value>) -> R<String> {
    let title = match v {
        Some(Value::String(s)) => pj::squash(s),
        _ => String::new(),
    };
    if title.is_empty() || pj::char_len(&title) > MEETING_TITLE_MAX || !pj::printable(&title) {
        return bad(format!("a meeting title is 1 to {MEETING_TITLE_MAX} characters"));
    }
    Ok(title)
}

/// _meeting_description.
fn meeting_description(v: Option<&Value>) -> R<String> {
    let text = match v {
        None | Some(Value::Null) => return Ok(String::new()),
        Some(Value::String(s)) => s.trim().to_string(),
        Some(_) => return bad("description must be text"),
    };
    if pj::char_len(&text) > MEETING_TEXT_MAX {
        return bad(format!("a meeting description is at most {MEETING_TEXT_MAX} characters"));
    }
    Ok(text)
}

/// _meeting_time: a time in seconds, after 1970 and before the year 3000.
fn meeting_time(v: Option<&Value>, what: &str) -> R<f64> {
    match pj::as_num(v) {
        Some(t) if t > 0.0 && t < 32503680000.0 => Ok(t),
        _ => bad(format!("{what} must be a time in seconds")),
    }
}

/// _meeting_span.
fn meeting_span(start: f64, end: f64) -> R<()> {
    if end <= start {
        return bad("a meeting must end after it starts");
    }
    if end - start > 86400.0 {
        return bad("a meeting lasts at most 24 hours");
    }
    Ok(())
}

/// _recurrence.
fn recurrence(v: Option<&Value>) -> R<String> {
    match v {
        None | Some(Value::Null) => Ok("none".into()),
        Some(Value::String(s)) if s.is_empty() => Ok("none".into()),
        Some(Value::String(s)) if MEETING_RECURRENCES.contains(&s.as_str()) => Ok(s.clone()),
        _ => bad("recurrence must be none, daily, weekdays or weekly"),
    }
}

/// _time_zone: the organizer's time zone (an IANA name such as Europe/Paris), "" when not given.
fn time_zone(v: Option<&Value>) -> R<String> {
    match v {
        None | Some(Value::Null) => Ok(String::new()),
        Some(Value::String(s)) if s.is_empty() => Ok(String::new()),
        Some(Value::String(s)) if re_like(s, 64, |c| c.is_ascii_alphanumeric() || "_+./-".contains(c)) => Ok(s.clone()),
        _ => bad("tz must be a time zone name such as Europe/Paris"),
    }
}

/// _attendees: the principals a meeting invites, lower case, each once.
fn attendees(v: Option<&Value>) -> R<Vec<String>> {
    let list = match v {
        Some(Value::Array(a)) if a.iter().all(Value::is_string) => a,
        _ => return bad("attendees must be a list of people"),
    };
    let mut out: Vec<String> = Vec::new();
    for p in list {
        let p = p.as_str().unwrap_or_default().trim().to_lowercase();
        if !p.is_empty() && !out.contains(&p) {
            out.push(p);
        }
    }
    if out.len() > MEETING_ATTENDEES_MAX {
        return bad(format!("a meeting has at most {MEETING_ATTENDEES_MAX} attendees"));
    }
    Ok(out)
}

/// _meeting_cohosts: the principals the organizer names co-organizers of the meeting's calls, lower case, each once.
fn cohosts(v: Option<&Value>) -> R<Vec<String>> {
    let list = match v {
        None | Some(Value::Null) => return Ok(Vec::new()),
        Some(Value::Array(a)) if a.iter().all(Value::is_string) => a,
        _ => return bad("cohosts must be a list of people"),
    };
    let mut out: Vec<String> = Vec::new();
    for p in list {
        let p = p.as_str().unwrap_or_default().trim().to_lowercase();
        if !p.is_empty() && !out.contains(&p) {
            out.push(p);
        }
    }
    if out.len() > parity::COHOSTS_MAX {
        return bad(parity::MEETING_COHOSTS_FULL);
    }
    Ok(out)
}

/// _stored_meeting: a meeting from state.json has the shape the routes rely on.
pub(super) fn stored_meeting(mid: &str, meeting: &Value) -> bool {
    let Some(m) = meeting.as_object() else { return false };
    let principal_of = |v: &Value| v.as_object().map(|o| o.get("principal").map(Value::is_string).unwrap_or(false)).unwrap_or(false);
    meeting_room_ok(mid)
        && m.get("id").and_then(Value::as_str) == Some(mid)
        && m.get("room").and_then(Value::as_str) == Some(mid)
        && m.get("title").map(Value::is_string).unwrap_or(false)
        && m.get("organizer").map(principal_of).unwrap_or(false)
        && m.get("attendees").and_then(Value::as_array).map(|a| a.iter().all(principal_of)).unwrap_or(false)
        && MEETING_RECURRENCES.contains(&pj::text_of(m, "recurrence").as_str())
        && matches!((meeting_time(m.get("start"), "start"), meeting_time(m.get("end"), "end")), (Ok(s), Ok(e)) if s < e)
}

/// datetime.fromtimestamp(t, tz): the wall clock in `zone` at `t`, microseconds rounded half to even.
fn wall_clock(t: f64, zone: chrono_tz::Tz) -> Option<chrono::NaiveDateTime> {
    let (secs, frac) = (t.trunc(), t.fract());
    let (mut secs, mut us) = (secs as i64, (frac * 1e6).round_ties_even() as i64);
    if us >= 1_000_000 {
        secs += 1;
        us -= 1_000_000;
    } else if us < 0 {
        secs -= 1;
        us += 1_000_000;
    }
    let utc = chrono::DateTime::<chrono::Utc>::from_timestamp(secs, (us * 1000) as u32)?;
    Some(utc.with_timezone(&zone).naive_local())
}

/// datetime(..., tzinfo=zone).timestamp() with fold 0: a wall-clock time repeated by a daylight saving change is its
/// first instant; one skipped by it is read with the offset in force before the change.
fn instant(local: chrono::NaiveDateTime, zone: chrono_tz::Tz) -> f64 {
    let utc = match zone.from_local_datetime(&local).earliest() {
        Some(d) => d.naive_utc(),
        None => {
            let before = zone.offset_from_utc_datetime(&(local - chrono::TimeDelta::hours(24))).fix();
            local - chrono::TimeDelta::seconds(i64::from(before.local_minus_utc()))
        }
    };
    let micros = utc.and_utc().timestamp() * 1_000_000 + i64::from(utc.and_utc().timestamp_subsec_micros());
    micros as f64 / 1e6
}

/// meeting_occurrences: `(start, end)` of every occurrence overlapping `[lo, hi]`. A recurring meeting repeats at the
/// same wall-clock time in its organizer's zone (`tz`; UTC when unknown): daily, Monday to Friday (`weekdays`) or on
/// the first start's weekday (`weekly`).
pub(super) fn meeting_occurrences(start: f64, end: f64, recurrence: &str, tz: &str, lo: f64, hi: f64, limit: usize) -> Vec<(f64, f64)> {
    let length = end - start;
    if !matches!(recurrence, "daily" | "weekdays" | "weekly") {
        return if start <= hi && end >= lo { vec![(start, end)] } else { Vec::new() };
    }
    let zone: chrono_tz::Tz = if tz.is_empty() { chrono_tz::UTC } else { tz.parse().unwrap_or(chrono_tz::UTC) };
    let Some(first) = wall_clock(start, zone) else { return Vec::new() };
    let step: i64 = if recurrence == "weekly" { 7 } else { 1 };
    // the first day that can still overlap lo (one spare day for a daylight saving shift)
    let mut day = (((lo - end) / 86400.0).floor() as i64 - 1).max(0);
    day -= day % step;
    let mut out = Vec::new();
    while out.len() < limit {
        let Some(date) = first.date().checked_add_days(chrono::Days::new(day as u64)) else { break };
        day += step;
        if recurrence == "weekdays" && date.weekday().num_days_from_monday() >= 5 {
            continue;
        }
        let s = instant(date.and_time(first.time()), zone);
        if s > hi {
            break;
        }
        if s + length >= lo {
            out.push((s, s + length));
        }
    }
    out
}

fn people_of(m: &Obj) -> Vec<String> {
    let mut out = vec![m.get("organizer").and_then(|o| o.get("principal")).and_then(Value::as_str).unwrap_or_default().to_string()];
    out.extend(m.get("attendees").and_then(Value::as_array).into_iter().flatten().map(|a| a.get("principal").and_then(Value::as_str).unwrap_or_default().to_string()));
    out
}

fn organizer_of(m: &Obj) -> String {
    m.get("organizer").and_then(|o| o.get("principal")).and_then(Value::as_str).unwrap_or_default().to_string()
}

impl State {
    /// _meeting_person: a person as a meeting names them, with the name the directory has now.
    fn meeting_person(&self, principal: &str, name: &str) -> Obj {
        let current = self.directory.get(principal).and_then(Value::as_object).map(|e| pj::s(e, "name")).unwrap_or_default();
        let name = if !current.is_empty() { current } else if !name.is_empty() { name.to_string() } else { principal.to_string() };
        obj([("principal", Value::from(principal)), ("name", Value::from(name)), ("org", self.org(principal))])
    }

    /// _meeting_view: a meeting as clients see it: names and organizations as they are now.
    fn meeting_view(&self, m: &Obj) -> Obj {
        let organizer = as_obj(m.get("organizer")).cloned().unwrap_or_default();
        let attendees: Vec<Value> = m
            .get("attendees")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_object)
            .map(|a| {
                let response = a.get("response").cloned().unwrap_or_else(|| Value::from("none"));
                Value::Object(with(&self.meeting_person(&pj::text_of(a, "principal"), &pj::s(a, "name")), obj([("response", response)])))
            })
            .collect();
        obj([
            ("id", m.get("id").cloned().unwrap_or(Value::Null)),
            ("room", m.get("room").cloned().unwrap_or(Value::Null)),
            ("title", m.get("title").cloned().unwrap_or(Value::Null)),
            ("description", m.get("description").cloned().unwrap_or_else(|| Value::from(""))),
            ("start", m.get("start").cloned().unwrap_or(Value::Null)),
            ("end", m.get("end").cloned().unwrap_or(Value::Null)),
            ("recurrence", m.get("recurrence").cloned().unwrap_or(Value::Null)),
            ("tz", m.get("tz").cloned().unwrap_or_else(|| Value::from(""))),
            ("organizer", Value::Object(self.meeting_person(&pj::text_of(&organizer, "principal"), &pj::s(&organizer, "name")))),
            ("attendees", Value::Array(attendees)),
            ("cohosts", m.get("cohosts").filter(|c| c.is_array()).cloned().unwrap_or_else(|| Value::Array(Vec::new()))),
            ("created", m.get("created").cloned().unwrap_or_else(|| Value::from(0))),
            ("updated", m.get("updated").cloned().unwrap_or_else(|| Value::from(0))),
            ("canceled", m.get("canceled").cloned().unwrap_or(Value::Null)),
        ])
    }

    /// _meeting: the id of a meeting on this relay.
    fn meeting_id(&self, id: Body) -> R<String> {
        let Some(Value::String(id)) = id.filter(|v| v.as_str().map(|s| !s.is_empty()).unwrap_or(false)) else { return bad("say which meeting (id)") };
        let key = id.trim().to_lowercase();
        if !self.meetings.contains_key(&key) {
            return Err(E::NotFound(NO_MEETING.into()));
        }
        Ok(key)
    }

    fn meeting_obj(&self, key: &str) -> Obj {
        as_obj(self.meetings.get(key)).cloned().unwrap_or_default()
    }

    /// _known: every invited person has used this relay.
    fn meeting_known(&self, people: &[String]) -> R<()> {
        let missing: Vec<&str> = people.iter().filter(|p| !self.directory.contains_key(p.as_str())).map(String::as_str).collect();
        if !missing.is_empty() {
            return Err(E::NotFound(format!("not known on this relay: {}", missing.join(", "))));
        }
        Ok(())
    }

    /// _tell_meeting.
    fn tell_meeting(&mut self, people: &[String], why: &str, m: &Obj, by: &str, skip: Option<&str>) {
        let event = obj([("type", Value::from("meeting")), ("why", Value::from(why)), ("meeting", Value::Object(self.meeting_view(m))), ("by", Value::from(by))]);
        self.tell(people, &event, skip);
    }

    /// _organizer_host: the organizer of the scheduled meeting held in `room` hosts it: true when this admitted peer
    /// is that organizer and just took the host role from someone else (the caller tells the room, stage `why:
    /// "organizer"`).
    pub(super) fn organizer_host(&mut self, room: &str, peer_id: &str) -> bool {
        let Some(m) = as_obj(self.meetings.get(room)) else { return false };
        let Some(p) = self.peers.get(peer_id) else { return false };
        if pj::truthy(m.get("canceled")) || p.admission_pending || organizer_of(m) != p.who.principal {
            return false;
        }
        let principal = p.who.principal.clone();
        let stage = self.stage_mut(room);
        if stage.get("host").and_then(Value::as_str) == Some(peer_id) {
            return false;
        }
        stage.insert("host".into(), Value::from(peer_id));
        log_info(&format!("stage room={room} principal={principal} host=organizer"));
        true
    }
}

impl Hub {
    /// meeting_create (`POST /v1/meetings`): schedule a meeting in a new room; every attendee (who must be in the
    /// directory) and the organizer's other sessions hear `meeting` `invite`. `cohosts` (people in the directory)
    /// become co-organizers of its calls when they join.
    #[allow(clippy::too_many_arguments)]
    pub fn meeting_create(&self, session: &str, who: &Identity, title: Body, start: Body, end: Body, attendees_v: Body, description: Body, recurrence_v: Body, tz: Body, cohosts_v: Body) -> R<Obj> {
        let title = meeting_title(title)?;
        let (start, end) = (meeting_time(start, "start")?, meeting_time(end, "end")?);
        meeting_span(start, end)?;
        let description = meeting_description(description)?;
        let recurrence = recurrence(recurrence_v)?;
        let tz = time_zone(tz)?;
        let people = attendees(attendees_v)?;
        let chosen = cohosts(cohosts_v)?;
        let mut st = self.st.lock();
        let r = (|| -> R<(Obj, String, usize)> {
            st.session(session, who)?;
            let people: Vec<String> = people.into_iter().filter(|p| *p != who.principal).collect();
            st.meeting_known(&people)?;
            let chosen: Vec<String> = chosen.into_iter().filter(|p| *p != who.principal).collect();
            st.meeting_known(&chosen)?;
            let mut room = meeting_room();
            while st.meetings.contains_key(&room) || st.rooms.contains_key(&room) {
                room = meeting_room();
            }
            let now = pj::now();
            let listed: Vec<Value> = people
                .iter()
                .map(|p| Value::Object(obj([("principal", Value::from(p.clone())), ("name", st.meeting_person(p, "")["name"].clone()), ("response", Value::from("none"))])))
                .collect();
            let m = obj([
                ("id", Value::from(room.clone())),
                ("room", Value::from(room.clone())),
                ("title", Value::from(title.clone())),
                ("description", Value::from(description.clone())),
                ("start", f(start)),
                ("end", f(end)),
                ("recurrence", Value::from(recurrence.clone())),
                ("tz", Value::from(tz.clone())),
                ("organizer", Value::Object(obj([("principal", Value::from(who.principal.clone())), ("name", Value::from(who.name.clone()))]))),
                ("attendees", Value::Array(listed)),
                ("cohosts", Value::Array(chosen.into_iter().map(Value::from).collect())),
                ("created", f(now)),
                ("updated", f(now)),
                ("canceled", Value::Null),
            ]);
            st.meetings.insert(room.clone(), Value::Object(m.clone()));
            st.dirty = true;
            st.tell_meeting(&people_of(&m), "invite", &m, &who.principal, Some(session));
            // NT-1 section 3.8: each attendee's offline iPhones hear `invite`
            st.nt_meeting("invite", &m, &people);
            Ok((st.meeting_view(&m), room, people.len()))
        })();
        drop(st);
        self.wake();
        let (out, room, count) = r?;
        log_info(&format!("meeting created id={room} by={} attendees={count} recurrence={recurrence}", who.principal));
        Ok(out)
    }

    /// meeting_update (`POST /v1/meetings/update`, organizer only): the fields given change. A new time or recurrence
    /// asks everyone again (responses back to none). Kept attendees hear `update`, added ones `invite`, removed ones
    /// `cancel`.
    pub fn meeting_update(&self, session: &str, who: &Identity, id: Body, changes: &Obj) -> R<Obj> {
        let given = |k: &str| changes.get(k).filter(|v| !v.is_null());
        let title = given("title").map(|v| meeting_title(Some(v))).transpose()?;
        let start = given("start").map(|v| meeting_time(Some(v), "start")).transpose()?;
        let end = given("end").map(|v| meeting_time(Some(v), "end")).transpose()?;
        let description = given("description").map(|v| meeting_description(Some(v))).transpose()?;
        let recurrence = given("recurrence").map(|v| recurrence(Some(v))).transpose()?;
        let tz = given("tz").map(|v| time_zone(Some(v))).transpose()?;
        let people = given("attendees").map(|v| attendees(Some(v))).transpose()?;
        let chosen = given("cohosts").map(|v| cohosts(Some(v))).transpose()?;
        let mut st = self.st.lock();
        let r = (|| -> R<(Obj, String, usize, usize, usize, bool)> {
            st.session(session, who)?;
            let key = st.meeting_id(id)?;
            let mut m = st.meeting_obj(&key);
            if organizer_of(&m) != who.principal {
                return forbidden(NOT_ORGANIZER);
            }
            if pj::truthy(m.get("canceled")) {
                return bad(MEETING_CANCELED);
            }
            let (old_start, old_end) = (pj::num(&m, "start"), pj::num(&m, "end"));
            let new_start = start.unwrap_or(old_start);
            let new_end = end.unwrap_or(old_end);
            meeting_span(new_start, new_end)?;
            let people = match people.clone() {
                Some(list) => {
                    let list: Vec<String> = list.into_iter().filter(|p| *p != who.principal).collect();
                    st.meeting_known(&list)?;
                    Some(list)
                }
                None => None,
            };
            if let Some(list) = chosen {
                let list: Vec<String> = list.into_iter().filter(|p| *p != who.principal).collect();
                st.meeting_known(&list)?;
                m.insert("cohosts".into(), Value::Array(list.into_iter().map(Value::from).collect()));
            }
            let retime = (new_start, new_end) != (old_start, old_end)
                || recurrence.as_ref().map(|r| *r != pj::text_of(&m, "recurrence")).unwrap_or(false)
                || tz.as_ref().map(|t| *t != pj::text_of(&m, "tz")).unwrap_or(false);
            let before: Vec<String> = people_of(&m)[1..].to_vec();
            if start.is_some() || new_start != old_start {
                m.insert("start".into(), f(new_start));
            }
            if end.is_some() || new_end != old_end {
                m.insert("end".into(), f(new_end));
            }
            if let Some(t) = &title {
                m.insert("title".into(), Value::from(t.clone()));
            }
            if let Some(d) = &description {
                m.insert("description".into(), Value::from(d.clone()));
            }
            if let Some(r) = &recurrence {
                m.insert("recurrence".into(), Value::from(r.clone()));
            }
            if let Some(t) = &tz {
                m.insert("tz".into(), Value::from(t.clone()));
            }
            if let Some(list) = &people {
                let kept: Vec<Obj> = m.get("attendees").and_then(Value::as_array).into_iter().flatten().filter_map(|a| a.as_object().cloned()).collect();
                let rows: Vec<Value> = list
                    .iter()
                    .map(|p| match kept.iter().find(|a| pj::text_of(a, "principal") == *p) {
                        Some(a) => Value::Object(a.clone()),
                        None => Value::Object(obj([("principal", Value::from(p.clone())), ("name", st.meeting_person(p, "")["name"].clone()), ("response", Value::from("none"))])),
                    })
                    .collect();
                m.insert("attendees".into(), Value::Array(rows));
            }
            if retime {
                if let Some(Value::Array(rows)) = m.get_mut("attendees") {
                    for a in rows.iter_mut().filter_map(Value::as_object_mut) {
                        a.insert("response".into(), Value::from("none"));
                    }
                }
            }
            m.insert("updated".into(), f(pj::now()));
            st.meetings.insert(key.clone(), Value::Object(m.clone()));
            st.dirty = true;
            let now_in: Vec<String> = people_of(&m)[1..].to_vec();
            let added: Vec<String> = now_in.iter().filter(|p| !before.contains(p)).cloned().collect();
            let removed: Vec<String> = before.iter().filter(|p| !now_in.contains(p)).cloned().collect();
            let mut staying = vec![who.principal.clone()];
            staying.extend(now_in.iter().filter(|p| before.contains(p)).cloned());
            st.tell_meeting(&staying, "update", &m, &who.principal, Some(session));
            if !added.is_empty() {
                st.tell_meeting(&added, "invite", &m, &who.principal, None);
            }
            if !removed.is_empty() {
                st.tell_meeting(&removed, "cancel", &m, &who.principal, None);
            }
            // NT-1 section 3.8: added attendees hear `invite`, kept ones `update` when the start or end changed,
            // removed ones `cancel`
            st.nt_meeting("invite", &m, &added);
            if (new_start, new_end) != (old_start, old_end) {
                st.nt_meeting("update", &m, &staying);
            }
            st.nt_meeting("cancel", &m, &removed);
            Ok((st.meeting_view(&m), key, now_in.len(), added.len(), removed.len(), retime))
        })();
        drop(st);
        self.wake();
        let (out, key, count, added, removed, retime) = r?;
        log_info(&format!(
            "meeting updated id={key} by={} attendees={count} added={added} removed={removed} retimed={}",
            who.principal,
            if retime { "yes" } else { "no" }
        ));
        Ok(out)
    }

    /// meeting_cancel (`POST /v1/meetings/cancel`, organizer only). Canceling a canceled meeting answers it again and
    /// tells nobody.
    pub fn meeting_cancel(&self, session: &str, who: &Identity, id: Body) -> R<Obj> {
        let mut st = self.st.lock();
        let r = (|| -> R<(Obj, Option<String>)> {
            st.session(session, who)?;
            let key = st.meeting_id(id)?;
            let mut m = st.meeting_obj(&key);
            if organizer_of(&m) != who.principal {
                return forbidden(NOT_ORGANIZER_CANCEL);
            }
            if pj::truthy(m.get("canceled")) {
                return Ok((st.meeting_view(&m), None));
            }
            let now = pj::now();
            m.insert("canceled".into(), f(now));
            m.insert("updated".into(), f(now));
            st.meetings.insert(key.clone(), Value::Object(m.clone()));
            st.dirty = true;
            st.tell_meeting(&people_of(&m), "cancel", &m, &who.principal, Some(session));
            // NT-1 section 3.8: every attendee's offline iPhones hear `cancel`
            st.nt_meeting("cancel", &m, &people_of(&m));
            Ok((st.meeting_view(&m), Some(key)))
        })();
        drop(st);
        self.wake();
        let (out, canceled) = r?;
        if let Some(key) = canceled {
            log_info(&format!("meeting canceled id={key} by={}", who.principal));
        }
        Ok(out)
    }

    /// meeting_rsvp (`POST /v1/meetings/rsvp`, attendees only): accept, tentative or decline. The organizer and the
    /// attendees hear `meeting` `rsvp`.
    pub fn meeting_rsvp(&self, session: &str, who: &Identity, id: Body, response: Body) -> R<Obj> {
        let response = match response {
            Some(Value::String(r)) if MEETING_RESPONSES.contains(&r.as_str()) => r.clone(),
            _ => return bad("response must be accept, tentative or decline"),
        };
        let mut st = self.st.lock();
        let r = (|| -> R<(Obj, String)> {
            st.session(session, who)?;
            let key = st.meeting_id(id)?;
            let mut m = st.meeting_obj(&key);
            let Some(Value::Array(rows)) = m.get_mut("attendees") else { return forbidden(NOT_ATTENDEE) };
            let Some(mine) = rows.iter_mut().filter_map(Value::as_object_mut).find(|a| pj::text_of(a, "principal") == who.principal) else { return forbidden(NOT_ATTENDEE) };
            let changed = mine.get("response").and_then(Value::as_str) != Some(response.as_str());
            if pj::truthy(m.get("canceled")) {
                return bad(MEETING_CANCELED);
            }
            if changed {
                if let Some(Value::Array(rows)) = m.get_mut("attendees") {
                    if let Some(a) = rows.iter_mut().filter_map(Value::as_object_mut).find(|a| pj::text_of(a, "principal") == who.principal) {
                        a.insert("response".into(), Value::from(response.clone()));
                    }
                }
                m.insert("updated".into(), f(pj::now()));
                st.meetings.insert(key.clone(), Value::Object(m.clone()));
                st.dirty = true;
                st.tell_meeting(&people_of(&m), "rsvp", &m, &who.principal, Some(session));
            }
            Ok((st.meeting_view(&m), key))
        })();
        drop(st);
        self.wake();
        let (out, key) = r?;
        log_info(&format!("meeting rsvp id={key} principal={} response={response}", who.principal));
        Ok(out)
    }

    /// meetings_list (`GET /v1/meetings`): `{meetings: [...]}`, the caller's (organizer or attendee) overlapping
    /// `[from, to]` (default: now and the next 14 days), one entry per occurrence with `occurrence_start` and
    /// `occurrence_end`, earliest first.
    pub fn meetings_list(&self, session: &str, who: &Identity, from: &str, to: &str) -> R<Obj> {
        let lo = if from.is_empty() { pj::now() } else { m::number(Some(&Value::from(from)), "from")? };
        let hi = if to.is_empty() { lo + 14.0 * 86400.0 } else { m::number(Some(&Value::from(to)), "to")? };
        if hi < lo {
            return bad("to must not be before from");
        }
        if hi - lo > MEETING_WINDOW_MAX {
            return bad(format!("ask for at most {} days at once", (MEETING_WINDOW_MAX / 86400.0) as i64));
        }
        let st = self.st.lock();
        st.session(session, who)?;
        let mut out: Vec<(f64, String, Obj)> = Vec::new();
        for m in st.meetings.values().filter_map(Value::as_object) {
            if !people_of(m).contains(&who.principal) {
                continue;
            }
            let spans = meeting_occurrences(pj::num(m, "start"), pj::num(m, "end"), &pj::text_of(m, "recurrence"), &pj::text_of(m, "tz"), lo, hi, MEETING_LIST_MAX);
            if spans.is_empty() {
                continue;
            }
            let view = st.meeting_view(m);
            let id = pj::text_of(m, "id");
            for (s, e) in spans {
                out.push((s, id.clone(), with(&view, obj([("occurrence_start", f(s)), ("occurrence_end", f(e))]))));
            }
        }
        out.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal).then_with(|| a.1.cmp(&b.1)));
        Ok(obj([("meetings", Value::Array(out.into_iter().take(MEETING_LIST_MAX).map(|(_, _, v)| Value::Object(v)).collect()))]))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(y: i32, mo: u32, d: u32, h: u32, zone: chrono_tz::Tz) -> f64 {
        zone.with_ymd_and_hms(y, mo, d, h, 0, 0).single().unwrap().timestamp() as f64
    }

    #[test]
    fn a_weekly_meeting_keeps_its_wall_clock_across_daylight_saving() {
        let paris: chrono_tz::Tz = "Europe/Paris".parse().unwrap();
        // Monday 2026-03-23 10:00 in Paris (UTC+1); the clocks go forward on 2026-03-29
        let start = at(2026, 3, 23, 10, paris);
        let got = meeting_occurrences(start, start + 1800.0, "weekly", "Europe/Paris", start - 60.0, start + 8.0 * 86400.0, MEETING_LIST_MAX);
        assert_eq!(got.len(), 2);
        assert_eq!(got[1].0, at(2026, 3, 30, 10, paris));
        assert_eq!(got[1].0 - got[0].0, 7.0 * 86400.0 - 3600.0);
        // an unknown zone repeats on UTC days
        let utc = meeting_occurrences(start, start + 1800.0, "weekly", "Nowhere/City", start - 60.0, start + 8.0 * 86400.0, MEETING_LIST_MAX);
        assert_eq!(utc[1].0 - utc[0].0, 7.0 * 86400.0);
    }

    #[test]
    fn weekdays_skip_the_weekend_and_one_off_meetings_overlap_or_not() {
        let start = at(2026, 11, 16, 9, chrono_tz::UTC); // a Monday
        let got = meeting_occurrences(start, start + 600.0, "weekdays", "", start, start + 14.0 * 86400.0 - 1.0, MEETING_LIST_MAX);
        assert_eq!(got.len(), 10);
        assert_eq!(meeting_occurrences(start, start + 600.0, "none", "", start + 700.0, start + 800.0, 10), Vec::new());
        assert_eq!(meeting_occurrences(start, start + 600.0, "none", "", start + 500.0, start + 800.0, 10), vec![(start, start + 600.0)]);
    }

    #[test]
    fn a_meeting_id_is_its_room() {
        let id = meeting_room();
        assert!(meeting_room_ok(&id), "{id}");
        assert!(!meeting_room_ok("m-ABCDEFGHIJ") && !meeting_room_ok("m-abc"));
    }
}
