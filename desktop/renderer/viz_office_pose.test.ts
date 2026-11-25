// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/viz_office_pose.test.ts - P-VIZ.4 (ADR-0627): the office cast's poses, clips, activity and idle
// mapping, reaction timelines, head-look math, effect timing and the outfit mapping; P-VIZ.5 (ADR-0631): the two
// managers' looks, the seeded alternation schedule and the handover timeline; P-VIZ.6 (ADR-0637): the mixed cast
// of workers and the hit reactions.

import { describe, expect, test } from "bun:test";
import {
  activityClip, applyManagerSwap, MANAGER_HAIR, MANAGER_REBUILD_S, MANAGER_SWAP_MAX_S, MANAGER_SWAP_MIN_S, MANAGER_SWAP_S, MANAGER_VARIANTS,
  managerSwapAt, managerSwapDelay, managerSwapDue, managerSwapReady, OFFICE_STATES, openManagerCast, otherManager, recastManager, seededUnit,
  STAND_POSE, SWAP_AT_S, SWAP_WALK_X, type ManagerCast, type SwapSample,
  CRT_S, crtOff, ENTER_SLAM_S, enterTapBoost, IDLE_SLEEP_S, idleClip, LOOK_PITCH_MAX, LOOK_YAW_MAX, lookAngles, MUG_DROP_S,
  MUG_GRAB_S, mugHeld, OFFICE_CLIP_NAMES, OFFICE_CLIPS, OFFICE_EMOTION_NAMES, OFFICE_EMOTIONS, OFFICE_HAIRS, OFFICE_POSE_LEN, OFFICE_POSE_VECTORS,
  OFFICE_SKINS, OFFICE_STILL_T, officeClipDone, officeClipFor, officeClipTime, officeFaceKey, officeJointOffset, officeLook, officeTempo,
  officeTransitionShot, OUTBURST_S, PAGE_FLIPS, pageFlipAt, paperFlight, PRINT_DROP_S, PRINT_GRAB_S, printHeld, reactAt, reactLength,
  sampleOfficeClip, SEAT, STARE_MAX_S, STARE_MIN_S, stareHold, tapRate, zedAt,
  type Crt, type OfficeClipName, type OfficeClipSample, type OfficeEmotionName, type Paper, type ReactSample, type Zed,
} from "./viz_office_pose.ts";
import {
  CAN_DROP_S, CAN_GRAB_S, FEMALE_HAIRS, longSleeves, MALE_HAIRS, newOfficeHitSample, OFFICE_HIT_CLIPS, officeHitCharge, officeHitPlay, PAPER_S,
  planOfficeHit, sampleOfficeHit, STORM_PAPERS_AT, workerCast, type OfficeHit, type OfficeHitPlan, type OfficeHitSample, type WorkerTop,
} from "./viz_office_pose.ts";
import {
  applyTyping, buttonPress, COMMIT_BLEND_S, commitLook, COPIER_BUTTON, COPY_EJECTS, COPY_HIPS, COPY_LEN, COPY_PRESS_S, COPY_SIP, copiesStarted,
  copyProgress, copyStartAt, DESK_MUG, EJECT_S, FLICK_S, flickAt, FLICKS, HANDSET_AT, handsetHeld, HEADPHONE_STAND, HEADPHONE_STAND_H,
  keyboardLocal, keyboardPoint, KEYBOARD, LIP_GAP, mugRimNear, mugTilt, OFFICE_ARM_GOALS, OFFICE_RIG, officeArmPoint,
  officeDeskSet, officeFacing, officeHeadPoint, officeMugAt, officePoseHips, officePoseTable, officeVariant, PALM_ALONG, PALM_REST,
  PHONE_DROP_S, PHONE_GRAB_S, PHONES_BACK_S, PHONES_GRAB_S, PHONES_OFF_S, PHONES_ON_S, phonesAt, REF_FIT, SHOULDER_X, SIP_TIP, STAND_LIFT,
  TAP_DRIFT, workerOutfit, type OfficePoseName, type OfficePoseTable, type RigFit, type Vec3,
} from "./viz_office_pose.ts";
import { chargeLevel, decayCharge, DRINK_S, HIT_BLEND_S, HIT_KINDS, HIT_OUT_S, HIT_TURN_S, newCharge, seededGender } from "./viz_anime_pose.ts";
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
        expect(w.grey).toBeNull();
        expect(officeLook(mini, seed, "worker")).toEqual(w);
      }
      for (const v of MANAGER_VARIANTS) {
        const b = officeLook(mini, 3, "boss", v);
        expect(b.tie).toBe(mini.accent);
        expect(relativeLuminance(b.jacket)).toBeLessThan(0.08);
        expect(relativeLuminance(b.shirt)).toBeGreaterThan(0.8);
        // salt and pepper: a dark base with clearly lighter grey streaks
        expect(b.hair).toBe(MANAGER_HAIR[v].base);
        expect(b.grey).toBe(MANAGER_HAIR[v].grey);
        expect(relativeLuminance(b.hair)).toBeLessThan(0.05);
        expect(relativeLuminance(b.grey!)).toBeGreaterThan(0.4);
      }
      const man = officeLook(mini, 3, "boss", "man"), woman = officeLook(mini, 3, "boss", "woman");
      expect(man.jacket).not.toBe(woman.jacket);
      expect(man.shirt).not.toBe(woman.shirt);
      expect(officeLook(mini, 3, "boss")).toEqual(man);
    }
  });

  test("the man wears reading glasses more often than not, the woman less often; both vary by seed", () => {
    const mini = lookFor("#38bdf8");
    let man = 0, woman = 0;
    for (let seed = 0; seed < 400; seed++) {
      if (officeLook(mini, seed, "boss", "man").glasses) man++;
      if (officeLook(mini, seed, "boss", "woman").glasses) woman++;
    }
    expect(man).toBeGreaterThan(200);
    expect(man).toBeLessThan(400);
    expect(woman).toBeGreaterThan(0);
    expect(woman).toBeLessThan(200);
  });
});

