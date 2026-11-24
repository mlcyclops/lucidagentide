// Contract API-1 revision 5 (phase 1c), sections 5.2, 5.4, 5.5 and 7.2: what a content client may see at this
// connector, judged at every call from the connector's own verified state, never from the relay's word.
//
// - 5.2 visibility (`visible`): all nine steps. Only `ch:` cids are ever visible (O4); `excluded_channels` applies to
//   the kinds `agent` and `agent_delegated` only (O13); membership is the app's verified member-log replay
//   (`AppSession::conversation_serving`, `is_member`), never the relay's member list. The approval re-check (7.5,
//   R5-12) uses the same function, so a post is judged by exactly the rule its reads are.
// - The message-level rules (`Shown`): only messages the app holds (the store), sent while the app was a member, and
//   for a delegated token only those whose time falls inside the person's own membership (`in_intervals`).
// - 5.4 classes (`class_of`): from the verified AI map and policy only; a policy that names a map this connector has
//   not verified yet leaves every class unknown, so nothing is visible until it verifies.
// - 5.5 identities (`Faces`): `from.id` is the hex of the first 16 bytes of HMAC-SHA-256 under the client's id key,
//   `from.email` only for people of the pinned policy's `domains`, `self` for the delegated person.
// - 7.2 shapes (`Faces::message`, `conversation`).

use crate::ai_gateway_policy::Ai;
use crate::api_cjournal::{self as cj, ConsoleEntry};
use crate::api_map::{ApiMapStore, TightenEntry, CEILINGS};
use crate::api_token as tok;
use crate::ce_device as ce;
use crate::ce_device_log::in_intervals;
use crate::codec::hex;
use crate::connector::Connector;
use crate::connector_session::{AppSession, MapPin, PolicyState};
use crate::connector_store::StoredMessage;
use crate::connector_sync::SyncState;
use crate::meet_org_policy::{self as op, Obj};
use aws_lc_rs::hmac;
use serde_json::{json, Value};
use std::sync::Arc;

/// Why a conversation is not visible: the 5.2 step that failed, also the `check` of `content.approval.refused`.
pub mod step {
    /// 1: the client does not list this connector, a journal entry dropped it, or the connector is not active.
    pub const CONNECTOR: &str = "connector";
    /// 2: no app of the client's `apps` is hosted and listed here.
    pub const APP: &str = "app";
    /// 3: the app does not serve (policy, certificate, revocation lists).
    pub const POLICY: &str = "policy";
    /// 4: the app is not a current member by its verified replay.
    pub const MEMBER: &str = "member";
    /// 5: not a group chat or channel cid (O4).
    pub const KIND: &str = "kind";
    /// 6: outside the client's `channels` or a `client_limit_channels`.
    pub const CHANNELS: &str = "channels";
    /// 7: above the effective ceiling, or the class cannot be known yet.
    pub const CEILING: &str = "ceiling";
    /// 8: in the AI map's `excluded_channels` (agents only, O13).
    pub const EXCLUDED: &str = "excluded";
    /// 9: the delegated person is not a current member.
    pub const PERSON: &str = "person";
}

/// What the connector judges a call against, read once per call: the synced map and journals (2.8) and its own
/// verified org policy and AI map (2.6).
pub struct Ground {
    pub org: String,
    pub connector_id: String,
    /// A snapshot of the pinned map and the applied relay journal.
    pub store: ApiMapStore,
    /// The active 4b console journal entries.
    pub console: Vec<ConsoleEntry>,
    /// This connector's `connectors[]` entry.
    pub entry: Option<Obj>,
    /// The own org's pinned policy while it is unexpired.
    pub policy: Option<Obj>,
    /// The verified AI map the policy names.
    pub ai_map: Option<MapPin>,
    pub now_ms: i64,
}

impl Ground {
    pub fn of(conn: &Connector, sync: &SyncState, now_ms: i64) -> Ground {
        let policy = conn.trust().own_pin().filter(|p| p.expires.saturating_mul(1000) > now_ms).map(|p| p.policy);
        Ground {
            org: sync.org().to_string(),
            connector_id: sync.connector_id().to_string(),
            store: sync.store(),
            console: sync.console_active(),
            entry: sync.connector(),
            policy,
            ai_map: conn.trust().ai_map(),
            now_ms,
        }
    }

