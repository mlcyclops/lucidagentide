// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-LOC.4 (ADR-0211): the GUI-owned AI-LOC ledger — the lock-free mirror that fixes "AI-authored lines are
// in the DB but never show in the UI". The gate holds agent_obs.duckdb read-write for the whole session, so
// the desktop's READ_ONLY DuckDB read always lock-failed → null → "none yet". These tests prove the JSONL
// write→read→aggregate path works with NO DuckDB (so no lock), and that line counting matches the chat chip.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countCode, recordAiLoc } from "./ailoc_log.ts";
import { aggregateAiLoc, readAiLocSamples } from "./ailoc_read.ts";

const dirs: string[] = [];
function log(): string { const d = mkdtempSync(join(tmpdir(), "ailoc-")); dirs.push(d); return join(d, "lucid-ailoc.jsonl"); }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("countCode (one diffstat convention with the chat chip)", () => {
  test("a write counts every content line as added, none removed", () => {
    expect(countCode({ content: "a\nb\nc\n" })).toEqual({ added: 3, removed: 0 });
    expect(countCode({ content: "solo" })).toEqual({ added: 1, removed: 0 });
    expect(countCode({ content: "" })).toEqual({ added: 0, removed: 0 });
  });
  test("an old→new edit counts the line diff (LCS), not the whole file", () => {
    expect(countCode({ oldText: "a\nb\nc\n", newText: "a\nB\nc\nd\n" })).toEqual({ added: 2, removed: 1 }); // B replaces b (+1/-1), d added (+1)
  });
  test("a hashline patch counts +/- content lines (headers/anchors ignored)", () => {
    expect(countCode({ patch: "[c.ts#h]\nKEEP\n+new1\n+new2\n-old1\n" })).toEqual({ added: 2, removed: 1 });
  });
  test("no authored code → nothing countable", () => {
    expect(countCode({})).toEqual({ added: 0, removed: 0 });
  });
});

describe("recordAiLoc → readAiLocSamples (the lock-free ledger)", () => {
  test("appends one sample per countable edit; a zero-line edit is a no-op", () => {
    const p = log();
    expect(recordAiLoc({ model: "m", identity: "i", identitySource: "email", repo: "r", tool: "write", code: { content: "x\ny\n" } }, { logPath: p })).not.toBeNull();
    expect(recordAiLoc({ model: "m", identity: "i", identitySource: "email", repo: "r", tool: "read", code: {} }, { logPath: p })).toBeNull(); // 0 lines → skipped
    const samples = readAiLocSamples(p);
    expect(samples).toHaveLength(1);
    expect(samples[0]!.added).toBe(2);
    expect(samples[0]!.model).toBe("m");
  });
  test("an empty/absent log reads as []", () => {
    expect(readAiLocSamples(join(tmpdir(), "does-not-exist-ailoc.jsonl"))).toEqual([]);
    expect(existsSync(join(tmpdir(), "does-not-exist-ailoc.jsonl"))).toBe(false);
  });
  test("model/identity fall back to 'unknown' when blank (never lost)", () => {
    const p = log();
    recordAiLoc({ model: "", identity: "", identitySource: "", repo: "", tool: "edit", code: { content: "a\n" } }, { logPath: p });
    const s = readAiLocSamples(p)[0]!;
    expect(s.model).toBe("unknown");
    expect(s.identity).toBe("unknown");
  });
});

describe("aggregateAiLoc (the dashboard roll-up)", () => {
  test("sums per-model + per-(model,repo,identity), counts distinct models/repos/identities", () => {
    const p = log();
    recordAiLoc({ model: "opus", identity: "nick", identitySource: "email", repo: "/lucid", tool: "write", code: { content: "1\n2\n3\n" } }, { logPath: p });
    recordAiLoc({ model: "opus", identity: "nick", identitySource: "email", repo: "/lucid", tool: "edit", code: { oldText: "a\n", newText: "a\nb\n" } }, { logPath: p });
    recordAiLoc({ model: "gpt", identity: "nick", identitySource: "email", repo: "/lucid", tool: "edit", code: { patch: "+x\n-y\n" } }, { logPath: p });
    const agg = aggregateAiLoc(readAiLocSamples(p), "2026-07-13T00:00:00Z")!;
    expect(agg.totals).toEqual({ added: 3 + 1 + 1, removed: 0 + 0 + 1, edits: 3, models: 2, repos: 1 });
    expect(agg.identities).toEqual(["nick"]);
    expect(agg.byModel[0]!.model).toBe("opus"); // most added first
    expect(agg.byModel.find((m) => m.model === "gpt")!.removed).toBe(1);
  });
  test("no samples → null (panel shows its explicit empty state)", () => {
    expect(aggregateAiLoc([], "2026-07-13T00:00:00Z")).toBeNull();
  });
});
