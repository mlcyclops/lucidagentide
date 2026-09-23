// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/recovery_supervisor.ts - P-RECOVER.1 (ADR-0384): what the window does when a turn says
// "reconnecting" and nothing happens, or a send is refused.
//
// The field report was a prompt stuck on "reconnecting" forever: the stream's own reattach loop kept
// knocking on a turn that no longer existed, or on an engine whose agent child had died, and nothing
// ever looked at WHY. This module is the decision half of the fix. It is a PURE state machine: it never
// touches the DOM or the network. app.ts feeds it observations (a probe of the engine, the result of the
// last remedy) and performs the action it names.
//
// The ladder, cheapest first:
//   probe          GET /api/session-health + /api/chat/status, every PROBE_INTERVAL_MS
//   reattach       the turn is still running: follow it again
//   resync         the turn is gone: stop waiting and reload the thread from the session
//   recover-agent  the master agent child is dead, exhausted, or wedged: POST /api/recovery/recover (once)
//   restart-engine the engine stopped answering UNREACHABLE_BEFORE_RESTART probes in a row: IPC (once)
//   give-up / done terminal
//
// Termination is the point. Every remedy has a fixed budget, the probe loop has a fixed budget, and a
// run has a hard step cap, so no input sequence can keep the window "reconnecting" forever. On top of
// that, mayStartRun() caps how many automatic runs may start in a window of time, so a remedy that
// itself raises a new trigger cannot chain runs indefinitely.
//
// Also here (pure, DOM-free, so they can be tested): the incident view shapes the bridge returns, their
// fail-closed shape gates, the probe mapping, and the guard that only a prefilled issue on the upstream
// repository can be opened from a recovery notice.

import { INCIDENT_REPO, type IncidentKind, type IncidentOutcome } from "../incident_report.ts";

export type { IncidentKind, IncidentOutcome };

// ── The engine API views (mirrors the P-RECOVER.1 contract in dev.ts) ─────────────────────────────────

/** One incident as the window sees it. Every string in it came from the engine's redacted store and is
 *  still rendered as TEXT only (textContent / esc), never as markup. */
export interface IncidentView {
  id: string;
  kind: IncidentKind;
  outcome: IncidentOutcome;
  createdAt: number;
  issueTitle: string;
  issueBody: string;
  issueUrl: string;
  reportPath: string;
  seen: boolean;
}
/** GET /api/recovery/state. `previous` is the master session the PREVIOUS engine process was on. */
export interface RecoveryStateView {
  previous: { sessionId: string; cwd: string; at: number } | null;
  currentSessionId: string | null;
  incidents: IncidentView[];
}
/** POST /api/recovery/resume: a VERIFIED session/load of the previous session. */
export interface RecoveryResumeView { ok: boolean; sessionId?: string; error?: string; incidentId?: string }
/** POST /api/recovery/recover: in-place recovery of the master agent child. */
export interface RecoveryRecoverView { ok: boolean; sessionId: string | null; reason: string; incidentId?: string }
/** window.lucid.restartEngine(): main's engine restart. */
export interface EngineRestartView { ok: boolean; reason: string; incidentId?: string }

const KINDS: readonly IncidentKind[] = ["unclean-shutdown", "leftover-processes", "session-unrecoverable", "engine-unreachable", "agent-child-failed", "recovery-exhausted"];
const OUTCOMES: readonly IncidentOutcome[] = ["recovered", "not-recovered", "pending"];
/** incident_store.ts ID_SHAPE: time digits plus 4 base36 chars. Anything else never goes back to the engine. */
const INCIDENT_ID = /^[0-9TZ]+-[0-9a-z]{4}$/;

export function isIncidentId(v: unknown): v is string {
  return typeof v === "string" && v.length <= 40 && INCIDENT_ID.test(v);
}

/** One field of an untrusted JSON value; undefined when `v` is not an object or lacks it. */
function prop(v: unknown, key: string): unknown {
  if (!v || typeof v !== "object" || !(key in v)) return undefined;
  return Reflect.get(v, key);
}

