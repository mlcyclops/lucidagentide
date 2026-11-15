// Parity wave C (contract PC-1 section 2, meet_relay._ParityC): shared documents (canvases and lists) of a channel,
// group chat or direct conversation. Persisted in ext["pc"]["docs"] exactly as the Python relay keeps it:
// `{key: {docs: {doc: {by, created, updated, seq, count, snap_at, rows, deleted?}}, epochs: {}}}`, keys
// `ch:<channel id>` or `dm:<sorted pair joined by a space>`. A child module of meet_hub: it shares the one lock.

use super::ce;
use super::channels::members_of;
use super::*;

/// Doc posts a second per sender per conversation.
const DOC_RATE: usize = 8;
/// Docaware a second per sender per conversation.
const AWARE_RATE: usize = 2;
/// Doc rows per docsnap of one document.
const SNAP_EVERY: i64 = 200;
/// Doc updates per epoch of one conversation.
const DOC_EPOCH_MAX: i64 = 50000;
const DOC_EPOCHS_KEPT: usize = 8;
/// A plain (bridgeable) payload, as CE-1's cap.
const DOC_PAYLOAD_MAX: usize = 65535;
const DOCS_LIMIT: i64 = 500;
const DOCS_SCOPE: &str = "canvases and lists are not in call chat";
const DOC_BUSY: &str = "too many canvas updates; wait a moment";
const AWARE_BUSY: &str = "too many cursor updates; wait a moment";
const ONE_SNAPSHOT: &str = "one snapshot per 200 updates";
const DOC_EPOCH: &str = "this conversation reached 50000 canvas updates in this key period; start a new one";
const DOC_DELETE_WHO: &str = "only the person who made this canvas or an admin of this conversation can delete it";
const DOC_GONE: &str = "that canvas is not here";
const DOC_DELETED: &str = "this canvas was deleted";
const DOC_KINDS: [&str; 2] = ["doc", "docsnap"];

type Hits = HashMap<(String, String), VecDeque<f64>>;

/// In memory: each sender's recent doc and docaware posts per conversation (monotonic times).
#[derive(Default)]
pub struct DocsRate {
    doc: Hits,
    aware: Hits,
}

/// _pc_rate: at most `most` a second (429).
fn rate(hits: &mut Hits, key: (String, String), most: usize, words: &str) -> R<()> {
    let now = pj::mono();
    let q = hits.entry(key).or_default();
    while q.front().map(|t| now - t >= 1.0).unwrap_or(false) {
        q.pop_front();
    }
    if q.len() >= most {
        return Err(E::Status(429, words.into(), false));
    }
    q.push_back(now);
    Ok(())
}

/// _pc_doc_id.
fn doc_id(v: Option<&Value>) -> R<String> {
    match v {
        Some(Value::String(s)) if ce::is_mid(s) => Ok(s.clone()),
        _ => bad("doc must be a document id (32 hex)"),
    }
}

/// `enc` / `body` as Python's `x is not None` sees them (JSON null is None).
fn given(v: Option<&Value>) -> Option<&Value> {
    v.filter(|v| !v.is_null())
}

fn now_ms() -> i64 {
    (pj::now() * 1000.0) as i64
}

/// The sort key of an epoch (`int(k) if k.isdigit() else 0`).
fn epoch_rank(k: &str) -> i128 {
    if !k.is_empty() && k.bytes().all(|c| c.is_ascii_digit()) {
        k.parse().unwrap_or(i128::MAX)
    } else {
        0
    }
}

fn rows_of(d: &Obj) -> Vec<Obj> {
    d.get("rows").and_then(Value::as_array).map(|l| l.iter().filter_map(Value::as_object).cloned().collect()).unwrap_or_default()
}

/// A document's conversation (_pc_doc_where): its docs key, channel, the other person and the people in it.
struct Where {
    key: String,
    cid: Option<String>,
    people: Vec<String>,
    conv: Conv,
}

