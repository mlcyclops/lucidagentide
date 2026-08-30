// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/sync_state.test.ts - P-PWA-FOCUS.2: the cross-target sync decision, exhaustively.
//
// Two things here can hurt the user, so both are pinned at their boundaries. First the ORDER: land them in the
// conversation they are already looking at, and never let a louder lane steal the jump. Second the ARITHMETIC:
// a lane whose replay shrank the stream must report nothing new instead of a negative count, and a clock that
// went backwards must not cost the user their automatic sync.
//
// The summary is phone UI copy, so every singular/plural combination is asserted, and it is checked to carry no
// em or en dash (project rule: hyphens, commas, colons only).

import { describe, expect, it } from "bun:test";
import { planSync, SYNC_AUTO_WINDOW_MS, type TargetProgress } from "./sync_state.ts";

function target(id: string, label: string, total: number, seen: number): TargetProgress {
  return { target: id, label, total, seen };
}

/** Master with nothing unseen: the neutral filler for ordering cases about lanes. */
const CAUGHT_UP_MASTER = target("master", "main session", 40, 40);

describe("planSync: ordering", () => {
  it("puts the focused target first even when another missed far more", () => {
    const plan = planSync([
      target("master", "main session", 10, 8),
      target("stella", "Stella", 30, 20),
    ], "master", 0);
    expect(plan.unseen.map((u) => u.target)).toEqual(["master", "stella"]);
    expect(plan.unseen.map((u) => u.count)).toEqual([2, 10]);
  });

  it("puts a focused LANE first over the busier master session", () => {
    const plan = planSync([
      target("master", "main session", 100, 1),
      target("stella", "Stella", 5, 4),
    ], "stella", 0);
    expect(plan.unseen.map((u) => u.target)).toEqual(["stella", "master"]);
  });

  it("falls back to descending count when the focused target has nothing unseen", () => {
    const plan = planSync([
      target("ada", "Ada", 8, 5),
      CAUGHT_UP_MASTER,
      target("bo", "Bo", 11, 4),
    ], "master", 0);
    expect(plan.unseen.map((u) => u.target)).toEqual(["bo", "ada"]);
    expect(plan.unseen.map((u) => u.count)).toEqual([7, 3]);
  });

  it("falls back to descending count when the focused target is not in the list at all", () => {
    const plan = planSync([
      target("ada", "Ada", 4, 3),
      target("bo", "Bo", 9, 3),
    ], "gone", 0);
    expect(plan.unseen.map((u) => u.target)).toEqual(["bo", "ada"]);
  });

  it("breaks equal counts by label so the render is stable", () => {
    const plan = planSync([
      target("z", "Zed", 14, 10),
      target("a", "Ada", 4, 0),
      target("m", "Mila", 9, 5),
    ], "master", 0);
    expect(plan.unseen.map((u) => u.label)).toEqual(["Ada", "Mila", "Zed"]);
    expect(plan.unseen.map((u) => u.count)).toEqual([4, 4, 4]);
  });

  it("applies focus, then count, then label in that priority", () => {
    const plan = planSync([
      target("zed", "Zed", 6, 4),
      target("ada", "Ada", 6, 4),
      target("loud", "Loud", 50, 10),
      target("focused", "Quiet", 2, 1),
    ], "focused", 0);
    expect(plan.unseen.map((u) => u.label)).toEqual(["Quiet", "Loud", "Ada", "Zed"]);
  });
});

describe("planSync: unseen arithmetic", () => {
  it("reports firstUnseen exactly at the seen boundary", () => {
    const plan = planSync([target("stella", "Stella", 31, 24)], "stella", 0);
    expect(plan.unseen[0]!.firstUnseen).toBe(24);
    expect(plan.unseen[0]!.count).toBe(7);
    expect(plan.totalUnseen).toBe(7);
  });

  it("reports firstUnseen 0 when nothing at all was seen", () => {
    const plan = planSync([target("stella", "Stella", 3, 0)], "stella", 0);
    expect(plan.unseen[0]!.firstUnseen).toBe(0);
    expect(plan.unseen[0]!.count).toBe(3);
  });

  it("omits a target that SHRANK below what was seen, with zero unseen", () => {
    const plan = planSync([target("stella", "Stella", 5, 12)], "stella", 0);
    expect(plan.unseen).toEqual([]);
    expect(plan.totalUnseen).toBe(0);
    expect(plan.summary).toBe("");
  });

  it("does not let a shrunken target subtract from a real backlog", () => {
    const plan = planSync([
      target("stella", "Stella", 5, 12),
      target("bo", "Bo", 10, 6),
    ], "stella", 0);
    expect(plan.unseen.map((u) => u.target)).toEqual(["bo"]);
    expect(plan.totalUnseen).toBe(4);
  });

  it("omits a caught-up target", () => {
    const plan = planSync([CAUGHT_UP_MASTER], "master", 0);
    expect(plan.unseen).toEqual([]);
    expect(plan.totalUnseen).toBe(0);
  });

  it("treats a non-finite length as read in full rather than inventing updates", () => {
    const plan = planSync([
      target("a", "A", Number.NaN, 0),
      target("b", "B", 9, Number.NaN),
      target("c", "C", Number.POSITIVE_INFINITY, 2),
      target("d", "D", 6, Number.POSITIVE_INFINITY),
    ], "a", 0);
    expect(plan.unseen).toEqual([]);
    expect(plan.totalUnseen).toBe(0);
  });

  it("clamps a negative seen up to the start of the stream", () => {
    const plan = planSync([target("stella", "Stella", 4, -2)], "stella", 0);
    expect(plan.unseen[0]!.count).toBe(4);
    expect(plan.unseen[0]!.firstUnseen).toBe(0);
  });

  it("carries the label through unchanged for the render", () => {
    const plan = planSync([target("master", "main session", 2, 1)], "master", 0);
    expect(plan.unseen[0]!).toEqual({ target: "master", label: "main session", count: 1, firstUnseen: 1 });
  });
});

