// AI-1 (docs/ai/contract.md 2, 6.4, 6.6, 7.1, 7.4, 7.6), the relay's part (meet_relay._AiOne): who may use org AI
// (the SSO service's `ai-groups` records and `/v1/ai/allowed`), the personal-access audit (`/v1/ai/audit`) and each
// person's `ai:` conversation (AI history, CE-1 revision 8): only kinds `ai` and `delete`, written only by that
// person's devices, read by them and by the archive device of every org policy covering them. The AI maps' store lives
// with the org policies (meet_parity_c). A child module of meet_hub: it shares the hub's one lock. Persisted in
// state.json as the Python keeps it: `ext["ai"]` = {v, maps: [signed AI maps], groups: {org: {principal: {provider,
// listed, read_at}}}, audit: [records + by + device + rts], history: {cid: {principal, rows}}}.

use super::*;
use crate::meet_org_policy as op;

const CID_LABEL: &[u8] = b"lucid-meet-ai-history-v1";
/// Rows kept per `ai:` conversation (the oldest go).
const HISTORY_KEEP: usize = 5000;
/// Rows one `GET /v1/ai/history` answers.
pub const HISTORY_LIMIT: i64 = 500;
/// Audit records kept (the oldest go).
const AUDIT_MAX: usize = 10000;
/// Audit records one `GET /v1/admin/ai/audit` answers.
const AUDIT_PAGE: usize = 1000;
const AUDIT_PERSONAL: [&str; 11] = ["v", "rid", "ts", "provider", "method", "plan", "class", "model", "tokens_in", "tokens_out", "tier"];
const AUDIT_DROPPED: [&str; 5] = ["v", "rid", "ts", "event", "reason"];
const AUDIT_METHODS: [&str; 2] = ["key", "oauth"];
const AUDIT_PLANS: [&str; 3] = ["business", "not_business", "unknown"];
const AUDIT_TEXT_MAX: usize = 128;
const REASON_MAX: usize = 500;
const MAX: i64 = (1 << 53) - 1;
pub const AI_NOT_FOUND: &str = "not found";
pub const AI_NOT_YOURS: &str = "that AI history belongs to someone else";
pub const AI_ARCHIVE_WRAP: &str = "The organization's archive must be able to read the AI history.";
pub const AI_APP_NEVER: &str = "an AI gateway is never in a conversation";
const AI_PEOPLE_ONLY: &str = "only a person's own device can do that";
const AI_AUDIT_SHAPE: &str =
    "an AI audit record is {v, rid, ts, provider, method, plan, class, model, tokens_in, tokens_out, tier} or {v, rid, ts, event, reason}";

/// A person's AI history cid: `ai:` + hex(SHA-256(lp("lucid-meet-ai-history-v1", principal))).
pub fn ai_cid(principal: &str) -> String {
    format!("ai:{}", crate::codec::sha256_hex(&op::lp(&[CID_LABEL, principal.as_bytes()])))
}

