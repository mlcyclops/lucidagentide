// Contract API-1 revision 4 (docs/api/contract-r4-1b.md) 2.3 item 4 and 2.4: the per-org console journal. Two of the
// three categories of tightening live here, in one sequence `cseq` with ids `k_<org>_<cseq as 6 digits>`:
// - 4a console-only (`"reach": "console"`): enforced by the console alone; reaches no relay and no connector;
// - 4b connector-relevant (`"reach": "connector"`): enforced by connectors (revision 5), which see only these entries,
//   so each carries `prev_cseq`, the `cseq` of the org's previous 4b entry (0 for the first).
// Nothing here is ever sent to a relay. `<state>/api-console-journal/<org>.jsonl` is append-only, each line flushed
// before the action takes effect and before the admin is answered; `<org>.settled.json` keeps the ids a pinned map
// folded or cleared (rewritten, flushed). Folding and clearing follow revision 3 2.5, checked by the console: a
// version 2 map may list `k_` ids in `folded` and `cleared`; `cleared` may undo `client_lower_caps`,
// `client_drop_recipient` and the actions of revision 5 4.2 (`person_revoke` only by a map whose `delegation.denied`
// no longer lists the principal).

use crate::api_map::{self, console_id_parts, ApiMapError};
use crate::codec::{parse_json, stringify};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};

/// The folder of the console journals.
pub const DIR: &str = "api-console-journal";
const MAX_INT: u64 = (1 << 53) - 1;

/// Who enforces a console journal action (2.3 item 4).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reach {
    /// 4a: the console alone.
    Console,
    /// 4b: connectors (revision 5 4.2); the console syncs these entries to them, never to a relay.
    Connector,
}

impl Reach {
    pub fn as_str(self) -> &'static str {
        match self {
            Reach::Console => "console",
            Reach::Connector => "connector",
        }
    }
}

/// Every console journal action with its reach: revision 4 2.4 defines four 4a actions; revision 5 4.2 adds thirteen
/// (4a and 4b); later revisions add rows.
pub const ACTIONS: [(&str, Reach); 27] = [
    ("client_lower_caps", Reach::Console),
    ("client_drop_recipient", Reach::Console),
    ("federation_drop_key", Reach::Console),
    ("webhook_key_drop", Reach::Console),
    // revision 5 4.2
    ("client_drop_connector", Reach::Connector),
    ("client_drop_app", Reach::Connector),
    ("client_limit_channels", Reach::Connector),
    ("client_confirm", Reach::Connector),
    ("client_drop_delegation", Reach::Console),
    ("connector_suspend", Reach::Connector),
    ("idp_suspend", Reach::Console),
    ("person_revoke", Reach::Connector),
    ("connector_drop_app", Reach::Connector),
    ("connector_limit", Reach::Connector),
    ("idp_limit", Reach::Console),
    ("client_limit_delegation", Reach::Console),
    ("client_drop_redirect", Reach::Console),
    // revision 6 2.3 (feature `a2a`): 4b for connectors, 4a for the console's card signing and partner card fetches
    ("agent_off", Reach::Connector),
    ("agent_drop_skill", Reach::Connector),
    ("a2a_key_drop", Reach::Console),
    ("push_off", Reach::Connector),
    ("push_drop_origin", Reach::Connector),
    ("client_drop_agent", Reach::Connector),
    ("client_drop_skill", Reach::Connector),
    ("client_a2a_limit", Reach::Connector),
    ("push_private_off", Reach::Connector),
    ("card_private_off", Reach::Console),
];
/// 2.4 and revision 5 4.2: the console actions a signed map's `cleared` may undo (two-person, 13.3 and r5 13.2): every
/// revision 5 action (1a 2.5 rules; `person_revoke` only by a map that no longer lists the principal in `denied`).
pub const CLEARABLE: [&str; 24] = [
    "client_lower_caps",
    "client_drop_recipient",
    "client_drop_connector",
    "client_drop_app",
    "client_limit_channels",
    "client_confirm",
    "client_drop_delegation",
    "connector_suspend",
    "idp_suspend",
    "person_revoke",
    "connector_drop_app",
    "connector_limit",
    "idp_limit",
    "client_limit_delegation",
    "client_drop_redirect",
    // revision 6 2.3: every A2A action but `a2a_key_drop` (a dropped key is replaced, not restored)
    "agent_off",
    "agent_drop_skill",
    "push_off",
    "push_drop_origin",
    "client_drop_agent",
    "client_drop_skill",
    "client_a2a_limit",
    "push_private_off",
    "card_private_off",
];
/// 2.2 caps and their ranges (`day_max_bytes` from the smallest job).
pub const CAPS: [(&str, i64, i64); 4] = [("holds_per_day", 1, 100), ("job_max_bytes", 1 << 20, 50 << 30), ("day_max_bytes", 1 << 20, 200 << 30), ("jobs_per_day", 1, 20)];

fn reach_of(action: &str) -> Option<Reach> {
    ACTIONS.iter().find(|(a, _)| *a == action).map(|(_, r)| *r)
}

fn no<T>(code: &'static str, message: impl Into<String>) -> Result<T, ApiMapError> {
    Err(ApiMapError::new(code, message))
}

