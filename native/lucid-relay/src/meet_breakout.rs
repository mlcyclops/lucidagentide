// Phase C (ADR-0540), wave 3: breakout rooms (meet_relay._Wave3Breakout). The host of a call plans 2 to 20 rooms
// (ids `<main room[:33]>-b<N>`, each with a name and the people assigned to it), opens them (with an optional timer),
// sends one message to all of them, moves people and closes them; everyone is back in the main room RETURN_S seconds
// after a close (or after the timer ran out). Every action is a `/v1/stage` action `breakout_*`; the plan is
// `stage.breakout` of the main room AND of each breakout room, and each change reaches everyone in all of those rooms
// as one `breakout` event plus a `stage` event. Only assigned people (and the planner, the main room's host and relay
// admins) join an open breakout room. In memory like the stage, but the plan outlives an empty main room while the
// rooms are open or closing. Times are wall-clock seconds; the timer and the return are computed when read (`tick`),
// so no sweep is needed for them. A child module of meet_hub: it shares the one lock.

use super::*;

const ACTIONS: [&str; 5] = ["breakout_plan", "breakout_open", "breakout_close", "breakout_message", "breakout_move"];
/// A close: everyone is back in the main room after this.
const RETURN_S: f64 = 60.0;
/// An open plan whose rooms all stay empty this long is dropped.
const IDLE_S: f64 = 600.0;
const ROOMS_MIN: usize = 2;
const ROOMS_MAX: usize = 20;
/// People assigned over all the rooms of one plan.
const PEOPLE_MAX: usize = 200;
const NAME_MAX: usize = 40;
const MESSAGE_MAX: usize = 500;
const MINUTES_MAX: i64 = 1440;
/// The main room's name is cut to this before "-b<N>".
const BASE_MAX: usize = 33;
const NOT_OPEN: &str = "the breakout rooms are not open";

pub(super) struct Room {
    id: String,
    name: String,
    members: Vec<String>,
}

/// One main room's plan: by (the planner's principal), its rooms, open, ends_at, return_at, can_return, the last
/// message to every room, and since when every room of it is empty.
pub(super) struct Plan {
    main: String,
    by: String,
    rooms: Vec<Room>,
    open: bool,
    ends_at: Option<f64>,
    return_at: Option<f64>,
    can_return: bool,
    message: Option<Obj>,
    empty_since: Option<f64>,
}

fn time_value(t: Option<f64>) -> Value {
    t.map(f).unwrap_or(Value::Null)
}

impl Plan {
    /// _breakout_tick: a timer that ran out closes the rooms (everyone returns RETURN_S later); a return that is over
    /// leaves the plan planned, ready to open again.
    fn tick(&mut self, now: f64) {
        if let (true, Some(end)) = (self.open, self.ends_at) {
            if now >= end {
                self.open = false;
                self.return_at = Some(end + RETURN_S);
                self.ends_at = None;
            }
        }
        if let (false, Some(back)) = (self.open, self.return_at) {
            if now >= back {
                self.return_at = None;
            }
        }
    }

    /// _breakout_live: open, or closing (people are on their way back).
    fn live(&self) -> bool {
        self.open || self.return_at.is_some()
    }

    /// _breakout_rooms_of: the main room, then its breakout rooms.
    fn rooms_of(&self) -> Vec<String> {
        std::iter::once(self.main.clone()).chain(self.rooms.iter().map(|r| r.id.clone())).collect()
    }

    fn rooms_value(&self) -> Value {
        Value::Array(
            self.rooms
                .iter()
                .map(|r| Value::Object(obj([("id", Value::from(r.id.clone())), ("name", Value::from(r.name.clone())), ("members", Value::Array(r.members.iter().cloned().map(Value::from).collect()))])))
                .collect(),
        )
    }

    /// _breakout_public: the plan as `stage.breakout` shows it.
    fn public(&mut self, now: f64) -> Obj {
        self.tick(now);
        obj([
            ("main", Value::from(self.main.clone())),
            ("by", Value::from(self.by.clone())),
            ("open", Value::Bool(self.open)),
            ("rooms", self.rooms_value()),
            ("ends_at", time_value(self.ends_at)),
            ("return_at", time_value(self.return_at)),
            ("can_return", Value::Bool(self.can_return)),
            ("message", self.message.clone().map(Value::Object).unwrap_or(Value::Null)),
        ])
    }
}

