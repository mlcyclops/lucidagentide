// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-SWITCH.1 (ADR-0403): what opening a session does, decided without touching the DOM.
//
// Main (the hub) is ONE omp process holding ONE session. Loading another session into it, or starting a
// new one, runs AcpBackend.clearTurnRecovery, which cancels a live turn (ADR-0385: correct, it ended the
// "already running" wedge). Before this increment the sidebar did that on a plain click, so a working
// session was stopped by the act of looking at another one. The rule now: opening a session never stops
// work unless the user picks the option that says so. The engine enforces it (409 without `force`); this
// module decides what the renderer offers, and app.ts paints it.

import { promoteRefusal } from "./composer_target.ts";

/** A live lane as the fleet reports it: enough to know which session it holds and whether it can attach. */
export interface SwitchLane { id: string; sessionId: string | null; status: string }

export interface SwitchState {
  /** Why Main cannot switch without stopping work (the engine's words), or null when Main is idle. */
  busy: string | null;
  /** The session Main holds, when known. */
  mainSessionId: string | null;
  /** The session the user asked to open. */
  targetId: string;
  /** Every lane the fleet reports. */
  lanes: SwitchLane[];
}

export type SwitchPlan =
  /** Main is idle: open it in Main as before. Also the path for Main's OWN session, whose running turn
   *  resumeSession adopts instead of loading. */
  | { kind: "load" }
  /** The session already runs in a spoke: attach the composer to that spoke. Loading it into Main too
   *  would put one session in two omp processes, both appending to the same history file. */
  | { kind: "promote"; laneId: string }
  /** The session's spoke exists but cannot attach right now (starting, or waiting on an approval): say
   *  why, and load nothing, for the same two-writers reason. */
  | { kind: "refuse"; reason: string }
  /** Main is working: the user chooses between a spoke and stopping it. */
  | { kind: "ask"; reason: string };

/** A lane whose child process is gone no longer holds its session file; any other status does. */
const LANE_GONE: Record<string, true> = { stopped: true, error: true };

/** Decide what opening `targetId` does. */
export function planSessionSwitch(s: SwitchState): SwitchPlan {
  const owner = s.lanes.find((l) => l.sessionId === s.targetId && !LANE_GONE[l.status]);
  if (owner) {
    const refusal = promoteRefusal(owner.status);
    return refusal ? { kind: "refuse", reason: refusal } : { kind: "promote", laneId: owner.id };
  }
  // Main's own session: resumeSession adopts the live turn (or re-shows the idle one). Nothing is stopped.
  if (s.mainSessionId && s.targetId === s.mainSessionId) return { kind: "load" };
  return s.busy ? { kind: "ask", reason: s.busy } : { kind: "load" };
}

/** Every string the switch sheet shows. `target` is null for New session. Titles are plain text: the caller
 *  sets them with textContent, never as HTML. */
export interface SwitchSheetCopy { title: string; body: string; spoke: string; spokeHint: string; stop: string; stay: string }

export function switchSheetCopy(main: string | null, target: string | null, reason: string): SwitchSheetCopy {
  const running = main ? `"${clip(main)}"` : "The main session";
  const next = target ? `"${clip(target)}"` : "a new session";
  return {
    title: `${running} is still working`,
    body: `Opening ${next} here would stop it (${reason}). Choose how to open it.`,
    spoke: target ? "Open as a spoke" : "Start it as a spoke",
    spokeHint: `${running} keeps running in Main. ${next.charAt(0).toUpperCase()}${next.slice(1)} opens in its own spoke, and this composer drives it.`,
    stop: target ? "Stop it and switch" : "Stop it and start new",
    stay: "Stay here",
  };
}

/** A spoke's display name from a session title: one line, bounded, never empty. */
export function spokeNameFor(title: string | null | undefined): string {
  const t = (title ?? "").replace(/\s+/g, " ").trim();
  return t ? clip(t) : "Session";
}

const TITLE_MAX = 48;
function clip(s: string): string {
  return s.length <= TITLE_MAX ? s : `${s.slice(0, TITLE_MAX - 1)}\u2026`;
}
