// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/stream_end.ts - what the UI must be told when an NDJSON turn stream ENDS.
//
// THE BUG THIS EXISTS FOR: bridge.ts's streamNdjson surfaced every PRE-stream failure loudly (unreachable
// backend, 404, non-OK status each emitted a visible line plus `done`) but handled the MID-stream failure -
// by far the most likely one on a long turn - with a bare `catch {}`. So when the socket died after the first
// events, the client silently stopped reading while the server turn KEPT RUNNING (ndjsonStream's own comment:
// "server turn continues"). The composer froze on the last event it happened to receive, with no error, no
// spinner resolution, and no hint that work was still happening. The user only learned what the agent did by
// stopping the session and reopening it, where the persisted history showed the whole turn.
//
// A stream can end three ways, and only one of them is a fault:
//   • aborted  - Stop was pressed (or the caller aborted). Expected; the caller's finally settles the UI.
//   • complete - a terminal `done` event arrived. The normal path.
//   • dropped  - the reader errored, or the body ended with no terminal `done`. THE FAULT: the turn is very
//                likely still running server-side, so the UI must say so instead of quietly freezing.
//
// A FOLLOW/tail stream (the fleet lane watch) is the deliberate exception: it is a live tail that the server
// closes on lane release without ever sending `done` (see renderer/fleet_grid.ts - "a stream ending, or being
// stopped on release, is not an error"). Treating its clean close as a drop would paint a false failure into
// every lane, so `tail` opts out of the synthesized notice.

import type { ChatEvent } from "./chat_events.ts";

export type StreamEndKind = "aborted" | "complete" | "dropped";

/** Event types that end a turn ON ITS OWN TERMS, so the stream closing afterwards is expected.
 *
 *  `done` is the normal finish. `error` / `lane-error` matter just as much: a FAILED fleet lane turn settles
 *  with an error event and NO `done` (desktop/fleet_lanes.ts), and a lane that has already explained itself
 *  must not then be handed a "connection dropped" line on top of its real error. Kept here, next to the
 *  decision that consumes it, so the reader in bridge.ts cannot drift from this list. */
export const TERMINAL_EVENT_TYPES: Readonly<Record<string, true>> = {
  done: true,
  error: true,
  "lane-error": true,
};

export interface StreamEndState {
  /** The caller's AbortSignal fired - Stop, a superseding prompt, or teardown. */
  aborted: boolean;
  /** A TERMINAL_EVENT_TYPES event was seen on the wire (the turn reported its own ending). */
  terminalDone: boolean;
  /** A live tail stream that the server may close cleanly with no terminal `done` (fleet lane watch). */
  tail?: boolean;
}

/** The user-facing line for a dropped turn stream. Names the fault, says the work may still be running, and
 *  points at the one place the output is guaranteed to exist - so "the composer just stopped" is never the
 *  whole story the user gets. Exported so the test pins the wording that carries the recovery step. */
export const STREAM_DROPPED_NOTICE =
  "[connection to the engine dropped mid-turn - this turn may still be running in the background. "
  + "Its output is saved to this session; reopen the session to see the rest.]";

/** Classify how a stream ended, then say what to emit. `dropped` is the only kind that emits: a visible
 *  notice plus the terminal `done` the wire never delivered, so the turn settles honestly instead of
 *  spinning forever. Pure - the array is what bridge.ts feeds back through its own onEvent sink. */
export function streamEndEvents(state: StreamEndState): { kind: StreamEndKind; events: ChatEvent[] } {
  if (state.aborted) return { kind: "aborted", events: [] };
  if (state.terminalDone) return { kind: "complete", events: [] };
  // A tail stream has no terminal `done` by design; a clean close is its normal end, not a fault.
  if (state.tail) return { kind: "complete", events: [] };
  return { kind: "dropped", events: [{ type: "token", text: STREAM_DROPPED_NOTICE }, { type: "done" }] };
}
