// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_pbench2a.ts
//
// P-BENCH.2a (ADR-0591): the long-context dev set, scored through real omp sessions with the real scanner.
// No network: the two models here are scripted references, and the "local model" is a stand-in server that
// speaks the OpenAI-compatible protocol on loopback.
//
//   1. the dev set: 24 generated tasks whose bytes and answers match the checked-in manifest
//   2. a reader that answers only from what it is shown: right at 8,000 characters, wrong beyond
//   3. a user of the artifact tools: right at every length, for about the same context
//   4. the same tool user behind an OpenAI-compatible endpoint: the path a real local model takes
//   5. a model with an 8K context window: its tool-result window is 2 KB, so without the tools it is
//      wrong even at 8,000 characters, and with them it is still right
//   6. the scorer: an answer must be committed to, and a ranking gets partial credit
//
// To score a real model: bun run desktop/scripts/bench_devset.ts --base-url <url> --model <id> --context <tokens>
//
// Run: bun run harness/scripts/demo_pbench2a.ts

import { readFileSync } from "node:fs";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { startFakeEndpoint } from "../bench/devset/fake_endpoint.ts";
import { MANIFEST_FILE, manifestOf } from "../bench/devset/manifest.ts";
import { readsView, usesTools } from "../bench/devset/policies.ts";
import { endpointModel, policyModel, runDevset } from "../bench/devset/runner.ts";
import { scoreReply, summarize, summaryTable } from "../bench/devset/scorer.ts";
import { buildDevset, DEVSET_VERSION } from "../bench/devset/tasks.ts";
import { ScannerClient } from "../security/scanner_client.ts";

const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };
const ok = (m: string): void => console.log(`   ok - ${m}`);
const indent = (s: string): string => s.split("\n").map((l) => `      ${l}`).join("\n");

console.log("1) the dev set");
const tasks = buildDevset();
{
  const disk = JSON.parse(readFileSync(MANIFEST_FILE, "utf8"));
  if (JSON.stringify(manifestOf(tasks)) !== JSON.stringify(disk)) fail("the generated dev set does not match the checked-in manifest");
  const chars = tasks.reduce((n, t) => n + t.haystack.length, 0);
  ok(`version ${DEVSET_VERSION}: ${tasks.length} tasks, ${chars.toLocaleString("en-US")} characters generated from fixed seeds, every hash and answer equal to manifest.json`);
}

const scanner = new ScannerClient();
scanner.start();

console.log("2) a reader that answers only from what it is shown (artifact tools off)");
const reader = summarize(await runDevset(policyModel("reader", readsView), tasks, { tools: false, scanner }));
{
  console.log(indent(summaryTable("reference reader", reader)));
  if (reader.byLength["8000"] !== 100) fail("shown the whole result, the reader must be right");
  if (reader.byLength["64000"] !== 0 || reader.byLength["512000"] !== 0) fail("every longer answer sits in the part it is not shown");
  ok("100 at 8,000 characters, 0 at 64,000 and 512,000: the answers are in the middle omp does not show");
}

console.log("3) a user of the artifact tools (artifact tools on)");
const toolUser = summarize(await runDevset(policyModel("tool user", usesTools), tasks, { tools: true, scanner }));
{
  console.log(indent(summaryTable("reference tool user", toolUser)));
  if (toolUser.overall !== 100 || toolUser.errors !== 0) fail("the tools must answer every task at every length");
  ok(`100 at every length, for ${toolUser.meanContextChars.toLocaleString("en-US")} characters of tool results per task against the reader's ${reader.meanContextChars.toLocaleString("en-US")}`);
}

console.log("4) the tool user behind an OpenAI-compatible endpoint (the path a local model takes)");
{
  const fake = startFakeEndpoint(usesTools);
  const subset = tasks.filter((t) => t.length === 64_000);
  const s = summarize(await runDevset(endpointModel({ label: "stand-in", baseUrl: fake.baseUrl, model: "fake-local", contextWindow: 200_000 }), subset, { tools: true, scanner, timeoutMs: 60_000 }));
  fake.stop();
  if (s.overall !== 100 || s.errors !== 0) fail(`the endpoint path must score the same, got ${s.overall} with ${s.errors} failures`);
  ok(`${s.tasks} tasks at 64,000 characters through a streamed chat-completions endpoint with tool calls: ${s.overall}`);
}

console.log("5) a model with an 8K context window: omp shows it 2 KB of a tool result");
{
  const small = Settings.isolated({ "tools.artifactSpillThreshold": 2, "tools.artifactHeadBytes": 0.8, "tools.artifactTailBytes": 0.8, "tools.artifactTailLines": 25 });
  const short = tasks.filter((t) => t.length === 8_000);
  const without = summarize(await runDevset(policyModel("reader", readsView), short, { tools: false, scanner, settings: small }));
  const withTools = summarize(await runDevset(policyModel("tool user", usesTools), short, { tools: true, scanner, settings: small }));
  if (without.overall !== 0) fail(`with a 2 KB window even 8,000 characters is cut, got ${without.overall}`);
  if (withTools.overall !== 100) fail(`the tools must still answer, got ${withTools.overall}`);
  ok(`at 8,000 characters: ${without.overall} without the tools, ${withTools.overall} with them, on ${withTools.meanContextChars.toLocaleString("en-US")} characters of tool results per task`);
}
scanner.stop();

console.log("6) the scorer");
{
  const t = tasks.find((x) => x.id === "rank-64000-a")!;
  const ideal = scoreReply(t, `ANSWER: ${t.answer}`);
  const swapped = scoreReply(t, `ANSWER: ${t.answer.split(", ").reverse().join(", ")}`);
  const hedged = scoreReply(t, `It is probably ${t.answer}`);
  if (ideal !== 100 || !(swapped > 0 && swapped < 100) || hedged !== 0) fail("ranking scores are wrong");
  ok(`a ranking in the ideal order scores ${ideal}, the same files reversed ${swapped}, and a reply with no ANSWER line ${hedged}`);
}

console.log("\ndemo_pbench2a OK - the dev set is fixed and fingerprinted; what a model is shown bounds what it can answer; the artifact tools remove that bound; and the same run works against an OpenAI-compatible endpoint, which is how a local model is scored.");
process.exit(0);
