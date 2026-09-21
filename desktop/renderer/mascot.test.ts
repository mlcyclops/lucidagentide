// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// LUCID the ninja (mascot.ts, P-MASCOT.1 / ADR-0251 pivot): frame-grid integrity, the animation state
// machine (victory on landed work, priorities, victory always finishes), the working-activity rotation,
// and the beat-timeline frame picker.

import { describe, expect, it } from "bun:test";
import {
  MASCOT_FRAMES, MASCOT_H, MASCOT_PALETTE, MASCOT_THEMES, MASCOT_W, MASCOT_RUN_FRAMES, VICTORY_MS, WORK_ACTIVITIES,
  mascotActivityFrame, mascotFrame, mascotTheme, stepMascot, workActivity, type MascotInputs, type MascotSnap,
} from "./mascot.ts";

const calm: MascotInputs = { speaking: false, listening: false, working: false };

describe("frame grids - every frame is on-model", () => {
  it("all frames share the declared grid and contain only palette characters", () => {
    for (const [id, f] of Object.entries(MASCOT_FRAMES)) {
      expect(f.length).toBe(MASCOT_H);
      for (const row of f) {
        expect({ id, len: row.length }).toEqual({ id, len: MASCOT_W });
        for (const c of row) if (c !== ".") expect({ id, c, known: c in MASCOT_PALETTE }).toEqual({ id, c, known: true });
      }
    }
  });
  it("the character carries the brand accent and reads as a drawn figure", () => {
    for (const [id, f] of Object.entries(MASCOT_FRAMES)) {
      const flat = f.join("");
      expect({ id, accent: flat.includes("G") }).toEqual({ id, accent: true }); // neon somewhere in every pose
      const drawn = [...flat].filter((c) => c !== ".").length;
      expect(drawn).toBeGreaterThan(120); // never a near-empty grid
    }
  });
  it("shuriken frames actually carry steel", () => {
    expect(MASCOT_FRAMES.throwA!.join("")).toContain("M");
    expect(MASCOT_FRAMES.throwB!.join("")).toContain("M");
  });
});

describe("articulated action geometry", () => {
  const strikes = ["punchA", "punchB", "punchC", "punchD", "kickA", "kickB", "kickC", "kickD"];
  it("every moving limb remains connected to the character", () => {
    const activities = Object.keys(MASCOT_FRAMES).filter(id => /^(coding|scanning|staff)/.test(id));
    for (const id of [...MASCOT_RUN_FRAMES, ...strikes, ...activities]) {
      const frame = MASCOT_FRAMES[id]!;
      const visited = new Set<number>();
      const first = frame.join("").search(/[^.]/);
      const pending = [first];
      while (pending.length) {
        const at = pending.pop()!;
        if (visited.has(at)) continue;
        visited.add(at);
        const x = at % MASCOT_W, y = Math.floor(at / MASCOT_W);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx >= 0 && xx < MASCOT_W && yy >= 0 && yy < MASCOT_H && frame[yy]![xx] !== "." && !visited.has(yy * MASCOT_W + xx)) pending.push(yy * MASCOT_W + xx);
        }
      }
      for (let y = 26; y < MASCOT_H; y++) for (let x = 0; x < MASCOT_W; x++) {
        if (frame[y]![x] !== ".") expect({ id, x, y, attached: visited.has(y * MASCOT_W + x) }).toEqual({ id, x, y, attached: true });
      }
    }
  });
  it("keeps the support boot planted throughout the kick", () => {
    const support = (id: string) => MASCOT_FRAMES[id]!.slice(47).map(row => row.slice(6, 16));
    for (const id of ["kickB", "kickC", "kickD"]) expect(support(id)).toEqual(support("kickA"));
  });
  it("uses distinct gait drawings and genuine finer detail rather than doubled pixels", () => {
    expect(new Set(MASCOT_RUN_FRAMES.map(id => MASCOT_FRAMES[id]!.join(""))).size).toBe(MASCOT_RUN_FRAMES.length);
    for (const id of [...MASCOT_RUN_FRAMES, ...strikes]) {
      const f = MASCOT_FRAMES[id]!;
      let fineDetail = false;
      for (let y = 0; y < MASCOT_H; y += 2) for (let x = 0; x < MASCOT_W; x += 2) {
        if (new Set([f[y]![x], f[y]![x + 1], f[y + 1]![x], f[y + 1]![x + 1]]).size > 1) fineDetail = true;
      }
      expect(fineDetail).toBe(true);
    }
  });
  it("punches with compact fists instead of stretching the skin into a forearm", () => {
    for (const id of ["punchA", "punchB", "punchC", "punchD"]) {
      const skin = [...MASCOT_FRAMES[id]!.slice(25, 35).join("")].filter(c => c === "S");
      expect(skin.length).toBeGreaterThan(0);
      expect(skin.length).toBeLessThanOrEqual(18); // two compact 3x3 fists; sleeves carry the reach
    }
  });
});

