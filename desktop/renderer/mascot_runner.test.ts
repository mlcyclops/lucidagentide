// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// The calm prompt-bar ninja (mascot_runner.ts, P-MINI.3 (ADR-0596)), at both sizes: the canvas headroom and
// device cell, home on the bar's right end, the home activity schedule, the five-minute traverse and its
// no-slip gait, the double-click dash (direction, visitor dismissal, the walk back in), the gestures, the
// hover hop and click greeting, and the mirror helper.

import { describe, expect, it } from "bun:test";
import { MASCOT_FRAMES, MASCOT_H, MASCOT_W, MASCOT_RUN_FRAMES, MASCOT_RUN_BEAT_MS, MASCOT_RUN_SWEEP_CELLS, mascotActivityFrame, mirrorFrame } from "./mascot.ts";
import { SCENE_H, SCENE_W, sceneRows, typingRows } from "./mascot_mini.ts";
import { MASCOT_CELL_CSS, MASCOT_SIZES } from "./mini_lucid.ts";
import {
  AWAY_MS, DASH_MS, DOUBLE_TAP_MS, HOME_MAX_MS, HOME_MIN_MS, LEAP_LIFT_CELLS, PRACTICE_LOOP_MS, RUNNER_EDGE_CELLS, RUNNER_SKY_CELLS, TRAVERSE_MAX_MS, TRAVERSE_MIN_MS,
  createRunnerBrain, dashAt, dashDirection, homeLook, homeSeatBox, nextHomeActivity, practiceSetMs, returnAt, returnBeats, runnerCellPx, runnerGesture,
  runnerHeadroom, runnerPlan, runnerReaction, runnerReactionMs, standTop, startDash, stepRunnerBrain, traverseAt, traverseTurnBack,
  type GestureMemory, type HomeActivityKind, type PracticeForm, type RunnerBrain, type RunnerLayout, type RunnerWorld,
} from "./mascot_runner.ts";

/** Deterministic random source (mulberry32), so schedules are reproducible. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The layout the mount measures for a size, a DPR and a composer of `cssW` x 120 CSS px. */
function layoutFor(size: "small" | "large", dpr = 1, cssW = 800): RunnerLayout {
  const room = runnerHeadroom(MASCOT_CELL_CSS[size]);
  return { width: Math.floor(cssW * dpr), barTop: Math.round(room * dpr), height: Math.floor((120 + room) * dpr), scale: runnerCellPx(size, dpr) };
}
const SIZES = MASCOT_SIZES;
const DPRS = [1, 1.25, 1.5, 2];
const world = (l: RunnerLayout, over: Partial<RunnerWorld> = {}): RunnerWorld => ({ busy: false, reduced: false, visitor: false, actMs: 0, rand: seeded(1), plan: runnerPlan(l), ...over });

describe("size: device cells and headroom", () => {
  it("a cell is one CSS px at Small and two at Large, in whole device pixels at every DPR", () => {
    expect(runnerCellPx("small", 1)).toBe(1);
    expect(runnerCellPx("large", 1)).toBe(2);
    expect(runnerCellPx("small", 1.5)).toBe(1);
    expect(runnerCellPx("large", 1.5)).toBe(3);
    expect(runnerCellPx("small", 2)).toBe(2);
    expect(runnerCellPx("large", 2)).toBe(4);
    expect(runnerCellPx("small", 0.5)).toBe(1);
  });
  it("the headroom scales with the cell and always fits him, the dash peak and the act sky", () => {
    expect(runnerHeadroom(MASCOT_CELL_CSS.large)).toBe(2 * runnerHeadroom(MASCOT_CELL_CSS.small));
    for (const size of SIZES) for (const dpr of DPRS) {
      const l = layoutFor(size, dpr);
      const top = l.barTop - (MASCOT_H + RUNNER_SKY_CELLS) * l.scale;
      expect({ size, dpr, fits: top >= 0 }).toEqual({ size, dpr, fits: true });
      expect(RUNNER_SKY_CELLS).toBeGreaterThanOrEqual(LEAP_LIFT_CELLS);
    }
  });
});