/// _breakout_parse_rooms: `[{name, members: [principal]}]`, 2 to 20 rooms, each person in one room at most.
fn parse_rooms(body: &Obj) -> R<Vec<(String, Vec<String>)>> {
    let rooms = match body.get("rooms") {
        Some(Value::Array(a)) if (ROOMS_MIN..=ROOMS_MAX).contains(&a.len()) => a,
        _ => return bad(format!("plan {ROOMS_MIN} to {ROOMS_MAX} breakout rooms (rooms)")),
    };
    let mut out = Vec::with_capacity(rooms.len());
    let mut seen: HashSet<String> = HashSet::new();
    for (n, item) in rooms.iter().enumerate() {
        let Some(item) = item.as_object() else { return bad("each breakout room has a name and members") };
        // `item.get("name") or ""` must be text
        let raw_name = match item.get("name") {
            Some(Value::String(s)) => s.clone(),
            v if !pj::truthy(v) => String::new(),
            _ => return bad("each breakout room has a name and members"),
        };
        let printable: String = raw_name.chars().filter(|c| pj::printable(c.encode_utf8(&mut [0u8; 4]))).collect();
        let mut name = pj::squash(&printable);
        if name.is_empty() {
            name = format!("Room {}", n + 1);
        }
        if pj::char_len(&name) > NAME_MAX {
            return bad(format!("a breakout room name is at most {NAME_MAX} characters"));
        }
        let members: &[Value] = match item.get("members") {
            None => &[],
            Some(Value::Array(a)) => a,
            Some(_) => return bad("members must be a list of people"),
        };
        let mut people = Vec::with_capacity(members.len());
        for value in members {
            let principal = if value.is_string() { m::principal(Some(value)) } else { String::new() };
            if principal.is_empty() || pj::char_len(&principal) > 254 || principal.chars().any(char::is_whitespace) {
                return bad("members must be a list of people");
            }
            if !seen.insert(principal.clone()) {
                return bad("a person can be in one breakout room only");
            }
            people.push(principal);
        }
        out.push((name, people));
    }
    if seen.len() > PEOPLE_MAX {
        return bad(format!("at most {PEOPLE_MAX} people in breakout rooms"));
    }
    Ok(out)
}

impl State {
    /// _breakout_plan_of: the main room of the plan `room` belongs to, as its main room or as one of its breakout
    /// rooms.
    fn breakout_plan_of(&self, room: &str) -> Option<String> {
        if self.breakouts.contains_key(room) {
            return Some(room.to_string());
        }
        self.breakouts.values().find(|p| p.rooms.iter().any(|r| r.id == room)).map(|p| p.main.clone())
    }

    fn breakout_plan(&mut self, main: &str) -> &mut Plan {
        self.breakouts.get_mut(main).expect("the breakout plan")
    }

    /// _breakout_stage_view: `stage.breakout` while `room` belongs to a plan.
    pub(super) fn breakout_stage_view(&mut self, room: &str, view: &mut Obj) {
        if let Some(main) = self.breakout_plan_of(room) {
            let public = self.breakout_plan(&main).public(pj::now());
            view.insert("breakout".into(), Value::Object(public));
        }
    }

    /// _breakout_tell: one `breakout` event, then the fresh stage, to everyone in the main room and in every breakout
    /// room. `message` rides only on the event that sent it.
    fn breakout_tell(&mut self, main: &str, why: &str, by: &str) {
        let plan = self.breakout_plan(main);
        let public = plan.public(pj::now());
        let assign: Obj = plan.rooms.iter().flat_map(|r| r.members.iter().map(|p| (p.clone(), Value::from(r.id.clone())))).collect();
        let rooms = plan.rooms_of();
        let mut event = obj([
            ("type", Value::from("breakout")),
            ("room", Value::from(main)),
            ("why", Value::from(why)),
            ("by", Value::from(by)),
            ("open", public["open"].clone()),
            ("rooms", public["rooms"].clone()),
            ("assign", Value::Object(assign)),
            ("ends_at", public["ends_at"].clone()),
            ("return_at", public["return_at"].clone()),
            ("can_return", public["can_return"].clone()),
        ]);
        if why == "breakout_message" && !public["message"].is_null() {
            event.insert("message".into(), public["message"].clone());
        }
        for room in rooms {
            self.broadcast(&room, &event, None);
            self.stage_event(&room, why, by, None);
        }
    }

