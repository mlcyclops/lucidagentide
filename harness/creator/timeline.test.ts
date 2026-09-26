// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/creator/timeline.test.ts - CREATOR-2 (ADR-0286) keystone tests.
//
// The claims that must hold or the editor is lying to the user:
//   * a span re-render changes ONLY that span's audio (bytes outside it are identical),
//   * the word map stays aligned to the text through every edit,
//   * undo restores the previous document EXACTLY,
//   * a render is deterministic, and a derived alignment can never claim vendor confidence.

import { describe, expect, test } from "bun:test";
import { buildWav, parseWav, type WavFormat } from "../brief/tts_backend.ts";
import {
  DERIVED_CONFIDENCE_CEILING, SILENCE_SOURCE, alignFromVendor, canRedo, canUndo, clipAt, commit,
  deleteSpan, deriveAlignment, docDurationMs, docFromSource, durationOfWav, frameEnergy, itemAt,
  lockToText, moveSpan, newHistory, redo, renderTimeline, replaceSpan, setItemLock, spanOf, speechRuns,
  splitItem, tokenizeWords, trimClip, undo, validateDoc, waveformPeaks,
  type SourceAudio, type TimelineDoc, type TimelineItem,
} from "./timeline.ts";

const FMT: WavFormat = { channels: 1, sampleRate: 1000, bitsPerSample: 16 }; // 1000Hz keeps 1ms = 1 sample
const FRAME = 2; // bytes per frame at 16-bit mono

/** A WAV whose sample values are `base + i`, so a byte range identifies exactly which source region it
 *  came from. Byte-level assertions on the render are meaningful because of this. */
function rampWav(samples: number, base = 0): Uint8Array {
  const data = new Uint8Array(samples * FRAME);
  for (let i = 0; i < samples; i++) {
    const v = (base + i) & 0xffff;
    data[i * FRAME] = v & 0xff;
    data[i * FRAME + 1] = (v >> 8) & 0xff;
  }
  return buildWav(FMT, data);
}

function source(wav: Uint8Array): SourceAudio {
  const { fmt, data } = parseWav(wav);
  return { fmt, data };
}

/** Tone bursts separated by silence, for the energy/run measurement. */
function burstWav(pattern: readonly { loud: boolean; ms: number }[]): Uint8Array {
  const total = pattern.reduce((n, p) => n + p.ms, 0);
  const data = new Uint8Array(total * FRAME);
  let s = 0;
  for (const p of pattern) {
    for (let i = 0; i < p.ms; i++, s++) {
      const v = p.loud ? (i % 2 === 0 ? 12000 : -12000) : 0;
      const u = v < 0 ? v + 0x10000 : v;
      data[s * FRAME] = u & 0xff;
      data[s * FRAME + 1] = (u >> 8) & 0xff;
    }
  }
  return buildWav(FMT, data);
}

const items = (...spec: readonly [string, number, number][]): TimelineItem[] =>
  spec.map(([text, startMs, endMs], i) => ({ id: `item-${i + 1}`, text, startMs, endMs, confidence: 1, source: "vendor" as const, locked: false }));

/** Four words over 400ms of ramp audio: the fixture nearly every op test starts from. */
function fixture(): { doc: TimelineDoc; sources: Map<string, SourceAudio> } {
  const doc = docFromSource({
    sourceId: "take-1",
    fmt: FMT,
    durationMs: 400,
    items: items(["Ship", 0, 100], ["it", 100, 200], ["on", 200, 300], ["Friday", 300, 400]),
  });
  return { doc, sources: new Map([["take-1", source(rampWav(400, 1000))]]) };
}

const rendered = (doc: TimelineDoc, sources: ReadonlyMap<string, SourceAudio>): Uint8Array => {
  const r = renderTimeline(doc, sources);
  if (!r.ok) throw new Error(r.error);
  return parseWav(r.wav).data;
};

const ok = (r: { ok: boolean; doc?: TimelineDoc; error?: string }): TimelineDoc => {
  if (!r.ok || !r.doc) throw new Error(r.error ?? "operation failed");
  return r.doc;
};

/** `toMatchObject` compares a RegExp property by equality, not by match, so a refusal's reason is asserted
 *  through this instead: it proves the operation refused AND hands the message to `toMatch`. */
