// Contract AI-1 section 3.1 for the AI gateway: model cards, one per backend, kept in the state folder as
// `cards/<card_id>.json` (the card as the admin and the benchmark wrote it) next to `cards/<card_id>.state.json`
// (what the gateway measured: the last benchmark, the digest check, degraded or quarantined). A card missing any
// field its tier requires, or with a field outside its type, is refused with one sentence.
//
// Evidence is `{value, source, observed_at, sample_size}`. `limits`, `throughput` and `quality["lucid-ask"]` are
// each ONE Evidence whose `value` is the object the contract lists (`{context_tokens, output_tokens}`,
// `{prefill_tps, decode_tps, at_concurrency}`, `{answers_pct, citations_pct}`).

use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};

pub type Obj = Map<String, Value>;

pub const PROVIDERS: [&str; 5] = ["local", "anthropic", "openai", "azure", "amazon-bedrock"];
const PRECISION_W: [&str; 9] = ["fp32", "bf16", "fp16", "fp8-e4m3", "fp8-e5m2", "int8", "int4-awq", "int4-gptq", "nf4"];
const PRECISION_KV: [&str; 4] = ["bf16", "fp16", "fp8", "int8"];
const SOURCES: [&str; 3] = ["advertised", "tested", "unknown"];
const APPROVALS: [&str; 3] = ["pending", "approved", "rejected"];
const RETIRE_MAX_DAYS: i64 = 366;
const CARD_KEYS: [&str; 20] = [
    "card_id", "tier", "provider", "endpoint", "enclave", "exact_model_id", "weights_digest", "precision", "runtime", "hardware", "arch", "limits", "throughput", "slots", "quality", "data_handling", "price", "license", "approval", "retire_after",
];
const ORG_ONLY: [&str; 7] = ["enclave", "weights_digest", "precision", "runtime", "hardware", "arch", "slots"];
const FRONTIER_ONLY: [&str; 2] = ["data_handling", "price"];

/// One Evidence value.
#[derive(Clone, Debug, PartialEq)]
pub struct Evidence {
    pub value: Value,
    pub source: String,
    pub observed_at: i64,
    pub sample_size: u64,
}

impl Evidence {
    pub fn tested(value: Value, sample_size: u64, now: i64) -> Evidence {
        Evidence { value, source: "tested".into(), observed_at: now, sample_size }
    }

    pub fn to_value(&self) -> Value {
        json!({"value": self.value, "source": self.source, "observed_at": self.observed_at, "sample_size": self.sample_size})
    }

    /// The integer `key` of the value, None when the evidence is `unknown` or the field is missing.
    pub fn int(&self, key: &str) -> Option<u64> {
        if self.source == "unknown" {
            return None;
        }
        self.value.get(key).and_then(Value::as_u64)
    }
}

/// A checked card.
#[derive(Clone, Debug)]
pub struct Card {
    pub raw: Obj,
    pub card_id: String,
    pub tier: String,
    pub provider: String,
    pub endpoint: String,
    pub enclave: bool,
    pub model: String,
    pub weights_digest: String,
    pub kv_cache: String,
    pub arch: Option<(u64, u64, u64)>,
    pub limits: Evidence,
    pub throughput: Evidence,
    pub slots: u64,
    pub quality: Evidence,
    pub retention_zero: bool,
    pub price: (u64, u64),
    pub approval_status: String,
    pub for_classes: Vec<String>,
    /// `approval.retention_override`: the admin's typed reason to send classes above the lowest to a frontier card
    /// whose `data_handling.retention` is not `zero` ("" when none).
    pub retention_override: String,
    pub approved_at: i64,
    pub retire_after: i64,
}

