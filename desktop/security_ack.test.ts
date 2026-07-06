// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/security_ack.test.ts — P-SECACK.1 (ADR-0170): the review-ack ledger.
// Over-tests foldAcks (it parses a user-reachable JSONL file — corruptible) and the
// invariants the Security panel counters depend on: idempotence, monotone watermark,
// persistence across a reload, and "an ack never fabricates state".

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetAcksForTest, ackArtifact, ackFindings, ackView, foldAcks } from "./security_ack.ts";

describe("foldAcks — defensive against a corrupted ledger", () => {
  test("empty / blank / corrupt lines → empty state, never a throw", () => {
    expect(foldAcks([])).toEqual({ artifacts: {}, findingsSeen: null });
    expect(foldAcks(["", "  ", "{oops", "42", '"str"', "null"])).toEqual({ artifacts: {}, findingsSeen: null });
  });

  test("keeps every parseable ack around a corrupt line", () => {
    const s = foldAcks([
      '{"kind":"artifact","id":"a1","at":"2026-01-01T00:00:00Z","reviewer":"user"}',
      "{corrupt",
      '{"kind":"findings","total":24,"at":"2026-01-02T00:00:00Z"}',
    ]);
    expect(Object.keys(s.artifacts)).toEqual(["a1"]);
    expect(s.findingsSeen).toBe(24);
  });

  test("first artifact ack wins; findings watermark only rises (replay can't un-see)", () => {
    const s = foldAcks([
      '{"kind":"artifact","id":"a1","at":"FIRST"}',
      '{"kind":"artifact","id":"a1","at":"SECOND"}',
      '{"kind":"findings","total":24,"at":"t"}',
      '{"kind":"findings","total":10,"at":"t"}',
    ]);
    expect(s.artifacts["a1"]?.at).toBe("FIRST");
    expect(s.findingsSeen).toBe(24);
  });

  test("blank ids and negative/NaN totals are rejected", () => {
    const s = foldAcks(['{"kind":"artifact","id":""}', '{"kind":"findings","total":"nope"}', '{"kind":"findings","total":-5}']);
    expect(s.artifacts).toEqual({});
    expect(s.findingsSeen).toBe(0); // -5 clamps to 0, not negative
  });
});

describe("ledger round-trip (temp LUCID_SEC_ACK_PATH — never the real ~/.omp)", () => {
  let dir: string;
  const noEmit = () => { /* audit sinks stay untouched in tests */ };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lucid-ack-"));
    process.env.LUCID_SEC_ACK_PATH = join(dir, "acks.jsonl");
    _resetAcksForTest();
  });
  afterEach(() => {
    delete process.env.LUCID_SEC_ACK_PATH;
    _resetAcksForTest();
    rmSync(dir, { recursive: true, force: true });
  });

  test("ack → persists → survives a cache reset (fresh process)", () => {
    expect(ackArtifact("art-1", "user", noEmit)).not.toBeNull();
    ackFindings(24);
    _resetAcksForTest(); // simulates an app restart re-reading the JSONL
    const v = ackView();
    expect(v.artifacts["art-1"]).toBeDefined();
    expect(v.findingsSeen).toBe(24);
  });

  test("re-acking the same artifact is idempotent — one ledger line, same record", () => {
    const first = ackArtifact("art-1", "user", noEmit);
    const second = ackArtifact("art-1", "someone-else", noEmit);
    expect(second).toEqual(first!); // reviewer/at unchanged
    const lines = readFileSync(process.env.LUCID_SEC_ACK_PATH!, "utf8").trim().split("\n");
    expect(lines.length).toBe(1);
  });

  test("blank id → null, nothing written", () => {
    expect(ackArtifact("   ", "user", noEmit)).toBeNull();
    expect(ackView().artifacts).toEqual({});
  });

  test("watermark is monotone: a lower re-ack neither lowers it nor appends", () => {
    expect(ackFindings(24)).toBe(24);
    expect(ackFindings(10)).toBe(24);
    const lines = readFileSync(process.env.LUCID_SEC_ACK_PATH!, "utf8").trim().split("\n");
    expect(lines.length).toBe(1);
    expect(ackFindings(30)).toBe(30); // more findings later → next ack raises it
  });

  test("a throwing audit sink never blocks the ack (observability, not the gate)", () => {
    const boom = () => { throw new Error("sink down"); };
    expect(ackArtifact("art-2", "user", boom)).not.toBeNull();
    expect(ackView().artifacts["art-2"]).toBeDefined();
  });
});
