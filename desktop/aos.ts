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
// P-AOS.2 (ADR-0453) adds Tasks: a unit of work assigned to one spoke, with an output contract and at
// least one acceptance check (section 6). The heartbeat's Dispatch step starts ready tasks on idle
// spokes; a command check is run by the spoke in a separate verification turn that may not modify files
// and must answer in strict JSON (fail-closed); a human check is ticked by a person. A failed check
// retries with the failure fed back, up to maxAttempts, then the task fails.
//
// Deliberately NOT here: Plan (the heartbeat inventing tasks: a person writes them), the AOS event log (a
// second event vocabulary beside the frozen EventName enum, invariant 8), and automatic criteria
// verification. Criteria are verified by the human, in the orbit.

/** AOS-1 Goal lifecycle (`draft` is never persisted: a goal is created active). Terminal: achieved, cancelled. */
export type AosGoalStatus = "active" | "blocked" | "achieved" | "cancelled";
/** AOS-1 Heartbeat status. Terminal goals stop it; a human pauses it. */
export type AosHeartbeatStatus = "running" | "paused" | "stopped";
/** AOS-1 section 8: derived by the observer from heartbeat age, never stored. */
export type AosLiveness = "alive" | "late" | "dead";
/** AOS-1 Agent lifecycle, mapped from a lane. */
export type AosAgentStatus = "idle" | "running" | "errored" | "stalled";
export type AosControl = "pause" | "resume" | "cancel" | "dismiss";
/** AOS-1 Task lifecycle. `running` covers both the work turn and the verification turn (see `turn`). */
export type AosTaskStatus = "pending" | "ready" | "running" | "needs_review" | "done" | "failed" | "cancelled";
/** `command`: run by the spoke in a verification turn, passes on exit code 0. `human`: ticked by a person. */
export type AosCheckKind = "human" | "command";
export interface AosCheck { id: string; kind: AosCheckKind; text: string; passed: boolean | null; detail: string | null }
export interface AosTask {
  id: string;
  title: string;
  /** What the spoke is asked to do. */
  prompt: string;
  /** AOS-1 output contract: what the spoke must deliver. */
  outputContract: string;
  acceptance: AosCheck[];
  /** The lane id the task runs on. */
  assignee: string;
  dependsOn: string[];
  status: AosTaskStatus;
  attempts: number;
  maxAttempts: number;
  /** Which turn is running: the work, or the verification of its command checks. */
  turn: "work" | "verify" | null;
  /** The spoke's one-paragraph result from the last work turn. */
  result: string | null;
  /** Why the last attempt failed; fed into the next attempt's prompt. */
  lastFailure: string | null;
  createdAt: number;
  updatedAt: number;
}
/** One prompt the heartbeat sends to a spoke. */
export interface AosDispatch { taskId: string; laneId: string; turn: "work" | "verify"; text: string }
/** How a dispatched turn ended, as the engine saw it. */
export type AosTurnOutcome = { ok: true; text: string } | { ok: false; error: string };

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
  /** P-AOS.2: the goal's tasks, in creation order. */
  tasks: AosTask[];
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
    tasks: [],
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

export interface AosTickResult { goal: AosGoal | null; heartbeat: AosHeartbeat; agents: AosAgent[]; changed: boolean; dispatch: AosDispatch[] }

/** One AOS-1 heartbeat tick: Beat, Observe, Reap, Verify, Budget check. Pure: same inputs, same result.
 *  A paused heartbeat still beats (the engine is alive) but evaluates nothing; a terminal goal stops the
 *  evaluation (status "stopped") while the beat continues. */
