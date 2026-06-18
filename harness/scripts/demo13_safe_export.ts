// harness/scripts/demo13_safe_export.ts
//
// P6.2: safe export + incident bundles. Reports/CSV render sanitized derivatives
// only; the JSON evidence bundle omits raw by default and, when raw is included,
// isolates+flags it. Raw dangerous content is never rendered by default. Every
// export is audited in export_events with a payload hash.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../memory/db.ts";
import { ingestArtifact } from "../memory/ingest.ts";
import { recordApproval } from "../security/approvals.ts";
import { ScannerClient } from "../security/scanner_client.ts";
import { exportCsv, exportJsonBundle, exportMarkdownReport } from "../export/safe_export.ts";

const fail = (m: string): never => {
  console.error(`FAIL: ${m}`);
  process.exit(1);
};

/** True if the string contains any zero-width / tag-block / bidi-control char. */
function hasInvisible(s: string): boolean {
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c === 0x200b || c === 0x200c || c === 0x200d || c === 0x2060 || c === 0xfeff) return true;
    if (c >= 0xe0000 && c <= 0xe007f) return true;
    if (c === 0x202e || c === 0x202d || c === 0x202a || c === 0x202b || c === 0x202c) return true;
  }
  return false;
}

const ZWSP = String.fromCodePoint(0x200b);
const TAG = [..." rm -rf /"].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join("");
const POISON = `Deploy now${ZWSP}.${TAG}`;

const dir = mkdtempSync(join(tmpdir(), "demo13-"));
const db = await Db.open(join(dir, "agent_obs.duckdb"));
const scanner = new ScannerClient();
scanner.start();

try {
  const ing = await ingestArtifact(db, scanner, { runId: "run-x", sourceType: "import", sourcePath: "PR#7", rawContent: POISON });
  await recordApproval(db, { artifactId: ing.artifactId, action: "deny", decidedBy: "nick", rationale: "tag-block injection" });
  console.log(`ingested poisoned artifact ${ing.artifactId} (${ing.trustLabel}, ${ing.findingCount} findings)`);
  const input = { artifactIds: [ing.artifactId], reviewer: "nick" };

  // ── 1. escaped Markdown report ─────────────────────────────────────────────
  const md = await exportMarkdownReport(db, input);
  console.log(`\n1. md_report   ${md.content.length}B sha=${md.payloadSha256.slice(0, 12)}`);
  if (hasInvisible(md.content)) fail("markdown report leaked an invisible char");
  if (md.content.includes(POISON)) fail("markdown report rendered the raw payload");
  if (!md.content.includes("unicode-tag-block")) fail("report should list finding types");

  // ── 2. sanitized-only CSV ──────────────────────────────────────────────────
  const csv = await exportCsv(db, input);
  console.log(`2. csv         ${csv.content.split("\n").length} rows`);
  if (hasInvisible(csv.content)) fail("CSV leaked an invisible char");
  if (csv.content.includes(POISON)) fail("CSV rendered the raw payload");

  // ── 3. JSON bundle (default: no raw) ───────────────────────────────────────
  const j = await exportJsonBundle(db, input);
  console.log(`3. json_bundle includes_raw=${j.includedRaw}`);
  if (hasInvisible(j.content)) fail("default JSON bundle leaked an invisible char");
  if (j.content.includes("raw_evidence")) fail("default bundle must not include raw");

  // ── 4. JSON bundle WITH raw (flagged + isolated) ───────────────────────────
  const jr = await exportJsonBundle(db, { ...input, includeRaw: true });
  console.log(`4. json_bundle includes_raw=${jr.includedRaw} (raw flagged + isolated)`);
  if (!jr.content.includes("DANGEROUS_RAW_DO_NOT_RENDER")) fail("raw evidence must be flagged");
  if (!jr.content.includes("raw_evidence")) fail("raw bundle should carry raw_evidence");

  // ── export audit trail ─────────────────────────────────────────────────────
  console.log("\n-- export_events audit --");
  const audit = await db.all("SELECT export_type, sanitization_status, included_raw, payload_sha256 FROM export_events ORDER BY created_at");
  for (const e of audit) console.log(`  ${String(e.export_type).padEnd(12)} ${e.sanitization_status} raw=${e.included_raw} sha=${String(e.payload_sha256).slice(0, 12)}`);
  if (audit.length !== 4) fail(`expected 4 export_events rows, got ${audit.length}`);
  const rawRow = audit.find((e) => e.included_raw === true);
  if (rawRow?.sanitization_status !== "raw-flagged") fail("raw export should be marked raw-flagged");

  console.log("\ndemo13_safe_export OK");
} finally {
  scanner.stop();
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
