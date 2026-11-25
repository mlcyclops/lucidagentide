// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/viz_tray_reactions.test.ts - P-VIZ.TRAY2 (ADR-0690): the tray reactions' pure rules. Four
// built-ins in tray order; a world's own reactions take their base's slot (the scene's allowlist); each reaction has
// its own cooldown; the fold-out pref is closed unless saved open; the broadcast is staggered along the sweep (dance
// in sync, everything at once under reduced motion); reduced motion gets the color cue and no figure layer or
// particles. Both figure families play every reaction as a short one-shot that hands back cleanly, with no charge.

import { describe, expect, test } from "bun:test";
import { chargeLevel, HIT_CLIPS, HIT_OUT_S, newCharge, newHitSample, animeHitCharge, planHit, POSE_LEN, sampleHit, DANCE_BEAT_S } from "./viz_anime_pose.ts";
import {
  COFFEE_DROP_S, COFFEE_GRAB_S, newOfficeHitSample, OFFICE_HIT_CLIPS, OFFICE_POSE_LEN, officeHitCharge, planOfficeHit, sampleOfficeHit,
} from "./viz_office_pose.ts";
import { createRateLimit, rateLeft, rateTake } from "./viz_throw_math.ts";
import {
  isTrayReactionKind, parseReactionsOpen, reactionFx, reactionSchedule, TRAY_REACTION_COOLDOWN_MS, TRAY_REACTION_CUE, TRAY_REACTION_KINDS,
  TRAY_REACTION_MS, TRAY_REACTIONS, trayReactionOf, trayReactionsFor,
} from "./viz_tray_reactions.ts";
import type { WorldTrayReaction } from "./viz_world_api.ts";

const pts = (n: number): { id: string; x: number; z: number }[] => Array.from({ length: n }, (_, i) => ({ id: `n${i}`, x: n - i, z: 0 }));
const RIGHT = { x: 1, z: 0 };

