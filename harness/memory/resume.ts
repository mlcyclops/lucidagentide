// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/memory/resume.ts
//
// Resume a run from durable state SAFELY (PRD Phase 4: "a run can resume from
// durable state"). Safe means: the resume surfaces the run's security posture —
// any unreviewed quarantined/suspicious artifacts are reported, never silently
// re-trusted. Reuses the P3.1 security precondition.

import { securityPrecondition, type BlockingArtifact } from "../verification/engine.ts";
import { getWorkingState } from "./memory.ts";
import type { Db, Row } from "./db.ts";

export interface ResumeState {
  runId: string;
  workingState?: Row;
  /** Facts promoted from this run's artifacts. */
  factCount: number;
  /** Quarantined/suspicious artifacts in scope that lack an approval. */
  blocking: BlockingArtifact[];
  /** True when there is nothing unreviewed blocking the run. */
  safe: boolean;
}

export async function resumeRun(db: Db, runId: string): Promise<ResumeState> {
  const workingState = await getWorkingState(db, runId);
  const factsRow = await db.get(
    `SELECT count(*)::INT AS n
     FROM semantic_facts f
     JOIN content_artifacts a ON a.artifact_id = f.source_artifact_id
     WHERE a.run_id = $1`,
    [runId],
  );
  const security = await securityPrecondition(db, runId);
  return {
    runId,
    workingState,
    factCount: Number(factsRow?.n ?? 0),
    blocking: security.blocking,
    safe: security.ok,
  };
}
