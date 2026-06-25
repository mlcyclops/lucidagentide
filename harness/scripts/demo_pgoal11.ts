// harness/scripts/demo_pgoal11.ts
//
// P-GOAL.11 (ADR-0056): the /goal loop's live SPEND meter + budget KILL SWITCH. Self-contained (no omp):
// drives the pure budget core + report/ledger integration, proving:
//   A. per-turn peak cost sums into total spend; context tokens track as a peak (never summed).
//   B. the kill switch trips at/above a positive cap and never on "no cap".
//   C. spend flows into the After-Action Report and the cross-run ledger/eval.
// Models the runGoal accounting loop turn-by-turn so the demo mirrors the real wiring.

import { addTurnSpend, newLoopSpend, normalizeBudget, overBudget } from "../../desktop/loop_budget.ts";
import { type LoopMetrics, renderLoopReport } from "../../desktop/loop_report.ts";
import { aggregateRuns, parseRunLog, runRecordLine, toRunRecord } from "../../desktop/loop_runlog.ts";

const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };
const must = (c: boolean, m: string) => { if (!c) fail(m); };

// ── A + B. simulate a loop with a $0.30 cap; each turn reports growing per-turn cost ────────────
const cap = normalizeBudget("0.30");
must(cap === 0.3, "budget normalize wrong");
// per-turn PEAK cost (USD) and PEAK context tokens, as usage_update would report them
const turns = [
  { peakCost: 0.08, peakCtx: 12_000 },
  { peakCost: 0.11, peakCtx: 21_000 },
  { peakCost: 0.14, peakCtx: 28_000 }, // running total after this = 0.33 → over the 0.30 cap
  { peakCost: 0.09, peakCtx: 30_000 }, // must never run
];
let spend = newLoopSpend();
let stoppedAt = 0;
for (let i = 0; i < turns.length; i++) {
  spend = addTurnSpend(spend, turns[i]!.peakCost, turns[i]!.peakCtx);
  if (overBudget(spend.usd, cap)) { stoppedAt = i + 1; break; }
}
console.log("== A+B. spend meter + kill switch ==");
must(stoppedAt === 3, `loop should stop on turn 3 when spend crosses the cap, got ${stoppedAt}`);
must(Math.abs(spend.usd - 0.33) < 1e-9, `total spend should be 0.33, got ${spend.usd}`);
must(spend.peakContextTokens === 28_000, `peak context should be 28000 (peak, not summed), got ${spend.peakContextTokens}`);
console.log(`   ✓ stopped on turn ${stoppedAt}: spent $${spend.usd.toFixed(2)} ≥ $${cap.toFixed(2)} cap (turn 4 never ran)`);
console.log(`   ✓ peak context ${spend.peakContextTokens} tokens (high-water mark, not 91000 summed)`);
must(!overBudget(999, 0), "a zero cap must never trip the kill switch");
console.log("   ✓ no cap (0) ⇒ kill switch never trips");

// ── C. spend surfaces in the AAR + the cross-run ledger ─────────────────────────
const metrics: LoopMetrics = {
  goal: "refactor the parser", condition: "tests pass", command: "npm test",
  outcome: "stopped", outcomeReason: `stopped: budget cap $0.30 reached (spent $0.33)`,
  iterations: 3, maxIters: 6, durationMs: 240_000,
  toolCalls: { shell: 7, edit: 5 }, loc: { added: 60, removed: 12, files: 3 },
  errors: [], websites: [], perIteration: [],
  spendUsd: spend.usd, peakContextTokens: spend.peakContextTokens, budgetUsd: cap,
};
const md = renderLoopReport(metrics);
must(md.includes("| Spend | $0.33 of $0.30 cap"), "AAR must show spend vs cap");
must(md.includes("peak context 28k"), "AAR must show peak context");
console.log("\n== C. report + ledger integration ==");
console.log("   ✓ After-Action Report shows: Spend $0.33 of $0.30 cap · peak context 28k");

const rec = toRunRecord(metrics, { id: "z", ts: 1 });
must(rec.spendUsd === 0.33 && rec.hasSpend === true, "ledger record must carry spend");
const stats = aggregateRuns(parseRunLog(runRecordLine(rec) + "\n" + runRecordLine(toRunRecord({ ...metrics, spendUsd: 0.10 }, { id: "y", ts: 2 })) + "\n"));
must(Math.abs(stats.totalSpendUsd - 0.43) < 1e-9, `cross-run total spend should be 0.43, got ${stats.totalSpendUsd}`);
console.log(`   ✓ run-log round-trips spend; cross-run eval totals $${stats.totalSpendUsd.toFixed(2)} across ${stats.runs} runs`);

console.log("\ndemo-P-GOAL.11 OK");
