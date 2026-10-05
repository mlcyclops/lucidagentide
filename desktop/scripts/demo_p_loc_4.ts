// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-LOC.4: the GUI-owned JSONL ledger is readable while the gate holds DuckDB's writer lock.
// Completed mutations provide explicit counts, and the dashboard aggregates the lock-free mirror.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordAiLoc } from "../ailoc_log.ts";
import { readAiLocSamples, aggregateAiLoc } from "../ailoc_read.ts";
import { countContentLines, countDiffLines } from "../../harness/runs/loc_count.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) { console.error("  FAIL " + msg); process.exit(1); }
  console.log("  PASS " + msg);
}

const dir = mkdtempSync(join(tmpdir(), "ailoc-demo-"));
const LOG = join(dir, "lucid-ailoc.jsonl");

console.log("== #ADR-0211 P-LOC.4: AI-authored lines flow to the UI via a lock-free GUI-owned ledger ==\n");

console.log("[1] count full writes and authoritative applied diffs, never preview snippets");
assert(countContentLines("a\nb\nc\n") === 3, "a write counts every content line as added");
const edit = countDiffLines(" 1|a\n-2|b\n+2|B\n 3|c\n+4|d\n");
assert(edit.added === 2 && edit.removed === 1, "an applied edit counts the actual diff rows");
const patch = countDiffLines("--- a/f.ts\n+++ b/f.ts\n@@ -1 +1 @@\n+n1\n+n2\n-o1\n");
assert(patch.added === 2 && patch.removed === 1, "unified diff headers do not count as authored lines");

console.log("\n[2] the desktop appends completed counts to GUI-owned JSONL without DuckDB");
const context = { identity: "nick@corp.com", identitySource: "email", repo: "/w/lucid" };
recordAiLoc({ ...context, model: "claude-opus-4-8", filePath: "/w/lucid/a.ts", tool: "write", added: countContentLines("1\n2\n3\n"), removed: 0 }, { logPath: LOG });
recordAiLoc({ ...context, model: "claude-opus-4-8", filePath: "/w/lucid/b.ts", tool: "edit", ...countDiffLines(" 1|x\n+2|y\n") }, { logPath: LOG });
recordAiLoc({ ...context, model: "gpt-5.2", filePath: "/w/lucid/c.ts", tool: "edit", ...countDiffLines("+p1\n-p2\n") }, { logPath: LOG });
const noop = recordAiLoc({ ...context, model: "m", tool: "edit", added: 0, removed: 0 }, { logPath: LOG });
assert(noop === null, "a zero-line mutation does not append a sample");

console.log("\n[3] the dashboard reads and aggregates the ledger without a database connection");
const agg = aggregateAiLoc(readAiLocSamples(LOG), "2026-07-13T00:00:00Z");
assert(!!agg, "the roll-up has data for the AI-authored lines panel");
assert(agg!.totals.edits === 3, "three countable edits recorded");
assert(agg!.totals.added === 5 && agg!.totals.removed === 1, "added and removed counts summed across write and edits");
assert(agg!.totals.models === 2 && agg!.byModel[0]!.model === "claude-opus-4-8", "per-model breakdown, most lines first");
assert(agg!.identities.length === 1 && agg!.identities[0] === "nick@corp.com", "attributed to the corporate identity");
assert(aggregateAiLoc([], "2026-07-13T00:00:00Z") === null, "no samples retain the explicit empty state");

rmSync(dir, { recursive: true, force: true });
console.log("\nP-LOC.4 demo passed: the lock-free ledger records counts and exposes the roll-up.");
