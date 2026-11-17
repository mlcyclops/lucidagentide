// Phase C (ADR-0540): conversations of the Meet relay (meet_relay.Hub.channel_*, pin, pins, search and the thread
// helpers): public and private channels and group chats (`channel_days` retention), threads in channels and direct
// messages, pins in rooms, channels and direct messages, search over the caller's own channels and direct messages,
// and the link previews a sender's Hub attaches. A child module of meet_hub: it shares the one lock.

use super::*;

pub(super) const CHANNEL_KINDS: [&str; 3] = ["public", "private", "group"];
/// Characters of a channel topic.
const CHANNEL_TOPIC_MAX: usize = 250;
/// Messages kept per channel (and only for `channel_days`).
pub(super) const CHANNEL_KEEP: usize = 10000;
/// Messages one channel history request returns.
const CHANNEL_LIMIT_MAX: i64 = 500;
/// People in one public or private channel.
pub(super) const CHANNEL_MEMBERS_MAX: usize = 500;
/// A group chat: me plus 2 to 8 others.
const GROUP_MIN: usize = 3;
const GROUP_MAX: usize = 9;
/// People one channel invitation names.
const INVITE_CHANNEL_MAX: usize = 50;
/// Principals a thread root names as its latest repliers.
const REPLIERS_MAX: usize = 3;
/// Pinned messages per conversation.
const PINS_MAX: usize = 100;
/// Characters of each link preview field.
const PREVIEW_FIELD_MAX: usize = 300;
/// Hits one search returns.
const SEARCH_MAX: i64 = 50;
/// Characters of a search.
const SEARCH_QUERY_MAX: usize = 200;
/// Characters of a search hit's excerpt.
const EXCERPT_MAX: usize = 160;
pub(super) const NO_CHANNEL: &str = "there is no such channel";
const ARCHIVED: &str = "this channel is archived";
const NOT_CREATOR: &str = "only the person who created the channel or an admin can do that";

/// A channel's members (none when there is no such channel).
pub(super) fn members_of(ch: Option<&Obj>) -> Vec<String> {
    ch.and_then(|c| c.get("members")).and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect()
}

fn set_members(ch: &mut Obj, members: &[String]) {
    ch.insert("members".into(), Value::Array(members.iter().cloned().map(Value::from).collect()));
}

/// _channel_name: a public or private channel's name, 1 to 40 lowercase letters, digits or dashes.
fn channel_name(v: Option<&Value>) -> R<String> {
    let name = pj::str_or(v).trim().to_lowercase();
    if !meetings::re_like(&name, 40, |c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') {
        return bad("channel names are 1 to 40 lowercase letters, digits or dashes");
    }
    Ok(name)
}

/// _topic: a channel topic (absent: none), white space collapsed.
fn topic(v: Option<&Value>) -> R<String> {
    let topic = match v {
        None | Some(Value::Null) => return Ok(String::new()),
        Some(Value::String(s)) => pj::squash(s),
        Some(_) => return bad("the topic must be text"),
    };
    if pj::char_len(&topic) > CHANNEL_TOPIC_MAX || !pj::printable(&topic) {
        return bad(format!("a topic is at most {CHANNEL_TOPIC_MAX} printable characters"));
    }
    Ok(topic)
}

/// _people: a list of principals (absent: none), lower case, each once.
pub(super) fn people(v: Option<&Value>, what: &str, most: usize) -> R<Vec<String>> {
    let list: Vec<&Value> = match v {
        None | Some(Value::Null) => return Ok(Vec::new()),
        Some(s @ Value::String(_)) => vec![s],
        Some(Value::Array(a)) if a.iter().all(Value::is_string) => a.iter().collect(),
        _ => return bad(format!("{what} must be a list of people")),
    };
    let mut out: Vec<String> = Vec::new();
    for p in list {
        let p = p.as_str().unwrap_or_default().trim().to_lowercase();
        if !p.is_empty() && !out.contains(&p) {
            out.push(p);
        }
    }
    if out.len() > most {
        return bad(format!("name at most {most} people at once"));
    }
    Ok(out)
}

fn printable_char(c: char) -> bool {
    pj::printable(c.encode_utf8(&mut [0u8; 4]))
}

/// _link_preview: the link preview a sender's Hub attached (absent: none): `{url, title, description, site}`, an https
/// link and each field capped at PREVIEW_FIELD_MAX characters.
pub(super) fn link_preview(v: Option<&Value>) -> R<Option<Obj>> {
    let p = match v {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::Object(p)) => p,
        Some(_) => return bad("a link preview must be an object"),
    };
    let url = match p.get("url") {
        Some(Value::String(u)) if u.starts_with("https://") && pj::char_len(u) <= PREVIEW_FIELD_MAX && u.chars().all(|c| !c.is_whitespace() && printable_char(c)) => u.clone(),
        _ => return bad(format!("a link preview must be an https link of at most {PREVIEW_FIELD_MAX} characters")),
    };
    let mut out = obj([("url", Value::from(url))]);
    for key in ["title", "description", "site"] {
        let text = match p.get(key) {
            Some(Value::String(s)) => pj::squash(s),
            _ => String::new(),
        };
        let kept: String = text.chars().filter(|c| printable_char(*c)).take(PREVIEW_FIELD_MAX).collect();
        out.insert(key.into(), Value::from(kept));
    }
    Ok(Some(out))
}

fn word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// str.casefold(), for the letters search meets.
fn fold(text: &str) -> String {
    text.to_lowercase().replace('ß', "ss")
}

/// _words: the words of a text as search compares them (case-insensitive).
fn words(text: &str) -> Vec<String> {
    fold(text).split(|c: char| !word_char(c)).filter(|w| !w.is_empty()).map(str::to_string).collect()
}

/// _excerpt: up to EXCERPT_MAX characters of `text` around the first match of `word`.
fn excerpt(text: &str, word: &str) -> String {
    let text: Vec<char> = pj::squash(text).chars().collect();
    if text.len() <= EXCERPT_MAX {
        return text.into_iter().collect();
    }
    let word: Vec<char> = word.chars().collect();
    let lower = |c: char| c.to_lowercase().next().unwrap_or(c);
    let found = (0..text.len()).find(|&i| {
        (i == 0 || !word_char(text[i - 1])) && i + word.len() <= text.len() && word.iter().enumerate().all(|(k, w)| lower(text[i + k]) == lower(*w))
    });
    let start = found.unwrap_or(0).saturating_sub(EXCERPT_MAX / 3).min(text.len() - EXCERPT_MAX);
    let out: String = text[start..start + EXCERPT_MAX].iter().collect();
    format!("{}{out}{}", if start > 0 { "..." } else { "" }, if start + EXCERPT_MAX < text.len() { "..." } else { "" })
}

