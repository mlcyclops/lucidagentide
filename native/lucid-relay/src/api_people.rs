// API-1 revision 4 (docs/api/contract-r4-1b.md) 2.5 `api-person`, 6.7 and 13.1 `directory/status`: the console side of
// a principal's deprovisioning.
//
// A relay whose SSO service suspended a principal sends `api-person {org, principal, state, at, provider, source}`.
// The console applies it only when `at` is later than the record it holds for (org, principal); at an equal `at`,
// `deprovisioned` wins, so records from several relays arriving out of order never re-mark an owner active
// (Rev4Review R4-13). An applied record is in the org's chain (`directory.person`) and fsynced to
// `<state>/api-people/<org>.json`, then its event goes out (`person.deprovisioned` or `person.reactivated`), then
// every client of the org's pinned map whose `owner` is that principal and that is not suspended yet gets a journaled
// `client_suspend`; only then is the relay answered. A record that repeats the stored `deprovisioned` (a relay that
// retries after a failed answer) runs the suspensions again and nothing else. A stale record is answered and ignored.
// `active` is stored and announced; its clients stay suspended until an admin's signed widening.
//
// The owner rule (`fleet_people::People::person_inactive`) reads `deprovisioned` here. The attention item
// `api-owner-gone` (`ApiOwnerGone`) stands while the pinned map still lists a client owned by a deprovisioned
// principal. `directory/status` reads the relays' chains the console already holds from `api-audit` (route `scim`),
// and asks the connected relays for the SSO services' token dates and pending confirmations (`api_sso_status`).

use crate::console::ApiError;
use crate::fleet_wire::Refusal;
use parking_lot::Mutex;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

/// The folder under the console's state folder: one `<org>.json` per org.
pub const DIR: &str = "api-people";
pub const DEPROVISIONED: &str = "deprovisioned";
pub const ACTIVE: &str = "active";
/// `api-person` `source` values (2.5).
pub const SOURCES: [&str; 3] = ["scim", "directory", "signin"];
/// The `directory.person` field that carries the record's `source`: the chain's own `source` field names the chain.
pub const SOURCE_FIELD: &str = "person_source";
/// The SCIM decisions' route in the relays' chains (6.3).
pub const SCIM_ROUTE: &str = "scim";
/// `directory/status` reads at most this many of the newest entries of each relay chain.
pub const SCAN_MAX: u64 = 200_000;
const PAGE: usize = 1000;
const MAX_SAFE: i64 = (1 << 53) - 1;
const FILE_VERSION: u64 = 1;

/// One principal's stored state.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Record {
    pub state: String,
    pub at: i64,
    pub provider: String,
    pub source: String,
}

impl Record {
    pub fn deprovisioned(&self) -> bool {
        self.state == DEPROVISIONED
    }

    fn to_value(&self) -> Value {
        json!({ "state": self.state, "at": self.at, "provider": self.provider, "source": self.source })
    }

    fn of(v: &Value) -> Result<Record, &'static str> {
        let state = v.get("state").and_then(Value::as_str).filter(|s| *s == DEPROVISIONED || *s == ACTIVE).ok_or("state is deprovisioned or active")?;
        let at = v.get("at").and_then(Value::as_i64).filter(|a| (0..=MAX_SAFE).contains(a)).ok_or("at is a whole number of seconds")?;
        let provider = v.get("provider").and_then(Value::as_str).filter(|p| provider_ok(p)).ok_or("provider is 1 to 64 printable ASCII characters")?;
        let source = v.get("source").and_then(Value::as_str).filter(|s| SOURCES.contains(s)).ok_or("source is scim, directory or signin")?;
        Ok(Record { state: state.to_owned(), at, provider: provider.to_owned(), source: source.to_owned() })
    }
}

fn provider_ok(p: &str) -> bool {
    (1..=64).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_graphic())
}

/// An `api-person` request, checked.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Person {
    pub org: String,
    pub principal: String,
    pub record: Record,
}

/// 2.5: the values of an `api-person` body (the wire already checked its exact keys and size).
pub fn parse(body: &Value) -> Result<Person, Refusal> {
    let bad = |why: &str| Refusal::new(400, "invalid", why);
    let org = body.get("org").and_then(Value::as_str).filter(|o| crate::api_audit::org_ok(o)).ok_or_else(|| bad("org is not an organization id"))?;
    let principal = body.get("principal").and_then(Value::as_str).filter(|p| crate::meet_org_policy::split_principal(p).is_ok()).ok_or_else(|| bad("principal is a lower-case email"))?;
    let record = Record::of(body).map_err(bad)?;
    Ok(Person { org: org.to_owned(), principal: principal.to_owned(), record })
}

/// What a record does to the stored one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    /// Later than the stored record (or an equal `at` turning it `deprovisioned`): stored, audited, announced.
    Apply,
    /// The stored `deprovisioned` again (same `at`): only the suspensions run again.
    Repeat,
    /// Older, or an equal `at` that would not make it `deprovisioned`: answered and ignored.
    Stale,
}

/// 6.7: later `at` wins; at an equal `at`, `deprovisioned` wins.
pub fn decide(stored: Option<&Record>, new: &Record) -> Decision {
    match stored {
        None => Decision::Apply,
        Some(s) if new.at > s.at => Decision::Apply,
        Some(s) if new.at == s.at && new.deprovisioned() => {
            if s.deprovisioned() {
                Decision::Repeat
            } else {
                Decision::Apply
            }
        }
        Some(_) => Decision::Stale,
    }
}

// ── the stored records ──

/// principal to record, for one org.
pub type OrgPeople = BTreeMap<String, Record>;

type Slot = Arc<Mutex<Option<OrgPeople>>>;

/// Each org file read once and kept (only this module writes it); None until read.
static FILES: LazyLock<Mutex<HashMap<PathBuf, Slot>>> = LazyLock::new(Default::default);

fn file_of(dir: &Path, org: &str) -> PathBuf {
    dir.join(DIR).join(format!("{org}.json"))
}

