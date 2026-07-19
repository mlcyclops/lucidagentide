// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/omp/block_log.test.ts
//
// P-NVIM.7: unit tests for the security gate's lock-free block mirror. Deliberately imports ONLY
// block_log.ts (never security_extension.ts) so no scanner sidecar spins up and `bun test` exits.
// Two guarantees are load-bearing here:
//   1. buildBlockRecord is a faithful, metadata-only projection of a block decision (severity floored at
//      "high", fail-closed → "scanner-unavailable", findings summarized as type×n).
//   2. mirrorBlock is env-gated (no LUCID_BLOCK_LOG → no write, so the GUI never double-writes) and
//      FAIL-SAFE (a write failure is swallowed — observability must never perturb the gate's decision).

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBlockRecord, mirrorBlock } from "./block_log.ts";

let dir: string;
let savedEnv: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "blocklog-"));
  savedEnv = process.env.LUCID_BLOCK_LOG;
  delete process.env.LUCID_BLOCK_LOG; // each test opts in explicitly
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.LUCID_BLOCK_LOG;
  else process.env.LUCID_BLOCK_LOG = savedEnv;
  rmSync(dir, { recursive: true, force: true });
});

// ── buildBlockRecord: the pure metadata projection ───────────────────────────
test("buildBlockRecord: severity is floored at high, even for a low-severity finding (a block is >= high)", () => {
  const rec = buildBlockRecord("write", { reason: "hidden-unicode", findings: [{ type: "zero-width", severity: "low" }], failClosed: false });
  expect(rec.severity).toBe("high");
  expect(rec.tool).toBe("write");
  expect(rec.reason).toBe("hidden-unicode");
  expect(rec.status).toBe("quarantined");
  expect(rec.findings).toBe("zero-width");
  expect(rec.id.length).toBeGreaterThan(0);
  expect(rec.at).toBe(new Date(rec.at).toISOString()); // round-trips as a valid ISO timestamp
});

test("buildBlockRecord: a critical finding raises severity above the high floor", () => {
  const rec = buildBlockRecord("bash", {
    reason: "bidi",
    findings: [{ type: "bidi-control", severity: "critical" }, { type: "zero-width", severity: "medium" }],
    failClosed: false,
  });
  expect(rec.severity).toBe("critical");
});

test("buildBlockRecord: findings summary counts repeats as type×n and joins distinct types", () => {
  const rec = buildBlockRecord("write", {
    reason: "r",
    findings: [{ type: "zero-width", severity: "high" }, { type: "zero-width", severity: "high" }, { type: "bidi-control", severity: "high" }],
    failClosed: false,
  });
  expect(rec.findings).toBe("zero-width×2, bidi-control");
});

test("buildBlockRecord: fail-closed → high severity + scanner-unavailable, ignoring any findings", () => {
  const rec = buildBlockRecord("bash", { reason: "scanner sidecar unavailable", findings: [{ type: "zero-width", severity: "critical" }], failClosed: true });
  expect(rec.severity).toBe("high");
  expect(rec.findings).toBe("scanner-unavailable");
});

test("buildBlockRecord: no findings and not fail-closed → the quarantined placeholder", () => {
  const rec = buildBlockRecord("write", { reason: "r", findings: [], failClosed: false });
  expect(rec.findings).toBe("quarantined");
  expect(rec.severity).toBe("high");
});

test("buildBlockRecord: each call mints a distinct id", () => {
  const a = buildBlockRecord("write", { reason: "r", findings: [], failClosed: true });
  const b = buildBlockRecord("write", { reason: "r", findings: [], failClosed: true });
  expect(a.id).not.toBe(b.id);
});

// ── mirrorBlock: env-gated, fail-safe JSONL append ───────────────────────────
test("mirrorBlock: no-op when LUCID_BLOCK_LOG is unset (so the GUI never double-writes)", () => {
  const path = join(dir, "should-not-exist.jsonl");
  mirrorBlock("write", { reason: "r", findings: [], failClosed: true }); // env deleted in beforeEach
  expect(existsSync(path)).toBe(false);
});

test("mirrorBlock: appends one JSONL record per block, creating parent dirs", () => {
  const path = join(dir, "nested", "lucid-blocks.jsonl"); // nested → exercises mkdirSync recursive
  process.env.LUCID_BLOCK_LOG = path;
  mirrorBlock("write", { reason: "hidden-unicode", findings: [{ type: "zero-width", severity: "high" }], failClosed: false });
  mirrorBlock("bash", { reason: "sidecar dead", findings: [], failClosed: true });
  expect(existsSync(path)).toBe(true);
  const lines = readFileSync(path, "utf8").trim().split("\n");
  expect(lines.length).toBe(2);
  const l0 = lines[0] ?? "";
  const l1 = lines[1] ?? "";
  expect(l0).toContain('"tool":"write"');
  expect(l0).toContain('"severity":"high"');
  expect(l0).toContain('"findings":"zero-width"');
  expect(l0).toContain('"status":"quarantined"');
  expect(l1).toContain('"tool":"bash"');
  expect(l1).toContain('"findings":"scanner-unavailable"');
});

test("mirrorBlock: a write failure is swallowed — observability never perturbs the gate", () => {
  // Point the log at a path whose PARENT is a regular file, so mkdirSync/appendFileSync throw internally.
  const asFile = join(dir, "afile");
  writeFileSync(asFile, "x");
  process.env.LUCID_BLOCK_LOG = join(asFile, "nope.jsonl");
  expect(() => mirrorBlock("write", { reason: "r", findings: [], failClosed: true })).not.toThrow();
});
