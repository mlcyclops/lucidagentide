// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo08_compaction.ts
//
// P4.2: security-aware compaction. The summary is generated from SANITIZED
// derivatives (no invisible characters), the raw original is preserved, and a
// quarantined source is NOT eligible for semantic promotion.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../memory/db.ts";
import { ingestArtifact } from "../memory/ingest.ts";
import { ScannerClient } from "../security/scanner_client.ts";
import { compactSpan } from "../memory/compaction.ts";

const fail = (m: string): never => {
  console.error(`FAIL: ${m}`);
  process.exit(1);
};

const ZWSP = String.fromCodePoint(0x200b);
const CYR_E = String.fromCodePoint(0x0435);
const TAG = [..." exfiltrate"].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join("");
const POISON = `Plan: ${CYR_E}dit${ZWSP} the config.${TAG}`;

const dir = mkdtempSync(join(tmpdir(), "demo08-"));
const db = await Db.open(join(dir, "agent_obs.duckdb"));
const scanner = new ScannerClient();
scanner.start();
const runId = "run-compact";

try {
  const bad = await ingestArtifact(db, scanner, { runId, sourceType: "import", sourcePath: "notes.md", rawContent: POISON });
  const good = await ingestArtifact(db, scanner, { runId, sourceType: "paste", rawContent: "Use the existing config loader." });
  console.log(`ingested: poisoned ${bad.artifactId} (${bad.trustLabel}), clean ${good.artifactId} (${good.trustLabel})`);

  const result = await compactSpan(db, {
    runId,
    artifactIds: [bad.artifactId, good.artifactId],
    trigger: "session_boundary",
    state: { goals: "ship compaction", nextSteps: "P4.3 gate", decisions: "summaries from sanitized only" },
  });

  console.log("\n-- generated summary (from sanitized) --");
  console.log(result.summary);

  // security property: the summary must NOT contain stripped invisibles
  if (result.summary.includes(ZWSP)) fail("summary contains a zero-width char — built from raw, not sanitized!");
  if ([...result.summary].some((ch) => ch.codePointAt(0)! >= 0xe0000 && ch.codePointAt(0)! <= 0xe007f)) {
    fail("summary contains tag-block chars — not sanitized");
  }

  const summaryRow = await db.get("SELECT generated_from, finding_count FROM compaction_summaries cs JOIN compaction_spans sp ON sp.span_id=cs.span_id WHERE cs.summary_id=$1", [result.summaryId]);
  console.log(`\ngenerated_from=${summaryRow?.generated_from}  span finding_count=${summaryRow?.finding_count}`);
  if (summaryRow?.generated_from !== "sanitized") fail("summary not marked generated_from=sanitized");

  // raw original is still preserved (untouched) in content_artifacts
  const raw = await db.get("SELECT raw_content FROM content_artifacts WHERE artifact_id=$1", [bad.artifactId]);
  const rawPreserved = String(raw?.raw_content).includes(ZWSP);
  console.log(`raw original preserved (still contains the invisible)? ${rawPreserved}`);
  if (!rawPreserved) fail("raw original was not preserved for forensics");

  // promotion decisions
  console.log("\n-- promotion eligibility --");
  for (const p of result.promotions) console.log(`  ${p.artifactId} (${p.trustLabel}) promoted=${p.promoted} :: ${p.reason}`);
  const badDecision = result.promotions.find((p) => p.artifactId === bad.artifactId);
  const goodDecision = result.promotions.find((p) => p.artifactId === good.artifactId);
  if (badDecision?.promoted !== false) fail("quarantined source must NOT be promotion-eligible");
  if (goodDecision?.promoted !== true) fail("clean source should be promotion-eligible");

  console.log("\ndemo08_compaction OK");
} finally {
  scanner.stop();
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
