// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Increment P-LOC.4 — AI-authored lines reach the UI again (ADR-0211). The bug: AI-LOC was recorded ONLY into
// agent_obs.duckdb by the security gate, which holds that DuckDB read-write for the whole omp session. DuckDB
// is single-writer — a second process opening it (even READ_ONLY) is refused with a lock conflict — so the
// desktop's `aiLocSummary()` always lock-failed → null → the "AI-authored code" panel showed "none yet" even
// though the rows were in the DB. Fix (mirrors turns/security/latency logs): the desktop appends every edit to
// a GUI-owned JSONL ledger it CAN read live; the dashboard aggregates that. This demo proves the pure core.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordAiLoc, countCode } from "../ailoc_log.ts";
import { readAiLocSamples, aggregateAiLoc } from "../ailoc_read.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) { console.error("  ✗ " + msg); process.exit(1); }
  console.log("  ✓ " + msg);
}

const dir = mkdtempSync(join(tmpdir(), "ailoc-demo-"));
const LOG = join(dir, "lucid-ailoc.jsonl");

console.log("== #ADR-0211 P-LOC.4: AI-authored lines flow to the UI via a lock-free GUI-owned ledger ==\n");

console.log("[1] count lines with the SAME convention the chat chip uses (write / edit / patch)");
assert(countCode({ content: "a\nb\nc\n" }).added === 3, "a write counts every content line as added");
const e = countCode({ oldText: "a\nb\nc\n", newText: "a\nB\nc\nd\n" });
assert(e.added === 2 && e.removed === 1, "an old→new edit counts the line diff (LCS), not the whole file");
const p = countCode({ patch: "[f#h]\nKEEP\n+n1\n+n2\n-o1\n" });
assert(p.added === 2 && p.removed === 1, "a hashline patch counts +/- content lines (headers ignored)");
assert(countCode({}).added === 0, "a read/search/bash (no authored code) counts nothing");

console.log("\n[2] the desktop APPENDS each edit to a GUI-owned JSONL (no DuckDB → no write-lock contention)");
recordAiLoc({ model: "claude-opus-4-8", identity: "nick@corp.com", identitySource: "email", repo: "/w/lucid", filePath: "/w/lucid/a.ts", tool: "write", code: { content: "1\n2\n3\n" } }, { logPath: LOG });
recordAiLoc({ model: "claude-opus-4-8", identity: "nick@corp.com", identitySource: "email", repo: "/w/lucid", filePath: "/w/lucid/b.ts", tool: "edit", code: { oldText: "x\n", newText: "x\ny\n" } }, { logPath: LOG });
recordAiLoc({ model: "gpt-5.2", identity: "nick@corp.com", identitySource: "email", repo: "/w/lucid", filePath: "/w/lucid/c.ts", tool: "edit", code: { patch: "+p1\n-p2\n" } }, { logPath: LOG });
const noop = recordAiLoc({ model: "m", identity: "i", identitySource: "email", repo: "r", tool: "read", code: {} }, { logPath: LOG });
assert(noop === null, "a zero-line step (read/search) is a no-op — not attributed as AI-authored");

console.log("\n[3] the dashboard reads + aggregates the ledger — the SAME roll-up the old DuckDB read produced");
const agg = aggregateAiLoc(readAiLocSamples(LOG), "2026-07-13T00:00:00Z");
assert(!!agg, "the roll-up is non-null (this is what makes aiLocHasData true → the panel shows DATA, not 'none yet')");
assert(agg!.totals.edits === 3, "3 countable edits recorded");
assert(agg!.totals.added === 3 + 1 + 1 && agg!.totals.removed === 0 + 0 + 1, "added/removed summed across write + edit + patch");
assert(agg!.totals.models === 2 && agg!.byModel[0]!.model === "claude-opus-4-8", "per-model breakdown, most lines first");
assert(agg!.identities.length === 1 && agg!.identities[0] === "nick@corp.com", "attributed to the corporate identity");

console.log("\n[4] the empty case stays honest");
assert(aggregateAiLoc([], "2026-07-13T00:00:00Z") === null, "no samples → null → the panel shows its explicit empty state");

rmSync(dir, { recursive: true, force: true });
console.log("\n✓ P-LOC.4 demo passed — AI-authored lines are recorded to a lock-free ledger and surface in the roll-up.");
