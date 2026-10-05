// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordAiLoc } from "./ailoc_log.ts";
import { aggregateAiLoc, readAiLocSamples } from "./ailoc_read.ts";

const dirs: string[] = [];
function log(): string { const d = mkdtempSync(join(tmpdir(), "ailoc-")); dirs.push(d); return join(d, "lucid-ailoc.jsonl"); }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const attribution = { model: "m", identity: "i", identitySource: "email", repo: "r" };

describe("recordAiLoc and the lock-free dashboard ledger", () => {
  test("persists explicit successful mutation counts; zero counts append nothing", () => {
    const p = log();
    recordAiLoc({ ...attribution, tool: "edit", added: 7, removed: 3 }, { logPath: p });
    expect(recordAiLoc({ ...attribution, tool: "edit", added: 0, removed: 0 }, { logPath: p })).toBeNull();
    const samples = readAiLocSamples(p);
    expect(samples.map(({ added, removed, model }) => ({ added, removed, model }))).toEqual([{ added: 7, removed: 3, model: "m" }]);
  });
  test("empty logs and blank attribution remain honest", () => {
    const p = log();
    expect(readAiLocSamples(p)).toEqual([]);
    recordAiLoc({ model: "", identity: "", identitySource: "", repo: "", tool: "write", added: 1, removed: 0 }, { logPath: p });
    const s = readAiLocSamples(p)[0]!;
    expect([s.model, s.identity, s.identitySource]).toEqual(["unknown", "unknown", "unknown"]);
  });
  test("invalid counts cannot corrupt dashboard totals", () => {
    const p = log();
    for (const added of [-1, NaN, Infinity, 0.5]) {
      expect(recordAiLoc({ ...attribution, tool: "edit", added, removed: 0 }, { logPath: p })).toBeNull();
    }
    expect(readAiLocSamples(p)).toEqual([]);
  });
  test("roll-up sums counts by model, repo, and identity", () => {
    const p = log();
    recordAiLoc({ ...attribution, model: "opus", repo: "/lucid", tool: "write", added: 3, removed: 0 }, { logPath: p });
    recordAiLoc({ ...attribution, model: "opus", repo: "/lucid", tool: "edit", added: 1, removed: 0 }, { logPath: p });
    recordAiLoc({ ...attribution, model: "gpt", repo: "/lucid", tool: "edit", added: 1, removed: 1 }, { logPath: p });
    const agg = aggregateAiLoc(readAiLocSamples(p), "2026-07-13T00:00:00Z")!;
    expect(agg.totals).toEqual({ added: 5, removed: 1, edits: 3, models: 2, repos: 1 });
    expect(agg.identities).toEqual(["i"]);
    expect(agg.byModel.find((m) => m.model === "opus")).toEqual({ model: "opus", added: 4, removed: 0, edits: 2 });
    expect(agg.byModel.find((m) => m.model === "gpt")!.removed).toBe(1);
    expect(aggregateAiLoc([], "2026-07-13T00:00:00Z")).toBeNull();
  });
});
