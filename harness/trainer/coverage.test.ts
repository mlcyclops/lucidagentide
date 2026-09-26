// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/trainer/coverage.test.ts - P-TRAINER.1: the L0-L3 rubric is a pure, derivable contract.

import { describe, expect, test } from "bun:test";
import {
  type CoverageObjective,
  type UnitForCoverage,
  coverageScore,
  domainCoverage,
  gapQueue,
  isTeachbackVerdict,
  isUnitKind,
  objectiveLevel,
} from "./coverage.ts";

const obj = (id: string, weight = 1, domain = "d"): CoverageObjective => ({
  objectiveId: id,
  packId: "p",
  domain,
  title: id,
  description: "",
  weight,
  elicitation: { scenarios: [], probes: [], edgeProbes: [] },
});

const unit = (kind: UnitForCoverage["kind"], completeness: number, confirmed = false): UnitForCoverage => ({ kind, completeness, confirmed });

describe("objectiveLevel", () => {
  test("L0: no units", () => {
    expect(objectiveLevel([])).toBe(0);
  });

  test("L1: any live unit, but no stepped procedure", () => {
    expect(objectiveLevel([unit("glossary", 100)])).toBe(1);
    expect(objectiveLevel([unit("procedure", 30)])).toBe(1); // too thin to count as stepped
  });

  test("L2: a reasonably complete procedure", () => {
    expect(objectiveLevel([unit("procedure", 60)])).toBe(2);
  });

  test("L3 requires BOTH a confirmed procedure AND a confirmed edge case", () => {
    expect(objectiveLevel([unit("procedure", 80, true)])).toBe(2); // no edge case yet
    expect(objectiveLevel([unit("procedure", 80), unit("edge_case", 50, true)])).toBe(2); // procedure unconfirmed
    expect(objectiveLevel([unit("procedure", 80, true), unit("edge_case", 50, true)])).toBe(3);
    expect(objectiveLevel([unit("procedure", 80, true), unit("exception", 50, true)])).toBe(3); // exceptions count
  });
});

describe("coverageScore + gapQueue", () => {
  test("weighted score and empty-map floor", () => {
    expect(coverageScore([], new Map())).toBe(0);
    const objectives = [obj("a", 3), obj("b", 1)];
    const units = new Map<string, UnitForCoverage[]>([
      ["a", [unit("procedure", 90, true), unit("edge_case", 60, true)]], // L3
      ["b", []], // L0
    ]);
    // (3*1 + 1*0) / 4 = 75%
    expect(coverageScore(objectives, units)).toBe(75);
  });

  test("gap queue: least level first, weight breaks ties, L3 excluded", () => {
    const objectives = [obj("low", 1), obj("heavy", 5), obj("done", 9)];
    const units = new Map<string, UnitForCoverage[]>([
      ["low", []],
      ["heavy", []],
      ["done", [unit("procedure", 90, true), unit("edge_case", 60, true)]],
    ]);
    const q = gapQueue(objectives, units);
    expect(q.map((e) => e.objective.objectiveId)).toEqual(["heavy", "low"]); // done (L3) never re-asked
  });

  test("domain rollup groups by domain", () => {
    const objectives = [obj("a", 1, "ops"), obj("b", 1, "tax")];
    const units = new Map<string, UnitForCoverage[]>([
      ["a", [unit("procedure", 80, true), unit("edge_case", 60, true)]],
      ["b", []],
    ]);
    const d = domainCoverage(objectives, units);
    expect(d).toEqual([
      { domain: "ops", score: 100 },
      { domain: "tax", score: 0 },
    ]);
  });
});

describe("closed-set guards", () => {
  test("unit kinds and verdicts are closed sets", () => {
    expect(isUnitKind("procedure")).toBe(true);
    expect(isUnitKind("vibe")).toBe(false);
    expect(isTeachbackVerdict("confirmed")).toBe(true);
    expect(isTeachbackVerdict("maybe")).toBe(false);
  });
});