fn kid_ok(v: &Value) -> bool {
    v.as_str().is_some_and(|s| (1..=64).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-')))
}

fn client_ok(v: &Value) -> bool {
    v.as_str().and_then(|s| s.strip_prefix("c_")).is_some_and(|h| h.len() == 16 && h.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}

fn connector_ok(v: &Value) -> bool {
    v.as_str().and_then(|s| s.strip_prefix("k_")).is_some_and(|h| h.len() == 16 && h.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}

fn str_ok(v: &Value, ok: impl Fn(&str) -> bool) -> bool {
    v.as_str().is_some_and(ok)
}

/// `low` to `high` distinct strings, each passing `ok`.
fn distinct(v: &Value, low: usize, high: usize, ok: impl Fn(&str) -> bool) -> bool {
    let Some(a) = v.as_array() else { return false };
    let mut seen = std::collections::BTreeSet::new();
    (low..=high).contains(&a.len()) && a.iter().all(|x| x.as_str().is_some_and(|s| ok(s) && seen.insert(s)))
}

/// Revision 5 4.2 `idp_limit`: `{idp, algs?, max_age_s?, tenant?, private_ok?: false}` with at least one optional key.
fn idp_limit_ok(o: &Map<String, Value>) -> bool {
    let rest: Vec<&str> = o.keys().map(String::as_str).filter(|k| *k != "idp").collect();
    !rest.is_empty()
        && str_ok(&o["idp"], api_map::idp_id_ok)
        && rest.iter().all(|k| match *k {
            "algs" => distinct(&o["algs"], 1, 3, |a| matches!(a, "ES256" | "RS256" | "PS256")),
            "max_age_s" => o["max_age_s"].as_i64().is_some_and(|n| (60..=600).contains(&n)),
            "tenant" => str_ok(&o["tenant"], |s| (1..=128).contains(&s.len()) && s.bytes().all(|b| (b' '..=b'~').contains(&b))),
            "private_ok" => o["private_ok"] == Value::Bool(false),
            _ => false,
        })
}

/// 2.4 and revision 5 4.2: whether a target fits its action.
pub fn target_ok(action: &str, t: &Value) -> bool {
    match action {
        "connector_suspend" => return connector_ok(t),
        "idp_suspend" => return str_ok(t, api_map::idp_id_ok),
        // revision 6 2.3: an agent id, a card key's kid, a client id
        "agent_off" => return str_ok(t, agent_id_ok),
        "a2a_key_drop" => return kid_ok(t),
        "push_off" => return client_ok(t),
        // the bare client id turns every private range off; `{client, keep}` (below) keeps only those inside `keep`
        "push_private_off" | "card_private_off" if t.is_string() => return client_ok(t),
        _ => {}
    }
    let Some(o) = t.as_object() else { return false };
    let keys = |want: &[&str]| o.len() == want.len() && want.iter().all(|k| o.contains_key(*k));
    let client = || o.get("client").is_some_and(client_ok);
    match action {
        "client_drop_connector" => keys(&["client", "connector"]) && client() && connector_ok(&o["connector"]),
        "client_drop_app" => keys(&["client", "app"]) && client() && str_ok(&o["app"], api_map::app_principal_ok),
        "client_limit_channels" => keys(&["client", "channels"]) && client() && distinct(&o["channels"], 1, 500, api_map::channel_ok),
        "client_confirm" => keys(&["client", "scope"]) && client() && str_ok(&o["scope"], |s| matches!(s, "content.read" | "content.post")),
        "client_drop_delegation" => {
            o.len() == 2
                && client()
                && (o.get("group").is_some_and(|g| str_ok(g, api_map::group_ok))
                    || o.get("principal").is_some_and(|p| str_ok(p, api_map::person_ok))
                    || o.get("idp").is_some_and(|i| str_ok(i, api_map::idp_id_ok)))
        }
        "person_revoke" => keys(&["client", "principal"]) && (client() || o["client"] == "*") && str_ok(&o["principal"], api_map::person_ok),
        "connector_drop_app" => keys(&["connector", "app"]) && connector_ok(&o["connector"]) && str_ok(&o["app"], api_map::app_principal_ok),
        "connector_limit" => keys(&["connector", "networks"]) && connector_ok(&o["connector"]) && distinct(&o["networks"], 1, 32, api_map::cidr_ok),
        "idp_limit" => o.contains_key("idp") && idp_limit_ok(o),
        "client_limit_delegation" => keys(&["client", "consent_days"]) && client() && o["consent_days"].as_i64().is_some_and(|n| (1..=30).contains(&n)),
        "client_drop_redirect" => keys(&["client", "uri"]) && client() && str_ok(&o["uri"], api_map::redirect_ok),
        "client_lower_caps" => {
            o.len() >= 2
                && o.get("client").is_some_and(client_ok)
                && o.iter().filter(|(k, _)| k.as_str() != "client").all(|(k, v)| CAPS.iter().any(|(c, lo, hi)| *c == k.as_str() && v.as_i64().is_some_and(|n| (*lo..=*hi).contains(&n))))
        }
        "client_drop_recipient" => keys(&["client", "kid"]) && client_ok(&o["client"]) && kid_ok(&o["kid"]),
        "federation_drop_key" | "webhook_key_drop" => keys(&["kid"]) && kid_ok(&o["kid"]),
        // revision 6 2.3
        "agent_drop_skill" => keys(&["agent", "skill"]) && str_ok(&o["agent"], agent_id_ok) && str_ok(&o["skill"], skill_id_ok),
        "push_drop_origin" => keys(&["client", "origin"]) && client() && str_ok(&o["origin"], |s| crate::connector_a2a_wire::origin_of(s).as_deref() == Some(s)),
        "client_drop_agent" => keys(&["client", "agent"]) && client() && str_ok(&o["agent"], agent_id_ok),
        "client_drop_skill" => {
            keys(&["client", "skill"]) && client() && str_ok(&o["skill"], |s| s.split_once('/').is_some_and(|(a, k)| agent_id_ok(a) && skill_id_ok(k)))
        }
        "client_a2a_limit" => keys(&["client", "max_open_tasks"]) && client() && o["max_open_tasks"].as_i64().is_some_and(|n| (1..=256).contains(&n)),
        // a private CIDR list narrowed but not emptied: only ranges inside `keep` stay reachable until the map is as narrow
        "push_private_off" | "card_private_off" => keys(&["client", "keep"]) && client() && distinct(&o["keep"], 1, 8, api_map::cidr_ok),
        _ => false,
    }
}

/// Revision 6 2.2: `a_` and 16 lowercase hex.
fn agent_id_ok(s: &str) -> bool {
    s.strip_prefix("a_").is_some_and(|h| h.len() == 16 && h.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}

/// Revision 6 2.2: `[a-z0-9-]{1,64}`.
fn skill_id_ok(s: &str) -> bool {
    (1..=64).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// One console journal entry.
#[derive(Clone, Debug, PartialEq)]
pub struct ConsoleEntry {
    pub id: String,
    pub org: String,
    pub cseq: u64,
    pub ts: i64,
    pub action: String,
    pub target: Value,
    pub reach: Reach,
    /// 4b only: the `cseq` of the org's previous 4b entry.
    pub prev_cseq: Option<u64>,
}

impl ConsoleEntry {
    /// Shape, id, action, reach and target (`not-tightening` for anything else).
    pub fn parse(v: &Value) -> Result<ConsoleEntry, ApiMapError> {
        let bad = |why: &str| no("not-tightening", why.to_string());
        let Some(e) = v.as_object() else { return bad("a console journal entry is an object") };
        let action = e.get("action").and_then(Value::as_str).unwrap_or_default();
        let Some(reach) = reach_of(action) else { return no("not-tightening", format!("{action:?} is not a console journal action")) };
        let mut want = vec!["id", "cseq", "ts", "action", "target", "reach"];
        if reach == Reach::Connector {
            want.push("prev_cseq");
        }
        if e.len() != want.len() || !want.iter().all(|k| e.contains_key(*k)) {
            return bad("a console journal entry is {id, cseq, ts, action, target, reach}, and prev_cseq for a connector entry");
        }
        let Some(cseq) = e["cseq"].as_u64().filter(|n| (1..=MAX_INT).contains(n)) else { return bad("cseq must be a whole number from 1") };
        let Some(ts) = e["ts"].as_i64().filter(|n| *n >= 1) else { return bad("ts must be a time") };
        let Some((org, n)) = e["id"].as_str().and_then(console_id_parts) else { return bad("id must be k_<org>_<cseq as 6 digits>") };
        if n != cseq {
            return bad("id must end with the entry's cseq");
        }
        if e["reach"].as_str() != Some(reach.as_str()) {
            return bad("reach does not fit the action");
        }
        let prev_cseq = match reach {
            Reach::Connector => Some(e["prev_cseq"].as_u64().filter(|p| *p < cseq).ok_or_else(|| ApiMapError::new("not-tightening", "prev_cseq must be below cseq"))?),
            Reach::Console => None,
        };
        if !target_ok(action, &e["target"]) {
            return no("not-tightening", format!("the target of {action} is not valid"));
        }
        Ok(ConsoleEntry { id: e["id"].as_str().unwrap_or_default().to_string(), org: org.to_string(), cseq, ts, action: action.to_string(), target: e["target"].clone(), reach, prev_cseq })
    }

    pub fn to_value(&self) -> Value {
        let mut v = json!({ "id": self.id, "cseq": self.cseq, "ts": self.ts, "action": self.action, "target": self.target, "reach": self.reach.as_str() });
        if let Some(p) = self.prev_cseq {
            v["prev_cseq"] = json!(p);
        }
        v
    }

    /// A string field of the entry's target ("" when absent).
    pub(crate) fn field(&self, k: &str) -> &str {
        self.target.get(k).and_then(Value::as_str).unwrap_or_default()
    }
}

/// 2.3 item 4: the entry, appended only as the next `cseq` (`cseq-gap`) and, for a 4b entry, naming the org's last 4b
/// `cseq` as `prev_cseq` (`prev-cseq`); the rest as `ConsoleEntry::parse`.
pub fn check_console_entry(entry: &Value, last_cseq: u64, last_connector: u64) -> Result<ConsoleEntry, ApiMapError> {
    let Some(cseq) = entry.get("cseq").and_then(Value::as_u64).filter(|n| (1..=MAX_INT).contains(n)) else { return no("not-tightening", "cseq must be a whole number from 1") };
    if cseq != last_cseq + 1 {
        return no("cseq-gap", format!("expected cseq {}, got {cseq}", last_cseq + 1));
    }
    let e = ConsoleEntry::parse(entry)?;
    if e.prev_cseq.is_some_and(|p| p != last_connector) {
        return no("prev-cseq", format!("prev_cseq must be {last_connector}"));
    }
    Ok(e)
}

fn find_client<'a>(map: &'a Value, id: &str) -> Option<&'a Map<String, Value>> {
    map.get("clients").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_object).find(|c| c.get("id").and_then(Value::as_str) == Some(id))
}

fn kids(map: &Value, pointer: &str) -> Vec<String> {
    map.pointer(pointer).and_then(Value::as_array).into_iter().flatten().filter_map(|k| k.get("kid").and_then(Value::as_str)).map(str::to_string).collect()
}

/// 2.4 "Folds when the pinned map": whether a map holds the entry's restriction.
pub fn contains(map: &Value, e: &ConsoleEntry) -> bool {
    match e.action.as_str() {
        "client_lower_caps" => find_client(map, e.field("client")).is_none_or(|c| {
            suspended(c) || e.target.as_object().into_iter().flatten().filter(|(k, _)| k.as_str() != "client").all(|(k, cap)| {
                c.get("compliance").and_then(|x| x.get(k)).and_then(Value::as_i64).is_none_or(|have| cap.as_i64().is_some_and(|cap| have <= cap))
            })
        }),
        "client_drop_recipient" => find_client(map, e.field("client")).is_none_or(|c| suspended(c) || c.get("compliance").and_then(|x| x.pointer("/recipient/kid")).and_then(Value::as_str) != Some(e.field("kid"))),
        "federation_drop_key" => !kids(map, "/federation/keys").iter().any(|k| k == e.field("kid")),
        "webhook_key_drop" => !kids(map, "/webhook_keys").iter().any(|k| k == e.field("kid")),
        // revision 5 4.2 "Folds when the pinned map"; absence counts only where the table says "or not at all"
        "client_drop_connector" => find_client(map, e.field("client")).is_none_or(|c| suspended(c) || !has(c.get("connectors"), e.field("connector"))),
        "client_drop_app" => find_client(map, e.field("client")).is_some_and(|c| !has(c.get("apps"), e.field("app"))),
        "client_limit_channels" => find_client(map, e.field("client")).is_some_and(|c| {
            let limit = texts(e.target.get("channels"));
            let held = texts(c.get("channels"));
            !held.is_empty() && held.iter().all(|ch| ch != "*" && limit.contains(ch))
        }),
        "client_confirm" => find_client(map, e.field("client")).is_some_and(|c| has(c.get("confirm"), e.field("scope"))),
        "client_drop_delegation" => find_client(map, e.field("client")).is_some_and(|c| {
            let d = c.get("delegation");
            let gone = |list: &str, k: &str| e.target.get(k).is_none() || !has(d.and_then(|d| d.get(list)), e.field(k));
            gone("groups", "group") && gone("principals", "principal") && gone("idps", "idp")
        }),
        "connector_suspend" => find_by(map, "connectors", e.target.as_str().unwrap_or_default()).is_none_or(suspended),
        "idp_suspend" => find_by(map, "idps", e.target.as_str().unwrap_or_default()).is_none_or(suspended),
        "person_revoke" => {
            let principal = e.field("principal");
            match e.field("client") {
                "*" => delegated_clients(map).all(|c| denies(c, principal)),
                id => find_client(map, id).is_some_and(|c| denies(c, principal)),
            }
        }
        "connector_drop_app" => find_by(map, "connectors", e.field("connector")).is_none_or(|k| !has(k.get("apps"), e.field("app"))),
        "connector_limit" => find_by(map, "connectors", e.field("connector")).is_some_and(|k| {
            let limit = texts(e.target.get("networks"));
            let held = texts(k.get("networks"));
            !held.is_empty() && held.iter().all(|n| limit.iter().any(|l| api_map::cidr_within(n, l)))
        }),
        "idp_limit" => find_by(map, "idps", e.field("idp")).is_some_and(|i| idp_within(i, &e.target)),
        "client_limit_delegation" => find_client(map, e.field("client")).is_some_and(|c| {
            let days = c.get("delegation").and_then(|d| d.get("consent_days")).and_then(Value::as_i64).unwrap_or(api_map::CONSENT_DAYS_DEFAULT);
            e.target.get("consent_days").and_then(Value::as_i64).is_some_and(|limit| days <= limit)
        }),
        "client_drop_redirect" => find_client(map, e.field("client")).is_some_and(|c| !has(c.get("redirect_uris"), e.field("uri"))),
        // revision 6 2.3 "Folds when the pinned map"
        "agent_off" => find_agent(map, e.target.as_str().unwrap_or_default()).is_none(),
        "agent_drop_skill" => find_agent(map, e.field("agent")).is_none_or(|a| !a.get("skills").and_then(Value::as_array).is_some_and(|s| s.iter().any(|k| k.get("id").and_then(Value::as_str) == Some(e.field("skill"))))),
        "a2a_key_drop" => !kids(map, "/a2a/jwks").iter().any(|k| Some(k.as_str()) == e.target.as_str()),
        "push_off" => find_client(map, e.target.as_str().unwrap_or_default()).is_none_or(|c| suspended(c) || c.get("a2a").and_then(|a| a.get("push")).is_none()),
        "push_drop_origin" => find_client(map, e.field("client")).is_none_or(|c| !has(c.get("a2a").and_then(|a| a.get("push")).and_then(|p| p.get("origins")), e.field("origin"))),
        "client_drop_agent" => find_client(map, e.field("client")).is_none_or(|c| suspended(c) || !has(c.get("a2a").and_then(|a| a.get("agents")), e.field("agent"))),
        "client_drop_skill" => find_client(map, e.field("client")).is_none_or(|c| {
            let skills = c.get("a2a").and_then(|a| a.get("skills"));
            !has(skills, "*") && !has(skills, e.field("skill"))
        }),
        "client_a2a_limit" => find_client(map, e.field("client")).is_none_or(|c| {
            let have = c.get("a2a").and_then(|a| a.get("max_open_tasks")).and_then(Value::as_i64);
            e.target.get("max_open_tasks").and_then(Value::as_i64).is_some_and(|limit| have.is_some_and(|h| h <= limit))
        }),
        // every pinned range inside a kept one (none kept for the bare client id: the list is empty or absent)
        "push_private_off" | "card_private_off" => find_client(map, private_client(e)).is_none_or(|c| {
            let held = texts(private_cidrs(c, &e.action));
            let keep = texts(e.target.get("keep"));
            held.iter().all(|n| keep.iter().any(|k| api_map::cidr_within(n, k)))
        }),
        _ => false,
    }
}

/// The client a `push_private_off` or `card_private_off` entry names: the bare client id or `{client, keep}`.
fn private_client(e: &ConsoleEntry) -> &str {
    e.target.as_str().unwrap_or_else(|| e.field("client"))
}

/// The client's private CIDR list that `action` (`push_private_off` or `card_private_off`) narrows.
fn private_cidrs<'a>(c: &'a Map<String, Value>, action: &str) -> Option<&'a Value> {
    if action == "push_private_off" {
        c.get("a2a").and_then(|a| a.get("push")).and_then(|p| p.get("private_cidrs"))
    } else {
        c.get("card").and_then(|k| k.get("private_cidrs"))
    }
}

