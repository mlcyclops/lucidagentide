// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// mascot_season.ts (P-SEASON.1, ADR-0525): every season's act plays real body frames with real props,
// the costume keeps the face readable, and an act is a pure function of t.

import { describe, expect, it } from "bun:test";
import { MASCOT_FRAMES, MASCOT_PALETTE, MASCOT_THEMES } from "./mascot.ts";
import { PROP_PALETTE, SEASON_SPRITES, headAnchor, seasonActAt, seasonActMs, seasonCostumePieces, seasonPalette } from "./mascot_season.ts";
import { SEASONS } from "./seasons.ts";

const STEP = 17; // off-beat sampling so no beat boundary is skipped by a round step

describe("acts - real frames, real props, sane length", () => {
  it("every season's act lasts 1.8 to 3.6 s", () => {
    for (const s of SEASONS) {
      const ms = seasonActMs(s.id);
      expect(ms).toBeGreaterThanOrEqual(1800);
      expect(ms).toBeLessThanOrEqual(3600);
    }
  });
  it("every t across every act names a MASCOT_FRAMES key and only existing sprites", () => {
    for (const s of SEASONS) {
      for (let t = 0; t < seasonActMs(s.id); t += STEP) {
        const a = seasonActAt(s.id, t);
        expect(a.frame in MASCOT_FRAMES).toBe(true);
        for (const p of a.props) {
          expect(p.sprite in SEASON_SPRITES).toBe(true);
          expect(Number.isInteger(p.x) && Number.isInteger(p.y)).toBe(true);
        }
      }
    }
  });
  it("each act actually performs: several body frames and props on screen", () => {
    for (const s of SEASONS) {
      const frames = new Set<string>();
      let withProps = 0, samples = 0;
      for (let t = 0; t < seasonActMs(s.id); t += STEP) {
        const a = seasonActAt(s.id, t);
        frames.add(a.frame);
        samples++;
        if (a.props.length > 0) withProps++;
      }
      expect(frames.size).toBeGreaterThanOrEqual(3);
      expect(withProps / samples).toBeGreaterThan(0.4);
    }
  });
  it("is pure: the same t gives the same frame, lift and props, regardless of call order", () => {
    for (const s of SEASONS) {
      const ms = seasonActMs(s.id);
      const probes = [0, ms * 0.37, ms * 0.81, ms - 1];
      const first = probes.map((t) => JSON.stringify(seasonActAt(s.id, t)));
      const again = [...probes].reverse().map((t) => JSON.stringify(seasonActAt(s.id, t))).reverse();
      expect(again).toEqual(first);
    }
  });
  it("clamps t into the act: before start = start, past the end = the last moment", () => {
    for (const s of SEASONS) {
      const ms = seasonActMs(s.id);
      expect(seasonActAt(s.id, -500)).toEqual(seasonActAt(s.id, 0));
      expect(seasonActAt(s.id, ms + 9999)).toEqual(seasonActAt(s.id, ms - 1));
      expect(seasonActAt(s.id, Number.NaN)).toEqual(seasonActAt(s.id, 0));
    }
  });
  it("the Super Bowl football is whole before the cut and in two halves after it", () => {
    const sprites = (t: number): string[] => seasonActAt("super-bowl", t).props.map((p) => p.sprite);
    expect(sprites(400).some((n) => n.startsWith("FOOTBALL") && !/_[LR]$/.test(n))).toBe(true);
    const after = sprites(1700);
    expect(after).toContain("FOOTBALL_L");
    expect(after).toContain("FOOTBALL_R");
    const l = seasonActAt("super-bowl", 1700).props.find((p) => p.sprite === "FOOTBALL_L")!;
    const r = seasonActAt("super-bowl", 1700).props.find((p) => p.sprite === "FOOTBALL_R")!;
    expect(r.x - l.x).toBeGreaterThan(SEASON_SPRITES.FOOTBALL_L![0]!.length); // they fell apart
  });
  it("Juneteenth's jump lifts the body and comes back down to the ground", () => {
    const lifts: number[] = [];
    for (let t = 0; t < seasonActMs("juneteenth"); t += STEP) lifts.push(seasonActAt("juneteenth", t).lift);
    expect(Math.max(...lifts)).toBeGreaterThanOrEqual(6);
    expect(lifts[0]).toBe(0);
    expect(lifts[lifts.length - 1]).toBe(0);
  });
});

describe("sprites - well-formed pixel grids", () => {
  it("every sprite is a non-empty rectangle over prop palette chars", () => {
    for (const [name, rows] of Object.entries(SEASON_SPRITES)) {
      expect(rows.length).toBeGreaterThan(0);
      const w = rows[0]!.length;
      expect(w).toBeGreaterThan(0);
      for (const r of rows) {
        expect(r.length).toBe(w);
        for (const c of r) if (c !== ".") expect(c in PROP_PALETTE ? c : `${name}:${c}`).toBe(c);
      }
    }
  });
  it("costume pieces exist as sprites", () => {
    for (const s of SEASONS) for (const p of seasonCostumePieces(s.id)) expect(p in SEASON_SPRITES).toBe(true);
  });
});

describe("headAnchor - hats ride the hood on every frame", () => {
  it("finds the hood top near the top of the box and roughly centered, for every body frame", () => {
    for (const f of Object.keys(MASCOT_FRAMES)) {
      const a = headAnchor(f);
      const grid = MASCOT_FRAMES[f]!;
      expect(a.y).toBeLessThanOrEqual(6);
      expect(a.x).toBeGreaterThanOrEqual(12);
      expect(a.x).toBeLessThanOrEqual(24);
      expect(grid[a.y]![a.x]).not.toBe("."); // the anchor is ON the hood, not in the air
    }
  });
  it("follows the head when a frame drops it (action frames sit a row lower than idle)", () => {
    expect(headAnchor("guard").y).toBeGreaterThan(headAnchor("idleA").y);
  });
});

describe("seasonPalette - costume colors, face untouched", () => {
  it("null is the base palette itself", () => {
    expect(seasonPalette(null, MASCOT_PALETTE)).toBe(MASCOT_PALETTE);
  });
  it("keeps skin, eyes, steel and ink, and changes the accent, for every season and base", () => {
    for (const base of [MASCOT_PALETTE, MASCOT_THEMES.ember.palette]) {
      for (const s of SEASONS) {
        const p = seasonPalette(s.id, base);
        for (const k of ["S", "s", "W", "B", "M", "k"]) expect(p[k]).toBe(base[k]);
        expect(p.G).not.toBe(MASCOT_PALETTE.G);
        expect(p.K).not.toBe(MASCOT_PALETTE.K);
      }
    }
  });
  it("is cached per base, so per-frame calls do not allocate a new palette", () => {
    expect(seasonPalette("christmas", MASCOT_PALETTE)).toBe(seasonPalette("christmas", MASCOT_PALETTE));
  });
});