    /// The relay journal entries still active for the org.
    pub fn active(&self) -> &[TightenEntry] {
        self.store.active(&self.org)
    }

    /// The client with `id` in the pinned map.
    pub fn client(&self, id: &str) -> Option<&Obj> {
        tok::find_client(&self.store, &self.org, id)
    }

    /// 2.8 and 5.3 check 2: the connector is listed `active` and no `connector_suspend` holds it.
    pub fn connector_active(&self) -> bool {
        self.entry.as_ref().is_some_and(|e| e.get("state").and_then(Value::as_str) == Some("active")) && !cj::connector_suspended(&self.console, &self.connector_id)
    }

    /// The pinned policy's `domains`.
    pub fn domains(&self) -> Vec<String> {
        self.policy.as_ref().and_then(|p| p.get("domains")).and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_ascii_lowercase).collect()
    }

    /// A person principal of the pinned policy's `domains`.
    pub fn in_org(&self, principal: &str) -> bool {
        if ce::principal_kind(principal).ok() != Some("person") {
            return false;
        }
        let Ok((_, domain)) = op::split_principal(principal) else { return false };
        self.domains().iter().any(|d| d.eq_ignore_ascii_case(domain))
    }

    /// The owner rule of a connector (5.4 step 5 has no people data here): a person of the policy's `domains` that no
    /// active `person_revoke` for `*` names.
    pub fn owner_active(&self, owner: &str) -> bool {
        self.in_org(owner) && !cj::person_revoked(&self.console, "*", owner)
    }

    /// The display name the pinned policy gives an app principal ("" for anyone else).
    pub fn app_name(&self, principal: &str) -> String {
        let apps = self.policy.as_ref().and_then(|p| p.get("apps")).and_then(Value::as_array);
        apps.into_iter().flatten().find(|a| a.get("principal").and_then(Value::as_str) == Some(principal)).and_then(|a| a.get("name")).and_then(Value::as_str).unwrap_or_default().to_string()
    }
}

/// The caller as visibility judges it.
#[derive(Clone, Copy)]
pub struct Who<'a> {
    /// The client id (`c_` and 16 hex).
    pub id: &'a str,
    /// Its pinned map entry.
    pub client: &'a Obj,
    /// Its `kind`.
    pub kind: &'a str,
    /// The delegated person (`sub` of an `agent_delegated` token).
    pub person: Option<&'a str>,
    /// The effective ceiling (1a 5.4 intersection).
    pub ceiling: &'a str,
}

/// The client's ceiling lowered by every journaled `client_lower_ceiling` (the token's own ceiling is applied by
/// validation; the approval re-check has no token).
pub fn client_ceiling(g: &Ground, id: &str, client: &Obj) -> &'static str {
    let own = client.get("ceiling").and_then(Value::as_str).and_then(tok::rank).unwrap_or(0);
    let lowered = tok::client_entries(g.active(), "client_lower_ceiling", id).filter_map(|e| tok::rank(tok::target_field(e, "ceiling")));
    CEILINGS[lowered.fold(own, usize::min)]
}

/// 5.4: a label equal to one of the four ceilings is that class, a label in `cui_classes` is `cui`, any other is
/// `confidential`.
pub fn class_of_label(label: &str, cui_classes: &[String]) -> &'static str {
    if let Some(c) = CEILINGS.iter().find(|c| **c == label) {
        return *c;
    }
    if cui_classes.iter().any(|c| c == label) {
        return "cui";
    }
    "confidential"
}

/// The verified AI map the policy names: Ok(None) when the policy names none, Err when it names one this connector
/// has not verified (nothing about classes or exclusions can be known then).
fn named_map<'g>(g: &'g Ground, ai: &Ai) -> Result<Option<&'g MapPin>, ()> {
    if ai.map_sha256.is_empty() {
        return Ok(None);
    }
    match &g.ai_map {
        Some(m) if m.hash.eq_ignore_ascii_case(&ai.map_sha256) => Ok(Some(m)),
        _ => Err(()),
    }
}

