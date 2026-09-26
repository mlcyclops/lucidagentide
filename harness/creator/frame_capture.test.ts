// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/creator/frame_capture.test.ts - CREATOR-3 (ADR-0287) keystone tests.
//
// The claims that must hold or a "regression compared" animation review is theatre:
//   * every tMs is derived from the frame INDEX, so a one second capture does not drift the ten milliseconds
//     a per-frame integer accumulator drifts,
//   * the fingerprint is the exact documented 64-bit FNV-1a, verified against an independent BigInt
//     implementation written from the algorithm rather than from the code under test,
//   * a scene driven ONLY by the supplied tMs fingerprints identically twice, and a scene that reads a wall
//     clock does not, which is the entire point of handing the scene a time value,
//   * a GPU that dithers by one level does not fail a regression, but a real change does,
//   * a capture that lies by dropping frames or by repeating them is named, and a repeat is never silently
//     excused as "the scene is just static".

import { describe, expect, test } from "bun:test";
import {
  captureReport, compareFrames, framePlan, frameFingerprint, MAX_CAPTURE_FRAMES, sameCapture,
  type CaptureFrame,
} from "./frame_capture.ts";

// ── test seams ──────────────────────────────────────────────────────────────

/** Unwrap a plan, failing the test loudly with the refusal text when there is one. */
function planned(opts: { durationMs: number; fps: number; startMs?: number }): readonly CaptureFrame[] {
  const result = framePlan(opts);
  if (!result.ok) throw new Error(`expected a plan, got refusal: ${result.error}`);
  return result.frames;
}

/** Unwrap a refusal, failing the test when the call unexpectedly succeeded. */
function refusal(opts: { durationMs: number; fps: number; startMs?: number }): string {
  const result = framePlan(opts);
  if (result.ok) throw new Error(`expected a refusal, got ${result.frames.length} frames`);
  return result.error;
}

/** A 2x2 RGBA frame whose red and green channels encode `value`, so distinct values are distinct frames. */
function frameEncoding(value: number): Uint8Array {
  const rgba = new Uint8Array(16);
  for (let pixel = 0; pixel < 4; pixel++) {
    rgba[pixel * 4] = value & 0xff;
    rgba[pixel * 4 + 1] = (value >>> 8) & 0xff;
    rgba[pixel * 4 + 2] = pixel * 40;
    rgba[pixel * 4 + 3] = 255;
  }
  return rgba;
}

/** The honest scene: its pixels are a function of the time it was handed and of nothing else. */
const deterministicScene = (tMs: number): Uint8Array => frameEncoding(tMs);

/**
 * The bug ADR-0287 item 3 exists to catch: a scene that animates off a wall clock and ignores the tMs it was
 * given. The clock is an injected counter, so the TEST stays deterministic while the SCENE does not: two runs
 * on machines under different load tick at different rates and therefore disagree.
 */
function wallClockScene(tickMs: number): (tMs: number) => Uint8Array {
  let now = 0;
  return () => {
    now += tickMs;
    return frameEncoding(now);
  };
}

const runCapture = (plan: readonly CaptureFrame[], scene: (tMs: number) => Uint8Array): string[] =>
  plan.map((frame) => frameFingerprint(scene(frame.tMs), 2, 2));

/**
 * FNV-1a 64 written straight from the algorithm in BigInt: offset basis 0xcbf29ce484222325, prime
 * 0x100000001b3, modulo 2^64. Deliberately independent of the module's 32-bit-halves arithmetic so that a
 * carry bug in the fast path cannot hide behind a test that shares its mistake.
 */
function referenceFnv1a64Hex(bytes: readonly number[]): string {
  const mask = (1n << 64n) - 1n;
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash = (hash ^ BigInt(byte)) & mask;
    hash = (hash * 0x100000001b3n) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

const le32 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];

/** The fingerprint the documented algorithm must produce, derived without calling the module. */
const referenceFingerprint = (rgba: Uint8Array, width: number, height: number): string =>
  `${width}x${height}:${rgba.length}:${referenceFnv1a64Hex([...le32(width), ...le32(height), ...rgba])}`;

// ── the clock ───────────────────────────────────────────────────────────────