    /// _breakout_hosts: host powers over the breakout rooms of `main`: a relay admin, the person who planned them, or
    /// the person who hosts the main room now (from any device).
    fn breakout_hosts(&self, planner: Option<&str>, main: &str, who: &Identity) -> bool {
        if self.admins.contains(&who.principal) || planner == Some(who.principal.as_str()) {
            return true;
        }
        self.stage_host(main).and_then(|h| self.peers.get(&h)).map(|p| p.who.principal == who.principal).unwrap_or(false)
    }

    /// _breakout_may_join: an open breakout room takes the people assigned to it (and its hosts).
    pub(super) fn breakout_may_join(&mut self, room: &str, who: &Identity) -> R<()> {
        let Some(main) = self.breakout_plan_of(room) else { return Ok(()) };
        let planner = self.breakouts[&main].by.clone();
        if room == main || self.breakout_hosts(Some(&planner), &main, who) {
            return Ok(());
        }
        let plan = self.breakout_plan(&main);
        plan.tick(pj::now());
        if !plan.open {
            return forbidden(NOT_OPEN);
        }
        if !plan.rooms.iter().any(|r| r.id == room && r.members.contains(&who.principal)) {
            return forbidden("you are not assigned to that breakout room");
        }
        Ok(())
    }

    /// _breakout_join_extra: someone joined a room of a plan: it is not empty any more. The planner coming back to the
    /// main room while the rooms are open or closing hosts it again (whoever held the role while they visited a room
    /// hands it back; the room hears a stage event).
    pub(super) fn breakout_join_extra(&mut self, room: &str, peer_id: &str) -> Obj {
        let Some(main) = self.breakout_plan_of(room) else { return Obj::new() };
        let plan = self.breakout_plan(&main);
        plan.empty_since = None;
        plan.tick(pj::now());
        let (planner, live) = (plan.by.clone(), plan.live());
        let Some(p) = self.peers.get(peer_id) else { return Obj::new() };
        if room != main || p.admission_pending || p.who.principal != planner || !live {
            return Obj::new();
        }
        if self.stage_host(room).as_deref() == Some(peer_id) {
            return Obj::new();
        }
        let principal = p.who.principal.clone();
        self.stage_mut(room).insert("host".into(), Value::from(peer_id));
        self.stage_event(room, "join", &principal, Some(peer_id));
        obj([("stage", self.stage_view_ext(room))])
    }

    /// _breakout_room_empty: the last one left a room of a plan. With every room of the plan empty: a planned (not
    /// open) plan goes now; an open or closing one waits IDLE_S (people are moving between rooms) and goes at the next
    /// prune.
    pub(super) fn breakout_room_empty(&mut self, room: &str) {
        let Some(main) = self.breakout_plan_of(room) else { return };
        let rooms = self.breakouts[&main].rooms_of();
        if self.peers.values().any(|p| rooms.contains(&p.room)) {
            return;
        }
        let now = pj::now();
        let plan = self.breakout_plan(&main);
        plan.tick(now);
        if plan.live() {
            plan.empty_since = Some(now);
        } else {
            self.breakouts.shift_remove(&main);
        }
    }

    /// _breakout_prune: plans whose rooms stayed empty IDLE_S go.
    pub(super) fn breakout_prune(&mut self, now: f64) {
        let mains: Vec<String> = self.breakouts.keys().cloned().collect();
        for main in mains {
            let plan = &self.breakouts[&main];
            if plan.empty_since.map(|since| now - since < IDLE_S).unwrap_or(true) {
                continue;
            }
            let rooms = plan.rooms_of();
            if !self.peers.values().any(|p| rooms.contains(&p.room)) {
                self.breakouts.shift_remove(&main);
                log_info(&format!("breakout room={main} dropped why=empty"));
            }
        }
    }

