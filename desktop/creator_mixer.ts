// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/creator_mixer.ts - CREATOR-5 (ADR-0289): the desktop seam under the mixer.
//
// harness/creator/mix.ts is the whole mix model plus the one function that sums it, and it is PURE: no IO,
// no clock, no node builtins, so it runs unchanged in the renderer bundle. This file is the ONLY place that
// turns LIBRARY TRACKS into the sources that render needs, and a RENDERED MIX back into a library track.
// Same division of labour as CREATOR-2: the renderer paints, the core sums, the disk lives here.
//
// Four positions this seam takes, and each one is a refusal rather than a fallback:
//
//   * THE MIX FORMAT IS DISCOVERED, NEVER IMPOSED. This build ships no resampler (ADR-0289), so every
//     layer of a mix must already share one sample rate. `mixerTracks` therefore reports the MAJORITY
//     (sampleRate, channels) pair in the library, ties going to the newest track, and still lists every
//     WAV with its REAL format so the UI can say WHY a track is not offered instead of quietly hiding it.
//     A WAV this build cannot decode as 16-bit PCM has no format the mixer can state, so it is listed with
//     nulls: unknown, never a guess, and never 0.
//   * NOTHING IS AUTOMATIC. `renderMix` measures the true peak and counts the samples that hit the rail;
//     this seam passes both through untouched. Headroom is applied ONLY when the caller asks for it, and
//     then the EXACT factor comes back as `headroomApplied`. A mixer that quietly turned a hot mix down
//     would be lying about what the user made.
//   * A SOURCE THAT CANNOT BE RESOLVED REFUSES THE WHOLE RENDER, BY ID. Not "mixed without that layer":
//     the file the user got back could not admit the omission, so the omission is never made. Silence is
//     only ever used where a clip explicitly asks for it.
//   * A SAVE IS AN APPEND. The render goes back through the library's own `addTrack`, so id minting, path
//     confinement, and the append-only ledger stay in ONE place and every input keeps its bytes. The
//     ledger has ONE parent slot and a mix has MANY inputs, so `parentId` records the track the user was
//     working from and the saved prompt NAMES every input and the role it played. The lineage row is never
//     asked to imply more than it can hold.

import type { WavFormat } from "../harness/brief/tts_backend.ts";
import { SILENCE_SOURCE, durationOfWav, type SourceAudio } from "../harness/creator/timeline.ts";
import {
  MAX_MIX_CLIPS_PER_TRACK, MAX_MIX_TRACKS, headroomGain, mixSourceIds, renderMix, validateMix,
  type EnvelopePoint, type MixBus, type MixClip, type MixGraph, type MixRenderOk, type MixTrack,
} from "../harness/creator/mix.ts";
import {
  MAX_TRACK_BYTES, addTrack, foldLibrary, libraryAudioDir, libraryLedger,
  type CreatorTrack, type LibraryIo,
} from "./creator_library.ts";
import type { EditorIo } from "./creator_editor.ts";

/** The one container the mixer decodes, exactly as strict as the editor: the library accepts seven, and a
 *  mix says which one it can actually read instead of failing later inside a render. */
const WAV_MIME = "audio/wav";

/** Learning a track's real format means decoding its header, and the library's IO hands back whole files,
 *  so the probe is bounded the way the editor's is: the newest MAX_MIX_PROBES tracks, or MAX_MIX_PROBE_BYTES
 *  of audio (measured from the ledger, before anything is read), whichever comes first. A mix holds at most
 *  MAX_MIX_TRACKS layers, so offering the newest 40 WAVs is already more than any one mix can use, and a
 *  larger library claims nothing about the rest rather than listing rows it never measured. */
export const MAX_MIX_PROBES = 40;
export const MAX_MIX_PROBE_BYTES = 256 * 1024 * 1024;

export const MAX_MIX_TITLE = 200;

/** How much of a track's label the provenance line carries. Bounded so a 32-layer mix still fits inside
 *  the library's prompt clamp with the caller's own prose after it. */
const MAX_ROLE_LABEL = 60;

