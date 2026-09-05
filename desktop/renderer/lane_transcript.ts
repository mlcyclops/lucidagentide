// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/lane_transcript.ts
//
// P-FLEET.L7: the lane card's transcript MODEL. Today `paintOutput` rebuilds the whole card with
// `innerHTML =` on every token, which destroys text selection mid-stream and slams every open chevron shut.
// The fix starts here: give every turn and every tool call a STABLE id so a repaint can PATCH the DOM
// instead of rebuilding it. This module is the DOM-free, tested half of that: id minting, the chip glance
// line, the chevron drilldown body, and the clipboard text.
//
// Two delegations are load-bearing, not stylistic. The glance line comes from `answer_chips.toolChip`, so a
// lane chip and a master-composer chip for the SAME call cannot disagree about its kind or its diffstat.
// The drilldown rows come from `linediff`, so a lane diff and a master diff count and classify lines the
// same way. Reimplementing either here is how the two surfaces drift apart.

import { toolChip } from "./answer_chips.ts";
import type { ToolChip } from "./answer_chips.ts";
import { lineDiff, patchLineType } from "./linediff.ts";
import type { DiffRow } from "./linediff.ts";

/** Mirrors desktop/fleet_lanes.ts LaneToolCode. */
export interface LaneToolCode { path: string; content?: string; oldText?: string; newText?: string; patch?: string }

/** P-FLEET.L7: one tool call in a lane transcript. `input` is the bounded, code-stripped rawInput JSON the
 *  engine now carries: literally "the command used", shown in the chevron drilldown for tools that authored
 *  no code (bash/read/search/fetch). */
export interface LaneToolRow { id: string; name: string; detail: string; code?: LaneToolCode; input?: string; open: boolean }

export interface LaneTurnRow {
  id: string;
  role: "user" | "assistant";
  text: string;
  thinking?: string;
  tools: LaneToolRow[];
  error?: string;
  /** data: URLs of images pasted onto a user turn. */
  images?: string[];
}

/** The chevron drilldown body.
 *  - "diff": authored code (content / oldText+newText / patch) -> DiffRow[] via linediff, patch rows kept raw.
 *  - "input": no authored code but the engine carried the command/rawInput -> show it verbatim.
 *  - "detail": neither -> the tool title. Never an empty panel: `text` is non-empty whenever hasBody. */
export type LaneChipBody =
  | { kind: "diff"; rows: { type: "add" | "del" | "ctx"; text: string }[] }
  | { kind: "input"; text: string }
  | { kind: "detail"; text: string };

/** Bounds. A lane card is a mini window, not an archive. */
export const LANE_INPUT_CAP = 4 * 1024;
export const LANE_DIFF_ROWS_CAP = 400;

/** Text a human could actually read. Whitespace-only is nothing: it must not earn a chevron. */
function filled(s: string | undefined): boolean {
  return typeof s === "string" && s.trim() !== "";
}