impl State {
    fn pc_doc_where(&mut self, who: &Identity, scope: &str, session: Option<&str>, with_: Option<&str>, channel: Option<&str>, writing: bool) -> R<Where> {
        if scope == "room" {
            return bad(DOCS_SCOPE);
        }
        if scope != "dm" && scope != "channel" {
            return bad(SCOPE_ERROR);
        }
        let c = Hub::conversation(self, who, scope, None, session, with_, channel, writing)?;
        match c {
            Conv::Channel(cid) => {
                let people = members_of(self.channel(&cid));
                Ok(Where { key: format!("ch:{cid}"), cid: Some(cid.clone()), people, conv: Conv::Channel(cid) })
            }
            Conv::Dm(other) => {
                if !self.directory.contains_key(&other) && other != who.principal && self.pc_dm_peer(who, &other)?.is_none() {
                    return Err(E::NotFound("nobody with that address has used this relay yet".into()));
                }
                Ok(Where { key: format!("dm:{}", conv(&who.principal, &other)), cid: None, people: vec![who.principal.clone(), other.clone()], conv: Conv::Dm(other) })
            }
            Conv::Room { .. } => bad(DOCS_SCOPE),
        }
    }

    fn pc_docs_map(&mut self) -> &mut Obj {
        obj_mut(self.pc_part(), "docs")
    }

    /// _pc_doc_conv: `{docs, epochs}` of a conversation, made sound.
    fn pc_doc_conv(&mut self, key: &str) -> &mut Obj {
        let convs = self.pc_docs_map();
        let sound = convs.get(key).and_then(Value::as_object).map(|c| c.get("docs").map(Value::is_object).unwrap_or(false)).unwrap_or(false);
        if !sound {
            convs.insert(key.to_string(), Value::Object(obj([("docs", Value::Object(Obj::new())), ("epochs", Value::Object(Obj::new()))])));
        }
        convs.get_mut(key).and_then(Value::as_object_mut).expect("a docs conversation")
    }

    /// _pc_doc_body: `(kind, {enc} or {kind, body})`: an envelope in an encrypted conversation, a plain payload only
    /// in a bridgeable one.
    #[allow(clippy::too_many_arguments)]
    fn pc_doc_body(&mut self, cid: Option<&str>, enc: Option<&Value>, body: Option<&Value>, kinds: &[&str], ref_: &str, who: &Identity, kind: Option<&Value>) -> R<(String, Obj)> {
        let bridgeable = cid.map(|c| pj::truthy(self.channel(c).and_then(|o| o.get("bridgeable")))).unwrap_or(false);
        if let Some(enc) = given(enc) {
            if bridgeable {
                return bad(ce::NOT_E2EE);
            }
            let head = self.ce_head(cid)?;
            let env = ce::envelope(Some(enc), kinds, ref_, who, head)?;
            return Ok((pj::text_of(&env, "k"), obj([("enc", Value::Object(env))])));
        }
        if !bridgeable {
            return Err(E::Conflict(ce::PLAIN.into()));
        }
        if kinds == ["delete"] {
            return Ok(("delete".into(), Obj::new()));
        }
        let Some(body) = given(body).filter(|b| b.is_object()) else { return bad("body must be the plain payload (an object)") };
        if pj::dumps_compact(body).len() > DOC_PAYLOAD_MAX {
            return bad("a canvas payload is at most 65535 bytes");
        }
        let many = kinds.len() > 1;
        let out_kind = if many { kind.and_then(Value::as_str).filter(|k| kinds.contains(k)) } else { Some(kinds[0]) };
        let Some(out_kind) = out_kind else { return bad(format!("kind must be {}", kinds.join(" or "))) };
        let payload = if many { obj([("kind", Value::from(out_kind)), ("body", body.clone())]) } else { obj([("body", body.clone())]) };
        Ok((out_kind.to_string(), payload))
    }

