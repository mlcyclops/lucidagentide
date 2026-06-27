// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_pbrief2.ts
//
// P-BRIEF.2 (ADR-0071): the FIRST audio backend behind the P-BRIEF.1 seam. Builds the Executive
// Engineering Update script from THIS repo's logs (P-BRIEF.1), then renders it to a single WAV via the
// OpenAI-compatible TTS backend. By DEFAULT it runs against a MOCK transport (deterministic synthetic
// WAV per turn) so the demo passes offline / air-gapped / in CI; set LUCID_TTS_BASE_URL to a real
// self-hosted Kokoro (OpenAI-compatible) server to synthesize actual speech.
//
// Run with: bun run harness/scripts/demo_pbrief2.ts
//   live:    LUCID_TTS_BASE_URL=http://localhost:8880 bun run harness/scripts/demo_pbrief2.ts

import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildEngineeringUpdate, buildPodcastScript } from "../brief/engineering_update.ts";
import { OpenAiCompatibleTtsBackend, buildWav, parseWav, type WavFormat } from "../brief/tts_backend.ts";

const ROOT = join(import.meta.dir, "..", "..");
const read = (f: string) => (existsSync(join(ROOT, f)) ? readFileSync(join(ROOT, f), "utf8") : "");
const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };
const FMT: WavFormat = { channels: 1, sampleRate: 24000, bitsPerSample: 16 };

try {
  const update = buildEngineeringUpdate({ label: "LucidAgentIDE", progressMd: read("PROGRESS.md"), decisionsMd: read("DECISIONS.md") });
  const script = buildPodcastScript(update);
  console.log(`== [1/3] script built from the repo logs: ${script.turns.length} turns, ${new Set(script.turns.map((t) => t.speaker)).size} speakers ==`);

  const live = !!process.env.LUCID_TTS_BASE_URL;
  const backend = live
    ? new OpenAiCompatibleTtsBackend({ baseUrl: process.env.LUCID_TTS_BASE_URL!, apiKey: process.env.LUCID_TTS_API_KEY, voices: { Host: process.env.LUCID_TTS_VOICE_HOST ?? "af_sky", Engineer: process.env.LUCID_TTS_VOICE_GUEST ?? "am_adam" } })
    : new OpenAiCompatibleTtsBackend({
        baseUrl: "http://mock",
        // MOCK transport: a tiny synthetic WAV per turn (length scaled by text) — proves the synth→concat
        // pipeline with no server, so the demo is air-gap clean.
        fetchImpl: (async (_url: string, init: { body: string }) => {
          const body = JSON.parse(init.body);
          const samples = Math.max(16, Math.min(2000, body.input.length * 4));
          return { ok: true, status: 200, statusText: "OK", arrayBuffer: async () => buildWav(FMT, new Uint8Array(samples)).buffer } as unknown as Response;
        }) as unknown as typeof fetch,
      });

  console.log(`== [2/3] synthesizing via ${live ? "LIVE " + process.env.LUCID_TTS_BASE_URL : "MOCK transport (offline)"} ==`);
  const result = await backend.synthesize(script);
  if (!result.audio) fail(`no audio produced: ${result.note}`);
  const parsed = parseWav(result.audio!);
  console.log(`   backend=${result.backendId}  audio=${result.audio!.length} bytes WAV  pcm=${parsed.data.length} bytes  (${parsed.fmt.sampleRate}Hz/${parsed.fmt.bitsPerSample}-bit)`);
  console.log(`   note: ${result.note}`);

  const dir = mkdtempSync(join(homedir(), ".lucid-demo-brief2-"));
  const outPath = join(dir, "engineering-update.wav");
  writeFileSync(outPath, result.audio!);
  console.log(`== [3/3] wrote a playable WAV: ${outPath} ==`);
  rmSync(dir, { recursive: true, force: true }); // demo cleanup; a real run would deliver it (P-BRIEF.2 delivery is next)

  console.log(`\nPASS: repo logs → exec-update script → ${live ? "real" : "mock"} OpenAI-compatible TTS → one concatenated WAV. Backend swappable behind the seam; fail-safe to script-only.`);
} catch (e) {
  fail(String((e as Error)?.stack ?? e));
}
process.exit(0);
