// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/viz_cast.test.ts - P-WORLDS.CAST1 (ADR-0649): mixed world seeds and balanced fleet casting.

import { describe, expect, test } from "bun:test";
import {
  CastBook, castGroupOf, FACE_VARIANTS, HAIR_COLORS, HAIR_STYLES, hairStylesFor, mix32, nodeSeed, SKIN_RAMP, worldSeed,
} from "./viz_cast.ts";
import type { WorldAppearance } from "./viz_world_api.ts";

const DEMO = ["demo-1", "demo-2", "demo-3", "demo-4", "demo-5", "demo-6"];
const luma = (hex: string): number => {
  const v = parseInt(hex.slice(1), 16);
  return 0.299 * ((v >> 16) & 255) + 0.587 * ((v >> 8) & 255) + 0.114 * (v & 255);
};
const cast = (ids: readonly string[], book = new CastBook()): WorldAppearance[] => ids.map((id) => book.appearanceFor(id, "human")!);
const FLEETS: readonly ((i: number) => string)[] = [
  (i) => `demo-${i + 1}`,
  (i) => `lane-${i}`,
  (i) => `${(i * 7919 + 13).toString(36)}-agent`,
  (i) => (i === 0 ? "main" : `run:${i}:sub`),
];

describe("worldSeed", () => {
  test("mix32 is the murmur3 finalizer over a golden-ratio offset (unchanged from viz_anime_pose)", () => {
    expect(mix32(1 - 0x9e3779b9)).toBe(1364076727); // fmix32(1)
    expect(mix32(0)).toBe(2462723854);
  });

  test("the scene hash is unchanged (Anime and Office read it)", () => {
    expect(nodeSeed("demo-1")).toBe(582137230);
    expect(nodeSeed("main")).toBe(9808448);
    expect(DEMO.map(nodeSeed)).toEqual([582137230, 582137231, 582137232, 582137233, 582137234, 582137235]);
  });

  test("demo-1 to demo-6: the raw hash rolled one v1 look, worldSeed rolls six skins and every hair", () => {
    const raw = DEMO.map(nodeSeed);
    expect(new Set(raw.map((s) => (s >>> 9) % 6)).size).toBe(1); // the v1 bug (audit 1.1)
    expect(new Set(raw.map((s) => (s >>> 13) % 5)).size).toBe(1);
    const mixed = raw.map(worldSeed);
    expect(new Set(mixed.map((s) => (s >>> 9) % 6)).size).toBe(6);
    expect(new Set(mixed.map((s) => (s >>> 13) % 5)).size).toBe(5);
    for (const s of mixed) expect(Number.isInteger(s) && s >= 0 && s < 4294967296).toBe(true);
  });
});

describe("palettes", () => {
  test("SKIN_RAMP: ten tones, light to deep, bands in order", () => {
    expect(SKIN_RAMP.length).toBe(10);
    for (let i = 1; i < SKIN_RAMP.length; i++) expect(luma(SKIN_RAMP[i]!.hex)).toBeLessThan(luma(SKIN_RAMP[i - 1]!.hex));
    const order = { light: 0, medium: 1, dark: 2 } as const;
    for (let i = 1; i < SKIN_RAMP.length; i++) expect(order[SKIN_RAMP[i]!.band]).toBeGreaterThanOrEqual(order[SKIN_RAMP[i - 1]!.band]);
    expect(new Set(SKIN_RAMP.map((s) => s.band))).toEqual(new Set(["light", "medium", "dark"]));
  });

  test("HAIR_COLORS: eight, black to platinum", () => {
    expect(HAIR_COLORS.length).toBe(8);
    for (let i = 1; i < HAIR_COLORS.length; i++) expect(luma(HAIR_COLORS[i]!)).toBeGreaterThan(luma(HAIR_COLORS[i - 1]!));
  });

  test("HAIR_STYLES: the shared vocabulary, every presentation has choices", () => {
    expect(HAIR_STYLES.map((h) => h.id)).toEqual(["short", "buzz", "curls", "coils", "afro", "puffs", "locs", "braids", "long", "wavy", "bob", "pixie", "bun", "ponytail", "headscarf", "hijab"]);
    for (const p of ["feminine", "masculine", "neutral"] as const) expect(hairStylesFor(p).length).toBeGreaterThanOrEqual(6);
    expect(hairStylesFor("masculine")).not.toContain("hijab");
    expect(hairStylesFor("masculine")).not.toContain("headscarf");
  });
});