describe("the reactions and the world merge", () => {
  test("four built-ins in tray order, each its own base, no world icon", () => {
    expect(TRAY_REACTIONS.map((r) => r.kind)).toEqual(["celebrate", "wave", "coffee", "dance"]);
    expect(TRAY_REACTION_KINDS).toEqual(TRAY_REACTIONS.map((r) => r.base));
    for (const r of TRAY_REACTIONS) {
      expect(r.icon).toBeNull();
      expect(r.label.length).toBeGreaterThan(0);
      expect(r.tip.length).toBeGreaterThan(0);
      expect(/^#[0-9a-f]{6}$/.test(TRAY_REACTION_CUE[r.base])).toBe(true);
    }
    for (const k of TRAY_REACTION_KINDS) expect(isTrayReactionKind(k)).toBe(true);
    for (const k of ["storm", "paper", "stars", "", "Celebrate"]) expect(isTrayReactionKind(k)).toBe(false);
  });

  test("the built-in styles and a world without reactions get the built-ins (the same list)", () => {
    expect(trayReactionsFor(null)).toBe(TRAY_REACTIONS);
    expect(trayReactionsFor({})).toBe(TRAY_REACTIONS);
    expect(trayReactionsFor({ reactions: [] })).toBe(TRAY_REACTIONS);
  });

  test("a world's reaction takes its base's slot; the slots it leaves stay built-in; the first per base wins", () => {
    const carol: WorldTrayReaction = { kind: "carol", base: "celebrate", label: "Carols", tip: "Everyone sings.", icon: "M4 4h16" };
    const toast: WorldTrayReaction = { kind: "toast", base: "celebrate", label: "Toast", tip: "Cheers.", icon: "M6 6h12" };
    const cocoa: WorldTrayReaction = { kind: "cocoa", base: "coffee", label: "Cocoa", tip: "A mug of cocoa.", icon: "M5 10h11" };
    const list = trayReactionsFor({ reactions: [cocoa, carol, toast] });
    expect(list.map((r) => r.kind)).toEqual(["carol", "wave", "cocoa", "dance"]);
    expect(list.map((r) => r.base)).toEqual(["celebrate", "wave", "coffee", "dance"]);
    expect(list[0]).toEqual({ kind: "carol", base: "celebrate", label: "Carols", tip: "Everyone sings.", icon: "M4 4h16" });
    expect(list[1]).toBe(TRAY_REACTIONS[1]!);
  });

  test("the allowlist: only what the tray offers for the style", () => {
    const list = trayReactionsFor({ reactions: [{ kind: "carol", base: "celebrate", label: "Carols", tip: "t", icon: "M4 4h16" }] });
    expect(trayReactionOf(list, "carol")?.base).toBe("celebrate");
    expect(trayReactionOf(list, "celebrate")).toBeNull(); // the world replaced it
    expect(trayReactionOf(list, "dance")?.base).toBe("dance");
    expect(trayReactionOf(TRAY_REACTIONS, "celebrate")?.base).toBe("celebrate");
    for (const k of ["carol", "storm", "paper", "stare", ""]) expect(trayReactionOf(TRAY_REACTIONS, k)).toBeNull();
  });
});

describe("cooldown and pref", () => {
  test("each reaction has its own cooldown: one taken leaves the others ready", () => {
    const limits = new Map(TRAY_REACTION_KINDS.map((k) => [k, createRateLimit(TRAY_REACTION_COOLDOWN_MS)]));
    expect(rateTake(limits.get("celebrate")!, 1000)).toBe(true);
    expect(rateTake(limits.get("celebrate")!, 1000 + TRAY_REACTION_COOLDOWN_MS - 1)).toBe(false);
    expect(rateLeft(limits.get("celebrate")!, 2000)).toBe(TRAY_REACTION_COOLDOWN_MS - 1000);
    for (const k of ["wave", "coffee", "dance"] as const) {
      expect(rateLeft(limits.get(k)!, 2000)).toBe(0);
      expect(rateTake(limits.get(k)!, 2000)).toBe(true);
    }
    expect(rateTake(limits.get("celebrate")!, 1000 + TRAY_REACTION_COOLDOWN_MS)).toBe(true);
    // long enough that a reaction never restarts on itself in the middle of most figures' clips
    expect(TRAY_REACTION_COOLDOWN_MS).toBeGreaterThanOrEqual(Math.max(...Object.values(TRAY_REACTION_MS)));
  });

  test("the fold-out pref: open only when saved open", () => {
    expect(parseReactionsOpen(true)).toBe(true);
    for (const v of [false, undefined, null, 1, "true", {}, []]) expect(parseReactionsOpen(v)).toBe(false);
  });
});

describe("the broadcast", () => {
  test("every figure once, in the sweep's order, staggered per reaction and within its spread", () => {
    for (const k of ["celebrate", "wave", "coffee"] as const) {
      const s = reactionSchedule(k, pts(8), RIGHT, true);
      expect(s.map((c) => c.id)).toEqual(["n7", "n6", "n5", "n4", "n3", "n2", "n1", "n0"]); // x ascending
      expect(s[0]!.at).toBe(0);
      for (let i = 1; i < s.length; i++) expect(s[i]!.at).toBeGreaterThan(s[i - 1]!.at);
      expect(s[s.length - 1]!.at).toBeLessThanOrEqual(1300);
    }
    // a big team still finishes its wave inside the spread
    const big = reactionSchedule("wave", pts(60), RIGHT, true);
    expect(new Set(big.map((c) => c.id)).size).toBe(60);
    expect(big[59]!.at).toBeLessThanOrEqual(1100);
  });

  test("the dance is in sync, and reduced motion starts everyone at once", () => {
    expect(reactionSchedule("dance", pts(8), RIGHT, true).every((c) => c.at === 0)).toBe(true);
    for (const k of TRAY_REACTION_KINDS) expect(reactionSchedule(k, pts(8), RIGHT, false).every((c) => c.at === 0)).toBe(true);
    expect(reactionSchedule("wave", [], RIGHT, true)).toEqual([]);
    expect(reactionSchedule("wave", pts(1), RIGHT, true)).toEqual([{ id: "n0", at: 0 }]);
  });

  test("reduced motion: the color cue only; with motion the figure layer and a tier-sized effect", () => {
    for (const tier of ["minimal", "reduced", "full", "ultra", "cinematic"] as const) {
      expect(reactionFx(tier, false)).toEqual({ figure: false, particles: 0, ring: false, cue: true });
      const m = reactionFx(tier, true);
      expect(m.figure).toBe(true);
      expect(m.cue).toBe(false);
      expect(m.particles).toBeGreaterThan(0);
      expect(m.ring).toBe(tier !== "minimal");
    }
    expect(reactionFx("minimal", true).particles).toBeLessThan(reactionFx("full", true).particles);
    expect(reactionFx("full", true).particles).toBeLessThanOrEqual(reactionFx("ultra", true).particles);
  });
});

describe("the figures' reactions", () => {
  test("anime: each reaction plays its own one-shot clip, within TRAY_REACTION_MS, turned to the viewer except the coffee break, no charge", () => {
    for (const k of TRAY_REACTION_KINDS) {
      const p = planHit(k, 1, null, 0, 0);
      expect(p.play).toBe(k);
      expect(p.turns).toBe(k !== "coffee");
      expect(HIT_CLIPS[k].loop).toBe(false);
      expect(HIT_CLIPS[k].len * 1000).toBeLessThanOrEqual(TRAY_REACTION_MS[k] + 1e-6);
      expect(chargeLevel(animeHitCharge(newCharge(), k, 1))).toBe(0);
    }
  });

  test("office: each reaction plays its own one-shot clip, within TRAY_REACTION_MS, no charge; the coffee break holds the mug", () => {
    for (const k of TRAY_REACTION_KINDS) {
      const p = planOfficeHit(k, 1, 0);
      expect(p.play).toBe(k);
      expect(p.turns).toBe(k !== "coffee");
      expect(OFFICE_HIT_CLIPS[k].loop).toBe(false);
      expect(OFFICE_HIT_CLIPS[k].len * 1000).toBeLessThanOrEqual(TRAY_REACTION_MS[k] + 1e-6);
      expect(chargeLevel(officeHitCharge(newCharge(), k, 1))).toBe(0);
    }
    const c = planOfficeHit("coffee", 1, 0);
    const at = (t: number) => sampleOfficeHit(c, t, newOfficeHitSample());
    expect(at(COFFEE_GRAB_S - 0.01).mug).toBe(false);
    expect(at(COFFEE_GRAB_S).mug).toBe(true);
    expect(at(1.5).tilt).toBe(1);
    expect(at(1.5).can).toBe(false); // the mug, never the energy drink's can
    expect(at(COFFEE_DROP_S).mug).toBe(false);
    expect(at(COFFEE_DROP_S).tilt).toBe(0);
    expect(sampleOfficeHit(planOfficeHit("wave", 1, 0), 1, newOfficeHitSample()).mug).toBe(false);
  });

  test("both families: a reaction blends in, never shakes, and hands back cleanly to the activity", () => {
    const pose = new Float32Array(POSE_LEN), opose = new Float32Array(OFFICE_POSE_LEN);
    for (const k of TRAY_REACTION_KINDS) {
      const p = planHit(k, 1, null, 0, 0), q = planOfficeHit(k, 1, 0);
      let prevA = sampleHit(p, 0, newHitSample(), pose).body, prevO = sampleOfficeHit(q, 0, newOfficeHitSample(), opose).body;
      expect(prevA).toBe(1);
      expect(prevO).toBe(1);
      for (let t = 1 / 120; t < Math.max(p.len, q.len) + 0.1; t += 1 / 120) {
        const a = sampleHit(p, t, newHitSample(), pose), o = sampleOfficeHit(q, t, newOfficeHitSample(), opose);
        expect(a.shake).toBe(0);
        expect(o.shake).toBe(0);
        expect(Math.abs(a.body - prevA)).toBeLessThan(0.05);
        expect(Math.abs(o.body - prevO)).toBeLessThan(0.05);
        for (const v of pose) expect(Number.isFinite(v)).toBe(true);
        for (const v of opose) expect(Number.isFinite(v)).toBe(true);
        prevA = a.body; prevO = o.body;
      }
      expect(sampleHit(p, p.len - HIT_OUT_S * 0.4, newHitSample()).emotion).toBeNull();
      expect(sampleHit(p, p.len, newHitSample()).done).toBe(true);
      expect(sampleOfficeHit(q, q.len, newOfficeHitSample()).done).toBe(true);
    }
  });

  test("the dance keeps one beat in both families, so a mixed team dances in sync", () => {
    const beats = (keys: readonly { at: number; pose: string }[]): number[] => keys.filter((k) => k.pose === "danceL" || k.pose === "danceR").map((k) => k.at);
    const a = beats(HIT_CLIPS.dance.keys), o = beats(OFFICE_HIT_CLIPS.dance.keys);
    expect(a.length).toBe(6);
    expect(o).toEqual(a);
    for (let i = 1; i < a.length; i++) expect(a[i]! - a[i - 1]!).toBeCloseTo(DANCE_BEAT_S, 9);
  });
});
