// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// tools/blocks_cli.test.ts
//
// P-NVIM.7: tests for the read-only `lucid blocks` data CLI behind :LucidBlocks.
//   - readBlockLog is exercised with an EXPLICIT path (no env, no DuckDB) so its JSONL parsing +
//     approve/dismiss-marker replay is fully deterministic.
//   - blockList / runBlocks read the env-defaulted log AND merge the repo's agent_obs.duckdb quarantines
//     (source "db"). Those db rows are environment-dependent, so every assertion here filters to
//     source === "log" (or uses toContain) — the CLI's own rows are the contract we own.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blockList, readBlockLog, runBlocks } from "./blocks_cli.ts";

let dir: string;
let savedEnv: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "blockscli-"));
  savedEnv = process.env.LUCID_BLOCK_LOG;
  delete process.env.LUCID_BLOCK_LOG;
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.LUCID_BLOCK_LOG;
  else process.env.LUCID_BLOCK_LOG = savedEnv;
  rmSync(dir, { recursive: true, force: true });
});

function writeLog(name: string, lines: string[]): string {
  const p = join(dir, name);
  writeFileSync(p, lines.join("\n") + "\n");
  return p;
}

// ── readBlockLog: deterministic JSONL parsing (explicit path, no db) ──────────
test("readBlockLog: a missing file → [] (no log yet is not an error)", () => {
  expect(readBlockLog(join(dir, "absent.jsonl"))).toEqual([]);
});

test("readBlockLog: parses records, tags source=log, skips blank/corrupt/non-object/id-less lines", () => {
  const p = writeLog("log.jsonl", [
    JSON.stringify({ id: "b1", tool: "bash", severity: "high", findings: "zero-width×2", reason: "hidden-unicode", at: "2026-07-19T00:00:00Z", status: "quarantined" }),
    "",
    "this is not json{",
    JSON.stringify([1, 2, 3]),
    JSON.stringify({ tool: "no-id" }),
    JSON.stringify({ id: "b2", tool: "write", severity: "critical", findings: "bidi-control", reason: "bidi", at: "2026-07-19T00:01:00Z", status: "quarantined" }),
  ]);
  const rows = readBlockLog(p);
  expect(rows.length).toBe(2);
  const b1 = rows.find((r) => r.id === "b1");
  expect(b1?.tool).toBe("bash");
  expect(b1?.findings).toBe("zero-width×2");
  expect(b1?.status).toBe("quarantined");
  expect(b1?.source).toBe("log");
  expect(rows.find((r) => r.id === "b2")?.severity).toBe("critical");
});

test("readBlockLog: an _approval marker flips its row to approved; _dismiss to dismissed; unknown ids ignored", () => {
  const p = writeLog("markers.jsonl", [
    JSON.stringify({ id: "a", tool: "bash", status: "quarantined" }),
    JSON.stringify({ id: "b", tool: "write", status: "quarantined" }),
    JSON.stringify({ id: "a", _approval: true }),
    JSON.stringify({ id: "b", _dismiss: true }),
    JSON.stringify({ id: "ghost", _dismiss: true }), // marker for an unknown id → no-op, no crash
  ]);
  const rows = readBlockLog(p);
  expect(rows.length).toBe(2);
  expect(rows.find((r) => r.id === "a")?.status).toBe("approved");
  expect(rows.find((r) => r.id === "b")?.status).toBe("dismissed");
});

test("readBlockLog: absent fields fall back to defaults (tool→tool, status→quarantined)", () => {
  const p = writeLog("defaults.jsonl", [JSON.stringify({ id: "d1" })]);
  const rows = readBlockLog(p);
  expect(rows.length).toBe(1);
  const d = rows[0];
  expect(d?.tool).toBe("tool");
  expect(d?.status).toBe("quarantined");
  expect(d?.severity).toBe("");
  expect(d?.source).toBe("log");
});

test("readBlockLog: a later record for the same id wins (last-write-wins by id)", () => {
  const p = writeLog("dup.jsonl", [
    JSON.stringify({ id: "x", tool: "bash", reason: "first" }),
    JSON.stringify({ id: "x", tool: "write", reason: "second" }),
  ]);
  const rows = readBlockLog(p);
  expect(rows.length).toBe(1);
  expect(rows[0]?.tool).toBe("write");
  expect(rows[0]?.reason).toBe("second");
});

// ── blockList / runBlocks: env-defaulted log merged with the db (filter source=log) ──
test("blockList: default lists only quarantined log rows; --all includes reviewed rows", async () => {
  const p = join(dir, "lucid-blocks.jsonl");
  writeFileSync(
    p,
    [
      JSON.stringify({ id: "q1", tool: "bash", status: "quarantined", reason: "r1" }),
      JSON.stringify({ id: "ap1", tool: "write", status: "quarantined", reason: "r2" }),
      JSON.stringify({ id: "ap1", _approval: true }),
    ].join("\n") + "\n",
  );
  process.env.LUCID_BLOCK_LOG = p;

  const active = (await blockList()).filter((b) => b.source === "log");
  expect(active.map((b) => b.id).sort()).toEqual(["q1"]);

  const all = (await blockList({ all: true })).filter((b) => b.source === "log");
  expect(all.map((b) => b.id).sort()).toEqual(["ap1", "q1"]);
  expect(all.find((b) => b.id === "ap1")?.status).toBe("approved");
});

test("runBlocks --json: emits a JSON array carrying the live-session log row; exit code 0", async () => {
  const p = join(dir, "lucid-blocks.jsonl");
  writeFileSync(p, JSON.stringify({ id: "j1", tool: "bash", severity: "high", findings: "zero-width×2", reason: "hidden-unicode", status: "quarantined" }) + "\n");
  process.env.LUCID_BLOCK_LOG = p;
  const { code, out } = await runBlocks(["--json"]);
  expect(code).toBe(0);
  expect(out).toContain('"id":"j1"');
  expect(out).toContain('"tool":"bash"');
  expect(out).toContain('"source":"log"');
  let parsed: unknown;
  expect(() => { parsed = JSON.parse(out); }).not.toThrow();
  expect(Array.isArray(parsed)).toBe(true);
});

test("runBlocks (human): renders the block with its reason and tool; not JSON", async () => {
  const p = join(dir, "lucid-blocks.jsonl");
  writeFileSync(p, JSON.stringify({ id: "h1", tool: "bash", severity: "high", findings: "zero-width×2", reason: "hidden-unicode", status: "quarantined" }) + "\n");
  process.env.LUCID_BLOCK_LOG = p;
  const { code, out } = await runBlocks([]);
  expect(code).toBe(0);
  expect(out).toContain("hidden-unicode");
  expect(out).toContain("bash");
  expect(out).not.toContain('"source"'); // human output, never JSON
});
