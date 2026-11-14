// Phase C (ADR-0540), wave 3: meeting tools (meet_relay._Wave3MeetingTools): polls in calls, direct messages and
// channels, and the call whiteboard.
//
// A poll is a conversation message with `poll`: the message keeps only what everyone may see (option counts, and the
// voters of a named poll). Who voted for what lives only in ext["tools"]["polls"] ({poll id: {scope, where, by, votes:
// {principal: [option ids]}}}, the poll id is the message id), so no history read, event or copy ever names the voters
// of an anonymous poll. A reader's own choices (`mine`) come with every poll answer and from `GET /v1/polls/mine`.
//
// The whiteboard of a call room lives in memory and goes when the room empties. A child module of meet_hub: it shares
// the one lock.

use super::*;

/// Characters of a poll question, and of one option.
const QUESTION_MAX: usize = 300;
const OPTION_MAX: usize = 100;
const OPTIONS_MIN: usize = 2;
const OPTIONS_MAX: usize = 10;
/// Polls one `/v1/polls/mine` request asks about.
const MINE_MAX: usize = 200;
/// Strokes on one call's whiteboard, and their JSON size together.
const BOARD_STROKES: usize = 5000;
const BOARD_BYTES: usize = 2 * 1024 * 1024;
/// Points of one stroke, characters of a text stroke, strokes one erase names.
const BOARD_POINTS: usize = 2000;
const BOARD_TEXT: usize = 500;
const BOARD_IDS: usize = 500;
const BOARD_TOOLS: [&str; 4] = ["pen", "highlighter", "text", "shape"];
const BOARD_SHAPES: [&str; 3] = ["rect", "ellipse", "arrow"];
const BOARD_OPS: [&str; 5] = ["stroke", "erase", "clear", "undo", "lock"];
const LOCKED: &str = "the whiteboard is locked; only the host and the presenter can draw";
const NO_POLL: &str = "that message has no poll";

/// One call room's whiteboard: its strokes in drawing order, each one's JSON size, their total, and the lock.
#[derive(Default)]
pub(super) struct Board {
    strokes: Vec<Obj>,
    sizes: HashMap<String, usize>,
    bytes: usize,
    locked: bool,
}

/// _tools_question: white space collapsed, 1 to QUESTION_MAX characters.
fn question_text(v: Body) -> R<String> {
    let text = match v {
        Some(Value::String(s)) => pj::squash(s),
        _ => String::new(),
    };
    if text.is_empty() || pj::char_len(&text) > QUESTION_MAX {
        return bad(format!("a poll question is 1 to {QUESTION_MAX} characters"));
    }
    Ok(text)
}

/// _tools_options: 2 to 10 options, each 1 to OPTION_MAX characters, no two the same (ignoring case).
fn option_texts(v: Body) -> R<Vec<String>> {
    let list = match v {
        Some(Value::Array(a)) if (OPTIONS_MIN..=OPTIONS_MAX).contains(&a.len()) => a,
        _ => return bad(format!("a poll has {OPTIONS_MIN} to {OPTIONS_MAX} options")),
    };
    let mut out: Vec<String> = Vec::with_capacity(list.len());
    for item in list {
        let text = item.as_str().map(pj::squash).unwrap_or_default();
        if text.is_empty() || pj::char_len(&text) > OPTION_MAX {
            return bad(format!("each poll option is 1 to {OPTION_MAX} characters"));
        }
        if out.iter().any(|o| o.to_lowercase() == text.to_lowercase()) {
            return bad("poll options must differ");
        }
        out.push(text);
    }
    Ok(out)
}

/// _tools_choices: a list of option ids, each once.
fn choices(v: Body) -> R<Vec<String>> {
    let Some(Value::Array(list)) = v else { return bad("choices must be a list of option ids") };
    let mut out: Vec<String> = Vec::with_capacity(list.len());
    for c in list {
        let Some(c) = c.as_str() else { return bad("choices must be a list of option ids") };
        if !out.iter().any(|o| o == c) {
            out.push(c.to_string());
        }
    }
    Ok(out)
}

/// _tools_copy_poll: a public poll (never with anyone's `mine`).
fn copy_poll(poll: &Obj) -> Obj {
    let mut out = poll.clone();
    out.shift_remove("mine");
    out
}

fn option_ids(poll: &Obj) -> Vec<String> {
    poll.get("options").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_object).map(|o| pj::str_or(o.get("id"))).collect()
}