fn slot(path: &Path) -> Slot {
    FILES.lock().entry(path.to_path_buf()).or_default().clone()
}

fn load(path: &Path) -> Result<OrgPeople, String> {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(OrgPeople::new()),
        Err(e) => return Err(format!("{}: {e}", path.display())),
    };
    let v: Value = serde_json::from_slice(&bytes).map_err(|e| format!("{}: {e}", path.display()))?;
    if v.get("v").and_then(Value::as_u64) != Some(FILE_VERSION) {
        return Err(format!("{}: not version {FILE_VERSION}", path.display()));
    }
    let people = v.get("people").and_then(Value::as_object).ok_or_else(|| format!("{}: no people", path.display()))?;
    let mut out = OrgPeople::new();
    for (p, r) in people {
        if crate::meet_org_policy::split_principal(p).is_err() {
            return Err(format!("{}: {p} is not a principal", path.display()));
        }
        out.insert(p.clone(), Record::of(r).map_err(|why| format!("{}: {p}: {why}", path.display()))?);
    }
    Ok(out)
}

fn save(path: &Path, people: &OrgPeople) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    let list: Map<String, Value> = people.iter().map(|(p, r)| (p.clone(), r.to_value())).collect();
    crate::fleet_local::write_durable(path, json!({ "v": FILE_VERSION, "people": list }).to_string().as_bytes())
}

/// The org's records, read on first use.
fn loaded<'a>(guard: &'a mut Option<OrgPeople>, path: &Path) -> Result<&'a mut OrgPeople, String> {
    if guard.is_none() {
        *guard = Some(load(path)?);
    }
    guard.as_mut().ok_or_else(|| "not loaded".to_owned())
}

/// The org's records (`dir` is the console's state folder).
pub fn records(dir: &Path, org: &str) -> Result<OrgPeople, String> {
    if !crate::api_audit::org_ok(org) {
        return Err("not an organization id".into());
    }
    let path = file_of(dir, org);
    let s = slot(&path);
    let mut g = s.lock();
    loaded(&mut g, &path).map(|p| p.clone())
}

/// 6.7 owner rule: the console's record for (`org`, `principal`) says `deprovisioned`. A file that does not read back
/// counts as deprovisioned (fail closed).
pub fn deprovisioned(dir: &Path, org: &str, principal: &str) -> bool {
    if !crate::api_audit::org_ok(org) {
        return false;
    }
    let want = principal.trim().to_lowercase();
    let path = file_of(dir, org);
    let s = slot(&path);
    let mut g = s.lock();
    match loaded(&mut g, &path) {
        Ok(people) => people.get(&want).is_some_and(Record::deprovisioned),
        Err(_) => true,
    }
}

// ── applying a record ──

/// The clients of a pinned map (`map` object) whose `owner` is `principal`: (id, already suspended), suspended in the
/// map itself or by `held`.
pub fn owned_clients(map: Option<&Value>, principal: &str, held: &dyn Fn(&str) -> bool) -> Vec<(String, bool)> {
    let Some(clients) = map.and_then(|m| m.get("clients")).and_then(Value::as_array) else { return Vec::new() };
    clients
        .iter()
        .filter(|c| c.get("owner").and_then(Value::as_str).is_some_and(|o| o.eq_ignore_ascii_case(principal)))
        .filter_map(|c| {
            let id = c.get("id").and_then(Value::as_str)?;
            let suspended = c.get("state").and_then(Value::as_str) == Some("suspended") || held(id);
            Some((id.to_owned(), suspended))
        })
        .collect()
}

/// What applying a record needs from the console.
pub trait PersonHost {
    /// The relay reported the org on its current connection.
    fn serves(&self, relay: &str, org: &str) -> bool;
    /// The org's serving pinned map (`map` object).
    fn pinned(&self, org: &str) -> Option<Value>;
    /// The clients an active `client_suspend` journal entry suspends.
    fn journal_suspended(&self, org: &str) -> Vec<String>;
    /// Journal `client_suspend` for `client` (flushed and sent to the org's relays).
    fn suspend(&self, org: &str, client: &str, now: i64) -> Result<(), String>;
    /// Append to the org's console chain, durable before Ok.
    fn audit(&self, org: &str, entry: Value, now: i64) -> Result<(), String>;
    /// Emit an event (never refuses).
    fn emit(&self, org: &str, kind: &str, data: Value, now: i64);
    /// Revision 5 4.2 (R5-3): journal `person_revoke {client: "*", principal}` for a deprovisioned person, ending
    /// their refresh families at once, when the org's pinned map has a delegated client and none is active yet.
    fn person_revoke(&self, _org: &str, _principal: &str, _now: i64) -> Result<(), String> {
        Ok(())
    }
}

/// The `directory.person` entry of an applied record.
pub fn audit_entry(p: &Person) -> Value {
    let mut e = json!({ "action": "directory.person", "result": "ok", "principal": p.principal, "state": p.record.state, "provider": p.record.provider });
    e[SOURCE_FIELD] = json!(p.record.source);
    e
}

