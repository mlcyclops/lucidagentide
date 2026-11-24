// API-1 revision 4 (docs/api/contract-r4-1b.md) 6.1.1, 6.6 and 13.1 `directory/status`: what only the SSO service
// knows (legacy SCIM token dates, the `pre_r4d3` mark, the SCIM group adds its directory reader has not confirmed)
// carried SSO service to relay to console.
//
// The SSO service posts one snapshot per (org, provider) its registry entry names it for (`POST
// /v1/sso/c/directory-status` over its mTLS identity, checked like every `/v1/sso/c/*` route), when it changed and at
// least hourly. The relay keeps the newest per (org, provider) in `api-sso-status/<org>.json` (fsynced). The console
// asks each connected relay of the org (fleet op `api-directory-status {org}`, read-only) while it builds `GET
// directory/status`, checks every report again, and keeps the newest per provider. Only non-secret data travels: a
// token's id, the first hex of its SHA-256 (`hint`), its dates, `pre_r4d3` and whether it has no address list; a
// pending confirmation's principal, group id, group display name and since. Never a token value, its whole hash or its
// addresses.

use crate::fleet_wire::Refusal;
use crate::meet::{log_info, Identity, Relay, E, R};
use crate::meet_json::{self as pj, obj, Obj};
use parking_lot::Mutex;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

/// The console's fleet op to a relay.
pub const OP: &str = "api-directory-status";
/// The largest `POST /v1/sso/c/directory-status` body.
pub const BODY_MAX: usize = 48 * 1024;
/// The relay's folder under its state folder: one `<org>.json` of provider to report.
pub const DIR: &str = "api-sso-status";
/// Legacy token rows in one report.
pub const TOKENS_MAX: usize = 64;
/// Pending confirmation rows in one report (`pending_count` counts every one).
pub const PENDING_MAX: usize = 200;
/// Providers one org file keeps: 16 reports of at most 48 KiB stay below the 1 MiB answer frame.
pub const PROVIDERS_MAX: usize = 16;
/// How long the console waits for each relay's answer.
pub const CALL_MS: u64 = 5_000;
/// The console marks a token `ending` from this long before its `expires` (6.1.1: 14 days).
pub const ENDING_S: i64 = 14 * 86_400;
const POST_KEYS: [&str; 6] = ["org", "provider", "at", "tokens", "pending", "pending_count"];
const TOKEN_KEYS: [&str; 6] = ["id", "hint", "issued", "expires", "pre_r4d3", "no_address_list"];
const PENDING_KEYS: [&str; 4] = ["principal", "group", "group_name", "since"];
const PROVIDER_MAX: usize = 64;
const ID_MAX: usize = 128;
const HINT_MAX: usize = 16;
const PRINCIPAL_MAX: usize = 320;
const NAME_MAX: usize = 128;
const MAX_INT: i64 = (1 << 53) - 1;
/// A report may be dated at most this far ahead of the clock that checks it.
const SKEW: i64 = 300;
const REGISTERED: &str = "the sign-in service may only report the directory status of providers registered to it";

fn exact(v: &Value, keys: &[&str]) -> bool {
    v.as_object().is_some_and(|o| o.len() == keys.len() && keys.iter().all(|k| o.contains_key(*k)))
}

fn text(v: &Value, min: usize, max: usize) -> bool {
    v.as_str().is_some_and(|t| (min..=max).contains(&t.chars().count()) && pj::printable(t))
}

fn int(v: &Value, min: i64) -> bool {
    v.as_i64().is_some_and(|n| (min..=MAX_INT).contains(&n))
}

