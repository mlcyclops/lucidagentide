// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/aos.ts - P-AOS.1 (ADR-0452): LUCID's own binding of AOS-1, the Agent Orchestration Standard
// (github.com/tomtomsatnav/agent-orchestration-standard, MIT, Copyright (c) 2026 Tom Mitchell).
//
// AOS-1 orchestrates several agents toward ONE standing Goal (success criteria + a mandatory budget),
// kept moving by a periodic Heartbeat whose age any observer turns into liveness. LUCID already owns the
// agents (fleet lanes) and their supervision (health_watch, call_pulse); what it lacked is the goal they
// share and an orchestrator pulse an observer can read. This module is the PURE half: the closed-set
// lifecycles, goal validation, the per-tick evaluation (beat, observe, reap, verify, budget check) and
// the liveness rule. No I/O, no clock reads, no Node imports: the engine (fleet_goal.ts) and the orbit
// renderer import the same rule, so the two can never disagree about what "late" means.
//
// Deliberately NOT here (P-AOS.2+): Plan and Dispatch (the heartbeat creating and starting tasks), the
// AOS event log (it would be a second event vocabulary beside the frozen EventName enum, invariant 8),
// and automatic criteria verification. Criteria are verified by the human, in the orbit.

/** AOS-1 Goal lifecycle (`draft` is never persisted: a goal is created active). Terminal: achieved, cancelled. */
export type AosGoalStatus = "active" | "blocked" | "achieved" | "cancelled";
/** AOS-1 Heartbeat status. Terminal goals stop it; a human pauses it. */
export type AosHeartbeatStatus = "running" | "paused" | "stopped";
/** AOS-1 section 8: derived by the observer from heartbeat age, never stored. */
export type AosLiveness = "alive" | "late" | "dead";
/** AOS-1 Agent lifecycle, mapped from a lane. */
export type AosAgentStatus = "idle" | "running" | "errored" | "stalled";
export type AosControl = "pause" | "resume" | "cancel" | "dismiss";

export interface AosCriterion { id: string; text: string; met: boolean }
/** AOS-1 section 7: a goal without a budget is invalid. Both caps are required and positive. */
export interface AosBudget { maxUsd: number; maxWallClockS: number }
/** Per-lane spend while the goal is open: `last` is the lane's last reported cumulative session cost,
 *  `total` what the goal has been charged. A respawned lane restarts its session cost at zero, so a
 *  DROP is a new session and its whole new amount is new spend; nothing is ever charged twice. */
export interface AosLaneSpend { last: number; total: number }
export interface AosGoal {
  id: string;
  title: string;
  status: AosGoalStatus;
  criteria: AosCriterion[];
  budget: AosBudget;
  /** Why the goal is blocked (only while status is "blocked"). */
  blockedReason: string | null;
  spend: Record<string, AosLaneSpend>;
  createdAt: number;
  updatedAt: number;
}
export interface AosHeartbeat {
  seq: number;
  /** Epoch ms of the last beat. */
  ts: number;
  intervalS: number;
  status: AosHeartbeatStatus;
  /** How long the last tick took (ms). */
  lastTickMs: number;
  consecutiveErrors: number;
}
export interface AosAgent {
  laneId: string;
  name: string;
  status: AosAgentStatus;
  /** Epoch ms of the lane's last ACP traffic. */
  lastEventAt: number;
}
export interface AosSnapshot {
  goal: AosGoal | null;
  heartbeat: AosHeartbeat;
  agents: AosAgent[];
  spentUsd: number;
  elapsedS: number;
}
/** What the heartbeat observes of one lane. */
export interface AosLaneInput {
  id: string;
  name: string;
  status: string;
  busy: boolean;
  lastActivityAt: number;
  /** omp's cumulative session cost for this lane (ACP usage_update cost.amount); 0 before any report. */
  cost: number;
}

/** LUCID beats every 10 s (AOS-1's default is 60 s): an observer sees a frozen engine within 15 s. */
export const AOS_INTERVAL_S = 10;
/** Reap: a running lane with no ACP traffic for this long is `stalled` (call_pulse's PULSE_STUCK_MS). */
export const AOS_STALL_AFTER_MS = 5 * 60_000;
export const AOS_TITLE_MAX = 200;
export const AOS_CRITERION_MAX = 300;
export const AOS_CRITERIA_MAX = 20;
export const AOS_MAX_USD = 10_000;
export const AOS_MAX_WALL_CLOCK_S = 30 * 24 * 3600;

