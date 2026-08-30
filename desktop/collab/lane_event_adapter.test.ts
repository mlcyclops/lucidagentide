// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/lane_event_adapter.test.ts - P-PWA-FOCUS.1: the lane -> chat translation.
//
// The load-bearing properties here are all about what does NOT happen. The adapter sits between two unions
// that were designed apart, so the failures worth pinning are: a payload quietly reshaped in transit, a
// `done` that fabricates an authoritative reply and wipes the phone's streamed text, a lane-only field
// riding to a guest under a ChatEvent name, a status/approval double-reported as conversation, and an
// unrecognized variant guessed into the nearest-looking event. Each has a test.

import { describe, expect, it } from "bun:test";
import type { LaneEvent } from "../fleet_lanes.ts";
import type { ChatEvent } from "../renderer/chat_events.ts";
import { laneEventToChatEvent } from "./lane_event_adapter.ts";

/** The keys each target ChatEvent variant DECLARES. Anything else in an output object is a leak. */
const DECLARED: Readonly<Record<string, readonly string[]>> = {
  token: ["type", "text"],
  thinking: ["type", "text"],
  tool: ["type", "name", "detail", "code"],
  done: ["type", "text"],
  "lane-error": ["type", "message"],
};
/** The keys the ChatEvent `code` sub-object declares. */
const CODE_KEYS: readonly string[] = ["path", "content", "oldText", "newText", "patch"];

/** Assert an output carries no key its target variant does not declare, nested `code` included. */
function expectNoUndeclaredKeys(out: ChatEvent): void {
  const declared = DECLARED[out.type];
  expect(declared, `no declared key list for ${out.type}`).toBeDefined();
  for (const key of Object.keys(out)) expect(declared).toContain(key);
  if (out.type === "tool" && out.code) for (const key of Object.keys(out.code)) expect(CODE_KEYS).toContain(key);
}

/** Every LaneEvent variant this build knows, and whether it is conversation for a guest. */
const SAMPLES: { lane: LaneEvent; mapped: boolean }[] = [
  { lane: { type: "token", text: "hi" }, mapped: true },
  { lane: { type: "thinking", text: "hmm" }, mapped: true },
  { lane: { type: "tool", name: "read", detail: "src/a.ts" }, mapped: true },
  { lane: { type: "tool", name: "write", detail: "src/a.ts", code: { path: "/w/src/a.ts", content: "x" } }, mapped: true },
  { lane: { type: "permission", summary: "run tests", kind: "exec" }, mapped: false },
  { lane: { type: "auto-approved", summary: "run tests", mode: "session" }, mapped: false },
  { lane: { type: "status", status: "working" }, mapped: false },
  { lane: { type: "done" }, mapped: true },
  { lane: { type: "error", message: "child exited" }, mapped: true },
];

