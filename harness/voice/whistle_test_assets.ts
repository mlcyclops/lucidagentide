// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/voice/whistle_test_assets.ts - test-only helpers shared by whistle.test.ts and
// whistle_client.test.ts: locate the three pinned assets, hash-verify them BEFORE anything loads, read
// the 16 kHz speech fixture, and score a transcript against the sentence it speaks.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseWav } from "../brief/tts_backend.ts";
import { pcm16ToMonoFloat } from "./resample.ts";

/** Contract "Pinned assets"; desktop/whistle_assets.ts carries the same pins for the engine. */
export const WHISTLE_TEST_PINS: readonly { name: "needle.js" | "needle.wasm" | "whistle.cact"; sha256: string; bytes: number }[] = [
  { name: "needle.js", sha256: "f3f7366dcad9555b792ee519d2518f3c506038bcb2ffd179e76e850000749359", bytes: 62823 },
  { name: "needle.wasm", sha256: "c19b9ddf9c7de4eb4f37e5f1811c5bbea9f099041d2a27284daf89789ee8523d", bytes: 903655 },
  { name: "whistle.cact", sha256: "b6e02f048568ac5d01a2042556c658061e699acbc0aa2a1439f52f3d461dffeb", bytes: 16919407 },
];
export const WHISTLE_MODEL_SHA256_PIN = WHISTLE_TEST_PINS[2]!.sha256;
/** What harness/fixtures/whistle/quick_fox_16k.wav says (12.28 s, Kokoro, on-device). */
export const FIXTURE_TEXT = "The quick brown fox jumps over the lazy dog. Lucid Creator Edition transcribes audio on this machine, with word level timestamps, and sends nothing over the network.";
export const FIXTURE_WAV = join(import.meta.dir, "..", "fixtures", "whistle", "quick_fox_16k.wav");
const SCRATCH_DIR = "C:\\Users\\neorc\\AppData\\Local\\Temp\\whistle-spike";

/** env LUCID_WHISTLE_DIR -> desktop/whistle (repo) -> the spike's scratch dir; a dir counts only with all three files. */
export function findWhistleAssetDir(): string | null {
  const candidates = [process.env.LUCID_WHISTLE_DIR, join(import.meta.dir, "..", "..", "desktop", "whistle"), SCRATCH_DIR];
  for (const dir of candidates) {
    if (dir && WHISTLE_TEST_PINS.every((p) => existsSync(join(dir, p.name)))) return dir;
  }
  return null;
}

export const WHISTLE_SKIP_REASON = "SKIPPING asset-backed tests: no directory with needle.js, needle.wasm and whistle.cact (set LUCID_WHISTLE_DIR, or run `bun run whistle` in desktop/)";

export interface VerifiedWhistleAssets { gluePath: string; glue: string; wasm: Uint8Array; cact: Uint8Array }

/** Read and hash-verify all three files; a mismatch throws naming the file and both sizes or hashes. */
export function readVerifiedWhistleAssets(dir: string): VerifiedWhistleAssets {
  const bytes: Record<string, Uint8Array> = {};
  for (const pin of WHISTLE_TEST_PINS) {
    const b = new Uint8Array(readFileSync(join(dir, pin.name)));
    if (b.byteLength !== pin.bytes) throw new Error(`${pin.name}: got ${b.byteLength} bytes, pinned ${pin.bytes}`);
    const got = new Bun.CryptoHasher("sha256").update(b).digest("hex");
    if (got !== pin.sha256) throw new Error(`${pin.name}: sha256 ${got.slice(0, 12)} does not match pinned ${pin.sha256.slice(0, 12)}`);
    bytes[pin.name] = b;
  }
  return {
    gluePath: join(dir, "needle.js"),
    glue: new TextDecoder().decode(bytes["needle.js"]!),
    wasm: bytes["needle.wasm"]!,
    cact: bytes["whistle.cact"]!,
  };
}

/** The fixture as 16 kHz mono float; throws if the file is not 16-bit PCM at 16 kHz. */
export function readFixturePcm16k(): Float32Array {
  const { fmt, data } = parseWav(new Uint8Array(readFileSync(FIXTURE_WAV)));
  if (fmt.sampleRate !== 16000 || fmt.bitsPerSample !== 16) throw new Error(`fixture is ${fmt.sampleRate} Hz / ${fmt.bitsPerSample}-bit; expected 16 kHz 16-bit`);
  return pcm16ToMonoFloat(data, fmt.channels);
}

/** NFKC, lowercase, leading/trailing punctuation stripped: the editor's token normalization. */
export function normalizedTokens(text: string): string[] {
  return text.normalize("NFKC").toLowerCase().split(/\s+/)
    .map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((t) => t.length > 0);
}

/** Share of `want` tokens the transcript reproduced in order (longest common subsequence / want length). */
export function tokenMatch(want: readonly string[], got: readonly string[]): number {
  if (want.length === 0) return 1;
  const prev = new Array<number>(got.length + 1).fill(0);
  for (const w of want) {
    let diag = 0;
    for (let j = 1; j <= got.length; j++) {
      const up = prev[j]!;
      prev[j] = w === got[j - 1] ? diag + 1 : Math.max(up, prev[j - 1]!);
      diag = up;
    }
  }
  return prev[got.length]! / want.length;
}