/// AI_CID_RE: `ai:` + 64 lower-case hex.
fn is_ai_cid(cid: &str) -> bool {
    cid.strip_prefix("ai:").is_some_and(|h| h.len() == 64 && h.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}

fn same_keys(o: &Obj, keys: &[&str]) -> bool {
    o.len() == keys.len() && keys.iter().all(|k| o.contains_key(*k))
}

/// _ai_audit_record: a checked 6.6 record (no content), without `session`: a personal-access request, or a dropped
/// history record (`event` `ai_history_dropped`).
fn audit_record(body: &Obj) -> R<Obj> {
    let rec: Obj = body.iter().filter(|(k, _)| k.as_str() != "session").map(|(k, v)| (k.clone(), v.clone())).collect();
    let whole = |v: Option<&Value>| pj::as_int(v).is_some_and(|n| (0..=MAX).contains(&n));
    let rid_ok = rec.get("rid").and_then(Value::as_str).is_some_and(|r| r.len() == 32 && r.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
    let dropped = same_keys(&rec, &AUDIT_DROPPED);
    if !(dropped || same_keys(&rec, &AUDIT_PERSONAL)) || pj::as_int(rec.get("v")) != Some(1) || !rid_ok || !whole(rec.get("ts")) {
        return bad(AI_AUDIT_SHAPE);
    }
    if dropped {
        let reason_ok = rec.get("reason").and_then(Value::as_str).is_some_and(|r| (1..=REASON_MAX).contains(&r.chars().count()) && pj::printable(r));
        if rec.get("event").and_then(Value::as_str) != Some("ai_history_dropped") || !reason_ok {
            return bad(AI_AUDIT_SHAPE);
        }
        return Ok(rec);
    }
    let text = |k: &str| rec.get(k).and_then(Value::as_str).is_some_and(|t| (1..=AUDIT_TEXT_MAX).contains(&t.chars().count()) && pj::printable(t));
    let one_of = |k: &str, of: &[&str]| rec.get(k).and_then(Value::as_str).is_some_and(|x| of.contains(&x));
    let ok = one_of("provider", op::AI_PROVIDERS)
        && one_of("method", &AUDIT_METHODS)
        && one_of("plan", &AUDIT_PLANS)
        && rec.get("tier").and_then(Value::as_str) == Some("personal")
        && whole(rec.get("tokens_in"))
        && whole(rec.get("tokens_out"))
        && text("class")
        && text("model");
    if !ok {
        return bad(AI_AUDIT_SHAPE);
    }
    Ok(rec)
}

/// _ai_person: a person's device certificate (never a guest, connector, console or seed).
pub(crate) fn ai_person(who: &Identity) -> bool {
    who.kind == "person" && !(who.guest || who.connector || who.is_console() || who.seed)
}

/// _ai_named_hash: `ai.map_sha256` of a policy ("" when none).
fn named_hash(policy: Option<&Obj>) -> String {
    policy.and_then(|p| p.get("ai")).and_then(Value::as_object).map(|a| pj::s(a, "map_sha256")).unwrap_or_default()
}

impl State {
    /// _ai_part: `ext["ai"]`, made sound.
    pub(crate) fn ai_part(&mut self) -> &mut Obj {
        let sound = matches!(self.ext.get("ai"), Some(Value::Object(o)) if pj::as_int(o.get("v")) == Some(1));
        if !sound {
            self.ext.insert("ai".into(), Value::Object(obj([("v", Value::from(1))])));
        }
        let part = self.ext.get_mut("ai").and_then(Value::as_object_mut).expect("ext ai");
        for (key, list) in [("maps", true), ("groups", false), ("audit", true), ("history", false)] {
            let ok = match part.get(key) {
                Some(Value::Array(_)) => list,
                Some(Value::Object(_)) => !list,
                _ => false,
            };
            if !ok {
                part.insert(key.into(), if list { Value::Array(Vec::new()) } else { Value::Object(Obj::new()) });
            }
        }
        part
    }

    pub(crate) fn ai_list(&mut self, key: &str) -> &mut Vec<Value> {
        self.ai_part().get_mut(key).and_then(Value::as_array_mut).expect("an ai list")
    }

    fn ai_obj(&mut self, key: &str) -> &mut Obj {
        self.ai_part().get_mut(key).and_then(Value::as_object_mut).expect("an ai object")
    }

    /// _ai_newest: the org's newest current (unexpired) policy.
    pub(crate) fn ai_newest(&mut self, org: &str) -> Option<Obj> {
        self.pc_current().into_iter().find(|p| p.get("org").and_then(Value::as_str) == Some(org))
    }

    /// _ai_app_of: `who` is an `ai` app (principal and device) of `policy`, with that org only.
    pub(crate) fn ai_app_of(who: &Identity, policy: Option<&Obj>) -> bool {
        let Some(policy) = policy else { return false };
        who.kind == "app" && who.orgs.len() == 1 && policy.get("org").and_then(Value::as_str) == Some(who.orgs[0].as_str()) && pc::ai_app_of(policy, who)
    }

    /// _ai_is_ai_app: a current policy names `principal` as an app of type `ai`.
    pub(crate) fn ai_is_ai_app(&mut self, principal: &str) -> bool {
        pc::service_kind(principal) == "app" && self.pc_policy_app(principal).is_some_and(|a| pj::text_of(&a, "type") == "ai")
    }

    /// _ai_owner: the person whose `ai:` conversation `cid` is ("" when the relay keeps none).
    pub(crate) fn ai_owner(&mut self, cid: &str) -> String {
        let entry = self.ext.get("ai").and_then(|a| a.get("history")).and_then(|h| h.get(cid));
        entry.and_then(Value::as_object).map(|e| pj::text_of(e, "principal")).unwrap_or_default()
    }

    /// _ai_archives: `(principal, device)` of the archive of every current policy covering `principal` that names one.
    fn ai_archives(&mut self, principal: &str) -> Vec<(String, String)> {
        let mut out = Vec::new();
        for policy in self.pc_current() {
            if let Some(arch) = policy.get("archive").and_then(Value::as_object).filter(|a| !a.is_empty()) {
                if op::covers(&policy, principal) {
                    out.push((pj::text_of(arch, "principal"), pj::text_of(arch, "device")));
                }
            }
        }
        out
    }

    /// _ai_tell: an `ai_history` event to the person's other sessions and to the archive sessions of every org whose
    /// newest policy names that archive and covers them. Callers wake the polls.
    fn ai_tell(&mut self, principal: &str, event: &Obj, skip: Option<&str>) {
        self.tell(&[principal.to_string()], event, skip);
        let archives: Vec<(String, Identity)> = self.sessions.values().filter(|s| s.who.kind == "archive").map(|s| (s.session_id.clone(), s.who.clone())).collect();
        let told = with(event, obj([("principal", Value::from(principal))]));
        for (id, who) in archives {
            if self.pc_archive_reads(&who, &[principal.to_string()]) {
                if let Some(s) = self.sessions.get_mut(&id) {
                    push(&mut s.seq, &mut s.events, &told);
                }
            }
        }
    }

    /// _ai_wrap_ok: an `ai:` wrap from the cid's own person, to their own device or to the archive named by a policy in
    /// `pols` that covers them.
    pub(crate) fn ai_wrap_ok(&mut self, cid: &str, sender: &str, to: &Obj, pols: &[String]) -> R<()> {
        if cid != ai_cid(sender) {
            return forbidden(AI_NOT_YOURS);
        }
        let mut policies = Vec::new();
        for h in pols {
            let wire = self.pc_store().and_then(|s| s.get_sha256(h)).cloned();
            match wire.and_then(|w| w.get("policy").and_then(Value::as_object).cloned()) {
                Some(p) => policies.push(p),
                None => return bad(pc::POLS_UNKNOWN),
            }
        }
        if pj::text_of(to, "principal") == sender {
            return Ok(());
        }
        for policy in &policies {
            let arch = policy.get("archive").and_then(Value::as_object);
            let same = arch.is_some_and(|a| a.get("principal") == to.get("principal") && a.get("device") == to.get("device"));
            if same && op::covers(policy, sender) {
                return Ok(());
            }
        }
        forbidden(ce::NOT_IN)
    }

    /// _ai_wrap_sets (7.6): each (`ai:` cid, epoch) of a wrap request reaches the archive device of every current
    /// policy covering the sender that names an archive, in this request or kept from an earlier one (403 otherwise).
    pub(crate) fn ai_wrap_sets(&mut self, who: &Identity, rows: &[Obj]) -> R<()> {
        let mut epochs: Vec<(String, i64)> = Vec::new();
        for r in rows.iter().filter(|r| !pj::truthy(r.get("share"))) {
            let key = (pj::text_of(r, "cid"), pj::as_int(r.get("epoch")).unwrap_or(0));
            if key.0.starts_with("ai:") && !epochs.contains(&key) {
                epochs.push(key);
            }
        }
        if epochs.is_empty() {
            return Ok(());
        }
        let needed = self.ai_archives(&who.principal);
        for (cid, epoch) in &epochs {
            for (ap, ad) in &needed {
                let here = rows.iter().any(|r| {
                    pj::text_of(r, "cid") == *cid
                        && pj::as_int(r.get("epoch")) == Some(*epoch)
                        && r.get("to").and_then(Value::as_object).is_some_and(|t| pj::text_of(t, "principal") == *ap && pj::text_of(t, "device") == *ad)
                });
                let before = self.ce_part("wraps").get(&format!("{ap}|{ad}")).and_then(Value::as_array).is_some_and(|kept| {
                    kept.iter().any(|k| k.get("cid").and_then(Value::as_str) == Some(cid.as_str()) && pj::as_int(k.get("epoch")) == Some(*epoch))
                });
                if !here && !before {
                    return forbidden(AI_ARCHIVE_WRAP);
                }
            }
        }
        Ok(())
    }

    /// _ai_keep_s: how long the relay keeps a person's `ai:` rows and wraps: their signed `retention.ai` (absent: kept),
    /// never longer than the relay's `channel_days`.
    pub(crate) fn ai_keep_s(&mut self, principal: &str) -> f64 {
        let cap = self.channel_s;
        self.pc_retention_s("ai", &[principal.to_string()], cap)
    }

    /// _ai_prune: rows past `retention.ai` (to the hold store when held), and maps no policy names any more.
    pub(crate) fn ai_prune(&mut self, now: f64) {
        // nothing kept yet: state.json stays without `ext["ai"]` (the PC-1 round-trip fixture)
        if !self.ext.contains_key("ai") {
            return;
        }
        let cids: Vec<String> = self.ai_obj("history").keys().cloned().collect();
        for cid in cids {
            let entry = self.ai_obj("history").get(&cid).cloned();
            let owner = entry.as_ref().and_then(Value::as_object).map(|e| pj::text_of(e, "principal")).unwrap_or_default();
            let rows: Option<Vec<Obj>> = entry
                .as_ref()
                .and_then(|e| e.get("rows"))
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_object).cloned().collect());
            let Some(rows) = rows.filter(|_| !owner.is_empty()) else {
                self.ai_obj("history").remove(&cid);
                continue;
            };
            let cut = now - self.ai_keep_s(&owner);
            let (kept, gone): (Vec<Obj>, Vec<Obj>) = rows.into_iter().partition(|r| pj::num(r, "ts") >= cut);
            if !gone.is_empty() {
                self.pc_hold_items(&cid, "row", &gone, None, Some(std::slice::from_ref(&owner)));
                if let Some(e) = self.ai_obj("history").get_mut(&cid).and_then(Value::as_object_mut) {
                    e.insert("rows".into(), Value::Array(kept.iter().cloned().map(Value::Object).collect()));
                }
                self.dirty = true;
            }
            if kept.is_empty() {
                self.ai_obj("history").remove(&cid);
            }
        }
        if self.pc_ai_maps_loaded() {
            for policy in self.pc_current() {
                let org = pj::text_of(&policy, "org");
                let named = named_hash(Some(&policy));
                if let Some(maps) = self.ai_maps() {
                    maps.prune(&org, &named);
                }
            }
            let kept = self.ai_maps().map(|m| m.persisted()).unwrap_or_default();
            if self.ai_part().get("maps") != Some(&Value::Array(kept.clone())) {
                self.ai_part().insert("maps".into(), Value::Array(kept));
                self.dirty = true;
            }
        }
    }
}

