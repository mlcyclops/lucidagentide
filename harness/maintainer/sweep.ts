// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/maintainer/sweep.ts
//
// P-MAINT.1: one sweep over one repository a Maintainer Agent owns. This is the orchestration, and
// it is deliberately the only place the four steps meet: discover + parse manifests, ask OSV, rebuild
// the SBOM and diff it against the last one, then order everything worst-first.
//
// ALL I/O IS INJECTED through `SweepIo`. The reader, the directory lister, the fetch, and the
// previous-SBOM loader are parameters, so a full sweep runs in a unit test with no filesystem and no
// network - and, just as importantly, so the sweep has no way to reach anything the caller did not
// hand it.
//
// READ-ONLY BY CONSTRUCTION. There is no writer in SweepIo. A sweep cannot modify a repository,
// cannot write the new SBOM, and cannot file anything. Persisting the new baseline and opening the
// PR / tracker item are the caller's decisions, made outside this function with its own audit trail.
//
// WHAT COUNTS AS A DEPENDENCY-UPDATE FINDING. Only a bump an advisory can justify: OSV names the
// fixed version, so the recommendation carries an official reference. There is deliberately NO
// registry "is there a newer release" check here. That needs a per-ecosystem registry client and a
// policy for what counts as a safe bump, which is the enterprise addon's job; guessing at it in the
// spike would put unbacked version numbers in front of a maintainer.

import { ADVISORY_UNAVAILABLE, queryAdvisories, SEVERITY_RANK, sortFindings, type FetchLike } from "./advisory.ts";
import type { DepEntry, Finding, MaintainerTarget, SweepReport } from "./contracts.ts";
import { discoverManifests, parseManifest } from "./manifests.ts";
import { buildSbom, diffSbom, type Sbom } from "./sbom.ts";

export interface SweepIo {
  /** File text, or null when the path cannot be read. Never throws. */
  readFile: (path: string) => string | null;
  /** Entry names in a directory. May throw for a missing one; discovery treats that as absent. */
  listDir: (dir: string) => string[];
  /** The only network seam. Wrap it with a timeout at the call site. */
  fetchImpl: FetchLike;
  /** The last SBOM persisted for this target, or null on a first sweep. */
  loadPrevSbom: (targetId: string) => Sbom | null;
  /** Injectable clock so a report is deterministic under test. Defaults to Date.now. */
  now?: () => number;
}

/** Everything a sweep produced, including the freshly built SBOM the caller may choose to persist. */
export interface SweepOutcome {
  report: SweepReport;
  sbom: Sbom;
  /** True when the previous sweep left no baseline, so drift could not be computed. */
  firstSweep: boolean;
  /** Human-readable line about advisory coverage, straight from the feed client. */
  advisoryNote: string;
  manifests: string[];
}

/**
 * Sweep one target and produce its report. Pure logic over injected I/O.
 *
 * The report's `findings` are ordered worst-first by sortFindings, with an advisory-feed coverage gap
 * pinned to the front. `deps` counts every declaration read across every manifest found, including
 * declarations OSV could not be asked about (a workspace or path dependency), because that number is
 * the honest size of the surface, not the size of the part we could check.
 */
export async function sweepTarget(target: MaintainerTarget, io: SweepIo): Promise<SweepOutcome> {
  const at = (io.now ?? Date.now)();
  const manifests = discoverManifests(target.localPath, io.listDir);
  const findings: Finding[] = [];
  const deps: DepEntry[] = [];

  if (manifests.length === 0) {
    findings.push({
      kind: "manifest-error",
      ecosystem: "n/a",
      name: target.localPath,
      current: "n/a",
      summary: "No supported dependency manifest was found at the repository root or one level into its common source directories, so nothing could be audited.",
    });
  }

  for (const path of manifests) {
    const text = io.readFile(path);
    if (text === null) {
      findings.push({
        kind: "manifest-error",
        ecosystem: "n/a",
        name: path,
        current: "n/a",
        summary: "Manifest was discovered but could not be read.",
      });
      continue;
    }
    const parsed = parseManifest(path, text);
    deps.push(...parsed.deps);
    for (const error of parsed.errors) {
      findings.push({ kind: "manifest-error", ecosystem: "n/a", name: path, current: "n/a", summary: error });
    }
  }

  const advisories = await queryAdvisories(deps, io.fetchImpl);
  findings.push(...advisories.findings);
  if (advisories.unavailable) {
    // Pinned to the front by sortFindings. A sweep whose advisory coverage is incomplete must say so
    // in the findings themselves, because the findings are what gets rendered and read.
    findings.push({
      kind: "advisory",
      ecosystem: "n/a",
      name: "osv.dev",
      current: "n/a",
      summary: advisories.note.startsWith(ADVISORY_UNAVAILABLE) ? advisories.note : `${ADVISORY_UNAVAILABLE}: ${advisories.note}`,
    });
  }

  // Evidence-backed bumps: one per advisory that publishes a fixed version, deduped per package so a
  // package hit by three advisories yields one bump recommendation carrying all three references.
  const bumps = new Map<string, Finding>();
  for (const f of advisories.findings) {
    if (f.latest === undefined) continue;
    const key = `${f.ecosystem}|${f.name}|${f.latest}`;
    const existing = bumps.get(key);
    if (existing === undefined) {
      bumps.set(key, {
        kind: "dependency-update",
        ecosystem: f.ecosystem,
        name: f.name,
        current: f.current,
        latest: f.latest,
        severity: f.severity,
        advisoryIds: [...(f.advisoryIds ?? [])],
        summary: `Update ${f.name} from ${f.current} to ${f.latest}, the version the advisory names as fixed.`,
      });
      continue;
    }
    for (const id of f.advisoryIds ?? []) if (!existing.advisoryIds?.includes(id)) existing.advisoryIds?.push(id);
    // Keep the worst severity across the advisories that share this bump.
    const a = existing.severity === undefined ? 4 : SEVERITY_RANK[existing.severity];
    const b = f.severity === undefined ? 4 : SEVERITY_RANK[f.severity];
    if (b < a) existing.severity = f.severity;
  }
  findings.push(...bumps.values());

  const sbom = buildSbom(deps, { name: target.id, at });
  const prev = io.loadPrevSbom(target.id);
  const sbomDrift = diffSbom(prev, sbom);
  const driftTotal = sbomDrift.added.length + sbomDrift.removed.length + sbomDrift.changed.length;
  if (driftTotal > 0) {
    findings.push({
      kind: "sbom-drift",
      ecosystem: "n/a",
      name: "sbom",
      current: `${sbom.components.length} components`,
      summary: `The CycloneDX component set changed since the last sweep: ${sbomDrift.added.length} added, ${sbomDrift.removed.length} removed, ${sbomDrift.changed.length} version change(s). Full lists are in the report's sbomDrift field.`,
    });
  }

  return {
    report: {
      targetId: target.id,
      at,
      deps: deps.length,
      findings: sortFindings(findings),
      sbomDrift,
    },
    sbom,
    firstSweep: prev === null,
    advisoryNote: advisories.note,
    manifests,
  };
}
