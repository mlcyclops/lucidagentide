// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/turn_pending.test.ts - P-STALL.2 (ADR-0263): the pending-call tracker behind the
// { type:"slow" } visibility. Load-bearing: a spawned subagent task is labeled as one, a terminal
// update closes exactly its call, and the snapshot is longest-running-first and capped.

import { describe, expect, test } from "bun:test";
import { type PendingCall, parseTaskCall, pendingLabel, pendingSnapshot, settleToolCall, trackToolCall } from "./turn_pending.ts";

describe("pendingLabel", () => {
  test("a task tool_call is labeled as a subagent, with its agents and the batch size", () => {
    expect(pendingLabel({ title: "Map the callers", rawInput: { agent: "scout", task: "x" } })).toBe("subagent scout: Map the callers");
    expect(pendingLabel({ rawInput: { context: "c", tasks: [{ agent: "scout", task: "a" }, { task: "b" }, { agent: "scout", task: "c" }] } })).toBe("subagent scout+task ×3");
  });
  test("a plain tool uses kind + title, deduped and capped", () => {
    expect(pendingLabel({ kind: "execute", title: "cargo build" })).toBe("execute: cargo build");
    expect(pendingLabel({ kind: "read", title: "read" })).toBe("read"); // title == kind -> no stutter
    expect(pendingLabel({})).toBe("tool");
    expect(pendingLabel({ kind: "execute", title: "x".repeat(200) }).length).toBeLessThanOrEqual(80);
  });
});

describe("parseTaskCall (P-TASK.6, omp 18's task input)", () => {
  test("a batch reads each item's own agent (default task), name and task", () => {
    expect(parseTaskCall({ context: "c", tasks: [{ name: "Scout", agent: "scout", task: "map it" }, { task: "fix it" }] })).toEqual([
      { agent: "scout", name: "Scout", task: "map it" },
      { agent: "task", name: "", task: "fix it" },
    ]);
  });
  test("the single form is a task call with or without its agent, but a todo op never is", () => {
    expect(parseTaskCall({ agent: "scout", task: "t" })).toEqual([{ agent: "scout", name: "", task: "t" }]);
    expect(parseTaskCall({ name: "N", task: "t" })).toEqual([{ agent: "task", name: "N", task: "t" }]);
    expect(parseTaskCall({ op: "done", task: "Ship it" })).toBeNull();
    expect(parseTaskCall({ path: "a.ts" })).toBeNull();
    expect(parseTaskCall({ tasks: [{ agent: "x" }] })).toBeNull(); // no task text: not a delegation
  });
});

describe("track / settle lifecycle", () => {
  test("open on tool_call, still open on progress, closed on terminal - and only that call", () => {
    const open = new Map<string, PendingCall>();
    trackToolCall(open, { toolCallId: "a", kind: "execute", title: "build" }, 1000);
    trackToolCall(open, { toolCallId: "b", rawInput: { agent: "scout", task: "x" } }, 2000);
    expect(open.size).toBe(2);
    settleToolCall(open, { toolCallId: "a", status: "in_progress" });
    expect(open.size).toBe(2); // progress keeps it open
    settleToolCall(open, { toolCallId: "a", status: "completed" });
    expect(open.size).toBe(1);
    expect(open.has("b")).toBe(true);
    settleToolCall(open, { toolCallId: "b", status: "failed" }); // failure is terminal too
    expect(open.size).toBe(0);
  });
  test("no id, or born-terminal, is never tracked; unknown-id settle is a no-op", () => {
    const open = new Map<string, PendingCall>();
    trackToolCall(open, { kind: "read" }, 0);
    trackToolCall(open, { toolCallId: "x", status: "completed", kind: "read" }, 0);
    expect(open.size).toBe(0);
    settleToolCall(open, { toolCallId: "ghost", status: "completed" }); // must not throw
  });
});

describe("pendingSnapshot", () => {
  test("longest-running first, elapsed computed, capped", () => {
    const open = new Map<string, PendingCall>();
    open.set("new", { label: "read: a", startedAt: 9_000 });
    open.set("old", { label: "subagent explore", startedAt: 1_000 });
    const snap = pendingSnapshot(open, 10_000);
    expect(snap.map((s) => s.label)).toEqual(["subagent explore", "read: a"]);
    expect(snap[0]!.elapsedMs).toBe(9_000);
    expect(pendingSnapshot(open, 10_000, 1)).toHaveLength(1);
  });
});
