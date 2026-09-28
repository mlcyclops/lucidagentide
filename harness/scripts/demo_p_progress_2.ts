// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_p_progress_2.ts
//
// P-PROGRESS.2 (ADR-0408, amended 2026-09-27): the activity window shows what matters. The ETAs this
// increment first added (tool rows, subagent runs, the delegation head, the whole prompt) were cut on
// operator request as noise; the fold and the doing line stay.
//   [1] quick calls fold into one summary line; failed, repeated and empty calls are "processing";
//   [2] a call's doing line names its subject even when its arguments arrive as an object;
//   [3] no ETA or estimate is left on the progress surface a worker or a delegation card reads;
//   [4] a subagent run still says what it did and whether it finished, with no start or end clock.
//
// Run: bun run harness/scripts/demo_p_progress_2.ts

import { foldSummary, QUICK_MS, stepFate, stepKey } from "../../desktop/renderer/tool_fold.ts";
import { describeTool } from "../../desktop/renderer/tool_describe.ts";
import * as turnProgress from "../../desktop/turn_progress.ts";
import * as subagentFilter from "../../desktop/renderer/subagent_filter.ts";
import { listSubagentRuns, type SubagentIo } from "../../desktop/subagent_activity.ts";

const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };
const ok = (cond: boolean, m: string) => { if (!cond) fail(m); console.log(`  ok  ${m}`); };

console.log("== #ADR-0408 P-PROGRESS.2: fold the noise, and no ETAs ==\n");

console.log("[1] the fold rule");
const good = { informative: true, redundant: false, ok: true };
ok(stepFate({ ...good, elapsedMs: QUICK_MS - 1 }) === "quick", "a call under 5 s is summarized");
ok(stepFate({ ...good, elapsedMs: QUICK_MS }) === "row", "a call of 5 s or more keeps its own row");
ok(stepFate({ ...good, ok: false, elapsedMs: 60_000 }) === "processing", "a crash is processing, whatever its length");
ok(stepFate({ ...good, redundant: true, elapsedMs: 60_000 }) === "processing", "a repeat of an earlier call is processing");
ok(stepFate({ ...good, informative: false, elapsedMs: 100 }) === "processing", "a call that says nothing is processing");
ok(stepKey("bash", "git  status") === stepKey("execute", "git status\n"), "a repeat is the same tool kind and arguments, whitespace aside");
const line = foldSummary(["read", "read", "grep", "bash"], 1);
ok(line === "Read 2 files, 1 search, ran 1 command, processing 1", `the fold line reads: ${line}`);

console.log("\n[2] the doing line");
const d = describeTool({ name: "read", input: JSON.stringify({ path: "desktop/turn_progress.ts" }, null, 2) });
ok(d.doing === "Reading desktop/turn_progress.ts" && d.informative, "an object argument names its path, not its brace");
ok(!describeTool({ name: "tool", title: "tool" }).informative, "a bare \"tool\" call is flagged as saying nothing");

console.log("\n[3] no ETA on the progress surface");
const progressExports = Object.keys(turnProgress).sort().join(",");
ok(progressExports === "PROGRESS_TICK_MS,humanMs,progressView", `turn_progress exports only the dead-process view and length words: ${progressExports}`);
const filterExports = Object.keys(subagentFilter).sort().join(",");
ok(filterExports === "NO_RUNS_GRACE_MS,RUN_IDLE_MS,delegationSettled,filterRunsForBatch", `subagent_filter scopes and settles runs, and estimates nothing: ${filterExports}`);
ok(turnProgress.humanMs(185_000) === "3 m 5 s", "a settled long call still says how long it took");

console.log("\n[4] subagent runs");
const files: Record<string, string> = {
  "C:/s/parent/Scout.jsonl": [
    JSON.stringify({ type: "session", version: 3, id: "x", timestamp: "2026-09-27T01:34:27.654Z" }),
    JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "find the gate" }] } }),
    JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "grep", arguments: { pattern: "WorkspaceGate" } }] } }),
  ].join("\n"),
  "C:/s/parent/Scout.md": "done",
};
const norm = (p: string): string => p.replace(/\\/g, "/");
const io: SubagentIo = {
  exists: (p) => norm(p) === "C:/s/parent" || norm(p) in files,
  readText: (p) => files[norm(p)] ?? "",
  list: () => ["Scout.jsonl", "Scout.md"],
  mtime: () => 5_000,
  size: (p) => (files[norm(p)] ?? "").length,
};
const [run] = listSubagentRuns("C:/s/parent.jsonl", io);
ok(!!run && run.done && run.tools === 1 && run.assignment === "find the gate", "a finished run says what it was asked and what it did");
ok(!!run && !("startedAt" in run) && !("endedAt" in run), "a run view carries no start or end clock to estimate from");
ok(subagentFilter.delegationSettled([{ done: true, lastAt: 5_000 }], 5_000, 5_001), "a delegation whose runs finished settles once the turn has ended");

console.log("\nP-PROGRESS.2 demo: all checks passed.");
