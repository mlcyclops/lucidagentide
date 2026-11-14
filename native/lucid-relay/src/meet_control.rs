// Phase C (ADR-0540), wave 3: remote control of the presenter's screen (meet_relay._Wave3Control). The relay only
// keeps WHO may control: the stage gains `control: {presenter, controller, requests}` (peer ids) while a control
// session exists in the room. Input itself never passes here: it travels peer to peer on the call's data channel, and
// the presenter's own page and Hub decide whether to inject it. A control session belongs to one presentation
// (presenter peer and its `since`): when that presenter stops, is replaced or leaves, the session is gone. Live
// control state only, never saved. A child module of meet_hub: it shares the one lock.

use super::*;

const ACTIONS: [&str; 5] = ["control_request", "control_cancel", "control_give", "control_take_back", "control_deny"];
const NOBODY: &str = "nobody is presenting a screen to control";
const NOT_PRESENTER: &str = "only the presenter can do that";
const TAKE_BACK: &str = "only the presenter or the host can take back control";
const NOT_ASKED: &str = "that person has not asked for control";
const GUEST: &str = "guests cannot control a screen";
/// One request per peer per presentation this often, and none this long after the presenter said Deny.
const ASK_EVERY: f64 = 10.0;
const DENIED_WAIT: f64 = 60.0;
const ASKED: &str = "you asked for control a moment ago; ask again in a few seconds";
const DENIED: &str = "the presenter declined your request; you can ask again in a minute";

/// One room's control session, kept for the whole presentation so the request throttle holds even while nobody asks
/// or controls (the stage shows `control` only then).
pub(super) struct Session {
    presenter: String,
    since: Value,
    controller: Option<String>,
    requests: Vec<String>,
    /// peer -> monotonic time of its last request, and of the presenter's Deny.
    asked: HashMap<String, f64>,
    denied: HashMap<String, f64>,
}

fn presenter_of(stage: Option<&Obj>) -> Option<&Obj> {
    stage.and_then(|s| s.get("presenter")).and_then(Value::as_object)
}

impl State {
    fn control_open(&mut self, room: &str, presenter: &Obj) -> &mut Session {
        let session = Session { presenter: pj::text_of(presenter, "peer"), since: presenter.get("since").cloned().unwrap_or(Value::Null), controller: None, requests: Vec::new(), asked: HashMap::new(), denied: HashMap::new() };
        self.control.insert(room.to_string(), session);
        self.control.get_mut(room).expect("the control session")
    }

    /// _control_live: true while the room's control session's presentation lasts; a session whose presentation ended
    /// (stop, take-over, leave) is dropped here.
    fn control_live(&mut self, room: &str) -> bool {
        let Some(session) = self.control.get(room) else { return false };
        let alive = presenter_of(self.stages.get(room)).map(|p| p.get("peer").and_then(Value::as_str) == Some(session.presenter.as_str()) && p.get("since").unwrap_or(&Value::Null) == &session.since).unwrap_or(false);
        if !alive {
            self.control.remove(room);
        }
        alive
    }

    /// _control_stage_view: `stage.control` while someone controls or asks.
    pub(super) fn control_stage_view(&mut self, room: &str, view: &mut Obj) {
        if !self.control_live(room) {
            return;
        }
        let s = &self.control[room];
        if s.controller.is_some() || !s.requests.is_empty() {
            let control = obj([
                ("presenter", Value::from(s.presenter.clone())),
                ("controller", s.controller.clone().map(Value::from).unwrap_or(Value::Null)),
                ("requests", Value::Array(s.requests.iter().cloned().map(Value::from).collect())),
            ]);
            view.insert("control".into(), Value::Object(control));
        }
    }

