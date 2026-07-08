// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/answer_chips.ts
//
// P-CHAT.B: the PURE keystone of the inline tool-event chips. During a turn the agent's tool calls arrive
// interleaved with the answer tokens; on SETTLE we thread each tool call back into the finished answer as a
// compact, expandable CHIP at the point in the prose where it fired - its "anchor" is the answer length when
// the tool ran. This module is the DOM-free, tested logic the renderer wiring depends on: classify a tool into
// a chip kind, build a compact chip descriptor (with a +/- diffstat for edits/writes), and interleave chips
// into the answer at fence-aware BLOCK boundaries (never splitting a paragraph or a fenced code block).
// Mirrors the P-CHAT.A `answer_sections.ts` pattern - pure keystone here, QA-gated DOM wiring in app.ts.

import { diffStat, lineDiff, patchStat } from "./linediff.ts";

/** The subset of a tool step's authored code (P-CHAT.1 `ToolCode`) the pure layer needs to size a diffstat. */
export interface ChipCode {
  content?: string;
  oldText?: string;
  newText?: string;
  patch?: string;
}

export type ChipKind = "read" | "search" | "edit" | "write" | "run" | "fetch" | "task" | "other";

export interface ToolChip {
  /** Category - drives the chip icon + accent color. */
  kind: ChipKind;
  /** The tool word shown bold on the chip (the raw tool name, e.g. "search", "edit", "bash"). */
  k: string;
  /** Compact right-hand detail, whitespace-collapsed + truncated so a chip stays one glance wide. */
  detail: string;
  /** Added/removed line counts for an edit/write/patch step, else null. */
  diffstat: { add: number; del: number } | null;
  /** A failed tool call (renders in the amber "did not run" style). */
  failed: boolean;
}

/** A tool call captured during streaming: the answer-buffer length when it fired (the anchor), its chip, and
 *  an opaque payload the DOM layer round-trips (the ToolCode + detail used to build the drilldown panel). */
export interface ToolMark<T = unknown> {
  offset: number;
  chip: ToolChip;
  data: T;
}

/** An ordered piece of a settled turn: a run of answer prose, or a tool chip anchored between blocks. */
export type TurnPart<T = unknown> =
  | { kind: "prose"; md: string }
  | { kind: "chip"; chip: ToolChip; data: T };

const CHIP_DETAIL_MAX = 64;
const FENCE = /^\s*(?:```|~~~)/;

/** Non-phantom line count (a trailing newline does not add a blank line). */
function countLines(s: string): number {
  if (!s) return 0;
  const t = s.replace(/\n$/, "");
  return t === "" ? 0 : t.split("\n").length;
}

/** Classify a tool name into a chip kind. Mirrors `phaseIcon`/`phaseForTool` in app.ts so a chip's icon +
 *  accent match the rest of the activity surface. Order matters: edit/write win before the read/search set. */
export function classifyTool(name: string): ChipKind {
  const n = (name || "").toLowerCase();
  if (/edit|patch|apply/.test(n)) return "edit";
  if (/write|notebook|create/.test(n)) return "write";
  if (/read|grep|glob|search|find|^ls|list/.test(n)) return /read/.test(n) ? "read" : "search";
  if (/bash|shell|run|exec|command|eval/.test(n)) return "run";
  if (/fetch|web|http|browse/.test(n)) return "fetch";
  if (/task|agent|subagent|delegate/.test(n)) return "task";
  return "other";
}

/** Line-count diffstat from a tool step's authored code: a hashline `patch`, a written `content` (all adds),
 *  or an old->new pair (line diff). Reuses the P-CHAT.1 linediff helpers so there is one diffstat convention. */
function chipDiffstat(code?: ChipCode): { add: number; del: number } | null {
  if (!code) return null;
  if (code.patch !== undefined) return patchStat(code.patch);
  if (code.content !== undefined) return { add: countLines(code.content), del: 0 };
  if (code.oldText !== undefined || code.newText !== undefined) return diffStat(lineDiff(code.oldText ?? "", code.newText ?? ""));
  return null;
}

/** Build a compact chip descriptor from a tool event. Pure: detail is whitespace-collapsed + truncated; the
 *  diffstat is sized from `code`; `failed` marks a call that did not run. */
export function toolChip(name: string, detail: string, code?: ChipCode, failed = false): ToolChip {
  const raw = (detail ?? "").trim().replace(/\s+/g, " ");
  const d = raw.length > CHIP_DETAIL_MAX ? raw.slice(0, CHIP_DETAIL_MAX - 1).trimEnd() + "\u2026" : raw;
  return { kind: classifyTool(name), k: (name || "tool").trim(), detail: d, diffstat: chipDiffstat(code), failed };
}

/** Interleave tool chips into a settled answer at fence-aware BLOCK boundaries. Each mark's anchor offset is
 *  snapped UP to the next safe cut (the answer start/end, or a blank-line block boundary outside any fence), so
 *  a chip is placed between blocks - never mid-paragraph and never inside a ``` fence. Marks need not be sorted;
 *  chips that snap to the same boundary keep their original order. */
export function interleaveChips<T>(md: string, marks: readonly ToolMark<T>[]): TurnPart<T>[] {
  const text = (md ?? "").replace(/\r\n/g, "\n");
  if (!marks.length) { const b = text.trim(); return b ? [{ kind: "prose", md: b }] : []; }

  const lines = text.split("\n");
  const lineStart: number[] = [];
  { let o = 0; for (const ln of lines) { lineStart.push(o); o += ln.length + 1; } }

  // Mark every line that is a fence delimiter or fence interior, so a boundary can never fall inside code.
  const fenceInterior: boolean[] = new Array(lines.length).fill(false);
  { let inF = false; for (let i = 0; i < lines.length; i++) { if (FENCE.test(lines[i]!)) { fenceInterior[i] = true; inF = !inF; } else fenceInterior[i] = inF; } }

  // Safe cut offsets: the very start, the very end, and each block boundary (a non-fence line whose previous
  // non-fence line is blank). Sorted ascending by construction.
  const cuts: number[] = [0];
  for (let i = 1; i < lines.length; i++) {
    if (!fenceInterior[i] && !fenceInterior[i - 1] && lines[i - 1]!.trim() === "") cuts.push(lineStart[i]!);
  }
  cuts.push(text.length);

  const snap = (off: number): number => {
    const o = Math.max(0, Math.min(off, text.length));
    for (const c of cuts) if (c >= o) return c;
    return text.length;
  };

  const sorted = marks
    .map((m) => ({ chip: m.chip, data: m.data, cut: snap(m.offset), offset: m.offset }))
    .sort((a, b) => a.cut - b.cut || a.offset - b.offset);

  const parts: TurnPart<T>[] = [];
  let cursor = 0, i = 0;
  while (i < sorted.length) {
    const cut = sorted[i]!.cut;
    const prose = text.slice(cursor, cut).trim();
    if (prose) parts.push({ kind: "prose", md: prose });
    cursor = cut;
    while (i < sorted.length && sorted[i]!.cut === cut) { parts.push({ kind: "chip", chip: sorted[i]!.chip, data: sorted[i]!.data }); i++; }
  }
  const tail = text.slice(cursor).trim();
  if (tail) parts.push({ kind: "prose", md: tail });
  return parts;
}

/** True when interleaving produced at least one chip - otherwise the caller renders the answer with the
 *  P-CHAT.A section logic (or inline), exactly as a no-tool turn does today. */
export function shouldInterleave(parts: readonly TurnPart<unknown>[]): boolean {
  return parts.some((p) => p.kind === "chip");
}