describe("home", () => {
  it("is on the bar top at the right end, a margin inside it, in whole device pixels", () => {
    for (const size of SIZES) for (const dpr of DPRS) {
      const l = layoutFor(size, dpr);
      const p = runnerPlan(l);
      expect(p.homeX + p.spriteW).toBe(l.width - RUNNER_EDGE_CELLS * l.scale);
      expect(Number.isInteger(p.homeX) && Number.isInteger(p.endX)).toBe(true);
      expect(standTop(p, "idleA")).toBeGreaterThanOrEqual(0);
    }
  });
  // Reported live: a 1357 px wrap with its centered input row at 95..1261 (wrap-relative CSS px); home hugged the
  // wrap's right end, past the send button. Canvas x = (row rect - wrap padding-box left) * dpr.
  it("lives inside the visible input row when it is narrower than the wrap on both sides", () => {
    for (const size of SIZES) for (const dpr of [1, 1.5, 2]) {
      const l: RunnerLayout = { ...layoutFor(size, dpr, 1357), barLeft: Math.round(95 * dpr), barRight: Math.round(1261 * dpr) };
      const p = runnerPlan(l);
      const margin = RUNNER_EDGE_CELLS * l.scale;
      expect(p.homeX + p.spriteW).toBe(l.barRight! - margin);
      expect(p.endX).toBeGreaterThanOrEqual(l.barLeft! + margin);
      expect(p.endX).toBeLessThan(l.barLeft! + margin + p.stepPx);
      for (let t = 0; t <= p.traverseMs; t += 50) {
        const s = traverseAt(t, p);
        expect(s.x).toBeGreaterThanOrEqual(l.barLeft!);
        expect(s.x + p.spriteW).toBeLessThanOrEqual(l.barRight!);
      }
      const box = homeSeatBox(l, p, typingRows(0));
      expect(box.x).toBeGreaterThanOrEqual(l.barLeft!);
      expect(box.x + box.w).toBeLessThanOrEqual(l.barRight!);
      // Leaving and coming back still go wholly out of sight past the canvas edge, not just the row's.
      expect(dashAt(DASH_MS, p, p.homeX, -1).x + p.spriteW).toBeLessThanOrEqual(0);
      expect(returnAt(0, p, 1).x).toBeGreaterThanOrEqual(l.width);
    }
  });
  it("without a row (no barLeft/barRight) the bar is the whole canvas", () => {
    const l = layoutFor("small");
    expect(runnerPlan(l)).toEqual(runnerPlan({ ...l, barLeft: 0, barRight: l.width }));
  });
  it("a seated scene has the figure where he stands, inside the bar", () => {
    for (const size of SIZES) {
      const l = layoutFor(size, 1);
      const p = runnerPlan(l);
      const box = homeSeatBox(l, p, typingRows(0));
      expect(box.w).toBe(SCENE_W * l.scale);
      expect(box.h).toBe(SCENE_H * l.scale);
      expect(box.x + ((SCENE_W - MASCOT_W) / 2) * l.scale).toBe(p.homeX);
      expect(box.x + box.w).toBeLessThanOrEqual(l.width);
    }
  });
  // Reported live: he floated above the visible bar, more so seated, because frames and scenes leave empty
  // rows under the figure. The contract is about paint: the lowest PAINTED row sits right on the bar top.
  it("every home pose, standing or seated, has its lowest painted row right on the bar top", () => {
    const lowest = (rows: readonly string[]): number => {
      for (let y = rows.length - 1; y >= 0; y--) if ([...rows[y]!].some((c) => c !== ".")) return y;
      return -1;
    };
    const standing = new Set<string>(["idleA", "idleB", "idleC", "blink", "guard", "crouch", "talkA", "talkB", "talkC", "victoryA", "victoryB", ...MASCOT_RUN_FRAMES]);
    for (const form of Object.keys(PRACTICE_LOOP_MS) as PracticeForm[]) for (let t = 0; t < PRACTICE_LOOP_MS[form]; t += 10) standing.add(mascotActivityFrame(form, t));
    const seated = [typingRows(0), typingRows(150), typingRows(1000)];
    for (const breathe of [false, true]) for (const lookUp of [false, true]) seated.push(sceneRows("idle", 0, { breathe, lookUp }));
    for (const size of SIZES) for (const dpr of DPRS) {
      const l = { ...layoutFor(size, dpr), barTop: layoutFor(size, dpr).barTop + 11 }; // the row sits below the wrap top
      const p = runnerPlan(l);
      for (const f of standing) {
        const top = standTop(p, f);
        expect({ f, size, dpr, bottom: top + (lowest(MASCOT_FRAMES[f]!) + 1) * l.scale }).toEqual({ f, size, dpr, bottom: l.barTop });
      }
      for (const rows of seated) {
        const box = homeSeatBox(l, p, rows);
        expect(lowest(rows)).toBeGreaterThan(0);
        expect(box.y + (lowest(rows) + 1) * l.scale).toBe(l.barTop);
        expect(box.y).toBeGreaterThanOrEqual(0);
      }
      for (let t = 0; t <= p.traverseMs; t += 97) {
        const s = traverseAt(t, p);
        expect(s.y + (lowest(MASCOT_FRAMES[s.frame]!) + 1) * l.scale).toBe(l.barTop);
      }
    }
  });
});

