// The Admin Console's Settings > AI (contract AI-1 section 9, slice AI-1e) for the Meeting Hub section: the presets and
// Advanced (every field of 1.2 and 2), who may use AI (`who.groups` and the map's `who_principals`), the staged save
// (AC-1) signed by the admin's own device as an AC-1 request (3.8), the AI map first and then the policy naming its
// hash (SD-1 order); gateway enrollment and model cards (Run benchmark, Approve only after a pass); usage with the 80%
// budget warning and the gateway `rid`s missing from the archive (7.3); the legal hold that a reviewer signs and that
// is placed on the relay and on the archive together (7.5); and the archive section by organization size (1.5, 7.8).
//
// The console holds no device key, so every signature (the map, the policy, a reviewer's archive request) is asked of
// a device through the requests store and observed by the relay before anything counts as done.

use crate::console::ApiError;
use crate::console_audit::canonical_json;
use crate::codec::sha256_hex;
use serde_json::{json, Map, Value};
use std::collections::HashSet;

// ── words (contract AI-1, verbatim) ──────────────────────────────────────────────────────────────────────────

pub const ADVANCED: &str = "Advanced";
pub const PLACE_HOLD: &str = "Place a legal hold";
pub const ADD_ARCHIVE: &str = "Add an archive";
pub const RECOVERABLE: &str = "Recoverable";
pub const NOT_TESTED: &str = "Not tested";
pub const NO_OFFLINE_COPY: &str = "No offline copy. Legal holds depend on restoring this archive server from your own backups.";
pub const NO_ARCHIVE: &str = "No archive. AI history stays on each person's devices; a legal hold cannot retrieve it.";

// ── console words (not given by the contract) ─────────────────────────────────────────────────────────────────

pub const APPROVE_AFTER_PASS: &str = "Run the benchmark first. A card can be approved only after it passes.";
pub const STAGE_GONE: &str = "These AI settings are no longer staged. Review them again.";
pub const STAGE_MOVED: &str = "Nothing was changed: the policy or the AI map changed since these settings were staged.";
pub const MAP_NOT_STORED: &str = "The relay does not hold the signed AI map yet, so the policy is not signed.";
pub const POLICY_OTHER_MAP: &str = "The signed policy does not name the staged AI map.";
pub const BUDGET_WARNING: &str = "AI spend has reached 80% of this month's budget.";
pub const CODE_WRONG: &str = "Those groups do not match the recovery code. Check them and try again.";
pub const REMOVED_REVIEWER: &str = "A removed reviewer's share still opens copies made before the change.";

// ── presets (9) ──────────────────────────────────────────────────────────────────────────────────────────────

pub struct Preset {
    pub id: &'static str,
    pub label: &'static str,
    pub order: &'static [&'static str],
    pub access: &'static str,
}

/// The three presets of section 9. The contract names `access` only for "This computer only"; the other two use
/// `org` (the gateway's frontier cards, no personal accounts), the safest access that still serves `frontier`.
pub const PRESETS: [Preset; 3] = [
    Preset { id: "device", label: "This computer only", order: &["device"], access: "none" },
    Preset { id: "org-first", label: "Org servers first", order: &["org", "device", "frontier"], access: "org" },
    Preset { id: "device-org-frontier", label: "This computer, then org servers, then frontier", order: &["device", "org", "frontier"], access: "org" },
];
pub const DEFAULT_PRESET: &str = "device-org-frontier";
pub const ADVANCED_ID: &str = "advanced";

pub fn preset(id: &str) -> Option<&'static Preset> {
    PRESETS.iter().find(|p| p.id == id)
}

/// The preset an `ai` key matches, else "advanced".
pub fn preset_of(ai: &Value) -> &'static str {
    let order: Vec<&str> = ai.get("order").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
    let access = ai.get("frontier").and_then(|f| f.get("access")).and_then(Value::as_str).unwrap_or("");
    PRESETS.iter().find(|p| p.order == order.as_slice() && p.access == access).map_or(ADVANCED_ID, |p| p.id)
}

/// Every key of the `ai` object (1.2), with `local_mcp` (API-1c 10.6, the Settings > AI Local MCP card).
pub const AI_KEYS: [&str; 18] = [
    "v", "enabled", "who", "order", "classes", "cui_classes", "default_class", "frontier_classes", "redact_for_frontier", "frontier", "models",
    "device_models", "embedding", "deadlines_ms", "budgets", "org_index", "map_sha256", "local_mcp",
];
/// Every key a console draft may give of the AI map (2); `v`, `org`, `seq` and `issued` are the console's.
pub const MAP_DRAFT_KEYS: [&str; 4] = ["gateways", "channel_classes", "excluded_channels", "who_principals"];
/// The optional AI map keys of r6 8.1, carried only when present (a map without them is byte-identical to before).
pub const MAP_MCP_KEYS: [&str; 2] = ["mcp_servers", "mcp_cleared"];

fn invalid(words: impl Into<String>) -> ApiError {
    ApiError::with("invalid", words)
}

/// A fresh `ai` key: org AI on, nobody allowed yet, the default preset, no org frontier spend.
pub fn default_ai() -> Value {
    json!({
        "v": 1, "enabled": true, "who": {"groups": []}, "order": ["device", "org", "frontier"],
        "classes": ["public", "internal", "confidential"], "cui_classes": [], "default_class": "internal",
        "frontier_classes": ["public"], "redact_for_frontier": [], "frontier": {"access": "org"},
        "models": {"asksageOnly": false, "allowed": [], "denied": [], "lock": false}, "device_models": {"allow_digests": []},
        "deadlines_ms": {"search": 20000, "catch_up": 60000}, "budgets": {"frontier_usd_month": 0, "frontier_usd_user_day": 0},
        "org_index": false,
    })
}