fn find_agent<'a>(map: &'a Value, id: &str) -> Option<&'a Map<String, Value>> {
    map.pointer("/a2a/agents").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_object).find(|a| a.get("id").and_then(Value::as_str) == Some(id))
}

fn texts(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect()
}

fn has(v: Option<&Value>, s: &str) -> bool {
    v.and_then(Value::as_array).is_some_and(|a| a.iter().any(|x| x.as_str() == Some(s)))
}

fn find_by<'a>(map: &'a Value, list: &str, id: &str) -> Option<&'a Map<String, Value>> {
    map.get(list).and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_object).find(|c| c.get("id").and_then(Value::as_str) == Some(id))
}

fn suspended(o: &Map<String, Value>) -> bool {
    o.get("state").and_then(Value::as_str) == Some("suspended")
}

fn delegated_clients(map: &Value) -> impl Iterator<Item = &Map<String, Value>> {
    map.get("clients").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_object).filter(|c| c.get("kind").and_then(Value::as_str) == Some("agent_delegated"))
}

/// A client's signed standing deny of a principal (`delegation.denied`, R5-3).
fn denies(c: &Map<String, Value>, principal: &str) -> bool {
    has(c.get("delegation").and_then(|d| d.get("denied")), principal)
}

/// `idp_limit` folding: the pinned IdP is at or inside every limit the entry gives.
fn idp_within(i: &Map<String, Value>, limit: &Value) -> bool {
    let algs = limit.get("algs").is_none_or(|_| {
        let allowed = texts(limit.get("algs"));
        texts(i.get("algs")).iter().all(|a| allowed.contains(a))
    });
    let age = limit.get("max_age_s").and_then(Value::as_i64).is_none_or(|m| i.get("max_age_s").and_then(Value::as_i64).is_some_and(|have| have <= m));
    let tenant = limit.get("tenant").is_none_or(|t| i.get("tenant") == Some(t));
    let private = limit.get("private_ok").is_none_or(|_| i.get("private_ok") == Some(&Value::Bool(false)));
    algs && age && tenant && private
}

/// Whether a map may clear an entry: a clearable action older than its `issued`; for `person_revoke` the map must
/// also no longer list the principal in `delegation.denied` of that client (of any `agent_delegated` client for `*`):
/// only a two-person widening lifts it (O18).
fn clear_ok(map: &Value, e: &ConsoleEntry) -> bool {
    let issued = map.get("issued").and_then(Value::as_i64).unwrap_or(0);
    if !CLEARABLE.contains(&e.action.as_str()) || e.ts >= issued {
        return false;
    }
    if e.action != "person_revoke" {
        return true;
    }
    let principal = e.field("principal");
    match e.field("client") {
        "*" => !delegated_clients(map).any(|c| denies(c, principal)),
        id => !find_client(map, id).is_some_and(|c| denies(c, principal)),
    }
}

/// A `person_revoke` for every client (`*`). Deliberately tighter than r5 4.2: a fold leaves it active, and only
/// `cleared` settles it, so a delegated client added after the fold still refuses the person (R5-3).
fn stays_after_fold(e: &ConsoleEntry) -> bool {
    e.action == "person_revoke" && e.field("client") == "*"
}

/// Whether a pinned map settles an entry: it clears it (`clear_ok`), or folds it and holds its restriction (never a
/// `*` `person_revoke`, `stays_after_fold`).
fn settled_by(map: &Value, e: &ConsoleEntry) -> bool {
    let lists = |k: &str| map.get(k).and_then(Value::as_array).is_some_and(|a| a.iter().any(|x| x.as_str() == Some(e.id.as_str())));
    (lists("cleared") && clear_ok(map, e)) || (lists("folded") && contains(map, e) && !stays_after_fold(e))
}

/// 2.3 item 4 folding and clearing of the active console entries by a new map (revision 3 2.5 rules):
/// `fold-mismatch` when it folds an entry whose restriction it does not hold, clears an entry that is not clearable
/// or not older than its `issued`, or lists an id both ways. Returns the ids still active, sorted. Ids of other
/// entries (relay journal `t_` ids, entries no longer active) are not judged here.
pub fn fold(active: &[ConsoleEntry], map: &Value) -> Result<Vec<String>, ApiMapError> {
    let ids = |k: &str| map.get(k).and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect::<Vec<String>>();
    let (folded, cleared) = (ids("folded"), ids("cleared"));
    if folded.iter().any(|f| cleared.contains(f)) {
        return no("fold-mismatch", "an id is both folded and cleared");
    }
    let mut remaining = Vec::new();
    for e in active {
        if folded.contains(&e.id) {
            if !contains(map, e) {
                return no("fold-mismatch", format!("the map folds {} but does not hold it", e.id));
            }
            if stays_after_fold(e) {
                remaining.push(e.id.clone());
            }
        } else if cleared.contains(&e.id) {
            if !clear_ok(map, e) {
                return no("fold-mismatch", format!("the map cannot clear {}", e.id));
            }
        } else {
            remaining.push(e.id.clone());
        }
    }
    remaining.sort();
    Ok(remaining)
}

// ── the console's effect of the active entries (2.4), read by the compliance, webhook and federation slices ──

/// `client_lower_caps`: each cap the minimum of the pinned value and every active entry for the client.
#[cfg_attr(not(test), allow(dead_code))]
pub fn caps(pinned: Option<&Value>, active: &[ConsoleEntry], client: &str) -> BTreeMap<String, i64> {
    let mut out: BTreeMap<String, i64> = BTreeMap::new();
    let base = pinned.and_then(|m| find_client(m, client)).and_then(|c| c.get("compliance")).and_then(Value::as_object);
    for (k, _, _) in CAPS {
        if let Some(n) = base.and_then(|b| b.get(k)).and_then(Value::as_i64) {
            out.insert(k.to_string(), n);
        }
    }
    for e in active.iter().filter(|e| e.action == "client_lower_caps" && e.field("client") == client) {
        for (k, cap) in e.target.as_object().into_iter().flatten().filter(|(k, _)| k.as_str() != "client") {
            if let Some(cap) = cap.as_i64() {
                out.entry(k.clone()).and_modify(|n| *n = (*n).min(cap)).or_insert(cap);
            }
        }
    }
    out
}