type Refusable = { ok: true } | { ok: false; error: string };
const refused = (r: Refusable): string => {
  if (r.ok) throw new Error("expected a refusal, got a successful result");
  return r.error;
};

describe("the document's invariants", () => {
  test("a fresh document is valid and one clip long", () => {
    const { doc } = fixture();
    expect(validateDoc(doc)).toEqual([]);
    expect(docDurationMs(doc)).toBe(400);
    expect(doc.clips).toHaveLength(1);
  });

  test("validateDoc names a gap between clips instead of quietly rendering a hole", () => {
    const { doc } = fixture();
    const broken: TimelineDoc = { ...doc, clips: [...doc.clips, { id: "clip-2", startMs: 500, endMs: 600, sourceId: "take-1", srcStartMs: 0, gain: 1 }] };
    expect(validateDoc(broken)[0]).toContain("starts at 500, expected 400");
  });

  test("validateDoc refuses a derived item wearing vendor confidence", () => {
    const { doc } = fixture();
    const lying: TimelineDoc = { ...doc, items: [{ ...doc.items[0]!, source: "derived", confidence: 1 }] };
    expect(validateDoc(lying)[0]).toContain("claims vendor-grade confidence");
  });

  test("itemAt and clipAt answer what the user tapped, and null past the end", () => {
    const { doc } = fixture();
    expect(itemAt(doc, 150)?.text).toBe("it");
    expect(itemAt(doc, 400)).toBeNull();
    expect(clipAt(doc, 399)?.id).toBe("clip-1");
    expect(clipAt(doc, 400)).toBeNull();
  });

  test("spanOf spans the selection and ignores ids that are not there", () => {
    const { doc } = fixture();
    const s = spanOf(doc, ["item-2", "item-3", "nope"]);
    expect(s).toEqual({ startMs: 100, endMs: 300, itemIds: ["item-2", "item-3"] });
    expect(spanOf(doc, ["nope"])).toBeNull();
  });
});

describe("alignment provenance", () => {
  test("vendor character timings produce word items at confidence 1", () => {
    const text = "hi there";
    const chars = [...text].map((_, i) => ({ startMs: i * 10, endMs: i * 10 + 10 }));
    const out = alignFromVendor(text, chars);
    expect(out.map((i) => i.text)).toEqual(["hi", "there"]);
    expect(out[0]).toMatchObject({ startMs: 0, endMs: 20, confidence: 1, source: "vendor" });
    expect(out[1]).toMatchObject({ startMs: 30, endMs: 80 });
  });

  test("a word with no timed character is dropped, never invented", () => {
    const chars = [{ startMs: 0, endMs: 10 }, { startMs: 10, endMs: 20 }]; // covers "hi" only
    expect(alignFromVendor("hi there", chars).map((i) => i.text)).toEqual(["hi"]);
  });

  test("derived alignment is labeled derived and capped below vendor confidence", () => {
    const wav = burstWav([{ loud: true, ms: 200 }, { loud: false, ms: 120 }, { loud: true, ms: 200 }]);
    const { fmt, data } = parseWav(wav);
    const a = deriveAlignment("two words", data, fmt);
    expect(a.items).toHaveLength(2);
    for (const it of a.items) {
      expect(it.source).toBe("derived");
      expect(it.confidence).toBeLessThanOrEqual(DERIVED_CONFIDENCE_CEILING);
    }
    expect(a.runs).toHaveLength(2);
    expect(a.note).toContain("2 measured speech run(s)");
  });

  test("silent audio says so rather than reporting invented boundaries", () => {
    const { fmt, data } = parseWav(burstWav([{ loud: false, ms: 300 }]));
    const a = deriveAlignment("one two", data, fmt);
    expect(a.runs).toEqual([]);
    expect(a.note).toContain("proportional only");
    expect(a.items.every((i) => i.confidence <= DERIVED_CONFIDENCE_CEILING)).toBe(true);
  });

  test("derived items stay inside the audio and in order", () => {
    const wav = burstWav([{ loud: true, ms: 300 }, { loud: false, ms: 100 }, { loud: true, ms: 300 }]);
    const { fmt, data } = parseWav(wav);
    const a = deriveAlignment("alpha beta gamma delta", data, fmt);
    let prev = -1;
    for (const it of a.items) {
      expect(it.startMs).toBeGreaterThanOrEqual(prev);
      expect(it.endMs).toBeGreaterThan(it.startMs);
      expect(it.endMs).toBeLessThanOrEqual(700);
      prev = it.startMs;
    }
  });

  test("no text to align is a note, not an exception", () => {
    const { fmt, data } = parseWav(rampWav(100));
    expect(deriveAlignment("   ", data, fmt).note).toBe("no text to align");
  });

  test("tokenizeWords keeps punctuation with its word and reports offsets", () => {
    expect(tokenizeWords("Ship it, now")).toEqual([
      { text: "Ship", start: 0, end: 4 },
      { text: "it,", start: 5, end: 8 },
      { text: "now", start: 9, end: 12 },
    ]);
  });

  test("energy measurement finds the bursts and merges a stop-consonant gap", () => {
    const { fmt, data } = parseWav(burstWav([{ loud: true, ms: 100 }, { loud: false, ms: 40 }, { loud: true, ms: 100 }]));
    const e = frameEnergy(data, fmt);
    expect(e.length).toBeGreaterThan(5);
    expect(speechRuns(e)).toHaveLength(1); // a 40ms gap is below minGapMs, so it is one run
    expect(speechRuns(e, { minGapMs: 20 })).toHaveLength(2);
  });
});