/// The `ai` key a draft asks for: the current key (or `default_ai`), the Advanced fields over it, then the preset's
/// `order` and `frontier.access` (a preset other than Advanced wins over Advanced's order and access). `personal` is
/// dropped when the access does not use it (1.2 refuses it there). `map_sha256` is set at staging.
pub fn ai_of(current: Option<&Value>, draft: &Value) -> Result<Value, ApiError> {
    let mut ai = current.filter(|v| v.is_object()).cloned().unwrap_or_else(default_ai);
    let o = ai.as_object_mut().ok_or_else(|| invalid("ai is an object."))?;
    if let Some(fields) = draft.get("ai") {
        let fields = fields.as_object().ok_or_else(|| invalid("ai is an object."))?;
        for (k, v) in fields {
            if !AI_KEYS.contains(&k.as_str()) || k == "map_sha256" {
                return Err(ApiError::with("unknown-field", format!("Unknown field: ai.{}.", crate::console_spokes::clean(k))));
            }
            o.insert(k.clone(), v.clone());
        }
    }
    let id = draft.get("preset").and_then(Value::as_str).unwrap_or(ADVANCED_ID);
    if id != ADVANCED_ID {
        let p = preset(id).ok_or_else(|| invalid("preset is device, org-first, device-org-frontier or advanced."))?;
        o.insert("order".into(), json!(p.order));
        let frontier = o.entry("frontier").or_insert_with(|| json!({}));
        if let Some(f) = frontier.as_object_mut() {
            f.insert("access".into(), Value::from(p.access));
        }
    }
    let access = o.get("frontier").and_then(|f| f.get("access")).and_then(Value::as_str).unwrap_or("").to_owned();
    if access == "none" || access == "org" {
        if let Some(f) = o.get_mut("frontier").and_then(Value::as_object_mut) {
            f.remove("personal");
        }
    }
    o.remove("map_sha256");
    Ok(ai)
}

/// The next AI map: the draft's fields over the current map's, `seq` one above the current, `issued` now (seconds).
pub fn map_of(org: &str, current: Option<&Value>, draft: &Value, t_ms: i64) -> Result<Value, ApiError> {
    let mut map = Map::new();
    for k in MAP_DRAFT_KEYS {
        let empty = if k == "channel_classes" { json!({}) } else { json!([]) };
        map.insert(k.into(), current.and_then(|c| c.get(k)).cloned().unwrap_or(empty));
    }
    for k in MAP_MCP_KEYS {
        if let Some(v) = current.and_then(|c| c.get(k)) {
            map.insert(k.into(), v.clone());
        }
    }
    if let Some(fields) = draft.get("map") {
        let fields = fields.as_object().ok_or_else(|| invalid("map is an object."))?;
        for (k, v) in fields {
            if !MAP_DRAFT_KEYS.contains(&k.as_str()) && !MAP_MCP_KEYS.contains(&k.as_str()) {
                return Err(ApiError::with("unknown-field", format!("Unknown field: map.{}.", crate::console_spokes::clean(k))));
            }
            map.insert(k.clone(), v.clone());
        }
    }
    let seq = current.and_then(|c| c.get("seq")).and_then(Value::as_i64).unwrap_or(0) + 1;
    map.insert("v".into(), Value::from(1));
    map.insert("org".into(), Value::from(org));
    map.insert("seq".into(), Value::from(seq));
    map.insert("issued".into(), Value::from(t_ms.div_euclid(1000)));
    Ok(Value::Object(map))
}

/// SHA-256 of the AI map's signed bytes (2), the hash the policy names.
pub fn map_sha256(map: &Value) -> Result<String, ApiError> {
    let o = map.as_object().ok_or_else(|| invalid("map is an object."))?;
    Ok(crate::meet_org_policy::ai_map_hash(o))
}

// ── the staged save (AC-1) ───────────────────────────────────────────────────────────────────────────────────

/// A staged change lives 30 minutes; a save takes it only while the policy and map it was built on are current.
pub const STAGE_MS: i64 = 30 * 60_000;
pub const STAGES_MAX: usize = 20;

#[derive(Clone, Debug, PartialEq)]
pub struct Staged {
    pub id: String,
    pub org: String,
    pub by: String,
    pub at: i64,
    /// The seq of the policy and of the map this was built on (0 for none).
    pub base: (i64, i64),
    pub map: Value,
    /// The whole unsigned policy, its `ai.map_sha256` naming `map`.
    pub policy: Value,
    pub map_sha256: String,
}

impl Staged {
    pub fn view(&self) -> Value {
        json!({
            "id": self.id, "org": self.org, "by": self.by, "at": self.at, "expires": self.at + STAGE_MS,
            "map": self.map, "ai": self.policy.get("ai"), "map_sha256": self.map_sha256,
            "preset": self.policy.get("ai").map(preset_of),
        })
    }
}

/// Build a staged change: the policy is `current_policy` with `ai` replaced and `seq` one higher; `check` is the
/// relay's own validation (check_policy, check_ai_map, the client and edition gates), whose words refuse it.
#[allow(clippy::too_many_arguments)]
pub fn stage(org: &str, by: &str, current_policy: &Value, current_map: Option<&Value>, draft: &Value, t: i64, check: &dyn Fn(&Value, &Value) -> Result<(), String>) -> Result<Staged, ApiError> {
    let policy_obj = current_policy.as_object().ok_or_else(|| ApiError::with("stale", "Nothing was changed: this organization has no signed policy on this relay."))?;
    let mut ai = ai_of(policy_obj.get("ai"), draft)?;
    let map = map_of(org, current_map, draft, t)?;
    let hash = map_sha256(&map)?;
    ai["map_sha256"] = Value::from(hash.as_str());
    let mut policy = policy_obj.clone();
    let base_seq = policy.get("seq").and_then(Value::as_i64).unwrap_or(0);
    policy.insert("seq".into(), Value::from(base_seq + 1));
    policy.insert("issued".into(), Value::from(t.div_euclid(1000)));
    policy.insert("ai".into(), ai);
    let policy = Value::Object(policy);
    check(&policy, &map).map_err(invalid)?;
    let base_map = current_map.and_then(|m| m.get("seq")).and_then(Value::as_i64).unwrap_or(0);
    let digest = sha256_hex(&canonical_json(&json!({"policy": policy, "map": map})).map_err(invalid)?);
    Ok(Staged { id: format!("st_{}", &digest[..16]), org: org.into(), by: by.into(), at: t, base: (base_seq, base_map), map, policy, map_sha256: hash })
}

/// The staged changes of this console (memory only: a restart drops them, as a staged email setting).
#[derive(Default)]
pub struct Stages {
    list: Vec<Staged>,
}

impl Stages {
    pub fn put(&mut self, s: Staged, t: i64) -> Value {
        self.list.retain(|x| t - x.at < STAGE_MS && x.id != s.id && x.org != s.org);
        if self.list.len() >= STAGES_MAX {
            self.list.remove(0);
        }
        let v = s.view();
        self.list.push(s);
        v
    }

    pub fn get(&self, org: &str, t: i64) -> Option<&Staged> {
        self.list.iter().find(|s| s.org == org && t - s.at < STAGE_MS)
    }

