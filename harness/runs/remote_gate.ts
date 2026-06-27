// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/runs/remote_gate.ts
//
// Remote-runner gate (P6.1). A comment/API payload is scanned BEFORE any
// privileged execution: the run RECORD is created (not executed), the payload is
// ingested+scanned under it, and the verdict decides the disposition —
//   clean       -> dispatched (remote-runner)
//   suspicious/quarantined -> blocked, and optionally routed to a read-only
//                  security-review subagent. No build execution occurs until a
//                  human has reviewed critical findings.
// Findings + approval lineage live on the run record (run_id-scoped artifacts).
// Fail-closed: an unscannable payload is treated as quarantined.

import type { ExecutionProfile, TrustLabel } from "../contracts.ts";
import type { Db } from "../memory/db.ts";
import type { Telemetry } from "../telemetry/events.ts";
import { ingestArtifact } from "../memory/ingest.ts";
import type { ScannerClient } from "../security/scanner_client.ts";
import { chooseProfile } from "./profiles.ts";
import { setRunDisposition, startRun } from "./lineage.ts";
import { spawnSecurityReview } from "./security_review.ts";

export type DispatchDecision = "dispatched" | "blocked" | "routed-to-review";

export interface RemoteDispatchInput {
  source: string; // e.g. "github-comment", "api"
  sourcePath?: string; // e.g. "PR#42"
  payload: string;
  /** Run id to use (bind your Telemetry to the same id). Minted if omitted. */
  runId?: string;
  sessionId?: string;
  requestedProfile?: ExecutionProfile;
}

export interface RemoteDispatchOptions {
  telemetry?: Telemetry;
  /** Route suspicious/quarantined payloads to a read-only security-review
   *  subagent instead of hard-blocking. Default true. */
  routeToReview?: boolean;
}

export interface RemoteDispatchResult {
  decision: DispatchDecision;
  runId: string;
  reviewRunId?: string;
  artifactId: string;
  trustLabel: TrustLabel;
  findingCount: number;
  failClosed: boolean;
  profile: ExecutionProfile;
  reason: string;
}

export async function dispatchRemoteRun(
  db: Db,
  scanner: ScannerClient,
  input: RemoteDispatchInput,
  opts: RemoteDispatchOptions = {},
): Promise<RemoteDispatchResult> {
  const tel = opts.telemetry;
  const routeToReview = opts.routeToReview ?? true;
  const requested = input.requestedProfile ?? "remote-runner";

  // 1. create the run RECORD (a record is not execution).
  const runId = await startRun(
    db,
    { runId: input.runId, kind: "root", mode: "build", sandboxProfile: requested, sessionId: input.sessionId },
    tel,
  );

  // 2. PRE-DISPATCH SCAN: ingest+scan the payload before anything runs.
  const ing = await ingestArtifact(
    db,
    scanner,
    { runId, sourceType: input.source, sourcePath: input.sourcePath, rawContent: input.payload },
    { telemetry: tel },
  );
  const { trustLabel, findingCount, failClosed, artifactId } = ing;

  // 3. clean -> dispatch.
  if (trustLabel === "untrusted") {
    const profile = chooseProfile({ requested, trustLabel }).profile;
    await setRunDisposition(db, runId, { status: "dispatched", sandboxProfile: profile });
    return { decision: "dispatched", runId, artifactId, trustLabel, findingCount, failClosed, profile, reason: "clean payload; dispatched" };
  }

  // 4. suspicious/quarantined -> block; never dispatch a build.
  const profile = chooseProfile({ requested, trustLabel }).profile;
  await setRunDisposition(db, runId, { status: "blocked", sandboxProfile: profile });
  tel?.emit("remote_run_blocked", { run_id: runId, artifact_id: artifactId, trust_label: trustLabel, fail_closed: failClosed });

  if (routeToReview) {
    const reviewRunId = await spawnSecurityReview(db, runId, {}, tel);
    return {
      decision: "routed-to-review",
      runId,
      reviewRunId,
      artifactId,
      trustLabel,
      findingCount,
      failClosed,
      profile,
      reason: `payload ${trustLabel}; routed to read-only security-review`,
    };
  }
  return {
    decision: "blocked",
    runId,
    artifactId,
    trustLabel,
    findingCount,
    failClosed,
    profile,
    reason: `payload ${trustLabel}; blocked (no execution until reviewed)`,
  };
}
