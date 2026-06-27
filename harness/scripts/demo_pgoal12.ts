// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_pgoal12.ts
//
// P-GOAL.12 (ADR-0057): the Pre-Flight Audit. Self-contained (no omp): drives the pure core end-to-end —
//   A. readiness scoring is GATED L0→L3 (a long goal can't buy L3 without the safety-bearing four).
//   B. history awareness — prior runs of a similar loop are surfaced so context isn't lost.
//   C. the prompt-engineering interview matures the goal (model JSON parsed; user values win), folds in
//      user/PO + engineer feedback, and emits explicit success criteria the checker grades against.
//   D. a repeatable Loop Design report is rendered (and written) ready to adopt as the goal.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LoopRunRecord } from "../../desktop/loop_runlog.ts";
import {
  assessReadiness,
  maturedGoalFrom,
  mergeMatured,
  parsePreflightJson,
  type PreflightSpec,
  relevantPriorRuns,
  renderLoopDesign,
  successCriteria,
  summarizePriorRuns,
} from "../../desktop/loop_preflight.ts";

const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };
const must = (c: boolean, m: string) => { if (!c) fail(m); };

// ── A. gated readiness L0→L3 ───────────────────────────────────────────────────
console.log("== A. readiness is gated L0→L3 ==");
const base: PreflightSpec = { goal: "Make all auth tests pass and fix lint" };
must(assessReadiness(base).level === "L0", "bare objective should be L0");
must(assessReadiness({ ...base, doneDefinition: "42 auth tests green" }).level === "L1", "objective+done = L1");
must(assessReadiness({ ...base, doneDefinition: "all tests green", command: "npm test" }).level === "L2", "+verify = L2");
const l3spec: PreflightSpec = { ...base, doneDefinition: "42 auth tests green", command: "npm test && npm run lint", budgetUsd: 2, scope: "branch: feat/auth", checkerIsCheap: true };
const l3 = assessReadiness(l3spec);
must(l3.level === "L3", "safety-bearing four lift to L3");
must(assessReadiness({ ...l3spec, command: undefined }).level !== "L3", "no verify command can't be L3 (Verifier Theater)");
console.log(`   ✓ L0 → L1 → L2 → L3 gated; L3 score ${l3.score}/100; missing-verify is capped below L3`);

// ── B. history awareness ───────────────────────────────────────────────────────
console.log("\n== B. history awareness (don't lose past context) ==");
const history: LoopRunRecord[] = [
  { ts: 3, id: "c", goal: "fix auth tests and lint", outcome: "stopped", outcomeReason: "stopped: 3 lint errors remain", iterations: 6, maxIters: 6, durationMs: 1, tools: 9, toolsByType: {}, added: 0, removed: 0, hasLoc: false, errors: 1, websites: 0, spendUsd: 0.42, hasSpend: true },
  { ts: 2, id: "b", goal: "update the changelog", outcome: "met", outcomeReason: "done", iterations: 2, maxIters: 6, durationMs: 1, tools: 3, toolsByType: {}, added: 0, removed: 0, hasLoc: false, errors: 0, websites: 0, spendUsd: 0.05, hasSpend: true },
];
const relevant = relevantPriorRuns(history, base.goal, 3);
must(relevant.length === 1 && relevant[0]!.id === "c", "the auth-tests run is relevant; the changelog run is not");
must(summarizePriorRuns(relevant).includes("3 lint errors"), "history digest carries the prior blocker");
console.log(`   ✓ surfaced the relevant prior run: "${relevant[0]!.outcomeReason}" — so the new loop won't re-discover it`);

// ── C. interview maturation + criteria + feedback ──────────────────────────────
console.log("\n== C. interview → matured goal + success criteria ==");
const userSpec: PreflightSpec = { ...base, command: "npm test", feedback: "no flaky tests", engineerNotes: "use the existing fixture loader" };
// model returns JSON; user-provided command wins, model fills the blanks
const modelOut = `{"maturedGoal":"Make the 42 auth tests pass and the lint clean, without touching payments.","definitionOfDone":"npm test and npm run lint both exit 0","suggestedCommand":"make test","nonGoals":"refactor unrelated modules"}`;
const fields = parsePreflightJson(modelOut);
const matured = mergeMatured(userSpec, fields);
must(matured.command === "npm test", "user command wins over the model suggestion");
must(matured.doneDefinition === "npm test and npm run lint both exit 0", "model fills the done blank");
const crit = successCriteria(matured);
must(crit.includes("Honor (product-owner): no flaky tests"), "criteria carries PO feedback");
must(crit.includes("Honor (engineer): use the existing fixture loader"), "criteria carries engineer notes");
console.log("   ✓ matured goal + criteria the checker grades against:");
for (const line of crit.split("\n")) console.log(`     · ${line}`);

// ── D. the repeatable Loop Design report ───────────────────────────────────────
console.log("\n== D. Loop Design report ==");
const finalSpec: PreflightSpec = { ...matured, scope: "branch: feat/auth", budgetUsd: 2, maxIters: 6, checkerIsCheap: true };
const report = assessReadiness(finalSpec);
const md = renderLoopDesign(finalSpec, report, fields.maturedGoal ?? maturedGoalFrom(finalSpec), { total: history.length, relevant });
for (const needle of ["# Loop Design", "## Matured goal", "## Prior runs", "2 prior loop runs on record", "| User / PO feedback |", "| Engineer notes |", "## Readiness checklist"]) {
  must(md.includes(needle), `report missing ${needle}`);
}
const dir = mkdtempSync(join(tmpdir(), "pgoal12-"));
const out = join(dir, "loop.preflight.md");
writeFileSync(out, md, "utf8");
console.log(`   ✓ report carries readiness, matured goal, prior-run history, feedback, and a checklist`);
console.log(`   wrote ${out}`);

console.log("\ndemo-P-GOAL.12 OK");