/// `client_drop_recipient`: the client's recipient `kid` is dropped (new jobs refused `recipient`).
#[cfg_attr(not(test), allow(dead_code))]
pub fn recipient_dropped(active: &[ConsoleEntry], client: &str, kid: &str) -> bool {
    active.iter().any(|e| e.action == "client_drop_recipient" && e.field("client") == client && e.field("kid") == kid)
}

/// `federation_drop_key` and `webhook_key_drop`: the console no longer signs with that key and omits it from the
/// published key set.
#[cfg_attr(not(test), allow(dead_code))]
pub fn key_dropped(active: &[ConsoleEntry], action: &str, kid: &str) -> bool {
    active.iter().any(|e| e.action == action && e.field("kid") == kid)
}

// ── revision 5 4.2: the effect of the active entries, read by the issuer (slice 1c3) and the connector (1c4) ──

#[cfg_attr(not(test), allow(dead_code))]
fn of<'a>(active: &'a [ConsoleEntry], action: &'a str) -> impl Iterator<Item = &'a ConsoleEntry> {
    active.iter().filter(move |e| e.action == action)
}

/// `person_revoke`: a standing deny of `principal` for `client`, by an entry naming that client or `*`.
#[cfg_attr(not(test), allow(dead_code))]
pub fn person_revoked(active: &[ConsoleEntry], client: &str, principal: &str) -> bool {
    of(active, "person_revoke").any(|e| e.field("principal") == principal && (e.field("client") == "*" || e.field("client") == client))
}

/// `connector_suspend`: the connector refuses every content call and the console issues no token for it.
#[cfg_attr(not(test), allow(dead_code))]
pub fn connector_suspended(active: &[ConsoleEntry], connector: &str) -> bool {
    of(active, "connector_suspend").any(|e| e.target.as_str() == Some(connector))
}

/// `idp_suspend`: ID-JAGs from the IdP are refused (`idp`).
#[cfg_attr(not(test), allow(dead_code))]
pub fn idp_suspended(active: &[ConsoleEntry], idp: &str) -> bool {
    of(active, "idp_suspend").any(|e| e.target.as_str() == Some(idp))
}

/// The pinned `idps[]` entry with every active `idp_limit` for it applied: `algs` intersected (in the pinned order),
/// `max_age_s` the minimum, `tenant` required (a limit naming another tenant than the pinned one, or two limits naming
/// two tenants, leave `algs` empty, so nothing is accepted), `private_ok` false; `auth_max_s` filled with its default
/// (O19) when the map gives none.
#[cfg_attr(not(test), allow(dead_code))]
pub fn idp_effective(idp: &Value, active: &[ConsoleEntry]) -> Value {
    let mut out = idp.clone();
    let id = idp.get("id").and_then(Value::as_str).unwrap_or_default();
    if out.get("auth_max_s").is_none() {
        out["auth_max_s"] = json!(api_map::AUTH_MAX_DEFAULT);
    }
    for e in of(active, "idp_limit").filter(|e| e.field("idp") == id) {
        if let Some(limit) = e.target.get("algs") {
            let allowed = texts(Some(limit));
            let kept: Vec<String> = texts(out.get("algs")).into_iter().filter(|a| allowed.contains(a)).collect();
            out["algs"] = json!(kept);
        }
        if let Some(m) = e.target.get("max_age_s").and_then(Value::as_i64) {
            let have = out.get("max_age_s").and_then(Value::as_i64).unwrap_or(m);
            out["max_age_s"] = json!(have.min(m));
        }
        if let Some(t) = e.target.get("tenant") {
            if out.get("tenant").is_some_and(|have| have != t) {
                out["algs"] = json!([]);
            } else {
                out["tenant"] = t.clone();
            }
        }
        if e.target.get("private_ok").is_some() {
            out["private_ok"] = json!(false);
        }
    }
    out
}

/// `client_drop_delegation`: `what` (`group`, `principal` or `idp`) `value` no longer delegates to the client.
#[cfg_attr(not(test), allow(dead_code))]
pub fn delegation_dropped(active: &[ConsoleEntry], client: &str, what: &str, value: &str) -> bool {
    of(active, "client_drop_delegation").any(|e| e.field("client") == client && e.target.get(what).and_then(Value::as_str) == Some(value))
}

/// `client_limit_delegation`: the smaller of the pinned `consent_days` and every active limit for the client.
#[cfg_attr(not(test), allow(dead_code))]
pub fn consent_days(pinned: i64, active: &[ConsoleEntry], client: &str) -> i64 {
    of(active, "client_limit_delegation").filter(|e| e.field("client") == client).filter_map(|e| e.target.get("consent_days").and_then(Value::as_i64)).fold(pinned, i64::min)
}

/// `client_drop_redirect`: that redirect URI is refused (`redirect`).
#[cfg_attr(not(test), allow(dead_code))]
pub fn redirect_dropped(active: &[ConsoleEntry], client: &str, uri: &str) -> bool {
    of(active, "client_drop_redirect").any(|e| e.field("client") == client && e.field("uri") == uri)
}

/// `client_drop_connector`: the client is refused at that connector.
#[cfg_attr(not(test), allow(dead_code))]
pub fn client_connector_dropped(active: &[ConsoleEntry], client: &str, connector: &str) -> bool {
    of(active, "client_drop_connector").any(|e| e.field("client") == client && e.field("connector") == connector)
}

// ── revision 6 2.3: the A2A actions as the connector applies them (slice 1d4) ──────────────────────────────────

fn of_string<'a>(active: &'a [ConsoleEntry], action: &'a str, id: &'a str) -> impl Iterator<Item = &'a ConsoleEntry> + 'a {
    of(active, action).filter(move |e| e.target.as_str() == Some(id))
}

/// `agent_off`: the agent serves nothing (404) and its open tasks are canceled.
pub fn agent_off(active: &[ConsoleEntry], agent: &str) -> bool {
    of_string(active, "agent_off", agent).next().is_some()
}

/// `agent_drop_skill`: new tasks for the skill are refused (`skill`).
pub fn agent_skill_dropped(active: &[ConsoleEntry], agent: &str, skill: &str) -> bool {
    of(active, "agent_drop_skill").any(|e| e.field("agent") == agent && e.field("skill") == skill)
}

/// `client_drop_agent`: the client may no longer use the agent (404); its open tasks there are canceled.
pub fn client_agent_dropped(active: &[ConsoleEntry], client: &str, agent: &str) -> bool {
    of(active, "client_drop_agent").any(|e| e.field("client") == client && e.field("agent") == agent)
}

/// `client_drop_skill` (`<agent id>/<skill id>`): new tasks for it are refused, a `["*"]` grant narrowed too.
pub fn client_skill_dropped(active: &[ConsoleEntry], client: &str, agent_skill: &str) -> bool {
    of(active, "client_drop_skill").any(|e| e.field("client") == client && e.field("skill") == agent_skill)
}

/// `client_a2a_limit`: the lowest `max_open_tasks` journaled for the client.
pub fn client_a2a_limit(active: &[ConsoleEntry], client: &str) -> Option<i64> {
    of(active, "client_a2a_limit").filter(|e| e.field("client") == client).filter_map(|e| e.target.get("max_open_tasks").and_then(Value::as_i64)).min()
}

/// `push_off`: no push of the client is delivered; its configs and credentials are deleted.
pub fn push_off(active: &[ConsoleEntry], client: &str) -> bool {
    of_string(active, "push_off", client).next().is_some()
}

/// `push_drop_origin`: pushes to that origin stop and configs under it are deleted.
pub fn push_origin_dropped(active: &[ConsoleEntry], client: &str, origin: &str) -> bool {
    of(active, "push_drop_origin").any(|e| e.field("client") == client && e.field("origin") == origin)
}

/// `push_private_off` and `card_private_off`: the client's `pinned` private CIDRs that stay reachable, each inside a
/// kept range of every active entry for the client (an entry naming the bare client id keeps none).
fn private_within(active: &[ConsoleEntry], action: &str, client: &str, pinned: &[String]) -> Vec<String> {
    let keeps: Vec<Vec<String>> = of(active, action).filter(|e| private_client(e) == client).map(|e| texts(e.target.get("keep"))).collect();
    pinned.iter().filter(|n| keeps.iter().all(|k| k.iter().any(|kept| api_map::cidr_within(n, kept)))).cloned().collect()
}

/// `push_private_off`: of the client's pinned `push.private_cidrs`, those pushes may still reach.
pub fn push_private_within(active: &[ConsoleEntry], client: &str, pinned: &[String]) -> Vec<String> {
    private_within(active, "push_private_off", client, pinned)
}

/// `card_private_off`: of the client's pinned `card.private_cidrs`, those partner card fetches may still reach.
pub fn card_private_within(active: &[ConsoleEntry], client: &str, pinned: &[String]) -> Vec<String> {
    private_within(active, "card_private_off", client, pinned)
}

/// `client_drop_app`: the app's conversations are no longer visible to the client.
#[cfg_attr(not(test), allow(dead_code))]
pub fn client_app_dropped(active: &[ConsoleEntry], client: &str, app: &str) -> bool {
    of(active, "client_drop_app").any(|e| e.field("client") == client && e.field("app") == app)
}

