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

/** A short, human label for a tool_call update. A spawned subagent task (omp's `task` tool: rawInput
 *  carries { agent, tasks[] | assignment }) is labeled as a subagent so the user sees WHO the turn is
 *  waiting on, not a nameless "other" chip. */
export function pendingLabel(u: { title?: unknown; kind?: unknown; rawInput?: unknown }): string {
  const ri = (u.rawInput ?? {}) as { agent?: unknown; tasks?: unknown; assignment?: unknown };
  const title = typeof u.title === "string" && u.title.trim() ? u.title.trim() : "";
  let label: string;
  if (ri.agent && (Array.isArray(ri.tasks) || ri.assignment)) {
    const n = Array.isArray(ri.tasks) ? ri.tasks.length : 1;
    label = `subagent ${String(ri.agent)}${n > 1 ? ` ×${n}` : ""}${title ? `: ${title}` : ""}`;
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
