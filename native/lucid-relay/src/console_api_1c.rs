// Contract API-1 revision 5 (docs/api/contract-r5-1c.md) 3.2, 4.2, 13.2, 13.3 and 14, slice 1c7: the rules of the
// console's connector, identity provider (EMA), SSO URL, delegation and approval screens, without any I/O. Every
// staging route's change to the org's draft (`console_api_ui::Draft`), the narrowings a save journals at once (4.2,
// R5-6, R5-7), the two-person reasons of 13.2 for content and delegated clients, connectors and idps (R5-4), and the
// views the screens read: no secret, no key material, no message text.
//
// console_fleet.rs runs the routes: it journals the narrowings through `api_journal` (the console journal's actions
// by `api_cjournal::ACTIONS`), fetches an IdP's discovery and keys (`ConsoleApi::idp_test`) and reads the connectors'
// acknowledgments, the delegated uses and the connectors' audit chains.

use crate::api_cjournal::{self as cj, ConsoleEntry};
use crate::api_delegated::{Use, AUTH_MAX_DEFAULT, CONSENT_DAYS_DEFAULT, MAX_AGE_DEFAULT};
use crate::api_map;
use crate::console::ApiError;
use crate::console_api_ui::{add_cleared, by_id, client_widens, find, find_mut, invalid, is_true, list_mut, not_found, s, strs, tighten, Draft, Tighten, NO_CLIENT, TWO_CONNECTOR, TWO_CONTENT, TWO_IDP};
use crate::meet_org_policy::{IdentityProvider, Obj};
use serde_json::{json, Map, Value};

// ── words ───────────────────────────────────────────────────────────────────────────────────────────────────────

pub const NO_CONNECTOR: &str = "There is no such connector.";
pub const NO_IDP: &str = "There is no such identity provider.";
pub const NO_PROVIDER: &str = "The signer policy lists no such identity provider for this organization.";
pub const NOT_DELEGATED: &str = "That client does not act for people (its kind is not agent_delegated).";
pub const REVOKED_FOR_ALL: &str = "This person is revoked for every client. Allow them for every client (client *) instead.";
pub const NOT_DENIED: &str = "Nothing was changed: that person is not denied for that client.";
pub const BAD_PRINCIPAL: &str = "principal is a person's address.";
pub const BAD_CLIENT: &str = "client is an API client id or *.";
pub const IDP_ID_FIXED: &str = "An identity provider's id does not change. Add a new one instead.";

// ── limits (3.2) ────────────────────────────────────────────────────────────────────────────────────────────────

pub const CONNECTORS_MAX: usize = 16;
pub const IDPS_MAX: usize = 8;
/// `delegation.denied`: 0 to 5000.
pub const DENIED_MAX: usize = 5000;
/// A connector's `stale_s` when the body (or a map) gives none (2.8).
pub const STALE_DEFAULT: i64 = 60;
/// 14.1 `GET settings/api/approvals`: at most this many, newest first.
pub const APPROVALS_MAX: usize = 200;
/// 12.2: the connector chain actions the approvals list shows.
pub const APPROVAL_ACTIONS: [&str; 5] = ["content.approval.requested", "content.approval.answered", "content.approval.posted", "content.approval.refused", "content.person.stopped"];

