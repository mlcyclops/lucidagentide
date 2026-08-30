// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_creator5.ts - CREATOR-5 (ADR-0289): the runnable proof of the mixer.
//
// CREATOR-2 proved one take can be edited. This proves N takes can play AT ONCE and land in one file
// without the mixer quietly improving them. Every source is synthesised in-process at 8000Hz mono 16-bit,
// where 1ms is exactly 8 frames and 16 bytes, so every number printed below is arithmetic anyone can
// re-derive rather than a golden blob nobody can check.
//
//   1. two layered takes become ONE file: at every frame of the overlap the output is the EXACT integer
//      sum of the two sources, and the file's length is the furthest clip end, not the first track's
//   2. the ADR-0289 keystone, both halves: (a) the same graph renders byte-identical audio twice, and
//      (b) a track silenced by mute, by another track's solo, or by a muted bus contributes EXACTLY
//      nothing, proven by rendering the graph WITHOUT that track and comparing byte for byte, with the
//      reason the render reported printed verbatim
//   3. levels MULTIPLY through the whole chain: clip x track x bus x master, to a predicted sample value
//   4. a fade and a two-point envelope shape the audio, checked at their midpoints against the arithmetic
//   5. pan is a position: hard left lands only on the left, and equal power keeps the total power at 1
//   6. honesty about clipping: a deliberately hot mix REPORTS its true peak above full scale and a
//      non-zero clipped count, and clamps rather than wrapping; then headroomGain applied EXPLICITLY by
//      the caller brings the re-render to full scale with zero clipping. The mixer never did that itself
//   7. fail-closed: a missing source refuses BY NAME, and a rate mismatch refuses naming BOTH rates and
//      admitting this build has no resampler
//   8. CREATOR-2 interop: an EDITED timeline document lifts onto a mix track, renders byte-identical to
//      what the timeline itself renders, and layers under a bed at the predicted value
//   9. the desktop seam end to end, over an in-memory library: the mix format is DISCOVERED from the
//      shelf (with an undecodable file reported as null rather than 0 and an mp3 not offered at all), and
//      saving APPENDS a remix whose parent is the primary track, whose prompt NAMES every input, whose
//      bytes are what the pure core rendered, and whose inputs keep every one of their own bytes
//  10. and the answer for a library holding NOTHING decodable: no format is CLAIMED at all, which the
//      pane's own shape gate accepts as honest rather than malformed, while HALF a format is refused
//  11. the render route's ANSWER, key for key: every measurement is a PRESENT key (clipped 0 included,
//      because a conditional key there reads to the pane as no report at all), headroomApplied appears
//      only when it was asked for AND there was something to recover, a refusal carries its reason and NO
//      measurement it never made, and the pane's own report gate accepts a report (a silent mix included)
//      while refusing a refusal. A reported peak survives its own 6dp re-rounding, while the headroom
//      factor is the RAW reciprocal, so it is asserted by identity with headroomGain and never a literal
//
// The theme: a mixer's only real promise is that what you hear is what you asked for. Nothing here is
// automatic, nothing is normalized behind your back, and a silenced track is silent to the byte.

