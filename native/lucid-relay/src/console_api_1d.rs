// Contract API-1 revision 6 (docs/api/contract-r6-1d.md) 2.2, 2.3, 7.14, 13 and 17.6, slice 1d5: the rules of the
// console's Agents and Remote Spokes tabs, without any I/O. Every staging route's change to the org's draft
// (`console_api_ui::Draft`): agents (`a2a.agents`), the root well-known card (`a2a.well_known`), `spokes.root`, a
// client's push turned off; the A2A narrowings a save journals at once (2.3, placed by `api_cjournal::ACTIONS`);
// the two-person reasons of 13; the refusals `card-version` and `well-known-taken`; and the views the tabs read
// (A2aView, AgentView, TaskView, SpokesView, the client hand-off): no secret, no key material, no task text.
//
// console_fleet.rs runs the routes: it draws the `a_` ids, journals the narrowings through `api_journal`, makes and
// drops card keys and signs cards (`console_a2a`), and reads the connectors' acknowledgments and audit chains.

use crate::api_cjournal::ConsoleEntry;
use crate::api_map;
use crate::console::ApiError;
use crate::console_api_ui::{by_id, find, find_mut, invalid, list_mut, not_found, s, strs, tighten, Draft, Tighten, NO_CLIENT, TWO_A2A_AGENT, TWO_A2A_CLIENT, TWO_A2A_PRIVATE, TWO_WELL_KNOWN};
use serde_json::{json, Map, Value};

// ── words (7.14, 7.1.3, 2.2) ────────────────────────────────────────────────────────────────────────────────────

pub const CARD_VERSION: &str = "Change the agent's version: its card changes with this save.";
pub const WELL_KNOWN_TAKEN: &str = "Another organization on this console already publishes the root agent card.";
pub const NO_AGENT: &str = "There is no such agent.";
pub const NO_WELL_KNOWN: &str = "Nothing was changed: no agent is published at the root well-known address.";
pub const NO_PUSH: &str = "Nothing was changed: that client has no push.";
pub const OTHER_ROOT: &str = "A connected spokes relay of this organization holds another Remote Spokes root. Make the console's Remote Spokes root the one those relays hold first.";
pub const NO_ROOT: &str = "Set the Remote Spokes root of this console first.";

// ── limits (2.2, 7.14) ──────────────────────────────────────────────────────────────────────────────────────────

/// 2.2 `a2a.agents`: 0 to 16.
pub const AGENTS_MAX: usize = 16;
/// `GET settings/api/a2a/tasks`: at most this many, newest first.
pub const TASKS_MAX: usize = 200;
/// The audit action of the connector's task records (Build1d4).
pub const TASK_ACTION: &str = "a2a.task";
/// 7.6: the task states, lower case.
pub const TASK_STATES: [&str; 8] = ["submitted", "working", "input_required", "auth_required", "completed", "canceled", "failed", "rejected"];

const CEILINGS: [&str; 4] = ["public", "internal", "confidential", "cui"];

/// A refusal of 7.14 with its own code (409).
fn conflict(code: &'static str, words: &str) -> ApiError {
    ApiError { status: 409, code, message: words.to_string(), retry_after: None }
}

/// 7.1.3 `card-version` (409).
pub fn card_version() -> ApiError {
    conflict("card-version", CARD_VERSION)
}

/// 2.2 `well-known-taken` (409).
pub fn well_known_taken() -> ApiError {
    conflict("well-known-taken", WELL_KNOWN_TAKEN)
}

/// `a_` and 16 lowercase hex.
pub fn agent_id_ok(id: &str) -> bool {
    id.strip_prefix("a_").is_some_and(|h| h.len() == 16 && h.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}

fn int(v: &Value, k: &str) -> Option<i64> {
    v.get(k).and_then(Value::as_i64)
}

/// Whether `new` names something `old` does not (`*` in `old` covers everything).
fn more(old: &[String], new: &[String]) -> bool {
    !old.iter().any(|x| x == "*") && new.iter().any(|x| !old.contains(x))
}

fn agents(m: &Value) -> impl Iterator<Item = &Value> {
    m.pointer("/a2a/agents").and_then(Value::as_array).into_iter().flatten()
}

/// The agent `id` of a map's `a2a.agents`.
pub fn agent<'a>(m: &'a Value, id: &str) -> Option<&'a Value> {
    agents(m).find(|a| s(a, "id") == id)
}

fn agent_mut<'a>(m: &'a mut Value, id: &str) -> Option<&'a mut Value> {
    m.get_mut("a2a")?.get_mut("agents")?.as_array_mut()?.iter_mut().find(|a| s(a, "id") == id)
}

/// The draft's `a2a`, made `{"jwks": [], "agents": []}` when absent.
fn a2a_mut(map: &mut Value) -> &mut Value {
    if !map.get("a2a").is_some_and(Value::is_object) {
        map["a2a"] = json!({"jwks": [], "agents": []});
    }
    &mut map["a2a"]
}

// ── agents (2.2, 7.14) ──────────────────────────────────────────────────────────────────────────────────────────

/// The `agent` body of 7.14.
const AGENT_BODY: [&str; 10] = ["name", "description", "version", "connector", "hub", "provider", "documentation_url", "streaming", "push", "skills"];
/// The fields `null` removes.
const AGENT_NULLABLE: [&str; 2] = ["provider", "documentation_url"];
/// The fields a new agent needs.
const AGENT_NEEDS: [&str; 8] = ["name", "description", "version", "connector", "hub", "streaming", "push", "skills"];

/// The map fields an agent body gives, checked for shape only (`check_api_map` judges the values).
fn agent_fields(body: &Value) -> Result<Map<String, Value>, ApiError> {
    let o = body.as_object().ok_or_else(|| invalid("agent is an object."))?;
    if let Some(k) = o.keys().find(|k| !AGENT_BODY.contains(&k.as_str())) {
        return Err(invalid(format!("Unknown agent field: {k}.")));
    }
    Ok(o.clone())
}

fn name_taken(d: &Draft, name: &str, except: &str) -> bool {
    agents(&d.map).any(|a| s(a, "name") == name && s(a, "id") != except)
}

/// `POST settings/api/a2a/agents {org, agent}`: a new agent (`id` the `a_` id the console drew), staged (two-person,
/// 13).
pub fn add_agent(d: &mut Draft, body: &Value, id: String) -> Result<(), ApiError> {
    let mut f = agent_fields(body)?;
    if let Some(k) = AGENT_NEEDS.iter().find(|k| f.get(**k).is_none_or(Value::is_null)) {
        return Err(invalid(format!("A new agent needs {k}.")));
    }
    for k in AGENT_NULLABLE {
        if f.get(k).is_some_and(Value::is_null) {
            f.remove(k);
        }
    }
    if agents(&d.map).count() >= AGENTS_MAX {
        return Err(invalid("An organization has at most 16 agents."));
    }
    let name = f.get("name").and_then(Value::as_str).unwrap_or_default().to_string();
    if name_taken(d, &name, "") {
        return Err(invalid(format!("An agent is already named {name}.")));
    }
    let mut a = json!({"id": id});
    a.as_object_mut().expect("an object").extend(f);
    list_mut(a2a_mut(&mut d.map), "agents").push(a);
    d.note(format!("Add agent {name}"));
    Ok(())
}

