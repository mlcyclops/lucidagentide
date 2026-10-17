// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/voice/whistle.ts
//
// CREATOR-WHISTLE (ADR-0432, decision 2): the Whistle speech model (Cactus Compute, Apache-2.0) running
// INSIDE the engine process through its Emscripten build (needle.js + needle.wasm). This module is pure
// apart from one `createRequire` of the glue: it reads NO process.env, opens NO socket, and never lets
// the glue fetch anything, because the caller hands it the verified `needle.wasm` bytes as `wasmBinary`
// and the verified `whistle.cact` bytes for `needle_load`. The model is process-global and not
// thread-safe (needle.h), so the engine owns it from exactly one Bun Worker (whistle_worker.ts); this
// class is what that worker runs, and what a test may run in-process.
//
// The model takes 16 kHz mono float PCM in [-1, 1] and at most 30 s per call. `windowPcm` cuts longer
// audio at the quietest 20 ms hop inside the last 5 s of each 30 s candidate, so a word is never split
// across two calls; `transcribe` offsets each window's word times by its start and concatenates.

import { createRequire } from "node:module";

export const WHISTLE_SAMPLE_RATE = 16000;
export const WHISTLE_WINDOW_MS = 30000;
export const WHISTLE_CUT_SEARCH_MS = 5000;
export const WHISTLE_LANGUAGES: readonly string[] = ["en", "de", "fr", "es", "it", "nl", "pl"];

/** The RMS hop the window cut is searched over (20 ms). */
const CUT_HOP_MS = 20;
/** Output JSON capacity handed to needle_transcribe: a 30 s window with word times is a few KB. */
const OUT_CAPACITY = 1 << 18;

export interface WhistleWord { readonly word: string; readonly startMs: number; readonly endMs: number; readonly probability: number }
export interface WhistleTranscript {
  readonly text: string;
  readonly language: string;
  readonly ttftMs: number;
  readonly decodeTps: number;
  readonly words: readonly WhistleWord[];
  readonly windows: number;
}
export interface WhistleOptions {
  readonly language?: string;
  readonly keywords?: readonly string[];
  /** Default true. */
  readonly wordTimestamps?: boolean;
}
/** Sample indices [start, end) into the PCM handed to `transcribe`. */
export interface WhistleWindow { readonly start: number; readonly end: number }
export interface WhistleLoadInput { readonly gluePath: string; readonly wasm: Uint8Array; readonly cact: Uint8Array }

/** Unsupported language -> named refusal; undefined or empty means "detect" and is admitted. */
export function whistleLanguageRefusal(language: string | undefined): string | null {
  if (language === undefined || language === "") return null;
  if (WHISTLE_LANGUAGES.includes(language)) return null;
  return `Whistle supports ${WHISTLE_LANGUAGES.join(", ")}; got "${language}"`;
}

/** Cut audio longer than one window into windows of at most `windowMs`. For every window that is not
 *  the last, the cut is the START of the quietest `CUT_HOP_MS` hop (by RMS) inside the last `searchMs`
 *  of the candidate window, so the cut falls in a pause rather than through a word. The final window
 *  may be short. Empty input gives no windows. */
export function windowPcm(
  pcm: Float32Array,
  sampleRate: number = WHISTLE_SAMPLE_RATE,
  windowMs: number = WHISTLE_WINDOW_MS,
  searchMs: number = WHISTLE_CUT_SEARCH_MS,
): WhistleWindow[] {
  const windows: WhistleWindow[] = [];
  if (pcm.length === 0) return windows;
  const windowSamples = Math.max(1, Math.floor((sampleRate * windowMs) / 1000));
  const searchSamples = Math.min(windowSamples, Math.max(1, Math.floor((sampleRate * searchMs) / 1000)));
  const hop = Math.max(1, Math.min(searchSamples, Math.floor((sampleRate * CUT_HOP_MS) / 1000)));
  let start = 0;
  while (pcm.length - start > windowSamples) {
    const candidateEnd = start + windowSamples;
    const searchStart = candidateEnd - searchSamples;
    let cut = searchStart;
    let quietest = Number.POSITIVE_INFINITY;
    for (let h = searchStart; h + hop <= candidateEnd; h += hop) {
      let energy = 0;
      for (let i = h; i < h + hop; i++) energy += pcm[i]! * pcm[i]!;
      if (energy < quietest) { quietest = energy; cut = h; }
    }
    windows.push({ start, end: cut });
    start = cut;
  }
  windows.push({ start, end: pcm.length });
  return windows;
}

