// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/viz_office_pose.test.ts - P-VIZ.4 (ADR-0627): the office cast's poses, clips, activity and idle
// mapping, reaction timelines, head-look math, effect timing and the outfit mapping.

import { describe, expect, test } from "bun:test";
import {
  activityClip, CRT_S, crtOff, ENTER_SLAM_S, enterTapBoost, IDLE_SLEEP_S, idleClip, LOOK_PITCH_MAX, LOOK_YAW_MAX, lookAngles, MUG_DROP_S,
  MUG_GRAB_S, mugHeld, OFFICE_CLIP_NAMES, OFFICE_CLIPS, OFFICE_EMOTION_NAMES, OFFICE_EMOTIONS, OFFICE_HAIRS, OFFICE_POSE_LEN, OFFICE_POSE_VECTORS,
  OFFICE_SKINS, OFFICE_STILL_T, officeClipDone, officeClipFor, officeClipTime, officeFaceKey, officeJointOffset, officeLook, officeTempo,
  officeTransitionShot, OUTBURST_S, PAGE_FLIPS, pageFlipAt, paperFlight, PRINT_DROP_S, PRINT_GRAB_S, printHeld, reactAt, reactLength,
  sampleOfficeClip, SEAT, STARE_MAX_S, STARE_MIN_S, stareHold, tapRate, zedAt,
  type Crt, type OfficeClipName, type OfficeClipSample, type OfficeEmotionName, type Paper, type ReactSample, type Zed,
} from "./viz_office_pose.ts";
import { lookFor, MINI_ACTIVITIES, relativeLuminance } from "./viz_mini_look.ts";

const sample = (name: OfficeClipName, t: number): { pose: Float32Array; info: OfficeClipSample } => {
  const pose = new Float32Array(OFFICE_POSE_LEN);
  const info: OfficeClipSample = { emotion: "neutral", gaze: 0 };
  sampleOfficeClip(OFFICE_CLIPS[name], t, pose, info);
  return { pose, info };
};
const emotionsOf = (name: OfficeClipName): Set<OfficeEmotionName> => {
  const seen = new Set<OfficeEmotionName>();
  for (let t = 0; t <= OFFICE_CLIPS[name].len; t += 1 / 60) seen.add(sample(name, t).info.emotion);
  return seen;
};
const fresh = (): ReactSample => ({ body: 0, look: 0, lift: 0, emotion: null, red: 0, steam: 0, shake: 0, papers: -1, slosh: 0, done: false });
const ONE_SHOTS: readonly OfficeClipName[] = ["facepalm", "relax", "slump", "frantic", "done", "outburst"];

describe("pose library", () => {
  test("every pose vector is finite and the right length", () => {
    for (const v of Object.values(OFFICE_POSE_VECTORS)) {
      expect(v.length).toBe(OFFICE_POSE_LEN);
      for (const x of v) expect(Number.isFinite(x)).toBe(true);
    }
  });

  test("everyone sits: a pose that leaves the legs out takes the seated legs", () => {
    const hip = officeJointOffset("hipL"), knee = officeJointOffset("kneeR");
    expect(OFFICE_POSE_VECTORS.type[hip]).toBeCloseTo(SEAT.hipL![0], 6);
    expect(OFFICE_POSE_VECTORS.reportsHold[knee]).toBeCloseTo(SEAT.kneeR![0], 6);
    // the roll overrides them (legs pushing the chair) and moves the chair with the root
    expect(OFFICE_POSE_VECTORS.rollReach[hip]).not.toBeCloseTo(SEAT.hipL![0], 3);
    expect(OFFICE_POSE_VECTORS.rollReach[0]).toBeLessThan(-0.2);
  });
});