fn slug_ok(s: &str, max: usize) -> bool {
    !s.is_empty() && s.len() <= max && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn printable_ascii(s: &str, max: usize) -> bool {
    !s.is_empty() && s.len() <= max && s.bytes().all(|b| (0x20..=0x7e).contains(&b))
}

fn sha_digest_ok(s: &str) -> bool {
    s.strip_prefix("sha256:").is_some_and(|h| h.len() == 64 && h.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}

/// An `https://` URL of at most 256 characters with a host.
pub fn https_url_ok(s: &str) -> bool {
    s.len() <= 256 && s.strip_prefix("https://").is_some_and(|rest| !rest.is_empty() && !rest.starts_with('/') && rest.bytes().all(|b| (0x21..=0x7e).contains(&b)))
}

/// A `YYYY-MM-DD` date (optionally with a time) as unix seconds.
fn date(v: Option<&Value>) -> Option<i64> {
    let t = v?.as_str()?;
    if t.len() < 10 {
        return None;
    }
    crate::meet_json::from_iso(t).map(|x| x as i64)
}

fn int_in(o: &Obj, key: &str, low: u64, high: u64) -> Option<u64> {
    o.get(key).and_then(Value::as_u64).filter(|n| (low..=high).contains(n))
}

fn evidence(v: Option<&Value>, what: &str) -> Result<Evidence, String> {
    let o = v.and_then(Value::as_object).ok_or_else(|| format!("{what} must be evidence"))?;
    let source = o.get("source").and_then(Value::as_str).filter(|s| SOURCES.contains(s)).ok_or_else(|| format!("{what}.source must be advertised, tested or unknown"))?;
    let value = o.get("value").filter(|v| v.is_object()).cloned().ok_or_else(|| format!("{what}.value must be an object"))?;
    Ok(Evidence {
        value,
        source: source.to_string(),
        observed_at: o.get("observed_at").and_then(Value::as_i64).unwrap_or(0),
        sample_size: o.get("sample_size").and_then(Value::as_u64).unwrap_or(0),
    })
}

/// Contract 3.1: the card's shape for its tier. The benchmark's results may be `unknown` until it runs; approval
/// (`approval_ready`) needs them tested.
pub fn check_card(v: &Value) -> Result<Card, String> {
    let o = v.as_object().ok_or("a card must be an object")?;
    if let Some(k) = o.keys().find(|k| !CARD_KEYS.contains(&k.as_str())) {
        return Err(format!("a card has no field {k}"));
    }
    let s = |k: &str| o.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
    let card_id = s("card_id");
    if !slug_ok(&card_id, 64) {
        return Err("card_id must be 1 to 64 of a-z, 0-9 and -".into());
    }
    let tier = s("tier");
    let org = match tier.as_str() {
        "org" => true,
        "frontier" => false,
        _ => return Err("tier must be org or frontier".into()),
    };
    let wrong_tier: &[&str] = if org { &FRONTIER_ONLY } else { &ORG_ONLY };
    if let Some(k) = wrong_tier.iter().find(|k| o.contains_key(**k)) {
        return Err(format!("{tier} cards have no {k}"));
    }
    let provider = s("provider");
    if !PROVIDERS.contains(&provider.as_str()) || (org && provider != "local") || (!org && provider == "local") {
        return Err("provider must be local for an org card, or anthropic, openai, azure or amazon-bedrock for a frontier card".into());
    }
    let endpoint = s("endpoint");
    if !https_url_ok(&endpoint) {
        return Err("endpoint must be an https:// URL of at most 256 characters".into());
    }
    let model = s("exact_model_id");
    if !printable_ascii(&model, 128) || model.to_ascii_lowercase().contains("latest") {
        return Err("exact_model_id must be 1 to 128 printable ASCII characters and name an exact model, not latest".into());
    }
    let lic = o.get("license").and_then(|l| l.get("commercial_runtime_use")).and_then(Value::as_str);
    if lic != Some("allowed") {
        return Err("license.commercial_runtime_use must be allowed".into());
    }
    let limits = evidence(o.get("limits"), "limits")?;
    let throughput = evidence(o.get("throughput"), "throughput")?;
    let quality = evidence(o.get("quality").and_then(|q| q.get("lucid-ask")), "quality[\"lucid-ask\"]")?;
    let ap = o.get("approval").and_then(Value::as_object).ok_or("approval must be {status, by, at, for_classes}")?;
    let status = ap.get("status").and_then(Value::as_str).filter(|x| APPROVALS.contains(x)).ok_or("approval.status must be pending, approved or rejected")?;
    let for_classes: Vec<String> = ap.get("for_classes").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default();
    if ap.get("for_classes").and_then(Value::as_array).map_or(true, |a| a.len() != for_classes.len() || a.len() > 8 || for_classes.iter().any(|c| !slug_ok(c, 32))) {
        return Err("approval.for_classes must list 0 to 8 classes".into());
    }
    let retention_override = ap.get("retention_override").and_then(Value::as_str).unwrap_or_default().trim().to_string();
    let approved_at = date(ap.get("at"));
    let retire_after = date(o.get("retire_after")).ok_or("retire_after must be a date")?;
    if status == "approved" {
        let at = approved_at.ok_or("approval.at must be a date")?;
        if !printable_ascii(ap.get("by").and_then(Value::as_str).unwrap_or_default(), 254) {
            return Err("approval.by must name who approved".into());
        }
        if retire_after > at + RETIRE_MAX_DAYS * 86_400 {
            return Err("retire_after must be at most 12 months after approval.at".into());
        }
    }
    let mut card = Card {
        raw: o.clone(),
        card_id,
        tier,
        provider,
        endpoint,
        enclave: false,
        model,
        weights_digest: String::new(),
        kv_cache: String::new(),
        arch: None,
        limits,
        throughput,
        slots: 0,
        quality,
        retention_zero: false,
        price: (0, 0),
        approval_status: status.to_string(),
        for_classes,
        retention_override,
        approved_at: approved_at.unwrap_or(0),
        retire_after,
    };
    if org {
        card.enclave = o.get("enclave").and_then(Value::as_bool).ok_or("enclave must be true or false")?;
        card.weights_digest = s("weights_digest");
        if !sha_digest_ok(&card.weights_digest) {
            return Err("weights_digest must be sha256: and 64 hex".into());
        }
        let p = o.get("precision").and_then(Value::as_object).ok_or("precision must be {weights, activations, kv_cache}")?;
        let ok = |k: &str, set: &[&str]| p.get(k).and_then(Value::as_str).is_some_and(|x| set.contains(&x));
        if p.len() != 3 || !ok("weights", &PRECISION_W) || !ok("activations", &PRECISION_W) || !ok("kv_cache", &PRECISION_KV) {
            return Err("precision must be {weights, activations, kv_cache} from the contract's lists".into());
        }
        card.kv_cache = p["kv_cache"].as_str().unwrap_or_default().to_string();
        let r = o.get("runtime").and_then(Value::as_object).ok_or("runtime must be {name, version, image_digest?}")?;
        let rs = |k: &str| r.get(k).and_then(Value::as_str).is_some_and(|x| printable_ascii(x, 128));
        if !rs("name") || !rs("version") || r.keys().any(|k| !["name", "version", "image_digest"].contains(&k.as_str())) || r.get("image_digest").is_some_and(|d| !d.as_str().is_some_and(sha_digest_ok)) {
            return Err("runtime must be {name, version, image_digest?}".into());
        }
        let h = o.get("hardware").and_then(Value::as_object).ok_or("hardware must be {gpu, count, vram_mb_each, tp, pp}")?;
        if h.len() != 5 || !h.get("gpu").and_then(Value::as_str).is_some_and(|g| printable_ascii(g, 128)) || ["count", "vram_mb_each", "tp", "pp"].iter().any(|k| int_in(h, k, 1, 1 << 40).is_none()) {
            return Err("hardware must be {gpu, count, vram_mb_each, tp, pp}".into());
        }
        let a = o.get("arch").and_then(Value::as_object).ok_or("arch must be {layers, kv_heads, head_dim}")?;
        match (int_in(a, "layers", 1, 4096), int_in(a, "kv_heads", 1, 4096), int_in(a, "head_dim", 1, 4096)) {
            (Some(l), Some(k), Some(d)) if a.len() == 3 => card.arch = Some((l, k, d)),
            _ => return Err("arch must be {layers, kv_heads, head_dim}, integers 1 to 4096".into()),
        }
        card.slots = int_in(o, "slots", 1, 1024).ok_or("slots must be 1 to 1024")?;
    } else {
        let d = o.get("data_handling").and_then(Value::as_object).ok_or("data_handling must be {retention, training_use, region, terms_ref}")?;
        if ["retention", "training_use", "region", "terms_ref"].iter().any(|k| !d.get(*k).and_then(Value::as_str).is_some_and(|x| printable_ascii(x, 256))) || d.len() != 4 {
            return Err("data_handling must be {retention, training_use, region, terms_ref}".into());
        }
        card.retention_zero = d["retention"].as_str() == Some("zero");
        let p = o.get("price").and_then(Value::as_object).ok_or("price must be {usd_per_mtok_in, usd_per_mtok_out}")?;
        match (int_in(p, "usd_per_mtok_in", 0, 1 << 40), int_in(p, "usd_per_mtok_out", 0, 1 << 40)) {
            (Some(i), Some(out)) if p.len() == 2 => card.price = (i, out),
            _ => return Err("price must be {usd_per_mtok_in, usd_per_mtok_out}, whole micro-dollars".into()),
        }
    }
    Ok(card)
}

impl Card {
    pub fn org(&self) -> bool {
        self.tier == "org"
    }

    /// Why the card cannot be approved yet ("" when it can): org needs tested limits, throughput and quality;
    /// frontier needs tested throughput and quality (advertised limits are enough).
    pub fn approval_gap(&self) -> &'static str {
        if self.limits.source == "unknown" || (self.org() && self.limits.source != "tested") {
            return "the card's limits are not tested";
        }
        if self.throughput.source != "tested" {
            return "the card's throughput is not tested";
        }
        if self.quality.source != "tested" {
            return "the card's quality is not tested";
        }
        ""
    }

    /// `provider/model` as the Lucid IDE matches `models.allowed` and `models.denied`.
    pub fn model_key(&self) -> String {
        format!("{}/{}", self.provider, self.model)
    }
}

/// What the gateway measured about a card (`cards/<id>.state.json`).
#[derive(Clone, Debug, Default)]
pub struct CardState {
    pub bench: Option<Value>,
    pub quarantined: bool,
    pub degraded: bool,
}

/// The status the console shows: `retired` past `retire_after`, `quarantined` after a digest change (until a new
/// benchmark and re-approval), `pending` until approved, `degraded` when throughput fell more than 20%.
pub fn status(card: &Card, st: &CardState, now: i64) -> &'static str {
    if now > card.retire_after {
        "retired"
    } else if st.quarantined {
        "quarantined"
    } else if card.approval_status != "approved" {
        "pending"
    } else if st.degraded {
        "degraded"
    } else {
        "approved"
    }
}