export function tick(goal: AosGoal | null, hb: AosHeartbeat, lanes: readonly AosLaneInput[], now: number): AosTickResult {
  const agents = lanes.map((l) => ({ laneId: l.id, name: l.name, status: agentStatus(l, now), lastEventAt: l.lastActivityAt }));
  const beat = (status: AosHeartbeatStatus): AosHeartbeat => ({ ...hb, seq: hb.seq + 1, ts: now, status });
  if (!goal) return { goal, heartbeat: beat(hb.status === "paused" ? "paused" : "running"), agents, changed: false, dispatch: [] };
  // A terminal goal stops orchestration (status "stopped"), but the beat itself goes on: in LUCID it is
  // also the engine's pulse, and a finished goal must not read as a dead engine.
  if (isTerminalGoal(goal.status)) return { goal, heartbeat: beat("stopped"), agents, changed: false, dispatch: [] };
  if (hb.status === "paused") return { goal, heartbeat: beat("paused"), agents, changed: false, dispatch: [] };
  let g = chargeLanes(goal, lanes);
  if (g.criteria.length && g.criteria.every((c) => c.met)) {
    g = { ...g, status: "achieved", blockedReason: null, updatedAt: now };
    return { goal: g, heartbeat: { ...beat("stopped") }, agents, changed: true, dispatch: [] };
  }
  const reason = budgetExceeded(g, now);
  if (reason && (g.status !== "blocked" || g.blockedReason !== reason)) g = { ...g, status: "blocked", blockedReason: reason, updatedAt: now };
  else if (!reason && g.status === "blocked") g = { ...g, status: "active", blockedReason: null, updatedAt: now };
  // Dispatch only while the goal is active: a blocked goal starts no new work.
  const planned = g.status === "active" ? planTasks(g, lanes, now) : { goal: g, dispatch: [] };
  g = planned.goal;
  return { goal: g, heartbeat: beat("running"), agents, changed: g !== goal, dispatch: planned.dispatch };
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
      // Its open tasks end with it: nothing may dispatch under a cancelled goal.
      return { ok: true, goal: { ...goal, status: "cancelled", blockedReason: null, tasks: goal.tasks.map((x) => (isTerminalTask(x.status) ? x : { ...x, status: "cancelled", turn: null, lastFailure: "the goal was cancelled", updatedAt: now })), updatedAt: now }, heartbeat: { ...hb, status: "stopped" } };
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
  const tasks = Array.isArray(g.tasks) ? g.tasks.filter(isTask) : [];
  return { id: g.id, title: g.title, status: g.status as AosGoalStatus, criteria: g.criteria, budget: g.budget, blockedReason: typeof g.blockedReason === "string" ? g.blockedReason : null, spend, tasks, createdAt: g.createdAt, updatedAt: g.updatedAt };
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

// ---------------------------------------------------------------------------------- P-AOS.2: tasks

export const AOS_TASKS_MAX = 50;
export const AOS_MAX_ATTEMPTS = 2;
export const AOS_RESULT_MAX = 2000;
const TASK_STATUSES: readonly string[] = ["pending", "ready", "running", "needs_review", "done", "failed", "cancelled"];
export const isTerminalTask = (s: AosTaskStatus): boolean => s === "done" || s === "failed" || s === "cancelled";

function isTask(t: unknown): t is AosTask {
  if (!t || typeof t !== "object") return false;
  const x = t as Partial<AosTask>;
  return typeof x.id === "string" && typeof x.title === "string" && typeof x.prompt === "string" && typeof x.outputContract === "string"
    && typeof x.assignee === "string" && TASK_STATUSES.includes(String(x.status)) && Array.isArray(x.acceptance) && Array.isArray(x.dependsOn)
    && x.acceptance.every((c) => c && typeof c.id === "string" && (c.kind === "human" || c.kind === "command") && typeof c.text === "string");
}

export interface AosTaskInput { title: string; prompt: string; outputContract: string; checks: { kind: AosCheckKind; text: string }[]; assignee: string; dependsOn: string[] }

/** Validate a task request (AOS-1 section 6: an output contract and at least one acceptance check). A
 *  check line starting with `$ ` is a command the spoke runs; any other line is a check a person ticks. */
export function validateTaskInput(raw: unknown, goal: AosGoal | null, laneIds: readonly string[]): { ok: true; input: AosTaskInput } | { ok: false; error: string } {
  if (!goal || isTerminalGoal(goal.status)) return { ok: false, error: "Set a fleet goal first: tasks belong to the open goal." };
  if (goal.tasks.length >= AOS_TASKS_MAX) return { ok: false, error: `At most ${AOS_TASKS_MAX} tasks per goal.` };
  const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const one = (v: unknown): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");
  const title = one(b.title);
  if (!title || title.length > AOS_TITLE_MAX) return { ok: false, error: "The task needs a short title." };
  const prompt = typeof b.prompt === "string" ? b.prompt.trim() : "";
  if (!prompt || prompt.length > 8000) return { ok: false, error: "Tell the spoke what to do (up to 8,000 characters)." };
  const outputContract = one(b.outputContract);
  if (!outputContract || outputContract.length > 1000) return { ok: false, error: "Say what the spoke must deliver (AOS-1: every task has an output contract)." };
  const lines = Array.isArray(b.checks) ? b.checks.filter((c): c is string => typeof c === "string").map((c) => c.trim()).filter(Boolean) : [];
  const checks = lines.map((l) => (l.startsWith("$ ") ? { kind: "command" as const, text: l.slice(2).trim() } : { kind: "human" as const, text: l.replace(/\s+/g, " ") }));
  if (!checks.length || checks.some((c) => !c.text)) return { ok: false, error: "Add at least one acceptance check (AOS-1). Start a line with \"$ \" for a command the spoke runs." };
  if (checks.length > 10 || checks.some((c) => c.text.length > AOS_CRITERION_MAX)) return { ok: false, error: `At most 10 checks, each under ${AOS_CRITERION_MAX} characters.` };
  const assignee = typeof b.assignee === "string" ? b.assignee : "";
  if (!laneIds.includes(assignee)) return { ok: false, error: "Pick the spoke that runs this task." };
  const deps = Array.isArray(b.dependsOn) ? [...new Set(b.dependsOn.filter((d): d is string => typeof d === "string"))] : [];
  // Dependencies may only name tasks that already exist, so the graph is acyclic by construction.
  if (deps.some((d) => !goal.tasks.some((t) => t.id === d))) return { ok: false, error: "A dependency names a task that does not exist." };
  return { ok: true, input: { title, prompt, outputContract, checks, assignee, dependsOn: deps } };
}

/** Append a task (pending; the next tick promotes it once its dependencies are done). */
export function addTask(goal: AosGoal, input: AosTaskInput, now: number): AosGoal {
  const n = goal.tasks.reduce((m, t) => Math.max(m, Number(t.id.slice(2)) || 0), 0) + 1;
  const task: AosTask = {
    id: `t-${n}`,
    title: input.title,
    prompt: input.prompt,
    outputContract: input.outputContract,
    acceptance: input.checks.map((c, i) => ({ id: `k${i + 1}`, kind: c.kind, text: c.text, passed: null, detail: null })),
    assignee: input.assignee,
    dependsOn: input.dependsOn,
    status: "pending",
    attempts: 0,
    maxAttempts: AOS_MAX_ATTEMPTS,
    turn: null,
    result: null,
    lastFailure: null,
    createdAt: now,
    updatedAt: now,
  };
  return { ...goal, tasks: [...goal.tasks, task], updatedAt: now };
}

const withTask = (goal: AosGoal, task: AosTask): AosGoal => ({ ...goal, tasks: goal.tasks.map((t) => (t.id === task.id ? task : t)), updatedAt: task.updatedAt });

/** The work prompt a spoke receives. Written by the person who set the task; the harness only frames it. */
export function workPrompt(goal: AosGoal, task: AosTask): string {
  const checks = task.acceptance.map((c) => `- ${c.kind === "command" ? `\`${c.text}\` must exit 0 (run in a separate verification turn)` : `${c.text} (a person checks this)`}`).join("\n");
  const retry = task.lastFailure ? `\n\nThe previous attempt did not pass: ${task.lastFailure}\nFix that first.` : "";
  return `[Fleet goal "${goal.title}", task ${task.id}: ${task.title}]\n\n${task.prompt}\n\nDeliver: ${task.outputContract}\nAcceptance checks:\n${checks}${retry}\n\nWhen you are done, reply with a one-paragraph result.`;
}

/** The verification prompt: run each command exactly, change nothing, answer in strict JSON. */
export function verifyPrompt(task: AosTask): string {
  const cmds = task.acceptance.filter((c) => c.kind === "command").map((c) => `${c.id}: \`${c.text}\``).join("\n");
  return `[Task ${task.id} verification] You are verifying, not working. Run each command below EXACTLY as written in this folder. Do not modify any file and do not try to fix anything. Then reply with ONLY one line of strict JSON: {"checks":[{"id":"k1","pass":true,"detail":"exit code and a short reason"}]} with one entry per command; "pass" is true only when the command exited 0.\n\n${cmds}`;
}