/// _group_id: a group chat's id, from its member set: the same people reuse one group.
fn group_id(members: &[String]) -> String {
    let mut set: Vec<&String> = members.iter().collect();
    set.sort();
    set.dedup();
    let joined = set.iter().map(|s| s.as_str()).collect::<Vec<_>>().join("\n");
    format!("g-{}", &crate::codec::sha256_hex(joined.as_bytes())[..20])
}

/// _thread_id: the thread a reply to `target` belongs to: its own, or the one it is in.
pub(super) fn thread_id(target: &Obj) -> String {
    if pj::truthy(target.get("thread")) {
        str_value(target.get("thread"))
    } else {
        str_value(target.get("id"))
    }
}

/// _recount: a thread root's `replies`, `last_reply` and `repliers` (the latest REPLIERS_MAX people, newest first)
/// from its kept replies that are not deleted. A root never replied to has none of them. A bridged reply (`src`)
/// counts as its external person, `ext:<platform>:<user id>`, not as the connector; the root's `replier_names` then
/// names those ids (only the ones in `repliers`; once present it becomes {} rather than going, like `repliers`).
pub(super) fn recount(msgs: &mut [Obj], root_id: &str) {
    let Some(at) = msgs.iter().position(|m| m.get("id").and_then(Value::as_str) == Some(root_id)) else { return };
    let replies: Vec<&Obj> = msgs.iter().filter(|m| m.get("thread").and_then(Value::as_str) == Some(root_id) && !pj::truthy(m.get("deleted"))).collect();
    let mut repliers: Vec<String> = Vec::new();
    let mut names = Obj::new();
    for m in replies.iter().rev() {
        let who = match m.get("src") {
            Some(Value::Object(src)) => {
                let who = format!("ext:{}:{}", str_value(src.get("platform")), str_value(src.get("user")));
                if !repliers.contains(&who) {
                    names.insert(who.clone(), Value::from(pj::s(src, "name")));
                }
                who
            }
            _ => str_value(m.get("from")),
        };
        if !repliers.contains(&who) {
            repliers.push(who);
        }
        if repliers.len() == REPLIERS_MAX {
            break;
        }
    }
    let (count, last) = match replies.last() {
        // zero, not absent: a copy elsewhere learns it too
        None => (0, Value::Null),
        Some(m) => (replies.len(), m.get("ts").cloned().unwrap_or(Value::Null)),
    };
    let root = &mut msgs[at];
    if !names.is_empty() || root.contains_key("replier_names") {
        root.insert("replier_names".into(), Value::Object(names));
    }
    root.insert("replies".into(), Value::from(count));
    root.insert("last_reply".into(), last);
    root.insert("repliers".into(), Value::Array(repliers.into_iter().map(Value::from).collect()));
}

/// _thread_view: a thread: its root first, then its replies after `after` (the last `limit` minus one of them).
pub(super) fn thread_view(msgs: &[Obj], root_id: &str, after: f64, limit: usize) -> R<Vec<Obj>> {
    let by_id = |id: &str| msgs.iter().find(|m| m.get("id").and_then(Value::as_str) == Some(id));
    let mut root_id = root_id.to_string();
    let mut root = by_id(&root_id);
    if let Some(r) = root {
        if pj::truthy(r.get("thread")) {
            root_id = str_value(r.get("thread"));
            root = by_id(&root_id);
        }
    }
    let Some(root) = root else { return Err(E::NotFound("that message is no longer kept".into())) };
    let replies: Vec<&Obj> = msgs.iter().filter(|m| m.get("thread").and_then(Value::as_str) == Some(root_id.as_str()) && pj::num(m, "ts") > after).collect();
    let mut out = vec![root.clone()];
    if limit > 1 {
        out.extend(replies[replies.len().saturating_sub(limit - 1)..].iter().map(|m| (*m).clone()));
    }
    Ok(out)
}

fn channel_event(why: &str, ch: &Obj, by: &str) -> Obj {
    obj([("type", Value::from("channel")), ("why", Value::from(why)), ("channel", Value::Object(ch.clone())), ("by", Value::from(by))])
}

impl State {
    pub(super) fn channel(&self, cid: &str) -> Option<&Obj> {
        as_obj(self.channels.get(cid))
    }

    pub(super) fn channel_mut(&mut self, cid: &str) -> &mut Obj {
        obj_mut(&mut self.channels, cid)
    }

    /// _member_channel: a channel `principal` is a member of. A private channel or a group is not there at all for
    /// anyone else (404); a public one asks them to join first (403). `writing` refuses an archived channel.
    pub(super) fn member_channel(&self, cid: &str, principal: &str, writing: bool) -> R<String> {
        let ch = self.channel(cid);
        let member = members_of(ch).iter().any(|m| m == principal);
        let Some(ch) = ch.filter(|c| member || pj::text_of(c, "kind") == "public") else { return Err(E::NotFound(NO_CHANNEL.into())) };
        if !member {
            return forbidden("join the channel first");
        }
        if writing && pj::truthy(ch.get("archived")) {
            return bad(ARCHIVED);
        }
        Ok(cid.to_string())
    }

    /// _managed_channel: a channel the caller may rename, describe or archive: its creator (a member) or a relay
    /// admin.
    fn managed_channel(&self, cid: &str, who: &Identity) -> R<String> {
        if self.admins.contains(&who.principal) {
            if self.channel(cid).is_none() {
                return Err(E::NotFound(NO_CHANNEL.into()));
            }
            return Ok(cid.to_string());
        }
        let cid = self.member_channel(cid, &who.principal, false)?;
        if self.channel(&cid).map(|c| pj::text_of(c, "created_by")) != Some(who.principal.clone()) {
            return forbidden(NOT_CREATOR);
        }
        Ok(cid)
    }

    /// _channel_message: where the message `id` is in a channel.
    pub(super) fn channel_index(&self, cid: &str, id: &str) -> R<usize> {
        self.channel_msgs.get(cid).and_then(|l| l.iter().position(|m| pj::text_of(m, "id") == id)).ok_or_else(|| E::NotFound("that message is no longer kept".into()))
    }