/// The card files of a state folder.
pub struct CardStore {
    dir: PathBuf,
}

impl CardStore {
    pub fn new(state_dir: &Path) -> CardStore {
        CardStore { dir: state_dir.join("cards") }
    }

    fn card_path(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{id}.json"))
    }

    fn state_path(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{id}.state.json"))
    }

    /// Check and store a card (replacing one of the same id).
    pub fn put(&self, v: &Value) -> Result<Card, String> {
        let card = check_card(v)?;
        std::fs::create_dir_all(&self.dir).map_err(|e| format!("cannot make {}: {e}", self.dir.display()))?;
        let text = serde_json::to_vec_pretty(v).map_err(|e| e.to_string())?;
        crate::meet_tls::write_atomic(&self.card_path(&card.card_id), &text).map_err(|e| format!("cannot write the card: {e}"))?;
        Ok(card)
    }

    pub fn get(&self, id: &str) -> Result<Card, String> {
        if !slug_ok(id, 64) {
            return Err("no such card".into());
        }
        let data = std::fs::read(self.card_path(id)).map_err(|_| format!("no card {id}"))?;
        let v: Value = serde_json::from_slice(&data).map_err(|_| format!("the card {id} is not JSON"))?;
        check_card(&v).map_err(|e| format!("the card {id} is refused: {e}"))
    }

