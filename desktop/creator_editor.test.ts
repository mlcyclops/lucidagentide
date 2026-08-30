// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, test } from "bun:test";
import { buildWav, parseWav, type WavFormat } from "../harness/brief/tts_backend.ts";
import { DERIVED_CONFIDENCE_CEILING, docDurationMs, replaceSpan, type TimelineDoc } from "../harness/creator/timeline.ts";
import { addTrack, foldLibrary, libraryAudioDir, libraryLedger, type CreatorTrack, type TrackOrigin } from "./creator_library.ts";
import {
  DEFAULT_PEAK_BUCKETS, MAX_WIRE_CLIPS, MAX_WIRE_ITEMS, NO_TEXT_NOTE, decodeTimelineDoc, editorStageDir,
  openEditor, saveEdit, type EditorIo,
} from "./creator_editor.ts";

const BASE = "/data";
const MONO_8K: WavFormat = { channels: 1, sampleRate: 8000, bitsPerSample: 16 };
const STEREO_44K: WavFormat = { channels: 2, sampleRate: 44100, bitsPerSample: 16 };
const LYRIC = "one two three four";

/** An in-memory disk. Everything is BYTES (the editor decodes audio, so a string store would not do);
 *  text files are the same map read back as UTF-8. */
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

/** `ms` of a 220Hz tone at `amp`, or silence when `amp` is 0. */
function pcmMs(ms: number, amp: number, fmt: WavFormat): Uint8Array {
  const frames = Math.round((ms / 1000) * fmt.sampleRate);
  const out = new Uint8Array(frames * fmt.channels * (fmt.bitsPerSample >> 3));
  const stride = fmt.bitsPerSample >> 3;
  for (let i = 0; i < frames; i++) {
    const v = amp === 0 ? 0 : Math.round(amp * Math.sin((i / fmt.sampleRate) * 2 * Math.PI * 220));
    const u = v < 0 ? v + 0x10000 : v;
    for (let c = 0; c < fmt.channels; c++) {
      const o = (i * fmt.channels + c) * stride;
      out[o] = u & 0xff;
      if (stride > 1) out[o + 1] = (u >> 8) & 0xff;
    }
  }
  return out;
}