impl Hub {
    /// `POST /v1/sso/c/ai-groups {org, provider, records, sso_attestation}`: the SSO service's poll of the listed
    /// groups. Its serial must be the root's registered SSO service of that org; each principal one that service
    /// serves and the org's policy covers; each `read_at` newer than the stored one (all or nothing).
    pub fn ai_groups_post(&self, who: &Identity, body: &Obj) -> R<Obj> {
        if who.kind != "sso" {
            return forbidden(pc::SSO_ONLY);
        }
        let org = pj::s(body, "org");
        let mut st = self.st.lock();
        if !who.orgs.contains(&org) {
            return forbidden(format!("this sign-in service is not registered for {org}"));
        }
        let held: HashMap<String, i64> = st
            .ai_obj("groups")
            .get(&org)
            .and_then(Value::as_object)
            .map(|rows| rows.iter().filter_map(|(p, r)| r.as_object().map(|r| (p.clone(), pc::pc_int(r.get("read_at"))))).collect())
            .unwrap_or_default();
        let terms = st.pc_terms();
        let policy = st.ai_newest(&org);
        let held_of = |p: &str| held.get(p).copied().unwrap_or(0);
        let records = op::check_ai_groups(&Value::Object(body.clone()), &who.serial, &terms, policy.as_ref(), &held_of, pj::now()).map_err(pc::policy_error)?;
        let provider = body.get("provider").cloned().unwrap_or(Value::Null);
        let groups = st.ai_obj("groups");
        let rows = groups.entry(org.clone()).or_insert_with(|| Value::Object(Obj::new()));
        if !rows.is_object() {
            *rows = Value::Object(Obj::new());
        }
        let rows = rows.as_object_mut().expect("group rows");
        for rec in &records {
            rows.insert(
                rec.principal.clone(),
                Value::Object(obj([
                    ("provider", provider.clone()),
                    ("listed", Value::Array(rec.listed.iter().cloned().map(Value::from).collect())),
                    ("read_at", Value::from(rec.read_at)),
                ])),
            );
        }
        st.dirty = true;
        drop(st);
        log_info(&format!("ai_groups org={org} provider={} service={} records={}", kv_of(body.get("provider")), who.serial, records.len()));
        Ok(obj([("ok", Value::Bool(true)), ("stored", Value::from(records.len()))]))
    }

