// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// The prompt-bar parkour timeline (mascot_runner.ts, P-MASCOT.2): phase order, positions staying inside
// the layout, the clip contract (hidden while crossing the bar band, visible on the lanes), direction
// alternation by cycle, and the mirror helper.

import { describe, expect, it } from "bun:test";
import { MASCOT_FRAMES, MASCOT_H, MASCOT_W, MASCOT_RUN_FRAMES, MASCOT_RUN_BEAT_MS, mirrorFrame } from "./mascot.ts";
import {
  LEAP_ROUTE_MS, RUNNER_HEADROOM, RUNNER_SCALE, RUNNER_TIMINGS, runnerAt, runnerCycle, runnerReaction, runnerReactionMs, runnerRestMs, runnerWalkLeft,
  type RunnerLayout, type RunnerPhase,
} from "./mascot_runner.ts";

const T = RUNNER_TIMINGS;

const L: RunnerLayout = { width: 900, barTop: 62, barBottom: 160, height: 160, scale: RUNNER_SCALE };
const H = MASCOT_H * RUNNER_SCALE;

describe("retina consistency (the missing-legs live bug, 2026-08-01)", () => {
  it("at any scale the sprite NEVER extends past the canvas bottom or above the crawl lane", () => {
    for (const scale of [1, 2, 3, 4]) {
      const l: RunnerLayout = { width: 900 * scale, barTop: 62 * scale, barBottom: 160 * scale, height: 160 * scale, scale };
      const c2 = runnerCycle(l);
      for (let t2 = 0; t2 < c2.total; t2 += 40) {
        const p = runnerAt(t2, l);
        expect(p.y + MASCOT_H * scale).toBeLessThanOrEqual(l.height + 1); // feet inside the canvas
        expect(p.y).toBeGreaterThanOrEqual(0); // no high-DPI crawl-lane clipping
      }
    }
  });
});

describe("runnerCycle", () => {
  it("edges stay inside the bar and the total covers every phase", () => {
    const c = runnerCycle(L);
    expect(c.xEdge).toBeGreaterThan(c.xExit);
    expect(c.xEdge).toBeLessThan(L.width);
    expect(c.xExit).toBeGreaterThanOrEqual(8);
    expect(c.total).toBeGreaterThan(c.runMs + c.sneakMs);
  });
});