/** Wire bound for an untrusted graph's automation. One over the line refuses the whole body: a truncated
 *  envelope would render as levels the user never drew. */
export const MAX_WIRE_ENVELOPE = 2_000;

const join = (...parts: string[]): string => parts.join("/").replace(/\/{2,}/g, "/");

/** Where a render waits between `renderMix` and `addTrack`. Outside the audio directory, so a torn save can
 *  never leave a stray file that looks like a track, and deleted the moment the import returns. */
export const mixerStageDir = (base: string): string => join(base, "mixer-staging");

// ── the tracks a mix can be built from ──────────────────────────────────────

export interface MixerTrackView {
  id: string;
  title: string;
  mime: string;
  /** null when it cannot be measured without reading the file. NEVER 0. */
  durationMs: number | null;
  sampleRate: number | null;
  channels: number | null;
}

export interface MixerTracksResult {
  ok: boolean;
  error?: string;
  tracks?: MixerTrackView[];
  sampleRate?: number;
  channels?: number;
}

interface TrackWav {
  readonly fmt: WavFormat;
  readonly data: Uint8Array;
  readonly durationMs: number;
}

type WavRead = { ok: true; wav: TrackWav } | { ok: false; reason: string };

/** Read one library file and decode it once. `durationOfWav` is `parseWav` plus a division, and it is the
 *  project's only WAV reader, so the mixer measures a track exactly the way the editor and the render do.
 *  There is no second codec here and there never will be. */
function readTrackWav(io: LibraryIo, path: string): WavRead {
  let b64 = "";
  try { b64 = io.readBase64(path); }
  catch { return { ok: false, reason: "a file LUCID could not read" }; }
  try { return { ok: true, wav: durationOfWav(Buffer.from(b64, "base64")) }; }
  catch { return { ok: false, reason: "not a readable RIFF/WAVE file" }; }
}

/** One (sampleRate, channels) pair and how many library tracks carry it. */
interface FormatTally {
  readonly sampleRate: number;
  readonly channels: number;
  count: number;
}

/** Which library tracks can mix together, plus the format the mix will run at (the majority WAV format). */
export function mixerTracks(io: LibraryIo, base: string): MixerTracksResult {
  const tracks = foldLibrary(io.readText(libraryLedger(base)));
  const views: MixerTrackView[] = [];
  // A runtime tally, so a Map: its insertion order is the ledger's own newest-first order, which is
  // exactly the tie-break the format vote needs.
  const tally = new Map<string, FormatTally>();
  let probed = 0;
  let budget = MAX_MIX_PROBE_BYTES;

  for (const t of tracks) { // foldLibrary is already newest first
    if (t.mime !== WAV_MIME) continue; // an mp3 cannot be a layer; there is no transcoder to pretend with
    if (probed >= MAX_MIX_PROBES || t.bytes > budget) break;
    probed++;
    budget -= t.bytes;
    const path = join(libraryAudioDir(base), t.file);
    const read = io.exists(path) ? readTrackWav(io, path) : null;
    // No decodable 16-bit mono/stereo header at a real rate means this build cannot state a format for the
    // file, so it says so with nulls and takes no part in the vote. Unknown, not zero, and not a guess.
    // The sampleRate check is load-bearing on the WIRE too: a header declaring 0Hz would otherwise become
    // the majority format and be emitted as a format no consumer can act on.
    if (!read || !read.ok || read.wav.fmt.sampleRate <= 0
      || read.wav.fmt.bitsPerSample !== 16 || (read.wav.fmt.channels !== 1 && read.wav.fmt.channels !== 2)) {
      views.push({ id: t.id, title: t.title, mime: t.mime, durationMs: null, sampleRate: null, channels: null });
      continue;
    }
    const { fmt, durationMs } = read.wav;
    views.push({
      id: t.id,
      title: t.title,
      mime: t.mime,
      durationMs: durationMs > 0 ? durationMs : null,
      sampleRate: fmt.sampleRate,
      channels: fmt.channels,
    });
    const key = `${fmt.sampleRate}x${fmt.channels}`;
    const seen = tally.get(key);
    if (seen) seen.count++;
    else tally.set(key, { sampleRate: fmt.sampleRate, channels: fmt.channels, count: 1 });
  }

  let best: FormatTally | null = null;
  // Strict `>` walking insertion order: a tie keeps the pair the NEWEST track carried.
  for (const f of tally.values()) if (!best || f.count > best.count) best = f;
  return best
    ? { ok: true, tracks: views, sampleRate: best.sampleRate, channels: best.channels }
    : { ok: true, tracks: views }; // nothing mixable, so no format is claimed at all
}

