// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/health_watch.ts - P-HEALTH.1: the harness watching its OWN sessions (the master chat, or one
// fleet lane) so the operator never has to restart the whole LUCID app. This is the automated form of the
// manual habit: after a stall the operator types "Status?" and, failing that, restarts everything.
//
// The ladder is ok -> quiet -> probe -> recover. `quiet` only SHOWS; `probe` injects the canned operator
// note through the existing interject path; `recover` cancels and respawns the child in place.
//
// Pure: DOM-free, IO-free, global-free. Time always arrives as `now`, so a whole stall replays in a test.
//
// The refusals are the reason this module is pure and heavily tested:
//   - An OPEN TOOL CALL caps the verdict at `quiet`, forever, at any silence duration. ADR-0263 (P-STALL.2)
//     deliberately removed the wall-clock turn cutoff because it killed legitimate long work: a ten-minute
//     build is work, not a stall. Probing it would interleave a note into a running call and recovering it
//     would kill exactly the turn worth running. The only thing that outranks an open call is a DEAD child,
//     which is evidence rather than a clock.
//   - Not `busy` is always `ok`. An idle session is not a stalled one; silence there is correct.
//   - Past `maxProbes` the harness never probes again (no nagging loop). Past `maxRecovers` it never
//     recovers again and pins at `quiet`, so a wedged provider cannot become a respawn loop.
//   - Fail-closed: an unreadable clock, or an unknown open-call count, never authorizes an action.

export type HealthAction = "ok" | "quiet" | "probe" | "recover";

export interface HealthConfig {
  quietMs: number;
  probeMs: number;
  recoverMs: number;
  maxProbes: number;
  maxRecovers: number;
}

export const HEALTH_DEFAULTS: HealthConfig = {
  quietMs: 90_000,
  probeMs: 180_000,
  recoverMs: 420_000,
  maxProbes: 2,
  maxRecovers: 2,
};

/** Per-stall-episode counters. Any real activity RESETS them, so a session that recovers and works again
 *  gets a full budget the next time it wedges. */
export interface HealthEpisode {
  probes: number;
  recovers: number;
  startedAt: number;
  lastActionAt: number;
}

export interface HealthInput {
  /** A prompt turn is in flight. */
  busy: boolean;
  /** The omp child is gone (ACPClient.isDead). Evidence, not a clock: outranks every threshold. */
  dead: boolean;
  /** Epoch ms of the last streamed event (token / thinking / tool / status). */
  lastActivityAt: number;
  now: number;
  /** Tool calls awaiting a result. Non-zero caps the verdict at `quiet`. */
  openCalls: number;
  episode: HealthEpisode;
}

export interface HealthVerdict {
  action: HealthAction;
  silentMs: number;
  /** Why, in one plain sentence, safe to show a user verbatim. Never empty. */
  reason: string;
}

/** Minimum gap between two harness actions on one session, so a fast poll cannot fire twice. */
export const HEALTH_ACTION_GAP_MS = 30_000;

/** The canned operator note a probe sends. Delivered on the operator-interject path (operator origin,
 *  outside untrusted delimiters), so it is an instruction and not model-authored text. It asks the
 *  operator's own question and then explicitly hands the turn back, because a probe that reads as a stop
 *  order would end the very work it was checking on. */
export const HEALTH_PROBE_NOTE =
  "Operator note from the LUCID harness: this session has gone quiet with a turn still in flight. " +
  "Status? Answer in one short line: what you are working on right now, what you are waiting on, and " +
  "your next step. This is not a stop order. After that one line, continue the work you were already doing.";

export function newEpisode(now: number): HealthEpisode {
  // lastActionAt 0 means "the harness has not acted in this episode yet", which is why a fresh episode
  // is not muzzled by HEALTH_ACTION_GAP_MS.
  return { probes: 0, recovers: 0, startedAt: now, lastActionAt: 0 };
}

