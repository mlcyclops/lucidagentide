// Contract AI-1 sections 1 (read side), 2 and 6.2 for the AI gateway: the `ai` key of the pinned org policy and the
// AI map it names, verified exactly as a device does (meet_org_policy::verify and verify_ai_map: chain to the org
// CA, signer policy, `seq` not lower than pinned, `expires`), kept as (policy, map) pairs on disk with the
// 10-minute window after a new pin (both pairs kept, so a restart inside the window keeps it), and the `who` answers
// of the relay cached 5 minutes (6.4).

use crate::meet_org_policy as op;
use crate::meet_x509::{Cert, Crl};
use parking_lot::Mutex;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

pub type Obj = Map<String, Value>;

/// 6.2: requests made under the previous policy hash are taken this long after a new pin.
pub const WINDOW_MS: i64 = 10 * 60 * 1000;
/// 6.4: the gateway caches an `allowed` answer at most this long.
pub const WHO_TTL_MS: i64 = 5 * 60 * 1000;

/// What the gateway reads from `ai` (the shape was checked by `check_policy`).
#[derive(Clone, Debug, Default)]
pub struct Ai {
    pub enabled: bool,
    pub order: Vec<String>,
    pub classes: Vec<String>,
    pub cui_classes: Vec<String>,
    pub default_class: String,
    pub frontier_classes: Vec<String>,
    pub redact_for_frontier: Vec<String>,
    pub access: String,
    pub asksage_only: bool,
    pub models_allowed: Vec<String>,
    pub models_denied: Vec<String>,
    pub deadline_search: u64,
    pub deadline_catch_up: u64,
    pub usd_month: u64,
    pub usd_user_day: u64,
    pub map_sha256: String,
}

fn strings(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default()
}

impl Ai {
    pub fn read(policy: &Obj) -> Result<Ai, String> {
        let ai = policy.get("ai").and_then(Value::as_object).ok_or("this organization's policy has no ai key, so org AI is off")?;
        let models = ai.get("models");
        Ok(Ai {
            enabled: ai.get("enabled").and_then(Value::as_bool).unwrap_or(false),
            order: strings(ai.get("order")),
            classes: strings(ai.get("classes")),
            cui_classes: strings(ai.get("cui_classes")),
            default_class: ai.get("default_class").and_then(Value::as_str).unwrap_or_default().to_string(),
            frontier_classes: strings(ai.get("frontier_classes")),
            redact_for_frontier: strings(ai.get("redact_for_frontier")),
            access: ai.get("frontier").and_then(|f| f.get("access")).and_then(Value::as_str).unwrap_or("none").to_string(),
            asksage_only: models.and_then(|m| m.get("asksageOnly")).and_then(Value::as_bool).unwrap_or(false),
            models_allowed: strings(models.and_then(|m| m.get("allowed"))),
            models_denied: strings(models.and_then(|m| m.get("denied"))),
            deadline_search: ai.get("deadlines_ms").and_then(|d| d.get("search")).and_then(Value::as_u64).unwrap_or(0),
            deadline_catch_up: ai.get("deadlines_ms").and_then(|d| d.get("catch_up")).and_then(Value::as_u64).unwrap_or(0),
            usd_month: ai.get("budgets").and_then(|b| b.get("frontier_usd_month")).and_then(Value::as_u64).unwrap_or(0),
            usd_user_day: ai.get("budgets").and_then(|b| b.get("frontier_usd_user_day")).and_then(Value::as_u64).unwrap_or(0),
            map_sha256: ai.get("map_sha256").and_then(Value::as_str).unwrap_or_default().to_string(),
        })
    }

    /// The position of a class in `classes` (its sensitivity), None for a label outside them.
    pub fn rank(&self, class: &str) -> Option<usize> {
        self.classes.iter().position(|c| c == class)
    }

    pub fn deadline(&self, key: &str) -> u64 {
        if key == "search" {
            self.deadline_search
        } else {
            self.deadline_catch_up
        }
    }
}

/// One gateway entry of the map.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GatewayEntry {
    pub url: String,
    pub principal: String,
    pub device: String,
    pub spki: String,
}

/// What the gateway reads from the AI map (checked by `check_ai_map` against its policy).
#[derive(Clone, Debug, Default)]
pub struct AiMap {
    pub org: String,
    pub seq: i64,
    pub gateways: Vec<GatewayEntry>,
    pub channel_classes: HashMap<String, String>,
    pub excluded: HashSet<String>,
}