// ── rendering and saving a mix ──────────────────────────────────────────────

export interface RenderMixInput {
  graph: MixGraph;
  title: string;
  prompt?: string;
  /** The track recorded as the saved mix's parent. A mix has many inputs; the ledger has one parent slot. */
  primaryTrackId: string;
  /** Opt-in only. When true the render is scaled by headroomGain(peak) and the result reports the number. */
  applyHeadroom?: boolean;
}

export interface RenderMixResult {
  ok: boolean;
  error?: string;
  trackId?: string;
  bytes?: number;
  durationMs?: number;
  /** True peak of the SAVED render, as the core reports it: rounded to 6 decimal places. When headroom was
   *  applied this is the RECOVERED peak (at or just under full scale), not the peak the factor came from. */
  peak?: number;
  clipped?: number;
  silentTracks?: { id: string; reason: string }[];
  panIgnored?: boolean;
  /** The exact gain applied when applyHeadroom was asked for, else undefined. Never a silent change.
   *  UNROUNDED, unlike `peak`: it is headroomGain(pre-headroom peak), a raw reciprocal. So compare it
   *  computed (headroomGain(the peak of the same graph rendered WITHOUT the flag)) and never against a
   *  decimal literal, and round it before display. A literal only happens to work when the pre-peak is a
   *  binary-friendly value such as 1.25 -> 0.8; 1/1.831055 is 0.5461328..., which no 6-place literal equals. */
  headroomApplied?: number;
}

/** Resolve every source the graph names to real audio. Fail-closed and BY ID: `renderMix` would refuse a
 *  missing source too, but the user needs to know WHICH track went missing, not that a render failed. The
 *  format refusals reuse the core's own wording, so the seam and the render can never explain the same
 *  problem two different ways. */
function collectSources(io: LibraryIo, base: string, tracks: readonly CreatorTrack[], graph: MixGraph):
  { ok: true; sources: Map<string, SourceAudio> } | { ok: false; error: string } {
  const byId = new Map(tracks.map((t) => [t.id, t] as const));
  const sources = new Map<string, SourceAudio>();
  for (const id of mixSourceIds(graph)) { // already free of SILENCE_SOURCE: silence needs no file
    const needs = `the mix needs source "${id}", which`;
    const track = byId.get(id);
    if (!track) return { ok: false, error: `${needs} is not in the library` };
    if (track.mime !== WAV_MIME) return { ok: false, error: `${needs} is ${track.mime}, not 16-bit PCM WAV` };
    const path = join(libraryAudioDir(base), track.file);
    if (!io.exists(path)) return { ok: false, error: `${needs} has no audio file any more` };
    const read = readTrackWav(io, path);
    if (!read.ok) return { ok: false, error: `${needs} is ${read.reason}` };
    const f = read.wav.fmt;
    // Channels deliberately do NOT have to match: a mono narration under a stereo bed is the whole point
    // of a mixer, and `renderMix` folds or duplicates a layer as needed. The SAMPLE RATE must match,
    // because there is no resampler, and the refusal says that in the core's own words.
    if (f.sampleRate !== graph.sampleRate) {
      return { ok: false, error: `source "${id}" is ${f.sampleRate}Hz and the mix is ${graph.sampleRate}Hz; this build has no resampler` };
    }
    if (f.bitsPerSample !== 16) return { ok: false, error: `source "${id}" is ${f.bitsPerSample}-bit; only 16-bit PCM is supported` };
    if (f.channels !== 1 && f.channels !== 2) return { ok: false, error: `source "${id}" has ${f.channels} channels; a mix takes mono or stereo` };
    sources.set(id, { fmt: f, data: read.wav.data });
  }
  return { ok: true, sources };
}

