// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/whisper_binary_stage.test.ts - P-STT.7: the dev-run whisper-server staging gate.
// The fail-closed pins are the load-bearing part: a wrong-sized or wrong-hashed download must never
// land in the staging dir, and platforms without a pinned prebuilt must refuse with the guided message
// instead of pretending. (The happy-path extract is covered live by the pinned-asset integration the
// installer build runs; unit-faking a 7MB signed zip would test the fake, not the gate.)

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageWhisperBinary } from "./whisper_binary_stage.ts";

const scratch = () => mkdtempSync(join(tmpdir(), "whisper-stage-test-"));
// Cast reason: the stub ignores fetch's argument overloads (url/init unused); structurally it serves the
// one call shape stageWhisperBinary makes, and inference cannot unify a zero-arg async fn with fetch.
const fetchBytes = (bytes: number, status = 200): typeof fetch =>
  (async () => new Response(new Uint8Array(bytes), { status })) as unknown as typeof fetch;

describe("stageWhisperBinary", () => {
  test("macOS refuses with the guided source-build message", async () => {
    const r = await stageWhisperBinary("/nowhere", { platform: "darwin", arch: "arm64" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("bun run whisper");
  });

  test("an unknown platform refuses and names LUCID_WHISPER_BIN", async () => {
    const r = await stageWhisperBinary("/nowhere", { platform: "freebsd", arch: "x64" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("LUCID_WHISPER_BIN");
  });

  test("an HTTP failure reports the status and stages nothing", async () => {
    const dir = scratch();
    try {
      const r = await stageWhisperBinary(dir, { platform: "win32", arch: "x64", fetchImpl: fetchBytes(10, 503) });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain("HTTP 503");
      expect(readdirSync(dir)).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("a size mismatch is refused before hashing, nothing staged", async () => {
    const dir = scratch();
    try {
      const r = await stageWhisperBinary(dir, { platform: "win32", arch: "x64", fetchImpl: fetchBytes(1234) });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain("size mismatch");
      expect(readdirSync(dir)).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("a right-sized wrong-content download fails the hash gate, nothing staged", async () => {
    const dir = scratch();
    try {
      // 7982101 zero bytes = the pinned win32 size with the wrong content -> must die at sha256.
      const r = await stageWhisperBinary(dir, { platform: "win32", arch: "x64", fetchImpl: fetchBytes(7_982_101) });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain("hash mismatch");
      expect(readdirSync(dir)).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