describe("home activities", () => {
  it("pins each practice loop length to its WORK_LOOPS beat list (one full period)", () => {
    for (const form of Object.keys(PRACTICE_LOOP_MS) as PracticeForm[]) {
      const loop = PRACTICE_LOOP_MS[form];
      for (let t = 0; t < loop; t += 10) expect(mascotActivityFrame(form, t + loop)).toBe(mascotActivityFrame(form, t));
      expect(mascotActivityFrame(form, loop - 1)).not.toBe(mascotActivityFrame(form, 0));
    }
  });
  it("alternates calm activities for 20 to 45 s, never the same kind twice running, practice in whole sets", () => {
    const rand = seeded(42);
    const kinds = new Set<HomeActivityKind>();
    let prev: HomeActivityKind | null = null;
    const category = (k: HomeActivityKind): string => (k === "meditate" || k === "breathe" || k === "season" ? k : "practice");
    for (let i = 0; i < 300; i++) {
      const a = nextHomeActivity(rand, prev);
      expect(a.ms).toBeGreaterThanOrEqual(HOME_MIN_MS);
      expect(a.ms).toBeLessThanOrEqual(HOME_MAX_MS);
      if (prev) expect(category(a.kind)).not.toBe(category(prev));
      if (a.kind === "kata" || a.kind === "shuriken" || a.kind === "staff") expect(a.ms % practiceSetMs(a.kind)).toBe(0);
      kinds.add(a.kind);
      prev = a.kind;
    }
    expect([...kinds].sort()).toEqual(["breathe", "kata", "meditate", "shuriken", "staff"]);
  });
  it("is deterministic for a given random source", () => {
    const schedule = (): HomeActivityKind[] => { const r = seeded(9); const out: HomeActivityKind[] = []; let p: HomeActivityKind | null = null; for (let i = 0; i < 20; i++) { p = nextHomeActivity(r, p).kind; out.push(p); } return out; };
    expect(schedule()).toEqual(schedule());
  });
  it("a live season's act plays now and then, never twice running, never without a season", () => {
    const rand = seeded(5);
    let prev: HomeActivityKind | null = "breathe";
    let acts = 0;
    for (let i = 0; i < 200; i++) {
      const a = nextHomeActivity(rand, prev, 3000);
      if (a.kind === "season") { acts++; expect(prev).not.toBe("season"); expect(a.ms).toBeGreaterThan(3000); }
      prev = a.kind;
    }
    expect(acts).toBeGreaterThan(20);
    expect(acts).toBeLessThan(100);
    expect(nextHomeActivity(() => 0, "breathe", 0).kind).not.toBe("season");
  });
  it("practice plays one set, then holds still; it is the work loop's own frames", () => {
    const a = { kind: "kata" as const, ms: practiceSetMs("kata") * 3 };
    expect(homeLook(a, 10, false, 0).frame).toBe(mascotActivityFrame("kata", 10));
    const hold = homeLook(a, PRACTICE_LOOP_MS.kata + 50, false, 0);
    expect(hold.seated).toBe(false);
    expect(["idleA", "idleB", "idleC", "blink"]).toContain(hold.frame);
    expect(homeLook(a, practiceSetMs("kata") + 10, false, 0).frame).toBe(mascotActivityFrame("kata", 10)); // the next set
  });
  it("meditation is seated, breathes on a 3.2 s cycle and glances up now and then", () => {
    const a = { kind: "meditate" as const, ms: 30_000 };
    expect(homeLook(a, 100, false, 0)).toMatchObject({ seated: true, breathe: false, lookUp: false });
    expect(homeLook(a, 1700, false, 0).breathe).toBe(true);
    expect(homeLook(a, 8500, false, 0).lookUp).toBe(true);
  });
  it("a season slot plays the act after a short lead and not after it ends", () => {
    const a = { kind: "season" as const, ms: 4000 };
    expect(homeLook(a, 100, false, 3000).actT).toBe(-1);
    expect(homeLook(a, 1300, false, 3000).actT).toBe(1000);
    expect(homeLook(a, 3400, false, 3000).actT).toBe(-1);
  });
  it("reduced motion holds one still picture per activity", () => {
    for (const kind of ["kata", "staff", "meditate", "breathe", "season"] as const) {
      const a = { kind, ms: 30_000 };
      const first = JSON.stringify(homeLook(a, 0, true, 3000));
      for (let t = 0; t < 30_000; t += 777) expect(JSON.stringify(homeLook(a, t, true, 3000))).toBe(first);
    }
  });
});

