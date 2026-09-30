// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-HEALTH.3: the streaming beat keeps the stall watchdog from killing a model that is busy writing a large
// tool call. Two ways it could go wrong are tested here: a beat credited to the wrong session would hide a
// real stall behind another session's streaming, and a beat that fires on anything would turn evidence of
// output into a blanket keep-alive.

import { describe, expect, test } from "bun:test";
import { BEAT_MS, beatSession, makeThrottle } from "./stream_beat_extension.ts";

const ctx = (id: unknown) => ({ sessionManager: { getSessionId: () => id } });
const update = (type: string) => ({ type: "message_update", message: {}, assistantMessageEvent: { type, delta: "x" } });

describe("beatSession", () => {
  test("tool-call argument streaming beats for the session that is streaming", () => {
    expect(beatSession(update("toolcall_start"), ctx("s-1"))).toBe("s-1");
    expect(beatSession(update("toolcall_delta"), ctx("s-1"))).toBe("s-1");
  });

  test("only tool-call streaming beats: text and thinking already reach the desktop, and nothing else is output", () => {
    for (const type of ["text_delta", "thinking_delta", "toolcall_end", "done", "error", "start"]) {
      expect(beatSession(update(type), ctx("s-1"))).toBeNull();
    }
  });

  test("no nameable session means no beat, so a beat can never be credited to the wrong session", () => {
    expect(beatSession(update("toolcall_delta"), undefined)).toBeNull();
    expect(beatSession(update("toolcall_delta"), {})).toBeNull();
    expect(beatSession(update("toolcall_delta"), ctx("  "))).toBeNull();
    expect(beatSession(update("toolcall_delta"), ctx(42))).toBeNull();
    expect(beatSession(update("toolcall_delta"), { sessionManager: { getSessionId: () => { throw new Error("switching"); } } })).toBeNull();
  });
});

describe("makeThrottle", () => {
  test("one beat per window per session, and sessions do not share a window", () => {
    const due = makeThrottle();
    expect(due("a", 0)).toBe(true);
    expect(due("a", BEAT_MS - 1)).toBe(false);
    expect(due("b", BEAT_MS - 1)).toBe(true); // a lane streaming must not starve the master's beat
    expect(due("a", BEAT_MS)).toBe(true);
  });
});
