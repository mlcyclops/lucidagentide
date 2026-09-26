// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/creator/mix.ts - CREATOR-5 (ADR-0289): the pure mix graph.
//
// CREATOR-2 gave one take an editable timeline. This is the other axis: N takes playing AT ONCE, each with
// its own level, pan, fades, and automation, summed to one file. Layering a narrator over a bed is a mix,
// not a concatenation, and this module is that mix as DATA plus the one function that renders it.
//
// Pure: no I/O, no clock, no random, no node builtins, no Web Audio. It runs identically in the renderer,
// in a unit test, and in the desktop seam.
//
// The shape, and why:
//
//   * A CLIP places a region of a source at a position on the timeline, with its own gain and fades.
//     Unlike the CREATOR-2 timeline, clips here may OVERLAP: overlapping is the entire point.
//   * A TRACK owns clips and applies level, pan, mute/solo, and an optional piecewise-linear ENVELOPE
//     (automation over time). A track is the unit a person reasons about ("the narration is too loud").
//   * A BUS groups tracks so a submix moves together. One level of grouping, not a routing matrix: a
//     matrix would be a graph problem with cycles to police, and nobody asked for one.
//   * The MASTER gain applies last.
//
// Three honesty rules are enforced in code, not in the UI:
//
//   * NOTHING IS AUTOMATIC. The render never quietly normalizes, ducks, limits, or fixes a hot mix. It
//     reports the true peak and how many samples clipped, and `headroomGain` hands the caller the number
//     to apply if it CHOOSES to. Silent gain changes are how a mixer lies about what you made.
//   * NO RESAMPLING, NO TIME-STRETCH. A source whose sample rate differs from the graph's REFUSES the
//     render, naming both rates. This project ships no resampler, so it claims none.
//   * A MUTED OR UNSOLOED TRACK CONTRIBUTES EXACTLY NOTHING. Not "almost nothing": its samples are never
//     added, which is the ADR-0289 keystone and is asserted byte-wise.

import { buildWav, type WavFormat } from "../brief/tts_backend.ts";
import { SILENCE_SOURCE, type SourceAudio, type TimelineDoc } from "./timeline.ts";

// ── the graph ───────────────────────────────────────────────────────────────

/** One automation point: the track's gain reaches `gain` at `atMs`, interpolated linearly between points. */
export interface EnvelopePoint { readonly atMs: number; readonly gain: number }

/** A region of a source placed on a track. `durationMs` is both the timeline length and the source region
 *  length (no time-stretch), and fades are measured inward from the clip's own edges. */
export interface MixClip {
  readonly id: string;
  readonly sourceId: string;
  readonly startMs: number;
  readonly durationMs: number;
  readonly srcStartMs: number;
  readonly gain: number;
  readonly fadeInMs: number;
  readonly fadeOutMs: number;
}

export interface MixTrack {
  readonly id: string;
  readonly label: string;
  readonly clips: readonly MixClip[];
  readonly gain: number;
  /** -1 hard left, 0 centre, 1 hard right. Ignored by a mono render, which SAYS so in the result. */
  readonly pan: number;
  readonly muted: boolean;
  readonly solo: boolean;
  /** Piecewise-linear gain automation. Empty means a flat 1. Must be sorted by `atMs`. */
  readonly envelope: readonly EnvelopePoint[];
  readonly busId?: string;
}

export interface MixBus {
  readonly id: string;
  readonly label: string;
  readonly gain: number;
  readonly muted: boolean;
}

export interface MixGraph {
  readonly sampleRate: number;
  /** 1 or 2. Pan and stereo sources only mean something at 2. */
  readonly channels: number;
  readonly bitsPerSample: number;
  readonly tracks: readonly MixTrack[];
  readonly buses: readonly MixBus[];
  readonly masterGain: number;
}

export const MAX_MIX_TRACKS = 32;
export const MAX_MIX_CLIPS_PER_TRACK = 200;

