// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-VOICE.4 (ADR-0248): the speech equalizer's maths. These pin the two properties that decide whether the
// display reads as a hi-fi analyser or as noise - log band spacing (so speech isn't crammed into three bars)
// and asymmetric ballistics with peak hold (snap up, glide down, cap hangs then falls).

import { expect, test } from "bun:test";
import {
  EQ_BALLISTICS, EQ_MAX_HZ, EQ_MIN_HZ, bandEdges, eqAtRest, foldBands, newEqFrame, stepEq,
} from "./eq_bands.ts";

const NYQ = 24000; // 48kHz context
const edges14 = () => bandEdges(1024, 14, EQ_MIN_HZ, EQ_MAX_HZ, NYQ);

test("band edges are strictly increasing, in range, and log-spaced", () => {
  const e = edges14();
  expect(e.length).toBe(15);
  for (let i = 1; i < e.length; i++) expect(e[i]!).toBeGreaterThan(e[i - 1]!); // no empty (always-dark) band
  expect(e[0]!).toBeGreaterThanOrEqual(0);
  expect(e[e.length - 1]!).toBeLessThanOrEqual(1024);
  // Log spacing: each band spans more bins than the one below it (the whole point vs linear buckets).
  const widths = e.slice(1).map((v, i) => v - e[i]!);
  expect(widths[widths.length - 1]!).toBeGreaterThan(widths[0]!);
  // A LINEAR split would give every band the same width; prove we are nothing like that.
  expect(widths[widths.length - 1]!).toBeGreaterThan(4 * widths[0]!);
});

test("band edges survive absurd inputs without producing an empty or out-of-range band", () => {
  const tiny = bandEdges(8, 14, EQ_MIN_HZ, EQ_MAX_HZ, NYQ); // more bands than bins
  expect(tiny.length).toBe(15);
  expect(tiny[tiny.length - 1]!).toBeLessThanOrEqual(8);
  expect(Math.min(...tiny)).toBeGreaterThanOrEqual(0);
  expect(bandEdges(0, 0, 0, 0, 0).length).toBe(2); // clamped to one band, still well-formed
});

test("each band reports its LOUDEST bin, so a narrow formant is not averaged away", () => {
  const e = [0, 4, 8];
  const bins = new Uint8Array(8);
  bins[5] = 255; // one hot bin inside the second band
  const bands = foldBands(bins, e);
  expect(bands).toEqual([0, 1]);
  // Averaging would have given 255/4/255 ≈ 0.25 here; the peak keeps it visible.
  expect(bands[1]!).toBe(1);
});

test("bars snap up fast and glide down slow", () => {
  const bands = 3;
  let f = newEqFrame(bands);
  const loud = [1, 1, 1];
  f = stepEq(f, loud, 16); // one 60fps frame of full-scale input
  const afterAttack = f.levels[0]!;
  expect(afterAttack).toBeGreaterThan(0.25); // a 40ms constant covers a third of the gap in one frame
  f = stepEq(f, [0, 0, 0], 16); // silence for one frame
  const afterRelease = f.levels[0]!;
  const rose = afterAttack - 0;
  const fell = afterAttack - afterRelease;
  expect(fell).toBeLessThan(rose); // release is slower than attack — the defining behaviour
  expect(afterRelease).toBeGreaterThan(0.5 * afterAttack);
});

test("a peak cap hangs at the maximum, then falls at the configured rate", () => {
  let f = newEqFrame(1);
  for (let i = 0; i < 40; i++) f = stepEq(f, [1], 16); // drive it to full scale
  const top = f.peaks[0]!;
  expect(top).toBeGreaterThan(0.9);
  // Silence: within the hold window the cap must not move at all.
  f = stepEq(f, [0], 100);
  expect(f.peaks[0]!).toBeCloseTo(top, 5);
  f = stepEq(f, [0], 200); // 300ms elapsed, still inside the 380ms hold
  expect(f.peaks[0]!).toBeCloseTo(top, 5);
  // Past the hold it falls at peakFallPerSec.
  f = stepEq(f, [0], 100);
  const t0 = f.peaks[0]!;
  expect(t0).toBeLessThan(top);
  f = stepEq(f, [0], 200);
  const dropped = t0 - f.peaks[0]!;
  expect(dropped).toBeCloseTo((EQ_BALLISTICS.peakFallPerSec * 200) / 1000, 2);
  // A cap can never sit below its own bar.
  expect(f.peaks[0]!).toBeGreaterThanOrEqual(f.levels[0]!);
});

test("the display settles to rest so the paint loop can stop", () => {
  let f = newEqFrame(4);
  expect(eqAtRest(f)).toBe(true);
  f = stepEq(f, [1, 1, 1, 1], 16);
  expect(eqAtRest(f)).toBe(false);
  for (let i = 0; i < 400; i++) f = stepEq(f, [0, 0, 0, 0], 16); // ~6.4s of silence
  expect(eqAtRest(f)).toBe(true);
});

test("a stalled frame glides instead of teleporting, and levels stay in range", () => {
  let f = newEqFrame(2);
  f = stepEq(f, [1, 1], 100000); // a backgrounded tab hands back an enormous dt
  expect(f.levels[0]!).toBeLessThanOrEqual(1);
  expect(f.levels[0]!).toBeGreaterThan(0);
  f = stepEq(f, [-5, 99], 16); // out-of-range targets are clamped, never propagated
  expect(f.levels[0]!).toBeGreaterThanOrEqual(0);
  expect(f.levels[1]!).toBeLessThanOrEqual(1);
});
