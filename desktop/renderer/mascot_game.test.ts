// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-MASCOT.4: the run-only arcade engine, pure and deterministic. These tests drive the REAL
// exported transitions (createArcadeState / applyArcadeInput / stepArcade) - no mocks, no DOM.

import { describe, expect, it } from "bun:test";
import {
  applyArcadeInput, arcadeSpeed, createArcadeState, stepArcade,
  type ArcadeObstacle, type ArcadeState,
} from "./mascot_game.ts";

const W = 400; // below the 560px 2x threshold, so geometry math reads at 1x

function obstacle(kind: ArcadeObstacle["kind"], x: number): ArcadeObstacle {
  const width = kind === "beam" ? 46 : kind === "star" ? 18 : 26;
  const height = kind === "beam" ? 12 : kind === "star" ? 18 : kind === "crate" ? 16 : 32;
  const bottom = kind === "beam" || kind === "star" ? 29 : 0;
  return { id: 900, kind, x, width, height, bottom, handled: false };
}

/** A playing state with one hazard parked on the runner. */
function facing(kind: ArcadeObstacle["kind"], overrides: Partial<ArcadeState> = {}): ArcadeState {
  const base = createArcadeState(W, 7);
  return { ...base, spawnMs: 60000, obstacles: [obstacle(kind, base.x + 12)], ...overrides };
}

describe("determinism and immutability", () => {
  it("identical seeds and inputs replay to identical states", () => {
    const run = () => {
      let s = createArcadeState(W, 42);
      for (let t = 0; t < 40; t++) {
        if (t === 10) s = applyArcadeInput(s, "jump", true);
        if (t === 25) s = applyArcadeInput(s, "duck", true);
        s = stepArcade(s, 16);
      }
      return s;
    };
    expect(run()).toEqual(run());
  });
  it("stepArcade never mutates the input state", () => {
    const before = facing("crate");
    const snapshot = JSON.parse(JSON.stringify(before));
    stepArcade(before, 48);
    expect(JSON.parse(JSON.stringify(before))).toEqual(snapshot);
  });
});

describe("obstacle variety and motion", () => {
  it("spawns every kind, including the fast ninja stars", () => {
    // Deep hearts via spread (documented test seam) so a long unplayed run cannot end early.
    let s: ArcadeState = { ...createArcadeState(W, 3), hearts: 9999 };
    const seen = new Set<string>();
    for (let t = 0; t < 9000 && seen.size < 5; t++) {
      s = stepArcade(s, 16);
      for (const o of s.obstacles) seen.add(o.kind);
      if (s.mode === "flycatch") s = stepArcade({ ...s, bonus: { ...s.bonus!, remainingMs: 1 } }, 16);
    }
    expect([...seen].sort()).toEqual(["beam", "crate", "pot", "star", "target"]);
  });
  it("ninja stars fly 1.7x faster than ground hazards", () => {
    const s = { ...facing("crate"), obstacles: [obstacle("crate", 300), obstacle("star", 300)] };
    const after = stepArcade(s, 16);
    const crate = after.obstacles.find((o) => o.kind === "crate")!;
    const star = after.obstacles.find((o) => o.kind === "star")!;
    expect(300 - star.x).toBeCloseTo((300 - crate.x) * 1.7, 5);
  });
  it("speed rises with level and caps", () => {
    expect(arcadeSpeed(2)).toBeGreaterThan(arcadeSpeed(1));
    expect(arcadeSpeed(99)).toBe(250);
    expect(arcadeSpeed(1)).toBeGreaterThan(0);
  });
});

describe("dodging and damage", () => {
  it("standing into a crate costs one heart and grants invulnerability", () => {
    const after = stepArcade(facing("crate"), 16);
    expect(after.hearts).toBe(2);
    expect(after.invulnerableMs).toBeGreaterThan(0);
  });
  it("ducking passes under stars and beams unharmed", () => {
    for (const kind of ["star", "beam"] as const) {
      const ducked = applyArcadeInput(facing(kind), "duck", true);
      expect(stepArcade(ducked, 16).hearts).toBe(3);
    }
  });
  it("standing into a star costs a heart - it must be ducked", () => {
    expect(stepArcade(facing("star"), 16).hearts).toBe(2);
  });
  it("a cleared hazard scores once it passes behind the runner", () => {
    const base = createArcadeState(W, 7);
    const passed = { ...base, spawnMs: 60000, obstacles: [obstacle("star", base.x - 30)] };
    const after = stepArcade(passed, 16);
    expect(after.score).toBe(35);
    expect(after.clears).toBe(1);
    expect(after.hearts).toBe(3);
  });
  it("invulnerability absorbs a second hit", () => {
    const after = stepArcade(facing("crate", { invulnerableMs: 500 }), 16);
    expect(after.hearts).toBe(3);
  });
  it("losing every heart ends the course and freezes input", () => {
    const lost = stepArcade(facing("crate", { hearts: 1 }), 16);
    expect(lost.phase).toBe("lost");
    expect(applyArcadeInput(lost, "jump", true)).toBe(lost);
  });
});