/** The line a saved mix carries so a human can read what went into it. The ledger holds ONE parent and a
 *  mix has MANY inputs, so the inputs live in prose where every one of them can be named: each source id
 *  with the label of the track (or tracks) that played it, in the graph's own order. Silence is not listed:
 *  it is not a library track and claiming it as an input would pad the truth. */
export function mixProvenance(graph: MixGraph): string {
  const roles = new Map<string, string[]>();
  for (const t of graph.tracks) {
    const role = (t.label || t.id).slice(0, MAX_ROLE_LABEL);
    for (const c of t.clips) {
      if (c.sourceId === SILENCE_SOURCE) continue;
      const seen = roles.get(c.sourceId);
      if (!seen) roles.set(c.sourceId, [role]);
      else if (!seen.includes(role)) seen.push(role);
    }
  }
  if (roles.size === 0) return "";
  return `mixed from: ${[...roles].map(([id, labels]) => `${id} (${labels.join(", ")})`).join(", ")}`;
}

export function renderAndSaveMix(io: EditorIo, base: string, input: RenderMixInput): RenderMixResult {
  // The structural check first, in `renderMix`'s own words, so a graph refused here and a graph refused
  // inside the render read identically.
  const problems = validateMix(input.graph);
  if (problems.length > 0) return { ok: false, error: `mix is not renderable: ${problems[0]}` };

  const tracks = foldLibrary(io.readText(libraryLedger(base)));
  const primaryId = typeof input.primaryTrackId === "string" ? input.primaryTrackId.trim() : "";
  const parent = tracks.find((t) => t.id === primaryId);
  if (!parent) return { ok: false, error: `no track ${primaryId || "id was given"}` };

  const title = (typeof input.title === "string" ? input.title : "").trim().slice(0, MAX_MIX_TITLE);
  if (!title) return { ok: false, error: "give the mix a title before saving it" };

  const collected = collectSources(io, base, tracks, input.graph);
  if (!collected.ok) return { ok: false, error: collected.error };

  const first = renderMix(input.graph, collected.sources);
  if (!first.ok) return { ok: false, error: first.error };
  if (first.bytes > MAX_TRACK_BYTES) {
    return { ok: false, error: `the mix renders to ${Math.round(first.bytes / (1024 * 1024))} MB, over the ${Math.round(MAX_TRACK_BYTES / (1024 * 1024))} MB library limit` };
  }

  // Headroom is OPT-IN. `headroomGain` hands back the factor that lands the reported peak at full scale;
  // the render runs again ONCE with that factor folded into the master gain, so the saved file and the
  // number in the answer describe the same audio. A factor of exactly 1 changes no sample (x * 1 is x), so
  // the second render is skipped and the 1 is still reported: what was applied, not what was intended.
  let rendered: MixRenderOk = first;
  let headroomApplied: number | undefined;
  if (input.applyHeadroom === true && first.peak > 0) {
    const gain = headroomGain(first.peak);
    headroomApplied = gain;
    if (gain !== 1) {
      const again = renderMix({ ...input.graph, masterGain: input.graph.masterGain * gain }, collected.sources);
      if (!again.ok) return { ok: false, error: again.error };
      rendered = again;
    }
  }

  const stage = join(mixerStageDir(base), `${io.id()}.wav`);
  io.ensureDir(mixerStageDir(base));
  try { io.writeBytes(stage, rendered.wav); }
  catch { return { ok: false, error: "could not stage the rendered mix for import" }; }

  // Provenance FIRST, the caller's own prompt after it: `addTrack` clamps the prompt, so if anything has to
  // be lost it must be the prose, never the list of what is actually in the file.
  const note = mixProvenance(input.graph);
  const extra = typeof input.prompt === "string" ? input.prompt.trim() : "";
  const prompt = [note, extra].filter((s) => s).join("\n");

  // No lyrics: a mix has as many word streams as it has layers, and pasting them end to end would claim a
  // timing the rendered file does not have. The words stay with the tracks that own them.
  const added = addTrack(io, base, {
    sourcePath: stage,
    title,
    origin: parent.origin,
    prompt: prompt || undefined,
    tags: parent.tags,
    parentId: parent.id,
    kind: "remix",
  });
  io.removeFile(stage);
  if (!added.ok || !added.track) return { ok: false, error: added.error ?? "the library refused the rendered mix" };

  // Every MEASUREMENT below is an unconditional property, and the conditional spread on the last line is
  // NOT a pattern to copy onto the others. For a measurement, 0 IS the measurement: `clipped: 0` is the
  // report "nothing hit the rail", so it must be sent. JSON.stringify drops undefined but keeps 0, and the
  // renderer's isRenderMixReport requires peak and clipped, so turning either into a conditional or truthy
  // spread would make the most common success in the whole feature, a clean render, arrive as a report the
  // pane refuses to read. `headroomApplied` earns the spread for the opposite reason: its ABSENCE is the
  // fact (no gain was applied), and reporting 0 there would claim a gain of zero.
  return {
    ok: true,
    trackId: added.track.id,
    bytes: rendered.bytes,
    durationMs: rendered.durationMs,
    peak: rendered.peak,
    clipped: rendered.clipped,
    silentTracks: [...rendered.silentTracks],
    panIgnored: rendered.panIgnored,
    ...(headroomApplied === undefined ? {} : { headroomApplied }),
  };
}

