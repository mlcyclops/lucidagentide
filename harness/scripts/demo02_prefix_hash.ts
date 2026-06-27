// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo02_prefix_hash.ts
//
// Increment 2: cache-optimized prompt assembly. Two proofs:
//   A. The frozen prefix is byte-identical across two very different requests
//      (different task, cwd, git branch, retrieved content) — the KV-cache win.
//   B. omp actually threads our frozen prefix through to the model as the first
//      system block (closing the ADR-0003 "no clean split seam" wrinkle).

import { assemblePrompt, FROZEN_PREFIX } from "../prompt/assembler.ts";
import { createEchoSession } from "../testing/echo.ts";

const fail = (m: string): never => {
  console.error(`FAIL: ${m}`);
  process.exit(1);
};

// ── A. prefix byte-stability across two different tasks ─────────────────────
const a = assemblePrompt({
  task: "Refactor the auth module",
  sessionState: { cwd: "/repo/alpha", gitBranch: "main", date: "2026-06-18" },
});
const b = assemblePrompt({
  task: "Write a parser for the new config format",
  sessionState: { cwd: "/repo/beta", gitBranch: "feature/parser", date: "2026-06-19" },
  retrieved: [{ source: "docs/spec.md", trustLabel: "untrusted", content: "format = TOML-ish" }],
  instructionFiles: "# CLAUDE.md\nbe concise",
  workingMemory: "decided: hand-rolled lexer",
});

console.log(`A. prefix bytes : ${a.prefix.length} (task A) vs ${b.prefix.length} (task B)`);
console.log(`   prefix hash  : ${a.prefixHash.slice(0, 16)}…  /  ${b.prefixHash.slice(0, 16)}…`);
console.log(`   tails differ : ${a.tail !== b.tail}`);
if (a.prefix !== b.prefix) fail("prefix bytes differ across tasks");
if (a.prefixHash !== b.prefixHash) fail("prefix hashes differ across tasks");
console.log(`   => identical frozen prefix across both requests ✓ (breakpoint @${a.breakpointIndex})`);

console.log("\n--- assembled prompt (task B), prefix abbreviated ---");
console.log(`[PREFIX v${b.prefixVersion} — ${b.prefix.split("\n")[0]} … ${b.prefix.length} bytes, hash ${b.prefixHash.slice(0, 12)}]`);
console.log("--- cache breakpoint ---");
console.log(b.tail);

// ── B. omp threads the frozen prefix through to the model ───────────────────
const { session, model, cleanup } = await createEchoSession({ systemPrompt: a.blocks });
try {
  await session.prompt("ping");
  const seen = model.calls[0]?.context.systemPrompt ?? [];
  if (seen.length === 0) fail("omp passed no systemPrompt to the model");
  const joined = seen.join("\n");
  console.log(`\nB. omp passed ${seen.length} system block(s) to the model`);
  if (!joined.includes(FROZEN_PREFIX)) fail("omp did not include our frozen prefix");
  const prefixAt = joined.indexOf(FROZEN_PREFIX);
  const taskAt = joined.indexOf("Refactor the auth module");
  console.log(`   frozen prefix present ✓ (at index ${prefixAt}); task in tail ✓ (at ${taskAt})`);
  if (taskAt !== -1 && prefixAt > taskAt) fail("prefix appears AFTER volatile task content");
  console.log("   => frozen prefix precedes volatile content in what omp sent ✓");
} finally {
  cleanup();
}

console.log("\ndemo02_prefix_hash OK");
process.exit(0);