/// 2.3: what a change of a pinned agent journals at once: `agent_drop_skill {agent, skill}` per skill it removes.
pub fn agent_narrowings(id: &str, pinned: &Value, now: &Value) -> Vec<Tighten> {
    let ids = |a: &Value| a.get("skills").and_then(Value::as_array).into_iter().flatten().map(|x| s(x, "id").to_string()).collect::<Vec<_>>();
    let is = ids(now);
    ids(pinned).into_iter().filter(|k| !is.contains(k)).map(|skill| tighten("agent_drop_skill", json!({"agent": id, "skill": skill}))).collect()
}

/// `POST settings/api/a2a/agents/update {org, id, agent}`: the given fields staged (`provider: null` and
/// `documentation_url: null` remove them); the skills it removes from the pinned agent are the answer (journaled at
/// once); a widening is two-person (13).
pub fn update_agent(d: &mut Draft, id: &str, body: &Value, pinned: Option<&Value>) -> Result<Vec<Tighten>, ApiError> {
    let f = agent_fields(body)?;
    let mut a = agent(&d.map, id).cloned().ok_or_else(|| not_found(NO_AGENT))?;
    for (k, v) in f {
        match v {
            Value::Null if AGENT_NULLABLE.contains(&k.as_str()) => {
                a.as_object_mut().expect("an object").remove(&k);
            }
            v => a[k.as_str()] = v,
        }
    }
    let name = s(&a, "name").to_string();
    if name_taken(d, &name, id) {
        return Err(invalid(format!("An agent is already named {name}.")));
    }
    let out = pinned.and_then(|m| agent(m, id)).map(|p| agent_narrowings(id, p, &a)).unwrap_or_default();
    *agent_mut(&mut d.map, id).expect("the agent") = a;
    d.note(format!("Change agent {name}"));
    Ok(out)
}

/// `POST settings/api/a2a/agents/delete {org, id, reason}`: `agent_off` at once (when the pinned map lists it), and
/// the agent removed from the draft, from `a2a.well_known` and from every client's `a2a.agents` and `a2a.skills`;
/// the next map folds `agent_off`.
pub fn delete_agent(d: &mut Draft, id: &str, pinned: Option<&Value>) -> Result<Vec<Tighten>, ApiError> {
    let name = agent(&d.map, id).map(|a| s(a, "name").to_string()).ok_or_else(|| not_found(NO_AGENT))?;
    let a2a = a2a_mut(&mut d.map);
    list_mut(a2a, "agents").retain(|a| s(a, "id") != id);
    if a2a.get("well_known").and_then(Value::as_str) == Some(id) {
        a2a.as_object_mut().expect("an object").remove("well_known");
    }
    let prefix = format!("{id}/");
    for c in d.map.get_mut("clients").and_then(Value::as_array_mut).into_iter().flatten() {
        let Some(x) = c.get_mut("a2a").filter(|x| x.is_object()) else { continue };
        if let Some(l) = x.get_mut("agents").and_then(Value::as_array_mut) {
            l.retain(|v| v.as_str() != Some(id));
        }
        if let Some(l) = x.get_mut("skills").and_then(Value::as_array_mut) {
            l.retain(|v| !v.as_str().is_some_and(|k| k.starts_with(&prefix)));
        }
    }
    d.note(format!("Delete agent {name}"));
    Ok(pinned.and_then(|m| agent(m, id)).map(|_| tighten("agent_off", json!(id))).into_iter().collect())
}

/// `POST settings/api/a2a/well-known {org, agent}`: `a2a.well_known` staged (an agent of the draft; two-person, 13),
/// or removed for `null`.
pub fn set_well_known(d: &mut Draft, agent_id: Option<&str>) -> Result<(), ApiError> {
    match agent_id {
        Some(id) => {
            let name = agent(&d.map, id).map(|a| s(a, "name").to_string()).ok_or_else(|| not_found(NO_AGENT))?;
            a2a_mut(&mut d.map)["well_known"] = json!(id);
            d.note(format!("Publish agent {name} at the root well-known address"));
        }
        None => {
            let held = d.map.get_mut("a2a").and_then(Value::as_object_mut).and_then(|o| o.remove("well_known"));
            if held.is_none() {
                return Err(ApiError::with("stale", NO_WELL_KNOWN));
            }
            d.note("Stop publishing an agent at the root well-known address".to_string());
        }
    }
    Ok(())
}

/// 2.2 `well-known-taken` and 7.1.3 `card-version` for a map about to be staged or saved: `map` names
/// `a2a.well_known` and so does one of `others` (the other orgs' pinned maps), or an agent's card changes while its
/// version stays (`pinned`, the org's pinned map, None before one).
pub fn a2a_problem(pinned: Option<&Value>, map: &Value, org: &str, others: &[Value]) -> Result<(), ApiError> {
    if api_map::well_known_taken(map, others) {
        return Err(well_known_taken());
    }
    if pinned.and_then(|p| api_map::card_version_problem(p, map, org)).is_some() {
        return Err(card_version());
    }
    Ok(())
}

// ── Remote Spokes (5.1, 7.14) ───────────────────────────────────────────────────────────────────────────────────

/// `POST settings/api/spokes/root {org}`: `spokes.root` and `root_spki` staged from the console's Remote Spokes root
/// (`root`: its node id and the SHA-256 hex of its public key; two-person, 13). Refused when a connected bound relay
/// reports another root (`reported`, the roots those relays hold).
pub fn stage_spokes_root(d: &mut Draft, root: Option<(&str, &str)>, reported: &[String]) -> Result<(), ApiError> {
    let (id, spki) = root.ok_or_else(|| invalid(NO_ROOT))?;
    if reported.iter().any(|r| r != id) {
        return Err(invalid(OTHER_ROOT));
    }
    if !d.map.get("spokes").is_some_and(Value::is_object) {
        d.map["spokes"] = json!({"relays": []});
    }
    d.map["spokes"]["root"] = json!(id);
    d.map["spokes"]["root_spki"] = json!(spki);
    d.note(format!("Set the Remote Spokes root {id}"));
    Ok(())
}

// ── clients (2.3, 7.14) ─────────────────────────────────────────────────────────────────────────────────────────

/// `POST settings/api/clients/push-off {org, id}`: `push_off` at once (when the pinned client has `a2a.push`) and
/// `a2a.push` removed in the draft.
pub fn push_off(d: &mut Draft, id: &str, pinned: Option<&Value>) -> Result<Vec<Tighten>, ApiError> {
    let c = find_mut(&mut d.map, "clients", id).ok_or_else(|| not_found(NO_CLIENT))?;
    let name = s(c, "name").to_string();
    let staged = c.get_mut("a2a").and_then(Value::as_object_mut).and_then(|o| o.remove("push")).is_some();
    let held = pinned.and_then(|m| find(m, "clients", id)).is_some_and(|p| p.pointer("/a2a/push").is_some());
    if !staged && !held {
        return Err(ApiError::with("stale", NO_PUSH));
    }
    d.note(format!("Turn off pushes of client {name}"));
    Ok(held.then(|| tighten("push_off", json!(id))).into_iter().collect())
}

