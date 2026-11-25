// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/viz_anime_pose.test.ts - P-VIZ.3 (ADR-0624): the anime mini Lucid's pose library, clips,
// interpolation math, emotion selection, blink and gaze bucketing, effect timing and the look mapping.
// P-VIZ.6 (ADR-0637): the seeded gender, the charge (bolt, energy balls, Storm) and the hit reactions.

import { describe, expect, test } from "bun:test";
import {
  ANIME_SKIN, animeLook, auraLevel, BLINK_MAX_S, BLINK_MIN_S, BLINK_S, blinkStep, bump, CHECK_ROWS, checklistTicks, clipDone, clipFor, CLIPS,
  clipTime, dashSpeed, distributeYaw, ease, easeOutBack, EMOTION_NAMES, EMOTIONS, eyeKey, gazeBucket, gazeOfBucket, GLARE_S, jointOffset, JOINTS,
  KI_FIRE_S, KI_FLY_S, kiBallAt, LAB_POSES, newReactionSample, nextBlinkDelay, OUTBURST_MAX_S, OUTBURST_MIN_S, OUTBURST_TURN_IN_S, planReaction,
  POSE_LEN, POSE_VECTORS, POSES, RAGE_IN_S, RAGE_OUT_S, REACT_TURN_OUT_S, sampleClip, sampleReaction, shakeLevel, SLOW_BLINK_S, smoothEase,
  STARE_HOLD_MAX_S, STARE_HOLD_MIN_S, STARE_TURN_IN_S, stateEmotion, STILL_T, STOMP_AT_S, SUPERVISE_TICK_AT, SURPRISE_S, tapCurve, tempoFor,
  transitionShot, YELL_S, type ClipName, type ClipSample, type EmotionName, type KiBall, type Reaction, type ReactionKind, type ReactionSample,
} from "./viz_anime_pose.ts";
import {
  addBoost, animeHitCharge, BOLT_S, chargeLevel, chargeTempo, decayCharge, DRINK_CHARGE, DRINK_S, HIT_BLEND_S, HIT_CLIPS, HIT_KINDS, HIT_OUT_S,
  HIT_TURN_S, newCharge, newHitSample, ORB_DECAY_S, ORB_MAX, orbScale, planHit, sampleHit, seededGender, STAR_CHAIN_S, type AnimeHit, type Charge,
  type HitPlan, type HitSample,
} from "./viz_anime_pose.ts";
import {
  KUNAI_FLY_S, newWeaponSample, STAFF_TURNS, variantOf, WEAPON_CLIP, WEAPON_CLIPS, WEAPON_FLY, WEAPON_HAND, WEAPON_SHARE, WEAPON_SLOTS, weaponAt,
  weaponOf, WEAPONS, weaponTurn,
} from "./viz_anime_pose.ts";
import * as THREE from "three";
import { animeTriangles, createAnimeFigure, type AnimeFigure } from "./viz_anime.ts";
import type { VizBrand } from "./viz_brand.ts";
import { lookFor, MINI_ACTIVITIES, relativeLuminance } from "./viz_mini_look.ts";

const CLIP_NAMES = Object.keys(CLIPS) as ClipName[];
const sample = (name: ClipName, t: number): { pose: Float32Array; info: ClipSample } => {
  const pose = new Float32Array(POSE_LEN);
  const info: ClipSample = { emotion: "neutral", gaze: 0 };
  sampleClip(CLIPS[name], t, pose, info);
  return { pose, info };
};
const emotionsOf = (name: ClipName, step = 1 / 60): Set<EmotionName> => {
  const seen = new Set<EmotionName>();
  for (let t = 0; t <= CLIPS[name].len; t += step) seen.add(sample(name, t).info.emotion);
  return seen;
};

describe("pose library", () => {
  test("the lab's approved poses are all here and every pose vector is finite", () => {
    for (const p of LAB_POSES) expect(POSES[p]).toBeDefined();
    for (const v of Object.values(POSE_VECTORS)) {
      expect(v.length).toBe(POSE_LEN);
      for (const x of v) expect(Number.isFinite(x)).toBe(true);
    }
  });

  test("pose vectors keep the lab's joint values in JOINTS order", () => {
    const v = POSE_VECTORS.stance;
    expect(v[1]).toBeCloseTo(-0.06, 6);
    expect(v[jointOffset("root") + 1]).toBeCloseTo(-0.35, 6);
    expect(v[jointOffset("shL")]).toBeCloseTo(-1.2, 6);
    expect(v[jointOffset("kneeR")]).toBeCloseTo(0.35, 6);
    expect(jointOffset(JOINTS[JOINTS.length - 1]!)).toBe(POSE_LEN - 3);
  });
});