    /// `GET /v1/ai/allowed` (a person, about themselves) or `?principal=` (an `ai` app, only for principals its own
    /// org's policy covers; 404 otherwise) -> `{allowed, read_at}`, computed now from the current policy and AI map.
    pub fn ai_allowed(&self, who: &Identity, principal: &str) -> R<Obj> {
        let asked = if principal.is_empty() { String::new() } else { m::principal(Some(&Value::from(principal))) };
        let mut st = self.st.lock();
        let current = st.pc_current();
        let (asked, policy) = if !asked.is_empty() {
            let policy = pc::covering(&current, &asked).cloned();
            if !State::ai_app_of(who, policy.as_ref()) {
                return Err(E::NotFound(AI_NOT_FOUND.into()));
            }
            (asked, policy)
        } else {
            if !ai_person(who) {
                return Err(E::NotFound(AI_NOT_FOUND.into()));
            }
            (who.principal.clone(), pc::covering(&current, &who.principal).cloned())
        };
        let Some(policy) = policy else { return Ok(obj([("allowed", Value::Bool(false)), ("read_at", Value::from(0))])) };
        let org = pj::text_of(&policy, "org");
        let record = st.ext.get("ai").and_then(|a| a.get("groups")).and_then(|g| g.get(&org)).and_then(|g| g.get(&asked)).and_then(Value::as_object).map(|r| op::AiGroupRecord {
            principal: asked.clone(),
            listed: r.get("listed").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect(),
            read_at: pc::pc_int(r.get("read_at")),
        });
        let named = named_hash(Some(&policy));
        let map = st.ai_maps().and_then(|m| m.get(&org, &named)).and_then(|v| v.wire.get("map")).and_then(Value::as_object).cloned();
        let (allowed, read_at) = op::ai_allowed(&asked, Some(&policy), map.as_ref(), record.as_ref(), pj::now(), op::AI_GROUPS_FRESH_S);
        Ok(obj([("allowed", Value::Bool(allowed)), ("read_at", Value::from(read_at))]))
    }

