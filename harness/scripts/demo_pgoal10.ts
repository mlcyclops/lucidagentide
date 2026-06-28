// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_pgoal10.ts
//
// P-GOAL.10 (ADR-0055): the /goal loop's cross-run EVALUATION ledger. Self-contained (no omp): drives
// the pure run-log core end-to-end, proving:
//   A. a completed loop (a P-GOAL.9 LoopMetrics) projects to a compact JSONL record and round-trips.
//   B. aggregating a history yields the eval stats — success rate, avg iterations-to-success, summed
//      tool/LOC/errors, and a failure breakdown that collapses recurring blockers across runs.
//   C. a malformed line never poisons the history (append-only, best-effort).
// Writes a real run-log.jsonl you can inspect.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LoopMetrics } from "../../desktop/loop_report.ts";
import { aggregateRuns, parseRunLog, runRecordLine, summarizeRunStats, toRunRecord } from "../../desktop/loop_runlog.ts";

const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };
const must = (c: boolean, m: string) => { if (!c) fail(m); };

function m(over: Partial<LoopMetrics>): LoopMetrics {
  return {
    goal: "g", condition: "c", command: "npm test", outcome: "met", outcomeReason: "all pass",
    iterations: 3, maxIters: 6, durationMs: 120_000, toolCalls: { shell: 5, edit: 2 },
    loc: { added: 30, removed: 5, files: 2 }, errors: [], blocks: [], websites: [], perIteration: [], ...over,
  };
}

// ── A. project + round-trip ────────────────────────────────────────────────────
const runs: LoopMetrics[] = [
  m({ outcome: "met", iterations: 2, outcomeReason: "all pass" }),
  m({ outcome: "met", iterations: 4, outcomeReason: "all pass" }),
  m({ outcome: "stopped", iterations: 6, outcomeReason: "stopped: 3 of 12 tests fail", toolCalls: { shell: 9, edit: 4 } }),
  m({ outcome: "stopped", iterations: 6, outcomeReason: "stopped: 1 of 12 tests fail" }),
  m({ outcome: "error", iterations: 1, outcomeReason: "loop error: provider timeout", loc: null }),
];
const lines = runs.map((mm, i) => runRecordLine(toRunRecord(mm, { id: `r${i}`, ts: 1000 + i })));
const parsed = parseRunLog(lines.join("\n") + "\n");
must(parsed.length === 5, `expected 5 records, got ${parsed.length}`);
must(parsed[0]!.tools === 7 && parsed[2]!.tools === 13, "tool totals wrong after round-trip");
console.log("== A. project + JSONL round-trip ==\n   ✓ 5 LoopMetrics → 5 records; tool totals preserved (7, 13)");

// ── B. aggregate into eval stats ───────────────────────────────────────────────
const s = aggregateRuns(parsed);
console.log("\n== B. cross-run evaluation ==");
must(s.runs === 5 && s.succeeded === 2, "run/success counts wrong");
must(Math.abs(s.successRate - 0.4) < 1e-9, "success rate wrong");
must(Math.abs(s.avgItersToSucceed - 3) < 1e-9, "avg iters-to-succeed wrong (should be (2+4)/2=3)");
console.log(`   ✓ ${summarizeRunStats(s)}`);
console.log(`   ✓ success rate ${Math.round(s.successRate * 100)}% · avg ${s.avgItersToSucceed.toFixed(1)} iters to win · ${s.totalTools} tool calls`);
// the two "N of 12 tests fail" runs collapse into ONE recurring blocker; timeout is a second
must(s.topBlockers[0]!.count === 2, `top blocker should aggregate the 2 tests-fail runs, got ${s.topBlockers[0]!.count}`);
must(s.topBlockers.length === 2, `expected 2 distinct blockers, got ${s.topBlockers.length}`);
console.log(`   ✓ failure breakdown: "${s.topBlockers[0]!.reason}" ×${s.topBlockers[0]!.count}, then "${s.topBlockers[1]!.reason}"`);

// ── C. a malformed line is skipped, not fatal ──────────────────────────────────
const poisoned = `${lines[0]}\nthis is not json\n{"half":true}\n${lines[1]}\n`;
must(parseRunLog(poisoned).length === 2, "malformed lines must be skipped, valid ones kept");
console.log("\n== C. resilience ==\n   ✓ malformed/partial lines skipped; valid history preserved");

// ── artifact ───────────────────────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), "pgoal10-"));
const out = join(dir, "run-log.jsonl");
writeFileSync(out, lines.join("\n") + "\n", "utf8");
must(parseRunLog(readFileSync(out, "utf8")).length === 5, "artifact did not round-trip");
console.log(`\n== artifact ==\n   wrote ${out} (5 runs)`);
console.log("\ndemo-P-GOAL.10 OK");
