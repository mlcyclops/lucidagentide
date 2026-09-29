// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// demo-P-JEV.5 (ADR-0416): the Judge fixed, None by default, and no local model that failed more than once.
//
// The bug, reproduced first: with the legacy overlay LUCID wrote (providers.judgmentProvider), the PINNED omp
// migrates the value into its `judge` model role, whose default chain (`@tiny -> @smol -> @default`) resolves
// `@tiny` through omp's built-in "smol" priority patterns (`glm-5.3-flash`, `spark`, ...). A LUCID local
// provider on a DGX box (dgx-spark/glm-5.3-flash) matches those patterns and becomes the judge of every
// turn; when the box does not answer, the 4 s auto-thinking timeout ends every judgment ("The operation was
// aborted"), because omp rethrows a timeout instead of trying the next candidate.
//
// Then the fix, against omp's REAL Settings loader and role resolver (the same functions the child runs):
//   [1] none (the default): the overlay resolves to NO judge candidate, even with that local model in the pool
//   [2] llm: exactly LUCID's chain - enabled local providers, then the chat model; a banned local is absent
//   [3] typesafe / auto: Jev first, then the same
//   [4] the in-process breaker: a local judge is refused before the call from its second failure on, with a
//       plain Error (omp moves to the next candidate), never for a cloud judge
//
// Run with: bun run desktop/scripts/demo_p_jev_5.ts   (make demo-P-JEV.5)

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { formatModelStringWithRouting, resolveRoleChain } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { judgeChain, judgmentOverlayYaml } from "../judgment_policy.ts";
import { bannedJudges, noteJudgeOutcome } from "../../harness/judgment/judge_bans.ts";
import { LocalJudgeBreaker, traceJudgePrototype, type JudgeLike } from "../../harness/omp/judgment_extension.ts";

let failures = 0;
const check = (cond: boolean, msg: string) => { console.log(`  ${cond ? "ok  " : "FAIL"} ${msg}`); if (!cond) failures++; };

// A catalog pool the way omp sees one: the user's chat model, a fast cloud model, the LUCID local provider
// model whose id matches omp's smol patterns, and Jev. Shape: the fields the resolver reads.
const mk = (provider: string, id: string, api: string) => ({ provider, id, name: id, api, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096 });
const CHAT = "anthropic/claude-fable-5-1";
const LOCAL = "dgx-spark/glm-5.3-flash";
const pool = [mk("anthropic", "claude-fable-5-1", "anthropic-messages"), mk("anthropic", "claude-haiku-4-5", "anthropic-messages"), mk("dgx-spark", "glm-5.3-flash", "openai-completions"), mk("typesafe", "jev-latest", "typesafe-judgment")];
const agentDir = mkdtempSync(join(tmpdir(), "lucid-jev5-"));
async function resolved(label: string, yaml: string): Promise<string[]> {
  const f = join(agentDir, `${label}.yml`);
  writeFileSync(f, yaml);
  const s = await Settings.loadReadOnly({ agentDir, cwd: agentDir, configFiles: [f] });
  return resolveRoleChain("judge", s, pool as never).map((c) => formatModelStringWithRouting(c.model));
}

try {
  console.log("\n[0] the bug: the legacy overlay hands the judge role to the DGX local model");
  const legacy = await resolved("legacy", "providers:\n  judgmentProvider: llm\n");
  check(legacy[0] === LOCAL, `providers.judgmentProvider: llm -> omp's judge chain starts with ${legacy[0] ?? "(nothing)"} (the pattern-matched local model)`);
  const legacyAuto = await resolved("legacy-auto", "providers:\n  judgmentProvider: auto\n");
  check(legacyAuto.includes(LOCAL), `providers.judgmentProvider: auto -> ${legacyAuto.join(" , ")} (the local model is in the chain too)`);

  console.log("\n[1] none (the default): no judge candidate at all");
  const none = await resolved("none", judgmentOverlayYaml(judgeChain({ effective: "none", keySet: true, locals: [LOCAL], chatModel: CHAT })));
  check(none.length === 0, `omp resolves the judge role to (${none.join(" , ") || "empty"})`);

  console.log("\n[2] llm: local providers first, then the chat model; a banned local is left out");
  const llm = await resolved("llm", judgmentOverlayYaml(judgeChain({ effective: "llm", keySet: true, locals: [LOCAL], chatModel: CHAT })));
  check(llm.join(",") === `${LOCAL},${CHAT}`, `chain -> ${llm.join(" , ")}`);
  let ledger = noteJudgeOutcome({}, { label: LOCAL, error: "The operation was aborted." }, ["dgx-spark"], 1);
  check(bannedJudges(ledger).length === 0, "one failure does not ban");
  ledger = noteJudgeOutcome(ledger, { label: LOCAL, error: "The operation was aborted." }, ["dgx-spark"], 2);
  check(bannedJudges(ledger).includes(LOCAL), "the second failure bans it");
  const banned = bannedJudges(ledger);
  const llmBanned = await resolved("llm-banned", judgmentOverlayYaml(judgeChain({ effective: "llm", keySet: true, locals: [LOCAL].filter((l) => !banned.includes(l)), chatModel: CHAT })));
  check(llmBanned.join(",") === CHAT, `banned -> chain is ${llmBanned.join(" , ")} (the chat model only)`);

  console.log("\n[3] typesafe / auto: Jev first");
  const ts = await resolved("typesafe", judgmentOverlayYaml(judgeChain({ effective: "typesafe", keySet: false, locals: [LOCAL], chatModel: CHAT })));
  check(ts[0] === "typesafe/jev-latest" && ts.includes(CHAT), `typesafe -> ${ts.join(" , ")}`);
  const autoNoKey = await resolved("auto-nokey", judgmentOverlayYaml(judgeChain({ effective: "auto", keySet: false, locals: [LOCAL], chatModel: CHAT })));
  check(!autoNoKey.includes("typesafe/jev-latest"), `auto without a key -> ${autoNoKey.join(" , ")} (no Jev)`);

  console.log("\n[4] the in-process breaker (the judgment extension, wrapping the judge class)");
  class Fake implements JudgeLike {
    calls = 0;
    constructor(public label: string, private readonly fail?: Error) {}
    async judge(_request: { state: unknown; questions: unknown }): Promise<unknown> { this.calls++; if (this.fail) throw this.fail; return { answers: {} }; }
  }
  class Local extends Fake {}
  class Cloud extends Fake {}
  const breaker = new LocalJudgeBreaker(["dgx-spark"], []);
  traceJudgePrototype(Local.prototype, "text", "master", async () => {}, breaker);
  traceJudgePrototype(Cloud.prototype, "text", "master", async () => {}, breaker);
  const dead = new Local(LOCAL, new Error("The operation was aborted."));
  const q = { state: "s", questions: {} };
  const errs: string[] = [];
  for (let i = 0; i < 3; i++) errs.push(await dead.judge(q).then(() => "", (e: Error) => `${e.name}: ${e.message}`));
  check(dead.calls === 2, `the local model was called ${dead.calls} times over three judgments`);
  check(errs[2]!.startsWith("Error: lucid: ") && errs[2]!.includes("not asked after 2 failed"), `the third is refused before the call: ${errs[2]}`);
  const cloud = new Cloud("anthropic/claude-haiku-4-5", new Error("overloaded"));
  for (let i = 0; i < 3; i++) await cloud.judge(q).catch(() => {});
  check(cloud.calls === 3, "a cloud judge is never refused");
} finally {
  rmSync(agentDir, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} check(s) FAILED` : "\ndemo-P-JEV.5: all checks passed");
process.exit(failures ? 1 : 0);
