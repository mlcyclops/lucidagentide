// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/brief/tts_backend.ts
//
// P-BRIEF.2 (ADR-0071): the FIRST concrete PodcastBackend behind the P-BRIEF.1 seam - an
// OpenAI-compatible TTS adapter. It speaks the `POST {baseUrl}/v1/audio/speech` shape that a SELF-HOSTED
// Kokoro server (docker-kokoro) exposes, so it is the AIR-GAP path (no allowlist, no cloud account) and
// also works against any OpenAI-compatible TTS endpoint. It synthesizes each podcast turn with a
// per-speaker voice and concatenates the WAV segments into one briefing.
//
// Why this and not ElevenLabs/NotebookLM first: those are cloud + access-gated (ADR-0070); Kokoro is
// local-first and adds NO Python (invariant #2 - this is a TS HTTP client, not a second Python surface).
//
// Testable by construction: the HTTP transport is INJECTABLE (`fetchImpl`), and the WAV concatenation is
// a PURE function unit-tested without any server. Fail-safe: any synth error degrades to a script-only
// result with a note - the pipeline never hard-fails on a missing/broken TTS endpoint.

import type { PodcastBackend, PodcastScript, PodcastResult } from "./engineering_update.ts";

export interface WavFormat { channels: number; sampleRate: number; bitsPerSample: number }

const u32 = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24);
const u16 = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);
const tag = (b: Uint8Array, o: number) => String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!);

/** Parse a PCM/RIFF WAV into its format + raw sample bytes. Robust to extra chunks (LIST/fact) by
 *  scanning sub-chunks rather than assuming the 44-byte layout. Throws on a non-WAV buffer. */
export function parseWav(bytes: Uint8Array): { fmt: WavFormat; data: Uint8Array } {
  if (bytes.length < 12 || tag(bytes, 0) !== "RIFF" || tag(bytes, 8) !== "WAVE") throw new Error("not a RIFF/WAVE buffer");
  let fmt: WavFormat | null = null;
  let data: Uint8Array | null = null;
  let o = 12;
  while (o + 8 <= bytes.length) {
    const id = tag(bytes, o);
    const size = u32(bytes, o + 4);
    const body = o + 8;
    if (id === "fmt ") fmt = { channels: u16(bytes, body + 2), sampleRate: u32(bytes, body + 4), bitsPerSample: u16(bytes, body + 14) };
    else if (id === "data") data = bytes.subarray(body, body + size);
    o = body + size + (size & 1); // chunks are word-aligned
  }
  if (!fmt || !data) throw new Error("WAV missing fmt/data chunk");
  return { fmt, data };
}

/** Build a canonical 44-byte-header PCM WAV from a format + sample bytes. */
export function buildWav(fmt: WavFormat, data: Uint8Array): Uint8Array {
  const blockAlign = (fmt.channels * fmt.bitsPerSample) >> 3;
  const byteRate = fmt.sampleRate * blockAlign;
  const out = new Uint8Array(44 + data.length);
  const dv = new DataView(out.buffer);
  const ascii = (s: string, o: number) => { for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i); };
  ascii("RIFF", 0); dv.setUint32(4, 36 + data.length, true); ascii("WAVE", 8);
  ascii("fmt ", 12); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
  dv.setUint16(22, fmt.channels, true); dv.setUint32(24, fmt.sampleRate, true);
  dv.setUint32(28, byteRate, true); dv.setUint16(32, blockAlign, true); dv.setUint16(34, fmt.bitsPerSample, true);
  ascii("data", 36); dv.setUint32(40, data.length, true); out.set(data, 44);
  return out;
}

/** Concatenate WAV segments (same format) into one WAV. Pure; the load-bearing audio-stitch step. */
export function concatWav(segments: Uint8Array[]): Uint8Array {
  if (segments.length === 0) throw new Error("concatWav: no segments");
  const parsed = segments.map(parseWav);
  const fmt = parsed[0]!.fmt;
  for (const p of parsed) {
    if (p.fmt.channels !== fmt.channels || p.fmt.sampleRate !== fmt.sampleRate || p.fmt.bitsPerSample !== fmt.bitsPerSample) {
      throw new Error("concatWav: segment format mismatch");
    }
  }
  const total = parsed.reduce((n, p) => n + p.data.length, 0);
  const merged = new Uint8Array(total);
  let off = 0;
  for (const p of parsed) { merged.set(p.data, off); off += p.data.length; }
  return buildWav(fmt, merged);
}

export interface OpenAiTtsOptions {
  /** Base URL of an OpenAI-compatible TTS server (e.g. a self-hosted Kokoro at http://host:8880). */
  baseUrl: string;
  /** Optional bearer key (Kokoro local needs none; a hosted OpenAI-compatible endpoint may). */
  apiKey?: string;
  /** Model id the endpoint expects (Kokoro: "kokoro"; OpenAI: "tts-1"). */
  model?: string;
  /** Per-speaker voice ids; `default` covers any speaker not listed. */
  voices?: Record<string, string> & { default?: string };
  /** Injectable transport for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export class OpenAiCompatibleTtsBackend implements PodcastBackend {
  readonly id = "openai-tts";
  constructor(private readonly opts: OpenAiTtsOptions) {}

  private voiceFor(speaker: string): string {
    const v = this.opts.voices ?? {};
    return v[speaker] ?? v.default ?? "af_heart"; // Kokoro's default voice
  }

  async synthesize(script: PodcastScript): Promise<PodcastResult> {
    const f = this.opts.fetchImpl ?? fetch;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.opts.apiKey) headers.authorization = `Bearer ${this.opts.apiKey}`;
    const url = `${this.opts.baseUrl.replace(/\/$/, "")}/v1/audio/speech`;
    try {
      const segments: Uint8Array[] = [];
      for (const turn of script.turns) {
        const res = await f(url, {
          method: "POST",
          headers,
          body: JSON.stringify({ model: this.opts.model ?? "kokoro", input: turn.text, voice: this.voiceFor(turn.speaker), response_format: "wav" }),
        });
        if (!res.ok) throw new Error(`TTS ${res.status} ${res.statusText}`);
        segments.push(new Uint8Array(await res.arrayBuffer()));
      }
      const audio = concatWav(segments);
      return { backendId: this.id, script, audio, note: `synthesized ${segments.length} turn(s) via ${url} → ${audio.length} bytes WAV` };
    } catch (e) {
      // Fail-safe: never hard-fail the brief on a TTS problem — degrade to script-only with the reason.
      return { backendId: this.id, script, note: `TTS unavailable (${(e as Error)?.message ?? e}); returning script only` };
    }
  }
}