/// 2.5, 6.7: apply one `api-person` from `relay` at `now` (seconds). Ok is `{ok, applied, suspended}`; a refusal leaves
/// the relay's outbox entry in place (it sends it again).
pub fn apply(dir: &Path, host: &dyn PersonHost, relay: &str, body: &Value, now: i64) -> Result<Value, Refusal> {
    let p = parse(body)?;
    if !host.serves(relay, &p.org) {
        return Err(Refusal::new(403, "org-not-served", "This relay did not report that organization on this connection."));
    }
    let unavailable = |why: &str| Refusal::new(503, "people-unavailable", why);
    let path = file_of(dir, &p.org);
    let s = slot(&path);
    let decision = {
        let mut g = s.lock();
        let people = loaded(&mut g, &path).map_err(|e| unavailable(e.as_str()))?;
        let d = decide(people.get(&p.principal), &p.record);
        if d == Decision::Apply {
            // 9.4: in the chain first; a record that is not kept is answered 503 and sent again
            host.audit(&p.org, audit_entry(&p), now).map_err(|e| Refusal::new(503, "audit-unavailable", &e))?;
            let mut next = people.clone();
            next.insert(p.principal.clone(), p.record.clone());
            save(&path, &next).map_err(|e| unavailable(e.as_str()))?;
            *people = next;
        }
        d
    };
    if decision == Decision::Stale {
        return Ok(json!({ "ok": true, "applied": false, "suspended": [] }));
    }
    if decision == Decision::Apply {
        let kind = if p.record.deprovisioned() { "person.deprovisioned" } else { "person.reactivated" };
        host.emit(&p.org, kind, json!({ "principal": p.principal, "provider": p.record.provider, "source": p.record.source }), now);
    }
    let mut suspended = Vec::new();
    if p.record.deprovisioned() {
        // revision 5 4.2: a deprovisioned person delegates to no client any more
        host.person_revoke(&p.org, &p.principal, now).map_err(|e| Refusal::new(503, "journal-unavailable", &e))?;
        let map = host.pinned(&p.org);
        let held = host.journal_suspended(&p.org);
        for (client, already) in owned_clients(map.as_ref(), &p.principal, &|c| held.iter().any(|h| h == c)) {
            if already {
                continue;
            }
            host.suspend(&p.org, &client, now).map_err(|e| Refusal::new(503, "journal-unavailable", &e))?;
            suspended.push(client);
        }
    }
    Ok(json!({ "ok": true, "applied": decision == Decision::Apply, "suspended": suspended }))
}

struct FleetHost<'a> {
    fleet: &'a crate::console_fleet::Fleet,
}

impl PersonHost for FleetHost<'_> {
    fn serves(&self, relay: &str, org: &str) -> bool {
        self.fleet.api.serves_now(relay, org)
    }
    fn pinned(&self, org: &str) -> Option<Value> {
        self.fleet.api.pinned(org).0
    }
    fn journal_suspended(&self, org: &str) -> Vec<String> {
        journal_suspended(self.fleet, org)
    }
    fn suspend(&self, org: &str, client: &str, now: i64) -> Result<(), String> {
        self.fleet.api.append(self.fleet.api_link(), org, "client_suspend", json!(client), None, now).map(|_| ()).map_err(|e| e.message)
    }
    fn audit(&self, org: &str, entry: Value, now: i64) -> Result<(), String> {
        self.fleet.api_audit().record(org, entry, now).map(|_| ()).map_err(|e| e.message)
    }
    fn emit(&self, org: &str, kind: &str, data: Value, now: i64) {
        // revision 4 7: an event never refuses the call (a failure is a security line written by the events module)
        let _ = self.fleet.api.emit_event(org, kind, data, now);
    }
    fn person_revoke(&self, org: &str, principal: &str, now: i64) -> Result<(), String> {
        let delegated = self.pinned(org).and_then(|m| m.get("clients").cloned()).and_then(|c| c.as_array().cloned()).unwrap_or_default().iter().any(|c| c.get("kind").and_then(Value::as_str) == Some("agent_delegated"));
        if !delegated || crate::api_delegated::person_revoked_now(org, "*", principal) {
            return Ok(());
        }
        self.fleet.api.person_revoke(org, "*", principal, now).map(|_| ()).map_err(|e| e.message)
    }
}

fn journal_suspended(fleet: &crate::console_fleet::Fleet, org: &str) -> Vec<String> {
    fleet.api.journal_active(org).into_iter().filter(|e| e.action == "client_suspend").filter_map(|e| e.target.as_str().map(str::to_owned)).collect()
}

/// The fleet port's `api-person` handler (blocking: fsyncs).
pub fn person_in(fleet: &crate::console_fleet::Fleet, relay: &str, body: &Value, now: i64) -> Result<Value, Refusal> {
    apply(&fleet.state_dir, &FleetHost { fleet }, relay, body, now)
}

/// `ApiOwnerGone`: per org, each deprovisioned principal whose clients the pinned map still lists, with those ids.
pub fn owner_gone(fleet: &crate::console_fleet::Fleet) -> Vec<(String, String, Vec<String>)> {
    let mut out = Vec::new();
    for org in fleet.api.known_orgs() {
        let Ok(people) = records(&fleet.state_dir, &org) else { continue };
        if !people.values().any(Record::deprovisioned) {
            continue;
        }
        let map = fleet.api.pinned(&org).0;
        out.extend(gone_in(&org, map.as_ref(), &people));
    }
    out
}

fn gone_in(org: &str, map: Option<&Value>, people: &OrgPeople) -> Vec<(String, String, Vec<String>)> {
    people
        .iter()
        .filter(|(_, r)| r.deprovisioned())
        .filter_map(|(p, _)| {
            let ids: Vec<String> = owned_clients(map, p, &|_| false).into_iter().map(|(id, _)| id).collect();
            (!ids.is_empty()).then(|| (org.to_owned(), p.clone(), ids))
        })
        .collect()
}

// ── `GET directory/status` (13.1) ──

#[derive(Default)]
struct Tally {
    last: Option<i64>,
    ok: u64,
    refused: u64,
    ops: BTreeMap<String, (u64, u64)>,
    refusals: BTreeMap<String, u64>,
}

impl Tally {
    fn add(&mut self, e: &Value, n: u64, refused: bool) {
        if let Some(ts) = e.get("ts").and_then(Value::as_i64) {
            self.last = Some(self.last.map_or(ts, |l| l.max(ts)));
        }
        let op = e.get("op").and_then(Value::as_str).filter(|o| matches!(*o, "create" | "read" | "update" | "delete"));
        if refused {
            self.refused += n;
            let check = e.get("check").or_else(|| e.get("code")).and_then(Value::as_str).unwrap_or("unknown");
            *self.refusals.entry(check.to_owned()).or_default() += n;
        } else {
            self.ok += n;
        }
        if let Some(op) = op {
            let c = self.ops.entry(op.to_owned()).or_default();
            if refused {
                c.1 += n;
            } else {
                c.0 += n;
            }
        }
    }