/// `client_limit_channels`: each active limit's channels; a conversation stays visible only when every list holds it
/// (and the pinned `channels` do).
#[cfg_attr(not(test), allow(dead_code))]
pub fn channel_limits(active: &[ConsoleEntry], client: &str) -> Vec<Vec<String>> {
    of(active, "client_limit_channels").filter(|e| e.field("client") == client).map(|e| texts(e.target.get("channels"))).collect()
}

/// `client_confirm`: the scopes that need a person's approval on every call besides the pinned `confirm`, each once.
#[cfg_attr(not(test), allow(dead_code))]
pub fn confirm_scopes(active: &[ConsoleEntry], client: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for e in of(active, "client_confirm").filter(|e| e.field("client") == client) {
        let scope = e.field("scope").to_string();
        if !out.contains(&scope) {
            out.push(scope);
        }
    }
    out
}

/// `connector_drop_app`: the connector serves that app's conversations to no client.
#[cfg_attr(not(test), allow(dead_code))]
pub fn connector_app_dropped(active: &[ConsoleEntry], connector: &str, app: &str) -> bool {
    of(active, "connector_drop_app").any(|e| e.field("connector") == connector && e.field("app") == app)
}

/// `connector_limit`: each active limit's networks; a caller must be inside one CIDR of every list (and of the pinned
/// `networks` when they are not empty).
#[cfg_attr(not(test), allow(dead_code))]
pub fn connector_networks(active: &[ConsoleEntry], connector: &str) -> Vec<Vec<String>> {
    of(active, "connector_limit").filter(|e| e.field("connector") == connector).map(|e| texts(e.target.get("networks"))).collect()
}

// ── the store ──

#[derive(Clone, Debug, Default)]
struct OrgCJournal {
    /// Every entry, in `cseq` order.
    entries: Vec<ConsoleEntry>,
    /// Ids a pinned map folded or cleared.
    settled: Vec<String>,
}

impl OrgCJournal {
    fn last(&self) -> u64 {
        self.entries.last().map_or(0, |e| e.cseq)
    }

    fn last_connector(&self) -> u64 {
        self.entries.iter().rev().find(|e| e.reach == Reach::Connector).map_or(0, |e| e.cseq)
    }

    fn active(&self) -> Vec<ConsoleEntry> {
        self.entries.iter().filter(|e| !self.settled.contains(&e.id)).cloned().collect()
    }
}

/// The console journals of every org (in memory without a folder).
#[derive(Debug, Default)]
pub struct ConsoleJournals {
    dir: Option<PathBuf>,
    orgs: BTreeMap<String, OrgCJournal>,
}

fn io(e: impl std::fmt::Display) -> ApiMapError {
    ApiMapError::new("io", e.to_string())
}