/** Fail-closed shape gate for one incident off the wire. */
export function isIncidentView(v: unknown): v is IncidentView {
  const kind = prop(v, "kind"), outcome = prop(v, "outcome");
  return isIncidentId(prop(v, "id"))
    && KINDS.some((k) => k === kind)
    && OUTCOMES.some((o) => o === outcome)
    && typeof prop(v, "createdAt") === "number"
    && typeof prop(v, "issueTitle") === "string"
    && typeof prop(v, "issueBody") === "string"
    && typeof prop(v, "issueUrl") === "string"
    && typeof prop(v, "reportPath") === "string"
    && typeof prop(v, "seen") === "boolean";
}

/** Keep only well-formed incidents; a malformed list is an empty one. */
export function incidentList(v: unknown): IncidentView[] {
  return Array.isArray(v) ? v.filter(isIncidentView) : [];
}

export function recoveryStateFrom(v: unknown): RecoveryStateView | null {
  if (!v || typeof v !== "object") return null;
  const p = prop(v, "previous");
  const sessionId = prop(p, "sessionId"), cwd = prop(p, "cwd"), at = prop(p, "at");
  const current = prop(v, "currentSessionId");
  return {
    previous: typeof sessionId === "string" && sessionId
      ? { sessionId, cwd: typeof cwd === "string" ? cwd : "", at: typeof at === "number" ? at : 0 }
      : null,
    currentSessionId: typeof current === "string" && current ? current : null,
    incidents: incidentList(prop(v, "incidents")),
  };
}

/** Only a prefilled NEW ISSUE on the upstream repository may be opened from a recovery notice. The engine
 *  builds this URL, but the window checks it anyway: a notice must never become a way to open an
 *  arbitrary page. */
export function isIncidentIssueUrl(url: string, repo: string = INCIDENT_REPO): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  return u.protocol === "https:" && u.hostname === "github.com" && !u.username && !u.password && !u.port
    && u.pathname === `/${repo}/issues/new`;
}

// ── Plain-language copy ───────────────────────────────────────────────────────────────────────────────

/** One sentence naming what happened, for the notice. */
export function incidentHeadline(kind: IncidentKind, outcome: IncidentOutcome): string {
  const failed = outcome === "not-recovered";
  switch (kind) {
    case "unclean-shutdown": return "LUCID did not close cleanly last time.";
    case "leftover-processes": return "LUCID stopped processes left over from the last run.";
    case "session-unrecoverable": return "A previous chat session could not be restored.";
    case "engine-unreachable": return failed ? "The engine stopped answering and could not be restarted." : "The engine stopped answering and was restarted.";
    case "agent-child-failed": return failed ? "The agent process failed and could not be restarted." : "The agent process failed and was restarted.";
    case "recovery-exhausted": return "Automatic recovery ran out of attempts.";
  }
}

// ── The supervisor ────────────────────────────────────────────────────────────────────────────────────

export const PROBE_INTERVAL_MS = 3_000;
/** Consecutive unreachable probes before the engine restart is asked for. */
export const UNREACHABLE_BEFORE_RESTART = 3;
/** Probes per run (about a minute at PROBE_INTERVAL_MS). */
export const MAX_PROBES = 20;
/** Reattach attempts per run. */
export const MAX_REATTACHES = 2;
/** Hard cap on steps per run: a backstop under every per-remedy budget. */
export const MAX_STEPS = 40;
/** Automatic runs allowed per RUN_WINDOW_MS. User-initiated retries do not count. */
export const MAX_RUNS_PER_WINDOW = 3;
export const RUN_WINDOW_MS = 5 * 60_000;

export type RecoveryTrigger =
  /** The chat stream reported its connection state (ndjson_stream onRecovery). */
  | { kind: "connection"; state: "reconnecting" | "failed" }
  /** A send did not start a turn. `already-running` = the engine refused it with "A chat turn is already running". */
  | { kind: "send-failed"; reason: "unreachable" | "already-running" };

/** One look at the engine. `turnRunning` is null when the turn status could not be read. */
export interface EngineProbe {
  engineReachable: boolean;
  turnRunning: boolean | null;
  masterDead: boolean;
  exhausted: boolean;
}

export type GiveUpReason =
  | "engine-unreachable" // restart already used, or not possible here
  | "engine-not-restarted" // the restart was refused or failed
  | "agent-not-recovered"
  | "turn-unreachable"
  | "resync-failed"
  | "out-of-time";

export type DoneHow = "reattached" | "resynced" | "agent-recovered" | "engine-restarted" | "engine-ready";

