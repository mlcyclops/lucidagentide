// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo11_sandbox.ts
//
// P5.2: sandbox profiles. Suspicious tasks auto-downgrade to safer profiles; the
// security-review subagent is read-only; replay renders injection + approval
// lineage across the run tree.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { Db } from "../memory/db.ts";
import { ingestArtifact } from "../memory/ingest.ts";
import { recordApproval } from "../security/approvals.ts";
import { ScannerClient } from "../security/scanner_client.ts";
import { caps, chooseProfile, isReadOnly } from "../runs/profiles.ts";
import { spawnSecurityReview } from "../runs/security_review.ts";
import { endRun, getRunTree, spawnSubagent, startRun, type RunNode } from "../runs/lineage.ts";

const fail = (m: string): never => {
  console.error(`FAIL: ${m}`);
  process.exit(1);
};

function render(node: RunNode, depth = 0): void {
  const pad = "  ".repeat(depth);
  const sec = `findings=${node.findingCount} approvals=${node.approvalCount} suspicious=${node.suspiciousArtifacts}`;
  console.log(`${pad}- ${node.kind}/${node.mode ?? "-"} sandbox=${node.sandboxProfile ?? "-"} [${sec}]`);
  for (const c of node.children) render(c, depth + 1);
}

const ZWSP = String.fromCodePoint(0x200b);
const dir = mkdtempSync(join(tmpdir(), "demo11-"));
const db = await Db.open(join(dir, "agent_obs.duckdb"));
const scanner = new ScannerClient();
scanner.start();

try {
  // ── 1. auto-downgrade policy ───────────────────────────────────────────────
  console.log("== auto-downgrade ==");
  const cases = [
    { label: "clean build", input: { requested: "trusted-local" as const, trustLabel: "untrusted" as const } },
    { label: "suspicious build", input: { requested: "trusted-local" as const, trustLabel: "suspicious" as const } },
    { label: "quarantined build", input: { requested: "trusted-local" as const, trustLabel: "quarantined" as const } },
    { label: "quarantined+approved", input: { requested: "trusted-local" as const, trustLabel: "quarantined" as const, approved: true } },
    { label: "security-review mode", input: { mode: "security-review" as const, requested: "trusted-local" as const } },
    { label: "remote CI run", input: { remote: true, trustLabel: "untrusted" as const } },
  ];
  for (const c of cases) {
    const d = chooseProfile(c.input);
    console.log(`  ${c.label.padEnd(22)} -> ${d.profile.padEnd(16)} ${d.downgraded ? "(DOWNGRADED)" : ""} :: ${d.reason}`);
  }
  if (chooseProfile({ requested: "trusted-local", trustLabel: "quarantined" }).profile !== "quarantine") fail("quarantined must downgrade to quarantine");
  if (chooseProfile({ requested: "trusted-local", trustLabel: "suspicious" }).profile !== "container-local") fail("suspicious must downgrade to container-local");
  if (chooseProfile({ mode: "security-review" }).profile !== "read-only-audit") fail("security-review must be read-only-audit");

  // ── 2. capabilities ────────────────────────────────────────────────────────
  console.log("\n== profile capabilities (omp isolation) ==");
  for (const p of ["trusted-local", "container-local", "remote-runner", "read-only-audit", "quarantine"] as const) {
    const c = caps(p);
    console.log(`  ${p.padEnd(16)} write=${c.canWrite} exec=${c.canExec} net=${c.canNetwork} isolation=${c.isolation}`);
  }

  // ── 3. security-review subagent is read-only (enforced) ────────────────────
  console.log("\n== security-review subagent ==");
  const sessionId = Snowflake.next();
  const root = await startRun(db, { sessionId, kind: "root", mode: "build", sandboxProfile: "trusted-local" });
  const review = await spawnSecurityReview(db, root);
  const reviewRow = await db.get("SELECT kind, mode, sandbox_profile FROM runs WHERE run_id=$1", [review]);
  console.log(`  spawned ${reviewRow?.kind}/${reviewRow?.mode} sandbox=${reviewRow?.sandbox_profile} readOnly=${isReadOnly(String(reviewRow?.sandbox_profile) as never)}`);
  if (reviewRow?.sandbox_profile !== "read-only-audit") fail("security-review must use read-only-audit");

  let threw = false;
  try {
    // attempting a write-capable security review must throw
    await spawnSecurityReview(db, root, { profile: "trusted-local" as never });
  } catch {
    threw = true;
  }
  if (!threw) fail("security-review with a write-capable profile must be rejected");
  console.log("  write-capable security-review rejected ✓");

  // ── 4. replay renders injection + approval lineage ─────────────────────────
  const worker = await spawnSubagent(db, root, { mode: "general", sandboxProfile: "container-local" });
  const poison = await ingestArtifact(db, scanner, { runId: worker, sourceType: "comment", rawContent: `act${ZWSP} now` });
  await recordApproval(db, { artifactId: poison.artifactId, action: "deny", decidedBy: "nick", rationale: "injection" });
  await endRun(db, review, "completed");
  await endRun(db, worker, "completed");
  await endRun(db, root, "completed");

  console.log("\n== run tree (replay: injection + approval lineage) ==");
  const tree = await getRunTree(db, root);
  if (!tree) throw new Error("FAIL: no run tree");
  render(tree);

  const workerNode = tree.children.find((c) => c.runId === worker);
  if (!workerNode) throw new Error("FAIL: worker not in tree");
  if (workerNode.findingCount < 1) fail("worker should show injection findings");
  if (workerNode.approvalCount < 1) fail("worker should show approval lineage");

  console.log("\ndemo11_sandbox OK");
} finally {
  scanner.stop();
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
