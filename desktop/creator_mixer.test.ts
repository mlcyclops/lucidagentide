// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, test } from "bun:test";
import { buildWav, parseWav, type WavFormat } from "../harness/brief/tts_backend.ts";
import {
  MAX_MIX_CLIPS_PER_TRACK, MAX_MIX_TRACKS, emptyMix, headroomGain, mixTrack, type MixClip, type MixGraph,
} from "../harness/creator/mix.ts";
import { addTrack, foldLibrary, libraryAudioDir, libraryLedger, type CreatorTrack, type TrackOrigin } from "./creator_library.ts";
import type { EditorIo } from "./creator_editor.ts";
import {
  MAX_MIX_PROBES, MAX_WIRE_ENVELOPE, decodeMixGraph, mixProvenance, mixerStageDir, mixerTracks,
  renderAndSaveMix,
} from "./creator_mixer.ts";

const BASE = "/data";
const MONO_8K: WavFormat = { channels: 1, sampleRate: 8000, bitsPerSample: 16 };
const STEREO_8K: WavFormat = { channels: 2, sampleRate: 8000, bitsPerSample: 16 };
const STEREO_44K: WavFormat = { channels: 2, sampleRate: 44100, bitsPerSample: 16 };

/** An in-memory disk. Everything is BYTES (the mixer decodes audio, so a string store would not do); text
 *  files are the same map read back as UTF-8. Copied from the CREATOR-2 editor's fake on purpose: both
 *  seams stage a render through `writeBytes` and import it through the library's own `addTrack`. */
function fakeIo(): EditorIo & { files: Map<string, Uint8Array>; ledger(): string } {
  let seq = 0;
  let clock = 1_700_000_000_000;
  const files = new Map<string, Uint8Array>();
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  const text = (p: string): string => dec.decode(files.get(p) ?? new Uint8Array());
  return {
    files,
    ledger: () => text(libraryLedger(BASE)),
    ensureDir: () => {},
    readText: text,
    appendLine: (p, line) => { files.set(p, enc.encode(text(p) + line + "\n")); },
    copyIn: (src, dest) => { const b = files.get(src); if (!b) throw new Error("missing"); files.set(dest, b); return b.length; },
    readBase64: (p) => { const b = files.get(p); if (!b) throw new Error("missing"); return Buffer.from(b).toString("base64"); },
    writeBytes: (p, b) => { files.set(p, b); },
    removeFile: (p) => { files.delete(p); },
    exists: (p) => files.has(p),
    now: () => (clock += 1000),
    id: () => `trk${++seq}`,
  };
}

/** `ms` of a CONSTANT sample value. Flat rather than a tone so a sum of layers has an arithmetically exact
 *  peak: the headroom assertions below are then checked against numbers, not against the code under test. */
function flatWav(ms: number, value: number, fmt: WavFormat): Uint8Array {
  const frames = Math.round((ms / 1000) * fmt.sampleRate);
  const pcm = new Uint8Array(frames * fmt.channels * 2);
  const u = value < 0 ? value + 0x10000 : value;
  for (let i = 0; i < frames * fmt.channels; i++) {
    pcm[i * 2] = u & 0xff;
    pcm[i * 2 + 1] = (u >> 8) & 0xff;
  }
  return buildWav(fmt, pcm);
}

const audioPath = (t: CreatorTrack): string => `${libraryAudioDir(BASE)}/${t.file}`;

interface SeedInput { name: string; bytes: Uint8Array; title?: string; origin?: TrackOrigin }

function seed(io: EditorIo & { files: Map<string, Uint8Array> }, input: SeedInput): CreatorTrack {
  const src = `/in/${input.name}`;
  io.files.set(src, input.bytes);
  const r = addTrack(io, BASE, { sourcePath: src, title: input.title, origin: input.origin });
  if (!r.track) throw new Error(r.error ?? "seed failed");
  return r.track;
}

const clipOf = (id: string, sourceId: string, startMs: number, durationMs: number): MixClip =>
  ({ id, sourceId, startMs, durationMs, srcStartMs: 0, gain: 1, fadeInMs: 0, fadeOutMs: 0 });

/** A narration over a bed at half level: the smallest graph that is genuinely a MIX and not an edit. */
function twoLayers(voxId: string, bedId: string, fmt: WavFormat = MONO_8K): MixGraph {
  return {
    ...emptyMix(fmt.sampleRate, fmt.channels),
    tracks: [
      mixTrack({ id: "t1", label: "Narration", clips: [clipOf("c1", voxId, 0, 1000)] }),
      mixTrack({ id: "t2", label: "Bed", clips: [clipOf("c2", bedId, 0, 1000)], gain: 0.5 }),
    ],
  };
}