/// `c_` and 16 lowercase hex.
pub fn client_id_ok(id: &str) -> bool {
    id.strip_prefix("c_").is_some_and(|h| h.len() == 16 && h.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}

fn name_of(d: &Draft, list: &str, id: &str) -> String {
    find(&d.map, list, id).map(|x| s(x, "name").to_string()).filter(|n| !n.is_empty()).unwrap_or_else(|| id.to_string())
}

fn int(v: &Value, k: &str) -> Option<i64> {
    v.get(k).and_then(Value::as_i64)
}

// The values a field omitted from a map means (3.2): widening and narrowing compare these, never the raw fields.

/// A connector's effective `stale_s`.
fn stale_of(k: &Value) -> i64 {
    int(k, "stale_s").unwrap_or(STALE_DEFAULT)
}

/// An idp's effective `max_age_s`.
fn max_age_of(i: &Value) -> i64 {
    int(i, "max_age_s").unwrap_or(MAX_AGE_DEFAULT)
}

/// An idp's effective `auth_max_s` (O19).
fn auth_max(i: &Value) -> i64 {
    int(i, "auth_max_s").unwrap_or(AUTH_MAX_DEFAULT)
}

/// A `delegation` block's effective `consent_days` (O2).
fn consent_of(delegation: &Value) -> i64 {
    int(delegation, "consent_days").unwrap_or(CONSENT_DAYS_DEFAULT)
}

/// Some(the new list) when `now` narrows `was` (CIDRs): from any source to some, or a pinned network no new one covers.
fn narrowed_networks(was: &[String], now: &[String]) -> Option<Vec<String>> {
    let uncovered = was.iter().any(|w| !now.iter().any(|n| api_map::cidr_within(w, n)));
    (!now.is_empty() && (was.is_empty() || uncovered)).then(|| now.to_vec())
}

/// Whether `now` (CIDRs) lets in more than `was`: emptied (any source) or a network outside every pinned one.
fn wider_networks(was: &[String], now: &[String]) -> bool {
    !was.is_empty() && (now.is_empty() || now.iter().any(|n| !was.iter().any(|w| api_map::cidr_within(n, w))))
}

// ── connectors (3.2, 14.1) ──────────────────────────────────────────────────────────────────────────────────────

const CONNECTOR_BODY: [&str; 5] = ["name", "origin", "apps", "networks", "stale_s"];

/// The map fields a connector body gives, checked for shape only (`check_api_map` judges the values).
fn connector_fields(body: &Value) -> Result<Map<String, Value>, ApiError> {
    let o = body.as_object().ok_or_else(|| invalid("connector is an object."))?;
    let mut out = Map::new();
    for (k, v) in o {
        if !CONNECTOR_BODY.contains(&k.as_str()) {
            return Err(invalid(format!("Unknown connector field: {k}.")));
        }
        let v = match k.as_str() {
            "name" | "origin" => json!(v.as_str().unwrap_or_default().trim().to_lowercase()),
            _ => v.clone(),
        };
        out.insert(k.clone(), v);
    }
    Ok(out)
}

/// `POST settings/api/connectors`: a new connector (`id` the `k_` id the console drew), active, staged (two-person).
pub fn add_connector(d: &mut Draft, body: &Value, id: String) -> Result<(), ApiError> {
    let f = connector_fields(body)?;
    for k in ["name", "origin", "apps"] {
        if !f.contains_key(k) {
            return Err(invalid(format!("A new connector needs {k}.")));
        }
    }
    let list = d.map.get("connectors").and_then(Value::as_array).cloned().unwrap_or_default();
    if list.len() >= CONNECTORS_MAX {
        return Err(invalid("An organization has at most 16 connectors."));
    }
    let name = f.get("name").and_then(Value::as_str).unwrap_or_default().to_string();
    if list.iter().any(|k| s(k, "name") == name) {
        return Err(invalid(format!("A connector is already named {name}.")));
    }
    let mut k = Value::Object(f);
    k["id"] = json!(id);
    if k.get("networks").is_none() {
        k["networks"] = json!([]);
    }
    if k.get("stale_s").is_none() {
        k["stale_s"] = json!(STALE_DEFAULT);
    }
    k["state"] = json!("active");
    list_mut(&mut d.map, "connectors").push(k);
    d.note(format!("Add connector {name}"));
    Ok(())
}

/// 4.2 (R5-7): what a change of a pinned connector journals at once: `connector_drop_app` per app it removes, and
/// `connector_limit` with the new networks when they narrow the pinned ones.
pub fn connector_narrowings(id: &str, pinned: &Value, now: &Value) -> Vec<Tighten> {
    let mut out = Vec::new();
    let now_apps = strs(now.get("apps"));
    for app in strs(pinned.get("apps")).into_iter().filter(|a| !now_apps.contains(a)) {
        out.push(tighten("connector_drop_app", json!({"connector": id, "app": app})));
    }
    if let Some(networks) = narrowed_networks(&strs(pinned.get("networks")), &strs(now.get("networks"))) {
        out.push(tighten("connector_limit", json!({"connector": id, "networks": networks})));
    }
    out
}

/// `POST settings/api/connectors/update`: the given fields staged; the narrowings of the pinned connector are the
/// answer (journaled at once); a widening is two-person (13.2).
pub fn update_connector(d: &mut Draft, id: &str, body: &Value, pinned: Option<&Value>) -> Result<Vec<Tighten>, ApiError> {
    let f = connector_fields(body)?;
    let cur = find(&d.map, "connectors", id).cloned().ok_or_else(|| not_found(NO_CONNECTOR))?;
    let mut k = cur.clone();
    for (key, v) in f {
        k[key.as_str()] = v;
    }
    let name = s(&k, "name").to_string();
    if s(&cur, "name") != name && d.map.get("connectors").and_then(Value::as_array).into_iter().flatten().any(|x| s(x, "name") == name) {
        return Err(invalid(format!("A connector is already named {name}.")));
    }
    let out = pinned.and_then(|m| find(m, "connectors", id)).map(|p| connector_narrowings(id, p, &k)).unwrap_or_default();
    *find_mut(&mut d.map, "connectors", id).expect("the connector") = k;
    d.note(format!("Change connector {name}"));
    Ok(out)
}

/// `POST settings/api/connectors/suspend`: `connector_suspend` at once (when the pinned map lists it) and
/// `state: suspended` staged.
pub fn suspend_connector(d: &mut Draft, id: &str, pinned: Option<&Value>) -> Result<Vec<Tighten>, ApiError> {
    let name = name_of(d, "connectors", id);
    let k = find_mut(&mut d.map, "connectors", id).ok_or_else(|| not_found(NO_CONNECTOR))?;
    k["state"] = json!("suspended");
    d.note(format!("Suspend connector {name}"));
    Ok(pinned.and_then(|m| find(m, "connectors", id)).map(|_| tighten("connector_suspend", json!(id))).into_iter().collect())
}

/// `POST settings/api/connectors/resume`: `state: active` staged and every active `connector_suspend` of it cleared
/// (a two-person save, 13.2).
pub fn resume_connector(d: &mut Draft, id: &str, console: &[ConsoleEntry]) -> Result<(), ApiError> {
    let name = name_of(d, "connectors", id);
    let k = find_mut(&mut d.map, "connectors", id).ok_or_else(|| not_found(NO_CONNECTOR))?;
    k["state"] = json!("active");
    for e in console.iter().filter(|e| e.action == "connector_suspend" && e.target.as_str() == Some(id)) {
        add_cleared(d, &e.id);
    }
    d.note(format!("Resume connector {name}"));
    Ok(())
}

/// `POST settings/api/connectors/delete`: `connector_suspend` at once (when pinned), and the connector removed from
/// the draft and from every client's `connectors`; the next map folds the suspension.
pub fn delete_connector(d: &mut Draft, id: &str, pinned: Option<&Value>) -> Result<Vec<Tighten>, ApiError> {
    let name = name_of(d, "connectors", id);
    let list = list_mut(&mut d.map, "connectors");
    let before = list.len();
    list.retain(|k| s(k, "id") != id);
    if list.len() == before {
        return Err(not_found(NO_CONNECTOR));
    }
    for c in list_mut(&mut d.map, "clients").iter_mut() {
        if let Some(a) = c.get_mut("connectors").and_then(Value::as_array_mut) {
            a.retain(|x| x.as_str() != Some(id));
        }
    }
    d.note(format!("Delete connector {name}"));
    Ok(pinned.and_then(|m| find(m, "connectors", id)).map(|_| tighten("connector_suspend", json!(id))).into_iter().collect())
}

// ── identity providers for EMA (3.2, 14.1) ──────────────────────────────────────────────────────────────────────

const IDP_BODY: [&str; 8] = ["id", "provider", "issuer", "algs", "tenant", "max_age_s", "auth_max_s", "private_ok"];

fn idp_fields(body: &Value) -> Result<Map<String, Value>, ApiError> {
    let o = body.as_object().ok_or_else(|| invalid("idp is an object."))?;
    let mut out = Map::new();
    for (k, v) in o {
        if !IDP_BODY.contains(&k.as_str()) {
            return Err(invalid(format!("Unknown identity provider field: {k}.")));
        }
        let v = match k.as_str() {
            "id" => json!(v.as_str().unwrap_or_default().trim().to_lowercase()),
            "provider" | "issuer" => json!(v.as_str().unwrap_or_default().trim()),
            _ => v.clone(),
        };
        out.insert(k.clone(), v);
    }
    Ok(out)
}

/// R5-9: the ID-JAG issuer of a registry entry: for Okta its org authorization server `https://<the entry's host>`,
/// for every other kind the entry's `iss` (what "Add identity provider" prefills).
pub fn registry_issuer(p: &IdentityProvider) -> String {
    if p.kind == "okta" {
        let host = p.iss.strip_prefix("https://").and_then(|r| r.split('/').next()).unwrap_or_default();
        format!("https://{host}")
    } else {
        p.iss.clone()
    }
}

/// `POST settings/api/idps`: a new idp of a registry entry of the org (`providers`; one the console cannot find is
/// refused), its issuer the entry's tenant unless given, `algs` RS256, `max_age_s` 300 and `private_ok` false unless
/// given, active; staged (two-person). Its `id` defaults to the provider's.
pub fn add_idp(d: &mut Draft, body: &Value, providers: &[IdentityProvider]) -> Result<(), ApiError> {
    let mut f = idp_fields(body)?;
    let provider = f.get("provider").and_then(Value::as_str).unwrap_or_default().to_string();
    let entry = providers.iter().find(|p| p.id == provider).ok_or_else(|| invalid(NO_PROVIDER))?;
    let id = f.get("id").and_then(Value::as_str).filter(|i| !i.is_empty()).map_or_else(|| provider.to_lowercase(), str::to_string);
    let list = d.map.get("idps").and_then(Value::as_array).cloned().unwrap_or_default();
    if list.len() >= IDPS_MAX {
        return Err(invalid("An organization has at most 8 identity providers."));
    }
    if list.iter().any(|i| s(i, "id") == id) {
        return Err(invalid(format!("An identity provider is already named {id}.")));
    }
    for k in ["tenant", "auth_max_s"] {
        if f.get(k).is_some_and(Value::is_null) {
            f.remove(k);
        }
    }
    let mut i = Value::Object(f);
    i["id"] = json!(id);
    if s(&i, "issuer").is_empty() {
        i["issuer"] = json!(registry_issuer(entry));
    }
    if i.get("algs").is_none() {
        i["algs"] = json!(["RS256"]);
    }
    if i.get("max_age_s").is_none() {
        i["max_age_s"] = json!(MAX_AGE_DEFAULT);
    }
    if i.get("private_ok").is_none() {
        i["private_ok"] = json!(false);
    }
    i["state"] = json!("active");
    list_mut(&mut d.map, "idps").push(i);
    d.note(format!("Add identity provider {id}"));
    Ok(())
}

/// 4.2 (R5-7) `idp_limit`: what a change of a pinned idp narrows, journaled at once: `algs` (the pinned ones kept,
/// when some are dropped and some kept), a lower `max_age_s`, a new or other `tenant`, `private_ok` turned off. None
/// when nothing narrows. A lower `auth_max_s` is only staged (`idp_limit` does not carry it).
pub fn idp_narrowing(id: &str, pinned: &Value, now: &Value) -> Option<Tighten> {
    let mut t = Map::new();
    let (was, is) = (strs(pinned.get("algs")), strs(now.get("algs")));
    let kept: Vec<String> = was.iter().filter(|a| is.contains(a)).cloned().collect();
    if !kept.is_empty() && kept.len() < was.len() {
        t.insert("algs".into(), json!(kept));
    }
    let (w, n) = (max_age_of(pinned), max_age_of(now));
    if n < w {
        t.insert("max_age_s".into(), json!(n));
    }
    if let Some(tenant) = now.get("tenant").filter(|x| x.is_string() && pinned.get("tenant") != Some(*x)) {
        t.insert("tenant".into(), tenant.clone());
    }
    if is_true(pinned.get("private_ok")) && !is_true(now.get("private_ok")) {
        t.insert("private_ok".into(), json!(false));
    }
    if t.is_empty() {
        return None;
    }
    t.insert("idp".into(), json!(id));
    Some(tighten("idp_limit", Value::Object(t)))
}

/// `POST settings/api/idps/update`: the given fields staged (`tenant: null` and `auth_max_s: null` remove them);
/// the narrowing of the pinned idp is the answer (journaled at once); a widening is two-person (13.2).
pub fn update_idp(d: &mut Draft, id: &str, body: &Value, pinned: Option<&Value>) -> Result<Vec<Tighten>, ApiError> {
    let f = idp_fields(body)?;
    if f.get("id").is_some_and(|x| x.as_str() != Some(id)) {
        return Err(invalid(IDP_ID_FIXED));
    }
    let mut i = find(&d.map, "idps", id).cloned().ok_or_else(|| not_found(NO_IDP))?;
    for (k, v) in f {
        if v.is_null() && matches!(k.as_str(), "tenant" | "auth_max_s") {
            if let Some(o) = i.as_object_mut() {
                o.remove(&k);
            }
        } else {
            i[k.as_str()] = v;
        }
    }
    let out = pinned.and_then(|m| find(m, "idps", id)).and_then(|p| idp_narrowing(id, p, &i)).into_iter().collect();
    *find_mut(&mut d.map, "idps", id).expect("the idp") = i;
    d.note(format!("Change identity provider {id}"));
    Ok(out)
}

/// `POST settings/api/idps/suspend`: `idp_suspend` at once (when pinned) and `state: suspended` staged.
pub fn suspend_idp(d: &mut Draft, id: &str, pinned: Option<&Value>) -> Result<Vec<Tighten>, ApiError> {
    let i = find_mut(&mut d.map, "idps", id).ok_or_else(|| not_found(NO_IDP))?;
    i["state"] = json!("suspended");
    d.note(format!("Suspend identity provider {id}"));
    Ok(pinned.and_then(|m| find(m, "idps", id)).map(|_| tighten("idp_suspend", json!(id))).into_iter().collect())
}

/// `POST settings/api/idps/resume`: active again and every active `idp_suspend` of it cleared (two-person, 13.2).
pub fn resume_idp(d: &mut Draft, id: &str, console: &[ConsoleEntry]) -> Result<(), ApiError> {
    let i = find_mut(&mut d.map, "idps", id).ok_or_else(|| not_found(NO_IDP))?;
    i["state"] = json!("active");
    for e in console.iter().filter(|e| e.action == "idp_suspend" && e.target.as_str() == Some(id)) {
        add_cleared(d, &e.id);
    }
    d.note(format!("Resume identity provider {id}"));
    Ok(())
}

/// `POST settings/api/idps/test` answer: the issuer, its `jwks_uri` and each key's `kid`, `alg` and `kty` (never key
/// material).
pub fn idp_test_view(issuer: &str, jwks_uri: &str, keys: &[Value]) -> Value {
    let keys: Vec<Value> = keys.iter().map(|k| json!({"kid": k.get("kid"), "alg": k.get("alg"), "kty": k.get("kty")})).collect();
    json!({"ok": true, "issuer": issuer, "jwks_uri": jwks_uri, "keys": keys})
}

// ── delegations (4.2 `person_revoke`, 14.1) ─────────────────────────────────────────────────────────────────────

fn principal_of(p: &str) -> Result<String, ApiError> {
    let p = p.trim().to_lowercase();
    if api_map::person_ok(&p) {
        Ok(p)
    } else {
        Err(invalid(BAD_PRINCIPAL))
    }
}

/// The draft's `agent_delegated` clients a delegation route names: every one for `*`, else that one.
fn delegated_targets(d: &Draft, client: &str) -> Result<Vec<String>, ApiError> {
    if client == "*" {
        let clients = d.map.get("clients").and_then(Value::as_array).into_iter().flatten();
        return Ok(clients.filter(|c| s(c, "kind") == "agent_delegated").map(|c| s(c, "id").to_string()).collect());
    }
    if !client_id_ok(client) {
        return Err(invalid(BAD_CLIENT));
    }
    let c = find(&d.map, "clients", client).ok_or_else(|| not_found(NO_CLIENT))?;
    if s(c, "kind") != "agent_delegated" {
        return Err(invalid(NOT_DELEGATED));
    }
    Ok(vec![client.to_string()])
}

fn denies(list: &[Value], p: &str) -> bool {
    list.iter().any(|x| x.as_str().is_some_and(|x| x.eq_ignore_ascii_case(p)))
}

/// `POST settings/api/delegations/revoke {client, principal}`: `person_revoke` at once (a standing deny, R5-3; the
/// route also ends the person's refresh families), and the principal staged into `delegation.denied` of that client
/// (of every `agent_delegated` client for `*`), which lets the next map fold the entry. A list already at 5000 is
/// left as it is: the entry stays in force on the console.
pub fn revoke_delegation(d: &mut Draft, client: &str, principal: &str) -> Result<Vec<Tighten>, ApiError> {
    let p = principal_of(principal)?;
    for id in delegated_targets(d, client)? {
        let c = find_mut(&mut d.map, "clients", &id).expect("the client");
        if !c.get("delegation").is_some_and(Value::is_object) {
            c["delegation"] = json!({});
        }
        let denied = list_mut(&mut c["delegation"], "denied");
        if !denies(denied.as_slice(), &p) && denied.len() < DENIED_MAX {
            denied.push(json!(p));
        }
    }
    let whom = if client == "*" { "every client".to_string() } else { name_of(d, "clients", client) };
    d.note(format!("Revoke {p} for {whom}"));
    Ok(vec![tighten("person_revoke", json!({"client": client, "principal": p}))])
}

/// `POST settings/api/delegations/allow {client, principal}` (O18): the principal staged out of `delegation.denied`
/// of that client (every `agent_delegated` client for `*`) and the matching active `person_revoke` entries cleared
/// (for `*` every one of the person; a two-person save, 13.2). A person revoked for every client is allowed again only
/// for every client.
pub fn allow_delegation(d: &mut Draft, client: &str, principal: &str, console: &[ConsoleEntry]) -> Result<(), ApiError> {
    let p = principal_of(principal)?;
    let revokes: Vec<&ConsoleEntry> = console.iter().filter(|e| e.action == "person_revoke" && e.field("principal").eq_ignore_ascii_case(&p)).collect();
    if client != "*" && revokes.iter().any(|e| e.field("client") == "*") {
        return Err(invalid(REVOKED_FOR_ALL));
    }
    let ids: Vec<String> = revokes.iter().filter(|e| client == "*" || e.field("client") == client).map(|e| e.id.clone()).collect();
    let mut changed = false;
    for id in delegated_targets(d, client)? {
        if let Some(denied) = find_mut(&mut d.map, "clients", &id).and_then(|c| c.pointer_mut("/delegation/denied")).and_then(Value::as_array_mut) {
            let before = denied.len();
            denied.retain(|x| !x.as_str().is_some_and(|x| x.eq_ignore_ascii_case(&p)));
            changed |= denied.len() != before;
        }
    }
    if !changed && ids.is_empty() {
        return Err(ApiError::with("stale", NOT_DENIED));
    }
    for id in &ids {
        add_cleared(d, id);
    }
    let whom = if client == "*" { "every client".to_string() } else { name_of(d, "clients", client) };
    d.note(format!("Allow {p} again for {whom}"));
    Ok(())
}

// ── client narrowings (4.2) ─────────────────────────────────────────────────────────────────────────────────────

/// 4.2 (R5-6, R5-7, 14.1): what a change of a pinned client's revision 5 fields journals at once:
/// `client_drop_connector`, `client_drop_app`, `client_limit_channels` (the new list, when it narrows `*` or drops a
/// cid), `client_confirm` per scope added to `confirm`, `client_drop_delegation` per group, principal or idp removed
/// (the route brings the R5-6 `person_revoke` entries), `client_limit_delegation` for fewer `consent_days`,
/// `person_revoke` per principal added to `delegation.denied`, and `client_drop_redirect` per redirect URI removed.
pub fn client_narrowings(id: &str, pinned: &Value, now: &Value) -> Vec<Tighten> {
    let mut out = Vec::new();
    let dropped = |was: Option<&Value>, is: Option<&Value>| {
        let is = strs(is);
        strs(was).into_iter().filter(move |x| !is.contains(x))
    };
    for k in dropped(pinned.get("connectors"), now.get("connectors")) {
        out.push(tighten("client_drop_connector", json!({"client": id, "connector": k})));
    }
    for app in dropped(pinned.get("apps"), now.get("apps")) {
        out.push(tighten("client_drop_app", json!({"client": id, "app": app})));
    }
    let (was_ch, now_ch) = (strs(pinned.get("channels")), strs(now.get("channels")));
    let all = |l: &[String]| l.iter().any(|c| c == "*");
    if !now_ch.is_empty() && !all(&now_ch) && (all(&was_ch) || was_ch.iter().any(|c| !now_ch.contains(c))) {
        out.push(tighten("client_limit_channels", json!({"client": id, "channels": now_ch})));
    }
    let was_confirm = strs(pinned.get("confirm"));
    for scope in strs(now.get("confirm")).into_iter().filter(|x| !was_confirm.contains(x)) {
        out.push(tighten("client_confirm", json!({"client": id, "scope": scope})));
    }
    if let Some(was) = pinned.get("delegation").filter(|x| x.is_object()) {
        let is = now.get("delegation");
        for (list, what) in [("groups", "group"), ("principals", "principal"), ("idps", "idp")] {
            for v in dropped(was.get(list), is.and_then(|x| x.get(list))) {
                let mut target = json!({"client": id});
                target[what] = json!(v);
                out.push(tighten("client_drop_delegation", target));
            }
        }
        // effective values (an omitted `consent_days` is 7); a client left without `delegation` is narrowed by its drops
        if let Some(n) = is.filter(|x| x.is_object()).map(consent_of) {
            if n < consent_of(was) {
                out.push(tighten("client_limit_delegation", json!({"client": id, "consent_days": n})));
            }
        }
    }
    let was_denied: Vec<Value> = strs(pinned.pointer("/delegation/denied")).into_iter().map(Value::from).collect();
    for p in strs(now.pointer("/delegation/denied")).into_iter().filter(|p| !denies(&was_denied, p)) {
        out.push(tighten("person_revoke", json!({"client": id, "principal": p.to_lowercase()})));
    }
    for uri in dropped(pinned.get("redirect_uris"), now.get("redirect_uris")) {
        out.push(tighten("client_drop_redirect", json!({"client": id, "uri": uri})));
    }
    out
}

// ── 13.2: two-person saves ──────────────────────────────────────────────────────────────────────────────────────

/// A client that holds `content.read` or `content.post`, or is of kind `agent_delegated`.
pub fn content_or_delegated(c: &Value) -> bool {
    s(c, "kind") == "agent_delegated" || strs(c.get("scopes")).iter().any(|x| x.starts_with("content."))
}

/// 13.2 (R5-4): whether a content or delegated client entry is new or wider than the pinned one in any field: the
/// revision 4 widenings (active again, a scope, a higher ceiling, relays, networks wider or emptied, a credential, its
/// hours, a cap, a later expiry, `mtls_required` off) and a higher rate, more connectors, apps or channels (or `*`),
/// a new redirect URI, `loopback_ok` on, another kind or owner, a scope removed from `confirm`, a wider `delegation`
/// (a group, a principal, an idp, more `consent_days`) or a principal removed from `delegation.denied`.
pub fn content_widens(old: Option<&Value>, new: &Value) -> bool {
    let Some(old) = old else { return true };
    if client_widens(Some(old), new) {
        return true;
    }
    let list = |v: &Value, k: &str| strs(v.get(k));
    let more = |k: &str| list(new, k).iter().any(|x| !list(old, k).contains(x));
    let rate = ["per_minute_each", "per_day_each"].into_iter().any(|k| {
        let r = |v: &Value| v.get("rate").and_then(|r| int(r, k));
        match (r(new), r(old)) {
            (Some(n), Some(o)) => n > o,
            (None, Some(_)) => true,
            _ => false,
        }
    });
    let channels = !list(old, "channels").iter().any(|c| c == "*") && more("channels");
    let loopback = is_true(new.get("loopback_ok")) && !is_true(old.get("loopback_ok"));
    let kind = s(new, "kind") != s(old, "kind");
    let owner = s(new, "owner") != s(old, "owner");
    let new_confirm = list(new, "confirm");
    let unconfirm = list(old, "confirm").iter().any(|x| !new_confirm.contains(x));
    let dl = |v: &Value, k: &str| strs(v.pointer(&format!("/delegation/{k}")));
    let delegation = ["groups", "principals", "idps"].into_iter().any(|k| dl(new, k).iter().any(|x| !dl(old, k).contains(x)));
    // effective values: an omitted `consent_days` is 7 (O2); a client without `delegation` delegates nothing
    let days = |v: &Value| v.get("delegation").filter(|x| x.is_object()).map(consent_of);
    let consent = match (days(new), days(old)) {
        (Some(n), Some(o)) => n > o,
        (Some(_), None) => true,
        _ => false,
    };
    let new_denied: Vec<Value> = dl(new, "denied").into_iter().map(Value::from).collect();
    let undeny = dl(old, "denied").iter().any(|p| !denies(&new_denied, p));
    rate || more("connectors") || more("apps") || channels || more("redirect_uris") || loopback || kind || owner || unconfirm || delegation || consent || undeny
}

/// 13.2: whether a connector entry is new or wider than the pinned one: an app, wider or emptied networks, or a longer
/// `stale_s`.
pub fn connector_widens(old: Option<&Value>, new: &Value) -> bool {
    let Some(old) = old else { return true };
    let old_apps = strs(old.get("apps"));
    let apps = strs(new.get("apps")).iter().any(|a| !old_apps.contains(a));
    let networks = wider_networks(&strs(old.get("networks")), &strs(new.get("networks")));
    apps || networks || stale_of(new) > stale_of(old)
}

/// 13.2: whether an idp entry is new or wider than the pinned one: an alg, a longer `max_age_s` or `auth_max_s`, its
/// `tenant` removed or changed, `private_ok` on, resumed, or another issuer or provider.
pub fn idp_widens(old: Option<&Value>, new: &Value) -> bool {
    let Some(old) = old else { return true };
    let old_algs = strs(old.get("algs"));
    let algs = strs(new.get("algs")).iter().any(|a| !old_algs.contains(a));
    let max_age = max_age_of(new) > max_age_of(old);
    let tenant = old.get("tenant").is_some() && new.get("tenant") != old.get("tenant");
    let private = is_true(new.get("private_ok")) && !is_true(old.get("private_ok"));
    let resumed = s(new, "state") == "active" && s(old, "state") != "active";
    let moved = s(new, "issuer") != s(old, "issuer") || s(new, "provider") != s(old, "provider");
    algs || max_age || auth_max(new) > auth_max(old) || tenant || private || resumed || moved
}

/// 13.2 (slice 1c7): the reasons of a save of `draft` over `base` beyond the revision 5 items slice 1c3 judges
/// (`TWO_UNDENY`, `TWO_LOOPBACK`, `TWO_IDP_PRIVATE`) and the cleared `k_` ids (`TWO_CLEARED`): a content or delegated
/// client added or widened (`TWO_CONTENT`), a connector added or widened (`TWO_CONNECTOR`), an idp added or widened
/// (`TWO_IDP`).
pub fn two_person_1c(base: &Value, draft: &Value) -> Vec<&'static str> {
    let mut out = Vec::new();
    let old_clients = by_id(base, "clients");
    if by_id(draft, "clients").iter().any(|(id, c)| {
        let old = old_clients.get(id);
        (content_or_delegated(c) || old.is_some_and(content_or_delegated)) && content_widens(old, c)
    }) {
        out.push(TWO_CONTENT);
    }
    let old_connectors = by_id(base, "connectors");
    if by_id(draft, "connectors").iter().any(|(id, k)| connector_widens(old_connectors.get(id), k)) {
        out.push(TWO_CONNECTOR);
    }
    let old_idps = by_id(base, "idps");
    if by_id(draft, "idps").iter().any(|(id, i)| idp_widens(old_idps.get(id), i)) {
        out.push(TWO_IDP);
    }
    out
}

