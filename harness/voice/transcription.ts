// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/voice/transcription.ts
//
// P-STT.1 (ADR-0073): speech-to-text behind a vendor-agnostic seam — the symmetric mirror of the P-BRIEF.2
// TTS backend (ADR-0071). A `TranscriptionBackend` turns recorded mic audio into text; the first concrete
// backend speaks the OpenAI-compatible `POST {baseUrl}/v1/audio/transcriptions` shape that a SELF-HOSTED
// Whisper server (whisper.cpp / faster-whisper) exposes — so the AIR-GAP default is a local model (no
// cloud account, audio never leaves the host) and it ALSO works against any OpenAI-compatible endpoint.
//
// Adds NO Python (invariant #2): this is a TS HTTP client that talks to a transcription server over HTTP,
// exactly like the Kokoro TTS adapter. The transcript it returns is ordinary USER INPUT — it enters the
// agent through the same scanned path as typed text, so this adds no new trust surface.
//
// Testable by construction: the HTTP transport is INJECTABLE (`fetchImpl`); fail-safe — any error returns
// an EMPTY transcript with a note rather than throwing, so a broken/absent STT endpoint never crashes the
// composer (the user just sees nothing transcribed and can type).

export interface TranscriptionResult {
  backendId: string;
  /** The recognized text (empty string on failure — never throws). */
  text: string;
  note: string;
}

export interface TranscribeOptions {
  /** MIME type of the audio blob (e.g. "audio/webm", "audio/wav"). Default "audio/wav". */
  mimeType?: string;
  /** Optional ISO language hint (e.g. "en") to improve accuracy / skip detection. */
  language?: string;
}

/** The seam every STT vendor implements (local Whisper, a hosted OpenAI-compatible endpoint, …). Callers
 *  only ever see this interface, so the backend swaps without touching the mic UI. */
export interface TranscriptionBackend {
  readonly id: string;
  transcribe(audio: Uint8Array, opts?: TranscribeOptions): Promise<TranscriptionResult>;
}

export interface OpenAiSttOptions {
  /** Base URL of an OpenAI-compatible transcription server (e.g. a self-hosted Whisper at http://host:9000). */
  baseUrl: string;
  /** Optional bearer key (a local Whisper needs none; a hosted endpoint may). */
  apiKey?: string;
  /** Model id the endpoint expects ("whisper-1" for OpenAI; "whisper" / "Systran/faster-whisper-*" locally). */
  model?: string;
  /** Injectable transport for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export class OpenAiCompatibleSttBackend implements TranscriptionBackend {
  readonly id = "openai-stt";
  constructor(private readonly opts: OpenAiSttOptions) {}

  async transcribe(audio: Uint8Array, opts: TranscribeOptions = {}): Promise<TranscriptionResult> {
    if (audio.length === 0) return { backendId: this.id, text: "", note: "empty audio — nothing to transcribe" };
    const f = this.opts.fetchImpl ?? fetch;
    const url = `${this.opts.baseUrl.replace(/\/$/, "")}/v1/audio/transcriptions`;
    try {
      const form = new FormData();
      // a fresh ArrayBuffer copy so a detaching transport can't corrupt the caller's buffer
      form.append("file", new Blob([audio.slice()], { type: opts.mimeType ?? "audio/wav" }), "audio.wav");
      form.append("model", this.opts.model ?? "whisper-1");
      form.append("response_format", "json");
      if (opts.language) form.append("language", opts.language);
      const headers: Record<string, string> = {};
      if (this.opts.apiKey) headers.authorization = `Bearer ${this.opts.apiKey}`; // NB: never set content-type — the runtime sets the multipart boundary
      const res = await f(url, { method: "POST", headers, body: form });
      if (!res.ok) throw new Error(`STT ${res.status} ${res.statusText}`);
      const data = (await res.json()) as { text?: string };
      const text = typeof data.text === "string" ? data.text.trim() : "";
      return { backendId: this.id, text, note: `transcribed ${audio.length} bytes via ${url}` };
    } catch (e) {
      // Fail-safe: never crash the composer on an STT problem — return empty text + the reason.
      return { backendId: this.id, text: "", note: `STT unavailable (${(e as Error)?.message ?? e}); no transcript` };
    }
  }
}