describe("framePlan", () => {
  test("a 30fps capture of 1000ms is exactly 30 frames, every tMs an integer, every index its own position", () => {
    const frames = planned({ durationMs: 1000, fps: 30 });
    expect(frames.length).toBe(30);
    for (let i = 0; i < frames.length; i++) {
      expect(frames[i]!.index).toBe(i);
      expect(Number.isInteger(frames[i]!.tMs)).toBe(true);
    }
  });

  test("every tMs equals startMs plus round(index * 1000 / fps), the rule stated in the module", () => {
    const frames = planned({ durationMs: 1000, fps: 30 });
    for (const frame of frames) expect(frame.tMs).toBe(Math.round((frame.index * 1000) / 30));
    expect(frames.slice(0, 7).map((f) => f.tMs)).toEqual([0, 33, 67, 100, 133, 167, 200]);
  });

  test("frame 29 of a 30fps plan sits at 967ms, which is round(29000 / 30) and not 29 steps of 33", () => {
    const frames = planned({ durationMs: 1000, fps: 30 });
    expect(frames[29]!.tMs).toBe(967);
    expect(Math.round(29000 / 30)).toBe(967);
  });

  test("the index derived timestep does not drift the 10ms a per frame integer accumulator drifts in one second", () => {
    const frames = planned({ durationMs: 1000, fps: 30 });
    const perFrame = Math.round(1000 / 30); // 33: the integer step a naive capture loop adds each turn
    const drifted: number[] = [];
    let accumulated = 0;
    for (let i = 0; i < frames.length; i++) {
      drifted.push(accumulated);
      accumulated += perFrame;
    }
    expect(drifted[29]).toBe(957);
    expect(frames[29]!.tMs - drifted[29]!).toBe(10);
  });

  test("tMs advances strictly and by at most one millisecond of jitter around the ideal 30fps step", () => {
    const frames = planned({ durationMs: 1000, fps: 30 });
    for (let i = 1; i < frames.length; i++) {
      const gap = frames[i]!.tMs - frames[i - 1]!.tMs;
      expect(gap === 33 || gap === 34).toBe(true);
    }
  });

  test("startMs shifts every frame by exactly that integer and changes nothing else about the plan", () => {
    const base = planned({ durationMs: 200, fps: 30 });
    const shifted = planned({ durationMs: 200, fps: 30, startMs: 5000 });
    expect(shifted.length).toBe(base.length);
    for (let i = 0; i < base.length; i++) expect(shifted[i]!.tMs).toBe(base[i]!.tMs + 5000);
  });

  test("a fractional startMs is refused by name, because a fractional tMs is where drift starts", () => {
    expect(refusal({ durationMs: 1000, fps: 30, startMs: 0.5 })).toContain("startMs must be a non-negative integer");
  });

  test("a negative startMs is refused by name rather than producing negative scene times", () => {
    expect(refusal({ durationMs: 1000, fps: 30, startMs: -1 })).toContain("startMs must be a non-negative integer");
  });

  test("fps 0 is refused by name and fps 1 is accepted, so the lower bound is inclusive", () => {
    expect(refusal({ durationMs: 1000, fps: 0 })).toBe("fps must be between 1 and 120, got 0");
    expect(planned({ durationMs: 5000, fps: 1 }).map((f) => f.tMs)).toEqual([0, 1000, 2000, 3000, 4000]);
  });

  test("fps 121 is refused by name and fps 120 is accepted, so the upper bound is inclusive", () => {
    expect(refusal({ durationMs: 1000, fps: 121 })).toBe("fps must be between 1 and 120, got 121");
    expect(planned({ durationMs: 1000, fps: 120 }).length).toBe(120);
  });

  test("a negative fps is refused by the range rule instead of producing a backwards plan", () => {
    expect(refusal({ durationMs: 1000, fps: -30 })).toContain("fps must be between 1 and 120");
  });

  test("a NaN or Infinite fps is refused as non finite, never treated as a rate", () => {
    expect(refusal({ durationMs: 1000, fps: Number.NaN })).toBe("fps must be a finite number, got NaN");
    expect(refusal({ durationMs: 1000, fps: Number.POSITIVE_INFINITY })).toContain("fps must be a finite number");
  });

  test("an fps that is a string wearing a number's type is refused, not coerced into a plan", () => {
    const error = refusal({ durationMs: 1000, fps: "30" as unknown as number });
    expect(error).toContain("fps must be a finite number");
    expect(error).toContain("30");
  });

  test("a 4 hour duration is refused by naming the frame count it needs and the 3600 frame cap", () => {
    const error = refusal({ durationMs: 4 * 60 * 60 * 1000, fps: 30 });
    expect(error).toContain("432000 frames");
    expect(error).toContain("3600 frame cap");
  });

  test("a plan of exactly MAX_CAPTURE_FRAMES is accepted and one frame past it is refused", () => {
    expect(MAX_CAPTURE_FRAMES).toBe(3600);
    const atCap = planned({ durationMs: 30_000, fps: 120 });
    expect(atCap.length).toBe(MAX_CAPTURE_FRAMES);
    expect(refusal({ durationMs: 30_009, fps: 120 })).toContain("3601 frames");
  });

  test("a negative duration is refused by name", () => {
    expect(refusal({ durationMs: -1, fps: 30 })).toBe("durationMs must not be negative, got -1");
  });

  test("a NaN or Infinite duration is refused as non finite rather than yielding a NaN frame count", () => {
    expect(refusal({ durationMs: Number.NaN, fps: 30 })).toBe("durationMs must be a finite number, got NaN");
    expect(refusal({ durationMs: Number.POSITIVE_INFINITY, fps: 30 })).toContain("durationMs must be a finite number");
  });

  test("a duration too short to hold one frame is refused, never returned as a green empty plan", () => {
    expect(refusal({ durationMs: 33, fps: 30 })).toBe("33ms at 30fps yields 0 frames: nothing to capture");
    expect(refusal({ durationMs: 0, fps: 30 })).toContain("yields 0 frames");
  });

  test("the duration is an exclusive end, so the last frame of a 1000ms 30fps plan is before 1000ms", () => {
    const frames = planned({ durationMs: 1000, fps: 30 });
    expect(frames[frames.length - 1]!.tMs).toBeLessThan(1000);
    expect(planned({ durationMs: 100, fps: 30 }).map((f) => f.tMs)).toEqual([0, 33, 67]);
  });

  test("two calls with the same options produce a deeply equal plan, because the plan is a pure function", () => {
    expect(planned({ durationMs: 777, fps: 60, startMs: 12 })).toEqual(planned({ durationMs: 777, fps: 60, startMs: 12 }));
  });
});

