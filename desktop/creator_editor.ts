// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/creator_editor.ts - CREATOR-2 (ADR-0286): the desktop seam under the follow-along audio editor.
//
// harness/creator/timeline.ts is the whole model and every operation on it, and it is PURE: no IO, no
// clock, no node builtins, so it runs unchanged in the renderer bundle. This file is the ONLY place that
// turns a LIBRARY TRACK into one of those documents and an EDITED DOCUMENT back into a library track.
// The renderer stays a painter; the core stays testable without a disk; the disk lives here.
//
// Three positions this seam takes, and why each one is a refusal rather than a fallback:
//
//   * IT DECODES 16-BIT PCM WAV AND SAYS SO. LUCID ships no transcoder by design (no ffmpeg, no native
//     module, ADR-0286), so an mp3 in the library cannot become a timeline. That is refused BY NAME, with
//     the track's real mime in the message, instead of opening an editor over audio nothing can read.
//   * ALIGNMENT PROVENANCE PASSES THROUGH VERBATIM. `deriveAlignment` already states what was MEASURED
//     (the speech runs) and what was merely DISTRIBUTED (the word boundaries inside a run), so its note is
//     carried into the session word for word. This file never re-words it and never labels a locally
//     derived alignment as a vendor one. With no text at all there is no alignment and the note says that,
//     rather than showing an empty strip the user has to interpret.
//   * A SAVE IS AN APPEND, NEVER AN OVERWRITE. The render goes back through the library's own `addTrack`,
//     so id minting, path confinement, and the append-only ledger stay in ONE place and the edited track
//     keeps its bytes. A source the render needs but cannot resolve refuses the WHOLE save, by id:
//     substituting silence for audio the user asked for would be a lie the rendered file could not admit.

import {
  SILENCE_SOURCE, deriveAlignment, docFromSource, durationOfWav, renderTimeline, validateDoc, waveformPeaks,
  type SourceAudio, type TimelineClip, type TimelineDoc, type TimelineItem,
} from "../harness/creator/timeline.ts";
import type { WavFormat } from "../harness/brief/tts_backend.ts";
import {
  MAX_TRACK_BYTES, addTrack, foldLibrary, libraryAudioDir, libraryLedger,
  type CreatorTrack, type LibraryIo,
} from "./creator_library.ts";

/** The library imports from a PATH (that is what keeps the write confined to a generated destination), but
 *  a render only ever exists in memory. So the editor needs exactly one capability LibraryIo lacks: the
 *  same byte writer the artifact store already uses. Nothing else about the library's IO changes. */
export interface EditorIo extends LibraryIo {
  writeBytes(path: string, bytes: Uint8Array): void;
}

/** The one container the editor decodes. The library accepts seven; the editor is deliberately stricter,
 *  and says which one it is instead of failing later inside a render. */
const WAV_MIME = "audio/wav";

/** Said when the caller supplied no text and the track carries none. The editor is honest that there is
 *  nothing to follow rather than painting an empty word strip. */
export const NO_TEXT_NOTE = "no text supplied, so there is nothing to follow along; paste the words to align them";

export const DEFAULT_PEAK_BUCKETS = 400;
const MIN_PEAK_BUCKETS = 40;
const MAX_PEAK_BUCKETS = 2000;

/** Deciding whether a track can supply a replacement span means decoding its header, and the library's IO
 *  hands back whole files, so the probe is bounded: the newest MAX_SOURCE_PROBES tracks, or
 *  MAX_SOURCE_PROBE_BYTES of audio (measured from the ledger, before anything is read), whichever comes
 *  first. A library larger than that offers its newest tracks and claims nothing about the rest. */
export const MAX_SOURCE_PROBES = 40;
export const MAX_SOURCE_PROBE_BYTES = 256 * 1024 * 1024;

export const MAX_EDIT_TITLE = 200;

/** Wire bounds for an untrusted document. One over the line refuses the whole body: a truncated timeline
 *  would render as audio the user never edited. */
export const MAX_WIRE_ITEMS = 20_000;
export const MAX_WIRE_CLIPS = 4_000;
const MAX_WIRE_TEXT = 400;

const join = (...parts: string[]): string => parts.join("/").replace(/\/{2,}/g, "/");

/** Where a render waits between `renderTimeline` and `addTrack`. Outside the audio directory, so a torn
 *  save can never leave a stray file that looks like a track, and deleted the moment the import returns. */
export const editorStageDir = (base: string): string => join(base, "editor-staging");

// ── the session the UI opens ────────────────────────────────────────────────

/** One library track offered as a replacement source. `durationMs` is null when the file carries no
 *  measurable frames: unknown, never 0. */
