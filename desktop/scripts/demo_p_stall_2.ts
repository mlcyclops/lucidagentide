// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Increment P-STALL.2 - no turn cutoff, visible pending work (ADR-0263).
//
// P-STALL.1's 10-minute silence kill was murdering legitimately long turns: an agent that fans work
// out to subagents sits quiet far longer than any fixed clock while the work is genuinely running,
// and the kill threw it all away with "the model sent nothing for 10 minutes". This proves the fix:
// (1) the clock is GONE - no IDLE_MS, no Promise.race against the prompt; (2) the failure the clock
// actually guarded against (a dead omp child) now rejects EVENT-DRIVEN - proven with a REAL child
// process; (3) the user gets VISIBILITY instead: every { type:"slow" } notice names the open tool
// calls / spawned subagent tasks and how long each has been running.
//
// Run with: bun run desktop/scripts/demo_p_stall_2.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ACPClient } from "../acp.ts";
import { type PendingCall, pendingSnapshot, settleToolCall, trackToolCall } from "../turn_pending.ts";
import { pendingSummaryLine, slowPhaseLabel, slowToastCopy } from "../renderer/stall_notice.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) { console.error("  \u2717 " + msg); process.exit(1); }
  console.log("  \u2713 " + msg);
}

const DESKTOP = join(import.meta.dir, "..");

console.log("== #ADR-0263 P-STALL.2: no turn cutoff, visible pending work ==\n");

console.log("[1] the clock is gone - a turn is never killed for taking long");
const backend = readFileSync(join(DESKTOP, "acp_backend.ts"), "utf8");
assert(!backend.includes("IDLE_MS"), "IDLE_MS no longer exists in acp_backend");
assert(!/Promise\.race[\s\S]{0,200}promptContent/.test(backend), "the CHAT turn is awaited directly - no race against a stall promise (util completions keep their own deliberate background clocks)");
assert(!backend.includes("the model sent nothing for"), "the 'sent nothing for N minutes' kill message is gone");
assert(backend.includes("SLOW_NOTICE_MS = 120_000"), "the 2-minute visibility cadence STAYS (removal killed the cutoff, not the notices)");

console.log("\n[2] transport death still fails fast - proven with a REAL child process");
const dead = new ACPClient("bun", ["-e", "setTimeout(() => process.exit(7), 150)"], process.cwd());
dead.start();
let err = "";
try { await dead.request("session/prompt", {}); } catch (e) { err = e instanceof Error ? e.message : String(e); }
assert(err.includes("exited") && err.includes("7"), `a dead omp child REJECTS the in-flight request (got: "${err}")`);

console.log("\n[3] pending-work tracking: the turn can SAY what it is waiting on");
const open = new Map<string, PendingCall>();
trackToolCall(open, { toolCallId: "t1", rawInput: { agent: "explore", tasks: [{}, {}] }, title: "Map the fleet code" }, 0);
trackToolCall(open, { toolCallId: "t2", kind: "execute", title: "cargo build" }, 5 * 60_000);
assert(open.size === 2, "a subagent task and a tool call are both tracked as open");
settleToolCall(open, { toolCallId: "t2", status: "completed" });
assert(open.size === 1, "a terminal update closes exactly its call");
const snap = pendingSnapshot(open, 12 * 60_000);
assert(snap[0]!.label === "subagent explore ×2: Map the fleet code" && snap[0]!.elapsedMs === 12 * 60_000, "the snapshot names the spawned subagent batch with its true elapsed time");
assert(backend.includes("pendingSnapshot(this.openCalls"), "acp_backend rides the snapshot on every { type:'slow' } notice");
assert(/pending\?: PendingView\[\]/.test(backend), "the slow ChatEvent carries the pending list (additive contract)");

console.log("\n[4] the copy is honest: no cap, Stop is the exit, tasks are named");
const c = slowToastCopy(4 * 60_000, snap);
assert(!/\b(10|ten) minutes?\b/.test(c.desc), "the toast never names a cap (there is none)");
assert(c.desc.includes("Stop cancels"), "the one real way out (Stop) is named");
assert(c.desc.includes("subagent explore ×2"), "the toast lists what the turn is waiting on");
assert(slowPhaseLabel(4 * 60_000, snap) === "Working · waiting on 1 task · quiet for 4 min", "the HUD phase reads as WORK, not a hang");
assert(pendingSummaryLine(snap)!.includes("(12m)"), "elapsed minutes ride along");

console.log("\n\u2713 P-STALL.2 demo passed - long work runs to completion, death fails fast, and the wait is legible.");
