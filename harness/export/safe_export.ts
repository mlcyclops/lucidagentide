// harness/export/safe_export.ts
//
// Safe export + incident bundles (P6.2). Exports preserve evidence WITHOUT
// reintroducing dangerous content downstream: reports/CSV render only sanitized
// derivatives (escaped); the JSON evidence bundle stores raw separately and
// flagged, and OMITS raw by default. Every export writes an export_events audit
// row (export_events from P2.2) with a payload hash.

import { createHash } from "node:crypto";
import { Snowflake } from "@oh-my-pi/pi-utils";
import type { Db } from "../memory/db.ts";
import type { Telemetry } from "../telemetry/events.ts";

export type ExportType = "md_report" | "csv" | "json_bundle";

export interface ExportInput {
  artifactIds: string[];
  reviewer?: string;
  /** JSON bundle only: include the raw originals (flagged). Default false. */
  includeRaw?: boolean;
}

export interface ExportResult {
  exportId: string;
  type: ExportType;
  content: string;
  payloadSha256: string;
  includedRaw: boolean;
}

interface FindingExport {
  type: string;
  severity: string;
  codepoint: string | null;
  index: number | null;
}
interface ArtifactExport {
  artifactId: string;
  source: string;
  sourcePath: string | null;
  trustLabel: string;
  verdict: string | null;
  findingCount: number;
  findings: FindingExport[];
  sanitized: string;
  rawSha256: string;
  approvals: { action: string; decidedBy: string; rationale: string | null }[];
  raw?: string;
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

async function gatherOne(db: Db, artifactId: string, withRaw: boolean): Promise<ArtifactExport | undefined> {
  const a = await db.get(
    `SELECT source_type, source_path, trust_label, raw_sha256${withRaw ? ", raw_content" : ""}
     FROM content_artifacts WHERE artifact_id=$1`,
    [artifactId],
  );
  if (!a) return undefined;
  const scan = await db.get(
    "SELECT scan_id, verdict, finding_count FROM content_scans WHERE artifact_id=$1 ORDER BY created_at DESC LIMIT 1",
    [artifactId],
  );
  const findings = scan
    ? await db.all(
        "SELECT finding_type, severity, codepoint, char_index FROM security_findings WHERE scan_id=$1 ORDER BY char_index",
        [scan.scan_id],
      )
    : [];
  const san = await db.get(
    "SELECT sanitized_content FROM sanitized_artifacts WHERE artifact_id=$1 ORDER BY created_at DESC LIMIT 1",
    [artifactId],
  );
  const approvals = await db.all(
    "SELECT action, decided_by, rationale FROM approval_events WHERE artifact_id=$1 ORDER BY created_at",
    [artifactId],
  );
  return {
    artifactId,
    source: String(a.source_type),
    sourcePath: a.source_path == null ? null : String(a.source_path),
    trustLabel: String(a.trust_label),
    verdict: scan?.verdict == null ? null : String(scan.verdict),
    findingCount: Number(scan?.finding_count ?? 0),
    findings: findings.map((f) => ({
      type: String(f.finding_type),
      severity: String(f.severity),
      codepoint: f.codepoint == null ? null : String(f.codepoint),
      index: f.char_index == null ? null : Number(f.char_index),
    })),
    sanitized: typeof san?.sanitized_content === "string" ? san.sanitized_content : "",
    rawSha256: String(a.raw_sha256),
    approvals: approvals.map((r) => ({
      action: String(r.action),
      decidedBy: String(r.decided_by),
      rationale: r.rationale == null ? null : String(r.rationale),
    })),
    ...(withRaw ? { raw: typeof a.raw_content === "string" ? a.raw_content : "" } : {}),
  };
}

async function gather(db: Db, ids: string[], withRaw: boolean): Promise<ArtifactExport[]> {
  const out: ArtifactExport[] = [];
  for (const id of ids) {
    const a = await gatherOne(db, id, withRaw);
    if (a) out.push(a);
  }
  return out;
}

const ZERO_WIDTH = new Set([0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x180e]);
const BIDI = new Set([0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x061c]);

/** A code point that must never be emitted raw into an export. */
function isDangerousCodepoint(code: number): boolean {
  if (code < 0x20 && code !== 0x0a && code !== 0x09) return true; // control (keep \n \t)
  if (code === 0x7f) return true; // DEL
  if (ZERO_WIDTH.has(code) || BIDI.has(code)) return true;
  if (code >= 0xe0000 && code <= 0xe007f) return true; // Unicode Tag block
  return false;
}

/** Escape Markdown metacharacters AND replace any dangerous/invisible code point
 *  with its U+XXXX notation. Defense in depth: sanitized text is already clean,
 *  but escapeMarkdown alone guarantees no export emits an invisible/control char. */
export function escapeMarkdown(s: string): string {
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (isDangerousCodepoint(code)) {
      out += `\\u{${code.toString(16)}}`;
    } else if ("\\`*_{}[]()#+-!|<>".includes(ch)) {
      out += "\\" + ch;
    } else {
      out += ch;
    }
  }
  return out;
}

/** CSV field quoting; flattens newlines so a field can't break the row grid and
 *  neutralizes any dangerous/invisible code point (defense in depth). */