/// 5.4: the class of a conversation from the verified AI map and policy only (`channel_classes[cid]`, else
/// `ai.default_class`; `confidential` for a policy without `ai`). None when it cannot be known now (no verified
/// policy, or the map the policy names has not verified).
pub fn class_of(g: &Ground, cid: &str) -> Option<&'static str> {
    let policy = g.policy.as_ref()?;
    if !policy.get("ai").is_some_and(Value::is_object) {
        return Some("confidential");
    }
    let ai = Ai::read(policy).ok()?;
    let label = match named_map(g, &ai).ok()? {
        Some(m) => m.map.channel_classes.get(cid).cloned().unwrap_or_else(|| ai.default_class.clone()),
        None => ai.default_class.clone(),
    };
    Some(class_of_label(&label, &ai.cui_classes))
}

/// 5.2 step 8's list: the cid is in the AI map's `excluded_channels`, or the map the policy names has not verified
/// (so an exclusion cannot be ruled out).
pub fn excluded(g: &Ground, cid: &str) -> bool {
    let Some(policy) = g.policy.as_ref() else { return true };
    if !policy.get("ai").is_some_and(Value::is_object) {
        return false;
    }
    let Ok(ai) = Ai::read(policy) else { return true };
    match named_map(g, &ai) {
        Ok(Some(m)) => m.map.excluded.contains(cid),
        Ok(None) => false,
        Err(()) => true,
    }
}

/// 5.2 step 1: the client lists this connector (journal included) and the connector is active.
pub fn reaches_connector(g: &Ground, who: &Who) -> bool {
    tok::names(who.client, "connectors").any(|k| k == g.connector_id) && !cj::client_connector_dropped(&g.console, who.id, &g.connector_id) && g.connector_active()
}

/// 5.2 step 6: in the client's `channels` (or `["*"]`) and inside every `client_limit_channels`.
pub fn in_channels(g: &Ground, who: &Who, cid: &str) -> bool {
    tok::names(who.client, "channels").any(|c| c == "*" || c == cid) && cj::channel_limits(&g.console, who.id).iter().all(|l| l.iter().any(|c| c == cid))
}

/// 5.2 step 2: the sessions of the apps in the client's effective `apps` that this connector hosts and lists (and no
/// `client_drop_app` or `connector_drop_app` removed).
pub fn client_apps(conn: &Connector, g: &Ground, who: &Who) -> Vec<Arc<AppSession>> {
    let Some(entry) = g.entry.as_ref() else { return Vec::new() };
    conn.sessions
        .values()
        .filter(|s| {
            let (p, _) = s.principal();
            !p.is_empty()
                && tok::names(who.client, "apps").any(|a| a == p)
                && !cj::client_app_dropped(&g.console, who.id, &p)
                && tok::names(entry, "apps").any(|a| a == p)
                && !cj::connector_app_dropped(&g.console, &g.connector_id, &p)
        })
        .cloned()
        .collect()
}

/// 5.2 steps 3 and 4 for one app: it serves (in the pinned policy as type `api` with its device, its certificate
/// within its end, fresh revocation lists) and is a current member of `cid` by its verified replay.
pub fn app_serves(conn: &Connector, s: &AppSession, cid: &str, now_ms: i64) -> Result<(), &'static str> {
    let (p, d) = s.principal();
    if s.serving().is_err() || conn.trust().app_state(&p, &d, now_ms) != PolicyState::Listed {
        return Err(step::POLICY);
    }
    s.conversation_serving(cid).map_err(|_| step::MEMBER)
}

/// 5.2: whether `cid` is visible to `who` now; Ok is the app session that serves it, Err the step that failed. The
/// caller answers every Err with the same 404 `not-found` as an unknown cid.
pub fn visible(conn: &Connector, g: &Ground, who: &Who, cid: &str) -> Result<Arc<AppSession>, &'static str> {
    if !reaches_connector(g, who) {
        return Err(step::CONNECTOR);
    }
    if ce::cid_kind(cid).ok() != Some("ch") {
        return Err(step::KIND);
    }
    if !in_channels(g, who, cid) {
        return Err(step::CHANNELS);
    }
    let allowed = tok::rank(who.ceiling).unwrap_or(0);
    if class_of(g, cid).and_then(tok::rank).is_none_or(|c| c > allowed) {
        return Err(step::CEILING);
    }
    if matches!(who.kind, "agent" | "agent_delegated") && excluded(g, cid) {
        return Err(step::EXCLUDED);
    }
    let mut why = step::APP;
    for s in client_apps(conn, g, who) {
        if let Err(w) = app_serves(conn, &s, cid, g.now_ms) {
            why = w;
            continue;
        }
        if who.person.is_some_and(|p| !s.is_member(cid, p)) {
            why = step::PERSON;
            continue;
        }
        return Ok(s);
    }
    Err(why)
}