// ── the graph on the wire ───────────────────────────────────────────────────

/** Narrowing guard, not a cast: after this the fields read as `unknown` and every one of them is still
 *  checked below. */
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

const asNumber = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

const asText = (v: unknown, max: number): string | null => (typeof v === "string" ? v.slice(0, max) : null);

function decodeClip(raw: unknown, track: number, at: number): { ok: true; clip: MixClip } | { ok: false; error: string } {
  const broken = { ok: false, error: `clip ${at} on track ${track} in that mix is not a well-formed clip` } as const;
  if (!isObject(raw)) return broken;
  const id = asText(raw.id, 120);
  const sourceId = asText(raw.sourceId, 120);
  const startMs = asNumber(raw.startMs);
  const durationMs = asNumber(raw.durationMs);
  const srcStartMs = asNumber(raw.srcStartMs);
  const gain = asNumber(raw.gain);
  const fadeInMs = asNumber(raw.fadeInMs);
  const fadeOutMs = asNumber(raw.fadeOutMs);
  if (!id || !sourceId) return broken;
  if (startMs === null || durationMs === null || srcStartMs === null || gain === null) return broken;
  if (fadeInMs === null || fadeOutMs === null) return broken;
  return { ok: true, clip: { id, sourceId, startMs, durationMs, srcStartMs, gain, fadeInMs, fadeOutMs } };
}

