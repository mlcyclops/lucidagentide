// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_pstt1.ts
//
// P-STT.1 (ADR-0073): speech-to-text behind the TranscriptionBackend seam. By DEFAULT it runs against a
// MOCK transport (returns a fixed transcript) so the demo passes offline / air-gapped / in CI; set
// LUCID_STT_BASE_URL to a real self-hosted Whisper (OpenAI-compatible) server to transcribe real audio
// bytes piped in via LUCID_STT_AUDIO (a path to a .wav/.webm).
//
// Run with: bun run harness/scripts/demo_pstt1.ts
//   live:    LUCID_STT_BASE_URL=http://localhost:9000 LUCID_STT_AUDIO=./clip.wav bun run harness/scripts/demo_pstt1.ts

import { readFileSync, existsSync } from "node:fs";
import { OpenAiCompatibleSttBackend } from "../voice/transcription.ts";

const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };

try {
  const live = !!process.env.LUCID_STT_BASE_URL;
  const audioPath = process.env.LUCID_STT_AUDIO;
  const audio = live && audioPath && existsSync(audioPath)
    ? new Uint8Array(readFileSync(audioPath))
    : new Uint8Array(2048).fill(7); // synthetic "recording" bytes for the offline mock path

  const backend = live
    ? new OpenAiCompatibleSttBackend({ baseUrl: process.env.LUCID_STT_BASE_URL!, apiKey: process.env.LUCID_STT_API_KEY, model: process.env.LUCID_STT_MODEL })
    : new OpenAiCompatibleSttBackend({
        baseUrl: "http://mock",
        // MOCK transport: a fixed transcript, proving the multipart → text pipeline with no server.
        fetchImpl: (async (_url: string, _init: unknown) => ({
          ok: true, status: 200, statusText: "OK",
          json: async () => ({ text: "open the goal loop and run the test suite" }),
        }) as unknown as Response) as unknown as typeof fetch,
      });

  console.log(`== [1/2] transcribing ${audio.length} bytes via ${live ? "LIVE " + process.env.LUCID_STT_BASE_URL : "MOCK transport (offline)"} ==`);
  const r = await backend.transcribe(audio, { language: "en", mimeType: "audio/wav" });
  if (!r.text) fail(`no transcript produced: ${r.note}`);
  console.log(`   backend=${r.backendId}  transcript="${r.text}"`);
  console.log(`   note: ${r.note}`);

  console.log("\n== [2/2] fail-safe: a broken endpoint yields an EMPTY transcript, never throws ==");
  const down = new OpenAiCompatibleSttBackend({ baseUrl: "http://127.0.0.1:1", fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch });
  const r2 = await down.transcribe(audio);
  if (r2.text !== "") fail("a broken STT endpoint must yield empty text");
  console.log(`   broken endpoint → text="" · note: ${r2.note}`);

  console.log("\nPASS: mic audio → OpenAI-compatible STT → text behind the seam; air-gap default (local Whisper), fail-safe to empty.");
} catch (e) {
  fail(String((e as Error)?.stack ?? e));
}
process.exit(0);
