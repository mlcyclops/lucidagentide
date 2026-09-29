// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/write_claims.test.ts - P-WAIT.1: workers in one folder never wait for each other unless they
// write the SAME file; then the second waits for the first one's turn to end, is told whom it waits for,
// gives up with a named refusal when the bound runs out, and never deadlocks.

import { describe, expect, test } from "bun:test";
import { WriteClaims, writeRefusal, type WaitView } from "./write_claims.ts";

const MAIN = { id: "master", name: "Main" };
const ALPHA = { id: "lane-a", name: "alpha" };
const BETA = { id: "lane-b", name: "beta" };
const ROOT = "/w/repo";

describe("WriteClaims", () => {
  test("two workers in one folder writing DIFFERENT files never wait", async () => {
    const c = new WriteClaims({ platform: "linux" });
    expect(await c.acquire(MAIN, ["src/a.ts"], ROOT, { waitMs: 5_000 })).toEqual({ held: false });
    const told: (WaitView | null)[] = [];
    expect(await c.acquire(ALPHA, ["src/b.ts", "docs/x.md"], ROOT, { waitMs: 5_000, onWait: (w) => told.push(w) })).toEqual({ held: false });
    expect(told).toEqual([]);
  });

  test("a write to a file another turn holds waits, is told whom and which file, and runs when that turn ends", async () => {
    const c = new WriteClaims({ platform: "linux" });
    await c.acquire(MAIN, ["src/a.ts"], ROOT, { waitMs: 0 });
    const told: (WaitView | null)[] = [];
    // acquire runs synchronously up to its first await, so the wait is registered (and told) on return.
    const pending = c.acquire(ALPHA, [`${ROOT}/src/a.ts`], "/elsewhere", { waitMs: 5_000, onWait: (w) => told.push(w) });
    expect(told).toEqual([{ on: MAIN, file: "a.ts" }]);
    c.endTurn("master");
    expect(await pending).toEqual({ held: false });
    expect(told).toEqual([{ on: MAIN, file: "a.ts" }, null]);
    // alpha now holds it: Main's next turn is the one that waits.
    const back = await c.acquire(MAIN, ["src/a.ts"], ROOT, { waitMs: 0 });
    expect(back).toEqual({ held: true, on: ALPHA, file: "a.ts", why: "busy" });
  });

  test("the same session re-writing its own file never waits", async () => {
    const c = new WriteClaims({ platform: "linux" });
    await c.acquire(ALPHA, ["a.ts"], ROOT, { waitMs: 0 });
    expect(await c.acquire(ALPHA, ["a.ts"], ROOT, { waitMs: 0 })).toEqual({ held: false });
  });

  test("still held when the bound runs out: a busy refusal that names the holder and its session id", async () => {
    const c = new WriteClaims({ platform: "linux" });
    await c.acquire(MAIN, ["a.ts"], ROOT, { waitMs: 0 });
    const v = await c.acquire(BETA, ["a.ts"], ROOT, { waitMs: 0 });
    expect(v).toEqual({ held: true, on: MAIN, file: "a.ts", why: "busy" });
    if (!v.held) throw new Error("unreachable");
    const text = writeRefusal(v, 20_000);
    expect(text).toContain("waited 20 s");
    expect(text).toContain("\"Main\" (session id \"master\")");
    expect(text).toContain("checkin_send");
    expect(text).not.toMatch(/[\u2013\u2014]/);
  });

  test("a multi-file write claims nothing while it waits, then claims every file at once", async () => {
    const c = new WriteClaims({ platform: "linux" });
    await c.acquire(MAIN, ["b.ts"], ROOT, { waitMs: 0 });
    const pending = c.acquire(ALPHA, ["a.ts", "b.ts"], ROOT, { waitMs: 5_000 });
    expect(await c.acquire(BETA, ["a.ts"], ROOT, { waitMs: 0 })).toEqual({ held: false }); // a waiting alpha holds no a.ts
    c.endTurn(BETA.id);
    c.endTurn("master");
    expect(await pending).toEqual({ held: false });
    expect(await c.acquire(BETA, ["a.ts"], ROOT, { waitMs: 0 })).toMatchObject({ held: true, on: ALPHA });
  });

  test("two sessions waiting on each other's files: the second is refused at once as a deadlock", async () => {
    const c = new WriteClaims({ platform: "linux" });
    await c.acquire(ALPHA, ["a.ts"], ROOT, { waitMs: 0 });
    await c.acquire(BETA, ["b.ts"], ROOT, { waitMs: 0 });
    const alphaWaits = c.acquire(ALPHA, ["b.ts"], ROOT, { waitMs: 5_000 });
    // Beta's own bound is long: only the deadlock check can answer before alpha's turn ends.
    const v = await c.acquire(BETA, ["a.ts"], ROOT, { waitMs: 5_000 });
    expect(v).toEqual({ held: true, on: ALPHA, file: "a.ts", why: "deadlock" });
    c.endTurn(BETA.id); // beta gives up its turn: alpha gets b.ts
    expect(await alphaWaits).toEqual({ held: false });
  });

  test("the waiter's own turn ending (Stop) ends its wait at once", async () => {
    const c = new WriteClaims({ platform: "linux" });
    await c.acquire(MAIN, ["a.ts"], ROOT, { waitMs: 0 });
    const pending = c.acquire(ALPHA, ["a.ts"], ROOT, { waitMs: 5_000 });
    c.endTurn(ALPHA.id);
    expect(await pending).toEqual({ held: true, on: MAIN, file: "a.ts", why: "ended" });
    expect(await c.acquire(BETA, ["a.ts"], ROOT, { waitMs: 0 })).toMatchObject({ held: true, on: MAIN }); // Main still holds it
  });

  test("a claim whose holder is no longer running (its turn ended without endTurn) never makes anyone wait", async () => {
    const c = new WriteClaims({ platform: "linux" });
    const running = new Set(["master"]);
    c.isRunning = (id) => running.has(id);
    await c.acquire(MAIN, ["a.ts"], ROOT, { waitMs: 0 });
    expect(await c.acquire(ALPHA, ["a.ts"], ROOT, { waitMs: 0 })).toMatchObject({ held: true, on: MAIN });
    running.delete("master");
    expect(await c.acquire(ALPHA, ["a.ts"], ROOT, { waitMs: 0 })).toEqual({ held: false });
  });

  test("Windows paths compare case-insensitively with either separator", async () => {
    const c = new WriteClaims({ platform: "win32" });
    await c.acquire(MAIN, ["C:\\Repo\\Src\\A.ts"], "C:\\Repo", { waitMs: 0 });
    expect(await c.acquire(ALPHA, ["src/a.ts"], "c:/repo", { waitMs: 0 })).toMatchObject({ held: true, on: MAIN });
  });
});
