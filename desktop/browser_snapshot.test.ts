// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/browser_snapshot.test.ts - P-JEV.4 (ADR-0379): the page-side scripts of the Jev browser
// policy, tested WITHOUT a DOM. What can break here without a browser: a script that no longer parses
// as one JS expression (main evaluates each as `code`), a page label that escapes its literal and
// becomes code, a freshness reference that compares the wrong keys, and runtime narrowing that lets an
// off-shape action or page through. Behaviour inside a live page is covered by the smoke run, not here.

import { describe, expect, test } from "bun:test";
import {
  MARKER_JS,
  SNAPSHOT_JS,
  freshnessJs,
  freshnessOf,
  isBrowserAction,
  isBrowserPageShape,
  settleJs,
  targetJs,
  type BrowserAction,
  type BrowserPage,
} from "./browser_snapshot.ts";

/** Throws when `code` is not a single, syntactically valid JS expression - exactly how main uses it. */
const parses = (code: string): void => { new Function(`return (${code})`); };

// Every character class that can break out of a string literal inside a template-built script.
const HOSTILE = `she said "hi" and 'bye' \`tick\` </script><script>alert(1)</script> \u2028\u2029 \\ \${x}`;
const hostile: BrowserAction = { id: "e1", kind: "fill", label: HOSTILE, node: 7, value: HOSTILE, role: HOSTILE };

const page: BrowserPage = {
  url: "https://one.test/", title: "One", w: 1180, h: 800, text: "hello", scroll: { y: 0, height: 2000 },
  actions: [], marker: ["m", 1], page_key: ["k", 2], guards: { "7": { tag: "BUTTON" }, "9": null },
  omitted_actions: 0, fingerprint: "abc",
};

describe("page scripts are single JS expressions", () => {
  test("the fixed scripts parse", () => {
    expect(() => parses(SNAPSHOT_JS)).not.toThrow();
    expect(() => parses(MARKER_JS)).not.toThrow();
    expect(() => parses(freshnessJs(null))).not.toThrow();
  });

  test("action-built scripts parse for every kind", () => {
    const kinds: BrowserAction[] = [
      { id: "e1", kind: "click", label: "Go", node: 1 },
      { id: "e2", kind: "fill", label: "Search", node: 2, value: "" },
      { id: "e3", kind: "select", label: "Country", node: 3, value: "CH" },
      { id: "scroll_down", kind: "scroll", label: "Scroll down", delta: 560 },
      { id: "wait", kind: "wait", label: "Wait" },
    ];
    for (const a of kinds) {
      expect(() => parses(freshnessJs(a))).not.toThrow();
      expect(() => parses(targetJs(a))).not.toThrow();
      expect(() => parses(settleJs(a))).not.toThrow();
    }
  });

  test("a hostile label/value cannot break out of its literal", () => {
    for (const code of [freshnessJs(hostile), targetJs(hostile), settleJs(hostile), freshnessJs({ ...hostile, kind: "select" })]) {
      expect(() => parses(code)).not.toThrow();
      // The raw line terminators must never reach the page source; JSON keeps everything else quoted.
      expect(code).not.toContain("\u2028");
      expect(code).not.toContain("\u2029");
    }
    // The embedded value round-trips: the script's argument literal is JSON, so the page gets the exact
    // string back (a select compares `o.value === action.value` against it).
    const fn = new Function(`return (${targetJs({ ...hostile, kind: "select" })
      .replace(/^\(\(action\) => \{[\s\S]*\}\)\(/, "((action) => action)(")})`);
    expect(fn()).toEqual({ node: 7, kind: "select", value: HOSTILE });
  });
});

