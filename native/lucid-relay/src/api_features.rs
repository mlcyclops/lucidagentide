// Contract API-1 revision 4 (docs/api/contract-r4-1b.md) 2.3, the cross-revision feature gate: the relay's
// `api-features` answer, the console's persisted relay set per org (`<state>/api-org-relays/<org>.json`, flushed
// before it is relied on), and the gate a stage, a save and every send checks: a feature (a map version, a map field,
// a fleet request or a journal action) is open for an org only while every relay of its set last reported it. A relay
// leaves a set only when an admin retires it from the org, never because it is offline or silent.
//
// The relay-relevant journal of revision 3 is gated here too: an entry whose target only a revision 4 relay reads (a
// revision 4 scope, the `entra_wif` credential type, the `events` signal) is journaled only while version 2 is open
// for the org, and as its revision 3 fallback (`client_suspend` or `destination_suspend`) while it is closed, so no
// relay ever stalls on an entry it cannot read.

use crate::api_map::{self, ApiMapError};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// The console's name for "the relay reports map version 2" (`api-features` `map` lists 2).
pub const MAP_V2: &str = "map-v2";
/// Revision 4 2.3 item 1: the feature names of revision 4. A relay reports a name once the slice that implements it
/// has landed (`RELAY_FEATURES`).
pub const COMPLIANCE: &str = "compliance";
pub const EVENTS: &str = "events";
pub const SCIM_CHECK: &str = "scim-check";
pub const ARCHIVE: &str = "archive";
/// Revision 5 3.3: the map shape names (a relay that reports them accepts and pins such a map; nothing it serves
/// changes) and `journal-1c`, which only connectors report (they apply the console journal actions of 4.2). Gating a
/// map on its org's connectors reporting these is slice 1c4's (the connector sync acknowledgment).
pub const CONNECTORS: &str = "connectors";
pub const IDPS: &str = "idps";
pub const CONTENT_CLIENTS: &str = "content-clients";
pub const DELEGATED: &str = "delegated";
pub const JOURNAL_1C: &str = "journal-1c";
/// Revision 6 2.4: `spokes` (map key `spokes`, kind `spokes_hub`, credential `spokes_node`, journal action
/// `client_drop_target`, ops `api-orgs` and `api-spokes`), `spokes-read` (scope `spokes.read`) and `a2a` (map key
/// `a2a`, client keys `a2a` and `card`, `spokes.tasks.submit` on a client other than spokes_hub; slice 1d5). A Meet
/// relay reports all three: it accepts the map keys and the journal action (which it has nothing to enforce with).
pub const SPOKES: &str = "spokes";
pub const SPOKES_READ: &str = "spokes-read";
pub const A2A: &str = "a2a";
/// Revision 8 3: `presence` (scopes `presence.read` and `presence.write`, ops `api-presence` and
/// `api-presence-write`, event `presence.changed`).
pub const PRESENCE: &str = "presence";
/// What this relay build reports in `features`. Each later slice adds its name here when its handlers land.
pub const RELAY_FEATURES: &[&str] = &[SCIM_CHECK, EVENTS, COMPLIANCE, ARCHIVE, CONNECTORS, IDPS, CONTENT_CLIENTS, DELEGATED, SPOKES, SPOKES_READ, A2A, PRESENCE];
/// The map versions this relay build takes.
pub const RELAY_MAP_VERSIONS: [u64; 2] = [1, 2];
/// The folder of the relay sets.
pub const SETS_DIR: &str = "api-org-relays";
/// The refusal of a stage, a save or a send the gate closes (409, revision 4 10).
pub const OUTDATED: &str = "relay-outdated";
const NAME_MAX: usize = 64;
const FEATURES_MAX: usize = 64;

/// The relay's `api-features` answer (2.3 item 1): `archive_orgs` the served orgs whose archive address it holds.
pub fn relay_answer(archive_orgs: Vec<String>) -> Value {
    json!({ "map": RELAY_MAP_VERSIONS, "features": RELAY_FEATURES, "archive_orgs": archive_orgs })
}

/// One relay's latest `api-features` answer as the console keeps it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Report {
    pub map: Vec<u64>,
    pub features: Vec<String>,
    pub archive_orgs: Vec<String>,
    /// When it was answered (seconds).
    pub at: i64,
}