import { buildWav, parseWav, type WavFormat } from "../brief/tts_backend.ts";
import {
  SILENCE_SOURCE, deleteSpan, deriveAlignment, docDurationMs, docFromSource, durationOfWav, renderTimeline,
  type SourceAudio, type TimelineDoc,
} from "../creator/timeline.ts";
import {
  emptyMix, headroomGain, mixDurationMs, mixSourceIds, mixTrack, panGains, renderMix, trackFromTimeline,
  validateMix, type MixClip, type MixGraph, type MixRenderOk, type MixTrack,
} from "../creator/mix.ts";
import {
  mixProvenance, mixerStageDir, mixerTracks, renderAndSaveMix,
  type MixerTrackView, type MixerTracksResult, type RenderMixResult,
} from "../../desktop/creator_mixer.ts";
import {
  isMixerTracksPayload, isRenderMixReport, mixFormatLabel, trackAddability,
} from "../../desktop/renderer/creator_mixer.ts";
import type { EditorIo } from "../../desktop/creator_editor.ts";
import {
  addTrack, foldLibrary, libraryAudioDir, libraryLedger,
  type CreatorTrack, type LibraryResult,
} from "../../desktop/creator_library.ts";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`   ${ok ? "ok" : "FAIL"} - ${label}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures++;
};

/** 8000Hz mono 16-bit: a real rate at which 1ms is exactly 8 frames and 16 bytes, so a fade midpoint and
 *  an envelope midpoint both land ON a frame and every predicted sample below is an integer. */
const FMT: WavFormat = { channels: 1, sampleRate: 8000, bitsPerSample: 16 };
const FRAMES_PER_MS = FMT.sampleRate / 1000;
const MS_BYTES = FRAMES_PER_MS * (FMT.bitsPerSample >> 3) * FMT.channels;
const HEADER = 44;

/** Stop the proof. A refusal in a step everything after it stands on is not a soft check: every later
 *  measurement would be reading the wrong render, so the demo exits instead of reporting nonsense. */
function stop(label: string, why: string): never {
  console.log(`   FAIL - ${label} (${why})`);
  console.log("\n1 CHECK(S) FAILED");
  process.exit(1);
}

/** Build a mono source from a per-frame function. One builder for the narration, the bed, the steady level
 *  and the deliberately hot take, so the only thing that differs between them is the arithmetic. */
function monoWav(ms: number, sample: (frame: number) => number): Uint8Array {
  const frames = ms * FRAMES_PER_MS;
  const data = new Uint8Array(frames * 2);
  for (let f = 0; f < frames; f++) {
    const v = Math.max(-32768, Math.min(32767, Math.round(sample(f))));
    const u = v < 0 ? v + 0x10000 : v;
    data[f * 2] = u & 0xff;
    data[f * 2 + 1] = (u >> 8) & 0xff;
  }
  return buildWav(FMT, data);
}

interface Segment { readonly loud: boolean; readonly ms: number }

/** Per-frame voicing from a segment pattern, so a narration-shaped take is speech bursts separated by real
 *  silence and the derived alignment in phase 8 has something to measure. */
function voicing(pattern: readonly Segment[]): boolean[] {
  const out: boolean[] = [];
  for (const p of pattern) for (let i = 0; i < p.ms * FRAMES_PER_MS; i++) out.push(p.loud);
  return out;
}

const tone = (frame: number, hz: number, amp: number): number =>
  amp * Math.sin((2 * Math.PI * hz * frame) / FMT.sampleRate);

const sourceOf = (wav: Uint8Array): SourceAudio => {
  const { fmt, data } = parseWav(wav);
  return { fmt, data };
};

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

/** Read frame `f`, channel `c` out of a WAV's PCM as a signed 16-bit sample. */
const pcmAt = (pcm: Uint8Array, f: number, channels = 1, c = 0): number => {
  const o = (f * channels + c) * 2;
  const raw = pcm[o]! | (pcm[o + 1]! << 8);
  return (raw & 0x8000) ? raw - 0x10000 : raw;
};

const clip = (over: Partial<MixClip> & { id: string; sourceId: string; durationMs: number }): MixClip =>
  ({ startMs: 0, srcStartMs: 0, gain: 1, fadeInMs: 0, fadeOutMs: 0, ...over });

const mustTrack = (label: string, r: LibraryResult): CreatorTrack =>
  (r.ok && r.track ? r.track : stop(label, r.error ?? "the library returned no track"));

/** An in-memory library: the REAL `addTrack`/`foldLibrary`/`mixerTracks`/`renderAndSaveMix` run against two
 *  Maps instead of a disk, so phase 9 proves the product's own save path rather than a re-implementation of
 *  it. `EditorIo` is `LibraryIo` plus the one byte writer a render needs, because a render only ever exists
 *  in memory and the library imports from a path. */
function fakeEditorIo(): EditorIo & { fileBytes(path: string): Uint8Array | undefined; paths(): string[] } {
  const files = new Map<string, Uint8Array>();
  const text = new Map<string, string>();
  let seq = 0;
  let clock = 1_700_000_000_000;
  return {
    fileBytes: (p) => files.get(p),
    paths: () => [...files.keys()],
    ensureDir: () => {},
    readText: (p) => text.get(p) ?? "",
    appendLine: (p, line) => { text.set(p, (text.get(p) ?? "") + line + "\n"); },
    copyIn: (src, dest) => {
      const b = files.get(src);
      if (!b) throw new Error(`no file at ${src}`);
      files.set(dest, b);
      return b.length;
    },
    readBase64: (p) => {
      const b = files.get(p);
      if (!b) throw new Error(`no file at ${p}`);
      return Buffer.from(b).toString("base64");
    },
    removeFile: (p) => { files.delete(p); text.delete(p); },
    exists: (p) => files.has(p) || text.has(p),
    now: () => (clock += 1000),
    id: () => `trk${++seq}`,
    writeBytes: (p, bytes) => { files.set(p, bytes); },
  };
}

function mustRender(label: string, graph: MixGraph, srcs: ReadonlyMap<string, SourceAudio>): MixRenderOk {
  const problems = validateMix(graph);
  if (problems.length > 0) stop(label, `the graph is not renderable: ${problems[0]}`);
  const r = renderMix(graph, srcs);
  return r.ok ? r : stop(label, r.error);
}

const refusal = (label: string, graph: MixGraph, srcs: ReadonlyMap<string, SourceAudio>): string => {
  const r = renderMix(graph, srcs);
  return r.ok ? stop(label, "the render SUCCEEDED where it should have refused") : r.error;
};

/** How many frames in [from, to) disagree with the arithmetic, and the first one that did. Every layering
 *  claim below is the same claim, checked at EVERY frame rather than at one flattering sample. */
function mismatch(pcm: Uint8Array, from: number, to: number, want: (frame: number) => number): { count: number; first: number; got: number; expected: number } {
  let count = 0;
  let first = -1;
  let got = 0;
  let expected = 0;
  for (let f = from; f < to; f++) {
    const e = want(f);
    const v = pcmAt(pcm, f);
    if (v === e) continue;
    count++;
    if (first < 0) { first = f; got = v; expected = e; }
  }
  return { count, first, got, expected };
}

// ── the takes ───────────────────────────────────────────────────────────────

/** 900ms of narration shape: four bursts with real silence between them, on 20ms boundaries so the energy
 *  measurement in phase 8 sees four runs rather than a smear. */
const NARRATION_PATTERN: readonly Segment[] = [
  { loud: false, ms: 40 }, { loud: true, ms: 160 },
  { loud: false, ms: 100 }, { loud: true, ms: 160 },
  { loud: false, ms: 100 }, { loud: true, ms: 160 },
  { loud: false, ms: 100 }, { loud: true, ms: 80 },
];
const TAKE_MS = NARRATION_PATTERN.reduce((n, p) => n + p.ms, 0);
const voiced = voicing(NARRATION_PATTERN);

const narrationWav = monoWav(TAKE_MS, (f) => (voiced[f]! ? tone(f, 220, 9000) : 0));
const bedWav = monoWav(TAKE_MS, (f) => tone(f, 110, 3000));
const stabWav = monoWav(TAKE_MS, (f) => tone(f, 440, 1500));
/** A constant 8000 for 200ms: a flat source makes a gain chain, a fade and an envelope exact integers. */
const LEVEL = 8000;
const LEVEL_MS = 200;
const levelWav = monoWav(LEVEL_MS, () => LEVEL);
/** Deliberately ASYMMETRIC and deliberately hot: +20000 over one half period, -30000 over the other, so
 *  two layers of it overshoot BOTH rails and each rail can be checked for a clamp rather than a wrap. */
const HOT_MS = 96;
const HOT_HALF_FRAMES = 32;
const hotWav = monoWav(HOT_MS, (f) => (Math.floor(f / HOT_HALF_FRAMES) % 2 === 0 ? 20000 : -30000));

const narration = sourceOf(narrationWav);
const bed = sourceOf(bedWav);
const stab = sourceOf(stabWav);
const level = sourceOf(levelWav);
const hot = sourceOf(hotWav);

const SOURCES: ReadonlyMap<string, SourceAudio> = new Map<string, SourceAudio>([
  ["narration", narration], ["bed", bed], ["stab", stab], ["level", level], ["hot", hot],
]);

// ── 1. two layered takes become one file ────────────────────────────────────

console.log("1) two layered takes become ONE file: the output IS the arithmetic sum, at every frame");
check("both takes parse back as the format they claim",
  narration.fmt.sampleRate === 8000 && narration.fmt.channels === 1 && narration.fmt.bitsPerSample === 16
  && bed.fmt.sampleRate === 8000 && bed.fmt.channels === 1,
  `${narration.fmt.sampleRate}Hz / ${narration.fmt.channels}ch / ${narration.fmt.bitsPerSample}-bit PCM`);
check("byte arithmetic is exact at this rate, so every offset below is checkable",
  narrationWav.length === HEADER + TAKE_MS * MS_BYTES && bedWav.length === narrationWav.length,
  `${HEADER}-byte header + ${TAKE_MS}ms x ${MS_BYTES} = ${narrationWav.length} bytes each`);

const NARR_CLIP_MS = 600;
const layered: MixGraph = {
  ...emptyMix(FMT.sampleRate, 1),
  tracks: [
    mixTrack({ id: "narration", label: "Narration", clips: [clip({ id: "n1", sourceId: "narration", durationMs: NARR_CLIP_MS })] }),
    mixTrack({ id: "bed", label: "Music bed", clips: [clip({ id: "b1", sourceId: "bed", durationMs: TAKE_MS })] }),
  ],
};
check("the graph is structurally valid", validateMix(layered).length === 0, validateMix(layered).join("; "));
check("it names exactly the two sources the render will ask for, and no more",
  mixSourceIds(layered).join(",") === "narration,bed", mixSourceIds(layered).join(", "));

const mix1 = mustRender("render the two layers", layered, SOURCES);
const pcm1 = parseWav(mix1.wav).data;
check("the file's length is the FURTHEST clip end, not the first track's",
  mix1.durationMs === TAKE_MS && mixDurationMs(layered) === TAKE_MS,
  `narration clip ends at ${NARR_CLIP_MS}ms, bed at ${TAKE_MS}ms, the file is ${mix1.durationMs}ms`);
check("and its byte count follows that duration exactly",
  mix1.bytes === HEADER + TAKE_MS * MS_BYTES && pcm1.length === TAKE_MS * MS_BYTES,
  `${mix1.bytes} = ${HEADER} + ${TAKE_MS} x ${MS_BYTES}`);

const overlapTo = NARR_CLIP_MS * FRAMES_PER_MS;
const bothSum = mismatch(pcm1, 0, overlapTo, (f) => pcmAt(narration.data, f) + pcmAt(bed.data, f));
const example = overlapTo >> 1;
check(`at EVERY one of the ${overlapTo} overlapping frames the sample is exactly narration + bed`,
  bothSum.count === 0,
  bothSum.count === 0
    ? `frame ${example}: ${pcmAt(narration.data, example)} + ${pcmAt(bed.data, example)} = ${pcmAt(pcm1, example)}`
    : `${bothSum.count} frames differ, first at ${bothSum.first}: got ${bothSum.got}, expected ${bothSum.expected}`);
const bedOnly = mismatch(pcm1, overlapTo, TAKE_MS * FRAMES_PER_MS, (f) => pcmAt(bed.data, f));
check(`past the narration clip the bed plays ALONE, unchanged, for the remaining ${TAKE_MS - NARR_CLIP_MS}ms`,
  bedOnly.count === 0,
  bedOnly.count === 0 ? `frames ${overlapTo} to ${TAKE_MS * FRAMES_PER_MS} are the bed's own samples`
    : `${bedOnly.count} frames differ, first at ${bedOnly.first}: got ${bedOnly.got}, expected ${bedOnly.expected}`);
check("layering did not clip: the true peak is reported and nothing hit the rail",
  mix1.clipped === 0 && mix1.peak > 0 && mix1.peak < 1, `peak ${mix1.peak} of full scale, ${mix1.clipped} clipped`);