describe("stepMascot - the state machine", () => {
  it("landed work triggers the victory pose, which always finishes", () => {
    let s = stepMascot(null, { ...calm, working: true }, 1000);
    expect(s.state).toBe("working");
    s = stepMascot(s, calm, 8000); // work done
    expect(s.state).toBe("victory");
    expect(s.until).toBe(8000 + VICTORY_MS);
    // Even new inputs cannot interrupt an active victory...
    expect(stepMascot(s, { ...calm, listening: true }, 8600).state).toBe("victory");
    // ...but it ends on schedule.
    expect(stepMascot(s, calm, 8000 + VICTORY_MS + 1).state).toBe("idle");
  });
  it("no victory when the reply is still being spoken (speaking wins the transition)", () => {
    let s = stepMascot(null, { ...calm, working: true }, 0);
    s = stepMascot(s, { ...calm, speaking: true }, 5000);
    expect(s.state).toBe("speaking");
  });
  it("priorities: speaking > listening > working > idle", () => {
    const all: MascotInputs = { speaking: true, listening: true, working: true };
    expect(stepMascot(null, all, 0).state).toBe("speaking");
    expect(stepMascot(null, { ...all, speaking: false }, 0).state).toBe("listening");
    expect(stepMascot(null, { ...all, speaking: false, listening: false }, 0).state).toBe("working");
    expect(stepMascot(null, calm, 0).state).toBe("idle");
  });
  it("same state is a stable no-op (since is preserved for the loop clock)", () => {
    const a = stepMascot(null, calm, 100);
    const b = stepMascot(a, calm, 5000);
    expect(b).toBe(a);
  });
});