/** Sole centers along a frame's bottom row, in cells. */
function soles(frame: readonly string[]): number[] {
  const bottom = frame[MASCOT_H - 1]!;
  const centers: number[] = [];
  for (let x = 0; x < MASCOT_W; x++) {
    if (bottom[x] === ".") continue;
    let end = x;
    while (end + 1 < MASCOT_W && bottom[end + 1] !== ".") end++;
    centers.push((x + end) / 2);
    x = end;
  }
  return centers;
}

describe("the traverse", () => {
  it("walks from home to the left end, looks, and walks back home, feet on the bar and inside it", () => {
    for (const size of SIZES) for (const dpr of [1, 2]) {
      const l = layoutFor(size, dpr);
      const p = runnerPlan(l);
      expect(p.beats).toBeGreaterThan(8);
      expect(p.endX).toBeGreaterThanOrEqual(RUNNER_EDGE_CELLS * l.scale);
      expect(p.endX).toBeLessThan(RUNNER_EDGE_CELLS * l.scale + p.stepPx);
      let minX = Infinity;
      for (let t = 0; t <= p.traverseMs; t += 25) {
        const s = traverseAt(t, p);
        expect(s.y).toBe(standTop(p, s.frame));
        expect(s.x).toBeGreaterThanOrEqual(0);
        expect(s.x + p.spriteW).toBeLessThanOrEqual(l.width);
        expect(s.frame in MASCOT_FRAMES).toBe(true);
        minX = Math.min(minX, s.x);
      }
      expect(minX).toBe(p.endX);
      expect(traverseAt(p.traverseMs, p).x).toBe(p.homeX);
      expect(traverseAt(10, p).mirrored).toBe(true); // heading left
      expect(traverseAt(p.traverseMs - 10, p).mirrored).toBe(false); // heading home
    }
  });
  it("keeps a foot planted through every beat, both ways, at both sizes (no skating)", () => {
    for (const size of SIZES) {
      const l = layoutFor(size, 1);
      const p = runnerPlan(l);
      const planted = (t: number): number[] => {
        const s = traverseAt(t, p);
        const f = MASCOT_FRAMES[s.frame]!;
        return soles(s.mirrored ? mirrorFrame(f) : f).map((c) => s.x + c * l.scale);
      };
      for (const start of [0, p.walkMs + 1800]) {
        for (let beat = 1; beat <= MASCOT_RUN_FRAMES.length; beat++) {
          const before = planted(start + (beat - 1) * MASCOT_RUN_BEAT_MS + 1);
          expect(planted(start + beat * MASCOT_RUN_BEAT_MS - 1)).toEqual(before); // still within a beat
          const after = planted(start + beat * MASCOT_RUN_BEAT_MS + 1);
          const held = before.some((a) => after.some((b) => Math.abs(a - b) < 1));
          expect({ size, start, beat, held }).toEqual({ size, start, beat, held: true });
        }
      }
      expect(p.stepPx).toBe(MASCOT_RUN_SWEEP_CELLS * l.scale);
    }
  });
  it("a turn mid-walk turns him around on the spot and takes him home", () => {
    const l = layoutFor("small");
    const p = runnerPlan(l);
    const t = 7 * MASCOT_RUN_BEAT_MS + 20;
    const back = traverseTurnBack(t, p);
    expect(traverseAt(back, p).x).toBe(traverseAt(t, p).x);
    expect(traverseAt(back, p).mirrored).toBe(false);
    expect(traverseTurnBack(back, p)).toBe(back); // already homeward: unchanged
    expect(traverseTurnBack(p.walkMs + 300, p)).toBe(p.walkMs + 1800); // mid-look: straight home
  });
});