/** A library holding a 1000ms narration and a 1000ms bed, both mono 8kHz, plus the graph over them. */
function twoLayerLibrary() {
  const io = fakeIo();
  const vox = seed(io, { name: "vox.wav", bytes: flatWav(1000, -12000, MONO_8K), title: "Vox", origin: "elevenlabs" });
  const bed = seed(io, { name: "bed.wav", bytes: flatWav(1000, -8000, MONO_8K), title: "Bed" });
  return { io, vox, bed, graph: twoLayers(vox.id, bed.id) };
}

/** Two 1000ms mono layers each sitting at -20480, so the sum is exactly -40960: a mix that clips at an
 *  arithmetically exact 1.25 of full scale. Exact because every headroom number below is then checkable by
 *  hand rather than against whatever the code happens to produce. */
function hotLibrary() {
  const io = fakeIo();
  const a = seed(io, { name: "a.wav", bytes: flatWav(1000, -20480, MONO_8K), title: "A" });
  const b = seed(io, { name: "b.wav", bytes: flatWav(1000, -20480, MONO_8K), title: "B" });
  const graph: MixGraph = {
    ...emptyMix(8000, 1),
    tracks: [
      mixTrack({ id: "t1", label: "A", clips: [clipOf("c1", a.id, 0, 1000)] }),
      mixTrack({ id: "t2", label: "B", clips: [clipOf("c2", b.id, 0, 1000)] }),
    ],
  };
  return { io, a, b, graph };
}