// ── views (14.1, 14.2) ──────────────────────────────────────────────────────────────────────────────────────────

/// 2.8, 14.1 `connector_status`: from the connector's latest acknowledgment (`{connector, at, ack}`, None before
/// one): seconds since it, its conversations count, key store and features, when it came, and `stale` (older than
/// `stale_s`, or never).
pub fn connector_status(ack: Option<&Value>, stale_s: i64, now: i64) -> Value {
    let at = ack.and_then(|a| int(a, "at"));
    let body = ack.and_then(|a| a.get("ack"));
    let age = at.map(|t| (now - t).max(0));
    let conversations = body.and_then(|b| b.get("conversations")).and_then(Value::as_array).map(Vec::len);
    let seal = body.and_then(|b| b.get("seal")).and_then(Value::as_str);
    let features = strs(body.and_then(|b| b.get("features")));
    let stale = age.is_none_or(|g| g > stale_s);
    json!({"sync_age_s": age, "conversations": conversations, "seal": seal, "features": features, "reported_at": at, "stale": stale})
}

/// ConnectorView: the map fields, `shown_state` (`suspended` by its state or a `connector_suspend`; else, with a
/// status, `never-synced` or `stale`; else `active`) and `suspended_by_journal`.
pub fn connector_view(k: &Value, status: Option<&Value>, console: &[ConsoleEntry]) -> Value {
    let id = s(k, "id");
    let by_journal = cj::connector_suspended(console, id);
    let shown = if s(k, "state") == "suspended" || by_journal {
        "suspended"
    } else {
        match status {
            Some(st) if st.get("reported_at").is_none_or(Value::is_null) => "never-synced",
            Some(st) if is_true(st.get("stale")) => "stale",
            _ => "active",
        }
    };
    json!({"id": id, "name": k.get("name"), "origin": k.get("origin"), "apps": strs(k.get("apps")), "networks": strs(k.get("networks")),
           "stale_s": k.get("stale_s"), "state": k.get("state"), "shown_state": shown, "suspended_by_journal": by_journal})
}