impl Report {
    /// A relay that answered `api-features` with `fleet-op` (revision 3): map version 1 and no features.
    pub fn old(at: i64) -> Report {
        Report { map: vec![1], features: Vec::new(), archive_orgs: Vec::new(), at }
    }

    /// An answer as the relay sent it (None when it is not one).
    pub fn of_answer(v: &Value, at: i64) -> Option<Report> {
        let map: Vec<u64> = v.get("map")?.as_array()?.iter().map(Value::as_u64).collect::<Option<_>>()?;
        let words = |k: &str| -> Option<Vec<String>> {
            let a: &[Value] = match v.get(k) {
                None => &[],
                Some(x) => x.as_array()?.as_slice(),
            };
            (a.len() <= FEATURES_MAX).then(|| a.iter().filter_map(Value::as_str).filter(|s| (1..=NAME_MAX).contains(&s.len())).map(str::to_string).collect())
        };
        Some(Report { map, features: words("features")?, archive_orgs: words("archive_orgs")?, at })
    }

    fn of_json(v: &Value) -> Option<Report> {
        Report::of_answer(v, v.get("at")?.as_i64()?)
    }

    fn to_json(&self) -> Value {
        json!({ "map": self.map, "features": self.features, "archive_orgs": self.archive_orgs, "at": self.at })
    }

    /// Whether it reports a need: `map-v2` from `map`, any other name from `features`.
    pub fn has(&self, need: &str) -> bool {
        if need == MAP_V2 {
            self.map.contains(&2)
        } else {
            self.features.iter().any(|f| f == need)
        }
    }
}

/// Revision 4 2.3 item 5: what a map needs every relay of its org to report: version 2 for a version 2 map, and for a
/// version 1 map that names the revision 4 kind `compliance`, which a revision 3 relay refuses as a whole. Revision 5
/// 3.3 adds, in this order: `connectors` and `idps` for those keys, `content-clients` for a client of kind `app` or
/// `agent`, a `content.*` scope or the keys `connectors`, `apps`, `channels`, `confirm`, and `delegated` for a client
/// of kind `agent_delegated`, the keys `delegation`, `redirect_uris`, `loopback_ok` or a `cimd` credential. Revision 6
/// 2.4 then adds `spokes` for the map key `spokes`, a client of kind `spokes_hub`, a client key `spokes` or a
/// `spokes_node` credential, `spokes-read` for a client holding `spokes.read`, and `a2a` for the map key `a2a`, a
/// client key `a2a` or `card`, or `spokes.tasks.submit` on a client other than spokes_hub. Judged on presence, as
/// `version_needed`.
pub fn map_needs(map: &Value) -> Vec<&'static str> {
    let v2 = map.get("v").and_then(Value::as_i64) == Some(2) || api_map::version_needed(map) == 2;
    let clients: Vec<&Value> = map.get("clients").and_then(Value::as_array).into_iter().flatten().collect();
    let kind_of = |c: &Value| c.get("kind").and_then(Value::as_str).unwrap_or_default().to_string();
    let kind = clients.iter().any(|&c| kind_of(c) == "compliance");
    let mut out = if v2 || kind { vec![MAP_V2] } else { Vec::new() };
    let has_key = |c: &Value, keys: &[&str]| keys.iter().any(|k| c.get(*k).is_some());
    let content = clients.iter().any(|&c| {
        matches!(kind_of(c).as_str(), "app" | "agent")
            || c.get("scopes").and_then(Value::as_array).into_iter().flatten().any(|s| s.as_str().is_some_and(|s| s.starts_with("content.")))
            || has_key(c, &["connectors", "apps", "channels", "confirm"])
    });
    let delegated = clients.iter().any(|&c| {
        kind_of(c) == "agent_delegated"
            || has_key(c, &["delegation", "redirect_uris", "loopback_ok"])
            || c.get("credentials").and_then(Value::as_array).into_iter().flatten().any(|cr| cr.get("type").and_then(Value::as_str) == Some("cimd"))
    });
    // revision 6 2.4, after the revision 5 names
    let spokes = map.get("spokes").is_some()
        || clients.iter().any(|&c| {
            kind_of(c) == "spokes_hub"
                || has_key(c, &["spokes"])
                || c.get("credentials").and_then(Value::as_array).into_iter().flatten().any(|cr| cr.get("type").and_then(Value::as_str) == Some("spokes_node"))
        });
    let holds = |c: &Value, scope: &str| c.get("scopes").and_then(Value::as_array).into_iter().flatten().any(|s| s.as_str() == Some(scope));
    let spokes_read = clients.iter().any(|&c| holds(c, "spokes.read"));
    let a2a = map.get("a2a").is_some() || clients.iter().any(|&c| has_key(c, &["a2a", "card"]) || (kind_of(c) != "spokes_hub" && holds(c, "spokes.tasks.submit")));
    // revision 8 3: a client holding presence.read or presence.write
    let presence = clients.iter().any(|&c| holds(c, "presence.read") || holds(c, "presence.write"));
    for (on, name) in [
        (map.get("connectors").is_some(), CONNECTORS),
        (map.get("idps").is_some(), IDPS),
        (content, CONTENT_CLIENTS),
        (delegated, DELEGATED),
        (spokes, SPOKES),
        (spokes_read, SPOKES_READ),
        (a2a, A2A),
        (presence, PRESENCE),
    ] {
        if on {
            out.push(name);
        }
    }
    out
}

