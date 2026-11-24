// API-1 revision 4 (docs/api/contract-r4-1b.md) 7.1: the console's watched events. Once a minute
// (`console_fleet::Fleet::tick`) the console compares what it holds with what it last reported, per org:
// - `relay.health.changed` when the 8.2 health it judges for a relay of the org changed (the first sight of a relay
//   in an org records its health and reports nothing);
// - `cert.expiring` (kinds `mgmt`, `tls`, `signer`, `crl` of the 5.3 expiry rows), `license.expiring` and
//   `client.expiring` (the registration end of an active client of the org's pinned map, reason `expiry`), each once
//   per threshold reached: 30, 14, 7 and 1 days left. A value back above 30 days (renewed) is forgotten, so the next
//   approach reports again.
// What was reported is kept in `<state>/api-events/watch.json`, written after each pass that changed it, so a restart
// neither repeats an event nor loses one; an event that could not be appended is tried again at the next pass.

use crate::codec::{parse_json, stringify};
use crate::fleet_local::write_durable;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::PathBuf;

/// The file under the event chains' folder.
pub const WATCH_FILE: &str = "watch.json";
/// Days left at which an expiry is reported, highest first.
pub const THRESHOLDS: [i64; 4] = [30, 14, 7, 1];

/// The lowest threshold `days_left` has reached (None above every threshold).
pub fn level(days_left: i64) -> Option<i64> {
    THRESHOLDS.iter().rev().copied().find(|t| days_left <= *t)
}

/// One relay as a pass sees it: its health now and its expiry rows (`license`, or a certificate kind, with days left).
#[derive(Clone, Debug)]
pub struct RelayFacts {
    pub id: String,
    pub health: String,
    pub expiry: Vec<(String, i64)>,
}

/// One org with a pinned map: the relays that serve it and the clients of its map.
#[derive(Clone, Debug)]
pub struct OrgFacts {
    pub org: String,
    pub relays: Vec<String>,
    pub clients: Vec<Value>,
}

#[derive(Default)]
struct Seen {
    /// `<org> <relay>` -> the health last reported (or first seen).
    health: BTreeMap<String, String>,
    /// `<type> <org> <subject>` -> the lowest threshold reported.
    levels: BTreeMap<String, i64>,
}

/// What the console last reported of its watched events.
pub struct Watch {
    path: Option<PathBuf>,
    seen: Mutex<Seen>,
}

impl Watch {
    /// The record in `path` (in memory without one); a record that does not read starts empty.
    pub fn load(path: Option<PathBuf>) -> Watch {
        let v = path.as_ref().and_then(|p| std::fs::read_to_string(p).ok()).and_then(|t| parse_json(&t)).unwrap_or(Value::Null);
        let strings = |k: &str| -> BTreeMap<String, String> { v.get(k).and_then(Value::as_object).into_iter().flatten().filter_map(|(a, b)| Some((a.clone(), b.as_str()?.to_owned()))).collect() };
        let levels = v.get("levels").and_then(Value::as_object).into_iter().flatten().filter_map(|(a, b)| Some((a.clone(), b.as_i64()?))).collect();
        Watch { path, seen: Mutex::new(Seen { health: strings("health"), levels }) }
    }

    fn save(&self, s: &Seen) {
        if let Some(p) = &self.path {
            let _ = write_durable(p, stringify(&json!({ "health": s.health, "levels": s.levels })).as_bytes());
        }
    }