describe("editing operations", () => {
  test("splitItem cuts text and time, and refuses a locked or out-of-range split", () => {
    const { doc } = fixture();
    const split = ok(splitItem(doc, "item-4", 350));
    expect(split.items.map((i) => i.text)).toEqual(["Ship", "it", "on", "Fri", "day"]);
    expect(split.items[3]).toMatchObject({ startMs: 300, endMs: 350 });
    expect(split.items[4]).toMatchObject({ startMs: 350, endMs: 400 });
    expect(splitItem(doc, "item-4", 400).ok).toBe(false);
    expect(refused(splitItem(ok(setItemLock(doc, "item-4", true)), "item-4", 350))).toMatch(/locked/);
  });

  test("trimClip drops the head, keeps the tail's own samples, and re-flows", () => {
    const { doc, sources } = fixture();
    const trimmed = ok(trimClip(doc, "clip-1", { headMs: 50 }));
    expect(validateDoc(trimmed)).toEqual([]);
    expect(docDurationMs(trimmed)).toBe(350);
    expect(trimmed.clips[0]).toMatchObject({ startMs: 0, endMs: 350, srcStartMs: 50 });
    // The first rendered sample is source sample 50 (value 1050), not 1000.
    const out = rendered(trimmed, sources);
    expect(out[0]! | (out[1]! << 8)).toBe(1050);
    expect(refused(trimClip(doc, "clip-1", { headMs: 200, tailMs: 200 }))).toMatch(/no length/);
    expect(refused(trimClip(doc, "nope", { headMs: 1 }))).toMatch(/no clip/);
  });

  test("deleteSpan removes the words, closes the gap, and shifts what followed", () => {
    const { doc, sources } = fixture();
    const cut = ok(deleteSpan(doc, ["item-2"]));
    expect(validateDoc(cut)).toEqual([]);
    expect(cut.items.map((i) => i.text)).toEqual(["Ship", "on", "Friday"]);
    expect(cut.items[1]).toMatchObject({ startMs: 100, endMs: 200 });
    expect(docDurationMs(cut)).toBe(300);
    // The audio is the ramp with samples 100..199 excised.
    const out = rendered(cut, sources);
    expect(out.length).toBe(300 * FRAME);
    expect(out[100 * FRAME]! | (out[100 * FRAME + 1]! << 8)).toBe(1200);
  });

  test("deleteSpan refuses a locked span and refuses to empty the timeline", () => {
    const { doc } = fixture();
    expect(refused(deleteSpan(ok(setItemLock(doc, "item-2", true)), ["item-2"]))).toMatch(/locked/);
    expect(refused(deleteSpan(doc, ["item-1", "item-2", "item-3", "item-4"]))).toMatch(/whole timeline/);
    expect(refused(deleteSpan(doc, []))).toMatch(/nothing selected/);
  });
});