/** The mix's length: the furthest clip end on any track, muted ones included (muting is not trimming). */
export function mixDurationMs(graph: MixGraph): number {
  let end = 0;
  for (const t of graph.tracks) {
    for (const c of t.clips) {
      const clipEnd = c.startMs + c.durationMs;
      if (clipEnd > end) end = clipEnd;
    }
  }
  return end;
}

export const mixFormat = (graph: MixGraph): WavFormat => ({
  channels: graph.channels,
  sampleRate: graph.sampleRate,
  bitsPerSample: graph.bitsPerSample,
});

/** Envelope points sorted and de-duplicated by time (last write at a given instant wins), so the render can
 *  walk them once and `validateMix` has a canonical shape to check. */
export function normalizeEnvelope(points: readonly EnvelopePoint[]): EnvelopePoint[] {
  const byTime = new Map<number, number>();
  for (const p of points) {
    if (!Number.isFinite(p.atMs) || !Number.isFinite(p.gain)) continue;
    byTime.set(Math.max(0, Math.round(p.atMs)), Math.max(0, p.gain));
  }
  return [...byTime.entries()].sort((a, b) => a[0] - b[0]).map(([atMs, gain]) => ({ atMs, gain }));
}

/** Structural problems, as reasons rather than a bare false. Empty means renderable. */
export function validateMix(graph: MixGraph): string[] {
  const problems: string[] = [];
  if (graph.sampleRate <= 0) problems.push("sampleRate must be positive");
  if (graph.channels !== 1 && graph.channels !== 2) problems.push("a mix renders to 1 or 2 channels");
  if (graph.bitsPerSample !== 16) problems.push("only 16-bit PCM is supported");
  if (!(graph.masterGain >= 0)) problems.push("masterGain must be zero or greater");
  if (graph.tracks.length > MAX_MIX_TRACKS) problems.push(`a mix holds at most ${MAX_MIX_TRACKS} tracks`);
  const busIds = new Set(graph.buses.map((b) => b.id));
  const trackIds = new Set<string>();
  for (const t of graph.tracks) {
    if (trackIds.has(t.id)) problems.push(`two tracks share the id ${t.id}`);
    trackIds.add(t.id);
    if (!(t.gain >= 0)) problems.push(`track ${t.id} has a negative gain`);
    if (t.pan < -1 || t.pan > 1) problems.push(`track ${t.id} has a pan outside -1..1`);
    if (t.busId && !busIds.has(t.busId)) problems.push(`track ${t.id} names bus ${t.busId}, which does not exist`);
    if (t.clips.length > MAX_MIX_CLIPS_PER_TRACK) problems.push(`track ${t.id} holds more than ${MAX_MIX_CLIPS_PER_TRACK} clips`);
    for (const c of t.clips) {
      if (c.durationMs <= 0) problems.push(`clip ${c.id} has no length`);
      if (c.startMs < 0) problems.push(`clip ${c.id} starts before zero`);
      if (c.srcStartMs < 0) problems.push(`clip ${c.id} has a negative source offset`);
      if (!(c.gain >= 0)) problems.push(`clip ${c.id} has a negative gain`);
      if (c.fadeInMs < 0 || c.fadeOutMs < 0) problems.push(`clip ${c.id} has a negative fade`);
      if (c.fadeInMs + c.fadeOutMs > c.durationMs) problems.push(`clip ${c.id} fades overlap: ${c.fadeInMs}ms in + ${c.fadeOutMs}ms out exceeds ${c.durationMs}ms`);
    }
    for (let i = 1; i < t.envelope.length; i++) {
      if (t.envelope[i]!.atMs < t.envelope[i - 1]!.atMs) { problems.push(`track ${t.id} has an unsorted envelope`); break; }
    }
    for (const p of t.envelope) if (!(p.gain >= 0)) problems.push(`track ${t.id} has a negative envelope gain`);
  }
  return problems;
}

// ── the gain stages, each its own testable function ─────────────────────────

