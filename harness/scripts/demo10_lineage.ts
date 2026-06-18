// harness/scripts/demo10_lineage.ts
//
// P5.1: parent/child run lineage. A parent spawns subagents; each child carries
// its own scan lineage (its ingested artifacts). The run tree is reconstructable
// for replay and shows where suspicious content entered. Promoting a child's
// poisoned artifact into shared semantic memory is security-checked (P4.3 gate).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { Db } from "../memory/db.ts";
import { ingestArtifact } from "../memory/ingest.ts";
import { ScannerClient } from "../security/scanner_client.ts";
import { promoteFactGated } from "../memory/promotion_gate.ts";
import { endRun, getLineage, getRunTree, spawnSubagent, startRun, type RunNode } from "../runs/lineage.ts";

const fail = (m: string): never => {
  console.error(`FAIL: ${m}`);
  process.exit(1);
};

function render(node: RunNode, depth = 0): void {
  const pad = "  ".repeat(depth);
  const flag = node.suspiciousArtifacts > 0 ? ` ⚠ ${node.suspiciousArtifacts} suspicious` : "";
  console.log(`${pad}- ${node.kind}/${node.mode ?? "-"} [${node.runId.slice(-6)}] sandbox=${node.sandboxProfile ?? "-"}${flag}`);
  for (const c of node.children) render(c, depth + 1);
}

const ZWSP = String.fromCodePoint(0x200b);
const dir = mkdtempSync(join(tmpdir(), "demo10-"));
const db = await Db.open(join(dir, "agent_obs.duckdb"));
const scanner = new ScannerClient();
scanner.start();

try {
  const sessionId = Snowflake.next();
  const root = await startRun(db, { sessionId, kind: "root", mode: "build", sandboxProfile: "trusted-local" });
  const childClean = await spawnSubagent(db, root, { mode: "general", sandboxProfile: "container-local" });
  const childPoison = await spawnSubagent(db, root, { mode: "general", sandboxProfile: "container-local" });
  const grandchild = await spawnSubagent(db, childPoison, { mode: "subagent", sandboxProfile: "read-only-audit" });
  console.log(`spawned: root + 2 children + 1 grandchild`);

  // each child has its OWN scan lineage (ingests under its own run_id)
  await ingestArtifact(db, scanner, { runId: childClean, sourceType: "repo", rawContent: "clean repo notes" });
  const poison = await ingestArtifact(db, scanner, { runId: childPoison, sourceType: "comment", rawContent: `do this${ZWSP} secretly` });
  console.log(`child-clean ingested clean; child-poison ingested -> ${poison.trustLabel}`);

  // promoting the child's poisoned artifact into shared semantic memory is blocked
  const promo = await promoteFactGated(db, { entityName: "task", statement: "do it secretly", trustLabel: "trusted", sourceArtifactId: poison.artifactId });
  console.log(`child->parent promotion of poisoned artifact: blocked=${promo.blocked} (${promo.reason})`);
  if (!promo.blocked) fail("child's poisoned artifact must not promote into shared memory");

  await endRun(db, grandchild, "completed");
  await endRun(db, childClean, "completed");
  await endRun(db, childPoison, "completed");
  await endRun(db, root, "completed");

  // ── replay: render the run tree ────────────────────────────────────────────
  console.log("\n-- run tree (replay) --");
  const tree = await getRunTree(db, root);
  if (!tree) throw new Error("FAIL: no run tree");
  render(tree);

  // lineage of the grandchild
  const lineage = await getLineage(db, grandchild);
  console.log(`\nlineage of grandchild: ${lineage.map((r) => r.slice(-6)).join(" -> ")}`);

  // assertions
  if (tree.children.length !== 2) fail(`root should have 2 children, got ${tree.children.length}`);
  const poisonNode = tree.children.find((c) => c.runId === childPoison);
  if (!poisonNode) throw new Error("FAIL: poisoned child not found in tree");
  if (poisonNode.suspiciousArtifacts !== 1) fail("poisoned child should show 1 suspicious artifact");
  if (poisonNode.children.length !== 1) fail("poisoned child should have the grandchild");
  if (lineage.length !== 3 || lineage[0] !== root || lineage[2] !== grandchild) fail("bad lineage chain");

  console.log("\ndemo10_lineage OK");
} finally {
  scanner.stop();
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