    /// _pc_canvas_keep_s: how long a document lives after its last change by the signed `canvas` retention; None
    /// (`canvas: 0`): while its conversation exists.
    fn pc_canvas_keep_s(&mut self, people: &[String]) -> Option<f64> {
        let policies = self.pc_current();
        let persons: Vec<&String> = people.iter().filter(|p| pc::service_kind(p).is_empty()).collect();
        if policies.is_empty() || persons.is_empty() {
            return None;
        }
        let mut best = 0.0f64;
        for p in persons {
            let days = pc::covering(&policies, p).and_then(|policy| policy.get("retention").and_then(Value::as_object).and_then(|r| pj::as_num(r.get("canvas"))));
            match days {
                Some(d) if d != 0.0 => best = best.max(d * 86400.0),
                _ => return None,
            }
        }
        Some(best)
    }

    /// _pc_docs_prune: documents go with their conversation (a DM's after its retention), or after the signed
    /// `canvas` days; deleted ones' markers after the retention. Then the idle rate counters go.
    pub(crate) fn pc_docs_prune(&mut self, now: f64) {
        let keys: Vec<String> = self.pc_docs_map().keys().cloned().collect();
        for key in keys {
            let (scope, rest) = key.split_once(':').unwrap_or((key.as_str(), ""));
            let (exists, people, cap, cid) = if scope == "ch" {
                let ch = self.channel(rest);
                (ch.is_some(), members_of(ch), self.channel_s, key.clone())
            } else {
                let people: Vec<String> = rest.split(' ').map(str::to_string).collect();
                let cid = if people.len() == 2 { ce::dm_cid(&people[0], &people[1]) } else { String::new() };
                (self.dms.contains_key(rest), people, self.mail_s, cid)
            };
            let is_ch = scope == "ch";
            let sound = self.pc_docs_map().get(&key).and_then(Value::as_object).map(|c| c.get("docs").map(Value::is_object).unwrap_or(false)).unwrap_or(false);
            if !sound {
                self.pc_docs_map().shift_remove(&key);
                continue;
            }
            let keep = self.pc_canvas_keep_s(&people);
            let gone: Vec<String> = {
                let docs = self.pc_doc_conv(&key).get("docs").and_then(Value::as_object).expect("docs");
                docs.iter()
                    .filter(|(_, d)| {
                        let d = d.as_object();
                        let age = now - pc::pc_int(d.and_then(|d| d.get("updated"))) as f64 / 1000.0;
                        if pj::truthy(d.and_then(|d| d.get("deleted"))) {
                            !exists || age > cap
                        } else {
                            (!exists && (is_ch || age > cap)) || keep.map(|k| age > k).unwrap_or(false)
                        }
                    })
                    .map(|(k, _)| k.clone())
                    .collect()
            };
            for doc in gone {
                let d = obj_mut(self.pc_doc_conv(&key), "docs").shift_remove(&doc);
                let rows = d.as_ref().and_then(Value::as_object).map(rows_of).unwrap_or_default();
                self.pc_hold_items(&cid, "doc", &rows, None, Some(&people));
                self.dirty = true;
            }
            if obj_mut(self.pc_doc_conv(&key), "docs").is_empty() {
                self.pc_docs_map().shift_remove(&key);
            }
        }
        let mono = pj::mono();
        for hits in [&mut self.pc_docs.doc, &mut self.pc_docs.aware] {
            hits.retain(|_, q| q.back().map(|t| mono - t < 1.0).unwrap_or(false));
        }
    }
}