export interface EditorSourceView {
  id: string;
  title: string;
  durationMs: number | null;
}

export interface EditorSession {
  trackId: string;
  title: string;
  doc: TimelineDoc;
  /** The alignment provenance line, shown verbatim in the UI. */
  note: string;
  peaks: number[];
  audioB64: string;
  mime: string;
  durationMs: number;
  /** Library track ids usable as replacement sources, newest first. */
  sources: EditorSourceView[];
}

export interface OpenEditorInput {
  trackId: string;
  text?: string;
  buckets?: number;
}

export interface OpenEditorResult {
  ok: boolean;
  error?: string;
  session?: EditorSession;
}

interface TrackWav {
  readonly b64: string;
  readonly fmt: WavFormat;
  readonly data: Uint8Array;
  readonly durationMs: number;
}

type WavRead = { ok: true; wav: TrackWav } | { ok: false; reason: string };

/** Read one library file as base64 (the library's own convention, and what the renderer needs for its blob
 *  URL) and decode it once. The base64 is kept so the caller never re-encodes what it just read. */
function readTrackWav(io: LibraryIo, path: string): WavRead {
  let b64 = "";
  try { b64 = io.readBase64(path); }
  catch { return { ok: false, reason: "a file LUCID could not read" }; }
  try {
    const { fmt, data, durationMs } = durationOfWav(Buffer.from(b64, "base64"));
    if (fmt.bitsPerSample !== 16) return { ok: false, reason: `${fmt.bitsPerSample}-bit` };
    return { ok: true, wav: { b64, fmt, data, durationMs } };
  } catch { return { ok: false, reason: "not a readable RIFF/WAVE file" }; }
}

function clampBuckets(raw: number | undefined): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_PEAK_BUCKETS;
  return Math.max(MIN_PEAK_BUCKETS, Math.min(MAX_PEAK_BUCKETS, Math.round(raw)));
}

/** The tracks a replacement span could actually be rendered from: another WAV in the same format. A track
 *  whose format differs is left OUT rather than offered and refused at save time. */
function renderableSources(io: LibraryIo, base: string, tracks: readonly CreatorTrack[], selfId: string, fmt: WavFormat): EditorSourceView[] {
  const out: EditorSourceView[] = [];
  let probed = 0;
  let budget = MAX_SOURCE_PROBE_BYTES;
  for (const t of tracks) { // foldLibrary is already newest first
    if (t.id === selfId || t.mime !== WAV_MIME) continue;
    if (probed >= MAX_SOURCE_PROBES || t.bytes > budget) break;
    probed++;
    budget -= t.bytes;
    const path = join(libraryAudioDir(base), t.file);
    if (!io.exists(path)) continue;
    const read = readTrackWav(io, path);
    if (!read.ok) continue;
    const f = read.wav.fmt;
    if (f.sampleRate !== fmt.sampleRate || f.channels !== fmt.channels || f.bitsPerSample !== fmt.bitsPerSample) continue;
    out.push({ id: t.id, title: t.title, durationMs: read.wav.durationMs > 0 ? read.wav.durationMs : null });
  }
  return out;
}

/** Open one library track as a timeline document: its audio, its waveform, the words bound to it, and the
 *  provenance of that binding. Every refusal names the track and the property that caused it. */
export function openEditor(io: LibraryIo, base: string, input: OpenEditorInput): OpenEditorResult {
  const trackId = typeof input.trackId === "string" ? input.trackId.trim() : "";
  if (!trackId) return { ok: false, error: "no track id was given" };
  const tracks = foldLibrary(io.readText(libraryLedger(base)));
  const track = tracks.find((t) => t.id === trackId);
  if (!track) return { ok: false, error: `no track ${trackId}` };
  // One phrasing for every "the editor cannot decode this" refusal: the reason is always the track's own
  // property (its mime, its bit depth, its unreadable header), never a vague failure.
  if (track.mime !== WAV_MIME) return { ok: false, error: `the editor works on 16-bit PCM WAV; "${track.title}" is ${track.mime}` };

  const path = join(libraryAudioDir(base), track.file);
  if (!io.exists(path)) return { ok: false, error: `the audio file for "${track.title}" is missing` };
  const read = readTrackWav(io, path);
  if (!read.ok) return { ok: false, error: `the editor works on 16-bit PCM WAV; "${track.title}" is ${read.reason}` };
  const wav = read.wav;

  // The caller's text wins (they are pasting the words they want followed); the track's own lyrics are the
  // fallback, because that is the text the library already holds for this audio.
  const supplied = typeof input.text === "string" ? input.text.trim() : "";
  const text = supplied || track.lyrics.trim();
  const aligned = text ? deriveAlignment(text, wav.data, wav.fmt) : null;

  return {
    ok: true,
    session: {
      trackId: track.id,
      title: track.title,
      doc: docFromSource({ sourceId: track.id, fmt: wav.fmt, durationMs: wav.durationMs, items: aligned?.items ?? [] }),
      note: aligned?.note ?? NO_TEXT_NOTE,
      peaks: waveformPeaks(wav.data, wav.fmt, clampBuckets(input.buckets)),
      audioB64: wav.b64,
      mime: track.mime,
      durationMs: wav.durationMs,
      sources: renderableSources(io, base, tracks, track.id, wav.fmt),
    },
  };
}

