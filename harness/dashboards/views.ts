// harness/dashboards/views.ts
//
// Dashboard view queries (P7.1). The six security dashboard views (PRD) plus a
// couple of operational views. Every view exposes finding METADATA only — no
// raw content, no raw_content column is ever selected — so dashboards are safe
// by construction (PRD: dashboard feeds expose metadata, not unsafe raw).

import type { Db, Row } from "../memory/db.ts";

/** 1. Findings overview — count findings by type, severity, source. */
export function findingsOverview(db: Db): Promise<Row[]> {
  return db.all(
    `SELECT f.finding_type, f.severity, a.source_type AS source, count(*)::INT AS n
     FROM security_findings f
     JOIN content_scans sc ON sc.scan_id = f.scan_id
     JOIN content_artifacts a ON a.artifact_id = sc.artifact_id
     GROUP BY f.finding_type, f.severity, a.source_type
     ORDER BY n DESC, f.finding_type`,
  );
}

/** 2. Unicode analysis — finding-type distribution by source. */
export function unicodeAnalysis(db: Db): Promise<Row[]> {
  return db.all(
    `SELECT a.source_type AS source, f.finding_type, count(*)::INT AS n
     FROM security_findings f
     JOIN content_scans sc ON sc.scan_id = f.scan_id
     JOIN content_artifacts a ON a.artifact_id = sc.artifact_id
     GROUP BY a.source_type, f.finding_type
     ORDER BY source, n DESC`,
  );
}

/** 3. Approval queue — unreviewed suspicious/quarantined artifacts (blocked). */
export function approvalQueue(db: Db): Promise<Row[]> {
  return db.all(
    `SELECT a.artifact_id, a.run_id, a.source_type AS source, a.trust_label,
            (SELECT sc.verdict FROM content_scans sc WHERE sc.artifact_id = a.artifact_id ORDER BY sc.created_at DESC LIMIT 1) AS verdict,
            (SELECT sc.finding_count FROM content_scans sc WHERE sc.artifact_id = a.artifact_id ORDER BY sc.created_at DESC LIMIT 1) AS finding_count
     FROM content_artifacts a
     WHERE a.trust_label IN ('quarantined','suspicious')
       AND NOT EXISTS (
         SELECT 1 FROM approval_events e
         WHERE e.artifact_id = a.artifact_id
           AND e.action IN ('approve','quarantine_release','promotion_approve'))
     ORDER BY a.created_at DESC`,
  );
}

/** 4. Quarantine review — artifacts currently isolated. */
export function quarantineReview(db: Db): Promise<Row[]> {
  return db.all(
    `SELECT a.artifact_id, a.source_type AS source, a.trust_label,
            (SELECT sc.risk_score FROM content_scans sc WHERE sc.artifact_id = a.artifact_id ORDER BY sc.created_at DESC LIMIT 1) AS risk_score,
            (SELECT sc.finding_count FROM content_scans sc WHERE sc.artifact_id = a.artifact_id ORDER BY sc.created_at DESC LIMIT 1) AS finding_count,
            (SELECT sc.fail_closed FROM content_scans sc WHERE sc.artifact_id = a.artifact_id ORDER BY sc.created_at DESC LIMIT 1) AS fail_closed
     FROM content_artifacts a
     WHERE a.trust_label = 'quarantined'
     ORDER BY a.created_at DESC`,
  );
}

/** 5. Memory promotion risk — blocked (gate) vs promoted (semantic). */
export function memoryPromotionRisk(db: Db): Promise<Row[]> {
  return db.all(
    `SELECT 'blocked' AS outcome, count(*)::INT AS n FROM telemetry_events WHERE event = 'memory_promotion_blocked'
     UNION ALL
     SELECT 'promoted' AS outcome, count(*)::INT AS n FROM semantic_facts
     ORDER BY outcome`,
  );
}

/** 6. Export audit — what was exported, sanitized, by whom. */
export function exportAudit(db: Db): Promise<Row[]> {
  return db.all(
    `SELECT export_type, sanitization_status, included_raw, reviewer, payload_sha256, created_at
     FROM export_events
     ORDER BY created_at DESC`,
  );
}

// ── operational ──────────────────────────────────────────────────────────────

/** Active runs overview. */
export function activeRuns(db: Db): Promise<Row[]> {
  return db.all(
    `SELECT run_id, parent_run_id, kind, mode, sandbox_profile, status FROM runs ORDER BY created_at DESC`,
  );
}

/** All dashboard views keyed by their output file basename. */
export const DASHBOARD_VIEWS: Record<string, (db: Db) => Promise<Row[]>> = {
  findings_overview: findingsOverview,
  unicode_analysis: unicodeAnalysis,
  approval_queue: approvalQueue,
  quarantine_review: quarantineReview,
  memory_promotion_risk: memoryPromotionRisk,
  export_audit: exportAudit,
  active_runs: activeRuns,
};
