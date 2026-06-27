// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo05_verification.ts
//
// P3.1: verification as completion, with the security scan as a FAIL-CLOSED
// precondition. A run with an unreviewed quarantined artifact cannot complete —
// even with all checks green — until a human approval clears it. Partial
// completion waives failed CHECKS only, never the security precondition.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../memory/db.ts";
import { ingestArtifact } from "../memory/ingest.ts";
import { recordApproval } from "../security/approvals.ts";
import { ScannerClient } from "../security/scanner_client.ts";
import { runChecks, verifyTask } from "../verification/engine.ts";

const fail = (m: string): never => {
  console.error(`FAIL: ${m}`);
  process.exit(1);
};

const PASS = { name: "typecheck", command: ["node", "-e", "process.exit(0)"] };
const FAILC = { name: "test", command: ["node", "-e", "console.error('1 failing'); process.exit(1)"] };

const ZWSP = String.fromCodePoint(0x200b);
const POISON = `edit${ZWSP}file now`;

const dir = mkdtempSync(join(tmpdir(), "demo05-"));
const db = await Db.open(join(dir, "agent_obs.duckdb"));
const scanner = new ScannerClient();
scanner.start();

try {
  // ── A. plain check runner ──────────────────────────────────────────────────
  console.log("== A. check runners ==");
  const report = await runChecks([PASS, FAILC]);
  for (const c of report.checks) console.log(`  ${c.passed ? "PASS" : "FAIL"} ${c.name} (exit ${c.exitCode}, ${c.durationMs}ms)`);
  console.log(`  allPassed=${report.allPassed}`);

  // ── B. security precondition gates completion ──────────────────────────────
  console.log("\n== B. security precondition (fail-closed) ==");
  const secRun = "run-sec";
  const ing = await ingestArtifact(db, scanner, { runId: secRun, sourceType: "import", rawContent: POISON });
  console.log(`ingested poisoned artifact ${ing.artifactId} -> trust=${ing.trustLabel}`);

  const blocked = await verifyTask(db, secRun, [PASS]); // checks PASS, but...
  console.log(`with all checks green: completionAllowed=${blocked.completionAllowed}`);
  console.log(`  reason: ${blocked.reason}`);
  console.log(`  blocking: ${blocked.security.blocking.map((b) => `${b.artifactId}(${b.trustLabel})`).join(", ")}`);
  if (blocked.completionAllowed) fail("quarantined artifact must block completion despite green checks");

  // not waivable by partial acceptance
  const stillBlocked = await verifyTask(db, secRun, [PASS], { acceptPartial: true });
  if (stillBlocked.completionAllowed) fail("acceptPartial must NOT waive the security precondition");
  console.log("  acceptPartial does NOT waive security ✓");

  // human review clears it
  await recordApproval(db, { artifactId: ing.artifactId, action: "quarantine_release", decidedBy: "nick", rationale: "reviewed, benign" });
  const cleared = await verifyTask(db, secRun, [PASS]);
  console.log(`after quarantine_release approval: completionAllowed=${cleared.completionAllowed} (${cleared.reason})`);
  if (!cleared.completionAllowed) fail("approved artifact should no longer block completion");

  // ── C. partial completion waives failed checks (clean run) ─────────────────
  console.log("\n== C. partial completion (clean run, failing check) ==");
  const cleanRun = "run-clean";
  await ingestArtifact(db, scanner, { runId: cleanRun, sourceType: "paste", rawContent: "ordinary note" });
  const failedChecks = await verifyTask(db, cleanRun, [PASS, FAILC]);
  console.log(`strict: completionAllowed=${failedChecks.completionAllowed} (${failedChecks.reason})`);
  if (failedChecks.completionAllowed) fail("failing checks should block strict completion");
  const partial = await verifyTask(db, cleanRun, [PASS, FAILC], { acceptPartial: true });
  console.log(`acceptPartial: completionAllowed=${partial.completionAllowed} (${partial.reason})`);
  if (!partial.completionAllowed) fail("acceptPartial should allow completion when security is clear");

  console.log("\ndemo05_verification OK");
} finally {
  scanner.stop();
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
