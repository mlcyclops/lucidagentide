// harness/runs/security_review.ts
//
// The security-review subagent (P5.2): a read-only / quarantine child run for
// triaging suspicious content. It MUST be read-only — enforced here, not just by
// convention (PRD: security-review operates in read-only or quarantine contexts).

import type { ExecutionProfile } from "../contracts.ts";
import type { Db } from "../memory/db.ts";
import type { Telemetry } from "../telemetry/events.ts";
import { spawnSubagent } from "./lineage.ts";
import { isReadOnly } from "./profiles.ts";

export type SecurityReviewProfile = Extract<ExecutionProfile, "read-only-audit" | "quarantine">;

export interface SecurityReviewOptions {
  /** read-only-audit (default) or quarantine. Both are read-only. */
  profile?: SecurityReviewProfile;
}

/** Spawn a read-only security-review subagent under `parentRunId`. */
export async function spawnSecurityReview(
  db: Db,
  parentRunId: string,
  opts: SecurityReviewOptions = {},
  tel?: Telemetry,
): Promise<string> {
  const profile = opts.profile ?? "read-only-audit";
  if (!isReadOnly(profile)) {
    // Defense in depth: a security-review must never get write/exec.
    throw new Error(`security-review must be read-only; profile '${profile}' grants write/exec`);
  }
  return spawnSubagent(db, parentRunId, { kind: "security-review", mode: "security-review", sandboxProfile: profile }, tel);
}