describe("the tracks a mix can be built from (CREATOR-5, ADR-0289)", () => {
  test("the majority WAV format wins, and every WAV reports its own real format", () => {
    const io = fakeIo();
    const a = seed(io, { name: "a.wav", bytes: flatWav(500, 1000, MONO_8K), title: "A" });
    const b = seed(io, { name: "b.wav", bytes: flatWav(250, 1000, MONO_8K), title: "B" });
    const wide = seed(io, { name: "wide.wav", bytes: flatWav(500, 1000, STEREO_44K), title: "Wide" });

    const r = mixerTracks(io, BASE);
    expect(r.ok).toBe(true);
    expect(r.sampleRate).toBe(8000); // two of three tracks, so the mix runs at 8kHz mono
    expect(r.channels).toBe(1);
    expect(r.tracks).toHaveLength(3);

    const byId = new Map(r.tracks!.map((t) => [t.id, t] as const));
    expect(byId.get(a.id)).toEqual({ id: a.id, title: "A", mime: "audio/wav", durationMs: 500, sampleRate: 8000, channels: 1 });
    expect(byId.get(b.id)!.durationMs).toBe(250);
    // The odd one out is still LISTED, with its real format, so the UI can say why it is not offered.
    expect(byId.get(wide.id)).toEqual({ id: wide.id, title: "Wide", mime: "audio/wav", durationMs: 500, sampleRate: 44100, channels: 2 });
  });

  test("a tie in the format vote goes to the newest track", () => {
    const io = fakeIo();
    seed(io, { name: "old.wav", bytes: flatWav(500, 1000, MONO_8K), title: "Old" });
    seed(io, { name: "new.wav", bytes: flatWav(500, 1000, STEREO_44K), title: "New" });

    const r = mixerTracks(io, BASE);
    expect(r.sampleRate).toBe(44100);
    expect(r.channels).toBe(2);
    expect(r.tracks!.map((t) => t.title)).toEqual(["New", "Old"]); // newest first, like the ledger fold
  });

  test("an mp3 in the library is never offered as a layer", () => {
    const io = fakeIo();
    const wav = seed(io, { name: "vox.wav", bytes: flatWav(500, 1000, MONO_8K), title: "Vox" });
    seed(io, { name: "song.mp3", bytes: new TextEncoder().encode("ID3 not decodable here"), title: "Song" });

    const r = mixerTracks(io, BASE);
    expect(r.tracks!.map((t) => t.id)).toEqual([wav.id]);
    expect(r.sampleRate).toBe(8000);
  });

  test("an empty library is ok with no tracks, not an error, and claims no format", () => {
    const r = mixerTracks(fakeIo(), BASE);
    expect(r).toEqual({ ok: true, tracks: [] });
    expect(r.error).toBeUndefined();
  });

  test("a WAV this build cannot decode is listed with an unknown format, never a guessed one", () => {
    const io = fakeIo();
    const good = seed(io, { name: "good.wav", bytes: flatWav(500, 1000, MONO_8K), title: "Good" });
    const deep = seed(io, { name: "deep.wav", bytes: buildWav({ channels: 1, sampleRate: 8000, bitsPerSample: 24 }, new Uint8Array(300)), title: "Deep" });
    const junk = seed(io, { name: "junk.wav", bytes: new TextEncoder().encode("not a RIFF file at all"), title: "Junk" });
    // A header that parses but declares 0Hz: no rate is a rate nobody can mix at, and if it voted it would
    // become a "format" on the wire that no consumer could act on.
    const zero = seed(io, { name: "zero.wav", bytes: buildWav({ channels: 1, sampleRate: 0, bitsPerSample: 16 }, new Uint8Array(200)), title: "Zero" });

    const r = mixerTracks(io, BASE);
    const byId = new Map(r.tracks!.map((t) => [t.id, t] as const));
    expect(byId.get(deep.id)).toMatchObject({ durationMs: null, sampleRate: null, channels: null });
    expect(byId.get(junk.id)).toMatchObject({ durationMs: null, sampleRate: null, channels: null });
    expect(byId.get(zero.id)).toMatchObject({ durationMs: null, sampleRate: null, channels: null });
    // Neither of them votes, so the one decodable track decides the format.
    expect(r.sampleRate).toBe(8000);
    expect(r.channels).toBe(1);
    expect(byId.get(good.id)!.sampleRate).toBe(8000);
  });

  test("a track with no frames reports an unknown duration, never 0", () => {
    const io = fakeIo();
    const empty = seed(io, { name: "empty.wav", bytes: buildWav(MONO_8K, new Uint8Array(0)), title: "Empty" });

    const view = mixerTracks(io, BASE).tracks!.find((t) => t.id === empty.id)!;
    expect(view.durationMs).toBeNull();
    expect(view.sampleRate).toBe(8000); // the header is real even though there is nothing in it
  });

  test("a ledger row whose audio file has gone is listed with an unknown format, not a stale one", () => {
    const io = fakeIo();
    const good = seed(io, { name: "good.wav", bytes: flatWav(500, 1000, MONO_8K), title: "Good" });
    const gone = seed(io, { name: "gone.wav", bytes: flatWav(500, 1000, STEREO_44K), title: "Gone" });
    io.files.delete(audioPath(gone));

    const r = mixerTracks(io, BASE);
    const byId = new Map(r.tracks!.map((t) => [t.id, t] as const));
    expect(byId.get(gone.id)).toMatchObject({ durationMs: null, sampleRate: null, channels: null });
    expect(byId.get(good.id)!.sampleRate).toBe(8000);
    expect(r.sampleRate).toBe(8000); // the file that is really there is the only one that votes
  });

  test("the probe is bounded, so a huge library offers its newest tracks and claims nothing else", () => {
    const io = fakeIo();
    let newest = "";
    for (let i = 0; i < MAX_MIX_PROBES + 2; i++) {
      newest = seed(io, { name: `t${i}.wav`, bytes: flatWav(10, 500, MONO_8K), title: `T${i}` }).id;
    }
    const r = mixerTracks(io, BASE);
    expect(r.tracks).toHaveLength(MAX_MIX_PROBES);
    expect(r.tracks![0]!.id).toBe(newest);
  });
});