/** AOS-1 section 8: alive under 1.5x the interval, late under 3x, dead at 3x or more. A beat stamped in
 *  the future (clock skew) or never stamped is not evidence of life. */
export function aosLiveness(ageMs: number, intervalS: number): AosLiveness {
  if (!Number.isFinite(ageMs) || ageMs < 0 || !(intervalS > 0)) return "dead";
  const interval = intervalS * 1000;
  return ageMs < 1.5 * interval ? "alive" : ageMs < 3 * interval ? "late" : "dead";
}

export const isTerminalGoal = (s: AosGoalStatus): boolean => s === "achieved" || s === "cancelled";

/** One lane as an AOS-1 agent. Reap rule: a lane mid-turn with no traffic for AOS_STALL_AFTER_MS. */
export function agentStatus(lane: AosLaneInput, now: number): AosAgentStatus {
  if (lane.status === "error") return "errored";
  if (!lane.busy) return "idle";
  return now - lane.lastActivityAt >= AOS_STALL_AFTER_MS ? "stalled" : "running";
}

export type AosGoalInput = { title: string; criteria: string[]; budget: AosBudget };

/** Validate a goal request from the UI. Every refusal names the field. */
export function validateGoalInput(raw: unknown): { ok: true; input: AosGoalInput } | { ok: false; error: string } {
  const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const title = typeof b.title === "string" ? b.title.replace(/\s+/g, " ").trim() : "";
  if (!title) return { ok: false, error: "The goal needs a title." };
  if (title.length > AOS_TITLE_MAX) return { ok: false, error: `Keep the title under ${AOS_TITLE_MAX} characters.` };
  const list = Array.isArray(b.criteria) ? b.criteria : [];
  const criteria = list.filter((c): c is string => typeof c === "string").map((c) => c.replace(/\s+/g, " ").trim()).filter(Boolean);
  if (!criteria.length) return { ok: false, error: "Add at least one success criterion: how will you know the goal is met?" };
  if (criteria.length > AOS_CRITERIA_MAX) return { ok: false, error: `At most ${AOS_CRITERIA_MAX} criteria.` };
  if (criteria.some((c) => c.length > AOS_CRITERION_MAX)) return { ok: false, error: `Keep each criterion under ${AOS_CRITERION_MAX} characters.` };
  const maxUsd = Number(b.maxUsd);
  if (!(maxUsd > 0) || maxUsd > AOS_MAX_USD) return { ok: false, error: `The budget needs a spend cap between $0 and $${AOS_MAX_USD.toLocaleString("en-US")} (AOS-1: a goal without a budget is invalid).` };
  const maxWallClockS = Math.round(Number(b.maxHours) * 3600);
  if (!(maxWallClockS > 0) || maxWallClockS > AOS_MAX_WALL_CLOCK_S) return { ok: false, error: "The budget needs a time cap: more than 0 hours and at most 30 days (AOS-1: a goal without a budget is invalid)." };
  return { ok: true, input: { title, criteria, budget: { maxUsd, maxWallClockS } } };
}

/** A new active goal. Every live lane's current session cost is the baseline: only spend after the
 *  goal starts is charged to it. */
export function newGoal(input: AosGoalInput, id: string, lanes: readonly AosLaneInput[], now: number): AosGoal {
  const spend: Record<string, AosLaneSpend> = {};
  for (const l of lanes) spend[l.id] = { last: Math.max(0, l.cost), total: 0 };
  return {
    id,
    title: input.title,
    status: "active",
    criteria: input.criteria.map((text, i) => ({ id: `c${i + 1}`, text, met: false })),
    budget: input.budget,
    blockedReason: null,
    spend,
    createdAt: now,
    updatedAt: now,
  };
}

export const spentUsd = (g: AosGoal): number => Object.values(g.spend).reduce((s, x) => s + x.total, 0);