// ── 2. the keystone, both halves ────────────────────────────────────────────

console.log("2) the ADR-0289 keystone: the same graph twice, and a silenced track adds NOTHING");
const narrFull = mixTrack({ id: "narration", label: "Narration", clips: [clip({ id: "n1", sourceId: "narration", durationMs: TAKE_MS })] });
const bedFull = mixTrack({ id: "bed", label: "Music bed", clips: [clip({ id: "b1", sourceId: "bed", durationMs: TAKE_MS })] });
const stabClips: readonly MixClip[] = [clip({ id: "s1", sourceId: "stab", durationMs: TAKE_MS })];
/** Every clip spans the whole take, so REMOVING a track cannot change the mix's duration and the byte
 *  comparison is about the samples rather than about the length. */
const three: MixGraph = { ...emptyMix(FMT.sampleRate, 1), tracks: [narrFull, bedFull, mixTrack({ id: "stab", label: "Stab", clips: stabClips })] };
const two: MixGraph = { ...emptyMix(FMT.sampleRate, 1), tracks: [narrFull, bedFull] };

const twiceA = mustRender("render the three-track graph", three, SOURCES);
const twiceB = mustRender("render the three-track graph again", three, SOURCES);
check("(a) the same graph renders BYTE-IDENTICAL audio twice, header included",
  sameBytes(twiceA.wav, twiceB.wav) && twiceA.peak === twiceB.peak,
  `${twiceA.bytes} bytes and peak ${twiceA.peak} both times`);

const without = mustRender("render the same graph without the third track", two, SOURCES);
check("the third track is genuinely AUDIBLE, so 'identical' below is not a vacuous claim",
  !sameBytes(twiceA.wav, without.wav) && twiceA.bytes === without.bytes,
  `both ${twiceA.bytes} bytes, and the samples differ while it plays`);

const silenced: readonly { readonly label: string; readonly graph: MixGraph; readonly reason: string }[] = [
  {
    label: "MUTED",
    reason: "muted",
    graph: { ...three, tracks: [narrFull, bedFull, mixTrack({ id: "stab", label: "Stab", clips: stabClips, muted: true })] },
  },
  {
    label: "silenced by another track's SOLO",
    reason: "another track is soloed",
    graph: {
      ...three,
      tracks: [{ ...narrFull, solo: true }, { ...bedFull, solo: true }, mixTrack({ id: "stab", label: "Stab", clips: stabClips })],
    },
  },
  {
    label: "on a MUTED BUS",
    reason: "bus Beds is muted",
    graph: {
      ...three,
      buses: [{ id: "beds", label: "Beds", gain: 1, muted: true }],
      tracks: [narrFull, bedFull, mixTrack({ id: "stab", label: "Stab", clips: stabClips, busId: "beds" })],
    },
  },
];
for (const c of silenced) {
  const r = mustRender(`render with the third track ${c.label}`, c.graph, SOURCES);
  const reported = r.silentTracks.find((s) => s.id === "stab");
  console.log(`   the render's own reason for the stab track, verbatim: "${reported?.reason ?? "none, it was audible"}"`);
  check(`(b) a track ${c.label} contributes EXACTLY nothing: byte-identical to the graph WITHOUT it`,
    sameBytes(r.wav, without.wav), `${r.bytes} bytes, identical to the ${without.bytes}-byte two-track render`);
  check("and the render NAMES why, so a quiet mix is explained rather than shrugged at",
    reported?.reason === c.reason, `reported "${reported?.reason ?? ""}", expected "${c.reason}"`);
}
check("muting is not trimming: the muted track's clip still sets the mix's length",
  mixDurationMs(silenced[0]!.graph) === TAKE_MS, `${mixDurationMs(silenced[0]!.graph)}ms either way`);

// ── 3. levels multiply through the whole chain ──────────────────────────────

console.log("3) levels MULTIPLY through the whole chain: clip x track x bus x master");
const CLIP_G = 0.5;
const TRACK_G = 0.25;
const BUS_G = 0.5;
const MASTER_G = 0.5;
const EXPECT_CHAIN = LEVEL * CLIP_G * TRACK_G * BUS_G * MASTER_G;
const chain: MixGraph = {
  ...emptyMix(FMT.sampleRate, 1),
  masterGain: MASTER_G,
  buses: [{ id: "sub", label: "Sub", gain: BUS_G, muted: false }],
  tracks: [mixTrack({
    id: "t", label: "Level", gain: TRACK_G, busId: "sub",
    clips: [clip({ id: "c", sourceId: "level", durationMs: LEVEL_MS, gain: CLIP_G })],
  })],
};
const chained = mustRender("render the gain chain", chain, SOURCES);
const chainPcm = parseWav(chained.wav).data;
const chainOff = mismatch(chainPcm, 0, LEVEL_MS * FRAMES_PER_MS, () => EXPECT_CHAIN);
check(`a flat ${LEVEL} through ${CLIP_G} clip x ${TRACK_G} track x ${BUS_G} bus x ${MASTER_G} master is ${EXPECT_CHAIN} at EVERY frame`,
  chainOff.count === 0,
  chainOff.count === 0
    ? `${LEVEL} x ${CLIP_G} x ${TRACK_G} x ${BUS_G} x ${MASTER_G} = ${pcmAt(chainPcm, 0)}, held for all ${LEVEL_MS * FRAMES_PER_MS} frames`
    : `${chainOff.count} frames differ, first at ${chainOff.first}: got ${chainOff.got}, expected ${chainOff.expected}`);
check("and the four stages are four separate multiplies, not one lumped level",
  EXPECT_CHAIN === 250 && pcmAt(chainPcm, 0) === 250, `${pcmAt(chainPcm, 0)} out of a full-scale ${LEVEL}`);

// ── 4. a fade and an envelope shape the audio ──────────────────────────────

console.log("4) a fade and a two-point envelope SHAPE the audio, and the shape is arithmetic");
const FADE_IN = 80;
const FADE_OUT = 40;
const faded: MixGraph = {
  ...emptyMix(FMT.sampleRate, 1),
  tracks: [mixTrack({
    id: "t", label: "Faded",
    clips: [clip({ id: "c", sourceId: "level", durationMs: LEVEL_MS, fadeInMs: FADE_IN, fadeOutMs: FADE_OUT })],
  })],
};
const fadePcm = parseWav(mustRender("render the fades", faded, SOURCES).wav).data;
const fadeInMid = (FADE_IN / 2) * FRAMES_PER_MS;
const fadeOutMid = (LEVEL_MS - FADE_OUT / 2) * FRAMES_PER_MS;
check(`the fade in starts at zero and reaches HALF at its midpoint, ${FADE_IN / 2}ms in`,
  pcmAt(fadePcm, 0) === 0 && pcmAt(fadePcm, fadeInMid) === LEVEL / 2,
  `frame 0 is ${pcmAt(fadePcm, 0)}, frame ${fadeInMid} is ${pcmAt(fadePcm, fadeInMid)} of ${LEVEL}`);
check(`between the fades the sample is untouched at full ${LEVEL}`,
  pcmAt(fadePcm, 100 * FRAMES_PER_MS) === LEVEL, `frame ${100 * FRAMES_PER_MS} is ${pcmAt(fadePcm, 100 * FRAMES_PER_MS)}`);
check(`the fade out is HALF at its midpoint, ${FADE_OUT / 2}ms from the clip's end`,
  pcmAt(fadePcm, fadeOutMid) === LEVEL / 2,
  `frame ${fadeOutMid} is ${pcmAt(fadePcm, fadeOutMid)}, and ${LEVEL} x (${FADE_OUT / 2} / ${FADE_OUT}) = ${LEVEL / 2}`);