/** Steps a brain in 50 ms ticks; returns how long until `stop` holds (Infinity if it never does). */
function run(b: RunnerBrain, w: RunnerWorld, ms: number, stop: (b: RunnerBrain) => boolean, onStep?: (r: "dismiss" | null) => void): number {
  for (let t = 0; t <= ms; t += 50) {
    if (stop(b)) return t;
    const r = stepRunnerBrain(b, 50, w);
    onStep?.(r);
  }
  return Infinity;
}

describe("the traverse schedule", () => {
  it("the first traverse is never before 4 minutes, and comes within 6 plus one activity", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const w = world(layoutFor("small"), { rand: seeded(seed) });
      const b = createRunnerBrain(w.rand);
      const at = run(b, w, TRAVERSE_MAX_MS + HOME_MAX_MS + 1000, (x) => x.mode === "traverse");
      expect(at).toBeGreaterThanOrEqual(TRAVERSE_MIN_MS);
      expect(at).toBeLessThanOrEqual(TRAVERSE_MAX_MS + HOME_MAX_MS);
    }
    expect(createRunnerBrain(() => 0).untilTraverse).toBe(TRAVERSE_MIN_MS);
    expect(createRunnerBrain(() => 0.999999).untilTraverse).toBeLessThanOrEqual(TRAVERSE_MAX_MS);
  });
  it("never starts while a turn runs: the home clock holds until he is idle again", () => {
    const w = world(layoutFor("large"), { busy: true });
    const b = createRunnerBrain(w.rand);
    const before = b.untilTraverse;
    expect(run(b, w, 20 * 60_000, (x) => x.mode !== "home")).toBe(Infinity);
    expect(b.untilTraverse).toBe(before);
    w.busy = false;
    expect(run(b, w, TRAVERSE_MAX_MS + HOME_MAX_MS, (x) => x.mode === "traverse")).toBeLessThan(Infinity);
  });
  it("comes home after the walk, picks a new activity, and starts a fresh clock", () => {
    const w = world(layoutFor("small"));
    const b = createRunnerBrain(w.rand);
    run(b, w, TRAVERSE_MAX_MS + HOME_MAX_MS, (x) => x.mode === "traverse");
    expect(b.untilTraverse).toBeGreaterThanOrEqual(TRAVERSE_MIN_MS);
    const back = run(b, w, w.plan.traverseMs + 100, (x) => x.mode === "home");
    expect(back).toBeLessThanOrEqual(w.plan.traverseMs + 50);
    expect(b.activityT).toBe(0);
  });
  it("reduced motion and a bar too short to walk never traverse", () => {
    const short = world(layoutFor("large", 1, 140));
    expect(short.plan.beats * MASCOT_RUN_SWEEP_CELLS).toBeLessThan(MASCOT_W); // less than his own width to walk
    for (const w of [world(layoutFor("small"), { reduced: true }), short]) {
      const b = createRunnerBrain(w.rand);
      expect(run(b, w, 2 * TRAVERSE_MAX_MS, (x) => x.mode !== "home")).toBe(Infinity);
    }
  });
});

