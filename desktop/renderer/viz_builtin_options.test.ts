// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/viz_builtin_options.test.ts - P-VIZ.STYLEOPT1 (ADR-0688): the built-in styles' option schemas
// (held to the world option rules), their defaults, the save / load / reset round trip under the builtin ids, and the
// pure mapping from option values to the backdrop, theme and scene look (a bad value falls back to the default).

import { describe, expect, test } from "bun:test";
import { BACKDROP_PLATE, backdropLook, BUILTIN_OPTIONS, builtinLook, builtinTheme, scaleParticles, THEME_ACCENT } from "./viz_builtin_options.ts";
import { checkOption, loadOptions, OPTIONS_KEY, optionDefaults, resetOptions, saveOption } from "./viz_worlds.ts";
import { vizTierOpts } from "./viz_model.ts";
import type { VizTheme } from "./viz_scene.ts";

const DARK: VizTheme = { bg: "#0b0d14", txt: "#e8eaf2", accent: "#c64bd6", cyan: "#46c8dc", light: false };
const LIGHT: VizTheme = { bg: "#f6f7fa", txt: "#1a1d26", accent: "#7c3aed", cyan: "#0891b2", light: true };

function memStorage(): { mem: Map<string, string>; storage: { getItem: (k: string) => string | null; setItem: (k: string, v: string) => void } } {
  const mem = new Map<string, string>();
  return { mem, storage: { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => void mem.set(k, v) } };
}

describe("schemas", () => {
  for (const style of ["anime", "professional"] as const) {
    const def = BUILTIN_OPTIONS[style];
    test(`${style}: every option passes the world option rules, keys are unique`, () => {
      def.options.forEach((o, i) => expect(checkOption(o, i)).toBeNull());
      expect(new Set(def.options.map((o) => o.key)).size).toBe(def.options.length);
      expect(def.id).toBe(`builtin:${style}`);
    });
    test(`${style}: shared options, with at least six backgrounds`, () => {
      const keys = def.options.map((o) => o.key);
      for (const k of ["background", "bgColor", "stars", "drift", "accent", "particles", "lighting", "labels"]) expect(keys).toContain(k);
      const bg = def.options.find((o) => o.key === "background");
      expect(bg?.type === "select" ? bg.choices.map((c) => c.value) : []).toEqual(["nebula", "night", "sunset", "aurora", "studio", "deep", "solid"]);
    });
  }

  test("style-only options", () => {
    const keys = (s: "anime" | "professional"): string[] => BUILTIN_OPTIONS[s].options.map((o) => o.key);
    expect(keys("anime")).toContain("plate");
    expect(keys("anime")).not.toContain("grid");
    expect(keys("professional")).toEqual(expect.arrayContaining(["grid", "desk"]));
    expect(keys("professional")).not.toContain("plate");
  });

  test("defaults: Nebula for Anime, Studio for Professional; the rest as the scene always drew", () => {
    const a = optionDefaults(BUILTIN_OPTIONS.anime.options);
    expect(a).toMatchObject({ background: "nebula", stars: "few", drift: false, accent: THEME_ACCENT, particles: "full", lighting: "neutral", labels: "pill", plate: BACKDROP_PLATE });
    const p = optionDefaults(BUILTIN_OPTIONS.professional.options);
    expect(p).toMatchObject({ background: "studio", grid: false, desk: "tinted" });
  });
});

describe("storage under the builtin ids", () => {
  test("save, load and reset round trip, next to a world's values", () => {
    const { mem, storage } = memStorage();
    storage.setItem(OPTIONS_KEY, JSON.stringify({ christmas: { sled: "gold" } }));
    const def = BUILTIN_OPTIONS.professional;
    expect(saveOption(storage, def, "background", "sunset").background).toBe("sunset");
    expect(saveOption(storage, def, "grid", true).grid).toBe(true);
    expect(saveOption(storage, def, "stars", "lots").stars).toBe("few"); // not a choice: the default
    expect(loadOptions(storage, def)).toMatchObject({ background: "sunset", grid: true, stars: "few" });
    expect(loadOptions(storage, BUILTIN_OPTIONS.anime).background).toBe("nebula"); // the other style is untouched
    const all = JSON.parse(mem.get(OPTIONS_KEY) ?? "{}") as Record<string, unknown>;
    expect(Object.keys(all).sort()).toEqual(["builtin:professional", "christmas"]);
    expect(resetOptions(storage, def)).toEqual(optionDefaults(def.options));
    expect(loadOptions(storage, def)).toEqual(optionDefaults(def.options));
    expect(JSON.parse(mem.get(OPTIONS_KEY) ?? "{}")).toEqual({ christmas: { sled: "gold" } });
  });
});