    /// One pass at `now` (unix seconds). `emit(org, type, data)` is true once the event is in the org's chains.
    pub fn pass(&self, orgs: &[OrgFacts], relays: &[RelayFacts], now: i64, emit: &dyn Fn(&str, &str, Value) -> bool) {
        let mut s = self.seen.lock();
        let mut changed = false;
        for o in orgs {
            for r in relays.iter().filter(|r| o.relays.iter().any(|x| *x == r.id)) {
                let key = format!("{} {}", o.org, r.id);
                match s.health.get(&key).cloned() {
                    None => {
                        s.health.insert(key, r.health.clone());
                        changed = true;
                    }
                    Some(from) if from != r.health => {
                        if emit(&o.org, "relay.health.changed", json!({ "relay": r.id, "from": from, "to": r.health })) {
                            s.health.insert(key, r.health.clone());
                            changed = true;
                        }
                    }
                    Some(_) => {}
                }
                for (kind, days) in &r.expiry {
                    let (event, data) = if kind == "license" {
                        ("license.expiring", json!({ "relay": r.id, "days_left": days }))
                    } else {
                        ("cert.expiring", json!({ "relay": r.id, "kind": kind, "days_left": days }))
                    };
                    let key = format!("{event} {} {} {kind}", o.org, r.id);
                    changed |= crossing(&mut s, &key, *days, || emit(&o.org, event, data.clone()));
                }
            }
            for c in &o.clients {
                let (Some(id), Some(expires)) = (c.get("id").and_then(Value::as_str), c.get("expires").and_then(Value::as_i64)) else { continue };
                if c.get("state").and_then(Value::as_str) != Some("active") {
                    continue;
                }
                let days = (expires - now).div_euclid(86_400);
                let key = format!("client.expiring {} {id}", o.org);
                changed |= crossing(&mut s, &key, days, || emit(&o.org, "client.expiring", json!({ "client": id, "reason": "expiry", "days_left": days })));
            }
        }
        if changed {
            self.save(&s);
        }
    }
}