/// `GET settings/api/connectors`: a ConnectorView with its status's fields (`sync_age_s`, `conversations`, `seal`,
/// `features`, `reported_at`, `stale`) added.
pub fn connector_with_status(k: &Value, status: Option<&Value>, console: &[ConsoleEntry]) -> Value {
    let mut v = connector_view(k, status, console);
    for (key, x) in status.and_then(Value::as_object).into_iter().flatten() {
        v[key.as_str()] = x.clone();
    }
    v
}

/// IdpView: the map fields (`auth_max_s` with its default), `shown_state` (`suspended` by its state or an
/// `idp_suspend`) and the last test of its issuer (`last_test`, `keys`; null before one).
pub fn idp_view(i: &Value, console: &[ConsoleEntry], last_test: Option<(i64, usize)>) -> Value {
    let id = s(i, "id");
    let shown = if s(i, "state") == "suspended" || cj::idp_suspended(console, id) { "suspended" } else { "active" };
    json!({"id": id, "provider": i.get("provider"), "issuer": i.get("issuer"), "algs": strs(i.get("algs")), "tenant": i.get("tenant"),
           "max_age_s": max_age_of(i), "auth_max_s": auth_max(i), "private_ok": is_true(i.get("private_ok")), "state": i.get("state"),
           "shown_state": shown, "last_test": last_test.map(|t| t.0), "keys": last_test.map(|t| t.1)})
}

/// 6.5 step 2: `<issuer.url>/oauth/sso-return`, the value the SSO operator sets in `sso.json` (null before an issuer
/// url).
pub fn api_return(issuer_url: Option<&str>) -> Value {
    issuer_url.filter(|u| !u.is_empty()).map_or(Value::Null, |u| json!(format!("{}/oauth/sso-return", u.trim_end_matches('/'))))
}

/// ProviderView: a registry entry of the org with its SSO URL (`ConsoleApi::sso_url`) and `api_return`.
pub fn provider_view(p: &IdentityProvider, sso_url: Option<String>, api_return: &Value) -> Value {
    json!({"id": p.id, "kind": p.kind, "iss": p.iss, "sso_url": sso_url, "api_return": api_return})
}

/// The org map's `connectors` and `idps` as the API access screen shows them, added to a `map_view` answer.
pub fn map_view_1c(view: &mut Value, m: &Value, status: &Map<String, Value>, console: &[ConsoleEntry], last_test: &dyn Fn(&str) -> Option<(i64, usize)>) {
    let connectors = m.get("connectors").and_then(Value::as_array).into_iter().flatten();
    view["connectors"] = Value::Array(connectors.map(|k| connector_view(k, status.get(s(k, "id")), console)).collect());
    let idps = m.get("idps").and_then(Value::as_array).into_iter().flatten();
    view["idps"] = Value::Array(idps.map(|i| idp_view(i, console, last_test(s(i, "issuer")))).collect());
}

/// `api_apps`: the `api` apps of the org's verified policy, `[{principal, name}]`.
pub fn api_apps(policy: Option<&Obj>) -> Value {
    let apps = policy.and_then(|p| p.get("apps")).and_then(Value::as_array).into_iter().flatten();
    Value::Array(apps.filter(|a| s(a, "type") == "api").map(|a| json!({"principal": a.get("principal"), "name": a.get("name")})).collect())
}

/// `ai_groups`: the policy's `ai.who.groups`, `[{id, label}]` (the label is the immutable id; ID-1 names stay with the
/// SSO service).
pub fn ai_groups(policy: Option<&Obj>) -> Value {
    let groups = policy.and_then(|p| p.get("ai")).and_then(|a| a.pointer("/who/groups")).and_then(Value::as_array).into_iter().flatten();
    Value::Array(groups.filter_map(Value::as_str).map(|g| json!({"id": g, "label": g})).collect())
}

