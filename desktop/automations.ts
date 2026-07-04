// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/automations.ts
//
// P-GOAL.5 (ADR-0047): scheduled AUTOMATIONS — the loop's "heartbeat", the last Loop-Engineering
// building block. An automation is just a saved /goal spec (goal + verifiable condition + optional
// command + iteration cap) plus a cadence. A timer inside the harness fires due automations while the
// app is open; each tick runs through the SAME `runGoal` path (maker ≠ checker, durable on-disk memory,
// and — crucially — the in-process fail-closed gate scanning every action). See ADR-0046 for the loop.
//
// Design decisions (this file is the store + the PURE scheduling math; the timer lives in the backend):
//   • In-process only. We never register with the OS scheduler — that would run omp in a process where
//     the gate isn't guaranteed armed (a fail-closed risk) and would drag in platform-specific surface
//     against the TS-only boundary. Automations run while the app is open; that's the safe envelope.
//   • Disabled until enabled. A freshly-created automation is INERT — nothing runs unattended on a
//     cadence until the user explicitly arms it. Safest default for an unattended-loop primitive.
//   • Cadence is interval ("every N minutes") OR daily ("every day at HH:MM", local time).
//
// The store is a single JSON array at `<workspace>/.omp/automations.json`, confined via pathWithin and
// fully fail-safe: any read/parse/write error degrades to "no automations", never throws into the loop.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathWithin } from "./path_guard.ts";

export type Cadence =
  | { kind: "interval"; everyMin: number }   // run every N minutes since the last run (or creation)
  | { kind: "daily"; hhmm: string };          // run once per day at HH:MM (24h, local time)

export interface Automation {
  id: string;
  goal: string; // goal text, or the display label for kind "agent"
  condition: string;
  command?: string;
  maxIters: number;
  cadence: Cadence;
  enabled: boolean;
  createdAt: number;
  lastRunAt?: number;
  lastResult?: string;
  // P-AGENT.14 (ADR-0140): scheduled BUILT-AGENT runs. kind defaults to "goal" for every legacy record.
  kind?: "goal" | "agent";
  agentSpecId?: string; // kind "agent": the built agent to run
  agentPrompt?: string; // kind "agent": the task each tick runs with
  agentModel?: string; // kind "agent": model override (runner default when unset)
}

/** Spec the UI/API supplies to create one (everything else is server-assigned). */
export interface AutomationSpec {
  goal: string;
  condition?: string;
  command?: string;
  maxIters?: number;
  cadence: Cadence;
  kind?: "goal" | "agent";
  agentSpecId?: string;
  agentPrompt?: string;
  agentModel?: string;
}

/** P-AGENT.14: the PURE fail-closed gate the scheduler consults before running an agent automation.
 *  Only a TRUSTED, loadable, approval-free spec runs unattended:
 *  - missing spec        → disable (it can never succeed until re-created)
 *  - trust ≠ trusted     → disable (a label downgrade SUSPENDS the schedule — ADR-0140)
 *  - approval checkpoints → refuse this tick but stay armed (unattended runs can't answer approval cards;
 *    the user may edit the agent, so the schedule survives) */
export function agentAutomationGate(
  spec: { name: string; nodes: Array<{ kind: string }> } | null,
  trustLabel: string,
): { run: boolean; result?: string; disable?: boolean } {
  if (!spec) return { run: false, disable: true, result: "suspended: the agent no longer exists in this workspace" };
  if (trustLabel !== "trusted")
    return { run: false, disable: true, result: `suspended: the agent is ${trustLabel} — review + approve it in the Agent Builder, then re-arm` };
  if (spec.nodes.some((n) => n.kind === "approval"))
    return { run: false, result: "refused: the workflow has human-approval checkpoints — run it manually from the Builder" };
  return { run: true };
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function storePath(workspace: string): string | null {
  const root = join(workspace, ".omp");
  return pathWithin(root, join(root, "automations.json"));
}

/** Validate + normalize a cadence, or null if it's malformed (fail-closed: a bad cadence never arms). */
export function normalizeCadence(c: unknown): Cadence | null {
  const o = c as any;
  if (!o || typeof o !== "object") return null;
  if (o.kind === "interval") {
    const everyMin = Math.floor(Number(o.everyMin));
    if (!Number.isFinite(everyMin) || everyMin < 1 || everyMin > 1440 * 7) return null;
    return { kind: "interval", everyMin };
  }
  if (o.kind === "daily") {
    const hhmm = String(o.hhmm ?? "");
    if (!HHMM.test(hhmm)) return null;
    return { kind: "daily", hhmm };
  }
  return null;
}

/** Human-readable cadence (UI + memory). */
export function cadenceLabel(c: Cadence): string {
  if (c.kind === "interval") {
    if (c.everyMin % 1440 === 0) return `every ${c.everyMin / 1440} day${c.everyMin === 1440 ? "" : "s"}`;
    if (c.everyMin % 60 === 0) return `every ${c.everyMin / 60} hour${c.everyMin === 60 ? "" : "s"}`;
    return `every ${c.everyMin} min`;
  }
  return `daily at ${c.hhmm}`;
}

/** Read the automation list (most-recently-created first). Any failure ⇒ []. */
export function listAutomations(workspace: string): Automation[] {
  const path = storePath(workspace);
  if (!path || !existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(raw)) return [];
    return raw.filter((a) => a && typeof a.id === "string" && typeof a.goal === "string" && normalizeCadence(a.cadence));
  } catch { return []; }
}