// ── P-HEALTH.2: RESUME the run the recovery interrupted ────────────────────────────────────────────
// `recover` above cancels the wedged turn, drops the omp child, and reloads the SAME session id, so the
// conversation survives. What it never did was resume the WORK: killing the child rejects the in-flight
// `session/prompt`, the turn falls into its error path, prints "[agent unavailable: ...]" and settles. The
// session was healthy again and the run was silently gone, so the operator had to notice and re-ask.
//
// The run is now re-sent on the recovered session with a short operator note saying where it left off, and
// the user is told plainly that the stalled run is being restarted and picked up. Two refusals keep this
// from becoming a machine for repeating work forever:
//   - A USER Stop is never resumed. Only a harness recovery authorizes it.
//   - The budget is per RUN and is NOT refilled by activity. HealthEpisode's own budget resets on any
//     activity (correct for probing a session), but a resumed run that produces a little output and wedges
//     again would refill it and loop, so the resume counter lives on the turn instead.
// A session that failed to reload is also never resumed: talking to a phantom session is worse than the
// stall, and the next prompt starting clean is the honest outcome.

/** How many times ONE run may be auto-resumed after a harness recovery. Per run, never refilled by
 *  activity. Past this the harness says so and leaves the turn ended, rather than restarting forever. */
export const RESUME_MAX_PER_RUN = 2;

/** What the recovery knew at the moment it dropped the child, handed to the interrupted run so it can
 *  explain itself. `pending` is captured at recovery time because the respawn clears the open-call set
 *  before the interrupted request's error handler ever runs. */
export interface RecoverMark {
  reason: string;
  at: number;
  silentMs: number;
  pending: string[];
}

/** The one-shot handoff between the health watchdog and the run it interrupted.
 *
 *  It is a class rather than a bare field because the interesting part is the LIFECYCLE, and a field would
 *  scatter it across three call sites in the backend: the watchdog SETS it just before the child dies, the
 *  interrupted request TAKES it exactly once (so a second failure in the same run cannot reuse one
 *  authorization), and a user Stop CLEARS it (stopping means stop, never "restart automatically"). Keeping
 *  those three moves here means the rule is unit-tested instead of implied by ordering in a 100-line
 *  method. */
export class RecoverMarker {
  private mark: RecoverMark | null = null;

  /** The watchdog is about to recover: authorize ONE resume of whatever run this interrupts. */
  set(mark: RecoverMark): void {
    this.mark = mark;
  }

  /** Consume the authorization. Returns null when there is none, which is the common case: an ordinary
   *  transport failure or a user Stop must fall through to the normal error path. */
  take(): RecoverMark | null {
    const mark = this.mark;
    this.mark = null;
    return mark;
  }

  /** Drop any authorization: a user Stop, or a fresh run that must not inherit the previous one's. */
  clear(): void {
    this.mark = null;
  }
}

export interface ResumeInput {
  /** A harness RECOVERY ended the in-flight request. False for a user Stop or a plain transport failure. */
  recovered: boolean;
  /** The session id survived the recovery (`session/load` restored it). */
  sessionAlive: boolean;
  /** Auto-resumes already spent on THIS run. */
  resumesSoFar: number;
  max?: number;
}

export interface ResumeVerdict {
  resume: boolean;
  /** Why, in one plain sentence, safe to show the user verbatim. Never empty. */
  reason: string;
}

/** Decide whether the interrupted run is re-sent. Pure. The `resume: true` reason is the exact line the
 *  user reads, so it says what is happening and that nothing is being thrown away. */
export function resumeVerdict(i: ResumeInput): ResumeVerdict {
  const max = count(i.max ?? RESUME_MAX_PER_RUN);
  const spent = count(i.resumesSoFar);
  if (!i.recovered) {
    return { resume: false, reason: "This run did not end in a harness recovery, so there is nothing to resume." };
  }
  if (!i.sessionAlive) {
    return { resume: false, reason: "The session could not be reloaded after the restart, so this run cannot be resumed and the next message starts a clean session." };
  }
  if (spent >= max) {
    return {
      resume: false,
      reason: `This run stalled again after being restarted ${spent} time${spent === 1 ? "" : "s"}, so the harness is leaving it stopped instead of restarting it again. The work so far is saved in this session.`,
    };
  }
  return {
    resume: true,
    reason: `The session stalled with a turn still in flight. Restarting the stalled session and picking up where it left off (restart ${spent + 1} of ${max}). Nothing already done is lost.`,
  };
}