describe("the keystone: a span re-render touches only that span", () => {
  test("replaceSpan swaps the span's audio and leaves every other byte identical", () => {
    const { doc, sources } = fixture();
    const before = rendered(doc, sources);
    sources.set("retake", source(rampWav(150, 50000)));

    const next = ok(replaceSpan(doc, ["item-2"], { sourceId: "retake", durationMs: 150, prompt: "say it warmer" }));
    expect(validateDoc(next)).toEqual([]);
    const after = rendered(next, sources);

    // Head (0..100ms) is byte-identical.
    expect(after.subarray(0, 100 * FRAME)).toEqual(before.subarray(0, 100 * FRAME));
    // Tail (from the new span's end) is the original tail, byte-identical.
    expect(after.subarray(250 * FRAME)).toEqual(before.subarray(200 * FRAME));
    // The span itself is the retake's samples.
    expect(after[100 * FRAME]! | (after[100 * FRAME + 1]! << 8)).toBe(50000);
    expect(after.length).toBe(450 * FRAME);
  });

  test("the replacement clip records its parent and the prompt that produced it", () => {
    const { doc } = fixture();
    const next = ok(replaceSpan(doc, ["item-3"], { sourceId: "retake", durationMs: 100, prompt: "  brighter  " }));
    const fresh = next.clips.find((c) => c.sourceId === "retake");
    expect(fresh?.prompt).toBe("brighter");
    expect(fresh?.parentClipId).toBeTruthy();
    expect(next.clips.every((c) => c.endMs > c.startMs)).toBe(true);
  });

  test("the word map still follows the text after a re-render of a different length", () => {
    const { doc } = fixture();
    const next = ok(replaceSpan(doc, ["item-2"], { sourceId: "retake", durationMs: 300, prompt: "slower" }));
    const texts = next.items.map((i) => i.text);
    expect(texts).toEqual(["Ship", "it", "on", "Friday"]);
    // "it" now covers the longer span, and everything after it shifted by +200ms.
    expect(next.items[1]).toMatchObject({ startMs: 100, endMs: 400 });
    expect(next.items[2]).toMatchObject({ startMs: 400, endMs: 500 });
    expect(next.items[3]).toMatchObject({ startMs: 500, endMs: 600 });
    expect(docDurationMs(next)).toBe(600);
    // Monotonic and gapless: the follow-along highlight can never land between two words.
    for (let i = 1; i < next.items.length; i++) expect(next.items[i]!.startMs).toBe(next.items[i - 1]!.endMs);
  });

  test("a re-render refuses without a prompt, a duration, or a live selection", () => {
    const { doc } = fixture();
    expect(refused(replaceSpan(doc, ["item-2"], { sourceId: "retake", durationMs: 100, prompt: "  " }))).toMatch(/prompt/);
    expect(refused(replaceSpan(doc, ["item-2"], { sourceId: "retake", durationMs: 0, prompt: "x" }))).toMatch(/duration/);
    expect(refused(replaceSpan(doc, ["item-2"], { sourceId: "", durationMs: 10, prompt: "x" }))).toMatch(/source id/);
    expect(refused(replaceSpan(doc, [], { sourceId: "retake", durationMs: 10, prompt: "x" }))).toMatch(/nothing selected/);
    expect(refused(replaceSpan(ok(setItemLock(doc, "item-2", true)), ["item-2"], { sourceId: "r", durationMs: 10, prompt: "x" }))).toMatch(/locked/);
  });
});

describe("dragging a span", () => {
  test("moveSpan reorders the audio and carries its words with it", () => {
    const { doc, sources } = fixture();
    const moved = ok(moveSpan(doc, ["item-4"], 0)); // drag "Friday" to the front
    expect(validateDoc(moved)).toEqual([]);
    expect(docDurationMs(moved)).toBe(400);
    const out = rendered(moved, sources);
    // First 100ms is now source samples 300..399 (values 1300+).
    expect(out[0]! | (out[1]! << 8)).toBe(1300);
    // Then the original head follows.
    expect(out[100 * FRAME]! | (out[100 * FRAME + 1]! << 8)).toBe(1000);
    const byTime = [...moved.items].sort((a, b) => a.startMs - b.startMs).map((i) => i.text);
    expect(byTime).toEqual(["Friday", "Ship", "it", "on"]);
  });

  test("moving a span later shifts what it passed over earlier", () => {
    const { doc } = fixture();
    const moved = ok(moveSpan(doc, ["item-1"], 400)); // "Ship" to the end
    const byTime = [...moved.items].sort((a, b) => a.startMs - b.startMs).map((i) => i.text);
    expect(byTime).toEqual(["it", "on", "Friday", "Ship"]);
    expect(moved.items.find((i) => i.text === "Ship")).toMatchObject({ startMs: 300, endMs: 400 });
  });

  test("a span refuses to be dropped inside itself, and a locked word will not travel", () => {
    const { doc } = fixture();
    expect(refused(moveSpan(doc, ["item-2", "item-3"], 150))).toMatch(/inside itself/);
    expect(refused(moveSpan(ok(setItemLock(doc, "item-2", true)), ["item-2"], 0))).toMatch(/locked/);
    expect(refused(moveSpan(doc, [], 0))).toMatch(/nothing selected/);
  });

  test("a move is length-preserving: the same bytes, reordered", () => {
    const { doc, sources } = fixture();
    const before = rendered(doc, sources);
    const after = rendered(ok(moveSpan(doc, ["item-2"], 400)), sources);
    expect(after.length).toBe(before.length);
    const sum = (b: Uint8Array): number => b.reduce((n, v) => n + v, 0);
    expect(sum(after)).toBe(sum(before));
  });
});

