// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/trainer/quizgen.test.ts - P-TRAINER.6: trainee content only ever comes from confirmed
// units, cites its source, and misses become new extraction targets (the flywheel's return edge).

import { describe, expect, test } from "bun:test";
import type { KnowledgeUnitRow } from "./store.ts";
import { extractionTargetsFromMisses, masteryFromResults, quizFromUnits, type TraineeResult } from "./quizgen.ts";

let seq = 0;
function row(over: Partial<KnowledgeUnitRow>): KnowledgeUnitRow {
  return {
    unit_id: `u${++seq}`,
    objective_id: "wmo-2.1",
    kind: "procedure",
    title: "Routine wire release",
    body_md: "body",
    structure: JSON.stringify({ steps: ["Ask", "Verify", "Enter", "Approve", "Release"], trigger: "", resolution: "" }),
    trust_label: "untrusted",
    completeness: 80,
    source_session_id: null,
    source_artifact_id: null,
    confirmed_at: "2026-08-02T00:00:00Z",
    confirmed_by: "expert",
    superseded_by: null,
    ...over,
  };
}

describe("quizFromUnits", () => {
  test("only confirmed, live, untrusted-labeled units generate items, and every item cites its unit", () => {
    const confirmed = row({});
    const unconfirmed = row({ confirmed_at: null });
    const superseded = row({ superseded_by: "u99" });
    const quarantined = row({ trust_label: "quarantined" });
    const items = quizFromUnits([confirmed, unconfirmed, superseded, quarantined], 42);
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.sourceUnitId === confirmed.unit_id)).toBe(true);
  });

  test("procedure items ask the true next step with 4 options and a correct index", () => {
    const items = quizFromUnits([row({})], 7);
    expect(items.length).toBe(1);
    const item = items[0]!;
    expect(item.options.length).toBe(4);
    expect(item.options[item.correctAnswer]).toBeDefined();
    // the correct option really is the step after the anchor
    const anchor = /after: "(.+)"\?$/.exec(item.question)?.[1];
    const steps = ["Ask", "Verify", "Enter", "Approve", "Release"];
    expect(item.options[item.correctAnswer]).toBe(steps[steps.indexOf(anchor!) + 1]!);
  });

  test("edge-case items draw decoy resolutions from OTHER units; too-thin pools are skipped", () => {
    const edge = (id: string, resolution: string) =>
      row({
        unit_id: id,
        kind: "edge_case",
        title: `edge ${id}`,
        structure: JSON.stringify({ steps: [], trigger: `Trigger ${id}.`, resolution }),
      });
    // only two resolutions in the pool -> cannot build 3 decoys -> no edge items
    expect(quizFromUnits([edge("a", "call the client"), edge("b", "hold the wire")], 3).filter((i) => i.id.endsWith("edge"))).toEqual([]);
    const pool = [
      edge("a", "call the client"),
      edge("b", "hold the wire"),
      edge("c", "escalate to compliance"),
      edge("d", "re-verify on a known number"),
    ];
    const items = quizFromUnits(pool, 3).filter((i) => i.id.endsWith("edge"));
    expect(items.length).toBe(4);
    for (const item of items) {
      expect(item.options.length).toBe(4);
      expect(new Set(item.options).size).toBe(4);
    }
  });

  test("deterministic: same units + same seed -> the same exam", () => {
    const units = [row({}), row({ unit_id: "z", title: "Second procedure" })];
    expect(quizFromUnits(units, 99)).toEqual(quizFromUnits(units, 99));
  });
});

describe("mastery + the return edge", () => {
  const item = (objectiveId: string, correctAnswer = 0) => ({
    id: "q",
    objectiveId,
    sourceUnitId: "u",
    question: "?",
    options: ["a", "b", "c", "d"],
    correctAnswer,
    explanation: "",
  });

  test("masteryFromResults is per-objective percent", () => {
    const results: TraineeResult[] = [
      { item: item("wmo-2.1"), chosen: 0 },
      { item: item("wmo-2.1"), chosen: 1 },
      { item: item("wmo-4.1"), chosen: 0 },
    ];
    expect(masteryFromResults(results)).toEqual({ "wmo-2.1": 50, "wmo-4.1": 100 });
  });

  test("misses below the bar become extraction targets (sorted, stable)", () => {
    const results: TraineeResult[] = [
      { item: item("wmo-2.1"), chosen: 1 },
      { item: item("wmo-4.1"), chosen: 0 },
      { item: item("wmo-1.1"), chosen: 2 },
    ];
    expect(extractionTargetsFromMisses(results)).toEqual(["wmo-1.1", "wmo-2.1"]);
  });
});
