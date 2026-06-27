// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/runs/loc_count.ts
//
// P-LOC.1 (ADR-0031): PURE line-counting for AI-authored file mutations. No I/O, no DB,
// no omp imports — just deterministic functions over the shapes omp's `write`/`edit`
// tool_result events carry. Over-tested on purpose: the whole AI-LOC metric is only as
// honest as this counter.
//
// We count from omp's OWN post-apply signal, captured at the gate's tool_result hook:
//   - `write`  → details is undefined; input = { path, content }. The authored lines are
//                the lines of `content` (a create/overwrite; we don't have the prior file,
//                so removed_lines is 0 — see ADR-0031 for why that's the honest choice).
//   - `edit`   → details.diff (and details.perFileResults[].diff) is omp's unified diff of
//                the change actually applied. omp's diff rows are line-numbered
//                (`+42|code`, `-7|old`, ` 40|ctx`) but still begin with +/-/space at
//                column 0, so a column-0 scan counts both that format AND a plain unified
//                diff. This covers ALL edit modes (hashline — the default — plus replace,
//                patch, apply_patch) because we read the result, not the mode-specific input.

/** Count the lines in a written file body. "a\nb\n" and "a\nb" are both 2; "" is 0. */
export function countContentLines(content: string): number {
  if (content.length === 0) return 0;
  // A trailing newline terminates the last line rather than starting an empty one.
  const body = content.endsWith("\n") ? content.slice(0, -1) : content;
  return body.split("\n").length;
}

export interface DiffLineCount {
  added: number;
  removed: number;
}

/**
 * Count added/removed lines in a unified diff. Robust to omp's line-numbered rows
 * (`+12|...`, `-3|...`) AND plain unified diffs (`+code`, `-code`):
 *   - a row starting with '+' but not '++'  → added  (skips the `+++ ` file header)
 *   - a row starting with '-' but not '--'  → removed (skips the `--- ` file header)
 * Everything else (context ' ', hunk '@@', '\ No newline', gap/elision rows) is ignored.
 */
export function countDiffLines(diff: string): DiffLineCount {
  let added = 0;
  let removed = 0;
  if (!diff) return { added, removed };
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("++")) added++;
    else if (line.startsWith("-") && !line.startsWith("--")) removed++;
  }
  return { added, removed };
}

/** The minimal slice of an omp tool_result event the counter needs. */
export interface EditResultLike {
  toolName: string;
  isError?: boolean;
  input?: Record<string, unknown>;
  details?: {
    diff?: string;
    path?: string;
    perFileResults?: { path?: string; diff?: string; isError?: boolean }[];
  };
}

export interface EditCount {
  /** Whether this event is a countable, successful file mutation. */
  countable: boolean;
  tool: "write" | "edit" | "";
  added: number;
  removed: number;
  /** Files touched (best-effort; for attribution we record one row per file). */
  files: string[];
}

const NOT_COUNTABLE: EditCount = { countable: false, tool: "", added: 0, removed: 0, files: [] };

/**
 * Count an omp `write`/`edit` tool_result. Returns countable=false for anything else,
 * for errored results, and for results with nothing to count. PURE — never throws on a
 * malformed event; it degrades to not-countable.
 */
export function countEdit(ev: EditResultLike): EditCount {
  if (!ev || ev.isError === true) return NOT_COUNTABLE;
  const input = ev.input ?? {};

  if (ev.toolName === "write") {
    const content = typeof input.content === "string" ? input.content : "";
    const added = countContentLines(content);
    if (added === 0) return NOT_COUNTABLE;
    const path = typeof input.path === "string" ? input.path : undefined;
    return { countable: true, tool: "write", added, removed: 0, files: path ? [path] : [] };
  }

  if (ev.toolName === "edit") {
    const d = ev.details;
    const perFile = d?.perFileResults?.filter((r) => r && !r.isError && typeof r.diff === "string") ?? [];
    if (perFile.length > 0) {
      let added = 0;
      let removed = 0;
      const files: string[] = [];
      for (const r of perFile) {
        const c = countDiffLines(r.diff as string);
        added += c.added;
        removed += c.removed;
        if (typeof r.path === "string") files.push(r.path);
      }
      if (added === 0 && removed === 0) return NOT_COUNTABLE;
      return { countable: true, tool: "edit", added, removed, files };
    }
    if (typeof d?.diff === "string" && d.diff.length > 0) {
      const c = countDiffLines(d.diff);
      if (c.added === 0 && c.removed === 0) return NOT_COUNTABLE;
      const path = typeof d.path === "string" ? d.path : typeof input.path === "string" ? input.path : undefined;
      return { countable: true, tool: "edit", added: c.added, removed: c.removed, files: path ? [path] : [] };
    }
    return NOT_COUNTABLE;
  }

  return NOT_COUNTABLE;
}