function decodeTrack(raw: unknown, at: number): { ok: true; track: MixTrack } | { ok: false; error: string } {
  const broken = { ok: false, error: `track ${at} in that mix is not a well-formed track` } as const;
  if (!isObject(raw)) return broken;
  const id = asText(raw.id, 120);
  const label = asText(raw.label, 200);
  const gain = asNumber(raw.gain);
  const pan = asNumber(raw.pan);
  const muted = raw.muted;
  const solo = raw.solo;
  if (!id || label === null || gain === null || pan === null) return broken;
  if (typeof muted !== "boolean" || typeof solo !== "boolean") return broken;
  const rawClips = raw.clips;
  const rawEnvelope = raw.envelope;
  if (!Array.isArray(rawClips) || !Array.isArray(rawEnvelope)) return broken;
  if (rawClips.length > MAX_MIX_CLIPS_PER_TRACK) {
    return { ok: false, error: `track ${at} in that mix carries ${rawClips.length} clips, over the ${MAX_MIX_CLIPS_PER_TRACK} limit` };
  }
  if (rawEnvelope.length > MAX_WIRE_ENVELOPE) {
    return { ok: false, error: `track ${at} in that mix carries ${rawEnvelope.length} envelope points, over the ${MAX_WIRE_ENVELOPE} limit` };
  }

  const clips: MixClip[] = [];
  for (let i = 0; i < rawClips.length; i++) {
    const r = decodeClip(rawClips[i], at, i);
    if (!r.ok) return { ok: false, error: r.error };
    clips.push(r.clip);
  }
  // Decoded verbatim, never quietly sorted or clamped: this gate checks SHAPE, and `validateMix` judges
  // MEANING (an unsorted or negative envelope is refused there, by name, before anything renders).
  const envelope: EnvelopePoint[] = [];
  for (let i = 0; i < rawEnvelope.length; i++) {
    const p = rawEnvelope[i];
    const atMs = isObject(p) ? asNumber(p.atMs) : null;
    const pointGain = isObject(p) ? asNumber(p.gain) : null;
    if (atMs === null || pointGain === null) {
      return { ok: false, error: `envelope point ${i} on track ${at} in that mix is not a well-formed point` };
    }
    envelope.push({ atMs, gain: pointGain });
  }

  const busId = asText(raw.busId, 120);
  return { ok: true, track: { id, label, clips, gain, pan, muted, solo, envelope, ...(busId ? { busId } : {}) } };
}

function decodeBus(raw: unknown, at: number): { ok: true; bus: MixBus } | { ok: false; error: string } {
  const broken = { ok: false, error: `bus ${at} in that mix is not a well-formed bus` } as const;
  if (!isObject(raw)) return broken;
  const id = asText(raw.id, 120);
  const label = asText(raw.label, 200);
  const gain = asNumber(raw.gain);
  const muted = raw.muted;
  if (!id || label === null || gain === null || typeof muted !== "boolean") return broken;
  return { ok: true, bus: { id, label, gain, muted } };
}

/** Gate an untrusted mix graph off the wire. Fail-closed, like `decodeTimelineDoc`: one malformed clip,
 *  track, or bus refuses the BODY rather than handing a half-built graph to the renderer, because a mix
 *  missing a layer nobody refused is a file that lies about what the user asked for. */
export function decodeMixGraph(raw: unknown): { ok: true; graph: MixGraph } | { ok: false; error: string } {
  if (!isObject(raw)) return { ok: false, error: "that request carried no mix" };
  const sampleRate = asNumber(raw.sampleRate);
  const channels = asNumber(raw.channels);
  const bitsPerSample = asNumber(raw.bitsPerSample);
  if (sampleRate === null || channels === null || bitsPerSample === null) {
    return { ok: false, error: "that mix does not declare its audio format" };
  }
  // No default of 1: a master gain the body never stated would render at a level the user never set.
  const masterGain = asNumber(raw.masterGain);
  if (masterGain === null) return { ok: false, error: "that mix does not declare a master gain" };

  const rawTracks = raw.tracks;
  const rawBuses = raw.buses;
  if (!Array.isArray(rawTracks) || !Array.isArray(rawBuses)) return { ok: false, error: "that mix has no tracks or no buses" };
  if (rawTracks.length > MAX_MIX_TRACKS) return { ok: false, error: `that mix carries ${rawTracks.length} tracks, over the ${MAX_MIX_TRACKS} limit` };
  if (rawBuses.length > MAX_MIX_TRACKS) return { ok: false, error: `that mix carries ${rawBuses.length} buses, over the ${MAX_MIX_TRACKS} limit` };

  const tracks: MixTrack[] = [];
  for (let i = 0; i < rawTracks.length; i++) {
    const r = decodeTrack(rawTracks[i], i);
    if (!r.ok) return { ok: false, error: r.error };
    tracks.push(r.track);
  }
  const buses: MixBus[] = [];
  for (let i = 0; i < rawBuses.length; i++) {
    const r = decodeBus(rawBuses[i], i);
    if (!r.ok) return { ok: false, error: r.error };
    buses.push(r.bus);
  }
  return { ok: true, graph: { sampleRate, channels, bitsPerSample, tracks, buses, masterGain } };
}