fn token_ok(v: &Value) -> bool {
    exact(v, &TOKEN_KEYS)
        && text(&v["id"], 1, ID_MAX)
        && v["hint"].as_str().is_some_and(|h| (1..=HINT_MAX).contains(&h.len()) && h.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
        && int(&v["issued"], 0)
        && int(&v["expires"], 1)
        && v["pre_r4d3"].is_boolean()
        && v["no_address_list"].is_boolean()
}

fn pending_ok(v: &Value) -> bool {
    exact(v, &PENDING_KEYS) && text(&v["principal"], 1, PRINCIPAL_MAX) && text(&v["group"], 1, ID_MAX) && text(&v["group_name"], 0, NAME_MAX) && int(&v["since"], 0)
}

/// 13.1: a directory status `{org, provider, at, tokens, pending, pending_count}` checked at `now` (seconds): `(org,
/// provider, report)`, the report being the body without `org`. Err is the 400 words.
pub fn check_report(body: &Value, now: i64) -> Result<(String, String, Value), String> {
    let shape = || format!("a directory status is {{org, provider, at, tokens: 0 to {TOKENS_MAX}, pending: 0 to {PENDING_MAX}, pending_count}}");
    let mut o: Map<String, Value> = body.as_object().filter(|_| exact(body, &POST_KEYS)).cloned().ok_or_else(shape)?;
    let org = o["org"].as_str().filter(|s| crate::api_audit::org_ok(s)).ok_or_else(|| "org must be an organization id".to_string())?.to_string();
    let provider = o["provider"].as_str().filter(|p| (1..=PROVIDER_MAX).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_graphic())).ok_or_else(|| "provider must be a provider id".to_string())?.to_string();
    if !int(&o["at"], 1) || o["at"].as_i64().unwrap_or_default() > now + SKEW {
        return Err("at must be the report's time, not ahead of the relay's clock".into());
    }
    let tokens = o["tokens"].as_array().filter(|a| a.len() <= TOKENS_MAX).ok_or_else(shape)?;
    if !tokens.iter().all(token_ok) {
        return Err("a token is {id, hint, issued, expires, pre_r4d3, no_address_list}".into());
    }
    let pending = o["pending"].as_array().filter(|a| a.len() <= PENDING_MAX).ok_or_else(shape)?;
    if !pending.iter().all(pending_ok) {
        return Err("a pending confirmation is {principal, group, group_name, since}".into());
    }
    let listed = pending.len() as i64;
    if !o["pending_count"].as_i64().is_some_and(|n| (listed..=MAX_INT).contains(&n)) {
        return Err("pending_count counts at least the listed pending confirmations".into());
    }
    o.remove("org");
    Ok((org, provider, Value::Object(o)))
}

// ── the relay ──

/// Writes of the org files, one at a time.
static FILES: LazyLock<Mutex<()>> = LazyLock::new(Mutex::default);

fn file_of(dir: &Path, org: &str) -> PathBuf {
    dir.join(DIR).join(format!("{org}.json"))
}

/// The reports kept for `org` (provider to report); a missing or unreadable file is none.
pub fn load(dir: &Path, org: &str) -> Map<String, Value> {
    std::fs::read(file_of(dir, org)).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()).and_then(|v| v.as_object().cloned()).unwrap_or_default()
}

/// Keep `report` of (`org`, `provider`) unless the held one is newer: Ok(false) then. Flushed before Ok(true).
pub fn store(dir: &Path, org: &str, provider: &str, report: &Value) -> Result<bool, String> {
    let _one = FILES.lock();
    let mut held = load(dir, org);
    let at = |r: &Value| r.get("at").and_then(Value::as_i64).unwrap_or(0);
    if held.get(provider).is_some_and(|old| at(old) > at(report)) {
        return Ok(false);
    }
    if !held.contains_key(provider) && held.len() >= PROVIDERS_MAX {
        return Err(format!("the directory status of {org} already holds {PROVIDERS_MAX} providers"));
    }
    held.insert(provider.to_string(), report.clone());
    let folder = dir.join(DIR);
    crate::store::make_dir(&folder).map_err(|e| format!("{}: {e}", folder.display()))?;
    let text = serde_json::to_vec(&Value::Object(held)).map_err(|e| e.to_string())?;
    crate::fleet_local::write_durable(&file_of(dir, org), &text)?;
    Ok(true)
}

/// `POST /v1/sso/c/directory-status` from the SSO service the registry names for (`org`, `provider`) (403
/// otherwise): `{ok, stored}`. A relay without a state folder serves no API and keeps nothing.
pub fn post(relay: &Relay, who: &Identity, b: &Obj) -> R<Obj> {
    relay.hub.pc_check_registered(who, &pj::text_of(b, "org"), &pj::text_of(b, "provider"), REGISTERED)?;
    let (org, provider, report) = check_report(&Value::Object(b.clone()), pj::now() as i64).map_err(E::Bad)?;
    let Some(dir) = crate::api_scim::state_dir(&relay.settings.state_dir) else {
        return Ok(obj([("ok", Value::Bool(true)), ("stored", Value::Bool(false))]));
    };
    let stored = store(&dir, &org, &provider, &report).map_err(|e| E::Internal(format!("the directory status could not be kept: {e}")))?;
    log_info(&format!("sso_directory_status org={org} provider={provider} service={} stored={stored}", crate::meet::serial(&who.serial)));
    Ok(obj([("ok", Value::Bool(true)), ("stored", Value::Bool(stored))]))
}