    /// Every readable card, sorted by id; the refused ones with their reason.
    pub fn all(&self) -> (Vec<Card>, Vec<(String, String)>) {
        let mut ids: Vec<String> = std::fs::read_dir(&self.dir)
            .map(|rd| rd.filter_map(|e| e.ok()).filter_map(|e| e.file_name().to_str().map(str::to_string)).filter(|n| n.ends_with(".json") && !n.ends_with(".state.json")).map(|n| n.trim_end_matches(".json").to_string()).collect())
            .unwrap_or_default();
        ids.sort();
        let (mut ok, mut bad) = (Vec::new(), Vec::new());
        for id in ids {
            match self.get(&id) {
                Ok(c) => ok.push(c),
                Err(e) => bad.push((id, e)),
            }
        }
        (ok, bad)
    }

    pub fn state(&self, id: &str) -> CardState {
        let v: Value = std::fs::read(self.state_path(id)).ok().and_then(|d| serde_json::from_slice(&d).ok()).unwrap_or(Value::Null);
        CardState { bench: v.get("bench").filter(|b| b.is_object()).cloned(), quarantined: v["quarantined"].as_bool().unwrap_or(false), degraded: v["degraded"].as_bool().unwrap_or(false) }
    }

    pub fn set_state(&self, id: &str, st: &CardState) -> Result<(), String> {
        std::fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
        let v = json!({"bench": st.bench.clone().unwrap_or(Value::Null), "quarantined": st.quarantined, "degraded": st.degraded});
        crate::meet_tls::write_atomic(&self.state_path(id), v.to_string().as_bytes()).map_err(|e| format!("cannot write the card state: {e}"))
    }
}

