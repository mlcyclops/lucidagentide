// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/viz_cast_prefs.test.ts - P-WORLDS.CAST2 (ADR-0650): cast preferences persist, migrate and
// validate, and a pinned look wins over the fleet mode and the balance (viz_cast.CastBook.setPrefs).

import { describe, expect, test } from "bun:test";
import { CastBook, HAIR_COLORS, HAIR_STYLES, HAIR_SWATCHES, hairStylesFor, SKIN_RAMP, SKIN_TONES, skinTone } from "./viz_cast.ts";
import {
  CAST_KEY, DEFAULT_FLEET, defaultCastPrefs, loadCastPrefs, parseCastPrefs, pinOf, PINS_MAX, saveCastPrefs, withFleet, withPin, type CastPrefs,
} from "./viz_cast_prefs.ts";

const memStore = (init?: Record<string, string>) => {
  const mem = new Map<string, string>(Object.entries(init ?? {}));
  return { mem, getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
};
const DEMO = ["main", "demo-1", "demo-2", "demo-3", "demo-4", "demo-5", "demo-6"];
const castAll = (prefs: CastPrefs | null, ids = DEMO) => {
  const book = new CastBook();
  book.setPrefs(prefs);
  return ids.map((id) => book.appearanceFor(id, "human")!);
};

describe("persistence", () => {
  test("migration: no key, bad JSON or an older shape is the default (Balanced fleet, nothing pinned)", () => {
    expect(loadCastPrefs(memStore())).toEqual(defaultCastPrefs());
    expect(loadCastPrefs(memStore({ [CAST_KEY]: "{not json" }))).toEqual(defaultCastPrefs());
    expect(loadCastPrefs(memStore({ [CAST_KEY]: "[1,2]" }))).toEqual(defaultCastPrefs());
    expect(defaultCastPrefs().fleet.mode).toBe("balanced");
    expect(defaultCastPrefs().pinned).toEqual({});
  });

  test("round trip through the storage key", () => {
    const s = memStore();
    let p = withFleet(defaultCastPrefs(), { mode: "same", skin: 7, undertone: "warm", hair: "locs", hairColor: HAIR_SWATCHES[9]!.value });
    p = withPin(p, "demo-2", { presentation: "feminine", skin: 1, undertone: "cool", hair: "bob", hairColor: HAIR_COLORS[6]! });
    p = withPin(p, "main", { skin: 9 });
    saveCastPrefs(s, p);
    expect(s.mem.has(CAST_KEY)).toBe(true);
    expect(JSON.parse(s.mem.get(CAST_KEY)!)).toEqual({
      fleet: { mode: "same", skin: 7, undertone: "warm", hair: "locs", hairColor: HAIR_SWATCHES[9]!.value },
      pinned: { "demo-2": { presentation: "feminine", skin: 1, undertone: "cool", hair: "bob", hairColor: HAIR_COLORS[6]! }, main: { skin: 9 } },
    });
    expect(loadCastPrefs(s)).toEqual(p);
  });

  test("validation: each field falls back on its own, no free hex, no unknown style, no style the pinned presentation does not wear", () => {
    const p = parseCastPrefs({
      fleet: { mode: "everyone", skin: 12, undertone: "warm", hair: "mohawk", hairColor: "#123456" },
      pinned: {
        a: { skin: 3.5, hairColor: "#ff00ff", hair: "afro" },
        b: { presentation: "masculine", hair: "hijab", skin: 2 },
        c: { nothing: 1 },
        d: "x",
        "": { skin: 1 },
      },
    });
    expect(p.fleet).toEqual({ ...DEFAULT_FLEET, undertone: "warm" });
    expect(pinOf(p, "a")).toEqual({ hair: "afro" });
    expect(pinOf(p, "b")).toEqual({ presentation: "masculine", skin: 2 });
    expect(pinOf(p, "c")).toBeNull();
    expect(pinOf(p, "d")).toBeNull();
    expect(pinOf(p, "")).toBeNull();
    expect(pinOf(p, "constructor")).toBeNull();
    // A stored "__proto__" lane id is only a key: it never becomes the map's prototype.
    const q = parseCastPrefs(JSON.parse(`{"pinned":{"__proto__":{"skin":4}}}`));
    expect(Object.getPrototypeOf(q.pinned)).toBe(Object.prototype);
    expect(pinOf(q, "__proto__")).toEqual({ skin: 4 });
    expect(pinOf(q, "toString")).toBeNull();
  });

  test("withPin replaces, removes and keeps the most recent PINS_MAX", () => {
    let p = withPin(defaultCastPrefs(), "x", { skin: 2 });
    p = withPin(p, "x", { hair: "buzz" });
    expect(pinOf(p, "x")).toEqual({ hair: "buzz" });
    expect(pinOf(withPin(p, "x", null), "x")).toBeNull();
    expect(pinOf(withPin(p, "x", {}), "x")).toBeNull();
    for (let i = 0; i < PINS_MAX + 5; i++) p = withPin(p, `lane-${i}`, { skin: i % 10 });
    expect(Object.keys(p.pinned).length).toBe(PINS_MAX);
    expect(pinOf(p, "lane-0")).toBeNull();
    expect(pinOf(p, `lane-${PINS_MAX + 4}`)).toEqual({ skin: (PINS_MAX + 4) % 10 });
  });

  test("values are frozen; a change returns new preferences", () => {
    const a = defaultCastPrefs();
    const b = withFleet(a, { undertone: "cool" });
    expect(a.fleet.undertone).toBe("neutral");
    expect(b.fleet.undertone).toBe("cool");
    expect(Object.isFrozen(b) && Object.isFrozen(b.fleet) && Object.isFrozen(b.pinned)).toBe(true);
  });
});

describe("ramps", () => {
  test("ten skin steps, each in warm, neutral and cool; neutral is the ramp itself and light to deep holds", () => {
    const luma = (hex: string): number => { const v = parseInt(hex.slice(1), 16); return 0.299 * ((v >> 16) & 255) + 0.587 * ((v >> 8) & 255) + 0.114 * (v & 255); };
    expect(SKIN_TONES.neutral).toEqual(SKIN_RAMP.map((s) => s.hex));
    for (const u of ["warm", "cool"] as const) {
      expect(SKIN_TONES[u].length).toBe(10);
      for (let i = 0; i < 10; i++) {
        expect(SKIN_TONES[u][i]).toMatch(/^#[0-9a-f]{6}$/);
        expect(SKIN_TONES[u][i]).not.toBe(SKIN_RAMP[i]!.hex);
        if (i) expect(luma(SKIN_TONES[u][i]!)).toBeLessThan(luma(SKIN_TONES[u][i - 1]!));
      }
    }
    expect(skinTone(3, "warm")).toBe(SKIN_TONES.warm[3]!);
  });

  test("hair colors: the eight natural steps, then six fashion colors", () => {
    expect(HAIR_SWATCHES.length).toBe(14);
    expect(HAIR_SWATCHES.slice(0, 8).map((s) => s.value)).toEqual([...HAIR_COLORS]);
    expect(HAIR_SWATCHES.filter((s) => s.fashion).length).toBe(6);
    expect(new Set(HAIR_SWATCHES.map((s) => s.value)).size).toBe(14);
    for (const s of HAIR_SWATCHES) expect(s.label.length).toBeGreaterThan(0);
  });
});

describe("CastBook with preferences", () => {
  test("default preferences cast exactly the balance", () => {
    expect(castAll(defaultCastPrefs())).toEqual(castAll(null));
  });

  test("a pinned look wins over the balance and touches nobody else", () => {
    const pinned = withPin(defaultCastPrefs(), "demo-3", { presentation: "masculine", skin: 0, undertone: "warm", hair: "buzz", hairColor: HAIR_SWATCHES[10]!.value });
    const base = castAll(null);
    const got = castAll(pinned);
    const i = DEMO.indexOf("demo-3");
    expect(got[i]).toEqual({ ...base[i]!, presentation: "masculine", skin: SKIN_TONES.warm[0]!, skinIndex: 0, skinBand: "light", hair: "buzz", hairColor: HAIR_SWATCHES[10]!.value });
    got.forEach((a, j) => { if (j !== i) expect(a).toEqual(base[j]!); });
  });

  test("Same for all: every figure takes the fleet's skin, hair style and hair color; a pin still wins", () => {
    let p = withFleet(defaultCastPrefs(), { mode: "same", skin: 6, undertone: "cool", hair: "braids", hairColor: HAIR_COLORS[4]! });
    p = withPin(p, "main", { skin: 2, hairColor: HAIR_COLORS[7]! });
    const base = castAll(null);
    const got = castAll(p);
    got.forEach((a, j) => {
      const isMain = DEMO[j] === "main";
      expect(a.skinIndex).toBe(isMain ? 2 : 6);
      expect(a.skin).toBe(SKIN_TONES.cool[isMain ? 2 : 6]!);
      expect(a.hair).toBe("braids");
      expect(a.hairColor).toBe(isMain ? HAIR_COLORS[7]! : HAIR_COLORS[4]!);
      expect(a.presentation).toBe(base[j]!.presentation); // braids suit every presentation: the balance stays
      expect(a.body).toBe(base[j]!.body);
      expect(a.face).toBe(base[j]!.face);
    });
  });

  test("hair always suits the presentation: a fixed style moves an unpinned figure, a pinned presentation keeps its own", () => {
    const hijab = castAll(withFleet(defaultCastPrefs(), { mode: "same", hair: "hijab" }));
    for (const a of hijab) { expect(a.hair).toBe("hijab"); expect(a.presentation).toBe("feminine"); }
    const p = withPin(withFleet(defaultCastPrefs(), { mode: "same", hair: "hijab" }), "demo-1", { presentation: "masculine" });
    const one = castAll(p)[DEMO.indexOf("demo-1")]!;
    expect(one.presentation).toBe("masculine");
    expect(hairStylesFor("masculine")).toContain(one.hair);
    for (const a of castAll(withPin(defaultCastPrefs(), "demo-4", { presentation: "neutral" }))) {
      expect(HAIR_STYLES.find((h) => h.id === a.hair)!.suits).toContain(a.presentation);
    }
  });

  test("the fleet undertone tints the balance in Balanced fleet; the balance itself stays", () => {
    const base = castAll(null);
    castAll(withFleet(defaultCastPrefs(), { undertone: "warm" })).forEach((a, j) => {
      expect(a.skinIndex).toBe(base[j]!.skinIndex);
      expect(a.skin).toBe(SKIN_TONES.warm[a.skinIndex]!);
      expect(a.presentation).toBe(base[j]!.presentation);
      expect(a.hairColor).toBe(base[j]!.hairColor);
    });
  });

  test("setPrefs re-resolves looks but keeps every slot", () => {
    const book = new CastBook();
    const before = DEMO.map((id) => book.appearanceFor(id, "human")!);
    book.setPrefs(withPin(defaultCastPrefs(), "demo-5", { skin: 9 }));
    expect(book.appearanceFor("demo-5", "human")!.skinIndex).toBe(9);
    book.setPrefs(null);
    expect(DEMO.map((id) => book.appearanceFor(id, "human")!)).toEqual(before);
    book.setPrefs(withPin(defaultCastPrefs(), "demo-5", { skin: 9 }));
    book.clear(); // a new world: the preferences follow the lane
    expect(book.appearanceFor("demo-5", "human")!.skinIndex).toBe(9);
  });
});
