// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/creator_library.ts - CREATOR-0 (ADR-0281): the local song / audio library.
//
// The Suno ask - generate, store locally, list, keep the library updated, remix, re-prompt, listen,
// review, edit - splits cleanly in two. Generation depends on a provider API (and Suno published no
// public self-serve API in 2026, so that half is capability-probed, ADR-0281). EVERYTHING ELSE is local
// and ships now: an append-only ledger of tracks with their prompt, lyrics, tags, rating, review, and
// remix lineage, plus the bytes stored under the Creator data root.
//
// Append-only, like every other GUI-owned ledger in this repo (ai-loc, latency, fleet lanes): a torn tail
// costs one record, never the library. All IO is injected, so the fold + the guards are unit-testable
// without touching a disk.

/** Where a track came from. Provider ids stay in sync with creator_registry's closed set; `local` is a
 *  file the user made or imported themselves. */
export type TrackOrigin = "suno" | "elevenlabs" | "dots-tts" | "comfyui" | "local";
export const TRACK_ORIGINS: readonly TrackOrigin[] = ["suno", "elevenlabs", "dots-tts", "comfyui", "local"] as const;

/** How this track relates to its parent. A remix keeps the audio lineage; a re-prompt keeps the idea. */
export type TrackKind = "original" | "remix" | "reprompt";

export interface CreatorTrack {
  readonly id: string;
  title: string;
  readonly origin: TrackOrigin;
  /** File name inside the library's audio directory. Never a user-supplied path. */
  readonly file: string;
  readonly mime: string;
  readonly bytes: number;
  readonly createdAt: number;
  updatedAt: number;
  /** The prompt that produced it, so a re-prompt starts from the truth instead of memory. */
  prompt: string;
  lyrics: string;
  tags: string[];
  /** 1-5, or null when unrated. */
  rating: number | null;
  review: string;
  readonly parentId: string | null;
  readonly kind: TrackKind;
}

export interface TrackPatch {
  title?: string;
  prompt?: string;
  lyrics?: string;
  tags?: string[];
  rating?: number | null;
  review?: string;
}

export interface LibraryIo {
  ensureDir(dir: string): void;
  /** "" when the file does not exist - a fresh library is an empty fold, not an error. */
  readText(path: string): string;
  appendLine(path: string, line: string): void;
  /** Copy the picked file into the library. Returns its size in bytes. */
  copyIn(src: string, dest: string): number;
  readBase64(path: string): string;
  removeFile(path: string): void;
  exists(path: string): boolean;
  now(): number;
  id(): string;
}

/** Audio containers LUCID will take in. Anything else is refused: the library is not a file dump. */
export const TRACK_MIME: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  flac: "audio/flac",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  m4a: "audio/mp4",
  aac: "audio/aac",
};

export const MAX_TRACK_BYTES = 200 * 1024 * 1024;

const join = (...parts: string[]): string => parts.join("/").replace(/\/{2,}/g, "/");
export const libraryDir = (base: string): string => join(base, "library");
export const libraryLedger = (base: string): string => join(libraryDir(base), "tracks.jsonl");
export const libraryAudioDir = (base: string): string => join(libraryDir(base), "audio");

const clampText = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");

/** Tags are lowercase, trimmed, deduped, and bounded - they are an index, not free prose. */
export function normalizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const t of raw) {
    const v = typeof t === "string" ? t.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 40) : "";
    if (v && !out.includes(v)) out.push(v);
    if (out.length >= 12) break;
  }
  return out;
}

