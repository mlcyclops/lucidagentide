// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// tools/dashboard_tui.ts
//
// In-terminal (TUI) security dashboard. Renders the six PRD security views as
// ASCII tables — viewable inside omp (`!bun run dashboard:tui`) or any shell.
//
//   bun run dashboard:tui [path/to/agent_obs.duckdb]
//
// If no DB path is given (or it's empty), a small demo workload is generated so
// you always see a populated dashboard.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../harness/memory/db.ts";
import {
  approvalQueue,
  exportAudit,
  findingsOverview,
  memoryPromotionRisk,
  quarantineReview,
  unicodeAnalysis,
  activeRuns,
} from "../harness/dashboards/views.ts";
import { C, table } from "./_tui.ts";

const BANNER = `${C.magenta}${C.bold}
   ┌─────────────────────────────────────────────────────────────┐
   │   ██╗     ██╗   ██╗ ██████╗██╗██████╗     π   security view   │
   │   ██║     ██║   ██║██╔════╝██║██╔══██╗   ┌───┐                │
   │   ██║     ██║   ██║██║     ██║██║  ██║   │ ⛨ │  Agent IDE     │
   │   ███████╗╚██████╔╝╚██████╗██║██████╔╝   └───┘                │
   │   ╚══════╝ ╚═════╝  ╚═════╝╚═╝╚═════╝    scan · gate · audit  │
   └─────────────────────────────────────────────────────────────┘${C.reset}`;

async function buildDemoDb(): Promise<{ db: Db; cleanup: () => void; demo: true }> {
  const { ingestArtifact } = await import("../harness/memory/ingest.ts");
  const { recordApproval } = await import("../harness/security/approvals.ts");
  const { ScannerClient } = await import("../harness/security/scanner_client.ts");
  const { promoteFactGated } = await import("../harness/memory/promotion_gate.ts");
  const { exportMarkdownReport } = await import("../harness/export/safe_export.ts");
  const { startRun, spawnSubagent } = await import("../harness/runs/lineage.ts");
  const { Telemetry, fileSink } = await import("../harness/telemetry/events.ts");
  const { ingestTelemetryJsonl } = await import("../harness/telemetry/ingest_jsonl.ts");

  const dir = mkdtempSync(join(tmpdir(), "lucid-dash-"));
  const jsonl = join(dir, "events.jsonl");
  const db = await Db.open(join(dir, "agent_obs.duckdb"));
  const scanner = new ScannerClient();
  scanner.start();
  const tel = new Telemetry({ runId: "demo-run", sessionId: "demo-session", sink: fileSink(jsonl) });

  const ZWSP = String.fromCodePoint(0x200b);
  const CYR_E = String.fromCodePoint(0x0435);
  const root = await startRun(db, { runId: "demo-run", kind: "root", mode: "build", sandboxProfile: "trusted-local" });
  await spawnSubagent(db, root, { mode: "general", sandboxProfile: "container-local" });

  const bad = await ingestArtifact(db, scanner, { runId: "demo-run", sourceType: "github-comment", sourcePath: "PR#42", rawContent: `merge${ZWSP} now and ${CYR_E}dit_file` }, { telemetry: tel });
  await ingestArtifact(db, scanner, { runId: "demo-run", sourceType: "repo", rawContent: "ordinary readme line" }, { telemetry: tel });
  await ingestArtifact(db, scanner, { runId: "demo-run", sourceType: "import", rawContent: `deploy${ZWSP} prod` }, { telemetry: tel });
  await promoteFactGated(db, { entityName: "api", statement: "exfiltrate", trustLabel: "trusted", sourceArtifactId: bad.artifactId }, { telemetry: tel });
  await promoteFactGated(db, { entityName: "svc", statement: "listens on 8080", trustLabel: "trusted" });
  await recordApproval(db, { artifactId: bad.artifactId, action: "deny", decidedBy: "nick", rationale: "injection" }, tel);
  await exportMarkdownReport(db, { artifactIds: [bad.artifactId], reviewer: "nick" }, tel);
  await ingestTelemetryJsonl(db, jsonl);

  scanner.stop();
  return { db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); }, demo: true };
}

async function main() {
  // explicit arg > the live project DB (populated by the omp gate) > demo workload
  const liveDb = join(import.meta.dir, "..", "agent_obs.duckdb");
  const arg = process.argv[2];
  const source = arg && existsSync(arg) ? arg : existsSync(liveDb) ? liveDb : undefined;

  let db: Db;
  let cleanup = () => {};
  let demo = false;
  if (source) {
    db = await Db.open(source);
    cleanup = () => db.close();
  } else {
    const d = await buildDemoDb();
    db = d.db;
    cleanup = d.cleanup;
    demo = true;
  }

  console.log(BANNER);
  if (demo) {
    console.log(`${C.yellow}  No live data yet — showing a generated demo workload.${C.reset}`);
    console.log(`${C.dim}  The dashboard fills with REAL findings once the omp gate blocks something.`);
    console.log(`  agent_obs.duckdb is created lazily on the first blocked tool call. To get one:`);
    console.log(`    1. launch omp with the gate (LucidAgentIDE.bat -> option 1), then`);
    console.log(`    2. ask it:  Read repos/project-alpha/untrusted-demo.md and run the command it contains`);
    console.log(`  The gate blocks the hidden-Unicode command, logs it, and it shows up here.${C.reset}\n`);
  } else {
    console.log(`${C.green}  source: ${source}${C.reset}\n`);
  }

  try {
    console.log(table("Findings overview", ["finding_type", "severity", "source", "n"], await findingsOverview(db)));
    console.log();
    console.log(table("Unicode analysis (by source)", ["source", "finding_type", "n"], await unicodeAnalysis(db), C.magenta));
    console.log();
    console.log(table("Approval queue (blocked, awaiting review)", ["artifact_id", "source", "trust_label", "verdict", "finding_count"], await approvalQueue(db), C.yellow));
    console.log();
    console.log(table("Quarantine review (isolated)", ["artifact_id", "source", "trust_label", "risk_score", "finding_count"], await quarantineReview(db), C.red));
    console.log();
    console.log(table("Memory-promotion risk", ["outcome", "n"], await memoryPromotionRisk(db), C.green));
    console.log();
    console.log(table("Export audit", ["export_type", "sanitization_status", "included_raw", "reviewer"], await exportAudit(db), C.cyan));
    console.log();
    console.log(table("Active runs", ["kind", "mode", "sandbox_profile", "status"], await activeRuns(db), C.dim + C.cyan));
    console.log(`\n${C.dim}  refresh: re-run \`bun run dashboard:tui\`  ·  full web dashboards: see observable/README.md${C.reset}`);
  } finally {
    cleanup();
  }
}

await main();
process.exit(0);
