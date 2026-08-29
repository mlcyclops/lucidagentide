// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/browser_control.test.ts - P-BROWSER.1 (wave 2): the agent-browser command queue + status
// store. Covers the seams the /api/browser routes and the Electron main poll loop lean on: FIFO
// enqueue/drain, result settlement in every arrival order (wait-then-complete, complete-then-wait),
// the CLEAN timeout (resolves, never rejects), the user-close kill switch, and status transitions.

import { beforeEach, describe, expect, test } from "bun:test";
import {
  completeBrowserCommand,
  drainBrowserCommands,
  enqueueBrowserCommand,
  failAllBrowserCommands,
  getBrowserStatus,
  lastBrowserActivityAt,
  latestBrowserShot,
  resetBrowserControl,
  setBrowserStatus,
  setLatestBrowserShot,
  waitBrowserResult,
} from "./browser_control.ts";

beforeEach(() => resetBrowserControl());

describe("command queue", () => {
  test("drains in enqueue order and clears atomically", () => {
    enqueueBrowserCommand({ id: "a", op: "open", url: "https://one.test" });
    enqueueBrowserCommand({ id: "b", op: "capture" });
    enqueueBrowserCommand({ id: "c", op: "scroll", dy: 800 });
    expect(drainBrowserCommands().map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect(drainBrowserCommands()).toEqual([]); // second drain finds nothing
  });

  test("input ops carry their coordinates, button, text and combo through the drain intact", () => {
    enqueueBrowserCommand({ id: "k1", op: "click", x: 412, y: 96, button: "right" });
    enqueueBrowserCommand({ id: "k2", op: "type", text: "hello world", pressEnter: true });
    enqueueBrowserCommand({ id: "k5", op: "drag", x: 10, y: 20, toX: 300, toY: 25 });
    enqueueBrowserCommand({ id: "k6", op: "keys", keys: "Control+a" });
    const [click, typed, dragged, keyed] = drainBrowserCommands();
    expect(click).toEqual({ id: "k1", op: "click", x: 412, y: 96, button: "right" });
    expect(typed).toEqual({ id: "k2", op: "type", text: "hello world", pressEnter: true });
    expect(dragged).toEqual({ id: "k5", op: "drag", x: 10, y: 20, toX: 300, toY: 25 });
    expect(keyed).toEqual({ id: "k6", op: "keys", keys: "Control+a" });
  });

  test("a click still settles through the normal result mailbox", async () => {
    enqueueBrowserCommand({ id: "k3", op: "click", x: 10, y: 20 });
    drainBrowserCommands();
    const settled = waitBrowserResult("k3", 1_000);
    completeBrowserCommand("k3", { ok: true, title: "After click", url: "https://one.test/next" });
    const r = await settled;
    expect(r.ok).toBe(true);
    expect(r.url).toBe("https://one.test/next");
  });

  test("the kill switch fails a queued type command like any other", async () => {
    enqueueBrowserCommand({ id: "k4", op: "type", text: "abc" });
    drainBrowserCommands();
    const settled = waitBrowserResult("k4", 1_000);
    failAllBrowserCommands("browser closed by user");
    const r = await settled;
    expect(r.ok).toBe(false);
    expect(r.error).toBe("browser closed by user");
  });

  test("wait registered before complete resolves with the executor's result", async () => {
    enqueueBrowserCommand({ id: "w1", op: "capture" });
    drainBrowserCommands(); // main took it
    const settled = waitBrowserResult("w1", 1_000);
    completeBrowserCommand("w1", { ok: true, png: "data:image/png;base64,AA==", title: "Page" });
    const r = await settled;
    expect(r.ok).toBe(true);
    expect(r.title).toBe("Page");
  });

  test("complete before wait parks the result for the late waiter", async () => {
    enqueueBrowserCommand({ id: "w2", op: "open", url: "https://two.test" });
    completeBrowserCommand("w2", { ok: false, error: "load failed" });
    const r = await waitBrowserResult("w2", 1_000);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("load failed");
  });

  test("times out cleanly: resolves ok:false, and a late complete never throws", async () => {
    enqueueBrowserCommand({ id: "slow", op: "capture" });
    const r = await waitBrowserResult("slow", 20);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("timed out");
    completeBrowserCommand("slow", { ok: true }); // late arrival: parked, nobody hangs
  });

  test("kill switch fails every pending waiter and drops the queue", async () => {
    enqueueBrowserCommand({ id: "k1", op: "capture" });
    enqueueBrowserCommand({ id: "k2", op: "scroll", dy: 400 });
    const w1 = waitBrowserResult("k1", 1_000);
    const w2 = waitBrowserResult("k2", 1_000);
    failAllBrowserCommands("browser closed by user");
    expect((await w1).error).toBe("browser closed by user");
    expect((await w2).error).toBe("browser closed by user");
    expect(drainBrowserCommands()).toEqual([]); // nothing left for a dead window
  });
});

describe("status store", () => {
  test("starts inactive and transitions through open -> shots -> close", () => {
    expect(getBrowserStatus()).toEqual({ active: false, title: "", url: "", startedAt: null, shots: 0 });
    setBrowserStatus({ active: true, title: "Example", url: "https://example.test", startedAt: 123, shots: 0 });
    expect(getBrowserStatus().active).toBe(true);
    setBrowserStatus({ shots: getBrowserStatus().shots + 1 }); // capture bumps only shots
    const mid = getBrowserStatus();
    expect(mid.shots).toBe(1);
    expect(mid.title).toBe("Example"); // patch merged, rest kept
    setBrowserStatus({ active: false });
    const done = getBrowserStatus();
    expect(done.active).toBe(false);
    expect(done.url).toBe("https://example.test"); // last session's label survives for the process row
  });

  test("getBrowserStatus returns a copy - mutating it never leaks into the store", () => {
    const snap = getBrowserStatus();
    snap.active = true;
    snap.shots = 99;
    expect(getBrowserStatus().active).toBe(false);
    expect(getBrowserStatus().shots).toBe(0);
  });

  test("latest shot cache set/get, and null clears it", () => {
    expect(latestBrowserShot()).toBeNull();
    setLatestBrowserShot("data:image/png;base64,QQ==");
    expect(latestBrowserShot()).toBe("data:image/png;base64,QQ==");
    setLatestBrowserShot(null);
    expect(latestBrowserShot()).toBeNull();
  });

  test("activity timestamp advances on queue and status traffic", () => {
    expect(lastBrowserActivityAt()).toBe(0);
    const before = Date.now();
    enqueueBrowserCommand({ id: "t", op: "close" });
    expect(lastBrowserActivityAt()).toBeGreaterThanOrEqual(before);
  });
});
