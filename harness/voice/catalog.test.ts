// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-VOICE.2 (ADR-0246): the voice catalog. The load-bearing behaviour is resolveVoice() — it is what stops a
// voice id from one engine being sent to another when the user switches providers mid-session.

import { expect, test } from "bun:test";
import {
  KOKORO_VOICES, OPENAI_VOICES, TTS_PROVIDERS, defaultVoiceFor, normalizeTtsProvider, resolveVoice,
  ttsEngineStatus, voicesForProvider,
} from "./catalog.ts";

const env = (o: Partial<Parameters<typeof ttsEngineStatus>[1]> = {}) =>
  ({ keySet: false, oauthActive: false, localUp: false, localUrl: "http://localhost:8880", ...o });

test("every engine has a provider row, and only self-hosted Kokoro needs no key", () => {
  expect(TTS_PROVIDERS.map((p) => p.id)).toEqual(["elevenlabs", "openai-tts", "local-tts"]);
  expect(TTS_PROVIDERS.filter((p) => p.keyEnv === null).map((p) => p.id)).toEqual(["local-tts"]);
  expect(TTS_PROVIDERS.filter((p) => p.cloud).map((p) => p.id)).toEqual(["elevenlabs", "openai-tts"]);
  expect(TTS_PROVIDERS.filter((p) => p.liveList).map((p) => p.id)).toEqual(["elevenlabs"]); // only ElevenLabs has a list endpoint
});

test("catalog ids are unique and non-empty", () => {
  for (const list of [OPENAI_VOICES, KOKORO_VOICES]) {
    const ids = list.map((v) => v.voiceId);
    expect(ids.every((id) => id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  }
});

test("normalizeTtsProvider folds anything unknown to the shipped default", () => {
  expect(normalizeTtsProvider("openai-tts")).toBe("openai-tts");
  expect(normalizeTtsProvider("local-tts")).toBe("local-tts");
  expect(normalizeTtsProvider("xai")).toBe("elevenlabs");
  expect(normalizeTtsProvider(undefined)).toBe("elevenlabs");
  expect(normalizeTtsProvider("")).toBe("elevenlabs");
});

test("static lists exist for the fixed-voice engines; ElevenLabs is fetched live", () => {
  expect(voicesForProvider("openai-tts")).toBe(OPENAI_VOICES);
  expect(voicesForProvider("local-tts")).toBe(KOKORO_VOICES);
  expect(voicesForProvider("elevenlabs")).toEqual([]);
});

test("defaults match the ids the TTS callers already hard-coded, so nothing changes sound", () => {
  expect(defaultVoiceFor("openai-tts")).toBe("alloy");
  expect(defaultVoiceFor("local-tts")).toBe("af_heart");
  expect(defaultVoiceFor("elevenlabs")).toBe(""); // the ElevenLabs client owns its own Rachel default
});

test("an engine with its credential is ready and says nothing", () => {
  expect(ttsEngineStatus("elevenlabs", env({ keySet: true }))).toEqual({ ready: true, reason: "" });
  expect(ttsEngineStatus("openai-tts", env({ keySet: true }))).toEqual({ ready: true, reason: "" });
  expect(ttsEngineStatus("local-tts", env({ localUp: true }))).toEqual({ ready: true, reason: "" });
});

test("an OpenAI OAuth-only user is told a subscription can't reach the speech API", () => {
  // The load-bearing case: signed in to ChatGPT, no platform key. "Add your API key" alone reads like a bug
  // to someone who is visibly signed in, so the reason must name the subscription AND the way out.
  const oauthOnly = ttsEngineStatus("openai-tts", env({ oauthActive: true }));
  expect(oauthOnly.ready).toBe(false);
  expect(oauthOnly.reason).toMatch(/ChatGPT sign-in/);
  expect(oauthOnly.reason).toMatch(/platform API key \(sk-/);
  expect(oauthOnly.reason).toMatch(/ElevenLabs \/ Kokoro/); // an escape hatch, not a dead end
  // With no credential at all the message stays short - there is no misconception to correct.
  const nothing = ttsEngineStatus("openai-tts", env());
  expect(nothing.ready).toBe(false);
  expect(nothing.reason).not.toMatch(/ChatGPT sign-in/);
  expect(nothing.reason).toMatch(/OpenAI API key/);
});

test("an OAuth login never counts as a key, and the local engine reports where it looked", () => {
  // An OAuth row must NOT flip readiness — that is exactly the bug: the picker offering a dead engine.
  expect(ttsEngineStatus("elevenlabs", env({ oauthActive: true })).ready).toBe(false);
  expect(ttsEngineStatus("openai-tts", env({ oauthActive: true })).ready).toBe(false);
  // Kokoro needs no key at all — only something listening; the reason names the URL so it is actionable.
  const down = ttsEngineStatus("local-tts", env({ keySet: true, localUrl: "http://localhost:9999" }));
  expect(down.ready).toBe(false);
  expect(down.reason).toContain("http://localhost:9999");
});

test("resolveVoice never leaks a voice id across engines", () => {
  expect(resolveVoice("openai-tts", "nova")).toBe("nova");
  expect(resolveVoice("local-tts", "bm_george")).toBe("bm_george");
  // an ElevenLabs id left over from a provider switch must NOT reach OpenAI/Kokoro
  expect(resolveVoice("openai-tts", "21m00Tcm4TlvDq8ikWAM")).toBe("alloy");
  expect(resolveVoice("local-tts", "nova")).toBe("af_heart");
  // ElevenLabs keeps whatever it is given (its catalog is per-account, unknown here)
  expect(resolveVoice("elevenlabs", "21m00Tcm4TlvDq8ikWAM")).toBe("21m00Tcm4TlvDq8ikWAM");
  // empty / whitespace selection falls back to the engine default
  expect(resolveVoice("openai-tts", "  ")).toBe("alloy");
  expect(resolveVoice("local-tts", null)).toBe("af_heart");
});