/** The envelope's gain at `ms`: flat 1 with no points, held flat before the first and after the last, and
 *  linearly interpolated in between. */
export function envelopeGainAt(points: readonly EnvelopePoint[], ms: number): number {
  if (points.length === 0) return 1;
  const first = points[0]!;
  if (ms <= first.atMs) return first.gain;
  const last = points[points.length - 1]!;
  if (ms >= last.atMs) return last.gain;
  for (let i = 1; i < points.length; i++) {
    const b = points[i]!;
    if (ms > b.atMs) continue;
    const a = points[i - 1]!;
    const span = b.atMs - a.atMs;
    if (span <= 0) return b.gain;
    return a.gain + ((ms - a.atMs) / span) * (b.gain - a.gain);
  }
  return last.gain;
}

/** A clip's fade multiplier `offsetMs` into it: linear in, linear out, 1 in the middle. Linear (not
 *  equal-power) because a fade the user drew as a straight line should sound like the line they drew. */
export function clipFadeGain(clip: MixClip, offsetMs: number): number {
  if (offsetMs < 0 || offsetMs > clip.durationMs) return 0;
  let g = 1;
  if (clip.fadeInMs > 0 && offsetMs < clip.fadeInMs) g = offsetMs / clip.fadeInMs;
  if (clip.fadeOutMs > 0) {
    const fromEnd = clip.durationMs - offsetMs;
    if (fromEnd < clip.fadeOutMs) g = Math.min(g, Math.max(0, fromEnd / clip.fadeOutMs));
  }
  return g;
}

/** Equal-power pan: centre sits at 1/sqrt(2) per side, so sweeping a track across the image does not make
 *  it louder in the middle. A mono render ignores pan entirely. */
export function panGains(pan: number, channels: number): number[] {
  if (channels === 1) return [1];
  const p = pan < -1 ? -1 : pan > 1 ? 1 : pan;
  const theta = ((p + 1) * Math.PI) / 4;
  return [Math.cos(theta), Math.sin(theta)];
}

/** Solo is exclusive: the moment any audible track is soloed, every track that is not soloed is silent.
 *  Returns null when nothing is soloed, so the caller has one branch instead of a special case per track. */
export function soloedTrackIds(graph: MixGraph): Set<string> | null {
  const soloed = graph.tracks.filter((t) => t.solo && !t.muted);
  return soloed.length === 0 ? null : new Set(soloed.map((t) => t.id));
}

/** WHY this track puts no samples into the mix, or null when it is audible. One function rather than a
 *  predicate plus a parallel explainer, so the render's decision and the sentence the UI prints can never
 *  disagree. The order is the order a person would check. */
export function trackSilenceReason(graph: MixGraph, track: MixTrack, soloed: Set<string> | null): string | null {
  if (track.muted) return "muted";
  if (track.clips.length === 0) return "no clips on the track";
  if (track.gain === 0) return "track level is at zero";
  if (soloed && !soloed.has(track.id)) return "another track is soloed";
  const bus = track.busId ? graph.buses.find((b) => b.id === track.busId) : undefined;
  if (bus?.muted) return `bus ${bus.label} is muted`;
  if (bus && bus.gain === 0) return `bus ${bus.label} is at zero`;
  return null;
}

/** The gain to apply so a mix that peaked at `peak` lands exactly at full scale. Returns 1 when there is
 *  nothing to recover (a silent or already-quiet mix), and is NEVER applied automatically. */
export function headroomGain(peak: number): number {
  return peak > 0 ? 1 / peak : 1;
}

// ── render ──────────────────────────────────────────────────────────────────

export interface MixRenderOk {
  readonly ok: true;
  readonly wav: Uint8Array;
  readonly bytes: number;
  readonly durationMs: number;
  /** True peak as a fraction of full scale, measured BEFORE clamping. Greater than 1 means it clipped. */
  readonly peak: number;
  /** How many output samples hit the rail. Reported, never silently fixed. */
  readonly clipped: number;
  /** Tracks that contributed nothing, and why, so the UI can explain a quiet mix instead of shrugging. */
  readonly silentTracks: readonly { readonly id: string; readonly reason: string }[];
  /** True when the graph carried a pan that a mono render could not honor. */
  readonly panIgnored: boolean;
}