const enveloped: MixGraph = {
  ...emptyMix(FMT.sampleRate, 1),
  tracks: [mixTrack({
    id: "t", label: "Automated",
    envelope: [{ atMs: 0, gain: 0 }, { atMs: LEVEL_MS, gain: 1 }],
    clips: [clip({ id: "c", sourceId: "level", durationMs: LEVEL_MS })],
  })],
};
const envPcm = parseWav(mustRender("render the envelope", enveloped, SOURCES).wav).data;
const envMid = (LEVEL_MS / 2) * FRAMES_PER_MS;
check(`a 0 to 1 envelope over ${LEVEL_MS}ms is HALF at its midpoint and a quarter at a quarter through`,
  pcmAt(envPcm, envMid) === LEVEL / 2 && pcmAt(envPcm, envMid >> 1) === LEVEL / 4,
  `${LEVEL / 2} at ${LEVEL_MS / 2}ms, ${LEVEL / 4} at ${LEVEL_MS / 4}ms, measured ${pcmAt(envPcm, envMid)} and ${pcmAt(envPcm, envMid >> 1)}`);
check("it starts at the first point's gain rather than jumping in at unity",
  pcmAt(envPcm, 0) === 0, `frame 0 is ${pcmAt(envPcm, 0)}`);

const AT_MS = 40;
const BOTH_G = (AT_MS / FADE_IN) * (AT_MS / LEVEL_MS);
const both: MixGraph = {
  ...emptyMix(FMT.sampleRate, 1),
  tracks: [mixTrack({
    id: "t", label: "Faded and automated",
    envelope: [{ atMs: 0, gain: 0 }, { atMs: LEVEL_MS, gain: 1 }],
    clips: [clip({ id: "c", sourceId: "level", durationMs: LEVEL_MS, fadeInMs: FADE_IN })],
  })],
};
const bothPcm = parseWav(mustRender("render fade and envelope together", both, SOURCES).wav).data;
check(`the two stages MULTIPLY: at ${AT_MS}ms the fade is ${AT_MS / FADE_IN} and the envelope ${AT_MS / LEVEL_MS}`,
  pcmAt(bothPcm, AT_MS * FRAMES_PER_MS) === LEVEL * BOTH_G,
  `${LEVEL} x ${AT_MS / FADE_IN} x ${AT_MS / LEVEL_MS} = ${LEVEL * BOTH_G}, measured ${pcmAt(bothPcm, AT_MS * FRAMES_PER_MS)}`);

// ── 5. pan ─────────────────────────────────────────────────────────────────

console.log("5) pan is a POSITION, and equal power means the middle is not louder than the edges");
const panned: MixGraph = {
  ...emptyMix(FMT.sampleRate, 2),
  tracks: [
    mixTrack({ id: "left", label: "Hard left", pan: -1, clips: [clip({ id: "l1", sourceId: "level", durationMs: LEVEL_MS })] }),
  ],
};
const panR = mustRender("render a hard-left track in a stereo mix", panned, SOURCES);
const panPcm = parseWav(panR.wav).data;
check("a stereo mix is twice the bytes of the mono one, frame for frame",
  panR.bytes === HEADER + LEVEL_MS * FRAMES_PER_MS * 2 * 2,
  `${panR.bytes} = ${HEADER} + ${LEVEL_MS * FRAMES_PER_MS} frames x 2ch x 2 bytes`);
check("hard left puts the signal ONLY on the left: the right channel is exactly zero",
  pcmAt(panPcm, 0, 2, 0) === LEVEL && pcmAt(panPcm, 0, 2, 1) === 0,
  `left ${pcmAt(panPcm, 0, 2, 0)}, right ${pcmAt(panPcm, 0, 2, 1)}`);
check("and a stereo render never reports an ignored pan, because it honored it",
  panR.panIgnored === false);

const CENTRE = Math.round(LEVEL * Math.SQRT1_2);
const centred: MixGraph = {
  ...emptyMix(FMT.sampleRate, 2),
  tracks: [mixTrack({ id: "mid", label: "Centre", pan: 0, clips: [clip({ id: "m1", sourceId: "level", durationMs: LEVEL_MS })] })],
};
const centrePcm = parseWav(mustRender("render a centred track", centred, SOURCES).wav).data;
check("equal-power centre sits at 1/sqrt(2) per side, not at unity per side",
  pcmAt(centrePcm, 0, 2, 0) === CENTRE && pcmAt(centrePcm, 0, 2, 1) === CENTRE,
  `${LEVEL} x ${Math.SQRT1_2.toFixed(6)} = ${CENTRE} on both channels`);
const positions = [-1, -0.5, 0, 0.5, 1];
const powers = positions.map((p) => {
  const g = panGains(p, 2);
  return g[0]! ** 2 + g[1]! ** 2;
});
check("the SUM OF SQUARED pan gains is 1 at every position, so sweeping a track does not change its power",
  powers.every((v) => Math.abs(v - 1) < 1e-12),
  positions.map((p, i) => `pan ${p}: ${powers[i]!.toFixed(12)}`).join(", "));
const monoPan = mustRender("render the same panned track as mono", { ...panned, channels: 1 }, SOURCES);
check("a MONO render says it had to ignore the pan instead of silently dropping it",
  monoPan.panIgnored === true, `panIgnored ${monoPan.panIgnored}`);

// ── 6. honesty about clipping ─────────────────────────────────────────────

console.log("6) a hot mix is REPORTED, never fixed: the true peak, the clipped count, and a clamp");
const HOT_SUM_POS = 20000 * 2;
const HOT_SUM_NEG = -30000 * 2;
const HOT_FRAMES = HOT_MS * FRAMES_PER_MS;
const EXPECT_PEAK = Number((-HOT_SUM_NEG / 32768).toFixed(6));
const hotGraph: MixGraph = {
  ...emptyMix(FMT.sampleRate, 1),
  tracks: [
    mixTrack({ id: "a", label: "Take A", clips: [clip({ id: "a1", sourceId: "hot", durationMs: HOT_MS })] }),
    mixTrack({ id: "b", label: "Take B", clips: [clip({ id: "b1", sourceId: "hot", durationMs: HOT_MS })] }),
  ],
};
const hotR = mustRender("render the deliberately hot mix", hotGraph, SOURCES);
const hotPcm = parseWav(hotR.wav).data;
check(`the TRUE peak is reported ABOVE full scale, measured before the rail: ${-HOT_SUM_NEG} of 32768`,
  hotR.peak === EXPECT_PEAK && hotR.peak > 1, `peak ${hotR.peak} (${-HOT_SUM_NEG} / 32768)`);
check(`and EVERY one of the ${HOT_FRAMES} samples that hit a rail is counted`,
  hotR.clipped === HOT_FRAMES, `${hotR.clipped} clipped samples reported`);
check(`the positive overshoot of ${HOT_SUM_POS} is CLAMPED to 32767, not wrapped to a negative`,
  pcmAt(hotPcm, 0) === 32767, `frame 0 is ${pcmAt(hotPcm, 0)}`);
check(`the negative overshoot of ${HOT_SUM_NEG} is CLAMPED to -32768, not wrapped to a positive`,
  pcmAt(hotPcm, HOT_HALF_FRAMES) === -32768, `frame ${HOT_HALF_FRAMES} is ${pcmAt(hotPcm, HOT_HALF_FRAMES)}`);
console.log("   the mixer applied NOTHING of its own here: it summed what it was given, told the truth about");
console.log("   the peak and the count, and left every clipped sample exactly where the arithmetic put it.");

const G = headroomGain(hotR.peak);
const fixed = mustRender("re-render with headroom the CALLER asked for", { ...hotGraph, masterGain: G }, SOURCES);
const fixedPcm = parseWav(fixed.wav).data;
check(`headroomGain(${hotR.peak}) = ${G} is a number handed BACK to the caller, applied only because this line asked`,
  G === 1 / hotR.peak && G < 1, `master gain set to ${G} by this script, not by the mixer`);
check("the re-render lands at or just under full scale with ZERO clipped samples",
  fixed.clipped === 0 && fixed.peak <= 1, `peak ${fixed.peak} of full scale, ${fixed.clipped} clipped`);