// ── saving an edit ──────────────────────────────────────────────────────────

export interface SaveEditInput {
  trackId: string;
  doc: TimelineDoc;
  title: string;
  prompt?: string;
}

export interface SaveEditResult {
  ok: boolean;
  error?: string;
  trackId?: string;
  bytes?: number;
  durationMs?: number;
}

/** Resolve every source the document names to real audio. Fail-closed and by id: `renderTimeline` would
 *  refuse a missing source too, but the user needs to know WHICH track went missing, not that a render
 *  failed. Silence is only ever used where the document explicitly asks for it. */
function collectSources(io: LibraryIo, base: string, tracks: readonly CreatorTrack[], doc: TimelineDoc):
  { ok: true; sources: Map<string, SourceAudio> } | { ok: false; error: string } {
  const byId = new Map(tracks.map((t) => [t.id, t] as const));
  const sources = new Map<string, SourceAudio>();
  for (const clip of doc.clips) {
    const id = clip.sourceId;
    if (id === SILENCE_SOURCE || sources.has(id)) continue;
    const needs = `the timeline needs source "${id}", which`;
    const track = byId.get(id);
    if (!track) return { ok: false, error: `${needs} is not in the library` };
    if (track.mime !== WAV_MIME) return { ok: false, error: `${needs} is ${track.mime}, not 16-bit PCM WAV` };
    const path = join(libraryAudioDir(base), track.file);
    if (!io.exists(path)) return { ok: false, error: `${needs} has no audio file any more` };
    const read = readTrackWav(io, path);
    if (!read.ok) return { ok: false, error: `${needs} is ${read.reason}` };
    const f = read.wav.fmt;
    if (f.sampleRate !== doc.sampleRate || f.channels !== doc.channels || f.bitsPerSample !== doc.bitsPerSample) {
      return {
        ok: false,
        error: `source "${id}" is ${f.sampleRate}Hz/${f.channels}ch/${f.bitsPerSample}-bit, the timeline is ${doc.sampleRate}Hz/${doc.channels}ch/${doc.bitsPerSample}-bit`,
      };
    }
    sources.set(id, { fmt: f, data: read.wav.data });
  }
  return { ok: true, sources };
}

/** Render an edited document and APPEND it to the library as a remix of the track it came from. The parent
 *  keeps its bytes and its ledger row: an edit in LUCID is always a new track, so undo is never needed to
 *  get the original back. */
export function saveEdit(io: EditorIo, base: string, input: SaveEditInput): SaveEditResult {
  const problems = validateDoc(input.doc);
  if (problems.length > 0) return { ok: false, error: `the timeline is not saveable: ${problems[0]}` };

  const tracks = foldLibrary(io.readText(libraryLedger(base)));
  const parent = tracks.find((t) => t.id === input.trackId);
  if (!parent) return { ok: false, error: `no track ${typeof input.trackId === "string" && input.trackId ? input.trackId : "id was given"}` };

  const title = (typeof input.title === "string" ? input.title : "").trim().slice(0, MAX_EDIT_TITLE);
  if (!title) return { ok: false, error: "give the edit a title before saving it" };

  const collected = collectSources(io, base, tracks, input.doc);
  if (!collected.ok) return { ok: false, error: collected.error };

  const rendered = renderTimeline(input.doc, collected.sources);
  if (!rendered.ok) return { ok: false, error: rendered.error };
  if (rendered.bytes > MAX_TRACK_BYTES) {
    return { ok: false, error: `the edit renders to ${Math.round(rendered.bytes / (1024 * 1024))} MB, over the ${Math.round(MAX_TRACK_BYTES / (1024 * 1024))} MB library limit` };
  }

  const stage = join(editorStageDir(base), `${io.id()}.wav`);
  io.ensureDir(editorStageDir(base));
  try { io.writeBytes(stage, rendered.wav); }
  catch { return { ok: false, error: "could not stage the rendered edit for import" }; }

  // The words the document is bound to travel with it, so re-opening the saved edit follows along instead
  // of asking for the text again. They are the document's own items, not a guess about the new audio.
  const added = addTrack(io, base, {
    sourcePath: stage,
    title,
    origin: parent.origin,
    prompt: typeof input.prompt === "string" && input.prompt.trim() ? input.prompt : undefined,
    lyrics: input.doc.items.map((it) => it.text).join(" "),
    tags: parent.tags,
    parentId: parent.id,
    kind: "remix",
  });
  io.removeFile(stage);
  if (!added.ok || !added.track) return { ok: false, error: added.error ?? "the library refused the rendered edit" };

  return { ok: true, trackId: added.track.id, bytes: rendered.bytes, durationMs: durationOfWav(rendered.wav).durationMs };
}

