// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/skills_scan_log.test.ts — P-SKILL.4 (ADR-0097): the scan-verdict ledger. Over-tests the
// corrupt-tolerant fold (the file is user-reachable) and the latest-wins round-trip through a temp path.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetScanVerdictsForTest, foldScanVerdicts, recordScanVerdict, scanVerdicts } from "./skills_scan_log.ts";

describe("foldScanVerdicts — pure, corrupt-tolerant, latest-wins", () => {
  test("skips blank + corrupt + unknown-trust lines, never throws", () => {
    const lines = [
      "",
      "{not json",
      JSON.stringify({ key: "project:a", trust: "trusted", findings: 0, at: "t1" }),
      JSON.stringify({ key: "project:b", trust: "banana", findings: 1, at: "t2" }), // bad trust → skipped
      JSON.stringify({ trust: "trusted", findings: 0, at: "t3" }), // no key → skipped
    ];
    const out = foldScanVerdicts(lines);
    expect(Object.keys(out)).toEqual(["project:a"]);
    expect(out["project:a"]).toEqual({ trust: "trusted", findings: 0, at: "t1" });
  });

  test("the LAST valid verdict for a key wins (a re-scan supersedes)", () => {
    const out = foldScanVerdicts([
      JSON.stringify({ key: "project:x", trust: "quarantined", findings: 3, at: "t1" }),
      JSON.stringify({ key: "project:x", trust: "trusted", findings: 0, at: "t2" }),
    ]);
    expect(out["project:x"]).toEqual({ trust: "trusted", findings: 0, at: "t2" });
  });

  test("negative / non-numeric findings clamp to 0", () => {
    const out = foldScanVerdicts([JSON.stringify({ key: "k", trust: "suspicious", findings: -5, at: "t" })]);
    expect(out["k"].findings).toBe(0);
  });
});

describe("recordScanVerdict — round-trips through a temp ledger", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lucid-skillscan-"));
    process.env.LUCID_SKILL_SCAN_PATH = join(dir, "scans.jsonl");
    _resetScanVerdictsForTest();
  });
  afterEach(() => {
    delete process.env.LUCID_SKILL_SCAN_PATH;
    _resetScanVerdictsForTest();
    rmSync(dir, { recursive: true, force: true });
  });

  test("records a verdict, reflects it in memory, and persists it to disk", () => {
    recordScanVerdict("project:sk", "suspicious", 2);
    expect(scanVerdicts()["project:sk"]).toMatchObject({ trust: "suspicious", findings: 2 });
    const raw = readFileSync(process.env.LUCID_SKILL_SCAN_PATH!, "utf8").trim();
    expect(JSON.parse(raw)).toMatchObject({ key: "project:sk", trust: "suspicious", findings: 2 });
  });

  test("a fresh reader (cache reset) folds the persisted verdict back", () => {
    recordScanVerdict("user:z", "quarantined", 9);
    _resetScanVerdictsForTest(); // simulate a new session reading the ledger cold
    expect(scanVerdicts()["user:z"]).toMatchObject({ trust: "quarantined", findings: 9 });
  });
});
