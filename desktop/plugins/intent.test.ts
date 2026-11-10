// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-PLUGINS.8 (ADR-0546): the running-intent ledger and the launch autostart, without processes or clocks. The
// runtime's own wiring (which stops forget the intent, which keep it) is driven end to end in runtime.test.ts.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUTOSTART_RETRY_DELAYS_MS, autostartPlugins, clearRunIntent, launchSelection, readRunIntents, setRunIntent,
  type AutostartDeps,
} from "./intent.ts";

let dir = "";
beforeEach(() => { dir = join(mkdtempSync(join(tmpdir(), "lplugin-intent-")), ".running-intent"); });
afterEach(() => { rmSync(join(dir, ".."), { recursive: true, force: true }); });

describe("the running-intent ledger", () => {
  test("a recorded plugin is listed until it is cleared; both are idempotent", () => {
    expect(readRunIntents(dir)).toEqual([]); // no ledger yet
    setRunIntent("remote-spokes", dir);
    setRunIntent("remote-spokes", dir);
    setRunIntent("pathfinder", dir);
    expect(readRunIntents(dir)).toEqual(["pathfinder", "remote-spokes"]);
    if (process.platform !== "win32") {
      expect(statSync(join(dir, "remote-spokes")).mode & 0o777).toBe(0o600);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
    clearRunIntent("remote-spokes", dir);
    clearRunIntent("remote-spokes", dir);
    expect(readRunIntents(dir)).toEqual(["pathfinder"]);
  });

  test("only plugin ids count: junk in the dir and invalid ids are ignored", () => {
    setRunIntent("../escape", dir);
    setRunIntent("Upper", dir);
    setRunIntent("ok-id", dir);
    writeFileSync(join(dir, ".tmp-123"), "x");
    writeFileSync(join(dir, "notes.txt"), "x");
    expect(readRunIntents(dir)).toEqual(["ok-id"]);
    clearRunIntent("../ok-id", dir); // never resolves outside the ledger
    expect(readRunIntents(dir)).toEqual(["ok-id"]);
  });
});

describe("launch selection", () => {
  test("recorded and installed starts; recorded without a package is set aside", () => {
    const installed = new Set(["remote-spokes", "pathfinder"]);
    expect(launchSelection(["gone-private", "pathfinder", "remote-spokes"], (id) => installed.has(id)))
      .toEqual({ start: ["pathfinder", "remote-spokes"], missing: ["gone-private"] });
    expect(launchSelection([], () => true)).toEqual({ start: [], missing: [] });
  });
});

/** A scripted launch: `plan[id]` lists each attempt's answer in order (true = it came up). */
function harness(plan: Record<string, boolean[]>, opts: { installed?: string[]; onSleep?: (ms: number) => void } = {}) {
  const intents = new Set(Object.keys(plan));
  const calls: string[] = [];
  const sleeps: number[] = [];
  const logs: string[] = [];
  const forgotten: string[] = [];
  const installed = new Set(opts.installed ?? Object.keys(plan));
  const deps: AutostartDeps = {
    intents: () => [...intents].sort(),
    installed: (id) => installed.has(id),
    start: async (id) => {
      calls.push(id);
      const ok = plan[id]!.shift() ?? false;
      return ok ? { ok: true } : { ok: false, error: `${id} refused` };
    },
    forget: (id) => { forgotten.push(id); intents.delete(id); },
    sleep: async (ms) => { sleeps.push(ms); opts.onSleep?.(ms); },
    log: (line) => { logs.push(line); },
  };
  return { deps, intents, calls, sleeps, logs, forgotten };
}

describe("autostart at launch", () => {
  test("each recorded plugin is started once when it comes up the first time", async () => {
    const h = harness({ "remote-spokes": [true], pathfinder: [true] });
    expect(await autostartPlugins(h.deps)).toEqual([
      { id: "pathfinder", ok: true, attempts: 1 },
      { id: "remote-spokes", ok: true, attempts: 1 },
    ]);
    expect(h.calls).toEqual(["pathfinder", "remote-spokes"]);
    expect(h.sleeps).toEqual([]);
  });

  test("a plugin that fails is retried after each delay, three attempts at most, and keeps its intent", async () => {
    expect(AUTOSTART_RETRY_DELAYS_MS.length).toBe(2);
    const h = harness({ "remote-spokes": [false, false, false, true] });
    expect(await autostartPlugins(h.deps)).toEqual([{ id: "remote-spokes", ok: false, attempts: 3, error: "remote-spokes refused" }]);
    expect(h.calls).toEqual(["remote-spokes", "remote-spokes", "remote-spokes"]);
    expect(h.sleeps).toEqual([...AUTOSTART_RETRY_DELAYS_MS]);
    expect(h.intents.has("remote-spokes")).toBe(true); // the next launch tries again
    expect(h.logs.at(-1)).toContain("did not come back after 3 attempts");
  });

  test("a retry that succeeds stops the retries", async () => {
    const h = harness({ "remote-spokes": [false, true] });
    expect(await autostartPlugins(h.deps)).toEqual([{ id: "remote-spokes", ok: true, attempts: 2 }]);
    expect(h.sleeps).toEqual([AUTOSTART_RETRY_DELAYS_MS[0]!]);
  });

  test("the bound follows the configured delays", async () => {
    const h = harness({ a: [false, false, false] });
    h.deps.retryDelaysMs = [1];
    expect(await autostartPlugins(h.deps)).toEqual([{ id: "a", ok: false, attempts: 2, error: "a refused" }]);
    expect(h.calls).toEqual(["a", "a"]);
  });

  test("one failing plugin never holds up the others: retries run in rounds", async () => {
    const h = harness({ a: [false, true], b: [true], c: [false, true] });
    await autostartPlugins(h.deps);
    expect(h.calls).toEqual(["a", "b", "c", "a", "c"]);
    expect(h.sleeps).toEqual([AUTOSTART_RETRY_DELAYS_MS[0]!]);
  });

  test("a user's Stop during the wait cancels that plugin's retry", async () => {
    const h = harness({ a: [false, true], b: [false, true] }, { onSleep: () => { h.intents.delete("a"); } });
    const out = await autostartPlugins(h.deps);
    expect(h.calls).toEqual(["a", "b", "b"]);
    expect(out).toEqual([{ id: "a", ok: false, attempts: 1, error: "a refused" }, { id: "b", ok: true, attempts: 2 }]);
  });

  test("a recorded plugin with no package (removed by a release cleanup) is skipped quietly and forgotten", async () => {
    const h = harness({ "gone-private": [true], "remote-spokes": [true] }, { installed: ["remote-spokes"] });
    expect(await autostartPlugins(h.deps)).toEqual([{ id: "remote-spokes", ok: true, attempts: 1 }]);
    expect(h.calls).toEqual(["remote-spokes"]);
    expect(h.forgotten).toEqual(["gone-private"]);
    expect(h.logs.join("\n")).not.toContain("gone-private");
  });

  test("nothing recorded starts nothing", async () => {
    const h = harness({});
    expect(await autostartPlugins(h.deps)).toEqual([]);
    expect(h.calls).toEqual([]);
  });
});
