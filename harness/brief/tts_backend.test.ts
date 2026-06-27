// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/brief/tts_backend.test.ts — the OpenAI-compatible TTS backend (P-BRIEF.2, ADR-0071). Pure WAV
// round-trip + concat, an injectable-transport synth (no server), per-speaker voice selection, and the
// fail-safe degrade-to-script-only path.

import { test, expect, describe } from "bun:test";
import { parseWav, buildWav, concatWav, OpenAiCompatibleTtsBackend, type WavFormat } from "./tts_backend.ts";
import type { PodcastScript } from "./engineering_update.ts";

const FMT: WavFormat = { channels: 1, sampleRate: 24000, bitsPerSample: 16 };
const wav = (nBytes: number, fill = 1) => buildWav(FMT, new Uint8Array(nBytes).fill(fill));

describe("WAV helpers", () => {
  test("buildWav → parseWav round-trips format + data", () => {
    const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const p = parseWav(buildWav(FMT, data));
    expect(p.fmt).toEqual(FMT);
    expect([...p.data]).toEqual([...data]);
  });

  test("parseWav rejects a non-WAV buffer", () => {
    expect(() => parseWav(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]))).toThrow(/RIFF|WAVE/);
  });

  test("parseWav tolerates an extra chunk before data", () => {
    // hand-build RIFF: fmt + a LIST chunk + data
    const data = new Uint8Array([9, 9, 9, 9]);
    const base = buildWav(FMT, data); // canonical
    // splice a 4-byte LIST chunk in front of 'data'
    const head = base.subarray(0, 36); // through fmt
    const list = new Uint8Array(12); // "LIST"+size(4)+4 bytes
    list.set([0x4c, 0x49, 0x53, 0x54], 0); new DataView(list.buffer).setUint32(4, 4, true);
    const dataChunk = base.subarray(36); // 'data'+size+payload
    const merged = new Uint8Array(head.length + list.length + dataChunk.length);
    merged.set(head, 0); merged.set(list, head.length); merged.set(dataChunk, head.length + list.length);
    // fix RIFF size
    new DataView(merged.buffer).setUint32(4, merged.length - 8, true);
    const p = parseWav(merged);
    expect([...p.data]).toEqual([...data]);
  });

  test("concatWav sums sample data and rebuilds a valid WAV", () => {
    const out = concatWav([wav(8, 1), wav(4, 2), wav(6, 3)]);
    const p = parseWav(out);
    expect(p.data.length).toBe(18);
    expect(p.fmt).toEqual(FMT);
  });

  test("concatWav rejects a format mismatch", () => {
    const other = buildWav({ channels: 2, sampleRate: 24000, bitsPerSample: 16 }, new Uint8Array(4));
    expect(() => concatWav([wav(8), other])).toThrow(/mismatch/);
  });

  test("concatWav throws on empty input", () => {
    expect(() => concatWav([])).toThrow(/no segments/);
  });
});

const SCRIPT: PodcastScript = {
  title: "t",
  turns: [
    { speaker: "Host", text: "Welcome." },
    { speaker: "Engineer", text: "Here's the status." },
    { speaker: "Host", text: "Thanks." },
  ],
};

describe("OpenAiCompatibleTtsBackend", () => {
  test("synthesizes each turn, selects per-speaker voice, concatenates audio", async () => {
    const calls: { voice: string; input: string }[] = [];
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      calls.push({ voice: body.voice, input: body.input });
      return { ok: true, status: 200, statusText: "OK", arrayBuffer: async () => wav(10).buffer } as unknown as Response;
    }) as unknown as typeof fetch;

    const be = new OpenAiCompatibleTtsBackend({ baseUrl: "http://kokoro.local:8880/", voices: { Host: "af_sky", Engineer: "am_adam", default: "af_heart" }, fetchImpl });
    const r = await be.synthesize(SCRIPT);

    expect(r.backendId).toBe("openai-tts");
    expect(calls.length).toBe(3);
    expect(calls[0]!.voice).toBe("af_sky");   // Host
    expect(calls[1]!.voice).toBe("am_adam");  // Engineer
    expect(r.audio).toBeDefined();
    expect(parseWav(r.audio!).data.length).toBe(30); // 3 × 10 bytes
  });

  test("fails safe: a transport error degrades to script-only, never throws", async () => {
    const fetchImpl = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const be = new OpenAiCompatibleTtsBackend({ baseUrl: "http://down:1/", fetchImpl });
    const r = await be.synthesize(SCRIPT);
    expect(r.audio).toBeUndefined();
    expect(r.note).toMatch(/unavailable|ECONNREFUSED|script only/i);
    expect(r.script.turns.length).toBe(3);
  });

  test("a non-200 response also fails safe", async () => {
    const fetchImpl = (async () => ({ ok: false, status: 503, statusText: "Service Unavailable", arrayBuffer: async () => new ArrayBuffer(0) }) as unknown as Response) as unknown as typeof fetch;
    const be = new OpenAiCompatibleTtsBackend({ baseUrl: "http://x/", fetchImpl });
    const r = await be.synthesize(SCRIPT);
    expect(r.audio).toBeUndefined();
    expect(r.note).toMatch(/503|unavailable/i);
  });
});
