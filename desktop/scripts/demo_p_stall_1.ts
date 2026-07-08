// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Increment P-STALL.1 — patience for overloaded providers (ADR-0186). At peak times Claude / Gemini /
// GPT can sit for minutes before the first token. LUCID used to kill the turn at 5 minutes with an
// error that falsely said "2 minutes"; the wait itself looked like a hang. Now: the turn stays alive
// for 10 minutes, a { type:"slow" } event fires at each silent 2-minute mark so the HUD says "still
// waiting on the provider" (plus a once-per-turn toast naming the cap), and the final stall error
// states the REAL wait, derived from the constant so it can never go stale again.
//
// Run with: bun run desktop/scripts/demo_p_stall_1.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TURN_PATIENCE_MS, slowPhaseLabel, slowToastCopy } from "../renderer/stall_notice.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) { console.error("  ✗ " + msg); process.exit(1); }
  console.log("  ✓ " + msg);
}

console.log("== #ADR-0186 P-STALL.1: patience for overloaded providers ==\n");

const backend = readFileSync(join(import.meta.dir, "..", "acp_backend.ts"), "utf8");

console.log("[1] the turn waits 10 minutes, not 5 - and the message can never lie again");
assert(/IDLE_MS = 600_000/.test(backend), "chat patience is 600_000 ms (10 min) - overload no longer throws away the queue position");
assert(backend.includes("Math.round(Backend.IDLE_MS / 60_000)"), "the stall error DERIVES its duration from the constant (the old text hardcoded '2 minutes' at a 5-minute cap)");
assert(!backend.includes("did not respond for 2 minutes"), "the stale wording is gone");

console.log("\n[2] a silent provider is VISIBLE, not a frozen pane");
assert(/SLOW_NOTICE_MS = 120_000/.test(backend), "a { type:'slow' } event fires at each silent 2-minute mark");
assert(backend.includes('{ type: "slow"; waitedMs: number }'), "the event is part of the ChatEvent contract");
assert(slowPhaseLabel(240_000) === "Still waiting on the provider · silent for 4 min", "the HUD phase line counts the silence honestly");

console.log("\n[3] the toast tells the user the wait is deliberate");
const c = slowToastCopy(120_000, TURN_PATIENCE_MS);
assert(c.desc.includes("10 minutes") && c.desc.includes("Stop cancels"), "copy names the cap + the way out (Stop)");
assert(TURN_PATIENCE_MS === 600_000, "the renderer's cap constant is in lockstep with the backend (pinned by test)");

console.log("\n✓ P-STALL.1 demo passed — overloaded models get 10 patient minutes, and the user watches the wait instead of a hang.");