/** Extension of a picked file, lowercased and without the dot; "" when it has none. */
export function extensionOf(path: string): string {
  const base = path.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

interface LedgerRecord {
  op: "add" | "update" | "remove";
  at: number;
  track?: CreatorTrack;
  id?: string;
  patch?: TrackPatch;
}

/** Fold the append-only ledger into the live library. Newest first. A torn or unknown line is skipped:
 *  an append-only file earns a torn tail, and one bad record must never hide the rest. */
export function foldLibrary(jsonl: string): CreatorTrack[] {
  const byId = new Map<string, CreatorTrack>();
  for (const line of (jsonl ?? "").split("\n")) {
    const raw = line.trim();
    if (!raw) continue;
    let rec: LedgerRecord | null = null;
    try { rec = JSON.parse(raw) as LedgerRecord; } catch { continue; }
    if (!rec || typeof rec.op !== "string") continue;
    if (rec.op === "add" && rec.track && typeof rec.track.id === "string") {
      byId.set(rec.track.id, { ...rec.track, tags: normalizeTags(rec.track.tags) });
      continue;
    }
    if (rec.op === "remove" && typeof rec.id === "string") { byId.delete(rec.id); continue; }
    if (rec.op === "update" && typeof rec.id === "string" && rec.patch) {
      const cur = byId.get(rec.id);
      if (!cur) continue;
      byId.set(rec.id, applyPatch(cur, rec.patch, typeof rec.at === "number" ? rec.at : cur.updatedAt));
    }
  }
  return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt);
}

/** Only the editable fields move, each clamped. Identity, bytes, lineage, and mime are immutable. */
export function applyPatch(track: CreatorTrack, patch: TrackPatch, at: number): CreatorTrack {
  const rating = patch.rating === null ? null
    : typeof patch.rating === "number" && Number.isFinite(patch.rating) ? Math.max(1, Math.min(5, Math.round(patch.rating)))
    : track.rating;
  return {
    ...track,
    title: patch.title !== undefined ? clampText(patch.title, 200).trim() || track.title : track.title,
    prompt: patch.prompt !== undefined ? clampText(patch.prompt, 4000) : track.prompt,
    lyrics: patch.lyrics !== undefined ? clampText(patch.lyrics, 20000) : track.lyrics,
    tags: patch.tags !== undefined ? normalizeTags(patch.tags) : track.tags,
    rating,
    review: patch.review !== undefined ? clampText(patch.review, 4000) : track.review,
    updatedAt: at,
  };
}

export interface AddTrackInput {
  /** Absolute path of the file the user picked or a provider wrote. */
  sourcePath: string;
  title?: string;
  origin?: TrackOrigin;
  prompt?: string;
  lyrics?: string;
  tags?: string[];
  /** Set together with `kind` to record lineage. */
  parentId?: string | null;
  kind?: TrackKind;
}

export interface LibraryResult {
  ok: boolean;
  error?: string;
  track?: CreatorTrack;
  tracks?: CreatorTrack[];
}

/** Import a file into the library. The destination is derived from a generated id, so nothing a caller
 *  passes can steer the write out of the audio directory. */
export function addTrack(io: LibraryIo, base: string, input: AddTrackInput): LibraryResult {
  const src = typeof input.sourcePath === "string" ? input.sourcePath.trim() : "";
  if (!src) return { ok: false, error: "Pick an audio file to add." };
  const ext = extensionOf(src);
  const mime = TRACK_MIME[ext];
  if (!mime) return { ok: false, error: `${ext ? `.${ext}` : "That file"} is not an audio container LUCID takes (mp3, wav, flac, ogg, opus, m4a, aac).` };
  if (!io.exists(src)) return { ok: false, error: "That file is not there any more." };
  const origin: TrackOrigin = TRACK_ORIGINS.includes(input.origin as TrackOrigin) ? input.origin as TrackOrigin : "local";
  const kind: TrackKind = input.kind === "remix" || input.kind === "reprompt" ? input.kind : "original";
  const parentId = kind === "original" ? null : (typeof input.parentId === "string" && input.parentId ? input.parentId : null);
  if (kind !== "original" && !parentId) return { ok: false, error: "A remix or re-prompt needs the track it came from." };
  const id = io.id();
  const file = `${id}.${ext}`;
  io.ensureDir(libraryAudioDir(base));
  let bytes = 0;
  try { bytes = io.copyIn(src, join(libraryAudioDir(base), file)); }
  catch { return { ok: false, error: "Could not copy that file into the library." }; }
  if (bytes > MAX_TRACK_BYTES) {
    io.removeFile(join(libraryAudioDir(base), file));
    return { ok: false, error: `That file is larger than the ${Math.round(MAX_TRACK_BYTES / (1024 * 1024))} MB library limit.` };
  }
  const at = io.now();
  const fallbackTitle = (src.replace(/\\/g, "/").split("/").pop() ?? "Untitled").replace(/\.[^.]+$/, "");
  const track: CreatorTrack = {
    id,
    title: clampText(input.title, 200).trim() || fallbackTitle,
    origin,
    file,
    mime,
    bytes,
    createdAt: at,
    updatedAt: at,
    prompt: clampText(input.prompt, 4000),
    lyrics: clampText(input.lyrics, 20000),
    tags: normalizeTags(input.tags),
    rating: null,
    review: "",
    parentId,
    kind,
  };
  io.appendLine(libraryLedger(base), JSON.stringify({ op: "add", at, track }));
  return { ok: true, track };
}