/// _tools_counted: a NEW public poll from its votes: counts per option, and for a named poll the voters per option.
/// `closed` replaces the poll's close time.
fn counted(poll: &Obj, votes: &Obj, closed: Option<Value>) -> Obj {
    let options: Vec<&Obj> = poll.get("options").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_object).collect();
    let mut voters: Obj = options.iter().map(|o| (pj::str_or(o.get("id")), Value::Array(Vec::new()))).collect();
    for (principal, picked) in votes {
        for c in picked.as_array().into_iter().flatten().filter_map(Value::as_str) {
            if let Some(Value::Array(list)) = voters.get_mut(c) {
                list.push(Value::from(principal.clone()));
            }
        }
    }
    let counts: Vec<Value> = options
        .iter()
        .map(|o| {
            let id = pj::str_or(o.get("id"));
            let n = voters.get(&id).and_then(Value::as_array).map(Vec::len).unwrap_or(0);
            Value::Object(obj([("id", Value::from(id)), ("text", o.get("text").cloned().unwrap_or(Value::Null)), ("votes", Value::from(n))]))
        })
        .collect();
    let anonymous = pj::truthy(poll.get("anonymous"));
    let field = |k: &str| poll.get(k).cloned().unwrap_or(Value::Null);
    let mut out = obj([
        ("id", field("id")),
        ("question", field("question")),
        ("options", Value::Array(counts)),
        ("multiple", Value::Bool(pj::truthy(poll.get("multiple")))),
        ("anonymous", Value::Bool(anonymous)),
        ("closed", field("closed")),
        ("by", field("by")),
    ]);
    if let Some(c) = closed {
        out.insert("closed".into(), c);
    }
    if !anonymous {
        out.insert("voters".into(), Value::Object(voters));
    }
    out
}

/// round(x, 4), as Python rounds (correctly rounded decimal digits).
fn round4(x: f64) -> f64 {
    format!("{x:.4}").parse().unwrap_or(x)
}

/// _tools_unit: a board coordinate (0..1, four decimals), None when it is not one.
fn unit(v: &Value) -> Option<f64> {
    pj::as_num(Some(v)).filter(|x| (0.0..=1.0).contains(x)).map(round4)
}

/// TOOLS_COLOR: `#rrggbb` (re.match: `$` also matches before one final newline).
fn color_ok(s: &str) -> bool {
    let body = s.strip_suffix('\n').unwrap_or(s);
    body.len() == 7 && body.starts_with('#') && body[1..].bytes().all(|c| c.is_ascii_hexdigit())
}

