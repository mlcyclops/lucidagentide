// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_pgoal9.ts
//
// P-GOAL.9 (ADR-0054): the /goal loop's After-Action Report + termination guards.
// Self-contained (no omp/network): drives the PURE report core end-to-end, proving:
//   A. the AAR renders every metric the user asked for - Tool Calls (by type), LOC (added/removed),
//      Errors Recorded, and Websites Visited - with portable Mermaid graphs + a text scoreboard.
//   B. the convergence-stall signature collapses a recurring blocker across rounds (#2 Infinite Fix Loop).
//   C. the report degrades honestly (no invalid empty charts) when a run did nothing.
// It writes a real report.md you can open to see the graphs render on GitHub / VS Code.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type LoopMetrics,
  normalizeToolName,
  renderLoopReport,
  stallSignature,
  summarizeLoop,
} from "../../desktop/loop_report.ts";

const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };
const must = (cond: boolean, m: string) => { if (!cond) fail(m); };

// ── A. A realistic finished loop → full After-Action Report ────────────────────
const metrics: LoopMetrics = {
  goal: "Make all auth tests pass and fix lint",
  condition: "npm test && npm run lint exits 0",
  command: "npm test && npm run lint",
  outcome: "met",
  outcomeReason: "all 42 tests pass, lint clean",
  iterations: 4,
  maxIters: 6,
  durationMs: 7 * 60_000 + 24_000,
  toolCalls: { shell: 14, edit: 9, read: 6, search: 4, "web-fetch": 2 },
  loc: { added: 213, removed: 88, files: 7 },
  errors: [
    { iter: 1, detail: "shell: command failed - exit 1 (TypeError in token.ts)" },
    { iter: 2, detail: "edit: rejected - file outside workspace" },
  ],
  blocks: [],
  websites: ["https://nodejs.org/api/test.html", "https://eslint.org/docs/latest/rules/no-unused-vars"],
  perIteration: [
    { n: 1, tools: 8, errors: 1, done: false, reason: "5 of 42 tests fail" },
    { n: 2, tools: 9, errors: 1, done: false, reason: "2 of 42 tests fail" },
    { n: 3, tools: 10, errors: 0, done: false, reason: "tests pass; 3 lint errors remain" },
    { n: 4, tools: 8, errors: 0, done: true, reason: "all 42 tests pass, lint clean" },
  ],
};

const md = renderLoopReport(metrics);
console.log("== After-Action Report - required sections & graphs ==");
for (const [label, needle] of [
  ["Tool Calls (by type) chart", "pie showData title Tool calls by type"],
  ["Tool Calls table", "| shell | 14 |"],
  ["LOC Changed graph", "bar [213, 88]"],
  ["LOC net summary", "+213 / -88"],
  ["Errors Recorded chart", "Errors recorded per iteration"],
  ["Errors table row", "exit 1 (TypeError"],
  ["Websites Visited", "https://eslint.org/docs/latest/rules/no-unused-vars"],
  ["Scoreboard", "Tool calls"],
  ["Per-iteration log", "## Per-iteration log"],
] as const) {
  must(md.includes(needle), `report missing ${label} (${needle})`);
  console.log(`   ✓ ${label}`);
}
console.log(`   summary: ${summarizeLoop(metrics)}`);

// ── B. Tool-name normalization + convergence-stall signature ───────────────────
console.log("\n== termination guards ==");
must(normalizeToolName("Bash") === "shell" && normalizeToolName("WebSearch") === "web-search", "tool normalization wrong");
console.log("   ✓ raw omp kinds group into stable types (Bash→shell, WebSearch→web-search)");
// the same blocker phrased with different numbers must collapse to ONE signature (→ stall detected)
const sigs = ["3 of 42 tests fail", "2 of 42 tests fail", "1 of 42 tests fail"].map(stallSignature);
must(sigs[0] === sigs[1] && sigs[1] === sigs[2], "stall signature failed to collapse a recurring blocker");
console.log("   ✓ recurring blocker collapses across rounds → loop stops 'not converging' (no infinite fix loop)");

// ── C. Honest degradation: a no-op run emits no invalid empty charts ───────────
const empty: LoopMetrics = {
  goal: "noop", condition: "c", outcome: "stopped", outcomeReason: "no progress for two iterations",
  iterations: 1, maxIters: 6, durationMs: 1200, toolCalls: {}, loc: null, errors: [], blocks: [], websites: [],
  perIteration: [{ n: 1, tools: 0, errors: 0, done: false, reason: "no actions taken" }],
};
const emptyMd = renderLoopReport(empty);
must(emptyMd.includes("_No tool calls recorded._"), "no-op report should state no tool calls");
must(emptyMd.includes("Not a git workspace"), "no-op report should note LOC unavailable");
must(!/```mermaid\s*```/.test(emptyMd) && !emptyMd.includes("pie showData title Tool calls by type\n```"), "no-op report emitted an invalid empty chart");
console.log("\n== honest degradation ==\n   ✓ a no-op run renders text fallbacks, never an empty/invalid Mermaid block");

// ── write a real artifact to inspect ───────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), "pgoal9-"));
const out = join(dir, "loop.report.md");
writeFileSync(out, md, "utf8");
console.log(`\n== artifact ==\n   wrote ${out}`);
console.log("   open it on GitHub / in VS Code to see the pie + bar charts render.");
console.log("\ndemo-P-GOAL.9 OK");
