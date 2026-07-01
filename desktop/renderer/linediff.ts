// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/linediff.ts — P-CHAT.1 (ADR-0104): a small, pure line diff for the chat's inline edit
// preview. An omp `edit` tool call carries `oldText`/`newText`; this turns them into +/− rows the renderer
// colors green/red (with unchanged context lines). LCS-based, with a size guard so a pathological pair can't
// blow up the O(n·m) table — past the guard it degrades to "all old removed, all new added" (still correct,
// just not minimal). No DOM, no highlighting — pure data, unit-tested.

export type DiffRow = { type: "add" | "del" | "ctx"; text: string };

const MAX_CELLS = 4_000_000; // ~2000×2000 lines; beyond this, skip the LCS table and emit a coarse diff

/** Line-level diff of `oldText` → `newText`. Returns rows in order: context, deletions, additions. */
export function lineDiff(oldText: string, newText: string): DiffRow[] {
  const a = (oldText ?? "").split("\n");
  const b = (newText ?? "").split("\n");
  // Trim a trailing empty line that split() adds for a text ending in "\n" (avoids a phantom blank row).
  if (a.length && a[a.length - 1] === "") a.pop();
  if (b.length && b[b.length - 1] === "") b.pop();

  if (a.length * b.length > MAX_CELLS || a.length === 0 || b.length === 0) {
    return [...a.map((t): DiffRow => ({ type: "del", text: t })), ...b.map((t): DiffRow => ({ type: "add", text: t }))];
  }

  // LCS DP table (rows = a, cols = b).
  const n = a.length, m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  // Backtrack into an ordered row list.
  const rows: DiffRow[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { rows.push({ type: "ctx", text: a[i]! }); i++; j++; }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) { rows.push({ type: "del", text: a[i]! }); i++; }
    else { rows.push({ type: "add", text: b[j]! }); j++; }
  }
  while (i < n) { rows.push({ type: "del", text: a[i]! }); i++; }
  while (j < m) { rows.push({ type: "add", text: b[j]! }); j++; }
  return rows;
}

/** Count added / removed lines (for a compact "+N −M" summary on the collapsed step). */
export function diffStat(rows: DiffRow[]): { add: number; del: number } {
  let add = 0, del = 0;
  for (const r of rows) { if (r.type === "add") add++; else if (r.type === "del") del++; }
  return { add, del };
}

// P-CHAT.1: omp's `edit` tool sends a hashline PATCH string (not old/new text) — `+`/`−` content lines plus
// header (`[path#hash]`) and anchor directives (`SWAP`/`KEEP`/…). These classify a patch line for coloring
// and count its +/− for the collapsed-row badge, so an edit still shows an inline, colored change.
export type PatchLineType = "add" | "del" | "meta" | "ctx";
export function patchLineType(line: string): PatchLineType {
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-") || line.startsWith("−")) return "del";                 // - or − (minus sign)
  if (line.startsWith("[") || /^(SWAP|KEEP|DEL|INS|MOVE|REPL|@)/.test(line)) return "meta";
  return "ctx";
}
export function patchStat(patch: string): { add: number; del: number } {
  let add = 0, del = 0;
  for (const l of (patch ?? "").split("\n")) { const t = patchLineType(l); if (t === "add") add++; else if (t === "del") del++; }
  return { add, del };
}