    /// _control_left: a controller or requester left: drop them and tell the room. A leaving presenter ends the
    /// session (its stage event already went out).
    pub(super) fn control_left(&mut self, peer: &Peer, why: &str) {
        let Some(s) = self.control.get_mut(&peer.room) else { return };
        if s.presenter == peer.peer_id {
            self.control.remove(&peer.room);
            return;
        }
        let mut changed = false;
        if s.controller.as_deref() == Some(peer.peer_id.as_str()) {
            s.controller = None;
            changed = true;
        }
        if s.requests.contains(&peer.peer_id) {
            s.requests.retain(|r| *r != peer.peer_id);
            changed = true;
        }
        if changed {
            self.stage_event(&peer.room, if why == "removed" { "remove" } else { "leave" }, &peer.who.principal, None);
        }
    }

    pub(super) fn control_room_empty(&mut self, room: &str) {
        self.control.remove(room);
    }

    pub(super) fn control_prune(&mut self) {
        let rooms: Vec<String> = self.control.keys().cloned().collect();
        for room in rooms {
            self.control_live(&room);
        }
    }
}

impl Hub {
    /// _control_stage: `/v1/stage` actions `control_request`, `control_cancel` (a request, or the controller giving
    /// control back), `control_give {target}` and `control_deny {target}` (presenter), `control_take_back` (presenter
    /// or host). Every change is one `stage` event to the room, as for the other stage actions.
    pub(super) fn control_stage(&self, peer_id: &str, who: &Identity, action: &str, body: &Obj) -> R<Obj> {
        if !ACTIONS.contains(&action) {
            return bad(format!("action must be one of {}", STAGE_ACTIONS.iter().chain(ACTIONS.iter()).copied().collect::<Vec<_>>().join(", ")));
        }
        let target = body.get("target");
        let mut st = self.st.lock();
        let r = (|| -> R<(Obj, String, String)> {
            st.owned(peer_id, who)?;
            if st.peers[peer_id].admission_pending {
                return forbidden(ADMISSION_FIRST);
            }
            let room = st.peers[peer_id].room.clone();
            let me = peer_id.to_string();
            let now = pj::now();
            if expire_grant(st.stage_mut(&room), now) {
                st.stage_event(&room, "expire", "", None);
            }
            let host = st.stage_host(&room).as_deref() == Some(me.as_str()) || st.admins.contains(&who.principal);
            let mut other: Option<String> = None;
            if let Some(t) = target.filter(|t| !t.is_null() && t.as_str() != Some("")) {
                let id = pj::py_str(t);
                match st.peers.get(&id) {
                    Some(o) if o.room == room && !o.admission_pending => other = Some(id),
                    _ => return Err(E::NotFound("that person is not in this call".into())),
                }
            }
            let other_principal = other.as_ref().map(|o| st.peers[o.as_str()].who.principal.clone()).unwrap_or_default();
            let presenter = presenter_of(st.stages.get(&room)).cloned();
            let presenting = presenter.as_ref().map(|p| p.get("peer").and_then(Value::as_str) == Some(me.as_str())).unwrap_or(false);
            let live = st.control_live(&room);
            let mut changed = true;
            match action {
                "control_request" => {
                    let Some(presenter) = presenter else { return Err(E::Conflict(NOBODY.into())) };
                    if presenting {
                        return bad("you are the presenter");
                    }
                    if who.principal.ends_with(m::GUEST_DOMAIN) {
                        return forbidden(GUEST);
                    }
                    let has = live && st.control.get(&room).map(|s| s.controller.as_deref() == Some(me.as_str()) || s.requests.contains(&me)).unwrap_or(false);
                    if has {
                        changed = false;
                    } else {
                        let s = if live { st.control.get_mut(&room).expect("the control session") } else { st.control_open(&room, &presenter) };
                        let mono = pj::mono();
                        if s.denied.get(&me).map(|t| mono - t < DENIED_WAIT).unwrap_or(false) {
                            return Err(E::Conflict(DENIED.into()));
                        }
                        if s.asked.get(&me).map(|t| mono - t < ASK_EVERY).unwrap_or(false) {
                            return Err(E::Conflict(ASKED.into()));
                        }
                        s.asked.insert(me.clone(), mono);
                        s.requests.push(me.clone());
                    }
                }
                "control_cancel" => {
                    changed = false;
                    if let Some(s) = st.control.get_mut(&room).filter(|_| live) {
                        if s.requests.contains(&me) {
                            s.requests.retain(|r| *r != me);
                            changed = true;
                        }
                        if s.controller.as_deref() == Some(me.as_str()) {
                            s.controller = None;
                            changed = true;
                        }
                    }
                }
                "control_give" | "control_deny" => {
                    let Some(other) = other.clone() else {
                        return bad(if action == "control_give" { "say whom to give control to (target)" } else { "say whom to deny (target)" });
                    };
                    if !presenting {
                        return forbidden(NOT_PRESENTER);
                    }
                    if other == me {
                        return bad("choose someone else");
                    }
                    if action == "control_give" {
                        if st.peers[other.as_str()].who.principal.ends_with(m::GUEST_DOMAIN) {
                            return forbidden(GUEST);
                        }
                        let presenter = presenter.expect("presenting");
                        let s = if live { st.control.get_mut(&room).expect("the control session") } else { st.control_open(&room, &presenter) };
                        changed = s.controller.as_deref() != Some(other.as_str());
                        s.controller = Some(other.clone());
                        s.requests.retain(|r| *r != other);
                    } else {
                        let Some(s) = st.control.get_mut(&room).filter(|s| live && s.requests.contains(&other)) else {
                            return Err(E::NotFound(NOT_ASKED.into()));
                        };
                        s.requests.retain(|r| *r != other);
                        s.denied.insert(other.clone(), pj::mono());
                    }
                }
                _ => {
                    // control_take_back
                    if !(presenting || host) {
                        return forbidden(TAKE_BACK);
                    }
                    match st.control.get_mut(&room).filter(|s| live && s.controller.is_some()) {
                        Some(s) => s.controller = None,
                        None => changed = false,
                    }
                }
            }
            if changed {
                st.stage_event(&room, action, &who.principal, None);
            }
            Ok((obj([("ok", Value::Bool(true)), ("stage", st.stage_view_ext(&room))]), room, other_principal))
        })();
        drop(st);
        self.wake();
        let (out, room, target) = r?;
        log_info(&format!("stage room={room} principal={} action={action} target={}", who.principal, kv(&target)));
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

    fn act(h: &Hub, peer: &str, who: &Identity, action: &str, target: Option<&str>) -> R<Obj> {
        let body = match target {
            Some(t) => json!({"target": t}),
            None => json!({}),
        };
        h.stage_ext(peer, who, action, body.as_object().unwrap())
    }

    #[test]
    fn control_follows_the_presentation() {
        let h = Hub::new(None, &[], 168.0, 30.0, 365.0, None, Arc::new(LinkStats::new()));
        let (ben, cy) = (who("ben@x", "bbbbbbbbbbbbbbbb"), who("cy@x", "cccccccccccccccc"));
        let b = h.join("rc", &ben, "", false, None).unwrap()["peer"].as_str().unwrap().to_string();
        let c = h.join("rc", &cy, "", false, None).unwrap()["peer"].as_str().unwrap().to_string();
        assert!(matches!(act(&h, &c, &cy, "control_request", None), Err(E::Conflict(m)) if m == NOBODY));
        h.stage(&b, &ben, Some(&json!("present")), None, None, None).unwrap();
        let asked = act(&h, &c, &cy, "control_request", None).unwrap();
        assert_eq!(asked["stage"]["control"], json!({"presenter": b.clone(), "controller": null, "requests": [c.clone()]}));
        let given = act(&h, &b, &ben, "control_give", Some(c.as_str())).unwrap();
        assert_eq!(given["stage"]["control"]["controller"], json!(c.clone()));
        let stopped = h.stage(&b, &ben, Some(&json!("stop")), None, None, None).unwrap();
        assert!(stopped["stage"].get("control").is_none());
        h.stage(&b, &ben, Some(&json!("present")), None, None, None).unwrap();
        assert!(matches!(act(&h, &b, &ben, "control_deny", Some(c.as_str())), Err(E::NotFound(m)) if m == NOT_ASKED));
        assert!(matches!(act(&h, &c, &cy, "control_dance", None), Err(E::Bad(m)) if m.ends_with("control_take_back, control_deny")));
    }
}
