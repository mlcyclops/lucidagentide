// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/tool_describe.ts - P-PROGRESS.1: what a tool call is DOING, in plain words, for the
// announcement the chat and the lane cards show while it runs. DOM-free.
//
// Three sources, best first: the agent's own intent (`i`, e.g. "Reading model role settings"), then omp's
// call title when it is prose rather than a bare tool name, then a sentence built from the tool name and
// its first argument. The tool name shown is the REAL one whenever tool-meta reported it (ADR-0318); before
// that the coarse ACP kind stands in, and the sentence says so no more than the kind does.

import { classifyTool } from "./answer_chips.ts";

export interface ToolDescription {
  /** "Running a shell command", "Editing src/app.ts", ... */
  doing: string;
  /** The verb phrase the compact head shows while the call is open. */
  verb: string;
  /** P-PROGRESS.2: the line says something specific (an intent, a prose title, a path or argument). False
   *  for the generic fallback ("Working with a tool"), which the activity window shows as processing. */
  informative: boolean;
}

const VERB_BY_KIND: Record<string, string> = {
  read: "Reading",
  search: "Searching",
  edit: "Editing",
  write: "Writing",
  run: "Running",
  fetch: "Fetching",
  task: "Delegating",
  other: "Working with",
};

const NOUN_BY_KIND: Record<string, string> = {
  read: "a file",
  search: "the workspace",
  edit: "a file",
  write: "a file",
  run: "a shell command",
  fetch: "a web resource",
  task: "to subagents",
  other: "a tool",
};

/** Argument keys that name what a call acts on, best first, for arguments that arrive as a JSON object. */
const SUBJECT_KEYS = ["path", "file_path", "url", "command", "pattern", "query", "name"];

/** The first meaningful line of the arguments: a shell line, a path, a pattern. P-PROGRESS.2: arguments
 *  serialized as a JSON object (tool_input.ts does that for a call with no lead key, e.g. `read {path}`)
 *  give their subject value, never the object's opening brace. */
function firstArgLine(input?: string): string {
  const raw = (input ?? "").trim();
  let t = raw.split("\n").find((l) => l.trim())?.trim() ?? "";
  if (raw.startsWith("{")) {
    try {
      const o = JSON.parse(raw) as Record<string, unknown>;
      const v = SUBJECT_KEYS.map((k) => o[k]).find((x): x is string => typeof x === "string" && !!x.trim());
      t = v?.trim().split("\n")[0] ?? "";
    } catch { t = ""; } // a clipped object is not a subject
  }
  return t.length > 96 ? t.slice(0, 95) + "\u2026" : t;
}

export function describeTool(i: { name: string; kind?: string; title?: string; intent?: string; input?: string; path?: string }): ToolDescription {
  const kind = classifyTool(i.kind && i.kind !== "other" ? i.kind : i.name);
  const verb = VERB_BY_KIND[kind] ?? "Working with";
  const intent = (i.intent ?? "").trim();
  if (intent) return { doing: intent, verb, informative: true };
  const title = (i.title ?? "").trim();
  const bare = title.toLowerCase() === (i.name ?? "").trim().toLowerCase() || title.toLowerCase() === (i.kind ?? "").trim().toLowerCase();
  if (title && !bare && /\s/.test(title)) return { doing: title, verb, informative: true };
  const subject = i.path?.trim() || firstArgLine(i.input);
  if (subject) return { doing: `${verb} ${subject}`, verb, informative: true };
  return { doing: `${verb} ${NOUN_BY_KIND[kind] ?? "a tool"}`, verb, informative: false };
}