describe("backdrop mapping", () => {
  test("every background has its own look; an unknown one is the nebula", () => {
    const looks = ["nebula", "night", "sunset", "aurora", "studio", "deep", "solid"].map((b) => backdropLook(b, "few", false, "#1b2130"));
    expect(new Set(looks.map((l) => JSON.stringify(l))).size).toBe(7);
    expect(backdropLook("bogus", "few", false, "#1b2130")).toEqual(backdropLook("nebula", "few", false, "#1b2130"));
  });

  test("the nebula is the backdrop as it always was (theme base, full glows, 140 stars)", () => {
    expect(backdropLook("nebula", "few", false, "#000000")).toMatchObject({ light: null, base: null, glows: 1, stars: 140, starTop: 1, gradient: [], bands: [] });
  });

  test("stars: none, few, many; deep space is denser; a bad value is few", () => {
    expect(backdropLook("night", "none", false, "#000000").stars).toBe(0);
    expect(backdropLook("night", "many", false, "#000000").stars).toBeGreaterThan(backdropLook("night", "few", false, "#000000").stars);
    expect(backdropLook("deep", "few", false, "#000000").stars).toBeGreaterThan(backdropLook("night", "few", false, "#000000").stars);
    expect(backdropLook("night", "zillions", false, "#000000").stars).toBe(140);
    expect(backdropLook("studio", "many", false, "#000000").stars).toBe(0);
  });

  test("solid color: its color, light or dark by luminance; a bad color falls back", () => {
    expect(backdropLook("solid", "few", false, "#f0f0f0")).toMatchObject({ light: true, base: { dark: "#f0f0f0", light: "#f0f0f0" } });
    expect(backdropLook("solid", "few", false, "#101010").light).toBe(false);
    expect(backdropLook("solid", "few", false, "red").base).toEqual({ dark: "#1b2130", light: "#1b2130" });
  });

  test("drift is carried through", () => {
    expect(backdropLook("aurora", "few", true, "#000000").drift).toBe(true);
  });
});

describe("builtinLook and builtinTheme", () => {
  test("bad saved values fall back to the defaults", () => {
    const bad = builtinLook("anime", { background: 3, stars: "x", accent: "#123456", particles: "most", lighting: "pink", labels: "neon", plate: "#000001", drift: "yes" });
    expect(bad).toEqual(builtinLook("anime", {}));
    expect(builtinLook("anime", null)).toEqual(builtinLook("anime", {}));
  });

  test("defaults keep the app theme for Anime (the scene as it always was)", () => {
    const l = builtinLook("anime", {});
    expect(l).toMatchObject({ accent: null, cyan: null, particles: 1, lighting: "neutral", labels: "pill", grid: false, plate: null });
    expect(builtinTheme(DARK, l)).toEqual(DARK);
    expect(builtinTheme(LIGHT, l)).toEqual(LIGHT);
  });

  test("Studio follows the theme's light, with a soft gray base", () => {
    const l = builtinLook("professional", {});
    const d = builtinTheme(DARK, l), w = builtinTheme(LIGHT, l);
    expect(d.light).toBe(false);
    expect(w.light).toBe(true);
    expect(d.bg).not.toBe(DARK.bg);
    expect(w.bg).not.toBe(LIGHT.bg);
  });

  test("a dark background on a light theme flips light and the text color (the remount path)", () => {
    const t = builtinTheme(LIGHT, builtinLook("anime", { background: "night" }));
    expect(t).toMatchObject({ light: false, txt: "#e8eaf2" });
    const s = builtinTheme(DARK, builtinLook("anime", { background: "solid", bgColor: "#eeeeee" }));
    expect(s).toMatchObject({ light: true, bg: "#eeeeee", txt: "#1a1d26" });
  });

  test("an accent swatch brings its pair; Theme keeps the app's", () => {
    const l = builtinLook("professional", { accent: "#3b82f6" });
    expect(l.accent).toBe("#3b82f6");
    expect(l.cyan).toMatch(/^#[0-9a-f]{6}$/);
    expect(builtinTheme(DARK, l)).toMatchObject({ accent: "#3b82f6", cyan: l.cyan });
    expect(builtinTheme(DARK, builtinLook("professional", { accent: THEME_ACCENT })).accent).toBe(DARK.accent);
  });

  test("style-only options apply to their style only", () => {
    expect(builtinLook("professional", { grid: true, desk: "dark" })).toMatchObject({ grid: true, desk: "dark", plate: null });
    expect(builtinLook("anime", { grid: true, desk: "dark", plate: "#123b2f" })).toMatchObject({ grid: false, desk: "tinted", plate: "#123b2f" });
  });

  test("particles, lighting and name tags", () => {
    expect(builtinLook("anime", { particles: "half" }).particles).toBe(0.5);
    expect(builtinLook("anime", { particles: "off" }).particles).toBe(0);
    const warm = builtinLook("anime", { lighting: "warm" }).light, cool = builtinLook("anime", { lighting: "cool" }).light;
    expect(warm.intensity).toBeGreaterThan(cool.intensity);
    expect(warm.sky).not.toBe(cool.sky);
    expect(builtinLook("anime", { labels: "outline" }).labels).toBe("outline");
  });

  test("scaleParticles scales flow and effect budgets only", () => {
    const o = vizTierOpts("full", false);
    expect(scaleParticles(o, 1)).toBe(o);
    expect(scaleParticles(o, 0.5)).toEqual({ ...o, particles: o.particles / 2, fx: o.fx / 2 });
    expect(scaleParticles(o, 0)).toMatchObject({ particles: 0, fx: 0, fps: o.fps, bloom: o.bloom });
  });
});