describe("the double-click dash", () => {
  it("goes away from the pointer's side of the bar: left from home, right from the left end", () => {
    const l = layoutFor("small");
    const p = runnerPlan(l);
    expect(dashDirection(p.homeX + p.spriteW / 2, l.width)).toBe(-1);
    expect(dashDirection(p.endX + p.spriteW / 2, l.width)).toBe(1);
  });
  it("crouches, bursts off the bar's end in an arc that fits the headroom, and ends wholly out of sight", () => {
    for (const size of SIZES) for (const dir of [-1, 1] as const) {
      const l = layoutFor(size, 1.5);
      const p = runnerPlan(l);
      const from = dir < 0 ? p.homeX : p.endX;
      expect(dashAt(0, p, from, dir).frame).toBe("crouch");
      let lastX = from;
      for (let t = 0; t <= DASH_MS; t += 10) {
        const s = dashAt(t, p, from, dir);
        expect(Number.isInteger(s.x)).toBe(true);
        expect((s.x - lastX) * dir).toBeGreaterThanOrEqual(0); // never doubles back
        expect(s.y - s.lift * l.scale).toBeGreaterThanOrEqual(0); // the peak stays inside the canvas
        lastX = s.x;
      }
      const end = dashAt(DASH_MS, p, from, dir);
      expect(dir < 0 ? end.x + p.spriteW <= 0 : end.x >= l.width).toBe(true);
      expect(end.airborne).toBe(false);
    }
  });
  it("a visitor's dash dismisses him exactly once, and he never comes back", () => {
    const w = world(layoutFor("small"), { visitor: true });
    const b = createRunnerBrain(w.rand);
    expect(startDash(b, -1, w.plan.homeX, w)).toBeNull();
    expect(b.mode).toBe("dash");
    let dismissals = 0;
    run(b, w, AWAY_MS * 2, () => false, (r) => { if (r === "dismiss") dismissals++; });
    expect(dismissals).toBe(1);
    expect(b.mode).toBe("gone");
    expect(startDash(b, -1, 0, w)).toBeNull(); // a second double-click does nothing
  });
  it("reduced motion: no dash, he just leaves (a visitor is dismissed at once)", () => {
    const v = world(layoutFor("large"), { visitor: true, reduced: true });
    expect(startDash(createRunnerBrain(v.rand), -1, 0, v)).toBe("dismiss");
    const r = world(layoutFor("large"), { reduced: true });
    const b = createRunnerBrain(r.rand);
    expect(startDash(b, -1, 0, r)).toBeNull();
    expect(b.mode).toBe("away");
  });
  it("a resident is away about 90 s, then walks back in from the edge he left by, to home", () => {
    for (const side of [-1, 1] as const) {
      const w = world(layoutFor("small"));
      const b = createRunnerBrain(w.rand);
      startDash(b, side, w.plan.homeX, w);
      expect(run(b, w, DASH_MS + 100, (x) => x.mode === "away")).toBeLessThanOrEqual(DASH_MS + 50);
      const back = run(b, w, AWAY_MS + 100, (x) => x.mode === "return");
      expect(back).toBeGreaterThanOrEqual(AWAY_MS - 50);
      const p = w.plan;
      const first = returnAt(0, p, side);
      expect(side < 0 ? first.x + p.spriteW <= 0 : first.x >= p.width).toBe(true); // starts out of sight
      expect(first.mirrored).toBe(side > 0);
      expect(returnAt(returnBeats(p, side) * MASCOT_RUN_BEAT_MS, p, side).x).toBe(p.homeX);
      expect(run(b, w, returnBeats(p, side) * MASCOT_RUN_BEAT_MS + 100, (x) => x.mode === "home")).toBeLessThan(Infinity);
    }
  });
  it("only leaves from the bar: no dash while already dashing or away", () => {
    const w = world(layoutFor("small"));
    const b = createRunnerBrain(w.rand);
    startDash(b, -1, w.plan.homeX, w);
    startDash(b, 1, 0, w);
    expect(b.side).toBe(-1);
  });
});