impl AiMap {
    pub fn read(map: &Value) -> AiMap {
        let s = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
        AiMap {
            org: s(map, "org"),
            seq: map.get("seq").and_then(Value::as_i64).unwrap_or(0),
            gateways: map.get("gateways").and_then(Value::as_array).into_iter().flatten().map(|g| GatewayEntry { url: s(g, "url"), principal: s(g, "principal"), device: s(g, "device"), spki: s(g, "spki") }).collect(),
            channel_classes: map.get("channel_classes").and_then(Value::as_object).map(|o| o.iter().filter_map(|(k, v)| v.as_str().map(|c| (k.clone(), c.to_string()))).collect()).unwrap_or_default(),
            excluded: strings(map.get("excluded_channels")).into_iter().collect(),
        }
    }
}

/// One verified (policy, map) pair.
#[derive(Clone, Debug)]
pub struct Pair {
    pub policy_hash: String,
    pub policy: Obj,
    pub policy_seq: i64,
    pub expires: i64,
    pub ai: Ai,
    pub map: AiMap,
    /// The wires as fetched (kept on disk and re-verified at start): `{"policy": {signed}, "map": {signed},
    /// "signer_policy": {...}}`.
    pub wires: Value,
}

impl Pair {
    /// A pair from objects that were already verified (tests build pairs from unsigned objects this way).
    pub fn from_parts(policy_hash: &str, policy: Obj, map: &Value, wires: Value) -> Result<Pair, String> {
        let ai = Ai::read(&policy)?;
        Ok(Pair {
            policy_hash: policy_hash.to_string(),
            policy_seq: policy.get("seq").and_then(Value::as_i64).unwrap_or(0),
            expires: policy.get("expires").and_then(Value::as_i64).unwrap_or(0),
            ai,
            map: AiMap::read(map),
            policy,
            wires,
        })
    }

    /// True when the principal's domain is one of the policy's (`covered`).
    pub fn covers(&self, principal: &str) -> bool {
        op::covers(&self.policy, principal)
    }

    /// Whether this gateway (principal and device) is one of the map's gateways.
    pub fn lists_gateway(&self, principal: &str, device: &str) -> bool {
        self.map.gateways.iter().any(|g| g.principal == principal && g.device == device)
    }
}

/// What the gateway trusts: the org CA root, the signer's previous intermediate serial, and the root's CRL.
pub struct Trust<'a> {
    pub roots: &'a [Cert],
    pub crls: &'a [Crl],
    pub previous_serial: &'a str,
}

impl Trust<'_> {
    /// The root that signed this signer policy, and that root's current CRL.
    fn root_for(&self, signer_policy: &Obj) -> Option<(&Cert, Option<&Crl>)> {
        let root = self.roots.iter().find(|r| op::verify_signer_policy(r, signer_policy))?;
        let crl = self.crls.iter().filter(|c| c.issuer == root.subject && c.signature_valid(&root.spki)).max_by_key(|c| c.this_update);
        Some((root, crl))
    }
}

/// 6.2: verify a policy and the map it names as a device does: the policy (`verify`), not expired, of `org`, with an
/// `ai` key; the map (`verify_ai_map`) whose signed-bytes hash is the policy's `map_sha256`, its fields against the
/// policy (`check_ai_map`); and this gateway listed in the map.
pub fn verify_pair(wires: &Value, trust: &Trust, org: &str, me: (&str, &str), now: f64) -> Result<Pair, String> {
    let signer_policy = wires.get("signer_policy").and_then(Value::as_object).ok_or("the relay sent no signer policy")?;
    let (root, root_crl) = trust.root_for(signer_policy).ok_or("the signer policy is not signed by this organization's root")?;
    let pol = op::verify(&wires["policy"], root, signer_policy, root_crl, trust.previous_serial, now).map_err(|e| format!("the org policy does not verify: {e}"))?;
    if pol.org != org {
        return Err(format!("the relay sent the policy of {}, not {org}", pol.org));
    }
    if op::expired(&pol.policy, now) {
        return Err("the org policy has expired".into());
    }
    let m = op::verify_ai_map(&wires["map"], root, signer_policy, root_crl, trust.previous_serial, now, Some(&pol.policy)).map_err(|e| format!("the AI map does not verify: {e}"))?;
    op::check_ai_map_named(&pol.policy, &m.hash).map_err(|e| format!("the AI map is not the one the policy names: {e}"))?;
    let map = m.wire.get("map").cloned().unwrap_or(Value::Null);
    let pair = Pair::from_parts(&pol.hash, pol.policy, &map, wires.clone())?;
    if !pair.lists_gateway(me.0, me.1) {
        return Err("this gateway is not in the organization's AI map".into());
    }
    Ok(pair)
}

