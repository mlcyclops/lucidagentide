// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/turn_pending.ts - P-STALL.2 (ADR-0263): which tool calls / spawned subagent tasks a turn is
// still waiting on.
//
// The 10-minute silence cutoff (P-STALL.1) killed legitimately long turns: an agent that fans work out
// to subagents can sit quiet for far longer than any fixed clock while the work is genuinely running.
// The cutoff is gone; in its place the user gets VISIBILITY - every slow notice now names the open
// tool calls (with the spawned subagent tasks labeled as such) and how long each has been running.
// Pure: acp_backend owns the Map and feeds it the raw ACP session/update payloads; these helpers
// derive labels, settle terminal updates, and snapshot the pending set for the { type:"slow" } event.

/** An open (not yet settled) tool call in the current turn. */
export interface PendingCall {
  label: string;
  startedAt: number;
}

/** The user-facing view of one pending call, carried on the { type:"slow" } ChatEvent. */
export interface PendingView {
  label: string;
  elapsedMs: number;
}

/** Terminal tool_call_update statuses - anything else (pending/in_progress) keeps the call open. */
const TERMINAL = new Set(["completed", "failed", "rejected", "cancelled", "canceled"]);

const LABEL_CAP = 80;

/** One subtask of an omp `task` call: its agent type, its optional caller-chosen name (which is also the
 *  subtask's transcript stem, `<name>.jsonl`), and its assignment text. */
export interface TaskCallItem { agent: string; name: string; task: string }

/** PURE: omp's `task` tool input, or null for any other tool. omp sends no tool name on an ACP tool_call,
 *  so the SHAPE identifies it. P-TASK.6 (ADR-0398): omp 18 moved `agent` into each item and renamed
 *  `assignment`/`id` to `task`/`name`:
 *    batch:  { context, tasks: [{ name?, agent = "task", task }] }
 *    single: { name?, agent = "task", task }
 *  The single form needs `agent` or the absence of `op`, because the todo tool also sends a `task`
 *  string (always beside an `op`). */
export function parseTaskCall(rawInput: unknown): TaskCallItem[] | null {
  const ri = (rawInput ?? {}) as Record<string, unknown>;
  const item = (t: Record<string, unknown>): TaskCallItem => ({
    agent: typeof t.agent === "string" && t.agent.trim() ? t.agent.trim() : "task",
    name: typeof t.name === "string" ? t.name.trim() : "",
    task: typeof t.task === "string" ? t.task : "",
  });
  if (Array.isArray(ri.tasks)) {
    const items = ri.tasks.filter((t): t is Record<string, unknown> => !!t && typeof t === "object" && typeof (t as Record<string, unknown>).task === "string").map(item);
    return items.length ? items : null;
  }
  if (typeof ri.task === "string" && (typeof ri.agent === "string" || !("op" in ri))) return [item(ri)];
  return null;
}

/** A short, human label for a tool_call update. A spawned subagent task (parseTaskCall) is labeled as a
 *  subagent so the user sees WHO the turn is waiting on, not a nameless "other" chip. */
export function pendingLabel(u: { title?: unknown; kind?: unknown; rawInput?: unknown }): string {
  const title = typeof u.title === "string" && u.title.trim() ? u.title.trim() : "";
  const task = parseTaskCall(u.rawInput);
  let label: string;
  if (task) {
    const agents = [...new Set(task.map((t) => t.agent))].join("+");
    label = `subagent ${agents}${task.length > 1 ? ` ×${task.length}` : ""}${title ? `: ${title}` : ""}`;
  } else {
    const kind = typeof u.kind === "string" && u.kind ? u.kind : "tool";
    label = title && title.toLowerCase() !== kind.toLowerCase() ? `${kind}: ${title}` : kind;
  }
  return label.length > LABEL_CAP ? label.slice(0, LABEL_CAP - 1) + "…" : label;
}

/** Record a new tool_call as open. No id, or a call that arrives already terminal, is not tracked. */
export function trackToolCall(open: Map<string, PendingCall>, u: { toolCallId?: unknown; status?: unknown; title?: unknown; kind?: unknown; rawInput?: unknown }, now: number): void {
  const id = u.toolCallId == null ? "" : String(u.toolCallId);
  if (!id || TERMINAL.has(String(u.status ?? ""))) return;
  open.set(id, { label: pendingLabel(u), startedAt: now });
}

/** Settle a tool_call_update: a terminal status closes the call; progress updates keep it open. */
export function settleToolCall(open: Map<string, PendingCall>, u: { toolCallId?: unknown; status?: unknown }): void {
  const id = u.toolCallId == null ? "" : String(u.toolCallId);
  if (id && TERMINAL.has(String(u.status ?? ""))) open.delete(id);
}

/** The pending set for a slow notice: longest-running first, capped so the event stays small. */
export function pendingSnapshot(open: Map<string, PendingCall>, now: number, cap = 6): PendingView[] {
  return [...open.values()]
    .map((c) => ({ label: c.label, elapsedMs: Math.max(0, now - c.startedAt) }))
    .sort((a, b) => b.elapsedMs - a.elapsedMs)
    .slice(0, cap);
}