/// 2.3: what a change of a pinned client's `a2a` and `card` journals at once: `client_drop_agent` per agent it
/// removes, `client_drop_skill` per skill it removes (a `*` grant narrowed to a list drops each skill of its agents in
/// `pinned_map` outside the list), `client_a2a_limit` for fewer `max_open_tasks`, `push_off` when `push` is removed,
/// `push_drop_origin` per origin removed, `push_private_off` and `card_private_off` when the CIDRs are emptied or
/// narrowed (`private_narrowing`).
pub fn client_narrowings(id: &str, pinned: &Value, now: &Value, pinned_map: &Value) -> Vec<Tighten> {
    let mut out = Vec::new();
    let obj = |c: &Value, k: &str| c.get(k).filter(|x| x.is_object()).cloned();
    let (was, is) = (obj(pinned, "a2a"), obj(now, "a2a"));
    if let Some(was) = &was {
        let now_agents = is.as_ref().map(|x| strs(x.get("agents"))).unwrap_or_default();
        for a in strs(was.get("agents")).into_iter().filter(|a| !now_agents.contains(a)) {
            out.push(tighten("client_drop_agent", json!({"client": id, "agent": a})));
        }
        if let Some(is) = &is {
            let (ws, ns) = (strs(was.get("skills")), strs(is.get("skills")));
            if !ns.iter().any(|x| x == "*") {
                let granted: Vec<String> = if ws.iter().any(|x| x == "*") {
                    now_agents
                        .iter()
                        .filter_map(|a| agent(pinned_map, a))
                        .flat_map(|a| a.get("skills").and_then(Value::as_array).into_iter().flatten().map(move |k| format!("{}/{}", s(a, "id"), s(k, "id"))))
                        .collect()
                } else {
                    ws
                };
                let kept = |k: &String| k.split_once('/').is_some_and(|(a, _)| now_agents.iter().any(|x| x == a));
                for skill in granted.into_iter().filter(|k| !ns.contains(k) && kept(k)) {
                    out.push(tighten("client_drop_skill", json!({"client": id, "skill": skill})));
                }
            }
            if let (Some(w), Some(n)) = (int(was, "max_open_tasks"), int(is, "max_open_tasks")) {
                if n < w {
                    out.push(tighten("client_a2a_limit", json!({"client": id, "max_open_tasks": n})));
                }
            }
        }
        if let Some(wp) = was.get("push").filter(|x| x.is_object()) {
            match is.as_ref().and_then(|x| x.get("push")).filter(|x| x.is_object()) {
                None => out.push(tighten("push_off", json!(id))),
                Some(np) => {
                    let origins = strs(np.get("origins"));
                    for origin in strs(wp.get("origins")).into_iter().filter(|o| !origins.contains(o)) {
                        out.push(tighten("push_drop_origin", json!({"client": id, "origin": origin})));
                    }
                    out.extend(private_narrowing("push_private_off", id, strs(wp.get("private_cidrs")), strs(np.get("private_cidrs"))));
                }
            }
        }
    }
    let cidrs = |c: &Value| strs(c.pointer("/card/private_cidrs"));
    out.extend(private_narrowing("card_private_off", id, cidrs(pinned), cidrs(now)));
    out
}

/// 2.3 `push_private_off` or `card_private_off` (`action`) for a private CIDR list going from `was` to `is`: the bare
/// client id when it is emptied, `{client, keep: is}` when a range of `was` is no longer inside any range of `is`
/// (the enforcing side then reaches only pinned ranges inside `keep`, `api_cjournal::*_private_within`), else nothing.
fn private_narrowing(action: &'static str, id: &str, was: Vec<String>, is: Vec<String>) -> Option<Tighten> {
    if was.is_empty() {
        return None;
    }
    if is.is_empty() {
        return Some(tighten(action, json!(id)));
    }
    let narrowed = was.iter().any(|w| !is.iter().any(|n| crate::api_map::cidr_within(w, n)));
    narrowed.then(|| tighten(action, json!({"client": id, "keep": is})))
}

// ── 13: two-person saves ────────────────────────────────────────────────────────────────────────────────────────

fn ceiling_rank(c: &Value) -> Option<usize> {
    CEILINGS.iter().position(|x| *x == s(c, "ceiling"))
}

fn hub_or_submit(c: &Value) -> bool {
    s(c, "kind") == "spokes_hub" || strs(c.get("scopes")).iter().any(|x| x == "spokes.tasks.submit")
}

/// 13: whether a service hub client or a client holding `spokes.tasks.submit` is new, newly such a client, or wider:
/// `a2a.agents`, `a2a.skills`, `max_open_tasks`, `spokes.targets`, `push.origins`, a higher ceiling, or a new
/// `spokes_node` credential.
pub fn a2a_client_widens(old: Option<&Value>, new: &Value) -> bool {
    let Some(old) = old.filter(|o| hub_or_submit(o)) else { return true };
    let list = |c: &Value, p: &str| strs(c.pointer(p));
    let wider = |p: &str| more(&list(old, p), &list(new, p));
    let tasks = |c: &Value| c.pointer("/a2a/max_open_tasks").and_then(Value::as_i64).unwrap_or(0);
    let old_creds: Vec<Value> = old.get("credentials").and_then(Value::as_array).cloned().unwrap_or_default();
    let node_added = new.get("credentials").and_then(Value::as_array).into_iter().flatten().any(|c| s(c, "type") == "spokes_node" && !old_creds.contains(c));
    wider("/a2a/agents")
        || wider("/a2a/skills")
        || tasks(new) > tasks(old)
        || wider("/spokes/targets")
        || wider("/a2a/push/origins")
        || ceiling_rank(new) > ceiling_rank(old)
        || node_added
}

/// 13: whether an agent is new or wider: a skill or a target added, or a longer `approve_within_s`.
pub fn agent_widens(old: Option<&Value>, new: &Value) -> bool {
    let Some(old) = old else { return true };
    let skills = |a: &Value| a.get("skills").and_then(Value::as_array).cloned().unwrap_or_default();
    let old_skills = skills(old);
    skills(new).iter().any(|k| match old_skills.iter().find(|o| s(o, "id") == s(k, "id")) {
        None => true,
        Some(o) => more(&strs(o.get("targets")), &strs(k.get("targets"))) || int(k, "approve_within_s").unwrap_or(0) > int(o, "approve_within_s").unwrap_or(0),
    })
}

