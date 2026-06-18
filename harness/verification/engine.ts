// harness/verification/engine.ts
//
// Verification as task completion (PRD "Verification engine"). Runs the repo's
// check runners (test/lint/typecheck) AND enforces the security precondition:
// a build-capable run MUST fail closed when suspicious/quarantined content sits
// in the causal chain and has not been reviewed (CLAUDE.md #3).
//
// completionAllowed = securityOk && (allChecksPassed || acceptPartial)
// — but the security precondition is NEVER waivable by acceptPartial; it can be
// cleared ONLY by a recorded approval (approve / quarantine_release /
// promotion_approve). Partial completion waives FAILED CHECKS only.

import { spawn } from "node:child_process";
import type { Db } from "../memory/db.ts";

export interface CheckSpec {
  name: string;
  command: string[];
  cwd?: string;
}

export interface CheckResult {
  name: string;
  command: string;
  passed: boolean;
  exitCode: number | null;
  durationMs: number;
  output: string;
}

export interface VerificationReport {
  checks: CheckResult[];
  allPassed: boolean;
}

function runOne(spec: CheckSpec): Promise<CheckResult> {
  const [cmd, ...args] = spec.command;
  const started = Date.now();
  return new Promise<CheckResult>((resolve) => {
    const child = spawn(cmd!, args, { cwd: spec.cwd, shell: false });
    let output = "";
    child.stdout?.on("data", (d) => (output += d));
    child.stderr?.on("data", (d) => (output += d));
    const finish = (exitCode: number | null) =>
      resolve({
        name: spec.name,
        command: spec.command.join(" "),
        passed: exitCode === 0,
        exitCode,
        durationMs: Date.now() - started,
        output: output.slice(0, 4000),
      });
    child.on("close", (code) => finish(code));
    child.on("error", (e) => {
      output += `spawn error: ${String(e)}`;
      finish(null); // could not run -> not passed
    });
  });
}

/** Run all checks (sequentially, deterministic order). */
export async function runChecks(checks: CheckSpec[]): Promise<VerificationReport> {
  const results: CheckResult[] = [];
  for (const c of checks) results.push(await runOne(c));
  return { checks: results, allPassed: results.every((r) => r.passed) };
}

export interface BlockingArtifact {
  artifactId: string;
  trustLabel: string;
  failClosed: boolean;
}

export interface SecurityPrecondition {
  ok: boolean;
  reason: string;
  blocking: BlockingArtifact[];
}

/**
 * Security precondition for a run: any artifact in the run's causal chain that is
 * quarantined/suspicious and NOT cleared by an approval blocks completion.
 * Fail-closed: a fail_closed scan keeps its artifact quarantined here too.
 */
export async function securityPrecondition(db: Db, runId: string): Promise<SecurityPrecondition> {
  const rows = await db.all(
    `SELECT a.artifact_id AS artifact_id,
            a.trust_label AS trust_label,
            COALESCE(BOOL_OR(s.fail_closed), FALSE) AS fail_closed
     FROM content_artifacts a
     LEFT JOIN content_scans s ON s.artifact_id = a.artifact_id
     WHERE a.run_id = $1
       AND a.trust_label IN ('quarantined','suspicious')
       AND NOT EXISTS (
         SELECT 1 FROM approval_events e
         WHERE e.artifact_id = a.artifact_id
           AND e.action IN ('approve','quarantine_release','promotion_approve')
       )
     GROUP BY a.artifact_id, a.trust_label`,
    [runId],
  );
  const blocking: BlockingArtifact[] = rows.map((r) => ({
    artifactId: String(r.artifact_id),
    trustLabel: String(r.trust_label),
    failClosed: Boolean(r.fail_closed),
  }));
  if (blocking.length === 0) {
    return { ok: true, reason: "no unreviewed suspicious/quarantined artifacts in scope", blocking };
  }
  return {
    ok: false,
    reason: `security review required: ${blocking.length} unreviewed artifact(s) in the causal chain`,
    blocking,
  };
}

export interface VerifyResult {
  completionAllowed: boolean;
  reason: string;
  report: VerificationReport;
  security: SecurityPrecondition;
}

export interface VerifyOptions {
  /** Allow completion despite FAILED CHECKS (explicit user acceptance). Does NOT
   *  waive the security precondition. */
  acceptPartial?: boolean;
}

/** Run checks + the security precondition and decide whether completion is allowed. */
export async function verifyTask(
  db: Db,
  runId: string,
  checks: CheckSpec[],
  opts: VerifyOptions = {},
): Promise<VerifyResult> {
  const report = await runChecks(checks);
  const security = await securityPrecondition(db, runId);

  if (!security.ok) {
    // Fail-closed and NOT waivable by acceptPartial.
    return { completionAllowed: false, reason: security.reason, report, security };
  }
  if (report.allPassed) {
    return { completionAllowed: true, reason: "all checks passed; security clear", report, security };
  }
  if (opts.acceptPartial) {
    const failed = report.checks.filter((c) => !c.passed).map((c) => c.name);
    return {
      completionAllowed: true,
      reason: `partial completion accepted (failed checks waived: ${failed.join(", ")})`,
      report,
      security,
    };
  }
  const failed = report.checks.filter((c) => !c.passed).map((c) => c.name);
  return { completionAllowed: false, reason: `checks failed: ${failed.join(", ")}`, report, security };
}
