// Contract AI-1 sections 4.1 and 4.4 for the AI gateway (`lucid-relay ai`): the token estimate, the integer
// admission rule (the same numbers as `relay/meet_org_policy.py` `admission` and the shared vectors, cases A to H),
// the activity table, and the frontier budgets with an atomic reservation, settle and expiry.

use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;

/// The activities of the table in 4.1.
pub const ACTIVITIES: [&str; 6] = ["search", "catch_up", "notes", "summary", "brief", "assist"];

/// `max_output` of an activity (4.1), None for an unknown activity.
pub fn max_output(activity: &str) -> Option<u64> {
    match activity {
        "search" => Some(512),
        "catch_up" => Some(1024),
        "notes" | "summary" | "brief" => Some(2048),
        "assist" => Some(256),
        _ => None,
    }
}

/// Which `deadlines_ms` entry an activity uses: `search` or `catch_up`.
pub fn deadline_key(activity: &str) -> &'static str {
    match activity {
        "search" | "assist" => "search",
        _ => "catch_up",
    }
}

/// `ceil(ascii / 3) + non_ascii` over Unicode scalar values (ascii is below U+0080).
pub fn estimate_tokens(text: &str) -> u64 {
    let (mut ascii, mut other) = (0u64, 0u64);
    for c in text.chars() {
        if (c as u32) < 0x80 {
            ascii += 1;
        } else {
            other += 1;
        }
    }
    ascii.div_ceil(3) + other
}

/// Bytes per KV cache element (`precision.kv_cache`): 2 for bf16 and fp16, 1 for fp8 and int8.
pub fn kv_bytes(kv_cache: &str) -> Option<u64> {
    match kv_cache {
        "bf16" | "fp16" => Some(2),
        "fp8" | "int8" => Some(1),
        _ => None,
    }
}

/// Why a request does not fit, in the order the checks run.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Why {
    Unknown,
    Context,
    Memory,
    Deadline,
}

impl Why {
    pub fn as_str(self) -> &'static str {
        match self {
            Why::Unknown => "unknown",
            Why::Context => "context",
            Why::Memory => "memory",
            Why::Deadline => "deadline",
        }
    }
}

/// The inputs of the rule. `None` is `unknown` evidence (or a backend that reports no free KV figure).
#[derive(Clone, Debug, Default)]
pub struct Fit {
    pub tokens_in: u64,
    pub max_output: u64,
    pub layers: Option<u64>,
    pub kv_heads: Option<u64>,
    pub head_dim: Option<u64>,
    pub kv_cache_bytes: Option<u64>,
    pub context_tokens: Option<u64>,
    pub free_kv_bytes: Option<u64>,
    pub prefill_tps: Option<u64>,
    pub decode_tps: Option<u64>,
    pub queue_ms: u64,
    pub deadline_ms: u64,
    /// Frontier cards skip `memory` (and need no `arch`).
    pub frontier: bool,
}

/// What the rule computed; `kv_need` and `expected_ms` are 0 when their inputs are unknown.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Admission {
    pub result: Result<(), Why>,
    pub tokens_in: u64,
    pub total: u64,
    pub kv_need: u64,
    pub expected_ms: u64,
}

/// Contract 4.1, integer arithmetic: unknown, then context, memory (org and device only), deadline.
pub fn admit(f: &Fit) -> Admission {
    let total = f.tokens_in + f.max_output;
    let arch = match (f.layers, f.kv_heads, f.head_dim, f.kv_cache_bytes) {
        (Some(l), Some(h), Some(d), Some(b)) => Some(2 * l * h * d * b),
        _ => None,
    };
    let kv_need = arch.map(|per_tok| total.saturating_mul(per_tok));
    let expected = match (f.prefill_tps, f.decode_tps) {
        (Some(p), Some(d)) if p > 0 && d > 0 => {
            Some(f.queue_ms + (f.tokens_in * 1000).div_ceil(p) + (f.max_output * 1000).div_ceil(d))
        }
        _ => None,
    };
    let mut out = Admission { result: Ok(()), tokens_in: f.tokens_in, total, kv_need: kv_need.unwrap_or(0), expected_ms: expected.unwrap_or(0) };
    let memory_known = f.frontier || (kv_need.is_some() && f.free_kv_bytes.is_some());
    if expected.is_none() || f.context_tokens.is_none() || !memory_known {
        out.result = Err(Why::Unknown);
    } else if total > f.context_tokens.unwrap_or(0) {
        out.result = Err(Why::Context);
    } else if !f.frontier && kv_need.unwrap_or(u64::MAX) > f.free_kv_bytes.unwrap_or(0) {
        out.result = Err(Why::Memory);
    } else if expected.unwrap_or(u64::MAX) > f.deadline_ms {
        out.result = Err(Why::Deadline);
    }
    out
}