/** The `checks` array of the first balanced JSON object in `text` that has one, else null. */
function checksArray(text: string): unknown[] | null {
  for (let i = text.indexOf("{"); i >= 0; i = text.indexOf("{", i + 1)) {
    let depth = 0, inStr = false, escaped = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (inStr) { if (escaped) escaped = false; else if (ch === "\\") escaped = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        try { const o = JSON.parse(text.slice(i, j + 1)) as { checks?: unknown }; if (Array.isArray(o.checks)) return o.checks; } catch { /* not JSON: keep scanning */ }
        break;
      }
    }
  }
  return null;
}

/** Parse a verification reply. Fail-closed: a check the reply does not answer with `"pass": true` fails. */
export function parseCheckVerdict(text: string, ids: readonly string[]): Record<string, { passed: boolean; detail: string }> {
  const answers = (checksArray(text ?? "") ?? []) as { id?: unknown; pass?: unknown; detail?: unknown }[];
  const out: Record<string, { passed: boolean; detail: string }> = {};
  for (const id of ids) {
    const a = answers.find((x) => x && x.id === id);
    out[id] = a ? { passed: a.pass === true, detail: String(a.detail ?? "").slice(0, 240) || (a.pass === true ? "passed" : "failed") } : { passed: false, detail: "no verdict for this check in the verification reply" };
  }
  return out;
}

