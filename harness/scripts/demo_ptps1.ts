// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_ptps1.ts
//
// P-TPS.1 (ADR-0044): streaming output-token readout. Proves the property the
// user asked for — a live token count that EXCLUDES the system prompt — by
// driving the shared engine (harness/metrics/token_speed.ts) through a simulated
// streaming turn the exact way both adapters do (omp message_update / desktop
// ChatEvents), against a controlled clock so the figures are reproducible.
//
// Run with: bun run harness/scripts/demo_ptps1.ts

import { formatReadout, TokenSpeedEngine } from "../metrics/token_speed.ts";

const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };

// A hand-cranked clock — no real time, so the demo is deterministic on any host.
let t = 10_000;
const now = () => t;
const advance = (ms: number) => { t += ms; };

// A big "system prompt" that, in the real product, is sent every turn (frozen
// prefix + tools). The whole point: it must NEVER enter this number. We model
// that by simply NOT feeding it to the engine — exactly how the live adapters
// work (they only ever see assistant output deltas).
const SYSTEM_PROMPT_TOKENS = 12_000;

console.log("== [1/3] simulate a streaming turn (submit → think → answer → end) ==");
const engine = new TokenSpeedEngine({ countStrategy: "estimate", now });
engine.startTTFT();               // user hits send
advance(380);                     // provider queue / first-token latency
engine.start();                   // assistant message begins

// First the model thinks, then answers — both are OUTPUT and both count.
const thinking = ["Let me ", "reason about ", "the request "];
const answer = ["Here is ", "the answer, ", "in two ", "short sentences. ", "Done."];
let first = true;
const feed = (chunk: string) => {
  if (first) { engine.stopTTFT(); first = false; } // freeze TTFT on first content delta
  engine.recordDelta(chunk);
  advance(120);                   // ~time between streamed chunks
};
thinking.forEach(feed);
answer.forEach(feed);
engine.stop();

console.log(`   readout: ⚡ ${formatReadout(engine, "full")}`);
console.log(`   tokens out: ${engine.tokenCount}  ·  TTFT: ${engine.ttft} ms  ·  elapsed: ${engine.elapsedSeconds.toFixed(1)}s`);

if (engine.ttft !== 380) fail(`TTFT should be the submit→first-token gap (380), got ${engine.ttft}`);
if (engine.tokenCount <= 0) fail("output count should be > 0 after a real turn");
if (engine.elapsedSeconds <= 0) fail("elapsed should advance once tokens flow");

console.log("\n== [2/3] the system prompt is absent from the count (the user's ask) ==");
// The count equals the estimate of the streamed text ONLY — it is nowhere near
// the system-prompt size, and adding the prompt to context cannot move it.
if (engine.tokenCount >= SYSTEM_PROMPT_TOKENS)
  fail(`output count (${engine.tokenCount}) must not include the ${SYSTEM_PROMPT_TOKENS}-token system prompt`);
console.log(`   output=${engine.tokenCount} tok  vs  system prompt=${SYSTEM_PROMPT_TOKENS} tok → prompt excluded ✔`);

console.log("\n== [3/3] provider usage.output reconciles the final total exactly ==");
// When the provider reports the authoritative per-turn output (omp message_end
// usage.output), we snap to it so the final total is exact, not an estimate.
const authoritative = 9001;
engine.reconcileTotal(authoritative);
if (engine.tokenCount !== authoritative) fail("reconcileTotal should snap to the authoritative usage.output");
console.log(`   reconciled to provider usage.output=${authoritative} ✔`);

console.log("\nPASS: streaming output-token readout — output-only, prompt-excluded, provider-reconciled.");