// ── budgets (4.4) ────────────────────────────────────────────────────────────────────────────────────────────

/// `ceil((tokens_in * usd_per_mtok_in + tokens_out * usd_per_mtok_out) / 1000000)` in micro-dollars.
pub fn cost_micro(tokens_in: u64, tokens_out: u64, usd_per_mtok_in: u64, usd_per_mtok_out: u64) -> u64 {
    let raw = tokens_in as u128 * usd_per_mtok_in as u128 + tokens_out as u128 * usd_per_mtok_out as u128;
    raw.div_ceil(1_000_000) as u64
}

/// This gateway's limits in micro-dollars: `frontier_usd_month` divided by the gateways in the map (whole dollars,
/// rounded down) and `frontier_usd_user_day`. A zero limit means org frontier is unavailable.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits {
    pub month_micro: u64,
    pub day_micro: u64,
}

impl Limits {
    pub fn of(usd_month: u64, usd_user_day: u64, gateways: usize) -> Limits {
        let share = usd_month / (gateways.max(1) as u64);
        Limits { month_micro: share * 1_000_000, day_micro: usd_user_day * 1_000_000 }
    }

    /// The lower of two limits (6.2: during the policy window budgets use the lower of the two).
    pub fn lower(self, other: Limits) -> Limits {
        Limits { month_micro: self.month_micro.min(other.month_micro), day_micro: self.day_micro.min(other.day_micro) }
    }
}

struct Reservation {
    principal: String,
    amount: u64,
    day: String,
    month: String,
    expires_ms: i64,
}

#[derive(Default)]
struct Ledger {
    month: String,
    month_spent: u64,
    day: String,
    day_spent: HashMap<String, u64>,
    held: HashMap<String, Reservation>,
}

/// The gateway's frontier spend: settled spend per UTC month and per person per UTC day (kept in `budgets.json`)
/// and the reservations in flight (memory only: a restart releases them, as an expired one is).
pub struct Budgets {
    path: Option<PathBuf>,
    ledger: Mutex<Ledger>,
}

/// `YYYY-MM` and `YYYY-MM-DD` of a UTC time in milliseconds.
fn periods(now_ms: i64) -> (String, String) {
    let (y, m, d) = crate::meet_json::civil(now_ms.div_euclid(86_400_000));
    (format!("{y:04}-{m:02}"), format!("{y:04}-{m:02}-{d:02}"))
}

impl Ledger {
    fn roll(&mut self, now_ms: i64) {
        let (month, day) = periods(now_ms);
        if self.month != month {
            self.month = month;
            self.month_spent = 0;
        }
        if self.day != day {
            self.day = day;
            self.day_spent.clear();
        }
        self.held.retain(|_, r| r.expires_ms > now_ms);
    }
}

impl Budgets {
    pub fn open(path: Option<PathBuf>) -> Budgets {
        let mut ledger = Ledger::default();
        if let Some(v) = path.as_ref().and_then(|p| std::fs::read(p).ok()).and_then(|b| serde_json::from_slice::<Value>(&b).ok()) {
            ledger.month = v["month"].as_str().unwrap_or_default().to_string();
            ledger.month_spent = v["month_spent"].as_u64().unwrap_or(0);
            ledger.day = v["day"].as_str().unwrap_or_default().to_string();
            if let Some(o) = v["day_spent"].as_object() {
                ledger.day_spent = o.iter().filter_map(|(k, n)| n.as_u64().map(|n| (k.clone(), n))).collect();
            }
        }
        Budgets { path, ledger: Mutex::new(ledger) }
    }

    fn save(&self, l: &Ledger) {
        if let Some(p) = &self.path {
            let v = json!({"month": l.month, "month_spent": l.month_spent, "day": l.day, "day_spent": l.day_spent});
            let _ = crate::meet_tls::write_atomic(p, v.to_string().as_bytes());
        }
    }