/// RevokeView: the active `person_revoke` entries (for a `c_` client: its own and the `*` ones).
pub fn revoke_views(console: &[ConsoleEntry], client: &str) -> Vec<Value> {
    console
        .iter()
        .filter(|e| e.action == "person_revoke" && (client == "*" || e.field("client") == client || e.field("client") == "*"))
        .map(|e| json!({"id": e.id, "client": e.field("client"), "principal": e.field("principal"), "ts": e.ts}))
        .collect()
}

/// DelegationView: one person's use of a client's delegated grant, and whether a `person_revoke` covers them now.
pub fn delegation_view(u: &Use, client_name: &str, revoked: bool) -> Value {
    json!({"principal": u.person, "client": u.client, "client_name": client_name, "grant": u.grant, "first_use": u.first, "last_use": u.last,
           "ends": u.ends, "revoked": revoked})
}

/// ApprovalView of one entry of a connector's chain (12.2), None for any other action: metadata only, never the
/// person, the conversation or any text.
pub fn approval_view(connector: &str, e: &Value) -> Option<Value> {
    let action = s(e, "action");
    APPROVAL_ACTIONS.contains(&action).then(|| {
        json!({"ts": e.get("ts"), "connector": connector, "client": e.get("client"), "approval": e.get("approval"), "action": action,
               "result": e.get("result"), "app": e.get("app")})
    })
}

