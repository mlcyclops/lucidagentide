// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-MASCOT.4: the run-only arcade engine, pure and deterministic. These tests drive the REAL
// exported transitions (createArcadeState / applyArcadeInput / stepArcade) - no mocks, no DOM.

import { describe, expect, it } from "bun:test";
import {
  ARCADE_FLOOR_Y, applyArcadeInput, arcadeMetrics, arcadeRunnerBox, arcadeSpeed, arcadeSpriteRect,
  createArcadeState, setArcadeMascotSize, stepArcade,
  type ArcadeObstacle, type ArcadeState,
} from "./mascot_game.ts";
import { MASCOT_H, MASCOT_W } from "./mascot.ts";
import type { MascotSize } from "./mini_lucid.ts";

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
  for (const size of ["large", "small"] as const) it(`every spawned hazard reaches the ${size} runner at least 0.9s after the last one`, () => {
    const { scale, motion } = arcadeMetrics(900, size);
    let s: ArcadeState = { ...createArcadeState(900, 11, size), hearts: 9999 };
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
        arrivals.push(s.elapsedMs + (o.x - (s.x + 30 * scale)) / (arcadeSpeed(s.level) * motion * (o.kind === "star" ? 1.7 : 1)) * 1000);
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

// P-MINI.3 (ADR-0596): the course at both ninja sizes. A wide panel is where they differ (classic paints
// 2x there, small paints mini Lucid's 1x), so every case runs at WIDE.
const WIDE = 640;
const SIZES: readonly MascotSize[] = ["small", "large"];

describe("ninja size metrics", () => {
  it("large keeps the classic scale and speed; small is half of it on a wide panel", () => {
    expect(arcadeMetrics(WIDE, "large")).toEqual({ scale: 2, motion: 1 });
    expect(arcadeMetrics(WIDE, "small")).toEqual({ scale: 1, motion: 0.5 });
  });
  it("on a narrow panel both sizes paint one pixel per cell, so small never goes sub-pixel", () => {
    expect(arcadeMetrics(W, "large")).toEqual({ scale: 1, motion: 1 });
    expect(arcadeMetrics(W, "small")).toEqual({ scale: 1, motion: 1 });
  });
  it("on a narrow panel the two sizes play the identical course", () => {
    const run = (size: MascotSize) => {
      let s = createArcadeState(W, 42, size);
      for (let t = 0; t < 200; t++) {
        if (t === 10) s = applyArcadeInput(s, "jump", true);
        s = stepArcade(s, 16);
      }
      return { ...s, size: "x" };
    };
    expect(run("small")).toEqual(run("large"));
  });
});

for (const size of SIZES) {
  describe(`the course at ${size} size`, () => {
    const { scale, motion } = arcadeMetrics(WIDE, size);
    const sized = (kind: ArcadeObstacle["kind"], x: number): ArcadeObstacle => {
      const o = obstacle(kind, x);
      return { ...o, width: o.width * scale, height: o.height * scale, bottom: o.bottom * scale };
    };
    const base = (): ArcadeState => ({ ...createArcadeState(WIDE, 7, size), spawnMs: 60000 });
    const box = arcadeRunnerBox(base());
    const at = (kind: ArcadeObstacle["kind"], x: number, overrides: Partial<ArcadeState> = {}): ArcadeState =>
      ({ ...base(), obstacles: [sized(kind, x)], ...overrides });
    const steps = (s: ArcadeState, n: number): ArcadeState => {
      for (let t = 0; t < n; t++) s = stepArcade(s, 16);
      return s;
    };

    it("spawns hazards at the size's scale", () => {
      let s = createArcadeState(WIDE, 3, size);
      for (let t = 0; t < 200 && !s.obstacles.length; t++) s = stepArcade(s, 16);
      const first = s.obstacles[0]!;
      expect(first.kind).toBe("crate");
      expect(first.width).toBe(26 * scale);
      expect(first.height).toBe(16 * scale);
    });
    it("the sprite stands on the floor, and on a crate lid, never floating or sunk", () => {
      const floor = arcadeSpriteRect(base());
      expect(floor.y + floor.h).toBe(ARCADE_FLOOR_Y);
      expect(floor.w).toBe(MASCOT_W * scale);
      expect(floor.h).toBe(MASCOT_H * scale);
      expect(box.bottom).toBe(0);
      expect(box.left).toBeGreaterThanOrEqual(floor.x);
      expect(box.right).toBeLessThanOrEqual(floor.x + floor.w);
      expect(box.top).toBeLessThanOrEqual(floor.h);
      const lid = 16 * scale;
      const onLid = arcadeSpriteRect({ ...base(), jumpY: lid, groundY: lid });
      expect(onLid.y + onLid.h).toBe(ARCADE_FLOOR_Y - lid);
    });
    it("a jump rises about half his height and stays up the same time at either size", () => {
      let s = applyArcadeInput(base(), "jump", true);
      let peak = 0;
      let n = 0;
      for (; n < 100 && (s.jumpY > 0 || s.velocityY !== 0); n++) {
        s = stepArcade(s, 16);
        peak = Math.max(peak, s.jumpY);
      }
      expect(peak / (MASCOT_H * scale)).toBeCloseTo(0.535, 1);
      expect(n).toBeGreaterThanOrEqual(38);
      expect(n).toBeLessThanOrEqual(42);
    });
    it("a clean jump clears the crate and scores it", () => {
      let s = applyArcadeInput(at("crate", box.right + arcadeSpeed(1) * motion * 0.2), "jump", true);
      for (let t = 0; t < 300 && !s.clears; t++) s = stepArcade(s, 16);
      expect(s.hearts).toBe(3);
      expect(s.score).toBe(20);
    });
    it("running into a crate still costs a heart", () => {
      expect(stepArcade(at("crate", box.left + 2 * scale), 16).hearts).toBe(2);
    });
    it("ducking passes under stars and beams; standing into a star is a hit", () => {
      for (const kind of ["star", "beam"] as const) {
        expect(stepArcade(applyArcadeInput(at(kind, box.left + 2 * scale), "duck", true), 16).hearts).toBe(3);
      }
      expect(stepArcade(at("star", box.left + 2 * scale), 16).hearts).toBe(2);
    });
    it("a punch in reach shatters the pot; a kick reaches the farther target", () => {
      expect(stepArcade(applyArcadeInput(at("pot", box.right + 5 * scale), "punch", true), 16).score).toBe(40);
      expect(stepArcade(applyArcadeInput(at("target", box.right + 25 * scale), "kick", true), 16).score).toBe(30);
    });
    it("a punch out of reach whiffs, and the pot then still hits him", () => {
      let s = steps(applyArcadeInput(at("pot", box.right + 35 * scale), "punch", true), 15);
      expect(s.score).toBe(0);
      expect(s.obstacles[0]!.handled).toBe(false);
      for (let t = 0; t < 300 && s.hearts === 3; t++) s = stepArcade(s, 16);
      expect(s.hearts).toBe(2);
      expect(s.score).toBe(0);
    });
  });
}

describe("switching the ninja size mid-run", () => {
  it("returns the same state when the size is unchanged", () => {
    const s = createArcadeState(WIDE, 7, "large");
    expect(setArcadeMascotSize(s, "large")).toBe(s);
  });
  it("a runner standing on a crate lid stays on the rescaled lid, unharmed", () => {
    const large = createArcadeState(WIDE, 7, "large");
    const crate = obstacle("crate", large.x + 12);
    const standing: ArcadeState = {
      ...large, spawnMs: 60000, jumpY: 32, groundY: 32,
      obstacles: [{ ...crate, width: crate.width * 2, height: crate.height * 2 }],
    };
    expect(stepArcade(standing, 16).jumpY).toBe(32);
    const small = setArcadeMascotSize(standing, "small");
    expect(small.size).toBe("small");
    expect(small.obstacles[0]!.height).toBe(16);
    const after = stepArcade(small, 16);
    expect(after.jumpY).toBe(16);
    expect(after.groundY).toBe(16);
    expect(after.hearts).toBe(3);
  });
});