    /// Reserve `amount` for `rid` against the month and `principal`'s day, atomically: Err(()) (`budget`) when either
    /// limit is zero or the spend plus every live reservation plus `amount` would cross it. The reservation lapses
    /// at `now_ms + ttl_ms` (twice the activity's deadline).
    pub fn reserve(&self, rid: &str, principal: &str, amount: u64, limits: Limits, now_ms: i64, ttl_ms: i64) -> Result<(), ()> {
        let mut l = self.ledger.lock();
        l.roll(now_ms);
        if limits.month_micro == 0 || limits.day_micro == 0 {
            return Err(());
        }
        let month_held: u64 = l.held.values().map(|r| r.amount).sum();
        let day_held: u64 = l.held.values().filter(|r| r.principal == principal && r.day == l.day).map(|r| r.amount).sum();
        let day_spent = l.day_spent.get(principal).copied().unwrap_or(0);
        if l.month_spent + month_held + amount > limits.month_micro || day_spent + day_held + amount > limits.day_micro {
            return Err(());
        }
        let (month, day) = (l.month.clone(), l.day.clone());
        l.held.insert(rid.to_string(), Reservation { principal: principal.to_string(), amount, day, month, expires_ms: now_ms + ttl_ms });
        Ok(())
    }

    /// The answer came back: the reservation goes and the real cost is spent (on the reservation's day and month
    /// when they are still current). A reservation that already lapsed is still charged with `principal`.
    pub fn settle(&self, rid: &str, principal: &str, actual: u64, now_ms: i64) {
        let mut l = self.ledger.lock();
        let r = l.held.remove(rid);
        l.roll(now_ms);
        let (day, month) = r.as_ref().map(|r| (r.day.clone(), r.month.clone())).unwrap_or_else(|| (l.day.clone(), l.month.clone()));
        if month == l.month {
            l.month_spent += actual;
        }
        if day == l.day {
            *l.day_spent.entry(principal.to_string()).or_insert(0) += actual;
        }
        self.save(&l);
    }

    /// The call failed before any spend: the reservation goes, nothing is charged.
    pub fn release(&self, rid: &str) {
        self.ledger.lock().held.remove(rid);
    }