struct Pinned {
    pair: Pair,
    pinned_ms: i64,
}

#[derive(Default)]
struct PinState {
    current: Option<Pinned>,
    previous: Option<Pair>,
}

/// The pinned pairs: the current one (and when it was pinned) and the one before it.
pub struct Pins {
    path: Option<PathBuf>,
    st: Mutex<PinState>,
}

/// Why a request's policy hash is not taken (409 `unverified`).
pub const UNVERIFIED: &str = "the AI gateway does not hold that policy; refresh the organization's policy and ask again";
pub const NO_POLICY: &str = "the AI gateway has no verified policy for its organization";

impl Pins {
    /// Pins from `pins.json`, each pair re-verified with `verify` (one that no longer verifies is dropped).
    pub fn open(path: Option<PathBuf>, verify: &dyn Fn(&Value) -> Result<Pair, String>) -> Pins {
        let mut st = PinState::default();
        if let Some(v) = path.as_ref().and_then(|p| std::fs::read(p).ok()).and_then(|b| serde_json::from_slice::<Value>(&b).ok()) {
            if let Ok(pair) = verify(&v["current"]["wires"]) {
                st.current = Some(Pinned { pair, pinned_ms: v["current"]["pinned_ms"].as_i64().unwrap_or(0) });
                st.previous = verify(&v["previous"]["wires"]).ok();
            }
        }
        Pins { path, st: Mutex::new(st) }
    }

    fn save(&self, current: &Pinned, previous: Option<&Pair>) -> std::io::Result<()> {
        let Some(p) = &self.path else { return Ok(()) };
        let v = json!({
            "current": {"wires": current.pair.wires, "pinned_ms": current.pinned_ms},
            "previous": previous.map(|p| json!({"wires": p.wires})).unwrap_or(Value::Null),
        });
        crate::meet_tls::write_atomic(p, v.to_string().as_bytes())
    }

    /// Pin a newly verified pair: the same policy changes nothing; a lower policy or map `seq` (or the same policy
    /// `seq` with other bytes) is refused; otherwise the current pair becomes the previous one and the window starts.
    /// The new pins are written to `pins.json` before they are taken: when they cannot be, Err and nothing changes
    /// (a restart must never return to an older policy than the one in force).
    pub fn pin(&self, pair: Pair, now_ms: i64) -> Result<bool, String> {
        let mut st = self.st.lock();
        if let Some(cur) = &st.current {
            if cur.pair.policy_hash == pair.policy_hash {
                return Ok(false);
            }
            if pair.policy_seq <= cur.pair.policy_seq {
                return Err(format!("the relay's policy seq {} is not higher than the pinned {}", pair.policy_seq, cur.pair.policy_seq));
            }
            if pair.map.seq < cur.pair.map.seq {
                return Err(format!("the relay's AI map seq {} is lower than the pinned {}", pair.map.seq, cur.pair.map.seq));
            }
        }
        let next = Pinned { pair, pinned_ms: now_ms };
        self.save(&next, st.current.as_ref().map(|c| &c.pair)).map_err(|e| format!("cannot keep the pinned policy: {e}"))?;
        st.previous = st.current.take().map(|c| c.pair);
        st.current = Some(next);
        Ok(true)
    }

    /// 6.2: the pairs a request under `hash` must pass. Outside the window only the current pair, and only for its
    /// own hash. Inside the window (the previous pair still unexpired) a request under either hash must pass both.
    /// Err is the refusal: no current pair or an expired one (`unverified` for everyone), or an unknown hash.
    pub fn pairs_for(&self, hash: &str, now_ms: i64) -> Result<Vec<Pair>, &'static str> {
        let st = self.st.lock();
        let cur = st.current.as_ref().ok_or(NO_POLICY)?;
        if cur.pair.expires * 1000 <= now_ms {
            return Err(NO_POLICY);
        }
        let prev = st.previous.as_ref().filter(|p| now_ms < cur.pinned_ms + WINDOW_MS && p.expires * 1000 > now_ms);
        match prev {
            Some(p) if hash == cur.pair.policy_hash || hash == p.policy_hash => Ok(vec![p.clone(), cur.pair.clone()]),
            None if hash == cur.pair.policy_hash => Ok(vec![cur.pair.clone()]),
            _ => Err(UNVERIFIED),
        }
    }

    /// The current pair (usage, budgets, estimate).
    pub fn current(&self) -> Option<Pair> {
        self.st.lock().current.as_ref().map(|c| c.pair.clone())
    }
}

