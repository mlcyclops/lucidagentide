// Contract AI-1 section 3.2: `lucid-relay ai bench <card_id>`. (1) Digest (org): the served weights' files hashed
// and compared with `weights_digest`. (2) Throughput: prefill and decode tokens per second at concurrency 1 with
// prompts of 2048, 8192 and (org) `limits.context_tokens` tokens, and (org) at `slots`. (3) Quality: the
// `ai-ask-bench-v1` suite (ai_gateway_suite.rs): answers at least 85% and valid citations at least 95%. (4) Prompt
// logging: no supported runtime reports it, so the result says `unknown`.
//
// The digest of a file list: one file is the SHA-256 of its bytes; several files are the SHA-256 of the lines
// `<sha256 hex>  <file name>\n` sorted by file name (the `sha256sum` listing of the folder). Without streaming, a
// prompt's prefill time is measured with a 1-token answer and decode from a 256-token answer minus that time.
//
// The result updates the card: `throughput` and `quality["lucid-ask"]` become `tested` with their sample sizes, and
// an org card's `limits` become `tested` once its full-context prompt was answered. A digest that does not match
// quarantines the card; throughput more than 20% below the card's earlier value marks it degraded. Approval stays
// with the admin (`ai approve`), and only after a passing benchmark.

use crate::ai_gateway_admit::estimate_tokens;
use crate::ai_gateway_ask::{user_prompt, SYSTEM};
use crate::ai_gateway_backend::{Backends, Credential, Prompt};
use crate::ai_gateway_cards::{Card, CardState, CardStore, Evidence};
use crate::ai_gateway_suite::{self as suite, Item};
use crate::codec::hex;
use aws_lc_rs::digest;
use serde_json::{json, Value};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const WEIGHT_EXTS: [&str; 6] = ["safetensors", "bin", "gguf", "pt", "pth", "onnx"];
const CALL_TIMEOUT: Duration = Duration::from_secs(600);

/// SHA-256 of a file, read in 8 MiB pieces.
pub fn file_sha256(path: &Path) -> Result<String, String> {
    let mut f = std::fs::File::open(path).map_err(|e| format!("cannot open {}: {e}", path.display()))?;
    let mut ctx = digest::Context::new(&digest::SHA256);
    let mut buf = vec![0u8; 8 << 20];
    loop {
        let n = f.read(&mut buf).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
        if n == 0 {
            break;
        }
        ctx.update(&buf[..n]);
    }
    Ok(hex(ctx.finish().as_ref()))
}

/// The digest of a file list (see the module comment), as `sha256:<hex>`.
pub fn files_digest(files: &[PathBuf]) -> Result<String, String> {
    if files.is_empty() {
        return Err("no weight files were given".into());
    }
    if files.len() == 1 {
        return Ok(format!("sha256:{}", file_sha256(&files[0])?));
    }
    let mut lines = Vec::new();
    for f in files {
        let name = f.file_name().and_then(|n| n.to_str()).ok_or_else(|| format!("{} has no file name", f.display()))?.to_string();
        lines.push((name, file_sha256(f)?));
    }
    lines.sort();
    let text: String = lines.iter().map(|(n, h)| format!("{h}  {n}\n")).collect();
    Ok(format!("sha256:{}", crate::codec::sha256_hex(text.as_bytes())))
}

/// The weight files of a model folder (vLLM and NIM serve from it): its files with a weights extension.
pub fn weight_files(dir: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|rd| rd.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.is_file() && p.extension().and_then(|x| x.to_str()).is_some_and(|x| WEIGHT_EXTS.contains(&x))).collect())
        .unwrap_or_default();
    out.sort();
    out
}

/// ASCII filler that the 4.1 estimate counts as `tokens` tokens.
fn filler(tokens: u64) -> String {
    let words = ["alpha ", "delta ", "gamma ", "omega ", "sigma "];
    let mut s = String::new();
    let mut i = 0;
    while estimate_tokens(&s) < tokens {
        s.push_str(words[i % words.len()]);
        i += 1;
    }
    s
}

/// One measured prompt size.
#[derive(Clone, Copy, Debug, Default)]
struct Rate {
    prefill_tps: u64,
    decode_tps: u64,
}

async fn measure(b: &Backends, card: &Card, cred: &Credential, tokens: u64) -> Result<Rate, String> {
    let user = format!("Reply with the word ok, then keep writing about the weather.\n{}", filler(tokens));
    let first = Prompt { system: "You are a benchmark.".into(), user: user.clone(), max_output: 1 };
    let t = Instant::now();
    let pre = b.complete(card, cred, &first, CALL_TIMEOUT).await?;
    let pre_ms = t.elapsed().as_millis().max(1) as u64;
    let full = Prompt { max_output: 256, ..first };
    let t = Instant::now();
    let done = b.complete(card, cred, &full, CALL_TIMEOUT).await?;
    let full_ms = t.elapsed().as_millis().max(1) as u64;
    let tokens_in = pre.tokens_in.unwrap_or(tokens);
    let out = done.tokens_out.unwrap_or_else(|| estimate_tokens(&done.text)).max(1);
    Ok(Rate { prefill_tps: tokens_in * 1000 / pre_ms, decode_tps: out * 1000 / full_ms.saturating_sub(pre_ms).max(1) })
}

