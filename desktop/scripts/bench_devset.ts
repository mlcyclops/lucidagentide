// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/bench_devset.ts - P-BENCH.2a (ADR-0591): score a local model on the long-context dev set.
//
// Point it at any OpenAI-compatible endpoint (Ollama, llama.cpp, vLLM, LM Studio):
//
//   bun run desktop/scripts/bench_devset.ts --base-url http://localhost:11434/v1 --model <model id> --context 32768
//
// It runs the 24 tasks twice through a real omp session built like a LUCID lane: once WITHOUT the artifact
// tools and once WITH them, and prints accuracy against input length for each, beside the two scripted
// references the model's scores sit between. The tool-result window is sized to the model's context window
// the way the app sizes it (ADR-0579), so the model is shown what a lane on that model would be shown.
//
// Options
//   --base-url <url>      the endpoint, usually ending in /v1                       (required)
//   --model <id>          the model id the endpoint knows                           (required)
//   --context <tokens>    the model's MEASURED context window                       (required)
//   --label <name>        how to name the model in the report                       (default: the id)
//   --lengths <a,b,...>   input lengths to run, from 8000, 64000, 512000            (default: all three)
//   --mode <m>            tools, no-tools or both                                   (default: both)
//   --window <w>          auto (sized to the context window) or omp (omp's default) (default: auto)
//   --timeout <seconds>   wall-clock limit per task                                 (default: 180)
//   --api-key-env <NAME>  environment variable holding a bearer key, if one is needed
//   --max-tokens <n>      output limit per reply                                    (default: 2048)
//   --out <file>          also write every result as JSON
//
// Nothing is sent anywhere but the endpoint you name. The data is generated locally from fixed seeds.

import { writeFileSync } from "node:fs";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { OMP_DEFAULT_THRESHOLD_KB, thresholdKbForContext, windowForThreshold } from "../result_window.ts";
import { POLICIES } from "../../harness/bench/devset/policies.ts";
import { endpointModel, policyModel, runDevset, type BenchModel, type RunOptions } from "../../harness/bench/devset/runner.ts";
import { summarize, summaryTable, type TaskResult } from "../../harness/bench/devset/scorer.ts";
import { buildDevset, DEVSET_LENGTHS, DEVSET_VERSION } from "../../harness/bench/devset/tasks.ts";
import { ScannerClient } from "../../harness/security/scanner_client.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const die = (m: string): never => { console.error(`bench_devset: ${m}\nSee the header of desktop/scripts/bench_devset.ts for the options.`); process.exit(2); };

const baseUrl = arg("base-url") ?? die("--base-url is required");
const modelId = arg("model") ?? die("--model is required");
const context = Number(arg("context") ?? die("--context is required: the model's measured context window in tokens"));
if (!Number.isFinite(context) || context < 1024) die("--context must be a number of tokens, at least 1024");
const label = arg("label") ?? modelId;
const lengths = (arg("lengths") ?? DEVSET_LENGTHS.join(",")).split(",").map((s) => Number(s.trim()));
for (const l of lengths) if (!(DEVSET_LENGTHS as readonly number[]).includes(l)) die(`--lengths takes values from ${DEVSET_LENGTHS.join(", ")}`);
const mode = arg("mode") ?? "both";
if (!["tools", "no-tools", "both"].includes(mode)) die("--mode is tools, no-tools or both");
const windowMode = arg("window") ?? "auto";
if (!["auto", "omp"].includes(windowMode)) die("--window is auto or omp");
const timeoutMs = Math.max(10, Number(arg("timeout") ?? 180)) * 1000;
const keyEnv = arg("api-key-env");
const apiKey = keyEnv ? (process.env[keyEnv] ?? die(`the environment variable ${keyEnv} is not set`)) : undefined;
const maxTokens = Number(arg("max-tokens") ?? 2048);

// The window a lane on this model is given (ADR-0579). At omp's default or above, nothing is overridden.
const thresholdKb = windowMode === "auto" ? thresholdKbForContext(context) : OMP_DEFAULT_THRESHOLD_KB;
const win = windowForThreshold(thresholdKb);
const settings = thresholdKb < OMP_DEFAULT_THRESHOLD_KB
  ? Settings.isolated({ "tools.artifactSpillThreshold": win.thresholdKb, "tools.artifactHeadBytes": win.headKb, "tools.artifactTailBytes": win.tailKb, "tools.artifactTailLines": win.tailLines })
  : undefined;

const tasks = buildDevset(lengths);
const scanner = new ScannerClient();
scanner.start();
const target = endpointModel({ label, baseUrl, model: modelId, contextWindow: context, maxTokens, ...(apiKey ? { apiKey } : {}) });
const all: { model: string; tools: boolean; results: TaskResult[] }[] = [];

async function run(model: BenchModel, tools: boolean, live: boolean): Promise<void> {
  const opts: RunOptions = { tools, scanner, timeoutMs, ...(settings ? { settings } : {}) };
  const results = await runDevset(model, tasks, opts, live ? (r) => console.log(`  ${r.id.padEnd(18)} ${String(r.score).padStart(5)}  ${r.error ? `FAILED: ${r.error}` : `answered ${JSON.stringify(r.given)} after ${r.tools.join(" > ") || "no tool"}`}`) : undefined);
  all.push({ model: model.label, tools, results });
  console.log(`\n${summaryTable(`${model.label}, artifact tools ${tools ? "ON" : "OFF"}`, summarize(results))}\n`);
}

console.log(`Dev set version ${DEVSET_VERSION}: ${tasks.length} tasks at ${lengths.map((l) => l.toLocaleString("en-US")).join(", ")} characters.`);
console.log(`Model ${label} at ${baseUrl}, context window ${context.toLocaleString("en-US")} tokens. A tool result is shown up to ${thresholdKb} KB${settings ? " (sized to the model)" : " (omp's default)"}.\n`);
try {
  console.log("Reference: a scripted reader that answers only from what it is shown (the ceiling without the tools)");
  await run(policyModel("reference reader", POLICIES["reads-view"]!), false, false);
  console.log("Reference: a scripted user of the artifact tools (the ceiling with them)");
  await run(policyModel("reference tool user", POLICIES["uses-tools"]!), true, false);
  if (mode !== "tools") { console.log(`${label} WITHOUT the artifact tools`); await run(target, false, true); }
  if (mode !== "no-tools") { console.log(`${label} WITH the artifact tools`); await run(target, true, true); }
  const out = arg("out");
  if (out) { writeFileSync(out, `${JSON.stringify({ devset: DEVSET_VERSION, model: label, modelId, baseUrl, contextTokens: context, windowKb: thresholdKb, at: new Date().toISOString(), runs: all }, null, 2)}\n`, "utf8"); console.log(`Results written to ${out}`); }
} finally { scanner.stop(); }
process.exit(0);
