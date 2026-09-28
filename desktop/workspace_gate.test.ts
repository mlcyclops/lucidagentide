// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/workspace_gate.test.ts - P-PROGRESS.1: overlapping folders take turns in order, disjoint ones
// never wait, a cancelled waiter leaves the line, and a waiter is told whom it waits for and its place.

import { describe, expect, test } from "bun:test";
import { overlaps, WorkspaceGate, type WaitView } from "./workspace_gate.ts";

function gate(): { g: WorkspaceGate; tick: (ms: number) => void } {
  let now = 1_000_000;
  const g = new WorkspaceGate({ now: () => now, platform: "linux" });
  return { g, tick: (ms) => { now += ms; } };
}

describe("overlaps", () => {
  test("same folder, parent and child overlap; siblings and prefixes of a name do not", () => {
    expect(overlaps("/r/a", "/r/a")).toBe(true);
    expect(overlaps("/r", "/r/a/b")).toBe(true);
    expect(overlaps("/r/a/b", "/r")).toBe(true);
    expect(overlaps("/r/a", "/r/b")).toBe(false);
    expect(overlaps("/r/app", "/r/a")).toBe(false);
  });
});

describe("WorkspaceGate", () => {
  test("disjoint folders run at once", async () => {
    const { g } = gate();
    const a = await g.acquire({ id: "a", name: "A", cwd: "/w/one" });
    const b = await g.acquire({ id: "b", name: "B", cwd: "/w/two" });
    expect(g.queues()).toEqual([]);
    a(); b();
  });

  test("a second turn on the same folder waits, is told what it waits on, and runs after the release", async () => {
    const { g } = gate();
    const a = await g.acquire({ id: "a", name: "A", cwd: "/w/repo" });
    let told: WaitView | null = null;
    const bp = g.acquire({ id: "b", name: "B", cwd: "/w/repo/sub" }, { onWait: (w) => { told = w; } });
    expect(g.waitView("b")?.on.id).toBeDefined();
    expect(told!.on).toEqual({ id: "a", name: "A" });
    expect(told!.position).toBe(1);
    expect(told!.sequence.map((e) => [e.id, e.state, e.position])).toEqual([["a", "running", 0], ["b", "waiting", 1]]);
    a();
    const b = await bp;
    expect(g.sequenceFor("/w/repo").map((e) => [e.id, e.state])).toEqual([["b", "running"]]);
    b();
    expect(g.queues()).toEqual([]);
  });

  test("waiters are admitted in line order, and each is told its place", async () => {
    const { g } = gate();
    const a = await g.acquire({ id: "a", name: "A", cwd: "/w/repo" });
    const order: string[] = [];
    const bp = g.acquire({ id: "b", name: "B", cwd: "/w/repo" }).then((r) => { order.push("b"); return r; });
    const cp = g.acquire({ id: "c", name: "C", cwd: "/w/repo" }).then((r) => { order.push("c"); return r; });
    expect(g.sequenceFor("/w/repo").map((e) => [e.id, e.position])).toEqual([["a", 0], ["b", 1], ["c", 2]]);
    expect(g.waitView("c")!.position).toBe(2);
    expect(g.queues()).toHaveLength(1);
    a();
    const b = await bp;
    expect(g.waitView("c")).not.toBeNull();
    b();
    const c = await cp;
    expect(order).toEqual(["b", "c"]);
    c();
  });

  test("a waiter behind a parent-folder holder does not block a sibling folder", async () => {
    const { g } = gate();
    const a = await g.acquire({ id: "a", name: "A", cwd: "/w" });
    const bp = g.acquire({ id: "b", name: "B", cwd: "/w/x" });
    const c = await g.acquire({ id: "c", name: "C", cwd: "/other" });
    expect(g.waitView("b")?.on.id).toBeDefined();
    c(); a();
    (await bp)();
  });

  test("cancelling a waiter leaves the line and lets the one behind it run", async () => {
    const { g } = gate();
    const a = await g.acquire({ id: "a", name: "A", cwd: "/w/repo" });
    const ctl = new AbortController();
    const bp = g.acquire({ id: "b", name: "B", cwd: "/w/repo" }, { signal: ctl.signal });
    const cp = g.acquire({ id: "c", name: "C", cwd: "/w/repo" });
    ctl.abort();
    await expect(bp).rejects.toThrow(/cancelled/);
    expect(g.sequenceFor("/w/repo").map((e) => e.id)).toEqual(["a", "c"]);
    a();
    (await cp)();
    expect(g.queues()).toEqual([]);
  });

  test("a holder cannot take a second lease, and an already-aborted signal never joins", async () => {
    const { g } = gate();
    const a = await g.acquire({ id: "a", name: "A", cwd: "/w/repo" });
    await expect(g.acquire({ id: "a", name: "A", cwd: "/w/repo" })).rejects.toThrow(/already/);
    const ctl = new AbortController(); ctl.abort();
    await expect(g.acquire({ id: "b", name: "B", cwd: "/w/repo" }, { signal: ctl.signal })).rejects.toThrow(/cancelled/);
    expect(g.sequenceFor("/w/repo")).toHaveLength(1);
    a();
  });

  test("Windows folders compare case-insensitively with either separator", () => {
    const g = new WorkspaceGate({ platform: "win32" });
    expect(g.normalize("C:\\Repo\\App\\")).toBe(g.normalize("c:/repo/app"));
  });
});