/// The suite against a card: (right answers, valid citations, items run).
pub async fn quality(b: &Backends, card: &Card, cred: &Credential, items: &[Item], parallel: usize) -> (usize, usize, usize) {
    let (mut right, mut cited) = (0, 0);
    for chunk in items.chunks(parallel.max(1)) {
        let calls = chunk.iter().map(|it| {
            let snippets: Vec<(String, String, bool, String)> = it.snippets.iter().map(|s| (s.id.clone(), s.from.clone(), s.meeting, s.text.clone())).collect();
            let p = Prompt { system: SYSTEM.into(), user: user_prompt(&it.question, &snippets, &crate::meet_json::token_hex(4)), max_output: 256 };
            async move { b.complete(card, cred, &p, CALL_TIMEOUT).await }
        });
        for (it, r) in chunk.iter().zip(futures_util::future::join_all(calls).await) {
            if let Ok(c) = r {
                let (a, ci) = suite::score(it, &c.text);
                right += a as usize;
                cited += ci as usize;
            }
        }
    }
    (right, cited, items.len())
}

/// Run the benchmark of a card; `files` overrides the configured model folder for the digest. The result is the
/// JSON the console and `ai bench` show (no content: only figures).
pub async fn run(b: &Backends, card: &Card, cred: &Credential, files: &[PathBuf], now: i64) -> Value {
    let mut why: Vec<String> = Vec::new();
    // 1. digest
    let digest = if card.org() {
        let list = if files.is_empty() && !cred.model_path.is_empty() { weight_files(Path::new(&cred.model_path)) } else { files.to_vec() };
        let got = tokio::task::spawn_blocking(move || files_digest(&list)).await.unwrap_or_else(|e| Err(e.to_string()));
        match got {
            Ok(d) => {
                let ok = d == card.weights_digest;
                if !ok {
                    why.push("the served weights do not match weights_digest".into());
                }
                json!({"checked": true, "ok": ok, "sha256": d})
            }
            Err(e) => {
                why.push(format!("the weights could not be hashed: {e}"));
                json!({"checked": false, "ok": false, "sha256": ""})
            }
        }
    } else {
        json!({"checked": false, "ok": true, "sha256": ""})
    };
    // 2. throughput at concurrency 1
    let mut sizes = vec![2048u64, 8192];
    let context = card.limits.int("context_tokens");
    if card.org() {
        if let Some(c) = context {
            sizes.push(c.saturating_sub(card.limits.int("output_tokens").unwrap_or(256).min(1024) + 64).max(1));
        }
    }
    let mut rates = Vec::new();
    let mut full_context_ok = false;
    for (i, size) in sizes.iter().enumerate() {
        match measure(b, card, cred, *size).await {
            Ok(r) => {
                rates.push(r);
                if i == 2 {
                    full_context_ok = true;
                }
            }
            Err(e) => why.push(format!("the {size}-token prompt failed: {e}")),
        }
    }
    let c1 = (!rates.is_empty()).then(|| Rate { prefill_tps: rates.iter().map(|r| r.prefill_tps).min().unwrap_or(0), decode_tps: rates.iter().map(|r| r.decode_tps).min().unwrap_or(0) });
    // ... and at `slots` for an org card
    let mut at_slots = Value::Null;
    if card.org() && card.slots > 1 {
        let started = Instant::now();
        let calls = (0..card.slots).map(|_| {
            let p = Prompt { system: "You are a benchmark.".into(), user: format!("Write about the weather.\n{}", filler(2048)), max_output: 256 };
            async move { b.complete(card, cred, &p, CALL_TIMEOUT).await }
        });
        let done = futures_util::future::join_all(calls).await;
        let wall = started.elapsed().as_millis().max(1) as u64;
        let ok: Vec<_> = done.into_iter().filter_map(Result::ok).collect();
        if ok.len() as u64 == card.slots {
            let tin: u64 = ok.iter().map(|c| c.tokens_in.unwrap_or(2048)).sum();
            let tout: u64 = ok.iter().map(|c| c.tokens_out.unwrap_or_else(|| estimate_tokens(&c.text))).sum();
            at_slots = json!({"prefill_tps": tin * 1000 / wall, "decode_tps": tout * 1000 / wall, "at_concurrency": card.slots, "samples": card.slots});
        } else {
            why.push(format!("{} of {} requests at slots concurrency failed", card.slots - ok.len() as u64, card.slots));
        }
    }
    // 3. quality
    let items = suite::items();
    let (right, cited, n) = quality(b, card, cred, &items, card.slots.clamp(1, 8) as usize).await;
    let (answers_pct, citations_pct) = (suite::pct(right, n), suite::pct(cited, n));
    if answers_pct < suite::PASS_ANSWERS_PCT {
        why.push(format!("answers {answers_pct}% is below {}%", suite::PASS_ANSWERS_PCT));
    }
    if citations_pct < suite::PASS_CITATIONS_PCT {
        why.push(format!("valid citations {citations_pct}% is below {}%", suite::PASS_CITATIONS_PCT));
    }
    if c1.is_none() {
        why.push("no throughput could be measured".into());
    }
    let pass = why.is_empty();
    json!({
        "card_id": card.card_id, "at": now,
        "digest": digest,
        "throughput": {
            "c1": c1.map(|r| json!({"prefill_tps": r.prefill_tps, "decode_tps": r.decode_tps, "samples": rates.len() * 2})).unwrap_or(Value::Null),
            "slots": at_slots,
            "full_context": full_context_ok,
        },
        "quality": {"suite": suite::SUITE, "n": n, "answers_pct": answers_pct, "citations_pct": citations_pct},
        "prompt_logging": "unknown",
        "pass": pass,
        "why": why,
    })
}