    /// Take `id` for saving: gone when past 30 minutes or replaced; stale when the policy or the map moved on.
    pub fn take(&mut self, id: &str, org: &str, now_base: (i64, i64), t: i64) -> Result<Staged, ApiError> {
        let i = self.list.iter().position(|s| s.id == id && s.org == org && t - s.at < STAGE_MS).ok_or_else(|| ApiError::with("gone", STAGE_GONE))?;
        if self.list[i].base != now_base {
            self.list.remove(i);
            return Err(ApiError::with("stale", STAGE_MOVED));
        }
        Ok(self.list.remove(i))
    }
}

// ── signing: the AI map first, then the policy naming its hash ───────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SignStep {
    Map,
    Policy,
    Done,
}

impl SignStep {
    pub fn as_str(self) -> &'static str {
        match self {
            SignStep::Map => "map",
            SignStep::Policy => "policy",
            SignStep::Done => "done",
        }
    }
}

/// The `meet.ai.sign` request target for `step` of a save by `principal`: the map step carries only the map; the
/// policy step carries only the policy (naming the map's hash). Nothing for `Done`.
pub fn sign_target(s: &Staged, principal: &str, step: SignStep) -> Option<Value> {
    match step {
        SignStep::Map => Some(json!({"principal": principal, "org": s.org, "step": "map", "op": "sign_org_ai", "map": s.map, "map_sha256": s.map_sha256})),
        SignStep::Policy => Some(json!({"principal": principal, "org": s.org, "step": "policy", "op": "sign_org_policy", "policy": s.policy, "map_sha256": s.map_sha256})),
        SignStep::Done => None,
    }
}

/// What the relay holds after a device reported a step signed.
pub struct Observed {
    /// The stored AI map with the staged hash exists.
    pub map_stored: bool,
    /// The current policy's `ai.map_sha256` and `seq`, when the org has a policy.
    pub policy: Option<(String, i64)>,
}

/// The next step after a device reported `step` signed, judged only by what the relay holds: the policy is asked
/// for only after the map with the staged hash is stored, and the save is done only when the current policy names
/// that hash at a newer seq.
pub fn after_signed(s: &Staged, step: SignStep, seen: &Observed) -> Result<SignStep, ApiError> {
    match step {
        SignStep::Map if seen.map_stored => Ok(SignStep::Policy),
        SignStep::Map => Err(ApiError::with("stale", MAP_NOT_STORED)),
        SignStep::Policy => match &seen.policy {
            Some((hash, seq)) if *hash == s.map_sha256 && *seq > s.base.0 => Ok(SignStep::Done),
            _ => Err(ApiError::with("stale", POLICY_OTHER_MAP)),
        },
        SignStep::Done => Ok(SignStep::Done),
    }
}

// ── gateways and model cards (3.1, 3.2) ──────────────────────────────────────────────────────────────────────

/// A gateway the console enrolled for an org: the AI map's `gateways` entry (2).
pub fn gateway_of(body: &Value) -> Result<Value, ApiError> {
    let s = |k: &str| body.get(k).and_then(Value::as_str).unwrap_or("").trim().to_owned();
    let (url, principal, device, spki, region) = (s("url"), s("principal").to_lowercase(), s("device").to_lowercase(), s("spki").to_lowercase(), s("region"));
    if url.len() > 256 || endpoint(&url).is_none() {
        return Err(invalid("url is https:// with a host and a port, at most 256 characters."));
    }
    if !principal.starts_with("ai@apps.") {
        return Err(invalid("principal is ai@apps.<domain>."));
    }
    if device.len() != 16 || !device.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err(invalid("device is 16 hex digits."));
    }
    if !hex64(&spki) {
        return Err(invalid("spki is the SHA-256 of the gateway's public key, 64 hex digits."));
    }
    let mut g = json!({"url": url, "principal": principal, "device": device, "spki": spki});
    if !region.is_empty() {
        if region.len() > 32 || !region.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-') {
            return Err(invalid("region is 1 to 32 of a-z, 0-9 and -."));
        }
        g["region"] = Value::from(region);
    }
    Ok(g)
}

pub fn hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

/// `https://host:port[/...]` -> (host, port); a port is required.
pub fn endpoint(url: &str) -> Option<(String, u16)> {
    let rest = url.strip_prefix("https://")?;
    let authority = rest.split(['/', '?', '#']).next()?;
    if authority.contains('@') {
        return None;
    }
    let (host, port) = if let Some(v6) = authority.strip_prefix('[') {
        let (h, after) = v6.split_once(']')?;
        (h, after.strip_prefix(':')?)
    } else {
        authority.rsplit_once(':')?
    };
    let port: u16 = port.parse().ok().filter(|p| *p > 0)?;
    (!host.is_empty()).then(|| (host.to_ascii_lowercase(), port))
}

/// Whether a gateway bench result (Gateway's `result`) is a pass by 3.2: the gateway's own verdict and, checked
/// again here, answers at least 85%, valid citations at least 95%, the digest ok when it was checked (org cards),
/// and prompt logging not reported on.
pub fn bench_passed(result: &Value) -> bool {
    let num = |v: Option<&Value>| v.and_then(Value::as_f64).unwrap_or(-1.0);
    let q = result.get("quality");
    let digest = result.get("digest");
    let digest_ok = digest.and_then(|d| d.get("checked")).and_then(Value::as_bool) != Some(true) || digest.and_then(|d| d.get("ok")).and_then(Value::as_bool) == Some(true);
    result.get("pass").and_then(Value::as_bool) == Some(true)
        && num(q.and_then(|q| q.get("answers_pct"))) >= 85.0
        && num(q.and_then(|q| q.get("citations_pct"))) >= 95.0
        && digest_ok
        && result.get("prompt_logging").and_then(Value::as_str) != Some("on")
}

/// Approve is refused before a passing benchmark: the card row (`{card, status, bench}`) must carry a passing result.
pub fn approve_allowed(row: &Value) -> Result<(), ApiError> {
    match row.get("bench").filter(|b| !b.is_null()) {
        Some(b) if bench_passed(b.get("result").filter(|r| !r.is_null()).unwrap_or(b)) => Ok(()),
        _ => Err(ApiError::with("stale", APPROVE_AFTER_PASS)),
    }
}