describe("CastBook", () => {
  test("any 6 consecutive figures: at least 2 feminine, 2 masculine, and light, medium and dark skin (fleets of 1 to 24)", () => {
    for (const name of FLEETS) {
      for (let n = 1; n <= 24; n++) {
        const a = cast(Array.from({ length: n }, (_, i) => name(i)));
        for (let s = 0; s + 6 <= n; s++) {
          const w = a.slice(s, s + 6);
          expect(w.filter((x) => x.presentation === "feminine").length).toBeGreaterThanOrEqual(2);
          expect(w.filter((x) => x.presentation === "masculine").length).toBeGreaterThanOrEqual(2);
          expect(new Set(w.map((x) => x.skinBand))).toEqual(new Set(["light", "medium", "dark"]));
        }
        // smaller fleets: from 3 figures on, both a feminine and a masculine one
        if (n >= 3 && n < 6) {
          expect(a.some((x) => x.presentation === "feminine")).toBe(true);
          expect(a.some((x) => x.presentation === "masculine")).toBe(true);
        }
      }
    }
  });

  test("every attribute is in range and consistent with the ramp", () => {
    for (const x of cast(Array.from({ length: 60 }, (_, i) => `lane-${i}`))) {
      expect(x.skin).toBe(SKIN_RAMP[x.skinIndex]!.hex);
      expect(x.skinBand).toBe(SKIN_RAMP[x.skinIndex]!.band);
      expect([0, 1, 2, 3]).toContain(x.body);
      expect(Number.isInteger(x.face) && x.face >= 0 && x.face < FACE_VARIANTS).toBe(true);
      expect(HAIR_COLORS).toContain(x.hairColor);
    }
  });

  test("hair style always suits the presentation", () => {
    const seen = new Set<string>();
    for (const x of cast(Array.from({ length: 200 }, (_, i) => `agent-${i}`))) {
      expect(hairStylesFor(x.presentation)).toContain(x.hair);
      expect(HAIR_STYLES.find((h) => h.id === x.hair)!.suits).toContain(x.presentation);
      seen.add(x.hair);
    }
    expect(seen.size).toBeGreaterThanOrEqual(12); // the vocabulary is actually used, not one style per presentation
  });

  test("stable: a node keeps its look as others join and leave", () => {
    const book = new CastBook();
    const before = cast(["main", "demo-1", "demo-2"], book);
    cast(["demo-3", "demo-4", "demo-5"], book);
    book.release("main");
    book.release("demo-2");
    expect(book.appearanceFor("demo-1", "human")).toBe(before[1]!);
    cast(["demo-6", "demo-7"], book);
    expect(book.appearanceFor("main", "human")).toEqual(before[0]!); // back after a release: same look
    expect(book.appearanceFor("demo-2", "human")).toEqual(before[2]!);
    book.release("demo-1");
    expect(book.appearanceFor("demo-1", "human")).toEqual(before[1]!);
  });

  test("a released slot stays reserved: the next node does not take its look", () => {
    const a = new CastBook();
    const b = new CastBook();
    const ids = ["main", "demo-1", "demo-2", "demo-3"];
    cast(ids, a);
    a.release("demo-1");
    const full = cast([...ids, "demo-4"], b);
    expect(a.appearanceFor("demo-4", "human")).toEqual(full[4]!);
  });

  test("deterministic: the same id order casts the same fleet", () => {
    for (const name of FLEETS) {
      const ids = Array.from({ length: 12 }, (_, i) => name(i));
      expect(cast(ids)).toEqual(cast(ids));
    }
  });

  test("different fleets start at different places in the sequence", () => {
    const starts = new Set(Array.from({ length: 30 }, (_, i) => {
      const x = new CastBook().appearanceFor(`fleet-${i}-main`, "human")!;
      return `${x.presentation}/${x.skinIndex}`;
    }));
    expect(starts.size).toBeGreaterThan(5);
  });

  test("clear starts a new cast", () => {
    const book = new CastBook();
    const first = cast(["x-1", "x-2"], book);
    book.clear();
    const again = cast(["x-2", "x-1"], book);
    expect(again).toEqual(cast(["x-2", "x-1"]));
    expect(cast(["x-1", "x-2"])).toEqual(first);
  });

  test("creature roles get no appearance and take no slot", () => {
    expect(castGroupOf(undefined, "hub")).toBe("human");
    expect(castGroupOf({ subagent: "creature" }, "subagent")).toBe("creature");
    expect(castGroupOf({ subagent: "creature" }, "agent")).toBe("human");
    expect(castGroupOf({ hub: "human" }, "hub")).toBe("human");
    const withCreatures = new CastBook();
    const plain = new CastBook();
    expect(withCreatures.appearanceFor("main", "human")).toEqual(plain.appearanceFor("main", "human")!);
    expect(withCreatures.appearanceFor("reindeer-1", "creature")).toBeNull();
    expect(withCreatures.appearanceFor("reindeer-2", "creature")).toBeNull();
    expect(withCreatures.appearanceFor("demo-1", "human")).toEqual(plain.appearanceFor("demo-1", "human")!);
  });

  test("hub, agents and subagents share one balanced sequence", () => {
    const ids = ["main", "demo-1", "demo-2", "main:sub-1", "demo-3", "demo-1:sub-1"];
    const a = cast(ids);
    expect(a.filter((x) => x.presentation === "feminine").length).toBeGreaterThanOrEqual(2);
    expect(a.filter((x) => x.presentation === "masculine").length).toBeGreaterThanOrEqual(2);
  });
});
