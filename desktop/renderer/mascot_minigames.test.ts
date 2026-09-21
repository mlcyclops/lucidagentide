// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// The three arcade mini game engines, driven through their REAL exported transitions. No DOM, no
// mocks: every assertion here is something a player would notice if it broke.

import { describe, expect, it } from "bun:test";
import {
  KATA_POSES, MINI_GAMES, SHURIKEN_DUMMY_PENALTY, SHURIKEN_HIT_POINTS, SHURIKEN_LANES,
  STACK_PERFECT_BONUS, STACK_PERFECT_GAIN, STACK_START_WIDTH,
  applyKataInput, applyShurikenInput, createKataState, createShurikenState, createStackState,
  dropStackBlock, kataPayout, shurikenMultiplier, stackSpeed, stepKata, stepShuriken, stepStack,
  type KataPose, type KataState, type ShurikenState, type ShurikenTarget, type StackState,
} from "./mascot_minigames.ts";

const W = 400;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe("the mini game registry", () => {
  it("publishes exactly the three switchable games", () => {
    expect(MINI_GAMES.map((game) => game.id)).toEqual(["shuriken", "kata", "stack"]);
    for (const game of MINI_GAMES) {
      expect(game.name.length).toBeGreaterThan(0);
      expect(game.blurb).not.toContain("\n");
      expect(typeof game.mount).toBe("function");
    }
  });
});

// ------------------------------------------------------------------------------------- shuriken

function mark(kind: ShurikenTarget["kind"], lane: number, x: number): ShurikenTarget {
  return { id: 900 + x, kind, lane, x, width: kind === "dummy" ? 20 : 22, speed: 0, hit: false, popMs: 0 };
}

/** A range with the spawner parked, so only the hazards a test places are in play. */
function range(overrides: Partial<ShurikenState> = {}): ShurikenState {
  return { ...createShurikenState(W, 5), spawnMs: 600000, ...overrides };
}

describe("shuriken range", () => {
  it("identical seeds and inputs replay to identical states", () => {
    const run = () => {
      let s = createShurikenState(W, 42);
      for (let t = 0; t < 300; t++) {
        if (t % 17 === 0) s = applyShurikenInput(s, "throw");
        if (t % 41 === 0) s = applyShurikenInput(s, "lane-down");
        if (t % 53 === 0) s = applyShurikenInput(s, "lane-up");
        s = stepShuriken(s, 16);
      }
      return s;
    };
    expect(run()).toEqual(run());
  });

  it("stepShuriken never mutates the state it was handed", () => {
    const before = range({ targets: [mark("target", 1, 120)], shots: [{ id: 1, lane: 1, x: 116, spent: false }] });
    const snapshot = clone(before);
    stepShuriken(before, 48);
    expect(clone(before)).toEqual(snapshot);
  });

  it("consecutive hits pay a growing multiplier", () => {
    const s = range({
      targets: [mark("target", 0, 120), mark("target", 0, 180), mark("target", 0, 240)],
      shots: [
        { id: 1, lane: 0, x: 116, spent: false },
        { id: 2, lane: 0, x: 176, spent: false },
        { id: 3, lane: 0, x: 236, spent: false },
      ],
    });
    const after = stepShuriken(s, 16);
    expect(after.combo).toBe(3);
    expect(after.score).toBe(SHURIKEN_HIT_POINTS * (shurikenMultiplier(0) + shurikenMultiplier(1) + shurikenMultiplier(2)));
    expect(shurikenMultiplier(2)).toBeGreaterThan(shurikenMultiplier(0));
  });

  it("a shuriken that sails off the range breaks the streak", () => {
    const s = range({ combo: 4, shots: [{ id: 1, lane: 2, x: W - 2, spent: false }] });
    const after = stepShuriken(s, 16);
    expect(after.combo).toBe(0);
    expect(after.misses).toBe(1);
    expect(after.shots).toHaveLength(0);
  });

  it("striking a straw dummy costs a point and breaks the streak", () => {
    const s = range({ score: 30, combo: 3, targets: [mark("dummy", 1, 120)], shots: [{ id: 1, lane: 1, x: 116, spent: false }] });
    const after = stepShuriken(s, 16);
    expect(after.score).toBe(30 - SHURIKEN_DUMMY_PENALTY);
    expect(after.combo).toBe(0);
    expect(after.strikes).toBe(1);
  });

  it("the dummy penalty can never drive the run score negative", () => {
    const s = range({ score: 0, targets: [mark("dummy", 1, 120)], shots: [{ id: 1, lane: 1, x: 116, spent: false }] });
    expect(stepShuriken(s, 16).score).toBe(0);
  });

  it("a shuriken only strikes inside its own lane", () => {
    const s = range({ targets: [mark("target", 2, 120)], shots: [{ id: 1, lane: 0, x: 116, spent: false }] });
    const after = stepShuriken(s, 16);
    expect(after.targets[0]!.hit).toBe(false);
    expect(after.score).toBe(0);
  });

  it("lane selection clamps to the three lanes", () => {
    let s = createShurikenState(W, 1);
    for (let n = 0; n < 6; n++) s = applyShurikenInput(s, "lane-up");
    expect(s.lane).toBe(0);
    for (let n = 0; n < 6; n++) s = applyShurikenInput(s, "lane-down");
    expect(s.lane).toBe(SHURIKEN_LANES - 1);
  });

  it("the run closes after sixty seconds and stops accepting throws", () => {
    let s = createShurikenState(W, 9);
    for (let t = 0; t < 4000 && s.phase === "playing"; t++) s = stepShuriken(s, 16);
    expect(s.phase).toBe("over");
    expect(s.elapsedMs).toBeGreaterThanOrEqual(60000);
    expect(applyShurikenInput(s, "throw")).toBe(s);
  });
});