/// The message-level rules of 5.2 for one conversation: messages sent while the app was a member and, for a
/// delegated token, while the person was.
pub struct Shown {
    app: Vec<(i64, i64)>,
    person: Option<Vec<(i64, i64)>>,
}

impl Shown {
    pub fn of(s: &AppSession, cid: &str, person: Option<&str>) -> Shown {
        let (p, _) = s.principal();
        Shown { app: s.member_intervals(cid, &p), person: person.map(|x| s.member_intervals(cid, x)) }
    }

    pub fn shows(&self, m: &StoredMessage) -> bool {
        in_intervals(&self.app, m.ts) && self.person.as_ref().is_none_or(|i| in_intervals(i, m.ts))
    }
}

/// 5.5: the hex of the first 16 bytes of HMAC-SHA-256(client id key, principal).
pub fn face_id(key: &[u8; 32], principal: &str) -> String {
    let k = hmac::Key::new(hmac::HMAC_SHA256, key);
    hex(&hmac::sign(&k, principal.as_bytes()).as_ref()[..16])
}

/// How principals appear to one client (5.5) and the 7.2 shapes.
pub struct Faces<'a> {
    pub key: [u8; 32],
    /// The delegated person (their own messages carry `self`).
    pub person: Option<&'a str>,
    pub ground: &'a Ground,
}

impl Faces<'_> {
    pub fn id(&self, principal: &str) -> String {
        face_id(&self.key, principal)
    }

    /// `from`: id, name, the email of a person of the policy's domains, `self` for the delegated person.
    pub fn from(&self, principal: &str) -> Value {
        let mut v = json!({"id": self.id(principal), "name": self.ground.app_name(principal)});
        if self.ground.in_org(principal) {
            v["email"] = json!(principal);
        }
        if self.person == Some(principal) {
            v["self"] = json!(true);
        }
        v
    }

    /// 7.2 `message`. `via` only on a post an API app made with `dlg` (7.4); its `person` in the `from.id` form.
    pub fn message(&self, cid: &str, m: &StoredMessage) -> Value {
        let files: Vec<Value> = m
            .files
            .iter()
            .map(|f| json!({"id": f.get("fid").cloned().unwrap_or(Value::Null), "name": f.get("name").and_then(Value::as_str).unwrap_or_default(), "size": f.get("size").and_then(Value::as_u64).unwrap_or(0), "mime": f.get("mime").and_then(Value::as_str).unwrap_or("application/octet-stream")}))
            .collect();
        let mut v = json!({
            "id": m.mid, "conv": cid, "ts": m.ts, "from": self.from(&m.from), "text": m.text,
            "thread": m.thread.clone().unwrap_or_default(), "reply_to": m.reply.clone().unwrap_or_default(),
            "mentions": m.mentions.iter().map(|p| self.id(p)).collect::<Vec<_>>(), "files": files, "edited": m.edited.unwrap_or(0),
        });
        let api_app = ce::principal_kind(&m.from).ok() == Some("app");
        if let Some(d) = m.dlg.as_ref().filter(|_| api_app) {
            let mut via = json!({"app": m.from, "client": d.get("client").and_then(Value::as_str).unwrap_or_default()});
            if let Some(p) = d.get("person").and_then(Value::as_str) {
                via["person"] = json!(self.id(p));
            }
            v["via"] = via;
        }
        v
    }
}