describe("crates are solid ground", () => {
  // Scale is 1 at W=400, so a crate's lid is exactly its 16px height above the floor.
  const LID = 16;
  const landed = (): ArcadeState => {
    const base = createArcadeState(W, 7);
    let s: ArcadeState = { ...base, spawnMs: 60000, jumpY: LID + 14, velocityY: -100, obstacles: [obstacle("crate", base.x + 12)] };
    for (let t = 0; t < 12 && !(s.velocityY === 0 && s.jumpY > 0); t++) s = stepArcade(s, 16);
    return s;
  };

  it("a descent that crosses the lid lands on it instead of falling through", () => {
    const after = landed();
    expect(after.jumpY).toBe(LID);
    expect(after.velocityY).toBe(0);
    expect(after.groundY).toBe(LID);
    expect(after.hearts).toBe(3);
  });
  it("running into the same crate from the side still costs a heart", () => {
    const base = createArcadeState(W, 7);
    const low = { ...base, spawnMs: 60000, jumpY: 4, velocityY: -100, obstacles: [obstacle("crate", base.x + 12)] };
    expect(stepArcade(low, 16).hearts).toBe(2);
  });
  it("a runner standing on the lid can jump again from up there", () => {
    const jumped = applyArcadeInput(landed(), "jump", true);
    expect(jumped.velocityY).toBe(350);
    expect(jumped.jumpY).toBeGreaterThan(LID);
  });
  it("the lid sliding out from underfoot drops him back to the floor", () => {
    let s = landed();
    for (let t = 0; t < 120 && s.jumpY > 0; t++) s = stepArcade(s, 16);
    expect(s.jumpY).toBe(0);
    expect(s.hearts).toBe(3);
  });
});

describe("hazards never arrive on top of each other", () => {
  it("every spawned hazard reaches the runner at least 0.9s after the last one", () => {
    let s: ArcadeState = { ...createArcadeState(900, 11), hearts: 9999 };
    const arrivals: number[] = [];
    const seen = new Set<number>();
    for (let t = 0; t < 12000; t++) {
      s = stepArcade(s, 16);
      if (s.mode === "flycatch") { s = stepArcade({ ...s, bonus: { ...s.bonus!, remainingMs: 1 } }, 16); continue; }
      for (const o of s.obstacles) {
        if (seen.has(o.id)) continue;
        seen.add(o.id);
        // Arrival is distance over the kind's own speed: a star covers ground 1.7x faster, which is
        // exactly how one used to land on a ground hazard already in flight.
        arrivals.push(s.elapsedMs + (o.x - (s.x + 60)) / (arcadeSpeed(s.level) * (o.kind === "star" ? 1.7 : 1)) * 1000);
      }
    }
    expect(arrivals.length).toBeGreaterThan(40);
    const sorted = [...arrivals].sort((a, b) => a - b);
    const gaps = sorted.slice(1).map((at, i) => at - sorted[i]!);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(900);
  });
});

describe("striking pots and targets", () => {
  it("a punch shatters the flower pot into debris and scores 40", () => {
    const armed = applyArcadeInput(facing("pot"), "punch", true);
    expect(armed.attack).toBe("punch");
    const after = stepArcade(armed, 16);
    expect(after.score).toBe(40);
    expect(after.clears).toBe(1);
    expect(after.hearts).toBe(3);
    expect(after.debris.length).toBeGreaterThan(0);
  });
  it("a kick breaks the target for 30 with longer reach", () => {
    const base = createArcadeState(W, 7);
    const far = { ...base, spawnMs: 60000, obstacles: [obstacle("target", base.x + 55)] };
    const kicked = applyArcadeInput(far, "kick", true); // the mount layer maps Down + Ctrl to this action
    expect(kicked.attack).toBe("kick");
    const after = stepArcade(kicked, 16);
    expect(after.score).toBe(30);
    expect(after.debris.length).toBeGreaterThan(0);
  });
  it("attacks respect the cooldown", () => {
    const first = applyArcadeInput(facing("pot"), "punch", true);
    const second = applyArcadeInput({ ...first, attack: null }, "punch", true);
    expect(second.attack).toBeNull();
  });
});

describe("the flycatch bonus round", () => {
  it("unlocks after five clears, clears the course, and never deals damage", () => {
    const base = createArcadeState(W, 7);
    const primed = { ...base, spawnMs: 60000, clears: 4, obstacles: [obstacle("star", base.x - 30)] };
    const bonus = stepArcade(primed, 16);
    expect(bonus.mode).toBe("flycatch");
    expect(bonus.bonus).not.toBeNull();
    expect(bonus.obstacles.length).toBe(0);
    expect(stepArcade(bonus, 100).hearts).toBe(3);
    expect(bonus.nextBonusAt).toBe(10);
  });
  it("a pinch on the fly scores 50 and repositions it; a miss only spends the cooldown", () => {
    let s = stepArcade({ ...facing("star", { clears: 5, obstacles: [] }) }, 16);
    expect(s.mode).toBe("flycatch");
    const aimTrue = { ...s, bonus: { ...s.bonus!, aimX: s.bonus!.flyX, aimY: s.bonus!.flyY, cooldownMs: 0 } };
    const caught = applyArcadeInput(aimTrue, "punch", true);
    expect(caught.score - aimTrue.score).toBe(50);
    expect(caught.bonus!.caught).toBe(1);
    expect(caught.bonus!.flyX === aimTrue.bonus!.flyX && caught.bonus!.flyY === aimTrue.bonus!.flyY).toBe(false);
    const aimFalse = { ...s, bonus: { ...s.bonus!, aimX: 24, aimY: 24, flyX: s.width - 24, flyY: 145, cooldownMs: 0 } };
    const missed = applyArcadeInput(aimFalse, "punch", true);
    expect(missed.score).toBe(aimFalse.score);
    expect(missed.bonus!.cooldownMs).toBeGreaterThan(0);
  });
  it("the bonus expires back into the course with a fair grace window", () => {
    let s = stepArcade({ ...facing("star", { clears: 5, obstacles: [] }) }, 16);
    s = { ...s, bonus: { ...s.bonus!, remainingMs: 10 } };
    const back = stepArcade(s, 32);
    expect(back.mode).toBe("runner");
    expect(back.bonus).toBeNull();
    expect(back.invulnerableMs).toBeGreaterThan(0);
    expect(back.score).toBe(s.score); // earned catches were already banked at pinch time
  });
});
