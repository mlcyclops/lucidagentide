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

/** The first meaningful line of the arguments: a shell line, a path, a pattern. */
function firstArgLine(input?: string): string {
  const line = (input ?? "").split("\n").find((l) => l.trim()) ?? "";
  const t = line.trim();
  return t.length > 96 ? t.slice(0, 95) + "\u2026" : t;
}

export function describeTool(i: { name: string; kind?: string; title?: string; intent?: string; input?: string; path?: string }): ToolDescription {
  const kind = classifyTool(i.kind && i.kind !== "other" ? i.kind : i.name);
  const verb = VERB_BY_KIND[kind] ?? "Working with";
  const intent = (i.intent ?? "").trim();
  if (intent) return { doing: intent, verb };
  const title = (i.title ?? "").trim();
  const bare = title.toLowerCase() === (i.name ?? "").trim().toLowerCase() || title.toLowerCase() === (i.kind ?? "").trim().toLowerCase();
  if (title && !bare && /\s/.test(title)) return { doing: title, verb };
  const subject = i.path?.trim() || firstArgLine(i.input);
  if (subject) return { doing: `${verb} ${subject}`, verb };
  return { doing: `${verb} ${NOUN_BY_KIND[kind] ?? "a tool"}`, verb };
}
