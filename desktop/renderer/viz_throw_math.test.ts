// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/viz_throw_math.test.ts - P-VIZ.6 (ADR-0636): the throw math. Arcs start and end exactly on
// their points and peak at the apex halfway; the stars are a stream of three 150 ms apart; Storm hits every
// figure once, in the order the front reaches them, within its spread, with fewer strikes on lower tiers and no
// VFX under reduced motion; the projectile cap and Storm's cooldown hold; the armed state machine arms, toggles,
// throws only on a node and is put down by Esc or a style switch.

import { describe, expect, test } from "bun:test";
import {
  arcApex, arcPoint, armState, armStep, BOLT_LEAD_MS, createRateLimit, flightMs, launchPx, launchRoom, rateLeft, rateTake,
  STAR_COUNT, STAR_GAP_MS, STORM_COOLDOWN_MS, STORM_GAP_MS, STORM_LEAD_MS, STORM_SPREAD_MS, stormFx, stormSchedule, strikeTargets,
  THROW_CAP, volley, type ArmState, type V3,
} from "./viz_throw_math.ts";
import { THROWS, type ThrowKind } from "./viz_throw_kinds.ts";

const ALL: ThrowKind[] = ["paper", "band", "drink", "stars", "bolt", "orb"];
const v = (x: number, y: number, z: number): V3 => ({ x, y, z });

describe("flight", () => {
  test("an arc starts on the launch point and ends on the node", () => {
    const from = v(1, 2, 3), to = v(-4, 0.5, 7);
    const out = v(0, 0, 0);
    expect(arcPoint(from, to, 1.5, 0, out)).toEqual(from);
    expect(arcPoint(from, to, 1.5, 1, out)).toEqual(to);
  });

  test("the arc peaks at the apex halfway, above the straight line", () => {
    const from = v(0, 0, 0), to = v(10, 2, 0);
    const mid = arcPoint(from, to, 1.2, 0.5, v(0, 0, 0));
    expect(mid.x).toBeCloseTo(5);
    expect(mid.y).toBeCloseTo(1 + 1.2);
    // symmetric lift and nothing higher than the peak
    const a = arcPoint(from, to, 1.2, 0.25, v(0, 0, 0)), b = arcPoint(from, to, 1.2, 0.75, v(0, 0, 0));
    expect(a.y - 0.5).toBeCloseTo(b.y - 1.5);
    for (let u = 0; u <= 1; u += 0.05) expect(arcPoint(from, to, 1.2, u, v(0, 0, 0)).y - 2 * u).toBeLessThanOrEqual(1.2 + 1e-9);
  });

  test("u outside 0..1 clamps (a late frame never overshoots the node)", () => {
    const from = v(0, 0, 0), to = v(3, 0, 0);
    expect(arcPoint(from, to, 1, 1.4, v(0, 0, 0))).toEqual(to);
    expect(arcPoint(from, to, 1, -0.3, v(0, 0, 0))).toEqual(from);
  });

  test("arcPoint writes into and returns its out argument", () => {
    const out = v(9, 9, 9);
    expect(arcPoint(v(0, 0, 0), v(1, 1, 1), 0, 0.5, out)).toBe(out);
  });

  test("the bolt strikes from above: no arc, a short lead; everything else flies longer with distance", () => {
    expect(arcApex("bolt", 20)).toBe(0);
    expect(flightMs("bolt", 50)).toBe(BOLT_LEAD_MS);
    for (const k of ALL.filter((x) => x !== "bolt")) {
      expect(arcApex(k, 10)).toBeGreaterThan(0);
      expect(flightMs(k, 12)).toBeGreaterThan(flightMs(k, 2));
      expect(flightMs(k, 1e6)).toBeLessThan(1500); // capped: a far node is still a throw, not a wait
    }
    expect(arcApex("paper", 10)).toBeGreaterThan(arcApex("stars", 10)); // a lob vs a flat throw
    expect(arcApex("paper", 1e6)).toBeLessThanOrEqual(2.5);
  });
});

