// harness/telemetry/queries.ts
//
// Sample analytical + replay queries over telemetry_events (P3.2 acceptance:
// security events are queryable and replayable). These back the demo and, later,
// the Phase-7 dashboards.

import type { Db, Row } from "../memory/db.ts";

/** Event counts by type (optionally scoped to a run). */
export async function eventCountsByType(db: Db, runId?: string): Promise<Row[]> {
  return runId === undefined
    ? db.all("SELECT event, count(*)::INT AS n FROM telemetry_events GROUP BY event ORDER BY n DESC, event")
    : db.all(
        "SELECT event, count(*)::INT AS n FROM telemetry_events WHERE run_id=$1 GROUP BY event ORDER BY n DESC, event",
        [runId],
      );
}

/** Prompt-injection finding counts by finding_type (from finding_detected events). */
export async function findingsByType(db: Db): Promise<Row[]> {
  return db.all(
    `SELECT json_extract_string(fields, '$.finding_type') AS finding_type,
            json_extract_string(fields, '$.severity')     AS severity,
            count(*)::INT AS n
     FROM telemetry_events
     WHERE event = 'finding_detected'
     GROUP BY finding_type, severity
     ORDER BY n DESC, finding_type`,
  );
}

/** Every blocked tool call (with the tool + reason). */
export async function blockedToolCalls(db: Db): Promise<Row[]> {
  return db.all(
    `SELECT ts,
            run_id,
            json_extract_string(fields, '$.tool')        AS tool,
            json_extract_string(fields, '$.trust_label') AS trust_label,
            json_extract_string(fields, '$.reason')      AS reason
     FROM telemetry_events
     WHERE event = 'tool_call_blocked'
     ORDER BY ts`,
  );
}

/** Approval decisions by action. */
export async function approvalsByAction(db: Db): Promise<Row[]> {
  return db.all(
    `SELECT json_extract_string(fields, '$.action') AS action, count(*)::INT AS n
     FROM telemetry_events
     WHERE event IN ('approval_granted','approval_denied')
     GROUP BY action ORDER BY n DESC, action`,
  );
}

/** Reconstruct a run's event timeline (replay), ordered by time. */
export async function runTimeline(db: Db, runId: string): Promise<Row[]> {
  return db.all(
    "SELECT ts, event, artifact_id FROM telemetry_events WHERE run_id=$1 ORDER BY ts, event_id",
    [runId],
  );
}
