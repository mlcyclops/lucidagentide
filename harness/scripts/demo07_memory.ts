// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo07_memory.ts
//
// P4.1: the memory layers (working / archive / semantic) with provenance + trust
// on every promoted item, plus the durable state artifacts
// (NOW/PROGRESS/DECISIONS/FAILURES).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../memory/db.ts";
import { ingestArtifact } from "../memory/ingest.ts";
import { ScannerClient } from "../security/scanner_client.ts";
import { archiveChunk, getFacts, promoteFact, upsertWorkingState, getWorkingState } from "../memory/memory.ts";
import { StateArtifacts } from "../memory/state.ts";

const fail = (m: string): never => {
  console.error(`FAIL: ${m}`);
  process.exit(1);
};

const dir = mkdtempSync(join(tmpdir(), "demo07-"));
const db = await Db.open(join(dir, "agent_obs.duckdb"));
const scanner = new ScannerClient();
scanner.start();
const runId = "run-mem";

try {
  // ── working memory ─────────────────────────────────────────────────────────
  await upsertWorkingState(db, runId, { goal: "wire memory layers", nextStep: "promote a fact", trustLabel: "trusted" });
  await upsertWorkingState(db, runId, { goal: "wire memory layers", nextStep: "verify provenance", blockers: "none" });
  const ws = await getWorkingState(db, runId);
  console.log(`working_state: goal="${ws?.goal}" next="${ws?.next_step}" trust=${ws?.trust_label}`);

  // ── archive (raw source-of-truth) with provenance to a scanned artifact ────
  const ing = await ingestArtifact(db, scanner, { runId, sourceType: "import", sourcePath: "spec.md", rawContent: "The build uses Bun." });
  const chunkId = await archiveChunk(db, { runId, artifactId: ing.artifactId, content: "The build uses Bun." });
  console.log(`archived raw chunk ${chunkId} (artifact ${ing.artifactId}, trust=${ing.trustLabel})`);

  // ── semantic memory: promote a fact with full provenance + trust ───────────
  const { factId, entityId } = await promoteFact(db, {
    entityName: "build-system",
    entityKind: "tool",
    statement: "The project builds with Bun.",
    trustLabel: "trusted",
    sourceArtifactId: ing.artifactId,
    sourceArchiveChunkId: chunkId,
  });
  console.log(`promoted fact ${factId} for entity ${entityId}`);

  const facts = await getFacts(db, "build-system");
  const f = facts[0];
  if (!f) throw new Error("FAIL: no fact promoted");
  console.log(`fact provenance: source_artifact=${f.source_artifact_id} source_chunk=${f.source_archive_chunk_id} trust=${f.trust_label}`);
  if (f.source_artifact_id !== ing.artifactId || f.source_archive_chunk_id !== chunkId) {
    fail("promoted fact missing provenance back to artifact + archive chunk");
  }
  if (f.trust_label !== "trusted") fail("fact trust label not recorded");

  // ── durable state artifacts ────────────────────────────────────────────────
  const state = new StateArtifacts(join(dir, "state"), { now: () => "2026-06-18T00:00:00Z" });
  state.writeNow("Goal: wire memory layers.\nNext: P4.2 compaction.");
  state.appendProgress("P4.1: memory layers + state artifacts shipped");
  state.appendDecision("Soft run_id on memory tables", "Mirrors ADR-0005; identity tables land later.");
  state.appendFailure("none this session");
  console.log("\n-- NOW.md --");
  console.log(state.read("NOW.md").trim());
  console.log("-- PROGRESS.md (tail) --");
  console.log(state.read("PROGRESS.md").trim().split("\n").slice(-1)[0]);

  if (!state.read("NOW.md").includes("P4.2 compaction")) fail("NOW.md not written");
  if (!state.read("DECISIONS.md").includes("Soft run_id")) fail("DECISIONS.md not appended");

  console.log("\ndemo07_memory OK");
} finally {
  scanner.stop();
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
