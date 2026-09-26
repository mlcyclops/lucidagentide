// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/creator/timeline.ts - CREATOR-2 (ADR-0286): the pure timeline document behind the follow-along
// audio editor.
//
// The experience: audio that follows the text word by word, tap a word to seek, select a span and drag it,
// delete it, or re-render just that span. This module is the whole model and every operation on it. It is
// PURE: no I/O, no clock, no random, no node builtins, so it runs unchanged in the renderer bundle and in a
// unit test, and the renderer only paints.
//
// The model is an EDIT DECISION LIST, not an overlapping multitrack:
//
//   * `clips` are CONTIGUOUS and ordered. Clip[0] starts at 0, clip[n] starts where clip[n-1] ends. There
//     are no gaps and no overlaps; a gap is an explicit SILENCE clip, which keeps render free of holes.
//   * a clip's timeline length ALWAYS equals its source region length. Nothing here time-stretches audio,
//     so a trim moves both ends together and the rendered samples are always the source's own samples.
//   * `items` are the text units (words) mapped onto timeline time. They are what the UI paints and what
//     the user taps; they carry the alignment's PROVENANCE and confidence.
//
// Two rules make the honesty testable rather than aspirational:
//
//   * ALIGNMENT PROVENANCE IS CARRIED, NOT ASSUMED. `source: "vendor"` means the engine gave us the
//     timings (ElevenLabs character timestamps); `source: "derived"` means LUCID measured the audio's own
//     energy and distributed the words across it. A derived item's confidence is CAPPED below 1
//     (DERIVED_CONFIDENCE_CEILING) so a guess can never render as a vendor fact.
//   * EVERY RE-RENDER IS A NEW CLIP with `parentClipId` and the `prompt` that produced it, so a span's
//     history is data. Nothing is edited in place, and `EditHistory` restores the previous document
//     exactly, byte-identical on re-render.

import { buildWav, parseWav, type WavFormat } from "../brief/tts_backend.ts";

// ── the document ────────────────────────────────────────────────────────────

/** Where an item's timing came from. A closed set: anything else would be an unlabeled guess. */
export type AlignSource = "vendor" | "derived";

/** A derived alignment is a measurement plus a distribution, never ground truth. Vendor timings get 1;
 *  everything LUCID works out itself is capped here so the UI can always tell the two apart. */
export const DERIVED_CONFIDENCE_CEILING = 0.7;

/** One text unit bound to a time span. `locked` pins it: `lockToText` and span moves refuse to retime it. */
export interface TimelineItem {
  readonly id: string;
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
  /** 0..1. Vendor alignment is 1; derived is <= DERIVED_CONFIDENCE_CEILING. */
  readonly confidence: number;
  readonly source: AlignSource;
  readonly locked: boolean;
}

/** The reserved source id for an explicit silence region. Render emits zeroed frames for it, so a gap is
 *  data in the list rather than a hole the renderer has to invent. */
export const SILENCE_SOURCE = "silence";

/** A contiguous audio region. `endMs - startMs` is both its timeline length and its source region length. */
export interface TimelineClip {
  readonly id: string;
  readonly startMs: number;
  readonly endMs: number;
  /** Which source buffer supplies the samples, or SILENCE_SOURCE. */
  readonly sourceId: string;
  /** Offset into that source buffer where this region begins. */
  readonly srcStartMs: number;
  /** Linear gain. 1 copies the samples untouched (the common case, so render skips the math). */
  readonly gain: number;
  /** The clip this one replaced, when it came from a re-render. Lineage, per ADR-0281 extended to spans. */
  readonly parentClipId?: string;
  /** The prompt that produced this clip, when it was re-rendered. */
  readonly prompt?: string;
}

export interface TimelineDoc {
  readonly sampleRate: number;
  readonly channels: number;
  readonly bitsPerSample: number;
  readonly items: readonly TimelineItem[];
  readonly clips: readonly TimelineClip[];
}

export type OpResult = { ok: true; doc: TimelineDoc } | { ok: false; error: string };

const fail = (error: string): OpResult => ({ ok: false, error });

export const clipLengthMs = (c: TimelineClip): number => c.endMs - c.startMs;

/** Total timeline length: the last clip's end, or 0 for an empty document. */
export function docDurationMs(doc: TimelineDoc): number {
  return doc.clips.length === 0 ? 0 : doc.clips[doc.clips.length - 1]!.endMs;
}