/// 6.4: `allowed` answers of the relay, kept at most 5 minutes.
#[derive(Default)]
pub struct WhoCache {
    m: Mutex<HashMap<String, (bool, i64)>>,
}

impl WhoCache {
    pub fn get(&self, principal: &str, now_ms: i64) -> Option<bool> {
        self.m.lock().get(principal).filter(|(_, at)| now_ms - at < WHO_TTL_MS).map(|(a, _)| *a)
    }

    pub fn put(&self, principal: &str, allowed: bool, now_ms: i64) {
        let mut m = self.m.lock();
        m.retain(|_, (_, at)| now_ms - *at < WHO_TTL_MS);
        m.insert(principal.to_string(), (allowed, now_ms));
    }

    /// A new pin can remove people (6.4): every cached answer is asked again.
    pub fn clear(&self) {
        self.m.lock().clear();
    }
}

#[cfg(test)]
pub(crate) mod testpairs {
    use super::*;

    /// An unsigned policy with an `ai` key: classes public < internal < confidential < cui, `order`, frontier access.
    pub fn policy(seq: i64, order: &[&str], access: &str, frontier_classes: &[&str], redact: &[&str]) -> Obj {
        let mut ai = json!({
            "v": 1, "enabled": true, "who": {"groups": []}, "order": order,
            "classes": ["public", "internal", "confidential", "cui"], "cui_classes": ["cui"],
            "default_class": "internal", "frontier_classes": frontier_classes, "redact_for_frontier": redact,
            "frontier": {"access": access}, "models": {"asksageOnly": false, "allowed": [], "denied": [], "lock": false},
            "deadlines_ms": {"search": 20000, "catch_up": 60000},
            "budgets": {"frontier_usd_month": 2000, "frontier_usd_user_day": 5},
            "map_sha256": "cd".repeat(32),
        });
        if access == "either" || access == "personal" {
            ai["frontier"]["personal"] = json!({"api_keys": true, "oauth": false, "providers": ["anthropic"], "classes": ["public"], "plans": "business"});
        }
        let p = json!({"v": 1, "org": "acme", "label": "Acme", "domains": ["acme.example"], "seq": seq, "issued": 1795000000, "expires": 1895000000, "ai": ai});
        p.as_object().unwrap().clone()
    }

    pub fn map(seq: i64, classes: &[(&str, &str)], excluded: &[&str]) -> Value {
        let cc: Obj = classes.iter().map(|(k, v)| (k.to_string(), Value::from(*v))).collect();
        json!({"v": 1, "org": "acme", "seq": seq, "issued": 1795000000,
               "gateways": [{"url": "https://ai.acme.example:8443", "principal": "ai@apps.acme.example", "device": "00112233445566ff", "spki": "ef".repeat(32)}],
               "channel_classes": cc, "excluded_channels": excluded})
    }