// ----------------------------------------------------------------------------------------- kata

/** Run the demo phase out so the player is allowed to answer. */
function untilInput(state: KataState): KataState {
  let s = state;
  for (let t = 0; t < 400 && s.phase !== "input"; t++) s = stepKata(s, 16);
  return s;
}

function replay(state: KataState, poses: readonly KataPose[]): KataState {
  let s = state;
  for (const pose of poses) s = applyKataInput(s, pose);
  return s;
}

describe("kata memory", () => {
  it("identical seeds and inputs replay to identical states", () => {
    const run = () => {
      let s = untilInput(createKataState(W, 77));
      for (let round = 0; round < 4; round++) {
        s = replay(s, s.sequence);
        s = untilInput(s);
      }
      return s;
    };
    expect(run()).toEqual(run());
  });

  it("stepKata never mutates the state it was handed", () => {
    const before = createKataState(W, 3);
    const snapshot = clone(before);
    stepKata(before, 96);
    expect(clone(before)).toEqual(snapshot);
  });

  it("a clean kata pays out and grows the sequence by exactly one", () => {
    const start = untilInput(createKataState(W, 11));
    const length = start.sequence.length;
    const cleared = replay(start, start.sequence);
    expect(cleared.phase).toBe("clear");
    expect(cleared.score).toBe(kataPayout(length));
    const grown = untilInput(cleared);
    expect(grown.sequence).toHaveLength(length + 1);
    expect(grown.sequence.slice(0, length)).toEqual(start.sequence);
    expect(grown.round).toBe(start.round + 1);
    expect(KATA_POSES).toContain(grown.sequence[length]!);
  });

  it("longer katas pay more per pose, not just more in total", () => {
    expect(kataPayout(4)).toBeGreaterThan(kataPayout(3));
    expect(kataPayout(6) / 6).toBeGreaterThan(kataPayout(2) / 2);
    expect(kataPayout(0)).toBe(0);
  });

  it("a wrong pose ends the run on the spot", () => {
    const start = untilInput(createKataState(W, 21));
    const expected = start.sequence[0]!;
    const wrong = KATA_POSES.find((pose) => pose !== expected)!;
    const after = applyKataInput(start, wrong);
    expect(after.phase).toBe("over");
    expect(after.wrongPose).toBe(wrong);
    expect(after.score).toBe(start.score);
    expect(stepKata(after, 16)).toBe(after);
  });

  it("poses outside the input phase are ignored rather than read past the sequence", () => {
    const demo = createKataState(W, 33);
    expect(demo.phase).toBe("demo");
    for (const pose of KATA_POSES) expect(applyKataInput(demo, pose)).toBe(demo);
    const cleared = replay(untilInput(demo), untilInput(demo).sequence);
    expect(cleared.phase).toBe("clear");
    expect(cleared.cursor).toBe(cleared.sequence.length);
    for (const pose of KATA_POSES) expect(applyKataInput(cleared, pose)).toBe(cleared);
  });
});

// ---------------------------------------------------------------------------------------- stack

