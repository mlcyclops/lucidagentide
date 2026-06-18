// harness/memory/ingest.ts
//
// The P2.3 ingestion pipeline: raw external content in -> scanned, trust-labeled,
// sanitized, and persisted as artifact + scan + findings + sanitized-derivative
// rows. Fail-closed (CLAUDE.md #3): if the scan can't be obtained, the artifact
// is recorded as QUARANTINED, never trusted.
//
// Trust labeling for INGESTED EXTERNAL content (distinct from the gate's
// block/allow view): external content is NEVER auto-trusted. Clean external text
// is "untrusted" (safe to quote as data, not to obey), not "trusted".

import { createHash } from "node:crypto";
import { Snowflake } from "@oh-my-pi/pi-utils";
import type { Finding, Severity, TrustLabel } from "../contracts.ts";
import { ScannerClient, ScanUnavailableError } from "../security/scanner_client.ts";
import { DEFAULT_POLICY, type GatePolicy } from "../security/gate.ts";
import { DEFAULT_SANITIZE_POLICY, policyLabel, sanitize, type SanitizePolicy } from "./sanitize.ts";
import type { Db } from "./db.ts";
import type { Telemetry } from "../telemetry/events.ts";

const SEVERITY_RANK: Record<Severity, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };

export type Verdict = "clean" | "suspicious" | "quarantined";

export interface IngestInput {
  runId: string;
  sourceType: string;
  sourcePath?: string;
  rawContent: string;
}

export interface IngestOptions {
  gatePolicy?: GatePolicy;
  sanitizePolicy?: SanitizePolicy;
  telemetry?: Telemetry;
}

export interface IngestResult {
  artifactId: string;
  scanId: string;
  sanitizedId: string;
  findingIds: string[];
  trustLabel: TrustLabel;
  verdict: Verdict;
  failClosed: boolean;
  riskScore: number;
  findingCount: number;
  scannerVersion: string;
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

interface Decision {
  trustLabel: TrustLabel;
  verdict: Verdict;
  riskScore: number;
}

function decide(findings: Finding[], failClosed: boolean, policy: GatePolicy): Decision {
  if (failClosed) return { trustLabel: "quarantined", verdict: "quarantined", riskScore: 1 };
  if (findings.length === 0) return { trustLabel: "untrusted", verdict: "clean", riskScore: 0 };
  const top = findings.reduce((m, f) => Math.max(m, SEVERITY_RANK[f.severity]), 0);
  const riskScore = top / 4;
  if (top >= SEVERITY_RANK[policy.blockAtOrAbove]) {
    return { trustLabel: "quarantined", verdict: "quarantined", riskScore };
  }
  return { trustLabel: "suspicious", verdict: "suspicious", riskScore };
}

/**
 * Ingest one artifact: scan -> label -> sanitize -> persist. Always records the
 * artifact (raw preserved), even when quarantined or when the scan failed closed.
 */
export async function ingestArtifact(
  db: Db,
  scanner: ScannerClient,
  input: IngestInput,
  opts: IngestOptions = {},
): Promise<IngestResult> {
  const gatePolicy = opts.gatePolicy ?? DEFAULT_POLICY;
  const sanitizePolicy = opts.sanitizePolicy ?? DEFAULT_SANITIZE_POLICY;
  const tel = opts.telemetry;
  const now = new Date().toISOString();

  // 1. scan (fail-closed: any failure => treat as unscanned => quarantine)
  let findings: Finding[] = [];
  let failClosed = false;
  let scannerVersion = "unavailable";
  try {
    const resp = await scanner.scan(input.rawContent);
    findings = resp.findings;
    scannerVersion = resp.scanner_version;
  } catch (err) {
    if (!(err instanceof ScanUnavailableError)) throw err;
    failClosed = true;
  }

  const { trustLabel, verdict, riskScore } = decide(findings, failClosed, gatePolicy);

  // 2. persist artifact (raw original always preserved for forensics)
  const artifactId = Snowflake.next();
  tel?.emit("content_ingested", {
    artifact_id: artifactId,
    source_type: input.sourceType,
    source_path: input.sourcePath,
  });
  await db.run(
    `INSERT INTO content_artifacts
       (artifact_id, run_id, source_type, source_path, trust_label, raw_content, raw_sha256, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      artifactId,
      input.runId,
      input.sourceType,
      input.sourcePath ?? null,
      trustLabel,
      input.rawContent,
      sha256(input.rawContent),
      now,
    ],
  );

  // 3. persist scan
  const scanId = Snowflake.next();
  await db.run(
    `INSERT INTO content_scans
       (scan_id, artifact_id, scanner_name, scanner_version, verdict, risk_score, finding_count, fail_closed, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [scanId, artifactId, "unicode-scanner", scannerVersion, verdict, riskScore, findings.length, failClosed, now],
  );
  tel?.emit("content_scanned", {
    artifact_id: artifactId,
    scan_id: scanId,
    verdict,
    scanner_version: scannerVersion,
    fail_closed: failClosed,
  });

  // 4. persist findings
  const findingIds: string[] = [];
  for (const f of findings) {
    const findingId = Snowflake.next();
    findingIds.push(findingId);
    await db.run(
      `INSERT INTO security_findings
         (finding_id, scan_id, finding_type, severity, codepoint, char_index, description, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [findingId, scanId, f.type, f.severity, f.codepoint, f.index, f.name ?? null, now],
    );
    tel?.emit("finding_detected", {
      artifact_id: artifactId,
      scan_id: scanId,
      finding_id: findingId,
      finding_type: f.type,
      severity: f.severity,
    });
  }

  // 5. persist sanitized derivative
  const { sanitized, changed } = sanitize(input.rawContent, sanitizePolicy);
  const sanitizedId = Snowflake.next();
  await db.run(
    `INSERT INTO sanitized_artifacts
       (sanitized_id, artifact_id, scan_id, policy, sanitized_content, sanitized_sha256, changed, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [sanitizedId, artifactId, scanId, policyLabel(sanitizePolicy), sanitized, sha256(sanitized), changed, now],
  );
  tel?.emit("artifact_sanitized", { artifact_id: artifactId, sanitized_id: sanitizedId, changed });

  if (trustLabel === "quarantined") {
    tel?.emit("artifact_quarantined", { artifact_id: artifactId, scan_id: scanId, fail_closed: failClosed });
  }

  return {
    artifactId,
    scanId,
    sanitizedId,
    findingIds,
    trustLabel,
    verdict,
    failClosed,
    riskScore,
    findingCount: findings.length,
    scannerVersion,
  };
}