    /// `POST /v1/ai/audit`: a device's 6.6 record (no content), kept in state.json (at most AUDIT_MAX, the oldest go)
    /// with its metadata logged.
    pub fn ai_audit_post(&self, who: &Identity, body: &Obj) -> R<Obj> {
        if !ai_person(who) || !who.own_device() {
            return forbidden(AI_PEOPLE_ONLY);
        }
        let rec = audit_record(body)?;
        let rts = (pj::now() * 1000.0) as i64;
        let mut st = self.st.lock();
        let audit = st.ai_list("audit");
        audit.push(Value::Object(with(&rec, obj([("by", Value::from(who.principal.clone())), ("device", Value::from(who.device.clone())), ("rts", Value::from(rts))]))));
        if audit.len() > AUDIT_MAX {
            let cut = audit.len() - AUDIT_MAX;
            audit.drain(..cut);
        }
        st.dirty = true;
        drop(st);
        let kind = rec.get("event").or_else(|| rec.get("provider"));
        log_info(&format!("ai_audit principal={} rid={} kind={}", who.principal, pj::s(&rec, "rid"), kv_of(kind)));
        Ok(obj([("ok", Value::Bool(true))]))
    }

    /// `GET /v1/admin/ai/audit?org=&since=&cursor=` (a relay admin; the Admin Console in process) -> `{records, next}`:
    /// the kept 6.6 records of people `org`'s current policy covers with `rts` after `since` (ms) and after `cursor`,
    /// oldest first, AUDIT_PAGE per page (a page never splits records of one `rts`). `next`: the cursor of the next
    /// page, null on the last. Read-only: the store keeps its AUDIT_MAX cap.
    pub fn ai_audit_list(&self, org: &str, since_ms: i64, cursor: Option<&str>) -> R<Obj> {
        let after = match cursor.filter(|c| !c.is_empty()) {
            None => since_ms,
            Some(c) => c.parse::<i64>().map_err(|_| E::Bad("cursor must be a next value of this route".into()))?.max(since_ms),
        };
        let mut st = self.st.lock();
        let Some(policy) = st.ai_newest(org) else { return Ok(obj([("records", Value::Array(Vec::new())), ("next", Value::Null)])) };
        let all: Vec<Value> = st.ext.get("ai").and_then(|a| a.get("audit")).and_then(Value::as_array).cloned().unwrap_or_default();
        drop(st);
        let mut records: Vec<Value> = Vec::new();
        let mut more = false;
        for r in all.iter().filter(|r| pc::pc_int(r.get("rts")) > after && r.get("by").and_then(Value::as_str).is_some_and(|p| op::covers(&policy, p))) {
            if records.len() >= AUDIT_PAGE && pc::pc_int(r.get("rts")) != pc::pc_int(records.last().and_then(|l| l.get("rts"))) {
                more = true;
                break;
            }
            records.push(r.clone());
        }
        let next = if more { Value::from(pc::pc_int(records.last().and_then(|l| l.get("rts"))).to_string()) } else { Value::Null };
        Ok(obj([("records", Value::Array(records)), ("next", next)]))
    }