    /// _breakout_new: a new plan for `main` (`old`: the plan it replaces, never while open or closing).
    fn breakout_new(&mut self, main: &str, who: &Identity, rooms: Vec<(String, Vec<String>)>, can_return: bool, old: Option<&str>) -> R<()> {
        if old.map(|o| self.breakouts[o].live()).unwrap_or(false) {
            return Err(E::Conflict("the breakout rooms are open; close them first".into()));
        }
        let mine = old.map(|o| self.breakouts[o].rooms_of()).unwrap_or_default();
        let base: String = main.chars().take(BASE_MAX).collect();
        let mut plan_rooms = Vec::with_capacity(rooms.len());
        for (n, (name, members)) in rooms.into_iter().enumerate() {
            let rid = format!("{base}-b{}", n + 1);
            let other = self.breakout_plan_of(&rid);
            if (other.is_some() && other.as_deref() != old) || (!mine.contains(&rid) && self.peers.values().any(|p| p.room == rid)) {
                return Err(E::Conflict(format!("a room named {rid} is in use, so this call cannot have breakout rooms")));
            }
            plan_rooms.push(Room { id: rid, name, members });
        }
        let plan = Plan { main: main.to_string(), by: who.principal.clone(), rooms: plan_rooms, open: false, ends_at: None, return_at: None, can_return, message: None, empty_since: None };
        self.breakouts.insert(main.to_string(), plan);
        Ok(())
    }
}

/// What a `breakout_*` action carries, checked before the lock.
enum Ask {
    Plan(Vec<(String, Vec<String>)>, bool),
    Open(Option<i64>),
    Close,
    Message(String),
    Move(String, String),
}