/** Whitespace-collapsed single line, for the copy text's one-line chip header. */
function oneLine(s: string | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

/** Which authored-code field a diff body would be built from, in answer_chips' precedence (patch, then a
 *  written content, then an old->new pair). `undefined` when the row authored no code: a bare `{ path }`
 *  is provenance, not a body, and must not open an empty panel. */
function codeSource(c: LaneToolCode | undefined): "patch" | "content" | "pair" | undefined {
  if (!c) return undefined;
  if (filled(c.patch)) return "patch";
  if (filled(c.content)) return "content";
  if (filled(c.oldText) || filled(c.newText)) return "pair";
  return undefined;
}

/** The "detail" body text: the tool title, falling back to the tool NAME. That fallback is why `hasBody`
 *  can key on the name at all: a row with a name but no detail still has one thing worth revealing. */
function bodyTitle(t: LaneToolRow): string {
  return oneLine(t.detail) || oneLine(t.name);
}

/** The ONE decision behind both `laneChip().hasBody` and `laneChipBody()`, which is how the biconditional
 *  (`null` <=> `!hasBody`) holds by construction rather than by two functions agreeing. A chevron the DOM
 *  renders therefore always opens onto something, and a dead chevron cannot ship. Deliberately cheap: it
 *  never diffs, so sizing a chip during a stream does not walk a 5000-line patch. */
function bodyKind(t: LaneToolRow): "diff" | "input" | "detail" | null {
  if (codeSource(t.code)) return "diff";
  if (filled(t.input)) return "input";
  if (bodyTitle(t)) return "detail";
  return null;
}

/** Monotone id minting, scoped per lane. Never reused, so a DOM node keyed on it is stable for the life of
 *  the card (the whole point: a repaint patches, it does not rebuild). */
export function mintId(prefix: string, seq: number): string {
  const p = filled(prefix) ? prefix.trim() : "id";
  // A non-finite seq means the caller's counter is already broken; collapse it rather than mint a DOM key
  // that reads "tNaN" and lands in the document as an id.
  const n = Number.isFinite(seq) ? Math.trunc(seq) : 0;
  return `${p}${n}`;
}

/** The chip's glance line. Delegates kind/detail/diffstat to answer_chips.toolChip so a lane chip and a
 *  master-composer chip can never disagree. `hasBody` is false only when there is genuinely nothing to
 *  reveal, so the DOM layer can omit the chevron rather than render a dead one. */
export function laneChip(t: LaneToolRow): ToolChip & { hasBody: boolean } {
  return { ...toolChip(t.name, t.detail, t.code), hasBody: bodyKind(t) !== null };
}

/** omp's hashline patch already IS a diff: every line stays RAW, because its own +/- and its `[path#hash]`
 *  header and `SWAP`/`DEL` directives are the content. patchLineType only classifies it for coloring, and
 *  its `meta` folds into `ctx`: the body's row type is the three-way DOM class, so a header row must never
 *  paint as an addition. */
function patchRows(patch: string): DiffRow[] {
  const body = patch.endsWith("\n") ? patch.slice(0, -1) : patch; // no phantom trailing blank row
  return body.split("\n").map((text): DiffRow => {
    const t = patchLineType(text);
    return { type: t === "add" || t === "del" ? t : "ctx", text };
  });
}

function codeRows(c: LaneToolCode | undefined): DiffRow[] {
  if (!c) return [];
  switch (codeSource(c)) {
    case "patch": return patchRows(c.patch ?? "");
    // A write authored a whole file: an empty-to-content diff is "all adds" and, unlike a hand-rolled
    // split, it drops the trailing newline's phantom line exactly as the diffstat on the chip does.
    case "content": return lineDiff("", c.content ?? "");
    case "pair": return lineDiff(c.oldText ?? "", c.newText ?? "");
    default: return [];
  }
}

/** Truncation is VISIBLE. A silently clipped diff lets the card imply the edit was smaller than it was, so
 *  the cap keeps exactly LANE_DIFF_ROWS_CAP rows and spends the last one saying what it dropped. */
function capRows(rows: DiffRow[]): DiffRow[] {
  if (rows.length <= LANE_DIFF_ROWS_CAP) return rows;
  const kept = rows.slice(0, LANE_DIFF_ROWS_CAP - 1);
  const hidden = rows.length - kept.length;
  kept.push({ type: "ctx", text: `[truncated: ${hidden} more rows not shown, a lane card caps a diff at ${LANE_DIFF_ROWS_CAP} rows]` });
  return kept;
}

/** Same doctrine for a command: clipped is fine, clipped in silence is a lie about what ran. Only the edges
 *  are trimmed, so a multi-line command's own newlines and indentation survive verbatim. */
function capInput(input: string): string {
  const v = input.trim();
  if (v.length <= LANE_INPUT_CAP) return v;
  const hidden = v.length - LANE_INPUT_CAP;
  return `${v.slice(0, LANE_INPUT_CAP)}\n[truncated: ${hidden} more characters not shown, a lane card caps an input at ${LANE_INPUT_CAP} characters]`;
}

export function laneChipBody(t: LaneToolRow): LaneChipBody | null {
  switch (bodyKind(t)) {
    // Precedence is code > input > detail: what the call AUTHORED outranks the command that authored it,
    // which outranks the title describing both.
    case "diff": return { kind: "diff", rows: capRows(codeRows(t.code)) };
    case "input": return { kind: "input", text: capInput(t.input ?? "") };
    case "detail": return { kind: "detail", text: bodyTitle(t) };
    default: return null;
  }
}

const LIVE_LABEL = "[assistant, in progress]";

/** Two-space indent for a chip's sub-content, so a pasted transcript reads as prose with commands under it.
 *  A blank line stays blank: no trailing whitespace in someone's clipboard. */
function indent(s: string): string {
  return s.split("\n").map((l) => (l.trim() ? `  ${l}` : "")).join("\n");
}

/** One diff row as plain text. A row whose text ALREADY carries its sign is not signed twice: that is every
 *  patch row (kept raw above) and the odd source line that literally starts with "+", so a pasted patch
 *  reads exactly as omp wrote it. Context rows carry no marker at all. */
function diffLine(r: DiffRow): string {
  if (r.type === "add") return `  ${r.text.startsWith("+") ? "" : "+"}${r.text}`;
  if (r.type === "del") return `  ${r.text.startsWith("-") || r.text.startsWith("\u2212") ? "" : "-"}${r.text}`;
  return `  ${r.text}`;
}

/** A tool call as plain text: one `[ran: <name>] <detail>` line plus its command or diff indented two
 *  spaces. A "detail" body adds nothing, since the header line already IS the detail. */
function toolCopyText(t: LaneToolRow): string {
  const detail = oneLine(t.detail);
  const head = `[ran: ${oneLine(t.name) || "tool"}]${detail ? ` ${detail}` : ""}`;
  const body = laneChipBody(t);
  if (!body) return head;
  if (body.kind === "diff") return `${head}\n${body.rows.map(diffLine).join("\n")}`;
  if (body.kind === "input") return `${head}\n${indent(body.text)}`;
  return head;
}

/** The blocks of one turn's body, ordered as fleet_lanes' own `#foldLiveTurn` folds a turn: the tool trail
 *  is the memory of the turn, the prose is its conclusion. */
function turnBlocks(t: {
  text: string;
  thinking?: string;
  tools: readonly LaneToolRow[];
  error?: string;
  images?: readonly string[];
}): string[] {
  const out: string[] = [];
  if (filled(t.thinking)) out.push(`[thinking]\n${indent((t.thinking ?? "").trim())}`);
  for (const tool of t.tools) out.push(toolCopyText(tool));
  const text = (t.text ?? "").trim();
  if (text) out.push(text);
  // Images are data: URLs. A paste states HOW MANY and never dumps megabytes of base64, and it never
  // reports a count that was not there: no images means no line, not "0 images".
  const n = t.images?.length ?? 0;
  if (n > 0) out.push(`[${n} image${n === 1 ? "" : "s"} attached]`);
  if (filled(t.error)) out.push(`[error] ${oneLine(t.error)}`);
  return out;
}

/** Clipboard text. Plain UTF-8, no markup, no ANSI. A tool row renders as one `[ran: <name>] <detail>` line
 *  plus its command/diff indented by two spaces, so a pasted transcript is readable in a plain text field. */
export function turnCopyText(t: LaneTurnRow): string {
  const blocks = turnBlocks({ text: t.text, thinking: t.thinking, tools: t.tools ?? [], error: t.error, images: t.images });
  // An empty turn contributes nothing: a lonely role header is the same bug as a dead chevron.
  if (!blocks.length) return "";
  return `${t.role === "user" ? "[user]" : "[assistant]"}\n${blocks.join("\n")}`;
}

export function transcriptCopyText(
  turns: readonly LaneTurnRow[],
  live?: { text: string; thinking?: string; tools: readonly LaneToolRow[] },
): string {
  const parts: string[] = [];
  for (const t of turns) {
    const s = turnCopyText(t);
    if (s) parts.push(s);
  }
  if (live) {
    const blocks = turnBlocks({ text: live.text, thinking: live.thinking, tools: live.tools ?? [] });
    if (blocks.length) parts.push(`${LIVE_LABEL}\n${blocks.join("\n")}`);
  }
  return parts.join("\n\n");
}