    fn to_value(&self) -> Value {
        let ops: Map<String, Value> = self.ops.iter().map(|(k, (ok, refused))| (k.clone(), json!({ "ok": ok, "refused": refused }))).collect();
        json!({ "last_request": self.last, "ok": self.ok, "refused": self.refused, "ops": ops, "refusals": self.refusals })
    }
}

fn scopes_of(c: &Value) -> Vec<String> {
    c.get("scopes").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect()
}

/// 13.1 `directory/status` from what the console holds: the pinned map (`map` object), the journal's suspensions,
/// the `scim` entries of the relays' chains (relay, entry) and the org's person records; and from what the SSO
/// services reported through the connected relays (`sso`, `api_sso_status`): legacy token dates and `pre_r4d3`, and
/// the pending group confirmations, at `now` (seconds). Without any report those three stay `not_reported`.
pub fn status_of(org: &str, map: Option<&Value>, held: &dyn Fn(&str) -> bool, entries: &[(String, Value)], people: &OrgPeople, sso: &crate::api_sso_status::Collected, now: i64) -> Value {
    let clients: Vec<&Value> = map.and_then(|m| m.get("clients")).and_then(Value::as_array).map(|a| a.iter().collect()).unwrap_or_default();
    let governed = clients.iter().any(|c| scopes_of(c).iter().any(|s| s == "directory.write"));
    let mut by_client: BTreeMap<String, Tally> = BTreeMap::new();
    let mut by_token: BTreeMap<String, Tally> = BTreeMap::new();
    let mut unattributed = Tally::default();
    for (_, e) in entries.iter().filter(|(_, e)| e.get("route").and_then(Value::as_str) == Some(SCIM_ROUTE)) {
        let action = e.get("action").and_then(Value::as_str).unwrap_or_default();
        let summary = action == "api.refusal.summary";
        let n = if summary { e.get("count").and_then(Value::as_u64).unwrap_or(1) } else { 1 };
        let refused = summary || action == "api.refusal" || e.get("result").and_then(Value::as_str) == Some("refused");
        if e.get("auth").and_then(Value::as_str) == Some("legacy") {
            let token = e.get("token_id").and_then(Value::as_str).unwrap_or("unknown");
            by_token.entry(token.to_owned()).or_default().add(e, n, refused);
        } else if let Some(c) = e.get("client").and_then(Value::as_str) {
            by_client.entry(c.to_owned()).or_default().add(e, n, refused);
        } else {
            unattributed.add(e, n, refused);
        }
    }
    let none = Tally::default();
    let scim_clients: Vec<Value> = clients
        .iter()
        .filter(|c| c.get("directory").is_some())
        .map(|c| {
            let id = c.get("id").and_then(Value::as_str).unwrap_or_default();
            let d = &c["directory"];
            let suspended = c.get("state").and_then(Value::as_str) == Some("suspended") || held(id);
            json!({
                "id": id, "name": c.get("name"), "owner": c.get("owner"), "state": if suspended { "suspended" } else { "active" },
                "scopes": scopes_of(c), "provider": d.get("provider"), "resource": d.get("resource"), "domains": d.get("domains"),
                "requests": by_client.get(id).unwrap_or(&none).to_value(),
            })
        })
        .collect();
    // the SSO services' reports, the newest per provider: token dates and the pending confirmations
    let reports = crate::api_sso_status::newest(&sso.reports);
    let mut tokens: Vec<Value> = Vec::new();
    let mut pending: Vec<Value> = Vec::new();
    let mut pending_count = 0u64;
    let mut reported: Vec<Value> = Vec::new();
    for (relay, r) in &reports {
        let provider = r.get("provider").cloned().unwrap_or(Value::Null);
        let count = r.get("pending_count").and_then(Value::as_u64).unwrap_or(0);
        pending_count += count;
        reported.push(json!({ "provider": provider, "relay": relay, "at": r.get("at"), "pending_count": count }));
        for p in r.get("pending").and_then(Value::as_array).into_iter().flatten() {
            let mut row = p.clone();
            row["provider"] = provider.clone();
            pending.push(row);
        }
        for t in r.get("tokens").and_then(Value::as_array).into_iter().flatten() {
            let expires = t.get("expires").and_then(Value::as_i64).unwrap_or(0);
            let mut row = none.to_value();
            row["token_id"] = t["id"].clone();
            for k in ["hint", "issued", "expires", "pre_r4d3", "no_address_list"] {
                row[k] = t[k].clone();
            }
            row["provider"] = provider.clone();
            // 6.1.1: the warning with the date from 14 days before the end
            row["ending"] = json!(now >= expires - crate::api_sso_status::ENDING_S);
            tokens.push(row);
        }
    }
    pending.sort_by(|a, b| (a["since"].as_i64(), a["principal"].as_str(), a["group"].as_str()).cmp(&(b["since"].as_i64(), b["principal"].as_str(), b["group"].as_str())));
    // the relays' ledger counts of a token id go on its reported entry that ends last, or on a row of their own
    for (t, tally) in &by_token {
        let at = tokens.iter().enumerate().filter(|(_, r)| r["token_id"] == json!(t)).max_by_key(|(_, r)| r["expires"].as_i64()).map(|(i, _)| i);
        let counts = tally.to_value();
        match at {
            Some(i) => {
                for (k, v) in counts.as_object().into_iter().flatten() {
                    tokens[i][k] = v.clone();
                }
            }
            None => {
                let mut v = counts;
                v["token_id"] = json!(t);
                tokens.push(v);
            }
        }
    }
    let not_reported: Vec<&str> = if reports.is_empty() { vec!["legacy_token_dates", "pre_r4d3", "pending_group_confirmations"] } else { Vec::new() };
    let person_rows: Vec<Value> = people
        .iter()
        .map(|(p, r)| {
            let mut v = r.to_value();
            v["principal"] = json!(p);
            v
        })
        .collect();
    json!({
        "org": org,
        "mode": if governed { "governed" } else { "legacy" },
        "governed": governed,
        "clients": scim_clients,
        "unattributed": unattributed.to_value(),
        "legacy": { "tokens": tokens },
        "pending": pending,
        "pending_count": pending_count,
        "people": person_rows,
        // who reported (`api_sso_status`), and the connected relays that did not answer
        "sso": reported,
        "sso_unanswered": sso.unanswered,
        "not_reported": not_reported,
    })
}

