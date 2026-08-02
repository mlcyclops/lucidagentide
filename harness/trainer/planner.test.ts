// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/trainer/planner.test.ts - P-TRAINER.1: the ADR-0255 cadence rules as invariants.

import { describe, expect, test } from "bun:test";
import type { CoverageObjective, UnitForCoverage } from "./coverage.ts";
import {
  FIVE_WHYS_MAX,
  hasDeviationCue,
  nextQuestion,
  openingRecap,
  recordAnswer,
  startSession,
  withUnits,
} from "./planner.ts";

const obj = (id: string, weight = 1): CoverageObjective => ({
  objectiveId: id,
  packId: "p",
  domain: "ops",
  title: `title of ${id}`,
  description: "",
  weight,
  elicitation: {
    scenarios: [`scenario A for ${id}`, `scenario B for ${id}`],
    probes: [`probe for ${id}`],
    edgeProbes: [`edge probe for ${id}`],
  },
});

const L2_UNITS: UnitForCoverage[] = [{ kind: "procedure", completeness: 80, confirmed: false }];
const L3_UNITS: UnitForCoverage[] = [
  { kind: "procedure", completeness: 80, confirmed: true },
  { kind: "edge_case", completeness: 60, confirmed: true },
];

describe("question selection", () => {
  test("scenario-first on an unexplored objective, direct at L1, edge probe at L2", () => {
    const a = obj("a");
    let s = startSession([a], new Map([["a", []]]));
    let r = nextQuestion(s, 0);
    expect(r.question?.kind).toBe("scenario");
    s = recordAnswer(r.state, "we just do it");

    s = withUnits(s, new Map([["a", [{ kind: "glossary", completeness: 50, confirmed: false } as UnitForCoverage]]]));
    r = nextQuestion(s, 0);
    expect(r.question?.kind).toBe("direct");
    s = recordAnswer(r.state, "step one then step two");

    s = withUnits(s, new Map([["a", L2_UNITS]]));
    r = nextQuestion(s, 0);
    expect(r.question?.kind).toBe("edge_probe");
  });

  test("the gap queue drives targeting: heaviest unexplored first, L3 never re-asked", () => {
    const s = startSession([obj("light", 1), obj("heavy", 5), obj("done", 9)], new Map([
      ["light", []],
      ["heavy", []],
      ["done", L3_UNITS],
    ]));
    const r = nextQuestion(s, 0);
    expect(r.question?.objectiveId).toBe("heavy");
  });

  test("phrasing rotates deterministically by ask count", () => {
    const a = obj("a");
    let s = startSession([a], new Map([["a", []]]));
    const first = nextQuestion(s, 0);
    s = recordAnswer(first.state, "plain answer");
    const second = nextQuestion(s, 0);
    expect(first.question?.text).toBe("scenario A for a");
    expect(second.question?.text).toBe("scenario B for a");
  });
});

describe("one question at a time", () => {
  test("nextQuestion re-issues the pending question until the answer lands", () => {
    const s = startSession([obj("a")], new Map([["a", []]]));
    const r1 = nextQuestion(s, 0);
    const r2 = nextQuestion(r1.state, 0);
    expect(r2.question).toEqual(r1.question);
    expect(r2.state.askCounts["a"]).toBe(1); // no double-count
  });

  test("recordAnswer without a pending question throws", () => {
    const s = startSession([obj("a")], new Map([["a", []]]));
    expect(() => recordAnswer(s, "answer")).toThrow(/one question at a time/);
  });
});

describe("energy-following (five-whys)", () => {
  test("a deviation cue queues a follow-up before the planner returns to the map", () => {
    let s = startSession([obj("a"), obj("b")], new Map([["a", []], ["b", []]]));
    const r1 = nextQuestion(s, 0);
    s = recordAnswer(r1.state, "we always verify, except when the client is traveling we do it manually");
    const r2 = nextQuestion(s, 0);
    expect(r2.question?.kind).toBe("followup");
    expect(r2.question?.objectiveId).toBe(r1.question?.objectiveId);
  });

  test("the why-thread caps at FIVE_WHYS_MAX", () => {
    let s = startSession([obj("a")], new Map([["a", []]]));
    let followups = 0;
    let r = nextQuestion(s, 0);
    // Answer EVERY question with a deviation cue; only followups may chain, capped.
    for (let i = 0; i < 20 && r.question; i++) {
      if (r.question.kind === "followup") followups++;
      expect(r.question.whyDepth).toBeLessThanOrEqual(FIVE_WHYS_MAX);
      s = recordAnswer(r.state, "well, usually, except that one time we did a workaround");
      r = nextQuestion(s, 0);
    }
    expect(followups).toBeGreaterThanOrEqual(FIVE_WHYS_MAX);
  });

  test("cue detection is case-insensitive and plain answers pass through", () => {
    expect(hasDeviationCue("EXCEPT on Fridays")).toBe(true);
    expect(hasDeviationCue("we file the form and confirm receipt")).toBe(false);
  });
});

describe("session close", () => {
  test("the cap closes the session with a recap; no question is asked past it", () => {
    const s = startSession([obj("a")], new Map([["a", []]]), { sessionCapMs: 1000 });
    const r = nextQuestion(s, 1500);
    expect(r.question).toBeNull();
    expect(r.closing).toContain("coverage now");
    // and it STAYS closed
    const r2 = nextQuestion(r.state, 2000);
    expect(r2.question).toBeNull();
  });

  test("a fully-extracted map closes immediately", () => {
    const s = startSession([obj("done")], new Map([["done", L3_UNITS]]));
    const r = nextQuestion(s, 0);
    expect(r.question).toBeNull();
    expect(r.closing).toContain("fully captured");
  });

  test("opening recap names the biggest gap", () => {
    const s = startSession([obj("a", 5)], new Map([["a", []]]));
    expect(openingRecap(s)).toContain("title of a");
  });
});