#[cfg(test)]
pub(crate) mod testcards {
    use serde_json::{json, Value};

    fn ev(value: Value, source: &str) -> Value {
        json!({"value": value, "source": source, "observed_at": 1795000000, "sample_size": 10})
    }

    /// An approved org card (70B, kv fp8, 4000/60 t/s) at `endpoint`.
    pub fn org_card(id: &str, endpoint: &str, for_classes: &[&str]) -> Value {
        json!({
            "card_id": id, "tier": "org", "provider": "local", "endpoint": endpoint, "enclave": false,
            "exact_model_id": "meta-llama/Llama-3.3-70B-Instruct",
            "weights_digest": format!("sha256:{}", "ab".repeat(32)),
            "precision": {"weights": "fp8-e4m3", "activations": "fp8-e4m3", "kv_cache": "fp8"},
            "runtime": {"name": "vllm", "version": "0.8.0"},
            "hardware": {"gpu": "H100", "count": 2, "vram_mb_each": 81920, "tp": 2, "pp": 1},
            "arch": {"layers": 80, "kv_heads": 8, "head_dim": 128},
            "limits": ev(json!({"context_tokens": 131072, "output_tokens": 4096}), "tested"),
            "throughput": ev(json!({"prefill_tps": 4000, "decode_tps": 60, "at_concurrency": 1}), "tested"),
            "slots": 16,
            "quality": {"lucid-ask": ev(json!({"answers_pct": 90, "citations_pct": 98}), "tested")},
            "license": {"commercial_runtime_use": "allowed"},
            "approval": {"status": "approved", "by": "admin@acme.example", "at": "2026-11-01", "for_classes": for_classes},
            "retire_after": "2027-10-01",
        })
    }

    /// An approved frontier card with zero retention.
    pub fn frontier_card(id: &str, provider: &str, endpoint: &str, for_classes: &[&str]) -> Value {
        json!({
            "card_id": id, "tier": "frontier", "provider": provider, "endpoint": endpoint,
            "exact_model_id": "claude-sonnet-4-5-20250929",
            "limits": ev(json!({"context_tokens": 200000, "output_tokens": 8192}), "advertised"),
            "throughput": ev(json!({"prefill_tps": 5000, "decode_tps": 80, "at_concurrency": 1}), "tested"),
            "quality": {"lucid-ask": ev(json!({"answers_pct": 95, "citations_pct": 99}), "tested")},
            "data_handling": {"retention": "zero", "training_use": "none", "region": "us", "terms_ref": "https://example.com/terms"},
            "price": {"usd_per_mtok_in": 3000000, "usd_per_mtok_out": 15000000},
            "license": {"commercial_runtime_use": "allowed"},
            "approval": {"status": "approved", "by": "admin@acme.example", "at": "2026-11-01", "for_classes": for_classes},
            "retire_after": "2027-10-01",
        })
    }
}

#[cfg(test)]
mod tests {
    use super::testcards::*;
    use super::*;