describe("volleys", () => {
  test("the stars are a stream of three, STAR_GAP_MS apart; everything else is one", () => {
    const stars = volley("stars");
    expect(stars.length).toBe(STAR_COUNT);
    expect(STAR_COUNT).toBe(3);
    expect(stars).toEqual([0, STAR_GAP_MS, 2 * STAR_GAP_MS]);
    for (const k of ALL.filter((x) => x !== "stars")) expect(volley(k)).toEqual([0]);
  });

  test("a launch starts bottom center; a stream spreads symmetrically around it", () => {
    expect(launchPx(800, 600, 0, 1)).toEqual({ x: 400, y: 600 * 0.97 });
    const xs = [0, 1, 2].map((i) => launchPx(800, 600, i, 3).x);
    expect(xs[1]).toBe(400);
    expect(xs[0]! < 400 && xs[2]! > 400).toBe(true);
    expect(400 - xs[0]!).toBeCloseTo(xs[2]! - 400);
  });

  test("the projectile cap: a volley is trimmed to the room left, never negative", () => {
    expect(launchRoom(0, 3)).toBe(3);
    expect(launchRoom(THROW_CAP - 2, 3)).toBe(2);
    expect(launchRoom(THROW_CAP, 3)).toBe(0);
    expect(launchRoom(THROW_CAP + 5, 1)).toBe(0);
  });
});

describe("storm", () => {
  const pts = [
    { id: "c", x: 4, z: 0 }, { id: "a", x: -3, z: 1 }, { id: "b", x: 0, z: -2 }, { id: "d", x: 0, z: 5 },
  ];

  test("every figure is hit once, in the order the front reaches them along its direction", () => {
    const s = stormSchedule(pts, { x: 1, z: 0 });
    expect(s.map((h) => h.id)).toEqual(["a", "b", "d", "c"]); // b and d tie on x: by id
    expect(new Set(s.map((h) => h.id)).size).toBe(pts.length);
    const back = stormSchedule(pts, { x: -1, z: 0 });
    expect(back.map((h) => h.id)).toEqual(["c", "b", "d", "a"]);
  });

  test("the stagger starts after the lead, rises strictly and stays within the spread", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ id: `n${i}`, x: i, z: 0 }));
    for (const list of [pts, many]) {
      const s = stormSchedule(list, { x: 1, z: 0 });
      expect(s[0]!.at).toBe(STORM_LEAD_MS);
      for (let i = 1; i < s.length; i++) {
        expect(s[i]!.at).toBeGreaterThan(s[i - 1]!.at);
        expect(s[i]!.at - s[i - 1]!.at).toBeLessThanOrEqual(STORM_GAP_MS + 1);
      }
      expect(s[s.length - 1]!.at - STORM_LEAD_MS).toBeLessThanOrEqual(STORM_SPREAD_MS);
    }
    expect(stormSchedule([], { x: 1, z: 0 })).toEqual([]);
    expect(stormSchedule([{ id: "solo", x: 0, z: 0 }], { x: 1, z: 0 })).toEqual([{ id: "solo", at: STORM_LEAD_MS }]);
  });

  test("the schedule does not reorder its input", () => {
    const copy = pts.map((p) => ({ ...p }));
    stormSchedule(pts, { x: 0, z: 1 });
    expect(pts).toEqual(copy);
  });

  test("fewer strikes and papers on lower tiers, none under reduced motion", () => {
    const f = stormFx("full", true), r = stormFx("reduced", true), m = stormFx("minimal", true);
    expect(f.strikes).toBeGreaterThan(r.strikes);
    expect(r.strikes).toBeGreaterThan(m.strikes);
    expect(m.strikes).toBeGreaterThanOrEqual(1);
    expect(f.papers).toBeGreaterThan(r.papers);
    expect(r.papers).toBeGreaterThan(m.papers);
    for (const t of ["full", "reduced", "minimal"] as const) expect(stormFx(t, false)).toEqual({ strikes: 0, papers: 0, sparks: 0 });
  });

  test("strikes land on distinct figures spread across the schedule, never more than there are", () => {
    expect(strikeTargets(10, 6)).toEqual([0, 2, 4, 5, 7, 9]);
    expect(strikeTargets(3, 6)).toEqual([0, 1, 2]);
    expect(strikeTargets(5, 1)).toEqual([2]);
    expect(strikeTargets(0, 6)).toEqual([]);
    expect(strikeTargets(4, 0)).toEqual([]);
    for (let n = 1; n < 30; n++) for (let k = 1; k <= 8; k++) {
      const t = strikeTargets(n, k);
      expect(t.length).toBe(Math.min(n, k));
      expect(new Set(t).size).toBe(t.length);
      for (let i = 1; i < t.length; i++) expect(t[i]!).toBeGreaterThan(t[i - 1]!);
      expect(t.every((i) => i >= 0 && i < n)).toBe(true);
    }
  });

  test("Storm's cooldown: once per STORM_COOLDOWN_MS, the first take always allowed", () => {
    const r = createRateLimit(STORM_COOLDOWN_MS);
    expect(rateLeft(r, 0)).toBe(0);
    expect(rateTake(r, 1000)).toBe(true);
    expect(rateTake(r, 1000 + STORM_COOLDOWN_MS - 1)).toBe(false);
    expect(rateLeft(r, 2000)).toBe(STORM_COOLDOWN_MS - 1000);
    expect(rateTake(r, 1000 + STORM_COOLDOWN_MS)).toBe(true);
    // a refused take does not restart the cooldown
    expect(rateTake(r, 1000 + STORM_COOLDOWN_MS + 10)).toBe(false);
    expect(rateTake(r, 1000 + 2 * STORM_COOLDOWN_MS)).toBe(true);
  });
});