impl Hub {
    /// `POST /v1/docs/post {scope, with|channel, doc, id, enc}` (a `doc` or `docsnap` envelope, ref `doc:<doc>`), or
    /// `{..., kind, body}` in a bridgeable conversation: a row of the document (`seq` contiguous per document), heard
    /// as `doc_update` by everyone in the conversation. At most 8 a second per sender, one snapshot per 200 updates,
    /// 50000 updates per epoch.
    #[allow(clippy::too_many_arguments)]
    pub fn pc_docs_post(&self, who: &Identity, scope: &str, doc: Option<&Value>, id: Option<&Value>, enc: Option<&Value>, kind: Option<&Value>, body: Option<&Value>, session: Option<String>, with_: Option<String>, channel: Option<String>) -> R<Obj> {
        let doc = doc_id(doc)?;
        let mid = ce::mid_of(id, "id")?;
        let mut st = self.st.lock();
        let r = (|| -> R<(Obj, String)> {
            let w = st.pc_doc_where(who, scope, session.as_deref(), with_.as_deref(), channel.as_deref(), true)?;
            let (got, payload) = st.pc_doc_body(w.cid.as_deref(), enc, body, &DOC_KINDS, &format!("doc:{doc}"), who, kind)?;
            if got == "doc" {
                rate(&mut st.pc_docs.doc, (who.principal.clone(), w.key.clone()), DOC_RATE, DOC_BUSY)?;
            }
            let now = now_ms();
            let conv = st.pc_doc_conv(&w.key);
            let (count, snap_at) = {
                let docs = conv.get("docs").and_then(Value::as_object).expect("docs");
                match docs.get(&doc).and_then(Value::as_object) {
                    Some(d) => {
                        if pj::truthy(d.get("deleted")) {
                            return Err(E::Conflict(DOC_DELETED.into()));
                        }
                        if rows_of(d).iter().any(|r| r.get("id").and_then(Value::as_str) == Some(mid.as_str())) {
                            return Err(E::Conflict("a message with that id is already kept".into()));
                        }
                        (pc::pc_int(d.get("count")), pc::pc_int(d.get("snap_at")))
                    }
                    None if got == "docsnap" => return Err(E::NotFound(DOC_GONE.into())),
                    None => (0, 0),
                }
            };
            if got == "docsnap" {
                if count - snap_at < SNAP_EVERY {
                    return Err(E::Conflict(ONE_SNAPSHOT.into()));
                }
            } else {
                let epoch = payload.get("enc").and_then(Value::as_object).and_then(|e| e.get("e")).map(pj::py_str).unwrap_or_else(|| "0".into());
                let epochs = obj_mut(conv, "epochs");
                let n = pc::pc_int(epochs.get(&epoch));
                if n >= DOC_EPOCH_MAX {
                    return Err(E::Conflict(DOC_EPOCH.into()));
                }
                epochs.insert(epoch, Value::from(n + 1));
                let mut order: Vec<(i128, String)> = epochs.keys().map(|k| (epoch_rank(k), k.clone())).collect();
                order.sort_by_key(|(n, _)| *n);
                let drop_n = order.len().saturating_sub(DOC_EPOCHS_KEPT);
                for (_, k) in order.into_iter().take(drop_n) {
                    epochs.shift_remove(&k);
                }
            }
            let docs = obj_mut(conv, "docs");
            if !docs.get(&doc).map(Value::is_object).unwrap_or(false) {
                let fresh = obj([
                    ("by", Value::from(who.principal.clone())),
                    ("created", Value::from(now)),
                    ("updated", Value::from(now)),
                    ("seq", Value::from(0)),
                    ("count", Value::from(0)),
                    ("snap_at", Value::from(0)),
                    ("rows", Value::Array(Vec::new())),
                ]);
                docs.insert(doc.clone(), Value::Object(fresh));
            }
            let d = docs.get_mut(&doc).and_then(Value::as_object_mut).expect("the document");
            if got == "docsnap" {
                d.insert("snap_at".into(), Value::from(count));
            } else {
                d.insert("count".into(), Value::from(count + 1));
            }
            let seq = pc::pc_int(d.get("seq")) + 1;
            d.insert("seq".into(), Value::from(seq));
            let mut row = obj([("seq", Value::from(seq)), ("id", Value::from(mid.clone())), ("doc", Value::from(doc.clone())), ("from", Value::from(who.principal.clone())), ("ts", Value::from(now))]);
            row.extend(payload);
            let rows = d.entry("rows").or_insert_with(|| Value::Array(Vec::new()));
            if !rows.is_array() {
                *rows = Value::Array(Vec::new());
            }
            rows.as_array_mut().expect("rows").push(Value::Object(row.clone()));
            d.insert("updated".into(), Value::from(now));
            st.dirty = true;
            let event = obj([("type", Value::from("doc_update")), ("scope", Value::from(scope)), ("doc", Value::from(doc.clone())), ("row", Value::Object(row.clone()))]);
            Self::tell_conversation(&mut st, who, &w.conv, &event);
            Ok((row, got))
        })();
        drop(st);
        self.wake();
        let (row, got) = r?;
        log_info(&format!("doc_post scope={scope} principal={} kind={got} seq={}", who.principal, pc::pc_int(row.get("seq"))));
        Ok(row)
    }