export type RecoveryAction =
  | { type: "probe"; delayMs: number }
  | { type: "reattach" }
  | { type: "recover-agent" }
  | { type: "restart-engine" }
  | { type: "resync" }
  | { type: "give-up"; reason: GiveUpReason; detail?: string }
  | { type: "done"; how: DoneHow };

export type RemedyResult =
  | { action: "reattach" | "recover-agent" | "resync"; ok: boolean }
  /** `reason` is main's: "engine-healthy" means its own probe answered, so keep probing. */
  | { action: "restart-engine"; ok: boolean; reason?: string };

export interface RecoveryRun {
  readonly trigger: RecoveryTrigger;
  /** The window holds a turn view open for output (vs. a send that already settled). */
  readonly waiting: boolean;
  readonly steps: number;
  readonly probes: number;
  readonly unreachableStreak: number;
  readonly reattaches: number;
  readonly agentRecoverTried: boolean;
  readonly agentRecovered: boolean;
  readonly engineRestartTried: boolean;
  readonly finished: boolean;
  readonly last: RecoveryAction | null;
}

export interface RecoveryStep { run: RecoveryRun; action: RecoveryAction }

function step(run: RecoveryRun, action: RecoveryAction): RecoveryStep {
  const finished = action.type === "done" || action.type === "give-up";
  const steps = run.steps + 1;
  if (!finished && steps > MAX_STEPS) {
    const cut: RecoveryAction = { type: "give-up", reason: "out-of-time" };
    return { run: { ...run, steps, finished: true, last: cut }, action: cut };
  }
  return { run: { ...run, steps, finished, last: action }, action };
}

/** Begin a run. `engineRestartUsed` carries the once-per-window budget for the engine restart across
 *  runs (the restart reloads the window, so a second one in the same page is never automatic). */
export function startRecovery(trigger: RecoveryTrigger, opts: { waiting: boolean; engineRestartUsed?: boolean }): RecoveryStep {
  const run: RecoveryRun = {
    trigger, waiting: opts.waiting, steps: 0, probes: 0, unreachableStreak: 0, reattaches: 0,
    agentRecoverTried: false, agentRecovered: false, engineRestartTried: !!opts.engineRestartUsed, finished: false, last: null,
  };
  return step(run, { type: "probe", delayMs: 0 });
}

/** Decide from one probe. */
export function afterProbe(run: RecoveryRun, p: EngineProbe): RecoveryStep {
  if (run.finished) return { run, action: run.last! };
  const probes = run.probes + 1;
  if (!p.engineReachable) {
    const unreachableStreak = run.unreachableStreak + 1;
    const next = { ...run, probes, unreachableStreak };
    if (unreachableStreak >= UNREACHABLE_BEFORE_RESTART) {
      if (!run.engineRestartTried) return step({ ...next, engineRestartTried: true }, { type: "restart-engine" });
      return step(next, { type: "give-up", reason: "engine-unreachable" });
    }
    if (probes >= MAX_PROBES) return step(next, { type: "give-up", reason: "out-of-time" });
    return step(next, { type: "probe", delayMs: PROBE_INTERVAL_MS });
  }
  const next = { ...run, probes, unreachableStreak: 0 };
  // A dead or given-up master child cannot finish any turn: nothing cheaper can help.
  if (p.masterDead || p.exhausted) {
    if (!run.agentRecoverTried) return step({ ...next, agentRecoverTried: true }, { type: "recover-agent" });
    return step(next, { type: "give-up", reason: "agent-not-recovered" });
  }
  if (p.turnRunning === true) {
    if (run.reattaches < MAX_REATTACHES) return step({ ...next, reattaches: run.reattaches + 1 }, { type: "reattach" });
    return step(next, { type: "give-up", reason: "turn-unreachable" });
  }
  // The engine answers and no turn is running.
  if (run.waiting) return step(next, { type: "resync" });
  // "Already running" while the engine says idle is the wedged-listener case: only the agent reset clears it.
  if (run.trigger.kind === "send-failed" && run.trigger.reason === "already-running") {
    if (!run.agentRecoverTried) return step({ ...next, agentRecoverTried: true }, { type: "recover-agent" });
    return step(next, { type: "give-up", reason: "agent-not-recovered" });
  }
  return step(next, { type: "done", how: run.agentRecovered ? "agent-recovered" : "engine-ready" });
}