fn org_ok(s: &str) -> bool {
    (1..=32).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

impl ConsoleJournals {
    /// Every journal under `<dir>/api-console-journal`; a torn or broken line ends its org's journal there (the
    /// unreadable lines come back by org for the caller's security line).
    pub fn load(dir: Option<&Path>) -> (ConsoleJournals, Vec<(String, u64)>) {
        let dir = dir.map(|d| d.join(DIR));
        let mut orgs: BTreeMap<String, OrgCJournal> = BTreeMap::new();
        let mut broken = Vec::new();
        for entry in dir.as_ref().and_then(|d| std::fs::read_dir(d).ok()).into_iter().flatten().flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let text = std::fs::read_to_string(entry.path()).unwrap_or_default();
            if let Some(org) = name.strip_suffix(".jsonl").filter(|o| org_ok(o)) {
                let j = orgs.entry(org.to_string()).or_default();
                for line in text.lines().filter(|l| !l.trim().is_empty()) {
                    match parse_json(line).and_then(|v| check_console_entry(&v, j.last(), j.last_connector()).ok()).filter(|e| e.org == org) {
                        Some(e) => j.entries.push(e),
                        None => {
                            broken.push((org.to_string(), j.last() + 1));
                            break;
                        }
                    }
                }
            } else if let Some(org) = name.strip_suffix(".settled.json").filter(|o| org_ok(o)) {
                let v = parse_json(&text).unwrap_or(Value::Null);
                orgs.entry(org.to_string()).or_default().settled = v.get("settled").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect();
            }
        }
        (ConsoleJournals { dir, orgs }, broken)
    }

    fn append_line(&self, org: &str, entry: &Value) -> Result<(), ApiMapError> {
        let Some(dir) = &self.dir else { return Ok(()) };
        crate::store::make_dir(dir).map_err(io)?;
        let mut o = std::fs::OpenOptions::new();
        o.append(true).create(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            o.mode(0o600);
        }
        let mut f = o.open(dir.join(format!("{org}.jsonl"))).map_err(io)?;
        f.write_all(format!("{}\n", stringify(entry)).as_bytes()).map_err(io)?;
        f.sync_all().map_err(io)?;
        #[cfg(unix)]
        if let Ok(d) = std::fs::File::open(dir) {
            let _ = d.sync_all();
        }
        Ok(())
    }

    fn save_settled(&self, org: &str, j: &OrgCJournal) -> Result<(), ApiMapError> {
        let Some(dir) = &self.dir else { return Ok(()) };
        crate::store::make_dir(dir).map_err(io)?;
        crate::fleet_local::write_durable(&dir.join(format!("{org}.settled.json")), stringify(&json!({ "settled": j.settled })).as_bytes()).map_err(io)
    }

    /// 2.3 item 4: append a console journal action as the org's next `cseq` (with `prev_cseq` for a 4b action),
    /// checked, and flushed to disk before Ok: the caller lets it take effect and answers the admin only then.
    pub fn append(&mut self, org: &str, action: &str, target: Value, now: i64) -> Result<ConsoleEntry, ApiMapError> {
        if !org_ok(org) {
            return no("not-tightening", "that is not an organization id");
        }
        let j = self.orgs.get(org).cloned().unwrap_or_default();
        let cseq = j.last() + 1;
        let reach = reach_of(action).ok_or_else(|| ApiMapError::new("not-tightening", format!("{action:?} is not a console journal action")))?;
        let mut v = json!({ "id": format!("k_{org}_{cseq:06}"), "cseq": cseq, "ts": now, "action": action, "target": target, "reach": reach.as_str() });
        if reach == Reach::Connector {
            v["prev_cseq"] = json!(j.last_connector());
        }
        let e = check_console_entry(&v, j.last(), j.last_connector())?;
        self.append_line(org, &v)?;
        self.orgs.entry(org.to_string()).or_default().entries.push(e.clone());
        Ok(e)
    }

    /// Fold-check a map before it is pinned (`fold`, against the org's active entries).
    pub fn check_map(&self, org: &str, map: &Value) -> Result<(), ApiMapError> {
        fold(&self.active(org), map).map(|_| ())
    }

    /// A map was pinned: the entries it settles leave the active set, flushed. True when any did.
    pub fn settle(&mut self, org: &str, map: &Value) -> Result<bool, ApiMapError> {
        let Some(j) = self.orgs.get(org) else { return Ok(false) };
        let gone: Vec<String> = j.active().iter().filter(|e| settled_by(map, e)).map(|e| e.id.clone()).collect();
        if gone.is_empty() {
            return Ok(false);
        }
        let mut next = j.clone();
        next.settled.extend(gone);
        self.save_settled(org, &next)?;
        self.orgs.insert(org.to_string(), next);
        Ok(true)
    }

    /// The org's entries not yet folded or cleared, in `cseq` order.
    pub fn active(&self, org: &str) -> Vec<ConsoleEntry> {
        self.orgs.get(org).map(OrgCJournal::active).unwrap_or_default()
    }

    /// Every entry of the org kept (the ids a save may still list), in `cseq` order.
    pub fn entries(&self, org: &str) -> Vec<ConsoleEntry> {
        self.orgs.get(org).map(|j| j.entries.clone()).unwrap_or_default()
    }

    /// 4b: the org's connector entries after `cseq`, in order (what revision 5 syncs to connectors).
    pub fn connector_entries(&self, org: &str, after: u64) -> Vec<ConsoleEntry> {
        self.orgs.get(org).into_iter().flat_map(|j| j.entries.iter()).filter(|e| e.reach == Reach::Connector && e.cseq > after).cloned().collect()
    }

    /// The org's last `cseq` (0: none).
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn head(&self, org: &str) -> u64 {
        self.orgs.get(org).map_or(0, OrgCJournal::last)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_795_000_000;
    const C1: &str = "c_0000000000000001";

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("lucid-api-cjournal-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    fn map(clients: Value) -> Value {
        json!({"v": 2, "org": "acme", "issued": NOW, "folded": [], "cleared": [], "clients": clients,
               "webhook_keys": [{"kid": "wk-1"}], "federation": {"keys": [{"kid": "fk-1"}]}})
    }

    fn compliance_client(state: &str) -> Value {
        json!({"id": C1, "state": state, "compliance": {"holds_per_day": 20, "recipient": {"kid": "r-1"}, "job_max_bytes": 1 << 30, "day_max_bytes": 4_i64 << 30, "jobs_per_day": 5}})
    }

    #[test]
    fn console_entries_are_checked_in_order_and_never_widen() {
        let ok = |action: &str, target: Value| json!({"id": "k_acme_000001", "cseq": 1, "ts": NOW, "action": action, "target": target, "reach": "console"});
        assert!(check_console_entry(&ok("client_lower_caps", json!({"client": C1, "jobs_per_day": 1})), 0, 0).is_ok());
        assert!(check_console_entry(&ok("client_drop_recipient", json!({"client": C1, "kid": "r-1"})), 0, 0).is_ok());
        assert!(check_console_entry(&ok("federation_drop_key", json!({"kid": "fk-1"})), 0, 0).is_ok());
        assert!(check_console_entry(&ok("webhook_key_drop", json!({"kid": "wk-1"})), 0, 0).is_ok());
        let code = |v: Value, last: u64| check_console_entry(&v, last, 0).err().map_or("ok", |e| e.code);
        assert_eq!(code(ok("client_lower_caps", json!({"client": C1})), 0), "not-tightening", "at least one cap");
        assert_eq!(code(ok("client_lower_caps", json!({"client": C1, "jobs_per_day": 21})), 0), "not-tightening");
        assert_eq!(code(ok("client_raise_caps", json!({"client": C1, "jobs_per_day": 1})), 0), "not-tightening");
        assert_eq!(code(ok("client_drop_recipient", json!({"client": C1, "kid": "r-1"})), 1), "cseq-gap");
        let mut v = ok("webhook_key_drop", json!({"kid": "wk-1"}));
        v["reach"] = json!("connector");
        assert_eq!(code(v, 0), "not-tightening", "reach is the action's");
        let mut v = ok("webhook_key_drop", json!({"kid": "wk-1"}));
        v["prev_cseq"] = json!(0);
        assert_eq!(code(v, 0), "not-tightening", "a console entry has no prev_cseq");
        let mut v = ok("webhook_key_drop", json!({"kid": "wk-1"}));
        v["id"] = json!("t_acme_000001");
        assert_eq!(code(v, 0), "not-tightening");
    }

    #[test]
    fn console_entries_fold_and_clear() {
        let e = |cseq: u64, action: &str, target: Value, ts: i64| {
            ConsoleEntry::parse(&json!({"id": format!("k_acme_{cseq:06}"), "cseq": cseq, "ts": ts, "action": action, "target": target, "reach": "console"})).unwrap()
        };
        let caps = e(1, "client_lower_caps", json!({"client": C1, "jobs_per_day": 2}), NOW - 10);
        let rcpt = e(2, "client_drop_recipient", json!({"client": C1, "kid": "r-1"}), NOW - 10);
        let fed = e(3, "federation_drop_key", json!({"kid": "fk-1"}), NOW - 10);
        let wh = e(4, "webhook_key_drop", json!({"kid": "wk-9"}), NOW - 10);
        let active = vec![caps.clone(), rcpt.clone(), fed.clone(), wh.clone()];
        let mut m = map(json!([compliance_client("active")]));
        assert_eq!(fold(&active, &m).unwrap().len(), 4);
        m["folded"] = json!(["k_acme_000001"]);
        assert_eq!(fold(&active, &m).unwrap_err().code, "fold-mismatch", "jobs_per_day 5 is above 2");
        m["clients"][0]["compliance"]["jobs_per_day"] = json!(2);
        m["folded"] = json!(["k_acme_000001", "k_acme_000004"]);
        assert_eq!(fold(&active, &m).unwrap(), ["k_acme_000002", "k_acme_000003"]);
        m["folded"] = json!(["k_acme_000003"]);
        assert_eq!(fold(&active, &m).unwrap_err().code, "fold-mismatch", "the map still lists fk-1");
        m["cleared"] = json!(["k_acme_000002"]);
        m["folded"] = json!([]);
        assert_eq!(fold(&active, &m).unwrap().len(), 3, "a recipient drop may be cleared");
        m["cleared"] = json!(["k_acme_000003"]);
        assert_eq!(fold(&active, &m).unwrap_err().code, "fold-mismatch", "a key drop is never cleared");
        let late = e(5, "client_lower_caps", json!({"client": C1, "holds_per_day": 1}), NOW);
        m["cleared"] = json!(["k_acme_000005"]);
        assert_eq!(fold(std::slice::from_ref(&late), &m).unwrap_err().code, "fold-mismatch", "a clear needs a later map");
        let suspended = map(json!([compliance_client("suspended")]));
        assert!(contains(&suspended, &caps) && contains(&suspended, &rcpt));
        // the effect at once
        let pinned = map(json!([compliance_client("active")]));
        assert_eq!(super::caps(Some(&pinned), &active, C1).get("jobs_per_day"), Some(&2));
        assert_eq!(super::caps(Some(&pinned), &active, C1).get("holds_per_day"), Some(&20));
        assert!(recipient_dropped(&active, C1, "r-1") && !recipient_dropped(&active, C1, "r-2"));
        assert!(key_dropped(&active, "federation_drop_key", "fk-1") && !key_dropped(&active, "webhook_key_drop", "fk-1"));
    }

    /// The shared vectors (`tests/vectors/make_api_map_v2.py` in the Meeting Hub, copied to `tests/api_journal_v2.json`).
    #[test]
    fn the_journal_v2_vectors_give_the_expected_verdicts() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("api_journal_v2.json");
        let text = std::fs::read_to_string(&path).unwrap_or_else(|_| panic!("{} is missing: run make_api_map_v2.py and copy it", path.display()));
        let doc: Value = serde_json::from_str(&text).unwrap();
        for c in doc["console"].as_array().unwrap() {
            let got = check_console_entry(&c["entry"], c["last_cseq"].as_u64().unwrap(), c["last_connector"].as_u64().unwrap()).err().map_or("ok", |e| e.code);
            assert_eq!(got, c["expect"].as_str().unwrap(), "console/{}", c["name"]);
        }
        for c in doc["fold"].as_array().unwrap() {
            let active: Vec<ConsoleEntry> = c["active"].as_array().unwrap().iter().map(|e| ConsoleEntry::parse(e).unwrap()).collect();
            match (fold(&active, &c["map"]), &c["expect"]) {
                (Ok(remaining), Value::Object(want)) => assert_eq!(json!(remaining), want["remaining"], "fold/{}", c["name"]),
                (Err(e), Value::String(want)) => assert_eq!(e.code, want.as_str(), "fold/{}", c["name"]),
                (got, want) => panic!("fold/{}: got {got:?}, want {want}", c["name"]),
            }
        }
        let m = &doc["map"];
        let issued = m["issued"].as_i64().unwrap();
        crate::api_map::check_api_map(m, issued, None, crate::api_map::Edition::Enterprise, &BTreeMap::new()).unwrap();
    }

    #[test]
    fn the_store_appends_durably_settles_and_reloads() {
        let dir = temp("store");
        let (mut s, broken) = ConsoleJournals::load(Some(&dir));
        assert!(broken.is_empty());
        let a = s.append("acme", "client_lower_caps", json!({"client": C1, "jobs_per_day": 2}), NOW - 10).unwrap();
        assert_eq!((a.id.as_str(), a.cseq, a.reach, a.prev_cseq), ("k_acme_000001", 1, Reach::Console, None));
        assert_eq!(s.append("acme", "webhook_key_drop", json!({"kid": "wk-1"}), NOW - 5).unwrap().cseq, 2);
        assert_eq!(s.append("acme", "client_lower_caps", json!({"client": C1}), NOW).unwrap_err().code, "not-tightening");
        assert_eq!(s.head("acme"), 2);
        let mut m = map(json!([]));
        m["folded"] = json!(["k_acme_000001"]);
        s.check_map("acme", &m).unwrap();
        assert!(s.settle("acme", &m).unwrap());
        let (back, broken) = ConsoleJournals::load(Some(&dir));
        assert!(broken.is_empty());
        assert_eq!(back.entries("acme").len(), 2);
        let active: Vec<String> = back.active("acme").into_iter().map(|e| e.id).collect();
        assert_eq!(active, ["k_acme_000002"]);
        assert!(back.connector_entries("acme", 0).is_empty(), "revision 4 has no connector actions");
        // a torn line ends the journal there
        let path = dir.join(DIR).join("acme.jsonl");
        let mut text = std::fs::read_to_string(&path).unwrap();
        text.push_str("{\"id\": \"k_acme_0000");
        std::fs::write(&path, text).unwrap();
        let (back, broken) = ConsoleJournals::load(Some(&dir));
        assert_eq!(broken, [("acme".to_string(), 3)]);
        assert_eq!(back.head("acme"), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- revision 5 4.2 (slice 1c3) ----

    const K1: &str = "k_7a1b2c3d4e5f6a7b";
    const APP: &str = "helpdesk-api@apps.acme.example";
    const URI: &str = "https://app.acme.example/cb";

    fn entry_of(cseq: u64, action: &str, target: Value, ts: i64) -> Value {
        let reach = reach_of(action).map_or("console", Reach::as_str);
        let mut v = json!({"id": format!("k_acme_{cseq:06}"), "cseq": cseq, "ts": ts, "action": action, "target": target, "reach": reach});
        if reach == "connector" {
            v["prev_cseq"] = json!(0);
        }
        v
    }

    fn r5(cseq: u64, action: &str, target: Value) -> ConsoleEntry {
        ConsoleEntry::parse(&entry_of(cseq, action, target, NOW - 10)).unwrap()
    }

    fn map_1c() -> Value {
        json!({"v": 2, "org": "acme", "issued": NOW, "folded": [], "cleared": [],
               "connectors": [{"id": K1, "apps": [APP], "networks": ["10.40.0.0/24"], "state": "active"}],
               "idps": [{"id": "okta", "algs": ["RS256"], "max_age_s": 300, "tenant": "t1", "private_ok": false, "state": "active"}],
               "clients": [{"id": C1, "kind": "agent_delegated", "state": "active", "connectors": [K1], "apps": [APP], "channels": ["ch:a"], "confirm": ["content.post"],
                            "delegation": {"groups": ["g1"], "principals": ["ann@acme.example"], "idps": ["okta"], "consent_days": 7, "denied": ["eve@acme.example"]},
                            "redirect_uris": [URI]}]})
    }

    /// The good target of each revision 5 action.
    fn r5_targets() -> Vec<(&'static str, Value)> {
        vec![
            ("client_drop_connector", json!({"client": C1, "connector": K1})),
            ("client_drop_app", json!({"client": C1, "app": APP})),
            ("client_limit_channels", json!({"client": C1, "channels": ["ch:a", "ch:b"]})),
            ("client_confirm", json!({"client": C1, "scope": "content.read"})),
            ("client_drop_delegation", json!({"client": C1, "group": "g1"})),
            ("connector_suspend", json!(K1)),
            ("idp_suspend", json!("okta")),
            ("person_revoke", json!({"client": C1, "principal": "bob@acme.example"})),
            ("connector_drop_app", json!({"connector": K1, "app": APP})),
            ("connector_limit", json!({"connector": K1, "networks": ["10.40.0.0/16"]})),
            ("idp_limit", json!({"idp": "okta", "max_age_s": 120})),
            ("client_limit_delegation", json!({"client": C1, "consent_days": 3})),
            ("client_drop_redirect", json!({"client": C1, "uri": URI})),
        ]
    }

    #[test]
    fn revision_5_actions_have_their_reach_and_targets() {
        let code = |v: Value| check_console_entry(&v, 0, 0).err().map_or("ok", |e| e.code);
        let targets = r5_targets();
        assert_eq!(targets.len(), 13);
        for (action, t) in &targets {
            assert_eq!(code(entry_of(1, action, t.clone(), NOW)), "ok", "{action}");
        }
        let connector: Vec<&str> = ACTIONS.iter().filter(|(_, r)| *r == Reach::Connector).map(|(a, _)| *a).collect();
        assert_eq!(
            connector,
            [
                "client_drop_connector", "client_drop_app", "client_limit_channels", "client_confirm", "connector_suspend", "person_revoke", "connector_drop_app", "connector_limit",
                // revision 6 2.3
                "agent_off", "agent_drop_skill", "push_off", "push_drop_origin", "client_drop_agent", "client_drop_skill", "client_a2a_limit", "push_private_off",
            ]
        );
        for (action, bad) in [
            ("client_drop_connector", json!({"client": C1, "connector": "k_123"})),
            ("client_drop_app", json!({"client": C1, "app": "ann@acme.example"})),
            ("client_limit_channels", json!({"client": C1, "channels": ["*"]})),
            ("client_limit_channels", json!({"client": C1, "channels": []})),
            ("client_limit_channels", json!({"client": C1, "channels": ["ch:a", "ch:a"]})),
            ("client_confirm", json!({"client": C1, "scope": "monitor.read"})),
            ("client_drop_delegation", json!({"client": C1})),
            ("client_drop_delegation", json!({"client": C1, "group": "g1", "idp": "okta"})),
            ("connector_suspend", json!({"connector": K1})),
            ("idp_suspend", json!("Okta")),
            ("person_revoke", json!({"client": "*", "principal": "bot@apps.acme.example"})),
            ("person_revoke", json!({"client": "c_1", "principal": "bob@acme.example"})),
            ("connector_drop_app", json!({"connector": K1})),
            ("connector_limit", json!({"connector": K1, "networks": ["10.40.0.1/16"]})),
            ("idp_limit", json!({"idp": "okta"})),
            ("idp_limit", json!({"idp": "okta", "private_ok": true})),
            ("idp_limit", json!({"idp": "okta", "algs": ["HS256"]})),
            ("idp_limit", json!({"idp": "okta", "max_age_s": 601})),
            ("client_limit_delegation", json!({"client": C1, "consent_days": 31})),
            ("client_drop_redirect", json!({"client": C1, "uri": "http://localhost/cb"})),
        ] {
            assert_eq!(code(entry_of(1, action, bad.clone(), NOW)), "not-tightening", "{action} {bad}");
        }
        assert!(target_ok("person_revoke", &json!({"client": "*", "principal": "bob@acme.example"})));
        assert!(target_ok("idp_limit", &json!({"idp": "okta", "algs": ["ES256"], "tenant": "t1", "private_ok": false})));
        // a connector entry names the previous connector cseq; a console entry has none
        let mut v = entry_of(3, "connector_suspend", json!(K1), NOW);
        v["prev_cseq"] = json!(1);
        assert_eq!(check_console_entry(&v, 2, 1).err().map_or("ok", |e| e.code), "ok");
        assert_eq!(check_console_entry(&v, 2, 2).err().map_or("ok", |e| e.code), "prev-cseq");
        let mut v = entry_of(1, "idp_suspend", json!("okta"), NOW);
        v["prev_cseq"] = json!(0);
        assert_eq!(code(v), "not-tightening");
    }

    /// Each action folds when the map holds it, not otherwise (a widening forgery), and clears by a later map;
    /// `person_revoke` clears only once `denied` no longer lists the principal.
    #[test]
    fn revision_5_actions_fold_and_clear() {
        let held = |f: &dyn Fn(&mut Value)| {
            let mut m = map_1c();
            f(&mut m);
            m
        };
        let cases: Vec<(ConsoleEntry, Value, Value)> = vec![
            (r5(1, "client_drop_connector", json!({"client": C1, "connector": K1})), held(&|m| m["clients"][0]["connectors"] = json!([])), map_1c()),
            (r5(2, "client_drop_app", json!({"client": C1, "app": APP})), held(&|m| m["clients"][0]["apps"] = json!([])), map_1c()),
            (r5(3, "client_limit_channels", json!({"client": C1, "channels": ["ch:a", "ch:b"]})), map_1c(), held(&|m| m["clients"][0]["channels"] = json!(["*"]))),
            (r5(4, "client_confirm", json!({"client": C1, "scope": "content.read"})), held(&|m| m["clients"][0]["confirm"] = json!(["content.post", "content.read"])), map_1c()),
            (r5(5, "client_drop_delegation", json!({"client": C1, "group": "g1"})), held(&|m| m["clients"][0]["delegation"]["groups"] = json!([])), map_1c()),
            (r5(6, "connector_suspend", json!(K1)), held(&|m| m["connectors"][0]["state"] = json!("suspended")), map_1c()),
            (r5(7, "idp_suspend", json!("okta")), held(&|m| m["idps"] = json!([])), map_1c()),
            (r5(8, "person_revoke", json!({"client": C1, "principal": "eve@acme.example"})), map_1c(), held(&|m| m["clients"][0]["delegation"]["denied"] = json!([]))),
            (r5(9, "connector_drop_app", json!({"connector": K1, "app": APP})), held(&|m| m["connectors"] = json!([])), map_1c()),
            (r5(10, "connector_limit", json!({"connector": K1, "networks": ["10.40.0.0/16"]})), map_1c(), held(&|m| m["connectors"][0]["networks"] = json!([]))),
            (r5(11, "idp_limit", json!({"idp": "okta", "max_age_s": 300, "private_ok": false})), map_1c(), held(&|m| m["idps"][0]["max_age_s"] = json!(301))),
            (r5(12, "client_limit_delegation", json!({"client": C1, "consent_days": 7})), map_1c(), held(&|m| m["clients"][0]["delegation"]["consent_days"] = json!(8))),
            (r5(13, "client_drop_redirect", json!({"client": C1, "uri": URI})), held(&|m| m["clients"][0]["redirect_uris"] = json!([])), map_1c()),
        ];
        for (e, holds, widens) in &cases {
            assert!(contains(holds, e), "{} holds", e.action);
            assert!(!contains(widens, e), "{} does not hold", e.action);
            let mut m = holds.clone();
            m["folded"] = json!([e.id]);
            assert_eq!(fold(std::slice::from_ref(e), &m), Ok(vec![]), "{} folds", e.action);
            // the widening forgery: a map that folds an entry it does not hold
            let mut m = widens.clone();
            m["folded"] = json!([e.id]);
            assert_eq!(fold(std::slice::from_ref(e), &m).unwrap_err().code, "fold-mismatch", "{} forged", e.action);
            // cleared by a map issued after it (person_revoke: only once denied no longer lists the person)
            let mut m = held(&|m| m["clients"][0]["delegation"]["denied"] = json!([]));
            m["cleared"] = json!([e.id]);
            assert_eq!(fold(std::slice::from_ref(e), &m), Ok(vec![]), "{} clears", e.action);
            assert!(settled_by(&m, e));
            m["issued"] = json!(NOW - 20);
            assert_eq!(fold(std::slice::from_ref(e), &m).unwrap_err().code, "fold-mismatch", "{} clears only later", e.action);
        }
        // absence counts only where the table says so
        let absent = held(&|m| {
            m["clients"] = json!([]);
            m["connectors"] = json!([]);
            m["idps"] = json!([]);
        });
        let folds_absent: Vec<&str> = cases.iter().filter(|(e, _, _)| contains(&absent, e)).map(|(e, _, _)| e.action.as_str()).collect();
        assert_eq!(folds_absent, ["client_drop_connector", "connector_suspend", "idp_suspend", "connector_drop_app"]);
        // person_revoke is not cleared while denied still lists the person
        let revoke = &cases[7].0;
        let mut m = map_1c();
        m["cleared"] = json!([revoke.id]);
        assert_eq!(fold(std::slice::from_ref(revoke), &m).unwrap_err().code, "fold-mismatch");
        assert!(!settled_by(&m, revoke));
        // `*`: every agent_delegated client denies (fold), none does (clear)
        let all = r5(14, "person_revoke", json!({"client": "*", "principal": "eve@acme.example"}));
        let mut two = map_1c();
        let mut other = two["clients"][0].clone();
        other["id"] = json!("c_0000000000000002");
        other["delegation"]["denied"] = json!([]);
        two["clients"].as_array_mut().unwrap().push(other);
        assert!(contains(&map_1c(), &all) && !contains(&two, &all));
        two["cleared"] = json!([all.id]);
        assert_eq!(fold(std::slice::from_ref(&all), &two).unwrap_err().code, "fold-mismatch", "one client still denies");
        two["clients"][0]["delegation"]["denied"] = json!([]);
        assert_eq!(fold(std::slice::from_ref(&all), &two), Ok(vec![]));
        // a `*` revoke stays active after a fold (even with no delegated client), so a later client still refuses
        let mut folds = map_1c();
        folds["folded"] = json!([all.id]);
        assert_eq!(fold(std::slice::from_ref(&all), &folds), Ok(vec![all.id.clone()]));
        assert!(!settled_by(&folds, &all));
        let mut none = folds.clone();
        none["clients"] = json!([]);
        assert_eq!(fold(std::slice::from_ref(&all), &none), Ok(vec![all.id.clone()]));
        let (mut s, _) = ConsoleJournals::load(None);
        let e = s.append("acme", "person_revoke", json!({"client": "*", "principal": "eve@acme.example"}), NOW).unwrap();
        none["folded"] = json!([e.id]);
        none["issued"] = json!(NOW + 10);
        assert_eq!(s.settle("acme", &none), Ok(false));
        assert!(person_revoked(&s.active("acme"), "c_0000000000000009", "eve@acme.example"), "a client added later still refuses");
    }

    #[test]
    fn revision_5_effect_helpers() {
        let active = vec![
            r5(1, "person_revoke", json!({"client": C1, "principal": "bob@acme.example"})),
            r5(2, "person_revoke", json!({"client": "*", "principal": "eve@acme.example"})),
            r5(3, "connector_suspend", json!(K1)),
            r5(4, "idp_suspend", json!("okta")),
            r5(5, "idp_limit", json!({"idp": "okta", "algs": ["ES256"], "max_age_s": 120, "private_ok": false})),
            r5(6, "client_drop_delegation", json!({"client": C1, "group": "g1"})),
            r5(7, "client_limit_delegation", json!({"client": C1, "consent_days": 3})),
            r5(8, "client_limit_delegation", json!({"client": C1, "consent_days": 5})),
            r5(9, "client_drop_redirect", json!({"client": C1, "uri": URI})),
            r5(10, "client_drop_connector", json!({"client": C1, "connector": K1})),
            r5(11, "client_drop_app", json!({"client": C1, "app": APP})),
            r5(12, "client_limit_channels", json!({"client": C1, "channels": ["ch:a"]})),
            r5(13, "client_confirm", json!({"client": C1, "scope": "content.read"})),
            r5(14, "client_confirm", json!({"client": C1, "scope": "content.read"})),
            r5(15, "connector_drop_app", json!({"connector": K1, "app": APP})),
            r5(16, "connector_limit", json!({"connector": K1, "networks": ["10.40.0.0/24"]})),
        ];
        const C2: &str = "c_0000000000000002";
        assert!(person_revoked(&active, C1, "bob@acme.example") && !person_revoked(&active, C2, "bob@acme.example"));
        assert!(person_revoked(&active, C2, "eve@acme.example"), "* covers every client");
        assert!(connector_suspended(&active, K1) && !connector_suspended(&active, "k_0000000000000002"));
        assert!(idp_suspended(&active, "okta") && !idp_suspended(&active, "entra"));
        let pinned = json!({"id": "okta", "algs": ["RS256", "ES256"], "max_age_s": 300, "private_ok": true, "state": "active"});
        let eff = idp_effective(&pinned, &active);
        assert_eq!((eff["algs"].clone(), eff["max_age_s"].clone(), eff["private_ok"].clone(), eff["auth_max_s"].clone()), (json!(["ES256"]), json!(120), json!(false), json!(43200)));
        let other_tenant = [r5(1, "idp_limit", json!({"idp": "okta", "tenant": "t2"}))];
        assert_eq!(idp_effective(&json!({"id": "okta", "algs": ["RS256"], "tenant": "t1"}), &other_tenant)["algs"], json!([]), "two tenants accept nothing");
        assert_eq!(idp_effective(&json!({"id": "okta", "algs": ["RS256"]}), &other_tenant)["tenant"], json!("t2"));
        assert!(delegation_dropped(&active, C1, "group", "g1") && !delegation_dropped(&active, C1, "idp", "g1"));
        assert_eq!((consent_days(7, &active, C1), consent_days(2, &active, C1), consent_days(7, &active, C2)), (3, 2, 7));
        assert!(redirect_dropped(&active, C1, URI) && !redirect_dropped(&active, C2, URI));
        assert!(client_connector_dropped(&active, C1, K1) && !client_connector_dropped(&active, C2, K1));
        assert!(client_app_dropped(&active, C1, APP) && !client_app_dropped(&active, C1, "sales-api@apps.acme.example"));
        assert_eq!(channel_limits(&active, C1), [vec!["ch:a".to_string()]]);
        assert!(channel_limits(&active, C2).is_empty());
        assert_eq!(confirm_scopes(&active, C1), ["content.read"]);
        assert!(connector_app_dropped(&active, K1, APP) && !connector_app_dropped(&active, K1, "sales-api@apps.acme.example"));
        assert_eq!(connector_networks(&active, K1), [vec!["10.40.0.0/24".to_string()]]);
    }

    #[test]
    fn connector_entries_chain_their_prev_cseq() {
        let (mut s, _) = ConsoleJournals::load(None);
        let a = s.append("acme", "connector_suspend", json!(K1), NOW).unwrap();
        assert_eq!((a.reach, a.prev_cseq), (Reach::Connector, Some(0)));
        s.append("acme", "idp_suspend", json!("okta"), NOW).unwrap();
        let c = s.append("acme", "person_revoke", json!({"client": "*", "principal": "eve@acme.example"}), NOW).unwrap();
        assert_eq!((c.cseq, c.prev_cseq), (3, Some(1)), "the console entry between is skipped");
        let synced: Vec<u64> = s.connector_entries("acme", 0).iter().map(|e| e.cseq).collect();
        assert_eq!(synced, [1, 3]);
    }

    /// Revision 6 2.3 (ReviewW6c): `push_private_off` and `card_private_off` take the bare client id (every private
    /// range off) or `{client, keep}` (a narrowed list); the enforcing side reaches only pinned ranges inside every
    /// entry's `keep`, and an entry folds once the pinned list is as narrow.
    #[test]
    fn private_cidr_narrowings_keep_ranges_and_fold_when_the_map_is_as_narrow() {
        for action in ["push_private_off", "card_private_off"] {
            assert!(target_ok(action, &json!(C1)));
            assert!(target_ok(action, &json!({"client": C1, "keep": ["10.40.0.0/16"]})));
            assert!(!target_ok(action, &json!({"client": C1, "keep": []})), "an emptied list is the bare id");
            assert!(!target_ok(action, &json!({"client": C1, "keep": ["10.40.0.1/16"]})));
            assert!(!target_ok(action, &json!({"client": C1, "keep": ["10.40.0.0/16"], "more": 1})));
        }
        let pinned: Vec<String> = ["10.40.0.0/23", "10.50.0.0/24", "192.168.1.0/24"].iter().map(|s| s.to_string()).collect();
        let keep = r5(1, "push_private_off", json!({"client": C1, "keep": ["10.40.0.0/16", "192.168.0.0/16"]}));
        let tighter = r5(2, "push_private_off", json!({"client": C1, "keep": ["10.0.0.0/8"]}));
        assert_eq!(push_private_within(&[], C1, &pinned), pinned);
        assert_eq!(push_private_within(std::slice::from_ref(&keep), C1, &pinned), ["10.40.0.0/23", "192.168.1.0/24"]);
        assert_eq!(push_private_within(&[keep.clone(), tighter], C1, &pinned), ["10.40.0.0/23"], "every entry applies");
        assert!(push_private_within(&[r5(3, "push_private_off", json!(C1))], C1, &pinned).is_empty());
        assert_eq!(push_private_within(std::slice::from_ref(&keep), "c_0000000000000002", &pinned), pinned, "another client");
        assert_eq!(card_private_within(std::slice::from_ref(&keep), C1, &pinned), pinned, "the push entry leaves card fetches alone");
        // folding
        let with = |cidrs: Value| map(json!([{"id": C1, "state": "active", "a2a": {"push": {"origins": ["https://ci.partner.example"], "private_cidrs": cidrs}}}]));
        assert!(!contains(&with(json!(["10.50.0.0/24"])), &keep), "a range outside keep");
        assert!(contains(&with(json!(["10.40.0.0/24", "192.168.1.0/24"])), &keep), "as narrow");
        assert!(contains(&with(json!([])), &keep));
        assert!(!contains(&with(json!(["10.40.0.0/24"])), &r5(3, "push_private_off", json!(C1))), "the bare id folds only when empty");
        let card = r5(4, "card_private_off", json!({"client": C1, "keep": ["10.40.0.0/16"]}));
        assert!(contains(&map(json!([{"id": C1, "state": "active", "card": {"private_cidrs": ["10.40.1.0/24"]}}])), &card));
        assert!(!contains(&map(json!([{"id": C1, "state": "active", "card": {"private_cidrs": ["10.41.0.0/24"]}}])), &card));
    }
}
