// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/queue_model.test.ts - P-INTERJECT.2: the staged-prompt queue's ordering rules.

import { describe, expect, test } from "bun:test";
import { addQueued, nextHold, pushRecovery, type QueuedItem } from "./queue_model.ts";

const hold = (text: string): QueuedItem => ({ text, mode: "hold" });
const push = (text: string): QueuedItem => ({ text, mode: "push" });

describe("addQueued", () => {
  test("trims and appends; the input array is never mutated", () => {
    const items: QueuedItem[] = [];
    const r = addQueued(items, "  fix the tests  ", "hold");
    expect(r.ok).toBe(true);
    expect(r.items).toEqual([hold("fix the tests")]);
    expect(items).toEqual([]); // caller's array untouched
  });

  test("refuses empty and whitespace-only text", () => {
    for (const t of ["", "   ", "\n\t"]) {
      const r = addQueued([hold("a")], t, "hold");
      expect(r.ok).toBe(false);
      expect(r.reason).toBeDefined();
      expect(r.items).toEqual([hold("a")]); // unchanged
    }
  });

  test("refuses a duplicate of the LAST item only - an earlier repeat is allowed", () => {
    const dup = addQueued([hold("a"), hold("b")], "b", "hold");
    expect(dup.ok).toBe(false);
    expect(dup.items.length).toBe(2);
    const earlier = addQueued([hold("a"), hold("b")], "a", "hold");
    expect(earlier.ok).toBe(true);
    expect(earlier.items.length).toBe(3);
  });

  test("dedupe compares the TRIMMED text", () => {
    const r = addQueued([hold("same")], "  same  ", "push");
    expect(r.ok).toBe(false);
  });

  test("enforces the cap and reports why", () => {
    let items: QueuedItem[] = [];
    for (let i = 0; i < 8; i++) items = addQueued(items, `p${i}`, "hold").items;
    expect(items.length).toBe(8);
    const over = addQueued(items, "p8", "hold");
    expect(over.ok).toBe(false);
    expect(over.reason).toContain("full");
    expect(over.items.length).toBe(8);
    // a custom cap is respected
    const tiny = addQueued([hold("x")], "y", "hold", 1);
    expect(tiny.ok).toBe(false);
  });
});

describe("nextHold", () => {
  test("returns the FIRST hold item and the queue without it, order preserved", () => {
    const items = [push("p1"), hold("h1"), hold("h2"), push("p2")];
    const r = nextHold(items);
    expect(r.item).toEqual(hold("h1"));
    expect(r.rest).toEqual([push("p1"), hold("h2"), push("p2")]);
  });

  test("hold ordering: repeated draining fires holds in staged order", () => {
    let items = [hold("first"), push("noise"), hold("second"), hold("third")];
    const fired: string[] = [];
    for (let r = nextHold(items); r.item; r = nextHold(items)) {
      fired.push(r.item.text);
      items = r.rest;
    }
    expect(fired).toEqual(["first", "second", "third"]);
    expect(items).toEqual([push("noise")]); // push records survive every drain
  });

  test("push items are NEVER returned - a push-only queue yields null and the same array", () => {
    const items = [push("a"), push("b")];
    const r = nextHold(items);
    expect(r.item).toBeNull();
    expect(r.rest).toBe(items);
  });

  test("empty queue yields null", () => {
    expect(nextHold([]).item).toBeNull();
  });
});

// ADR-0414: the old toast guessed ("the cap may be full, or the backend is unreachable") and the text was
// already gone from the composer and the stack. Each refusal now keeps the text somewhere and quotes the
// engine's reason.
describe("pushRecovery", () => {
  const idle = { draft: false, ownTurnOpen: false };
  test("the turn ended: sent as the next prompt, unless a draft or this composer's own settling stream is in the way", () => {
    expect(pushRecovery("idle", "the turn had already ended", idle).keep).toBe("send");
    expect(pushRecovery("idle", "the turn had already ended", { draft: true, ownTurnOpen: false }).keep).toBe("stage");
    expect(pushRecovery("idle", "the turn had already ended", { draft: false, ownTurnOpen: true }).keep).toBe("stage");
  });

  test("a full cap or no engine stages it for the next turn; a note needing the user goes back to the composer, never over a draft", () => {
    expect(pushRecovery("cap", "8 earlier notes are still waiting", idle).keep).toBe("stage");
    expect(pushRecovery("unreachable", "LUCID could not reach its engine", idle).keep).toBe("stage");
    expect(pushRecovery("unknown-target", "that session is no longer running", idle).keep).toBe("composer");
    expect(pushRecovery("too-long", "note too long (4001 chars; max 4000)", idle).keep).toBe("composer");
    expect(pushRecovery("too-long", "note too long (4001 chars; max 4000)", { draft: true, ownTurnOpen: false }).keep).toBe("stage");
  });

  test("the toast carries the engine's reason", () => {
    for (const code of ["idle", "cap", "unknown-target", "too-long", "unreachable"] as const) {
      expect(pushRecovery(code, "8 earlier notes are still waiting for the agent's next tool step", idle).desc).toContain("8 earlier notes are still waiting");
    }
  });
});