/** Trim a quoted fragment for the resume note: enough to orient the model, never enough to re-paste a
 *  whole turn back into the context the reload already restored. */
function clip(s: string, max: number): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}...` : t;
}

export interface ResumeNoteInput {
  /** The operator's original request for this run. */
  request: string;
  /** What the model had produced before it went quiet (the tail is what matters). */
  progress: string;
  /** Labels of the tool calls that were still open when it wedged. */
  pending: string[];
  stalledMs: number;
  /** 1-based: which restart this is, and the ceiling. */
  attempt: number;
  max: number;
}

/** The note that goes to the AGENT on the resumed run. Operator origin, same convention as
 *  HEALTH_PROBE_NOTE: harness-authored instruction, not model-authored text, and deliberately SHORT
 *  because `session/load` already restored the conversation. Its whole job is to stop the model from
 *  starting over, and to make it verify anything it may have left half-written. Pure. */
export function buildResumeNote(i: ResumeNoteInput): string {
  const waited = humanMs(usable(i.stalledMs) ? i.stalledMs : 0);
  const parts = [
    `Operator note from the LUCID harness: your previous turn went quiet for ${waited} with a turn still in flight, `
    + `so this session was restarted and you are resuming mid-run (restart ${count(i.attempt)} of ${count(i.max)}).`,
  ];
  const request = clip(i.request, 400);
  if (request) parts.push(`The request you were working on: "${request}"`);
  const progress = clip(i.progress, 300);
  if (progress) parts.push(`The last thing you produced was: "...${progress}"`);
  const pending = i.pending.filter((p) => typeof p === "string" && p.trim()).map((p) => clip(p, 80));
  if (pending.length) parts.push(`You were waiting on: ${pending.join(", ")}.`);
  parts.push(
    "Continue from where you left off. Do NOT start over and do NOT redo work that is already finished. "
    + "If you were part-way through writing or editing a file, read it first and verify its actual state "
    + "before continuing. If the step you were waiting on cannot be completed, say so and move to the next one.",
  );
  return parts.join(" ");
}

/** Real activity ends the episode: the next stall starts from a full budget. */
export function onActivity(e: HealthEpisode, now: number): HealthEpisode {
  void e; // the old counters are deliberately discarded, not carried forward
  return newEpisode(now);
}

export function onProbe(e: HealthEpisode, now: number): HealthEpisode {
  // `now` is stored raw: an unusable action stamp must stay detectable so the gap check can fail closed.
  return { probes: count(e.probes) + 1, recovers: count(e.recovers), startedAt: e.startedAt, lastActionAt: now };
}

export function onRecover(e: HealthEpisode, now: number): HealthEpisode {
  return { probes: count(e.probes), recovers: count(e.recovers) + 1, startedAt: e.startedAt, lastActionAt: now };
}

export function healthVerdict(i: HealthInput, cfg: HealthConfig = HEALTH_DEFAULTS): HealthVerdict {
  // Fail-closed, and it comes first: if the clock cannot be read, nothing in this frame can be trusted to
  // authorize a cancel-and-respawn, so the harness reports and does nothing. `dead` arrives from the same
  // poll as the clock, so it does not get to escalate past an unreadable one either.
  if (!usable(i.now) || !usable(i.lastActivityAt)) {
    return { action: "ok", silentMs: 0, reason: "The activity clock is unreadable, so the harness is not acting on this session." };
  }

  const silentMs = Math.max(0, i.now - i.lastActivityAt);
  const v = ladder(i, cfg, silentMs);
  if ((v.action === "probe" || v.action === "recover") && withinActionGap(i.episode, i.now)) {
    return {
      action: "quiet",
      silentMs,
      reason: `The harness acted on this session less than ${humanMs(HEALTH_ACTION_GAP_MS)} ago, so it is waiting before acting again.`,
    };
  }
  return v;
}

/** One-line UI label for a verdict (the chip in the composer HUD / the lane card). */
export function healthLabel(v: HealthVerdict): string {
  const t = usable(v.silentMs) ? humanMs(v.silentMs) : "an unknown time";
  switch (v.action) {
    case "ok":
      return "Healthy";
    case "quiet":
      return `Quiet for ${t}`;
    case "probe":
      return `Asking for status after ${t}`;
    case "recover":
      return `Recovering session after ${t}`;
  }
}

// --- internals ---------------------------------------------------------------------------------------

function ladder(i: HealthInput, cfg: HealthConfig, silentMs: number): HealthVerdict {
  const at = (action: HealthAction, reason: string): HealthVerdict => ({ action, silentMs, reason });

  // Evidence beats every clock and beats an open call: a dead child cannot finish the call it is holding,
  // and it cannot take the next prompt either, so this fires even when no turn is in flight.
  if (i.dead) return recoverOrStop(i.episode, cfg, at, "The engine child for this session is gone");

  if (!i.busy) return at("ok", "No turn is in flight, so this session being quiet is expected.");

  if (silentMs < threshold(cfg.quietMs)) {
    return at("ok", `The turn is streaming, last output ${humanMs(silentMs)} ago.`);
  }

  // Fail-closed: an unknown open-call count counts as one open call, so "we cannot tell what is running"
  // caps the verdict at `quiet` instead of authorizing a probe or a respawn.
  const open = Number.isFinite(i.openCalls) ? Math.max(0, Math.floor(i.openCalls)) : 1;
  if (open > 0) {
    // The ADR-0263 guarantee: this branch has no upper bound. A long-running call is never probed and
    // never killed on a clock, at 3 minutes or at 3 hours.
    const calls = open === 1 ? "1 tool call is" : `${open} tool calls are`;
    return at("quiet", `No output for ${humanMs(silentMs)}, but ${calls} still running, so the harness is only watching.`);
  }

  if (silentMs >= threshold(cfg.recoverMs)) {
    return recoverOrStop(i.episode, cfg, at, `No output for ${humanMs(silentMs)} with no tool call running`);
  }

  if (silentMs >= threshold(cfg.probeMs)) {
    const probes = count(i.episode.probes);
    if (probes < count(cfg.maxProbes)) {
      return at("probe", `No output for ${humanMs(silentMs)} with no tool call running, so the harness is asking this session for a status update.`);
    }
    const asked = probes === 1 ? "once" : `${probes} times`;
    return at(
      "quiet",
      `No output for ${humanMs(silentMs)} and the harness has already asked for status ${asked}, so it is waiting rather than asking again.`,
    );
  }

  return at("quiet", `No output for ${humanMs(silentMs)} while a turn is in flight.`);
}

/** The one place a `recover` can be minted, so the retry budget cannot be bypassed by a new caller. */
function recoverOrStop(
  e: HealthEpisode,
  cfg: HealthConfig,
  at: (action: HealthAction, reason: string) => HealthVerdict,
  lead: string,
): HealthVerdict {
  const recovers = count(e.recovers);
  if (recovers < count(cfg.maxRecovers)) {
    return at("recover", `${lead}, so the harness is cancelling and respawning it in place.`);
  }
  const tried = recovers === 1 ? "1 recovery attempt" : `${recovers} recovery attempts`;
  return at("quiet", `${lead}, and the harness has stopped retrying after ${tried}, so this session needs a manual restart.`);
}

function withinActionGap(e: HealthEpisode, now: number): boolean {
  if (count(e.probes) + count(e.recovers) === 0) return false; // nothing has fired yet in this episode
  if (!usable(e.lastActionAt)) return true; // fail-closed: we acted but cannot time it, so hold
  return now - e.lastActionAt < HEALTH_ACTION_GAP_MS;
}

/** A timestamp or duration we are willing to do arithmetic on. NaN, Infinity, and negatives are not. */
function usable(n: number): boolean {
  return Number.isFinite(n) && n >= 0;
}

/** An unusable threshold becomes unreachable rather than falling back to a default: an escalation the
 *  caller did not actually configure must never fire. */
function threshold(ms: number): number {
  return usable(ms) ? ms : Number.POSITIVE_INFINITY;
}

/** Whole, non-negative counters and budgets. An unusable one is zero, so a budget nobody set cannot
 *  authorize the action it guards, and a garbage counter cannot spend one. */
function count(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function humanMs(ms: number): string {
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}