export function csvField(s: string): string {
  let neutralized = "";
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    neutralized += isDangerousCodepoint(code) ? `\\u{${code.toString(16)}}` : ch;
  }
  const flat = neutralized.replace(/[\r\n]+/g, " ");
  return `"${flat.replace(/"/g, '""')}"`;
}

async function recordExport(
  db: Db,
  type: ExportType,
  input: ExportInput,
  content: string,
  includedRaw: boolean,
  tel?: Telemetry,
): Promise<ExportResult> {
  const exportId = Snowflake.next();
  const payloadSha256 = sha256(content);
  await db.run(
    `INSERT INTO export_events
       (export_id, export_type, source_artifact_ids, sanitization_status, included_raw, reviewer, payload_sha256, created_at)
     VALUES ($1,$2,CAST($3 AS JSON),$4,$5,$6,$7,$8)`,
    [
      exportId,
      type,
      JSON.stringify(input.artifactIds),
      includedRaw ? "raw-flagged" : "sanitized-only",
      includedRaw,
      input.reviewer ?? null,
      payloadSha256,
      new Date().toISOString(),
    ],
  );
  tel?.emit(type === "json_bundle" ? "incident_bundle_created" : "safe_export_created", {
    export_id: exportId,
    export_type: type,
    included_raw: includedRaw,
    reviewer: input.reviewer,
  });
  return { exportId, type, content, payloadSha256, includedRaw };
}

/** Escaped Markdown incident report. Renders sanitized snippets + finding
 *  metadata; never renders raw. */
export async function exportMarkdownReport(db: Db, input: ExportInput, tel?: Telemetry): Promise<ExportResult> {
  const arts = await gather(db, input.artifactIds, false);
  const lines: string[] = ["# Security incident report", ""];
  if (input.reviewer) lines.push(`Reviewer: ${escapeMarkdown(input.reviewer)}`, "");
  for (const a of arts) {
    lines.push(`## Artifact ${escapeMarkdown(a.artifactId)}`);
    lines.push(
      `- source: ${escapeMarkdown(a.source)}${a.sourcePath ? ` (${escapeMarkdown(a.sourcePath)})` : ""}`,
      `- trust: ${a.trustLabel} · verdict: ${a.verdict ?? "-"} · findings: ${a.findingCount}`,
      `- raw sha256: \`${a.rawSha256}\` (raw NOT rendered)`,
    );
    if (a.findings.length) {
      lines.push("", "| type | severity | codepoint | index |", "| --- | --- | --- | --- |");
      for (const f of a.findings) lines.push(`| ${f.type} | ${f.severity} | ${f.codepoint ?? "-"} | ${f.index ?? "-"} |`);
    }
    if (a.approvals.length) {
      lines.push("", "Approvals:");
      for (const ap of a.approvals) lines.push(`- ${ap.action} by ${escapeMarkdown(ap.decidedBy)}${ap.rationale ? ` — ${escapeMarkdown(ap.rationale)}` : ""}`);
    }
    lines.push("", "Sanitized excerpt:", "", "> " + escapeMarkdown(a.sanitized.slice(0, 280)).replace(/\n/g, "\n> "), "");
  }
  return recordExport(db, "md_report", input, lines.join("\n"), false, tel);
}

/** CSV of finding metadata + sanitized snippets only. */
export async function exportCsv(db: Db, input: ExportInput, tel?: Telemetry): Promise<ExportResult> {
  const arts = await gather(db, input.artifactIds, false);
  const rows: string[] = ["artifact_id,source,trust_label,verdict,finding_type,severity,codepoint,sanitized_snippet"];
  for (const a of arts) {
    const snippet = a.sanitized.slice(0, 120);
    if (a.findings.length === 0) {
      rows.push([a.artifactId, a.source, a.trustLabel, a.verdict ?? "", "", "", "", snippet].map(csvField).join(","));
    }
    for (const f of a.findings) {
      rows.push(
        [a.artifactId, a.source, a.trustLabel, a.verdict ?? "", f.type, f.severity, f.codepoint ?? "", snippet]
          .map(csvField)
          .join(","),
      );
    }
  }
  return recordExport(db, "csv", input, rows.join("\n"), false, tel);
}

/** JSON evidence bundle. Raw is OMITTED unless includeRaw, and when present it is
 *  isolated under `raw_evidence` and flagged dangerous. */
export async function exportJsonBundle(db: Db, input: ExportInput, tel?: Telemetry): Promise<ExportResult> {
  const includeRaw = input.includeRaw ?? false;
  const arts = await gather(db, input.artifactIds, includeRaw);
  const bundle = {
    kind: "incident-evidence-bundle",
    includes_raw: includeRaw,
    reviewer: input.reviewer ?? null,
    artifacts: arts.map((a) => ({
      artifact_id: a.artifactId,
      source: a.source,
      source_path: a.sourcePath,
      trust_label: a.trustLabel,
      verdict: a.verdict,
      finding_count: a.findingCount,
      findings: a.findings,
      sanitized: a.sanitized,
      raw_sha256: a.rawSha256,
      approvals: a.approvals,
      ...(includeRaw
        ? { raw_evidence: { WARNING: "DANGEROUS_RAW_DO_NOT_RENDER", content: a.raw } }
        : {}),
    })),
  };
  return recordExport(db, "json_bundle", input, JSON.stringify(bundle, null, 2), includeRaw, tel);
}