/// The approvals list: newest first, at most 200.
pub fn newest_approvals(mut list: Vec<Value>) -> Vec<Value> {
    list.sort_by(|a, b| int(b, "ts").cmp(&int(a, "ts")));
    list.truncate(APPROVALS_MAX);
    list
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api_cjournal::Reach;
    use crate::console_api_ui::{self as api_ui, Ctx, TWO_CLEARED, TWO_IDP_PRIVATE, TWO_LOOPBACK, TWO_UNDENY};

    const ORG: &str = "acme";
    const C1: &str = "c_0b1c2d3e4f5a6b7c";
    const D1: &str = "c_1a2b3c4d5e6f7a8b";
    const P1: &str = "c_2b3c4d5e6f7a8b9c";
    const K1: &str = "k_7a1b2c3d4e5f6a7b";
    const K2: &str = "k_8b2c3d4e5f6a7b8c";
    const APP: &str = "helpdesk-api@apps.acme.example";
    const APP2: &str = "billing-api@apps.acme.example";

    fn content_client() -> Value {
        json!({"id": C1, "name": "ops-bot", "principal": "ops-bot@apps.acme.example", "kind": "agent", "owner": "ann@acme.example", "reach": "R1",
               "scopes": ["content.read"], "ceiling": "internal", "relays": ["r1"], "networks": ["10.0.0.0/8"], "mtls_required": true,
               "hours": {"tz": "UTC", "from": "08:00", "to": "18:00", "days": [1, 2, 3, 4, 5]},
               "rate": {"per_minute_each": 60, "per_day_each": 1000}, "credentials": [], "created": 1, "expires": 100, "state": "active",
               "connectors": [K1], "apps": [APP], "channels": ["ch:a", "ch:b"], "confirm": ["content.read"]})
    }

    fn delegated_client() -> Value {
        json!({"id": D1, "name": "claude-ops", "principal": "claude-ops@apps.acme.example", "kind": "agent_delegated", "owner": "ann@acme.example",
               "reach": "R1", "scopes": ["content.read", "content.post"], "ceiling": "internal", "relays": ["*"], "networks": [], "mtls_required": false,
               "rate": {"per_minute_each": 60, "per_day_each": 1000}, "credentials": [], "created": 1, "expires": 100, "state": "active",
               "connectors": [K1], "apps": [APP], "channels": ["*"], "confirm": ["content.post"],
               "delegation": {"groups": ["00g1"], "principals": ["bob@acme.example"], "idps": ["okta"], "consent_days": 7, "denied": ["eve@acme.example"]},
               "redirect_uris": ["https://app.example/cb", "http://127.0.0.1/callback"]})
    }

    fn plain_client() -> Value {
        json!({"id": P1, "name": "grafana", "principal": "grafana@apps.acme.example", "kind": "app", "owner": "ann@acme.example", "reach": "R0",
               "scopes": ["monitor.read"], "ceiling": "internal", "relays": ["r1"], "networks": [], "mtls_required": false,
               "rate": {"per_minute_each": 60, "per_day_each": 1000}, "credentials": [], "created": 1, "expires": 100, "state": "active"})
    }

    fn connector() -> Value {
        json!({"id": K1, "name": "helpdesk", "origin": "https://connector.acme.example:9445", "apps": [APP], "networks": ["10.40.0.0/16"], "stale_s": 60, "state": "active"})
    }

    fn idp() -> Value {
        json!({"id": "okta", "provider": "okta", "issuer": "https://acme.okta.com", "algs": ["RS256", "ES256"], "tenant": "t0", "max_age_s": 300, "private_ok": false, "state": "active"})
    }

    fn base() -> Value {
        let mut m = api_ui::skeleton(ORG);
        m["clients"] = json!([content_client(), delegated_client(), plain_client()]);
        m["connectors"] = json!([connector()]);
        m["idps"] = json!([idp()]);
        m
    }

    fn draft_on(b: &Value) -> Draft {
        Draft::new(&Ctx { org: ORG, by: "admin@acme.example", pinned: Some(b), pinned_seq: 1 }, "st_0000000000000001".into(), 0)
    }

    fn entry(n: u64, action: &str, target: Value) -> ConsoleEntry {
        ConsoleEntry { id: format!("k_{ORG}_{n:06}"), org: ORG.into(), cseq: n, ts: 10 + n as i64, action: action.into(), target, reach: Reach::Console, prev_cseq: None }
    }

    fn has(out: &[Tighten], action: &str, target: Value) -> bool {
        out.iter().any(|t| t.action == action && t.target == target)
    }

    fn provider() -> IdentityProvider {
        IdentityProvider { org: ORG.into(), id: "okta".into(), kind: "okta".into(), iss: "https://acme.okta.com/oauth2/default".into(), sso_serial: "01".into(), cloud: String::new() }
    }

    /// 13.2 with one admin: every listed widening of a content or delegated client is a two-person save; its
    /// narrowings and a plain client's widenings are not.
    #[test]
    fn each_content_widening_needs_a_second_admin() {
        let b = base();
        let reasons = |m: &Value| api_ui::two_person(&b, m, &[]);
        assert!(reasons(&b).is_empty(), "nothing changed");
        let content: [(&str, fn(&mut Value)); 15] = [
            ("scope", |c| c["scopes"] = json!(["content.read", "content.post"])),
            ("credential", |c| c["credentials"] = json!([{"type": "mtls", "serial": "01", "spki": "aa"}])),
            ("ceiling", |c| c["ceiling"] = json!("confidential")),
            ("relays", |c| c["relays"] = json!(["r1", "r2"])),
            ("connectors", |c| c["connectors"] = json!([K1, K2])),
            ("apps", |c| c["apps"] = json!([APP, APP2])),
            ("channels *", |c| c["channels"] = json!(["*"])),
            ("networks emptied", |c| c["networks"] = json!([])),
            ("networks wider", |c| c["networks"] = json!(["0.0.0.0/0"])),
            ("hours", |c| {
                c.as_object_mut().unwrap().remove("hours");
            }),
            ("mtls off", |c| c["mtls_required"] = json!(false)),
            ("rate", |c| c["rate"]["per_minute_each"] = json!(120)),
            ("expires", |c| c["expires"] = json!(200)),
            ("kind", |c| c["kind"] = json!("app")),
            ("owner", |c| c["owner"] = json!("zed@acme.example")),
        ];
        for (what, widen) in content {
            let mut m = b.clone();
            widen(&mut m["clients"][0]);
            assert!(reasons(&m).contains(&TWO_CONTENT), "{what}");
        }
        let mut m = b.clone();
        m["clients"][0]["confirm"] = json!([]);
        assert!(reasons(&m).contains(&TWO_CONTENT), "a scope removed from confirm");
        let delegated: [(&str, fn(&mut Value)); 7] = [
            ("redirect", |c| c["redirect_uris"].as_array_mut().unwrap().push(json!("https://app.example/cb2"))),
            ("loopback", |c| c["loopback_ok"] = json!(true)),
            ("group", |c| c["delegation"]["groups"] = json!(["00g1", "00g2"])),
            ("principal", |c| c["delegation"]["principals"] = json!(["bob@acme.example", "cy@acme.example"])),
            ("idp", |c| c["delegation"]["idps"] = json!(["okta", "entra"])),
            ("consent days", |c| c["delegation"]["consent_days"] = json!(14)),
            ("undeny", |c| c["delegation"]["denied"] = json!([])),
        ];
        for (what, widen) in delegated {
            let mut m = b.clone();
            widen(&mut m["clients"][1]);
            assert!(reasons(&m).contains(&TWO_CONTENT), "{what}");
        }
        let mut m = b.clone();
        m["clients"][1]["loopback_ok"] = json!(true);
        assert!(reasons(&m).contains(&TWO_LOOPBACK));
        let mut m = b.clone();
        m["clients"][1]["delegation"]["denied"] = json!([]);
        assert!(reasons(&m).contains(&TWO_UNDENY));
        // resuming a suspended content client
        let mut suspended = b.clone();
        suspended["clients"][0]["state"] = json!("suspended");
        let mut m = suspended.clone();
        m["clients"][0]["state"] = json!("active");
        assert!(api_ui::two_person(&suspended, &m, &[]).contains(&TWO_CONTENT), "resume");
        // a new content client and a new delegated client (even without a content scope)
        for kind_scopes in [json!({"kind": "agent", "scopes": ["content.read"]}), json!({"kind": "agent_delegated", "scopes": ["monitor.read"]})] {
            let mut c = plain_client();
            c["id"] = json!("c_3c4d5e6f7a8b9c0d");
            c["kind"] = kind_scopes["kind"].clone();
            c["scopes"] = kind_scopes["scopes"].clone();
            let mut m = b.clone();
            m["clients"].as_array_mut().unwrap().push(c);
            assert!(reasons(&m).contains(&TWO_CONTENT), "{kind_scopes}");
        }
        // narrowings need step-up only
        let mut m = b.clone();
        m["clients"][0]["channels"] = json!(["ch:a"]);
        m["clients"][0]["networks"] = json!(["10.1.0.0/16"]);
        m["clients"][0]["confirm"] = json!(["content.read", "content.post"]);
        m["clients"][1]["delegation"]["groups"] = json!([]);
        m["clients"][1]["delegation"]["consent_days"] = json!(3);
        m["clients"][1]["delegation"]["denied"] = json!(["eve@acme.example", "mal@acme.example"]);
        m["clients"][1]["redirect_uris"] = json!(["https://app.example/cb"]);
        assert!(reasons(&m).is_empty(), "{:?}", reasons(&m));
        // a plain client widened is not a content widening
        let mut m = b.clone();
        m["clients"][2]["relays"] = json!(["r1", "r2"]);
        assert!(!reasons(&m).contains(&TWO_CONTENT));
    }

    #[test]
    fn connectors_and_idps_added_or_widened_need_a_second_admin() {
        let b = base();
        let reasons = |m: &Value| api_ui::two_person(&b, m, &[]);
        let widenings: [(&str, fn(&mut Value)); 4] = [
            ("app", |k| k["apps"] = json!([APP, APP2])),
            ("networks wider", |k| k["networks"] = json!(["10.0.0.0/8"])),
            ("networks emptied", |k| k["networks"] = json!([])),
            ("stale_s", |k| k["stale_s"] = json!(120)),
        ];
        for (what, widen) in widenings {
            let mut m = b.clone();
            widen(&mut m["connectors"][0]);
            assert_eq!(reasons(&m), [TWO_CONNECTOR], "{what}");
        }
        let mut m = b.clone();
        let mut k = connector_fixture_other();
        k["id"] = json!(K2);
        m["connectors"].as_array_mut().unwrap().push(k);
        assert_eq!(reasons(&m), [TWO_CONNECTOR], "a new connector");
        let mut m = b.clone();
        m["connectors"][0]["networks"] = json!(["10.40.1.0/24"]);
        m["connectors"][0]["stale_s"] = json!(30);
        assert!(reasons(&m).is_empty(), "narrowing a connector");
        let idp_w: [(&str, fn(&mut Value)); 6] = [
            ("algs", |i| i["algs"] = json!(["RS256", "ES256", "PS256"])),
            ("max_age_s", |i| i["max_age_s"] = json!(600)),
            ("auth_max_s", |i| i["auth_max_s"] = json!(86400)),
            ("tenant removed", |i| {
                i.as_object_mut().unwrap().remove("tenant");
            }),
            ("tenant changed", |i| i["tenant"] = json!("t9")),
            ("issuer", |i| i["issuer"] = json!("https://other.okta.com")),
        ];
        for (what, widen) in idp_w {
            let mut m = b.clone();
            widen(&mut m["idps"][0]);
            assert_eq!(reasons(&m), [TWO_IDP], "{what}");
        }
        let mut m = b.clone();
        m["idps"][0]["private_ok"] = json!(true);
        assert_eq!(reasons(&m), [TWO_IDP_PRIVATE, TWO_IDP]);
        let mut suspended = b.clone();
        suspended["idps"][0]["state"] = json!("suspended");
        assert_eq!(api_ui::two_person(&suspended, &b, &[]), [TWO_IDP], "resume");
        let mut m = b.clone();
        let mut i = idp();
        i["id"] = json!("entra");
        i["issuer"] = json!("https://login.microsoftonline.com/x/v2.0");
        m["idps"].as_array_mut().unwrap().push(i);
        assert_eq!(reasons(&m), [TWO_IDP], "a new idp");
        let mut m = b.clone();
        m["idps"][0]["algs"] = json!(["RS256"]);
        m["idps"][0]["max_age_s"] = json!(120);
        m["idps"][0]["auth_max_s"] = json!(3600);
        assert!(reasons(&m).is_empty(), "narrowing an idp");
    }

    fn connector_fixture_other() -> Value {
        json!({"id": K2, "name": "billing", "origin": "https://billing.acme.example:9445", "apps": [APP2], "networks": [], "stale_s": 60, "state": "active"})
    }

    #[test]
    fn connector_routes_stage_and_journal() {
        let b = base();
        let mut d = draft_on(&b);
        add_connector(&mut d, &json!({"name": "Billing", "origin": "https://billing.acme.example:9445", "apps": [APP2]}), K2.into()).unwrap();
        let k = find(&d.map, "connectors", K2).unwrap();
        assert_eq!((s(k, "name"), k["stale_s"].clone(), s(k, "state"), k["networks"].clone()), ("billing", json!(60), "active", json!([])));
        assert_eq!(add_connector(&mut d, &json!({"name": "billing", "origin": "https://x.acme.example:1", "apps": [APP]}), "k_0000000000000000".into()).unwrap_err().code, "invalid");
        assert_eq!(add_connector(&mut d, &json!({"name": "x", "origin": "https://x:1", "apps": [], "secret": 1}), "k_0000000000000000".into()).unwrap_err().code, "invalid");
        assert!(d.view(&[])["two_person_reasons"].as_array().unwrap().contains(&json!(TWO_CONNECTOR)));
        // an app removed and the networks narrowed journal at once; widening journals nothing
        let out = update_connector(&mut d, K1, &json!({"apps": [], "networks": ["10.40.1.0/24"]}), Some(&b)).unwrap();
        assert!(has(&out, "connector_drop_app", json!({"connector": K1, "app": APP})));
        assert!(has(&out, "connector_limit", json!({"connector": K1, "networks": ["10.40.1.0/24"]})));
        assert_eq!(out.len(), 2);
        let mut d = draft_on(&b);
        assert!(update_connector(&mut d, K1, &json!({"networks": [], "stale_s": 300}), Some(&b)).unwrap().is_empty());
        // suspend and delete journal connector_suspend; delete also leaves every client's connectors
        let mut d = draft_on(&b);
        let out = suspend_connector(&mut d, K1, Some(&b)).unwrap();
        assert_eq!(out, vec![tighten("connector_suspend", json!(K1))]);
        assert_eq!(s(find(&d.map, "connectors", K1).unwrap(), "state"), "suspended");
        let console = [entry(1, "connector_suspend", json!(K1))];
        resume_connector(&mut d, K1, &console).unwrap();
        assert_eq!(d.map["cleared"], json!(["k_acme_000001"]));
        assert!(api_ui::two_person(&d.base, &d.map, &[]).contains(&TWO_CLEARED), "resume clears a k_ id");
        let mut d = draft_on(&b);
        let out = delete_connector(&mut d, K1, Some(&b)).unwrap();
        assert_eq!(out, vec![tighten("connector_suspend", json!(K1))]);
        assert!(find(&d.map, "connectors", K1).is_none());
        assert_eq!(d.map["clients"][0]["connectors"], json!([]));
        assert_eq!(d.map["clients"][1]["connectors"], json!([]));
        assert_eq!(delete_connector(&mut d, K1, Some(&b)).unwrap_err().code, "not-found");
        // a connector only staged journals nothing
        let mut d = draft_on(&b);
        add_connector(&mut d, &connector_fixture_other(), K2.into()).unwrap_err();
        let mut body = connector_fixture_other();
        body.as_object_mut().unwrap().retain(|k, _| CONNECTOR_BODY.contains(&k.as_str()));
        add_connector(&mut d, &body, K2.into()).unwrap();
        assert!(suspend_connector(&mut d, K2, Some(&b)).unwrap().is_empty());
    }

    #[test]
    fn idp_routes_stage_and_journal() {
        let mut b = base();
        b["idps"] = json!([]);
        let mut d = draft_on(&b);
        assert_eq!(add_idp(&mut d, &json!({"provider": "entra"}), &[provider()]).unwrap_err().message, NO_PROVIDER);
        add_idp(&mut d, &json!({"provider": "okta"}), &[provider()]).unwrap();
        let i = find(&d.map, "idps", "okta").unwrap();
        assert_eq!(s(i, "issuer"), "https://acme.okta.com", "R5-9: Okta's org authorization server");
        assert_eq!((i["algs"].clone(), i["max_age_s"].clone(), i["private_ok"].clone(), s(i, "state")), (json!(["RS256"]), json!(300), json!(false), "active"));
        assert_eq!(api_ui::two_person(&d.base, &d.map, &[]), [TWO_IDP]);
        // a narrowing journals idp_limit at once
        let b = base();
        let mut d = draft_on(&b);
        let out = update_idp(&mut d, "okta", &json!({"algs": ["RS256"], "max_age_s": 120, "tenant": "t1"}), Some(&b)).unwrap();
        assert_eq!(out, vec![tighten("idp_limit", json!({"idp": "okta", "algs": ["RS256"], "max_age_s": 120, "tenant": "t1"}))]);
        let mut private = base();
        private["idps"][0]["private_ok"] = json!(true);
        let mut d = draft_on(&private);
        let out = update_idp(&mut d, "okta", &json!({"private_ok": false}), Some(&private)).unwrap();
        assert_eq!(out, vec![tighten("idp_limit", json!({"idp": "okta", "private_ok": false}))]);
        let mut d = draft_on(&b);
        assert!(update_idp(&mut d, "okta", &json!({"tenant": null, "max_age_s": 600}), Some(&b)).unwrap().is_empty(), "a widening journals nothing");
        assert!(find(&d.map, "idps", "okta").unwrap().get("tenant").is_none());
        assert_eq!(update_idp(&mut d, "okta", &json!({"id": "other"}), Some(&b)).unwrap_err().message, IDP_ID_FIXED);
        // suspend journals idp_suspend; resume clears it
        let mut d = draft_on(&b);
        assert_eq!(suspend_idp(&mut d, "okta", Some(&b)).unwrap(), vec![tighten("idp_suspend", json!("okta"))]);
        resume_idp(&mut d, "okta", &[entry(3, "idp_suspend", json!("okta"))]).unwrap();
        assert_eq!(d.map["cleared"], json!(["k_acme_000003"]));
        assert!(api_ui::two_person(&d.base, &d.map, &[]).contains(&TWO_CLEARED));
    }

    /// 4.2: each narrowing of a client's revision 5 fields journals its action at once (update_client).
    #[test]
    fn each_client_narrowing_journals_its_action() {
        let b = base();
        let mut d = draft_on(&b);
        let body = json!({"connectors": [], "apps": [], "channels": ["ch:a"], "confirm": ["content.read", "content.post"]});
        let out = api_ui::update_client(&mut d, C1, &body, Some(&b), 50).unwrap();
        assert!(has(&out, "client_drop_connector", json!({"client": C1, "connector": K1})));
        assert!(has(&out, "client_drop_app", json!({"client": C1, "app": APP})));
        assert!(has(&out, "client_limit_channels", json!({"client": C1, "channels": ["ch:a"]})));
        assert!(has(&out, "client_confirm", json!({"client": C1, "scope": "content.post"})));
        let mut d = draft_on(&b);
        let body = json!({"channels": ["ch:z"], "redirect_uris": ["https://app.example/cb"],
                          "delegation": {"groups": [], "principals": [], "idps": [], "consent_days": 3, "denied": ["eve@acme.example", "Mal@acme.example"]}});
        let out = api_ui::update_client(&mut d, D1, &body, Some(&b), 50).unwrap();
        assert!(has(&out, "client_limit_channels", json!({"client": D1, "channels": ["ch:z"]})), "* narrowed to a list");
        assert!(has(&out, "client_drop_delegation", json!({"client": D1, "group": "00g1"})));
        assert!(has(&out, "client_drop_delegation", json!({"client": D1, "principal": "bob@acme.example"})));
        assert!(has(&out, "client_drop_delegation", json!({"client": D1, "idp": "okta"})));
        assert!(has(&out, "client_limit_delegation", json!({"client": D1, "consent_days": 3})));
        assert!(has(&out, "person_revoke", json!({"client": D1, "principal": "mal@acme.example"})), "a principal added to denied");
        assert!(has(&out, "client_drop_redirect", json!({"client": D1, "uri": "http://127.0.0.1/callback"})));
        assert_eq!(out.len(), 7);
        // every target fits its console journal action
        for t in &out {
            assert!(cj::target_ok(t.action, &t.target), "{} {}", t.action, t.target);
        }
        // widening journals nothing
        let mut d = draft_on(&b);
        let out = api_ui::update_client(&mut d, D1, &json!({"delegation": {"groups": ["00g1", "00g2"], "principals": ["bob@acme.example"], "idps": ["okta"], "consent_days": 30, "denied": []}}), Some(&b), 50).unwrap();
        assert!(out.is_empty(), "{out:?}");
    }

    #[test]
    fn delegations_revoke_and_allow() {
        let b = base();
        let mut d = draft_on(&b);
        let out = revoke_delegation(&mut d, D1, " Mal@Acme.example ").unwrap();
        assert_eq!(out, vec![tighten("person_revoke", json!({"client": D1, "principal": "mal@acme.example"}))]);
        assert_eq!(d.map["clients"][1]["delegation"]["denied"], json!(["eve@acme.example", "mal@acme.example"]));
        assert!(cj::target_ok("person_revoke", &out[0].target));
        assert!(api_ui::two_person(&d.base, &d.map, &[]).is_empty(), "a revocation needs step-up only");
        // `*` stages into every agent_delegated client and leaves the others
        let mut d = draft_on(&b);
        let out = revoke_delegation(&mut d, "*", "zed@acme.example").unwrap();
        assert_eq!(out[0].target, json!({"client": "*", "principal": "zed@acme.example"}));
        assert_eq!(d.map["clients"][1]["delegation"]["denied"], json!(["eve@acme.example", "zed@acme.example"]));
        assert!(d.map["clients"][0].get("delegation").is_none());
        assert_eq!(revoke_delegation(&mut d, C1, "zed@acme.example").unwrap_err().message, NOT_DELEGATED);
        assert_eq!(revoke_delegation(&mut d, "c_nope", "zed@acme.example").unwrap_err().message, BAD_CLIENT);
        assert_eq!(revoke_delegation(&mut d, D1, "not a person").unwrap_err().message, BAD_PRINCIPAL);
        // allow lifts the deny and clears its entry: a two-person save
        let console = [entry(4, "person_revoke", json!({"client": D1, "principal": "eve@acme.example"}))];
        let mut d = draft_on(&b);
        allow_delegation(&mut d, D1, "eve@acme.example", &console).unwrap();
        assert_eq!(d.map["clients"][1]["delegation"]["denied"], json!([]));
        assert_eq!(d.map["cleared"], json!(["k_acme_000004"]));
        let reasons = api_ui::two_person(&d.base, &d.map, &[]);
        for r in [TWO_UNDENY, TWO_CLEARED, TWO_CONTENT] {
            assert!(reasons.contains(&r), "{r}");
        }
        // a revocation for every client is lifted only for every client
        let all = [entry(5, "person_revoke", json!({"client": "*", "principal": "eve@acme.example"}))];
        let mut d = draft_on(&b);
        assert_eq!(allow_delegation(&mut d, D1, "eve@acme.example", &all).unwrap_err().message, REVOKED_FOR_ALL);
        allow_delegation(&mut d, "*", "eve@acme.example", &all).unwrap();
        assert_eq!(d.map["cleared"], json!(["k_acme_000005"]));
        let mut d = draft_on(&b);
        assert_eq!(allow_delegation(&mut d, D1, "nobody@acme.example", &[]).unwrap_err().code, "stale");
    }

    /// The views never carry a secret, key material, a person in an approval or any text.
    #[test]
    fn views_carry_no_secret() {
        let mut c = delegated_client();
        c["credentials"] = json!([
            {"type": "client_secret", "sha256": "5e88489c51d2b1a4e1e7a0e0c4f8f3b5f1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6", "hint": "5e88489c", "expires": 90},
            {"type": "cimd", "url": "https://claude.ai/oauth/mcp-client.json", "private_ok": false, "expires": 80}
        ]);
        let v = api_ui::client_view(&c, &[], &|_: &str| true, 50);
        let text = v.to_string();
        assert!(!text.contains("5e88489c51d2"), "no secret hash");
        assert_eq!(v["credentials"][1], json!({"type": "cimd", "hint": "https://claude.ai/oauth/mcp-client.json", "expires": 80}));
        assert_eq!(v["delegation"]["denied"], json!(["eve@acme.example"]));
        assert_eq!(v["redirect_uris"], c["redirect_uris"]);
        assert_eq!(v["connectors"], json!([K1]));
        // IdP test: kid, alg, kty only
        let keys = [json!({"kid": "k1", "alg": "RS256", "kty": "RSA", "n": "secretish-modulus", "e": "AQAB"})];
        let t = idp_test_view("https://acme.okta.com", "https://acme.okta.com/oauth2/v1/keys", &keys);
        assert_eq!(t["keys"], json!([{"kid": "k1", "alg": "RS256", "kty": "RSA"}]));
        assert!(!t.to_string().contains("modulus"));
        // an approval entry loses its person and conversation
        let e = json!({"seq": 9, "ts": 70, "action": "content.approval.answered", "client": D1, "person": "ann@acme.example", "conv": "ch:a", "approval": "ab".repeat(16), "result": "approved"});
        let a = approval_view(K1, &e).unwrap();
        assert_eq!(a, json!({"ts": 70, "connector": K1, "client": D1, "approval": "ab".repeat(16), "action": "content.approval.answered", "result": "approved", "app": null}));
        assert!(approval_view(K1, &json!({"action": "api.call", "client": D1})).is_none());
        // idp and connector views
        let i = idp_view(&idp(), &[entry(6, "idp_suspend", json!("okta"))], Some((40, 2)));
        assert_eq!((i["shown_state"].clone(), i["auth_max_s"].clone(), i["last_test"].clone(), i["keys"].clone()), (json!("suspended"), json!(43200), json!(40), json!(2)));
        let k = connector_view(&connector(), Some(&connector_status(None, 60, 100)), &[]);
        assert_eq!(k["shown_state"], json!("never-synced"));
        assert_eq!(k.as_object().unwrap().len(), 9, "the map fields, shown_state and suspended_by_journal only");
    }

    #[test]
    fn connector_status_from_the_latest_ack() {
        let ack = json!({"connector": K1, "at": 1000, "ack": {"org": ORG, "seq": 3, "tseq": 1, "cseq": 2, "conversations": [{"cid": "ch:a"}, {"cid": "ch:b"}],
                                                          "metrics": {}, "features": ["connectors", "journal-1c"], "seal": "tpm"}});
        let st = connector_status(Some(&ack), 60, 1030);
        assert_eq!(st, json!({"sync_age_s": 30, "conversations": 2, "seal": "tpm", "features": ["connectors", "journal-1c"], "reported_at": 1000, "stale": false}));
        assert_eq!(connector_view(&connector(), Some(&st), &[])["shown_state"], json!("active"));
        let old = connector_status(Some(&ack), 60, 1100);
        assert_eq!(old["stale"], json!(true));
        assert_eq!(connector_view(&connector(), Some(&old), &[])["shown_state"], json!("stale"));
        assert_eq!(connector_view(&connector(), Some(&old), &[entry(7, "connector_suspend", json!(K1))])["suspended_by_journal"], json!(true));
        assert_eq!(api_return(Some("https://console.acme.example:7443/api/orgs/acme/")), json!("https://console.acme.example:7443/api/orgs/acme/oauth/sso-return"));
        assert_eq!(api_return(Some("")), Value::Null);
    }

    #[test]
    fn revokes_approvals_and_policy_lists() {
        let console = [
            entry(1, "person_revoke", json!({"client": D1, "principal": "eve@acme.example"})),
            entry(2, "person_revoke", json!({"client": "*", "principal": "zed@acme.example"})),
            entry(3, "person_revoke", json!({"client": "c_9999999999999999", "principal": "cy@acme.example"})),
            entry(4, "idp_suspend", json!("okta")),
        ];
        let mine = revoke_views(&console, D1);
        assert_eq!(mine.len(), 2, "its own and the * ones");
        assert_eq!(mine[0], json!({"id": "k_acme_000001", "client": D1, "principal": "eve@acme.example", "ts": 11}));
        assert_eq!(revoke_views(&console, "*").len(), 3);
        let list: Vec<Value> = (0..250).map(|n| json!({"ts": n, "action": "content.person.stopped"})).collect();
        let newest = newest_approvals(list);
        assert_eq!((newest.len(), newest[0]["ts"].clone()), (APPROVALS_MAX, json!(249)));
        let mut policy = Obj::new();
        policy.insert("apps".into(), json!([{"principal": APP, "name": "Helpdesk", "type": "api"}, {"principal": "bot@apps.acme.example", "name": "Bot", "type": "bot"}]));
        policy.insert("ai".into(), json!({"who": {"groups": ["00g1"]}}));
        assert_eq!(api_apps(Some(&policy)), json!([{"principal": APP, "name": "Helpdesk"}]));
        assert_eq!(ai_groups(Some(&policy)), json!([{"id": "00g1", "label": "00g1"}]));
        assert_eq!(api_apps(None), json!([]));
        let u = Use { client: D1.into(), person: "ann@acme.example".into(), grant: "jwt_bearer".into(), first: 5, last: 9, ends: None };
        assert_eq!(delegation_view(&u, "claude-ops", false),
                   json!({"principal": "ann@acme.example", "client": D1, "client_name": "claude-ops", "grant": "jwt_bearer", "first_use": 5, "last_use": 9, "ends": null, "revoked": false}));
        assert_eq!(provider_view(&provider(), None, &json!("https://i/oauth/sso-return"))["sso_url"], Value::Null);
    }

    fn without(mut v: Value, k: &str) -> Value {
        v.as_object_mut().unwrap().remove(k);
        v
    }

    /// Widening (13.2) and narrowing (4.2) compare effective values: a field a map omits counts as its default
    /// (`consent_days` 7, `max_age_s` 300, `auth_max_s` 43200, `stale_s` 60, `networks`, `confirm` and `channels`
    /// empty).
    #[test]
    fn omitted_fields_count_as_their_defaults() {
        // consent_days: an explicit 1 changed to omitted widens to 7 (two-person); omitted changed to 3 is journaled
        let b = base();
        let mut one = b.clone();
        one["clients"][1]["delegation"]["consent_days"] = json!(1);
        let mut omitted = b.clone();
        omitted["clients"][1]["delegation"] = without(omitted["clients"][1]["delegation"].clone(), "consent_days");
        let mut three = b.clone();
        three["clients"][1]["delegation"]["consent_days"] = json!(3);
        assert!(api_ui::two_person(&one, &omitted, &[]).contains(&TWO_CONTENT), "1 to omitted (7) widens");
        assert!(api_ui::two_person(&omitted, &b, &[]).is_empty(), "omitted and an explicit 7 are the same");
        assert!(client_narrowings(D1, &one["clients"][1], &omitted["clients"][1]).is_empty(), "1 to omitted narrows nothing");
        assert_eq!(client_narrowings(D1, &omitted["clients"][1], &three["clients"][1]), vec![tighten("client_limit_delegation", json!({"client": D1, "consent_days": 3}))]);
        assert!(client_narrowings(D1, &omitted["clients"][1], &b["clients"][1]).is_empty());
        // max_age_s: 600 to omitted (300) narrows at once; omitted to 600 widens; omitted and 300 are the same
        let mut wide = idp();
        wide["max_age_s"] = json!(600);
        let none = without(idp(), "max_age_s");
        assert_eq!(idp_narrowing("okta", &wide, &none), Some(tighten("idp_limit", json!({"idp": "okta", "max_age_s": 300}))));
        assert!(idp_widens(Some(&none), &wide));
        assert!(!idp_widens(Some(&none), &idp()) && idp_narrowing("okta", &none, &idp()).is_none());
        assert!(!idp_widens(Some(&wide), &none));
        // auth_max_s: 3600 to omitted (43200) widens; 86400 to omitted does not
        let mut short = idp();
        short["auth_max_s"] = json!(3600);
        let mut long = idp();
        long["auth_max_s"] = json!(86400);
        assert!(idp_widens(Some(&short), &idp()));
        assert!(!idp_widens(Some(&long), &idp()));
        assert!(!idp_widens(Some(&idp()), &short) && idp_narrowing("okta", &idp(), &short).is_none(), "a lower auth_max_s is staged only");
        // stale_s: 30 to omitted (60) widens; omitted to 60 does not; omitted to 120 does
        let mut k_short = connector();
        k_short["stale_s"] = json!(30);
        let k_none = without(connector(), "stale_s");
        let mut k_long = connector();
        k_long["stale_s"] = json!(120);
        assert!(connector_widens(Some(&k_short), &k_none));
        assert!(!connector_widens(Some(&k_none), &connector()));
        assert!(connector_widens(Some(&k_none), &k_long));
        // networks: omitted and [] both mean any source
        let k_open = without(connector(), "networks");
        let mut k_empty = connector();
        k_empty["networks"] = json!([]);
        assert_eq!(connector_narrowings(K1, &k_open, &connector()), vec![tighten("connector_limit", json!({"connector": K1, "networks": ["10.40.0.0/16"]}))]);
        assert!(!connector_widens(Some(&k_open), &k_empty) && connector_narrowings(K1, &k_open, &k_empty).is_empty());
        assert!(connector_widens(Some(&connector()), &k_open), "networks left out: any source");
        // confirm: omitted and [] both mean none
        let c_none = without(content_client(), "confirm");
        let mut c_empty = content_client();
        c_empty["confirm"] = json!([]);
        assert!(content_widens(Some(&content_client()), &c_none), "confirm left out removes a scope from it");
        assert_eq!(client_narrowings(C1, &c_none, &content_client()), vec![tighten("client_confirm", json!({"client": C1, "scope": "content.read"}))]);
        assert!(!content_widens(Some(&c_none), &c_empty) && client_narrowings(C1, &c_none, &c_empty).is_empty());
        // channels: omitted means none, so `*` widens
        let mut ch_all = content_client();
        ch_all["channels"] = json!(["*"]);
        assert!(content_widens(Some(&without(content_client(), "channels")), &ch_all));
        // delegation: none to some widens
        assert!(content_widens(Some(&without(delegated_client(), "delegation")), &delegated_client()));
    }

    /// Revision 5 4.1: a client whose kind leaves `agent_delegated` loses its `cimd` credential (journaled as a
    /// credential drop) and keeps its key.
    #[test]
    fn a_client_leaving_agent_delegated_loses_its_cimd() {
        let mut b = base();
        let key = json!({"type": "private_key_jwt", "kid": "k1", "jwks_uri": "https://app.example/jwks.json", "expires": 90});
        b["clients"][1]["credentials"] = json!([{"type": "cimd", "url": "https://claude.ai/oauth/mcp-client.json", "private_ok": false, "expires": 80}, key]);
        let mut d = draft_on(&b);
        let out = api_ui::update_client(&mut d, D1, &json!({"kind": "agent", "delegation": null, "redirect_uris": null}), Some(&b), 50).unwrap();
        assert_eq!(find(&d.map, "clients", D1).unwrap()["credentials"], json!([key]));
        assert!(has(&out, "client_drop_credential", json!({"client": D1, "type": "cimd"})));
        assert!(!out.iter().any(|t| t.action == "client_drop_credential" && t.target.get("kid").is_some()), "the key stays");
        // still agent_delegated: the cimd stays
        let mut d = draft_on(&b);
        let out = api_ui::update_client(&mut d, D1, &json!({"rate": {"per_minute_each": 30, "per_day_each": 1000}}), Some(&b), 50).unwrap();
        assert_eq!(find(&d.map, "clients", D1).unwrap()["credentials"].as_array().unwrap().len(), 2);
        assert!(!out.iter().any(|t| t.action == "client_drop_credential"));
    }
}