    /// _channel_view: a channel as its member sees it, plus `unread` (main conversation messages of others after the
    /// read mark) and `mentions` (of those, and of thread replies, the ones that mention them).
    fn channel_view(&mut self, cid: &str, principal: &str) -> Obj {
        let mark = as_obj(self.channel_read.get(principal)).and_then(|o| pj::as_num(o.get(cid))).unwrap_or(0.0);
        let (mut unread, mut mentions) = (0, 0);
        for m in self.channel_msgs.get(cid).into_iter().flatten() {
            if pj::num(m, "ts") <= mark || m.get("from").and_then(Value::as_str) == Some(principal) || pj::truthy(m.get("deleted")) || pj::truthy(m.get("imported")) {
                // imported history (PC-1 L6) counts toward no unread totals
                continue;
            }
            if !pj::truthy(m.get("thread")) || pj::truthy(m.get("also_channel")) {
                unread += 1;
            }
            if m.get("mentions").and_then(Value::as_array).map(|l| l.iter().any(|p| p.as_str() == Some(principal))).unwrap_or(false) {
                mentions += 1;
            }
        }
        let mut view = with(&self.channel(cid).cloned().unwrap_or_default(), obj([("unread", Value::from(unread)), ("mentions", Value::from(mentions))]));
        // the bridge adds `links`, chat encryption its flags and member log
        self.bridge_chan_view(cid, &mut view);
        self.ce_chan_view(cid, &mut view);
        view
    }

    /// _last_ts: when the channel's latest kept message was sent (0 when none): a person added to a channel starts
    /// with everything before it read. Messages are kept in time order.
    pub(super) fn last_ts(&self, cid: &str) -> f64 {
        self.channel_msgs.get(cid).and_then(|l| l.last()).map(|m| pj::num(m, "ts")).unwrap_or(0.0)
    }

    /// _mark_read.
    pub(super) fn mark_read(&mut self, principals: &[String], cid: &str, ts: f64) {
        if ts <= 0.0 {
            return;
        }
        for p in principals {
            let marks = obj_mut(&mut self.channel_read, p);
            if ts > pj::as_num(marks.get(cid)).unwrap_or(0.0) {
                marks.insert(cid.to_string(), f(ts));
            }
        }
    }

    /// _known: everyone named has used this relay (the caller aside).
    fn channel_known(&mut self, people: &[String], who: &Identity) -> R<()> {
        // PC-1: an app or archive a current org policy names is known too
        let mut missing: Vec<&str> = Vec::new();
        for p in people {
            if !self.directory.contains_key(p.as_str()) && *p != who.principal && !self.pc_policy_service(p) {
                missing.push(p);
            }
        }
        if !missing.is_empty() {
            return Err(E::NotFound(format!("not known on this relay: {}", missing.join(", "))));
        }
        Ok(())
    }

    /// _open_group: the group chat of exactly these people: made (with its signed `create` entry, `log`), or the
    /// existing one (back from archived, and anyone who had left it back in: an `add` entry). Everyone in it hears
    /// `channel`.
    #[allow(clippy::too_many_arguments)]
    fn open_group(&mut self, who: &Identity, everyone: &[String], topic: &str, now: f64, log: Body, bridgeable: bool) -> R<String> {
        if !(GROUP_MIN..=GROUP_MAX).contains(&everyone.len()) {
            return bad(format!("a group chat is {GROUP_MIN} to {GROUP_MAX} people (you and {} to {} others)", GROUP_MIN - 1, GROUP_MAX - 1));
        }
        let cid = group_id(everyone);
        if self.channel(&cid).is_some() && self.ce_bridgeable(&cid) != bridgeable {
            return Err(E::Conflict(ce::GROUP_OTHER.into()));
        }
        let mut entry: Option<Obj> = None;
        let why = match self.channel(&cid) {
            None => {
                if bridgeable {
                    self.ce_bridgeable_ok(who)?;
                }
                entry = Some(self.ce_first(&cid, log, who, "create", everyone, "group", bridgeable)?);
                let ch = obj([
                    ("id", Value::from(cid.clone())),
                    ("kind", Value::from("group")),
                    ("name", Value::from("")),
                    ("topic", Value::from(topic)),
                    ("created_by", Value::from(who.principal.clone())),
                    ("members", Value::Array(everyone.iter().cloned().map(Value::from).collect())),
                    ("created", f(now)),
                    ("archived", Value::Null),
                    ("last", f(now)),
                ]);
                self.channels.insert(cid.clone(), Value::Object(ch));
                "created"
            }
            Some(ch) if members_of(Some(ch)) != everyone || pj::truthy(ch.get("archived")) => {
                let before = members_of(Some(ch));
                let newcomers: Vec<String> = everyone.iter().filter(|p| !before.contains(p)).cloned().collect();
                if !newcomers.is_empty() {
                    entry = self.ce_entry_in(&cid, who, log, "add", &newcomers)?;
                }
                let last = self.last_ts(&cid);
                self.mark_read(&newcomers, &cid, last);
                let ch = self.channel_mut(&cid);
                set_members(ch, everyone);
                ch.insert("archived".into(), Value::Null);
                "updated"
            }
            Some(_) => return Ok(cid),
        };
        match (why, entry) {
            ("created", Some(e)) => self.ce_open(&cid, e),
            (_, Some(e)) => self.ce_keep(&cid, e),
            _ => {}
        }
        self.dirty = true;
        let event = channel_event(why, self.channel(&cid).expect("the group"), &who.principal);
        self.tell(everyone, &event, None);
        if why == "updated" {
            self.bridge_recheck("relay", Some(&cid), None);
        }
        Ok(cid)
    }
}

