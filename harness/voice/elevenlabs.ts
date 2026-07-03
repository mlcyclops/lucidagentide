// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/voice/elevenlabs.ts
//
// P-VOICE.1 (ADR-0115): ElevenLabs voice backends behind the SAME seams as the local/OpenAI adapters -
// a `PodcastBackend` (TTS, ADR-0071) and a `TranscriptionBackend` (STT, ADR-0073). ElevenLabs is a CLOUD
// REST API (xi-api-key), so this is a pure TypeScript `fetch` client - it adds ZERO install bloat (no SDK,
// no bundled binary), exactly like the OpenAI TTS/STT clients. Because it is cloud (audio leaves the host),
// it is the PERSONAL-user path; the DoD / air-gap path stays the self-hosted OpenAI-compatible Whisper /
// Kokoro adapters. Nothing here is gov-routable.
//
// Testable by construction: the HTTP transport is INJECTABLE (`fetchImpl`), and the PCM→WAV wrap reuses the
// pure helpers in tts_backend.ts. Fail-safe throughout: a synth/transcribe error degrades to a note (TTS)
// or empty text (STT), never a throw - a broken key/endpoint can't crash the composer or the brief.

import type { PodcastBackend, PodcastScript, PodcastResult } from "../brief/engineering_update.ts";
import { buildWav, concatWav } from "../brief/tts_backend.ts";
import type { TranscriptionBackend, TranscriptionResult, TranscribeOptions } from "./transcription.ts";

const ELEVEN_BASE = "https://api.elevenlabs.io";

// ElevenLabs models (2026): turbo v2.5 = fast + cheap (the default), multilingual v2 = highest quality,
// flash v2.5 = lowest latency. Scribe v1 is the STT model.
export const ELEVEN_TTS_MODEL_DEFAULT = "eleven_turbo_v2_5";
export const ELEVEN_STT_MODEL_DEFAULT = "scribe_v1";
// A neutral default voice id (ElevenLabs "Rachel", present on every account) so TTS works before the user
// picks one. The picker overrides it; favorites/selection are persisted GUI-side.
export const ELEVEN_DEFAULT_VOICE = "21m00Tcm4TlvDq8ikWAM";

export interface ElevenVoice {
  voiceId: string;
  name: string;
  category?: string;         // "premade" | "cloned" | "professional" | "generated" | …
  description?: string;
  previewUrl?: string;
  labels?: Record<string, string>;
}

/** Parse ElevenLabs' `GET /v1/voices` payload into our compact shape. Pure + defensive (a shape change
 *  never throws; unknown entries are dropped). Exported for unit tests. */
export function parseElevenVoices(payload: unknown): ElevenVoice[] {
  const arr = (payload as { voices?: unknown } | null)?.voices;
  if (!Array.isArray(arr)) return [];
  const out: ElevenVoice[] = [];
  for (const v of arr) {
    const o = v as Record<string, unknown>;
    const voiceId = typeof o?.voice_id === "string" ? o.voice_id : "";
    const name = typeof o?.name === "string" ? o.name : "";
    if (!voiceId || !name) continue;
    out.push({
      voiceId,
      name,
      category: typeof o.category === "string" ? o.category : undefined,
      description: typeof o.description === "string" ? o.description : undefined,
      previewUrl: typeof o.preview_url === "string" ? o.preview_url : undefined,
      labels: o.labels && typeof o.labels === "object" ? (o.labels as Record<string, string>) : undefined,
    });
  }
  return out;
}

export interface ElevenClientOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
}

/** Turn a non-2xx ElevenLabs response into an actionable Error that includes the API's own reason
 *  (its `detail.status` / `detail.message`), so a 401 shows WHY — e.g. `invalid_api_key` (bad/typo'd key)
 *  vs `missing_permissions` (a restricted key without Voices/TTS read access). */
async function elevenErr(res: Response, ctx: string): Promise<Error> {
  let detail = res.statusText || "";
  try {
    const txt = await res.text();
    if (txt) {
      try {
        const j = JSON.parse(txt) as { detail?: unknown; message?: unknown };
        const d = j?.detail;
        detail = typeof d === "string" ? d
          : (d && typeof d === "object" ? String((d as Record<string, unknown>).message ?? (d as Record<string, unknown>).status ?? txt)
          : typeof j?.message === "string" ? j.message : txt);
      } catch { detail = txt.slice(0, 160); }
    }
  } catch { /* keep statusText */ }
  return new Error(`ElevenLabs ${ctx} ${res.status}: ${detail}`.slice(0, 220));
}

/** List the account's voices (premade + cloned + favorited-from-library). Throws on a non-2xx so the
 *  caller can surface an actionable error (the picker shows the reason). */
export async function listElevenVoices(opts: ElevenClientOptions): Promise<ElevenVoice[]> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(`${ELEVEN_BASE}/v1/voices`, { headers: { "xi-api-key": opts.apiKey } });
  if (!res.ok) throw await elevenErr(res, "voices");
  return parseElevenVoices(await res.json());
}