/// The `scim` entries of every relay chain of the org the console holds (the newest `SCAN_MAX` of each).
fn relay_scim_entries(fleet: &crate::console_fleet::Fleet, org: &str) -> Vec<(String, Value)> {
    use crate::api_audit::Repr;
    let audit = fleet.api_audit();
    let root = fleet.state_dir.join(crate::api_audit::AUDIT_DIR).join(org);
    let relays: Vec<String> = std::fs::read_dir(&root)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|d| d.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|d| d.file_name().into_string().ok())
        .filter(|s| s != "console" && crate::api_audit::source_ok(s))
        .collect();
    let mut out = Vec::new();
    for relay in relays {
        let mut after = audit.head(org, &relay, Repr::AsIs).0.saturating_sub(SCAN_MAX);
        loop {
            let Ok(page) = audit.read(org, &relay, Repr::AsIs, after, PAGE) else { break };
            let list = page.get("entries").and_then(Value::as_array).cloned().unwrap_or_default();
            let Some(last) = list.last().and_then(|e| e.get("seq")).and_then(Value::as_u64) else { break };
            out.extend(list.into_iter().filter(|e| e.get("route").and_then(Value::as_str) == Some(SCIM_ROUTE)).map(|e| (relay.clone(), e)));
            if last <= after {
                break;
            }
            after = last;
        }
    }
    out
}