    #[test]
    fn good_cards_read_and_their_fields_are_kept() {
        let c = check_card(&org_card("llama-70b-fp8", "https://vllm.acme.example:8000/v1", &["internal"])).unwrap();
        assert_eq!((c.arch, c.kv_cache.as_str(), c.slots, c.limits.int("context_tokens")), (Some((80, 8, 128)), "fp8", 16, Some(131072)));
        assert_eq!(c.approval_gap(), "");
        let f = check_card(&frontier_card("claude", "anthropic", "https://api.anthropic.com", &["public", "internal"])).unwrap();
        assert_eq!((f.price, f.retention_zero, f.model_key().as_str()), ((3000000, 15000000), true, "anthropic/claude-sonnet-4-5-20250929"));
    }

    #[test]
    fn cards_missing_or_misusing_a_field_are_refused() {
        let base = org_card("a", "https://h:1/v1", &[]);
        let refuse = |edit: &dyn Fn(&mut Value), words: &str| {
            let mut v = base.clone();
            edit(&mut v);
            assert_eq!(check_card(&v).unwrap_err(), words);
        };
        refuse(&|v: &mut Value| v["card_id"] = json!("A_B"), "card_id must be 1 to 64 of a-z, 0-9 and -");
        refuse(&|v: &mut Value| v["endpoint"] = json!("http://h:1/v1"), "endpoint must be an https:// URL of at most 256 characters");
        refuse(&|v: &mut Value| v["exact_model_id"] = json!("llama3:latest"), "exact_model_id must be 1 to 128 printable ASCII characters and name an exact model, not latest");
        refuse(&|v: &mut Value| { v.as_object_mut().unwrap().remove("weights_digest"); }, "weights_digest must be sha256: and 64 hex");
        refuse(&|v: &mut Value| v["precision"]["kv_cache"] = json!("fp4"), "precision must be {weights, activations, kv_cache} from the contract's lists");
        refuse(&|v: &mut Value| v["arch"]["layers"] = json!(0), "arch must be {layers, kv_heads, head_dim}, integers 1 to 4096");
        refuse(&|v: &mut Value| v["slots"] = json!(2000), "slots must be 1 to 1024");
        refuse(&|v: &mut Value| v["price"] = json!({"usd_per_mtok_in": 1, "usd_per_mtok_out": 1}), "org cards have no price");
        refuse(&|v: &mut Value| v["retire_after"] = json!("2028-01-01"), "retire_after must be at most 12 months after approval.at");
        refuse(&|v: &mut Value| v["license"]["commercial_runtime_use"] = json!("research"), "license.commercial_runtime_use must be allowed");
        refuse(&|v: &mut Value| v["provider"] = json!("openai"), "provider must be local for an org card, or anthropic, openai, azure or amazon-bedrock for a frontier card");
        let mut f = frontier_card("f", "openai", "https://api.openai.com/v1", &[]);
        f.as_object_mut().unwrap().remove("price");
        assert_eq!(check_card(&f).unwrap_err(), "price must be {usd_per_mtok_in, usd_per_mtok_out}");
    }

    #[test]
    fn untested_results_block_approval_and_status_follows_the_state() {
        let mut v = org_card("a", "https://h:1/v1", &[]);
        v["throughput"]["source"] = json!("advertised");
        let c = check_card(&v).unwrap();
        assert_eq!(c.approval_gap(), "the card's throughput is not tested");
        let ok = check_card(&org_card("b", "https://h:1/v1", &[])).unwrap();
        let now = 1_795_000_000;
        assert_eq!(status(&ok, &CardState::default(), now), "approved");
        assert_eq!(status(&ok, &CardState { quarantined: true, ..CardState::default() }, now), "quarantined");
        assert_eq!(status(&ok, &CardState { degraded: true, ..CardState::default() }, now), "degraded");
        assert_eq!(status(&ok, &CardState::default(), ok.retire_after + 1), "retired");
    }

    #[test]
    fn the_store_keeps_cards_and_their_state() {
        let dir = crate::meet_tls::testpki::dir("ai-cards");
        let store = CardStore::new(&dir);
        store.put(&org_card("one", "https://h:1/v1", &["internal"])).unwrap();
        assert!(store.put(&json!({"card_id": "two"})).is_err());
        assert_eq!(store.all().0.len(), 1);
        store.set_state("one", &CardState { quarantined: true, ..CardState::default() }).unwrap();
        assert!(store.state("one").quarantined);
        assert!(store.get("../x").is_err());
    }
}