describe("themed sprites and expressive eyes", () => {
  it("every theme resolves every drawable pixel without mutating the base palette", () => {
    const themes = Object.values(MASCOT_THEMES);
    expect(new Set(themes.map(theme => theme.palette.G)).size).toBe(themes.length);
    for (const theme of themes) {
      expect(theme.palette).not.toBe(MASCOT_PALETTE);
      for (const char of Object.keys(MASCOT_PALETTE)) expect(theme.palette[char]).toMatch(/^#[0-9a-f]{6}$/i);
      expect(theme.palette.K).not.toBe(theme.palette.D);
      expect(theme.palette.G).not.toBe(theme.palette.g);
      expect(theme.palette.W).not.toBe(theme.palette.B);
    }
    expect(MASCOT_THEMES.lucid.palette).toEqual(MASCOT_PALETTE);
  });
  it("keeps closed eyes closed and gives active faces distinct readable expressions", () => {
    const face = (id: string) => MASCOT_FRAMES[id]!.slice(14, 21).join("");
    for (const id of ["blink", "meditate"]) {
      expect(face(id)).not.toContain("W");
      expect(face(id)).not.toContain("B");
    }
    for (const id of ["idleA", "guard"]) {
      expect(face(id)).toContain("W");
      expect(face(id)).toContain("B");
    }
    expect(face("idleA")).not.toBe(face("guard"));
    expect(face("victoryB")).not.toBe(face("guard"));
  });
  it("synchronizes work costumes to activity slots and restores brand outside work", () => {
    const snap: MascotSnap = { state: "working", since: 923, until: 0 };
    const themes = new Set();
    for (let index = 0; index < WORK_ACTIVITIES.length; index++) {
      const theme = mascotTheme(snap, snap.since + index * 6500);
      themes.add(theme);
      expect(mascotTheme(snap, snap.since + (index + 1) * 6500 - 1)).toBe(theme);
    }
    expect(themes.size).toBe(Object.keys(MASCOT_THEMES).length);
    expect(mascotTheme(snap, snap.since - 1)).toBe(mascotTheme(snap, snap.since));
    expect(mascotTheme(snap, snap.since + WORK_ACTIVITIES.length * 6500)).toBe(mascotTheme(snap, snap.since));
    for (const state of ["idle", "speaking", "listening", "victory"] as const) {
      expect(mascotTheme({ ...snap, state }, 987654)).toBe(MASCOT_THEMES.lucid);
    }
  });
  it("new work activities animate distinct poses through the production scheduler", () => {
    for (const activity of ["coding", "scanning", "staff"]) {
      const index = WORK_ACTIVITIES.indexOf(activity);
      expect(index).toBeGreaterThanOrEqual(0);
      const poses = new Set<string>();
      const snap: MascotSnap = { state: "working", since: 100, until: 0 };
      for (let t = index * 6500; t < (index + 1) * 6500; t += 10) {
        const frame = mascotActivityFrame(activity, t);
        expect(frame.startsWith(activity)).toBe(true);
        expect(mascotFrame(snap, snap.since + t)).toBe(frame);
        poses.add(MASCOT_FRAMES[frame]!.join(""));
      }
      expect(poses.size).toBeGreaterThanOrEqual(4);
      expect(mascotActivityFrame(activity, -100)).toBe(mascotActivityFrame(activity, 0));
    }
  });
  it("unknown and prototype-shaped activity names resolve safely to idle", () => {
    for (const activity of ["missing", "toString", "__proto__", "constructor"]) {
      expect(mascotActivityFrame(activity, 71)).toBe(mascotFrame({ state: "idle", since: 0, until: 0 }, 71));
    }
  });
});

describe("working activities + frame picks", () => {
  it("visits every activity, holds slot boundaries, and wraps", () => {
    expect(workActivity(-1)).toBe(WORK_ACTIVITIES[0]!);
    for (let index = 0; index < WORK_ACTIVITIES.length; index++) {
      expect(workActivity(index * 6500)).toBe(WORK_ACTIVITIES[index]!);
      expect(workActivity((index + 1) * 6500 - 1)).toBe(WORK_ACTIVITIES[index]!);
    }
    expect(workActivity(WORK_ACTIVITIES.length * 6500)).toBe(WORK_ACTIVITIES[0]!);
  });
  it("every state resolves to a REAL frame at any time offset", () => {
    const states: MascotSnap[] = [
      { state: "idle", since: 0, until: 0 },
      { state: "listening", since: 0, until: 0 },
      { state: "speaking", since: 0, until: 0 },
      { state: "working", since: 0, until: 0 },
      { state: "victory", since: 0, until: 99999 },
    ];
    for (const s of states) {
      for (const t of [0, 137, 999, 4242, 60001, 3600000]) {
        const f = mascotFrame(s, t);
        expect({ state: s.state, t, known: f in MASCOT_FRAMES }).toEqual({ state: s.state, t, known: true });
      }
    }
  });
  it("strikes wind up, extend, recoil and recover in order", () => {
    const s: MascotSnap = { state: "working", since: 0, until: 0 };
    const transitions: string[] = [];
    for (let t = 0; t < 2400; t += 10) {
      const frame = mascotFrame(s, t);
      if (transitions[transitions.length - 1] !== frame) transitions.push(frame);
    }
    expect(transitions.filter(f => f.startsWith("punch"))).toEqual(["punchA", "punchB", "punchC", "punchD"]);
    expect(transitions.filter(f => f.startsWith("kick"))).toEqual(["kickA", "kickB", "kickC", "kickD"]);
  });
  it("the kata loop actually cycles through punch and kick frames", () => {
    const seen = new Set<string>();
    const s: MascotSnap = { state: "working", since: 0, until: 0 };
    for (let t = 0; t < 2200; t += 40) seen.add(mascotFrame(s, t));
    expect(seen.has("punchB")).toBe(true);
    expect(seen.has("kickB")).toBe(true);
  });
});