/** A failed attempt: retry with the reason while attempts remain, else the task fails. */
function failAttempt(task: AosTask, reason: string, now: number): AosTask {
  const reset = task.acceptance.map((c) => ({ ...c, passed: null, detail: c.kind === "command" ? c.detail : null }));
  return task.attempts < task.maxAttempts
    ? { ...task, status: "ready", turn: null, lastFailure: reason, acceptance: reset, updatedAt: now }
    : { ...task, status: "failed", turn: null, lastFailure: reason, updatedAt: now };
}

/** After the commands passed (or there were none): done when every human check is ticked, else review. */
function afterCommands(task: AosTask, now: number): AosTask {
  const human = task.acceptance.filter((c) => c.kind === "human");
  return human.every((c) => c.passed === true) ? { ...task, status: "done", turn: null, updatedAt: now } : { ...task, status: "needs_review", turn: null, updatedAt: now };
}

/** Heartbeat Plan/Dispatch over existing tasks: promote pending tasks whose dependencies are done, cancel
 *  those whose dependency failed, and start ready tasks on idle spokes, at most one running task per spoke. */
export function planTasks(goal: AosGoal, lanes: readonly AosLaneInput[], now: number): { goal: AosGoal; dispatch: AosDispatch[] } {
  let g = goal;
  const dispatch: AosDispatch[] = [];
  const byId = (id: string): AosTask | undefined => g.tasks.find((t) => t.id === id);
  for (const t0 of goal.tasks) {
    let t = byId(t0.id)!;
    if (t.status === "pending") {
      const deps = t.dependsOn.map(byId);
      const broken = deps.find((d) => !d || d.status === "failed" || d.status === "cancelled");
      if (broken) { g = withTask(g, { ...t, status: "cancelled", lastFailure: `dependency ${broken?.id ?? "?"} did not complete`, updatedAt: now }); continue; }
      if (deps.every((d) => d!.status === "done")) { t = { ...t, status: "ready", updatedAt: now }; g = withTask(g, t); }
    }
    if (t.status !== "ready") continue;
    const lane = lanes.find((l) => l.id === t.assignee);
    if (!lane) { g = withTask(g, { ...t, status: "failed", lastFailure: "its spoke is gone", updatedAt: now }); continue; }
    const laneTaken = lane.busy || lane.status === "stopped" || g.tasks.some((x) => x.assignee === lane.id && x.status === "running") || dispatch.some((d) => d.laneId === lane.id);
    if (laneTaken) continue;
    t = { ...t, status: "running", turn: "work", attempts: t.attempts + 1, updatedAt: now };
    g = withTask(g, t);
    dispatch.push({ taskId: t.id, laneId: lane.id, turn: "work", text: workPrompt(g, t) });
  }
  return { goal: g, dispatch };
}

/** A dispatched turn ended. Work turn: on to verification (command checks), review (human checks), or a
 *  failed attempt. Verify turn: the fail-closed verdict decides. A task cancelled meanwhile is left alone. */