impl Hub {
    /// _breakout_stage: `POST /v1/stage` with `action`: `breakout_plan {rooms: [{name, members: [principal]}],
    /// can_return?}` (2 to 20 rooms; not while open or closing), `breakout_open {minutes?}` (again while open: a new
    /// timer), `breakout_close` (everyone back RETURN_S later), `breakout_message {text}` (open or closing),
    /// `breakout_move {target: principal, room: breakout room id, or "" / the main room to unassign}`. Host only (see
    /// `breakout_hosts`), from the main room or any of its breakout rooms. Answers `{ok, stage}` with the caller's
    /// room's stage.
    pub(super) fn breakout_stage(&self, peer_id: &str, who: &Identity, action: &str, body: &Obj) -> R<Obj> {
        let ask = match action {
            "breakout_plan" => {
                let rooms = parse_rooms(body)?;
                let can_return = match body.get("can_return") {
                    None => true,
                    Some(Value::Bool(b)) => *b,
                    Some(_) => return bad("can_return must be true or false"),
                };
                Ask::Plan(rooms, can_return)
            }
            "breakout_open" => Ask::Open(match body.get("minutes") {
                None | Some(Value::Null) => None,
                v => match pj::as_int(v) {
                    Some(n) if (1..=MINUTES_MAX).contains(&n) => Some(n),
                    _ => return bad(format!("minutes must be a whole number from 1 to {MINUTES_MAX}")),
                },
            }),
            "breakout_close" => Ask::Close,
            "breakout_message" => {
                let text = pj::squash(&m::text(body.get("text"), "messages")?);
                if pj::char_len(&text) > MESSAGE_MAX {
                    return bad(format!("a message to the breakout rooms is at most {MESSAGE_MAX} characters"));
                }
                Ask::Message(text)
            }
            "breakout_move" => {
                let target = match body.get("target") {
                    Some(v @ Value::String(_)) => m::principal(Some(v)),
                    _ => String::new(),
                };
                if target.is_empty() {
                    return bad("say whom to move (target)");
                }
                Ask::Move(target, pj::str_or(body.get("room")).trim().to_lowercase())
            }
            _ => return bad(format!("action must be one of {}", ACTIONS.join(", "))),
        };
        let target = if let Ask::Move(t, _) = &ask { t.clone() } else { String::new() };
        let mut st = self.st.lock();
        let r = (|| -> R<(Obj, String)> {
            st.owned(peer_id, who)?;
            if st.peers[peer_id].admission_pending {
                return forbidden(ADMISSION_FIRST);
            }
            let room = st.peers[peer_id].room.clone();
            let found = st.breakout_plan_of(&room);
            let main = found.clone().unwrap_or_else(|| room.clone());
            let planner = found.as_ref().map(|k| st.breakouts[k].by.clone());
            if !st.breakout_hosts(planner.as_deref(), &main, who) {
                return forbidden(NOT_HOST);
            }
            let now = pj::now();
            if let Some(k) = &found {
                st.breakout_plan(k).tick(now);
            }
            let mut changed = true;
            match ask {
                Ask::Plan(rooms, can_return) => st.breakout_new(&main, who, rooms, can_return, found.as_deref())?,
                _ if found.is_none() => return bad("plan the breakout rooms first"),
                Ask::Open(minutes) => {
                    let plan = st.breakout_plan(&main);
                    plan.open = true;
                    plan.return_at = None;
                    plan.ends_at = minutes.map(|n| now + n as f64 * 60.0);
                }
                Ask::Close => {
                    let plan = st.breakout_plan(&main);
                    if plan.open {
                        plan.open = false;
                        plan.ends_at = None;
                        plan.return_at = Some(now + RETURN_S);
                    } else if plan.return_at.is_some() {
                        changed = false; // closing already
                    } else {
                        return bad(NOT_OPEN);
                    }
                }
                Ask::Message(text) => {
                    let plan = st.breakout_plan(&main);
                    if !plan.live() {
                        return bad(NOT_OPEN);
                    }
                    plan.message = Some(obj([("text", Value::from(text)), ("ts", f(now)), ("by", Value::from(who.principal.clone())), ("name", Value::from(who.name.clone()))]));
                }
                Ask::Move(target, to) => {
                    let plan = st.breakout_plan(&main);
                    let ids: Vec<String> = plan.rooms.iter().map(|r| r.id.clone()).collect();
                    if !to.is_empty() && to != main && !ids.contains(&to) {
                        return Err(E::NotFound("that breakout room does not exist".into()));
                    }
                    let before = plan.rooms.iter().find(|r| r.members.contains(&target)).map(|r| r.id.clone()).unwrap_or_default();
                    let after = if ids.contains(&to) { to } else { String::new() };
                    changed = before != after;
                    if changed {
                        let assigned: usize = plan.rooms.iter().map(|r| r.members.len()).sum();
                        if before.is_empty() && assigned >= PEOPLE_MAX {
                            return bad(format!("at most {PEOPLE_MAX} people in breakout rooms"));
                        }
                        for r in plan.rooms.iter_mut() {
                            if r.id == before {
                                r.members.retain(|p| *p != target);
                            }
                            if r.id == after {
                                r.members.push(target.clone());
                            }
                        }
                    }
                }
            }
            if changed {
                st.breakout_tell(&main, action, &who.principal);
            }
            Ok((obj([("ok", Value::Bool(true)), ("stage", st.stage_view_ext(&room))]), main))
        })();
        drop(st);
        self.wake();
        let (out, main) = r?;
        log_info(&format!("breakout room={main} principal={} action={action} target={}", who.principal, kv(&target)));
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn who(p: &str, device: &str) -> Identity {
        Identity { principal: p.into(), name: p.to_uppercase(), device: device.into(), ..Default::default() }
    }

    fn hub() -> Hub {
        Hub::new(None, &["admin@x".to_string()], 168.0, 30.0, 365.0, None, Arc::new(LinkStats::new()))
    }

    fn act(h: &Hub, peer: &str, who: &Identity, action: &str, body: Value) -> R<Obj> {
        h.stage_ext(peer, who, action, body.as_object().unwrap())
    }

    fn status(r: R<Obj>) -> String {
        match r {
            Ok(_) => "ok".into(),
            Err(E::Forbidden(m)) => format!("403 {m}"),
            Err(E::Bad(m)) => format!("400 {m}"),
            Err(E::Conflict(m)) => format!("409 {m}"),
            Err(E::NotFound(m)) => format!("404 {m}"),
            Err(e) => format!("other {}", e.message()),
        }
    }

    /// ben hosts "class" with cy; the plan puts cy in Room 1.
    fn planned() -> (Hub, Identity, Identity, String) {
        let h = hub();
        let (ben, cy) = (who("ben@x", "bbbbbbbbbbbbbbbb"), who("cy@x", "cccccccccccccccc"));
        let b = h.join("class", &ben, "", false, None).unwrap()["peer"].as_str().unwrap().to_string();
        h.join("class", &cy, "", false, None).unwrap();
        let rooms = json!({"rooms": [{"name": "Room 1", "members": ["cy@x"]}, {"name": " Design \n team ", "members": []}]});
        let out = act(&h, &b, &ben, "breakout_plan", rooms).unwrap();
        assert_eq!(out["stage"]["breakout"]["rooms"][1], json!({"id": "class-b2", "name": "Design team", "members": []}));
        (h, ben, cy, b)
    }

    #[test]
    fn a_breakout_room_takes_its_people_once_open() {
        let (h, ben, cy, b) = planned();
        assert_eq!(status(h.join("class-b1", &cy, "", false, None)), "403 the breakout rooms are not open");
        let opened = act(&h, &b, &ben, "breakout_open", json!({"minutes": 15})).unwrap();
        assert_eq!(opened["stage"]["breakout"]["open"], json!(true));
        let p4 = who("p4@x", "dddddddddddddddd");
        assert_eq!(status(h.join("class-b1", &p4, "", false, None)), "403 you are not assigned to that breakout room");
        let joined = h.join("class-b1", &cy, "", false, None).unwrap();
        assert_eq!(joined["stage"]["breakout"]["main"], json!("class"));
        // the planner visits any room
        assert!(h.join("class-b2", &ben, "", false, None).is_ok());
    }

    #[test]
    fn a_timer_that_ran_out_closes_the_rooms_and_the_return_ends() {
        let mut plan = Plan { main: "m".into(), by: "a@x".into(), rooms: Vec::new(), open: true, ends_at: Some(100.0), return_at: None, can_return: true, message: None, empty_since: None };
        plan.tick(99.0);
        assert!(plan.open);
        plan.tick(100.0);
        assert_eq!((plan.open, plan.return_at), (false, Some(100.0 + RETURN_S)));
        assert!(plan.live());
        plan.tick(100.0 + RETURN_S);
        assert!(!plan.live());
    }

    #[test]
    fn breakout_checks_and_host_only() {
        let (h, ben, cy, b) = planned();
        let c = h.st.lock().peers.values().find(|p| p.who.principal == "cy@x").unwrap().peer_id.clone();
        assert_eq!(status(act(&h, &c, &cy, "breakout_open", json!({}))), "403 only the host can do that");
        assert_eq!(status(act(&h, &b, &ben, "breakout_open", json!({"minutes": 0}))), "400 minutes must be a whole number from 1 to 1440");
        assert_eq!(status(act(&h, &b, &ben, "breakout_close", json!({}))), "400 the breakout rooms are not open");
        assert_eq!(status(act(&h, &b, &ben, "breakout_dance", json!({}))), "400 action must be one of breakout_plan, breakout_open, breakout_close, breakout_message, breakout_move");
        act(&h, &b, &ben, "breakout_open", json!({})).unwrap();
        assert_eq!(status(act(&h, &b, &ben, "breakout_move", json!({"target": "p4@x", "room": "class-b9"}))), "404 that breakout room does not exist");
        let moved = act(&h, &b, &ben, "breakout_move", json!({"target": "cy@x", "room": "class-b2"})).unwrap();
        assert_eq!(moved["stage"]["breakout"]["rooms"][1]["members"], json!(["cy@x"]));
        assert_eq!(status(act(&h, &b, &ben, "breakout_plan", json!({"rooms": [{"name": "A"}, {"name": "B"}]}))), "409 the breakout rooms are open; close them first");
        let closed = act(&h, &b, &ben, "breakout_close", json!({})).unwrap();
        assert!(closed["stage"]["breakout"]["return_at"].is_number());
    }
}
