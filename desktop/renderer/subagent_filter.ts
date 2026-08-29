// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/subagent_filter.ts - pure (DOM-free) run filtering for delegation cards.
//
// P-TASK.5 polls /api/subagents, which returns ALL runs in the parent session; with two `task`
// batches in one turn every card rendered the UNION of runs while its header claimed its own
// batch size. Scope each card to its own batch here: by task id when the delegation carried
// explicit ids (rawInput.tasks[].id), else by assignment-prefix matching, with a single-card
// fallback so a lone batch keeps working even when neither yields a match.

/** The subset of a P-TASK.5 run view the filter needs (see bridge.subagents()). */
export interface BatchRun { name: string; assignment: string }

export interface SubagentBatch {
  /** Per-task ids from the delegation rawInput; absent when they were all auto-generated. */
  names?: string[];
  /** The batch's assignment/description texts (already capped at 200 chars by the backend). */
  assignments: string[];
  /** True when this is the only delegation card in the current turn (enables the show-all fallback). */
  soleCard: boolean;
}

/** trim + collapse whitespace + first 200 chars, so a capped batch assignment and the run's full
 *  assignment compare as prefixes of each other regardless of wrapping. */
const norm = (s: string): string => s.trim().replace(/\s+/g, " ").slice(0, 200);

/** Keep only the runs that belong to `batch`. Matched results are capped at the batch size
 *  (the header count); an empty match on the turn's only card falls back to showing all runs. */
export function filterRunsForBatch<R extends BatchRun>(runs: readonly R[], batch: SubagentBatch): R[] {
  if (!runs.length) return runs.slice();
  let matched: R[];
  if (batch.names && batch.names.length) {
    const names = new Set(batch.names);
    matched = runs.filter((r) => names.has(r.name));
  } else {
    const batchAsg = batch.assignments.map(norm).filter(Boolean);
    matched = runs.filter((r) => {
      const ra = norm(r.assignment);
      return !!ra && batchAsg.some((a) => a.startsWith(ra) || ra.startsWith(a));
    });
  }
  if (matched.length) {
    const size = Math.max(batch.assignments.length, batch.names?.length ?? 0);
    return size > 0 ? matched.slice(0, size) : matched;
  }
  return batch.soleCard ? runs.slice() : matched;
}