/// 13 (slice 1d5): the reasons of a save of `draft` over `base` beyond `TWO_SPOKES_BIND` and `TWO_CLEARED`: a service
/// hub or `spokes.tasks.submit` client added or widened (`TWO_A2A_CLIENT`), a private CIDR added to `push` or `card`
/// (`TWO_A2A_PRIVATE`), an agent added or widened (`TWO_A2A_AGENT`), `a2a.well_known` set (`TWO_WELL_KNOWN`).
pub fn two_person_1d(base: &Value, draft: &Value) -> Vec<&'static str> {
    let mut out = Vec::new();
    let mut add = |r: &'static str| {
        if !out.contains(&r) {
            out.push(r);
        }
    };
    let old_clients = by_id(base, "clients");
    for (id, c) in by_id(draft, "clients") {
        let old = old_clients.get(&id);
        if hub_or_submit(&c) && a2a_client_widens(old, &c) {
            add(TWO_A2A_CLIENT);
        }
        for p in ["/a2a/push/private_cidrs", "/card/private_cidrs"] {
            let was = old.map(|o| strs(o.pointer(p))).unwrap_or_default();
            if strs(c.pointer(p)).iter().any(|x| !was.contains(x)) {
                add(TWO_A2A_PRIVATE);
            }
        }
    }
    if agents(draft).any(|a| agent_widens(agent(base, s(a, "id")), a)) {
        add(TWO_A2A_AGENT);
    }
    let wk = |m: &Value| m.pointer("/a2a/well_known").and_then(Value::as_str).map(str::to_string);
    if wk(draft).is_some_and(|w| wk(base).as_deref() != Some(w.as_str())) {
        add(TWO_WELL_KNOWN);
    }
    out
}

// ── views (7.14) ────────────────────────────────────────────────────────────────────────────────────────────────

fn agent_off(console: &[ConsoleEntry], id: &str) -> bool {
    console.iter().any(|e| e.action == "agent_off" && e.target.as_str() == Some(id))
}

fn skill_dropped(console: &[ConsoleEntry], agent: &str, skill: &str) -> bool {
    console.iter().any(|e| e.action == "agent_drop_skill" && s(&e.target, "agent") == agent && s(&e.target, "skill") == skill)
}

/// AgentView: the map fields (`provider` and `documentation_url` null when absent), each skill with `dropped` (an
/// active `agent_drop_skill`), `off` (an active `agent_off`), `card_url` (null without an issuer) and `card` (a
/// CardView; left out for a draft's agents, None).
pub fn agent_view(a: &Value, console: &[ConsoleEntry], card_url: Option<String>, card: Option<Value>) -> Value {
    let id = s(a, "id");
    let skills: Vec<Value> = a
        .get("skills")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|k| {
            json!({"id": k.get("id"), "name": k.get("name"), "description": k.get("description"), "tags": k.get("tags").cloned().unwrap_or_else(|| json!([])),
                   "examples": k.get("examples").cloned().unwrap_or_else(|| json!([])), "targets": k.get("targets").cloned().unwrap_or_else(|| json!([])),
                   "model": k.get("model"), "turns": k.get("turns"), "approve_within_s": k.get("approve_within_s"), "idle_close_s": k.get("idle_close_s"),
                   "dropped": skill_dropped(console, id, s(k, "id"))})
        })
        .collect();
    let mut v = json!({"id": id, "name": a.get("name"), "description": a.get("description"), "version": a.get("version"), "connector": a.get("connector"),
                       "hub": a.get("hub"), "streaming": a.get("streaming"), "push": a.get("push"), "provider": a.get("provider"),
                       "documentation_url": a.get("documentation_url"), "skills": skills, "off": agent_off(console, id), "card_url": card_url});
    if let Some(card) = card {
        v["card"] = card;
    }
    v
}

/// The A2aView `connectors` entry of a connector: its name, `stale` and `shown_state` (`console_api_1c`), and whether
/// its latest acknowledgment reports the features `a2a` and `a2a-enclave`.
pub fn connector_a2a(k: &Value, status: Option<&Value>, console: &[ConsoleEntry]) -> Value {
    let view = crate::console_api_1c::connector_view(k, status, console);
    let features = strs(status.and_then(|st| st.get("features")));
    let has = |f: &str| features.iter().any(|x| x == f);
    json!({"name": k.get("name"), "stale": status.and_then(|st| st.get("stale")).and_then(Value::as_bool).unwrap_or(true), "shown_state": view.get("shown_state"),
           "a2a": has("a2a"), "enclave": has("a2a-enclave")})
}

/// The `spokes_hub` clients of a map, `[{id, name}]`.
pub fn hubs(m: Option<&Value>) -> Vec<Value> {
    m.and_then(|m| m.get("clients")).and_then(Value::as_array).into_iter().flatten().filter(|c| s(c, "kind") == "spokes_hub").map(|c| json!({"id": c.get("id"), "name": c.get("name")})).collect()
}

/// The well-known address of the root card on this console (`origin`: `https://host[:port]`).
pub fn well_known_url(origin: &str) -> String {
    format!("{}/.well-known/agent-card.json", origin.trim_end_matches('/'))
}

/// The parts of A2aView the console reads (cards, key views and connector statuses made by `console_fleet`).
pub struct A2aParts {
    pub agents: Vec<Value>,
    pub keys: Vec<Value>,
    pub connectors: Map<String, Value>,
    pub draft: Option<Value>,
}

/// A2aView (`GET settings/api/a2a`): the pinned map's issuer, agents (with their CardViews), card keys and root
/// well-known card, the org's connectors with their A2A features, its service hubs, and the draft's agents, keys and
/// well-known card.
pub fn a2a_view(org: &str, pinned: Option<&Value>, console_origin: &str, parts: A2aParts) -> Value {
    let issuer = pinned.and_then(|m| m.pointer("/issuer/url")).and_then(Value::as_str).filter(|u| !u.is_empty());
    let well_known = pinned.and_then(|m| m.pointer("/a2a/well_known")).cloned().unwrap_or(Value::Null);
    json!({"ok": true, "org": org, "issuer": issuer, "agents_url": issuer.map(crate::a2a_card::agents_url), "jwks_url": issuer.map(crate::a2a_card::jwks_url),
           "well_known": well_known, "well_known_url": well_known.is_string().then(|| well_known_url(console_origin)),
           "agents": parts.agents, "keys": parts.keys, "connectors": parts.connectors, "hubs": hubs(pinned), "draft": parts.draft})
}

/// A2aView `draft`: the draft's agents (AgentView without `card`), its card keys and well-known card.
pub fn draft_a2a(m: &Value, console: &[ConsoleEntry], keys: Vec<Value>) -> Value {
    let issuer = m.pointer("/issuer/url").and_then(Value::as_str).filter(|u| !u.is_empty());
    let list: Vec<Value> = agents(m).map(|a| agent_view(a, console, issuer.map(|i| crate::a2a_card::card_url(i, s(a, "id"))), None)).collect();
    json!({"agents": list, "keys": keys, "well_known": m.pointer("/a2a/well_known")})
}

/// The client view's `handoff` (7.1.2 R6-12): the org's JWKS address and the RFC 7638 thumbprints of its current
/// card keys (`kids`, those `jwks` lists).
pub fn handoff(issuer: Option<&str>, jwks: &[Value], kids: &[String]) -> Value {
    let thumbprints: Vec<String> = jwks.iter().filter(|j| kids.iter().any(|k| k == s(j, "kid"))).filter_map(crate::a2a_card::thumbprint).collect();
    json!({"jwks_url": issuer.filter(|u| !u.is_empty()).map(crate::a2a_card::jwks_url), "thumbprints": thumbprints})
}

