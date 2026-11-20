// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/viz_mini_look.test.ts - P-VIZ.2 (ADR-0623), P-VIZ.3 (ADR-0624): mini Lucid's suit,
// repertoires and rotation. The accent must read against the gi for every persona and any input; each role gets
// its own repertoire; the rotation is deterministic, switches on the ~6.5 s beat and is de-synchronized across a
// fleet. The anime figure stays inside its per-tier triangle budgets and never produces a non-finite transform.

import { describe, expect, test } from "bun:test";
import { PERSONAS } from "./viz_model.ts";
import { animeTriangles, createAnimeFigure, type AnimeDetail, type AnimeState } from "./viz_anime.ts";
import {
  activitiesFor, activityAt, BRAND_ACCENT, contrastRatio, lookFor, MIN_ACCENT_CONTRAST, MINI_ACTIVITIES, MINI_ACTIVITY_MS,
  parseHex, relativeLuminance, type MiniKind,
} from "./viz_mini_look.ts";

const HEX = /^#[0-9a-f]{6}$/;

describe("lookFor", () => {
  const inputs = [...Object.values(PERSONAS).map((p) => p.color), BRAND_ACCENT, "#000000", "#ffffff", "#0000ff", "#123", "#808080", "#1a2b3c"];

  test("every color is a normalized hex and the accent clears the contrast floor against the gi", () => {
    for (const c of inputs) {
      const l = lookFor(c);
      for (const v of Object.values(l)) expect(v).toMatch(HEX);
      expect(contrastRatio(l.accent, l.gi)).toBeGreaterThanOrEqual(MIN_ACCENT_CONTRAST);
      expect(relativeLuminance(l.accent)).toBeGreaterThan(relativeLuminance(l.gi));
    }
  });

  test("the suit stays dark and ordered: shadow < gi < highlight, deep accent below the accent", () => {
    for (const c of inputs) {
      const l = lookFor(c);
      expect(relativeLuminance(l.gi)).toBeLessThanOrEqual(0.05);
      expect(relativeLuminance(l.giShadow)).toBeLessThan(relativeLuminance(l.gi));
      expect(relativeLuminance(l.giHighlight)).toBeGreaterThan(relativeLuminance(l.gi));
      expect(relativeLuminance(l.accentDeep)).toBeLessThan(relativeLuminance(l.accent));
    }
  });

  test("persona colors are kept as the accent; a dark color is lifted until it reads", () => {
    for (const p of Object.values(PERSONAS)) expect(lookFor(p.color).accent).toBe(p.color.toLowerCase());
    expect(lookFor("#000000").accent).not.toBe("#000000");
  });

  test("invalid colors fall back to the brand accent", () => {
    for (const bad of ["", "green", "#12345", "#ggg", "rgb(1,2,3)"]) expect(lookFor(bad).accent).toBe(BRAND_ACCENT);
    expect(parseHex(" #ABC ")).toEqual([0xaa, 0xbb, 0xcc]);
    expect(parseHex("#41FF8B")).toEqual([0x41, 0xff, 0x8b]);
  });
});

describe("activitiesFor", () => {
  const has = (persona: string, kind: MiniKind, ...want: string[]) => {
    const list = activitiesFor(persona, kind);
    for (const w of want) expect(list).toContain(w);
  };
  const share = (list: readonly string[], a: string) => list.filter((x) => x === a).length / list.length;

  test("each role gets its signature moves", () => {
    has("coder", "agent", "typing");
    has("tester", "agent", "kiblast", "scan");
    has("guard", "agent", "kata", "dash");
    has("writer", "agent", "typing", "meditate");
    has("researcher", "subagent", "scan", "typing");
    has("reviewer", "agent", "scan", "typing");
    has("planner", "agent", "meditate", "scan");
    has("lead", "agent", "meditate", "kata");
    has("scout", "agent", "scan", "dash");
  });

  test("coders and the hub are typing-heavy; an unknown persona works like a coder", () => {
    expect(share(activitiesFor("coder", "agent"), "typing")).toBeGreaterThanOrEqual(0.5);
    expect(share(activitiesFor("lead", "hub"), "typing")).toBeGreaterThanOrEqual(0.5);
    expect(activitiesFor("mystery", "agent")).toEqual(activitiesFor("coder", "agent"));
  });

  test("repertoires only use known activities and never repeat back to back (wrap included)", () => {
    for (const persona of [...Object.keys(PERSONAS), "mystery"]) {
      for (const kind of ["hub", "agent", "subagent"] as const) {
        const list = activitiesFor(persona, kind);
        for (let i = 0; i < list.length; i++) {
          expect(MINI_ACTIVITIES).toContain(list[i]!);
          expect(list[i]).not.toBe(list[(i + 1) % list.length]);
        }
      }
    }
  });
});