    /// `POST /v1/ai/history {session, id, enc}`: one `ai` record (envelope kind `ai`) in the caller's own `ai:`
    /// conversation; their other devices and the covering archives hear `ai_history`.
    pub fn ai_history_post(&self, session: &str, who: &Identity, id: Body, enc: Body) -> R<Obj> {
        let mid = ce::mid_of(id, "id")?;
        if !ai_person(who) || !who.own_device() {
            return forbidden(AI_PEOPLE_ONLY);
        }
        let mut st = self.st.lock();
        let r = (|| -> R<Obj> {
            st.session(session, who)?;
            let env = ce::envelope(enc, &["ai"], "", who, None)?;
            let cid = ai_cid(&who.principal);
            let history = st.ai_obj("history");
            let entry = history.entry(cid.clone()).or_insert_with(|| Value::Object(obj([("principal", Value::from(who.principal.clone())), ("rows", Value::Array(Vec::new()))])));
            let rows = entry.as_object_mut().and_then(|e| e.get_mut("rows")).and_then(Value::as_array_mut).expect("ai rows");
            if rows.iter().any(|r| r.get("id").and_then(Value::as_str) == Some(mid.as_str())) {
                return Err(E::Conflict("a message with that id is already kept".into()));
            }
            let now = pj::now();
            let row = obj([
                ("id", Value::from(mid.clone())),
                ("from", Value::from(who.principal.clone())),
                ("ts", pj::f(now)),
                ("rts", Value::from((now * 1000.0) as i64)),
                ("enc", Value::Object(env)),
                ("events", Value::Array(Vec::new())),
            ]);
            rows.push(Value::Object(row.clone()));
            let gone: Vec<Obj> = if rows.len() > HISTORY_KEEP {
                let cut = rows.len() - HISTORY_KEEP;
                rows.drain(..cut).filter_map(|v| v.as_object().cloned()).collect()
            } else {
                Vec::new()
            };
            if !gone.is_empty() {
                st.pc_hold_items(&cid, "row", &gone, None, Some(std::slice::from_ref(&who.principal)));
            }
            st.dirty = true;
            let event = obj([("type", Value::from("ai_history")), ("cid", Value::from(cid)), ("row", Value::Object(row.clone()))]);
            st.ai_tell(&who.principal, &event, Some(session));
            Ok(row)
        })();
        drop(st);
        self.wake();
        let out = r?;
        log_info(&format!("ai_history_post principal={} device={}", who.principal, who.device));
        Ok(out)
    }

