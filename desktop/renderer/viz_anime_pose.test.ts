// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/viz_anime_pose.test.ts - P-VIZ.3 (ADR-0624): the anime mini Lucid's pose library, clips,
// interpolation math, emotion selection, blink and gaze bucketing, effect timing and the look mapping.

import { describe, expect, test } from "bun:test";
import {
  ANIME_SKIN, animeLook, auraLevel, BLINK_MAX_S, BLINK_MIN_S, BLINK_S, blinkStep, bump, clipDone, clipFor, CLIPS, clipTime, dashSpeed, ease,
  easeOutBack, EMOTION_NAMES, EMOTIONS, eyeKey, gazeBucket, gazeOfBucket, jointOffset, JOINTS, KI_FIRE_S, KI_FLY_S, kiBallAt, LAB_POSES,
  nextBlinkDelay, POSE_LEN, POSE_VECTORS, POSES, sampleClip, shakeLevel, smoothEase, stateEmotion, STILL_T, tapCurve, tempoFor, transitionShot,
  type ClipName, type ClipSample, type EmotionName, type KiBall,
} from "./viz_anime_pose.ts";
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