describe("freshnessOf", () => {
  test("click and select take the scoped page_key + the target's guard", () => {
    expect(freshnessOf(page, { id: "e1", kind: "click", label: "Go", node: 7 })).toEqual({ page_key: ["k", 2], guard: { tag: "BUTTON" } });
    expect(freshnessOf(page, { id: "e2", kind: "select", label: "C", node: 7, value: "x" })).toEqual({ page_key: ["k", 2], guard: { tag: "BUTTON" } });
  });

  test("a node without a recorded guard yields null, never undefined (JSON-comparable)", () => {
    expect(freshnessOf(page, { id: "e1", kind: "click", label: "Go", node: 42 })).toEqual({ page_key: ["k", 2], guard: null });
  });

  test("fill, scroll and wait take the full marker", () => {
    expect(freshnessOf(page, { id: "e2", kind: "fill", label: "S", node: 7 })).toEqual({ marker: ["m", 1] });
    expect(freshnessOf(page, { id: "scroll_down", kind: "scroll", label: "Down", delta: 560 })).toEqual({ marker: ["m", 1] });
    expect(freshnessOf(page, { id: "wait", kind: "wait", label: "Wait" })).toEqual({ marker: ["m", 1] });
  });

  test("the scoped probe and the scoped reference agree on when to scope", () => {
    // freshnessJs must probe [page_key, guard] exactly when freshnessOf recorded them, or act would
    // compare a marker against a pair and refuse every decision.
    const click: BrowserAction = { id: "e1", kind: "click", label: "Go", node: 7 };
    const fill: BrowserAction = { id: "e2", kind: "fill", label: "S", node: 7 };
    expect(freshnessJs(click)).not.toBe(MARKER_JS);
    expect(freshnessJs(click)).toContain("pageKey()");
    expect(freshnessJs(fill)).toBe(MARKER_JS);
    expect("marker" in freshnessOf(page, click)).toBe(false);
    expect("marker" in freshnessOf(page, fill)).toBe(true);
  });
});

describe("isBrowserAction", () => {
  test("accepts each valid kind", () => {
    expect(isBrowserAction({ id: "e1", kind: "click", label: "Go", node: 1 })).toBe(true);
    expect(isBrowserAction({ id: "e2", kind: "fill", label: "Search", node: 0 })).toBe(true);
    expect(isBrowserAction({ id: "e3", kind: "select", label: "Country", node: 3, value: "CH" })).toBe(true);
    expect(isBrowserAction({ id: "scroll_up", kind: "scroll", label: "Up", delta: -560 })).toBe(true);
    expect(isBrowserAction({ id: "wait", kind: "wait", label: "Wait" })).toBe(true);
  });

  test("rejects a click without an integer node", () => {
    expect(isBrowserAction({ id: "e1", kind: "click", label: "Go" })).toBe(false);
    expect(isBrowserAction({ id: "e1", kind: "click", label: "Go", node: 1.5 })).toBe(false);
    expect(isBrowserAction({ id: "e1", kind: "click", label: "Go", node: "1" })).toBe(false);
  });

  test("rejects a scroll without a delta, an unknown kind, and non-objects", () => {
    expect(isBrowserAction({ id: "scroll_down", kind: "scroll", label: "Down" })).toBe(false);
    expect(isBrowserAction({ id: "x", kind: "navigate", label: "Go", node: 1 })).toBe(false);
    expect(isBrowserAction({ id: "x", kind: "click", node: 1 })).toBe(false);
    expect(isBrowserAction(null)).toBe(false);
    expect(isBrowserAction("click")).toBe(false);
  });
});

describe("isBrowserPageShape", () => {
  const { fingerprint: _fp, ...bare } = page;

  test("accepts what SNAPSHOT_JS returns (no fingerprint yet)", () => {
    expect(isBrowserPageShape(bare)).toBe(true);
  });

  test("rejects a page missing guards or marker, and a null result", () => {
    const { guards: _g, ...noGuards } = bare;
    const { marker: _m, ...noMarker } = bare;
    expect(isBrowserPageShape(noGuards)).toBe(false);
    expect(isBrowserPageShape(noMarker)).toBe(false);
    expect(isBrowserPageShape({ ...bare, guards: null })).toBe(false);
    expect(isBrowserPageShape(null)).toBe(false);
  });
});