// The Emscripten module surface the spike proved (contract "Spike facts"); only what this file calls.
interface NeedleModule {
  HEAPU8: Uint8Array;
  _malloc(n: number): number;
  _free(p: number): void;
  _needle_load(ptr: number, n: bigint): number;
  _needle_models(): number;
  _needle_last_error(): number;
  _needle_transcribe(pcm: number, samples: number, lang: number, keywords: number, wordTimestamps: number, out: number, cap: number): number;
  UTF8ToString(p: number): string;
}
type CreateNeedle = (opts: Record<string, unknown>) => Promise<NeedleModule>;

const NEEDLE_SPEECH = 2;
const MAX_WINDOW_SAMPLES = (WHISTLE_SAMPLE_RATE * WHISTLE_WINDOW_MS) / 1000;
const utf8 = new TextEncoder();

function isNeedleModule(m: unknown): m is NeedleModule {
  if (!m || typeof m !== "object") return false;
  const r = m as Record<string, unknown>;
  return ["_malloc", "_free", "_needle_load", "_needle_models", "_needle_last_error", "_needle_transcribe", "UTF8ToString"].every((k) => typeof r[k] === "function")
    && r.HEAPU8 instanceof Uint8Array;
}

function numberField(r: Record<string, unknown>, key: string): number {
  const v = r[key];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Parse needle_transcribe's JSON (seconds) into the millisecond transcript shape; a malformed body is a
 *  named failure, never an empty "ok". */
function parseTranscriptJson(json: string): WhistleTranscript {
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch (e) { throw new Error(`Whistle returned malformed JSON: ${e instanceof Error ? e.message : String(e)}`); }
  if (!parsed || typeof parsed !== "object") throw new Error("Whistle returned a non-object transcript");
  const r = parsed as Record<string, unknown>;
  const text = typeof r.text === "string" ? r.text.trim() : "";
  const language = typeof r.language === "string" ? r.language : "";
  const words: WhistleWord[] = [];
  if (Array.isArray(r.words)) {
    for (const w of r.words) {
      if (!w || typeof w !== "object") continue;
      const wr = w as Record<string, unknown>;
      const word = typeof wr.word === "string" ? wr.word.trim() : "";
      if (!word) continue;
      words.push({
        word,
        startMs: Math.round(numberField(wr, "start") * 1000),
        endMs: Math.round(numberField(wr, "end") * 1000),
        probability: numberField(wr, "probability"),
      });
    }
  }
  return { text, language, ttftMs: numberField(r, "ttft_ms"), decodeTps: numberField(r, "decode_tps"), words, windows: 1 };
}

export class WhistleEngine {
  private constructor(private readonly m: NeedleModule) {}

  /** Instantiate the glue with the verified wasm bytes (never a fetch) and load the model. Throws an
   *  Error carrying needle_last_error's text when the runtime refuses. */
  static async load(input: WhistleLoadInput): Promise<WhistleEngine> {
    const loaded: unknown = createRequire(import.meta.url)(input.gluePath);
    if (typeof loaded !== "function") throw new Error(`Whistle glue at ${input.gluePath} did not export createNeedle`);
    const createNeedle = loaded as CreateNeedle;
    const stderr: string[] = [];
    const m: unknown = await createNeedle({
      wasmBinary: input.wasm,
      print: () => {},
      printErr: (line: string) => { stderr.push(line); },
    });
    if (!isNeedleModule(m)) throw new Error(`Whistle glue at ${input.gluePath} produced a module without the needle exports`);
    const ptr = m._malloc(input.cact.byteLength);
    if (ptr === 0) throw new Error(`Whistle could not allocate ${input.cact.byteLength} bytes for the model`);
    m.HEAPU8.set(input.cact, ptr);
    const rc = m._needle_load(ptr, BigInt(input.cact.byteLength));
    m._free(ptr);
    if (rc < 0) throw new Error(`needle_load failed: ${m.UTF8ToString(m._needle_last_error())}${stderr.length ? ` (${stderr.join(" | ")})` : ""}`);
    if ((m._needle_models() & NEEDLE_SPEECH) === 0) throw new Error("needle_load did not load a speech model (whistle.cact holds no speech weights)");
    return new WhistleEngine(m);
  }

  private cString(s: string): number {
    const bytes = utf8.encode(s);
    const ptr = this.m._malloc(bytes.byteLength + 1);
    if (ptr === 0) throw new Error("Whistle could not allocate a string");
    this.m.HEAPU8.set(bytes, ptr);
    this.m.HEAPU8[ptr + bytes.byteLength] = 0;
    return ptr;
  }

  /** One needle_transcribe call over at most 30 s of 16 kHz PCM. Throws on a negative rc with the
   *  runtime's reason, on an over-long window, and on an unsupported language. */
  transcribeWindow(pcm16k: Float32Array, opts: WhistleOptions = {}): WhistleTranscript {
    if (pcm16k.length > MAX_WINDOW_SAMPLES) {
      throw new Error(`Whistle window is ${pcm16k.length} samples; at most ${MAX_WINDOW_SAMPLES} (${WHISTLE_WINDOW_MS / 1000} s at ${WHISTLE_SAMPLE_RATE} Hz) per call`);
    }
    const refusal = whistleLanguageRefusal(opts.language);
    if (refusal !== null) throw new Error(refusal);
    const m = this.m;
    const keywords = (opts.keywords ?? []).map((k) => k.trim()).filter((k) => k.length > 0);
    const pcmPtr = m._malloc(pcm16k.length * 4);
    if (pcmPtr === 0 && pcm16k.length > 0) throw new Error(`Whistle could not allocate ${pcm16k.length * 4} bytes of PCM`);
    const langPtr = opts.language ? this.cString(opts.language) : 0;
    const kwPtr = keywords.length > 0 ? this.cString(keywords.join("\n")) : 0;
    const outPtr = m._malloc(OUT_CAPACITY);
    try {
      if (outPtr === 0) throw new Error("Whistle could not allocate the output buffer");
      // Views are taken AFTER every malloc: a heap growth replaces the buffer behind HEAPU8.
      new Float32Array(m.HEAPU8.buffer, pcmPtr, pcm16k.length).set(pcm16k);
      const rc = m._needle_transcribe(pcmPtr, pcm16k.length, langPtr, kwPtr, opts.wordTimestamps === false ? 0 : 1, outPtr, OUT_CAPACITY);
      if (rc < 0) throw new Error(`needle_transcribe failed: ${m.UTF8ToString(m._needle_last_error())}`);
      return parseTranscriptJson(m.UTF8ToString(outPtr));
    } finally {
      m._free(pcmPtr);
      if (langPtr) m._free(langPtr);
      if (kwPtr) m._free(kwPtr);
      if (outPtr) m._free(outPtr);
    }
  }

  /** Any length of 16 kHz PCM: windows via `windowPcm`, each window's word times offset by its start,
   *  words concatenated, texts joined with one space, `windows` = call count, `language` = the first
   *  window that reported one, `ttftMs` = the first window's, `decodeTps` = mean of the windows that
   *  decoded tokens. */
  transcribe(pcm16k: Float32Array, opts: WhistleOptions = {}): WhistleTranscript {
    const windows = windowPcm(pcm16k);
    const texts: string[] = [];
    const words: WhistleWord[] = [];
    let language = "";
    let ttftMs = 0;
    let tpsSum = 0;
    let tpsCount = 0;
    for (let i = 0; i < windows.length; i++) {
      const w = windows[i]!;
      const t = this.transcribeWindow(pcm16k.subarray(w.start, w.end), opts);
      const offsetMs = Math.round((w.start * 1000) / WHISTLE_SAMPLE_RATE);
      if (t.text) texts.push(t.text);
      for (const word of t.words) words.push({ ...word, startMs: word.startMs + offsetMs, endMs: word.endMs + offsetMs });
      if (!language && t.language) language = t.language;
      if (i === 0) ttftMs = t.ttftMs;
      if (t.decodeTps > 0) { tpsSum += t.decodeTps; tpsCount++; }
    }
    return {
      text: texts.join(" "),
      language,
      ttftMs,
      decodeTps: tpsCount > 0 ? tpsSum / tpsCount : 0,
      words,
      windows: windows.length,
    };
  }
}