describe("armed state", () => {
  const step = (s: ArmState, ...acts: Parameters<typeof armStep>[1][]): ArmState => acts.reduce((x, a) => armStep(x, a).state, s);

  test("arm, then a click on a node throws and stays armed; empty space throws nothing", () => {
    const s = step(armState("anime"), { type: "arm", kind: "bolt" });
    expect(s.armed).toBe("bolt");
    const hit = armStep(s, { type: "release", onNode: true });
    expect(hit.fire).toBe("bolt");
    expect(hit.state.armed).toBe("bolt");
    const miss = armStep(s, { type: "release", onNode: false });
    expect(miss.fire).toBeNull();
    expect(miss.state.armed).toBe("bolt");
  });

  test("nothing armed: a click on a node throws nothing (it opens the panel instead)", () => {
    expect(armStep(armState("professional"), { type: "release", onNode: true }).fire).toBeNull();
  });

  test("a second click on the armed throwable puts it down; another one switches", () => {
    const s = step(armState("professional"), { type: "arm", kind: "paper" });
    expect(step(s, { type: "arm", kind: "paper" }).armed).toBeNull();
    expect(step(s, { type: "arm", kind: "drink" }).armed).toBe("drink");
  });

  test("Esc disarms", () => {
    expect(step(armState("anime"), { type: "arm", kind: "orb" }, { type: "disarm" }).armed).toBeNull();
  });

  test("a style switch puts it down; the same style keeps it", () => {
    const s = step(armState("anime"), { type: "arm", kind: "stars" });
    const sw = step(s, { type: "style", style: "professional" });
    expect(sw).toEqual({ style: "professional", armed: null });
    expect(step(s, { type: "style", style: "anime" }).armed).toBe("stars");
  });

  test("arming a throwable the style does not offer is ignored", () => {
    for (const style of ["anime", "professional"] as const) {
      const offered = new Set(THROWS[style].map((t) => t.kind));
      for (const k of ALL) expect(step(armState(style), { type: "arm", kind: k }).armed).toBe(offered.has(k) ? k : null);
    }
  });
});
