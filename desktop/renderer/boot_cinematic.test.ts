// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// The boot cinematic's pure half (boot_cinematic.ts, P-AVATAR.6 / ADR-0251): real-signal lines, the
// min-beat + hard-cap done gate (voice/models never hold boot hostage), and the sprint choreography.

import { describe, expect, it } from "bun:test";
import { BOOT_CAP_MS, BOOT_MIN_MS, FINALE_MS, bootDone, bootFinale, bootLines, bootRunnerX } from "./boot_cinematic.ts";
import { BLADE_DIAG, BLADE_FLAT, KEYBOARD_LEFT, KEYBOARD_RIGHT, KEYBOARD_WHOLE, MASCOT_FRAMES, keyboardLitKeys } from "./mascot.ts";

const none = { settings: false, config: false, models: 0, voice: false };
const all = { settings: true, config: true, models: 12, voice: true };

describe("bootLines - real signals, stable rows", () => {
  it("four rows, each flipping done with its signal", () => {
    expect(bootLines(none).every((l) => !l.done)).toBe(true);
    const lines = bootLines(all);
    expect(lines).toHaveLength(4);
    expect(lines.every((l) => l.done)).toBe(true);
    expect(lines[2]!.label).toContain("12 routes");
  });
  it("ids are stable regardless of state (the list never reflows)", () => {
    expect(bootLines(none).map((l) => l.id)).toEqual(bootLines(all).map((l) => l.id));
  });
});

describe("bootDone - min beat, hard cap, config-gated", () => {
  it("never done before the minimum beat, even fully ready", () => {
    expect(bootDone(all, BOOT_MIN_MS - 50)).toBe(false);
  });
  it("done once config arrived after the beat - voice and models NEVER gate", () => {
    expect(bootDone({ ...all, voice: false, models: 0 }, BOOT_MIN_MS + 1)).toBe(true);
    expect(bootDone({ ...none, settings: true }, BOOT_MIN_MS + 1)).toBe(false); // no config yet
  });
  it("the hard cap ends it no matter what", () => {
    expect(bootDone(none, BOOT_CAP_MS)).toBe(true);
  });
});

describe("bootFinale - stop, draw, slice the keyboard, follow through", () => {
  it("plays the beats in order and every frame is real", () => {
    const seen: string[] = [];
    for (let t = 0; t < FINALE_MS; t += 40) {
      const f = bootFinale(t);
      if (seen[seen.length - 1] !== f.frame) seen.push(f.frame);
      expect(f.frame in MASCOT_FRAMES).toBe(true);
    }
    expect(seen).toEqual(["idleA", "draw", "slashUp", "slash", "slashEnd"]);
  });
  it("the keyboard stays whole until the cut lands mid-swing, then splits monotonically", () => {
    expect(bootFinale(1000).split).toBe(false);
    expect(bootFinale(1100).split).toBe(true);
    let prevSep = -1, prevDrop = -1;
    for (let t = 1100; t < FINALE_MS; t += 60) {
      const f = bootFinale(t);
      expect(f.kbSep).toBeGreaterThanOrEqual(prevSep);
      expect(f.kbDrop).toBeGreaterThanOrEqual(prevDrop);
      prevSep = f.kbSep; prevDrop = f.kbDrop;
    }
    expect(bootFinale(FINALE_MS).done).toBe(true);
    expect(bootFinale(FINALE_MS - 100).done).toBe(false);
  });
  it("every slash frame keeps a grip; the BLADE PROPS carry the real steel with a bright edge", () => {
    for (const id of ["slashUp", "slash", "slashEnd"]) expect(MASCOT_FRAMES[id]!.join("")).toContain("M"); // the grip in hand
    expect(BLADE_FLAT[0]!).toMatch(/^W+$/); // the edge shine runs the full cut
    expect(BLADE_FLAT[1]!).toContain("M");
    expect(BLADE_FLAT[0]!.length).toBeGreaterThanOrEqual(16); // a REAL blade, not a toothpick
    expect(BLADE_DIAG.length).toBe(12);
    for (const row of BLADE_DIAG) expect(row.length).toBe(13); // uniform grid for paintRows
    expect(BLADE_DIAG[0]!.indexOf("W")).toBeGreaterThan(BLADE_DIAG[11]!.indexOf("W")); // it slopes
  });
  it("the keyboard reads as one: dark deck, distinct keycaps, a spacebar, jagged halves", () => {
    for (const g of [KEYBOARD_WHOLE, KEYBOARD_LEFT, KEYBOARD_RIGHT]) {
      const w = g[0]!.length;
      for (const row of g) expect(row.length).toBe(w);
    }
    expect(KEYBOARD_WHOLE[0]!.length).toBe(24);
    const keyRows = KEYBOARD_WHOLE.filter((r) => /(Mk){4,}/.test(r)); // caps separated by dark gaps
    expect(keyRows.length).toBeGreaterThanOrEqual(2);
    expect(KEYBOARD_WHOLE[6]!).toContain("MMMMMMMMMMMMMM"); // the spacebar
    expect(KEYBOARD_WHOLE.join("")).not.toMatch(/M{15,}M{15,}/); // never a solid slab again
    expect(KEYBOARD_LEFT[0]!.length + KEYBOARD_RIGHT[0]!.length).toBe(24); // halves sum to the whole
  });
  it("lit keys hop like typing while alive - and die with the cut, forever", () => {
    const a = keyboardLitKeys(0, false);
    expect(a).toHaveLength(3);
    for (const k of a) {
      expect([2, 4]).toContain(k.row); // only the key rows
      expect(k.col % 2).toBe(0);
      expect(k.col).toBeGreaterThanOrEqual(2);
      expect(k.col).toBeLessThanOrEqual(20); // only real caps, never the bezel
    }
    const b = keyboardLitKeys(600, false);
    expect(JSON.stringify(b)).not.toBe(JSON.stringify(a)); // the pattern moves
    expect(keyboardLitKeys(0, true)).toEqual([]); // sliced = dark
    expect(keyboardLitKeys(99999, true)).toEqual([]); // and it STAYS dark
  });
});

describe("bootRunnerX - sprint passes with rests", () => {
  it("crosses the full stage during a pass and rests offscreen after", () => {
    const w = 1000, s = 120;
    const start = bootRunnerX(0, w, s);
    expect(start.x).toBeLessThanOrEqual(-s + 1);
    const mid = bootRunnerX(1300, w, s);
    expect(mid.x).toBeGreaterThan(0);
    expect(mid.x).toBeLessThan(w);
    const rest = bootRunnerX(2700, w, s); // inside the rest window
    expect(rest.x).toBeLessThan(-s);
  });
  it("progresses monotonically within a pass and cycles the four-beat gait", () => {
    const w = 800, s = 100;
    let prev = -Infinity;
    const frames = new Set<string>();
    for (let t = 0; t < 2600; t += 80) {
      const r = bootRunnerX(t, w, s);
      expect(r.x).toBeGreaterThanOrEqual(prev);
      prev = r.x;
      frames.add(r.frame);
    }
    expect(frames.size).toBe(4);
  });
});