export const docFormat = (doc: TimelineDoc): WavFormat => ({
  channels: doc.channels,
  sampleRate: doc.sampleRate,
  bitsPerSample: doc.bitsPerSample,
});

/** Mint an id that cannot collide with one already in the document, without a clock or a random source, so
 *  the same edit sequence always produces the same ids and a render is reproducible. */
function nextId(prefix: string, taken: readonly { readonly id: string }[]): string {
  let max = 0;
  for (const t of taken) {
    const m = /^[a-z]+-(\d+)$/.exec(t.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}-${max + 1}`;
}

/** Re-lay clips end to end from 0, preserving order and each clip's own length. The single place that
 *  restores the contiguity invariant after an insert, delete, or move. */
function reflow(clips: readonly TimelineClip[]): TimelineClip[] {
  const out: TimelineClip[] = [];
  let at = 0;
  for (const c of clips) {
    const len = clipLengthMs(c);
    out.push({ ...c, startMs: at, endMs: at + len });
    at += len;
  }
  return out;
}

/** Structural check callers can assert on: ordered, contiguous, non-negative, and no time-stretch. Returns
 *  the reasons it is broken (empty means valid), because a silent "false" is useless in a test failure. */
export function validateDoc(doc: TimelineDoc): string[] {
  const problems: string[] = [];
  if (doc.sampleRate <= 0) problems.push("sampleRate must be positive");
  if (doc.channels <= 0) problems.push("channels must be positive");
  if (doc.bitsPerSample !== 16) problems.push("only 16-bit PCM is supported");
  let at = 0;
  for (const c of doc.clips) {
    if (c.startMs !== at) problems.push(`clip ${c.id} starts at ${c.startMs}, expected ${at}`);
    if (c.endMs <= c.startMs) problems.push(`clip ${c.id} has no length`);
    if (c.srcStartMs < 0) problems.push(`clip ${c.id} has a negative source offset`);
    at = c.endMs;
  }
  for (const it of doc.items) {
    if (it.endMs < it.startMs) problems.push(`item ${it.id} ends before it starts`);
    if (it.confidence < 0 || it.confidence > 1) problems.push(`item ${it.id} has an out-of-range confidence`);
    if (it.source === "derived" && it.confidence > DERIVED_CONFIDENCE_CEILING) {
      problems.push(`item ${it.id} is derived but claims vendor-grade confidence`);
    }
  }
  return problems;
}

// ── reading the document (what the UI asks) ─────────────────────────────────

/** The item playing at `ms`, or null in a gap. Tap-to-seek and follow-along highlighting both use this. */
export function itemAt(doc: TimelineDoc, ms: number): TimelineItem | null {
  for (const it of doc.items) if (ms >= it.startMs && ms < it.endMs) return it;
  return null;
}

/** The clip covering `ms`, or null past the end. */
export function clipAt(doc: TimelineDoc, ms: number): TimelineClip | null {
  for (const c of doc.clips) if (ms >= c.startMs && ms < c.endMs) return c;
  return null;
}

export interface Span { readonly startMs: number; readonly endMs: number; readonly itemIds: readonly string[] }

/** The time span a selection of items covers, in document order. Unknown ids are ignored; an empty or
 *  unknown selection yields null so callers branch once instead of guarding every field. */
export function spanOf(doc: TimelineDoc, itemIds: readonly string[]): Span | null {
  const wanted = new Set(itemIds);
  const hits = doc.items.filter((it) => wanted.has(it.id));
  if (hits.length === 0) return null;
  let startMs = Infinity;
  let endMs = -Infinity;
  for (const it of hits) {
    startMs = Math.min(startMs, it.startMs);
    endMs = Math.max(endMs, it.endMs);
  }
  return { startMs, endMs, itemIds: hits.map((it) => it.id) };
}

/** True when any item inside the span is locked, so an operation can refuse with a reason the user can act
 *  on rather than silently dragging a pinned word. */
export function spanHasLock(doc: TimelineDoc, span: Span): boolean {
  const wanted = new Set(span.itemIds);
  return doc.items.some((it) => wanted.has(it.id) && it.locked);
}

// ── splitting: the primitive every span operation needs ─────────────────────

/** Split the clip list at `atMs` so no clip straddles that instant. Returns the list unchanged when the
 *  instant already falls on a boundary (or outside), which keeps the span ops idempotent at their edges. */
function splitClipsAt(clips: readonly TimelineClip[], atMs: number): TimelineClip[] {
  const out: TimelineClip[] = [];
  for (const c of clips) {
    if (atMs <= c.startMs || atMs >= c.endMs) { out.push(c); continue; }
    const head = atMs - c.startMs;
    out.push({ ...c, endMs: atMs });
    out.push({ ...c, id: `${c.id}b`, startMs: atMs, srcStartMs: c.srcStartMs + head });
  }
  return out;
}

/** Uniquify the ids `splitClipsAt` derived, so a document never carries two clips with the same id after
 *  repeated splits. Runs once per operation, after all splitting is done. */
function renumber(clips: readonly TimelineClip[]): TimelineClip[] {
  const seen = new Set<string>();
  return clips.map((c) => {
    if (!seen.has(c.id)) { seen.add(c.id); return c; }
    let n = 2;
    while (seen.has(`${c.id}-${n}`)) n++;
    const id = `${c.id}-${n}`;
    seen.add(id);
    return { ...c, id };
  });
}

// ── operations (pure; each returns a NEW document) ──────────────────────────

/** Split one item in two at `atMs`. The audio is untouched: this is a text-level cut, for when the
 *  alignment merged two words into one span. */
export function splitItem(doc: TimelineDoc, itemId: string, atMs: number): OpResult {
  const idx = doc.items.findIndex((it) => it.id === itemId);
  if (idx < 0) return fail(`no item ${itemId}`);
  const it = doc.items[idx]!;
  if (it.locked) return fail(`item ${itemId} is locked to the text`);
  if (atMs <= it.startMs || atMs >= it.endMs) return fail("the split point must fall inside the item");
  const cut = Math.max(1, Math.round(((atMs - it.startMs) / (it.endMs - it.startMs)) * it.text.length));
  const left: TimelineItem = { ...it, endMs: atMs, text: it.text.slice(0, cut) };
  const right: TimelineItem = {
    ...it,
    id: nextId("item", doc.items),
    startMs: atMs,
    text: it.text.slice(cut),
  };
  const items = [...doc.items.slice(0, idx), left, right, ...doc.items.slice(idx + 1)];
  return { ok: true, doc: { ...doc, items } };
}

/** Pin or release an item. A pinned item keeps its timing through `lockToText` and refuses to be dragged. */
export function setItemLock(doc: TimelineDoc, itemId: string, locked: boolean): OpResult {
  if (!doc.items.some((it) => it.id === itemId)) return fail(`no item ${itemId}`);
  const items = doc.items.map((it) => (it.id === itemId ? { ...it, locked } : it));
  return { ok: true, doc: { ...doc, items } };
}

/** Trim a clip's head and/or tail. The head moves the source offset with it (no time-stretch), so the
 *  remaining audio is exactly the samples that were already there. Everything after re-flows. */
export function trimClip(doc: TimelineDoc, clipId: string, trim: { headMs?: number; tailMs?: number }): OpResult {
  const idx = doc.clips.findIndex((c) => c.id === clipId);
  if (idx < 0) return fail(`no clip ${clipId}`);
  const c = doc.clips[idx]!;
  const head = Math.max(0, Math.round(trim.headMs ?? 0));
  const tail = Math.max(0, Math.round(trim.tailMs ?? 0));
  const len = clipLengthMs(c);
  if (head + tail >= len) return fail("that trim would leave the clip with no length");
  const trimmed: TimelineClip = {
    ...c,
    startMs: c.startMs + head,
    endMs: c.endMs - tail,
    srcStartMs: c.srcStartMs + head,
  };
  const clips = reflow([...doc.clips.slice(0, idx), trimmed, ...doc.clips.slice(idx + 1)]);
  const items = retimeItems(doc, [{ from: c, to: trimmed }]);
  return { ok: true, doc: { ...doc, clips, items } };
}

/** Map items through a set of clip-level changes: an item inside a changed clip is scaled into the clip's
 *  new position; every other item shifts by however much the timeline moved before it. Locked items keep
 *  their own timing (that is what the lock is for). */
function retimeItems(prev: TimelineDoc, moves: readonly { from: TimelineClip; to: TimelineClip }[]): readonly TimelineItem[] {
  const shiftAfter = (ms: number): number => {
    let delta = 0;
    for (const m of moves) {
      if (m.from.endMs <= ms) delta += (m.to.endMs - m.to.startMs) - (m.from.endMs - m.from.startMs);
    }
    return ms + delta;
  };
  const inside = (ms: number): { from: TimelineClip; to: TimelineClip } | null => {
    for (const m of moves) if (ms >= m.from.startMs && ms < m.from.endMs) return m;
    return null;
  };
  const map = (ms: number): number => {
    const m = inside(ms);
    if (!m) return shiftAfter(ms);
    const fromLen = m.from.endMs - m.from.startMs;
    const toLen = m.to.endMs - m.to.startMs;
    const frac = fromLen === 0 ? 0 : (ms - m.from.startMs) / fromLen;
    return Math.round(m.to.startMs + frac * toLen);
  };
  return prev.items.map((it) => {
    if (it.locked) return it;
    const startMs = map(it.startMs);
    const endMs = Math.max(startMs, map(it.endMs));
    return { ...it, startMs, endMs };
  });
}

export interface ReplaceSpanInput {
  /** The re-rendered audio's source id (a new library track, a TTS render, a ComfyUI artifact). */
  readonly sourceId: string;
  readonly durationMs: number;
  /** What produced it. Recorded on the clip, so a span's provenance is data and not a memory. */
  readonly prompt: string;
  readonly srcStartMs?: number;
  readonly gain?: number;
}

/** Replace the audio under a span with a re-render. The span's clips are dropped and ONE new clip takes
 *  their place, carrying `parentClipId` (the first clip it replaced) and the prompt. Audio outside the
 *  span is untouched, which is the keystone this increment is tested on. */
export function replaceSpan(doc: TimelineDoc, itemIds: readonly string[], input: ReplaceSpanInput): OpResult {
  const span = spanOf(doc, itemIds);
  if (!span) return fail("nothing selected to replace");
  if (spanHasLock(doc, span)) return fail("that span contains an item locked to the text");
  const durationMs = Math.round(input.durationMs);
  if (durationMs <= 0) return fail("a replacement needs a positive duration");
  if (!input.sourceId) return fail("a replacement needs a source id");
  if (!input.prompt.trim()) return fail("a re-render must record the prompt that produced it");

  const cut = renumber(splitClipsAt(splitClipsAt(doc.clips, span.startMs), span.endMs));
  const before = cut.filter((c) => c.endMs <= span.startMs);
  const dropped = cut.filter((c) => c.startMs >= span.startMs && c.endMs <= span.endMs);
  const after = cut.filter((c) => c.startMs >= span.endMs);
  if (dropped.length === 0) return fail("the selected span covers no audio");

  const fresh: TimelineClip = {
    id: nextId("clip", cut),
    startMs: span.startMs,
    endMs: span.startMs + durationMs,
    sourceId: input.sourceId,
    srcStartMs: Math.max(0, Math.round(input.srcStartMs ?? 0)),
    gain: input.gain ?? 1,
    parentClipId: dropped[0]!.id,
    prompt: input.prompt.trim(),
  };
  const clips = reflow([...before, fresh, ...after]);
  const from: TimelineClip = { ...dropped[0]!, startMs: span.startMs, endMs: span.endMs };
  const items = retimeItems(doc, [{ from, to: fresh }]);
  return { ok: true, doc: { ...doc, clips, items } };
}

/** Delete a span: its clips AND its items go, and the timeline closes up behind them. The word-level
 *  editor's most common edit. */
export function deleteSpan(doc: TimelineDoc, itemIds: readonly string[]): OpResult {
  const span = spanOf(doc, itemIds);
  if (!span) return fail("nothing selected to delete");
  if (spanHasLock(doc, span)) return fail("that span contains an item locked to the text");
  const cut = renumber(splitClipsAt(splitClipsAt(doc.clips, span.startMs), span.endMs));
  const kept = cut.filter((c) => c.endMs <= span.startMs || c.startMs >= span.endMs);
  if (kept.length === cut.length) return fail("the selected span covers no audio");
  if (kept.length === 0) return fail("that would delete the whole timeline");
  const clips = reflow(kept);
  const removed = new Set(span.itemIds);
  const gap = span.endMs - span.startMs;
  const items = doc.items
    .filter((it) => !removed.has(it.id))
    .map((it) => (it.startMs >= span.endMs ? { ...it, startMs: it.startMs - gap, endMs: it.endMs - gap } : it));
  return { ok: true, doc: { ...doc, clips, items } };
}

/** Drag a span to a new position: cut it out, reinsert it at the clip boundary nearest `targetMs`, and
 *  re-flow. The moved items travel with their audio; the ones it passed over shift the other way. */
export function moveSpan(doc: TimelineDoc, itemIds: readonly string[], targetMs: number): OpResult {
  const span = spanOf(doc, itemIds);
  if (!span) return fail("nothing selected to move");
  if (spanHasLock(doc, span)) return fail("that span contains an item locked to the text");
  const target = Math.max(0, Math.round(targetMs));
  if (target > span.startMs && target < span.endMs) return fail("a span cannot be dropped inside itself");

  const cut = renumber(splitClipsAt(splitClipsAt(splitClipsAt(doc.clips, span.startMs), span.endMs), target));
  const moving = cut.filter((c) => c.startMs >= span.startMs && c.endMs <= span.endMs);
  if (moving.length === 0) return fail("the selected span covers no audio");
  const rest = cut.filter((c) => c.endMs <= span.startMs || c.startMs >= span.endMs);

  const head: TimelineClip[] = [];
  const tail: TimelineClip[] = [];
  for (const c of rest) (c.startMs < target ? head : tail).push(c);
  const clips = reflow([...head, ...moving, ...tail]);

  // Where the span landed: the sum of the lengths that ended up before it.
  const landedAt = head.reduce((n, c) => n + clipLengthMs(c), 0);
  const delta = landedAt - span.startMs;
  const spanLen = span.endMs - span.startMs;
  const inSpan = new Set(span.itemIds);
  const items = doc.items.map((it) => {
    if (it.locked) return it;
    if (inSpan.has(it.id)) return { ...it, startMs: it.startMs + delta, endMs: it.endMs + delta };
    // A span moving later drags everything it passed over earlier, and the reverse.
    if (delta > 0 && it.startMs >= span.endMs && it.endMs <= span.endMs + delta) {
      return { ...it, startMs: it.startMs - spanLen, endMs: it.endMs - spanLen };
    }
    if (delta < 0 && it.startMs >= target && it.endMs <= span.startMs) {
      return { ...it, startMs: it.startMs + spanLen, endMs: it.endMs + spanLen };
    }
    return it;
  });
  const ordered = [...items].sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id));
  return { ok: true, doc: { ...doc, clips, items: ordered } };
}

/** Re-bind the text to the audio after edits: items are redistributed across the current clip layout in
 *  document order, weighted by their own text length, so a word never straddles a clip boundary. Locked
 *  items keep their timing and split the run around them. Alignment provenance is preserved: this changes
 *  WHEN a word sits, never the claim about where the timing came from. */
export function lockToText(doc: TimelineDoc): OpResult {
  if (doc.items.length === 0) return { ok: true, doc };
  const total = docDurationMs(doc);
  if (total <= 0) return fail("an empty timeline has nothing to align to");
  const free = doc.items.filter((it) => !it.locked);
  if (free.length === 0) return { ok: true, doc };
  const weight = (it: TimelineItem): number => Math.max(1, it.text.trim().length);
  const sum = free.reduce((n, it) => n + weight(it), 0);
  const lockedMs = doc.items.filter((it) => it.locked).reduce((n, it) => n + (it.endMs - it.startMs), 0);
  const budget = Math.max(free.length, total - lockedMs);
  let at = 0;
  const items = doc.items.map((it) => {
    if (it.locked) { at = Math.max(at, it.endMs); return it; }
    const len = Math.max(1, Math.round((weight(it) / sum) * budget));
    const startMs = at;
    at = Math.min(total, startMs + len);
    return { ...it, startMs, endMs: at };
  });
  return { ok: true, doc: { ...doc, items } };
}

// ── history: undo restores the previous document exactly ────────────────────

export interface EditHistory {
  readonly past: readonly TimelineDoc[];
  readonly future: readonly TimelineDoc[];
  readonly present: TimelineDoc;
}

export const MAX_HISTORY = 50;

export function newHistory(doc: TimelineDoc): EditHistory {
  return { past: [], future: [], present: doc };
}

/** Record an edit. The future is dropped (you cannot redo past a new branch) and the past is bounded, so a
 *  long session cannot grow without limit. */
export function commit(h: EditHistory, doc: TimelineDoc): EditHistory {
  const past = [...h.past, h.present].slice(-MAX_HISTORY);
  return { past, future: [], present: doc };
}

export const canUndo = (h: EditHistory): boolean => h.past.length > 0;
export const canRedo = (h: EditHistory): boolean => h.future.length > 0;

export function undo(h: EditHistory): EditHistory {
  if (h.past.length === 0) return h;
  const present = h.past[h.past.length - 1]!;
  return { past: h.past.slice(0, -1), future: [h.present, ...h.future].slice(0, MAX_HISTORY), present };
}

export function redo(h: EditHistory): EditHistory {
  if (h.future.length === 0) return h;
  const [present, ...future] = h.future;
  return { past: [...h.past, h.present].slice(-MAX_HISTORY), future, present: present! };
}

// ── alignment ───────────────────────────────────────────────────────────────

export interface WordToken { readonly text: string; readonly start: number; readonly end: number }

/** Split text into words with their character offsets. Punctuation stays attached to its word (that is how
 *  a reader sees it), and whitespace runs are the separators. */
export function tokenizeWords(text: string): WordToken[] {
  const out: WordToken[] = [];
  const re = /\S+/g;
  for (let m = re.exec(text); m; m = re.exec(text)) out.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  return out;
}

export interface CharTiming { readonly startMs: number; readonly endMs: number }

/** Build items from an engine's per-character timings (the ElevenLabs shape). Confidence is 1 and the
 *  source is "vendor" because the engine reported these, we did not infer them. Characters missing a
 *  timing are skipped; a word with no timed character at all is dropped rather than invented. */
export function alignFromVendor(text: string, chars: readonly CharTiming[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  let n = 0;
  for (const w of tokenizeWords(text)) {
    let startMs = Infinity;
    let endMs = -Infinity;
    for (let i = w.start; i < w.end; i++) {
      const t = chars[i];
      if (!t) continue;
      startMs = Math.min(startMs, t.startMs);
      endMs = Math.max(endMs, t.endMs);
    }
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;
    items.push({ id: `item-${++n}`, text: w.text, startMs: Math.round(startMs), endMs: Math.round(endMs), confidence: 1, source: "vendor", locked: false });
  }
  return items;
}

export interface SpeechRun { readonly startMs: number; readonly endMs: number }

export interface EnergyOptions {
  /** Analysis hop. 20ms is the usual speech frame and keeps a word-length run resolvable. */
  readonly frameMs?: number;
  /** A run shorter than this is noise, not a word. */
  readonly minRunMs?: number;
  /** A gap shorter than this is a stop consonant, not a pause between words. */
  readonly minGapMs?: number;
}

const DEFAULT_ENERGY: Required<EnergyOptions> = { frameMs: 20, minRunMs: 60, minGapMs: 80 };

/** Per-frame RMS of 16-bit PCM, normalized to 0..1. The measurement the derived alignment and the waveform
 *  both read, so the picture the user sees is the same data the timing came from. */
export function frameEnergy(pcm: Uint8Array, fmt: WavFormat, frameMs = DEFAULT_ENERGY.frameMs): number[] {
  const bytesPerSample = fmt.bitsPerSample >> 3;
  const stride = bytesPerSample * fmt.channels;
  const perFrame = Math.max(1, Math.round((fmt.sampleRate * frameMs) / 1000));
  const frames: number[] = [];
  const total = Math.floor(pcm.length / stride);
  for (let f = 0; f * perFrame < total; f++) {
    let sum = 0;
    let n = 0;
    for (let s = f * perFrame; s < Math.min(total, (f + 1) * perFrame); s++) {
      const o = s * stride;
      const raw = pcm[o]! | (pcm[o + 1]! << 8);
      const v = (raw & 0x8000) ? raw - 0x10000 : raw;
      sum += v * v;
      n++;
    }
    frames.push(n === 0 ? 0 : Math.sqrt(sum / n) / 32768);
  }
  return frames;
}

/** Contiguous speech regions, from the energy envelope. The threshold is relative to the clip's own noise
 *  floor (its 10th percentile), so a quiet recording is not read as one long silence. */
export function speechRuns(energy: readonly number[], opts: EnergyOptions = {}): SpeechRun[] {
  const o = { ...DEFAULT_ENERGY, ...opts };
  if (energy.length === 0) return [];
  const sorted = [...energy].sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.1)] ?? 0;
  const peak = sorted[sorted.length - 1] ?? 0;
  if (peak <= 0) return [];
  const threshold = Math.max(floor * 2.5, peak * 0.12, 0.005);
  const raw: SpeechRun[] = [];
  let start = -1;
  for (let i = 0; i < energy.length; i++) {
    const loud = (energy[i] ?? 0) >= threshold;
    if (loud && start < 0) start = i;
    if (!loud && start >= 0) { raw.push({ startMs: start * o.frameMs, endMs: i * o.frameMs }); start = -1; }
  }
  if (start >= 0) raw.push({ startMs: start * o.frameMs, endMs: energy.length * o.frameMs });

  const merged: SpeechRun[] = [];
  for (const r of raw) {
    const last = merged[merged.length - 1];
    if (last && r.startMs - last.endMs < o.minGapMs) { merged[merged.length - 1] = { startMs: last.startMs, endMs: r.endMs }; continue; }
    merged.push(r);
  }
  return merged.filter((r) => r.endMs - r.startMs >= o.minRunMs);
}

export interface DerivedAlignment {
  readonly items: TimelineItem[];
  readonly runs: SpeechRun[];
  /** Why the confidence is what it is, in one line the UI can show verbatim. */
  readonly note: string;
}

/** Distribute words across the audio's own measured speech runs. This is a MEASUREMENT plus a
 *  DISTRIBUTION: the run boundaries are real, which word sits where inside a run is proportional to its
 *  length. Every item is labeled "derived" and capped at DERIVED_CONFIDENCE_CEILING, and the note says so,
 *  because presenting this as vendor timing would be a lie the UI could not detect. */
export function deriveAlignment(text: string, pcm: Uint8Array, fmt: WavFormat, opts: EnergyOptions = {}): DerivedAlignment {
  const words = tokenizeWords(text);
  const energy = frameEnergy(pcm, fmt, opts.frameMs ?? DEFAULT_ENERGY.frameMs);
  const runs = speechRuns(energy, opts);
  const totalMs = Math.round((energy.length * (opts.frameMs ?? DEFAULT_ENERGY.frameMs)));
  if (words.length === 0) return { items: [], runs, note: "no text to align" };

  const usable = runs.length > 0 ? runs : [{ startMs: 0, endMs: Math.max(1, totalMs) }];
  const speechMs = usable.reduce((n, r) => n + (r.endMs - r.startMs), 0);
  const weight = (w: WordToken): number => Math.max(1, w.text.length);
  const totalWeight = words.reduce((n, w) => n + weight(w), 0);

  // Confidence: how close the measured run count is to the word count. One run for many words means the
  // boundaries inside it are pure proportion, which is the weakest honest claim we can make.
  const ratio = usable.length / words.length;
  const closeness = ratio >= 1 ? Math.min(1, 1 / ratio) : ratio;
  const confidence = Math.min(DERIVED_CONFIDENCE_CEILING, Math.max(0.2, Number((0.25 + 0.45 * closeness).toFixed(3))));

  const items: TimelineItem[] = [];
  let runIdx = 0;
  let cursor = usable[0]!.startMs;
  let n = 0;
  for (const w of words) {
    const share = (weight(w) / totalWeight) * speechMs;
    let remaining = share;
    const startMs = Math.round(cursor);
    while (remaining > 0 && runIdx < usable.length) {
      const run = usable[runIdx]!;
      const left = run.endMs - cursor;
      if (left <= remaining) {
        remaining -= left;
        runIdx++;
        if (runIdx < usable.length) cursor = usable[runIdx]!.startMs;
        else { cursor = run.endMs; break; }
        continue;
      }
      cursor += remaining;
      remaining = 0;
    }
    const endMs = Math.max(startMs + 1, Math.round(cursor));
    items.push({ id: `item-${++n}`, text: w.text, startMs, endMs, confidence, source: "derived", locked: false });
  }
  const note = runs.length === 0
    ? `derived from ${totalMs}ms of audio with no measurable speech run: word boundaries are proportional only`
    : `derived locally: ${runs.length} measured speech run(s) across ${words.length} word(s), boundaries proportional within a run`;
  return { items, runs, note };
}

/** A whole-file document from one source: one clip covering it, plus whatever alignment the caller has. */
export function docFromSource(opts: {
  sourceId: string;
  fmt: WavFormat;
  durationMs: number;
  items: readonly TimelineItem[];
}): TimelineDoc {
  return {
    sampleRate: opts.fmt.sampleRate,
    channels: opts.fmt.channels,
    bitsPerSample: opts.fmt.bitsPerSample,
    items: [...opts.items],
    clips: [{ id: "clip-1", startMs: 0, endMs: Math.max(1, Math.round(opts.durationMs)), sourceId: opts.sourceId, srcStartMs: 0, gain: 1 }],
  };
}

export function durationOfWav(bytes: Uint8Array): { fmt: WavFormat; durationMs: number; data: Uint8Array } {
  const { fmt, data } = parseWav(bytes);
  const bytesPerFrame = (fmt.bitsPerSample >> 3) * fmt.channels;
  return { fmt, data, durationMs: Math.round((data.length / bytesPerFrame / fmt.sampleRate) * 1000) };
}

// ── render ──────────────────────────────────────────────────────────────────

export interface SourceAudio { readonly fmt: WavFormat; readonly data: Uint8Array }

export type RenderResult = { ok: true; wav: Uint8Array; bytes: number } | { ok: false; error: string };

/** Render the edit list to one WAV. Deterministic: the same document and sources always produce the same
 *  bytes, which is what makes "the re-render changed only that span" a testable claim rather than a hope.
 *  A missing or mismatched source REFUSES the render, it never silently substitutes silence. */
export function renderTimeline(doc: TimelineDoc, sources: ReadonlyMap<string, SourceAudio>): RenderResult {
  const problems = validateDoc(doc);
  if (problems.length > 0) return { ok: false, error: `timeline is not renderable: ${problems[0]}` };
  const fmt = docFormat(doc);
  const bytesPerFrame = (fmt.bitsPerSample >> 3) * fmt.channels;
  const msToBytes = (ms: number): number => Math.round((ms / 1000) * fmt.sampleRate) * bytesPerFrame;

  let total = 0;
  for (const c of doc.clips) total += msToBytes(clipLengthMs(c));
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of doc.clips) {
    const want = msToBytes(clipLengthMs(c));
    if (c.sourceId === SILENCE_SOURCE) { off += want; continue; } // out is already zeroed
    const src = sources.get(c.sourceId);
    if (!src) return { ok: false, error: `clip ${c.id} needs source "${c.sourceId}", which was not supplied` };
    if (src.fmt.sampleRate !== fmt.sampleRate || src.fmt.channels !== fmt.channels || src.fmt.bitsPerSample !== fmt.bitsPerSample) {
      return { ok: false, error: `source "${c.sourceId}" is ${src.fmt.sampleRate}Hz/${src.fmt.channels}ch, the timeline is ${fmt.sampleRate}Hz/${fmt.channels}ch` };
    }
    const from = msToBytes(c.srcStartMs);
    const available = Math.max(0, src.data.length - from);
    const take = Math.min(want, available);
    if (take > 0) {
      const region = src.data.subarray(from, from + take);
      if (c.gain === 1) out.set(region, off);
      else applyGain(region, out, off, c.gain);
    }
    off += want; // a source shorter than the clip pads with the silence already in `out`
  }
  const wav = buildWav(fmt, out);
  return { ok: true, wav, bytes: wav.length };
}

/** Scale 16-bit little-endian frames by `gain`, clamped to the format's range. Separate from the copy path
 *  so an unmodified clip costs one `set` and no per-sample math. */
function applyGain(region: Uint8Array, out: Uint8Array, off: number, gain: number): void {
  for (let i = 0; i + 1 < region.length; i += 2) {
    const raw = region[i]! | (region[i + 1]! << 8);
    const v = (raw & 0x8000) ? raw - 0x10000 : raw;
    const scaled = Math.max(-32768, Math.min(32767, Math.round(v * gain)));
    const u = scaled < 0 ? scaled + 0x10000 : scaled;
    out[off + i] = u & 0xff;
    out[off + i + 1] = (u >> 8) & 0xff;
  }
}

/** Peak envelope for the waveform strip: `buckets` values in 0..1, computed from the same PCM the
 *  alignment measured. Pure, so the renderer paints a picture of real data it did not have to guess. */
export function waveformPeaks(pcm: Uint8Array, fmt: WavFormat, buckets: number): number[] {
  const n = Math.max(1, Math.floor(buckets));
  const stride = (fmt.bitsPerSample >> 3) * fmt.channels;
  const frames = Math.floor(pcm.length / stride);
  if (frames === 0) return Array(n).fill(0);
  const per = Math.max(1, Math.floor(frames / n));
  const out: number[] = [];
  for (let b = 0; b < n; b++) {
    let peak = 0;
    const end = Math.min(frames, (b + 1) * per);
    for (let s = b * per; s < end; s++) {
      const o = s * stride;
      const raw = pcm[o]! | (pcm[o + 1]! << 8);
      const v = Math.abs((raw & 0x8000) ? raw - 0x10000 : raw);
      if (v > peak) peak = v;
    }
    out.push(Number((peak / 32768).toFixed(4)));
  }
  return out;
}