/** Fold the lanes' latest cumulative costs into the goal's spend ledger. Returns the same object when
 *  nothing changed, so the caller can skip a write. */
export function chargeLanes(g: AosGoal, lanes: readonly AosLaneInput[]): AosGoal {
  let spend: Record<string, AosLaneSpend> | null = null;
  for (const l of lanes) {
    const cost = Math.max(0, Number.isFinite(l.cost) ? l.cost : 0);
    const prev = g.spend[l.id];
    // A lane first seen after the goal started began under it: its whole cost is goal spend.
    const delta = !prev ? cost : cost >= prev.last ? cost - prev.last : cost;
    if (prev && prev.last === cost) continue;
    spend ??= { ...g.spend };
    spend[l.id] = { last: cost, total: (prev?.total ?? 0) + delta };
  }
  return spend ? { ...g, spend } : g;
}

export interface AosTickResult { goal: AosGoal | null; heartbeat: AosHeartbeat; agents: AosAgent[]; changed: boolean }

/** One AOS-1 heartbeat tick: Beat, Observe, Reap, Verify, Budget check. Pure: same inputs, same result.
 *  A paused heartbeat still beats (the engine is alive) but evaluates nothing; a terminal goal stops the
 *  evaluation (status "stopped") while the beat continues. */
export function tick(goal: AosGoal | null, hb: AosHeartbeat, lanes: readonly AosLaneInput[], now: number): AosTickResult {
  const agents = lanes.map((l) => ({ laneId: l.id, name: l.name, status: agentStatus(l, now), lastEventAt: l.lastActivityAt }));
  const beat = (status: AosHeartbeatStatus): AosHeartbeat => ({ ...hb, seq: hb.seq + 1, ts: now, status });
  if (!goal) return { goal, heartbeat: beat(hb.status === "paused" ? "paused" : "running"), agents, changed: false };
  // A terminal goal stops orchestration (status "stopped"), but the beat itself goes on: in LUCID it is
  // also the engine's pulse, and a finished goal must not read as a dead engine.
  if (isTerminalGoal(goal.status)) return { goal, heartbeat: beat("stopped"), agents, changed: false };
  if (hb.status === "paused") return { goal, heartbeat: beat("paused"), agents, changed: false };
  let g = chargeLanes(goal, lanes);
  if (g.criteria.length && g.criteria.every((c) => c.met)) {
    g = { ...g, status: "achieved", blockedReason: null, updatedAt: now };
    return { goal: g, heartbeat: { ...beat("stopped") }, agents, changed: true };
  }
  const reason = budgetExceeded(g, now);
  if (reason && (g.status !== "blocked" || g.blockedReason !== reason)) g = { ...g, status: "blocked", blockedReason: reason, updatedAt: now };
  else if (!reason && g.status === "blocked") g = { ...g, status: "active", blockedReason: null, updatedAt: now };
  return { goal: g, heartbeat: beat("running"), agents, changed: g !== goal };
}

/** The budget line a goal crossed, or null. */
export function budgetExceeded(g: AosGoal, now: number): string | null {
  const spent = spentUsd(g);
  if (spent >= g.budget.maxUsd) return `spend cap reached: $${spent.toFixed(2)} of $${g.budget.maxUsd.toFixed(2)}`;
  const elapsed = Math.max(0, now - g.createdAt) / 1000;
  if (elapsed >= g.budget.maxWallClockS) return `time cap reached: ${humanSeconds(elapsed)} of ${humanSeconds(g.budget.maxWallClockS)}`;
  return null;
}

/** "45 s", "12 m", "3 h 5 m", "2 d 4 h". */
export function humanSeconds(s: number): string {
  const t = Math.max(0, Math.floor(s));
  if (t < 60) return `${t} s`;
  if (t < 3600) return `${Math.floor(t / 60)} m`;
  if (t < 86_400) { const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60); return m ? `${h} h ${m} m` : `${h} h`; }
  const d = Math.floor(t / 86_400), h = Math.floor((t % 86_400) / 3600);
  return h ? `${d} d ${h} h` : `${d} d`;
}

/** A human control (AOS-1 section 4: pause, resume, cancel at any time). `dismiss` clears a terminal
 *  goal off the orbit. Returns the new pair, or a refusal naming why. */
