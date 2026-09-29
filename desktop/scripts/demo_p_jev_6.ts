// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// demo-P-JEV.6 (ADR-0421): a judge whose account says the model does not exist is not asked again.
//
// The operator's screenshot: every judgment row read "openai/gpt-5.3-codex-spark failed: 404 The model
// `gpt-5.3-codex-spark` does not exist or you do not have access to it (model_not_found)" before the chain
// moved on. omp's smol priority patterns name that model for the openai-codex OAuth provider and the same
// pattern matches it under an API-key account that has no such model; omp cools down only 401/402/403, so
// the 404 was paid on every judgment. P-JEV.5 counted only LOCAL failures, so a cloud 404 never banned.
//
//   [1] the ledger: ONE report with the provider's missing-model wording bans, cloud or local; a transient
//       cloud failure (overloaded, 5xx, rate limit, abort) still never counts
//   [2] the in-process breaker: the missing model is refused BEFORE the second call with a plain Error
//   [3] the chain omp is told, through omp's REAL Settings loader and role resolver: the banned model is
//       absent, even when it is the session's chat model (judgePlan blanks it)
//
// Run with: bun run desktop/scripts/demo_p_jev_6.ts   (make demo-P-JEV.6)

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { formatModelStringWithRouting, resolveRoleChain } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { judgeChain, judgmentOverlayYaml } from "../judgment_policy.ts";
import { bannedJudges, isMissingModelError, JUDGE_BAN_FAILURES, noteJudgeOutcome } from "../../harness/judgment/judge_bans.ts";
import { JudgeBreaker, traceJudgePrototype, type JudgeLike } from "../../harness/omp/judgment_extension.ts";

let failures = 0;
const check = (cond: boolean, msg: string) => { console.log(`  ${cond ? "ok  " : "FAIL"} ${msg}`); if (!cond) failures++; };

const MISSING = "404 The model `gpt-5.3-codex-spark` does not exist or you do not have access to it. (type=invalid_request_error param=model_not_found)";
const SPARK = "openai/gpt-5.3-codex-spark";
const HAIKU = "anthropic/claude-haiku-4-5";
const LOCAL = "dgx-spark/glm-5.3-flash";
const LOCALS = ["dgx-spark"];

const mk = (provider: string, id: string, api: string) => ({ provider, id, name: id, api, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096 });
const pool = [mk("openai", "gpt-5.3-codex-spark", "openai-responses"), mk("anthropic", "claude-haiku-4-5", "anthropic-messages"), mk("dgx-spark", "glm-5.3-flash", "openai-completions")];
const agentDir = mkdtempSync(join(tmpdir(), "lucid-jev6-"));
async function resolved(label: string, yaml: string): Promise<string[]> {
  const f = join(agentDir, `${label}.yml`);
  writeFileSync(f, yaml);
  const s = await Settings.loadReadOnly({ agentDir, cwd: agentDir, configFiles: [f] });
  return resolveRoleChain("judge", s, pool as never).map((c) => formatModelStringWithRouting(c.model));
}

try {
  console.log("\n[1] the ledger: the operator's 404 bans from ONE report; a transient never counts");
  check(isMissingModelError(MISSING), "the provider's wording is recognized as a missing model");
  for (const e of ["overloaded", "429 rate limit exceeded", "502 Bad Gateway", "The operation was aborted.", "401 invalid api key"]) {
    check(!isMissingModelError(e), `"${e}" is not`);
  }
  let ledger = noteJudgeOutcome({}, { label: SPARK, error: MISSING }, LOCALS, 1);
  check(bannedJudges(ledger).includes(SPARK), `${SPARK} is banned after one 404 (cloud)`);
  check(ledger[SPARK]!.failures === JUDGE_BAN_FAILURES, `its count is the ban threshold (${JUDGE_BAN_FAILURES})`);
  ledger = noteJudgeOutcome(ledger, { label: "ollama/qwen3", error: 'model "qwen3" not found, try pulling it first' }, ["ollama"], 2);
  check(bannedJudges(ledger).includes("ollama/qwen3"), "a local model the runner never pulled is banned after one answer too");
  const before = ledger;
  for (let i = 0; i < 5; i++) ledger = noteJudgeOutcome(ledger, { label: HAIKU, error: "overloaded" }, LOCALS, 3 + i);
  check(ledger === before && !bannedJudges(ledger).includes(HAIKU), "five transient failures of a cloud judge leave the ledger untouched");

  console.log("\n[2] the in-process breaker: refused before the second call, with a plain Error");
  class Fake implements JudgeLike {
    calls = 0;
    constructor(public label: string, private readonly fail?: Error) {}
    async judge(_request: { state: unknown; questions: unknown }): Promise<unknown> { this.calls++; if (this.fail) throw this.fail; return { answers: {} }; }
  }
  class Missing extends Fake {}
  class Flaky extends Fake {}
  const breaker = new JudgeBreaker(LOCALS, []);
  traceJudgePrototype(Missing.prototype, "text", "master", async () => {}, breaker);
  traceJudgePrototype(Flaky.prototype, "text", "master", async () => {}, breaker);
  const q = { state: "s", questions: {} };
  const spark = new Missing(SPARK, new Error(MISSING));
  const errs: string[] = [];
  for (let i = 0; i < 3; i++) errs.push(await spark.judge(q).then(() => "", (e: Error) => `${e.name}: ${e.message}`));
  check(spark.calls === 1, `the missing model was called ${spark.calls} time over three judgments`);
  check(errs[0]!.includes("does not exist"), `the first answer is the provider's 404: ${errs[0]!.slice(0, 60)}...`);
  check(errs[1]!.startsWith("Error: lucid: ") && errs[1]!.includes("no such model"), `the second is refused before the call: ${errs[1]}`);
  const haiku = new Flaky(HAIKU, new Error("overloaded"));
  for (let i = 0; i < 3; i++) await haiku.judge(q).catch(() => {});
  check(haiku.calls === 3, "a cloud judge with transient failures is still asked every time");

  console.log("\n[3] the chain omp is told: the banned model is absent, even as the chat model");
  const banned = bannedJudges(ledger);
  const chatBanned = banned.includes(SPARK) ? "" : SPARK; // judgePlan(): a banned chat model is never NAMED
  const llm = await resolved("llm", judgmentOverlayYaml(judgeChain({ effective: "llm", keySet: false, locals: [LOCAL], chatModel: chatBanned })));
  check(!llm.includes(SPARK) && llm.join(",") === LOCAL, `llm with ${SPARK} as the chat model -> ${llm.join(" , ")}`);
  const llmOk = await resolved("llm-ok", judgmentOverlayYaml(judgeChain({ effective: "llm", keySet: false, locals: [LOCAL], chatModel: HAIKU })));
  check(llmOk.join(",") === `${LOCAL},${HAIKU}`, `an unbanned chat model is still last: ${llmOk.join(" , ")}`);
} finally {
  rmSync(agentDir, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} check(s) FAILED` : "\ndemo-P-JEV.6: all checks passed");
process.exit(failures ? 1 : 0);