// ── the fingerprint ─────────────────────────────────────────────────────────

describe("frameFingerprint", () => {
  test("the BigInt reference reproduces the published FNV-1a 64 vectors, anchoring this chain outside the repo", () => {
    // Without this the BigInt reference below is just a second opinion from the same author. These three are
    // the published FNV-1a 64 answers, so the chain runs: published vector -> reference -> module.
    const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));
    expect(referenceFnv1a64Hex(ascii(""))).toBe("cbf29ce484222325");
    expect(referenceFnv1a64Hex(ascii("a"))).toBe("af63dc4c8601ec8c");
    expect(referenceFnv1a64Hex(ascii("foobar"))).toBe("85944171f73967e8");
  });

  test("the fast 32 bit halves multiply agrees with the BigInt reference on carry heavy and long inputs", () => {
    // The module avoids BigInt by holding the 64 bit state as two 32 bit halves, so the failure mode is a
    // dropped or double counted carry. All 0xff maximizes the carry out of every low half multiply, and the
    // sweep walks all 256 byte values; a halves bug survives none of these.
    const sizes: readonly (readonly [number, number])[] = [[1, 1], [2, 2], [4, 4], [10, 10], [16, 16], [37, 11], [64, 64]];
    const patterns: readonly ((i: number, n: number) => number)[] = [
      () => 0x00,
      () => 0xff,
      (i) => (i % 2 ? 0xff : 0x00),
      (i, n) => (i === n - 1 ? 0x80 : 0x00),
      (i) => (i * 167 + 13) & 0xff,
    ];
    let checked = 0;
    for (const [width, height] of sizes) {
      const n = width * height * 4;
      for (const fill of patterns) {
        const bytes = new Uint8Array(n);
        for (let i = 0; i < n; i++) bytes[i] = fill(i, n);
        expect(frameFingerprint(bytes, width, height)).toBe(referenceFingerprint(bytes, width, height));
        checked++;
      }
    }
    expect(checked).toBe(35);
  });

  test("the digest is the documented 64 bit FNV-1a over the dimensions then the bytes, per an independent BigInt reference", () => {
    for (const value of [0, 1, 255, 4096, 65535]) {
      const rgba = frameEncoding(value);
      expect(frameFingerprint(rgba, 2, 2)).toBe(referenceFingerprint(rgba, 2, 2));
    }
    const wide = new Uint8Array(4 * 3 * 4);
    for (let i = 0; i < wide.length; i++) wide[i] = (i * 37) & 0xff;
    expect(frameFingerprint(wide, 4, 3)).toBe(referenceFingerprint(wide, 4, 3));
  });

  test("the fingerprint carries width, height, byte length, and 16 lowercase hex digits", () => {
    const mark = frameFingerprint(frameEncoding(9), 2, 2);
    const parts = mark.split(":");
    expect(parts[0]).toBe("2x2");
    expect(parts[1]).toBe("16");
    expect(parts[2]).toMatch(/^[0-9a-f]{16}$/);
  });

  test("identical bytes fingerprint identically every time, including all zero and all 255 frames", () => {
    const zeros = new Uint8Array(16);
    const maxed = new Uint8Array(16).fill(255);
    expect(frameFingerprint(zeros, 2, 2)).toBe(frameFingerprint(new Uint8Array(16), 2, 2));
    expect(frameFingerprint(maxed, 2, 2)).toBe(frameFingerprint(new Uint8Array(16).fill(255), 2, 2));
    expect(frameFingerprint(zeros, 2, 2)).not.toBe(frameFingerprint(maxed, 2, 2));
  });

  test("a single flipped bit in a single channel changes the fingerprint", () => {
    const before = frameEncoding(7);
    const after = frameEncoding(7);
    after[9] = (after[9]! ^ 1) & 0xff;
    expect(frameFingerprint(after, 2, 2)).not.toBe(frameFingerprint(before, 2, 2));
  });

  test("the dimensions are mixed in, so a 2x2 and a 4x1 frame with the same 16 bytes never collide", () => {
    const bytes = frameEncoding(1234);
    const square = frameFingerprint(bytes, 2, 2);
    const strip = frameFingerprint(bytes, 4, 1);
    expect(square).not.toBe(strip);
    expect(square.split(":")[2]).not.toBe(strip.split(":")[2]);
  });

  test("a byte count that does not match width times height times 4 returns invalid with both numbers, and throws nothing", () => {
    expect(frameFingerprint(new Uint8Array(12), 2, 2)).toBe("invalid:12!=16");
    expect(frameFingerprint(new Uint8Array(20), 2, 2)).toBe("invalid:20!=16");
    expect(frameFingerprint(new Uint8Array(0), 2, 2)).toBe("invalid:0!=16");
  });

  test("two frames that are invalid for different reasons carry different invalid strings", () => {
    expect(frameFingerprint(new Uint8Array(12), 2, 2)).not.toBe(frameFingerprint(new Uint8Array(13), 2, 2));
  });

  test("a zero, negative, or fractional dimension is reported invalid instead of fingerprinted", () => {
    expect(frameFingerprint(new Uint8Array(0), 0, 0)).toBe("invalid:0!=0");
    expect(frameFingerprint(new Uint8Array(16), -2, -2)).toContain("invalid:16!=");
    expect(frameFingerprint(new Uint8Array(16), 2.5, 1.6)).toContain("invalid:16!=");
    expect(frameFingerprint(new Uint8Array(16), Number.NaN, 2)).toBe("invalid:16!=NaN");
  });

  test("a frame that is not a Uint8Array at all is reported invalid rather than throwing", () => {
    expect(frameFingerprint([0, 0, 0, 0] as unknown as Uint8Array, 1, 1)).toBe("invalid:-1!=4");
  });

  test("a 1080p sized readback fingerprints without BigInt, proving the 32 bit halves path carries real volume", () => {
    const big = new Uint8Array(1920 * 1080 * 4);
    for (let i = 0; i < big.length; i += 1021) big[i] = (i * 31) & 0xff;
    const mark = frameFingerprint(big, 1920, 1080);
    expect(mark.startsWith("1920x1080:8294400:")).toBe(true);
    expect(mark.split(":")[2]).toMatch(/^[0-9a-f]{16}$/);
    big[big.length - 1] = 1;
    expect(frameFingerprint(big, 1920, 1080)).not.toBe(mark);
  });
});