const railSample = pcmAt(fixedPcm, HOT_HALF_FRAMES);
check("the loudest sample now sits AT the rail rather than past it, and the quieter one scaled with it",
  railSample === Math.round(HOT_SUM_NEG * G) && railSample <= -32767 && pcmAt(fixedPcm, 0) === Math.round(HOT_SUM_POS * G),
  `${HOT_SUM_NEG} x ${G} = ${railSample}, ${HOT_SUM_POS} x ${G} = ${pcmAt(fixedPcm, 0)}`);
check("and the hot render's own bytes were never touched: the two renders are different files",
  !sameBytes(hotR.wav, fixed.wav) && hotR.clipped === HOT_FRAMES,
  "the honest one is still on record with its clipped count");

// ── 7. fail-closed ────────────────────────────────────────────────────────

console.log("7) fail-closed: a missing source and a rate mismatch are REFUSED, by name");
const missing = new Map<string, SourceAudio>([["narration", narration]]);
const missingErr = refusal("render without the bed", layered, missing);
console.log(`   the refusal, verbatim: ${missingErr}`);
check("a missing source refuses the whole render rather than substituting silence",
  missingErr.includes('needs source "bed"'), missingErr);
check("and it names the CLIP and the TRACK, so the user knows where to look",
  missingErr.includes("clip b1") && missingErr.includes("track bed"));

const wrongRate: WavFormat = { channels: 1, sampleRate: 48000, bitsPerSample: 16 };
const mismatched = new Map<string, SourceAudio>([
  ["narration", narration],
  ["bed", sourceOf(buildWav(wrongRate, new Uint8Array(TAKE_MS * 96)))],
]);
const rateErr = refusal("render a 48kHz bed into an 8kHz mix", layered, mismatched);
console.log(`   the refusal, verbatim: ${rateErr}`);
check("a sample-rate mismatch names BOTH rates rather than guessing which one wins",
  rateErr.includes("is 48000Hz") && rateErr.includes("the mix is 8000Hz"), rateErr);
check("and ADMITS there is no resampler in this build instead of pretending to have one",
  rateErr.includes("no resampler"));

// ── 8. CREATOR-2 interop ──────────────────────────────────────────────────

console.log("8) CREATOR-2 interop: an EDITED timeline lifts onto a mix track and layers under the bed");
const TEXT = "Layer the takes together";
const align = deriveAlignment(TEXT, narration.data, FMT);
const whole = docFromSource({ sourceId: "narration", fmt: FMT, durationMs: TAKE_MS, items: align.items });
check("the take's own energy gave every word a home, in reading order",
  whole.items.map((it) => it.text).join(" ") === TEXT, `${whole.items.length} words over ${docDurationMs(whole)}ms`);
const cut = deleteSpan(whole, [whole.items[1]!.id]);
const edited: TimelineDoc = cut.ok ? cut.doc : stop("delete a word in the timeline", cut.error);
const EDIT_MS = docDurationMs(edited);
check(`deleting "${whole.items[1]!.text}" shortened the timeline and left it in more than one clip`,
  EDIT_MS < TAKE_MS && edited.clips.length > 1,
  `${TAKE_MS}ms in ${whole.clips.length} clip(s) became ${EDIT_MS}ms in ${edited.clips.length} clips`);

const lifted: MixTrack = trackFromTimeline(edited, { id: "vox", label: "Vox" });
check("every timeline clip became a mix clip at the SAME position with the SAME source region",
  lifted.clips.length === edited.clips.length
  && lifted.clips.every((c, i) => {
    const t = edited.clips[i]!;
    return c.sourceId === t.sourceId && c.startMs === t.startMs && c.durationMs === t.endMs - t.startMs
      && c.srcStartMs === t.srcStartMs && c.gain === t.gain;
  }),
  lifted.clips.map((c) => `${c.startMs}-${c.startMs + c.durationMs}ms from ${c.srcStartMs}ms`).join(", "));

const voxAlone: MixGraph = { ...emptyMix(FMT.sampleRate, 1), tracks: [lifted] };
const voxR = mustRender("render the lifted track on its own", voxAlone, SOURCES);
const timelineR = renderTimeline(edited, SOURCES);
const timelineWav = timelineR.ok ? timelineR.wav : stop("render the timeline itself", timelineR.error);
check("at unity the lifted track renders BYTE-IDENTICALLY to what the timeline itself renders",
  sameBytes(voxR.wav, timelineWav), `${voxR.bytes} bytes both ways`);
const voxPcm = parseWav(voxR.wav).data;

const BED_G = 0.25;
const underBed: MixGraph = {
  ...emptyMix(FMT.sampleRate, 1),
  tracks: [
    lifted,
    mixTrack({ id: "bed", label: "Music bed", gain: BED_G, clips: [clip({ id: "b1", sourceId: "bed", durationMs: EDIT_MS })] }),
  ],
};
const underR = mustRender("render the edit layered under the bed", underBed, SOURCES);
const underPcm = parseWav(underR.wav).data;
const layeredOff = mismatch(underPcm, 0, EDIT_MS * FRAMES_PER_MS,
  (f) => Math.round(pcmAt(voxPcm, f) + pcmAt(bed.data, f) * BED_G));
const pick = (EDIT_MS * FRAMES_PER_MS) >> 1;
check(`at EVERY frame the mix is the edited vox plus the bed at ${BED_G}, to the predicted integer`,
  layeredOff.count === 0,
  layeredOff.count === 0
    ? `frame ${pick}: ${pcmAt(voxPcm, pick)} + ${pcmAt(bed.data, pick)} x ${BED_G} = ${pcmAt(underPcm, pick)}`
    : `${layeredOff.count} frames differ, first at ${layeredOff.first}: got ${layeredOff.got}, expected ${layeredOff.expected}`);
check("and the layered file is exactly the EDITED length, so the mixer inherited the edit's duration",
  underR.durationMs === EDIT_MS && underR.bytes === HEADER + EDIT_MS * MS_BYTES,
  `${underR.durationMs}ms, ${underR.bytes} bytes`);

// ── 9. the desktop seam ───────────────────────────────────────────────────

console.log("9) the desktop seam: layer LIBRARY tracks and save the mix as a NEW record beside them");
const io = fakeEditorIo();
const BASE = "/creator";
io.writeBytes("/imports/narration.wav", narrationWav);
io.writeBytes("/imports/bed.wav", bedWav);
io.writeBytes("/imports/stab.wav", stabWav);
io.writeBytes("/imports/hot.wav", hotWav);
io.writeBytes("/imports/session.wav", buildWav({ channels: 2, sampleRate: 48000, bitsPerSample: 16 }, new Uint8Array(9600)));
io.writeBytes("/imports/broken.wav", new Uint8Array([0x00, 0x01, 0x02, 0x03]));
io.writeBytes("/imports/voice.mp3", new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00]));

const narrTrack = mustTrack("import the narration", addTrack(io, BASE, { sourcePath: "/imports/narration.wav", title: "Narration", origin: "elevenlabs", lyrics: TEXT }));
const bedTrack = mustTrack("import the bed", addTrack(io, BASE, { sourcePath: "/imports/bed.wav", title: "Music bed", origin: "suno" }));
const stabTrack = mustTrack("import the stab", addTrack(io, BASE, { sourcePath: "/imports/stab.wav", title: "Stab", origin: "local" }));
const hotTrack = mustTrack("import the hot take", addTrack(io, BASE, { sourcePath: "/imports/hot.wav", title: "Hot take", origin: "local" }));
const sessionTrack = mustTrack("import a 48kHz stereo session", addTrack(io, BASE, { sourcePath: "/imports/session.wav", title: "48k session", origin: "local" }));
const brokenTrack = mustTrack("import a .wav that is not a WAV", addTrack(io, BASE, { sourcePath: "/imports/broken.wav", title: "Truncated", origin: "local" }));
const mp3Track = mustTrack("import an mp3", addTrack(io, BASE, { sourcePath: "/imports/voice.mp3", title: "Voice memo", origin: "local" }));