describe("clips", () => {
  test("activity, idle and paused clips loop; state shots, burst and the outburst do not", () => {
    for (const n of OFFICE_CLIP_NAMES) expect(OFFICE_CLIPS[n].loop).toBe(!ONE_SHOTS.includes(n));
  });

  test("keys start at 0, ascend strictly, end inside the clip; stills sit inside the clip", () => {
    for (const n of OFFICE_CLIP_NAMES) {
      const c = OFFICE_CLIPS[n];
      expect(c.keys[0]!.at).toBe(0);
      for (let i = 1; i < c.keys.length; i++) expect(c.keys[i]!.at).toBeGreaterThan(c.keys[i - 1]!.at);
      expect(c.keys[c.keys.length - 1]!.at).toBeLessThanOrEqual(c.len);
      expect(OFFICE_STILL_T[n]).toBeGreaterThanOrEqual(0);
      expect(OFFICE_STILL_T[n]).toBeLessThanOrEqual(c.len);
    }
  });

  test("sampling at a key time gives exactly that key's pose", () => {
    for (const n of OFFICE_CLIP_NAMES) {
      for (const k of OFFICE_CLIPS[n].keys) {
        if (k.at >= OFFICE_CLIPS[n].len) continue;
        const { pose } = sample(n, k.at);
        const want = OFFICE_POSE_VECTORS[k.pose];
        for (let i = 0; i < OFFICE_POSE_LEN; i++) expect(pose[i]).toBeCloseTo(want[i]!, 5);
      }
    }
  });

  test("a loop eases its last key back into its first; a one-shot holds its last key", () => {
    for (const n of OFFICE_CLIP_NAMES) {
      const c = OFFICE_CLIPS[n];
      if (c.loop) {
        const end = sample(n, c.len - 1e-4).pose, start = sample(n, 0).pose;
        for (let i = 0; i < OFFICE_POSE_LEN; i++) expect(Math.abs(end[i]! - start[i]!)).toBeLessThan(1e-3);
      } else {
        expect(officeClipDone(c, c.len - 0.01)).toBe(false);
        expect(officeClipDone(c, c.len)).toBe(true);
        const late = sample(n, c.len + 5).pose, last = OFFICE_POSE_VECTORS[c.keys[c.keys.length - 1]!.pose];
        for (let i = 0; i < OFFICE_POSE_LEN; i++) expect(late[i]).toBeCloseTo(last[i]!, 5);
      }
    }
    expect(officeClipTime(OFFICE_CLIPS.type, Number.NaN)).toBe(0);
  });

  test("the faces fit the moment", () => {
    expect(emotionsOf("sleep")).toEqual(new Set<OfficeEmotionName>(["asleep"]));
    expect(emotionsOf("blank")).toEqual(new Set<OfficeEmotionName>(["blank"]));
    expect(emotionsOf("facepalm")).toEqual(new Set<OfficeEmotionName>(["pain"]));
    expect(emotionsOf("slump").has("ko")).toBe(true);
    expect(emotionsOf("frantic")).toEqual(new Set<OfficeEmotionName>(["strain"]));
    expect(emotionsOf("outburst").has("furious")).toBe(true);
    expect(emotionsOf("squint").has("squint")).toBe(true);
    expect(emotionsOf("sip").has("calm")).toBe(true);
    expect(OFFICE_EMOTIONS.strain.sweat).toBe(true);
    expect(OFFICE_EMOTIONS.furious.mouth).toBe("shout");
  });
});

describe("what plays", () => {
  test("worker and boss activity tables", () => {
    const worker: Record<string, OfficeClipName | null> = { typing: "type", kiblast: "enter", kata: "stretch", scan: "squint", dash: "roll", meditate: null, supervise: "squint" };
    const boss: Record<string, OfficeClipName | null> = { typing: "reports", kiblast: "clipboard", kata: "sip", scan: "supervise", dash: "reports", meditate: null, supervise: "supervise" };
    for (const a of MINI_ACTIVITIES) {
      expect(activityClip("worker", a)).toBe(worker[a]!);
      expect(activityClip("boss", a)).toBe(boss[a]!);
    }
  });

  test("idle: coffee under a minute, head down on the desk after", () => {
    expect(idleClip(0)).toBe("sip");
    expect(idleClip(IDLE_SLEEP_S - 0.1)).toBe("sip");
    expect(idleClip(IDLE_SLEEP_S)).toBe("sleep");
    expect(idleClip(Number.NaN)).toBe("sip");
    expect(officeClipFor("worker", "idle", "meditate", 5)).toBe("sip");
    expect(officeClipFor("boss", "idle", "meditate", 120)).toBe("sleep");
    // an idle boss whose team works supervises; he never naps through it
    expect(officeClipFor("boss", "idle", "supervise", 120)).toBe("supervise");
    // working through a meditate slot is a coffee break, not a nap
    expect(officeClipFor("worker", "working", "meditate", 500)).toBe("sip");
  });

  test("power-down states pick their clips over any activity", () => {
    expect(officeClipFor("worker", "paused", "typing", 0)).toBe("blank");
    expect(officeClipFor("worker", "failed", "typing", 0)).toBe("facepalm");
    expect(officeClipFor("boss", "ended", "typing", 0)).toBe("relax");
    expect(officeClipFor("boss", "killed", "typing", 0)).toBe("slump");
    expect(officeClipFor("boss", "working", "supervise", 0)).toBe("supervise");
    expect(officeTransitionShot("working", "idle")).toBe("done");
    expect(officeTransitionShot("idle", "working")).toBeNull();
  });

  test("tempo and taps follow the intensity; paused freezes", () => {
    expect(officeTempo("working", 1)).toBeGreaterThan(officeTempo("working", 0));
    expect(officeTempo("paused", 1)).toBe(0);
    expect(tapRate(1, false)).toBeGreaterThan(tapRate(0, false));
    expect(tapRate(0, true)).toBeGreaterThan(tapRate(1, false));
    expect(tapRate(Number.NaN, false)).toBe(tapRate(0, false));
  });
});

