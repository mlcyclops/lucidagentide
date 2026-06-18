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
import { Db, type Row } from "../harness/memory/db.ts";
import {
  approvalQueue,
  exportAudit,
  findingsOverview,
  memoryPromotionRisk,
  quarantineReview,
  unicodeAnalysis,
  activeRuns,
} from "../harness/dashboards/views.ts";

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
};

const BANNER = `${C.magenta}${C.bold}
   ┌─────────────────────────────────────────────────────────────┐
   │   ██╗     ██╗   ██╗ ██████╗██╗██████╗     π   security view   │
   │   ██║     ██║   ██║██╔════╝██║██╔══██╗   ┌───┐                │
   │   ██║     ██║   ██║██║     ██║██║  ██║   │ ⛨ │  Agent IDE     │
   │   ███████╗╚██████╔╝╚██████╗██║██████╔╝   └───┘                │
   │   ╚══════╝ ╚═════╝  ╚═════╝╚═╝╚═════╝    scan · gate · audit  │
   └─────────────────────────────────────────────────────────────┘${C.reset}`;

function cell(v: unknown): string {
  if (v == null) return "";
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

/** Render a box-drawn table. */
function table(title: string, headers: string[], rows: Row[], color = C.cyan): string {
  const cols = headers;
  const data = rows.map((r) => cols.map((c) => cell(r[c])));
  const w = cols.map((h, i) => Math.max(h.length, ...data.map((d) => d[i]!.length), 1));
  const sep = (l: string, m: string, r: string) => l + w.map((x) => "─".repeat(x + 2)).join(m) + r;
  const fmt = (vals: string[]) => "│" + vals.map((v, i) => " " + v.padEnd(w[i]!) + " ").join("│") + "│";

  const lines: string[] = [];
  lines.push(`${color}${C.bold}▸ ${title}${C.reset}`);
  if (rows.length === 0) {
    lines.push(`${C.dim}  (no rows)${C.reset}`);
    return lines.join("\n");
  }
  lines.push(color + sep("┌", "┬", "┐") + C.reset);
  lines.push(color + fmt(cols).replace(/[^│]+/g, (s) => C.bold + s + C.reset + color) + C.reset);
  lines.push(color + sep("├", "┼", "┤") + C.reset);
  for (const d of data) lines.push(color + "│" + C.reset + d.map((v, i) => " " + v.padEnd(w[i]!) + " ").join(C.dim + "│" + C.reset) + C.dim + "│" + C.reset);
  lines.push(color + sep("└", "┴", "┘") + C.reset);
  return lines.join("\n");
}

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
  if (demo) console.log(`${C.dim}  (no live DB yet — showing a generated demo workload)${C.reset}\n`);
  else console.log(`${C.dim}  source: ${source}${C.reset}\n`);

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