/// The scopes a revision 3 relay reads in a `client_drop_scope` target (what `api_map::SCOPES` held in revision 3).
/// Fixed here because `SCOPES` grows as revision 4 routes land; a drop of any other scope needs `map-v2`.
const R3_SCOPES: [&str; 4] = ["monitor.read", "fleet.read", "audit.read", "events.subscribe"];

/// Revision 4 2.3 item 4c for revision 3 actions with revision 4 targets: `(need, fallback action, fallback target)`
/// when the entry names a scope, credential type or signal only revision 4 relays read; None when every relay reads
/// it. Revision 6 2.3 (category 4c): `client_drop_target` needs `spokes`; a `client_drop_scope` of `spokes.read` needs
/// `spokes-read` and of `spokes.tasks.submit` needs `spokes`; a `client_drop_credential` of type `spokes_node` needs
/// `spokes`. Each falls back to `client_suspend` of the client.
pub fn relay_entry_gate(action: &str, target: &Value) -> Option<(&'static str, &'static str, Value)> {
    let field = |k: &str| target.get(k).and_then(Value::as_str).unwrap_or_default();
    let suspend = |need: &'static str| Some((need, "client_suspend", json!(field("client"))));
    match action {
        "client_drop_target" => suspend(SPOKES),
        "client_drop_scope" if field("scope") == "spokes.read" => suspend(SPOKES_READ),
        "client_drop_scope" if field("scope") == "spokes.tasks.submit" => suspend(SPOKES),
        // revision 8 3: a drop of presence.read or presence.write needs `presence`
        "client_drop_scope" if matches!(field("scope"), "presence.read" | "presence.write") => suspend(PRESENCE),
        "client_drop_credential" if field("type") == "spokes_node" => suspend(SPOKES),
        "client_drop_scope" if !R3_SCOPES.contains(&field("scope")) => Some((MAP_V2, "client_suspend", json!(field("client")))),
        "client_drop_credential" if field("type") == "entra_wif" => Some((MAP_V2, "client_suspend", json!(field("client")))),
        "destination_drop_signal" if field("signal") == "events" => Some((MAP_V2, "destination_suspend", json!(field("destination")))),
        _ => None,
    }
}

/// The relays of an org that lack any of `needs` (sorted, each once), from `set` (relay to its report; None: it
/// reported the org but its features are not known yet, so it lacks everything).
pub fn lacking(set: &BTreeMap<String, Option<Report>>, needs: &[&str]) -> Vec<String> {
    set.iter().filter(|(_, r)| needs.iter().any(|n| !r.as_ref().is_some_and(|r| r.has(n)))).map(|(id, _)| id.clone()).collect()
}

/// The `relay-outdated` refusal naming the relays that lack a need.
pub fn outdated(org: &str, relays: &[String], needs: &[&str]) -> ApiMapError {
    ApiMapError::new(OUTDATED, format!("relay {} of {org} does not report {} yet; update it or retire it from the organization", relays.join(", "), needs.join(", ")))
}