/// 7.2 `conversation` of a visible cid served by `s`.
pub fn conversation(g: &Ground, s: &AppSession, cid: &str) -> Value {
    let info = s.conversations().into_iter().find(|c| c.cid == cid);
    let (p, _) = s.principal();
    json!({
        "cid": cid,
        "kind": info.as_ref().map_or("channel", |i| i.kind),
        "name": info.as_ref().map(|i| i.name.clone()).unwrap_or_default(),
        "class": class_of(g, cid).unwrap_or("confidential"),
        "app": p,
        "since": info.as_ref().map_or(0, |i| i.since),
        "members": s.member_count(cid),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai_gateway_policy::AiMap;
    use crate::api_cjournal::Reach;
    use crate::connector_session::tests::{World, APP};
    use std::collections::BTreeMap;

    const K: &str = "k_7a1b2c3d4e5f6a7b";

    fn policy(ai: Option<Value>) -> Obj {
        let mut p = json!({"org": "acme", "domains": ["acme.test"], "apps": [{"name": "Helpdesk", "type": "api", "principal": "helpdesk@apps.acme.test"}]});
        if let Some(a) = ai {
            p["ai"] = a;
        }
        p.as_object().unwrap().clone()
    }

    fn ground(policy: Option<Obj>, map: Option<MapPin>) -> Ground {
        Ground { org: "acme".into(), connector_id: K.into(), store: ApiMapStore::load(None), console: Vec::new(), entry: None, policy, ai_map: map, now_ms: 0 }
    }

    fn pin(hash: &str, classes: Value, excluded: Value) -> MapPin {
        let map = AiMap::read(&json!({"org": "acme", "seq": 1, "channel_classes": classes, "excluded_channels": excluded}));
        MapPin { hash: hash.into(), seq: 1, map, wire: Value::Null }
    }

    #[test]
    fn classes_come_only_from_the_verified_ai_map_and_policy() {
        // no ai key: confidential
        assert_eq!(class_of(&ground(Some(policy(None)), None), "ch:a"), Some("confidential"));
        // no verified policy: unknown
        assert_eq!(class_of(&ground(None, None), "ch:a"), None);
        let ai = json!({"default_class": "internal", "cui_classes": ["itar"], "map_sha256": "ab".repeat(32)});
        // the named map has not verified: unknown
        assert_eq!(class_of(&ground(Some(policy(Some(ai.clone()))), None), "ch:a"), None);
        let m = pin(&"ab".repeat(32), json!({"ch:conf": "confidential", "ch:itar": "itar", "ch:other": "secret-ish"}), json!([]));
        let g = ground(Some(policy(Some(ai))), Some(m));
        assert_eq!(class_of(&g, "ch:conf"), Some("confidential"));
        assert_eq!(class_of(&g, "ch:itar"), Some("cui"));
        assert_eq!(class_of(&g, "ch:other"), Some("confidential"), "an unknown label is confidential");
        assert_eq!(class_of(&g, "ch:plain"), Some("internal"), "the policy's default_class");
        // another map than the one named: unknown
        let g = ground(Some(policy(Some(json!({"default_class": "public", "map_sha256": "cd".repeat(32)})))), Some(pin(&"ab".repeat(32), json!({}), json!([]))));
        assert_eq!(class_of(&g, "ch:plain"), None);
    }

    #[test]
    fn excluded_channels_follow_the_named_map() {
        let ai = json!({"default_class": "internal", "map_sha256": "ab".repeat(32)});
        let g = ground(Some(policy(Some(ai.clone()))), Some(pin(&"ab".repeat(32), json!({}), json!(["ch:secret"]))));
        assert!(excluded(&g, "ch:secret"));
        assert!(!excluded(&g, "ch:open"));
        assert!(excluded(&ground(Some(policy(Some(ai))), None), "ch:open"), "unverified map: cannot rule an exclusion out");
        assert!(!excluded(&ground(Some(policy(None)), None), "ch:open"));
    }

    #[test]
    fn faces_are_per_client_and_hide_foreign_addresses() {
        let mut g = ground(Some(policy(None)), None);
        g.now_ms = 1;
        let f = Faces { key: [1; 32], person: Some("ann@acme.test"), ground: &g };
        let other = Faces { key: [2; 32], person: None, ground: &g };
        assert_eq!(f.id("ann@acme.test").len(), 32);
        assert_ne!(f.id("ann@acme.test"), other.id("ann@acme.test"), "meaningless to other clients");
        assert_eq!(f.id("ann@acme.test"), face_id(&[1; 32], "ann@acme.test"), "stable per client at every connector");
        let ann = f.from("ann@acme.test");
        assert_eq!((ann["email"].as_str(), ann["self"].as_bool()), (Some("ann@acme.test"), Some(true)));
        let eve = f.from("eve@other.example");
        assert!(eve.get("email").is_none() && eve.get("self").is_none());
        assert_eq!(f.from("helpdesk@apps.acme.test")["name"], "Helpdesk");
        assert!(f.from("helpdesk@apps.acme.test").get("email").is_none());
    }

    #[test]
    fn a_visible_conversation_needs_every_step() {
        let w = World::new();
        let key = [4u8; 32];
        let (cid, _) = w.conversation("vis1", &key);
        w.session.deliver(&[json!({"seq": 1, "type": "chat_log", "channel": &cid[3..]}), json!({"seq": 2, "type": "chat_keys"})], w.now).unwrap();
        let conn = Connector::for_test(&w.dir, w.session.shared().clone(), BTreeMap::from([(APP.to_string(), w.session.clone())]));
        let client = json!({"id": "c_00000000000000a1", "kind": "agent", "connectors": [K], "apps": [w.app_p], "channels": ["*"], "ceiling": "confidential"});
        let client = client.as_object().unwrap().clone();
        let mut g = ground(conn.trust().own_pin().map(|p| p.policy), None);
        g.now_ms = w.now;
        g.entry = json!({"id": K, "apps": [w.app_p], "state": "active"}).as_object().cloned();
        let who = Who { id: "c_00000000000000a1", client: &client, kind: "agent", person: None, ceiling: "confidential" };
        assert!(visible(&conn, &g, &who, &cid).is_ok());
        assert_eq!(visible(&conn, &g, &Who { ceiling: "internal", ..who }, &cid).err(), Some(step::CEILING), "confidential is above internal");
        assert_eq!(visible(&conn, &g, &Who { person: Some("bob@acme.test"), ..who }, &cid).err(), Some(step::PERSON));
        assert_eq!(visible(&conn, &g, &who, "ch:never-added").err(), Some(step::MEMBER));
        let dm = ce::dm_cid(&w.ann_p, &w.app_p).unwrap();
        assert_eq!(visible(&conn, &g, &who, &dm).err(), Some(step::KIND), "O4: never a DM");
        // O13: excluded for agents, not for apps
        let ai = json!({"default_class": "internal", "map_sha256": "ab".repeat(32)});
        let mut p = g.policy.clone().unwrap();
        p.insert("ai".into(), ai);
        g.policy = Some(p);
        g.ai_map = Some(pin(&"ab".repeat(32), json!({}), json!([cid])));
        assert_eq!(visible(&conn, &g, &who, &cid).err(), Some(step::EXCLUDED));
        assert_eq!(visible(&conn, &g, &Who { kind: "agent_delegated", person: Some(&w.ann_p), ..who }, &cid).err(), Some(step::EXCLUDED));
        assert!(visible(&conn, &g, &Who { kind: "app", ..who }, &cid).is_ok(), "excluded_channels never applies to app");
        // channel classes from the verified map
        g.ai_map = Some(pin(&"ab".repeat(32), json!({cid.clone(): "confidential"}), json!([])));
        assert_eq!(visible(&conn, &g, &Who { ceiling: "internal", ..who }, &cid).err(), Some(step::CEILING));
        g.ai_map = Some(pin(&"ab".repeat(32), json!({}), json!([])));
        assert!(visible(&conn, &g, &Who { ceiling: "internal", ..who }, &cid).is_ok(), "the default class internal");
        // the journal: client_drop_app, client_limit_channels, connector_suspend
        let entry = |action: &str, target: Value| ConsoleEntry { id: "k_acme_000001".into(), org: "acme".into(), cseq: 1, ts: 1, action: action.into(), target, reach: Reach::Connector, prev_cseq: Some(0) };
        g.console = vec![entry("client_drop_app", json!({"client": "c_00000000000000a1", "app": w.app_p}))];
        assert_eq!(visible(&conn, &g, &who, &cid).err(), Some(step::APP));
        g.console = vec![entry("client_limit_channels", json!({"client": "c_00000000000000a1", "channels": ["ch:elsewhere"]}))];
        assert_eq!(visible(&conn, &g, &who, &cid).err(), Some(step::CHANNELS));
        g.console = vec![entry("connector_suspend", json!(K))];
        assert_eq!(visible(&conn, &g, &who, &cid).err(), Some(step::CONNECTOR));
    }
}
