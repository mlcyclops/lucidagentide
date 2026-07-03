// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-VOICE.1 (ADR-0115): ElevenLabs backends. Stubbed fetch (no real ElevenLabs) proves voice parsing,
// the PCM→WAV wrap, xi-api-key headers, and FAIL-SAFE degradation (a broken key never throws).

import { expect, test } from "bun:test";
import {
  ElevenLabsSttBackend, ElevenLabsTtsBackend, elevenLabsSpeak, listElevenVoices, parseElevenVoices,
} from "./elevenlabs.ts";
import { parseWav } from "../brief/tts_backend.ts";
import type { PodcastScript } from "../brief/engineering_update.ts";

const okAudio = (bytes: Uint8Array): Response => new Response(bytes, { status: 200 });
const okJson = (b: unknown): Response => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });

test("parseElevenVoices maps voice_id/name and drops junk", () => {
  const v = parseElevenVoices({ voices: [
    { voice_id: "abc", name: "Rachel", category: "premade", labels: { accent: "american" } },
    { voice_id: "", name: "bad" },      // no id → dropped
    { name: "no id" },                   // dropped
    "nonsense",                          // dropped
  ] });
  expect(v).toEqual([{ voiceId: "abc", name: "Rachel", category: "premade", description: undefined, previewUrl: undefined, labels: { accent: "american" } }]);
  expect(parseElevenVoices(null)).toEqual([]);
  expect(parseElevenVoices({})).toEqual([]);
});

test("listElevenVoices sends xi-api-key and returns parsed voices", async () => {
  let sawKey = "";
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    sawKey = (init?.headers as Record<string, string>)?.["xi-api-key"] ?? "";
    return okJson({ voices: [{ voice_id: "v1", name: "Nova" }] });
  }) as unknown as typeof fetch;
  const voices = await listElevenVoices({ apiKey: "xi-123", fetchImpl });
  expect(sawKey).toBe("xi-123");
  expect(voices.map((v) => v.name)).toEqual(["Nova"]);
});

test("elevenLabsSpeak wraps PCM as a valid WAV; mp3 passes through", async () => {
  const pcm = new Uint8Array(48).fill(7); // fake 16-bit PCM payload
  const fetchImpl = (async (url: string) => {
    expect(String(url)).toContain("/v1/text-to-speech/");
    return okAudio(pcm);
  }) as unknown as typeof fetch;
  const wav = await elevenLabsSpeak("hi", { apiKey: "k", voiceId: "v", format: "pcm", fetchImpl });
  expect(wav.mime).toBe("audio/wav");
  const parsed = parseWav(wav.audio); // must be a valid RIFF/WAVE
  expect(parsed.fmt).toEqual({ channels: 1, sampleRate: 24_000, bitsPerSample: 16 });
  const mp3 = await elevenLabsSpeak("hi", { apiKey: "k", format: "mp3", fetchImpl: (async () => okAudio(new Uint8Array([1, 2, 3]))) as unknown as typeof fetch });
  expect(mp3.mime).toBe("audio/mpeg");
});

test("ElevenLabsTtsBackend fail-safes to a script-only note on error", async () => {
  const script: PodcastScript = { title: "t", turns: [{ speaker: "Host", text: "hello" }] };
  const bad = new ElevenLabsTtsBackend({ apiKey: "k", fetchImpl: (async () => new Response("no", { status: 401 })) as unknown as typeof fetch });
  const r = await bad.synthesize(script);
  expect(r.audio).toBeUndefined();
  expect(r.note).toContain("unavailable");
});

test("ElevenLabsSttBackend fail-safes to empty text; empty audio is a no-op", async () => {
  const stt = new ElevenLabsSttBackend({ apiKey: "k", fetchImpl: (async () => new Response("no", { status: 403 })) as unknown as typeof fetch });
  expect((await stt.transcribe(new Uint8Array())).text).toBe("");           // empty audio
  const r = await stt.transcribe(new Uint8Array([1, 2, 3]));                // server error
  expect(r.text).toBe("");
  expect(r.note).toContain("unavailable");
});

test("ElevenLabsSttBackend returns the transcript on success", async () => {
  const stt = new ElevenLabsSttBackend({ apiKey: "k", fetchImpl: (async () => okJson({ text: "  hello world  " })) as unknown as typeof fetch });
  expect((await stt.transcribe(new Uint8Array([1, 2, 3]))).text).toBe("hello world");
});