    /// `GET /v1/docs/history?scope&with|channel&doc&after&limit` -> `{rows, more}`: rows after `seq` `after`, ascending.
    #[allow(clippy::too_many_arguments)]
    pub fn pc_docs_history(&self, session: &str, who: &Identity, scope: &str, with_: Option<String>, channel: Option<String>, doc: &str, after: &str, limit: &str) -> R<Obj> {
        let doc = doc_id(Some(&Value::from(doc)))?;
        let mark = m::number(Some(&Value::from(after)), "after")? as i64;
        let most = (m::number(Some(&Value::from(limit)), "limit")? as i64).clamp(1, DOCS_LIMIT) as usize;
        let mut st = self.st.lock();
        let w = st.pc_doc_where(who, scope, Some(session), with_.as_deref(), channel.as_deref(), false)?;
        let docs = st.pc_doc_conv(&w.key).get("docs").and_then(Value::as_object).expect("docs");
        let d = match docs.get(&doc).and_then(Value::as_object) {
            Some(d) if !pj::truthy(d.get("deleted")) => d,
            _ => return Err(E::NotFound(DOC_GONE.into())),
        };
        let rows: Vec<Value> = d.get("rows").and_then(Value::as_array).map(|l| l.iter().filter(|r| pc::pc_int(r.get("seq")) > mark).cloned().collect()).unwrap_or_default();
        drop(st);
        let more = rows.len() > most;
        Ok(obj([("rows", Value::Array(rows.into_iter().take(most).collect())), ("more", Value::Bool(more))]))
    }

    /// `GET /v1/docs/list?scope&with|channel` -> `{docs: [{doc, by, created, updated, count}]}` (times in ms; `count`:
    /// its updates).
    pub fn pc_docs_list(&self, session: &str, who: &Identity, scope: &str, with_: Option<String>, channel: Option<String>) -> R<Obj> {
        let mut st = self.st.lock();
        let w = st.pc_doc_where(who, scope, Some(session), with_.as_deref(), channel.as_deref(), false)?;
        let docs = st.pc_doc_conv(&w.key).get("docs").and_then(Value::as_object).expect("docs");
        let field = |d: &Obj, k: &str| d.get(k).cloned().unwrap_or(Value::Null);
        let mut out: Vec<(i64, Value)> = docs
            .iter()
            .filter_map(|(doc, d)| d.as_object().map(|d| (doc, d)))
            .filter(|(_, d)| !pj::truthy(d.get("deleted")))
            .map(|(doc, d)| {
                let row = obj([("doc", Value::from(doc.clone())), ("by", field(d, "by")), ("created", field(d, "created")), ("updated", field(d, "updated")), ("count", field(d, "count"))]);
                (pc::pc_int(d.get("updated")), Value::Object(row))
            })
            .collect();
        drop(st);
        out.sort_by_key(|o| std::cmp::Reverse(o.0));
        Ok(obj([("docs", Value::Array(out.into_iter().map(|(_, v)| v).collect()))]))
    }