describe("runnerAt - the parkour route", () => {
  const c = runnerCycle(L);
  it("visits the phases in order: run -> climb -> mantle -> sneak -> pause -> drop -> land -> rest", () => {
    const seen: RunnerPhase[] = [];
    for (let t = 0; t < c.total; t += 20) {
      const p = runnerAt(t, L).phase;
      if (seen[seen.length - 1] !== p) seen.push(p);
    }
    expect(seen).toEqual(["run", "climb", "mantle", "sneak", "pause", "drop", "land", "rest"]);
  });
  it("plays every gait beat in order and restarts it on the mirrored pass", () => {
    for (let i = 0; i < MASCOT_RUN_FRAMES.length; i++) {
      const t = i * MASCOT_RUN_BEAT_MS + 1;
      expect(runnerAt(t, L).frame).toBe(MASCOT_RUN_FRAMES[i]);
      expect(runnerAt(c.total + t, L).frame).toBe(MASCOT_RUN_FRAMES[i]);
    }
  });
  it("keeps travel per stride proportional to the painted sprite at every pixel scale", () => {
    const dt = MASCOT_RUN_BEAT_MS * MASCOT_RUN_FRAMES.length;
    const travel = (l: RunnerLayout) => runnerAt(dt, l).x - runnerAt(0, l).x;
    for (const scale of [2, 3, 4]) {
      const larger = { ...L, width: L.width * scale, scale: L.scale * scale };
      expect(travel(larger) / scale).toBeCloseTo(travel(L));
      expect(runnerAt(dt / 2, larger).frame).toBe(runnerAt(dt / 2, L).frame);
    }
  });
  // P-MASCOT.5, reported live: "it does not have the same walk and it makes it look weird". The body
  // advanced 4 cells a beat while the planted heel swept back 5, so every step slid forward and the
  // run read as gliding. The contract is physical: on each beat of the run SOME sole must hold the
  // same WORLD position it held on the previous beat. Soles are measured off the painted frames, so
  // this fails if either the gait art or the travel speed moves without the other.
  it("keeps a foot planted on the ground through every beat of the run (no skating)", () => {
    const soles = (frameId: string): number[] => {
      const bottom = MASCOT_FRAMES[frameId]![MASCOT_H - 1]!;
      const centres: number[] = [];
      for (let x = 0; x < MASCOT_W; x++) {
        if (bottom[x] === ".") continue;
        let end = x;
        while (end + 1 < MASCOT_W && bottom[end + 1] !== ".") end++;
        centres.push((x + end) / 2);
        x = end;
      }
      return centres;
    };
    for (const scale of [1, 2, 3]) {
      const l: RunnerLayout = { ...L, scale };
      const world = (t: number): number[] => {
        const p = runnerAt(t, l);
        expect(p.phase).toBe("run");
        return soles(p.frame).map((c) => p.x + c * scale);
      };
      // A whole stride pair, plus a sample at the END of each beat: travel happens in whole beats, so a
      // body that glided within a beat would drag its planted sole along with it.
      for (let beat = 1; beat <= MASCOT_RUN_FRAMES.length; beat++) {
        const before = world((beat - 1) * MASCOT_RUN_BEAT_MS + 1);
        const late = world(beat * MASCOT_RUN_BEAT_MS - 1);
        const after = world(beat * MASCOT_RUN_BEAT_MS + 1);
        expect(late).toEqual(before);
        const held = before.some((a) => after.some((b) => Math.abs(a - b) < 1));
        expect({ beat, scale, held }).toEqual({ beat, scale, held: true });
      }
    }
  });
  it("the climb eases (slow start: quarter time covers well under quarter distance)", () => {
    const start = runnerAt(c.runMs + 1, L).y;
    const quarter = runnerAt(c.runMs + T.CLIMB_MS / 4, L).y;
    const top = L.barTop - H;
    expect(Math.abs(quarter - start)).toBeLessThan(Math.abs(top - start) * 0.2);
  });
  it("the mantle sits ON the edge and the landing squash is visible at the foot", () => {
    const mantle = runnerAt(c.runMs + T.CLIMB_MS + 100, L);
    expect(mantle.phase).toBe("mantle");
    expect(mantle.y).toBe(L.barTop - H);
    const landT = c.runMs + T.CLIMB_MS + T.MANTLE_MS + c.sneakMs + T.PAUSE_MS + T.DROP_MS + 80;
    const land = runnerAt(landT, L);
    expect(land.phase).toBe("land");
    expect(land.frame).toBe("land");
    expect(land.clipBar).toBe(false);
    expect(land.y).toBe(L.height - H);
  });
  it("runs the FOOT lane unclipped, crosses the band clipped, sneaks the TOP lane", () => {
    const run = runnerAt(10, L);
    expect(run.clipBar).toBe(false);
    expect(run.y).toBe(L.height - H); // feet on the canvas foot
    const climb = runnerAt(c.runMs + 100, L);
    expect(climb.clipBar).toBe(true);
    expect(["hang", "hangB"]).toContain(climb.frame);
    const sneak = runnerAt(c.runMs + T.CLIMB_MS + T.MANTLE_MS + 200, L);
    expect(sneak.y).toBe(L.barTop - H); // standing ON the bar's top edge
    // The top lane uses the SAME run cycle as the foot (and as the arcade). The old separate
    // sneak poses read as a worse, different walk directly above the prompt.
    expect(MASCOT_RUN_FRAMES).toContain(sneak.frame);
  });
  it("the drop accelerates (gravity), lands with a squash, and rest is visible again", () => {
    const dropStart = c.runMs + T.CLIMB_MS + T.MANTLE_MS + c.sneakMs + T.PAUSE_MS;
    const early = runnerAt(dropStart + 80, L);
    const late = runnerAt(dropStart + 340, L);
    expect(early.phase).toBe("drop");
    expect(late.y - early.y).toBeGreaterThan(0);
    // second half falls farther than the first (ease-in)
    const mid = runnerAt(dropStart + 210, L);
    expect(late.y - mid.y).toBeGreaterThan(mid.y - early.y);
    const rest = runnerAt(dropStart + T.DROP_MS + T.LAND_MS + 10, L);
    expect(rest.phase).toBe("rest");
    expect(rest.clipBar).toBe(false);
  });
  it("positions stay inside the canvas on every sampled tick", () => {
    for (let t = 0; t < c.total * 2; t += 33) {
      const p = runnerAt(t, L);
      expect(p.x).toBeGreaterThanOrEqual(-MASCOT_W * RUNNER_SCALE - 1);
      expect(p.x).toBeLessThanOrEqual(L.width + 1);
      expect(p.y).toBeGreaterThanOrEqual(L.barTop - H - 1);
      expect(p.y).toBeLessThanOrEqual(L.height - H + 1);
      expect(p.frame in MASCOT_FRAMES).toBe(true);
    }
  });
  it("cycles alternate direction (odd cycles mirror the route)", () => {
    const a = runnerAt(10, L);
    const b = runnerAt(c.total + 10, L);
    expect(a.mirrored).toBe(false);
    expect(b.mirrored).toBe(true);
    expect(Math.abs((L.width - MASCOT_W * RUNNER_SCALE - a.x) - b.x)).toBeLessThan(2); // reflected entry
  });
});