/// The filters of `GET settings/api/a2a/tasks` (each optional).
#[derive(Default)]
pub struct TaskFilter<'a> {
    pub agent: Option<&'a str>,
    pub client: Option<&'a str>,
    pub state: Option<&'a str>,
}

/// TaskViews from the `a2a.task` entries of the org's connector chains, oldest first: per task, the latest
/// state-change entry (no `rid` or `route`) gives `state`, `skill`, `spoke` and `updated`; the first entry naming the
/// task gives `created`, `client` and `agent`; `bytes_in` and `bytes_out` are summed over the call entries. A task
/// with call entries only takes their latest `state`. Filtered, newest first, at most 200; never text.
pub fn task_views(entries: &[Value], client_name: &dyn Fn(&str) -> Option<String>, f: &TaskFilter) -> Vec<Value> {
    let mut tasks: Map<String, Value> = Map::new();
    let mut changed: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for e in entries.iter().filter(|e| s(e, "action") == TASK_ACTION) {
        let task = s(e, "task");
        if task.is_empty() {
            continue;
        }
        let ts = e.get("ts").cloned().unwrap_or(Value::Null);
        let t = tasks.entry(task.to_string()).or_insert_with(|| {
            json!({"task": task, "client": e.get("client"), "client_name": Value::Null, "agent": e.get("agent"), "skill": Value::Null, "spoke": Value::Null,
                   "state": Value::Null, "created": ts.clone(), "updated": ts.clone(), "bytes_in": 0, "bytes_out": 0})
        });
        for k in ["client", "agent"] {
            if t[k].is_null() {
                t[k] = e.get(k).cloned().unwrap_or(Value::Null);
            }
        }
        let call = e.get("rid").is_some() || e.get("route").is_some();
        if call {
            for k in ["bytes_in", "bytes_out"] {
                t[k] = json!(t[k].as_i64().unwrap_or(0) + int(e, k).unwrap_or(0));
            }
            if !changed.contains(task) {
                for k in ["state", "skill", "spoke"] {
                    if let Some(v) = e.get(k).filter(|v| !v.is_null()) {
                        t[k] = v.clone();
                    }
                }
                t["updated"] = ts;
            }
        } else {
            changed.insert(task.to_string());
            for k in ["state", "skill", "spoke"] {
                if let Some(v) = e.get(k).filter(|v| !v.is_null()) {
                    t[k] = v.clone();
                }
            }
            t["updated"] = ts;
        }
    }
    let ok = |want: Option<&str>, v: &Value| want.is_none_or(|w| v.as_str() == Some(w));
    let mut list: Vec<Value> = tasks
        .into_values()
        .filter(|t| ok(f.agent, &t["agent"]) && ok(f.client, &t["client"]) && ok(f.state, &t["state"]))
        .map(|mut t| {
            t["client_name"] = json!(client_name(s(&t, "client")));
            t
        })
        .collect();
    list.sort_by(|a, b| b["updated"].as_i64().cmp(&a["updated"].as_i64()));
    list.truncate(TASKS_MAX);
    list
}

/// SpokesView `hubs`: the `spokes_hub` clients of a map with their targets, relays, credentials (node, serial,
/// expires, key store; never the SPKI) and the agent they serve (2.2: at most one).
pub fn hub_views(m: Option<&Value>) -> Vec<Value> {
    let Some(m) = m else { return Vec::new() };
    m.get("clients")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|c| s(c, "kind") == "spokes_hub")
        .map(|c| {
            let id = s(c, "id");
            let credentials: Vec<Value> = c
                .get("credentials")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter(|cr| s(cr, "type") == "spokes_node")
                .map(|cr| json!({"node": cr.get("node"), "serial": cr.get("serial"), "expires": cr.get("expires"), "key_store": cr.get("key_store")}))
                .collect();
            let served = agents(m).find(|a| s(a, "hub") == id).map(|a| json!(s(a, "id"))).unwrap_or(Value::Null);
            json!({"id": id, "name": c.get("name"), "principal": c.get("principal"), "state": c.get("state"), "ceiling": c.get("ceiling"),
                   "targets": c.pointer("/spokes/targets").cloned().unwrap_or_else(|| json!([])), "relays": c.get("relays").cloned().unwrap_or_else(|| json!([])),
                   "credentials": credentials, "agent": served})
        })
        .collect()
}

fn root_of(m: Option<&Value>) -> Value {
    m.and_then(|m| m.get("spokes")).filter(|x| x.get("root").is_some()).map_or(Value::Null, |x| json!({"root": x.get("root"), "root_spki": x.get("root_spki")}))
}

/// SpokesView (`GET settings/api/spokes`): the console's Remote Spokes root, the pinned and the draft's roots, the
/// relay rows and candidates `console_fleet` made, and the pinned map's service hubs.
pub fn spokes_view(org: &str, console_root: Option<&str>, pinned: Option<&Value>, draft: Option<&Value>, relays: Vec<Value>, candidates: Vec<Value>) -> Value {
    json!({"ok": true, "org": org, "console_root": console_root.map(|id| json!({"id": id})), "map_root": root_of(pinned), "draft_root": root_of(draft),
           "relays": relays, "candidates": candidates, "hubs": hub_views(pinned)})
}