impl Hub {
    /// channel_create (`POST /v1/channels`): a public or private channel (`name`, unique among channels that are not
    /// archived) with the creator and any `members` in it, or a group chat of `members` and the creator (3 to 9
    /// people, no name; the same people get the same group back). `id` is chosen by the creator's device (`c-` and 16
    /// hex). End-to-end encrypted unless `bridgeable`; either way `log` is its signed `create` entry.
    #[allow(clippy::too_many_arguments)]
    pub fn channel_create(&self, session: &str, who: &Identity, kind: Body, name: Body, topic_v: Body, members: Body, id: Body, bridgeable: Body, log: Body) -> R<Obj> {
        let kind = match kind {
            Some(Value::String(k)) if CHANNEL_KINDS.contains(&k.as_str()) => k.clone(),
            _ => return bad("kind must be public, private or group"),
        };
        let topic = topic(topic_v)?;
        let people = people(members, "members", INVITE_CHANNEL_MAX)?;
        let bridgeable = m::flag(bridgeable, "bridgeable")?;
        if kind == "group" && pj::truthy(name) {
            return bad("a group chat has no name");
        }
        let name = if kind == "group" { String::new() } else { channel_name(name)? };
        let mut st = self.st.lock();
        let r = (|| -> R<Obj> {
            st.session(session, who)?;
            st.channel_known(&people, who)?;
            let now = pj::now();
            let cid = if kind == "group" {
                let mut everyone = people.clone();
                everyone.push(who.principal.clone());
                everyone.sort();
                everyone.dedup();
                st.open_group(who, &everyone, &topic, now, log, bridgeable)?
            } else {
                let taken = st.channels.values().filter_map(Value::as_object).any(|c| pj::text_of(c, "kind") != "group" && !pj::truthy(c.get("archived")) && pj::text_of(c, "name") == name);
                if taken {
                    return Err(E::Conflict("a channel with that name already exists".into()));
                }
                if matches!(log, None | Some(Value::Null)) {
                    return Err(E::Conflict(ce::CREATE_OLD.into()));
                }
                if bridgeable {
                    st.ce_bridgeable_ok(who)?;
                }
                let mut everyone = vec![who.principal.clone()];
                everyone.extend(people.iter().filter(|p| **p != who.principal).cloned());
                let cid = st.ce_new_id(id)?;
                let entry = st.ce_first(&cid, log, who, "create", &everyone, &kind, bridgeable)?;
                let ch = obj([
                    ("id", Value::from(cid.clone())),
                    ("kind", Value::from(kind.clone())),
                    ("name", Value::from(name.clone())),
                    ("topic", Value::from(topic.clone())),
                    ("created_by", Value::from(who.principal.clone())),
                    ("members", Value::Array(everyone.iter().cloned().map(Value::from).collect())),
                    ("created", f(now)),
                    ("archived", Value::Null),
                    ("last", f(now)),
                ]);
                st.channels.insert(cid.clone(), Value::Object(ch));
                st.ce_open(&cid, entry);
                st.dirty = true;
                let event = channel_event("created", st.channel(&cid).expect("the channel"), &who.principal);
                st.tell(&everyone, &event, None);
                cid
            };
            Ok(st.channel_view(&cid, &who.principal))
        })();
        drop(st);
        self.wake();
        let out = r?;
        log_info(&format!(
            "channel_create id={} kind={kind} principal={} members={}",
            pj::text_of(&out, "id"),
            who.principal,
            out.get("members").and_then(Value::as_array).map(Vec::len).unwrap_or(0)
        ));
        Ok(out)
    }

    /// channels_list (`GET /v1/channels`): `{mine: [channel + unread + mentions], browse: [public channels I am not
    /// in]}`: mine newest activity first, browse by name (archived ones are not offered).
    pub fn channels_list(&self, session: &str, who: &Identity) -> R<Obj> {
        let mut st = self.st.lock();
        st.session(session, who)?;
        let mut mine: Vec<Obj> = Vec::new();
        let mut browse: Vec<Obj> = Vec::new();
        let ids: Vec<String> = st.channels.keys().cloned().collect();
        for cid in ids {
            let Some(ch) = st.channel(&cid) else { continue };
            let member = members_of(Some(ch)).contains(&who.principal);
            if member {
                let view = st.channel_view(&cid, &who.principal);
                mine.push(view);
            } else if pj::text_of(ch, "kind") == "public" && !pj::truthy(ch.get("archived")) {
                browse.push(ch.clone());
            }
        }
        drop(st);
        let last = |c: &Obj| if pj::truthy(c.get("last")) { pj::num(c, "last") } else { 0.0 };
        mine.sort_by(|a, b| last(b).partial_cmp(&last(a)).unwrap_or(std::cmp::Ordering::Equal));
        browse.sort_by_key(|c| pj::text_of(c, "name"));
        Ok(obj([("mine", Value::Array(mine.into_iter().map(Value::Object).collect())), ("browse", Value::Array(browse.into_iter().map(Value::Object).collect()))]))
    }

    /// channel_join: join a public channel (a member already: nothing changes); `log` is the signed `join` entry an
    /// encrypted channel needs.
    pub fn channel_join(&self, session: &str, who: &Identity, cid: Body, log: Body) -> R<Obj> {
        let cid = pj::str_or(cid);
        let mut st = self.st.lock();
        let r = (|| -> R<Obj> {
            st.session(session, who)?;
            let Some(ch) = st.channel(&cid) else { return Err(E::NotFound(NO_CHANNEL.into())) };
            let members = members_of(Some(ch));
            let member = members.contains(&who.principal);
            if pj::text_of(ch, "kind") != "public" && !member {
                return Err(E::NotFound(NO_CHANNEL.into()));
            }
            if !member {
                if pj::truthy(ch.get("archived")) {
                    return bad(ARCHIVED);
                }
                let cap = st.ce_cap(&cid);
                if members.len() >= cap {
                    return bad(format!("this channel is full ({cap} people)"));
                }
                let entry = st.ce_entry_in(&cid, who, log, "join", std::slice::from_ref(&who.principal))?;
                st.ce_rate(&who.principal)?;
                let mut members = members;
                members.push(who.principal.clone());
                set_members(st.channel_mut(&cid), &members);
                if let Some(e) = entry {
                    st.ce_keep(&cid, e);
                }
                let last = st.last_ts(&cid);
                st.mark_read(std::slice::from_ref(&who.principal), &cid, last);
                st.dirty = true;
                let event = channel_event("joined", st.channel(&cid).expect("the channel"), &who.principal);
                st.tell(&members, &event, None);
                st.bridge_recheck("relay", Some(&cid), None);
                log_info(&format!("channel_join id={cid} principal={}", who.principal));
            }
            Ok(st.channel_view(&cid, &who.principal))
        })();
        drop(st);
        self.wake();
        r
    }

    /// channel_leave: leave a channel or a group chat. A private channel or group nobody is left in is archived (and
    /// goes after the retention). `log` is the signed `leave` entry an encrypted one needs.
    pub fn channel_leave(&self, session: &str, who: &Identity, cid: Body, log: Body) -> R<Obj> {
        let cid = pj::str_or(cid);
        let mut st = self.st.lock();
        let r = (|| -> R<Obj> {
            st.session(session, who)?;
            let cid = st.member_channel(&cid, &who.principal, false)?;
            let entry = st.ce_entry_in(&cid, who, log, "leave", std::slice::from_ref(&who.principal))?;
            st.ce_rate(&who.principal)?;
            let told = members_of(st.channel(&cid));
            let left: Vec<String> = told.iter().filter(|p| **p != who.principal).cloned().collect();
            set_members(st.channel_mut(&cid), &left);
            if let Some(e) = entry {
                st.ce_keep(&cid, e);
            }
            if let Some(marks) = st.channel_read.get_mut(&who.principal).and_then(Value::as_object_mut) {
                marks.shift_remove(&cid);
            }
            let ch = st.channel_mut(&cid);
            if left.is_empty() && pj::text_of(ch, "kind") != "public" && !pj::truthy(ch.get("archived")) {
                ch.insert("archived".into(), f(pj::now()));
            }
            let out = ch.clone();
            st.dirty = true;
            st.tell(&told, &channel_event("left", &out, &who.principal), None);
            st.bridge_recheck("relay", Some(&cid), None);
            Ok(out)
        })();
        drop(st);
        self.wake();
        let out = r?;
        log_info(&format!("channel_leave id={} principal={}", pj::text_of(&out, "id"), who.principal));
        Ok(out)
    }