describe("hover hop and click leap", () => {
  const sample = (kind: "hop" | "leap", reduced: boolean) => {
    const out: { t: number; frame: string; lift: number; travel: number }[] = [];
    for (let t = 0; t <= runnerReactionMs(kind, reduced); t += 5) {
      const b = runnerReaction(kind, t, reduced);
      out.push({ t, frame: b.frame, lift: b.lift, travel: b.travel });
    }
    return out;
  };
  it("both reactions crouch first, rise and fall back to the lane, and end on the ground", () => {
    for (const kind of ["hop", "leap"] as const) {
      const s = sample(kind, false);
      expect(s[0]!.frame).toBe("crouch");
      expect(s[0]!.lift).toBe(0);
      expect(s[s.length - 1]!.lift).toBe(0);
      const peak = s.reduce((a, b) => (b.lift > a.lift ? b : a));
      expect(peak.lift).toBeGreaterThan(4);
      // Rises monotonically to the peak, then falls monotonically: no hitches mid-air.
      const i = s.indexOf(peak);
      for (let k = 1; k <= i; k++) expect(s[k]!.lift).toBeGreaterThanOrEqual(s[k - 1]!.lift);
      for (let k = i + 1; k < s.length; k++) expect(s[k]!.lift).toBeLessThanOrEqual(s[k - 1]!.lift);
      for (const b of s) expect(b.frame in MASCOT_FRAMES).toBe(true);
    }
  });
  it("only the leap dashes: its travel runs 0 -> 1 without ever reversing; the hop stays put", () => {
    const leap = sample("leap", false);
    expect(leap[0]!.travel).toBe(0);
    expect(leap[leap.length - 1]!.travel).toBe(1);
    for (let k = 1; k < leap.length; k++) expect(leap[k]!.travel).toBeGreaterThanOrEqual(leap[k - 1]!.travel);
    expect(sample("hop", false).every((b) => b.travel === 0)).toBe(true);
  });
  it("reduced motion never leaves the ground or travels", () => {
    for (const kind of ["hop", "leap"] as const) {
      const s = sample(kind, true);
      expect(s.every((b) => b.lift === 0 && b.travel === 0)).toBe(true);
      expect(new Set(s.map((b) => b.frame)).size).toBe(1);
    }
  });
  it("the leap's peak fits in the canvas sky above the top lane at every DPR", () => {
    const peak = Math.max(...sample("leap", false).map((b) => b.lift));
    for (const dpr of [1, 1.5, 2]) {
      const scale = Math.max(1, Math.floor(RUNNER_SCALE * dpr));
      const topY = Math.round(RUNNER_HEADROOM * dpr) - MASCOT_H * scale;
      expect(topY - peak * scale).toBeGreaterThanOrEqual(0);
    }
  });
  it("a dash only has room on the walking lanes, and never past the lane's end", () => {
    const c = runnerCycle(L);
    expect(runnerWalkLeft(runnerAt(10, L), c)).toBe(c.runMs - 10);
    expect(runnerWalkLeft(runnerAt(c.runMs - 5, L), c)).toBe(5);
    const sneakT = c.runMs + T.CLIMB_MS + T.MANTLE_MS + 30;
    expect(runnerWalkLeft(runnerAt(sneakT, L), c)).toBe(c.sneakMs - 30);
    expect(runnerWalkLeft(runnerAt(c.total - 10, L), c)).toBe(0); // rest
    // Folding a full dash into the route keeps him on the same lane, further along, facing the same way.
    const before = runnerAt(100, L), after = runnerAt(100 + LEAP_ROUTE_MS, L);
    expect(after.phase).toBe("run");
    expect(after.mirrored).toBe(before.mirrored);
    expect(after.x).toBeGreaterThan(before.x);
  });
});

describe("seasonal rest", () => {
  it("stretches the rest to fit the act with a lead-in and a tail, never shortening the plain rest", () => {
    expect(runnerRestMs(0)).toBe(T.REST_MS);
    expect(runnerRestMs(500)).toBe(T.REST_MS);
    expect(runnerRestMs(3600)).toBeGreaterThanOrEqual(T.ACT_LEAD_MS + 3600);
    const plain = runnerCycle(L), festive = runnerCycle(L, runnerRestMs(3600));
    expect(festive.total - plain.total).toBe(runnerRestMs(3600) - T.REST_MS);
    // The act window sits wholly inside the rest phase.
    const actEnd = festive.total - festive.restMs + T.ACT_LEAD_MS + 3600;
    const p = runnerAt(actEnd - 1, L, undefined, festive);
    expect(p.phase).toBe("rest");
    expect(p.phaseT).toBe(T.ACT_LEAD_MS + 3600 - 1);
  });
});

describe("mirrorFrame", () => {
  it("reverses every row, preserves dims, and is an involution", () => {
    const f = MASCOT_FRAMES.runA!;
    const m = mirrorFrame(f);
    expect(m.length).toBe(f.length);
    for (const r of m) expect(r.length).toBe(MASCOT_W);
    expect(mirrorFrame(m)).toEqual(f);
    expect(m).not.toEqual(f); // runA is asymmetric (it strides)
  });
});