function writeAutomations(workspace: string, list: Automation[]): boolean {
  const path = storePath(workspace);
  if (!path) return false;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(list, null, 2), "utf8");
    return true;
  } catch { return false; }
}

/** Create a DISABLED automation. `id` is injectable for deterministic tests. Returns null on bad input. */
export function createAutomation(workspace: string, spec: AutomationSpec, id: string, createdAt: number): Automation | null {
  const goal = String(spec.goal ?? "").trim();
  const cadence = normalizeCadence(spec.cadence);
  if (!goal || !cadence) return null;
  const command = spec.command?.trim() || undefined;
  const condition = String(spec.condition ?? "").trim() || command || goal;
  const maxIters = Math.min(20, Math.max(1, Math.floor(Number(spec.maxIters)) || 6));
  // P-AGENT.14: an agent-run automation must fully name its work (spec id + task) or it never exists.
  const kind: "goal" | "agent" = spec.kind === "agent" ? "agent" : "goal";
  const agentSpecId = spec.agentSpecId?.trim() || undefined;
  const agentPrompt = spec.agentPrompt?.trim() || undefined;
  const agentModel = spec.agentModel?.trim() || undefined;
  if (kind === "agent" && (!agentSpecId || !agentPrompt)) return null;
  const auto: Automation = {
    id, goal, condition, command, maxIters, cadence, enabled: false, createdAt,
    ...(kind === "agent" ? { kind, agentSpecId, agentPrompt, ...(agentModel ? { agentModel } : {}) } : {}),
  };
  const list = listAutomations(workspace);
  list.unshift(auto);
  return writeAutomations(workspace, list) ? auto : null;
}

/** Patch one automation in place. Returns the updated record, or null if not found / unwritable. */
export function updateAutomation(workspace: string, id: string, patch: Partial<Automation>): Automation | null {
  const list = listAutomations(workspace);
  const i = list.findIndex((a) => a.id === id);
  const cur = list[i];
  if (!cur) return null;
  const next: Automation = { ...cur, ...patch, id: cur.id, createdAt: cur.createdAt };
  if (patch.cadence) { const c = normalizeCadence(patch.cadence); if (!c) return null; next.cadence = c; }
  list[i] = next;
  return writeAutomations(workspace, list) ? next : null;
}

export function deleteAutomation(workspace: string, id: string): boolean {
  const list = listAutomations(workspace);
  const next = list.filter((a) => a.id !== id);
  if (next.length === list.length) return false;
  return writeAutomations(workspace, next);
}

/** PURE: is this automation due to run at `now` (ms)? Disabled ⇒ never. The timer calls this each tick. */
export function isDue(a: Automation, now: number): boolean {
  if (!a.enabled) return false;
  const last = a.lastRunAt ?? a.createdAt;
  if (a.cadence.kind === "interval") {
    return now - last >= a.cadence.everyMin * 60_000;
  }
  // daily: due once now has passed today's HH:MM and we haven't already run since that moment.
  const d = new Date(now);
  const [hh, mm] = a.cadence.hhmm.split(":").map(Number);
  const scheduledToday = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, mm, 0, 0).getTime();
  return now >= scheduledToday && last < scheduledToday;
}

/** The first enabled+due automation at `now`, or null. Deterministic order (creation order, oldest first
 *  among the due) so the same one fires given the same state. */
export function nextDueAutomation(workspace: string, now: number): Automation | null {
  const due = listAutomations(workspace).filter((a) => isDue(a, now));
  if (!due.length) return null;
  due.sort((x, y) => (x.lastRunAt ?? x.createdAt) - (y.lastRunAt ?? y.createdAt));
  return due[0] ?? null;
}