/// `GET /console/api/directory/status?org=` (Viewer).
pub fn directory_status(fleet: &crate::console_fleet::Fleet, query: &[(String, String)]) -> Result<Value, ApiError> {
    if let Some((k, _)) = query.iter().find(|(k, _)| k != "org") {
        return Err(ApiError::with("invalid", format!("Unknown filter: {k}.")));
    }
    let org = query.iter().find(|(k, _)| k == "org").map(|(_, v)| v.as_str()).filter(|o| crate::api_audit::org_ok(o)).ok_or_else(|| ApiError::with("invalid", "org is an organization id."))?;
    let people = records(&fleet.state_dir, org).map_err(|_| ApiError::of("state-unreadable"))?;
    let map = fleet.api.pinned(org).0;
    let held = journal_suspended(fleet, org);
    let entries = relay_scim_entries(fleet, org);
    let now = crate::meet_json::now() as i64;
    let sso = crate::api_sso_status::collect(fleet, org, now);
    Ok(status_of(org, map.as_ref(), &|c| held.iter().any(|h| h == c), &entries, &people, &sso, now))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fleet_wire::{parse_frame, req_text, Frame, Side};
    use std::cell::RefCell;

    const ORG: &str = "acme";
    const ANN: &str = "ann@acme.example";

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("lucid-api-people-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn body(state: &str, at: i64) -> Value {
        json!({ "org": ORG, "principal": ANN, "state": state, "at": at, "provider": "entra", "source": "scim" })
    }

    fn rec(state: &str, at: i64) -> Record {
        Record { state: state.into(), at, provider: "entra".into(), source: "scim".into() }
    }

    fn map() -> Value {
        json!({ "clients": [
            { "id": "c_1", "owner": ANN, "state": "active", "scopes": ["directory.write"],
              "directory": { "provider": "entra", "resource": "https://sso.acme.example:8443/api/orgs/acme/scim/v2", "domains": ["acme.example"] } },
            { "id": "c_2", "owner": ANN, "state": "active", "scopes": ["audit.read"] },
            { "id": "c_3", "owner": "bob@acme.example", "state": "active", "scopes": ["audit.read"] },
            { "id": "c_4", "owner": ANN, "state": "suspended", "scopes": ["audit.read"] },
            { "id": "c_5", "owner": ANN, "state": "active", "scopes": ["monitor.read"] },
        ] })
    }

    struct Fake {
        dir: PathBuf,
        serves: bool,
        audit_ok: bool,
        held: Vec<String>,
        suspended: RefCell<Vec<String>>,
        audits: RefCell<Vec<Value>>,
        events: RefCell<Vec<(String, Value)>>,
        file_seen_at_suspend: RefCell<Vec<bool>>,
    }

    impl Fake {
        fn new(dir: &Path) -> Fake {
            Fake {
                dir: dir.to_path_buf(),
                serves: true,
                audit_ok: true,
                held: vec!["c_5".into()],
                suspended: RefCell::default(),
                audits: RefCell::default(),
                events: RefCell::default(),
                file_seen_at_suspend: RefCell::default(),
            }
        }
    }

    impl PersonHost for Fake {
        fn serves(&self, _relay: &str, _org: &str) -> bool {
            self.serves
        }
        fn pinned(&self, _org: &str) -> Option<Value> {
            Some(map())
        }
        fn journal_suspended(&self, _org: &str) -> Vec<String> {
            self.held.clone()
        }
        fn suspend(&self, _org: &str, client: &str, _now: i64) -> Result<(), String> {
            self.file_seen_at_suspend.borrow_mut().push(file_of(&self.dir, ORG).is_file());
            self.suspended.borrow_mut().push(client.to_owned());
            Ok(())
        }
        fn audit(&self, _org: &str, entry: Value, _now: i64) -> Result<(), String> {
            if !self.audit_ok {
                return Err("the audit volume is full".into());
            }
            self.audits.borrow_mut().push(entry);
            Ok(())
        }
        fn emit(&self, _org: &str, kind: &str, data: Value, _now: i64) {
            self.events.borrow_mut().push((kind.to_owned(), data));
        }
    }

    #[test]
    fn later_at_wins_and_equal_at_goes_to_deprovisioned() {
        let dep = |at| rec(DEPROVISIONED, at);
        let act = |at| rec(ACTIVE, at);
        assert_eq!(decide(None, &act(1)), Decision::Apply);
        assert_eq!(decide(Some(&dep(10)), &act(20)), Decision::Apply, "newer wins");
        assert_eq!(decide(Some(&act(10)), &dep(20)), Decision::Apply);
        assert_eq!(decide(Some(&act(10)), &dep(10)), Decision::Apply, "equal at: deprovisioned wins");
        assert_eq!(decide(Some(&dep(10)), &act(10)), Decision::Stale, "equal at: active never wins");
        assert_eq!(decide(Some(&dep(10)), &dep(10)), Decision::Repeat);
        assert_eq!(decide(Some(&dep(20)), &act(10)), Decision::Stale, "R4-13");
        assert_eq!(decide(Some(&act(20)), &act(20)), Decision::Stale);
    }

    #[test]
    fn deprovisioning_suspends_each_owned_client_after_the_file_is_written() {
        let dir = scratch("suspend");
        let host = Fake::new(&dir);
        let a = apply(&dir, &host, "r_1", &body(DEPROVISIONED, 100), 200).unwrap();
        assert_eq!(a, json!({ "ok": true, "applied": true, "suspended": ["c_1", "c_2"] }));
        // c_3 is bob's, c_4 is suspended in the map, c_5 by the journal: nothing for them
        assert_eq!(*host.suspended.borrow(), ["c_1", "c_2"]);
        assert!(host.file_seen_at_suspend.borrow().iter().all(|seen| *seen), "fsynced before the journal");
        assert!(file_of(&dir, ORG).is_file());
        assert_eq!(records(&dir, ORG).unwrap().get(ANN), Some(&rec(DEPROVISIONED, 100)));
        // the audit entry, then the event
        let audits = host.audits.borrow();
        assert_eq!(audits.len(), 1);
        assert_eq!(audits[0]["action"], "directory.person");
        assert_eq!((audits[0]["principal"].as_str(), audits[0]["state"].as_str(), audits[0]["provider"].as_str(), audits[0][SOURCE_FIELD].as_str()), (Some(ANN), Some(DEPROVISIONED), Some("entra"), Some("scim")));
        assert_eq!(*host.events.borrow(), [("person.deprovisioned".to_owned(), json!({ "principal": ANN, "provider": "entra", "source": "scim" }))]);
        // the file reads back after a restart of the cache
        FILES.lock().remove(&file_of(&dir, ORG));
        assert!(deprovisioned(&dir, ORG, ANN));
        assert!(!deprovisioned(&dir, ORG, "bob@acme.example"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_older_active_after_a_newer_deprovisioned_is_ignored() {
        let dir = scratch("r4-13");
        let host = Fake::new(&dir);
        apply(&dir, &host, "r_1", &body(DEPROVISIONED, 100), 200).unwrap();
        let a = apply(&dir, &host, "r_2", &body(ACTIVE, 90), 201).unwrap();
        assert_eq!(a, json!({ "ok": true, "applied": false, "suspended": [] }));
        assert_eq!(records(&dir, ORG).unwrap().get(ANN), Some(&rec(DEPROVISIONED, 100)));
        assert!(deprovisioned(&dir, ORG, ANN));
        assert_eq!(host.audits.borrow().len(), 1, "a stale record is not audited");
        // equal at: active does not win either
        apply(&dir, &host, "r_2", &body(ACTIVE, 100), 202).unwrap();
        assert!(deprovisioned(&dir, ORG, ANN));
        // a newer active is stored and announced; nothing is cleared
        let a = apply(&dir, &host, "r_2", &body(ACTIVE, 110), 203).unwrap();
        assert_eq!(a["applied"], true);
        assert!(!deprovisioned(&dir, ORG, ANN));
        assert_eq!(host.events.borrow().last().unwrap().0, "person.reactivated");
        assert_eq!(host.suspended.borrow().len(), 2, "active suspends and clears nothing");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_repeated_record_runs_only_the_suspensions_again() {
        let dir = scratch("repeat");
        let host = Fake::new(&dir);
        apply(&dir, &host, "r_1", &body(DEPROVISIONED, 100), 200).unwrap();
        let again = apply(&dir, &host, "r_2", &body(DEPROVISIONED, 100), 201).unwrap();
        assert_eq!(again["applied"], false);
        assert_eq!(host.audits.borrow().len(), 1);
        assert_eq!(host.events.borrow().len(), 1);
        assert_eq!(host.suspended.borrow().len(), 4, "the fake journal does not hold them, so they go again");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn refusals_keep_nothing() {
        let dir = scratch("refused");
        let mut host = Fake::new(&dir);
        host.audit_ok = false;
        let e = apply(&dir, &host, "r_1", &body(DEPROVISIONED, 100), 200).unwrap_err();
        assert_eq!((e.status, e.code.as_str()), (503, "audit-unavailable"));
        assert!(!file_of(&dir, ORG).exists());
        assert!(host.suspended.borrow().is_empty() && host.events.borrow().is_empty());
        host.audit_ok = true;
        host.serves = false;
        assert_eq!(apply(&dir, &host, "r_1", &body(DEPROVISIONED, 100), 200).unwrap_err().code, "org-not-served");
        host.serves = true;
        for bad in [
            json!({ "org": ORG, "principal": "Ann@Acme.example", "state": DEPROVISIONED, "at": 1, "provider": "entra", "source": "scim" }),
            json!({ "org": ORG, "principal": ANN, "state": "gone", "at": 1, "provider": "entra", "source": "scim" }),
            json!({ "org": ORG, "principal": ANN, "state": ACTIVE, "at": -1, "provider": "entra", "source": "scim" }),
            json!({ "org": ORG, "principal": ANN, "state": ACTIVE, "at": 1, "provider": "", "source": "scim" }),
            json!({ "org": ORG, "principal": ANN, "state": ACTIVE, "at": 1, "provider": "entra", "source": "ldap" }),
            json!({ "org": "../x", "principal": ANN, "state": ACTIVE, "at": 1, "provider": "entra", "source": "scim" }),
        ] {
            assert_eq!(apply(&dir, &host, "r_1", &bad, 200).unwrap_err().code, "invalid", "{bad}");
        }
        assert!(!file_of(&dir, ORG).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    struct PeopleFake {
        dir: PathBuf,
    }

    impl crate::fleet_people::PeopleHost for PeopleFake {
        fn relays(&self) -> Vec<crate::fleet_people::RelayView> {
            Vec::new()
        }
        fn rights_now(&self, _session: &str) -> Option<crate::fleet_people::Rights> {
            None
        }
        fn call<'a>(&'a self, _relay: &'a str, _body: Value) -> crate::fleet_people::BoxFut<'a, Result<Value, ApiError>> {
            Box::pin(async { Err(ApiError::of("invalid")) })
        }
        fn people_op<'a>(&'a self, _relay: &'a str, _body: Value) -> crate::fleet_people::BoxFut<'a, Result<Value, ApiError>> {
            Box::pin(async { Err(ApiError::of("invalid")) })
        }
        fn console_rows(&self) -> Vec<Value> {
            Vec::new()
        }
        fn console_exists(&self, _email: &str) -> bool {
            false
        }
        fn console_invite(&self, _asker: &crate::fleet_people::Asker, _email: &str, _role: &str, _t: i64) -> Result<(), ApiError> {
            Err(ApiError::of("invalid"))
        }
        fn console_emails(&self) -> std::collections::HashSet<String> {
            Default::default()
        }
        fn mail_on(&self) -> bool {
            false
        }
        fn api_deprovisioned(&self, org: &str, principal: &str) -> bool {
            deprovisioned(&self.dir, org, principal)
        }
    }

    #[test]
    fn the_owner_rule_reads_the_deprovisioned_record() {
        let dir = scratch("owner-rule");
        let people = crate::fleet_people::People::new(Arc::new(PeopleFake { dir: dir.clone() }));
        assert!(!people.person_inactive(ORG, ANN));
        apply(&dir, &Fake::new(&dir), "r_1", &body(DEPROVISIONED, 100), 200).unwrap();
        assert!(people.person_inactive(ORG, ANN));
        assert!(people.person_inactive(ORG, " Ann@acme.example "));
        assert!(!people.person_inactive(ORG, "bob@acme.example"));
        assert!(!people.person_inactive("other", ANN));
        // a file that does not read back refuses the owner
        std::fs::write(file_of(&dir, ORG), b"{").unwrap();
        FILES.lock().remove(&file_of(&dir, ORG));
        assert!(people.person_inactive(ORG, "bob@acme.example"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn owner_gone_lists_the_clients_a_deprovisioned_owner_still_holds() {
        let mut people = OrgPeople::new();
        people.insert(ANN.into(), rec(DEPROVISIONED, 1));
        people.insert("bob@acme.example".into(), rec(ACTIVE, 1));
        people.insert("cy@acme.example".into(), rec(DEPROVISIONED, 1));
        let m = map();
        assert_eq!(gone_in(ORG, Some(&m), &people), [(ORG.to_owned(), ANN.to_owned(), vec!["c_1".to_owned(), "c_2".into(), "c_4".into(), "c_5".into()])]);
        assert!(gone_in(ORG, None, &people).is_empty());
    }

    #[test]
    fn directory_status_has_its_shape() {
        let m = map();
        let mut people = OrgPeople::new();
        people.insert(ANN.into(), rec(DEPROVISIONED, 100));
        let e = |v: Value| ("r_1".to_owned(), v);
        let entries = [
            e(json!({ "seq": 1, "ts": 10, "action": "api.call", "route": "scim", "op": "create", "result": "ok", "client": "c_1", "status": 200 })),
            e(json!({ "seq": 2, "ts": 30, "action": "api.call", "route": "scim", "op": "read", "result": "ok", "client": "c_1", "status": 200 })),
            e(json!({ "seq": 3, "ts": 20, "action": "api.refusal", "route": "scim", "op": "delete", "result": "refused", "check": "scope", "client": "c_1" })),
            e(json!({ "seq": 4, "ts": 40, "action": "api.refusal.summary", "route": "scim", "result": "refused", "check": "client-auth", "count": 7 })),
            e(json!({ "seq": 5, "ts": 50, "action": "api.call", "route": "scim", "op": "update", "auth": "legacy", "token_id": "tok-1", "result": "ok", "status": 200 })),
            e(json!({ "seq": 6, "ts": 60, "action": "api.call", "route": "scim", "op": "update", "auth": "legacy", "token_id": "tok-1", "result": "refused", "status": 403, "check": "scim-governed" })),
            e(json!({ "seq": 7, "ts": 70, "action": "api.call", "route": "GET /v1/audit", "result": "ok", "client": "c_1" })),
        ];
        let none = crate::api_sso_status::Collected::default();
        let s = status_of(ORG, Some(&m), &|c| c == "c_5", &entries, &people, &none, 100);
        assert_eq!(s["mode"], "governed");
        assert_eq!(s["governed"], true);
        let clients = s["clients"].as_array().unwrap();
        assert_eq!(clients.len(), 1, "only clients with a directory block");
        let c = &clients[0];
        assert_eq!((c["id"].as_str(), c["state"].as_str(), c["provider"].as_str()), (Some("c_1"), Some("active"), Some("entra")));
        assert_eq!(c["requests"], json!({ "last_request": 30, "ok": 2, "refused": 1,
            "ops": { "create": { "ok": 1, "refused": 0 }, "delete": { "ok": 0, "refused": 1 }, "read": { "ok": 1, "refused": 0 } },
            "refusals": { "scope": 1 } }));
        assert_eq!(s["unattributed"]["refused"], 7);
        assert_eq!(s["unattributed"]["refusals"], json!({ "client-auth": 7 }));
        assert_eq!(s["legacy"]["tokens"], json!([{ "token_id": "tok-1", "last_request": 60, "ok": 1, "refused": 1,
            "ops": { "update": { "ok": 1, "refused": 1 } }, "refusals": { "scim-governed": 1 } }]));
        assert_eq!(s["people"], json!([{ "principal": ANN, "state": DEPROVISIONED, "at": 100, "provider": "entra", "source": "scim" }]));
        assert_eq!(s["not_reported"], json!(["legacy_token_dates", "pre_r4d3", "pending_group_confirmations"]), "no SSO report reached the console");
        assert_eq!((s["pending"].clone(), s["pending_count"].clone(), s["sso"].clone()), (json!([]), json!(0), json!([])));
        // no client with directory.write: legacy
        let legacy = status_of(ORG, Some(&json!({ "clients": [] })), &|_| false, &[], &OrgPeople::new(), &none, 100);
        assert_eq!((legacy["mode"].as_str(), legacy["governed"].as_bool()), (Some("legacy"), Some(false)));
        assert_eq!(status_of(ORG, None, &|_| false, &[], &OrgPeople::new(), &none, 100)["mode"], "legacy");
    }

    #[test]
    fn directory_status_fills_token_dates_and_pending_confirmations_from_sso_reports() {
        const NOW: i64 = 1_763_000_000;
        let e = |v: Value| ("r_1".to_owned(), v);
        let entries = [
            e(json!({ "seq": 1, "ts": 50, "action": "api.call", "route": "scim", "op": "update", "auth": "legacy", "token_id": "okta", "result": "ok", "status": 200 })),
            e(json!({ "seq": 2, "ts": 60, "action": "api.call", "route": "scim", "op": "read", "auth": "legacy", "token_id": "gone", "result": "ok", "status": 200 })),
        ];
        let report = |provider: &str, at: i64, tokens: Value, pending: Value, count: u64| {
            json!({ "provider": provider, "at": at, "tokens": tokens, "pending": pending, "pending_count": count })
        };
        let okta_old = report("okta", NOW - 100, json!([]), json!([]), 0);
        let okta = report(
            "okta",
            NOW - 10,
            json!([
                { "id": "okta", "hint": "3f2a9c1d", "issued": 0, "expires": NOW + 86_400, "pre_r4d3": true, "no_address_list": true },
                { "id": "okta", "hint": "0b1c2d3e", "issued": NOW - 60, "expires": NOW + 60 * 86_400, "pre_r4d3": false, "no_address_list": false },
            ]),
            json!([]),
            0,
        );
        let entra = report("entra", NOW - 5, json!([]), json!([
            { "principal": "cy@acme.example", "group": "g-eng", "group_name": "Engineering", "since": NOW - 50 },
            { "principal": "bob@acme.example", "group": "g-ops", "group_name": "", "since": NOW - 400 },
        ]), 250);
        let sso = crate::api_sso_status::Collected {
            reports: vec![("r_2".into(), okta_old), ("r_1".into(), okta), ("r_1".into(), entra)],
            unanswered: vec!["r_3".into()],
        };
        let s = status_of(ORG, Some(&map()), &|_| false, &entries, &OrgPeople::new(), &sso, NOW);
        assert_eq!(s["not_reported"], json!([]));
        assert_eq!(s["sso_unanswered"], json!(["r_3"]));
        assert_eq!(s["sso"], json!([
            { "provider": "entra", "relay": "r_1", "at": NOW - 5, "pending_count": 250 },
            { "provider": "okta", "relay": "r_1", "at": NOW - 10, "pending_count": 0 },
        ]), "the newest report per provider");
        let tokens = s["legacy"]["tokens"].as_array().unwrap();
        assert_eq!(tokens.len(), 3, "two reported entries and a ledger-only token id");
        let (recorded, renewed, gone) = (&tokens[0], &tokens[1], &tokens[2]);
        assert_eq!((recorded["token_id"].as_str(), recorded["hint"].as_str(), recorded["provider"].as_str()), (Some("okta"), Some("3f2a9c1d"), Some("okta")));
        assert_eq!((recorded["pre_r4d3"].as_bool(), recorded["no_address_list"].as_bool(), recorded["ending"].as_bool()), (Some(true), Some(true), Some(true)));
        assert_eq!(recorded["expires"], NOW + 86_400);
        assert_eq!(recorded["ok"], 0, "the counts go on the entry that ends last");
        assert_eq!((renewed["hint"].as_str(), renewed["ending"].as_bool(), renewed["ok"].as_u64(), renewed["last_request"].as_i64()), (Some("0b1c2d3e"), Some(false), Some(1), Some(50)));
        assert_eq!((gone["token_id"].as_str(), gone["ok"].as_u64(), gone.get("expires")), (Some("gone"), Some(1), None));
        assert_eq!(s["pending"], json!([
            { "principal": "bob@acme.example", "group": "g-ops", "group_name": "", "since": NOW - 400, "provider": "entra" },
            { "principal": "cy@acme.example", "group": "g-eng", "group_name": "Engineering", "since": NOW - 50, "provider": "entra" },
        ]));
        assert_eq!(s["pending_count"], 250, "the count covers rows the report could not list");
        let text = s.to_string();
        assert!(!text.contains("sha256") && !text.contains("ip_allow"), "no token hash or address reaches the console view");
    }

    #[test]
    fn the_api_person_op_goes_relay_to_console_within_1_kib() {
        let ok = body(DEPROVISIONED, 100);
        assert!(matches!(parse_frame(&req_text(1, "api-person", ok.clone()), Side::Console), Ok(Frame::Req { op: "api-person", .. })));
        assert_eq!(parse_frame(&req_text(1, "api-person", ok.clone()), Side::Relay).err().unwrap().why, "op", "the wrong side refuses it");
        let mut missing = ok.clone();
        missing.as_object_mut().unwrap().remove("source");
        assert_eq!(parse_frame(&req_text(1, "api-person", missing), Side::Console).err().unwrap().why, "body");
        let mut extra = ok.clone();
        extra["reason"] = json!("x");
        assert_eq!(parse_frame(&req_text(1, "api-person", extra), Side::Console).err().unwrap().why, "body");
        let mut big = ok;
        big["provider"] = json!("p".repeat(1024));
        assert_eq!(parse_frame(&req_text(1, "api-person", big), Side::Console).err().unwrap().why, "size");
        assert_eq!(crate::fleet_wire::op_frame_max("api-person"), Some(1024));
    }
}