/// A card row as the page lists it (9): tier, precision, hardware, tested throughput, quality, status, `retire_after`,
/// and whether Approve is offered.
pub fn card_view(gateway: &str, row: &Value) -> Value {
    let card = row.get("card").cloned().unwrap_or(Value::Null);
    let pick = |k: &str| card.get(k).cloned().unwrap_or(Value::Null);
    let status = row.get("status").cloned().unwrap_or(Value::Null);
    json!({
        "gateway": gateway, "card_id": pick("card_id"), "tier": pick("tier"), "provider": pick("provider"), "model": pick("exact_model_id"),
        "precision": pick("precision"), "hardware": pick("hardware"), "throughput": pick("throughput"), "quality": card.get("quality").and_then(|q| q.get("lucid-ask")).cloned().unwrap_or(Value::Null),
        "status": status, "retire_after": pick("retire_after"), "bench": row.get("bench").cloned().unwrap_or(Value::Null),
        "approvable": approve_allowed(row).is_ok() && row.get("status").and_then(Value::as_str) != Some("approved"),
    })
}

// ── usage (9, 7.3) ───────────────────────────────────────────────────────────────────────────────────────────

/// The usage panel from every gateway's `usage` answer and the archive's `ai` rids (None: no archive or it did not
/// answer): requests, refusals by code, spend against the budgets with the 80% warning, card health, and the gateway
/// rids the archive does not hold.
pub fn usage_view(usages: &[Value], archive_rids: Option<&HashSet<String>>) -> Value {
    let mut requests = 0i64;
    let mut refusals: Map<String, Value> = Map::new();
    let (mut spent, mut month_limit, mut day_limit) = (0i64, 0i64, 0i64);
    let mut cards = Vec::new();
    let mut rids: Vec<String> = Vec::new();
    for u in usages {
        requests += u.get("requests").and_then(Value::as_i64).unwrap_or(0);
        for (code, n) in u.get("refusals").and_then(Value::as_object).into_iter().flatten() {
            let total = refusals.get(code).and_then(Value::as_i64).unwrap_or(0) + n.as_i64().unwrap_or(0);
            refusals.insert(code.clone(), Value::from(total));
        }
        let sp = u.get("spend");
        let int = |k: &str| sp.and_then(|s| s.get(k)).and_then(Value::as_i64).unwrap_or(0);
        spent += int("month_usd_micro");
        month_limit += int("month_limit_usd_micro");
        day_limit = day_limit.max(int("day_limit_usd_micro"));
        cards.extend(u.get("cards").and_then(Value::as_array).cloned().unwrap_or_default());
        rids.extend(u.get("rids").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_owned));
    }
    let warn = month_limit > 0 && spent * 100 >= month_limit * 80;
    let missing: Value = match archive_rids {
        Some(held) => {
            let mut m: Vec<String> = rids.into_iter().filter(|r| !held.contains(r)).collect();
            m.sort();
            m.dedup();
            json!(m)
        }
        None => Value::Null,
    };
    json!({
        "requests": requests, "refusals": refusals,
        "spend": {"month_usd_micro": spent, "month_limit_usd_micro": month_limit, "day_limit_usd_micro": day_limit, "warning": if warn { Value::from(BUDGET_WARNING) } else { Value::Null }},
        "cards": cards, "missing_rids": missing,
    })
}

/// The device audit records (6.6) the panel lists at most, newest last; the counts cover every record read.
pub const AUDIT_DROPPED_SHOWN: usize = 50;

/// The device audit part of the usage panel from the relay's 6.6 records (metadata only, no content exists in them):
/// personal-access requests by provider and method, business-plan answers per provider, tokens, and the
/// `ai_history_dropped` events by reason. A record of neither kind is counted as `other` and otherwise ignored.
pub fn audit_view(records: &[Value]) -> Value {
    let mut by_provider: Map<String, Value> = Map::new();
    let mut plans: Map<String, Value> = Map::new();
    let (mut requests, mut tokens_in, mut tokens_out, mut other) = (0i64, 0i64, 0i64, 0i64);
    let mut reasons: Map<String, Value> = Map::new();
    let mut dropped: Vec<Value> = Vec::new();
    let bump = |m: &mut Map<String, Value>, k: &str| {
        let n = m.get(k).and_then(Value::as_i64).unwrap_or(0) + 1;
        m.insert(k.to_owned(), Value::from(n));
    };
    for r in records {
        let s = |k: &str| r.get(k).and_then(Value::as_str).unwrap_or("");
        if s("event") == "ai_history_dropped" {
            bump(&mut reasons, s("reason"));
            dropped.push(json!({"rid": r.get("rid"), "ts": r.get("ts"), "reason": s("reason")}));
        } else if s("tier") == "personal" {
            requests += 1;
            let provider = s("provider");
            let method = if s("method") == "oauth" { "oauth" } else { "key" };
            let entry = by_provider.entry(provider.to_owned()).or_insert_with(|| json!({"key": 0, "oauth": 0}));
            if let Some(o) = entry.as_object_mut() {
                bump(o, method);
            }
            let plan = match s("plan") {
                p @ ("business" | "not_business") => p,
                _ => "unknown",
            };
            let p = plans.entry(provider.to_owned()).or_insert_with(|| json!({"business": 0, "not_business": 0, "unknown": 0}));
            if let Some(o) = p.as_object_mut() {
                bump(o, plan);
            }
            tokens_in += r.get("tokens_in").and_then(Value::as_i64).unwrap_or(0).max(0);
            tokens_out += r.get("tokens_out").and_then(Value::as_i64).unwrap_or(0).max(0);
        } else {
            other += 1;
        }
    }
    dropped.sort_by_key(|d| d.get("ts").and_then(Value::as_i64).unwrap_or(0));
    let total_dropped = dropped.len();
    let shown: Vec<Value> = dropped.split_off(total_dropped.saturating_sub(AUDIT_DROPPED_SHOWN));
    json!({
        "personal": {"requests": requests, "by_provider": by_provider, "plans": plans, "tokens_in": tokens_in, "tokens_out": tokens_out},
        "dropped": {"count": total_dropped, "by_reason": reasons, "latest": shown},
        "other": other,
    })
}

// ── legal hold on a person (7.5) ─────────────────────────────────────────────────────────────────────────────

pub const HOLD_LABEL: &str = "lucid-meet-archive-hold-v1";
pub const RECOVERY_CODE_LABEL: &str = "lucid-meet-archive-recovery-code-v1";
pub const CONFIG_LABEL: &str = "lucid-meet-archive-config-v1";
/// The archive refuses a request whose `ts` is more than 10 minutes from its clock.
pub const SIGN_WINDOW_S: i64 = 600;