export function taskTurnEnded(goal: AosGoal, taskId: string, turn: "work" | "verify", outcome: AosTurnOutcome, now: number): { goal: AosGoal; dispatch: AosDispatch[] } {
  const t = goal.tasks.find((x) => x.id === taskId);
  if (!t || t.status !== "running" || t.turn !== turn) return { goal, dispatch: [] };
  if (!outcome.ok) return { goal: withTask(goal, failAttempt(t, `the spoke's turn failed: ${outcome.error.slice(0, 200)}`, now)), dispatch: [] };
  if (turn === "work") {
    const done = { ...t, result: outcome.text.trim().slice(-AOS_RESULT_MAX) || null, updatedAt: now };
    if (done.acceptance.some((c) => c.kind === "command")) {
      const v = { ...done, turn: "verify" as const };
      return { goal: withTask(goal, v), dispatch: [{ taskId: t.id, laneId: t.assignee, turn: "verify", text: verifyPrompt(v) }] };
    }
    return { goal: withTask(goal, afterCommands(done, now)), dispatch: [] };
  }
  const ids = t.acceptance.filter((c) => c.kind === "command").map((c) => c.id);
  const verdict = parseCheckVerdict(outcome.text, ids);
  const checked = { ...t, acceptance: t.acceptance.map((c) => (verdict[c.id] ? { ...c, passed: verdict[c.id]!.passed, detail: verdict[c.id]!.detail } : c)), updatedAt: now };
  const failed = checked.acceptance.filter((c) => c.kind === "command" && c.passed !== true);
  if (failed.length) return { goal: withTask(goal, failAttempt(checked, failed.map((c) => `\`${c.text}\`: ${c.detail}`).join("; "), now)), dispatch: [] };
  return { goal: withTask(goal, afterCommands(checked, now)), dispatch: [] };
}

/** A person ticks or rejects a human check. A rejection is a failed attempt (retried with the reason);
 *  the last tick on a task in review completes it. */
export function setTaskCheck(goal: AosGoal | null, taskId: string, checkId: string, passed: boolean, now: number): { ok: true; goal: AosGoal } | { ok: false; error: string } {
  if (!goal) return { ok: false, error: "There is no fleet goal." };
  const t = goal.tasks.find((x) => x.id === taskId);
  if (!t) return { ok: false, error: "No such task." };
  const c = t.acceptance.find((x) => x.id === checkId);
  if (!c || c.kind !== "human") return { ok: false, error: "Only a person's check can be ticked here; command checks are run by the spoke." };
  if (t.status !== "needs_review") return { ok: false, error: "This task is not waiting for review." };
  const next = { ...t, acceptance: t.acceptance.map((x) => (x.id === checkId ? { ...x, passed, detail: passed ? "checked by a person" : "rejected by a person" } : x)), updatedAt: now };
  if (!passed) return { ok: true, goal: withTask(goal, failAttempt(next, `a reviewer rejected: ${c.text}`, now)) };
  return { ok: true, goal: withTask(goal, afterCommands(next, now)) };
}

/** Cancel a task (terminal). Its running turn, if any, is left to finish; its outcome is ignored. */
export function cancelTask(goal: AosGoal | null, taskId: string, now: number): { ok: true; goal: AosGoal } | { ok: false; error: string } {
  if (!goal) return { ok: false, error: "There is no fleet goal." };
  const t = goal.tasks.find((x) => x.id === taskId);
  if (!t) return { ok: false, error: "No such task." };
  if (isTerminalTask(t.status)) return { ok: false, error: `The task is already ${t.status}.` };
  return { ok: true, goal: withTask(goal, { ...t, status: "cancelled", turn: null, lastFailure: "cancelled by a person", updatedAt: now }) };
}

/** On engine start: a task that was mid-turn lost its turn with the old process. It goes back to ready
 *  (the attempt it used still counts, so a crash loop cannot retry forever). */
export function recoverTasks(goal: AosGoal, now: number): AosGoal {
  if (!goal.tasks.some((t) => t.status === "running")) return goal;
  let g = goal;
  for (const t of goal.tasks) if (t.status === "running") g = withTask(g, failAttempt(t, "the engine restarted during this task's turn", now));
  return g;
}