    /// `POST /v1/docs/aware`: a `docaware` envelope (cursors), relayed live as `doc_aware` and never stored, at most 2
    /// a second per sender.
    #[allow(clippy::too_many_arguments)]
    pub fn pc_docs_aware(&self, who: &Identity, scope: &str, doc: Option<&Value>, id: Option<&Value>, enc: Option<&Value>, body: Option<&Value>, session: Option<String>, with_: Option<String>, channel: Option<String>) -> R<Obj> {
        let doc = doc_id(doc)?;
        let mid = ce::mid_of(id, "id")?;
        let mut st = self.st.lock();
        let r = (|| -> R<()> {
            let w = st.pc_doc_where(who, scope, session.as_deref(), with_.as_deref(), channel.as_deref(), true)?;
            let (_, payload) = st.pc_doc_body(w.cid.as_deref(), enc, body, &["docaware"], &format!("doc:{doc}"), who, None)?;
            rate(&mut st.pc_docs.aware, (who.principal.clone(), w.key.clone()), AWARE_RATE, AWARE_BUSY)?;
            let mut event = obj([("type", Value::from("doc_aware")), ("scope", Value::from(scope)), ("doc", Value::from(doc.clone())), ("id", Value::from(mid.clone())), ("from", Value::from(who.principal.clone()))]);
            event.extend(payload);
            Self::tell_conversation(&mut st, who, &w.conv, &event);
            Ok(())
        })();
        drop(st);
        self.wake();
        r?;
        Ok(obj([("ok", Value::Bool(true))]))
    }

    /// `POST /v1/docs/delete`: the document's maker or an admin of the conversation deletes it (a `delete` envelope,
    /// ref `doc:<doc>`); its rows go (to the hold store when held) and everyone hears `doc_deleted`.
    #[allow(clippy::too_many_arguments)]
    pub fn pc_docs_delete(&self, who: &Identity, scope: &str, doc: Option<&Value>, id: Option<&Value>, enc: Option<&Value>, session: Option<String>, with_: Option<String>, channel: Option<String>) -> R<Obj> {
        let doc = doc_id(doc)?;
        let mid = ce::mid_of(id, "id")?;
        let mut st = self.st.lock();
        let r = (|| -> R<()> {
            let w = st.pc_doc_where(who, scope, session.as_deref(), with_.as_deref(), channel.as_deref(), false)?;
            let (by, created, seq, count, rows) = {
                let docs = st.pc_doc_conv(&w.key).get("docs").and_then(Value::as_object).expect("docs");
                match docs.get(&doc).and_then(Value::as_object) {
                    Some(d) if !pj::truthy(d.get("deleted")) => {
                        let field = |k: &str| d.get(k).cloned().unwrap_or(Value::Null);
                        (field("by"), field("created"), field("seq"), field("count"), rows_of(d))
                    }
                    _ => return Err(E::NotFound(DOC_GONE.into())),
                }
            };
            if by.as_str() != Some(who.principal.as_str()) {
                let admin = match &w.cid {
                    Some(cid) => st.ce_admins(cid).contains(&who.principal),
                    None => false,
                };
                if !admin {
                    return forbidden(DOC_DELETE_WHO);
                }
            }
            let (_, payload) = st.pc_doc_body(w.cid.as_deref(), enc, None, &["delete"], &format!("doc:{doc}"), who, None)?;
            let cid = match (&w.cid, &w.conv) {
                (Some(c), _) => format!("ch:{c}"),
                (None, Conv::Dm(other)) => ce::dm_cid(&who.principal, other),
                _ => String::new(),
            };
            st.pc_hold_items(&cid, "doc", &rows, None, Some(&w.people));
            let now = now_ms();
            let marker = obj([
                ("by", by),
                ("created", created),
                ("updated", Value::from(now)),
                ("seq", seq),
                ("count", count),
                ("snap_at", Value::from(0)),
                ("rows", Value::Array(Vec::new())),
                ("deleted", Value::from(now)),
            ]);
            obj_mut(st.pc_doc_conv(&w.key), "docs").insert(doc.clone(), Value::Object(marker));
            st.dirty = true;
            let mut event = obj([("type", Value::from("doc_deleted")), ("scope", Value::from(scope)), ("doc", Value::from(doc.clone())), ("id", Value::from(mid.clone())), ("from", Value::from(who.principal.clone()))]);
            event.extend(payload);
            Self::tell_conversation(&mut st, who, &w.conv, &event);
            Ok(())
        })();
        drop(st);
        self.wake();
        r?;
        log_info(&format!("doc_delete scope={scope} principal={}", who.principal));
        Ok(obj([("ok", Value::Bool(true)), ("doc", Value::from(doc))]))
    }
}