fn stroke_id_ok(s: &str) -> bool {
    meetings::re_like(s, 40, |c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// _tools_stroke: a whiteboard stroke, checked and normalized: `{id, tool, color, width, points, text?, shape?}` with
/// points as `[x, y]` from 0 to 1 (the board's width and height) and the width in thousandths of the board's width.
fn stroke_of(v: Body) -> R<Obj> {
    let Some(Value::Object(raw)) = v else { return bad("a stroke must be an object") };
    let sid = match raw.get("id") {
        Some(Value::String(s)) if stroke_id_ok(s) => s.clone(),
        _ => return bad("a stroke id is 1 to 40 letters, digits, - or _"),
    };
    let tool = match raw.get("tool") {
        Some(Value::String(t)) if BOARD_TOOLS.contains(&t.as_str()) => t.clone(),
        _ => return bad("tool must be pen, highlighter, text or shape"),
    };
    let color = match raw.get("color") {
        Some(Value::String(c)) if color_ok(c) => c.to_lowercase(),
        _ => return bad("color must be #rrggbb"),
    };
    let width = match pj::as_num(raw.get("width")) {
        Some(w) if (0.5..=100.0).contains(&w) => w,
        _ => return bad("width must be a number from 0.5 to 100"),
    };
    let points_error = || bad(format!("points must be 1 to {BOARD_POINTS} [x, y] pairs from 0 to 1"));
    let points = match raw.get("points") {
        Some(Value::Array(p)) if (1..=BOARD_POINTS).contains(&p.len()) => p,
        _ => return points_error(),
    };
    let mut clean: Vec<Value> = Vec::with_capacity(points.len());
    for pt in points {
        let Some([x, y]) = pt.as_array().map(Vec::as_slice).and_then(|p| <&[Value; 2]>::try_from(p).ok()) else { return points_error() };
        let (Some(x), Some(y)) = (unit(x), unit(y)) else { return points_error() };
        clean.push(Value::Array(vec![f(x), f(y)]));
    }
    let shape_points = clean.len();
    let mut out = obj([("id", Value::from(sid)), ("tool", Value::from(tool.clone())), ("color", Value::from(color)), ("width", f(width)), ("points", Value::Array(clean))]);
    if tool == "text" {
        let text = raw.get("text").and_then(Value::as_str).map(str::trim).unwrap_or_default();
        if text.is_empty() || pj::char_len(text) > BOARD_TEXT {
            return bad(format!("a text stroke needs text (1 to {BOARD_TEXT} characters)"));
        }
        out.insert("text".into(), Value::from(text));
    }
    if tool == "shape" {
        let shape = match raw.get("shape") {
            Some(Value::String(s)) if BOARD_SHAPES.contains(&s.as_str()) => s.clone(),
            _ => return bad("shape must be rect, ellipse or arrow"),
        };
        if shape_points < 2 {
            return bad("a shape needs two points (start and end)");
        }
        out.insert("shape".into(), Value::from(shape));
    }
    Ok(out)
}

/// _tools_ids: 1 to BOARD_IDS stroke ids, each once.
fn stroke_ids(v: Body) -> R<Vec<String>> {
    let list = match v {
        Some(Value::Array(a)) if (1..=BOARD_IDS).contains(&a.len()) && a.iter().all(|i| i.as_str().map(stroke_id_ok).unwrap_or(false)) => a,
        _ => return bad("ids must be a list of stroke ids"),
    };
    let mut out: Vec<String> = Vec::with_capacity(list.len());
    for i in list.iter().filter_map(Value::as_str) {
        if !out.iter().any(|o| o == i) {
            out.push(i.to_string());
        }
    }
    Ok(out)
}

fn py_bool(b: bool) -> &'static str {
    if b {
        "True"
    } else {
        "False"
    }
}

impl State {
    /// _tools_room_empty: a call's whiteboard goes with the call.
    pub(super) fn tools_room_empty(&mut self, room: &str) {
        self.boards.remove(room);
    }

    /// _tools_prune: forget the votes of polls whose message is gone (retention) or deleted; a deleted poll message
    /// loses its poll too.
    pub(super) fn tools_prune(&mut self) {
        if !self.ext.contains_key("tools") {
            return;
        }
        let records: Vec<(String, String, String)> = self.tools_polls().iter().map(|(pid, rec)| (pid.clone(), pj::text_of(rec.as_object().expect("a poll record"), "scope"), pj::str_or(rec.get("where")))).collect();
        for (pid, scope, place) in records {
            let gone = match self.tools_find(&pid, &scope, &place) {
                None => true,
                Some(target) if pj::truthy(target.get("deleted")) => {
                    target.shift_remove("poll");
                    true
                }
                Some(_) => false,
            };
            if gone {
                self.tools_polls().shift_remove(&pid);
                self.dirty = true;
            }
        }
    }

    /// _tools_polls: ext["tools"]["polls"], made sound on use (a hand-edited or older state.json loses only entries
    /// that are not polls).
    fn tools_polls(&mut self) -> &mut Obj {
        let polls = obj_mut(obj_mut(&mut self.ext, "tools"), "polls");
        polls.retain(|_, rec| rec.as_object().map(|r| r.get("votes").map(Value::is_object).unwrap_or(false)).unwrap_or(false));
        polls
    }

    /// _tools_find: the message a poll record belongs to (None when it is no longer kept).
    fn tools_find(&mut self, pid: &str, scope: &str, place: &str) -> Option<&mut Obj> {
        let (list, room) = match scope {
            "room" => (self.rooms.get_mut(place)?, true),
            "channel" => (self.channel_msgs.get_mut(place)?, false),
            "dm" => (self.dms.get_mut(place)?, false),
            _ => return None,
        };
        list.iter_mut().find(|m| (!room || pj::text_of(m, "kind") == "chat") && m.get("id").and_then(Value::as_str) == Some(pid))
    }

    /// _tools_answer: the message as its reader gets it: the poll with `mine`.
    fn tools_answer(&mut self, msg: &Obj, principal: &str) -> Obj {
        let mut out = msg.clone();
        if let Some(Value::Object(poll)) = msg.get("poll") {
            let mine = self.tools_polls().get(&pj::s(msg, "id")).and_then(|r| r.get("votes")).and_then(|v| v.get(principal)).filter(|v| pj::truthy(Some(*v))).cloned().unwrap_or(Value::Array(Vec::new()));
            out.insert("poll".into(), Value::Object(with(&copy_poll(poll), obj([("mine", mine)]))));
        }
        out
    }

    /// _tools_seat: the caller's own seat, admitted.
    fn tools_seat(&self, peer_id: &str, who: &Identity) -> R<String> {
        self.owned(peer_id, who)?;
        if self.peers[peer_id].admission_pending {
            return forbidden(ADMISSION_FIRST);
        }
        Ok(self.peers[peer_id].room.clone())
    }
}

impl Hub {
    /// _tools_poll: where the poll `pid` is in a checked conversation (its message is kept, not deleted, and has a
    /// poll record).
    fn tools_poll(st: &mut State, who: &Identity, c: &Conv, pid: &str) -> R<usize> {
        let i = Self::scoped_index(st, who, c, pid)?;
        let target = &Self::conv_list(st, who, c).expect("the poll's conversation")[i];
        if pj::truthy(target.get("deleted")) {
            return bad("that message was deleted");
        }
        let has_poll = target.get("poll").map(Value::is_object).unwrap_or(false);
        if !has_poll || !st.tools_polls().contains_key(pid) {
            return Err(E::NotFound(NO_POLL.into()));
        }
        Ok(i)
    }

    /// _tools_update: the poll's new state for everyone in the conversation (`chat_update` with `poll`, never anyone's
    /// `mine`), and the answer to the caller.
    fn tools_update(st: &mut State, who: &Identity, scope: &str, c: &Conv, i: usize, poll: Obj, by: &str) {
        let list = Self::conv_list_mut(st, who, c).expect("the poll's conversation");
        let target = &mut list[i];
        target.insert("poll".into(), Value::Object(poll.clone()));
        let event = obj([
            ("type", Value::from("chat_update")),
            ("scope", Value::from(scope)),
            ("id", target.get("id").cloned().unwrap_or(Value::Null)),
            ("text", Value::from(pj::s(target, "text"))),
            ("poll", Value::Object(copy_poll(&poll))),
            ("by", Value::from(by)),
        ]);
        st.dirty = true;
        Self::tell_conversation(st, who, c, &event);
    }

    /// `POST /v1/polls`: a poll message in a call (`room`), a direct-message conversation (`dm`) or a channel or group
    /// chat (`channel`). Its text is the question, so an app without polls shows the question. Answers the message.
    #[allow(clippy::too_many_arguments)]
    pub fn tools_poll_create(&self, who: &Identity, scope: &str, question: Body, options: Body, multiple: Body, anonymous: Body, session: Option<String>, peer: Option<String>, with_: Option<String>, channel: Option<String>) -> R<Obj> {
        let question = question_text(question)?;
        let texts = option_texts(options)?;
        let multiple = m::flag(multiple, "multiple")?;
        let anonymous = m::flag(anonymous, "anonymous")?;
        let mut st = self.st.lock();
        let r = (|| -> R<Obj> {
            let c = Self::conversation(&st, who, scope, peer.as_deref(), session.as_deref(), with_.as_deref(), channel.as_deref(), true)?;
            // encrypted: a post whose payload holds the poll
            st.ce_plain_in(&c)?;
            let pid = pj::token_hex(8);
            let options: Vec<Value> = texts.iter().enumerate().map(|(i, t)| Value::Object(obj([("id", Value::from(format!("o{}", i + 1))), ("text", Value::from(t.clone()))]))).collect();
            let base = obj([
                ("id", Value::from(pid.clone())),
                ("question", Value::from(question.clone())),
                ("options", Value::Array(options)),
                ("multiple", Value::Bool(multiple)),
                ("anonymous", Value::Bool(anonymous)),
                ("closed", Value::Null),
                ("by", Value::from(who.principal.clone())),
            ]);
            let poll = Value::Object(counted(&base, &Obj::new(), None));
            let now = pj::now();
            let (place, msg) = match &c {
                Conv::Room { peer, room } => {
                    let mut msg = obj([
                        ("type", Value::from("chat")),
                        ("kind", Value::from("chat")),
                        ("id", Value::from(pid.clone())),
                        ("from", Value::from(peer.clone())),
                        ("name", Value::from(who.name.clone())),
                        ("principal", Value::from(who.principal.clone())),
                        ("org", st.org(&who.principal)),
                        ("text", Value::from(question.clone())),
                        ("ts", f(now)),
                        ("rts", Value::from((now * 1000.0) as i64)),
                        ("reactions", Value::Object(Obj::new())),
                        ("poll", poll),
                    ]);
                    st.room_log(room, &mut msg);
                    st.broadcast(room, &msg, None);
                    (room.clone(), msg)
                }
                Conv::Channel(cid) => {
                    let now = now.max(st.last_ts(cid) + 1e-6);
                    let msg = obj([
                        ("id", Value::from(pid.clone())),
                        ("channel", Value::from(cid.clone())),
                        ("from", Value::from(who.principal.clone())),
                        ("from_name", Value::from(who.name.clone())),
                        ("from_org", st.org(&who.principal)),
                        ("text", Value::from(question.clone())),
                        ("ts", f(now)),
                        ("rts", Value::from((now * 1000.0) as i64)),
                        ("reactions", Value::Object(Obj::new())),
                        ("poll", poll),
                    ]);
                    let msgs = st.channel_msgs.entry(cid.clone()).or_default();
                    msgs.push(msg.clone());
                    if msgs.len() > channels::CHANNEL_KEEP {
                        let cut = msgs.len() - channels::CHANNEL_KEEP;
                        msgs.drain(..cut);
                    }
                    st.channel_mut(cid).insert("last".into(), f(now));
                    let members = channels::members_of(st.channel(cid));
                    st.tell(&members, &obj([("type", Value::from("channel_message")), ("message", Value::Object(msg.clone()))]), session.as_deref());
                    (cid.clone(), msg)
                }
                // direct messages are always encrypted (refused above)
                Conv::Dm(_) => return Err(E::Conflict(ce::PLAIN.into())),
            };
            let record = obj([("scope", Value::from(scope)), ("where", Value::from(place)), ("by", Value::from(who.principal.clone())), ("votes", Value::Object(Obj::new()))]);
            st.tools_polls().insert(pid, Value::Object(record));
            st.dirty = true;
            Ok(st.tools_answer(&msg, &who.principal))
        })();
        drop(st);
        self.wake();
        let out = r?;
        log_info(&format!("poll scope={scope} principal={} options={} multiple={} anonymous={}", who.principal, texts.len(), py_bool(multiple), py_bool(anonymous)));
        Ok(out)
    }

    /// `POST /v1/polls/vote`: the caller's choices replace their earlier ones (one vote set per person; empty clears
    /// it). A named poll shows who chose what; an anonymous one only counts, and its update names nobody (`by` is
    /// empty).
    #[allow(clippy::too_many_arguments)]
    pub fn tools_poll_vote(&self, who: &Identity, scope: &str, id: Body, picked: Body, session: Option<String>, peer: Option<String>, with_: Option<String>, channel: Option<String>) -> R<Obj> {
        let pid = pj::str_or(id);
        let picked = choices(picked)?;
        let mut st = self.st.lock();
        let r = (|| -> R<(Obj, bool, usize)> {
            let c = Self::conversation(&st, who, scope, peer.as_deref(), session.as_deref(), with_.as_deref(), channel.as_deref(), true)?;
            // encrypted: a signed `vote` event (/v1/chat/event)
            st.ce_plain_in(&c)?;
            let i = Self::tools_poll(&mut st, who, &c, &pid)?;
            let poll = Self::conv_list(&st, who, &c).expect("the poll's conversation")[i].get("poll").and_then(Value::as_object).cloned().expect("a poll");
            if pj::truthy(poll.get("closed")) {
                return Err(E::Conflict("this poll is closed".into()));
            }
            let ids = option_ids(&poll);
            if picked.iter().any(|c| !ids.contains(c)) {
                return bad("choose among this poll's options");
            }
            if picked.len() > 1 && !pj::truthy(poll.get("multiple")) {
                return bad("this poll takes one choice");
            }
            let picked: Vec<Value> = ids.iter().filter(|i| picked.contains(*i)).cloned().map(Value::from).collect();
            let anonymous = pj::truthy(poll.get("anonymous"));
            let votes = obj_mut(st.tools_polls().get_mut(&pid).and_then(Value::as_object_mut).expect("a poll record"), "votes");
            let before = votes.get(&who.principal).filter(|v| pj::truthy(Some(*v))).cloned().unwrap_or(Value::Array(Vec::new()));
            if Value::Array(picked.clone()) != before {
                // a changed vote counts as the latest
                votes.shift_remove(&who.principal);
                if !picked.is_empty() {
                    votes.insert(who.principal.clone(), Value::Array(picked.clone()));
                }
                let fresh = counted(&poll, votes, None);
                Self::tools_update(&mut st, who, scope, &c, i, fresh, if anonymous { "" } else { who.principal.as_str() });
            }
            let target = Self::conv_list(&st, who, &c).expect("the poll's conversation")[i].clone();
            Ok((st.tools_answer(&target, &who.principal), anonymous, picked.len()))
        })();
        drop(st);
        self.wake();
        let (out, anonymous, n) = r?;
        log_info(&format!("poll_vote scope={scope} principal={} choices={n}", if anonymous { "-" } else { who.principal.as_str() }));
        Ok(out)
    }

    /// `POST /v1/polls/close`: no more votes; the person who made the poll or a relay admin. Closing a closed poll
    /// answers it and tells nobody.
    #[allow(clippy::too_many_arguments)]
    pub fn tools_poll_close(&self, who: &Identity, scope: &str, id: Body, session: Option<String>, peer: Option<String>, with_: Option<String>, channel: Option<String>) -> R<Obj> {
        let pid = pj::str_or(id);
        let mut st = self.st.lock();
        let r = (|| -> R<Obj> {
            let c = Self::conversation(&st, who, scope, peer.as_deref(), session.as_deref(), with_.as_deref(), channel.as_deref(), false)?;
            // encrypted: a signed `close` event (/v1/chat/event)
            st.ce_plain_in(&c)?;
            let i = Self::tools_poll(&mut st, who, &c, &pid)?;
            let record = st.tools_polls().get(&pid).and_then(Value::as_object).cloned().expect("a poll record");
            if pj::text_of(&record, "by") != who.principal && !st.admins.contains(&who.principal) {
                return forbidden("only the person who made the poll or an admin can close it");
            }
            let poll = Self::conv_list(&st, who, &c).expect("the poll's conversation")[i].get("poll").and_then(Value::as_object).cloned().expect("a poll");
            if !pj::truthy(poll.get("closed")) {
                let votes = record.get("votes").and_then(Value::as_object).cloned().unwrap_or_default();
                let fresh = counted(&poll, &votes, Some(f(pj::now())));
                Self::tools_update(&mut st, who, scope, &c, i, fresh, &who.principal);
                log_info(&format!("poll_close scope={scope} principal={}", who.principal));
            }
            let target = Self::conv_list(&st, who, &c).expect("the poll's conversation")[i].clone();
            Ok(st.tools_answer(&target, &who.principal))
        })();
        drop(st);
        self.wake();
        r
    }

    /// `GET /v1/polls/mine`: `{mine: {poll id: [option ids]}}`, the caller's own choices in the polls asked about
    /// (unknown ids are left out).
    pub fn tools_polls_mine(&self, who: &Identity, ids: &str, session: Option<String>, peer: Option<String>) -> R<Obj> {
        let wanted: Vec<&str> = ids.split(',').map(str::trim).filter(|i| !i.is_empty()).collect();
        if wanted.len() > MINE_MAX {
            return bad(format!("ask about at most {MINE_MAX} polls at once"));
        }
        let mut st = self.st.lock();
        if let Some(s) = &session {
            st.session(s, who)?;
        } else if let Some(p) = &peer {
            st.owned(p, who)?;
        } else {
            return bad("say your session (session or peer)");
        }
        let polls = st.tools_polls();
        let mut mine = Obj::new();
        for pid in wanted {
            if let Some(rec) = polls.get(pid) {
                let chosen = rec.get("votes").and_then(|v| v.get(&who.principal)).filter(|v| pj::truthy(Some(*v))).cloned().unwrap_or(Value::Array(Vec::new()));
                mine.insert(pid.to_string(), chosen);
            }
        }
        Ok(obj([("mine", Value::Object(mine))]))
    }

    /// `POST /v1/board`: draw (`stroke`), `erase` strokes, `undo` the caller's latest stroke, `clear` the board (host)
    /// or `lock` it (host; a locked board takes strokes, erasing and undo from the host and the presenter only). The
    /// others in the room hear `{type: "board", op, stroke?, ids?, locked?, by}`. Answers `{ok, locked, count}` (`ids`
    /// removed, for erase and undo).
    pub fn tools_board(&self, peer_id: &str, who: &Identity, op: Body, stroke: Body, ids: Body, locked: Body) -> R<Obj> {
        let op = match op {
            Some(Value::String(o)) if BOARD_OPS.contains(&o.as_str()) => o.clone(),
            _ => return bad("op must be stroke, erase, clear, undo or lock"),
        };
        let mut drawn = None;
        let mut named = Vec::new();
        let mut lock_to = false;
        match op.as_str() {
            "stroke" => drawn = Some(stroke_of(stroke)?),
            "erase" => named = stroke_ids(ids)?,
            "lock" => match locked {
                Some(Value::Bool(b)) => lock_to = *b,
                _ => return bad("locked must be true or false"),
            },
            _ => {}
        }
        let mut st = self.st.lock();
        let r = (|| -> R<(Obj, String)> {
            let room = st.tools_seat(peer_id, who)?;
            let host = st.stage_host(&room).as_deref() == Some(peer_id);
            let presenter = st.stages.get(&room).and_then(|s| s.get("presenter")).and_then(|p| p.get("peer")).and_then(Value::as_str) == Some(peer_id);
            let existed = st.boards.contains_key(&room);
            let was_locked = st.boards.get(&room).map(|b| b.locked).unwrap_or(false);
            if (op == "clear" || op == "lock") && !host {
                return forbidden(NOT_HOST);
            }
            if was_locked && matches!(op.as_str(), "stroke" | "erase" | "undo") && !(host || presenter) {
                return forbidden(LOCKED);
            }
            let mut board = st.boards.remove(&room).unwrap_or_default();
            let mut event = obj([("type", Value::from("board")), ("op", Value::from(op.clone()))]);
            let mut removed: Vec<String> = Vec::new();
            let drew = (|| -> R<()> {
                match op.as_str() {
                    "stroke" => {
                        let mut s = drawn.take().expect("a checked stroke");
                        let sid = pj::text_of(&s, "id");
                        if board.strokes.iter().any(|x| pj::text_of(x, "id") == sid) {
                            return Err(E::Conflict("that stroke is on the whiteboard already".into()));
                        }
                        s.insert("by".into(), Value::from(who.principal.clone()));
                        let size = pj::dumps_compact(&Value::Object(s.clone())).len();
                        if board.strokes.len() >= BOARD_STROKES {
                            return Err(E::Conflict(format!("the whiteboard is full ({BOARD_STROKES} strokes); erase some or clear it")));
                        }
                        if board.bytes + size > BOARD_BYTES {
                            return Err(E::Conflict("the whiteboard is full (2 MB); erase some or clear it".into()));
                        }
                        board.sizes.insert(sid, size);
                        board.bytes += size;
                        board.strokes.push(s.clone());
                        event.insert("stroke".into(), Value::Object(s));
                    }
                    "erase" | "undo" => {
                        removed = if op == "erase" {
                            board.strokes.iter().map(|s| pj::text_of(s, "id")).filter(|i| named.contains(i)).collect()
                        } else {
                            board.strokes.iter().rev().find(|s| s.get("by").and_then(Value::as_str) == Some(who.principal.as_str())).map(|s| vec![pj::text_of(s, "id")]).unwrap_or_default()
                        };
                        if !removed.is_empty() {
                            board.strokes.retain(|s| !removed.contains(&pj::text_of(s, "id")));
                            for sid in &removed {
                                board.bytes -= board.sizes.remove(sid).unwrap_or(0);
                            }
                            event.insert("ids".into(), Value::Array(removed.iter().cloned().map(Value::from).collect()));
                        }
                    }
                    "clear" => {
                        board.strokes.clear();
                        board.sizes.clear();
                        board.bytes = 0;
                    }
                    _ => {
                        if board.locked != lock_to {
                            board.locked = lock_to;
                            event.insert("locked".into(), Value::Bool(lock_to));
                        }
                    }
                }
                Ok(())
            })();
            let (locked_now, count) = (board.locked, board.strokes.len());
            if existed || (drew.is_ok() && (op == "stroke" || op == "lock")) {
                st.boards.insert(room.clone(), board);
            }
            drew?;
            let changed = op == "stroke" || op == "clear" || !removed.is_empty() || event.contains_key("locked");
            if changed {
                event.insert("by".into(), Value::from(who.principal.clone()));
                st.broadcast(&room, &event, Some(peer_id));
            }
            let mut out = obj([("ok", Value::Bool(true)), ("locked", Value::Bool(locked_now)), ("count", Value::from(count))]);
            if op == "erase" || op == "undo" {
                out.insert("ids".into(), Value::Array(removed.into_iter().map(Value::from).collect()));
            }
            Ok((out, room))
        })();
        drop(st);
        self.wake();
        let (out, room) = r?;
        if op != "stroke" {
            log_info(&format!("board room={room} principal={} op={op}", who.principal));
        }
        Ok(out)
    }

    /// `GET /v1/board`: `{strokes, locked}` of the caller's call room.
    pub fn tools_board_view(&self, peer_id: &str, who: &Identity) -> R<Obj> {
        let st = self.st.lock();
        let room = st.tools_seat(peer_id, who)?;
        Ok(match st.boards.get(&room) {
            None => obj([("strokes", Value::Array(Vec::new())), ("locked", Value::Bool(false))]),
            Some(b) => obj([("strokes", Value::Array(b.strokes.iter().cloned().map(Value::Object).collect())), ("locked", Value::Bool(b.locked))]),
        })
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
        Hub::new(None, &["ann@x".to_string()], 168.0, 30.0, 365.0, None, Arc::new(LinkStats::new()))
    }

    fn peer_of(joined: &Obj) -> String {
        joined["peer"].as_str().unwrap().to_string()
    }

    #[test]
    fn strokes_are_normalized_and_checked() {
        let s = stroke_of(Some(&json!({"id": "s1", "tool": "pen", "color": "#1F6FEB", "width": 3, "points": [[0.1, 0.2], [0.123456, 0.5]]}))).unwrap();
        assert_eq!(Value::Object(s), json!({"id": "s1", "tool": "pen", "color": "#1f6feb", "width": 3.0, "points": [[0.1, 0.2], [0.1235, 0.5]]}));
        let shape = stroke_of(Some(&json!({"id": "r", "tool": "shape", "shape": "arrow", "color": "#000000", "width": 1, "points": [[0.1, 0.1]]})));
        assert!(matches!(shape, Err(E::Bad(m)) if m == "a shape needs two points (start and end)"));
        assert!(matches!(stroke_of(Some(&json!({"id": "bad id"}))), Err(E::Bad(_))));
    }

    #[test]
    fn a_named_poll_counts_and_names_its_voters_an_anonymous_one_only_counts() {
        let h = hub();
        let (ann, ben) = (who("ann@x", "aaaaaaaaaaaaaaaa"), who("ben@x", "bbbbbbbbbbbbbbbb"));
        let a = peer_of(&h.join("ops", &ann, "", false, None).unwrap());
        let b = peer_of(&h.join("ops", &ben, "", false, None).unwrap());
        // the call's chat is end-to-end encrypted: a plain poll only while a web guest is in it
        let plain = h.tools_poll_create(&ann, "room", Some(&json!("Q")), Some(&json!(["a", "b"])), None, None, None, Some(a.clone()), None, None);
        assert!(matches!(plain, Err(E::Conflict(m)) if m == ce::PLAIN));
        let g = peer_of(&h.join("ops", &who("cy@x", "cccccccccccccccc"), "", false, None).unwrap());
        h.st.lock().peers.get_mut(&g).unwrap().who.guest = true;
        let made = h.tools_poll_create(&ann, "room", Some(&json!(" Lunch? ")), Some(&json!(["Pizza", "Salad"])), None, None, None, Some(a.clone()), None, None).unwrap();
        let pid = made["id"].as_str().unwrap().to_string();
        assert_eq!(made["poll"]["voters"], json!({"o1": [], "o2": []}));
        assert_eq!(made["poll"]["mine"], json!([]));
        let voted = h.tools_poll_vote(&ben, "room", Some(&json!(pid)), Some(&json!(["o2"])), None, Some(b.clone()), None, None).unwrap();
        assert_eq!(voted["poll"]["options"][1]["votes"], json!(1));
        assert_eq!(voted["poll"]["voters"]["o2"], json!(["ben@x"]));
        assert_eq!(voted["poll"]["mine"], json!(["o2"]));
        let mine = h.tools_polls_mine(&ben, &format!("{pid},nope"), None, Some(b.clone())).unwrap();
        assert_eq!(Value::Object(mine), json!({"mine": {pid.clone(): ["o2"]}}));
        let secret = h.tools_poll_create(&ann, "room", Some(&json!("Q")), Some(&json!(["a", "b"])), None, Some(&json!(true)), None, Some(a), None, None).unwrap();
        let sid = secret["id"].as_str().unwrap().to_string();
        let voted = h.tools_poll_vote(&ben, "room", Some(&json!(sid)), Some(&json!(["o1"])), None, Some(b), None, None).unwrap();
        assert!(voted["poll"].get("voters").is_none());
        assert!(!pj::dumps(&Value::Object(h.st.lock().rooms["ops"].iter().find(|l| l["id"] == json!(sid)).unwrap().clone())).contains("ben@x"));
    }

    #[test]
    fn the_board_is_the_rooms_until_it_empties() {
        let h = hub();
        let ann = who("ann@x", "aaaaaaaaaaaaaaaa");
        let a = peer_of(&h.join("board", &ann, "", false, None).unwrap());
        let stroke = json!({"id": "s1", "tool": "pen", "color": "#000000", "width": 2, "points": [[0, 0]]});
        assert_eq!(Value::Object(h.tools_board(&a, &ann, Some(&json!("stroke")), Some(&stroke), None, None).unwrap()), json!({"ok": true, "locked": false, "count": 1}));
        assert!(matches!(h.tools_board(&a, &ann, Some(&json!("stroke")), Some(&stroke), None, None), Err(E::Conflict(_))));
        assert_eq!(h.tools_board(&a, &ann, Some(&json!("undo")), None, None, None).unwrap()["ids"], json!(["s1"]));
        h.tools_board(&a, &ann, Some(&json!("lock")), None, None, Some(&json!(true))).unwrap();
        h.leave(&a, &ann).unwrap();
        let a = peer_of(&h.join("board", &ann, "", false, None).unwrap());
        assert_eq!(Value::Object(h.tools_board_view(&a, &ann).unwrap()), json!({"strokes": [], "locked": false}));
    }
}
