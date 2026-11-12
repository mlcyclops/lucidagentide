// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/voice/resample.ts
//
// CREATOR-WHISTLE (ADR-0432, decision 3): a scratch resampler for the model's ears only. Whistle hears
// 16 kHz mono float; the library holds 24 kHz Kokoro and 48 kHz dots.tts WAVs. This builds the model's
// INPUT buffer and nothing else: the user's samples, the timeline and every stored byte stay untouched.
//
// Pure TypeScript windowed sinc (Blackman window): the kernel is low-passed at 95% of the smaller
// Nyquist so a downsample does not alias, with 32 taps per side scaled by the decimation ratio so the
// transition band stays the same width in Hz. No dependency, no WASM, no worker.

/** Taps on each side of the centre at unity ratio; scaled by from/to when downsampling. */
const HALF_TAPS = 32;
/** Kernel table resolution (points per input sample); the table is linearly interpolated. */
const KERNEL_RES = 128;

function blackmanSinc(x: number, cutoff: number, halfTaps: number): number {
  const w = 0.42 + 0.5 * Math.cos((Math.PI * x) / halfTaps) + 0.08 * Math.cos((2 * Math.PI * x) / halfTaps);
  const y = 2 * cutoff * x;
  const sinc = y === 0 ? 1 : Math.sin(Math.PI * y) / (Math.PI * y);
  return 2 * cutoff * sinc * w;
}

/** Resample mono float PCM between arbitrary positive rates. Equal rates return a copy. Output length is
 *  round(n * to / from); each output sample is a normalized windowed-sinc sum over the nearest input
 *  samples, so the edges of the clip taper cleanly instead of ringing against zeros. */
export function resampleLinearPcm(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (!(fromRate > 0) || !(toRate > 0) || !Number.isFinite(fromRate) || !Number.isFinite(toRate)) {
    throw new Error(`resample rates must be positive finite numbers; got ${fromRate} -> ${toRate}`);
  }
  if (fromRate === toRate) return input.slice();
  const n = input.length;
  const outLen = Math.round((n * toRate) / fromRate);
  const out = new Float32Array(outLen);
  if (n === 0 || outLen === 0) return out;

  const step = fromRate / toRate; // input samples per output sample
  const halfTaps = step > 1 ? Math.ceil(HALF_TAPS * step) : HALF_TAPS;
  const cutoff = (Math.min(fromRate, toRate) / 2) * 0.95 / fromRate; // cycles per input sample

  // Kernel for |x| in [0, halfTaps] at KERNEL_RES points per input sample, plus one guard point.
  const tableLen = halfTaps * KERNEL_RES + 2;
  const table = new Float64Array(tableLen);
  for (let i = 0; i < tableLen - 1; i++) table[i] = blackmanSinc(i / KERNEL_RES, cutoff, halfTaps);

  for (let m = 0; m < outLen; m++) {
    const t = m * step;
    const k0 = Math.max(0, Math.ceil(t - halfTaps));
    const k1 = Math.min(n - 1, Math.floor(t + halfTaps));
    let acc = 0;
    let wsum = 0;
    for (let k = k0; k <= k1; k++) {
      const p = Math.abs(k - t) * KERNEL_RES;
      const i = p | 0;
      const f = p - i;
      const h0 = table[i]!;
      const h = h0 + (table[i + 1]! - h0) * f;
      acc += input[k]! * h;
      wsum += h;
    }
    out[m] = wsum !== 0 ? acc / wsum : 0;
  }
  return out;
}

/** Interleaved 16-bit little-endian PCM to mono float in [-1, 1]; channels are averaged. A trailing
 *  partial frame is dropped. */
export function pcm16ToMonoFloat(data: Uint8Array, channels: number): Float32Array {
  if (!Number.isInteger(channels) || channels < 1) throw new Error(`pcm16ToMonoFloat: channels must be a positive integer; got ${channels}`);
  const frameBytes = 2 * channels;
  const frames = Math.floor(data.byteLength / frameBytes);
  const out = new Float32Array(frames);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const scale = 1 / (32768 * channels);
  for (let i = 0; i < frames; i++) {
    const base = i * frameBytes;
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += view.getInt16(base + 2 * c, true);
    out[i] = sum * scale;
  }
  return out;
}