/** Decide from the result of the remedy the run last asked for. */
export function afterRemedy(run: RecoveryRun, r: RemedyResult): RecoveryStep {
  if (run.finished) return { run, action: run.last! };
  const again: RecoveryAction = { type: "probe", delayMs: PROBE_INTERVAL_MS };
  switch (r.action) {
    case "reattach":
      return r.ok ? step(run, { type: "done", how: "reattached" }) : step(run, again);
    case "recover-agent": {
      if (!r.ok) return step(run, again); // the next probe decides: dead again = give up, idle = fine
      const next = { ...run, agentRecovered: true };
      // Recovery cancels whatever the old child held, so a waiting view has nothing left to follow.
      return next.waiting ? step(next, { type: "resync" }) : step(next, { type: "done", how: "agent-recovered" });
    }
    case "restart-engine":
      if (r.ok) return step(run, { type: "done", how: "engine-restarted" });
      if (r.reason === "engine-healthy") return step({ ...run, unreachableStreak: 0 }, { type: "probe", delayMs: 0 });
      return step(run, { type: "give-up", reason: "engine-not-restarted", ...(r.reason ? { detail: r.reason } : {}) });
    case "resync":
      return r.ok
        ? step(run, { type: "done", how: run.agentRecovered ? "agent-recovered" : "resynced" })
        : step(run, { type: "give-up", reason: "resync-failed" });
  }
}

/** Whether another AUTOMATIC run may start now, given the start times of earlier ones. */
export function mayStartRun(starts: readonly number[], now: number): boolean {
  return starts.filter((t) => now - t < RUN_WINDOW_MS).length < MAX_RUNS_PER_WINDOW;
}

/** Map the two probe reads onto an EngineProbe. `health`/`status` are the `data` of
 *  /api/session-health and /api/chat/status; `reached` is whether each answered at all (any HTTP status). */
export function probeFrom(health: { reached: boolean; data: unknown }, status: { reached: boolean; ok: boolean; data: unknown }): EngineProbe {
  const master = prop(health.data, "master");
  let turnRunning: boolean | null = null;
  if (status.reached && status.ok) {
    const running = prop(status.data, "running");
    if (status.data === null) turnRunning = false; // no turn has ever run on this engine
    else if (typeof running === "boolean") turnRunning = running;
  }
  return {
    engineReachable: health.reached || status.reached,
    turnRunning,
    masterDead: prop(master, "dead") === true,
    exhausted: prop(master, "exhausted") === true,
  };
}

// ── What the notice says ──────────────────────────────────────────────────────────────────────────────

/** The progress line for an in-flight action (the thread-tail notice). */
export function progressText(a: RecoveryAction): string {
  switch (a.type) {
    case "probe": return "Checking the engine\u2026";
    case "reattach": return "Reconnecting to the running turn\u2026";
    case "recover-agent": return "Restarting the agent process\u2026";
    case "restart-engine": return "Restarting the engine\u2026";
    case "resync": return "Reloading the conversation from the session\u2026";
    case "give-up": case "done": return "";
  }
}

export function doneText(how: DoneHow): string {
  switch (how) {
    case "reattached": return "Reconnected to the running turn.";
    case "resynced": return "The turn is no longer running. The conversation was reloaded from the session.";
    case "agent-recovered": return "The agent process was restarted and your session was reloaded.";
    case "engine-restarted": return "The engine was restarted. Reloading the window.";
    case "engine-ready": return "The engine is answering again.";
  }
}

export function giveUpText(reason: GiveUpReason, detail?: string): string {
  switch (reason) {
    case "engine-unreachable": return "The engine is not answering and could not be restarted automatically. Restart LUCID if this continues.";
    case "engine-not-restarted":
      return detail === "rate-limited"
        ? "The engine is not answering. It was already restarted less than a minute ago, so LUCID did not try again. Restart LUCID if this continues."
        : "The engine is not answering and the restart did not succeed. Restart LUCID if this continues.";
    case "agent-not-recovered": return "The agent process could not be restarted. Start a new session, or restart LUCID if this continues.";
    case "turn-unreachable": return "The running turn could not be reconnected. Stop it, or wait and reconnect again.";
    case "resync-failed": return "The conversation could not be reloaded from the session. Open it again from the sessions list.";
    case "out-of-time": return "The engine did not recover in time. Restart LUCID if this continues.";
  }
}
