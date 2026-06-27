// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/launcher/ext_parity.test.ts
//
// P-EXT.3 (ADR-0038) — verifies the TS IDE-client implementation against the SHARED, language-neutral
// parity spec (ext_parity.json). The JetBrains Kotlin port (extensions/jetbrains) runs its own
// implementation against the SAME file, so both editors honor one verified security contract — even
// though the Kotlin can't be compiled in this Bun environment. A drift in either impl fails its test.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isLucidBinary, parseBlockLine } from "./ide_client.ts";

const spec = JSON.parse(readFileSync(join(import.meta.dir, "ext_parity.json"), "utf8")) as {
  launcherAccept: { path: string; accept: boolean }[];
  blockLines: { line: string; expect: { tool: string; severity: string; findings: string } | null }[];
};

test("launcher acceptance matches the shared spec (only-lucid; omp & look-alikes rejected)", () => {
  for (const c of spec.launcherAccept) {
    expect(isLucidBinary(c.path)).toBe(c.accept);
  }
  // the spec must include the security-critical negative (omp is never accepted)
  expect(spec.launcherAccept.some((c) => /omp/.test(c.path) && c.accept === false)).toBe(true);
});

test("[BLOCKED] parsing matches the shared spec", () => {
  for (const c of spec.blockLines) {
    expect(parseBlockLine(c.line)).toEqual(c.expect);
  }
});