export type MixRenderResult = MixRenderOk | { ok: false; error: string };

/** Sum the graph to one WAV. Deterministic: identical inputs always yield identical bytes, because the
 *  accumulation order is the graph's own order and the quantization happens exactly once at the end. */
export function renderMix(graph: MixGraph, sources: ReadonlyMap<string, SourceAudio>): MixRenderResult {
  const problems = validateMix(graph);
  if (problems.length > 0) return { ok: false, error: `mix is not renderable: ${problems[0]}` };

  const fmt = mixFormat(graph);
  const durationMs = mixDurationMs(graph);
  const totalFrames = Math.round((durationMs / 1000) * fmt.sampleRate);
  if (totalFrames <= 0) return { ok: false, error: "an empty mix has nothing to render" };

  const soloed = soloedTrackIds(graph);
  const silentTracks: { id: string; reason: string }[] = [];
  const acc = new Float64Array(totalFrames * fmt.channels);
  let panIgnored = false;

  for (const track of graph.tracks) {
    const silent = trackSilenceReason(graph, track, soloed);
    if (silent) { silentTracks.push({ id: track.id, reason: silent }); continue; }
    if (track.pan !== 0 && fmt.channels === 1) panIgnored = true;
    const bus = track.busId ? graph.buses.find((b) => b.id === track.busId) : undefined;
    const staticGain = track.gain * (bus ? bus.gain : 1) * graph.masterGain;
    const pans = panGains(track.pan, fmt.channels);
    const env = track.envelope;

    for (const clip of track.clips) {
      if (clip.gain === 0 || clip.sourceId === SILENCE_SOURCE) continue;
      const src = sources.get(clip.sourceId);
      if (!src) return { ok: false, error: `clip ${clip.id} on track ${track.id} needs source "${clip.sourceId}", which was not supplied` };
      if (src.fmt.sampleRate !== fmt.sampleRate) {
        return { ok: false, error: `source "${clip.sourceId}" is ${src.fmt.sampleRate}Hz and the mix is ${fmt.sampleRate}Hz; this build has no resampler` };
      }
      if (src.fmt.bitsPerSample !== 16) return { ok: false, error: `source "${clip.sourceId}" is ${src.fmt.bitsPerSample}-bit; only 16-bit PCM is supported` };
      if (src.fmt.channels !== 1 && src.fmt.channels !== 2) return { ok: false, error: `source "${clip.sourceId}" has ${src.fmt.channels} channels; a mix takes mono or stereo` };

      const srcChannels = src.fmt.channels;
      const srcFrames = Math.floor(src.data.length / (2 * srcChannels));
      const startFrame = Math.round((clip.startMs / 1000) * fmt.sampleRate);
      const clipFrames = Math.round((clip.durationMs / 1000) * fmt.sampleRate);
      const srcOffsetFrames = Math.round((clip.srcStartMs / 1000) * fmt.sampleRate);
      const msPerFrame = 1000 / fmt.sampleRate;

      for (let i = 0; i < clipFrames; i++) {
        const outFrame = startFrame + i;
        if (outFrame < 0 || outFrame >= totalFrames) continue;
        const srcFrame = srcOffsetFrames + i;
        if (srcFrame >= srcFrames) break; // a source shorter than its clip runs out; the rest stays silent
        const offsetMs = i * msPerFrame;
        const gain = clip.gain * clipFadeGain(clip, offsetMs) * envelopeGainAt(env, clip.startMs + offsetMs) * staticGain;
        if (gain === 0) continue;
        const base = srcFrame * srcChannels * 2;
        const left = readSample(src.data, base);
        const right = srcChannels === 2 ? readSample(src.data, base + 2) : left;
        if (fmt.channels === 1) {
          // Read-add-write rather than `+=`: a typed-array element reads as possibly undefined under
          // noUncheckedIndexedAccess, and the assertion erases to the same three instructions.
          acc[outFrame] = acc[outFrame]! + (srcChannels === 2 ? (left + right) / 2 : left) * gain;
          continue;
        }
        const o = outFrame * 2;
        acc[o] = acc[o]! + left * gain * pans[0]!;
        acc[o + 1] = acc[o + 1]! + right * gain * pans[1]!;
      }
    }
  }

  // Quantize once, at the end: measure the true peak, clamp, and COUNT what hit the rail.
  const out = new Uint8Array(acc.length * 2);
  let peakRaw = 0;
  let clipped = 0;
  for (let i = 0; i < acc.length; i++) {
    const v = acc[i]!;
    const mag = v < 0 ? -v : v;
    if (mag > peakRaw) peakRaw = mag;
    let q = Math.round(v);
    if (q > 32767) { q = 32767; clipped++; } else if (q < -32768) { q = -32768; clipped++; }
    const u = q < 0 ? q + 0x10000 : q;
    out[i * 2] = u & 0xff;
    out[i * 2 + 1] = (u >> 8) & 0xff;
  }
  const wav = buildWav(fmt, out);
  return {
    ok: true, wav, bytes: wav.length, durationMs,
    peak: Number((peakRaw / 32768).toFixed(6)),
    clipped, silentTracks, panIgnored,
  };
}