describe("the manager on duty", () => {
  test("seeded draws are deterministic, in [0, 1), and differ across draws", () => {
    const seen = new Set<number>();
    for (let k = 0; k < 50; k++) {
      const r = seededUnit(1234, k);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThan(1);
      expect(seededUnit(1234, k)).toBe(r);
      seen.add(r);
    }
    expect(seen.size).toBe(50);
    for (const bad of [Number.NaN, Infinity, -5]) expect(Number.isFinite(seededUnit(bad, 0))).toBe(true);
  });

  test("a new open flips a seeded coin: both managers open, roughly half the time each", () => {
    let woman = 0;
    for (let seed = 0; seed < 2000; seed++) {
      const c = openManagerCast(seed, 100, null);
      expect(openManagerCast(seed, 100, null)).toEqual(c);
      if (c.variant === "woman") woman++;
      expect(c.swaps).toBe(0);
      expect(c.nextAt).toBeGreaterThanOrEqual(100 + MANAGER_SWAP_MIN_S);
      expect(c.nextAt).toBeLessThanOrEqual(100 + MANAGER_SWAP_MAX_S);
    }
    expect(woman).toBeGreaterThan(850);
    expect(woman).toBeLessThan(1150);
  });

  test("a rebuild right after the last boss went away keeps the cast; a later open flips again", () => {
    const cast: ManagerCast = { variant: "woman", seed: 7, swaps: 3, nextAt: 900 };
    const memo = { cast, goneAt: 500 };
    expect(openManagerCast(99, 500.5, memo)).toBe(cast);
    expect(openManagerCast(99, 500 + MANAGER_REBUILD_S, memo)).toBe(cast);
    expect(openManagerCast(99, 500 + MANAGER_REBUILD_S + 1, memo)).toEqual(openManagerCast(99, 500 + MANAGER_REBUILD_S + 1, null));
    // a memo from another clock (gone "in the future") is not trusted
    expect(openManagerCast(99, 400, memo)).toEqual(openManagerCast(99, 400, null));
  });

  test("every handover is 8 to 15 minutes after the last, seeded, and alternates the managers", () => {
    let c = openManagerCast(42, 0, null);
    const delays = new Set<number>();
    let now = 0;
    for (let i = 0; i < 30; i++) {
      now = c.nextAt;
      expect(managerSwapDue(c, now - 0.01)).toBe(false);
      expect(managerSwapDue(c, now)).toBe(true);
      const next = recastManager(c, otherManager(c.variant), now);
      expect(next.variant).not.toBe(c.variant);
      expect(next.swaps).toBe(c.swaps + 1);
      const d = next.nextAt - now;
      expect(d).toBeGreaterThanOrEqual(MANAGER_SWAP_MIN_S);
      expect(d).toBeLessThanOrEqual(MANAGER_SWAP_MAX_S);
      expect(d).toBeCloseTo(managerSwapDelay(42, next.swaps), 9);
      delays.add(Math.round(d));
      c = next;
    }
    expect(delays.size).toBeGreaterThan(20);
    expect(managerSwapDue(c, Number.NaN)).toBe(false);
  });

  test("a handover waits for a quiet moment at the desk: never mid-reaction or mid one-shot", () => {
    for (const s of OFFICE_STATES) {
      expect(managerSwapReady(s, false, false)).toBe(s === "idle" || s === "working");
      expect(managerSwapReady(s, true, false)).toBe(false);
      expect(managerSwapReady(s, false, true)).toBe(false);
    }
  });

  const swapAt = (t: number): SwapSample =>
    managerSwapAt(t, { stand: 0, x: 0, lift: 0, z: 0, turn: 0, gait: 0, phase: 0, alpha: 0, incoming: false, done: false });

  test("the handover: seated and solid at both ends, standing off to the side and gone at the switch", () => {
    for (const t of [0, -1, Number.NaN]) {
      const s = swapAt(t);
      expect(s.stand).toBe(0); expect(s.x).toBe(0); expect(s.turn).toBe(0); expect(s.gait).toBe(0); expect(s.alpha).toBe(1);
      expect(s.incoming).toBe(false); expect(s.done).toBe(false);
    }
    const mid = swapAt(SWAP_AT_S - 1e-6);
    expect(mid.stand).toBeCloseTo(1, 6);
    expect(mid.x).toBeCloseTo(SWAP_WALK_X, 4);
    expect(mid.alpha).toBeCloseTo(0, 4);
    expect(mid.incoming).toBe(false);
    expect(swapAt(SWAP_AT_S).incoming).toBe(true);
    const end = swapAt(MANAGER_SWAP_S);
    expect(end.done).toBe(true);
    expect(end.stand).toBe(0); expect(end.x).toBe(0); expect(end.turn).toBeCloseTo(0, 9); expect(end.alpha).toBe(1);
  });

  test("the incoming half mirrors the outgoing one, walking the other way; the dissolve only ever fades out", () => {
    let alpha = 1;
    for (let t = 0; t < SWAP_AT_S; t += 0.02) {
      const a = swapAt(t), b = swapAt(MANAGER_SWAP_S - t);
      expect(b.stand).toBeCloseTo(a.stand, 6);
      expect(b.x).toBeCloseTo(a.x, 6);
      expect(b.alpha).toBeCloseTo(a.alpha, 6);
      expect(b.turn).toBeCloseTo(-a.turn, 6);
      expect(a.turn).toBeGreaterThanOrEqual(0);
      expect(a.alpha).toBeLessThanOrEqual(alpha + 1e-9);
      alpha = a.alpha;
    }
  });

  test("standing straightens the seated legs; seated with no stride leaves the pose alone; the stride alternates", () => {
    const hipL = officeJointOffset("hipL"), hipR = officeJointOffset("hipR");
    const seated = Float32Array.from(OFFICE_POSE_VECTORS.type);
    const still = Float32Array.from(seated);
    applyManagerSwap(still, { ...swapAt(0) });
    expect(Array.from(still)).toEqual(Array.from(seated));
    const up = Float32Array.from(seated);
    applyManagerSwap(up, { ...swapAt(0), stand: 1 });
    for (let i = 0; i < up.length; i++) expect(up[i]!).toBeCloseTo(STAND_POSE[i]!, 6);
    expect(Math.abs(up[hipL]!)).toBeLessThan(0.1);
    expect(seated[hipL]!).toBeLessThan(-1.2);
    const step = Float32Array.from(seated);
    applyManagerSwap(step, { ...swapAt(0), stand: 1, gait: 1, phase: 0.25 });
    expect(step[hipL]! - STAND_POSE[hipL]!).toBeCloseTo(-(step[hipR]! - STAND_POSE[hipR]!), 6);
    expect(step[hipL]!).not.toBeCloseTo(STAND_POSE[hipL]!, 2);
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
const INK_MOUTH = "#0a0a12";
const hsample = (p: OfficeHitPlan, t: number, pose?: Float32Array): OfficeHitSample => sampleOfficeHit(p, t, newOfficeHitSample(), pose);

describe("P-VIZ.6: the mixed cast", () => {
  test("a worker's gender is stable per node, about half and half, and the same as the node's anime figure", () => {
    let women = 0;
    for (const id of NODE_IDS) {
      const seed = idSeed(id);
      const cast = workerCast(seed);
      expect(workerCast(seed)).toEqual(cast);
      expect(cast.gender).toBe(seededGender(seed));
      if (cast.gender === "female") women++;
    }
    expect(women / NODE_IDS.length).toBeGreaterThan(0.42);
    expect(women / NODE_IDS.length).toBeLessThan(0.58);
  });

  test("hairstyles and tops follow the gender, and every one of them turns up over a fleet", () => {
    const hairs = new Set<string>(), tops = new Set<WorkerTop>();
    for (const id of NODE_IDS) {
      const c = workerCast(idSeed(id));
      if (c.gender === "female") {
        expect(FEMALE_HAIRS).toContain(c.hair);
        expect(["blouse", "cardigan", "blazer"]).toContain(c.top);
      } else {
        expect(MALE_HAIRS).toContain(c.hair);
        expect(["shirt", "sweater"]).toContain(c.top);
      }
      hairs.add(c.hair);
      tops.add(c.top);
    }
    expect(hairs.size).toBe(MALE_HAIRS.length + FEMALE_HAIRS.length);
    expect(tops.size).toBe(5);
    expect(longSleeves("shirt") || longSleeves("blouse")).toBe(false);
    expect(longSleeves("sweater") && longSleeves("cardigan") && longSleeves("blazer")).toBe(true);
  });

  test("worker looks: the women's lips are colored, the men's mouths ink; a long top goes over a lighter shirt or blouse", () => {
    for (const color of ["#41ff8b", "#38bdf8", "#ff5a5a", "#9d8bff", "#000000"]) {
      const mini = lookFor(color);
      for (const id of NODE_IDS.slice(0, 300)) {
        const seed = idSeed(id), cast = workerCast(seed), w = officeLook(mini, seed, "worker");
        if (cast.gender === "female") expect(w.lip).not.toBe(INK_MOUTH);
        else expect(w.lip).toBe(INK_MOUTH);
        expect(w.tie).toBe(mini.accent);
        if (longSleeves(cast.top)) expect(relativeLuminance(w.jacket)).toBeLessThan(relativeLuminance(w.shirt));
      }
    }
    // the managers keep their own looks (the woman's rose lips)
    expect(officeLook(lookFor("#38bdf8"), 3, "boss", "woman").lip).not.toBe(INK_MOUTH);
    expect(officeLook(lookFor("#38bdf8"), 3, "boss", "man").lip).toBe(INK_MOUTH);
  });
});

describe("P-VIZ.6: hits", () => {
  const PLAYS = Object.keys(OFFICE_HIT_CLIPS) as OfficeHit[];

  test("hit clips are one-shots: keys start at 0, ascend strictly, end inside the clip, outlast the turn and the hand-back", () => {
    for (const n of PLAYS) {
      const c = OFFICE_HIT_CLIPS[n];
      expect(c.loop).toBe(false);
      expect(c.keys[0]!.at).toBe(0);
      for (let i = 1; i < c.keys.length; i++) expect(c.keys[i]!.at).toBeGreaterThan(c.keys[i - 1]!.at);
      expect(c.keys[c.keys.length - 1]!.at).toBeLessThanOrEqual(c.len);
      expect(c.len).toBeGreaterThan(HIT_OUT_S + HIT_TURN_S);
    }
  });

  test("the office throwables play their own clips, the anime ones a flinch; only the Storm does not turn, only the drink charges", () => {
    for (const k of ["paper", "band", "drink", "storm"] as const) expect(officeHitPlay(k)).toBe(k);
    for (const k of ["stars", "bolt", "orb"] as const) expect(officeHitPlay(k)).toBe("flinch");
    for (const k of HIT_KINDS) {
      expect(planOfficeHit(k, 1, 0).turns).toBe(k !== "storm");
      expect(chargeLevel(officeHitCharge(newCharge(), k, 1))).toBeCloseTo(k === "drink" ? 0.6 : 0, 9);
    }
    expect(OFFICE_HIT_CLIPS.paper.len).toBeCloseTo(2.0, 6);
    expect(OFFICE_HIT_CLIPS.band.len).toBeCloseTo(1.8, 6);
    expect(OFFICE_HIT_CLIPS.storm.len).toBeCloseTo(3.0, 6);
  });

  test("every hit ends cleanly: the weight eases back to 0 without a jump and the face goes back to the activity's", () => {
    const pose = new Float32Array(OFFICE_POSE_LEN);
    for (const k of HIT_KINDS) {
      const p = planOfficeHit(k, 1, 0);
      let prev = hsample(p, 0, pose);
      expect(prev.body).toBe(1);
      expect(prev.blend).toBe(0);
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
      expect(hsample(p, p.len)).toEqual({ body: 0, blend: 1, turn: 0, emotion: null, can: false, mug: false, tilt: 0, papers: -1, shake: 0, done: true });
    }
  });

  test("drink: the can is in hand from the catch to the fist pump, tipped up only to chug; energized after; the charge is gone by DRINK_S", () => {
    const p = planOfficeHit("drink", 1, 0);
    expect(hsample(p, CAN_GRAB_S - 0.01).can).toBe(false);
    expect(hsample(p, CAN_GRAB_S).can).toBe(true);
    expect(hsample(p, CAN_DROP_S - 0.01).can).toBe(true);
    expect(hsample(p, CAN_DROP_S).can).toBe(false);
    expect(hsample(p, 0.5).tilt).toBe(0);
    expect(hsample(p, 1.1).tilt).toBe(1);
    expect(hsample(p, 1.1).emotion).toBe("calm");
    expect(hsample(p, 1.65).tilt).toBe(0);
    expect(hsample(p, 2.0).emotion).toBe("energized");
    const c = officeHitCharge(newCharge(), "drink", 1);
    expect(chargeLevel(c)).toBeCloseTo(0.6, 9);
    for (let i = 0; i < Math.round(DRINK_S * 60) + 6; i++) decayCharge(c, 1 / 60);
    expect(chargeLevel(c)).toBe(0);
  });

  test("storm: papers fly off the pile, he ducks and holds the desk, then straightens up; no turn", () => {
    const p = planOfficeHit("storm", 1, 0);
    const spine = officeJointOffset("spine");
    const pose = new Float32Array(OFFICE_POSE_LEN);
    expect(hsample(p, STORM_PAPERS_AT / 2).papers).toBe(-1);
    const fly = hsample(p, 0.5).papers;
    expect(fly).toBeGreaterThan(0);
    expect(fly).toBeLessThan(1);
    expect(hsample(p, STORM_PAPERS_AT + PAPER_S + 0.01).papers).toBe(-1);
    const duck = hsample(p, 0.8, pose);
    expect(duck.emotion).toBe("strain");
    expect(pose[spine]!).toBeGreaterThan(0.5);
    hsample(p, 2.8, pose);
    expect(Math.abs(pose[spine]!)).toBeLessThan(0.2);
    for (let t = 0; t < p.len; t += 0.1) expect(hsample(p, t).turn).toBe(0);
  });

  test("a hit landing mid-hit never leaves a stuck pose: the turn carries on, the clip blends in, the last one ends", () => {
    let seed = 777;
    const rnd = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let run = 0; run < 60; run++) {
      let plan: OfficeHitPlan | null = null;
      const n = 2 + Math.floor(rnd() * 6);
      for (let i = 0; i < n; i++) {
        const kind = HIT_KINDS[Math.floor(rnd() * HIT_KINDS.length)]!;
        const at = rnd() * 2.6;
        let prevTurn = 0;
        if (plan) {
          const s = hsample(plan, at);
          if (!s.done) prevTurn = s.turn;
        }
        const next = planOfficeHit(kind, 1, prevTurn);
        const s0 = hsample(next, 0);
        expect(s0.body).toBe(1);
        expect(s0.blend).toBe(0);
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
      expect(end.can).toBe(false);
      expect(end.papers).toBe(-1);
    }
  });
});

// ------------------------------------------------------------------------------------------ P-VIZ.7 (ADR-0641)

/** Every build a figure solves its hands for: the worker man and woman, the two managers, the size classes. */
const FITS: readonly RigFit[] = [
  REF_FIT, { shoulderX: SHOULDER_X.woman, scale: 1 }, { shoulderX: SHOULDER_X.bossMan, scale: 1 }, { shoulderX: SHOULDER_X.bossWoman, scale: 1.1 },
  { shoulderX: SHOULDER_X.man, scale: 1.1 }, { shoulderX: SHOULDER_X.man, scale: 0.88 }, { shoulderX: SHOULDER_X.woman, scale: 0.88 },
];
const TABLES = new Map<RigFit, OfficePoseTable>(FITS.map((f) => [f, officePoseTable(f)]));
const v3 = (): Vec3 => ({ x: 0, y: 0, z: 0 });
const at = (p: readonly [number, number, number]): Vec3 => ({ x: p[0], y: p[1], z: p[2] });
const gap = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const posed = (fit: RigFit, clip: OfficeClipName, t: number): Float32Array => {
  const pose = new Float32Array(OFFICE_POSE_LEN);
  sampleOfficeClip(OFFICE_CLIPS[clip], t, pose, { emotion: "neutral", gaze: 0 }, TABLES.get(fit)!);
  return pose;
};
const palmOf = (pose: Float32Array, fit: RigFit, side: -1 | 1, hips: readonly [number, number, number] | null = null): Vec3 =>
  officeArmPoint(pose, fit, side, PALM_ALONG, v3(), hips);
const span = (from: number, to: number, step: number): number[] => Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => from + i * step);

describe("P-VIZ.7: the solved hands", () => {
  test("every build's goals are reached: palms over the keys, the mug on its coaster, the handset, the stand", () => {
    for (const fit of FITS) {
      const P = TABLES.get(fit)!;
      for (const side of [-1, 1] as const) {
        expect(gap(palmOf(P.type, fit, side), keyboardPoint(side * 0.07, PALM_REST, v3()))).toBeLessThan(1e-3);
        expect(gap(palmOf(P.frantic, fit, side), keyboardPoint(side * 0.07, PALM_REST, v3()))).toBeLessThan(1e-3);
      }
      expect(gap(officeMugAt(P.reachMug, fit, 0, v3()), at(DESK_MUG))).toBeLessThan(1e-3);
      expect(gap(palmOf(P.reachPhone, fit, -1), at(HANDSET_AT))).toBeLessThan(1e-3);
      const stand = { x: HEADPHONE_STAND[0], y: HEADPHONE_STAND[1] + HEADPHONE_STAND_H, z: HEADPHONE_STAND[2] };
      expect(gap(palmOf(P.reachPhones, fit, -1), stand)).toBeLessThan(1e-3);
    }
    // the poses that stand at the copier were solved with its hips offset; everything else sits
    expect(officePoseHips("copyPress")).toBe(COPY_HIPS);
    expect(officePoseHips("type")).toBeNull();
    expect(COPY_HIPS[1] - OFFICE_RIG.hipY).toBeCloseTo(STAND_LIFT, 9);
    for (const name of Object.keys(OFFICE_ARM_GOALS) as OfficePoseName[]) for (const x of OFFICE_POSE_VECTORS[name]) expect(Number.isFinite(x)).toBe(true);
  });

  test("typing: both palms stay over the keyboard, wrists low and forearms near level, through every tap", () => {
    for (const fit of FITS) {
      const local = v3();
      const check = (pose: Float32Array, side: -1 | 1): void => {
        const palm = palmOf(pose, fit, side);
        keyboardLocal(palm, local);
        expect(Math.abs(local.x)).toBeLessThan(KEYBOARD.w / 2);
        expect(Math.abs(local.z)).toBeLessThan(KEYBOARD.d / 2 + 0.01);
        expect(local.y).toBeGreaterThan(0.02); // the hand's underside on the keys, not through them
        expect(local.y).toBeLessThan(0.07); // and never hovering up in front of the screen
        const elbow = officeArmPoint(pose, fit, side, 0, v3());
        expect(Math.abs(elbow.y - palm.y)).toBeLessThan(0.05); // the forearm near level (under ~13 degrees)
      };
      for (const clip of ["type", "frantic"] as const) {
        for (const t of span(0, OFFICE_CLIPS[clip].len, 0.1)) {
          for (const ph of span(0, 1, 0.05)) {
            const pose = posed(fit, clip, t);
            applyTyping(pose, ph + 7, 1);
            check(pose, -1);
            check(pose, 1);
          }
        }
      }
      // Enter: the left hand types all through; the right only off the wind-up and the smug beat
      for (const t of span(0, OFFICE_CLIPS.enter.len - 0.01, 0.05)) {
        const pose = posed(fit, "enter", t);
        check(pose, -1);
        if (t < 1.5 || t >= 2.75) check(pose, 1);
      }
    }
  });

  test("the typing taps alternate, dip the hand onto the keys and leave the pose alone at weight 0", () => {
    const rest = Float32Array.from(OFFICE_POSE_VECTORS.type);
    const same = Float32Array.from(rest);
    applyTyping(same, 0.19, 0);
    expect(Array.from(same)).toEqual(Array.from(rest));
    const left = Float32Array.from(rest);
    applyTyping(left, 0.19, 1); // the left hand's tap at its peak, the right hand resting
    const eL = officeJointOffset("elL"), eR = officeJointOffset("elR");
    expect(left[eL]!).toBeGreaterThan(rest[eL]!);
    expect(left[eR]!).toBeCloseTo(rest[eR]!, 6);
    expect(palmOf(left, REF_FIT, -1).y).toBeLessThan(palmOf(rest, REF_FIT, -1).y);
    expect(TAP_DRIFT).toBeLessThan(0.1);
  });

  test("the sip: the mug off the coaster, its rim at the lips with the head tipped back and the elbow up, back on the coaster", () => {
    const head = officeJointOffset("head");
    expect(OFFICE_POSE_VECTORS.sipUp[head]!).toBeLessThan(-0.1);
    for (const fit of FITS) {
      for (const t of [MUG_GRAB_S, MUG_DROP_S]) {
        expect(mugTilt("sip", t)).toBeCloseTo(0, 9);
        expect(gap(officeMugAt(posed(fit, "sip", t), fit, 0, v3()), at(DESK_MUG))).toBeLessThan(1e-3);
      }
      for (const t of span(1.3, 2.6, 0.1)) {
        const pose = posed(fit, "sip", t);
        const tilt = mugTilt("sip", t);
        expect(tilt).toBeCloseTo(SIP_TIP, 6);
        const mug = officeMugAt(pose, fit, tilt, v3());
        const rim = mugRimNear(officeFacing(pose), tilt, mug, v3());
        const mouth = officeHeadPoint(pose, fit, OFFICE_RIG.mouth, v3());
        expect(gap(rim, mouth)).toBeLessThan(LIP_GAP + 0.003);
        expect(rim.z).toBeGreaterThan(mouth.z); // at the lips, not inside the face
        expect(mug.z).toBeGreaterThan(mouth.z + 0.05); // the mug's body out in front, not under the chin
        // the hand clears the (big, toon) head
        const skull = officeHeadPoint(pose, fit, [0, OFFICE_RIG.skullY, 0], v3());
        expect(gap(palmOf(pose, fit, -1), skull)).toBeGreaterThan(0.17 * fit.scale + 0.035);
        // the elbow raised well above where it was reaching for the desk
        const elbow = officeArmPoint(pose, fit, -1, 0, v3());
        expect(elbow.y).toBeGreaterThan(officeArmPoint(posed(fit, "sip", MUG_GRAB_S), fit, -1, 0, v3()).y + 0.08);
      }
    }
  });

  test("the phone: the handset is in hand between the reach keys; the headphones go stand, hand, head, hand, stand", () => {
    const keys = OFFICE_CLIPS.phone.keys;
    expect(keys.some((k) => k.at === PHONE_GRAB_S && k.pose === "reachPhone")).toBe(true);
    expect(keys.some((k) => k.at === PHONE_DROP_S && k.pose === "reachPhone")).toBe(true);
    expect(handsetHeld("phone", PHONE_GRAB_S - 0.01)).toBe(false);
    expect(handsetHeld("phone", 3)).toBe(true);
    expect(handsetHeld("phone", PHONE_DROP_S)).toBe(false);
    expect(handsetHeld("type", 3)).toBe(false);
    const hk = OFFICE_CLIPS.headphones.keys;
    for (const [s, pose] of [[PHONES_GRAB_S, "reachPhones"], [PHONES_ON_S, "phonesOn"], [PHONES_OFF_S, "phonesOn"], [PHONES_BACK_S, "reachPhones"]] as const) {
      expect(hk.some((k) => k.at === s && k.pose === pose)).toBe(true);
    }
    expect(phonesAt("headphones", PHONES_GRAB_S - 0.01)).toBe("stand");
    expect(phonesAt("headphones", PHONES_GRAB_S + 0.01)).toBe("hand");
    expect(phonesAt("headphones", 3)).toBe("head");
    expect(phonesAt("headphones", PHONES_OFF_S + 0.01)).toBe("hand");
    expect(phonesAt("headphones", PHONES_BACK_S)).toBe("stand");
    expect(phonesAt("type", 3)).toBe("stand");
    // both palms at the ears putting them on, the handset's palm at the left ear
    for (const fit of FITS) {
      const P = TABLES.get(fit)!;
      for (const side of [-1, 1] as const) {
        const ear = officeHeadPoint(P.phonesOn, fit, [side * OFFICE_RIG.ear[0], OFFICE_RIG.ear[1], 0], v3());
        expect(gap(palmOf(P.phonesOn, fit, side), ear)).toBeLessThan(0.09 * fit.scale);
      }
      const earL = officeHeadPoint(P.phoneEar, fit, [-OFFICE_RIG.ear[0], OFFICE_RIG.ear[1], 0], v3());
      expect(gap(palmOf(P.phoneEar, fit, -1), earL)).toBeLessThan(0.09 * fit.scale);
    }
  });

  test("the boss flicks through a report: a page turns near each flick key and only then", () => {
    const flicks = OFFICE_CLIPS.flip.keys.filter((k) => k.pose === "reportsFlip");
    expect(flicks.length).toBe(FLICKS.length);
    for (const s of FLICKS) {
      expect(flicks.some((k) => Math.abs(k.at - s) < 0.05)).toBe(true);
      expect(flickAt(s + FLICK_S / 2)).toBeGreaterThan(0);
    }
    expect(flickAt(3)).toBe(-1);
  });
});

describe("P-VIZ.7: variants", () => {
  test("the variant is the brand's, else the seed's, always 0..3", () => {
    expect(officeVariant(2, 99)).toBe(2);
    expect(officeVariant(null, 7)).toBe(3);
    expect(officeVariant(undefined, -1)).toBe(3);
    expect(officeVariant(Number.NaN, 5)).toBe(1);
    expect(officeVariant(5.7, 0)).toBe(1);
    for (let s = -20; s < 20; s++) expect([0, 1, 2, 3]).toContain(officeVariant(null, s));
  });

  test("outfits: the cast's own top, a vest, rolled sleeves or a cardigan, a hoodie; gender and hair untouched", () => {
    const man = NODE_IDS.map(idSeed).map(workerCast).find((c) => c.gender === "male")!;
    const woman = NODE_IDS.map(idSeed).map(workerCast).find((c) => c.gender === "female")!;
    expect(workerOutfit(man, 0)).toBe(man.top);
    expect(workerOutfit(woman, 0)).toBe(woman.top);
    expect(workerOutfit(man, 1)).toBe("vest");
    expect(workerOutfit(man, 2)).toBe("rolled");
    expect(workerOutfit(woman, 2)).toBe("cardigan");
    expect(workerOutfit(woman, 3)).toBe("hoodie");
    expect(longSleeves("hoodie")).toBe(true);
    expect(longSleeves("rolled")).toBe(false);
    expect(longSleeves("vest")).toBe(false);
    const look = lookFor("#38bdf8");
    const seed = idSeed("agent-3");
    const plain = officeLook(look, seed, "worker");
    const hoodie = officeLook(look, seed, "worker", "man", "hoodie");
    const vest = officeLook(look, seed, "worker", "man", "vest");
    expect(hoodie.jacket).not.toBe(vest.jacket);
    expect(hoodie.skin).toBe(plain.skin);
    expect(hoodie.hair).toBe(plain.hair);
    expect(officeLook(look, seed, "worker", "man", workerCast(seed).top)).toEqual(plain);
  });

  test("desk sets differ per variant, the boss always has his phone, and a variant's action has its prop", () => {
    const sets = [0, 1, 2, 3].map((v) => officeDeskSet("worker", v).join());
    expect(new Set(sets).size).toBe(4);
    for (let v = 0; v < 4; v++) {
      expect(officeDeskSet("boss", v)).toContain("phone");
      expect(officeDeskSet("worker", v).length).toBeGreaterThanOrEqual(2);
      for (const role of ["worker", "boss"] as const) {
        for (const a of MINI_ACTIVITIES) {
          const clip = activityClip(role, a, v);
          if (clip === "phone") expect(officeDeskSet(role, v)).toContain("phone");
          if (clip === "headphones") expect(officeDeskSet(role, v)).toContain("headphones");
        }
      }
    }
  });

  test("the variants' own actions ride existing activity slots; no variant (-1) keeps the plain table", () => {
    expect(activityClip("worker", "scan", 3)).toBe("phone");
    expect(activityClip("worker", "kata", 1)).toBe("headphones");
    expect(activityClip("worker", "scan", 0)).toBe("squint");
    expect(activityClip("worker", "typing", 2)).toBe("type");
    expect(activityClip("boss", "scan", 0)).toBe("phone");
    expect(activityClip("boss", "scan", 1)).toBe("supervise");
    expect(activityClip("boss", "supervise", 3)).toBe("flip");
    expect(activityClip("worker", "scan", -1)).toBe("squint");
    expect(activityClip("boss", "supervise", -1)).toBe("supervise");
    expect(officeClipFor("boss", "idle", "supervise", 120, 1)).toBe("flip");
    expect(officeClipFor("worker", "paused", "scan", 0, 3)).toBe("blank");
  });
});

describe("P-VIZ.7: the commit at the copier", () => {
  test("the copy clip: a snap press on the button, a sip with the rim at the lips, standing at the copier", () => {
    const keys = OFFICE_CLIPS.copy.keys;
    expect(OFFICE_CLIPS.copy.loop).toBe(true);
    expect(OFFICE_CLIPS.copy.len).toBe(COPY_LEN);
    expect(keys.some((k) => k.at === COPY_PRESS_S && k.pose === "copyPress" && k.ease === "snap")).toBe(true);
    expect(buttonPress(COPY_PRESS_S)).toBeCloseTo(1, 6);
    expect(buttonPress(0)).toBe(0);
    expect(buttonPress(COPY_SIP[0])).toBe(0);
    expect(COMMIT_BLEND_S).toBeGreaterThan(0.3);
    expect(COMMIT_BLEND_S).toBeLessThan(1);
    for (const fit of FITS) {
      const press = posed(fit, "copy", COPY_PRESS_S);
      const palm = palmOf(press, fit, 1, COPY_HIPS);
      const button = at(COPIER_BUTTON);
      expect(gap(palm, button)).toBeLessThan(0.05);
      expect(palm.y).toBeGreaterThan(button.y);
      for (const t of span(COPY_SIP[0], COPY_SIP[1], 0.1)) {
        const pose = posed(fit, "copy", t);
        const tilt = mugTilt("copy", t);
        expect(tilt).toBeCloseTo(SIP_TIP, 6);
        const mug = officeMugAt(pose, fit, tilt, v3(), COPY_HIPS);
        const rim = mugRimNear(officeFacing(pose), tilt, mug, v3());
        const mouth = officeHeadPoint(pose, fit, OFFICE_RIG.mouth, v3(), COPY_HIPS);
        expect(gap(rim, mouth)).toBeLessThan(LIP_GAP + 0.003);
        expect(rim.x).toBeGreaterThan(mouth.x); // he faces the copier (+X): the rim in front of his lips
      }
    }
    // he holds the mug upright between the sips (and turns to face the copier)
    expect(mugTilt("copy", 0.5)).toBeCloseTo(0, 9);
    expect(officeFacing(OFFICE_POSE_VECTORS.copyIdle)).toBeCloseTo(Math.PI / 2, 6);
  });

  test("copies start one after another, each slides out over EJECT_S, the count keeps rising", () => {
    expect(copiesStarted(0)).toBe(0);
    expect(copiesStarted(Number.NaN)).toBe(0);
    expect(copiesStarted(COPY_EJECTS[0]!)).toBe(1);
    expect(copiesStarted(COPY_LEN + COPY_EJECTS[1]!)).toBe(2 * COPY_EJECTS.length);
    for (const s of COPY_EJECTS) {
      expect(s).toBeGreaterThan(COPY_PRESS_S); // the button first
      expect(s + EJECT_S).toBeLessThanOrEqual(COPY_LEN);
    }
    let prev = 0;
    for (let t = 0; t < 30; t += 0.05) {
      const n = copiesStarted(t);
      expect(n).toBeGreaterThanOrEqual(prev);
      prev = n;
    }
    for (let j = 0; j < 12; j++) {
      const s = copyStartAt(j);
      expect(copiesStarted(s)).toBe(j + 1);
      expect(copiesStarted(s - 1e-6)).toBe(j);
      expect(copyProgress(j, s)).toBe(0);
      expect(copyProgress(j, s + EJECT_S / 2)).toBeCloseTo(0.5, 6);
      expect(copyProgress(j, s + EJECT_S)).toBeCloseTo(1, 9);
    }
  });

  test("he glances around (a full look over the shoulder among them), but not while he sips", () => {
    let min = 0, max = 0;
    for (let t = 0; t < 7.2; t += 0.02) {
      const y = commitLook(t, 0.5);
      min = Math.min(min, y);
      max = Math.max(max, y);
    }
    expect(min).toBeLessThan(-1.2);
    expect(max).toBeGreaterThan(0.5);
    const mid = (COPY_SIP[0] + COPY_SIP[1]) / 2;
    for (let t = 0; t < 7.2; t += 0.1) expect(Math.abs(commitLook(t, mid))).toBeLessThan(1e-9);
    expect(commitLook(Number.NaN, 0)).toBe(0);
  });
});
