// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/whistle_assets.test.ts - CREATOR-WHISTLE (ADR-0432): the asset pins, the dir resolver's
// precedence and all-three rule, and the pure size-then-hash verdict with named reasons.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { WHISTLE_ASSETS, WHISTLE_MODEL_SHA256, resolveWhistleDir, verifyWhistleAsset } from "./whistle_assets.ts";

const HEX64 = /^[0-9a-f]{64}$/;

/** An `exists` that answers true only for the given dir set, each holding the listed file names. */
function dirsWith(contents: Record<string, readonly string[]>): (path: string) => boolean {
  const present = new Set<string>();
  for (const [dir, names] of Object.entries(contents)) for (const n of names) present.add(join(dir, n));
  return (p) => present.has(p);
}
const ALL = WHISTLE_ASSETS.map((s) => s.name);

describe("WHISTLE_ASSETS pins", () => {
  test("three assets in order with the committed sizes and hashes", () => {
    expect(ALL).toEqual(["needle.js", "needle.wasm", "whistle.cact"]);
    expect(WHISTLE_ASSETS.map((s) => s.bytes)).toEqual([62823, 903655, 16919407]);
    for (const s of WHISTLE_ASSETS) {
      expect(s.sha256).toMatch(HEX64);
      expect(s.url.startsWith("https://huggingface.co/Cactus-Compute/")).toBe(true);
      // Cactus replaces binaries in place on `main` (2026-10-05); only a commit revision holds the pinned bytes.
      expect(s.url).toMatch(/\/resolve\/[0-9a-f]{40}\//);
      expect(s.url.endsWith(`/${s.name}`)).toBe(true);
    }
    expect(WHISTLE_ASSETS[2].sha256).toBe("b6e02f048568ac5d01a2042556c658061e699acbc0aa2a1439f52f3d461dffeb");
    expect(WHISTLE_MODEL_SHA256).toBe(WHISTLE_ASSETS[2].sha256);
  });
});

describe("resolveWhistleDir", () => {
  test("env wins over bundled over staged when each holds all three", () => {
    const exists = dirsWith({ "/env": ALL, [join("/res", "whistle")]: ALL, "/staged": ALL });
    expect(resolveWhistleDir({ env: { LUCID_WHISTLE_DIR: "/env" }, resourcesPath: "/res", stagedDir: "/staged", exists }))
      .toEqual({ dir: "/env", source: "env" });
    expect(resolveWhistleDir({ env: {}, resourcesPath: "/res", stagedDir: "/staged", exists }))
      .toEqual({ dir: join("/res", "whistle"), source: "bundled" });
    expect(resolveWhistleDir({ env: {}, stagedDir: "/staged", exists }))
      .toEqual({ dir: "/staged", source: "staged" });
  });

  test("a dir missing one file is skipped and the next candidate wins", () => {
    const exists = dirsWith({ "/env": ["needle.js", "needle.wasm"], "/staged": ALL });
    expect(resolveWhistleDir({ env: { LUCID_WHISTLE_DIR: "/env" }, stagedDir: "/staged", exists }))
      .toEqual({ dir: "/staged", source: "staged" });
  });

  test("no complete dir anywhere resolves to null", () => {
    const exists = dirsWith({ [join("/res", "whistle")]: ["whistle.cact"] });
    expect(resolveWhistleDir({ env: { LUCID_WHISTLE_DIR: "" }, resourcesPath: "/res", stagedDir: "/staged", exists })).toBeNull();
    expect(resolveWhistleDir({ env: {}, exists: () => true })).toBeNull();
  });
});

describe("verifyWhistleAsset", () => {
  const spec = { name: "needle.js" as const, url: "https://x/needle.js", sha256: "ab".repeat(32), bytes: 4 };

  test("size mismatch refuses first, naming the file and both sizes, before the hash is consulted", () => {
    const v = verifyWhistleAsset(spec, new Uint8Array(3), spec.sha256);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toContain("needle.js");
      expect(v.reason).toContain("got 3");
      expect(v.reason).toContain("pinned 4");
      expect(v.reason).not.toContain("sha256");
    }
  });

  test("hash mismatch names the file and the first 12 hex of both hashes", () => {
    const got = "cd".repeat(32);
    const v = verifyWhistleAsset(spec, new Uint8Array(4), got);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toContain("needle.js");
      expect(v.reason).toContain(got.slice(0, 12));
      expect(v.reason).toContain(spec.sha256.slice(0, 12));
      expect(v.reason).not.toContain(got.slice(0, 20));
    }
  });

  test("right size and hash passes; the hash comparison is case-insensitive", () => {
    expect(verifyWhistleAsset(spec, new Uint8Array(4), spec.sha256)).toEqual({ ok: true });
    expect(verifyWhistleAsset(spec, new Uint8Array(4), spec.sha256.toUpperCase())).toEqual({ ok: true });
  });
});
