// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/voice/eq_bands.ts
//
// P-VOICE.4 (ADR-0247): the maths behind the speech equalizer - FFT bins folded into log-spaced bands, plus
// the BALLISTICS that make it read like a hi-fi spectrum analyser instead of a twitching bar chart.
//
// Two things separate a real analyser display from a naive one, and both live here:
//
//   1. LOG-SPACED BANDS. An FFT is linear in frequency, so half its bins sit above 5 kHz where speech has
//      almost nothing. Bucketing linearly gives you three busy bars on the left and eleven dead ones on the
//      right. Ears are logarithmic, and so are the bands on every stereo that ever had a spectrum display.
//   2. ASYMMETRIC BALLISTICS + PEAK HOLD. Raw per-frame magnitudes flicker at 60 Hz and look like noise. A
//      fast attack with a slow release is what gives bars their characteristic "snap up, glide down", and the
//      little cap that hangs at the recent maximum before falling is the signature of the era being imitated.
//
// Pure: no Web Audio, no canvas, no clock. The renderer supplies dt and the raw bins.

export interface BandBallistics {
  /** Time constant for a RISING band. Small = the bar snaps to a transient. */
  attackMs: number;
  /** Time constant for a FALLING band. Large = the glide down that reads as "musical". */
  releaseMs: number;
  /** How long a peak cap hangs at its maximum before it starts to fall. */
  peakHoldMs: number;
  /** How fast the cap falls once the hold expires, in full-scale units per second. */
  peakFallPerSec: number;
}

/** Tuned for speech at 60fps: the bar tracks syllables, the cap lingers long enough to read. */
export const EQ_BALLISTICS: BandBallistics = { attackMs: 40, releaseMs: 220, peakHoldMs: 380, peakFallPerSec: 1.15 };

/** Speech lives roughly between these; going wider just adds bars that never move. */
export const EQ_MIN_HZ = 60;
export const EQ_MAX_HZ = 12000;

/** Bin indices delimiting each band: band `i` owns bins `[edges[i], edges[i+1])`. Length is `bands + 1`.
 *  Log-spaced across `minHz`..`maxHz`, then forced strictly increasing so no band is empty -- an empty band
 *  would render as a bar that is always dark, which reads as a broken display rather than a quiet frequency. */
export function bandEdges(binCount: number, bands: number, minHz: number, maxHz: number, nyquistHz: number): number[] {
  const n = Math.max(1, Math.floor(bands));
  const bins = Math.max(1, Math.floor(binCount));
  const lo = Math.log(Math.max(1, minHz));
  const hi = Math.log(Math.max(minHz + 1, maxHz));
  const edges: number[] = [];
  for (let i = 0; i <= n; i++) {
    const hz = Math.exp(lo + ((hi - lo) * i) / n);
    edges.push(Math.min(bins, Math.max(0, Math.round((hz / Math.max(1, nyquistHz)) * bins))));
  }
  // Walk forward giving every band at least one bin, then backward so the tail still fits inside `bins`
  // when there are more bands than bins to go round.
  for (let i = 1; i <= n; i++) if (edges[i]! <= edges[i - 1]!) edges[i] = edges[i - 1]! + 1;
  if (edges[n]! > bins) {
    edges[n] = bins;
    for (let i = n - 1; i >= 0; i--) if (edges[i]! >= edges[i + 1]!) edges[i] = Math.max(0, edges[i + 1]! - 1);
  }
  return edges;
}

/** Fold raw FFT magnitudes (0..255, as `getByteFrequencyData` gives them) into 0..1 levels, one per band.
 *  Each band takes the LOUDEST bin it owns, not the mean: averaging washes a narrow formant out against its
 *  quiet neighbours, and a spectrum display is meant to show that the energy is there. */
export function foldBands(freq: ArrayLike<number>, edges: number[]): number[] {
  const out: number[] = [];
  for (let b = 0; b + 1 < edges.length; b++) {
    const from = Math.max(0, Math.min(freq.length, edges[b]!));
    const to = Math.max(from + 1, Math.min(freq.length, edges[b + 1]!));
    let peak = 0;
    for (let i = from; i < to; i++) { const v = freq[i] ?? 0; if (v > peak) peak = v; }
    out.push(peak / 255);
  }
  return out;
}

/** The animated state of the display: the smoothed bar heights, the hanging peak caps, and how much hold
 *  each cap has left. All arrays are the same length and are replaced (never mutated) on each step. */
export interface EqFrame {
  levels: number[];
  peaks: number[];
  holdMs: number[];
}

export function newEqFrame(bands: number): EqFrame {
  const n = Math.max(0, Math.floor(bands));
  return { levels: Array(n).fill(0), peaks: Array(n).fill(0), holdMs: Array(n).fill(0) };
}

/** Advance the display by `dtMs` towards `target`. Rising bands use the fast attack constant, falling ones
 *  the slow release; each cap holds at the running maximum, then falls at a constant rate. Frame-rate
 *  independent -- the exponential is computed from dt, so a dropped frame glides instead of jumping. */
export function stepEq(f: EqFrame, target: number[], dtMs: number, b: BandBallistics = EQ_BALLISTICS): EqFrame {
  const dt = Math.max(0, Math.min(250, dtMs)); // a backgrounded tab can hand us a huge dt; don't teleport
  const kUp = 1 - Math.exp(-dt / Math.max(1, b.attackMs));
  const kDown = 1 - Math.exp(-dt / Math.max(1, b.releaseMs));
  const levels: number[] = [];
  const peaks: number[] = [];
  const holdMs: number[] = [];
  for (let i = 0; i < f.levels.length; i++) {
    const cur = f.levels[i] ?? 0;
    const want = Math.max(0, Math.min(1, target[i] ?? 0));
    const next = cur + (want - cur) * (want > cur ? kUp : kDown);
    levels.push(next);
    const peak = f.peaks[i] ?? 0;
    if (next >= peak) { peaks.push(next); holdMs.push(b.peakHoldMs); continue; }
    const left = (f.holdMs[i] ?? 0) - dt;
    if (left > 0) { peaks.push(peak); holdMs.push(left); continue; }
    peaks.push(Math.max(next, peak - (b.peakFallPerSec * dt) / 1000));
    holdMs.push(0);
  }
  return { levels, peaks, holdMs };
}

/** True once every bar and cap has settled at rest -- the cue to stop the paint loop instead of burning a
 *  rAF forever on a static display. */
export function eqAtRest(f: EqFrame, epsilon = 0.004): boolean {
  return f.levels.every((v) => v <= epsilon) && f.peaks.every((v) => v <= epsilon);
}
