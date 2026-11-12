// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/lockdown_route.test.ts
//
// CUI lockdown: the shared routing predicate (models, voice, egress) and the toggle guard. The server clamp,
// the checker filter, the agent-run clamp and the renderer pickers all call these, so a regression here is a
// sovereignty regression everywhere at once.

import { describe, expect, test } from "bun:test";
import {
  enclaveHostSet,
  enclaveProviderSet,
  isLockdownRoutable,
  lockdownEgressExempt,
  lockdownToggleDecision,
  lockdownVoiceVerdict,
  type EnclaveProviderRef,
} from "./lockdown_route.ts";

const DGX: EnclaveProviderRef = { ompProvider: "dgx-spark", enabled: true, enclave: true, baseUrl: "http://10.0.0.21:8000/v1" };
const OLLAMA: EnclaveProviderRef = { ompProvider: "ollama-local", enabled: true, baseUrl: "http://localhost:11434/v1" };
const DGX_OFF: EnclaveProviderRef = { ...DGX, ompProvider: "dgx-off", enabled: false, baseUrl: "http://10.0.0.99:8000/v1" };
const PROVIDERS = [DGX, OLLAMA, DGX_OFF];

describe("enclaveProviderSet", () => {
  test("only enabled AND enclave-attested providers count; a garbled attestation never does", () => {
    const garbled = { ompProvider: "dgx-str", enabled: true, enclave: "true" } as unknown as EnclaveProviderRef;
    expect([...enclaveProviderSet([...PROVIDERS, garbled], false)]).toEqual(["dgx-spark"]);
    expect(enclaveProviderSet(undefined, false).size).toBe(0);
  });
  test("under the ORG-managed lock a user attestation never widens it: no enclave providers, no enclave hosts", () => {
    expect(enclaveProviderSet(PROVIDERS, true).size).toBe(0);
    expect(enclaveHostSet(PROVIDERS, true).size).toBe(0);
    expect(isLockdownRoutable("dgx-spark/glm-5.3-flash", enclaveProviderSet(PROVIDERS, true))).toBe(false);
    expect(isLockdownRoutable("asksage-openai/gpt-5.6-luna", enclaveProviderSet(PROVIDERS, true))).toBe(true);
  });
});

// The truth table the lead asked for: who may carry a turn under the user's lock.
describe("isLockdownRoutable truth table", () => {
  const enclave = enclaveProviderSet(PROVIDERS, false);
  const rows: [label: string, model: string, routable: boolean][] = [
    ["AskSage gov route", "asksage-openai/gpt-5.6-luna", true],
    ["AskSage RAG route", "asksage-query/rag", true],
    ["enabled enclave local provider", "dgx-spark/glm-5.3-flash", true],
    ["non-enclave local provider (loopback Ollama)", "ollama-local/llama3.1:8b", false],
    ["DISABLED enclave provider", "dgx-off/glm-5.3-flash", false],
    ["direct cloud (Anthropic)", "anthropic/claude-opus-4-8", false],
    ["direct cloud (OpenAI Codex)", "openai-codex/gpt-5.5", false],
    ["local id that merely contains 'asksage'", "ollama-local/asksage-clone", false],
    ["bare id with no provider", "glm-5.3-flash", false],
    ["empty", "", false],
  ];
  for (const [label, model, routable] of rows) {
    test(`${label}: ${routable ? "allowed" : "refused"}`, () => expect(isLockdownRoutable(model, enclave)).toBe(routable));
  }
  test("with no enclave providers declared, only AskSage passes", () => {
    expect(isLockdownRoutable("dgx-spark/glm-5.3-flash", new Set())).toBe(false);
    expect(isLockdownRoutable("asksage-openai/gpt-5.6-luna", new Set())).toBe(true);
  });
});

describe("lockdownToggleDecision", () => {
  test("turning lockdown OFF is always allowed", () => {
    expect(lockdownToggleDecision({ enable: false, asksageConfigured: false, providers: [], managedLocked: false })).toEqual({ ok: true });
  });
  test("ON with AskSage configured is allowed", () => {
    expect(lockdownToggleDecision({ enable: true, asksageConfigured: true, providers: [], managedLocked: false }).ok).toBe(true);
  });
  test("ON with no AskSage but an enabled enclave provider is allowed", () => {
    expect(lockdownToggleDecision({ enable: true, asksageConfigured: false, providers: [DGX], managedLocked: false }).ok).toBe(true);
  });
  test("ON with neither (only a plain local box, or a disabled enclave box) is refused, naming both options", () => {
    const d = lockdownToggleDecision({ enable: true, asksageConfigured: false, providers: [OLLAMA, DGX_OFF], managedLocked: false });
    expect(d.ok).toBe(false);
    expect(d.reason).toMatch(/AskSage/);
    expect(d.reason).toMatch(/DGX enclave/);
  });
  test("under the ORG-managed lock an enclave provider does not satisfy the guard; only AskSage does", () => {
    const d = lockdownToggleDecision({ enable: true, asksageConfigured: false, providers: [DGX], managedLocked: true });
    expect(d.ok).toBe(false);
    expect(d.reason).toMatch(/organization/);
    expect(lockdownToggleDecision({ enable: true, asksageConfigured: true, providers: [], managedLocked: true }).ok).toBe(true);
  });
});