function readSample(data: Uint8Array, at: number): number {
  const raw = data[at]! | (data[at + 1]! << 8);
  return (raw & 0x8000) ? raw - 0x10000 : raw;
}

// ── builders and CREATOR-2 interop ──────────────────────────────────────────

export interface NewTrackInput {
  id: string;
  label: string;
  clips?: readonly MixClip[];
  gain?: number;
  pan?: number;
  muted?: boolean;
  solo?: boolean;
  envelope?: readonly EnvelopePoint[];
  busId?: string;
}

/** A track with the defaults spelled out, so every caller starts from unity gain, centred, audible. */
export function mixTrack(input: NewTrackInput): MixTrack {
  return {
    id: input.id,
    label: input.label,
    clips: input.clips ? [...input.clips] : [],
    gain: input.gain ?? 1,
    pan: input.pan ?? 0,
    muted: input.muted ?? false,
    solo: input.solo ?? false,
    envelope: normalizeEnvelope(input.envelope ?? []),
    ...(input.busId ? { busId: input.busId } : {}),
  };
}

export function emptyMix(sampleRate: number, channels: number): MixGraph {
  return { sampleRate, channels, bitsPerSample: 16, tracks: [], buses: [], masterGain: 1 };
}

/** Lift an edited CREATOR-2 timeline onto ONE mix track: each of its clips becomes a mix clip at the same
 *  position, keeping the source region it already resolved. This is the seam ADR-0289 promised, and it is
 *  why the mixer needs no separate notion of an edit. */
export function trackFromTimeline(doc: TimelineDoc, input: NewTrackInput): MixTrack {
  const clips: MixClip[] = doc.clips.map((c, i) => ({
    id: `${input.id}-c${i + 1}`,
    sourceId: c.sourceId,
    startMs: c.startMs,
    durationMs: c.endMs - c.startMs,
    srcStartMs: c.srcStartMs,
    gain: c.gain,
    fadeInMs: 0,
    fadeOutMs: 0,
  }));
  return mixTrack({ ...input, clips });
}

/** Every distinct source the graph will ask for, so a caller can load exactly those and no more. */
export function mixSourceIds(graph: MixGraph): string[] {
  const ids = new Set<string>();
  for (const t of graph.tracks) for (const c of t.clips) if (c.sourceId !== SILENCE_SOURCE) ids.add(c.sourceId);
  return [...ids];
}