describe("rendering and saving a mix", () => {
  test("two layers save as a NEW remix whose parent is the primary and whose prompt names every input", () => {
    const { io, vox, bed, graph } = twoLayerLibrary();

    const r = renderAndSaveMix(io, BASE, { graph, title: "Vox over bed", prompt: "warmer bed", primaryTrackId: vox.id });
    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(r.durationMs).toBe(1000);
    expect(r.clipped).toBe(0);
    expect(r.peak).toBeCloseTo(16000 / 32768, 5); // -12000 plus half of -8000
    expect(r.panIgnored).toBe(false);
    expect(r.silentTracks).toEqual([]);
    expect(r.headroomApplied).toBeUndefined(); // never touched unless asked

    const tracks = foldLibrary(io.ledger());
    expect(tracks).toHaveLength(3);
    const saved = tracks.find((t) => t.id === r.trackId)!;
    expect(saved).toMatchObject({ kind: "remix", parentId: vox.id, origin: "elevenlabs", title: "Vox over bed", mime: "audio/wav" });
    // One parent slot, many inputs: the prose names them all, with the role each one played.
    expect(saved.prompt).toBe(`mixed from: ${vox.id} (Narration), ${bed.id} (Bed)\nwarmer bed`);
    expect(saved.lyrics).toBe(""); // a mix has as many word streams as layers; it claims none of them
  });

  test("a clean render's measurements survive the wire, because 0 is a measurement and not an absence", () => {
    const { io, vox, graph } = twoLayerLibrary();

    const r = renderAndSaveMix(io, BASE, { graph, title: "Clean", primaryTrackId: vox.id });
    // The route answers with `json(r)`, so this round trip IS the body the pane parses. JSON.stringify drops
    // undefined but keeps 0, and the renderer's isRenderMixReport requires peak and clipped, so a clean
    // render has to carry both keys or the most common success in the feature arrives as a report the pane
    // refuses to read. That is why the measurements are unconditional properties and only headroomApplied
    // is spread conditionally.
    const wire = JSON.parse(JSON.stringify(r)) as Record<string, unknown>;
    expect(Object.keys(wire)).toContain("peak");
    expect(Object.keys(wire)).toContain("clipped");
    expect(wire.clipped).toBe(0);
    expect(wire.panIgnored).toBe(false);
    expect(wire.silentTracks).toEqual([]);
    // headroomApplied is the opposite case: its ABSENCE is the fact, so it must NOT be sent as 0.
    expect(Object.keys(wire)).not.toContain("headroomApplied");
  });

  test("a success carries exactly the wire's fields, so nothing is added to the report unnoticed", () => {
    const { io, vox, graph } = twoLayerLibrary();
    // POST /api/creator/mixer/render answers with `json(r)`, so this return value IS the body. Pinning the
    // key set means a field added to or removed from the report fails HERE, at the one place that owns it,
    // instead of silently reaching (or not reaching) the pane's isRenderMixReport gate.
    const clean = renderAndSaveMix(io, BASE, { graph, title: "Clean", primaryTrackId: vox.id });
    expect(Object.keys(clean).sort())
      .toEqual(["bytes", "clipped", "durationMs", "ok", "panIgnored", "peak", "silentTracks", "trackId"]);

    const recovered = renderAndSaveMix(io, BASE, { graph, title: "Recovered", primaryTrackId: vox.id, applyHeadroom: true });
    expect(Object.keys(recovered).sort())
      .toEqual(["bytes", "clipped", "durationMs", "headroomApplied", "ok", "panIgnored", "peak", "silentTracks", "trackId"]);
  });

  test("every input keeps its bytes and its row, and nothing is left in staging", () => {
    const { io, vox, bed, graph } = twoLayerLibrary();
    const voxBefore = io.files.get(audioPath(vox))!;
    const bedBefore = io.files.get(audioPath(bed))!;

    const r = renderAndSaveMix(io, BASE, { graph, title: "Mix", primaryTrackId: vox.id });
    expect(r.ok).toBe(true);

    const tracks = foldLibrary(io.ledger());
    expect(io.files.get(audioPath(vox))).toEqual(voxBefore);
    expect(io.files.get(audioPath(bed))).toEqual(bedBefore);
    expect(tracks.find((t) => t.id === vox.id)).toMatchObject({ kind: "original", parentId: null, title: "Vox" });
    expect(tracks.find((t) => t.id === bed.id)).toMatchObject({ kind: "original", parentId: null, title: "Bed" });
    expect([...io.files.keys()].some((p) => p.startsWith(mixerStageDir(BASE)))).toBe(false);
  });

  test("the saved bytes re-parse as a valid WAV of the reported duration and format", () => {
    const { io, vox, graph } = twoLayerLibrary();

    const r = renderAndSaveMix(io, BASE, { graph, title: "Mix", primaryTrackId: vox.id });
    const saved = foldLibrary(io.ledger()).find((t) => t.id === r.trackId)!;
    const parsed = parseWav(io.files.get(audioPath(saved))!);

    expect(parsed.fmt).toEqual(MONO_8K);
    expect(Math.round((parsed.data.length / 2 / 8000) * 1000)).toBe(r.durationMs!);
    expect(saved.bytes).toBe(r.bytes!);
  });

  test("a source used by two tracks is named once, with both roles", () => {
    const { io, vox, graph } = twoLayerLibrary();
    const doubled: MixGraph = {
      ...graph,
      tracks: [
        graph.tracks[0]!,
        mixTrack({ id: "t3", label: "Echo", clips: [clipOf("c3", vox.id, 500, 500)], gain: 0.25 }),
      ],
    };

    expect(mixProvenance(doubled)).toBe(`mixed from: ${vox.id} (Narration, Echo)`);
    const r = renderAndSaveMix(io, BASE, { graph: doubled, title: "Echoed", primaryTrackId: vox.id });
    expect(r.error).toBeUndefined();
    expect(foldLibrary(io.ledger()).find((t) => t.id === r.trackId)!.prompt).toBe(`mixed from: ${vox.id} (Narration, Echo)`);
  });

  test("a source the library does not hold refuses the whole render, by id, with nothing appended", () => {
    const { io, vox, graph } = twoLayerLibrary();
    const ghosted: MixGraph = { ...graph, tracks: [graph.tracks[0]!, mixTrack({ id: "t2", label: "Bed", clips: [clipOf("c2", "trk-ghost", 0, 1000)] })] };

    const r = renderAndSaveMix(io, BASE, { graph: ghosted, title: "Ghost", primaryTrackId: vox.id });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('the mix needs source "trk-ghost", which is not in the library');
    expect(foldLibrary(io.ledger())).toHaveLength(2); // the ledger never grew
    expect([...io.files.keys()].some((p) => p.startsWith(mixerStageDir(BASE)))).toBe(false);
  });

  test("a source at another sample rate refuses, naming both rates, because there is no resampler", () => {
    const { io, vox, graph } = twoLayerLibrary();
    const wide = seed(io, { name: "wide.wav", bytes: flatWav(1000, 1000, STEREO_44K), title: "Wide" });
    const mismatched: MixGraph = { ...graph, tracks: [graph.tracks[0]!, mixTrack({ id: "t2", label: "Bed", clips: [clipOf("c2", wide.id, 0, 1000)] })] };

    const r = renderAndSaveMix(io, BASE, { graph: mismatched, title: "Mismatch", primaryTrackId: vox.id });
    expect(r.error).toBe(`source "${wide.id}" is 44100Hz and the mix is 8000Hz; this build has no resampler`);
    expect(foldLibrary(io.ledger())).toHaveLength(3);
  });

  test("a stereo source under a mono mix is fine: channels are folded, not refused", () => {
    const io = fakeIo();
    const vox = seed(io, { name: "vox.wav", bytes: flatWav(1000, -12000, MONO_8K), title: "Vox" });
    const bed = seed(io, { name: "bed.wav", bytes: flatWav(1000, -8000, STEREO_8K), title: "Bed" });

    const r = renderAndSaveMix(io, BASE, { graph: twoLayers(vox.id, bed.id), title: "Folded", primaryTrackId: vox.id });
    expect(r.error).toBeUndefined();
    expect(r.peak).toBeCloseTo(16000 / 32768, 5); // both channels carry -8000, so the fold is -8000
  });

  test("a non-WAV source and an unreadable WAV each refuse by id, naming what is wrong with them", () => {
    const { io, vox, graph } = twoLayerLibrary();
    const mp3 = seed(io, { name: "song.mp3", bytes: new TextEncoder().encode("ID3"), title: "Song" });
    const junk = seed(io, { name: "junk.wav", bytes: new TextEncoder().encode("not a RIFF file"), title: "Junk" });
    const withSource = (id: string): MixGraph =>
      ({ ...graph, tracks: [mixTrack({ id: "t1", label: "Narration", clips: [clipOf("c1", id, 0, 1000)] })] });

    expect(renderAndSaveMix(io, BASE, { graph: withSource(mp3.id), title: "Mp3", primaryTrackId: vox.id }).error)
      .toBe(`the mix needs source "${mp3.id}", which is audio/mpeg, not 16-bit PCM WAV`);
    expect(renderAndSaveMix(io, BASE, { graph: withSource(junk.id), title: "Junk", primaryTrackId: vox.id }).error)
      .toBe(`the mix needs source "${junk.id}", which is not a readable RIFF/WAVE file`);
    expect(foldLibrary(io.ledger())).toHaveLength(4);
  });

  test("a source at the right rate but the wrong depth or channel count refuses in the core's own words", () => {
    const { io, vox, graph } = twoLayerLibrary();
    // Both are 8000Hz, so they pass the rate check and reach the checks under test.
    const deep = seed(io, { name: "deep.wav", bytes: buildWav({ channels: 1, sampleRate: 8000, bitsPerSample: 24 }, new Uint8Array(300)), title: "Deep" });
    const wide = seed(io, { name: "wide.wav", bytes: buildWav({ channels: 3, sampleRate: 8000, bitsPerSample: 16 }, new Uint8Array(600)), title: "Wide" });
    const withSource = (id: string): MixGraph =>
      ({ ...graph, tracks: [mixTrack({ id: "t1", label: "Narration", clips: [clipOf("c1", id, 0, 1000)] })] });

    expect(renderAndSaveMix(io, BASE, { graph: withSource(deep.id), title: "Deep", primaryTrackId: vox.id }).error)
      .toBe(`source "${deep.id}" is 24-bit; only 16-bit PCM is supported`);
    expect(renderAndSaveMix(io, BASE, { graph: withSource(wide.id), title: "Wide", primaryTrackId: vox.id }).error)
      .toBe(`source "${wide.id}" has 3 channels; a mix takes mono or stereo`);
    expect(foldLibrary(io.ledger())).toHaveLength(4); // neither refusal appended anything
  });

  test("a source whose audio file has gone missing refuses rather than mixing silence into the gap", () => {
    const { io, vox, bed, graph } = twoLayerLibrary();
    io.files.delete(audioPath(bed));

    const r = renderAndSaveMix(io, BASE, { graph, title: "Gone", primaryTrackId: vox.id });
    expect(r.error).toBe(`the mix needs source "${bed.id}", which has no audio file any more`);
    expect(foldLibrary(io.ledger())).toHaveLength(2);
  });

  test("a structurally broken graph refuses with the structural reason, before any file is read", () => {
    const { io, vox, bed } = twoLayerLibrary();
    const broken: MixGraph = {
      ...emptyMix(8000, 1),
      tracks: [mixTrack({ id: "t1", label: "Narration", clips: [clipOf("c1", vox.id, 0, 0), clipOf("c2", bed.id, 0, 500)] })],
    };

    const r = renderAndSaveMix(io, BASE, { graph: broken, title: "Broken", primaryTrackId: vox.id });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("mix is not renderable: clip c1 has no length");
    expect(foldLibrary(io.ledger())).toHaveLength(2);
  });

  test("a mix with no layers at all is refused by name rather than saved as a zero-length file", () => {
    const { io, vox } = twoLayerLibrary();

    const r = renderAndSaveMix(io, BASE, { graph: emptyMix(8000, 1), title: "Nothing", primaryTrackId: vox.id });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("an empty mix has nothing to render");
    expect(foldLibrary(io.ledger())).toHaveLength(2);
  });

  test("an untitled mix and an unknown primary track are refused before anything is written", () => {
    const { io, vox, graph } = twoLayerLibrary();

    expect(renderAndSaveMix(io, BASE, { graph, title: "   ", primaryTrackId: vox.id }).error).toBe("give the mix a title before saving it");
    expect(renderAndSaveMix(io, BASE, { graph, title: "Orphan", primaryTrackId: "trk404" }).error).toBe("no track trk404");
    expect(renderAndSaveMix(io, BASE, { graph, title: "Orphan", primaryTrackId: "" }).error).toBe("no track id was given");
    expect(foldLibrary(io.ledger())).toHaveLength(2);
    expect([...io.files.keys()].some((p) => p.startsWith(mixerStageDir(BASE)))).toBe(false);
  });

  test("a muted layer is reported with its reason and contributes exactly nothing", () => {
    const { io, vox, bed, graph } = twoLayerLibrary();
    const muted: MixGraph = {
      ...graph,
      tracks: [graph.tracks[0]!, mixTrack({ id: "t2", label: "Bed", clips: [clipOf("c2", bed.id, 0, 1000)], muted: true })],
    };

    const r = renderAndSaveMix(io, BASE, { graph: muted, title: "Muted bed", primaryTrackId: vox.id });
    expect(r.error).toBeUndefined();
    expect(r.silentTracks).toEqual([{ id: "t2", reason: "muted" }]);
    expect(r.peak).toBeCloseTo(12000 / 32768, 5); // the narration alone: not "almost nothing", nothing
  });

  test("a mono mix says it ignored a pan instead of pretending it honored one", () => {
    const { io, vox, bed } = twoLayerLibrary();
    const panned: MixGraph = {
      ...emptyMix(8000, 1),
      tracks: [
        mixTrack({ id: "t1", label: "Narration", clips: [clipOf("c1", vox.id, 0, 1000)], pan: -0.8 }),
        mixTrack({ id: "t2", label: "Bed", clips: [clipOf("c2", bed.id, 0, 1000)], gain: 0.5 }),
      ],
    };

    const r = renderAndSaveMix(io, BASE, { graph: panned, title: "Panned", primaryTrackId: vox.id });
    expect(r.panIgnored).toBe(true);
    expect(r.peak).toBeCloseTo(16000 / 32768, 5); // a mono render sums at full level, pan or no pan
  });

  test("a hot mix keeps its clipping and reports it, because nothing is fixed automatically", () => {
    const { io, a, graph } = hotLibrary();

    const r = renderAndSaveMix(io, BASE, { graph, title: "Hot", primaryTrackId: a.id });
    expect(r.ok).toBe(true); // clipping is REPORTED, not refused: it is the user's mix
    expect(r.peak).toBe(1.25); // 40960 of 32768
    expect(r.clipped).toBe(8000); // every one of the 1000ms at 8kHz hit the rail
    expect(r.headroomApplied).toBeUndefined();
  });

  test("applyHeadroom re-renders at the exact factor it reports, and lands at full scale", () => {
    const { io, a, graph: hot } = hotLibrary();

    const r = renderAndSaveMix(io, BASE, { graph: hot, title: "Hot, recovered", primaryTrackId: a.id, applyHeadroom: true });
    expect(r.ok).toBe(true);
    expect(r.headroomApplied).toBe(0.8); // 1 / 1.25, the exact number applied
    expect(r.peak).toBeLessThanOrEqual(1);
    expect(r.peak).toBeGreaterThanOrEqual(0.999999);
    expect(r.clipped).toBe(0);
    // The graph the caller handed in is untouched: the gain moved for the render, not in their document.
    expect(hot.masterGain).toBe(1);
    // And the saved file really is the recovered render, not the clipped one.
    const saved = foldLibrary(io.ledger()).find((t) => t.id === r.trackId)!;
    const pcm = parseWav(io.files.get(audioPath(saved))!).data;
    expect(pcm[0]! | (pcm[1]! << 8)).toBe(0x8000); // -32768 exactly: at the rail, not through it
  });

  test("the headroom factor comes from the PRE-headroom peak, not from the peak it reports back", () => {
    const { io, a, graph } = hotLibrary();

    const plain = renderAndSaveMix(io, BASE, { graph, title: "Plain", primaryTrackId: a.id });
    const recovered = renderAndSaveMix(io, BASE, { graph, title: "Recovered", primaryTrackId: a.id, applyHeadroom: true });

    // The whole meaning of headroom: the factor recovers the peak the mix HAD, so it is derived from the
    // un-recovered render. Deriving it from the peak in its own result would be circular.
    expect(recovered.headroomApplied).toBe(headroomGain(plain.peak!));
    // The two peaks are DIFFERENT numbers, which is exactly why headroomGain(result.peak) is not the factor:
    // by the time the report exists the peak has already been recovered to full scale.
    expect(recovered.peak).not.toBe(plain.peak);
    expect(headroomGain(recovered.peak!)).not.toBe(recovered.headroomApplied);
  });

  test("headroom on a mix already at full scale reports the factor 1 and changes not one byte", () => {
    const io = fakeIo();
    // One layer sitting exactly at the negative rail: peak is 1.0, so headroomGain is exactly 1.
    const rail = seed(io, { name: "rail.wav", bytes: flatWav(1000, -32768, MONO_8K), title: "Rail" });
    const graph: MixGraph = {
      ...emptyMix(8000, 1),
      tracks: [mixTrack({ id: "t1", label: "Rail", clips: [clipOf("c1", rail.id, 0, 1000)] })],
    };

    const plain = renderAndSaveMix(io, BASE, { graph, title: "Rail plain", primaryTrackId: rail.id });
    const asked = renderAndSaveMix(io, BASE, { graph, title: "Rail asked", primaryTrackId: rail.id, applyHeadroom: true });

    expect(plain.peak).toBe(1);
    expect(plain.clipped).toBe(0); // -32768 IS the rail, not past it
    expect(plain.headroomApplied).toBeUndefined();
    // Asked for, and the honest answer is 1: what was applied, not what was intended. The second render is
    // skipped because multiplying by exactly 1 cannot change a sample, and THAT is the observable claim:
    // the two saved files are byte-identical.
    expect(asked.headroomApplied).toBe(1);
    expect(asked.peak).toBe(1);
    const rows = foldLibrary(io.ledger());
    const plainBytes = io.files.get(audioPath(rows.find((t) => t.id === plain.trackId)!))!;
    const askedBytes = io.files.get(audioPath(rows.find((t) => t.id === asked.trackId)!))!;
    expect(askedBytes).toEqual(plainBytes);
  });

  test("headroom asked for on a silent mix applies nothing, because peak 0 has nothing to recover", () => {
    const { io, vox, graph } = twoLayerLibrary();
    const zeroed: MixGraph = {
      ...graph,
      tracks: [mixTrack({ id: "t1", label: "Narration", clips: [clipOf("c1", vox.id, 0, 1000)], gain: 0 })],
    };

    const r = renderAndSaveMix(io, BASE, { graph: zeroed, title: "Zeroed", primaryTrackId: vox.id, applyHeadroom: true });
    expect(r.ok).toBe(true);
    expect(r.peak).toBe(0);
    expect(r.clipped).toBe(0);
    expect(r.silentTracks).toEqual([{ id: "t1", reason: "track level is at zero" }]);
    // Asked for and NOT applied, so the key is absent. 0 would be a lie (a gain of zero) and 1 would claim
    // a factor nobody computed; absence is the only honest answer.
    expect(Object.keys(r)).not.toContain("headroomApplied");
  });
});

