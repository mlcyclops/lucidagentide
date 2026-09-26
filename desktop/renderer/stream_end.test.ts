// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/stream_end.test.ts - the regression guarded here is the reported one: the engine keeps
// working on a turn while the composer renders nothing and says nothing, and the user can only find out what
// happened by stopping the session and reopening it.

import { describe, expect, test } from "bun:test";
import { STREAM_DROPPED_NOTICE, streamEndEvents, TERMINAL_EVENT_TYPES } from "./stream_end.ts";

describe("streamEndEvents", () => {
  test("THE BUG: a mid-stream death is announced AND settles the turn", () => {
    const { kind, events } = streamEndEvents({ aborted: false, terminalDone: false });
    expect(kind).toBe("dropped");
    // Visible first, then the terminal `done` the wire never sent - otherwise the composer spins forever.
    expect(events.map((e) => e.type)).toEqual(["token", "done"]);
    expect(events[0]).toEqual({ type: "token", text: STREAM_DROPPED_NOTICE });
  });

  test("the notice tells the user the turn may still be running and where its output is", () => {
    // Pinned wording: the old failure mode was silence, so the recovery step is the load-bearing part.
    expect(STREAM_DROPPED_NOTICE).toContain("still be running");
    expect(STREAM_DROPPED_NOTICE).toContain("reopen the session");
  });

  test("Stop stays silent - an abort is expected, not a fault", () => {
    expect(streamEndEvents({ aborted: true, terminalDone: false })).toEqual({ kind: "aborted", events: [] });
    // Abort wins even if a done also arrived, so a Stop race cannot emit a spurious notice.
    expect(streamEndEvents({ aborted: true, terminalDone: true })).toEqual({ kind: "aborted", events: [] });
  });

  test("a normal turn emits nothing extra - no duplicate done", () => {
    expect(streamEndEvents({ aborted: false, terminalDone: true })).toEqual({ kind: "complete", events: [] });
  });

  test("a tail stream closing cleanly is NOT a drop (fleet lane watch has no terminal done)", () => {
    // Regression guard for the collateral: painting a false failure into every lane on release.
    expect(streamEndEvents({ aborted: false, terminalDone: false, tail: true }))
      .toEqual({ kind: "complete", events: [] });
    expect(streamEndEvents({ aborted: true, terminalDone: false, tail: true }))
      .toEqual({ kind: "aborted", events: [] });
  });

  test("a tail stream that DID deliver done is still complete", () => {
    expect(streamEndEvents({ aborted: false, terminalDone: true, tail: true }))
      .toEqual({ kind: "complete", events: [] });
  });
});

describe("TERMINAL_EVENT_TYPES", () => {
  test("a failed fleet lane turn counts as self-explained - error, not just done", () => {
    // fleet_lanes.ts settles a FAILED turn with `error` and never sends `done`. Without error in this
    // table, every lane failure would also get the dropped-turn notice stacked on top of its real message.
    expect(TERMINAL_EVENT_TYPES.done).toBe(true);
    expect(TERMINAL_EVENT_TYPES.error).toBe(true);
    expect(TERMINAL_EVENT_TYPES["lane-error"]).toBe(true);
  });

  test("mid-turn events are NOT terminal - they must never suppress the notice", () => {
    for (const t of ["token", "thinking", "tool", "tool-meta", "permission", "usage", "slow", "ping", "goal-iter"]) {
      expect(TERMINAL_EVENT_TYPES[t]).toBeUndefined();
    }
  });
});