    pub fn pair(hash: &str, policy: Obj, map: Value) -> Pair {
        let wires = json!({"policy": policy.clone(), "map": map.clone()});
        Pair::from_parts(hash, policy, &map, wires).unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::testpairs::*;
    use super::*;

    #[test]
    fn the_ai_key_reads() {
        let p = pair(&"01".repeat(32), policy(3, &["org", "device", "frontier"], "org", &["public", "internal"], &["internal"]), map(1, &[("ch:a", "confidential")], &["ch:x"]));
        assert_eq!((p.ai.rank("confidential"), p.ai.deadline("search"), p.ai.access.as_str()), (Some(2), 20000, "org"));
        assert_eq!(p.map.channel_classes.get("ch:a").map(String::as_str), Some("confidential"));
        assert!(p.map.excluded.contains("ch:x"));
        assert!(p.covers("ann@acme.example") && !p.covers("eve@other.example"));
        assert!(p.lists_gateway("ai@apps.acme.example", "00112233445566ff"));
    }

    /// 6.2: inside the window both hashes are taken and every request is checked under both pairs; after it only the
    /// new hash; a lower seq is refused; a restart inside the window keeps both pairs.
    #[test]
    fn the_window_keeps_both_pairs_for_ten_minutes_and_across_a_restart() {
        let dir = crate::meet_tls::testpki::dir("ai-pins");
        let path = dir.join("pins.json");
        let (old_hash, new_hash) = ("01".repeat(32), "02".repeat(32));
        let old = pair(&old_hash, policy(3, &["org"], "none", &[], &[]), map(1, &[], &[]));
        let new = pair(&new_hash, policy(4, &["org"], "none", &[], &[]), map(2, &[], &[]));
        let reread = |v: &Value| -> Result<Pair, String> {
            let p = v["policy"].as_object().ok_or("none")?.clone();
            let hash = if p["seq"] == 3 { "01".repeat(32) } else { "02".repeat(32) };
            Ok(pair(&hash, p, v["map"].clone()))
        };
        let pins = Pins::open(Some(path.clone()), &reread);
        let t = 1_795_000_000_000;
        assert_eq!(pins.pairs_for(&old_hash, t).unwrap_err(), NO_POLICY);
        assert!(pins.pin(old, t).unwrap());
        assert_eq!(pins.pairs_for(&old_hash, t).unwrap().len(), 1);
        assert!(pins.pin(new.clone(), t + 1000).unwrap());
        assert!(!pins.pin(new, t + 2000).unwrap());
        let both = pins.pairs_for(&old_hash, t + 1000 + WINDOW_MS - 1).unwrap();
        assert_eq!(both.iter().map(|p| p.policy_seq).collect::<Vec<_>>(), [3, 4]);
        assert_eq!(pins.pairs_for(&new_hash, t + 5000).unwrap().len(), 2);
        // restart inside the window
        let again = Pins::open(Some(path), &reread);
        assert_eq!(again.pairs_for(&old_hash, t + 60_000).unwrap().len(), 2);
        // after the window
        assert_eq!(again.pairs_for(&old_hash, t + 1000 + WINDOW_MS).unwrap_err(), UNVERIFIED);
        assert_eq!(again.pairs_for(&new_hash, t + 1000 + WINDOW_MS).unwrap().len(), 1);
        assert_eq!(again.pairs_for(&"03".repeat(32), t).unwrap_err(), UNVERIFIED);
        // rollback
        let lower = pair(&"04".repeat(32), policy(4, &["org"], "none", &[], &[]), map(3, &[], &[]));
        assert!(again.pin(lower, t + 3000).is_err());
    }

    /// A pin that cannot be written to `pins.json` is refused and changes nothing, so the gateway never serves a policy
    /// a restart would forget.
    #[test]
    fn a_pin_that_cannot_be_kept_is_refused_and_changes_nothing() {
        let dir = crate::meet_tls::testpki::dir("ai-pins-unsaved");
        let blocked = dir.join("blocked");
        let path = blocked.join("pins.json");
        let (old_hash, new_hash) = ("01".repeat(32), "02".repeat(32));
        let old = pair(&old_hash, policy(3, &["org"], "none", &[], &[]), map(1, &[], &[]));
        let new = pair(&new_hash, policy(4, &["org"], "none", &[], &[]), map(2, &[], &[]));
        let reread = |v: &Value| -> Result<Pair, String> {
            let p = v["policy"].as_object().ok_or("none")?.clone();
            let hash = if p["seq"] == 3 { "01".repeat(32) } else { "02".repeat(32) };
            Ok(pair(&hash, p, v["map"].clone()))
        };
        let pins = Pins::open(Some(path.clone()), &reread);
        let t = 1_795_000_000_000;
        assert!(pins.pin(old, t).unwrap());
        // a file where the folder was: the next pin cannot be written
        std::fs::remove_dir_all(&blocked).unwrap();
        std::fs::write(&blocked, b"not a folder").unwrap();
        assert!(pins.pin(new.clone(), t + 1000).is_err());
        assert_eq!(pins.pairs_for(&old_hash, t + 2000).unwrap().len(), 1);
        assert_eq!(pins.pairs_for(&new_hash, t + 2000).unwrap_err(), UNVERIFIED);
        // writable again: the same pin is taken and survives a restart
        std::fs::remove_file(&blocked).unwrap();
        assert!(pins.pin(new, t + 3000).unwrap());
        assert_eq!(Pins::open(Some(path), &reread).pairs_for(&new_hash, t + 4000).unwrap().len(), 2);
    }

    #[test]
    fn who_answers_last_five_minutes() {
        let w = WhoCache::default();
        w.put("ann@acme.example", true, 0);
        assert_eq!(w.get("ann@acme.example", WHO_TTL_MS - 1), Some(true));
        assert_eq!(w.get("ann@acme.example", WHO_TTL_MS), None);
    }
}