export function updateTrack(io: LibraryIo, base: string, id: string, patch: TrackPatch): LibraryResult {
  const tracks = foldLibrary(io.readText(libraryLedger(base)));
  const cur = tracks.find((t) => t.id === id);
  if (!cur) return { ok: false, error: "That track is not in the library." };
  const at = io.now();
  io.appendLine(libraryLedger(base), JSON.stringify({ op: "update", at, id, patch }));
  return { ok: true, track: applyPatch(cur, patch, at) };
}

export function removeTrack(io: LibraryIo, base: string, id: string): LibraryResult {
  const tracks = foldLibrary(io.readText(libraryLedger(base)));
  const cur = tracks.find((t) => t.id === id);
  if (!cur) return { ok: false, error: "That track is not in the library." };
  io.appendLine(libraryLedger(base), JSON.stringify({ op: "remove", at: io.now(), id }));
  try { io.removeFile(join(libraryAudioDir(base), cur.file)); } catch { /* the ledger is the truth; a stray file is harmless */ }
  return { ok: true, track: cur };
}

/** Playable bytes for one track, base64 like the TTS path (so the renderer builds one blob URL and the
 *  control plane keeps its single JSON shape). */
export function trackAudio(io: LibraryIo, base: string, id: string): { ok: boolean; error?: string; audioB64?: string; mime?: string; title?: string } {
  const cur = foldLibrary(io.readText(libraryLedger(base))).find((t) => t.id === id);
  if (!cur) return { ok: false, error: "That track is not in the library." };
  const path = join(libraryAudioDir(base), cur.file);
  if (!io.exists(path)) return { ok: false, error: "The audio file for that track is missing." };
  try { return { ok: true, audioB64: io.readBase64(path), mime: cur.mime, title: cur.title }; }
  catch { return { ok: false, error: "Could not read that track." }; }
}

/** Oldest ancestor first, ending at `id`. Cycle-safe and bounded. */
export function lineageOf(tracks: readonly CreatorTrack[], id: string): CreatorTrack[] {
  const byId = new Map(tracks.map((t) => [t.id, t] as const));
  const chain: CreatorTrack[] = [];
  const seen = new Set<string>();
  let cur = byId.get(id);
  while (cur && !seen.has(cur.id) && chain.length < 20) {
    seen.add(cur.id);
    chain.unshift(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return chain;
}

export interface LibraryStats {
  tracks: number;
  remixes: number;
  reviewed: number;
  bytes: number;
  origins: Record<string, number>;
}

export function libraryStats(tracks: readonly CreatorTrack[]): LibraryStats {
  const origins: Record<string, number> = {};
  let remixes = 0, reviewed = 0, bytes = 0;
  for (const t of tracks) {
    origins[t.origin] = (origins[t.origin] ?? 0) + 1;
    if (t.kind !== "original") remixes++;
    if (t.review.trim() || t.rating !== null) reviewed++;
    bytes += t.bytes;
  }
  return { tracks: tracks.length, remixes, reviewed, bytes, origins };
}
