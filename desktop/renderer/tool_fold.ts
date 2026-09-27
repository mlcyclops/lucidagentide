// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/tool_fold.ts - P-PROGRESS.2: which tool steps earn a row of their own in the activity
// window, and what the rest fold into. DOM-free.
//
// A row per call buried the few calls worth reading (the long ones) under dozens of sub-second reads, and a
// call with nothing to say ("tool", no arguments) was a row too. The rule the operator set:
//   - a call that finished in under QUICK_MS folds into ONE summary line for its run of quick calls
//     ("Read 3 files, 2 searches, ran 1 command"),
//   - a call that failed, repeated an earlier call of this turn, or carries no information shows only as
//     "processing" (a count on the same kind of fold line), never as its own row,
//   - everything else (a call still running at QUICK_MS, or one that took longer) keeps its full row: what it
//     is doing, the real tool, its arguments, and how long it took.
// Nothing is thrown away: every folded call stays listed under its fold line's chevron.

import { classifyTool, type ChipKind } from "./answer_chips.ts";

/** A call shorter than this is summarized, not shown as a row. */
export const QUICK_MS = 5_000;

export type StepFate = "row" | "quick" | "processing";

export interface FateInput {
  /** The doing line says something specific (tool_describe `informative`). */
  informative: boolean;
  /** The same call (tool and arguments) already ran this turn. */
  redundant: boolean;
  /** The call's outcome; undefined while no report has arrived. */
  ok?: boolean;
  /** How long the call took, when the settle report said. */
  elapsedMs?: number;
}

/** Where a SETTLED call belongs. Order is the operator's: a crash or a repeat is processing whatever its
 *  length, an empty call is processing, then length decides between the summary and a row. Pure. */
export function stepFate(i: FateInput): StepFate {
  if (i.ok === false || i.redundant || !i.informative) return "processing";
  if (i.elapsedMs !== undefined && Number.isFinite(i.elapsedMs) && i.elapsedMs >= 0 && i.elapsedMs < QUICK_MS) return "quick";
  return "row";
}

/** The identity of a call for repeat detection: its tool and its arguments, whitespace-folded. Empty when the
 *  call carried no arguments at all (nothing to compare; it is not called a repeat). Pure. */
export function stepKey(name: string, input?: string, intent?: string): string {
  const args = (input ?? "").trim() || (intent ?? "").trim();
  if (!args) return "";
  return `${classifyTool(name)}|${args.replace(/\s+/g, " ").toLowerCase()}`;
}

const PHRASE: Record<ChipKind, [string, string]> = {
  read: ["read 1 file", "read # files"],
  search: ["1 search", "# searches"],
  edit: ["edited 1 file", "edited # files"],
  write: ["wrote 1 file", "wrote # files"],
  run: ["ran 1 command", "ran # commands"],
  fetch: ["fetched 1 page", "fetched # pages"],
  task: ["1 delegation", "# delegations"],
  other: ["1 other step", "# other steps"],
};
const ORDER: readonly ChipKind[] = ["read", "search", "edit", "write", "run", "fetch", "task", "other"];

/** The fold line: the quick calls by kind, then the processing count. "Read 3 files, 2 searches, ran 1
 *  command, processing 2". Only processing: "Processing (3)". Pure. */
export function foldSummary(quick: readonly string[], processing: number): string {
  const counts: Partial<Record<ChipKind, number>> = {};
  for (const name of quick) {
    const k = classifyTool(name);
    counts[k] = (counts[k] ?? 0) + 1;
  }
  const bits: string[] = [];
  for (const k of ORDER) {
    const n = counts[k];
    if (!n) continue;
    const [one, many] = PHRASE[k];
    bits.push(n === 1 ? one : many.replace("#", String(n)));
  }
  const p = processing > 0 ? Math.floor(processing) : 0;
  if (!bits.length) return p ? `Processing (${p})` : "";
  if (p) bits.push(`processing ${p}`);
  const line = bits.join(", ");
  return line.charAt(0).toUpperCase() + line.slice(1);
}