/// Whether `key`'s record changed: a newly reached threshold reported (once `emit` succeeded), or a value back above
/// every threshold forgotten.
fn crossing(s: &mut Seen, key: &str, days: i64, emit: impl FnOnce() -> bool) -> bool {
    match level(days) {
        None => s.levels.remove(key).is_some(),
        Some(l) if s.levels.get(key).is_none_or(|old| l < *old) => {
            if emit() {
                s.levels.insert(key.to_owned(), l);
                true
            } else {
                false
            }
        }
        Some(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    const NOW: i64 = 1_795_000_000;

    fn relay(health: &str, expiry: &[(&str, i64)]) -> RelayFacts {
        RelayFacts { id: "r_01".into(), health: health.into(), expiry: expiry.iter().map(|(k, d)| (k.to_string(), *d)).collect() }
    }

    fn org(clients: Vec<Value>) -> Vec<OrgFacts> {
        vec![OrgFacts { org: "acme".into(), relays: vec!["r_01".into()], clients }]
    }

    /// A pass's events, each checked against the registry (`api_events::check_emit`) as the console's emit checks it.
    fn run(w: &Watch, orgs: &[OrgFacts], relays: &[RelayFacts], now: i64, ok: bool) -> Vec<(String, String, Value)> {
        let got = RefCell::new(Vec::new());
        w.pass(orgs, relays, now, &|o: &str, k: &str, d: Value| {
            crate::api_events::check_emit("console", k, &d).unwrap_or_else(|e| panic!("{k}: {e}"));
            got.borrow_mut().push((o.to_owned(), k.to_owned(), d));
            ok
        });
        got.into_inner()
    }

    #[test]
    fn thresholds_are_30_14_7_and_1_days() {
        assert_eq!([31, 30, 15, 14, 8, 7, 2, 1, 0, -3].map(level), [None, Some(30), Some(30), Some(14), Some(14), Some(7), Some(7), Some(1), Some(1), Some(1)]);
    }

    #[test]
    fn health_changes_are_reported_once_and_survive_a_restart() {
        let dir = crate::fleet_ca::tests_dir("api-event-watch-health");
        let path = Some(dir.join(WATCH_FILE));
        let w = Watch::load(path.clone());
        assert!(run(&w, &org(vec![]), &[relay("ok", &[])], NOW, true).is_empty(), "the first sight reports nothing");
        assert!(run(&w, &org(vec![]), &[relay("ok", &[])], NOW, true).is_empty());
        let got = run(&w, &org(vec![]), &[relay("warn", &[])], NOW, true);
        assert_eq!(got, vec![("acme".to_string(), "relay.health.changed".to_string(), json!({"relay": "r_01", "from": "ok", "to": "warn"}))]);
        assert!(run(&w, &org(vec![]), &[relay("warn", &[])], NOW, true).is_empty(), "once");
        // a restart repeats nothing; an append that failed is tried again
        let again = Watch::load(path);
        assert!(run(&again, &org(vec![]), &[relay("warn", &[])], NOW, true).is_empty());
        assert_eq!(run(&again, &org(vec![]), &[relay("bad", &[])], NOW, false).len(), 1);
        assert_eq!(run(&again, &org(vec![]), &[relay("bad", &[])], NOW, true).len(), 1);
        assert!(run(&again, &org(vec![]), &[relay("bad", &[])], NOW, true).is_empty());
        // a relay that does not serve the org is none of its events
        let other = vec![OrgFacts { org: "beta".into(), relays: vec!["r_02".into()], clients: vec![] }];
        assert!(run(&again, &other, &[relay("ok", &[])], NOW, true).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn expiries_are_reported_once_per_threshold() {
        let dir = crate::fleet_ca::tests_dir("api-event-watch-expiry");
        let path = Some(dir.join(WATCH_FILE));
        let w = Watch::load(path.clone());
        let kinds = |got: &[(String, String, Value)]| got.iter().map(|(_, k, d)| (k.clone(), d["days_left"].as_i64().unwrap())).collect::<Vec<_>>();
        assert!(run(&w, &org(vec![]), &[relay("ok", &[("tls", 40), ("license", 90)])], NOW, true).is_empty());
        let got = run(&w, &org(vec![]), &[relay("ok", &[("tls", 25), ("license", 30)])], NOW, true);
        assert_eq!(kinds(&got), [("cert.expiring".to_string(), 25), ("license.expiring".to_string(), 30)]);
        assert_eq!(got[0].2, json!({"relay": "r_01", "kind": "tls", "days_left": 25}));
        assert_eq!(got[1].2, json!({"relay": "r_01", "days_left": 30}));
        assert!(run(&w, &org(vec![]), &[relay("ok", &[("tls", 20), ("license", 29)])], NOW, true).is_empty(), "the same threshold");
        assert_eq!(kinds(&run(&w, &org(vec![]), &[relay("ok", &[("tls", 10), ("license", 29)])], NOW, true)), [("cert.expiring".to_string(), 10)]);
        // restart: nothing again; renewed: forgotten, so the next approach reports again
        let again = Watch::load(path);
        assert!(run(&again, &org(vec![]), &[relay("ok", &[("tls", 9)])], NOW, true).is_empty());
        assert!(run(&again, &org(vec![]), &[relay("ok", &[("tls", 365)])], NOW, true).is_empty());
        assert_eq!(run(&again, &org(vec![]), &[relay("ok", &[("tls", 28)])], NOW, true).len(), 1);
        // a client's registration end: active clients only, reason expiry
        let clients = vec![
            json!({"id": "c_0a1b2c3d4e5f6071", "state": "active", "expires": NOW + 5 * 86_400 + 60}),
            json!({"id": "c_1111111111111111", "state": "suspended", "expires": NOW + 5 * 86_400 + 60}),
        ];
        let got = run(&again, &org(clients.clone()), &[], NOW, true);
        assert_eq!(got, vec![("acme".to_string(), "client.expiring".to_string(), json!({"client": "c_0a1b2c3d4e5f6071", "reason": "expiry", "days_left": 5}))]);
        assert!(run(&again, &org(clients), &[], NOW, true).is_empty(), "once");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
