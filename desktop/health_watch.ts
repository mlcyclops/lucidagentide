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