/** A WAV with `bursts` measurable speech runs, so a derived alignment has real boundaries to work from. */
function speechWav(fmt: WavFormat, bursts = 4, burstMs = 200, gapMs = 150): Uint8Array {
  const parts: Uint8Array[] = [];
  for (let i = 0; i < bursts; i++) {
    parts.push(pcmMs(burstMs, 12000, fmt));
    parts.push(pcmMs(gapMs, 0, fmt));
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const pcm = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { pcm.set(p, off); off += p.length; }
  return buildWav(fmt, pcm);
}

const audioPath = (t: CreatorTrack): string => `${libraryAudioDir(BASE)}/${t.file}`;

interface SeedInput { name: string; bytes: Uint8Array; title?: string; lyrics?: string; origin?: TrackOrigin }

function seed(io: EditorIo & { files: Map<string, Uint8Array> }, input: SeedInput): CreatorTrack {
  const src = `/in/${input.name}`;
  io.files.set(src, input.bytes);
  const r = addTrack(io, BASE, { sourcePath: src, title: input.title, lyrics: input.lyrics, origin: input.origin });
  if (!r.track) throw new Error(r.error ?? "seed failed");
  return r.track;
}

/** The duration the render MUST come out at, derived from the document rather than from the code under
 *  test: every clip is rounded to whole frames, then the frames are read back as milliseconds. */
function expectedRenderMs(doc: TimelineDoc): number {
  let frames = 0;
  for (const c of doc.clips) frames += Math.round(((c.endMs - c.startMs) / 1000) * doc.sampleRate);
  return Math.round((frames / doc.sampleRate) * 1000);
}

function openOk(io: EditorIo, trackId: string, text?: string) {
  const r = openEditor(io, BASE, { trackId, text });
  expect(r.error).toBeUndefined();
  if (!r.session) throw new Error("expected a session");
  return r.session;
}

describe("opening a track as a timeline (CREATOR-2, ADR-0286)", () => {
  test("a real WAV yields words, a waveform, and the alignment's own provenance note", () => {
    const io = fakeIo();
    const track = seed(io, { name: "vox.wav", bytes: speechWav(MONO_8K), title: "Vox" });
    const s = openOk(io, track.id, LYRIC);

    expect(s.doc.items).toHaveLength(4);
    expect(s.doc.clips).toHaveLength(1);
    expect(s.doc.clips[0]!.sourceId).toBe(track.id);
    expect(s.doc.sampleRate).toBe(8000);
    expect(s.durationMs).toBe(1400); // 4 * (200ms burst + 150ms gap)
    expect(s.peaks).toHaveLength(DEFAULT_PEAK_BUCKETS);
    expect(s.peaks.some((v) => v > 0)).toBe(true);
    expect(s.mime).toBe("audio/wav");
    expect(Buffer.from(s.audioB64, "base64").length).toBe(io.files.get(audioPath(track))!.length);
    // The note is deriveAlignment's own line, carried verbatim: measured runs, proportional boundaries.
    expect(s.note).toContain("derived locally");
    expect(s.note).toContain("4 word(s)");
    for (const it of s.doc.items) {
      expect(it.source).toBe("derived");
      expect(it.confidence).toBeLessThanOrEqual(DERIVED_CONFIDENCE_CEILING);
    }
  });

  test("no text at all is said out loud, not painted as an empty strip", () => {
    const io = fakeIo();
    const track = seed(io, { name: "vox.wav", bytes: speechWav(MONO_8K), title: "Vox" });
    const s = openOk(io, track.id);
    expect(s.doc.items).toHaveLength(0);
    expect(s.note).toBe(NO_TEXT_NOTE);
    expect(s.peaks).toHaveLength(DEFAULT_PEAK_BUCKETS); // the waveform is still real
  });

  test("the track's own lyrics are the fallback, and supplied text wins over them", () => {
    const io = fakeIo();
    const track = seed(io, { name: "vox.wav", bytes: speechWav(MONO_8K), title: "Vox", lyrics: LYRIC });
    expect(openOk(io, track.id).doc.items).toHaveLength(4);
    expect(openOk(io, track.id, "five six").doc.items.map((i) => i.text)).toEqual(["five", "six"]);
  });

  test("an mp3 is refused by name: there is no transcoder to pretend with", () => {
    const io = fakeIo();
    const track = seed(io, { name: "song.mp3", bytes: new TextEncoder().encode("ID3-bytes"), title: "Neon Skyline" });
    const r = openEditor(io, BASE, { trackId: track.id, text: LYRIC });
    expect(r.ok).toBe(false);
    expect(r.session).toBeUndefined();
    expect(r.error).toBe('the editor works on 16-bit PCM WAV; "Neon Skyline" is audio/mpeg');
  });

  test("a WAV that is not 16-bit is refused with its real bit depth", () => {
    const io = fakeIo();
    const fmt: WavFormat = { channels: 1, sampleRate: 8000, bitsPerSample: 24 };
    const track = seed(io, { name: "hires.wav", bytes: buildWav(fmt, pcmMs(500, 9000, fmt)), title: "Hi-Res" });
    expect(openEditor(io, BASE, { trackId: track.id, text: LYRIC }).error).toBe('the editor works on 16-bit PCM WAV; "Hi-Res" is 24-bit');
  });

  test("an unknown id refuses by id, and a missing id says so", () => {
    const io = fakeIo();
    expect(openEditor(io, BASE, { trackId: "trk404" }).error).toBe("no track trk404");
    expect(openEditor(io, BASE, { trackId: "  " }).error).toBe("no track id was given");
  });

  test("the bucket count is clamped instead of trusted", () => {
    const io = fakeIo();
    const track = seed(io, { name: "vox.wav", bytes: speechWav(MONO_8K) });
    expect(openEditor(io, BASE, { trackId: track.id, buckets: 1 }).session!.peaks).toHaveLength(40);
    expect(openEditor(io, BASE, { trackId: track.id, buckets: 9_999_999 }).session!.peaks).toHaveLength(2000);
    expect(openEditor(io, BASE, { trackId: track.id, buckets: 120 }).session!.peaks).toHaveLength(120);
  });

  test("sources offer only tracks a replacement could actually render from", () => {
    const io = fakeIo();
    const track = seed(io, { name: "vox.wav", bytes: speechWav(MONO_8K), title: "Vox" });
    const takeTwo = seed(io, { name: "take2.wav", bytes: speechWav(MONO_8K, 2), title: "Take 2" });
    seed(io, { name: "wide.wav", bytes: speechWav(STEREO_44K, 1), title: "Wide" });   // 44100Hz/2ch: cannot render in
    seed(io, { name: "other.mp3", bytes: new TextEncoder().encode("ID3"), title: "Other" }); // no decoder
    const empty = seed(io, { name: "empty.wav", bytes: buildWav(MONO_8K, new Uint8Array(0)), title: "Empty" });

    const s = openOk(io, track.id, LYRIC);
    expect(s.sources.map((x) => x.id)).toEqual([empty.id, takeTwo.id]); // newest first, self excluded
    expect(s.sources.find((x) => x.id === takeTwo.id)!.durationMs).toBe(700);
    expect(s.sources.find((x) => x.id === empty.id)!.durationMs).toBeNull(); // unknown, never 0
  });
});

describe("saving an edit as a new track (CREATOR-2, ADR-0286)", () => {
  test("the render is appended as a remix and the edited track keeps its bytes", () => {
    const io = fakeIo();
    const track = seed(io, { name: "vox.wav", bytes: speechWav(MONO_8K), title: "Vox", origin: "elevenlabs" });
    const before = Uint8Array.from(io.files.get(audioPath(track))!); // a copy, so an in-place write would show
    const s = openOk(io, track.id, LYRIC);

    const r = saveEdit(io, BASE, { trackId: track.id, doc: s.doc, title: "Vox (edit)", prompt: "tighten the second line" });
    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(r.durationMs).toBe(expectedRenderMs(s.doc));
    expect(r.bytes).toBe(io.files.get(audioPath(foldLibrary(io.ledger()).find((t) => t.id === r.trackId)!))!.length);

    const tracks = foldLibrary(io.ledger());
    expect(tracks).toHaveLength(2);
    const saved = tracks.find((t) => t.id === r.trackId)!;
    expect(saved).toMatchObject({ kind: "remix", parentId: track.id, origin: "elevenlabs", title: "Vox (edit)", mime: "audio/wav" });
    expect(saved.prompt).toBe("tighten the second line");
    expect(saved.lyrics).toBe(LYRIC); // the words the document was bound to travel with it

    // The parent is untouched: same bytes on disk, still in the ledger, still its own row.
    const parentAfter = tracks.find((t) => t.id === track.id)!;
    expect(parentAfter).toMatchObject({ kind: "original", parentId: null, title: "Vox" });
    expect(io.files.get(audioPath(track))).toEqual(before);
    // Nothing is left in the staging area the render passed through.
    expect([...io.files.keys()].some((p) => p.startsWith(editorStageDir(BASE)))).toBe(false);
  });

  test("a span replaced from another take still renders, and re-opens as a valid WAV", () => {
    const io = fakeIo();
    const track = seed(io, { name: "vox.wav", bytes: speechWav(MONO_8K), title: "Vox" });
    const takeTwo = seed(io, { name: "take2.wav", bytes: speechWav(MONO_8K, 2), title: "Take 2" }); // 700ms
    const s = openOk(io, track.id, LYRIC);

    const replaced = replaceSpan(s.doc, [s.doc.items[1]!.id], { sourceId: takeTwo.id, durationMs: 500, prompt: "re-sing line two" });
    expect(replaced.ok).toBe(true);
    if (!replaced.ok) throw new Error(replaced.error);
    expect(replaced.doc.clips.some((c) => c.sourceId === takeTwo.id && c.prompt === "re-sing line two")).toBe(true);

    const r = saveEdit(io, BASE, { trackId: track.id, doc: replaced.doc, title: "Vox (line two)" });
    expect(r.error).toBeUndefined();
    expect(r.durationMs).toBe(expectedRenderMs(replaced.doc));
    expect(docDurationMs(replaced.doc)).not.toBe(s.durationMs); // the edit really changed the length

    const savedTrack = foldLibrary(io.ledger()).find((t) => t.id === r.trackId)!;
    const parsed = parseWav(io.files.get(audioPath(savedTrack))!);
    expect(parsed.fmt).toEqual(MONO_8K);
    expect(Math.round((parsed.data.length / 2 / 8000) * 1000)).toBe(r.durationMs!);

    const reopened = openOk(io, r.trackId!);
    expect(reopened.durationMs).toBe(r.durationMs!);
    expect(reopened.doc.items).toHaveLength(4); // the carried lyrics follow along again
    expect(reopened.sources.map((x) => x.id)).toContain(track.id);
  });

  test("a source the document names but the library does not hold refuses the whole save, by id", () => {
    const io = fakeIo();
    const track = seed(io, { name: "vox.wav", bytes: speechWav(MONO_8K), title: "Vox" });
    const s = openOk(io, track.id, LYRIC);
    const doc: TimelineDoc = { ...s.doc, clips: s.doc.clips.map((c) => ({ ...c, sourceId: "trk-ghost" })) };

    const r = saveEdit(io, BASE, { trackId: track.id, doc, title: "Ghost" });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('the timeline needs source "trk-ghost", which is not in the library');
    expect(foldLibrary(io.ledger())).toHaveLength(1); // nothing was appended
  });

  test("a source in the wrong format refuses and names both formats, rather than rendering silence", () => {
    const io = fakeIo();
    const track = seed(io, { name: "vox.wav", bytes: speechWav(MONO_8K), title: "Vox" });
    const wide = seed(io, { name: "wide.wav", bytes: speechWav(STEREO_44K, 1), title: "Wide" });
    const mp3 = seed(io, { name: "other.mp3", bytes: new TextEncoder().encode("ID3"), title: "Other" });
    const s = openOk(io, track.id, LYRIC);

    const wrongRate = saveEdit(io, BASE, { trackId: track.id, doc: { ...s.doc, clips: s.doc.clips.map((c) => ({ ...c, sourceId: wide.id })) }, title: "Wide edit" });
    expect(wrongRate.error).toBe(`source "${wide.id}" is 44100Hz/2ch/16-bit, the timeline is 8000Hz/1ch/16-bit`);

    const notWav = saveEdit(io, BASE, { trackId: track.id, doc: { ...s.doc, clips: s.doc.clips.map((c) => ({ ...c, sourceId: mp3.id })) }, title: "Mp3 edit" });
    expect(notWav.error).toBe(`the timeline needs source "${mp3.id}", which is audio/mpeg, not 16-bit PCM WAV`);
    expect(foldLibrary(io.ledger())).toHaveLength(3);
  });

  test("a structurally broken document refuses with its first reason", () => {
    const io = fakeIo();
    const track = seed(io, { name: "vox.wav", bytes: speechWav(MONO_8K), title: "Vox" });
    const s = openOk(io, track.id, LYRIC);
    const gapped: TimelineDoc = { ...s.doc, clips: s.doc.clips.map((c) => ({ ...c, startMs: 25, endMs: c.endMs + 25 })) };

    const r = saveEdit(io, BASE, { trackId: track.id, doc: gapped, title: "Broken" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("the timeline is not saveable:");
    expect(r.error).toContain("starts at 25, expected 0");
    expect(foldLibrary(io.ledger())).toHaveLength(1);
  });

  test("an untitled edit and an unknown parent are both refused before anything is written", () => {
    const io = fakeIo();
    const track = seed(io, { name: "vox.wav", bytes: speechWav(MONO_8K), title: "Vox" });
    const s = openOk(io, track.id, LYRIC);
    expect(saveEdit(io, BASE, { trackId: track.id, doc: s.doc, title: "   " }).error).toBe("give the edit a title before saving it");
    expect(saveEdit(io, BASE, { trackId: "trk404", doc: s.doc, title: "Orphan" }).error).toBe("no track trk404");
    expect(foldLibrary(io.ledger())).toHaveLength(1);
    expect([...io.files.keys()].some((p) => p.startsWith(editorStageDir(BASE)))).toBe(false);
  });
});

/** A library holding one 1400ms mono WAV, opened with four words bound to it. */
function opened() {
  const io = fakeIo();
  const track = seed(io, { name: "vox.wav", bytes: speechWav(MONO_8K), title: "Vox" });
  return { io, track, session: openOk(io, track.id, LYRIC) };
}

describe("the document on the wire", () => {
  test("a JSON round trip of a real document survives intact", () => {
    const { session } = opened();
    const r = decodeTimelineDoc(JSON.parse(JSON.stringify(session.doc)));
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.error);
    expect(r.doc).toEqual(session.doc);
  });

  test("one malformed word or clip refuses the whole body rather than saving a shorter edit", () => {
    const { session } = opened();
    const badItem = { ...session.doc, items: [session.doc.items[0], { id: "item-2", text: "two" }] };
    expect(decodeTimelineDoc(badItem)).toMatchObject({ ok: false, error: "item 1 in that timeline is not a well-formed word" });
    expect(decodeTimelineDoc({ ...session.doc, clips: [{ id: "clip-1", startMs: 0 }] }))
      .toMatchObject({ ok: false, error: "clip 0 in that timeline is not a well-formed region" });
  });

  test("a body with no timeline, no format, or too many words is named, never thrown", () => {
    const { session } = opened();
    expect(decodeTimelineDoc(null)).toMatchObject({ error: "that request carried no timeline" });
    expect(decodeTimelineDoc([])).toMatchObject({ error: "that request carried no timeline" });
    expect(decodeTimelineDoc({ items: [], clips: [] })).toMatchObject({ error: "that timeline does not declare its audio format" });
    expect(decodeTimelineDoc({ sampleRate: 8000, channels: 1, bitsPerSample: 16 })).toMatchObject({ error: "that timeline has no words or no clips" });
    expect(decodeTimelineDoc({ ...session.doc, items: new Array(MAX_WIRE_ITEMS + 1).fill(session.doc.items[0]) }).ok).toBe(false);
    expect(decodeTimelineDoc({ ...session.doc, clips: new Array(MAX_WIRE_CLIPS + 1).fill(session.doc.clips[0]) }).ok).toBe(false);
  });

  test("a decoded document is what saveEdit accepts, so the route has one gate and one path", () => {
    const { io, track, session } = opened();
    const decoded = decodeTimelineDoc(JSON.parse(JSON.stringify(session.doc)));
    if (!decoded.ok) throw new Error(decoded.error);
    const r = saveEdit(io, BASE, { trackId: track.id, doc: decoded.doc, title: "From the wire" });
    expect(r.error).toBeUndefined();
    expect(r.trackId).toBeTruthy();
    expect(foldLibrary(io.ledger())).toHaveLength(2);
  });
});
