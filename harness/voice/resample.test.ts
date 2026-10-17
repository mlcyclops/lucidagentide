// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// CREATOR-WHISTLE (ADR-0432): the scratch resampler that builds the model's 16 kHz input. These pin the
// two properties that matter for speech: an in-band tone survives at its frequency, and content above
// the target Nyquist is removed instead of aliasing into the speech band.

import { expect, test } from "bun:test";
import { pcm16ToMonoFloat, resampleLinearPcm } from "./resample.ts";

function tone(hz: number, rate: number, seconds: number, amplitude = 0.8): Float32Array {
  const out = new Float32Array(Math.round(rate * seconds));
  for (let i = 0; i < out.length; i++) out[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / rate);
  return out;
}

function zeroCrossings(x: Float32Array, from: number, to: number): number {
  let n = 0;
  for (let i = from + 1; i < to; i++) if ((x[i - 1]! < 0) !== (x[i]! < 0)) n++;
  return n;
}

function rms(x: Float32Array, from: number, to: number): number {
  let e = 0;
  for (let i = from; i < to; i++) e += x[i]! * x[i]!;
  return Math.sqrt(e / Math.max(1, to - from));
}

test("24 kHz 1 kHz tone -> 16 kHz keeps 1 kHz (zero crossings within 2%) and its amplitude", () => {
  const input = tone(1000, 24000, 1);
  const out = resampleLinearPcm(input, 24000, 16000);
  expect(out.length).toBe(16000);
  // Measure the interior second to stay clear of the edge taper: 1 kHz over 0.8 s = 1600 crossings.
  const crossings = zeroCrossings(out, 1600, 14400);
  expect(Math.abs(crossings - 1600) / 1600).toBeLessThanOrEqual(0.02);
  const ratio = rms(out, 1600, 14400) / rms(input, 2400, 21600);
  expect(ratio).toBeGreaterThan(0.97);
  expect(ratio).toBeLessThan(1.03);
});

test("a 10 kHz tone above the 8 kHz target Nyquist is attenuated by at least 40 dB", () => {
  const input = tone(10000, 24000, 1);
  const out = resampleLinearPcm(input, 24000, 16000);
  const inDb = 20 * Math.log10(rms(input, 2400, 21600));
  const outDb = 20 * Math.log10(rms(out, 1600, 14400) + 1e-12);
  expect(inDb - outDb).toBeGreaterThanOrEqual(40);
});

test("48 kHz -> 16 kHz decimates a 2 kHz tone cleanly (3:1)", () => {
  const out = resampleLinearPcm(tone(2000, 48000, 0.5), 48000, 16000);
  expect(out.length).toBe(8000);
  const crossings = zeroCrossings(out, 800, 7200); // 0.4 s of 2 kHz = 1600 crossings
  expect(Math.abs(crossings - 1600) / 1600).toBeLessThanOrEqual(0.02);
});

test("equal rates return a copy, not the same buffer", () => {
  const input = tone(440, 16000, 0.1);
  const out = resampleLinearPcm(input, 16000, 16000);
  expect(out).not.toBe(input);
  expect(out.buffer).not.toBe(input.buffer);
  expect(Array.from(out)).toEqual(Array.from(input));
});

test("empty input and absurd rates", () => {
  expect(resampleLinearPcm(new Float32Array(0), 48000, 16000).length).toBe(0);
  expect(() => resampleLinearPcm(new Float32Array(10), 0, 16000)).toThrow(/positive/);
  expect(() => resampleLinearPcm(new Float32Array(10), 16000, Number.NaN)).toThrow(/positive/);
});

test("48 kHz stereo pcm16 -> mono float averages the channels and scales to [-1, 1]", () => {
  // Frames: L=16384 R=-16384 (avg 0); L=32767 R=32767 (avg ~1); L=-32768 R=0 (avg -0.5); trailing odd byte dropped.
  const frames = [[16384, -16384], [32767, 32767], [-32768, 0]];
  const bytes = new Uint8Array(frames.length * 4 + 1);
  const view = new DataView(bytes.buffer);
  frames.forEach(([l, r], i) => { view.setInt16(i * 4, l!, true); view.setInt16(i * 4 + 2, r!, true); });
  const mono = pcm16ToMonoFloat(bytes, 2);
  expect(mono.length).toBe(3);
  expect(mono[0]).toBeCloseTo(0, 6);
  expect(mono[1]).toBeCloseTo(32767 / 32768, 6);
  expect(mono[2]).toBeCloseTo(-0.5, 6);
  // A view into a larger buffer (a WAV data chunk) honours the byte offset.
  const framed = new Uint8Array(bytes.buffer, 4, 8);
  expect(Array.from(pcm16ToMonoFloat(framed, 2))).toEqual([mono[1]!, mono[2]!]);
  // Mono passes samples through.
  expect(pcm16ToMonoFloat(bytes, 1).length).toBe(6);
  expect(() => pcm16ToMonoFloat(bytes, 0)).toThrow(/channels/);
});
