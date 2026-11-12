// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/tool_input.ts - "the command used" for a tool call that authored no code. P-FLEET.L7 wrote this
// for lane cards; P-PROGRESS.1 lifts it here so the master chat's tool steps carry the same arguments and
// one extractor serves both. A bash call's whole value is its `command`, a read's is its `path`, a search's
// is its `pattern` plus `paths`; without this the step shows only omp's one-line title and its chevron has
// nothing to open.
//
// The single-string fast paths come first so the common case reads as itself (a shell line, not a JSON
// object wrapping a shell line). Everything else serializes, with the code-bearing keys STRIPPED: they are
// already carried as authored code, and a 16KB file body pasted under a chevron labelled "command" is
// noise. Serialization is defensive - a rawInput holding a cycle or a BigInt must never take down the
// notify handler, which is the worker's only channel. Pure.

/** Cap on the arguments carried per tool event. A shell line is tens of bytes; this is generous for a long
 *  pipeline or a JSON arg blob while keeping the stream small. Mirrors lane_transcript.LANE_INPUT_CAP so
 *  the renderer never receives more than it will display. */
export const TOOL_INPUT_CAP = 4 * 1024;

const CODE_KEYS: Record<string, true> = { content: true, edits: true, old_text: true, new_text: true, oldText: true, newText: true };
const LEAD_KEYS = ["command", "cmd", "query", "pattern", "url", "expression"];

export function toolInput(u: { rawInput?: unknown; input?: unknown }, cap = TOOL_INPUT_CAP): string | undefined {
  const riRaw = u.rawInput ?? u.input;
  if (typeof riRaw === "string") return riRaw.trim().slice(0, cap) || undefined;
  if (!riRaw || typeof riRaw !== "object") return undefined;
  const ri = riRaw as Record<string, unknown>;
  for (const k of LEAD_KEYS) {
    const v = ri[k];
    if (typeof v === "string" && v.trim()) {
      // A search carries its scope in a sibling key; the pattern alone is not the command.
      const scope = Array.isArray(ri.paths) ? ri.paths.filter((p) => typeof p === "string").join(", ") : typeof ri.path === "string" ? ri.path : "";
      return `${v.trim()}${scope ? `\n  in: ${scope}` : ""}`.slice(0, cap);
    }
  }
  const stripped: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ri)) {
    if (CODE_KEYS[k] || v === undefined || v === null || v === "") continue;
    stripped[k] = v;
  }
  if (!Object.keys(stripped).length) return undefined;
  try {
    return JSON.stringify(stripped, (_k, v) => (typeof v === "bigint" ? String(v) : v), 2).slice(0, cap);
  } catch {
    return undefined; // an unserializable rawInput is simply not shown; it never breaks the stream
  }
}

/** The tool's intent, when the call carried one: omp's tools take `i`, a short present-participle phrase
 *  ("Reading model role settings"). It is the best "what is it doing" line there is, and it is the agent's
 *  own words, so it is shown as such. */
export function toolIntent(u: { rawInput?: unknown; input?: unknown }): string | undefined {
  const riRaw = u.rawInput ?? u.input;
  if (!riRaw || typeof riRaw !== "object") return undefined;
  const i = (riRaw as Record<string, unknown>).i;
  return typeof i === "string" && i.trim() ? i.trim().slice(0, 160) : undefined;
}
