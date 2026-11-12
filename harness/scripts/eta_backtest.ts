// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/eta_backtest.ts
//
// P-PROGRESS.4 (ADR-0413): replay finished turns and score the turn ETA. Two estimators, two corpora:
//   baseline = typicalEstimate (P-PROGRESS.1..3: p75 of recent turn lengths minus elapsed);
//   current  = estimateTurn    (P-PROGRESS.4: time left given the time already run);
//   synthetic = desktop/eta_backtest.ts syntheticTurns (deterministic, same numbers everywhere);
//   ledger    = this machine's latency ledger (~/.omp/lucid-latency.jsonl, or --ledger <path>), read only.
// --check (the demo) exits non-zero unless current beats baseline on the synthetic corpus on both measures.
// The ledger verdict is printed, not enforced: it differs per machine and may be absent.
//
// Run: bun run harness/scripts/eta_backtest.ts [--ledger <path>] [--check]

import { readFileSync } from "node:fs";
import { backtest, CHECKPOINTS, HIT_BAND, syntheticTurns, type BacktestScore } from "../../desktop/eta_backtest.ts";
import { LATENCY_LOG_PATH } from "../../desktop/latency_log.ts";
import { estimateTurn, humanMs, ledgerTurns, typicalEstimate, type TurnSample } from "../../desktop/turn_progress.ts";

const args = process.argv.slice(2);
const at = args.indexOf("--ledger");
const ledgerPath = at >= 0 && args[at + 1] ? args[at + 1]! : LATENCY_LOG_PATH;
const check = args.includes("--check");

function row(name: string, s: BacktestScore): string {
  const err = s.medianAbsErrMs === null ? "none" : `${humanMs(s.medianAbsErrMs)} (${(s.medianAbsErrMs / 1000).toFixed(1)} s)`;
  return `  ${name.padEnd(34)} answered ${String(s.predicted).padStart(5)}/${s.points}   median error ${err.padEnd(22)} within ${HIT_BAND * 100}%: ${(s.within30 * 100).toFixed(1)}%`;
}

/** Scores both estimators on one corpus and says whether the current one wins on both measures. */
function compare(label: string, turns: TurnSample[]): boolean {
  const base = backtest(turns, typicalEstimate);
  const cur = backtest(turns, estimateTurn);
  const beats = cur.within30 > base.within30 && cur.medianAbsErrMs !== null && (base.medianAbsErrMs === null || cur.medianAbsErrMs < base.medianAbsErrMs);
  console.log(`[${label}] ${turns.length} turns, ${base.points} checkpoints`);
  console.log(row("baseline (p75 minus elapsed)", base));
  console.log(row("current (time left given elapsed)", cur));
  console.log(`  current beats baseline on both measures: ${beats ? "yes" : "NO"}\n`);
  return beats;
}

console.log("== #ADR-0413 P-PROGRESS.4: the turn ETA, replayed against finished turns ==");
console.log(`asked at ${CHECKPOINTS.map((f) => `${f * 100}%`).join(", ")} of each turn; a hit is within +/-${HIT_BAND * 100}% of the real time left\n`);

const synthetic = compare("synthetic", syntheticTurns());

let text = "";
try { text = readFileSync(ledgerPath, "utf8"); } catch { text = ""; } // no ledger yet is not an error
const real = [...ledgerTurns(text.split("\n"))];
if (real.length) compare(`ledger ${ledgerPath}`, real);
else console.log(`[ledger] no finished turns at ${ledgerPath}; only the synthetic corpus was scored\n`);

if (check && !synthetic) { console.error("FAIL: the current estimator does not beat the baseline on the synthetic corpus"); process.exit(1); }
if (check) console.log("P-PROGRESS.4 demo: all checks passed.");