    /// channel_invite: a member adds people. A group chat stays the same people: inviting into it answers (and opens)
    /// the group of everyone in it plus the invited (`log`: that group's `create` entry, or its `add` entry when it
    /// exists). Into a channel, `log` is the signed `add` entry an encrypted one needs.
    pub fn channel_invite(&self, session: &str, who: &Identity, cid: Body, principals: Body, log: Body) -> R<Obj> {
        let people = people(principals, "principals", INVITE_CHANNEL_MAX)?;
        if people.is_empty() {
            return bad("name at least one person to invite");
        }
        let cid = pj::str_or(cid);
        let mut st = self.st.lock();
        let r = (|| -> R<Obj> {
            st.session(session, who)?;
            let mut cid = st.member_channel(&cid, &who.principal, true)?;
            st.channel_known(&people, who)?;
            let now = pj::now();
            let members = members_of(st.channel(&cid));
            if st.channel(&cid).map(|c| pj::text_of(c, "kind")) == Some("group".into()) {
                let mut everyone: Vec<String> = members.iter().chain(people.iter()).cloned().collect();
                everyone.sort();
                everyone.dedup();
                let mut sorted = members.clone();
                sorted.sort();
                if everyone != sorted {
                    let bridgeable = st.ce_bridgeable(&cid);
                    cid = st.open_group(who, &everyone, "", now, log, bridgeable)?;
                }
            } else {
                let added: Vec<String> = people.iter().filter(|p| !members.contains(p)).cloned().collect();
                let cap = st.ce_cap(&cid);
                if members.len() + added.len() > cap {
                    return bad(format!("this channel is full ({cap} people)"));
                }
                if !added.is_empty() {
                    let entry = st.ce_entry_in(&cid, who, log, "add", &added)?;
                    let mut all = members;
                    all.extend(added.iter().cloned());
                    set_members(st.channel_mut(&cid), &all);
                    if let Some(e) = entry {
                        st.ce_keep(&cid, e);
                    }
                    let last = st.last_ts(&cid);
                    st.mark_read(&added, &cid, last);
                    st.dirty = true;
                    let event = channel_event("invited", st.channel(&cid).expect("the channel"), &who.principal);
                    st.tell(&all, &event, None);
                    st.bridge_recheck("relay", Some(&cid), None);
                }
            }
            Ok(st.channel_view(&cid, &who.principal))
        })();
        drop(st);
        self.wake();
        let out = r?;
        log_info(&format!("channel_invite id={} principal={} people={}", pj::text_of(&out, "id"), who.principal, people.len()));
        Ok(out)
    }

    /// channel_update: rename (`name`) or describe (`topic`) a channel: its creator or an admin.
    pub fn channel_update(&self, session: &str, who: &Identity, cid: Body, name: Body, topic_v: Body) -> R<Obj> {
        let cid = pj::str_or(cid);
        let mut st = self.st.lock();
        let r = (|| -> R<Obj> {
            st.session(session, who)?;
            let cid = st.managed_channel(&cid, who)?;
            let ch = st.channel(&cid).cloned().unwrap_or_default();
            if pj::truthy(ch.get("archived")) {
                return bad(ARCHIVED);
            }
            let mut changes = Obj::new();
            if let Some(name) = name.filter(|v| !v.is_null()) {
                if pj::text_of(&ch, "kind") == "group" {
                    return bad("a group chat has no name");
                }
                let name = channel_name(Some(name))?;
                if name != pj::text_of(&ch, "name") {
                    let taken = st.channels.iter().filter(|(id, _)| **id != cid).filter_map(|(_, c)| c.as_object()).any(|c| pj::text_of(c, "kind") != "group" && !pj::truthy(c.get("archived")) && pj::text_of(c, "name") == name);
                    if taken {
                        return Err(E::Conflict("a channel with that name already exists".into()));
                    }
                    changes.insert("name".into(), Value::from(name));
                }
            }
            if let Some(t) = topic_v.filter(|v| !v.is_null()) {
                let t = topic(Some(t))?;
                if t != pj::text_of(&ch, "topic") {
                    changes.insert("topic".into(), Value::from(t));
                }
            }
            if !changes.is_empty() {
                let row = st.channel_mut(&cid);
                for (k, v) in changes {
                    row.insert(k, v);
                }
                st.dirty = true;
                let members = members_of(st.channel(&cid));
                let event = channel_event("updated", st.channel(&cid).expect("the channel"), &who.principal);
                st.tell(&members, &event, None);
            }
            Ok(st.channel_view(&cid, &who.principal))
        })();
        drop(st);
        self.wake();
        r
    }

    /// channel_archive: archive a channel (its creator or an admin): read-only from now on, kept for the retention,
    /// offered to nobody.
    pub fn channel_archive(&self, session: &str, who: &Identity, cid: Body) -> R<Obj> {
        let cid = pj::str_or(cid);
        let mut st = self.st.lock();
        let r = (|| -> R<Obj> {
            st.session(session, who)?;
            let cid = st.managed_channel(&cid, who)?;
            if !st.channel(&cid).map(|c| pj::truthy(c.get("archived"))).unwrap_or(false) {
                st.channel_mut(&cid).insert("archived".into(), f(pj::now()));
                st.dirty = true;
                let members = members_of(st.channel(&cid));
                let event = channel_event("archived", st.channel(&cid).expect("the channel"), &who.principal);
                st.tell(&members, &event, None);
                log_info(&format!("channel_archive id={cid} principal={}", who.principal));
            }
            Ok(st.channel_view(&cid, &who.principal))
        })();
        drop(st);
        self.wake();
        r
    }