    /// (settled month spend, held) in micro-dollars, for usage.
    pub fn month_spend(&self, now_ms: i64) -> (u64, u64) {
        let mut l = self.ledger.lock();
        l.roll(now_ms);
        (l.month_spent, l.held.values().map(|r| r.amount).sum())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    const GIB: u64 = 1 << 30;

    fn fit70(kv: u64, tokens_in: u64, max_out: u64, pre: u64, dec: u64, queue: u64, free: u64, ctx: u64, deadline: u64) -> Fit {
        Fit {
            tokens_in,
            max_output: max_out,
            layers: Some(80),
            kv_heads: Some(8),
            head_dim: Some(128),
            kv_cache_bytes: Some(kv),
            context_tokens: Some(ctx),
            free_kv_bytes: Some(free),
            prefill_tps: Some(pre),
            decode_tps: Some(dec),
            queue_ms: queue,
            deadline_ms: deadline,
            frontier: false,
        }
    }

    /// Contract 4.3, cases A to H, exactly as the table (deadlines are the policy defaults 20000 and 60000).
    #[test]
    fn admission_matches_the_worked_examples() {
        let a = admit(&fit70(1, estimate_tokens(&"x".repeat(12000)), 512, 4000, 60, 500, 20 * GIB, 131072, 20000));
        assert_eq!((a.tokens_in, a.kv_need, a.expected_ms, a.result), (4000, 739246080, 10034, Ok(())));
        let b = admit(&fit70(1, 4000, 512, 4000, 20, 500, 20 * GIB, 131072, 20000));
        assert_eq!((b.kv_need, b.expected_ms, b.result), (739246080, 27100, Err(Why::Deadline)));
        let c = admit(&fit70(2, 31744, 1024, 4000, 40, 0, 8 * GIB, 131072, 60000));
        assert_eq!((c.kv_need, c.expected_ms, c.result), (10737418240, 33536, Err(Why::Memory)));
        let d = admit(&fit70(1, 130500, 1024, 4000, 40, 0, 200 * GIB, 131072, 60000));
        assert_eq!((d.kv_need, d.expected_ms, d.result), (21548892160, 58225, Err(Why::Context)));
        let dev = |tokens: u64, out: u64, free: u64, deadline: u64| Fit {
            tokens_in: tokens,
            max_output: out,
            layers: Some(32),
            kv_heads: Some(8),
            head_dim: Some(128),
            kv_cache_bytes: Some(2),
            context_tokens: Some(32768),
            free_kv_bytes: Some(free),
            prefill_tps: Some(300),
            decode_tps: Some(50),
            queue_ms: 0,
            deadline_ms: deadline,
            frontier: false,
        };
        let e = admit(&dev(2000, 512, 2 * GIB, 20000));
        assert_eq!((e.kv_need, e.expected_ms, e.result), (329252864, 16907, Ok(())));
        let f = admit(&dev(30000, 1024, 8 * GIB, 60000));
        assert_eq!((f.kv_need, f.expected_ms, f.result), (4066377728, 120480, Err(Why::Deadline)));
        let mut g = fit70(1, estimate_tokens(&"x".repeat(3000)), 512, 0, 0, 500, 20 * GIB, 131072, 20000);
        g.prefill_tps = None;
        g.decode_tps = None;
        let g = admit(&g);
        assert_eq!((g.tokens_in, g.result), (1000, Err(Why::Unknown)));
        let h = admit(&fit70(1, estimate_tokens(&"会".repeat(3000)), 512, 4000, 60, 500, 20 * GIB, 131072, 20000));
        assert_eq!((h.tokens_in, h.kv_need, h.expected_ms, h.result), (3000, 575406080, 9784, Ok(())));
    }

    #[test]
    fn token_estimate_counts_non_ascii_scalars_one_each() {
        assert_eq!(estimate_tokens("Hello 会議"), 4);
        assert_eq!(estimate_tokens(""), 0);
        assert_eq!(estimate_tokens("abcd"), 2);
    }

    /// A missing free KV figure is `unknown` for an org card; a frontier card skips `memory` and needs no arch.
    #[test]
    fn no_free_kv_figure_is_unknown_but_frontier_skips_memory() {
        let mut org = fit70(1, 100, 512, 4000, 60, 0, 0, 131072, 20000);
        org.free_kv_bytes = None;
        assert_eq!(admit(&org).result, Err(Why::Unknown));
        let frontier = Fit { tokens_in: 100, max_output: 512, context_tokens: Some(200000), prefill_tps: Some(4000), decode_tps: Some(60), deadline_ms: 20000, frontier: true, ..Fit::default() };
        assert_eq!(admit(&frontier).result, Ok(()));
    }

    /// The shared vectors (`tests/ai_policy_v1.json`, copied from the Meeting Hub's `tests/vectors`): the token
    /// estimate and admission cases A to H, field for field.
    #[test]
    fn admission_matches_the_shared_vectors() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("ai_policy_v1.json");
        let raw = std::fs::read(&path).unwrap_or_else(|e| panic!("{} is needed (copy tests/vectors/ai_policy_v1.json): {e}", path.display()));
        let v: Value = serde_json::from_slice(&raw).unwrap();
        for t in v["token_estimate"].as_array().unwrap() {
            assert_eq!(estimate_tokens(t["text"].as_str().unwrap()), t["tokens"].as_u64().unwrap(), "{t}");
        }
        let cases = v["admission"].as_array().unwrap();
        assert!(cases.len() >= 8);
        for c in cases {
            let ev = |k: &str| -> Option<u64> {
                let e = &c[k];
                if e["source"].as_str() == Some("unknown") {
                    None
                } else {
                    e["value"].as_u64()
                }
            };
            let tokens_in = match c["text"].as_str() {
                Some(t) => estimate_tokens(t),
                None => c["tokens_in"].as_u64().unwrap(),
            };
            let f = Fit {
                tokens_in,
                max_output: c["max_output"].as_u64().unwrap(),
                layers: c["arch"]["layers"].as_u64(),
                kv_heads: c["arch"]["kv_heads"].as_u64(),
                head_dim: c["arch"]["head_dim"].as_u64(),
                kv_cache_bytes: c["kv_cache"].as_str().and_then(kv_bytes),
                context_tokens: c["context_tokens"].as_u64(),
                free_kv_bytes: c["free_kv_bytes"].as_u64(),
                prefill_tps: ev("prefill_tps"),
                decode_tps: ev("decode_tps"),
                queue_ms: c["queue_ms"].as_u64().unwrap_or(0),
                deadline_ms: c["deadline_ms"].as_u64().unwrap(),
                frontier: c["tier"].as_str() == Some("frontier"),
            };
            let a = admit(&f);
            let x = &c["expect"];
            let result = match a.result {
                Ok(()) => "admit",
                Err(w) => w.as_str(),
            };
            assert_eq!(a.tokens_in, x["tokens_in"].as_u64().unwrap(), "case {}", c["case"]);
            assert_eq!(result, x["result"].as_str().unwrap(), "case {}", c["case"]);
            if let Some(k) = x["kv_need"].as_u64() {
                assert_eq!(a.kv_need, k, "case {}", c["case"]);
            }
            if let Some(e) = x["expected_ms"].as_u64() {
                assert_eq!(a.expected_ms, e, "case {}", c["case"]);
            }
        }
    }