describe("gestures", () => {
  const mem = (): GestureMemory => ({ lastTapAt: -Infinity, off: false });
  it("a click greets, a double-click dashes", () => {
    const m = mem();
    expect(runnerGesture(m, "click", 0)).toBe("greet");
    expect(runnerGesture(m, "dblclick", 10)).toBe("dash");
  });
  it("two taps within 350 ms dash; slower taps do not; a third tap starts over", () => {
    const m = mem();
    expect(runnerGesture(m, "tap", 1000)).toBe("none");
    expect(runnerGesture(m, "tap", 1000 + DOUBLE_TAP_MS)).toBe("dash");
    expect(runnerGesture(m, "tap", 1000 + DOUBLE_TAP_MS + 100)).toBe("none");
    expect(runnerGesture(m, "tap", 1000 + 3 * DOUBLE_TAP_MS)).toBe("none"); // 351+ ms later: a new first tap
  });
  it("a right-click turns him off exactly once; nothing reaches him after", () => {
    const m = mem();
    const actions = (["contextmenu", "contextmenu", "click", "dblclick", "tap", "tap"] as const).map((g, i) => runnerGesture(m, g, i * 10));
    expect(actions.filter((a) => a === "off").length).toBe(1);
    expect(actions.slice(1).every((a) => a === "none")).toBe(true);
  });
});

describe("hover hop and click greeting", () => {
  const sample = (kind: "hop" | "greet", reduced: boolean) => {
    const out: { frame: string; lift: number }[] = [];
    for (let t = 0; t <= runnerReactionMs(kind, reduced); t += 5) {
      const b = runnerReaction(kind, t, reduced);
      out.push({ frame: b.frame, lift: b.lift });
    }
    return out;
  };
  it("both crouch first, rise and fall back to the bar, and end on the ground", () => {
    for (const kind of ["hop", "greet"] as const) {
      const s = sample(kind, false);
      expect(s[0]!.frame).toBe("crouch");
      expect(s[s.length - 1]!.lift).toBe(0);
      const peak = s.reduce((a, b) => (b.lift > a.lift ? b : a));
      expect(peak.lift).toBeGreaterThan(4);
      const i = s.indexOf(peak);
      for (let k = 1; k <= i; k++) expect(s[k]!.lift).toBeGreaterThanOrEqual(s[k - 1]!.lift);
      for (let k = i + 1; k < s.length; k++) expect(s[k]!.lift).toBeLessThanOrEqual(s[k - 1]!.lift);
      for (const b of s) expect(b.frame in MASCOT_FRAMES).toBe(true);
    }
  });
  it("the greeting ends in a wave; the hop does not", () => {
    expect(sample("greet", false).some((b) => b.frame.startsWith("victory"))).toBe(true);
    expect(sample("hop", false).some((b) => b.frame.startsWith("victory"))).toBe(false);
  });
  it("reduced motion never leaves the ground", () => {
    for (const kind of ["hop", "greet"] as const) {
      const s = sample(kind, true);
      expect(s.every((b) => b.lift === 0)).toBe(true);
      expect(new Set(s.map((b) => b.frame)).size).toBe(1);
    }
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