// ── the document on the wire ────────────────────────────────────────────────

/** Narrowing guard, not a cast: after this the fields read as `unknown` and every one of them is still
 *  checked below. */
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

const asNumber = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

const asText = (v: unknown, max: number): string | null => (typeof v === "string" ? v.slice(0, max) : null);

function decodeItem(raw: unknown, at: number): { ok: true; item: TimelineItem } | { ok: false; error: string } {
  const broken = { ok: false, error: `item ${at} in that timeline is not a well-formed word` } as const;
  if (!isObject(raw)) return broken;
  const id = asText(raw.id, 120);
  const text = asText(raw.text, MAX_WIRE_TEXT);
  const startMs = asNumber(raw.startMs);
  const endMs = asNumber(raw.endMs);
  const confidence = asNumber(raw.confidence);
  const source = raw.source;
  const locked = raw.locked;
  if (source !== "vendor" && source !== "derived") return broken;
  if (typeof locked !== "boolean") return broken;
  if (!id || text === null || startMs === null || endMs === null || confidence === null) return broken;
  return { ok: true, item: { id, text, startMs, endMs, confidence, source, locked } };
}

function decodeClip(raw: unknown, at: number): { ok: true; clip: TimelineClip } | { ok: false; error: string } {
  const broken = { ok: false, error: `clip ${at} in that timeline is not a well-formed region` } as const;
  if (!isObject(raw)) return broken;
  const id = asText(raw.id, 120);
  const sourceId = asText(raw.sourceId, 120);
  const startMs = asNumber(raw.startMs);
  const endMs = asNumber(raw.endMs);
  const srcStartMs = asNumber(raw.srcStartMs);
  const gain = asNumber(raw.gain);
  if (!id || !sourceId || startMs === null || endMs === null || srcStartMs === null || gain === null) return broken;
  const parentClipId = asText(raw.parentClipId, 120);
  const prompt = asText(raw.prompt, 4000);
  return {
    ok: true,
    clip: {
      id, sourceId, startMs, endMs, srcStartMs, gain,
      ...(parentClipId ? { parentClipId } : {}),
      ...(prompt ? { prompt } : {}),
    },
  };
}

/** Gate an untrusted timeline off the wire. Fail-closed, like `decodeWireFrames`: one malformed word or
 *  region refuses the body rather than silently saving a shorter edit than the user made. */
export function decodeTimelineDoc(raw: unknown): { ok: true; doc: TimelineDoc } | { ok: false; error: string } {
  if (!isObject(raw)) return { ok: false, error: "that request carried no timeline" };
  const sampleRate = asNumber(raw.sampleRate);
  const channels = asNumber(raw.channels);
  const bitsPerSample = asNumber(raw.bitsPerSample);
  if (sampleRate === null || channels === null || bitsPerSample === null) {
    return { ok: false, error: "that timeline does not declare its audio format" };
  }
  const rawItems = raw.items;
  const rawClips = raw.clips;
  if (!Array.isArray(rawItems) || !Array.isArray(rawClips)) return { ok: false, error: "that timeline has no words or no clips" };
  if (rawItems.length > MAX_WIRE_ITEMS) return { ok: false, error: `that timeline carries ${rawItems.length} words, over the ${MAX_WIRE_ITEMS} limit` };
  if (rawClips.length > MAX_WIRE_CLIPS) return { ok: false, error: `that timeline carries ${rawClips.length} clips, over the ${MAX_WIRE_CLIPS} limit` };

  const items: TimelineItem[] = [];
  for (let i = 0; i < rawItems.length; i++) {
    const r = decodeItem(rawItems[i], i);
    if (!r.ok) return { ok: false, error: r.error };
    items.push(r.item);
  }
  const clips: TimelineClip[] = [];
  for (let i = 0; i < rawClips.length; i++) {
    const r = decodeClip(rawClips[i], i);
    if (!r.ok) return { ok: false, error: r.error };
    clips.push(r.clip);
  }
  return { ok: true, doc: { sampleRate, channels, bitsPerSample, items, clips } };
}