    /// channel_post (`POST /v1/channels/post`): a message to a channel or group chat. `thread` (a message of it) makes
    /// it a thread reply, kept out of the main conversation unless `also_channel`; `mentions` keeps only members;
    /// `preview` is the sender's Hub's link preview; `fwd` a forwarded message's origin. Every member's sessions hear
    /// `channel_message`.
    #[allow(clippy::too_many_arguments)]
    pub fn channel_post(&self, session: &str, who: &Identity, cid: Body, text: Body, reply_to: Body, mentioned: Body, thread: Body, also_channel: Body, link: Body, fwd: Body) -> R<Obj> {
        let text = m::text(text, "messages")?;
        let reply_to = message_id(reply_to, "reply_to")?;
        let thread = message_id(thread, "thread")?;
        let mentioned = mentions(mentioned)?;
        let also = m::flag(also_channel, "also_channel")?;
        let link = link_preview(link)?;
        let fwd = parity::fwd(fwd)?;
        if also && thread.is_none() {
            return bad("also_channel is only for a thread reply");
        }
        let cid = pj::str_or(cid);
        let mut st = self.st.lock();
        let r = (|| -> R<Obj> {
            st.session(session, who)?;
            let cid = st.member_channel(&cid, &who.principal, true)?;
            st.ce_plain(None, Some(&cid))?;
            // strictly after the channel's last message: read marks and `after` compare ts
            let now = pj::now().max(st.last_ts(&cid) + 1e-6);
            let mut msg = obj([
                ("id", Value::from(pj::token_hex(8))),
                ("channel", Value::from(cid.clone())),
                ("from", Value::from(who.principal.clone())),
                ("from_name", Value::from(who.name.clone())),
                ("from_org", st.org(&who.principal)),
                ("text", Value::from(text.clone())),
                ("ts", f(now)),
                ("rts", Value::from((now * 1000.0) as i64)),
                ("reactions", Value::Object(Obj::new())),
            ]);
            if let Some(id) = &reply_to {
                let i = st.channel_index(&cid, id)?;
                let target = &st.channel_msgs[&cid][i];
                msg.insert("reply_to".into(), Value::Object(preview(target, target.get("from_name"))?));
            }
            let members = members_of(st.channel(&cid));
            let kept: Vec<String> = mentioned.iter().filter(|p| members.contains(p) && **p != who.principal).cloned().collect();
            if !kept.is_empty() {
                msg.insert("mentions".into(), Value::Array(kept.into_iter().map(Value::from).collect()));
            }
            if let Some(id) = &thread {
                let i = st.channel_index(&cid, id)?;
                msg.insert("thread".into(), Value::from(thread_id(&st.channel_msgs[&cid][i])));
                if also {
                    msg.insert("also_channel".into(), Value::Bool(true));
                }
            }
            if let Some(p) = &link {
                msg.insert("preview".into(), Value::Object(p.clone()));
            }
            if let Some(origin) = &fwd {
                msg.insert("fwd".into(), Value::Object(origin.clone()));
            }
            // the bridge: `bridged` on the message before anyone hears it
            st.bridge_chan_posted(&cid, &mut msg);
            let msgs = st.channel_msgs.entry(cid.clone()).or_default();
            msgs.push(msg.clone());
            if thread.is_some() {
                recount(msgs, &pj::text_of(&msg, "thread"));
            }
            if msgs.len() > CHANNEL_KEEP {
                let cut = msgs.len() - CHANNEL_KEEP;
                msgs.drain(..cut);
            }
            st.channel_mut(&cid).insert("last".into(), f(now));
            st.dirty = true;
            st.tell(&members, &obj([("type", Value::from("channel_message")), ("message", Value::Object(msg.clone()))]), Some(session));
            st.pu_message(Some(cid.as_str()), None, &msg);
            // AC-2a 9.2: one chat message relayed.
            crate::fleet_probe::counters().message(1);
            Ok(msg)
        })();
        drop(st);
        self.wake();
        let out = r?;
        log_info(&format!(
            "channel_post id={} principal={} chars={} thread={}",
            pj::text_of(&out, "channel"),
            who.principal,
            pj::char_len(&text),
            if thread.is_some() { "yes" } else { "no" }
        ));
        Ok(out)
    }

    /// channel_history (`GET /v1/channels/history`): `{channel, messages}`: the main conversation after `after`
    /// (thread replies only when also sent to the channel), oldest first, at most `limit`; with `thread` (a root id)
    /// that root first, then its replies.
    pub fn channel_history(&self, session: &str, who: &Identity, cid: &str, after: &str, thread: &str, limit: &str) -> R<Obj> {
        let after = m::number(Some(&Value::from(after)), "after")?;
        let limit = (m::number(Some(&Value::from(limit)), "limit")?.trunc() as i64).clamp(1, CHANNEL_LIMIT_MAX) as usize;
        let thread = message_id(Some(&Value::from(thread)), "thread")?;
        let mut st = self.st.lock();
        st.session(session, who)?;
        let cid = st.member_channel(cid, &who.principal, false)?;
        let empty = Vec::new();
        let msgs = st.channel_msgs.get(&cid).unwrap_or(&empty);
        let rows: Vec<Obj> = match &thread {
            Some(root) => thread_view(msgs, root, after, limit)?,
            None => {
                let main: Vec<&Obj> = msgs.iter().filter(|m| pj::num(m, "ts") > after && (!pj::truthy(m.get("thread")) || pj::truthy(m.get("also_channel")))).collect();
                main[main.len().saturating_sub(limit)..].iter().map(|m| (*m).clone()).collect()
            }
        };
        let view = st.channel_view(&cid, &who.principal);
        Ok(obj([("channel", Value::Object(view)), ("messages", Value::Array(rows.into_iter().map(Value::Object).collect()))]))
    }

    /// channel_read_mark (`POST /v1/channels/read`): mark a channel read up to `ts` (a mark never moves back).
    pub fn channel_read_mark(&self, session: &str, who: &Identity, cid: Body, ts: Body) -> R<Obj> {
        let ts = m::number(ts, "ts")?;
        let cid = pj::str_or(cid);
        let mut st = self.st.lock();
        st.session(session, who)?;
        let cid = st.member_channel(&cid, &who.principal, false)?;
        let mark = as_obj(st.channel_read.get(&who.principal)).and_then(|o| pj::as_num(o.get(&cid))).unwrap_or(0.0);
        if ts > mark {
            st.mark_read(std::slice::from_ref(&who.principal), &cid, ts);
            st.dirty = true;
            // NT-1: the reader's other sessions clear that conversation's notifications
            st.tell(std::slice::from_ref(&who.principal), &obj([("type", Value::from("read")), ("conv", Value::from(format!("channel:{cid}")))]), Some(session));
            drop(st);
            self.wake();
        }
        Ok(obj([("ok", Value::Bool(true))]))
    }