describe("activityAt", () => {
  test("not working means meditating", () => {
    for (let t = 0; t < 60_000; t += 1700) expect(activityAt("tester", "agent", 3, t, false)).toBe("meditate");
  });

  test("an idle boss whose team works supervises, never meditates; working beats supervising", () => {
    for (let t = 0; t < 60_000; t += 1700) {
      expect(activityAt("lead", "hub", 1, t, false, true)).toBe("supervise");
      expect(activityAt("lead", "hub", 1, t, true, true)).not.toBe("supervise");
    }
    expect(MINI_ACTIVITIES).toContain("supervise");
  });

  test("deterministic, switches only on the slot beat, and visits the whole repertoire", () => {
    const step = 50;
    const changes: number[] = [];
    const seen = new Set<string>();
    let prev = activityAt("guard", "agent", 7, 0, true);
    for (let t = step; t <= 80_000; t += step) {
      const a = activityAt("guard", "agent", 7, t, true);
      expect(activityAt("guard", "agent", 7, t, true)).toBe(a);
      seen.add(a);
      if (a !== prev) changes.push(t);
      prev = a;
    }
    for (let i = 1; i < changes.length; i++) expect(Math.abs(changes[i]! - changes[i - 1]! - MINI_ACTIVITY_MS)).toBeLessThanOrEqual(step);
    expect([...seen].sort()).toEqual([...new Set(activitiesFor("guard", "agent"))].sort());
  });

  test("a fleet does not switch in lockstep", () => {
    const firstSwitch = (seed: number) => {
      const a0 = activityAt("coder", "agent", seed, 0, true);
      for (let t = 0; t <= MINI_ACTIVITY_MS; t += 25) if (activityAt("coder", "agent", seed, t, true) !== a0) return t;
      return -1;
    };
    const times = new Set<number>();
    for (let seed = 0; seed < 8; seed++) times.add(firstSwitch(seed));
    expect(times.size).toBeGreaterThanOrEqual(5);
  });
});

describe("anime mini Lucid budgets", () => {
  const BUDGET: Record<AnimeDetail, number> = { full: 60_000, reduced: 20_000, minimal: 8_000 };
  const finite = (o: { position: { x: number; y: number; z: number }; quaternion: { x: number; y: number; z: number; w: number }; scale: { x: number; y: number; z: number } }) =>
    [o.position.x, o.position.y, o.position.z, o.quaternion.x, o.quaternion.y, o.quaternion.z, o.quaternion.w, o.scale.x, o.scale.y, o.scale.z].every(Number.isFinite);

  /** bun has no DOM: a canvas whose 2D context accepts every call is enough to build the figure and draw its eyes.
   *  The fake document lives only for the construction (the figure keeps its context). */
  function withCanvas<T>(fn: () => T): T {
    const g = globalThis as { document?: unknown };
    const had = "document" in g;
    const prev = g.document;
    const ctx = new Proxy({} as Record<string | symbol, unknown>, {
      get: (target, key) => (key in target ? target[key] : () => ({ addColorStop() {} })),
      set: (target, key, value) => { target[key] = value; return true; },
    });
    g.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) };
    try {
      return fn();
    } finally {
      if (had) g.document = prev;
      else delete g.document;
    }
  }

  for (const detail of ["full", "reduced", "minimal"] as const) {
    test(`${detail}: every activity, burst and state stays under ${BUDGET[detail]} triangles with finite transforms`, () => {
      const fig = withCanvas(() => createAnimeFigure({ look: lookFor("#38bdf8"), detail, flat: detail === "minimal" }));
      fig.setIntensity(1);
      let worst = 0;
      let t = 0;
      for (const a of MINI_ACTIVITIES) {
        fig.setActivity(a);
        for (let f = 0; f < 240; f++) {
          if (f === 40) fig.burst();
          t += 1 / 60;
          fig.update(t, 1 / 60, true);
          worst = Math.max(worst, animeTriangles(fig.group));
        }
        fig.group.traverse((o) => expect(finite(o)).toBe(true));
      }
      for (const s of ["working", "idle", "working", "paused", "failed", "working", "ended", "killed"] as AnimeState[]) {
        fig.setState(s);
        for (let f = 0; f < 120; f++) {
          t += 1 / 30;
          fig.update(t, 1 / 30, true);
          worst = Math.max(worst, animeTriangles(fig.group));
        }
        fig.update(t, 0, false);
        fig.group.traverse((o) => expect(finite(o)).toBe(true));
      }
      expect(worst).toBeGreaterThan(0);
      expect(worst).toBeLessThan(BUDGET[detail]);
      fig.dispose();
    });
  }
});
