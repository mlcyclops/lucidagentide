// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// LUCID the ninja (mascot.ts, P-MASCOT.1 / ADR-0251 pivot): frame-grid integrity, the animation state
// machine (victory on landed work, priorities, victory always finishes), the working-activity rotation,
// and the beat-timeline frame picker.

import { describe, expect, it } from "bun:test";
import {
  MASCOT_FRAMES, MASCOT_H, MASCOT_PALETTE, MASCOT_W, VICTORY_MS, WORK_ACTIVITIES,
  mascotFrame, stepMascot, workActivity, type MascotInputs, type MascotSnap,
} from "./mascot.ts";

const calm: MascotInputs = { speaking: false, listening: false, working: false };

describe("frame grids - every frame is on-model", () => {
  it("all frames are exactly 20x26 with only palette characters", () => {
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

describe("working activities + frame picks", () => {
  it("rotates kata -> shuriken -> meditate and wraps", () => {
    expect(workActivity(0)).toBe("kata");
    expect(workActivity(7000)).toBe("shuriken");
    expect(workActivity(14000)).toBe("meditate");
    expect(workActivity(21000)).toBe("kata");
    expect(WORK_ACTIVITIES.length).toBe(3);
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
  it("the kata loop actually cycles through punch and kick frames", () => {
    const seen = new Set<string>();
    const s: MascotSnap = { state: "working", since: 0, until: 0 };
    for (let t = 0; t < 2200; t += 40) seen.add(mascotFrame(s, t));
    expect(seen.has("punchB")).toBe(true);
    expect(seen.has("kickB")).toBe(true);
  });
});
