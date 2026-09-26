// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/security_log.test.ts - dismissAllBlocks, the Security panel's bulk "Dismiss all".
// Over-tests the two properties a reviewer's trust rests on:
//   1. it acknowledges WITHOUT releasing. Only quarantined -> dismissed ever happens, an already
//      approved row is left completely alone, and nothing is ever flipped to approved. "Dismiss all"
//      must never quietly become "approve all".
//   2. the audit trail stays PER BLOCK: one _dismiss ledger line and one block_dismissed security
//      event for each block, never one aggregate line that would destroy the provenance trail.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { audit } from "./audit_export.ts";
import { approveBlock, dismissAllBlocks, liveBlocks, recordBlock } from "./security_log.ts";

// STATIC imports are correct here, and the reason matters. This file first tried redirecting HOME and
// dynamically importing, because security_log resolved its ledger path once at module load. That passed
// ALONE and, in the full suite, found the module already loaded with the real home: it dismissed the
// operator's real quarantine queue and wrote its fixtures into their real audit ledger. So the module now
// resolves the path PER CALL and honors LUCID_BLOCKS_PATH, which removes the load-order problem entirely.
// Nothing reads the path until the first recordBlock/liveBlocks call inside a test below.
//
// The audit sink needs no override: under `bun test` its default is already a per-process temp file, and
// these tests assert on the in-memory ring (audit.recent), not on that file.
const dir = mkdtempSync(join(tmpdir(), "lucid-blocks-"));
const LEDGER = join(dir, "lucid-blocks.jsonl");
process.env.LUCID_BLOCKS_PATH = LEDGER;

afterAll(() => {
  delete process.env.LUCID_BLOCKS_PATH; // never leak the redirect into another file in this process
  // Non-fatal (repo convention): on Windows the sink can still hold the handle, and a leftover dir in the
  // OS temp dir is harmless. The env cleanup above must never be skipped for it.
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
});

interface DismissLine { id: string; reviewer?: string; dismissedAt?: string }
/** Every _dismiss marker on disk, in ledger order (the audit trail the SOC actually reads). */
const ledgerDismisses = (): DismissLine[] =>
  readFileSync(LEDGER, "utf8").split("\n").filter((l) => l.trim())
    .map((l) => JSON.parse(l) as DismissLine & { _dismiss?: boolean })
    .filter((o) => o._dismiss === true);
const dismissedEvents = (identity?: string) =>
  audit.recent(500).filter((e) => e.type === "block_dismissed" && (identity === undefined || e.identity === identity));

describe("dismissAllBlocks - bulk acknowledge, zero release", () => {
  // These tests share ONE ledger and run in declaration order on purpose: security_log.ts caches the
  // parsed log in a module-level `mem` and exports no reset seam, so the sequence IS the fixture.
  const ids: string[] = [];
  let approvedId = "";

  test("every quarantined block becomes dismissed; an approved block is left alone", () => {
    for (const tool of ["write", "eval", "bash"]) {
      ids.push(recordBlock({ tool, severity: "high", findings: "zero-width\u00d72", reason: `${tool} carried hidden Unicode` }).id);
    }
    approvedId = recordBlock({ tool: "read", reason: "reviewed false positive" }).id;
    expect(approveBlock(approvedId)).not.toBeNull();

    const r = dismissAllBlocks();
    expect(r.dismissed).toBe(3);
    expect(r.blocks.map((b) => b.id).sort()).toEqual([...ids].sort());
    expect(r.blocks.every((b) => b.status === "dismissed" && b.reviewer === "user" && !!b.dismissedAt)).toBe(true);
    // Nothing was released: the approved row is untouched and no block was flipped to approved.
    expect(r.blocks.some((b) => b.id === approvedId)).toBe(false);
    expect(r.blocks.some((b) => b.status === "approved")).toBe(false);

    const v = liveBlocks();
    expect(v.quarantined).toEqual([]); // the active queue is empty, which is the whole point
    expect(v.dismissed.map((b) => b.id).sort()).toEqual([...ids].sort());
    expect(v.approved.map((b) => b.id)).toEqual([approvedId]);
    expect(v.total).toBe(4); // nothing deleted; every audit record is retained
  });

  test("the audit trail stays per block: one _dismiss ledger line and one event each", () => {
    const lines = ledgerDismisses();
    expect(lines.length).toBe(3); // one line PER block, never a single aggregate line
    expect(lines.map((o) => o.id).sort()).toEqual([...ids].sort());
    expect(lines.every((o) => o.reviewer === "user" && typeof o.dismissedAt === "string")).toBe(true);
    expect(lines.some((o) => o.id === approvedId)).toBe(false); // approved rows are not dismissable

    const events = dismissedEvents();
    expect(events.length).toBe(3);
    expect(events.every((e) => e.category === "approval" && e.decision === "block" && e.identity === "user")).toBe(true);
    expect(events.map((e) => e.tool).sort()).toEqual(["bash", "eval", "write"]);
  });

  test("a second call finds nothing: { dismissed: 0, blocks: [] }, no new ledger lines, no throw", () => {
    const before = ledgerDismisses().length;
    const r = dismissAllBlocks();
    expect(r).toEqual({ dismissed: 0, blocks: [] });
    expect(ledgerDismisses().length).toBe(before);
    expect(dismissedEvents().length).toBe(3); // no duplicate events for already-dismissed blocks
    const v = liveBlocks();
    expect(v.dismissed.length).toBe(3); // still dismissed, still blocked, still audited
    expect(v.approved.map((b) => b.id)).toEqual([approvedId]); // "approve all" still never happened
  });

  test("the reviewer reaches every ledger line and every event", () => {
    const fresh = [
      recordBlock({ tool: "fetch", reason: "egress to an unknown host" }).id,
      recordBlock({ tool: "eval", reason: "bidi override in the payload" }).id,
    ];
    const r = dismissAllBlocks("soc-analyst");
    expect(r.dismissed).toBe(2);
    expect(r.blocks.every((b) => b.reviewer === "soc-analyst")).toBe(true);

    const lines = ledgerDismisses().filter((o) => fresh.includes(o.id));
    expect(lines.length).toBe(2);
    expect(lines.every((o) => o.reviewer === "soc-analyst")).toBe(true);

    const events = dismissedEvents("soc-analyst");
    expect(events.length).toBe(2);
    expect(events.every((e) => e.decision === "block")).toBe(true);
    expect(liveBlocks().approved.map((b) => b.id)).toEqual([approvedId]); // still nothing released
  });
});