describe("lane_event_adapter: laneEventToChatEvent", () => {
  it("token and thinking round-trip their text byte for byte, whitespace and all", () => {
    const text = "line one\n  indented\n\nline four ";
    expect(laneEventToChatEvent({ type: "token", text })).toEqual({ type: "token", text });
    expect(laneEventToChatEvent({ type: "thinking", text })).toEqual({ type: "thinking", text });
    // The two lane variants share one shape; the mapping must NOT collapse them onto one chat type.
    expect(laneEventToChatEvent({ type: "thinking", text: "t" })?.type).toBe("thinking");
    expect(laneEventToChatEvent({ type: "token", text: "" })).toEqual({ type: "token", text: "" });
  });

  it("a tool with NO code maps name and detail and stays code-free", () => {
    const out = laneEventToChatEvent({ type: "tool", name: "bash", detail: "bun test" });
    expect(out).toEqual({ type: "tool", name: "bash", detail: "bun test" });
    expect(out && "code" in out).toBe(false);
  });

  it("a tool WITH code carries every code field across under its own meaning", () => {
    const write: LaneEvent = { type: "tool", name: "write", detail: "src/a.ts", code: { path: "/w/src/a.ts", content: "export const a = 1;\n" } };
    expect(laneEventToChatEvent(write)).toEqual({ type: "tool", name: "write", detail: "src/a.ts", code: { path: "/w/src/a.ts", content: "export const a = 1;\n" } });

    const edit: LaneEvent = { type: "tool", name: "edit", detail: "src/b.ts", code: { path: "/w/src/b.ts", oldText: "old", newText: "new" } };
    expect(laneEventToChatEvent(edit)).toEqual({ type: "tool", name: "edit", detail: "src/b.ts", code: { path: "/w/src/b.ts", oldText: "old", newText: "new" } });

    const patch: LaneEvent = { type: "tool", name: "edit", detail: "src/c.ts", code: { path: "/w/src/c.ts", patch: "@@ -1 +1 @@" } };
    expect(laneEventToChatEvent(patch)).toEqual({ type: "tool", name: "edit", detail: "src/c.ts", code: { path: "/w/src/c.ts", patch: "@@ -1 +1 @@" } });

    // All four optional fields at once, plus an empty path (fleet_lanes.ts emits "" when rawInput had none).
    const all: LaneEvent = { type: "tool", name: "edit", detail: "d", code: { path: "", content: "c", oldText: "o", newText: "n", patch: "p" } };
    expect(laneEventToChatEvent(all)).toEqual({ type: "tool", name: "edit", detail: "d", code: { path: "", content: "c", oldText: "o", newText: "n", patch: "p" } });
  });

  it("an absent code field stays ABSENT rather than serializing as an explicit undefined", () => {
    const out = laneEventToChatEvent({ type: "tool", name: "write", detail: "a", code: { path: "/w/a", content: "x" } });
    expect(out?.type).toBe("tool");
    expect(out && out.type === "tool" && Object.keys(out.code ?? {})).toEqual(["path", "content"]);
  });

  it("the emitted code is a COPY, so later engine mutation cannot rewrite what a guest was sent", () => {
    const code = { path: "/w/a", content: "before" };
    const out = laneEventToChatEvent({ type: "tool", name: "write", detail: "a", code });
    expect(out && out.type === "tool" && out.code).not.toBe(code);
    code.content = "after";
    expect(out && out.type === "tool" && out.code?.content).toBe("before");
  });

  it("done carries NO text: an authoritative empty reply would erase the phone's streamed tokens", () => {
    const out = laneEventToChatEvent({ type: "done" });
    expect(out).toEqual({ type: "done" });
    expect(out && "text" in out).toBe(false);
    expect(Object.keys(out ?? {})).toEqual(["type"]);
  });

  it("error becomes lane-error, never block: a lane crash must not wear the security gate's clothing", () => {
    expect(laneEventToChatEvent({ type: "error", message: "child exited with 1" })).toEqual({ type: "lane-error", message: "child exited with 1" });
    expect(laneEventToChatEvent({ type: "error", message: "" })).toEqual({ type: "lane-error", message: "" });
  });

  it("drops permission, auto-approved and status: the lane CARD already reports all three", () => {
    expect(laneEventToChatEvent({ type: "permission", summary: "rm -rf", kind: "exec" })).toBeNull();
    expect(laneEventToChatEvent({ type: "auto-approved", summary: "rm -rf", mode: "auto" })).toBeNull();
    expect(laneEventToChatEvent({ type: "auto-approved", summary: "rm -rf", mode: "session" })).toBeNull();
    for (const status of ["starting", "working", "needs-approval", "awaiting-input", "done", "error", "stopped"] as const) {
      expect(laneEventToChatEvent({ type: "status", status })).toBeNull();
    }
  });

  it("drops an unrecognized type instead of guessing it into the nearest-looking chat event", () => {
    expect(laneEventToChatEvent({ type: "sandbox-request", detail: "net" } as unknown as LaneEvent)).toBeNull();
    // Looks exactly like a token but is not one. Fail-closed: shape is not permission to translate.
    expect(laneEventToChatEvent({ type: "token-v2", text: "would render as chat" } as never)).toBeNull();
    expect(laneEventToChatEvent({ type: "" } as unknown as LaneEvent)).toBeNull();
  });

  it("maps exactly the conversation variants, and no output leaks an undeclared key", () => {
    for (const { lane, mapped } of SAMPLES) {
      const out = laneEventToChatEvent(lane);
      expect(out !== null, `${lane.type} should ${mapped ? "map" : "drop"}`).toBe(mapped);
      if (out) expectNoUndeclaredKeys(out);
    }
  });
});