/// Write a benchmark result into the card and its state (see the module comment). Returns the new state.
pub fn apply(store: &CardStore, card: &Card, result: &Value, now: i64) -> Result<CardState, String> {
    let mut st = store.state(&card.card_id);
    let mut raw = Value::Object(card.raw.clone());
    if result["digest"]["checked"] == true && result["digest"]["ok"] == false {
        st.quarantined = true;
    } else if result["digest"]["ok"] == true && card.org() {
        st.quarantined = false;
    }
    if let Some(c1) = result["throughput"]["c1"].as_object() {
        let (pre, dec) = (c1["prefill_tps"].as_u64().unwrap_or(0), c1["decode_tps"].as_u64().unwrap_or(0));
        let samples = c1["samples"].as_u64().unwrap_or(0);
        let before = (card.throughput.source == "tested").then(|| (card.throughput.int("prefill_tps"), card.throughput.int("decode_tps")));
        st.degraded = matches!(before, Some((Some(p), Some(d))) if pre * 10 < p * 8 || dec * 10 < d * 8);
        raw["throughput"] = Evidence::tested(json!({"prefill_tps": pre, "decode_tps": dec, "at_concurrency": 1}), samples, now).to_value();
    }
    if card.org() && result["throughput"]["full_context"] == true {
        let mut limits = card.limits.clone();
        limits.source = "tested".into();
        limits.observed_at = now;
        limits.sample_size = 1;
        raw["limits"] = limits.to_value();
    }
    let q = &result["quality"];
    raw["quality"] = json!({"lucid-ask": Evidence::tested(json!({"answers_pct": q["answers_pct"], "citations_pct": q["citations_pct"]}), q["n"].as_u64().unwrap_or(0), now).to_value()});
    st.bench = Some(result.clone());
    store.put(&raw)?;
    store.set_state(&card.card_id, &st)?;
    Ok(st)
}

/// Whether the last benchmark passed and is newer than the card's approval (an approval needs a pass after it).
pub fn passed(st: &CardState) -> bool {
    st.bench.as_ref().is_some_and(|b| b["pass"] == true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai_gateway_cards::testcards::org_card;

    #[test]
    fn file_lists_hash_like_a_sorted_sha256sum_listing() {
        let dir = crate::meet_tls::testpki::dir("ai-bench-digest");
        let (a, b) = (dir.join("b.safetensors"), dir.join("a.safetensors"));
        std::fs::write(&a, b"two").unwrap();
        std::fs::write(&b, b"one").unwrap();
        std::fs::write(dir.join("README.md"), b"x").unwrap();
        let listed = weight_files(&dir);
        assert_eq!(listed.len(), 2);
        let one = crate::codec::sha256_hex(b"one");
        let two = crate::codec::sha256_hex(b"two");
        let expect = crate::codec::sha256_hex(format!("{one}  a.safetensors\n{two}  b.safetensors\n").as_bytes());
        assert_eq!(files_digest(&listed).unwrap(), format!("sha256:{expect}"));
        assert_eq!(files_digest(&[b]).unwrap(), format!("sha256:{one}"));
        assert!(files_digest(&[]).is_err());
        assert!(estimate_tokens(&filler(2048)) >= 2048);
    }

    #[test]
    fn a_result_marks_the_card_tested_quarantined_or_degraded() {
        let dir = crate::meet_tls::testpki::dir("ai-bench-apply");
        let store = CardStore::new(&dir);
        let card = store.put(&org_card("llama", "https://h:1/v1", &["internal"])).unwrap();
        let result = json!({"digest": {"checked": true, "ok": false}, "throughput": {"c1": {"prefill_tps": 3000, "decode_tps": 40, "samples": 6}, "full_context": true}, "quality": {"n": 200, "answers_pct": 90, "citations_pct": 97}, "pass": false});
        let st = apply(&store, &card, &result, 1_795_000_000).unwrap();
        assert!(st.quarantined);
        assert!(st.degraded, "40 t/s decode is more than 20% below 60");
        assert!(!passed(&st));
        let again = store.get("llama").unwrap();
        assert_eq!((again.throughput.int("decode_tps"), again.throughput.sample_size, again.quality.int("answers_pct")), (Some(40), 6, Some(90)));
    }
}