const offered = mixerTracks(io, BASE);
const views = offered.tracks ?? stop("ask the library which tracks can mix", offered.error ?? "no tracks came back");
const viewOf = (id: string): MixerTrackView | undefined => views.find((v) => v.id === id);
check("the mix format is DISCOVERED as the majority format in the library, never imposed",
  offered.ok && offered.sampleRate === FMT.sampleRate && offered.channels === 1,
  `${offered.sampleRate}Hz / ${offered.channels}ch, carried by ${views.filter((v) => v.sampleRate === FMT.sampleRate).length} of the ${views.length} WAVs on the shelf`);
check("every 8kHz layer is offered with the duration LUCID measured out of its own bytes",
  [narrTrack, bedTrack, stabTrack].every((t) => viewOf(t.id)?.sampleRate === FMT.sampleRate && viewOf(t.id)?.channels === 1 && viewOf(t.id)?.durationMs === TAKE_MS)
  && viewOf(hotTrack.id)?.durationMs === HOT_MS,
  [narrTrack, bedTrack, stabTrack, hotTrack].map((t) => `${t.title} ${viewOf(t.id)?.durationMs}ms`).join(", "));
check("the 48kHz stereo session is LISTED with its real format, so the UI can say WHY it cannot join",
  viewOf(sessionTrack.id)?.sampleRate === 48000 && viewOf(sessionTrack.id)?.channels === 2,
  `${viewOf(sessionTrack.id)?.sampleRate}Hz / ${viewOf(sessionTrack.id)?.channels}ch, listed rather than quietly hidden`);
const brokenView = viewOf(brokenTrack.id);
check("a .wav this build cannot decode reports NULL for every measurement: unknown, never 0",
  !!brokenView && brokenView.durationMs === null && brokenView.sampleRate === null && brokenView.channels === null,
  `durationMs ${String(brokenView?.durationMs)}, sampleRate ${String(brokenView?.sampleRate)}, channels ${String(brokenView?.channels)}`);
check("and the mp3 is not offered at all, because there is no transcoder to pretend with",
  viewOf(mp3Track.id) === undefined && views.length === 6, `${views.length} WAVs listed, the mp3 among none of them`);

const seamGraph: MixGraph = {
  ...emptyMix(FMT.sampleRate, 1),
  tracks: [
    mixTrack({ id: "vox", label: "Narration", clips: [
      clip({ id: "v1", sourceId: narrTrack.id, durationMs: NARR_CLIP_MS }),
      clip({ id: "v2", sourceId: SILENCE_SOURCE, startMs: NARR_CLIP_MS, durationMs: TAKE_MS - NARR_CLIP_MS }),
    ] }),
    mixTrack({ id: "bed", label: "Music bed", gain: 0.25, clips: [clip({ id: "b1", sourceId: bedTrack.id, durationMs: TAKE_MS })] }),
    mixTrack({ id: "stab", label: "Stab", muted: true, clips: [clip({ id: "s1", sourceId: stabTrack.id, durationMs: TAKE_MS })] }),
  ],
};
const savedR = renderAndSaveMix(io, BASE, {
  graph: seamGraph, title: "Narration over a bed", prompt: "keep the bed under the voice", primaryTrackId: narrTrack.id,
});
check("the mix renders and saves", savedR.ok, savedR.error ?? "");
if (!savedR.ok) stop("save the mix", savedR.error ?? "the save refused without naming a reason");

const shelf = foldLibrary(io.readText(libraryLedger(BASE)));
const mixRecord = shelf.find((t) => t.id === savedR.trackId);
check("it is a NEW library record, appended beside the inputs it was mixed from",
  shelf.length === 8 && !!mixRecord && mixRecord.id !== narrTrack.id, `${shelf.length} tracks on the shelf`);
check("recorded as a REMIX whose parent is the primary track the user was working from",
  mixRecord?.kind === "remix" && mixRecord.parentId === narrTrack.id, `kind ${mixRecord?.kind}, parent ${mixRecord?.parentId}`);

const note = mixProvenance(seamGraph);
const savedPrompt = mixRecord?.prompt ?? "";
console.log(`   the provenance line the record carries, verbatim: ${note}`);
const inputIds = mixSourceIds(seamGraph);
check(`the saved prompt NAMES all ${inputIds.length} inputs, because the ledger's single parent slot cannot`,
  inputIds.length === 3 && inputIds.every((id) => savedPrompt.includes(id)), inputIds.join(", "));
check("the MUTED layer is named too: it was in the graph the user saved, so it is in the record",
  savedPrompt.includes(stabTrack.id), `${stabTrack.title} is ${stabTrack.id}`);
check("and the list is not padded with silence, which is not a library track",
  !savedPrompt.includes(SILENCE_SOURCE), SILENCE_SOURCE);
check("the caller's own prose sits AFTER the provenance rather than in place of it",
  savedPrompt.startsWith(note) && savedPrompt.includes("keep the bed under the voice"));

const inputs: readonly { readonly track: CreatorTrack; readonly wav: Uint8Array }[] = [
  { track: narrTrack, wav: narrationWav }, { track: bedTrack, wav: bedWav }, { track: stabTrack, wav: stabWav },
];
check("every INPUT keeps its own bytes: a mix in LUCID is an append, never an overwrite",
  inputs.every((i) => {
    const b = io.fileBytes(`${libraryAudioDir(BASE)}/${i.track.file}`);
    return !!b && sameBytes(b, i.wav);
  }),
  inputs.map((i) => `${i.track.title} still ${i.wav.length} bytes`).join(", "));

const savedBytes = io.fileBytes(`${libraryAudioDir(BASE)}/${mixRecord?.file ?? ""}`) ?? new Uint8Array(0);
const savedWav = savedBytes.length > 0 ? durationOfWav(savedBytes) : null;
check("the saved bytes re-parse as a valid WAV in the mix's own format",
  savedWav !== null && savedWav.fmt.sampleRate === FMT.sampleRate && savedWav.fmt.channels === 1 && savedWav.fmt.bitsPerSample === 16,
  savedWav ? `${savedBytes.length} bytes, ${savedWav.durationMs}ms` : "nothing was written");
check("of exactly the size and duration the result REPORTED, measured off the file rather than assumed",
  savedWav !== null && savedR.bytes === savedBytes.length && savedR.durationMs === savedWav.durationMs,
  `${savedR.bytes} bytes and ${savedR.durationMs}ms reported, ${savedBytes.length} bytes and ${savedWav?.durationMs}ms on disk`);
const libSources: ReadonlyMap<string, SourceAudio> = new Map<string, SourceAudio>([
  [narrTrack.id, narration], [bedTrack.id, bed], [stabTrack.id, stab],
]);
const pure = mustRender("render the same graph in-process", seamGraph, libSources);
check("and they are EXACTLY what the pure core renders for the same graph: the seam adds no processing",
  sameBytes(savedBytes, pure.wav), `byte-identical to the ${pure.bytes}-byte in-process render`);

const silent = savedR.silentTracks ?? [];
check("the muted layer comes back through the seam with the core's OWN reason, not a re-wording",
  silent.length === 1 && silent[0]?.id === "stab" && silent[0]?.reason === "muted",
  silent.map((s) => `${s.id}: ${s.reason}`).join(", "));
check("and NO headroom was applied, because this save never asked for any",
  savedR.headroomApplied === undefined && savedR.clipped === 0 && (savedR.peak ?? 0) > 0,
  `peak ${savedR.peak}, ${savedR.clipped} clipped, headroomApplied ${String(savedR.headroomApplied)}`);

const seamHot: MixGraph = {
  ...emptyMix(FMT.sampleRate, 1),
  tracks: [
    mixTrack({ id: "a", label: "Take A", clips: [clip({ id: "a1", sourceId: hotTrack.id, durationMs: HOT_MS })] }),
    mixTrack({ id: "b", label: "Take B", clips: [clip({ id: "b1", sourceId: hotTrack.id, durationMs: HOT_MS })] }),
  ],
};
const hotSave = renderAndSaveMix(io, BASE, { graph: seamHot, title: "Hot layers", primaryTrackId: hotTrack.id });
check("a hot mix saves UNFIXED, with its true peak and every clipped sample counted",
  hotSave.ok && (hotSave.peak ?? 0) > 1 && hotSave.clipped === HOT_FRAMES && hotSave.headroomApplied === undefined,
  `peak ${hotSave.peak}, ${hotSave.clipped} clipped, headroomApplied ${String(hotSave.headroomApplied)}`);