    /// pin (`POST /v1/pins`): pin (`on`) or unpin a message of a conversation the caller is in. Everyone in it hears a
    /// `chat_update` with `pinned` (and the current `text`). Answers the message, `pinned` `{by, ts}` or null.
    #[allow(clippy::too_many_arguments)]
    pub fn pin(&self, who: &Identity, scope: &str, id: &str, on: Body, session: Option<String>, peer: Option<String>, with_: Option<String>, channel: Option<String>) -> R<Obj> {
        let Some(Value::Bool(on)) = on else { return bad("on must be true or false") };
        let on = *on;
        let mut st = self.st.lock();
        let r = (|| -> R<Obj> {
            let c = Self::conversation(&st, who, scope, peer.as_deref(), session.as_deref(), with_.as_deref(), channel.as_deref(), true)?;
            // encrypted: a signed `pin` event (/v1/chat/event)
            st.ce_plain_in(&c)?;
            let i = Self::scoped_index(&st, who, &c, id)?;
            let list = Self::conv_list_mut(&mut st, who, &c).expect("the message's conversation");
            if pj::truthy(list[i].get("deleted")) {
                return bad("that message was deleted");
            }
            let mut event: Option<Obj> = None;
            if on != pj::truthy(list[i].get("pinned")) {
                if on {
                    if list.iter().filter(|m| pj::truthy(m.get("pinned"))).count() >= PINS_MAX {
                        return bad(format!("a conversation keeps at most {PINS_MAX} pinned messages"));
                    }
                    list[i].insert("pinned".into(), Value::Object(obj([("by", Value::from(who.principal.clone())), ("ts", f(pj::now()))])));
                } else {
                    // null, so a copy elsewhere learns it too
                    list[i].insert("pinned".into(), Value::Null);
                }
                let target = &list[i];
                event = Some(obj([
                    ("type", Value::from("chat_update")),
                    ("scope", Value::from(scope)),
                    ("id", Value::from(id)),
                    ("text", Value::from(pj::s(target, "text"))),
                    ("pinned", target.get("pinned").cloned().unwrap_or(Value::Null)),
                    ("by", Value::from(who.principal.clone())),
                ]));
            }
            let mut out = list[i].clone();
            if let Some(event) = event {
                st.dirty = true;
                Self::tell_conversation(&mut st, who, &c, &event);
                log_info(&format!("pin scope={scope} principal={} on={}", who.principal, if on { "True" } else { "False" }));
            }
            if !out.contains_key("pinned") {
                out.insert("pinned".into(), Value::Null);
            }
            Ok(out)
        })();
        drop(st);
        self.wake();
        r
    }

    /// pins (`GET /v1/pins`): `{messages}`: the pinned messages of a conversation the caller is in, the latest pin
    /// first.
    pub fn pins(&self, who: &Identity, scope: &str, session: Option<String>, peer: Option<String>, with_: Option<String>, channel: Option<String>) -> R<Obj> {
        let st = self.st.lock();
        let c = Self::conversation(&st, who, scope, peer.as_deref(), session.as_deref(), with_.as_deref(), channel.as_deref(), false)?;
        let room = matches!(c, Conv::Room { .. });
        let mut pinned: Vec<Obj> = Self::conv_list(&st, who, &c)
            .into_iter()
            .flatten()
            .filter(|m| (!room || pj::text_of(m, "kind") == "chat") && pj::truthy(m.get("pinned")) && !pj::truthy(m.get("deleted")))
            .cloned()
            .collect();
        drop(st);
        let at = |m: &Obj| m.get("pinned").and_then(|p| pj::as_num(p.get("ts"))).unwrap_or(0.0);
        pinned.sort_by(|a, b| at(b).partial_cmp(&at(a)).unwrap_or(std::cmp::Ordering::Equal));
        Ok(obj([("messages", Value::Array(pinned.into_iter().map(Value::Object).collect()))]))
    }

