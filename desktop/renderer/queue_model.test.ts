// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/queue_model.test.ts - P-INTERJECT.2: the staged-prompt queue's ordering rules.

import { describe, expect, test } from "bun:test";
import { addQueued, nextHold, type QueuedItem } from "./queue_model.ts";

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

describe("addQueued with guest extra (P-REMOTE.15)", () => {
  const img = "data:image/png;base64,AAAA";

  test("carries from and images through onto the staged item", () => {
    const r = addQueued([], "  look at this  ", "hold", 8, { from: "Ana (phone)", images: [img] });
    expect(r.ok).toBe(true);
    expect(r.items).toEqual([{ text: "look at this", mode: "hold", from: "Ana (phone)", images: [img] }]);
  });

  test("from alone rides without an images key", () => {
    const r = addQueued([], "hi", "hold", 8, { from: "Ana" });
    expect(r.ok).toBe(true);
    expect(r.items[0]).toEqual({ text: "hi", mode: "hold", from: "Ana" });
    expect("images" in r.items[0]!).toBe(false);
  });

  test("an image-only prompt (empty text) is stageable; text stays empty", () => {
    const r = addQueued([], "   ", "hold", 8, { from: "Ana", images: [img] });
    expect(r.ok).toBe(true);
    expect(r.items[0]!.text).toBe("");
    expect(r.items[0]!.images).toEqual([img]);
  });

  test("two image-only prompts in a row both stage - empty texts are not a duplicate", () => {
    const first = addQueued([], "", "hold", 8, { from: "Ana", images: [img] });
    const second = addQueued(first.items, "", "hold", 8, { from: "Ana", images: [img] });
    expect(second.ok).toBe(true);
    expect(second.items.length).toBe(2);
  });

  test("empty text WITHOUT images is still refused, even with a from", () => {
    const r = addQueued([], "  ", "hold", 8, { from: "Ana" });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("empty prompt");
  });

  test("dup-of-last still refuses matching nonempty text even when images differ", () => {
    const first = addQueued([], "same", "hold", 8, { from: "Ana", images: [img] });
    const retry = addQueued(first.items, "same", "hold", 8, { from: "Ana", images: ["data:image/png;base64,BBBB"] });
    expect(retry.ok).toBe(false);
  });

  test("cap still refuses, extra or not", () => {
    let items: QueuedItem[] = [];
    for (let i = 0; i < 8; i++) items = addQueued(items, `p${i}`, "hold").items;
    const over = addQueued(items, "", "hold", 8, { from: "Ana", images: [img] });
    expect(over.ok).toBe(false);
    expect(over.reason).toContain("full");
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