/// The relay ids a SpokesView lists: bound by the console's record, listed by the pinned map or staged in the draft,
/// sorted and once each.
pub fn spokes_relay_ids(bound: &[String], pinned: Option<&Value>, draft: Option<&Value>) -> Vec<String> {
    let mut ids: Vec<String> = bound.to_vec();
    for m in [pinned, draft].into_iter().flatten() {
        ids.extend(strs(m.pointer("/spokes/relays")));
    }
    ids.sort();
    ids.dedup();
    ids
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api_cjournal::Reach;
    use crate::console_api_ui::{self as api_ui, Ctx, TWO_SPOKES_BIND};

    const ORG: &str = "acme";
    const A1: &str = "a_7c1d2e3f4a5b6c7d";
    const A2: &str = "a_8d2e3f4a5b6c7d8e";
    const HUB: &str = "c_9a8b7c6d5e4f3a2b";
    const PARTNER: &str = "c_0b1c2d3e4f506172";
    const K1: &str = "k_1a2b3c4d5e6f7081";
    const SPOKE: &str = "n_a1b2c3d4e5f60718293a4b5c6d7e8f90";
    const SPOKE2: &str = "n_b1b2c3d4e5f60718293a4b5c6d7e8f90";

    fn skill(id: &str) -> Value {
        json!({"id": id, "name": "Build and test", "description": "Builds a branch.", "tags": ["build"], "examples": [], "targets": [SPOKE],
               "turns": "one", "approve_within_s": 3600})
    }

    fn agent_entry(id: &str) -> Value {
        json!({"id": id, "name": format!("agent {id}"), "description": "Runs builds.", "version": "1.0.0", "connector": K1, "hub": HUB,
               "streaming": true, "push": true, "skills": [skill("build-and-test"), skill("lint")]})
    }

    fn hub() -> Value {
        json!({"id": HUB, "name": "build-hub", "principal": "build-hub@apps.acme.example", "kind": "spokes_hub", "owner": "ann@acme.example", "reach": "R1",
               "scopes": ["spokes.tasks.submit"], "ceiling": "confidential", "relays": ["r_21"], "networks": [], "mtls_required": false,
               "credentials": [{"type": "spokes_node", "node": SPOKE, "serial": "0a", "spki": "ab", "expires": 9, "key_store": "pkcs11"}],
               "spokes": {"targets": [SPOKE]}, "state": "active"})
    }

    fn partner() -> Value {
        json!({"id": PARTNER, "name": "partner-ci", "principal": "partner-ci@apps.acme.example", "kind": "agent", "owner": "bob@acme.example", "reach": "R1",
               "scopes": ["spokes.tasks.submit"], "ceiling": "confidential", "relays": ["console"], "networks": [], "mtls_required": false, "credentials": [],
               "connectors": [K1], "state": "active",
               "a2a": {"agents": [A1, A2], "skills": ["*"], "max_open_tasks": 8, "push": {"origins": ["https://ci.partner.example", "https://b.partner.example"], "private_cidrs": ["10.0.0.0/8"]}},
               "card": {"url": "https://ci.partner.example/.well-known/agent-card.json", "jwks_uri": "https://ci.partner.example/jwks.json", "private_cidrs": ["10.1.0.0/16"]}})
    }

    fn base() -> Value {
        let mut m = api_ui::skeleton(ORG);
        m["clients"] = json!([hub(), partner()]);
        m["a2a"] = json!({"jwks": [], "agents": [agent_entry(A1), agent_entry(A2)], "well_known": A1});
        m
    }

    fn draft_on(b: &Value) -> Draft {
        Draft::new(&Ctx { org: ORG, by: "admin@acme.example", pinned: Some(b), pinned_seq: 1 }, "st_0000000000000001".into(), 0)
    }

    fn entry(n: u64, action: &str, target: Value) -> ConsoleEntry {
        ConsoleEntry { id: format!("k_{ORG}_{n:06}"), org: ORG.into(), cseq: n, ts: 10 + n as i64, action: action.into(), target, reach: Reach::Connector, prev_cseq: None }
    }

    fn has(out: &[Tighten], action: &str, target: Value) -> bool {
        out.iter().any(|t| t.action == action && t.target == target)
    }

    #[test]
    fn agent_ids_are_a_and_16_lowercase_hex() {
        assert!(agent_id_ok(A1));
        assert!(!agent_id_ok("a_7C1D2E3F4A5B6C7D"));
        assert!(!agent_id_ok("c_7c1d2e3f4a5b6c7d"));
        assert!(!agent_id_ok("a_7c1d"));
    }

    #[test]
    fn adding_an_agent_stages_it_and_is_two_person() {
        let b = base();
        let mut d = draft_on(&b);
        let mut body = agent_entry("x");
        body.as_object_mut().unwrap().remove("id");
        body["name"] = json!("third");
        let id = "a_0000000000000003".to_string();
        add_agent(&mut d, &body, id.clone()).unwrap();
        assert_eq!(agent(&d.map, &id).unwrap()["name"], json!("third"));
        assert_eq!(d.changes.last().unwrap(), "Add agent third");
        assert!(two_person_1d(&d.base, &d.map).contains(&TWO_A2A_AGENT));
        // the same name, an unknown field, a missing field
        assert_eq!(add_agent(&mut d, &body, "a_0000000000000004".into()).unwrap_err().code, "invalid");
        let mut odd = body.clone();
        odd["secret"] = json!(1);
        assert!(add_agent(&mut d, &odd, "a_0000000000000005".into()).unwrap_err().message.contains("Unknown agent field"));
        let mut short = body.clone();
        short["name"] = json!("fourth");
        short.as_object_mut().unwrap().remove("skills");
        assert_eq!(add_agent(&mut d, &short, "a_0000000000000006".into()).unwrap_err().message, "A new agent needs skills.");
    }

    #[test]
    fn a_draft_without_a2a_gets_it_with_its_first_agent() {
        let mut d = draft_on(&api_ui::skeleton(ORG));
        let mut body = agent_entry("x");
        body.as_object_mut().unwrap().remove("id");
        add_agent(&mut d, &body, A1.into()).unwrap();
        assert_eq!(d.map["a2a"]["jwks"], json!([]));
        assert_eq!(d.map["a2a"]["agents"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn removing_a_skill_journals_agent_drop_skill_and_a_new_target_is_two_person() {
        let b = base();
        let mut d = draft_on(&b);
        let j = update_agent(&mut d, A1, &json!({"skills": [skill("build-and-test")]}), Some(&b)).unwrap();
        assert_eq!(j, vec![tighten("agent_drop_skill", json!({"agent": A1, "skill": "lint"}))]);
        assert!(!two_person_1d(&d.base, &d.map).contains(&TWO_A2A_AGENT));
        let mut wider = skill("build-and-test");
        wider["targets"] = json!([SPOKE, SPOKE2]);
        update_agent(&mut d, A1, &json!({"skills": [wider]}), Some(&b)).unwrap();
        assert!(two_person_1d(&d.base, &d.map).contains(&TWO_A2A_AGENT));
        let mut longer = skill("build-and-test");
        longer["approve_within_s"] = json!(7200);
        let mut e = draft_on(&b);
        update_agent(&mut e, A1, &json!({"skills": [longer, skill("lint")]}), Some(&b)).unwrap();
        assert!(two_person_1d(&e.base, &e.map).contains(&TWO_A2A_AGENT));
        // provider: null removes it; an unpinned agent journals nothing
        update_agent(&mut e, A1, &json!({"provider": null}), Some(&b)).unwrap();
        assert!(agent(&e.map, A1).unwrap().get("provider").is_none());
        assert_eq!(update_agent(&mut e, "a_0000000000000009", &json!({}), Some(&b)).unwrap_err().code, "not-found");
    }

    #[test]
    fn deleting_an_agent_journals_agent_off_and_removes_it_everywhere() {
        let b = base();
        let mut d = draft_on(&b);
        let j = delete_agent(&mut d, A1, Some(&b)).unwrap();
        assert_eq!(j, vec![tighten("agent_off", json!(A1))]);
        assert!(agent(&d.map, A1).is_none());
        assert!(d.map["a2a"].get("well_known").is_none());
        let c = find(&d.map, "clients", PARTNER).unwrap();
        assert_eq!(c["a2a"]["agents"], json!([A2]));
        // an agent the pinned map does not list journals nothing
        let mut unpinned = api_ui::skeleton(ORG);
        unpinned["a2a"] = json!({"jwks": [], "agents": []});
        let mut e = draft_on(&b);
        assert!(delete_agent(&mut e, A2, Some(&unpinned)).unwrap().is_empty());
        assert_eq!(delete_agent(&mut e, A2, None).unwrap_err().code, "not-found");
    }

    #[test]
    fn the_root_well_known_card_is_two_person_and_null_removes_it() {
        let mut b = base();
        b["a2a"].as_object_mut().unwrap().remove("well_known");
        let mut d = draft_on(&b);
        assert_eq!(set_well_known(&mut d, None).unwrap_err().code, "stale");
        assert_eq!(set_well_known(&mut d, Some("a_0000000000000009")).unwrap_err().code, "not-found");
        set_well_known(&mut d, Some(A2)).unwrap();
        assert_eq!(d.map["a2a"]["well_known"], json!(A2));
        assert!(two_person_1d(&d.base, &d.map).contains(&TWO_WELL_KNOWN));
        set_well_known(&mut d, None).unwrap();
        assert!(!two_person_1d(&d.base, &d.map).contains(&TWO_WELL_KNOWN));
    }

    #[test]
    fn the_refusals_carry_their_codes_and_words() {
        let e = well_known_taken();
        assert_eq!((e.status, e.code, e.message.as_str()), (409, "well-known-taken", WELL_KNOWN_TAKEN));
        let e = card_version();
        assert_eq!((e.status, e.code, e.message.as_str()), (409, "card-version", CARD_VERSION));
        // a well-known card another org's pinned map publishes
        let other = base();
        assert_eq!(a2a_problem(None, &base(), ORG, &[other]).unwrap_err().code, "well-known-taken");
        let mut quiet = base();
        quiet["a2a"].as_object_mut().unwrap().remove("well_known");
        assert!(a2a_problem(None, &base(), ORG, &[quiet]).is_ok());
    }

    #[test]
    fn narrowing_an_a2a_client_journals_each_2_3_action() {
        let b = base();
        let p = partner();
        let mut now = p.clone();
        now["a2a"] = json!({"agents": [A1], "skills": [format!("{A1}/build-and-test")], "max_open_tasks": 4,
                            "push": {"origins": ["https://ci.partner.example"], "private_cidrs": []}});
        now["card"]["private_cidrs"] = json!([]);
        let out = client_narrowings(PARTNER, &p, &now, &b);
        assert!(has(&out, "client_drop_agent", json!({"client": PARTNER, "agent": A2})));
        // `*` narrowed: the skills of the kept agent outside the list (never the dropped agent's)
        assert!(has(&out, "client_drop_skill", json!({"client": PARTNER, "skill": format!("{A1}/lint")})));
        assert!(!out.iter().any(|t| t.action == "client_drop_skill" && t.target["skill"].as_str().unwrap().starts_with(A2)));
        assert!(has(&out, "client_a2a_limit", json!({"client": PARTNER, "max_open_tasks": 4})));
        assert!(has(&out, "push_drop_origin", json!({"client": PARTNER, "origin": "https://b.partner.example"})));
        assert!(has(&out, "push_private_off", json!(PARTNER)));
        assert!(has(&out, "card_private_off", json!(PARTNER)));
        // push removed: push_off; nothing narrowed: nothing
        let mut off = p.clone();
        off["a2a"].as_object_mut().unwrap().remove("push");
        assert_eq!(client_narrowings(PARTNER, &p, &off, &b), vec![tighten("push_off", json!(PARTNER))]);
        assert!(client_narrowings(PARTNER, &p, &p, &b).is_empty());
        // a partly narrowed CIDR list journals the ranges it keeps (ReviewW6c), at once
        let mut part = p.clone();
        part["card"]["private_cidrs"] = json!(["10.1.2.0/24"]);
        part["a2a"]["push"]["private_cidrs"] = json!(["10.4.0.0/16", "192.168.1.0/24"]);
        assert_eq!(
            client_narrowings(PARTNER, &p, &part, &b),
            vec![
                tighten("push_private_off", json!({"client": PARTNER, "keep": ["10.4.0.0/16", "192.168.1.0/24"]})),
                tighten("card_private_off", json!({"client": PARTNER, "keep": ["10.1.2.0/24"]})),
            ]
        );
        // a list that only grows (every old range still inside a new one) narrows nothing
        let mut wider = p.clone();
        wider["card"]["private_cidrs"] = json!(["10.1.0.0/16", "192.168.0.0/16"]);
        wider["a2a"]["push"]["private_cidrs"] = json!(["10.0.0.0/8"]);
        assert!(client_narrowings(PARTNER, &p, &wider, &b).is_empty());
    }

    #[test]
    fn push_off_journals_at_once_and_removes_push_from_the_draft() {
        let b = base();
        let mut d = draft_on(&b);
        assert_eq!(push_off(&mut d, PARTNER, Some(&b)).unwrap(), vec![tighten("push_off", json!(PARTNER))]);
        assert!(find(&d.map, "clients", PARTNER).unwrap().pointer("/a2a/push").is_none());
        assert_eq!(push_off(&mut d, HUB, Some(&b)).unwrap_err().code, "stale");
        assert_eq!(push_off(&mut d, "c_0000000000000000", Some(&b)).unwrap_err().code, "not-found");
    }

    #[test]
    fn a2a_clients_and_private_cidrs_are_two_person() {
        let b = base();
        // a new service hub
        let mut m = b.clone();
        let mut h2 = hub();
        h2["id"] = json!("c_1111111111111111");
        m["clients"].as_array_mut().unwrap().push(h2);
        assert!(two_person_1d(&b, &m).contains(&TWO_A2A_CLIENT));
        // more targets, a higher ceiling, a new spokes_node credential
        for (p, v) in [("/spokes/targets", json!([SPOKE, SPOKE2])), ("/ceiling", json!("cui"))] {
            let mut m = b.clone();
            *m["clients"][0].pointer_mut(p).unwrap() = v;
            assert!(two_person_1d(&b, &m).contains(&TWO_A2A_CLIENT), "{p}");
        }
        let mut m = b.clone();
        m["clients"][0]["credentials"].as_array_mut().unwrap().push(json!({"type": "spokes_node", "node": SPOKE2, "serial": "0b", "spki": "cd", "expires": 9, "key_store": "tpm"}));
        assert!(two_person_1d(&b, &m).contains(&TWO_A2A_CLIENT));
        // a client given spokes.tasks.submit; more open tasks; a new push origin
        let mut base_plain = b.clone();
        base_plain["clients"][1]["scopes"] = json!(["monitor.read"]);
        assert!(two_person_1d(&base_plain, &b).contains(&TWO_A2A_CLIENT));
        let mut m = b.clone();
        m["clients"][1]["a2a"]["max_open_tasks"] = json!(9);
        assert!(two_person_1d(&b, &m).contains(&TWO_A2A_CLIENT));
        let mut m = b.clone();
        m["clients"][1]["a2a"]["push"]["origins"].as_array_mut().unwrap().push(json!("https://c.partner.example"));
        assert!(two_person_1d(&b, &m).contains(&TWO_A2A_CLIENT));
        // a narrower client is no widening
        let mut m = b.clone();
        m["clients"][1]["a2a"]["max_open_tasks"] = json!(2);
        assert!(!two_person_1d(&b, &m).contains(&TWO_A2A_CLIENT));
        // a private CIDR added to push or card
        for p in ["/a2a/push/private_cidrs", "/card/private_cidrs"] {
            let mut m = b.clone();
            m["clients"][1].pointer_mut(p).unwrap().as_array_mut().unwrap().push(json!("192.168.0.0/16"));
            assert_eq!(two_person_1d(&b, &m), vec![TWO_A2A_PRIVATE], "{p}");
        }
        assert!(two_person_1d(&b, &b).is_empty());
    }

    #[test]
    fn clearing_any_2_3_id_is_two_person() {
        let b = base();
        // a console journal id (agent_off and the other A2A actions live there)
        let mut m = b.clone();
        m["cleared"] = json!([entry(1, "agent_off", json!(A1)).id]);
        assert!(api_ui::two_person(&b, &m, &[]).contains(&api_ui::TWO_CLEARED));
        // a relay journal client_drop_target id
        let drop = crate::api_map::TightenEntry { id: "t_000007".into(), action: "client_drop_target".into(), target: json!({"client": HUB, "spoke": SPOKE}), org: ORG.into(), tseq: 7, ts: 1, until: None };
        let mut m = b.clone();
        m["cleared"] = json!(["t_000007"]);
        assert!(api_ui::two_person(&b, &m, &[drop]).contains(&api_ui::TWO_CLEARED));
    }

    #[test]
    fn setting_the_spokes_root_is_refused_when_a_bound_relay_holds_another() {
        let b = base();
        let mut d = draft_on(&b);
        let root = ("n_0f1e2d3c4b5a69788796a5b4c3d2e1f0", "ab".repeat(32));
        assert_eq!(stage_spokes_root(&mut d, None, &[]).unwrap_err().message, NO_ROOT);
        assert_eq!(stage_spokes_root(&mut d, Some((root.0, &root.1)), &["n_ffffffffffffffffffffffffffffffff".into()]).unwrap_err().message, OTHER_ROOT);
        stage_spokes_root(&mut d, Some((root.0, &root.1)), &[root.0.into()]).unwrap();
        assert_eq!(d.map["spokes"], json!({"root": root.0, "root_spki": root.1, "relays": []}));
        assert!(api_ui::two_person(&d.base, &d.map, &[]).contains(&TWO_SPOKES_BIND));
    }

    #[test]
    fn agent_views_mark_dropped_skills_and_agents_off() {
        let console = vec![entry(1, "agent_drop_skill", json!({"agent": A1, "skill": "lint"})), entry(2, "agent_off", json!(A2))];
        let v = agent_view(&agent_entry(A1), &console, Some("https://i/a2a/agents/x/agent-card.json".into()), Some(json!({"state": "served"})));
        assert_eq!(v["skills"][1]["dropped"], json!(true));
        assert_eq!(v["skills"][0]["dropped"], json!(false));
        assert_eq!((v["off"].as_bool(), v["provider"].is_null(), v["skills"][0]["model"].is_null()), (Some(false), true, true));
        assert_eq!(v["card"]["state"], json!("served"));
        let w = agent_view(&agent_entry(A2), &console, None, None);
        assert_eq!((w["off"].as_bool(), w.get("card").is_none(), w["card_url"].is_null()), (Some(true), true, true));
    }

    #[test]
    fn connector_a2a_reads_the_ack_features() {
        let k = json!({"id": K1, "name": "helpdesk", "state": "active", "stale_s": 60});
        let st = json!({"features": ["a2a", "a2a-enclave"], "stale": false, "reported_at": 5});
        let v = connector_a2a(&k, Some(&st), &[]);
        assert_eq!(v, json!({"name": "helpdesk", "stale": false, "shown_state": "active", "a2a": true, "enclave": true}));
        let none = connector_a2a(&k, None, &[]);
        assert_eq!((none["a2a"].as_bool(), none["stale"].as_bool()), (Some(false), Some(true)));
    }

    #[test]
    fn tasks_fold_their_records_and_filter() {
        let call = |ts: i64, task: &str, bi: i64, bo: i64| json!({"action": TASK_ACTION, "ts": ts, "rid": "r", "route": "send", "client": PARTNER, "agent": A1, "task": task, "state": "submitted", "bytes_in": bi, "bytes_out": bo});
        let change = |ts: i64, task: &str, state: &str| json!({"action": TASK_ACTION, "ts": ts, "client": PARTNER, "agent": A1, "skill": "lint", "task": task, "spoke": SPOKE, "state": state});
        let entries = vec![
            call(10, "t1", 100, 20),
            change(11, "t1", "working"),
            call(12, "t1", 5, 7),
            change(13, "t1", "completed"),
            call(20, "t2", 1, 1),
            json!({"action": "content.approval.requested", "ts": 21, "task": "t3"}),
        ];
        let name = |c: &str| (c == PARTNER).then(|| "partner-ci".to_string());
        let all = task_views(&entries, &name, &TaskFilter::default());
        assert_eq!(all.len(), 2);
        assert_eq!(all[0]["task"], json!("t2"));
        let t1 = &all[1];
        assert_eq!(
            *t1,
            json!({"task": "t1", "client": PARTNER, "client_name": "partner-ci", "agent": A1, "skill": "lint", "spoke": SPOKE, "state": "completed",
                   "created": 10, "updated": 13, "bytes_in": 105, "bytes_out": 27})
        );
        assert_eq!(all[0]["state"], json!("submitted"));
        let done = task_views(&entries, &name, &TaskFilter { state: Some("completed"), ..TaskFilter::default() });
        assert_eq!(done.len(), 1);
        assert!(task_views(&entries, &name, &TaskFilter { agent: Some(A2), ..TaskFilter::default() }).is_empty());
        assert_eq!(task_views(&entries, &name, &TaskFilter { client: Some(PARTNER), ..TaskFilter::default() }).len(), 2);
    }

    #[test]
    fn spokes_views_list_roots_relays_and_hubs() {
        let mut b = base();
        b["spokes"] = json!({"root": "n_0f1e2d3c4b5a69788796a5b4c3d2e1f0", "root_spki": "ab", "relays": ["r_21"]});
        let mut draft = b.clone();
        draft["spokes"]["relays"] = json!(["r_21", "r_22"]);
        assert_eq!(spokes_relay_ids(&["r_20".into(), "r_21".into()], Some(&b), Some(&draft)), vec!["r_20", "r_21", "r_22"]);
        let v = spokes_view(ORG, Some("n_0f1e2d3c4b5a69788796a5b4c3d2e1f0"), Some(&b), None, vec![], vec![]);
        assert_eq!(v["console_root"], json!({"id": "n_0f1e2d3c4b5a69788796a5b4c3d2e1f0"}));
        assert_eq!(v["map_root"], json!({"root": "n_0f1e2d3c4b5a69788796a5b4c3d2e1f0", "root_spki": "ab"}));
        assert!(v["draft_root"].is_null());
        let h = &v["hubs"][0];
        assert_eq!((h["id"].as_str(), h["agent"].as_str()), (Some(HUB), Some(A1)));
        assert_eq!(h["credentials"], json!([{"node": SPOKE, "serial": "0a", "expires": 9, "key_store": "pkcs11"}]));
        assert_eq!(hubs(Some(&b)), vec![json!({"id": HUB, "name": "build-hub"})]);
    }
}