// ── the pixel comparator ────────────────────────────────────────────────────

describe("compareFrames", () => {
  const flat = (value: number, bytes = 16): Uint8Array => new Uint8Array(bytes).fill(value);

  test("a one level channel difference is equal at tolerance 1 and not equal at tolerance 0", () => {
    const a = flat(100);
    const b = flat(100);
    b[5] = 101;
    expect(compareFrames(a, b, { tolerance: 1 }).equal).toBe(true);
    expect(compareFrames(a, b, { tolerance: 0 }).equal).toBe(false);
    expect(compareFrames(a, b).equal).toBe(false);
  });

  test("maxChannelDelta reports the true delta even when the tolerance absorbs it", () => {
    const a = flat(100);
    const b = flat(100);
    b[5] = 101;
    const diff = compareFrames(a, b, { tolerance: 1 });
    expect(diff.equal).toBe(true);
    expect(diff.maxChannelDelta).toBe(1);
    expect(diff.changedPixels).toBe(0);
  });

  test("changedPixels counts pixels, not channels, so three channels off in one pixel is one changed pixel", () => {
    const a = flat(0);
    const b = flat(0);
    b[4] = 9; b[5] = 9; b[6] = 9;
    const diff = compareFrames(a, b);
    expect(diff.changedPixels).toBe(1);
    expect(diff.maxChannelDelta).toBe(9);
  });

  test("two changed pixels are counted as two even when their changed channels are adjacent bytes", () => {
    const a = flat(0);
    const b = flat(0);
    b[3] = 5; b[4] = 5;
    expect(compareFrames(a, b).changedPixels).toBe(2);
  });

  test("firstDiffIndex is the byte index of the first channel over tolerance, and -1 when the frames match", () => {
    const a = flat(10);
    const b = flat(10);
    b[11] = 30;
    b[7] = 12;
    expect(compareFrames(a, b, { tolerance: 0 }).firstDiffIndex).toBe(7);
    expect(compareFrames(a, b, { tolerance: 5 }).firstDiffIndex).toBe(11);
    expect(compareFrames(a, flat(10)).firstDiffIndex).toBe(-1);
  });

  test("a tolerance of 255 makes any two frames equal, which is the documented ceiling and not a bug", () => {
    expect(compareFrames(flat(0), flat(255), { tolerance: 255 }).equal).toBe(true);
    expect(compareFrames(flat(0), flat(255), { tolerance: 254 }).equal).toBe(false);
  });

  test("different byte lengths are not equal, name both lengths, and do not crash", () => {
    const diff = compareFrames(flat(7, 16), flat(7, 20));
    expect(diff.equal).toBe(false);
    expect(diff.reason).toContain("16 vs 20");
    expect(diff.firstDiffIndex).toBe(16);
  });

  test("a length mismatch still reports whether the shared prefix drifted, because that is a different bug", () => {
    const a = flat(7, 16);
    const b = flat(7, 24);
    b[2] = 200;
    const diff = compareFrames(a, b);
    expect(diff.equal).toBe(false);
    expect(diff.changedPixels).toBe(1);
    expect(diff.firstDiffIndex).toBe(2);
    expect(diff.reason).toContain("16 vs 24");
  });

  test("a tolerance outside 0..255 refuses the comparison instead of reporting a green regression", () => {
    for (const tolerance of [-1, 256, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const diff = compareFrames(flat(0), flat(0), { tolerance });
      expect(diff.equal).toBe(false);
      expect(diff.reason).toContain("tolerance must be an integer in 0..255");
    }
  });

  test("a negative tolerance never inverts the comparison into calling identical frames different-but-fine", () => {
    const diff = compareFrames(flat(3), flat(3), { tolerance: -1 });
    expect(diff.equal).toBe(false);
    expect(diff.changedPixels).toBe(0);
    expect(diff.reason).toContain("refusing to compare");
  });

  test("either frame failing to be a Uint8Array refuses the comparison by naming what arrived", () => {
    const first = compareFrames(null as unknown as Uint8Array, flat(0));
    expect(first.equal).toBe(false);
    expect(first.reason).toContain("must be Uint8Array");
    expect(first.reason).toContain("null");
    const second = compareFrames(flat(0), "1234" as unknown as Uint8Array);
    expect(second.equal).toBe(false);
    expect(second.reason).toContain("must be Uint8Array");
    expect(second.reason).toContain("Uint8Array(16)");
  });

  test("two empty frames of equal length are equal, and the reason quotes the tolerance", () => {
    const diff = compareFrames(new Uint8Array(0), new Uint8Array(0));
    expect(diff.equal).toBe(true);
    expect(diff.reason).toContain("tolerance 0");
  });
});

// ── the capture audit ───────────────────────────────────────────────────────

describe("captureReport", () => {
  const plan = (n: number): CaptureFrame[] => Array.from({ length: n }, (_, index) => ({ index, tMs: index * 10 }));
  const marks = (values: readonly string[]): string[] => values.map((v) => `2x2:16:${v.padStart(16, "0")}`);

  test("a capture with every frame fingerprinted and no repeats is ok and the verdict quotes the frame count", () => {
    const report = captureReport(plan(5), marks(["a", "b", "c", "d", "e"]));
    expect(report.ok).toBe(true);
    expect(report.frames).toBe(5);
    expect(report.missing).toBe(0);
    expect(report.stuckRuns).toEqual([]);
    expect(report.invalid).toEqual([]);
    expect(report.verdict).toContain("all 5 planned frames");
  });

  test("a 5 frame identical run is reported as one stuck run with bounds 0 to 4", () => {
    const report = captureReport(plan(5), marks(["a", "a", "a", "a", "a"]));
    expect(report.ok).toBe(false);
    expect(report.stuckRuns).toEqual([{ from: 0, to: 4 }]);
  });

  test("the stuck threshold is exactly longer than 2, so a pair repeats innocently and a triple does not", () => {
    expect(captureReport(plan(4), marks(["a", "a", "b", "c"])).stuckRuns).toEqual([]);
    expect(captureReport(plan(4), marks(["a", "a", "b", "c"])).ok).toBe(true);
    expect(captureReport(plan(4), marks(["a", "a", "a", "c"])).stuckRuns).toEqual([{ from: 0, to: 2 }]);
  });

  test("two separate stuck runs are both reported with their own bounds", () => {
    const report = captureReport(plan(9), marks(["a", "a", "a", "b", "c", "d", "d", "d", "d"]));
    expect(report.stuckRuns).toEqual([{ from: 0, to: 2 }, { from: 5, to: 8 }]);
    expect(report.verdict).toContain("frames 0-2, frames 5-8");
  });

  test("a stuck verdict states both readings, static scene and wall clock animation, and picks neither", () => {
    const verdict = captureReport(plan(5), marks(["a", "a", "a", "a", "a"])).verdict;
    expect(verdict).toContain("static");
    expect(verdict).toContain("wall clock");
    expect(verdict).toContain("cannot");
    expect(verdict).toContain("5 of 5");
  });

  test("a short fingerprint list reports how many planned frames have no fingerprint and is not ok", () => {
    const report = captureReport(plan(30), marks(["a", "b", "c"]));
    expect(report.ok).toBe(false);
    expect(report.missing).toBe(27);
    expect(report.verdict).toContain("27 of 30 planned frames have no fingerprint");
  });

  test("a surplus fingerprint list is reported as misaligned even though nothing is missing", () => {
    const report = captureReport(plan(3), marks(["a", "b", "c", "d"]));
    expect(report.ok).toBe(false);
    expect(report.missing).toBe(0);
    expect(report.verdict).toContain("misaligned by 1");
  });

  test("an invalid fingerprint is listed by index and keeps the capture from being ok", () => {
    const report = captureReport(plan(4), ["2x2:16:aaaa", "invalid:12!=16", "2x2:16:cccc", ""]);
    expect(report.ok).toBe(false);
    expect(report.invalid).toEqual([1, 3]);
    expect(report.verdict).toContain("2 frames could not be fingerprinted (1, 3)");
  });

  test("an invalid frame breaks a stuck run instead of joining it, because an unread frame proves nothing about motion", () => {
    const report = captureReport(plan(5), ["2x2:16:aa", "2x2:16:aa", "invalid:0!=16", "2x2:16:aa", "2x2:16:aa"]);
    expect(report.stuckRuns).toEqual([]);
    expect(report.invalid).toEqual([2]);
    expect(report.ok).toBe(false);
  });

  test("a run of identical invalid fingerprints is reported as invalid, never as a stuck scene", () => {
    const report = captureReport(plan(4), ["invalid:0!=16", "invalid:0!=16", "invalid:0!=16", "invalid:0!=16"]);
    expect(report.invalid).toEqual([0, 1, 2, 3]);
    expect(report.stuckRuns).toEqual([]);
  });

  test("an invalid index list longer than 8 entries is truncated so a wholesale failure does not eat the verdict", () => {
    const report = captureReport(plan(12), Array.from({ length: 12 }, () => "invalid:0!=16"));
    expect(report.invalid.length).toBe(12);
    expect(report.verdict).toContain("and 4 more");
  });

  test("an empty plan is not ok, because a capture of nothing is not a passing capture", () => {
    const report = captureReport([], []);
    expect(report.ok).toBe(false);
    expect(report.frames).toBe(0);
    expect(report.verdict).toContain("no frames");
  });

  test("a plan that is not an array at all is refused by naming what arrived, not by throwing", () => {
    const report = captureReport(null as unknown as CaptureFrame[], []);
    expect(report.ok).toBe(false);
    expect(report.frames).toBe(0);
    expect(report.verdict).toContain("expected an array of frames, got null");
  });

  test("a plan whose indices are not contiguous is refused with the offending entry named", () => {
    const report = captureReport([{ index: 0, tMs: 0 }, { index: 2, tMs: 33 }], marks(["a", "b"]));
    expect(report.ok).toBe(false);
    expect(report.verdict).toContain("entry 1 carries index 2");
  });

  test("a plan whose tMs does not advance is refused, because every audit below it would be meaningless", () => {
    const report = captureReport([{ index: 0, tMs: 33 }, { index: 1, tMs: 33 }], marks(["a", "b"]));
    expect(report.ok).toBe(false);
    expect(report.verdict).toContain("does not advance past entry 0");
  });

  test("a plan entry with a fractional or missing tMs is refused by naming the entry", () => {
    expect(captureReport([{ index: 0, tMs: 0.5 }], marks(["a"])).verdict).toContain("entry 0 has a non-integer");
    expect(captureReport([null as unknown as CaptureFrame], marks(["a"])).verdict).toContain("entry 0 is null");
  });

  test("a real 30fps plan captured by an honest scene passes the audit end to end", () => {
    const frames = planned({ durationMs: 1000, fps: 30 });
    const report = captureReport(frames, runCapture(frames, deterministicScene));
    expect(report.ok).toBe(true);
    expect(report.frames).toBe(30);
  });

  test("a wall clock scene on a machine fast enough to repeat a frame is caught as stuck by the audit", () => {
    const frames = planned({ durationMs: 200, fps: 30 });
    const report = captureReport(frames, runCapture(frames, wallClockScene(0)));
    expect(report.ok).toBe(false);
    expect(report.stuckRuns).toEqual([{ from: 0, to: 5 }]);
  });
});

// ── the regression compare ──────────────────────────────────────────────────

describe("sameCapture", () => {
  test("two runs of a scene driven only by the plan tMs produce identical fingerprints", () => {
    const frames = planned({ durationMs: 1000, fps: 30 });
    const runA = runCapture(frames, deterministicScene);
    const runB = runCapture(frames, deterministicScene);
    const comparison = sameCapture(runA, runB);
    expect(comparison.equal).toBe(true);
    expect(comparison.firstDiff).toBe(-1);
    expect(runA.length).toBe(30);
    expect(comparison.reason).toContain("30 frames match");
  });

  test("a scene that reads a wall clock instead of the supplied tMs disagrees between two runs", () => {
    const frames = planned({ durationMs: 1000, fps: 30 });
    const onIdleMachine = runCapture(frames, wallClockScene(16));
    const onLoadedMachine = runCapture(frames, wallClockScene(20));
    const comparison = sameCapture(onIdleMachine, onLoadedMachine);
    expect(comparison.equal).toBe(false);
    expect(comparison.firstDiff).toBe(0);
    expect(comparison.reason).toContain("frame 0 differs");
  });

  test("the wall clock scene fails the compare because of its clock, not because the module is unstable", () => {
    const frames = planned({ durationMs: 1000, fps: 30 });
    // Same tick rate twice is the one case a wall clock scene agrees with itself, which proves the
    // disagreement above comes from the clock and not from nondeterminism in the fingerprint.
    expect(sameCapture(runCapture(frames, wallClockScene(16)), runCapture(frames, wallClockScene(16))).equal).toBe(true);
  });

  test("firstDiff names the first differing frame even when later frames also differ", () => {
    const comparison = sameCapture(["2x2:16:a", "2x2:16:b", "2x2:16:c"], ["2x2:16:a", "2x2:16:x", "2x2:16:y"]);
    expect(comparison.equal).toBe(false);
    expect(comparison.firstDiff).toBe(1);
    expect(comparison.reason).toContain("frame 1 differs");
  });

  test("runs of different lengths are not equal and firstDiff points at the first index only one run has", () => {
    const comparison = sameCapture(["2x2:16:a", "2x2:16:b"], ["2x2:16:a"]);
    expect(comparison.equal).toBe(false);
    expect(comparison.firstDiff).toBe(1);
    expect(comparison.reason).toContain("2 vs 1");
  });

  test("a divergence inside the shared prefix outranks a length mismatch, since it is the earlier failure", () => {
    const comparison = sameCapture(["2x2:16:a", "2x2:16:b"], ["2x2:16:z"]);
    expect(comparison.firstDiff).toBe(0);
    expect(comparison.reason).toContain("frame 0 differs");
  });

  test("two runs carrying the identical invalid fingerprint are not equal, so an unreadable frame never passes", () => {
    const comparison = sameCapture(["2x2:16:a", "invalid:12!=16"], ["2x2:16:a", "invalid:12!=16"]);
    expect(comparison.equal).toBe(false);
    expect(comparison.firstDiff).toBe(1);
    expect(comparison.reason).toContain("both runs");
  });

  test("an invalid fingerprint on one side only is named as that side", () => {
    expect(sameCapture(["invalid:0!=16"], ["2x2:16:a"]).reason).toContain("run A");
    expect(sameCapture(["2x2:16:a"], ["invalid:0!=16"]).reason).toContain("run B");
  });

  test("a blank fingerprint is unusable rather than a value two runs can agree on", () => {
    const comparison = sameCapture(["  "], ["  "]);
    expect(comparison.equal).toBe(false);
    expect(comparison.reason).toContain("unusable");
  });

  test("two empty runs are not equal, because neither of them captured anything", () => {
    const comparison = sameCapture([], []);
    expect(comparison.equal).toBe(false);
    expect(comparison.reason).toContain("nothing to compare");
  });

  test("a non array argument is treated as an empty run instead of throwing", () => {
    expect(sameCapture(null as unknown as string[], null as unknown as string[]).equal).toBe(false);
    expect(sameCapture(null as unknown as string[], ["2x2:16:a"]).reason).toContain("0 frames but their lengths differ");
  });

  test("a hostile fingerprint cannot smuggle newlines or bidi overrides into the reason it produces", () => {
    const hostile = `2x2:16:aaaa\u202Ebbbb\ncccc\u0000dddd`;
    const reason = sameCapture([hostile], ["2x2:16:0000000000000000"]).reason;
    expect(reason).not.toContain("\n");
    expect(reason).not.toContain("\u202e");
    expect(reason).not.toContain("\u0000");
    expect(reason).toContain("?");
  });

  test("an absurdly long fingerprint is truncated in the reason rather than pasted whole", () => {
    const reason = sameCapture(["2x2:16:" + "f".repeat(5000)], ["2x2:16:0"]).reason;
    expect(reason.length).toBeLessThan(300);
    expect(reason).toContain("...");
  });

  test("a two run regression over the real plan catches a single changed pixel in a single frame", () => {
    const frames = planned({ durationMs: 200, fps: 30 });
    const baseline = runCapture(frames, deterministicScene);
    const regressed = frames.map((frame) => {
      const rgba = deterministicScene(frame.tMs);
      if (frame.index === 3) rgba[6] = (rgba[6]! ^ 1) & 0xff;
      return frameFingerprint(rgba, 2, 2);
    });
    const comparison = sameCapture(baseline, regressed);
    expect(comparison.equal).toBe(false);
    expect(comparison.firstDiff).toBe(3);
  });
});