/// The `api-directory-status {org}` answer from the state folder `dir`: `{org, reports: [{provider, at, tokens,
/// pending, pending_count}]}` by provider (none without a folder).
pub fn answer(dir: Option<&Path>, body: &Value) -> Result<Value, Refusal> {
    let org = body.get("org").and_then(Value::as_str).filter(|o| crate::api_audit::org_ok(o)).ok_or_else(|| Refusal::new(400, "fleet-op", "api-directory-status needs an organization id."))?;
    let reports: Vec<Value> = dir.map(|d| load(d, org)).unwrap_or_default().into_iter().map(|(_, r)| r).collect();
    Ok(json!({ "org": org, "reports": reports }))
}

/// The relay's `api-directory-status` handler (meet.rs `api_request`; the wire checked the keys and the size).
pub fn request(relay: &Relay, body: &Value) -> Result<Value, Refusal> {
    answer(crate::api_scim::state_dir(&relay.settings.state_dir).as_deref(), body)
}

// ── the console ──

/// What the connected relays of an org answered: (relay, checked report) and the relays that did not answer.
#[derive(Debug, Default)]
pub struct Collected {
    pub reports: Vec<(String, Value)>,
    pub unanswered: Vec<String>,
}

/// The reports of one relay's answer for `org`, each checked again (a report that does not check is left out).
pub fn answer_reports(answer: &Value, org: &str, now: i64) -> Vec<Value> {
    answer
        .get("reports")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(PROVIDERS_MAX)
        .filter_map(|r| {
            let mut body = r.clone();
            body.as_object_mut()?.insert("org".into(), json!(org));
            check_report(&body, now).ok().map(|(_, _, report)| report)
        })
        .collect()
}

/// `api-directory-status {org}` to every relay of the org connected now and serving it (blocking; never under a
/// console lock).
pub fn collect(fleet: &crate::console_fleet::Fleet, org: &str, now: i64) -> Collected {
    let mut out = Collected::default();
    let link = fleet.api_link();
    for relay in fleet.api.relays_of(org).into_iter().filter(|r| fleet.api.serves_now(r, org)) {
        match link.as_ref().map(|l| l.request(&relay, OP, json!({ "org": org }), CALL_MS)) {
            Some(Ok(a)) => out.reports.extend(answer_reports(&a, org, now).into_iter().map(|r| (relay.clone(), r))),
            _ => out.unanswered.push(relay),
        }
    }
    out
}

