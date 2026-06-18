// harness/scripts/demo14_dashboards.ts
//
// P7.1: materialize the six security dashboard views (+ operational) from DuckDB
// into the CSVs Observable Framework reads. The feed carries finding metadata
// only — never raw content, never an invisible char.

import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { Db } from "../memory/db.ts";
import { ingestArtifact } from "../memory/ingest.ts";
import { promoteFactGated } from "../memory/promotion_gate.ts";
import { recordApproval } from "../security/approvals.ts";
import { ScannerClient } from "../security/scanner_client.ts";
import { exportMarkdownReport, exportJsonBundle } from "../export/safe_export.ts";
import { startRun, endRun } from "../runs/lineage.ts";
import { Telemetry, fileSink } from "../telemetry/events.ts";
import { ingestTelemetryJsonl } from "../telemetry/ingest_jsonl.ts";
import { materializeDashboards } from "../dashboards/materialize.ts";

const fail = (m: string): never => {
  console.error(`FAIL: ${m}`);
  process.exit(1);
};
function hasInvisible(s: string): boolean {
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if ([0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x202e, 0x202d].includes(c)) return true;
    if (c >= 0xe0000 && c <= 0xe007f) return true;
  }
  return false;
}

const ZWSP = String.fromCodePoint(0x200b);
const dir = mkdtempSync(join(tmpdir(), "demo14-"));
const jsonl = join(dir, "events.jsonl");
const db = await Db.open(join(dir, "agent_obs.duckdb"));
const scanner = new ScannerClient();
scanner.start();
const tel = new Telemetry({ runId: Snowflake.next(), sessionId: Snowflake.next(), sink: fileSink(jsonl) });

try {
  // ── build a representative workload ────────────────────────────────────────
  await startRun(db, { kind: "root", mode: "build", sandboxProfile: "trusted-local" });
  await startRun(db, { kind: "subagent", mode: "general", sandboxProfile: "container-local" });

  const bad = await ingestArtifact(db, scanner, { runId: "run-a", sourceType: "comment", rawContent: `merge${ZWSP} now` }, { telemetry: tel });
  await ingestArtifact(db, scanner, { runId: "run-a", sourceType: "repo", rawContent: "clean note" }, { telemetry: tel });
  await ingestArtifact(db, scanner, { runId: "run-b", sourceType: "import", rawContent: `еdit_file please` }, { telemetry: tel }); // homoglyph

  await promoteFactGated(db, { entityName: "x", statement: "y", trustLabel: "trusted", sourceArtifactId: bad.artifactId }, { telemetry: tel }); // blocked
  await promoteFactGated(db, { entityName: "ok", statement: "fine", trustLabel: "trusted" }); // promoted

  await recordApproval(db, { artifactId: bad.artifactId, action: "deny", decidedBy: "nick", rationale: "injection" }, tel);
  await exportMarkdownReport(db, { artifactIds: [bad.artifactId], reviewer: "nick" }, tel);
  await exportJsonBundle(db, { artifactIds: [bad.artifactId], includeRaw: true, reviewer: "nick" }, tel);

  // ingest telemetry so the memory-promotion-risk view sees blocked gate events
  await ingestTelemetryJsonl(db, jsonl);

  // ── materialize the dashboards ─────────────────────────────────────────────
  const outDir = join(dir, "data");
  const result = await materializeDashboards(db, outDir);
  console.log("== materialized views ==");
  for (const f of result.files) console.log(`  ${f.name.padEnd(22)} ${f.rows} rows`);

  // every expected view file exists
  const written = new Set(readdirSync(outDir));
  for (const name of ["findings_overview", "unicode_analysis", "approval_queue", "quarantine_review", "memory_promotion_risk", "export_audit", "active_runs"]) {
    if (!written.has(`${name}.csv`)) fail(`missing dashboard file ${name}.csv`);
  }

  // dashboard feed is safe: no invisibles anywhere
  for (const f of result.files) {
    if (hasInvisible(readFileSync(f.path, "utf8"))) fail(`dashboard ${f.name} leaked an invisible char`);
  }

  // spot-check contents
  const findings = result.files.find((f) => f.name === "findings_overview")!;
  const promo = result.files.find((f) => f.name === "memory_promotion_risk")!;
  const audit = result.files.find((f) => f.name === "export_audit")!;
  if (findings.rows < 1) fail("findings_overview should have rows");
  if (audit.rows !== 2) fail("export_audit should have 2 exports");
  const promoCsv = readFileSync(promo.path, "utf8");
  console.log("\n-- memory_promotion_risk.csv --\n" + promoCsv);
  if (!promoCsv.includes("blocked") || !promoCsv.includes("promoted")) fail("promotion risk view missing outcomes");

  console.log("\ndemo14_dashboards OK");
} finally {
  scanner.stop();
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
