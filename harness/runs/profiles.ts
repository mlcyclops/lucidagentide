// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/runs/profiles.ts
//
// Sandbox profiles as a POLICY layer over omp's isolation backends (P5.2). omp
// already ships worktree / fuse-overlay / ProjFS isolation; our five profiles map
// onto them and add the security rules (capabilities + auto-downgrade).
//
// Auto-downgrade is the load-bearing rule: a task whose causal chain holds
// unreviewed suspicious/quarantined content is forced into a safer profile, and
// the security-review/replay modes are always read-only.

import type { AgentMode, ExecutionProfile, TrustLabel } from "../contracts.ts";

/** omp isolation backend (worktree everywhere; "overlay" = fuse-overlay on
 *  Linux / ProjFS on Windows, resolved by omp per platform). */
export type OmpIsolation = "none" | "worktree" | "overlay";

export interface ProfileCaps {
  canWrite: boolean;
  canExec: boolean;
  canNetwork: boolean;
  isolation: OmpIsolation;
}

export const PROFILE_CAPS: Record<ExecutionProfile, ProfileCaps> = {
  "trusted-local": { canWrite: true, canExec: true, canNetwork: true, isolation: "none" },
  "container-local": { canWrite: true, canExec: true, canNetwork: false, isolation: "overlay" },
  "remote-runner": { canWrite: true, canExec: true, canNetwork: true, isolation: "worktree" },
  "read-only-audit": { canWrite: false, canExec: false, canNetwork: false, isolation: "worktree" },
  quarantine: { canWrite: false, canExec: false, canNetwork: false, isolation: "worktree" },
  // ADR-0133 (P-AGENT.1): a Builder-authored agent runs capable but ISOLATED (worktree) and always under the
  // fail-closed gate + its tool allow-list + egress whitelist. Its non-destructive dry-run uses read-only-audit.
  "built-agent": { canWrite: true, canExec: true, canNetwork: true, isolation: "worktree" },
};

export function caps(profile: ExecutionProfile): ProfileCaps {
  return PROFILE_CAPS[profile];
}
export function isReadOnly(profile: ExecutionProfile): boolean {
  return !PROFILE_CAPS[profile].canWrite && !PROFILE_CAPS[profile].canExec;
}

/** Restrictiveness rank (higher = more restrictive). Used to detect downgrades. Only relative order matters.
 *  built-agent sits just above trusted-local: capable, but isolated + gated, so a request for it that gets
 *  downgraded (suspicious chain) still registers as a downgrade. */
const RANK: Record<ExecutionProfile, number> = {
  "trusted-local": 0,
  "built-agent": 1,
  "remote-runner": 2,
  "container-local": 3,
  "read-only-audit": 4,
  quarantine: 5,
};

export interface ProfileDecisionInput {
  /** What was requested (default trusted-local). */
  requested?: ExecutionProfile;
  mode?: AgentMode;
  /** Worst trust label in the task's causal chain. */
  trustLabel?: TrustLabel;
  /** Suspicious/quarantined content has been reviewed + approved. */
  approved?: boolean;
  /** Task is a CI/PR/remote-triggered run. */
  remote?: boolean;
}

export interface ProfileDecision {
  profile: ExecutionProfile;
  downgraded: boolean;
  reason: string;
}

/**
 * Choose the execution profile, auto-downgrading when the causal chain is
 * suspicious/quarantined. Never UPGRADES past what was requested.
 */
export function chooseProfile(input: ProfileDecisionInput): ProfileDecision {
  const requested = input.requested ?? (input.remote ? "remote-runner" : "trusted-local");

  // Read-only modes are always read-only-audit, regardless of request.
  if (input.mode === "security-review" || input.mode === "replay") {
    return mk("read-only-audit", requested, `mode ${input.mode} is read-only`);
  }

  if (!input.approved) {
    if (input.trustLabel === "quarantined") {
      return mk("quarantine", requested, "quarantined content in causal chain (unreviewed)");
    }
    if (input.trustLabel === "suspicious") {
      // downgrade to at least container-local
      const chosen = RANK[requested] >= RANK["container-local"] ? requested : "container-local";
      return mk(chosen, requested, "suspicious content in causal chain (unreviewed)");
    }
  }

  return mk(requested, requested, input.approved ? "approved; honoring requested profile" : "clean; honoring requested profile");

  function mk(profile: ExecutionProfile, req: ExecutionProfile, reason: string): ProfileDecision {
    return { profile, downgraded: RANK[profile] > RANK[req], reason };
  }
}