/** The peak measured WITHOUT the flag, which is the only peak the factor can come from. The `peak` inside
 *  the recovered result is the peak AFTER recovery (at full scale by construction), so deriving the factor
 *  from THAT would be circular and would compare 0.55 against 1. This is why the plain render runs first
 *  and its peak is the one named here and in phase 11. Do not collapse these two renders into one. */
const PRE_PEAK = hotSave.peak ?? 0;
const fixedSave = renderAndSaveMix(io, BASE, {
  graph: seamHot, title: "Hot layers (with headroom)", primaryTrackId: hotTrack.id, applyHeadroom: true,
});
check("and the SAME graph, asked for headroom, reports the EXACT gain it applied with the clipping gone",
  fixedSave.ok && fixedSave.headroomApplied === headroomGain(PRE_PEAK) && fixedSave.clipped === 0 && (fixedSave.peak ?? 0) <= 1,
  `headroomGain(${PRE_PEAK}) = ${headroomGain(PRE_PEAK)} applied, peak now ${fixedSave.peak}, ${fixedSave.clipped} clipped`);
check("and the factor is NOT headroomGain of the peak in its OWN result: that peak is already recovered",
  headroomGain(PRE_PEAK) < 1 && fixedSave.headroomApplied !== headroomGain(fixedSave.peak ?? 0),
  `applied ${fixedSave.headroomApplied} from the pre-headroom ${PRE_PEAK}, where headroomGain(${fixedSave.peak}) would be ${headroomGain(fixedSave.peak ?? 0)}`);

const orphan: MixGraph = {
  ...emptyMix(FMT.sampleRate, 1),
  tracks: [mixTrack({ id: "vox", label: "Narration", clips: [clip({ id: "v1", sourceId: "trk-gone", durationMs: 100 })] })],
};
const refusedSave = renderAndSaveMix(io, BASE, { graph: orphan, title: "broken", primaryTrackId: narrTrack.id });
check("a mix naming a track that is not in the library is REFUSED by id, never rendered as silence",
  !refusedSave.ok && (refusedSave.error ?? "").includes("trk-gone"), refusedSave.error ?? "");
const crossRate: MixGraph = {
  ...emptyMix(FMT.sampleRate, 1),
  tracks: [mixTrack({ id: "vox", label: "Session", clips: [clip({ id: "v1", sourceId: sessionTrack.id, durationMs: 50 })] })],
};
const refusedRate = renderAndSaveMix(io, BASE, { graph: crossRate, title: "48k layer", primaryTrackId: narrTrack.id });
check("and a 48kHz layer in an 8kHz mix is refused naming BOTH rates, never resampled",
  !refusedRate.ok && (refusedRate.error ?? "").includes("is 48000Hz") && (refusedRate.error ?? "").includes("the mix is 8000Hz"),
  refusedRate.error ?? "");
const finalShelf = foldLibrary(io.readText(libraryLedger(BASE)));
check("neither refusal appended anything, and staging left nothing behind that looks like a track",
  finalShelf.length === 10 && io.paths().every((p) => !p.startsWith(mixerStageDir(BASE))),
  `${finalShelf.length} tracks on the shelf: 7 imports and 3 saved mixes`);

// ── 10. a library with nothing decodable in it ─────────────────────────────

console.log("10) nothing decodable on the shelf: NO format is claimed, and that is a VALID answer");
const bare = fakeEditorIo();
const empty = mixerTracks(bare, BASE);
check("an EMPTY library answers ok with an empty list and claims no format at all",
  empty.ok && empty.tracks?.length === 0 && empty.sampleRate === undefined && empty.channels === undefined,
  `ok ${empty.ok}, ${empty.tracks?.length ?? "no"} tracks, sampleRate ${String(empty.sampleRate)}, channels ${String(empty.channels)}`);

bare.writeBytes("/imports/junk1.wav", new Uint8Array([0x00, 0x01, 0x02, 0x03]));
bare.writeBytes("/imports/junk2.wav", new Uint8Array([0x52, 0x49, 0x46, 0x46]));
const junkTrack = mustTrack("import an undecodable .wav", addTrack(bare, BASE, { sourcePath: "/imports/junk1.wav", title: "Junk one", origin: "local" }));
mustTrack("import a second undecodable .wav", addTrack(bare, BASE, { sourcePath: "/imports/junk2.wav", title: "Junk two", origin: "local" }));
const undecodable = mixerTracks(bare, BASE);
const junkViews = undecodable.tracks ?? [];
check("a library holding ONLY files this build cannot decode still LISTS them, every measurement null",
  junkViews.length === 2 && junkViews.every((v) => v.durationMs === null && v.sampleRate === null && v.channels === null),
  junkViews.map((v) => `${v.title}: ${String(v.sampleRate)}Hz / ${String(v.channels)}ch / ${String(v.durationMs)}ms`).join(", "));
check("and it claims NO format rather than inventing a plausible default to open a mixer onto",
  undecodable.ok && undecodable.sampleRate === undefined && undecodable.channels === undefined,
  `sampleRate ${String(undecodable.sampleRate)}, channels ${String(undecodable.channels)}`);

/** The `data` payload the tracks route nests its answer under, JSON round-tripped, because JSON drops an
 *  undefined field: this is what the pane's gate actually reads, not the object the seam handed back. */
const wireBody = (r: MixerTracksResult): unknown =>
  JSON.parse(JSON.stringify({ tracks: r.tracks, sampleRate: r.sampleRate, channels: r.channels }));
check("the body the route sends for a formatless library PASSES the pane's shape gate: an honest 'no format' is not a malformed answer",
  isMixerTracksPayload(wireBody(undecodable)) && isMixerTracksPayload(wireBody(empty)),
  "tracks present, format absent, accepted");
check("and the body for a library WITH a format passes the same gate",
  isMixerTracksPayload(wireBody(offered)), `${offered.sampleRate}Hz / ${offered.channels}ch`);
check("HALF a format is still REFUSED: a rate without channels, or channels without a rate, is not a format",
  !isMixerTracksPayload({ tracks: junkViews, sampleRate: FMT.sampleRate })
  && !isMixerTracksPayload({ tracks: junkViews, channels: 1 }));
check("and a nonsense rate is refused rather than becoming the graph a level gets built on",
  !isMixerTracksPayload({ tracks: junkViews, sampleRate: 0, channels: 1 }));

const noFormat = { sampleRate: null, channels: null };
console.log(`   what the pane says with no format, verbatim: ${mixFormatLabel(noFormat)}`);
check("with no format the pane says it is NOT claiming one, and prints no rate it could not have measured",
  !mixFormatLabel(noFormat).includes("Hz"), mixFormatLabel(noFormat));
const goodRow = viewOf(narrTrack.id);
const mixReason = goodRow ? trackAddability(goodRow, noFormat) : null;
check("a perfectly measured 8kHz row is unaddable for the MIX's missing format, not for anything about the track",
  mixReason?.addable === false && mixReason.reason.includes("the format this mix runs at"),
  mixReason?.reason ?? "there was no measured row to test");
check("and the same row IS addable the moment a format is reported, so that refusal was about the mix",
  !!goodRow && trackAddability(goodRow, { sampleRate: FMT.sampleRate, channels: 1 }).addable === true);
const junkRow = junkViews.find((v) => v.id === junkTrack.id);
const junkReason = junkRow ? trackAddability(junkRow, { sampleRate: FMT.sampleRate, channels: 1 }) : null;
check("an UNMEASURED row is refused in its OWN words instead: unknown is not a match, and it is not zero",
  junkReason?.addable === false && junkReason.reason.includes("never measured")
  && junkReason.reason !== mixReason?.reason,
  junkReason?.reason ?? "there was no unmeasured row to test");
console.log("   what phase 10 proves is the BODY and the pane's gate; mounting that body into the DOM is the");
console.log("   pane's own test, which has no place in a headless proof.");