/** A tower whose top block sits exactly where the test asks, with the slider parked. */
function tower(topX: number, topWidth: number, blockX: number, blockWidth: number, overrides: Partial<StackState> = {}): StackState {
  const base = createStackState(W, 4);
  return { ...base, tower: [{ x: topX, width: topWidth }], blockX, blockWidth, ...overrides };
}

describe("rooftop stack", () => {
  it("identical seeds and inputs replay to identical states", () => {
    const run = () => {
      let s = createStackState(W, 8);
      for (let t = 0; t < 400 && s.phase === "playing"; t++) {
        if (t % 23 === 0) s = dropStackBlock(s);
        s = stepStack(s, 16);
      }
      return s;
    };
    expect(run()).toEqual(run());
  });

  it("stepStack never mutates the state it was handed", () => {
    const before = createStackState(W, 2);
    const snapshot = clone(before);
    stepStack(before, 64);
    expect(clone(before)).toEqual(snapshot);
  });

  it("overhang is trimmed off the placed crate and lost for good", () => {
    const s = tower(100, 80, 120, 80);
    const after = dropStackBlock(s);
    const placed = after.tower[after.tower.length - 1]!;
    expect(placed.width).toBe(60);
    expect(placed.x).toBe(120);
    expect(after.blockWidth).toBe(60);
    expect(after.lastTrim).toBe(20);
    expect(after.height).toBe(1);
  });

  it("a perfect centre hands width back and pays a bonus", () => {
    const off = dropStackBlock(tower(100, 60, 101, 60));
    expect(off.perfects).toBe(1);
    expect(off.tower[1]!.width).toBe(60 + STACK_PERFECT_GAIN);
    expect(off.lastTrim).toBe(0);
    const plain = dropStackBlock(tower(100, 60, 110, 60));
    expect(off.score - plain.score).toBe(STACK_PERFECT_BONUS);
  });

  it("the perfect bonus never grows a crate past the starting width", () => {
    const s = tower(100, STACK_START_WIDTH, 100, STACK_START_WIDTH);
    expect(dropStackBlock(s).tower[1]!.width).toBe(STACK_START_WIDTH);
  });

  it("a crate that misses the tower entirely ends the run", () => {
    const missed = dropStackBlock(tower(100, 60, 200, 40));
    expect(missed.phase).toBe("over");
    expect(missed.height).toBe(0);
    expect(dropStackBlock(missed)).toBe(missed);
    expect(stepStack(missed, 16)).toBe(missed);
  });

  it("a crate landing flush on the tower edge is a miss, not a zero width crate", () => {
    const flush = dropStackBlock(tower(100, 60, 160, 40));
    expect(flush.phase).toBe("over");
  });

  it("tower width stays positive through a long automated run", () => {
    let s = createStackState(W, 13);
    let drops = 0;
    let narrowest = Number.POSITIVE_INFINITY;
    let escaped = false;
    // An imprecise autoplayer: it releases whenever the crate is roughly over the tower, so the
    // run is a long chain of real trims rather than one instant miss.
    for (let t = 0; t < 4000 && s.phase === "playing"; t++) {
      s = stepStack(s, 16);
      const top = s.tower[s.tower.length - 1]!;
      const drift = Math.abs((s.blockX + s.blockWidth / 2) - (top.x + top.width / 2));
      if (drift < 5) {
        s = dropStackBlock(s);
        if (s.phase === "playing") drops++;
      }
      for (const block of s.tower) narrowest = Math.min(narrowest, block.width);
      if (s.blockX < -0.0001 || s.blockX + s.blockWidth > W + 0.0001) escaped = true;
    }
    expect(drops).toBeGreaterThan(3);
    expect(narrowest).toBeGreaterThan(0);
    expect(escaped).toBe(false);
  });

  it("the crate slides faster as the tower grows, and the climb is capped", () => {
    expect(stackSpeed(6, 420)).toBeGreaterThan(stackSpeed(1, 420));
    expect(stackSpeed(9999, 420)).toBe(340);
  });

  it("a wider panel gets a proportionally faster crate, so a sweep keeps its timing", () => {
    expect(stackSpeed(3, 840)).toBeCloseTo(stackSpeed(3, 420) * 2, 6);
    // Narrow panels are not slowed below the base rate, they would become unplayably sluggish.
    expect(stackSpeed(3, 300)).toBe(stackSpeed(3, 420));
  });
});