    /// `POST /v1/ai/history/delete {session, id, event, enc}`: the person deletes one of their own `ai` records
    /// (envelope kind `delete`); under a hold the record goes to the hold store first.
    pub fn ai_history_delete(&self, session: &str, who: &Identity, id: Body, event: Body, enc: Body) -> R<Obj> {
        let target_id = ce::mid_of(id, "id")?;
        let eid = ce::mid_of(event, "event")?;
        if !ai_person(who) || !who.own_device() {
            return forbidden(AI_PEOPLE_ONLY);
        }
        let mut st = self.st.lock();
        let r = (|| -> R<Obj> {
            st.session(session, who)?;
            let env = ce::envelope(enc, &["delete"], &target_id, who, None)?;
            let cid = ai_cid(&who.principal);
            let target = st
                .ai_obj("history")
                .get(&cid)
                .and_then(|e| e.get("rows"))
                .and_then(Value::as_array)
                .and_then(|rows| rows.iter().filter_map(Value::as_object).find(|r| pj::text_of(r, "id") == target_id).cloned());
            let Some(mut target) = target else { return Err(E::NotFound("that message is no longer kept".into())) };
            if target.contains_key("deleted") && pj::truthy(target.get("deleted")) {
                return Ok(target);
            }
            let now = pj::now();
            st.pc_hold_items(&cid, "deleted", std::slice::from_ref(&target), None, Some(std::slice::from_ref(&who.principal)));
            let ev = ce::add_event(&mut target, &eid, who, env, now)?;
            target.remove("enc");
            target.insert("events".into(), Value::Array(vec![Value::Object(ev.clone())]));
            target.insert("deleted".into(), pj::f(now));
            if let Some(rows) = st.ai_obj("history").get_mut(&cid).and_then(|e| e.get_mut("rows")).and_then(Value::as_array_mut) {
                if let Some(slot) = rows.iter_mut().find(|r| r.get("id").and_then(Value::as_str) == Some(target_id.as_str())) {
                    *slot = Value::Object(target.clone());
                }
            }
            st.dirty = true;
            let told = obj([
                ("type", Value::from("ai_history")),
                ("cid", Value::from(cid)),
                ("id", Value::from(target_id.clone())),
                ("event", Value::Object(ev)),
                ("deleted", pj::f(now)),
            ]);
            st.ai_tell(&who.principal, &told, Some(session));
            Ok(target)
        })();
        drop(st);
        self.wake();
        let out = r?;
        log_info(&format!("ai_history_delete principal={} device={}", who.principal, who.device));
        Ok(out)
    }

