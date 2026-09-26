// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/fs_dirs.test.ts - ensureDir's goal-state contract: an existing directory is ALWAYS success
// (the Bun-on-Windows EEXIST-from-recursive-mkdir case that killed slash-command creation), while a
// FILE squatting on the path still fails loudly (fail-closed: never write "into" a file).

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDir } from "./fs_dirs.ts";

describe("ensureDir", () => {
  test("creates nested directories and is idempotent on repeat calls", () => {
    const root = mkdtempSync(join(tmpdir(), "fsdirs-"));
    try {
      const dir = join(root, ".omp", "commands");
      ensureDir(dir);
      expect(statSync(dir).isDirectory()).toBe(true);
      ensureDir(dir); // the reported failure mode: the dir already exists - MUST be success
      expect(statSync(dir).isDirectory()).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("a FILE squatting on the path still throws (never silently treat a file as a directory)", () => {
    const root = mkdtempSync(join(tmpdir(), "fsdirs-"));
    try {
      const squatter = join(root, "commands");
      writeFileSync(squatter, "not a directory");
      expect(() => ensureDir(squatter)).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
