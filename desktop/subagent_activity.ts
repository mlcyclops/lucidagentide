// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/subagent_activity.ts — P-TASK.5 (ADR-0180): LIVE subagent activity for the delegation card.
//
// omp's task tool persists EACH subtask as its OWN session transcript: for a parent session at
// `<dir>/<stamp>_<id>.jsonl`, subtask transcripts land in the sibling directory `<dir>/<stamp>_<id>/`
// as `<GeneratedName>.jsonl`, with `<GeneratedName>.md` written when the subtask finishes (see
// vendor task/index.ts: `artifactsDir = sessionFile.slice(0, -6)`). Until now the delegation card
// showed only the static assignments - the actual thinking/tools of each subagent were invisible.
// This module reads those transcripts into a compact, bounded activity view the card can poll.
//
// Boundaries: READ-ONLY, path-confined (derives ONLY from the resolved parent session file - the
// route never accepts arbitrary paths), corrupt-tolerant (a torn line contributes nothing), bounded
// (steps capped, labels clipped, big transcripts tail-read). Transcript text is model/tool output -
// the renderer esc()'s every label; nothing here ever re-enters a prompt.

import { existsSync as realExists, readdirSync as realReaddir, readFileSync as realRead, statSync as realStat } from "node:fs";
import { join } from "node:path";

export interface SubagentIo {
  exists: (p: string) => boolean;
  readText: (p: string) => string;
  list: (dir: string) => string[];
  mtime: (p: string) => number;
  size: (p: string) => number;
}
const REAL_IO: SubagentIo = {
  exists: realExists,
  readText: (p) => realRead(p, "utf8"),
  list: (dir) => realReaddir(dir),
  mtime: (p) => { try { return realStat(p).mtimeMs; } catch { return 0; } },
  size: (p) => { try { return realStat(p).size; } catch { return 0; } },
};

export interface SubagentStep { kind: "thinking" | "tool" | "text"; tool?: string; label: string }
export interface SubagentRun {
  name: string;         // the generated subtask name (transcript filename minus .jsonl)
  done: boolean;        // the sibling <name>.md output exists
  lastAt: number;       // transcript mtime (ms)
  assignment: string;   // the subtask's own first user message (its assignment), clipped
  model: string | null;
  tools: number;        // total tool calls so far
  steps: SubagentStep[]; // the LAST few notable steps (thinking / tool / text), oldest→newest
}

const STEP_CAP = 12;
const LABEL_CAP = 180;
const ASSIGN_CAP = 240;
/** Transcripts grow with tool results; only the tail matters for "what is it doing NOW". */
const TAIL_BYTES = 2 * 1024 * 1024;

/** Mirror of omp's rule (task/index.ts): the subtask artifacts dir is the parent session file minus
 *  its `.jsonl` extension. Null for anything that isn't a .jsonl session path. */
export function subagentArtifactsDir(sessionFile: string | null | undefined): string | null {
  if (!sessionFile || !/\.jsonl$/i.test(sessionFile)) return null;
  return sessionFile.slice(0, -6);
}

const clip = (s: unknown, n: number): string => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** A tool call's one-line label: the model's own intent note (`_i`) when present, else the most
 *  path/command-shaped argument. */
function toolLabel(args: Record<string, unknown> | undefined): string {
  if (!args || typeof args !== "object") return "";
  for (const k of ["_i", "path", "file_path", "command", "url", "pattern", "query", "title"]) {
    const v = (args as Record<string, unknown>)[k];
    if (typeof v === "string" && v.trim()) return clip(v, 120);
  }
  const firstStr = Object.values(args).find((v) => typeof v === "string" && (v as string).trim());
  return clip(firstStr ?? "", 120);
}

/** The executor wraps the assignment in a fixed preamble - show the user the assignment itself. */
function trimAssignment(text: string): string {
  return clip(text.replace(/^Complete the assignment below, thoroughly:\s*/i, ""), ASSIGN_CAP);
}

/** Parse ONE subtask transcript (JSONL text) into the bounded activity view. Corrupt-tolerant. */
export function parseSubagentTranscript(jsonl: string, maxSteps = STEP_CAP): { assignment: string; model: string | null; tools: number; steps: SubagentStep[] } {
  let assignment = "";
  let model: string | null = null;
  let tools = 0;
  const steps: SubagentStep[] = [];
  const push = (s: SubagentStep) => { if (s.label) { steps.push(s); if (steps.length > maxSteps) steps.shift(); } };
  for (const ln of jsonl.split("\n")) {
    if (!ln.trim()) continue;
    let o: { type?: string; model?: string; message?: { role?: string; content?: unknown } };
    try { o = JSON.parse(ln); } catch { continue; } // torn/corrupt line - contributes nothing
    if (o.type === "model_change" && typeof o.model === "string") { model = o.model; continue; }
    if (o.type !== "message" || !o.message) continue;
    const { role, content } = o.message;
    if (!Array.isArray(content)) continue;
    if (role === "user" && !assignment) {
      const t = content.find((c) => (c as { type?: string })?.type === "text") as { text?: string } | undefined;
      if (t?.text) assignment = trimAssignment(t.text);
      continue;
    }
    if (role !== "assistant") continue;
    for (const c of content as { type?: string; thinking?: string; text?: string; name?: string; arguments?: Record<string, unknown> }[]) {
      if (c?.type === "thinking" && c.thinking) push({ kind: "thinking", label: clip(c.thinking, LABEL_CAP) });
      else if (c?.type === "toolCall") { tools += 1; push({ kind: "tool", tool: clip(c.name, 30) || "tool", label: toolLabel(c.arguments) }); }
      else if (c?.type === "text" && c.text) push({ kind: "text", label: clip(c.text, LABEL_CAP) });
    }
  }
  return { assignment, model, tools, steps };
}

/** List the live/finished subagent runs behind a parent session file. Missing dir / no runs → []
 *  (a parent that never delegated simply has no artifacts dir - that is not an error). */
export function listSubagentRuns(sessionFile: string | null | undefined, io: SubagentIo = REAL_IO): SubagentRun[] {
  const dir = subagentArtifactsDir(sessionFile);
  if (!dir || !io.exists(dir)) return [];
  let entries: string[];
  try { entries = io.list(dir); } catch { return []; }
  const runs: SubagentRun[] = [];
  for (const f of entries) {
    if (!f.endsWith(".jsonl")) continue;
    const file = join(dir, f);
    const name = f.slice(0, -6);
    try {
      let text = io.readText(file);
      // Tail-read big transcripts: drop everything before the last TAIL_BYTES, then skip the first
      // (possibly torn) line. The parser tolerates the missing head - assignment may be absent then.
      if (io.size(file) > TAIL_BYTES && text.length > TAIL_BYTES) {
        text = text.slice(-TAIL_BYTES);
        text = text.slice(text.indexOf("\n") + 1);
      }
      const parsed = parseSubagentTranscript(text);
      runs.push({ name, done: io.exists(join(dir, `${name}.md`)), lastAt: io.mtime(file), ...parsed });
    } catch { /* unreadable transcript - skip the run, never the list */ }
  }
  return runs.sort((a, b) => a.name.localeCompare(b.name));
}