/// The archive hold request a reviewer signs (without `ts` and `sig`, which the reviewer's device adds).
pub fn hold_body(principals: &[String], reason: &str, reviewer: &str) -> Value {
    json!({"op": "hold", "on": "people", "principals": principals, "reason": reason, "reviewer": reviewer})
}

/// The body as the archive receives it: the reviewer's `ts` (seconds, within 10 minutes of now) and `sig`.
pub fn signed_body(body: &Value, ts: i64, sig: &str, now_s: i64) -> Result<Value, ApiError> {
    if (now_s - ts).abs() > SIGN_WINDOW_S {
        return Err(ApiError::with("stale", "Nothing was changed: the reviewer's signature is older than 10 minutes. Ask again."));
    }
    if sig.is_empty() {
        return Err(invalid("sig is the reviewer's signature."));
    }
    let mut b = body.clone();
    b["ts"] = Value::from(ts);
    b["sig"] = Value::from(sig);
    Ok(b)
}

/// Placing both holds: the relay hold, then the archive hold. The hold counts as placed only when both succeeded; a
/// failed archive hold leaves the relay hold in place (a hold is never lifted by a failure) and says which part failed.
pub fn place_both(relay: impl FnOnce() -> Result<String, ApiError>, archive: impl FnOnce() -> Result<Value, ApiError>) -> Value {
    let r = relay();
    let a = if r.is_ok() { Some(archive()) } else { None };
    let placed = r.is_ok() && matches!(a, Some(Ok(_)));
    json!({
        "placed": placed,
        "relay": match &r { Ok(id) => json!({"ok": true, "id": id}), Err(e) => json!({"ok": false, "error": e.message}) },
        "archive": match &a { Some(Ok(v)) => json!({"ok": true, "ids": v.get("ids").cloned().unwrap_or(Value::Null)}), Some(Err(e)) => json!({"ok": false, "error": e.message}), None => Value::Null },
    })
}

// ── the archive section by organization size (1.5, 7.8) ─────────────────────────────────────────────────────

/// "Recoverable", "Not tested" or the no-offline-copy sentence, from the archive's `status`.
pub fn recoverable_words(status: &str) -> &'static str {
    match status {
        "Recoverable" => RECOVERABLE,
        "No offline copy" => NO_OFFLINE_COPY,
        _ => NOT_TESTED,
    }
}

/// What the edition gate (1.5) says the policy lacks for org AI, for the console to show before anyone signs (the
/// signer and the relay refuse the same; a license change to `enterprise` shows it at once).
pub fn edition_lacks(edition: Option<&str>, policy: &Value) -> Option<String> {
    let mut p = policy.as_object().cloned().unwrap_or_default();
    p.insert("ai".into(), json!({"enabled": true}));
    crate::meet_org_policy::ai_edition_gate(&p, edition).err()
}

/// The archive panel. `edition` from the license (anything but `standard`, or none, is big: 1.5), `status` the
/// archive's `GET /v1/recovery` answer (None when no archive is added or it did not answer), `archive_url` the
/// console's record.
pub fn archive_view(edition: Option<&str>, policy: &Value, archive_url: Option<&str>, status: Option<&Value>, code_confirmed_gen: Option<i64>) -> Value {
    let big = edition != Some("standard");
    let lacks = edition_lacks(edition, policy).map(Value::from).unwrap_or(Value::Null);
    let state = status.and_then(|s| s.get("status")).and_then(Value::as_str).map(recoverable_words);
    if big {
        return json!({
            "size": "big", "lacks": lacks, "archive": archive_url,
            "offline_copy": status.and_then(|s| s.get("offline_copy")).cloned().unwrap_or(Value::Null),
            "shares": status.and_then(|s| s.get("shares")).cloned().unwrap_or(json!([])),
            "reviewers": status.and_then(|s| s.get("reviewers")).cloned().unwrap_or_else(|| policy.get("archive_reviewers").cloned().unwrap_or(json!([]))),
            "state": state, "note": REMOVED_REVIEWER,
        });
    }
    let has_archive = archive_url.is_some() || policy.get("archive").is_some_and(|a| a.as_object().is_some_and(|o| !o.is_empty()));
    if !has_archive {
        return json!({"size": "small", "lacks": lacks, "archive": Value::Null, "add": ADD_ARCHIVE, "notice": NO_ARCHIVE});
    }
    let gen = status.and_then(|s| s.get("gen")).and_then(Value::as_i64);
    let code = match (status.and_then(|s| s.get("mode")).and_then(Value::as_str), gen) {
        (Some("code"), Some(g)) if code_confirmed_gen == Some(g) => "confirmed",
        (Some("code"), _) => "unconfirmed",
        _ => "none",
    };
    json!({"size": "small", "lacks": lacks, "archive": archive_url, "add": ADD_ARCHIVE, "recovery_code": code, "state": state})
}

// ── the recovery code (7.8, small organizations) ─────────────────────────────────────────────────────────────

/// A code the archive made, held only until its owner types back two groups.
#[derive(Clone, Debug)]
pub struct PendingCode {
    pub org: String,
    pub gen: i64,
    pub groups: Vec<String>,
    /// The two group positions (0-based) the owner types back.
    pub ask: (usize, usize),
    pub shown: bool,
}

/// The 13 groups of 4 of a code (`XXXX-XXXX-...`, spaces or hyphens), upper case; None unless 52 base32 characters.
pub fn code_groups(code: &str) -> Option<Vec<String>> {
    let chars: String = code.chars().filter(|c| !c.is_whitespace() && *c != '-').map(|c| c.to_ascii_uppercase()).collect();
    if chars.len() != 52 || !chars.bytes().all(|c| c.is_ascii_uppercase() || (b'2'..=b'7').contains(&c)) {
        return None;
    }
    Some(chars.as_bytes().chunks(4).map(|c| String::from_utf8_lossy(c).into_owned()).collect())
}

/// Two distinct group positions from two random bytes.
pub fn pick_two(r: [u8; 2], n: usize) -> (usize, usize) {
    let a = r[0] as usize % n;
    let b = (a + 1 + r[1] as usize % (n - 1)) % n;
    (a.min(b), a.max(b))
}

impl PendingCode {
    /// The type-back check: both asked groups, compared without case, spaces or hyphens.
    pub fn confirm(&self, first: &str, second: &str) -> Result<(), ApiError> {
        let norm = |s: &str| s.chars().filter(|c| !c.is_whitespace() && *c != '-').map(|c| c.to_ascii_uppercase()).collect::<String>();
        if norm(first) == self.groups[self.ask.0] && norm(second) == self.groups[self.ask.1] {
            Ok(())
        } else {
            Err(invalid(CODE_WRONG))
        }
    }
}