export function control(goal: AosGoal | null, hb: AosHeartbeat, action: AosControl, now: number): { ok: true; goal: AosGoal | null; heartbeat: AosHeartbeat } | { ok: false; error: string } {
  if (!goal) return { ok: false, error: "There is no fleet goal." };
  const terminal = isTerminalGoal(goal.status);
  switch (action) {
    case "pause":
      if (terminal) return { ok: false, error: `The goal is already ${goal.status}.` };
      return { ok: true, goal, heartbeat: { ...hb, status: "paused" } };
    case "resume":
      if (terminal) return { ok: false, error: `The goal is already ${goal.status}.` };
      return { ok: true, goal, heartbeat: { ...hb, status: "running" } };
    case "cancel":
      if (terminal) return { ok: false, error: `The goal is already ${goal.status}.` };
      return { ok: true, goal: { ...goal, status: "cancelled", blockedReason: null, updatedAt: now }, heartbeat: { ...hb, status: "stopped" } };
    case "dismiss":
      if (!terminal) return { ok: false, error: "Cancel the goal before dismissing it." };
      return { ok: true, goal: null, heartbeat: { ...hb, status: "running" } };
  }
}

/** The human verifies one criterion (AOS-1 Verify, done by a person in P-AOS.1). */
export function setCriterion(goal: AosGoal | null, id: string, met: boolean, now: number): { ok: true; goal: AosGoal } | { ok: false; error: string } {
  if (!goal) return { ok: false, error: "There is no fleet goal." };
  if (isTerminalGoal(goal.status)) return { ok: false, error: `The goal is already ${goal.status}.` };
  const c = goal.criteria.find((x) => x.id === id);
  if (!c) return { ok: false, error: "No such criterion." };
  if (c.met === met) return { ok: true, goal };
  return { ok: true, goal: { ...goal, criteria: goal.criteria.map((x) => (x.id === id ? { ...x, met } : x)), updatedAt: now } };
}

/** Parse a persisted goal. Anything malformed is null (the orbit offers a new goal), never a crash. */
export function parseGoal(text: string): AosGoal | null {
  let o: unknown;
  try { o = JSON.parse(text); } catch { return null; }
  if (!o || typeof o !== "object") return null;
  const g = o as Partial<AosGoal>;
  const statuses: readonly string[] = ["active", "blocked", "achieved", "cancelled"];
  if (typeof g.id !== "string" || typeof g.title !== "string" || !statuses.includes(String(g.status))) return null;
  if (!Array.isArray(g.criteria) || !g.criteria.every((c) => c && typeof c.id === "string" && typeof c.text === "string" && typeof c.met === "boolean")) return null;
  if (!g.budget || !(g.budget.maxUsd > 0) || !(g.budget.maxWallClockS > 0)) return null;
  if (typeof g.createdAt !== "number" || typeof g.updatedAt !== "number") return null;
  const spend: Record<string, AosLaneSpend> = {};
  if (g.spend && typeof g.spend === "object") {
    for (const [k, v] of Object.entries(g.spend)) if (v && typeof v.last === "number" && typeof v.total === "number") spend[k] = { last: v.last, total: v.total };
  }
  return { id: g.id, title: g.title, status: g.status as AosGoalStatus, criteria: g.criteria, budget: g.budget, blockedReason: typeof g.blockedReason === "string" ? g.blockedReason : null, spend, createdAt: g.createdAt, updatedAt: g.updatedAt };
}

/** The orbit's one-line goal summary pieces (pure so the wording is tested once). */
export function goalProgress(s: AosSnapshot): { met: number; total: number; pct: number; spend: string; time: string } {
  const g = s.goal;
  if (!g) return { met: 0, total: 0, pct: 0, spend: "", time: "" };
  const met = g.criteria.filter((c) => c.met).length;
  const total = g.criteria.length;
  return {
    met,
    total,
    pct: total ? Math.round((met / total) * 100) : 0,
    spend: `$${s.spentUsd.toFixed(2)} of $${g.budget.maxUsd.toFixed(2)}`,
    time: `${humanSeconds(s.elapsedS)} of ${humanSeconds(g.budget.maxWallClockS)}`,
  };
}
