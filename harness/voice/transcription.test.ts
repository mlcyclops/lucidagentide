// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/voice/transcription.test.ts — the OpenAI-compatible STT backend (P-STT.1, ADR-0073). Asserts the
// multipart request shape (model/language/file), the transcript round-trip, the empty-audio short-circuit,
// and the fail-safe (transport error / non-200 → empty text, never throws).

import { test, expect, describe } from "bun:test";
import { OpenAiCompatibleSttBackend, WhisperCppSttBackend, sttTransportFailed, stripNonSpeech } from "./transcription.ts";

const audio = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

// P-STT.2b: whisper.cpp's whisper-server uses the NATIVE /inference route (verified live), not the OpenAI
// /v1/audio/transcriptions path. This backend posts there and parses { text }.
describe("WhisperCppSttBackend", () => {
  test("posts multipart to /inference and returns the transcript", async () => {
    let seen: { url: string; hasFile: boolean; fmt: unknown } | null = null;
    const fetchImpl = (async (url: string, init: { body: FormData }) => {
      seen = { url, hasFile: init.body.get("file") instanceof Blob, fmt: init.body.get("response_format") };
      return { ok: true, status: 200, statusText: "OK", json: async () => ({ text: " the quick brown fox " }) } as unknown as Response;
    }) as unknown as typeof fetch;
    const be = new WhisperCppSttBackend({ baseUrl: "http://127.0.0.1:9111/", fetchImpl });
    const r = await be.transcribe(audio, { mimeType: "audio/wav" });
    expect(r.backendId).toBe("whisper-cpp");
    expect(r.text).toBe("the quick brown fox"); // trimmed
    expect(seen!.url).toBe("http://127.0.0.1:9111/inference");
    expect(seen!.hasFile).toBe(true);
    expect(seen!.fmt).toBe("json");
  });
  test("empty audio short-circuits (no request)", async () => {
    let called = false;
    const fetchImpl = (async () => { called = true; return {} as Response; }) as unknown as typeof fetch;
    const r = await new WhisperCppSttBackend({ baseUrl: "http://x/", fetchImpl }).transcribe(new Uint8Array(0));
    expect(called).toBe(false);
    expect(r.text).toBe("");
  });
  test("fail-safe: a transport error yields empty text, never throws", async () => {
    const fetchImpl = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const r = await new WhisperCppSttBackend({ baseUrl: "http://down:1/", fetchImpl }).transcribe(audio);
    expect(r.text).toBe("");
    expect(r.note).toMatch(/unavailable|ECONNREFUSED/i);
  });
});

describe("OpenAiCompatibleSttBackend", () => {
  test("posts multipart (model + file + language) and returns the transcript text", async () => {
    let seen: { url: string; model: unknown; lang: unknown; hasFile: boolean; auth?: string } | null = null;
    const fetchImpl = (async (url: string, init: { body: FormData; headers: Record<string, string> }) => {
      const fd = init.body;
      seen = { url, model: fd.get("model"), lang: fd.get("language"), hasFile: fd.get("file") instanceof Blob, auth: init.headers.authorization };
      return { ok: true, status: 200, statusText: "OK", json: async () => ({ text: "  open the goal loop  " }) } as unknown as Response;
    }) as unknown as typeof fetch;

    const be = new OpenAiCompatibleSttBackend({ baseUrl: "http://whisper.local:9000/", model: "whisper", apiKey: "k", fetchImpl });
    const r = await be.transcribe(audio, { language: "en", mimeType: "audio/webm" });

    expect(r.backendId).toBe("openai-stt");
    expect(r.text).toBe("open the goal loop"); // trimmed
    expect(seen!.url).toBe("http://whisper.local:9000/v1/audio/transcriptions");
    expect(seen!.model).toBe("whisper");
    expect(seen!.lang).toBe("en");
    expect(seen!.hasFile).toBe(true);
    expect(seen!.auth).toBe("Bearer k");
  });

  test("empty audio short-circuits without a network call", async () => {
    let called = false;
    const fetchImpl = (async () => { called = true; return {} as Response; }) as unknown as typeof fetch;
    const be = new OpenAiCompatibleSttBackend({ baseUrl: "http://x/", fetchImpl });
    const r = await be.transcribe(new Uint8Array(0));
    expect(called).toBe(false);
    expect(r.text).toBe("");
    expect(r.note).toMatch(/empty audio/i);
  });

  test("fails safe on a transport error: empty text, never throws", async () => {
    const fetchImpl = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const be = new OpenAiCompatibleSttBackend({ baseUrl: "http://down:1/", fetchImpl });
    const r = await be.transcribe(audio);
    expect(r.text).toBe("");
    expect(r.note).toMatch(/unavailable|ECONNREFUSED/i);
  });

  test("fails safe on a non-200 response", async () => {
    const fetchImpl = (async () => ({ ok: false, status: 500, statusText: "Internal Server Error", json: async () => ({}) }) as unknown as Response) as unknown as typeof fetch;
    const be = new OpenAiCompatibleSttBackend({ baseUrl: "http://x/", fetchImpl });
    const r = await be.transcribe(audio);
    expect(r.text).toBe("");
    expect(r.note).toMatch(/500|unavailable/i);
  });

  test("tolerates a response missing the text field", async () => {
    const fetchImpl = (async () => ({ ok: true, status: 200, statusText: "OK", json: async () => ({}) }) as unknown as Response) as unknown as typeof fetch;
    const be = new OpenAiCompatibleSttBackend({ baseUrl: "http://x/", fetchImpl });
    const r = await be.transcribe(audio);
    expect(r.text).toBe("");
  });
});