export interface ElevenSpeakOptions extends ElevenClientOptions {
  voiceId?: string;
  modelId?: string;
  /** "mp3" (single-clip playback, smaller) or "pcm" (16-bit/24k mono, WAV-wrapped for concatenation). */
  format?: "mp3" | "pcm";
}

/** Synthesize ONE text to audio. Returns WAV for "pcm" (concatenatable) or MP3 for "mp3" (compact single
 *  clip). Throws on a non-2xx (callers wrap in a fail-safe note). */
export async function elevenLabsSpeak(text: string, opts: ElevenSpeakOptions): Promise<{ audio: Uint8Array; mime: string }> {
  const f = opts.fetchImpl ?? fetch;
  const voiceId = opts.voiceId || ELEVEN_DEFAULT_VOICE;
  const pcm = opts.format === "pcm";
  const outputFormat = pcm ? "pcm_24000" : "mp3_44100_128";
  const url = `${ELEVEN_BASE}/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${outputFormat}`;
  const res = await f(url, {
    method: "POST",
    headers: { "xi-api-key": opts.apiKey, "content-type": "application/json", accept: pcm ? "audio/pcm" : "audio/mpeg" },
    body: JSON.stringify({ text, model_id: opts.modelId ?? ELEVEN_TTS_MODEL_DEFAULT }),
  });
  if (!res.ok) throw await elevenErr(res, "TTS");
  const bytes = new Uint8Array(await res.arrayBuffer());
  // Wrap raw 16-bit/24kHz mono PCM as a canonical WAV so it plays + concatenates with the other backends.
  if (pcm) return { audio: buildWav({ channels: 1, sampleRate: 24_000, bitsPerSample: 16 }, bytes), mime: "audio/wav" };
  return { audio: bytes, mime: "audio/mpeg" };
}

export interface ElevenTtsBackendOptions extends ElevenClientOptions {
  modelId?: string;
  /** Per-speaker voice ids for the podcast; `default` covers any speaker not listed. */
  voices?: Record<string, string> & { default?: string };
}

/** The podcast backend (P-BRIEF): one PCM clip per turn, concatenated to a single WAV briefing. */
export class ElevenLabsTtsBackend implements PodcastBackend {
  readonly id = "elevenlabs-tts";
  constructor(private readonly opts: ElevenTtsBackendOptions) {}

  private voiceFor(speaker: string): string {
    const v = this.opts.voices ?? {};
    return v[speaker] ?? v.default ?? ELEVEN_DEFAULT_VOICE;
  }

  async synthesize(script: PodcastScript): Promise<PodcastResult> {
    try {
      const segments: Uint8Array[] = [];
      for (const turn of script.turns) {
        const { audio } = await elevenLabsSpeak(turn.text, {
          apiKey: this.opts.apiKey, fetchImpl: this.opts.fetchImpl,
          voiceId: this.voiceFor(turn.speaker), modelId: this.opts.modelId, format: "pcm",
        });
        segments.push(audio);
      }
      const audio = concatWav(segments);
      return { backendId: this.id, script, audio, note: `synthesized ${segments.length} turn(s) via ElevenLabs → ${audio.length} bytes WAV` };
    } catch (e) {
      return { backendId: this.id, script, note: `ElevenLabs TTS unavailable (${(e as Error)?.message ?? e}); returning script only` };
    }
  }
}

export interface ElevenSttOptions extends ElevenClientOptions {
  modelId?: string;
}

/** ElevenLabs Scribe speech-to-text. Fail-safe: any error returns empty text + a note (never throws) so
 *  the mic never crashes the composer. */
export class ElevenLabsSttBackend implements TranscriptionBackend {
  readonly id = "elevenlabs-stt";
  constructor(private readonly opts: ElevenSttOptions) {}

  async transcribe(audio: Uint8Array, opts: TranscribeOptions = {}): Promise<TranscriptionResult> {
    if (audio.length === 0) return { backendId: this.id, text: "", note: "empty audio - nothing to transcribe" };
    const f = this.opts.fetchImpl ?? fetch;
    try {
      const form = new FormData();
      form.append("file", new Blob([audio.slice()], { type: opts.mimeType ?? "audio/webm" }), "audio");
      form.append("model_id", this.opts.modelId ?? ELEVEN_STT_MODEL_DEFAULT);
      if (opts.language) form.append("language_code", opts.language);
      const res = await f(`${ELEVEN_BASE}/v1/speech-to-text`, { method: "POST", headers: { "xi-api-key": this.opts.apiKey }, body: form });
      if (!res.ok) throw await elevenErr(res, "STT");
      const data = (await res.json()) as { text?: string };
      const text = typeof data.text === "string" ? data.text.trim() : "";
      return { backendId: this.id, text, note: `transcribed ${audio.length} bytes via ElevenLabs Scribe` };
    } catch (e) {
      return { backendId: this.id, text: "", note: `ElevenLabs STT unavailable (${(e as Error)?.message ?? e}); no transcript` };
    }
  }
}