describe("the mix on the wire", () => {
  test("a JSON round trip of a real graph survives intact", () => {
    const { graph } = twoLayerLibrary();
    const r = decodeMixGraph(JSON.parse(JSON.stringify(graph)));
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.error);
    expect(r.graph).toEqual(graph);
  });

  test("one malformed track, clip, bus, or envelope point refuses the whole body by name", () => {
    const { graph } = twoLayerLibrary();
    const t0 = graph.tracks[0]!;

    expect(decodeMixGraph({ ...graph, tracks: [...graph.tracks, { id: "t3" }] }))
      .toMatchObject({ ok: false, error: "track 2 in that mix is not a well-formed track" });
    expect(decodeMixGraph({ ...graph, tracks: [{ ...t0, clips: [{ id: "c1", sourceId: "x" }] }] }))
      .toMatchObject({ ok: false, error: "clip 0 on track 0 in that mix is not a well-formed clip" });
    expect(decodeMixGraph({ ...graph, buses: [{ id: "b1", label: "Music" }] }))
      .toMatchObject({ ok: false, error: "bus 0 in that mix is not a well-formed bus" });
    expect(decodeMixGraph({ ...graph, tracks: [{ ...t0, envelope: [{ atMs: 0 }] }] }))
      .toMatchObject({ ok: false, error: "envelope point 0 on track 0 in that mix is not a well-formed point" });
  });

  test("a body with no mix, no format, no master gain, or too much of anything is named, never thrown", () => {
    const { graph } = twoLayerLibrary();
    const t0 = graph.tracks[0]!;

    expect(decodeMixGraph(null)).toMatchObject({ error: "that request carried no mix" });
    expect(decodeMixGraph([])).toMatchObject({ error: "that request carried no mix" });
    expect(decodeMixGraph({})).toMatchObject({ error: "that mix does not declare its audio format" });
    expect(decodeMixGraph({ sampleRate: 8000, channels: 1, bitsPerSample: 16 }))
      .toMatchObject({ error: "that mix does not declare a master gain" });
    expect(decodeMixGraph({ sampleRate: 8000, channels: 1, bitsPerSample: 16, masterGain: 1 }))
      .toMatchObject({ error: "that mix has no tracks or no buses" });
    expect(decodeMixGraph({ ...graph, tracks: new Array(MAX_MIX_TRACKS + 1).fill(t0) }))
      .toMatchObject({ error: `that mix carries ${MAX_MIX_TRACKS + 1} tracks, over the ${MAX_MIX_TRACKS} limit` });
    expect(decodeMixGraph({ ...graph, buses: new Array(MAX_MIX_TRACKS + 1).fill({ id: "b", label: "B", gain: 1, muted: false }) })
    ).toMatchObject({ error: `that mix carries ${MAX_MIX_TRACKS + 1} buses, over the ${MAX_MIX_TRACKS} limit` });
    expect(decodeMixGraph({ ...graph, tracks: [{ ...t0, clips: new Array(MAX_MIX_CLIPS_PER_TRACK + 1).fill(t0.clips[0]) }] }))
      .toMatchObject({ error: `track 0 in that mix carries ${MAX_MIX_CLIPS_PER_TRACK + 1} clips, over the ${MAX_MIX_CLIPS_PER_TRACK} limit` });
    expect(decodeMixGraph({ ...graph, tracks: [{ ...t0, envelope: new Array(MAX_WIRE_ENVELOPE + 1).fill({ atMs: 0, gain: 1 }) }] })
    ).toMatchObject({ error: `track 0 in that mix carries ${MAX_WIRE_ENVELOPE + 1} envelope points, over the ${MAX_WIRE_ENVELOPE} limit` });
  });

  test("a decoded graph is exactly what renderAndSaveMix accepts, so the route has one gate and one path", () => {
    const { io, vox, graph } = twoLayerLibrary();
    const decoded = decodeMixGraph(JSON.parse(JSON.stringify(graph)));
    if (!decoded.ok) throw new Error(decoded.error);

    const r = renderAndSaveMix(io, BASE, { graph: decoded.graph, title: "From the wire", primaryTrackId: vox.id });
    expect(r.error).toBeUndefined();
    expect(r.trackId).toBeTruthy();
    expect(foldLibrary(io.ledger())).toHaveLength(3);
  });
});