    #[test]
    fn cost_rounds_up_to_whole_micro_dollars() {
        assert_eq!(cost_micro(1, 0, 3_000_000, 15_000_000), 3);
        assert_eq!(cost_micro(1000, 500, 3_000_000, 15_000_000), 10500);
        assert_eq!(cost_micro(1, 1, 1, 1), 1);
        assert_eq!(Limits::of(2000, 5, 3), Limits { month_micro: 666_000_000, day_micro: 5_000_000 });
    }

    /// 11: 20 concurrent requests cannot together exceed the remaining budget.
    #[test]
    fn twenty_concurrent_reservations_never_cross_the_limit() {
        let b = Arc::new(Budgets::open(None));
        let now = 1_795_000_000_000;
        let limits = Limits { month_micro: 1_000_000_000, day_micro: 1_000_000 };
        b.reserve("seed", "ann@acme.example", 300_000, limits, now, 60_000).unwrap();
        b.settle("seed", "ann@acme.example", 300_000, now);
        // 700000 remains for ann today; each request reserves 100000: at most 7 fit
        let threads: Vec<_> = (0..20)
            .map(|i| {
                let b = b.clone();
                std::thread::spawn(move || b.reserve(&format!("r{i}"), "ann@acme.example", 100_000, limits, now, 60_000).is_ok())
            })
            .collect();
        let granted = threads.into_iter().map(|t| t.join().unwrap()).filter(|ok| *ok).count();
        assert_eq!(granted, 7);
        // someone else's day is separate, the month is shared
        assert!(b.reserve("bob", "bob@acme.example", 100_000, limits, now, 60_000).is_ok());
    }

    #[test]
    fn reservations_lapse_after_their_window_and_zero_limits_refuse() {
        let b = Budgets::open(None);
        let now = 1_795_000_000_000;
        let limits = Limits { month_micro: 100, day_micro: 100 };
        b.reserve("a", "p@x.example", 100, limits, now, 40_000).unwrap();
        assert!(b.reserve("b", "p@x.example", 1, limits, now + 39_999, 40_000).is_err());
        // not settled within twice the deadline: released
        assert!(b.reserve("c", "p@x.example", 100, limits, now + 40_001, 40_000).is_ok());
        assert!(b.reserve("d", "q@x.example", 1, Limits { month_micro: 0, day_micro: 100 }, now, 1).is_err());
        assert!(b.reserve("e", "q@x.example", 1, Limits { month_micro: 100, day_micro: 0 }, now, 1).is_err());
    }

    #[test]
    fn settled_spend_survives_a_restart() {
        let dir = crate::meet_tls::testpki::dir("ai-budgets");
        let path = dir.join("budgets.json");
        let now = 1_795_000_000_000;
        let limits = Limits { month_micro: 1000, day_micro: 1000 };
        let b = Budgets::open(Some(path.clone()));
        b.reserve("a", "p@x.example", 900, limits, now, 1000).unwrap();
        b.settle("a", "p@x.example", 800, now);
        let again = Budgets::open(Some(path));
        assert!(again.reserve("b", "p@x.example", 201, limits, now, 1000).is_err());
        assert!(again.reserve("c", "p@x.example", 200, limits, now, 1000).is_ok());
    }
}