describe("lockToText", () => {
  test("words are redistributed across the current audio, weighted by their length", () => {
    const { doc } = fixture();
    const shrunk = ok(trimClip(doc, "clip-1", { tailMs: 200 })); // 200ms of audio, 4 words
    const bound = ok(lockToText(shrunk));
    expect(bound.items[0]!.startMs).toBe(0);
    expect(bound.items[bound.items.length - 1]!.endMs).toBeLessThanOrEqual(docDurationMs(bound));
    for (let i = 1; i < bound.items.length; i++) expect(bound.items[i]!.startMs).toBe(bound.items[i - 1]!.endMs);
    // "Friday" is the longest word, so it gets the longest share.
    const span = (t: string): number => { const it = bound.items.find((x) => x.text === t)!; return it.endMs - it.startMs; };
    expect(span("Friday")).toBeGreaterThan(span("it"));
  });

  test("a locked word keeps its own timing", () => {
    const { doc } = fixture();
    const locked = ok(setItemLock(doc, "item-3", true));
    const bound = ok(lockToText(locked));
    expect(bound.items.find((i) => i.id === "item-3")).toMatchObject({ startMs: 200, endMs: 300 });
  });

  test("provenance survives the rebind", () => {
    const wav = burstWav([{ loud: true, ms: 200 }, { loud: false, ms: 120 }, { loud: true, ms: 200 }]);
    const { fmt, data } = parseWav(wav);
    const a = deriveAlignment("two words", data, fmt);
    const doc = docFromSource({ sourceId: "s", fmt, durationMs: 520, items: a.items });
    const bound = ok(lockToText(doc));
    expect(bound.items.every((i) => i.source === "derived")).toBe(true);
    expect(validateDoc(bound)).toEqual([]);
  });
});

describe("history", () => {
  test("undo restores the previous document exactly, and redo returns", () => {
    const { doc } = fixture();
    let h = newHistory(doc);
    expect(canUndo(h)).toBe(false);
    const edited = ok(deleteSpan(doc, ["item-2"]));
    h = commit(h, edited);
    expect(canUndo(h)).toBe(true);
    h = undo(h);
    expect(h.present).toEqual(doc); // exactly, field for field
    expect(canRedo(h)).toBe(true);
    h = redo(h);
    expect(h.present).toEqual(edited);
  });

  test("undo restores the replaced clip byte-for-byte on re-render", () => {
    const { doc, sources } = fixture();
    sources.set("retake", source(rampWav(150, 50000)));
    const before = rendered(doc, sources);
    let h = newHistory(doc);
    h = commit(h, ok(replaceSpan(doc, ["item-2"], { sourceId: "retake", durationMs: 150, prompt: "warmer" })));
    expect(rendered(h.present, sources)).not.toEqual(before);
    h = undo(h);
    expect(rendered(h.present, sources)).toEqual(before);
  });

  test("a new edit after an undo drops the future, and the past is bounded", () => {
    const { doc } = fixture();
    let h = commit(newHistory(doc), ok(deleteSpan(doc, ["item-2"])));
    h = undo(h);
    h = commit(h, ok(deleteSpan(doc, ["item-3"])));
    expect(canRedo(h)).toBe(false);
    for (let i = 0; i < 80; i++) h = commit(h, h.present);
    expect(h.past.length).toBeLessThanOrEqual(50);
    // Undo at the bottom of an empty stack is a no-op, not a crash.
    let empty = newHistory(doc);
    expect(undo(empty)).toBe(empty);
    expect(redo(empty)).toBe(empty);
  });
});