describe("lockdownVoiceVerdict", () => {
  const hosts = enclaveHostSet(PROVIDERS, false);
  test("lock off: every engine passes, cloud included", () => {
    expect(lockdownVoiceVerdict(false, "tts", "elevenlabs", undefined, hosts).allowed).toBe(true);
  });
  test("lock on: ElevenLabs TTS, OpenAI TTS and ElevenLabs STT are refused with a specific reason", () => {
    const el = lockdownVoiceVerdict(true, "tts", "elevenlabs", undefined, hosts);
    expect(el.allowed).toBe(false);
    expect(el.reason).toMatch(/ElevenLabs.*not CUI-authorized/);
    const oa = lockdownVoiceVerdict(true, "tts", "openai-tts", "https://api.openai.com", hosts);
    expect(oa.allowed).toBe(false);
    expect(oa.reason).toMatch(/OpenAI TTS/);
    const scribe = lockdownVoiceVerdict(true, "stt", "elevenlabs", undefined, hosts);
    expect(scribe.allowed).toBe(false);
    expect(scribe.reason).toMatch(/audio/);
    expect(scribe.reason).toMatch(/Whisper/);
  });
  test("lock on: loopback Whisper / Kokoro and an enclave-host dots.tts still work", () => {
    expect(lockdownVoiceVerdict(true, "stt", "whisper", "http://localhost:9000", hosts).allowed).toBe(true);
    expect(lockdownVoiceVerdict(true, "tts", "local-tts", "http://127.0.0.1:8880", hosts).allowed).toBe(true);
    expect(lockdownVoiceVerdict(true, "tts", "dots-tts", "http://10.0.0.21:8084", hosts).allowed).toBe(true);
    expect(lockdownVoiceVerdict(true, "tts", "dots-tts", "http://[::1]:8084", hosts).allowed).toBe(true);
  });
  test("lock on: Whistle runs in-process with no URL at all, so it is allowed by construction (ADR-0432)", () => {
    expect(lockdownVoiceVerdict(true, "stt", "whistle", undefined, hosts)).toEqual({ allowed: true, reason: "" });
  });
  test("lock on: a local engine pointed at a public host, or an unknown engine, is refused (fail-closed)", () => {
    expect(lockdownVoiceVerdict(true, "stt", "whisper", "https://stt.example.com", hosts).allowed).toBe(false);
    expect(lockdownVoiceVerdict(true, "stt", "whisper", "not a url", hosts).allowed).toBe(false);
    expect(lockdownVoiceVerdict(true, "tts", "mystery-tts", "http://localhost:1", hosts).allowed).toBe(false);
  });
});

describe("lockdownEgressExempt", () => {
  const hosts = enclaveHostSet(PROVIDERS, false);
  test("under the ORG-managed lock only loopback is exempt (the enclave host is not)", () => {
    const managed = enclaveHostSet(PROVIDERS, true);
    expect(lockdownEgressExempt("http://127.0.0.1:8088/health", managed)).toBe(true);
    expect(lockdownEgressExempt("http://10.0.0.21:8000/v1/models", managed)).toBe(false);
  });
  test("loopback and enabled enclave hosts are not public egress", () => {
    expect(lockdownEgressExempt("http://localhost:5173/", hosts)).toBe(true);
    expect(lockdownEgressExempt("http://127.0.0.1:8088/health", hosts)).toBe(true);
    expect(lockdownEgressExempt("http://10.0.0.21:8000/v1/models", hosts)).toBe(true);
  });
  test("public hosts, a disabled enclave host, a non-enclave LAN host and non-URL targets stay blocked", () => {
    expect(lockdownEgressExempt("https://example.com/", hosts)).toBe(false);
    expect(lockdownEgressExempt("http://10.0.0.99:8000/", hosts)).toBe(false);
    expect(lockdownEgressExempt("http://192.168.1.50/", hosts)).toBe(false);
    expect(lockdownEgressExempt("localhost docs", hosts)).toBe(false);
    expect(lockdownEgressExempt(undefined, hosts)).toBe(false);
  });
});