    /// search (`GET /v1/search`): messages of the caller's channels and direct messages that hold every word of `q`
    /// (whole words, any case), newest first. Deleted messages have no words; other people's conversations are never
    /// looked at.
    pub fn search(&self, session: &str, who: &Identity, q: &str, limit: &str) -> R<Obj> {
        let query = q.trim();
        if pj::char_len(query) > SEARCH_QUERY_MAX {
            return bad(format!("a search is at most {SEARCH_QUERY_MAX} characters"));
        }
        let wanted_words = words(query);
        if wanted_words.is_empty() {
            return bad("say what to look for");
        }
        let limit = (m::number(Some(&Value::from(limit)), "limit")?.trunc() as i64).clamp(1, SEARCH_MAX) as usize;
        let me = who.principal.as_str();
        let mut hits: Vec<Obj> = Vec::new();
        let hit = |m: &Obj, mut row: Obj, hits: &mut Vec<Obj>| {
            let text = pj::s(m, "text");
            // search never looks into an encrypted row
            if pj::truthy(m.get("deleted")) || m.contains_key("enc") {
                return;
            }
            let holds = |t: &str| {
                let have = words(t);
                wanted_words.iter().all(|w| have.contains(w))
            };
            // else the transcript of one of its voice or video clips (parity wave B), the excerpt then from it
            let source = if holds(&text) {
                text.as_str()
            } else {
                let mut clips = m.get("files").and_then(Value::as_array).into_iter().flatten().filter_map(|f| f.get("clip")?.get("tx")?.as_str());
                let Some(tx) = clips.find(|tx| holds(tx)) else { return };
                tx
            };
            row.insert("id".into(), m.get("id").cloned().unwrap_or(Value::Null));
            row.insert("from".into(), m.get("from").cloned().unwrap_or(Value::Null));
            row.insert("from_name".into(), m.get("from_name").cloned().unwrap_or(Value::Null));
            row.insert("ts".into(), m.get("ts").cloned().unwrap_or(Value::Null));
            row.insert("excerpt".into(), Value::from(excerpt(source, &wanted_words[0])));
            if pj::truthy(m.get("thread")) {
                row.insert("thread".into(), m["thread"].clone());
            }
            if let Some(src @ Value::Object(_)) = m.get("src") {
                // a bridged message: shown by its real sender
                row.insert("src".into(), src.clone());
            }
            hits.push(row);
        };
        let st = self.st.lock();
        st.session(session, who)?;
        for (cid, ch) in st.channels.iter() {
            if !members_of(ch.as_object()).iter().any(|p| p == me) {
                continue;
            }
            for m in st.channel_msgs.get(cid).into_iter().flatten() {
                hit(m, obj([("scope", Value::from("channel")), ("channel", Value::from(cid.clone()))]), &mut hits);
            }
        }
        for (key, msgs) in st.dms.iter() {
            if !key.split(' ').any(|p| p == me) {
                continue;
            }
            for m in msgs {
                let other = if m.get("from").and_then(Value::as_str) == Some(me) { m.get("to") } else { m.get("from") };
                hit(m, obj([("scope", Value::from("dm")), ("with", other.cloned().unwrap_or(Value::Null))]), &mut hits);
            }
        }
        drop(st);
        let at = |h: &Obj| if pj::truthy(h.get("ts")) { pj::num(h, "ts") } else { 0.0 };
        hits.sort_by(|a, b| at(b).partial_cmp(&at(a)).unwrap_or(std::cmp::Ordering::Equal));
        log_info(&format!("search principal={me} words={} hits={}", wanted_words.len(), hits.len()));
        Ok(obj([("hits", Value::Array(hits.into_iter().take(limit).map(Value::Object).collect()))]))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_words_and_excerpts_follow_python() {
        assert_eq!(words("BUDGET numbers, budgeting_2"), vec!["budget", "numbers", "budgeting_2"]);
        assert_eq!(excerpt("  short   text ", "short"), "short text");
        let long = format!("{} needle {}", "a".repeat(200), "b".repeat(200));
        let got = excerpt(&long, "needle");
        assert!(got.starts_with("...") && got.ends_with("...") && got.contains("needle"));
        assert_eq!(got.chars().count(), EXCERPT_MAX + 6);
    }

    #[test]
    fn search_finds_a_clip_by_its_transcript() {
        use serde_json::json;
        let h = Hub::new(None, &[], 168.0, 30.0, 365.0, None, Arc::new(LinkStats::new()));
        let ann = Identity { principal: "ann@x".into(), name: "Ann".into(), device: "aaaaaaaaaaaaaaaa".into(), ..Default::default() };
        let s = h.hello(&ann, "", &Obj::new()).unwrap()["session"].as_str().unwrap().to_string();
        {
            let o = |v: serde_json::Value| v.as_object().unwrap().clone();
            let mut st = h.st.lock();
            st.channels.insert("c-01".into(), json!({"id": "c-01", "kind": "public", "name": "general", "members": ["ann@x"]}));
            st.channel_msgs.insert(
                "c-01".into(),
                vec![
                    o(json!({"id": "m1", "from": "ann@x", "from_name": "Ann", "text": "", "ts": 1.0, "files": [{"id": "f", "clip": {"k": "a", "d": 1000, "w": "", "tx": "the quarterly budget review"}}]})),
                    o(json!({"id": "m2", "from": "ann@x", "from_name": "Ann", "text": "budget", "ts": 2.0})),
                ],
            );
        }
        let found = h.search(&s, &ann, "Quarterly budget", "50").unwrap();
        let hits = found["hits"].as_array().unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!((hits[0]["id"].clone(), hits[0]["excerpt"].clone()), (json!("m1"), json!("the quarterly budget review")));
        // the text when it holds every word, else a transcript: newest first
        let both = h.search(&s, &ann, "budget", "50").unwrap();
        assert_eq!(both["hits"].as_array().unwrap().iter().map(|r| r["id"].clone()).collect::<Vec<_>>(), [json!("m2"), json!("m1")]);
    }

    #[test]
    fn a_group_id_is_the_member_set() {
        let a = group_id(&["b@x".to_string(), "a@x".to_string(), "c@x".to_string()]);
        assert_eq!(a, group_id(&["c@x".to_string(), "a@x".to_string(), "b@x".to_string()]));
        assert!(a.starts_with("g-") && a.len() == 22);
    }

    #[test]
    fn link_previews_are_https_and_capped() {
        let p = link_preview(Some(&serde_json::json!({"url": "https://e.test/a", "title": "T".repeat(400), "extra": 1}))).unwrap().unwrap();
        assert_eq!(p["title"].as_str().unwrap().len(), PREVIEW_FIELD_MAX);
        assert_eq!(p["description"], serde_json::json!(""));
        assert!(link_preview(Some(&serde_json::json!({"url": "http://e.test/"}))).is_err());
        assert!(link_preview(Some(&serde_json::json!("https://e.test/"))).is_err());
    }

    #[test]
    fn a_thread_root_counts_its_replies() {
        let mut msgs: Vec<Obj> = vec![
            serde_json::json!({"id": "r", "from": "a", "ts": 1.0}).as_object().unwrap().clone(),
            serde_json::json!({"id": "x", "from": "b", "ts": 2.0, "thread": "r"}).as_object().unwrap().clone(),
            serde_json::json!({"id": "y", "from": "c", "ts": 3.0, "thread": "r", "deleted": 4.0}).as_object().unwrap().clone(),
        ];
        recount(&mut msgs, "r");
        assert_eq!((msgs[0]["replies"].clone(), msgs[0]["last_reply"].clone(), msgs[0]["repliers"].clone()), (serde_json::json!(1), serde_json::json!(2.0), serde_json::json!(["b"])));
        let view = thread_view(&msgs, "x", 0.0, 200).unwrap();
        assert_eq!(view.iter().map(|m| pj::text_of(m, "id")).collect::<Vec<_>>(), ["r", "x", "y"]);
        assert!(thread_view(&msgs, "nope", 0.0, 200).is_err());
    }

    #[test]
    fn bridged_repliers_are_external_people() {
        let o = |v: serde_json::Value| v.as_object().unwrap().clone();
        let src = |user: &str, name: &str| serde_json::json!({"platform": "slack", "link": "l", "user": user, "name": name, "org": {"id": "o", "label": "O"}, "msg": "1", "url": ""});
        let mut msgs: Vec<Obj> = vec![
            o(serde_json::json!({"id": "r", "from": "a@x", "ts": 1.0})),
            o(serde_json::json!({"id": "m", "from": "a@x", "ts": 2.0, "thread": "r"})),
            o(serde_json::json!({"id": "p", "from": "bridge@b", "ts": 3.0, "thread": "r", "src": src("U1", "Bob")})),
            o(serde_json::json!({"id": "q", "from": "bridge@b", "ts": 4.0, "thread": "r", "src": src("U2", "Cy")})),
            o(serde_json::json!({"id": "s", "from": "bridge@b", "ts": 5.0, "thread": "r", "src": src("U1", "Bob")})),
        ];
        recount(&mut msgs, "r");
        assert_eq!(msgs[0]["repliers"], serde_json::json!(["ext:slack:U1", "ext:slack:U2", "a@x"]));
        assert_eq!(msgs[0]["replier_names"], serde_json::json!({"ext:slack:U1": "Bob", "ext:slack:U2": "Cy"}));
        for m in msgs.iter_mut().skip(2) {
            m.insert("deleted".into(), serde_json::json!(6.0));
        }
        recount(&mut msgs, "r");
        assert_eq!((msgs[0]["repliers"].clone(), msgs[0]["replier_names"].clone()), (serde_json::json!(["a@x"]), serde_json::json!({})));
        // member-only threads never get replier_names
        let mut plain = vec![o(serde_json::json!({"id": "r", "from": "a@x", "ts": 1.0})), o(serde_json::json!({"id": "m", "from": "b@x", "ts": 2.0, "thread": "r"}))];
        recount(&mut plain, "r");
        assert!(!plain[0].contains_key("replier_names"));
    }
}