describe("render", () => {
  test("the same document renders byte-identical audio twice", () => {
    const { doc, sources } = fixture();
    const a = renderTimeline(doc, sources);
    const b = renderTimeline(doc, sources);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.wav).toEqual(b.wav);
  });

  test("a missing source refuses the render instead of substituting silence", () => {
    const { doc } = fixture();
    expect(refused(renderTimeline(doc, new Map()))).toMatch(/needs source "take-1"/);
  });

  test("a format mismatch is named with both formats", () => {
    const { doc } = fixture();
    const wrong = buildWav({ channels: 2, sampleRate: 48000, bitsPerSample: 16 }, new Uint8Array(800));
    expect(refused(renderTimeline(doc, new Map([["take-1", source(wrong)]])))).toContain("48000Hz/2ch");
  });

  test("a silence clip renders zeroed frames", () => {
    const { doc, sources } = fixture();
    const withGap: TimelineDoc = {
      ...doc,
      clips: [...doc.clips, { id: "clip-2", startMs: 400, endMs: 500, sourceId: SILENCE_SOURCE, srcStartMs: 0, gain: 1 }],
    };
    const out = rendered(withGap, sources);
    expect(out.length).toBe(500 * FRAME);
    expect([...out.subarray(400 * FRAME)].every((b) => b === 0)).toBe(true);
  });

  test("gain scales the samples and clamps at full scale", () => {
    const doc = docFromSource({ sourceId: "s", fmt: FMT, durationMs: 4, items: [] });
    const loud: TimelineDoc = { ...doc, clips: [{ ...doc.clips[0]!, gain: 2 }] };
    const data = new Uint8Array(4 * FRAME);
    const put = (i: number, v: number): void => { const u = v < 0 ? v + 0x10000 : v; data[i * FRAME] = u & 0xff; data[i * FRAME + 1] = (u >> 8) & 0xff; };
    put(0, 1000); put(1, -1000); put(2, 20000); put(3, -20000);
    const out = rendered(loud, new Map([["s", { fmt: FMT, data }]]));
    const read = (i: number): number => { const raw = out[i * FRAME]! | (out[i * FRAME + 1]! << 8); return (raw & 0x8000) ? raw - 0x10000 : raw; };
    expect(read(0)).toBe(2000);
    expect(read(1)).toBe(-2000);
    expect(read(2)).toBe(32767);  // clamped, never wrapped
    expect(read(3)).toBe(-32768);
  });

  test("a source shorter than its clip pads with silence rather than reading past the end", () => {
    const doc = docFromSource({ sourceId: "s", fmt: FMT, durationMs: 100, items: [] });
    const out = rendered(doc, new Map([["s", source(rampWav(40, 7))]]));
    expect(out.length).toBe(100 * FRAME);
    expect([...out.subarray(40 * FRAME)].every((b) => b === 0)).toBe(true);
  });

  test("an unrenderable document is refused with the structural reason", () => {
    const { doc, sources } = fixture();
    const broken: TimelineDoc = { ...doc, bitsPerSample: 24 };
    expect(refused(renderTimeline(broken, sources))).toMatch(/only 16-bit PCM/);
  });

  test("durationOfWav reads the real length from the header", () => {
    const d = durationOfWav(rampWav(1500));
    expect(d.durationMs).toBe(1500);
    expect(d.fmt).toEqual(FMT);
  });
});

describe("waveform", () => {
  test("peaks are bucketed 0..1 and follow the audio's real shape", () => {
    const wav = burstWav([{ loud: false, ms: 100 }, { loud: true, ms: 100 }]);
    const { fmt, data } = parseWav(wav);
    const peaks = waveformPeaks(data, fmt, 4);
    expect(peaks).toHaveLength(4);
    expect(peaks[0]).toBe(0);
    expect(peaks[3]!).toBeGreaterThan(0.3);
    expect(Math.max(...peaks)).toBeLessThanOrEqual(1);
  });

  test("empty audio yields a flat strip instead of throwing", () => {
    expect(waveformPeaks(new Uint8Array(0), FMT, 3)).toEqual([0, 0, 0]);
  });
});