describe("clips", () => {
  test("every activity has a looping clip; states and one-shots do not loop", () => {
    for (const a of MINI_ACTIVITIES) expect(CLIPS[a].loop).toBe(true);
    for (const s of ["powerup", "victory", "failed", "ended", "killed"] as const) expect(CLIPS[s].loop).toBe(false);
  });

  test("keys start at 0, ascend strictly, end inside the clip and name known poses", () => {
    for (const name of CLIP_NAMES) {
      const c = CLIPS[name];
      expect(c.keys[0]!.at).toBe(0);
      for (let i = 1; i < c.keys.length; i++) expect(c.keys[i]!.at).toBeGreaterThan(c.keys[i - 1]!.at);
      expect(c.keys[c.keys.length - 1]!.at).toBeLessThanOrEqual(c.len);
      for (const k of c.keys) expect(POSE_VECTORS[k.pose]).toBeDefined();
      expect(STILL_T[name]).toBeGreaterThanOrEqual(0);
      expect(STILL_T[name]).toBeLessThanOrEqual(c.len);
    }
  });

  test("sampling at a key time gives exactly that key's pose", () => {
    for (const name of CLIP_NAMES) {
      for (const k of CLIPS[name].keys) {
        if (k.at >= CLIPS[name].len) continue;
        const { pose } = sample(name, k.at);
        const want = POSE_VECTORS[k.pose];
        for (let i = 0; i < POSE_LEN; i++) expect(pose[i]).toBeCloseTo(want[i]!, 5);
      }
    }
  });

  test("a loop eases its last key back into its first (no pop at the wrap)", () => {
    for (const a of MINI_ACTIVITIES) {
      const end = sample(a, CLIPS[a].len - 1e-4).pose;
      const start = sample(a, 0).pose;
      for (let i = 0; i < POSE_LEN; i++) expect(Math.abs(end[i]! - start[i]!)).toBeLessThan(1e-3);
      expect(clipTime(CLIPS[a], CLIPS[a].len * 2.5)).toBeCloseTo(CLIPS[a].len * 0.5, 6);
    }
  });

  test("one-shots hold their last key and report done", () => {
    for (const s of ["powerup", "victory", "failed", "ended", "killed"] as const) {
      const c = CLIPS[s];
      expect(clipDone(c, c.len - 0.01)).toBe(false);
      expect(clipDone(c, c.len)).toBe(true);
      const late = sample(s, c.len + 5).pose;
      const last = POSE_VECTORS[c.keys[c.keys.length - 1]!.pose];
      for (let i = 0; i < POSE_LEN; i++) expect(late[i]).toBeCloseTo(last[i]!, 5);
    }
  });

  test("non-finite clock times read as the clip start", () => {
    expect(clipTime(CLIPS.kata, Number.NaN)).toBe(0);
    expect(clipTime(CLIPS.kata, Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("easing", () => {
  test("smooth flows inside its endpoints; a snap overshoots slightly and lands exactly", () => {
    expect(ease("smooth", 0)).toBe(0);
    expect(ease("smooth", 1)).toBe(1);
    expect(ease("snap", 0)).toBeCloseTo(0, 9);
    expect(ease("snap", 1)).toBeCloseTo(1, 9);
    let maxSmooth = 0, maxSnap = 0;
    for (let u = 0; u <= 1; u += 0.001) {
      const s = smoothEase(u);
      expect(s).toBeGreaterThanOrEqual(0);
      maxSmooth = Math.max(maxSmooth, s);
      maxSnap = Math.max(maxSnap, easeOutBack(u));
    }
    expect(maxSmooth).toBeLessThanOrEqual(1);
    expect(maxSnap).toBeGreaterThan(1.02);
    expect(maxSnap).toBeLessThan(1.1);
    // the snap is fast: most of the way there in the first third
    expect(easeOutBack(1 / 3)).toBeGreaterThan(0.75);
  });

  test("a strike in kata goes anticipation, snap past the key, settle", () => {
    const keys = CLIPS.kata.keys;
    const i = keys.findIndex((k) => k.pose === "punchR" && k.ease === "snap");
    const wind = keys[i - 1]!, hit = keys[i]!;
    expect(wind.pose).toBe("punchWind");
    const ch = jointOffset("elR");
    const a = POSE_VECTORS.punchWind[ch]!, b = POSE_VECTORS.punchR[ch]!;
    let past = false;
    for (let t = wind.at; t <= hit.at; t += 0.002) {
      const v = sample("kata", t).pose[ch]!;
      if ((v - b) * Math.sign(b - a) > 1e-4) past = true;
    }
    expect(past).toBe(true);
    expect(hit.at - wind.at).toBeLessThanOrEqual(0.2);
  });

  test("tap, bump and shake curves stay in range", () => {
    for (let u = -0.5; u <= 1.5; u += 0.01) {
      expect(tapCurve(u)).toBeGreaterThanOrEqual(0);
      expect(tapCurve(u)).toBeLessThanOrEqual(1);
      expect(bump(u, 0, 0.2, 0.8, 1)).toBeGreaterThanOrEqual(0);
      expect(bump(u, 0, 0.2, 0.8, 1)).toBeLessThanOrEqual(1);
      expect(shakeLevel(u)).toBeGreaterThanOrEqual(0);
      expect(shakeLevel(u)).toBeLessThanOrEqual(1);
    }
    expect(tapCurve(0.19)).toBeCloseTo(1, 6);
    expect(tapCurve(0.6)).toBe(0);
  });
});

describe("emotion selection", () => {
  test("each activity speaks through the expected eyes", () => {
    const want: Record<ClipName, EmotionName[]> = {
      typing: ["focused", "neutral"],
      supervise: ["focused"],
      kiblast: ["determined"],
      kata: ["focused", "determined"],
      meditate: ["calm"],
      scan: ["focused", "surprised"],
      dash: ["focused", "determined"],
      powerup: ["strain"],
      victory: ["happy"],
      failed: ["pain"],
      ended: ["calm", "happy"],
      killed: ["neutral", "surprised", "ko"],
      slash: ["focused", "determined"],
      kunaiThrow: ["focused", "determined"],
      staffSpin: ["focused", "determined"],
      discThrow: ["focused", "determined", "smug"],
      commit: ["raiden"],
    };
    for (const name of CLIP_NAMES) expect([...emotionsOf(name)].sort()).toEqual([...want[name]].sort());
  });

  test("a snap switches the eyes at once; a smooth move switches them halfway", () => {
    const keys = CLIPS.scan.keys;
    const spot = keys.find((k) => k.pose === "scanSpot" && k.ease === "snap")!;
    const before = keys[keys.indexOf(spot) - 1]!;
    expect(sample("scan", before.at - 0.01).info.emotion).toBe("focused");
    expect(sample("scan", before.at + 0.001).info.emotion).toBe("surprised");
    // ended: calm portrait (0.8) easing into the happy bow (1.4)
    expect(sample("ended", 1.0).info.emotion).toBe("calm");
    expect(sample("ended", 1.3).info.emotion).toBe("happy");
  });

  test("states override the clip's eyes: paused is tired, failed hurts", () => {
    expect(stateEmotion("paused", "focused")).toBe("tired");
    expect(stateEmotion("failed", "determined")).toBe("pain");
    for (const s of ["working", "idle", "ended", "killed"] as const) expect(stateEmotion(s, "focused")).toBe("focused");
    expect(EMOTIONS.pain.sweat).toBe(true);
    expect(EMOTIONS.strain.shape).toBe("strain");
    expect(EMOTIONS.ko.shape).toBe("x");
    expect(EMOTIONS.happy.shape).toBe("happy");
    expect(EMOTIONS.calm.shape).toBe("closed");
  });

  test("the state picks the clip; a working turn that ends plays the victory once", () => {
    expect(clipFor("working", "kata")).toBe("kata");
    expect(clipFor("idle", "meditate")).toBe("meditate");
    expect(clipFor("paused", "scan")).toBe("scan");
    expect(clipFor("failed", "typing")).toBe("failed");
    expect(clipFor("ended", "typing")).toBe("ended");
    expect(clipFor("killed", "typing")).toBe("killed");
    expect(transitionShot("working", "idle")).toBe("victory");
    for (const [a, b] of [["idle", "working"], ["working", "paused"], ["failed", "idle"], ["working", "ended"], ["paused", "idle"]] as const) expect(transitionShot(a, b)).toBeNull();
  });

  test("the activity clock speeds up with intensity and freezes while paused", () => {
    expect(tempoFor("working", 1)).toBeGreaterThan(tempoFor("working", 0));
    expect(tempoFor("paused", 1)).toBe(0);
    expect(tempoFor("working", Number.NaN)).toBe(tempoFor("working", 0));
    expect(tempoFor("idle", 0.5)).toBeGreaterThan(0);
  });
});

describe("eyes: blink and gaze", () => {
  test("blinks come every 2.5 to 5 s and close then reopen within BLINK_S", () => {
    for (let r = 0; r < 1; r += 0.05) {
      expect(nextBlinkDelay(r)).toBeGreaterThanOrEqual(BLINK_MIN_S);
      expect(nextBlinkDelay(r)).toBeLessThanOrEqual(BLINK_MAX_S);
    }
    expect(nextBlinkDelay(Number.NaN)).toBeGreaterThanOrEqual(BLINK_MIN_S);
    expect(blinkStep(-1)).toBe(0);
    expect(blinkStep(BLINK_S)).toBe(0);
    expect(blinkStep(BLINK_S / 2)).toBe(2);
    const steps: number[] = [];
    for (let a = 0; a < BLINK_S; a += 0.004) { const s = blinkStep(a); if (steps[steps.length - 1] !== s) steps.push(s); }
    expect(steps).toEqual([0, 1, 2, 1, 0]);
  });

  test("gaze buckets: five, clamped, and the key changes only with a bucket", () => {
    expect(gazeBucket(-3)).toBe(-2);
    expect(gazeBucket(3)).toBe(2);
    expect(gazeBucket(Number.NaN)).toBe(0);
    expect(gazeBucket(0.2)).toBe(0);
    expect(gazeBucket(0.3)).toBe(1);
    expect(gazeOfBucket(gazeBucket(1))).toBe(1);
    const keys = new Set<number>();
    for (const e of EMOTION_NAMES) for (let b = 0; b < 3; b++) for (let g = -2; g <= 2; g++) keys.add(eyeKey(e, b, g));
    expect(keys.size).toBe(EMOTION_NAMES.length * 3 * 5);
  });

  test("the eye canvas redraws a handful of times per scan loop, not every frame", () => {
    let last = -1, redraws = 0, frames = 0;
    for (let t = 0; t < CLIPS.scan.len; t += 1 / 60, frames++) {
      const { info } = sample("scan", t);
      const k = eyeKey(info.emotion, 0, gazeBucket(info.gaze));
      if (k !== last) { redraws++; last = k; }
    }
    expect(redraws).toBeGreaterThan(3);
    expect(redraws).toBeLessThan(frames / 10);
  });
});

describe("effect timing", () => {
  test("the ki ball grows while charging, then fires, swells and fades", () => {
    const kb: KiBall = { scale: 0, alpha: 0, fly: -1 };
    expect(kiBallAt(0.1, kb).alpha).toBe(0);
    const early = kiBallAt(0.5, kb).scale;
    const late = kiBallAt(KI_FIRE_S - 0.01, kb).scale;
    expect(late).toBeGreaterThan(early);
    expect(kiBallAt(KI_FIRE_S - 0.01, kb).fly).toBe(-1);
    expect(kiBallAt(KI_FIRE_S + 0.01, kb).fly).toBeGreaterThanOrEqual(0);
    const a1 = kiBallAt(KI_FIRE_S + 0.1, kb).alpha;
    const a2 = kiBallAt(KI_FIRE_S + KI_FLY_S - 0.02, kb).alpha;
    expect(a2).toBeLessThan(a1);
    expect(kiBallAt(KI_FIRE_S + KI_FLY_S + 0.01, kb).alpha).toBe(0);
    // the thrust snaps in exactly when the ball fires
    expect(CLIPS.kiblast.keys.some((k) => k.pose === "kiblast" && k.ease === "snap" && Math.abs(k.at - KI_FIRE_S) < 1e-9)).toBe(true);
  });

  test("speed streaks only while the dash flies; the aura only during the powerup", () => {
    expect(dashSpeed(0.2)).toBe(0);
    expect(dashSpeed(1.0)).toBeCloseTo(1, 6);
    expect(dashSpeed(2.2)).toBe(0);
    expect(auraLevel(-0.1)).toBe(0);
    expect(auraLevel(0.6)).toBeCloseTo(1, 6);
    expect(auraLevel(CLIPS.powerup.len + 0.1)).toBe(0);
  });
});

describe("animeLook", () => {
  test("hair is very dark and tinted toward the gi, the iris is the accent slightly darker", () => {
    for (const c of ["#41ff8b", "#38bdf8", "#ff5a5a", "#9d8bff", "#000000", "bad"]) {
      const mini = lookFor(c);
      const a = animeLook(mini);
      for (const v of [a.gi, a.giDark, a.accent, a.hair, a.skin, a.eye]) expect(v).toMatch(/^#[0-9a-f]{6}$/);
      expect(a.gi).toBe(mini.gi);
      expect(a.accent).toBe(mini.accent);
      expect(relativeLuminance(a.hair)).toBeLessThan(relativeLuminance(a.gi));
      expect(relativeLuminance(a.eye)).toBeLessThan(relativeLuminance(a.accent));
      expect(relativeLuminance(a.eye)).toBeGreaterThan(relativeLuminance(a.accent) * 0.5);
      expect(a.skin).toBe(ANIME_SKIN);
    }
  });
});

// ------------------------------------------------------------------------------------------ P-VIZ.4 (ADR-0628)

describe("supervise", () => {
  test("the hub's supervise loop glances at the checklist exactly when a box ticks, about every 6 s when idle", () => {
    expect(CLIPS.supervise.loop).toBe(true);
    for (const a of SUPERVISE_TICK_AT) {
      const { pose } = sample("supervise", a);
      for (let i = 0; i < POSE_LEN; i++) expect(pose[i]).toBeCloseTo(POSE_VECTORS.superviseCheck[i]!, 5);
    }
    expect(CLIPS.supervise.len / SUPERVISE_TICK_AT.length / tempoFor("idle", 0)).toBeCloseTo(6, 1);
    // he looks both ways over his team
    const gazes = new Set<number>();
    for (let t = 0; t < CLIPS.supervise.len; t += 0.05) gazes.add(gazeBucket(sample("supervise", t).info.gaze));
    expect(gazes.has(2)).toBe(true);
    expect(gazes.has(-2)).toBe(true);
  });

  test("the checklist ticks one box per glance and starts a fresh list after a full one", () => {
    const len = CLIPS.supervise.len;
    const [a, b] = SUPERVISE_TICK_AT as [number, number];
    expect(CHECK_ROWS).toBe(3);
    expect(checklistTicks(0)).toBe(0);
    expect(checklistTicks(a - 0.01)).toBe(0);
    expect(checklistTicks(a)).toBe(1);
    expect(checklistTicks(b - 0.01)).toBe(1);
    expect(checklistTicks(b)).toBe(2);
    // (just past each tick: len + a is not exactly representable)
    expect(checklistTicks(len + a + 0.01)).toBe(3);
    expect(checklistTicks(len + b + 0.01)).toBe(0);
    expect(checklistTicks(2 * len + a + 0.01)).toBe(1);
    expect(checklistTicks(Number.NaN)).toBe(0);
    expect(checklistTicks(-1)).toBe(0);
  });
});

const rsample = (r: Reaction, t: number): ReactionSample => sampleReaction(r, t, newReactionSample());
/** Consecutive distinct values of `pick` over the reaction (1/480 s steps, through the end). */
const sequence = <T>(r: Reaction, pick: (s: ReactionSample) => T): T[] => {
  const seen: T[] = [];
  for (let t = 0; t <= r.len + 0.05; t += 1 / 480) {
    const v = pick(rsample(r, t));
    if (seen.length === 0 || seen[seen.length - 1] !== v) seen.push(v);
  }
  return seen;
};

describe("reactions: timeline", () => {
  test("phase durations: the stare holds 1.6 to 2.2 s, the outburst lasts 1.5 to 2.5 s before its glare", () => {
    for (let r = 0; r < 1; r += 0.1) {
      const s = planReaction("stare", r);
      expect(s.hold).toBeGreaterThanOrEqual(STARE_HOLD_MIN_S);
      expect(s.hold).toBeLessThanOrEqual(STARE_HOLD_MAX_S);
      expect(s.len).toBeCloseTo(STARE_TURN_IN_S + s.hold + REACT_TURN_OUT_S, 9);
      const o = planReaction("outburst", r);
      expect(o.rage).toBeGreaterThanOrEqual(OUTBURST_MIN_S);
      expect(o.rage).toBeLessThanOrEqual(OUTBURST_MAX_S);
      expect(o.face).toBeCloseTo(o.rage + GLARE_S, 9);
      expect(o.len).toBeCloseTo(o.rage + GLARE_S + REACT_TURN_OUT_S, 9);
    }
    expect(planReaction("stare", Number.NaN).hold).toBeCloseTo((STARE_HOLD_MIN_S + STARE_HOLD_MAX_S) / 2, 9);
    // a smooth turn in, a slower return
    expect(STARE_TURN_IN_S).toBeLessThan(REACT_TURN_OUT_S);
    expect(OUTBURST_TURN_IN_S).toBeLessThan(STARE_TURN_IN_S);
  });

  test("stare: eyes snap wide open, narrow into the glare, one slow blink in the hold, then the activity's eyes", () => {
    const r = planReaction("stare", 0.5);
    expect(rsample(r, 0).emotion).toBe("surprised");
    expect(rsample(r, SURPRISE_S - 0.01).emotion).toBe("surprised");
    expect(rsample(r, SURPRISE_S).emotion).toBe("glare");
    expect(sequence(r, (s) => s.emotion)).toEqual(["surprised", "glare", null]);
    expect(sequence(r, (s) => s.blink)).toEqual([0, 1, 2, 1, 0, -1]);
    let shut = 0;
    for (let t = 0; t < r.len; t += 1 / 480) if (rsample(r, t).blink > 0) shut += 1 / 480;
    expect(shut).toBeGreaterThan(SLOW_BLINK_S * 0.5);
    expect(shut).toBeLessThanOrEqual(SLOW_BLINK_S + 0.01);
    // he faces the camera through the whole hold, and never raises his fists
    for (let t = r.turnIn; t < r.face; t += 0.05) expect(rsample(r, t).turn).toBe(1);
    for (let t = 0; t < r.len; t += 0.05) expect(rsample(r, t).rage + rsample(r, t).mark + rsample(r, t).steam + rsample(r, t).aura).toBe(0);
  });

  test("outburst: strain then angry eyes, fists up, a stomp, mark, steam and aura, then the glare", () => {
    const r = planReaction("outburst", 0.5);
    expect(sequence(r, (s) => s.emotion)).toEqual(["strain", "angry", "glare", null]);
    expect(rsample(r, YELL_S - 0.01).emotion).toBe("strain");
    expect(rsample(r, YELL_S).emotion).toBe("angry");
    expect(rsample(r, r.rage).emotion).toBe("glare");
    expect(rsample(r, RAGE_IN_S).rage).toBeCloseTo(1, 9);
    expect(rsample(r, r.rage - RAGE_OUT_S).rage).toBeCloseTo(1, 9);
    expect(rsample(r, r.rage).rage).toBeCloseTo(0, 9);
    expect(rsample(r, STOMP_AT_S - 0.01).stomp).toBe(0);
    expect(rsample(r, STOMP_AT_S).stomp).toBe(1);
    const mid = rsample(r, r.rage / 2);
    expect(mid.mark).toBeCloseTo(1, 6);
    expect(mid.steam).toBeCloseTo(1, 6);
    expect(mid.aura).toBeGreaterThan(0.5);
    // the glare: still facing the camera with the fists down and the effects gone
    const glare = rsample(r, r.face - 0.05);
    expect(glare.turn).toBe(1);
    expect(glare.rage + glare.mark + glare.steam + glare.aura + glare.stomp).toBe(0);
    expect(glare.emotion).toBe("glare");
  });

  test("both reactions return to the activity: every layer weight eases back to 0 without a jump", () => {
    for (const kind of ["stare", "outburst"] as const satisfies readonly ReactionKind[]) {
      for (const u of [0, 0.5, 0.99]) {
        const r = planReaction(kind, u);
        let prev = rsample(r, 0);
        expect(prev.turn).toBe(0);
        expect(prev.done).toBe(false);
        for (let t = 1 / 480; t <= r.len + 0.05; t += 1 / 480) {
          const s = rsample(r, t);
          expect(Math.abs(s.turn - prev.turn)).toBeLessThan(0.05);
          expect(Math.abs(s.rage - prev.rage)).toBeLessThan(0.05);
          prev = s;
        }
        expect(rsample(r, r.len - 1e-4).turn).toBeLessThan(1e-3);
        const end = rsample(r, r.len);
        expect(end).toEqual({ turn: 0, rage: 0, emotion: null, blink: -1, stomp: 0, mark: 0, steam: 0, aura: 0, done: true });
        expect(rsample(r, r.len + 10).done).toBe(true);
      }
    }
  });

  test("a reaction during a reaction restarts cleanly from the weights already on", () => {
    // a tap mid stare: the outburst starts already facing the camera
    const stare = planReaction("stare", 0.3);
    const s1 = rsample(stare, 1.0);
    expect(s1.turn).toBe(1);
    const out = planReaction("outburst", 0.3, s1);
    expect(out.len).toBeCloseTo(planReaction("outburst", 0.3).len, 9);
    const o0 = rsample(out, 0);
    expect(o0.turn).toBe(1);
    expect(o0.rage).toBe(0);
    expect(o0.emotion).toBe("strain");
    // a tap mid outburst: the fists come down smoothly while the new stare starts over with wide eyes
    const s2 = rsample(out, 1.0);
    expect(s2.rage).toBe(1);
    const st = planReaction("stare", 0.3, s2);
    const t0 = rsample(st, 0);
    expect(t0.turn).toBe(1);
    expect(t0.rage).toBe(1);
    expect(t0.emotion).toBe("surprised");
    expect(rsample(st, RAGE_OUT_S / 2).rage).toBeGreaterThan(0);
    expect(rsample(st, RAGE_OUT_S).rage).toBeCloseTo(0, 9);
    // a tap while he turns back: the turn resumes from where it was
    const late = rsample(st, st.face + REACT_TURN_OUT_S / 2);
    expect(late.turn).toBeCloseTo(0.5, 6);
    const again = planReaction("stare", 0.3, late);
    expect(rsample(again, 0).turn).toBeCloseTo(0.5, 6);
    expect(rsample(again, STARE_TURN_IN_S).turn).toBe(1);
    expect(again.len).toBeCloseTo(stare.len, 9);
    // non-finite carried weights read as none
    const bad = planReaction("stare", 0.3, { turn: Number.NaN, rage: Number.NaN });
    expect(bad.turnFrom).toBe(0);
    expect(bad.rageFrom).toBe(0);
  });

  test("the reaction eyes: the glare is narrowed and intense, the outburst's brows the sharpest", () => {
    expect(EMOTIONS.surprised.open).toBeGreaterThan(EMOTIONS.neutral.open);
    expect(EMOTIONS.glare.open).toBeLessThan(EMOTIONS.focused.open);
    expect(EMOTIONS.glare.pupil).toBeLessThan(EMOTIONS.neutral.pupil);
    expect(EMOTIONS.glare.brow).toBeGreaterThan(EMOTIONS.focused.brow);
    expect(EMOTIONS.angry.brow).toBeGreaterThan(EMOTIONS.determined.brow);
    expect(EMOTIONS.angry.pupil).toBeLessThan(EMOTIONS.determined.pupil);
    expect(POSES.outburst.emotion).toBe("angry");
  });
});

describe("reactions: turning to the camera", () => {
  test("the yaw spreads over spine, chest, neck and head; the root turns only for what they cannot cover", () => {
    const out = new Float32Array(5);
    const sum = (): number => out.reduce((s, v) => s + v, 0);
    distributeYaw(0.8, out);
    expect(sum()).toBeCloseTo(0.8, 5);
    expect(out[0]).toBeCloseTo(0, 6);
    expect(out[4]).toBeGreaterThan(out[1]!);
    distributeYaw(3, out);
    expect(sum()).toBeCloseTo(3, 5);
    expect(out[0]).toBeGreaterThan(1);
    for (let i = 1; i < 5; i++) expect(Math.abs(out[i]!)).toBeLessThanOrEqual(0.7 + 1e-6);
    distributeYaw(-3, out);
    expect(sum()).toBeCloseTo(-3, 5);
    expect(out[0]).toBeLessThan(-1);
    distributeYaw(Math.PI * 2 + 0.5, out);
    expect(sum()).toBeCloseTo(0.5, 5);
    distributeYaw(Number.NaN, out);
    expect([...out]).toEqual([0, 0, 0, 0, 0]);
  });
});

// ------------------------------------------------------------------------------------------ P-VIZ.6 (ADR-0637)

/** viz_scene's node seed: the id hashed the same way. */
const idSeed = (id: string): number => {
  let s = 7;
  for (let i = 0; i < id.length; i++) s = (s * 31 + id.charCodeAt(i)) >>> 0;
  return s;
};
const NODE_IDS = Array.from({ length: 2000 }, (_, i) =>
  i % 3 === 0 ? `agent-${i}` : i % 3 === 1 ? `sub:${i}:task-${(i * 7919) % 1000}` : `${((i * 2654435761) >>> 0).toString(16)}-lane`);
const hsample = (p: HitPlan, t: number, pose?: Float32Array): HitSample => sampleHit(p, t, newHitSample(), pose);
/** Decay `c` over `secs` in frame-sized steps. */
const decayFor = (c: Charge, secs: number, dt = 1 / 60): Charge => {
  const n = Math.round(secs / dt);
  for (let i = 0; i < n; i++) decayCharge(c, dt);
  return c;
};

describe("P-VIZ.6: who a node is", () => {
  test("a node's gender is stable for its id and about half and half over a fleet", () => {
    let female = 0;
    for (const id of NODE_IDS) {
      const g = seededGender(idSeed(id));
      expect(seededGender(idSeed(id))).toBe(g);
      if (g === "female") female++;
    }
    expect(female / NODE_IDS.length).toBeGreaterThan(0.42);
    expect(female / NODE_IDS.length).toBeLessThan(0.58);
    // consecutive seeds mix too (a figure built without a node seed falls back to an instance counter)
    expect(new Set(Array.from({ length: 16 }, (_, i) => seededGender(i + 1))).size).toBe(2);
    expect(seededGender(Number.NaN)).toBe(seededGender(0));
  });
});

describe("P-VIZ.6: charge", () => {
  test("a bolt supercharges to 1 and is fully gone by BOLT_S; a drink is 0.6 and gone by DRINK_S", () => {
    const c = animeHitCharge(newCharge(), "bolt", 1);
    expect(chargeLevel(c)).toBe(1);
    decayFor(c, BOLT_S - 1);
    expect(chargeLevel(c)).toBeGreaterThan(0);
    expect(chargeLevel(c)).toBeLessThan(0.1);
    decayFor(c, 1.5);
    expect(chargeLevel(c)).toBe(0);
    expect(c.boostRate).toBe(0);
    decayFor(c, 30); // and it stays at 0: no drift below it, no NaN
    expect(chargeLevel(c)).toBe(0);
    const d = addBoost(newCharge(), DRINK_CHARGE, DRINK_S);
    expect(chargeLevel(d)).toBeCloseTo(0.6, 9);
    decayFor(d, DRINK_S / 2);
    expect(chargeLevel(d)).toBeCloseTo(0.3, 2);
    decayFor(d, DRINK_S / 2 + 0.1);
    expect(chargeLevel(d)).toBe(0);
  });

  test("energy balls stack to ORB_MAX (+12 percent), a third of the charge each, and wear off over ORB_DECAY_S", () => {
    const c = animeHitCharge(newCharge(), "orb", 1);
    expect(chargeLevel(c)).toBeCloseTo(1 / 3, 9);
    expect(orbScale(c)).toBeCloseTo(1.04, 9);
    for (let i = 0; i < 10; i++) animeHitCharge(c, "orb", 1);
    expect(c.orbs).toBe(ORB_MAX);
    expect(orbScale(c)).toBeCloseTo(1.12, 9);
    expect(chargeLevel(c)).toBe(1);
    decayFor(c, ORB_DECAY_S / 2);
    expect(orbScale(c)).toBeGreaterThan(1.05);
    expect(orbScale(c)).toBeLessThan(1.07);
    decayFor(c, ORB_DECAY_S / 2 + 0.5);
    expect(c.orbs).toBe(0);
    expect(orbScale(c)).toBe(1);
    expect(chargeLevel(c)).toBe(0);
  });

  test("a weaker or shorter boost never cuts a running one short; a stronger one takes over", () => {
    const c = animeHitCharge(newCharge(), "bolt", 1);
    decayFor(c, 2);
    const before = chargeLevel(c);
    addBoost(c, DRINK_CHARGE, DRINK_S);
    expect(chargeLevel(c)).toBeCloseTo(before, 9);
    decayFor(c, 12.5); // the bolt had 13 s left
    expect(chargeLevel(c)).toBeGreaterThan(0);
    const d = addBoost(newCharge(), DRINK_CHARGE, DRINK_S);
    decayFor(d, 10);
    animeHitCharge(d, "bolt", 1);
    expect(chargeLevel(d)).toBe(1);
    decayFor(d, BOLT_S - 1);
    expect(chargeLevel(d)).toBeGreaterThan(0);
    // nonsense in, nothing changes
    const e = addBoost(newCharge(), 0.5, 5);
    addBoost(e, Number.NaN, 5);
    addBoost(e, 1, 0);
    decayCharge(e, Number.NaN);
    decayCharge(e, -3);
    expect(chargeLevel(e)).toBeCloseTo(0.5, 9);
  });

  test("only the anime throwables (and the Storm) charge the anime figure; the tempo follows the charge", () => {
    for (const k of ["paper", "band", "drink", "stars"] as const) expect(chargeLevel(animeHitCharge(newCharge(), k, 1))).toBe(0);
    expect(chargeLevel(animeHitCharge(newCharge(), "storm", 1))).toBeCloseTo(0.5, 9);
    expect(chargeLevel(animeHitCharge(newCharge(), "bolt", 0.4))).toBeCloseTo(0.4, 9);
    expect(chargeTempo(0)).toBe(1);
    expect(chargeTempo(0.5)).toBeCloseTo(1.4, 9);
    expect(chargeTempo(1)).toBeCloseTo(1.8, 9);
    expect(chargeTempo(5)).toBeCloseTo(1.8, 9);
    expect(chargeTempo(Number.NaN)).toBe(1);
  });
});

describe("P-VIZ.6: hits", () => {
  const PLAYS = Object.keys(HIT_CLIPS) as AnimeHit[];

  test("hit clips are one-shots: keys start at 0, ascend strictly, end inside the clip, outlast the turn and the hand-back", () => {
    for (const n of PLAYS) {
      const c = HIT_CLIPS[n];
      expect(c.loop).toBe(false);
      expect(c.keys[0]!.at).toBe(0);
      for (let i = 1; i < c.keys.length; i++) expect(c.keys[i]!.at).toBeGreaterThan(c.keys[i - 1]!.at);
      expect(c.keys[c.keys.length - 1]!.at).toBeLessThanOrEqual(c.len);
      expect(c.len).toBeGreaterThan(HIT_OUT_S + HIT_TURN_S);
    }
  });

  test("each throwable plays its own reaction; the office ones are a generic flinch; only the Storm does not turn", () => {
    const plays = Object.fromEntries(HIT_KINDS.map((k) => [k, planHit(k, 1, null, 0, 0)]));
    for (const k of ["paper", "band", "drink"]) expect(plays[k]!.play).toBe("flinch");
    expect(plays.stars!.play).toBe("starBlockR");
    expect(plays.bolt!.play).toBe("bolt");
    expect(plays.orb!.play).toBe("orb");
    expect(plays.storm!.play).toBe("storm");
    for (const k of HIT_KINDS) expect(plays[k]!.turns).toBe(k !== "storm");
    expect(HIT_CLIPS.flinch.len).toBeGreaterThanOrEqual(1.5);
    expect(HIT_CLIPS.flinch.len).toBeLessThanOrEqual(2.5);
    expect(HIT_CLIPS.storm.len).toBeGreaterThanOrEqual(2.5);
    expect(HIT_CLIPS.storm.len).toBeLessThanOrEqual(3.5);
  });

  test("every hit ends cleanly: the weight eases back to 0 without a jump and the eyes go back to the activity's", () => {
    const pose = new Float32Array(POSE_LEN);
    for (const k of HIT_KINDS) {
      const p = planHit(k, 1, null, 0, 0);
      let prev = hsample(p, 0, pose);
      expect(prev.body).toBe(1);
      expect(prev.blend).toBe(0);
      expect(prev.done).toBe(false);
      expect(prev.emotion).not.toBeNull();
      for (let t = 1 / 240; t < p.len + 0.1; t += 1 / 240) {
        const s = hsample(p, t, pose);
        for (const v of pose) expect(Number.isFinite(v)).toBe(true);
        expect(s.body).toBeGreaterThanOrEqual(0);
        expect(s.body).toBeLessThanOrEqual(1);
        expect(Math.abs(s.body - prev.body)).toBeLessThan(0.05);
        expect(Math.abs(s.turn - prev.turn)).toBeLessThan(0.1);
        prev = s;
      }
      expect(hsample(p, p.len - 1e-4).body).toBeLessThan(1e-3);
      expect(hsample(p, p.len - HIT_OUT_S * 0.4).emotion).toBeNull();
      expect(hsample(p, p.len)).toEqual({ body: 0, blend: 1, turn: 0, emotion: null, aura: 0, crackle: 0, absorb: 0, shake: 0, done: true });
      expect(hsample(p, Number.NaN).done).toBe(false); // a bad clock reads as the start, never a stuck end
    }
  });

  test("throwing stars: block right, block left, catch the third with smug eyes; a late star starts a new chain", () => {
    const a = planHit("stars", 1, null, 0, 0);
    expect(a.play).toBe("starBlockR");
    const b = planHit("stars", 1, a, 0.15, hsample(a, 0.15).turn);
    expect(b.play).toBe("starBlockL");
    const c = planHit("stars", 1, b, 0.15, hsample(b, 0.15).turn);
    expect(c.play).toBe("starCatch");
    expect(hsample(c, 1.0).emotion).toBe("smug");
    expect(c.len).toBeCloseTo(2.2, 6);
    // the arms alternate: the right forearm comes up first, then the left
    const shR = jointOffset("shR"), shL = jointOffset("shL");
    const pa = new Float32Array(POSE_LEN), pb = new Float32Array(POSE_LEN);
    hsample(a, 0.3, pa);
    hsample(b, 0.3, pb);
    expect(pa[shR]!).toBeLessThan(pa[shL]!);
    expect(pb[shL]!).toBeLessThan(pb[shR]!);
    // long after the catch, or after another kind of hit, a star opens a new chain
    expect(planHit("stars", 1, c, STAR_CHAIN_S + 0.5, 0).play).toBe("starBlockR");
    expect(planHit("stars", 1, planHit("bolt", 1, null, 0, 0), 0.1, 0).play).toBe("starBlockR");
  });

  test("a hit landing mid-hit never leaves a stuck pose: the turn carries on, the clip blends in, the last one ends", () => {
    let seed = 12345;
    const rnd = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let run = 0; run < 60; run++) {
      let plan: HitPlan | null = null;
      const n = 2 + Math.floor(rnd() * 6);
      for (let i = 0; i < n; i++) {
        const kind = HIT_KINDS[Math.floor(rnd() * HIT_KINDS.length)]!;
        const at = rnd() * 2.6; // seconds into the current hit when the next lands (it may have ended by then)
        let live: HitPlan | null = null, prevTurn = 0;
        if (plan) {
          const s = hsample(plan, at);
          if (!s.done) { live = plan; prevTurn = s.turn; }
        }
        const next = planHit(kind, 1, live, at, prevTurn);
        const s0 = hsample(next, 0);
        expect(s0.body).toBe(1);
        expect(s0.blend).toBe(0); // it starts from the pose on screen
        expect(s0.turn).toBeCloseTo(prevTurn, 9);
        expect(hsample(next, HIT_BLEND_S).blend).toBe(1);
        plan = next;
      }
      const last = plan!;
      const end = hsample(last, last.len + 0.01);
      expect(end.done).toBe(true);
      expect(end.body).toBe(0);
      expect(end.turn).toBe(0);
      expect(end.emotion).toBeNull();
    }
  });

  test("Storm: about 3 s of power-up to the sky, then the body is the interrupted activity's again", () => {
    const p = planHit("storm", 1, null, 0, 0);
    const pose = new Float32Array(POSE_LEN);
    const mid = hsample(p, 1.5, pose);
    expect(mid.body).toBe(1);
    expect(mid.turn).toBe(0);
    expect(mid.emotion).toBe("determined");
    expect(mid.aura).toBeGreaterThan(0.5);
    expect(pose[jointOffset("head")]!).toBeLessThan(-0.3); // face up to the sky
    // the figure lays the hit over the activity by `body`: once it ends, what shows is the activity's own pose
    const act = sample("typing", 2.0).pose;
    const shown = new Float32Array(POSE_LEN);
    for (const t of [p.len - HIT_OUT_S / 2, p.len, p.len + 1]) {
      const s = hsample(p, t, pose);
      for (let i = 0; i < POSE_LEN; i++) shown[i] = act[i]! + (pose[i]! - act[i]!) * s.body;
      if (t >= p.len) expect([...shown]).toEqual([...act]);
      else expect(s.body).toBeGreaterThan(0);
    }
  });

  test("bolt: struck rigid with strain, a crackle and a shake, then the aura; orb: the ball between the hands, then the aura", () => {
    const b = planHit("bolt", 1, null, 0, 0);
    const b0 = hsample(b, 0.2);
    expect(b0.emotion).toBe("strain");
    expect(b0.crackle).toBeGreaterThan(0.9);
    expect(b0.shake).toBeGreaterThan(0);
    const b1 = hsample(b, 1.3);
    expect(b1.aura).toBeGreaterThan(0.9);
    expect(b1.crackle).toBe(0);
    const o = planHit("orb", 1, null, 0, 0);
    expect(hsample(o, 0.8).absorb).toBe(1);
    expect(hsample(o, 0.8).emotion).toBe("calm");
    expect(hsample(o, 2.0).absorb).toBe(0);
    expect(hsample(o, 2.0).aura).toBeGreaterThan(0.9);
    // strength scales the effects, not the choreography
    const weak = planHit("bolt", 0.25, null, 0, 0);
    expect(hsample(weak, 0.2).crackle).toBeCloseTo(0.25, 6);
    expect(hsample(weak, 0.2).body).toBe(1);
  });
});

// ------------------------------------------------------------------------------------------ P-VIZ.7 (ADR-0641)

const NEW_LOOPS: readonly ClipName[] = [...WEAPON_CLIPS, "commit"];
/** The largest per-joint change between two samples `step` apart, over the whole loop. */
const maxStep = (name: ClipName, step = 1 / 120): number => {
  let worst = 0;
  let prev = sample(name, 0).pose;
  for (let t = step; t <= CLIPS[name].len; t += step) {
    const p = sample(name, t).pose;
    for (let i = 0; i < POSE_LEN; i++) worst = Math.max(worst, Math.abs(p[i]! - prev[i]!));
    prev = p;
  }
  return worst;
};
const wrapAngle = (a: number): number => a - Math.round(a / (Math.PI * 2)) * Math.PI * 2;

describe("P-VIZ.7: weapon moves and the commit loop", () => {
  test("every new clip loops and eases its last key back into its first (no pop at the wrap)", () => {
    for (const name of NEW_LOOPS) {
      const c = CLIPS[name];
      expect(c.loop).toBe(true);
      const end = sample(name, c.len - 1e-4).pose;
      const start = sample(name, 0).pose;
      for (let i = 0; i < POSE_LEN; i++) expect(Math.abs(end[i]! - start[i]!)).toBeLessThan(1e-3);
    }
  });

  test("joint coverage: every key sets both arms and both hips, so no limb falls back to the rest pose mid-move", () => {
    for (const name of NEW_LOOPS) {
      for (const k of CLIPS[name].keys) {
        const p = POSES[k.pose] as Partial<Record<string, unknown>>;
        for (const j of ["shL", "elL", "shR", "elR", "hipL", "hipR"]) expect(p[j]).toBeDefined();
      }
    }
  });

  test("the weapon moves start and end in the kata guard and are never harsher than the kata's own snaps", () => {
    const kata = maxStep("kata");
    for (const name of WEAPON_CLIPS) {
      const keys = CLIPS[name].keys;
      expect(keys[0]!.pose).toBe("stance");
      expect(keys[keys.length - 1]!.pose).toBe("stance");
      expect(keys.some((k) => k.ease === "snap")).toBe(true);
      expect(maxStep(name)).toBeLessThanOrEqual(kata * 1.1);
      // the right arm does the work: it sweeps through more than a radian
      let lo = Infinity, hi = -Infinity;
      for (const k of keys) {
        const v = POSE_VECTORS[k.pose][jointOffset("shR")]!;
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
      expect(hi - lo).toBeGreaterThan(1);
    }
  });

  test("the weapon is on its mount at every loop boundary and in the hand only from a draw key until its release", () => {
    const s = newWeaponSample();
    for (const w of WEAPONS) {
      const clip = CLIPS[WEAPON_CLIP[w]];
      for (const t of [0, clip.len - 1e-3]) {
        weaponAt(w, t, s);
        expect(s.hand).toBe(false);
        expect(s.fly).toBe(-1);
      }
      for (const [a, b] of [...WEAPON_HAND[w], ...WEAPON_FLY[w]]) {
        expect(a).toBeGreaterThan(0);
        expect(b).toBeLessThan(clip.len);
      }
      // each draw lands on a key (the hand reaching the mount) at most 50 ms before
      for (const [a] of WEAPON_HAND[w]) expect(clip.keys.some((k) => k.at <= a && a - k.at <= 0.05)).toBe(true);
      // never both in the hand and in flight
      for (let t = 0; t < clip.len; t += 1 / 240) {
        weaponAt(w, t, s);
        expect(s.hand && s.fly >= 0).toBe(false);
        expect(s.fly).toBeLessThanOrEqual(1);
      }
    }
  });

  test("thrown weapons leave on a snap release; the kunai fly KUNAI_FLY_S, the chakram comes back to a snap catch", () => {
    for (const w of ["kunai", "disc"] as const) {
      const clip = CLIPS[WEAPON_CLIP[w]];
      for (const [a] of WEAPON_FLY[w]) {
        const key = clip.keys.find((k) => Math.abs(k.at - a) < 1e-9)!;
        expect(key.ease).toBe("snap");
        // released out of the hand: the hand window ends exactly where the flight starts
        expect(WEAPON_HAND[w].some(([, b]) => Math.abs(b - a) < 1e-9)).toBe(true);
      }
    }
    for (const [a, b] of WEAPON_FLY.kunai) expect(b - a).toBeCloseTo(KUNAI_FLY_S, 9);
    const [[, back]] = WEAPON_FLY.disc as [[number, number]];
    const catchKey = CLIPS.discThrow.keys.find((k) => k.pose === "discCatch" && k.ease === "snap")!;
    expect(catchKey.at).toBeCloseTo(back, 9);
    expect(WEAPON_HAND.disc.some(([a]) => Math.abs(a - back) < 1e-9)).toBe(true);
  });

  test("the staff spins STAFF_TURNS whole turns without a jump, held across for the thrust and back along the mount", () => {
    const s = newWeaponSample();
    const clip = CLIPS.staffSpin;
    let prev = weaponAt("staff", 0, s).spin, peak = 0, total = 0;
    for (let t = 1 / 240; t < clip.len; t += 1 / 240) {
      weaponAt("staff", t, s);
      expect(Math.abs(s.spin - prev)).toBeLessThan(0.5);
      total += Math.abs(s.spin - prev);
      prev = s.spin;
      expect(s.blur).toBeGreaterThanOrEqual(0);
      expect(s.blur).toBeLessThanOrEqual(1);
      if (!s.hand) expect(s.blur).toBe(0);
      peak = Math.max(peak, s.blur);
    }
    expect(peak).toBeGreaterThan(0.9);
    expect(total / (Math.PI * 2)).toBeGreaterThanOrEqual(STAFF_TURNS);
    const strike = clip.keys.find((k) => k.pose === "staffStrike")!;
    expect(Math.abs(wrapAngle(weaponAt("staff", strike.at, s).spin - Math.PI / 2))).toBeLessThan(1e-6);
    expect(Math.abs(wrapAngle(weaponAt("staff", clip.len - 1e-3, s).spin))).toBeLessThan(1e-6);
  });

  test("weapon loops: never the first loop, only in the weapon slots, about WEAPON_SHARE, stable and not in lockstep", () => {
    for (const a of MINI_ACTIVITIES) {
      for (let seed = 0; seed < 50; seed++) {
        expect(weaponTurn(a, seed, 0)).toBe(false);
        if (!WEAPON_SLOTS.includes(a)) for (let c = 1; c < 20; c++) expect(weaponTurn(a, seed, c)).toBe(false);
      }
    }
    let on = 0, n = 0;
    const firstLoop = new Set<boolean>();
    for (let seed = 0; seed < 1000; seed++) {
      firstLoop.add(weaponTurn("kata", seed, 1));
      for (let c = 1; c <= 20; c++) {
        const v = weaponTurn("kata", seed * 7919, c);
        expect(weaponTurn("kata", seed * 7919, c)).toBe(v);
        if (v) on++;
        n++;
      }
    }
    expect(Math.abs(on / n - WEAPON_SHARE)).toBeLessThan(0.05);
    expect(firstLoop.size).toBe(2);
    expect(weaponTurn("kata", Number.NaN, 3)).toBe(weaponTurn("kata", 0, 3));
  });

  test("the variant picks one of four weapons: the brand's variant first (wrapped), else the seed's", () => {
    expect(new Set(WEAPONS).size).toBe(4);
    expect(new Set(WEAPONS.map((w) => WEAPON_CLIP[w])).size).toBe(4);
    expect(variantOf(2, 7)).toBe(2);
    expect(variantOf(5, 7)).toBe(1);
    expect(variantOf(-1, 7)).toBe(3);
    expect(variantOf(null, 6)).toBe(2);
    expect(variantOf(undefined, 6)).toBe(2);
    expect(variantOf(Number.NaN, 9)).toBe(1);
    expect(variantOf(null, Number.NaN)).toBe(0);
    for (let v = 0; v < 4; v++) expect(weaponOf(v)).toBe(WEAPONS[v]!);
  });

  test("the commit holds the right arm straight up over planted feet, with glowing raiden eyes the whole loop", () => {
    const shR = jointOffset("shR"), elR = jointOffset("elR"), hipL = jointOffset("hipL"), hipR = jointOffset("hipR");
    for (let t = 0; t < CLIPS.commit.len; t += 1 / 30) {
      const { pose, info } = sample("commit", t);
      expect(pose[shR]!).toBeLessThan(-2.95);
      expect(pose[elR]!).toBeGreaterThan(-0.1);
      // feet wide apart
      expect(pose[hipL + 2]!).toBeLessThan(-0.25);
      expect(pose[hipR + 2]!).toBeGreaterThan(0.25);
      expect(info.emotion).toBe("raiden");
    }
    expect(EMOTIONS.raiden.shape).toBe("glow");
    expect(STILL_T.commit).toBeGreaterThanOrEqual(0);
  });
});

describe("P-VIZ.7: the figure (sponsor, size, commit storm)", () => {
  /** bun has no DOM: a canvas whose 2D context accepts every call is enough to build the figure, its eyes and its
   *  patches. The fake document lives only for the construction. */
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
  const brand = (scale: number, variant: number): VizBrand =>
    ({ key: "anthropic", word: "CLAUDE", primary: "#d97757", secondary: "#f4e9dc", ink: "#fffaf3", size: scale > 1 ? "large" : scale < 1 ? "small" : "mid", scale, variant, private: false });
  const make = (b: VizBrand | null, seed = 4, flat = false): AnimeFigure =>
    withCanvas(() => createAnimeFigure({ look: lookFor("#38bdf8"), detail: "full", flat, seed, brand: b }));
  let clock = 0;
  const run = (fig: AnimeFigure, secs: number, motion = true): void => {
    for (let f = 0; f < Math.round(secs * 60); f++) {
      clock += 1 / 60;
      fig.update(clock, motion ? 1 / 60 : 0, motion);
    }
  };
  /** The bolt: the first mesh drawn with the bolt shader (the forks come after it; the aura's flame shader also has
   *  uA but runs on a clock, uT, which the bolt's does not). */
  const boltOf = (fig: AnimeFigure): THREE.Mesh => {
    const found: THREE.Mesh[] = [];
    fig.group.traverse((o) => {
      if (o instanceof THREE.Mesh && o.material instanceof THREE.ShaderMaterial && "uA" in o.material.uniforms && !("uT" in o.material.uniforms)) found.push(o);
    });
    return found[0]!;
  };
  const ys = (m: THREE.Mesh): number[] => {
    const p = m.geometry.getAttribute("position")!;
    const out: number[] = [];
    for (let i = 0; i < p.count; i++) out.push(p.getY(i));
    return out;
  };

  test("the size class scales the whole body: small 0.88, large 1.1 of a mid figure with the same seed", () => {
    const mid = make(brand(1, 0)), small = make(brand(0.88, 0)), large = make(brand(1.1, 0));
    const s = (f: AnimeFigure) => f.group.children[0]!.scale.x;
    expect(s(small) / s(mid)).toBeCloseTo(0.88, 6);
    expect(s(large) / s(mid)).toBeCloseTo(1.1, 6);
    for (const f of [mid, small, large]) f.dispose();
  });

  test("a sponsor adds the front and thigh patches (the 2D map keeps the front one); no sponsor, no patch", () => {
    // seed 4 picks variant 0, the same weapon as the brand's variant 0
    const tris = (b: VizBrand | null, flat: boolean): number => {
      const f = make(b, 4, flat);
      run(f, 0.2);
      const n = animeTriangles(f.group);
      f.dispose();
      return n;
    };
    const patch = tris(brand(1, 0), false) - tris(null, false);
    expect(patch).toBeGreaterThan(0);
    expect(tris(brand(1, 0), true) - tris(null, true)).toBeCloseTo(patch / 2, 0);
  });

  test("setCommit drives the storm: the bolt rises from the raised hand to the cloud, re-jitters, then all of it goes", () => {
    const fig = make(brand(1, 0));
    fig.setActivity("typing");
    run(fig, 0.5);
    const before = animeTriangles(fig.group);
    fig.setCommit(true);
    run(fig, 1.5);
    const bolt = boltOf(fig);
    expect(bolt.visible).toBe(true);
    expect((bolt.material as THREE.ShaderMaterial).uniforms.uA!.value).toBeGreaterThan(0.5);
    const y = ys(bolt);
    // from about the raised fist (above the head, eye height is 1.76) up past the cube top (about 2.9) to the cloud
    expect(Math.min(...y)).toBeGreaterThan(1.8);
    expect(Math.min(...y)).toBeLessThan(2.6);
    expect(Math.max(...y)).toBeGreaterThan(5.5);
    expect(animeTriangles(fig.group)).toBeGreaterThan(before);
    // it holds for as long as the commit runs, and keeps changing shape
    const a = ys(bolt);
    run(fig, 20);
    expect(bolt.visible).toBe(true);
    expect(ys(bolt)).not.toEqual(a);
    fig.setCommit(false);
    run(fig, 1.5);
    expect(bolt.visible).toBe(false);
    expect(animeTriangles(fig.group)).toBe(before);
    fig.dispose();
  });

  test("reduced motion: the bolt and the cloud stand still", () => {
    const fig = make(brand(1, 0));
    fig.setCommit(true);
    run(fig, 0.1, false);
    const bolt = boltOf(fig);
    expect(bolt.visible).toBe(true);
    const a = ys(bolt);
    run(fig, 1, false);
    expect(ys(bolt)).toEqual(a);
    fig.dispose();
  });
});