// ── 11. the answer on the wire ─────────────────────────────────────────────

console.log("11) the render route's ANSWER, key for key: the same both-or-neither discipline, one layer down");
/** The answer as it REACHES the pane. The render route answers with `renderAndSaveMix`'s own return value
 *  rather than a copy of it, so this round-trip IS the emitted body: JSON drops every undefined field, so
 *  a key set to undefined and a key that was never there are the same thing by the time the gate reads it. */
const wireAnswer = (r: RenderMixResult): Record<string, unknown> => JSON.parse(JSON.stringify(r));
const keysOf = (body: Record<string, unknown>): string[] => Object.keys(body).sort();
/** Every measurement a successful render owes the pane, alphabetically. `headroomApplied` is deliberately
 *  NOT here: it is the ONE conditional key, present only when headroom was asked for and there was a peak
 *  to recover, which is why every case below states whether it expects it. */
const KEYS_CLEAN = ["bytes", "clipped", "durationMs", "ok", "panIgnored", "peak", "silentTracks", "trackId"];

const cleanBody = wireAnswer(savedR);
console.log(`   the clean render's answer, key for key: ${keysOf(cleanBody).join(", ")}`);
check("a CLEAN render answers with EVERY measurement as a present key, and nothing it did not measure",
  keysOf(cleanBody).join(",") === KEYS_CLEAN.join(","), keysOf(cleanBody).join(", "));
check("clipped is PRESENT and 0, not omitted: a conditional key here reads to the pane as no report at all",
  "clipped" in cleanBody && cleanBody.clipped === 0, `clipped ${String(cleanBody.clipped)}`);
check("so the pane's OWN report gate accepts it, and a clean render never prints that it cannot be read",
  isRenderMixReport(cleanBody));
check("no error key rides along on a success: an absent refusal is ABSENT, not an empty string",
  !("error" in cleanBody));
check("and headroomApplied is absent, because this render was never asked to apply any",
  !("headroomApplied" in cleanBody));

const hotBody = wireAnswer(hotSave);
check("the HOT render's answer carries its true peak above full scale and its clipped count, still with no headroom key",
  isRenderMixReport(hotBody) && typeof hotBody.peak === "number" && hotBody.peak > 1
  && hotBody.clipped === HOT_FRAMES && !("headroomApplied" in hotBody),
  `peak ${String(hotBody.peak)}, clipped ${String(hotBody.clipped)}`);
const fixedBody = wireAnswer(fixedSave);
check("the HEADROOM render's answer carries the exact factor as one extra key, and only then",
  keysOf(fixedBody).join(",") === [...KEYS_CLEAN, "headroomApplied"].sort().join(",")
  && fixedBody.headroomApplied === headroomGain(PRE_PEAK) && fixedBody.clipped === 0,
  `headroomApplied ${String(fixedBody.headroomApplied)} from the pre-headroom peak ${PRE_PEAK}, clipped ${String(fixedBody.clipped)}`);
// The two numbers are rounded DIFFERENTLY, on purpose: `peak` is 6dp because the core rounds it, while
// `headroomApplied` is the RAW reciprocal passed straight through. So a 6dp decimal literal is safe for a
// peak and WRONG for the factor, which is why every factor check here is computed as headroomGain(PRE_PEAK).
// That exact identity with the unrounded computation is also what would catch a future "round the factor
// before reporting it": if such a change moved the value the identity fails, and if it did not move the
// value there was nothing to catch. Only the PEAK half is asserted below. Whether a reciprocal runs past 6
// places is a property of THESE amplitudes and not of the mixer (a pre-peak of 1.25 gives exactly 0.8), so
// the factor's delta is printed as evidence rather than asserted, where it could go red with nothing wrong.
const factor = headroomGain(PRE_PEAK);
check("a reported peak survives its own 6dp rounding, which is what makes a 6dp literal safe for a PEAK",
  PRE_PEAK === Number(PRE_PEAK.toFixed(6)), `${PRE_PEAK} re-rounds to ${Number(PRE_PEAK.toFixed(6))}`);
console.log(`   the factor, by contrast, is the raw reciprocal ${factor}: on THIS fixture a 6dp literal would`);
console.log(`   miss it by ${Math.abs(factor - Number(factor.toFixed(6))).toExponential(1)}, and on a fixture whose reciprocal terminates it would be exact. That is why`);
console.log("   the factor is asserted by identity with headroomGain and never against a written-out number.");

const refusedBody = wireAnswer(refusedRate);
console.log(`   a refusal's answer, key for key: ${keysOf(refusedBody).join(", ")}`);
check("a REFUSAL answers with ok false and its reason, carrying NO measurement it never made",
  keysOf(refusedBody).join(",") === "error,ok" && refusedBody.ok === false, keysOf(refusedBody).join(", "));
check("and the pane's report gate REFUSES it, so a refusal can never be painted as a report",
  !isRenderMixReport(refusedBody), "ok false is not a report");

// headroomApplied is absent unless it was ASKED for AND there was something to recover. A silent mix has
// no peak to scale, and 1 is not a measurement, so the answer reports no factor rather than a flattering
// one. This is the last place the both-or-neither rule could have been fudged into a default.
const silentGraph: MixGraph = {
  ...emptyMix(FMT.sampleRate, 1),
  tracks: [mixTrack({
    id: "quiet", label: "Quiet", gain: 0,
    clips: [clip({ id: "q1", sourceId: narrTrack.id, durationMs: TAKE_MS })],
  })],
};
const silentSave = renderAndSaveMix(io, BASE, {
  graph: silentGraph, title: "Silence", primaryTrackId: narrTrack.id, applyHeadroom: true,
});
const silentBody = wireAnswer(silentSave);
check("headroom ASKED for on a silent mix reports NO factor: there is nothing to recover, and 1 is not a measurement",
  keysOf(silentBody).join(",") === KEYS_CLEAN.join(",") && silentBody.peak === 0 && silentBody.clipped === 0,
  `peak ${String(silentBody.peak)}, clipped ${String(silentBody.clipped)}, headroomApplied ${String(silentBody.headroomApplied)}`);
check("and a peak of 0 is still a REPORT the pane can read, with the zeroed track's reason named",
  isRenderMixReport(silentBody)
  && (silentSave.silentTracks ?? []).some((s) => s.id === "quiet" && s.reason === "track level is at zero"),
  (silentSave.silentTracks ?? []).map((s) => `${s.id}: ${s.reason}`).join(", "));
console.log("   the route answers with renderAndSaveMix's own return value, so the key sets above are the");
console.log("   emitted body rather than a projection of it: a measurement dropped anywhere fails this phase.");

console.log(failures === 0
  ? "\ndemo_creator5 OK - two takes layered into one file sum to the EXACT arithmetic sum at every frame and the file is as long as the furthest clip, the same graph renders byte-identical audio twice, and a track silenced by mute, by another track's solo, or by a muted bus contributes exactly nothing: the render is byte-identical to the same graph with that track REMOVED, and it names the reason. Clip, track, bus and master levels multiply to a predicted sample, a fade and an envelope are half their level at their midpoints, hard left is silent on the right while equal-power pan holds total power at 1, and a hot mix reports its true peak above full scale with every clipped sample counted and clamped rather than wrapped, fixed only when this script explicitly applies the headroomGain it was handed. A missing source and a rate mismatch are refused by name, and an edited CREATOR-2 timeline lifts onto a mix track that renders byte for byte what the timeline renders. Through the desktop seam the mix format is discovered from the library rather than imposed, an undecodable file measures as null instead of 0, and a saved mix is a NEW remix whose prompt names every input, whose bytes are exactly what the pure core rendered, and whose inputs keep every byte they came in with. A library holding nothing this build can decode claims NO format at all, which the pane's own shape gate accepts as the honest answer while refusing half a format, and every row is then unaddable for the MIX's missing format rather than for anything about the track. The render route's answer is pinned key for key: every measurement is a present key with clipped 0 included, the exact headroom factor appears only when it was asked for, and a refusal carries its reason and nothing it never measured, which the pane's own report gate accepts and refuses respectively."
  : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