describe("planSync: the auto window", () => {
  it("defaults to a 60 second window", () => {
    expect(SYNC_AUTO_WINDOW_MS).toBe(60_000);
    expect(planSync([], "master", SYNC_AUTO_WINDOW_MS).auto).toBe(true);
    expect(planSync([], "master", SYNC_AUTO_WINDOW_MS + 1).auto).toBe(false);
  });

  it("is INCLUSIVE at the boundary", () => {
    expect(planSync([], "master", 59_999, 60_000).auto).toBe(true);
    expect(planSync([], "master", 60_000, 60_000).auto).toBe(true);
    expect(planSync([], "master", 60_001, 60_000).auto).toBe(false);
  });

  it("treats a backwards clock as no absence at all", () => {
    expect(planSync([], "master", -1).auto).toBe(true);
    expect(planSync([], "master", -900_000).auto).toBe(true);
  });

  it("treats an unsampled absence as no absence at all", () => {
    expect(planSync([], "master", Number.NaN).auto).toBe(true);
    expect(planSync([], "master", Number.POSITIVE_INFINITY).auto).toBe(true);
    expect(planSync([], "master", Number.NEGATIVE_INFINITY).auto).toBe(true);
  });

  it("honours a caller-supplied window", () => {
    expect(planSync([], "master", 1_000, 1_000).auto).toBe(true);
    expect(planSync([], "master", 1_001, 1_000).auto).toBe(false);
    expect(planSync([], "master", 120_000, 600_000).auto).toBe(true);
  });

  it("reports auto for a long absence with a backlog, and for a glance with none", () => {
    const long = planSync([target("stella", "Stella", 9, 2)], "stella", 5 * 60_000);
    expect(long.auto).toBe(false);
    expect(long.totalUnseen).toBe(7);
    const glance = planSync([CAUGHT_UP_MASTER], "master", 900);
    expect(glance.auto).toBe(true);
    expect(glance.unseen).toEqual([]);
  });

  it("still reports auto FALSE when a long absence left nothing unseen", () => {
    const plan = planSync([CAUGHT_UP_MASTER], "master", 10 * 60_000);
    expect(plan).toEqual({ unseen: [], totalUnseen: 0, auto: false, summary: "" });
  });
});

describe("planSync: the summary line", () => {
  it("names the one conversation, singular update", () => {
    expect(planSync([target("stella", "Stella", 8, 7)], "stella", 0).summary).toBe("1 update in Stella");
  });

  it("names the one conversation, plural updates", () => {
    expect(planSync([target("stella", "Stella", 20, 8)], "stella", 0).summary).toBe("12 updates in Stella");
  });

  it("names the one conversation even when other targets are caught up", () => {
    const plan = planSync([CAUGHT_UP_MASTER, target("stella", "Stella", 4, 1)], "master", 0);
    expect(plan.summary).toBe("3 updates in Stella");
  });

  it("counts conversations once there are two or more", () => {
    const two = planSync([
      target("master", "main session", 12, 7),
      target("stella", "Stella", 30, 23),
    ], "master", 0);
    expect(two.summary).toBe("12 updates in 2 conversations");
    const three = planSync([
      target("a", "Ada", 6, 4),
      target("b", "Bo", 9, 8),
      target("c", "Cyd", 5, 2),
    ], "a", 0);
    expect(three.summary).toBe("6 updates in 3 conversations");
  });

  it("stays plural for the smallest multi-conversation backlog", () => {
    const plan = planSync([
      target("a", "Ada", 1, 0),
      target("b", "Bo", 1, 0),
    ], "a", 0);
    expect(plan.summary).toBe("2 updates in 2 conversations");
  });

  it("is empty when everything has been seen", () => {
    expect(planSync([CAUGHT_UP_MASTER, target("stella", "Stella", 3, 3)], "master", 0).summary).toBe("");
    expect(planSync([], "master", 0).summary).toBe("");
  });

  it("carries no em or en dash", () => {
    const plan = planSync([
      target("master", "main session", 12, 7),
      target("stella", "Stella", 30, 23),
    ], "master", 0);
    expect(plan.summary).not.toMatch(/[\u2013\u2014]/);
  });
});
