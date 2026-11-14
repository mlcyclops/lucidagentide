// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/bench/devset/manifest.ts - P-BENCH.2a (ADR-0591): the dev set's fingerprint.
//
// The haystacks are generated (tasks.ts), so nothing in the repository would notice if a change to the
// generator moved an answer or a byte. `manifest.json` records, for every task, the hash of its haystack,
// its question and its reference answer. A test compares the generator's output with the file. A score is
// comparable with an earlier one only when the manifest is the same, which is why a deliberate change to
// the dev set bumps DEVSET_VERSION and rewrites the file in the same commit:
//
//   bun run harness/bench/devset/manifest.ts --write

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildDevset, DEVSET_VERSION, type DevTask } from "./tasks.ts";

export interface ManifestEntry { id: string; chars: number; sha256: string; question: string; answer: string }
export interface Manifest { version: string; tasks: ManifestEntry[] }

export const MANIFEST_FILE = join(import.meta.dir, "manifest.json");

export function manifestOf(tasks: readonly DevTask[] = buildDevset()): Manifest {
  return {
    version: DEVSET_VERSION,
    tasks: tasks.map((t) => ({ id: t.id, chars: t.haystack.length, sha256: createHash("sha256").update(t.haystack, "utf8").digest("hex"), question: t.question, answer: t.answer })),
  };
}

if (import.meta.main && process.argv.includes("--write")) {
  writeFileSync(MANIFEST_FILE, `${JSON.stringify(manifestOf(), null, 2)}\n`, "utf8");
  console.log(`wrote ${MANIFEST_FILE}`);
}