// P-STT: the /api/transcribe handler tries whisper.cpp's /inference, then falls back to the OpenAI /v1 shape
// ONLY when the first attempt did not reach a working server. This guard is what keeps a healthy whisper.cpp
// that heard SILENCE from being probed on /v1 (which it 404s) and mislabeled "no STT server answered".
describe("sttTransportFailed", () => {
  test("true only when text is empty AND the note says the server was unreachable", () => {
    expect(sttTransportFailed({ backendId: "whisper-cpp", text: "", note: "whisper.cpp STT unavailable (whisper.cpp 400 Bad Request)" })).toBe(true);
    expect(sttTransportFailed({ backendId: "openai-stt", text: "", note: "STT unavailable (fetch failed); no transcript" })).toBe(true);
  });
  test("false for a healthy server that answered with empty text (genuine silence) - no fallback probe", () => {
    expect(sttTransportFailed({ backendId: "whisper-cpp", text: "", note: "transcribed 32000 bytes via http://127.0.0.1:9111/inference" })).toBe(false);
  });
  test("false when a transcript landed, and false for the empty-audio short-circuit", () => {
    expect(sttTransportFailed({ backendId: "whisper-cpp", text: "hello", note: "transcribed 32000 bytes via http://x/inference" })).toBe(false);
    expect(sttTransportFailed({ backendId: "whisper-cpp", text: "", note: "empty audio - nothing to transcribe" })).toBe(false);
  });
});

// Whisper transcribes a NON-SPEECH segment to a placeholder token ("[BLANK_AUDIO]", "[SILENCE]", music
// notes) instead of words; a silent dictation tail must not land that literal text in the composer.
describe("stripNonSpeech", () => {
  test("a pure non-speech clip -> empty string (genuine silence, merges nothing)", () => {
    expect(stripNonSpeech("[BLANK_AUDIO]")).toBe("");
    expect(stripNonSpeech("[ Silence ]")).toBe("");
    expect(stripNonSpeech("\u266a \u266b")).toBe("");
    expect(stripNonSpeech("(upbeat music)")).toBe("");
    expect(stripNonSpeech("[BLANK_AUDIO]\n")).toBe("");
  });
  test("strips a trailing token but keeps the spoken words (the reported case)", () => {
    expect(stripNonSpeech("Testing, testing, can you hear me? [BLANK_AUDIO]")).toBe("Testing, testing, can you hear me?");
    expect(stripNonSpeech("hello [BLANK_AUDIO] world")).toBe("hello world");
  });
  test("leaves real speech untouched, including non-keyword brackets a user might dictate", () => {
    expect(stripNonSpeech("The quick brown fox jumps over the lazy dog.")).toBe("The quick brown fox jumps over the lazy dog.");
    expect(stripNonSpeech("set index a[0] to b")).toBe("set index a[0] to b"); // [0] is not a non-speech keyword
  });
});
