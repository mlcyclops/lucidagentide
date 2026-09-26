// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/maintainer/contracts.ts
//
// P-MAINT.1: the Maintainer Agent SPIKE contract. A Maintainer Agent is a long-lived, OS-SCHEDULED
// agent that periodically re-reviews a repository it owns: it re-reads the dependency manifests,
// asks an OFFICIAL advisory feed (OSV, which aggregates CVE + GHSA) what is known-vulnerable,
// rebuilds a CycloneDX SBOM and diffs it against the last one, and renders the pull request plus
// tracker item (GitHub issue / GitLab issue / Azure DevOps work item) a human should act on.
//
// SCOPE OF THIS FILE'S REPO (the public core): the spike is ADDITIVE and READ-ONLY. It discovers,
// parses, queries, diffs, and RENDERS. It never files anything and never mutates a repository.
// Actually opening the PR / issue / work item (which needs a per-host credential out of the OS
// vault) is the enterprise addon's job; the core only proves the capability and owns the shapes.
//
// These types are the contract BOTH repos implement against, so they are duplicated verbatim in
// the addon rather than imported across the repo boundary (the addon consumes the core contract
// and never modifies core).

export type Ecosystem = "npm" | "pypi" | "cargo" | "go" | "maven" | "nuget";
export type Cadence = { kind: "interval"; everyMin: number } | { kind: "daily"; hhmm: string };
export type TrackerKind = "github" | "gitlab" | "azure-devops";

/** One repository a maintainer agent owns. */
export interface MaintainerTarget {
  id: string;
  repoUrl: string;
  provider: TrackerKind | "other";
  localPath: string;
  cadence: Cadence;
  /** Render and open a PR for updates it judges safe. Default false (dry run). */
  openPr: boolean;
  /** Open an issue / work item so owners and contributors get notified. Default false. */
  openTracker: boolean;
}

/** One dependency as declared by a manifest. */
export interface DepEntry { ecosystem: Ecosystem; name: string; version: string; manifest: string }

export type Severity = "low" | "medium" | "high" | "critical";

/** Something the sweep found and a human may need to act on. */
export interface Finding {
  kind: "advisory" | "dependency-update" | "sbom-drift" | "manifest-error";
  ecosystem: Ecosystem | "n/a";
  name: string;
  current: string;
  latest?: string;
  severity?: Severity;
  /** Official identifiers only: CVE-*, GHSA-*, OSV ids. */
  advisoryIds?: string[];
  summary: string;
}

/** The result of one sweep over one target. Pure data, safe to log (no secrets). */
export interface SweepReport {
  targetId: string;
  at: number;
  deps: number;
  findings: Finding[];
  sbomDrift: { added: string[]; removed: string[]; changed: string[] };
}
