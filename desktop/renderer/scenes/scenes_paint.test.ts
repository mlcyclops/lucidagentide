// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/scenes/scenes_paint.test.ts
//
// P-SEASON.1 (ADR-0525): behavioral checks for EVERY registered backdrop, under every season that uses
// it, against a recording 2D context: no call that a real canvas would reject or silently drop
// (non-finite numbers, negative radii, gradient stops outside [0, 1]) at any t, size or season, and
// painting is stateless (the same t always yields the same frame, whatever came before).

import { describe, expect, test } from "bun:test";
import type { SceneDef } from "../scene_kit.ts";
import { SEASONS, type SeasonId } from "../seasons.ts";

const RADIUS_ARG: Record<string, number[]> = { arc: [2], ellipse: [2, 3], createRadialGradient: [2, 5] };

/** A 2D context stand-in that logs every call and assignment and collects anything a real canvas
 *  would throw on or ignore. */
function recorder(log: string[], bad: string[]): CanvasRenderingContext2D {
  const gradient = {
    addColorStop(o: number): void {
      log.push(`stop ${o}`);
      if (!(o >= 0 && o <= 1)) bad.push(`addColorStop(${o})`);
    },
  };
  const state: Record<string | symbol, unknown> = { getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) };
  const handler: ProxyHandler<Record<string | symbol, unknown>> = {
    get(obj, key) {
      if (key in obj) return obj[key];
      return (...args: unknown[]): unknown => {
        const name = String(key);
        log.push(`${name}(${args.map((a) => (typeof a === "number" ? a.toFixed(3) : typeof a)).join(",")})`);
        for (const a of args) if (typeof a === "number" && !Number.isFinite(a)) bad.push(`${name}(${args.join(",")})`);
        for (const i of RADIUS_ARG[name] ?? []) {
          const r = args[i];
          if (typeof r === "number" && r < 0) bad.push(`${name} negative radius ${r}`);
        }
        return name.startsWith("create") ? gradient : undefined;
      };
    },
    set(obj, key, v) {
      log.push(`${String(key)}=${String(v)}`);
      if (typeof v === "number" && !Number.isFinite(v)) bad.push(`${String(key)}=${v}`);
      obj[key] = v;
      return true;
    },
  };
  // The proxy implements the subset of the 2D API the scenes call; the cast names that contract.
  const ctx = new Proxy(state, handler) as unknown as CanvasRenderingContext2D;
  return ctx;
}

let sink: string[] = [];
let sinkBad: string[] = [];

// Bun has no canvas: stand-ins for OffscreenCanvas (layerCache) and Path2D (shapes some scenes build once
// at module load), installed BEFORE the scenes are imported, hence the dynamic import below.
class FakeOffscreen {
  constructor(public width: number, public height: number) {}
  getContext(): CanvasRenderingContext2D {
    return recorder(sink, sinkBad);
  }
}
// Path calls go to the frame being painted, so a scene that batches shapes into a Path2D is checked
// (and its motion seen) exactly like one that draws on the context directly.
const FakePath = function FakePath(this: object) {
  return new Proxy(this, {
    get: (obj, key) => (key in obj ? Reflect.get(obj, key) : (...args: unknown[]): void => {
      const name = `path.${String(key)}`;
      pathLog.push(`${name}(${args.map((a) => (typeof a === "number" ? a.toFixed(3) : typeof a)).join(",")})`);
      for (const a of args) if (typeof a === "number" && !Number.isFinite(a)) pathBad.push(`${name}(${args.join(",")})`);
    }),
  });
};
let pathLog: string[] = [];
let pathBad: string[] = [];
Object.assign(globalThis, { OffscreenCanvas: FakeOffscreen, Path2D: FakePath });
const { SCENES } = await import("../season_scenes.ts");
const CASES: [SceneDef, (SeasonId | null)[]][] = Object.values(SCENES).map((s) => [
  s,
  [null, ...SEASONS.filter((x) => x.scene === s.id).map((x) => x.id)],
]);

function frame(s: SceneDef, w: number, h: number, t: number, season: SeasonId | null): { log: string[]; bad: string[] } {
  const log: string[] = [];
  const bad: string[] = [];
  sink = [];
  sinkBad = bad;
  pathLog = log;
  pathBad = bad;
  s.paint({ ctx: recorder(log, bad), w, h, t, season });
  return { log, bad };
}

describe("seasonal backdrops", () => {
  for (const [s, seasons] of CASES) {
    test(`${s.id}: every call is valid at any t, size and season`, () => {
      for (const season of seasons) {
        for (const [w, h] of [[1400, 800], [1920, 1080], [320, 200], [1, 1]]) {
          for (const t of [0, 16.7, 4750, 123_456, 3 * 86_400_000]) {
            expect(frame(s, w, h, t, season).bad).toEqual([]);
          }
        }
      }
    });

    test(`${s.id}: a frame depends only on its inputs`, () => {
      const first = frame(s, 1400, 800, 7321, seasons[seasons.length - 1]).log;
      frame(s, 1400, 800, 99_999, seasons[0]);
      frame(s, 900, 600, 7321, seasons[seasons.length - 1]);
      expect(frame(s, 1400, 800, 7321, seasons[seasons.length - 1]).log).toEqual(first);
    });

    test(`${s.id}: the backdrop actually moves`, () => {
      const season = seasons[seasons.length - 1];
      expect(frame(s, 1400, 800, 2000, season).log).not.toEqual(frame(s, 1400, 800, 6000, season).log);
    });
  }
});
