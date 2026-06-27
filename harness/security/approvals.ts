// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/security/approvals.ts
//
// The human review workflow (PRD "Required review actions"). Every approval is a
// durable, audited row: who decided, when, why, and at what scope. approve /
// deny / quarantine-release / memory-promotion-approve.

import { Snowflake } from "@oh-my-pi/pi-utils";
import type { Db } from "../memory/db.ts";
import type { Telemetry } from "../telemetry/events.ts";

export type ApprovalAction = "approve" | "deny" | "quarantine_release" | "promotion_approve";

export interface ApprovalInput {
  artifactId?: string;
  action: ApprovalAction;
  /** Who made the decision (user id / handle). Required for the audit trail. */
  decidedBy: string;
  rationale?: string;
  scope?: string;
}

/** Persist an approval decision; returns its stable approval_id. */
export async function recordApproval(db: Db, input: ApprovalInput, tel?: Telemetry): Promise<string> {
  const approvalId = Snowflake.next();
  await db.run(
    `INSERT INTO approval_events (approval_id, artifact_id, action, decided_by, rationale, scope, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      approvalId,
      input.artifactId ?? null,
      input.action,
      input.decidedBy,
      input.rationale ?? null,
      input.scope ?? null,
      new Date().toISOString(),
    ],
  );

  // deny is the only "not granted" action; the rest move the workflow forward.
  const event = input.action === "deny" ? "approval_denied" : "approval_granted";
  tel?.emit(event, {
    artifact_id: input.artifactId,
    approval_id: approvalId,
    action: input.action,
    decided_by: input.decidedBy,
    scope: input.scope,
  });
  return approvalId;
}