    /// `GET /v1/ai/history?session=&cid=&after=&limit=` -> `{cid, messages}`: rows after `rts` `after` (ms), oldest
    /// first. The person reads their own (`cid` optional); an archive device of an org covering the person reads with
    /// `cid`.
    pub fn ai_history_get(&self, session: &str, who: &Identity, cid: &str, after: &str, limit: &str) -> R<Obj> {
        let after_ms = m::number(Some(&Value::from(after)), "after")?;
        let most = (m::number(Some(&Value::from(limit)), "limit")?.trunc() as i64).clamp(1, HISTORY_LIMIT) as usize;
        let mut st = self.st.lock();
        st.session(session, who)?;
        let cid = if who.kind == "archive" {
            let owner = if is_ai_cid(cid) { st.ai_owner(cid) } else { String::new() };
            if owner.is_empty() || !st.pc_archive_reads(who, &[owner]) {
                return Err(E::NotFound(AI_NOT_FOUND.into()));
            }
            cid.to_string()
        } else if ai_person(who) {
            let own = ai_cid(&who.principal);
            if !cid.is_empty() && cid != own {
                return forbidden(AI_NOT_YOURS);
            }
            own
        } else {
            return forbidden(pc::APP_ROUTES_ONLY);
        };
        let out: Vec<Value> = st
            .ext
            .get("ai")
            .and_then(|a| a.get("history"))
            .and_then(|h| h.get(&cid))
            .and_then(|e| e.get("rows"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|r| pj::as_num(r.get("rts")).unwrap_or(0.0) > after_ms)
            .take(most)
            .cloned()
            .collect();
        Ok(obj([("cid", Value::from(cid)), ("messages", Value::Array(out))]))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_ai_cid_is_the_labelled_hash_of_the_principal() {
        let cid = ai_cid("ann@acme.example");
        assert!(is_ai_cid(&cid));
        let mut want = Vec::new();
        for part in [&CID_LABEL[..], b"ann@acme.example"] {
            want.extend_from_slice(&(part.len() as u32).to_be_bytes());
            want.extend_from_slice(part);
        }
        assert_eq!(cid, format!("ai:{}", crate::codec::sha256_hex(&want)));
        assert_ne!(cid, ai_cid("bob@acme.example"));
        assert!(!is_ai_cid("ai:ABC"));
    }

    #[test]
    fn audit_records_carry_no_content_and_only_their_fields() {
        let personal = json!({"v": 1, "rid": "0".repeat(32), "ts": 5, "provider": "openai", "method": "key", "plan": "business",
            "class": "internal", "model": "gpt-5", "tokens_in": 10, "tokens_out": 3, "tier": "personal", "session": "s"});
        let rec = audit_record(personal.as_object().unwrap()).unwrap();
        assert!(!rec.contains_key("session"));
        let dropped = json!({"v": 1, "rid": "a".repeat(32), "ts": 5, "event": "ai_history_dropped", "reason": "too big"});
        assert!(audit_record(dropped.as_object().unwrap()).is_ok());
        for broken in [
            json!({"v": 1, "rid": "0".repeat(32), "ts": 5, "provider": "openai", "method": "key", "plan": "business",
                "class": "internal", "model": "gpt-5", "tokens_in": 10, "tokens_out": 3, "tier": "personal", "q": "the question"}),
            json!({"v": 1, "rid": "0".repeat(32), "ts": 5, "provider": "nope", "method": "key", "plan": "business",
                "class": "internal", "model": "gpt-5", "tokens_in": 10, "tokens_out": 3, "tier": "personal"}),
            json!({"v": 1, "rid": "0".repeat(31), "ts": 5, "event": "ai_history_dropped", "reason": "x"}),
            json!({"v": 1, "rid": "0".repeat(32), "ts": 5, "event": "other", "reason": "x"}),
            json!({"v": true, "rid": "0".repeat(32), "ts": 5, "event": "ai_history_dropped", "reason": "x"}),
        ] {
            assert_eq!(audit_record(broken.as_object().unwrap()).unwrap_err().message(), AI_AUDIT_SHAPE, "{broken}");
        }
    }
}