// ── the offline copy settings (7.8, big organizations) ───────────────────────────────────────────────────────

pub fn offline_copy_of(v: &Value) -> Result<Value, ApiError> {
    let o = v.as_object().ok_or_else(|| invalid("offline_copy is an object."))?;
    if let Some(k) = o.keys().find(|k| !["enabled", "schedule", "target", "keep"].contains(&k.as_str())) {
        return Err(ApiError::with("unknown-field", format!("Unknown field: offline_copy.{}.", crate::console_spokes::clean(k))));
    }
    let enabled = o.get("enabled").and_then(Value::as_bool).ok_or_else(|| invalid("offline_copy.enabled is true or false."))?;
    let schedule = o.get("schedule").and_then(Value::as_str).filter(|s| *s == "daily" || *s == "weekly").ok_or_else(|| invalid("offline_copy.schedule is daily or weekly."))?;
    let keep = o.get("keep").and_then(Value::as_i64).filter(|k| (1..=365).contains(k)).ok_or_else(|| invalid("offline_copy.keep is 1 to 365."))?;
    let target = o.get("target").and_then(Value::as_object).ok_or_else(|| invalid("offline_copy.target is a path, s3 with Object Lock, or ssh."))?;
    if !matches!(target.get("type").and_then(Value::as_str), Some("path" | "s3" | "ssh")) {
        return Err(invalid("offline_copy.target is a path, s3 with Object Lock, or ssh."));
    }
    Ok(json!({"enabled": enabled, "schedule": schedule, "target": target, "keep": keep}))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy() -> Value {
        json!({"v": 2, "org": "acme", "seq": 7, "domains": ["acme.example"], "archive": {"principal": "archive@apps.acme.example", "device": "e5e5e5e5e5e5e5e5"}, "archive_reviewers": ["a@acme.example"]})
    }

    fn ok_check(_: &Value, _: &Value) -> Result<(), String> {
        Ok(())
    }

    /// API-1c 10.6: the Local MCP card stages `ai.local_mcp` (the relay's `check_local_mcp` and gates judge it).
    #[test]
    fn the_local_mcp_card_stages_ai_local_mcp() {
        let lm = json!({"enabled": true, "classes": ["internal"], "tools": ["search_messages"], "send": false});
        let ai = ai_of(None, &json!({"preset": "advanced", "ai": {"local_mcp": lm.clone()}})).unwrap();
        assert_eq!(ai["local_mcp"], lm);
        assert!(ai_of(None, &json!({"ai": {"local_mcp_x": true}})).is_err());
    }

    #[test]
    fn presets_give_the_exact_order_and_access() {
        let want: [(&str, &str, Vec<&str>, &str); 3] = [
            ("device", "This computer only", vec!["device"], "none"),
            ("org-first", "Org servers first", vec!["org", "device", "frontier"], "org"),
            ("device-org-frontier", "This computer, then org servers, then frontier", vec!["device", "org", "frontier"], "org"),
        ];
        for (id, label, order, access) in want {
            assert_eq!(preset(id).unwrap().label, label);
            let ai = ai_of(None, &json!({"preset": id})).unwrap();
            assert_eq!(ai["order"], json!(order), "{id}");
            assert_eq!(ai["frontier"]["access"], json!(access), "{id}");
            assert_eq!(preset_of(&ai), id);
        }
        assert_eq!(DEFAULT_PRESET, "device-org-frontier");
    }

    #[test]
    fn a_preset_overrides_advanced_order_and_drops_personal() {
        let current = json!({"v": 1, "order": ["frontier"], "frontier": {"access": "either", "personal": {"api_keys": true, "oauth": true, "providers": ["anthropic"], "classes": [], "plans": "business"}}});
        let ai = ai_of(Some(&current), &json!({"preset": "device", "ai": {"order": ["org"]}})).unwrap();
        assert_eq!(ai["order"], json!(["device"]));
        assert_eq!(ai["frontier"], json!({"access": "none"}));
        // Advanced keeps what it is given, personal included
        let adv = ai_of(Some(&current), &json!({"preset": "advanced", "ai": {"budgets": {"frontier_usd_month": 10, "frontier_usd_user_day": 1}}})).unwrap();
        assert_eq!(adv["frontier"]["access"], json!("either"));
        assert!(adv["frontier"].get("personal").is_some());
        assert_eq!(preset_of(&adv), ADVANCED_ID);
        assert_eq!(ai_of(None, &json!({"ai": {"bogus": 1}})).unwrap_err().code, "unknown-field");
        assert_eq!(ai_of(None, &json!({"ai": {"map_sha256": "00"}})).unwrap_err().code, "unknown-field");
        assert_eq!(ai_of(None, &json!({"preset": "fast"})).unwrap_err().code, "invalid");
    }

    #[test]
    fn staging_names_the_map_hash_and_raises_both_seqs() {
        let map0 = json!({"v": 1, "org": "acme", "seq": 3, "issued": 1, "gateways": [], "channel_classes": {}, "excluded_channels": [], "who_principals": ["ann@acme.example"]});
        let s = stage("acme", "boss@acme.example", &policy(), Some(&map0), &json!({"preset": "device", "map": {"who_principals": ["bob@acme.example"]}}), 5_000_000, &ok_check).unwrap();
        assert_eq!(s.map["seq"], json!(4));
        assert_eq!(s.map["who_principals"], json!(["bob@acme.example"]));
        assert_eq!(s.policy["seq"], json!(8));
        assert_eq!(s.policy["ai"]["map_sha256"], json!(s.map_sha256));
        assert_eq!(s.map_sha256, map_sha256(&s.map).unwrap());
        assert_eq!(s.base, (7, 3));
        let refused = stage("acme", "b", &policy(), None, &json!({}), 1, &|_, _| Err("ai.order must list device, org or frontier, each once".into())).unwrap_err();
        assert_eq!(refused.message, "ai.order must list device, org or frontier, each once");
    }

    #[test]
    fn a_staged_save_is_taken_once_and_only_while_current() {
        let mut st = Stages::default();
        let s = stage("acme", "b", &policy(), None, &json!({}), 1000, &ok_check).unwrap();
        let id = s.id.clone();
        st.put(s.clone(), 1000);
        // the policy moved on: stale, and the stage is gone
        assert_eq!(st.take(&id, "acme", (8, 0), 2000).unwrap_err().message, STAGE_MOVED);
        assert_eq!(st.take(&id, "acme", (7, 0), 2000).unwrap_err().code, "gone");
        st.put(s.clone(), 1000);
        assert_eq!(st.take(&id, "acme", (7, 0), 1000 + STAGE_MS).unwrap_err().code, "gone");
        st.put(s, 1000);
        assert_eq!(st.take(&id, "other", (7, 0), 2000).unwrap_err().code, "gone");
        assert!(st.take(&id, "acme", (7, 0), 2000).is_ok());
        assert_eq!(st.take(&id, "acme", (7, 0), 2000).unwrap_err().code, "gone");
    }

    #[test]
    fn the_map_is_signed_before_the_policy_that_names_it() {
        let s = stage("acme", "b", &policy(), None, &json!({}), 1000, &ok_check).unwrap();
        let first = sign_target(&s, "boss@acme.example", SignStep::Map).unwrap();
        assert_eq!(first["op"], json!("sign_org_ai"));
        assert!(first.get("policy").is_none(), "the map step must not carry the policy");
        // the policy step is never reached while the relay does not hold the map
        let none = Observed { map_stored: false, policy: None };
        assert_eq!(after_signed(&s, SignStep::Map, &none).unwrap_err().message, MAP_NOT_STORED);
        let stored = Observed { map_stored: true, policy: Some(("x".repeat(64), 7)) };
        assert_eq!(after_signed(&s, SignStep::Map, &stored).unwrap(), SignStep::Policy);
        let second = sign_target(&s, "boss@acme.example", SignStep::Policy).unwrap();
        assert_eq!(second["op"], json!("sign_org_policy"));
        assert_eq!(second["policy"]["ai"]["map_sha256"], json!(s.map_sha256));
        assert!(second.get("map").is_none());
        // done only when the current policy names the staged map at a newer seq
        assert_eq!(after_signed(&s, SignStep::Policy, &stored).unwrap_err().message, POLICY_OTHER_MAP);
        let old_seq = Observed { map_stored: true, policy: Some((s.map_sha256.clone(), 7)) };
        assert!(after_signed(&s, SignStep::Policy, &old_seq).is_err());
        let signed = Observed { map_stored: true, policy: Some((s.map_sha256.clone(), 8)) };
        assert_eq!(after_signed(&s, SignStep::Policy, &signed).unwrap(), SignStep::Done);
        assert!(sign_target(&s, "b", SignStep::Done).is_none());
    }

    fn bench(pass: bool, answers: f64, citations: f64, digest_ok: bool) -> Value {
        json!({"state": "done", "result": {"pass": pass, "quality": {"answers_pct": answers, "citations_pct": citations}, "digest": {"checked": true, "ok": digest_ok}, "prompt_logging": "off"}})
    }

    #[test]
    fn approve_is_refused_before_a_passing_benchmark() {
        let row = |b: Value| json!({"card": {"card_id": "llama-70b", "tier": "org"}, "status": "pending", "bench": b});
        assert_eq!(approve_allowed(&row(Value::Null)).unwrap_err().message, APPROVE_AFTER_PASS);
        assert!(approve_allowed(&row(json!({"state": "running", "result": null}))).is_err());
        assert!(approve_allowed(&row(bench(false, 90.0, 99.0, true))).is_err());
        assert!(approve_allowed(&row(bench(true, 84.9, 99.0, true))).is_err());
        assert!(approve_allowed(&row(bench(true, 90.0, 94.9, true))).is_err());
        assert!(approve_allowed(&row(bench(true, 90.0, 99.0, false))).is_err());
        assert!(approve_allowed(&row(bench(true, 85.0, 95.0, true))).is_ok());
        assert_eq!(card_view("g", &row(bench(true, 85.0, 95.0, true)))["approvable"], json!(true));
        assert_eq!(card_view("g", &row(Value::Null))["approvable"], json!(false));
    }

    #[test]
    fn usage_sums_gateways_warns_at_80_percent_and_lists_missing_rids() {
        let u = |spent: i64, rids: &[&str]| json!({"requests": 3, "refusals": {"budget": 1, "who": 2}, "spend": {"month_usd_micro": spent, "month_limit_usd_micro": 500, "day_limit_usd_micro": 5}, "cards": [{"card_id": "c", "healthy": true}], "rids": rids});
        let held: HashSet<String> = ["r1".to_string()].into();
        // two gateways: 300 + 500 of 500 + 500 is exactly 80%
        let v = usage_view(&[u(300, &["r1", "r2"]), u(500, &["r3"])], Some(&held));
        assert_eq!(v["requests"], json!(6));
        assert_eq!(v["refusals"], json!({"budget": 2, "who": 4}));
        assert_eq!(v["spend"]["warning"], json!(BUDGET_WARNING));
        assert_eq!(v["missing_rids"], json!(["r2", "r3"]));
        let low = usage_view(&[u(399, &[])], None);
        assert_eq!(low["spend"]["warning"], Value::Null);
        assert_eq!(low["missing_rids"], Value::Null);
        assert_eq!(usage_view(&[u(400, &[])], None)["spend"]["warning"], json!(BUDGET_WARNING));
    }

    #[test]
    fn device_audit_counts_personal_access_and_dropped_history() {
        let p = |provider: &str, method: &str, plan: &str, tin: i64, tout: i64| json!({"v": 1, "rid": "r", "ts": 1, "provider": provider, "method": method, "plan": plan, "class": "internal", "model": "m", "tokens_in": tin, "tokens_out": tout, "tier": "personal"});
        let mut recs = vec![
            p("anthropic", "oauth", "business", 100, 20),
            p("anthropic", "key", "not_business", 50, 5),
            p("openai", "oauth", "bogus", 10, 1),
            json!({"v": 1, "rid": "d1", "ts": 2, "event": "ai_history_dropped", "reason": "encoding"}),
            json!({"v": 1, "rid": "x", "ts": 3, "event": "something_else"}),
        ];
        for i in 0..60 {
            recs.push(json!({"v": 1, "rid": format!("q{i}"), "ts": 10 + i, "event": "ai_history_dropped", "reason": "queue"}));
        }
        let v = audit_view(&recs);
        assert_eq!(v["personal"]["requests"], json!(3));
        assert_eq!(v["personal"]["by_provider"], json!({"anthropic": {"key": 1, "oauth": 1}, "openai": {"key": 0, "oauth": 1}}));
        assert_eq!(v["personal"]["plans"]["anthropic"], json!({"business": 1, "not_business": 1, "unknown": 0}));
        assert_eq!(v["personal"]["plans"]["openai"]["unknown"], json!(1), "an unknown plan word counts as unknown");
        assert_eq!((v["personal"]["tokens_in"].clone(), v["personal"]["tokens_out"].clone()), (json!(160), json!(26)));
        assert_eq!(v["dropped"]["count"], json!(61));
        assert_eq!(v["dropped"]["by_reason"], json!({"encoding": 1, "queue": 60}));
        let latest = v["dropped"]["latest"].as_array().unwrap();
        assert_eq!(latest.len(), AUDIT_DROPPED_SHOWN);
        assert_eq!(latest.last().unwrap()["rid"], json!("q59"), "the newest are kept");
        assert_eq!(v["other"], json!(1));
        assert!(!v.to_string().contains("\"model\""), "the panel carries no per-request detail beyond counts");
    }

    #[test]
    fn a_hold_is_placed_only_when_relay_and_archive_both_succeed() {
        let both = place_both(|| Ok("h1".into()), || Ok(json!({"ids": ["a1"]})));
        assert_eq!(both["placed"], json!(true));
        let mut archive_called = false;
        let relay_failed = place_both(|| Err(ApiError::with("stale", "no")), || {
            archive_called = true;
            Ok(json!({}))
        });
        assert_eq!(relay_failed["placed"], json!(false));
        assert!(!archive_called);
        let archive_failed = place_both(|| Ok("h1".into()), || Err(ApiError::with("relay-offline", "down")));
        assert_eq!(archive_failed["placed"], json!(false));
        assert_eq!(archive_failed["relay"]["ok"], json!(true));
        let body = hold_body(&["ann@acme.example".into()], "case 12", "rev@acme.example");
        assert!(signed_body(&body, 1000, "c2ln", 1000 + SIGN_WINDOW_S + 1).is_err());
        let b = signed_body(&body, 1000, "c2ln", 1000 + SIGN_WINDOW_S).unwrap();
        assert_eq!(b["ts"], json!(1000));
        assert_eq!(b["op"], json!("hold"));
    }

    #[test]
    fn archive_section_by_size() {
        let mut p = policy();
        use crate::meet_org_policy::{AI_BIG_ORG, AI_ONE_REVIEWER};
        let big = archive_view(Some("enterprise"), &p, Some("https://a.acme.example:9443"), Some(&json!({"status": "Recoverable", "shares": [{"reviewer": "a"}], "offline_copy": {"enabled": true}})), None);
        assert_eq!(big["size"], json!("big"));
        assert_eq!(big["lacks"], json!(AI_BIG_ORG));
        assert_eq!(big["state"], json!(RECOVERABLE));
        assert!(big.get("recovery_code").is_none());
        assert_eq!(archive_view(None, &p, None, None, None)["size"], json!("big"));
        p["archive_reviewers"] = json!(["a", "b", "c"]);
        assert_eq!(archive_view(Some("enterprise"), &p, None, None, None)["lacks"], Value::Null);
        let small = archive_view(Some("standard"), &p, Some("https://a:1"), Some(&json!({"status": "No offline copy", "mode": "code", "gen": 2})), Some(2));
        assert_eq!(small["state"], json!(NO_OFFLINE_COPY));
        assert_eq!(small["recovery_code"], json!("confirmed"));
        assert_eq!(archive_view(Some("standard"), &p, Some("https://a:1"), Some(&json!({"status": "x", "mode": "code", "gen": 3})), Some(2))["recovery_code"], json!("unconfirmed"));
        let none = archive_view(Some("standard"), &json!({}), None, None, None);
        assert_eq!(none["notice"], json!(NO_ARCHIVE));
        assert_eq!(none["add"], json!(ADD_ARCHIVE));
        p["archive_reviewers"] = json!([]);
        assert_eq!(archive_view(Some("standard"), &p, None, None, None)["lacks"], json!(AI_ONE_REVIEWER));
    }

    #[test]
    fn recovery_code_type_back() {
        let code = "ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ23-4567-ABCD-EFGH-IJKL-MNOP-QRST";
        let groups = code_groups(code).unwrap();
        assert_eq!(groups.len(), 13);
        assert!(code_groups("ABCD").is_none());
        for r in [[0u8, 0], [12, 12], [255, 255], [7, 200]] {
            let (a, b) = pick_two(r, 13);
            assert!(a < b && b < 13);
        }
        let p = PendingCode { org: "acme".into(), gen: 1, groups, ask: (1, 7), shown: true };
        assert!(p.confirm("efgh", "4567").is_ok());
        assert_eq!(p.confirm("EFGH", "ABCD").unwrap_err().message, CODE_WRONG);
    }

    #[test]
    fn gateway_entries_and_offline_copy_are_checked() {
        let g = gateway_of(&json!({"url": "https://ai.acme.example:8443", "principal": "ai@apps.acme.example", "device": "0123456789abcdef", "spki": "a".repeat(64), "region": "us-east"})).unwrap();
        assert_eq!(g["region"], json!("us-east"));
        assert!(gateway_of(&json!({"url": "https://ai.acme.example", "principal": "ai@apps.acme.example", "device": "0123456789abcdef", "spki": "a".repeat(64)})).is_err());
        assert!(gateway_of(&json!({"url": "https://ai.acme.example:1", "principal": "x@acme.example", "device": "0123456789abcdef", "spki": "a".repeat(64)})).is_err());
        assert_eq!(endpoint("https://[::1]:8443/x"), Some(("::1".into(), 8443)));
        assert!(offline_copy_of(&json!({"enabled": true, "schedule": "daily", "target": {"type": "path", "path": "/backup"}, "keep": 30})).is_ok());
        assert!(offline_copy_of(&json!({"enabled": true, "schedule": "daily", "target": {"kind": "path"}, "keep": 30})).is_err());
        assert!(offline_copy_of(&json!({"enabled": true, "schedule": "hourly", "target": {"type": "s3"}, "keep": 30})).is_err());
        assert!(offline_copy_of(&json!({"enabled": true, "schedule": "daily", "target": {"type": "s3"}, "keep": 366})).is_err());
    }

    #[test]
    fn no_long_dashes() {
        let src = include_str!("console_ai.rs");
        assert!(!src.contains('\u{2014}') && !src.contains('\u{2013}'));
    }
}