describe("props and effect timing", () => {
  test("the mug is in hand exactly between the reach keys of the sip", () => {
    const keys = OFFICE_CLIPS.sip.keys;
    expect(keys.some((k) => k.at === MUG_GRAB_S && k.pose === "reachMug")).toBe(true);
    expect(keys.some((k) => k.at === MUG_DROP_S && k.pose === "reachMug")).toBe(true);
    expect(mugHeld("sip", MUG_GRAB_S - 0.01)).toBe(false);
    expect(mugHeld("sip", 2)).toBe(true);
    expect(mugHeld("sip", MUG_DROP_S)).toBe(false);
    expect(mugHeld("type", 2)).toBe(false);
    expect(printHeld("roll", (PRINT_GRAB_S + PRINT_DROP_S) / 2)).toBe(true);
    expect(printHeld("roll", 0.2)).toBe(false);
  });

  test("Enter: the taps speed up, stop for the wind-up, and the slam is a snap key", () => {
    expect(enterTapBoost(1.4)).toBeGreaterThan(enterTapBoost(0.1));
    expect(enterTapBoost(ENTER_SLAM_S)).toBe(0);
    expect(enterTapBoost(2.9)).toBe(1);
    expect(OFFICE_CLIPS.enter.keys.some((k) => k.at === ENTER_SLAM_S && k.pose === "enterSlam" && k.ease === "snap")).toBe(true);
  });

  test("a page turns near each reportsFlip key and only then", () => {
    const flips = OFFICE_CLIPS.reports.keys.filter((k) => k.pose === "reportsFlip");
    expect(flips.length).toBe(PAGE_FLIPS.length);
    for (const s of PAGE_FLIPS) expect(flips.some((k) => Math.abs(k.at - s) < 0.1)).toBe(true);
    expect(pageFlipAt(1)).toBe(-1);
    expect(pageFlipAt(PAGE_FLIPS[0]! + 0.1)).toBeGreaterThan(0);
  });

  test("the CRT power-off: picture to a bright line, line to a dot, then dark", () => {
    const c: Crt = { sx: 0, sy: 0, a: 0 };
    expect(crtOff(-0.1, c).a).toBe(0);
    expect(crtOff(0, c).sy).toBeCloseTo(1, 6);
    expect(crtOff(0.17, c).sy).toBeLessThan(0.1);
    expect(crtOff(0.37, c).sx).toBeLessThan(0.1);
    expect(crtOff(CRT_S, c).a).toBe(0);
  });

  test("papers fly up from the pile and come down no lower than the floor", () => {
    const p: Paper = { x: 0, y: 0, z: 0, rx: 0, rz: 0 };
    for (let i = 0; i < 6; i++) {
      paperFlight(i, 6, 0, 0.5, p);
      expect(Math.hypot(p.x - 0.04 * Math.sin(i), p.y, p.z)).toBeLessThan(1e-9);
      let top = 0;
      for (let u = 0; u <= 1; u += 0.02) { paperFlight(i, 6, u, 0.5, p); top = Math.max(top, p.y); expect(p.y).toBeGreaterThanOrEqual(-0.5); }
      expect(top).toBeGreaterThan(0.2);
    }
  });

  test("sleeping z's rise and fade in and out", () => {
    const z: Zed = { x: 0, y: 0, s: 0, a: 0 };
    for (let t = 0; t < 5; t += 0.05) {
      zedAt(1, 3, t, z);
      expect(z.a).toBeGreaterThanOrEqual(0);
      expect(z.a).toBeLessThanOrEqual(1);
      expect(z.y).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("reactions", () => {
  test("a stare snaps the head to the camera, holds 1.6 to 2.2 s with annoyed eyes, then lets go", () => {
    for (let r = 0; r < 1; r += 0.1) {
      const hold = stareHold(r);
      expect(hold).toBeGreaterThanOrEqual(STARE_MIN_S);
      expect(hold).toBeLessThanOrEqual(STARE_MAX_S);
    }
    const hold = stareHold(0.5), s = fresh();
    expect(reactAt("stare", 0.15, hold, s).look).toBeCloseTo(1, 6);
    expect(reactAt("stare", 0.05, hold, s).emotion).toBe("wide");
    expect(reactAt("stare", 1.0, hold, s).emotion).toBe("annoyed");
    expect(reactAt("stare", hold - 0.01, hold, s).look).toBe(1);
    for (let t = 0; t <= reactLength("stare", hold); t += 0.05) expect(reactAt("stare", t, hold, s).body).toBe(0);
    const end = reactAt("stare", reactLength("stare", hold), hold, s);
    expect(end.done).toBe(true);
    expect(end.look).toBe(0);
    expect(end.emotion).toBeNull();
  });

  test("an outburst lasts 1.5 to 2.5 s, red-faced and steaming, papers flying, then a glare at the camera", () => {
    const s = fresh();
    let first = -1, last = -1, glare = false;
    for (let t = 0; t <= reactLength("outburst", 2); t += 0.01) {
      reactAt("outburst", t, 2, s);
      if (s.body > 0.5) { if (first < 0) first = t; last = t; }
      if (s.body < 0.05 && t > OUTBURST_S && s.look > 0.99) glare = true;
    }
    expect(last - first).toBeGreaterThanOrEqual(1.5);
    expect(last - first).toBeLessThanOrEqual(2.5);
    expect(glare).toBe(true);
    reactAt("outburst", 1.0, 2, s);
    expect(s.red).toBeGreaterThan(0.9);
    expect(s.steam).toBeGreaterThan(0.9);
    expect(s.emotion).toBe("furious");
    expect(s.papers).toBeGreaterThanOrEqual(0);
    expect(s.papers).toBeLessThan(1);
    expect(reactAt("outburst", 0.34, 2, s).shake).toBeGreaterThan(0.8);
    expect(reactAt("outburst", OUTBURST_S + 0.5, 2, s).emotion).toBe("glare");
    expect(reactAt("outburst", reactLength("outburst", 2), 2, s).done).toBe(true);
  });

  test("the head look: straight ahead is zero, up lifts the face, and the neck clamps", () => {
    const a = { yaw: 9, pitch: 9 };
    lookAngles(0, 0, 1, a);
    expect(a.yaw).toBeCloseTo(0, 9);
    expect(a.pitch).toBeCloseTo(0, 9);
    lookAngles(1, 0, 1, a);
    expect(a.yaw).toBeCloseTo(Math.PI / 4, 6);
    lookAngles(0, 0.5, 1, a);
    expect(a.pitch).toBeCloseTo(-Math.atan(0.5), 6);
    lookAngles(-0.1, 0, -1, a);
    expect(Math.abs(a.yaw)).toBe(LOOK_YAW_MAX);
    lookAngles(0, -5, 0.1, a);
    expect(a.pitch).toBe(LOOK_PITCH_MAX);
    lookAngles(Number.NaN, 0, 1, a);
    expect(a.yaw).toBe(0);
  });
});

describe("face and outfit", () => {
  test("one face key per emotion, blink step and gaze bucket", () => {
    const keys = new Set<number>();
    for (const e of OFFICE_EMOTION_NAMES) for (let b = 0; b < 3; b++) for (let g = -2; g <= 2; g++) keys.add(officeFaceKey(e, b, g));
    expect(keys.size).toBe(OFFICE_EMOTION_NAMES.length * 15);
  });

  test("the persona color is the tie; the worker's shirt is a lighter tint of it; the boss wears a dark suit", () => {
    for (const c of ["#41ff8b", "#38bdf8", "#ff5a5a", "#9d8bff", "#000000", "bad"]) {
      const mini = lookFor(c);
      for (let seed = 0; seed < 8; seed++) {
        const w = officeLook(mini, seed, "worker");
        for (const v of [w.shirt, w.tie, w.slacks, w.jacket, w.shoe, w.skin, w.hair]) expect(v).toMatch(/^#[0-9a-f]{6}$/);
        expect(w.tie).toBe(mini.accent);
        expect(relativeLuminance(w.shirt)).toBeGreaterThanOrEqual(relativeLuminance(w.tie));
        expect(OFFICE_SKINS).toContain(w.skin);
        expect(OFFICE_HAIRS).toContain(w.hair);
        expect(w.mustache).toBe(false);
        expect(officeLook(mini, seed, "worker")).toEqual(w);
      }
      const b = officeLook(mini, 3, "boss");
      expect(b.tie).toBe(mini.accent);
      expect(relativeLuminance(b.jacket)).toBeLessThan(0.08);
      expect(b.glasses && b.mustache).toBe(true);
    }
  });
});