/// The newest report per provider (by `at`; at an equal `at` the first relay by name), with its relay.
pub fn newest(reports: &[(String, Value)]) -> Vec<(String, Value)> {
    let mut by: BTreeMap<String, (String, Value)> = BTreeMap::new();
    for (relay, r) in reports {
        let provider = r.get("provider").and_then(Value::as_str).unwrap_or_default().to_string();
        let at = |r: &Value| r.get("at").and_then(Value::as_i64).unwrap_or(0);
        let newer = by.get(&provider).is_none_or(|(held_relay, held)| at(r) > at(held) || (at(r) == at(held) && relay < held_relay));
        if newer {
            by.insert(provider, (relay.clone(), r.clone()));
        }
    }
    by.into_values().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fleet_wire::{parse_frame, req_text, Frame, Side};

    const NOW: i64 = 1_763_000_000;

    fn body() -> Value {
        json!({
            "org": "acme", "provider": "okta", "at": NOW,
            "tokens": [
                { "id": "okta", "hint": "3f2a9c1d", "issued": 0, "expires": NOW + 86_400, "pre_r4d3": true, "no_address_list": true },
                { "id": "multi", "hint": "0b1c2d3e", "issued": NOW - 60, "expires": NOW + 30 * 86_400, "pre_r4d3": false, "no_address_list": false },
            ],
            "pending": [{ "principal": "ann@acme.com", "group": "g-ops", "group_name": "Ops", "since": NOW - 400 }],
            "pending_count": 3,
        })
    }

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("lucid-api-sso-status-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn a_report_is_checked_and_loses_its_org() {
        let (org, provider, report) = check_report(&body(), NOW).unwrap();
        assert_eq!((org.as_str(), provider.as_str()), ("acme", "okta"));
        assert!(report.get("org").is_none());
        assert_eq!(report["pending_count"], 3);
        assert_eq!(report["tokens"][0]["hint"], "3f2a9c1d");
    }

    #[test]
    fn every_shape_error_is_refused() {
        fn bad(f: impl Fn(&mut Value)) -> String {
            let mut b = body();
            f(&mut b);
            check_report(&b, NOW).unwrap_err()
        }
        bad(|b| b["extra"] = json!(1));
        bad(|b| {
            b.as_object_mut().unwrap().remove("pending_count");
        });
        bad(|b| b["org"] = json!("Acme Corp"));
        bad(|b| b["provider"] = json!(""));
        bad(|b| b["at"] = json!(NOW + SKEW + 1));
        bad(|b| b["at"] = json!(0));
        bad(|b| b["pending_count"] = json!(0));
        // a token value, its whole hash or its addresses are no fields of a row
        bad(|b| b["tokens"][0]["sha256"] = json!("ab".repeat(32)));
        bad(|b| b["tokens"][0]["ip_allow"] = json!(["203.0.113.0/24"]));
        bad(|b| b["tokens"][0]["hint"] = json!("ab".repeat(32)));
        bad(|b| b["tokens"][0]["hint"] = json!("3F2A9C1D"));
        bad(|b| b["tokens"][0]["pre_r4d3"] = json!("yes"));
        bad(|b| b["tokens"][0]["expires"] = json!(0));
        bad(|b| b["pending"][0]["principal"] = json!("ann\n@acme.com"));
        bad(|b| b["pending"][0]["group_name"] = json!("x".repeat(NAME_MAX + 1)));
        bad(|b| b["tokens"] = json!(vec![body()["tokens"][0].clone(); TOKENS_MAX + 1]));
        bad(|b| {
            b["pending"] = json!(vec![body()["pending"][0].clone(); PENDING_MAX + 1]);
            b["pending_count"] = json!(PENDING_MAX + 1);
        });
        // empty lists are a report too (nothing pending, no legacy token)
        let mut empty = body();
        empty["tokens"] = json!([]);
        empty["pending"] = json!([]);
        empty["pending_count"] = json!(0);
        assert!(check_report(&empty, NOW).is_ok());
    }

    #[test]
    fn the_relay_keeps_the_newest_report_per_provider_and_answers_them() {
        let dir = scratch("store");
        let (_, _, report) = check_report(&body(), NOW).unwrap();
        assert!(store(&dir, "acme", "okta", &report).unwrap());
        let mut older = report.clone();
        older["at"] = json!(NOW - 1);
        older["pending_count"] = json!(9);
        assert!(!store(&dir, "acme", "okta", &older).unwrap(), "an older report is not kept");
        let mut entra = report.clone();
        entra["provider"] = json!("entra");
        assert!(store(&dir, "acme", "entra", &entra).unwrap());
        let a = answer(Some(&dir), &json!({ "org": "acme" })).unwrap();
        assert_eq!(a["org"], "acme");
        let reports = a["reports"].as_array().unwrap();
        assert_eq!(reports.len(), 2);
        assert!(reports.iter().all(|r| r["pending_count"] == 3));
        assert_eq!(answer(Some(&dir), &json!({ "org": "beta" })).unwrap()["reports"], json!([]));
        assert_eq!(answer(None, &json!({ "org": "acme" })).unwrap()["reports"], json!([]));
        assert!(answer(Some(&dir), &json!({ "org": "../x" })).is_err());
        // the console checks the answer again and drops what does not check
        let mut tampered = a.clone();
        tampered["reports"][0]["tokens"][0]["sha256"] = json!("ab");
        assert_eq!(answer_reports(&a, "acme", NOW).len(), 2);
        assert_eq!(answer_reports(&tampered, "acme", NOW).len(), 1);
        for i in 0..PROVIDERS_MAX - 2 {
            assert!(store(&dir, "acme", &format!("p{i}"), &report).unwrap());
        }
        assert!(store(&dir, "acme", "one-more", &report).is_err(), "at most 16 providers per org");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn newest_keeps_one_report_per_provider() {
        let r = |p: &str, at: i64| json!({ "provider": p, "at": at });
        let got = newest(&[("r_2".into(), r("okta", 5)), ("r_1".into(), r("okta", 9)), ("r_3".into(), r("entra", 1)), ("r_0".into(), r("entra", 1))]);
        assert_eq!(got, vec![("r_0".to_string(), r("entra", 1)), ("r_1".to_string(), r("okta", 9))]);
    }

    #[test]
    fn the_op_goes_console_to_relay_within_256_bytes() {
        let ok = json!({ "org": "acme" });
        assert!(matches!(parse_frame(&req_text(1, OP, ok.clone()), Side::Relay), Ok(Frame::Req { op: OP, .. })));
        assert_eq!(parse_frame(&req_text(1, OP, ok.clone()), Side::Console).err().unwrap().why, "op", "the wrong side refuses it");
        assert_eq!(parse_frame(&req_text(1, OP, json!({})), Side::Relay).err().unwrap().why, "body");
        assert_eq!(parse_frame(&req_text(1, OP, json!({ "org": "a".repeat(300) })), Side::Relay).err().unwrap().why, "size");
        assert_eq!(crate::fleet_wire::op_frame_max(OP), Some(256));
        let route = crate::meet_license::GATE.iter().find(|(m, p, _)| *m == "POST" && *p == "/v1/sso/c/directory-status");
        assert!(route.is_some(), "the route is in the gate table");
    }
}