/// The console's relay sets, one file per org: `{"relays": {relay: report or null}}`.
#[derive(Debug, Default)]
pub struct RelaySets {
    dir: Option<PathBuf>,
    orgs: BTreeMap<String, BTreeMap<String, Option<Report>>>,
}

fn org_ok(s: &str) -> bool {
    (1..=32).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

impl RelaySets {
    /// Every set under `<dir>/api-org-relays` (in memory without a folder).
    pub fn load(dir: Option<&Path>) -> RelaySets {
        let dir = dir.map(|d| d.join(SETS_DIR));
        let mut orgs = BTreeMap::new();
        for entry in dir.as_ref().and_then(|d| std::fs::read_dir(d).ok()).into_iter().flatten().flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let Some(org) = name.strip_suffix(".json").filter(|o| org_ok(o)) else { continue };
            let v = crate::codec::parse_json(&std::fs::read_to_string(entry.path()).unwrap_or_default()).unwrap_or(Value::Null);
            let set: BTreeMap<String, Option<Report>> = v.get("relays").and_then(Value::as_object).into_iter().flatten().map(|(r, rep)| (r.clone(), Report::of_json(rep))).collect();
            orgs.insert(org.to_string(), set);
        }
        RelaySets { dir, orgs }
    }

    /// Write an org's candidate set durably. Callers replace the set in memory only after Ok, so a failed write leaves
    /// memory and disk on the same (previous) set.
    fn write_set(&self, org: &str, set: &BTreeMap<String, Option<Report>>) -> Result<(), ApiMapError> {
        let Some(dir) = &self.dir else { return Ok(()) };
        crate::store::make_dir(dir).map_err(|e| ApiMapError::new("io", e.to_string()))?;
        let relays: Map<String, Value> = set.iter().map(|(r, rep)| (r.clone(), rep.as_ref().map_or(Value::Null, Report::to_json))).collect();
        let text = crate::codec::stringify(&json!({ "relays": relays }));
        crate::fleet_local::write_durable(&dir.join(format!("{org}.json")), text.as_bytes()).map_err(|e| ApiMapError::new("io", e))
    }

    /// 2.3 item 2: a relay reported these orgs in `api-heads`; each it is new to takes it (with the relay's known report,
    /// else none yet), flushed. Ok lists the orgs it joined. A relay that joins is kept in memory even when its set could
    /// not be written: with no known report it only closes the gate (the stricter side), and the next catch-up writes it.
    pub fn joined<'a>(&mut self, relay: &str, orgs: impl IntoIterator<Item = &'a str>) -> Result<Vec<String>, ApiMapError> {
        let known = self.report_of(relay).cloned();
        let mut out = Vec::new();
        for org in orgs.into_iter().filter(|o| org_ok(o)) {
            let set = self.orgs.entry(org.to_string()).or_default();
            if set.contains_key(relay) {
                continue;
            }
            set.insert(relay.to_string(), known.clone());
            let set = set.clone();
            self.write_set(org, &set)?;
            out.push(org.to_string());
        }
        Ok(out)
    }

    /// 2.3 item 3: a relay's new `api-features` answer, kept for every org whose set holds it, flushed. Ok lists the
    /// `(org, needs)` it closed: needs every relay of the org reported before and this relay no longer does. Each org's
    /// new set is written durably before it replaces the one in memory; on a failed write that org keeps its previous
    /// set (memory and disk agree) and Err comes back (the catch-up tries again).
    pub fn reported(&mut self, relay: &str, report: Report, watched: &[&'static str]) -> Result<Vec<(String, Vec<&'static str>)>, ApiMapError> {
        let orgs: Vec<String> = self.orgs.iter().filter(|(_, s)| s.contains_key(relay)).map(|(o, _)| o.clone()).collect();
        let mut closed = Vec::new();
        for org in orgs {
            let held = &self.orgs[&org];
            if held.get(relay).and_then(Option::as_ref).is_some_and(|r| r.map == report.map && r.features == report.features && r.archive_orgs == report.archive_orgs) {
                continue;
            }
            let was: Vec<&'static str> = watched.iter().copied().filter(|n| lacking(held, &[*n]).is_empty()).collect();
            let mut candidate = held.clone();
            candidate.insert(relay.to_string(), Some(report.clone()));
            self.write_set(&org, &candidate)?;
            self.orgs.insert(org.clone(), candidate);
            let gone: Vec<&'static str> = was.into_iter().filter(|n| !report.has(n)).collect();
            if !gone.is_empty() {
                closed.push((org, gone));
            }
        }
        Ok(closed)
    }

    /// 2.3 item 2: an admin retires a relay from an org's set (written durably first, then applied in memory); false
    /// when it was not in it.
    pub fn retire(&mut self, org: &str, relay: &str) -> Result<bool, ApiMapError> {
        let Some(mut candidate) = self.orgs.get(org).filter(|s| s.contains_key(relay)).cloned() else { return Ok(false) };
        candidate.remove(relay);
        self.write_set(org, &candidate)?;
        self.orgs.insert(org.to_string(), candidate);
        Ok(true)
    }

    /// A relay's latest report in any set.
    pub fn report_of(&self, relay: &str) -> Option<&Report> {
        self.orgs.values().filter_map(|s| s.get(relay)).flatten().max_by_key(|r| r.at)
    }

    /// The org's set (relay to its report).
    pub fn set(&self, org: &str) -> BTreeMap<String, Option<Report>> {
        self.orgs.get(org).cloned().unwrap_or_default()
    }

    /// Whether every relay of the org's set reports `need` (an empty set opens everything).
    pub fn open(&self, org: &str, need: &str) -> bool {
        self.orgs.get(org).is_none_or(|s| lacking(s, &[need]).is_empty())
    }

    /// 2.3 item 3: Ok while every need is open for the org, else `relay-outdated` naming the relays that lack one.
    pub fn gate(&self, org: &str, needs: &[&str]) -> Result<(), ApiMapError> {
        let Some(set) = self.orgs.get(org) else { return Ok(()) };
        let out = lacking(set, needs);
        if out.is_empty() {
            Ok(())
        } else {
            Err(outdated(org, &out, needs))
        }
    }

    /// Every org with a set.
    pub fn orgs(&self) -> Vec<String> {
        self.orgs.keys().cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rep(map: &[u64], features: &[&str]) -> Report {
        Report { map: map.to_vec(), features: features.iter().map(|s| s.to_string()).collect(), archive_orgs: Vec::new(), at: 1 }
    }

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("lucid-api-features-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn the_relay_answer_and_reports() {
        let a = relay_answer(vec!["acme".into()]);
        assert_eq!(a["map"], json!([1, 2]));
        let r = Report::of_answer(&a, 5).unwrap();
        assert!(r.has(MAP_V2));
        // revision 4 2.3 item 1 plus the revision 5 3.3, revision 6 2.4 and revision 8 3 names; `journal-1c` is a
        // connector's only
        assert_eq!(r.features, [SCIM_CHECK, EVENTS, COMPLIANCE, ARCHIVE, CONNECTORS, IDPS, CONTENT_CLIENTS, DELEGATED, SPOKES, SPOKES_READ, A2A, PRESENCE]);
        assert!(!r.has(JOURNAL_1C));
        assert!(r.has(A2A));
        assert_eq!(r.archive_orgs, ["acme"]);
        assert!(!Report::old(5).has(MAP_V2));
        assert!(Report::of_answer(&json!({"features": []}), 5).is_none(), "map is required");
    }

    #[test]
    fn a_relay_set_persists_gates_and_closes_on_a_rollback() {
        let dir = temp("sets");
        let mut s = RelaySets::load(Some(&dir));
        assert!(s.gate("acme", &[MAP_V2]).is_ok(), "an empty set opens everything");
        assert_eq!(s.joined("r_1", ["acme"]).unwrap(), ["acme"]);
        assert_eq!(s.gate("acme", &[MAP_V2]).unwrap_err().code, OUTDATED, "features not known yet: closed");
        assert!(s.reported("r_1", rep(&[1, 2], &[]), &[MAP_V2]).unwrap().is_empty());
        assert!(s.gate("acme", &[MAP_V2]).is_ok());
        // a revision 3 relay joins after the save
        s.joined("r_2", ["acme"]).unwrap();
        s.reported("r_2", Report::old(2), &[MAP_V2]).unwrap();
        let e = s.gate("acme", &[MAP_V2]).unwrap_err();
        assert!(e.message.contains("r_2") && !e.message.contains("r_1"), "{}", e.message);
        // offline is not retired: a reload keeps it
        let back = RelaySets::load(Some(&dir));
        assert!(!back.open("acme", MAP_V2));
        assert_eq!(back.set("acme").len(), 2);
        // retired by an admin: the gate opens again
        let mut back = back;
        assert!(back.retire("acme", "r_2").unwrap());
        assert!(!back.retire("acme", "r_2").unwrap());
        assert!(back.open("acme", MAP_V2));
        // a rollback closes an open feature and says so
        assert_eq!(back.reported("r_1", Report::old(9), &[MAP_V2]).unwrap(), vec![("acme".to_string(), vec![MAP_V2])]);
        assert!(!RelaySets::load(Some(&dir)).open("acme", MAP_V2));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A report or a retirement whose write fails changes nothing: memory keeps the set the disk holds.
    #[test]
    fn a_failed_write_keeps_the_previous_set() {
        let dir = temp("write-fails");
        let mut s = RelaySets::load(Some(&dir));
        s.joined("r_1", ["acme"]).unwrap();
        s.reported("r_1", rep(&[1, 2], &[]), &[MAP_V2]).unwrap();
        assert!(s.open("acme", MAP_V2));
        // the seam: the sets folder becomes a file, so every write fails
        let sets = dir.join(SETS_DIR);
        std::fs::remove_dir_all(&sets).unwrap();
        std::fs::write(&sets, b"not a folder").unwrap();
        assert_eq!(s.reported("r_1", Report::old(2), &[MAP_V2]).unwrap_err().code, "io");
        assert!(s.open("acme", MAP_V2), "the rollback that was not written is not in force either");
        assert_eq!(s.report_of("r_1").map(|r| r.map.clone()), Some(vec![1, 2]));
        assert_eq!(s.retire("acme", "r_1").unwrap_err().code, "io");
        assert!(s.set("acme").contains_key("r_1"), "nor is a retirement that was not written");
        // once writes work again the same report applies and closes the gate
        std::fs::remove_file(&sets).unwrap();
        assert_eq!(s.reported("r_1", Report::old(3), &[MAP_V2]).unwrap(), vec![("acme".to_string(), vec![MAP_V2])]);
        assert!(!RelaySets::load(Some(&dir)).open("acme", MAP_V2));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The shared vectors (`tests/vectors/make_api_map_v2.py` in the Meeting Hub, copied to `tests/api_journal_v2.json`).
    #[test]
    fn the_gate_vectors_give_the_expected_verdicts() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("api_journal_v2.json");
        let text = std::fs::read_to_string(&path).unwrap_or_else(|_| panic!("{} is missing: run make_api_map_v2.py and copy it", path.display()));
        let doc: Value = serde_json::from_str(&text).unwrap();
        for c in doc["gate"].as_array().unwrap() {
            let set: BTreeMap<String, Option<Report>> = c["set"].as_object().unwrap().iter().map(|(r, rep)| (r.clone(), Report::of_answer(rep, 0))).collect();
            let needs: Vec<&str> = c["needs"].as_array().unwrap().iter().map(|n| n.as_str().unwrap()).collect();
            assert_eq!(json!(lacking(&set, &needs)), c["lacking"], "gate/{}", c["name"]);
        }
        for c in doc["needs"].as_array().unwrap() {
            assert_eq!(json!(map_needs(&c["map"])), c["needs"], "needs/{}", c["name"]);
        }
        for c in doc["relay_entries"].as_array().unwrap() {
            let got = relay_entry_gate(c["action"].as_str().unwrap(), &c["target"]).map(|(n, a, t)| json!([n, a, t]));
            assert_eq!(got.unwrap_or(Value::Null), c["gate"], "relay_entries/{}", c["name"]);
        }
    }

    #[test]
    fn needs_of_maps_and_relay_entries() {
        assert!(map_needs(&json!({"v": 1, "clients": [{"kind": "monitoring"}]})).is_empty());
        assert_eq!(map_needs(&json!({"v": 1, "clients": [{"kind": "compliance"}]})), [MAP_V2]);
        assert_eq!(map_needs(&json!({"v": 2, "webhook_keys": []})), [MAP_V2]);
        // revision 5 3.3: each map shape name, and a relay reports all four
        assert_eq!(map_needs(&json!({"v": 1, "connectors": []})), [CONNECTORS]);
        assert_eq!(map_needs(&json!({"v": 1, "idps": []})), [IDPS]);
        assert_eq!(map_needs(&json!({"v": 1, "clients": [{"kind": "app"}]})), [CONTENT_CLIENTS]);
        assert_eq!(map_needs(&json!({"v": 1, "clients": [{"kind": "monitoring", "scopes": ["content.read"]}]})), [CONTENT_CLIENTS]);
        assert_eq!(map_needs(&json!({"v": 1, "clients": [{"kind": "agent_delegated"}]})), [DELEGATED]);
        assert_eq!(map_needs(&json!({"v": 1, "clients": [{"kind": "monitoring", "credentials": [{"type": "cimd"}]}]})), [DELEGATED]);
        assert_eq!(
            map_needs(&json!({"v": 2, "connectors": [], "idps": [], "clients": [{"kind": "agent_delegated", "scopes": ["content.post"]}]})),
            [MAP_V2, CONNECTORS, IDPS, CONTENT_CLIENTS, DELEGATED]
        );
        assert!([CONNECTORS, IDPS, CONTENT_CLIENTS, DELEGATED].iter().all(|f| RELAY_FEATURES.contains(f)));
        assert!(!RELAY_FEATURES.contains(&JOURNAL_1C), "journal-1c is a connector's");
        assert!(relay_entry_gate("client_drop_scope", &json!({"client": "c_1", "scope": "audit.read"})).is_none());
        assert_eq!(relay_entry_gate("client_drop_scope", &json!({"client": "c_1", "scope": "directory.write"})), Some((MAP_V2, "client_suspend", json!("c_1"))));
        assert_eq!(relay_entry_gate("client_drop_credential", &json!({"client": "c_1", "type": "entra_wif"})), Some((MAP_V2, "client_suspend", json!("c_1"))));
        assert_eq!(relay_entry_gate("destination_drop_signal", &json!({"destination": "d_1", "signal": "events"})), Some((MAP_V2, "destination_suspend", json!("d_1"))));
        assert!(relay_entry_gate("client_suspend", &json!("c_1")).is_none());
    }

    /// Revision 6 2.3 and 2.4: the spokes needs of a map, after the revision 5 names, and the 4c fallbacks while
    /// `spokes` or `spokes-read` is closed.
    #[test]
    fn spokes_needs_and_their_fallbacks() {
        assert_eq!(map_needs(&json!({"v": 1, "spokes": {}})), [SPOKES]);
        assert_eq!(map_needs(&json!({"v": 1, "clients": [{"kind": "spokes_hub"}]})), [SPOKES]);
        assert_eq!(map_needs(&json!({"v": 1, "clients": [{"kind": "monitoring", "spokes": {}}]})), [SPOKES]);
        assert_eq!(map_needs(&json!({"v": 1, "clients": [{"kind": "monitoring", "credentials": [{"type": "spokes_node"}]}]})), [SPOKES]);
        assert_eq!(map_needs(&json!({"v": 1, "clients": [{"kind": "monitoring", "scopes": ["spokes.read"]}]})), [SPOKES_READ]);
        assert_eq!(
            map_needs(&json!({"v": 2, "connectors": [], "spokes": {}, "clients": [{"kind": "agent_delegated", "scopes": ["content.post", "spokes.read"]}]})),
            [MAP_V2, CONNECTORS, CONTENT_CLIENTS, DELEGATED, SPOKES, SPOKES_READ]
        );
        assert!(map_needs(&json!({"v": 1, "clients": [{"kind": "monitoring", "scopes": ["monitor.read"]}]})).is_empty());
        // revision 6 2.4 (slice 1d5): `a2a` for the map key, the client keys `a2a` and `card`, and spokes.tasks.submit
        // on a client other than spokes_hub; a relay reports it
        assert_eq!(map_needs(&json!({"v": 1, "a2a": {}})), [A2A]);
        assert_eq!(map_needs(&json!({"v": 1, "clients": [{"kind": "monitoring", "a2a": {}}]})), [A2A]);
        assert_eq!(map_needs(&json!({"v": 1, "clients": [{"kind": "monitoring", "card": {}}]})), [A2A]);
        assert_eq!(map_needs(&json!({"v": 1, "clients": [{"kind": "agent", "scopes": ["spokes.tasks.submit"]}]})), [CONTENT_CLIENTS, A2A]);
        assert_eq!(map_needs(&json!({"v": 1, "clients": [{"kind": "spokes_hub", "scopes": ["spokes.tasks.submit"]}]})), [SPOKES], "a service hub's own scope");
        assert_eq!(
            map_needs(&json!({"v": 1, "spokes": {}, "connectors": [], "a2a": {"agents": []},
                              "clients": [{"kind": "spokes_hub", "scopes": ["spokes.tasks.submit"]}, {"kind": "agent", "scopes": ["spokes.tasks.submit"], "connectors": [], "a2a": {}}]})),
            [CONNECTORS, CONTENT_CLIENTS, SPOKES, A2A]
        );
        assert!(RELAY_FEATURES.contains(&A2A));
        let suspend = |need: &'static str| Some((need, "client_suspend", json!("c_1")));
        assert_eq!(relay_entry_gate("client_drop_target", &json!({"client": "c_1", "spoke": "n_1"})), suspend(SPOKES));
        assert_eq!(relay_entry_gate("client_drop_scope", &json!({"client": "c_1", "scope": "spokes.read"})), suspend(SPOKES_READ));
        assert_eq!(relay_entry_gate("client_drop_scope", &json!({"client": "c_1", "scope": "spokes.tasks.submit"})), suspend(SPOKES));
        assert_eq!(relay_entry_gate("client_drop_credential", &json!({"client": "c_1", "type": "spokes_node"})), suspend(SPOKES));
        assert!(relay_entry_gate("client_drop_credential", &json!({"client": "c_1", "kid": "0123456789abcdef0123456789abcdef"})).is_none(), "a serial as kid every relay reads");
        // the gate closes on a relay that does not report the name
        let set = BTreeMap::from([("r_1".to_string(), Some(rep(&[1, 2], &[SPOKES]))), ("r_2".to_string(), Some(rep(&[1, 2], &[])))]);
        assert_eq!(lacking(&set, &[SPOKES]), ["r_2"]);
        assert_eq!(lacking(&set, &[SPOKES_READ]), ["r_1", "r_2"]);
    }

    /// API-1 revision 8 3: a client holding presence.* needs `presence`, a relay reports it, and a drop of either
    /// scope falls back to client_suspend while it is closed.
    #[test]
    fn presence_needs_and_its_fallback() {
        assert!(RELAY_FEATURES.contains(&PRESENCE));
        assert_eq!(map_needs(&json!({"v": 1, "clients": [{"kind": "integration", "scopes": ["presence.read"]}]})), [PRESENCE]);
        assert_eq!(map_needs(&json!({"v": 1, "clients": [{"kind": "integration", "scopes": ["presence.write"]}]})), [PRESENCE]);
        assert_eq!(map_needs(&json!({"v": 1, "clients": [{"kind": "integration", "scopes": ["spokes.read", "presence.read"]}]})), [SPOKES_READ, PRESENCE]);
        let suspend = Some((PRESENCE, "client_suspend", json!("c_1")));
        assert_eq!(relay_entry_gate("client_drop_scope", &json!({"client": "c_1", "scope": "presence.read"})), suspend);
        assert_eq!(relay_entry_gate("client_drop_scope", &json!({"client": "c_1", "scope": "presence.write"})), suspend);
        let set = BTreeMap::from([("r_1".to_string(), Some(rep(&[1, 2], &[PRESENCE]))), ("r_2".to_string(), Some(rep(&[1, 2], &[SPOKES])))]);
        assert_eq!(lacking(&set, &[PRESENCE]), ["r_2"]);
    }
}
