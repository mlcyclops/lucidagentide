// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/repo_root.ts - where does this repo live on disk, and can we PROVE it?
//
// THE BUG THIS EXISTS FOR (P-GATE-PATH.1, ADR-0356; v2.2.0, reported live). Every omp child on a
// packaged install logged, on EVERY spawn:
//
//   Failed to load extension  path: B:\~BUN\harness\omp\security_extension.ts
//     Cannot find module 'B:\~BUN\harness\omp\security_extension.ts'
//
// `B:\~BUN` is Bun's VIRTUALIZED embedded root inside a `bun build --compile` binary: the engine's own
// stack frames read `B:/~BUN/root/lucid-engine`. acp_backend.ts built its gate path as
// `join(import.meta.dir, "..")`, which in a compiled binary is that virtual root, so the `-e` argument
// named a file that exists in no filesystem. An in-process import survives virtualization; an argument
// handed to a SEPARATE omp process does not. omp logged the miss and ran the whole session with NO
// SECURITY GATE, which is invariant 3 and 4 failing silently and open.
//
// WHY A PROBE, NOT A PLATFORM CHECK. The compiled binaries ship at <repo>/bin/lucid-engine[.exe] and
// <repo>/bin/lucid[.exe], so the real repo is derivable from process.execPath - but execPath is useless
// under `bun desktop/dev.ts`, where it names the bun binary. Neither candidate is right in both worlds,
// so neither may be chosen by inference. Probe for the gate keystone ON DISK and take the first
// candidate that actually carries it, which is the same doctrine as omp_bin.ts (probe the thing, do not
// infer it from a path) and ADR-0261's write probe.
//
// This pattern is already PROVEN on the exact install that reported the bug: harness/launcher's
// lucid_acp.ts carries a keystone check with an execPath fallback, and `lucid.exe check` on that machine
// printed OK while the engine was handing omp `B:\~BUN\...`. Same binary format, same virtualization,
// opposite outcome, and the only difference was the probe. That is also the evidence that existsSync
// returns FALSE for a virtual path, which is what makes the first candidate safe to test at all.
//
// The order and the fallback rule are pure logic with the probe injected, so the decision is unit-tested
// without compiling a binary or touching a filesystem.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** The gate extension, relative to a repo root. Its presence ON DISK is what makes a candidate real.
 *  Deliberately the SECURITY KEYSTONE rather than a cheap marker like package.json: the one path whose
 *  absence must refuse a spawn is the one worth probing, and a root that cannot produce it is useless
 *  to every caller here even if it looks like a repo. */
export const KEYSTONE = ["harness", "omp", "security_extension.ts"] as const;

export interface RepoCandidateInput {
  /** `import.meta.dir` of a module living directly under the repo root (this file: <repo>/desktop).
   *  Correct in a dev checkout and in packaged resources/repo; VIRTUAL in a compiled binary. */
  sourceDir: string;
  /** `process.execPath`. Names <repo>/bin/lucid-engine[.exe] in a compiled binary; names the bun
   *  binary under `bun desktop/dev.ts`, where it resolves to nothing and the probe rejects it. */
  execPath: string;
  /** Path join, injected so this module stays trivially testable cross-platform. */
  join: (...parts: string[]) => string;
  /** Path dirname, injected for the same reason. */
  dirname: (p: string) => string;
}

/** Can this root produce the gate keystone? The real implementation is an existsSync; tests pass a fake.
 *  MUST NOT throw: a probe that throws is a probe that failed. */
export type RepoProbe = (keystonePath: string) => boolean;

/** The candidate order, most trustworthy first. Pure. Exported for the test and for diagnostics: when
 *  every candidate fails, the caller logs THIS list so the refusal names what it tried. */
export function repoCandidates(i: RepoCandidateInput): string[] {
  return [i.join(i.sourceDir, ".."), i.join(i.dirname(i.execPath), "..")];
}

export interface RepoResolution {
  /** The repo root to build asset paths from. Never empty: the source-relative candidate is returned
   *  even when unproven, so a caller always has something to name in its error. */
  root: string;
  /** True when a probe confirmed the gate keystone is on disk under `root`. False means NO candidate
   *  carried it, and any security-bearing caller MUST refuse rather than proceed (invariant 3). */
  proven: boolean;
  /** Every keystone path that was probed and rejected, in order. For the refusal message. */
  rejected: string[];
}

/** Pick the first candidate that PROVABLY carries the gate. Pure apart from the injected probe. */
export function resolveRepo(i: RepoCandidateInput, hasKeystone: RepoProbe): RepoResolution {
  const candidates = repoCandidates(i);
  const rejected: string[] = [];
  for (const c of candidates) {
    const keystone = i.join(c, ...KEYSTONE);
    let ok = false;
    try { ok = hasKeystone(keystone) === true; } catch { ok = false; } // a throwing probe is a failed probe
    if (ok) return { root: c, proven: true, rejected };
    rejected.push(keystone);
  }
  // Nothing carried the gate. Hand back the source-relative root so the caller can NAME it while
  // refusing, and flag that nothing was proven. Never throw: the caller owns the refusal.
  return { root: candidates[0]!, proven: false, rejected };
}

let cached: RepoResolution | null = null;

/** The resolved repo, memoized. The answer cannot change within a process: neither the binary's own
 *  location nor its embedded source layout moves while it runs. */
export function resolvedRepo(): RepoResolution {
  if (!cached) cached = resolveRepo({ sourceDir: import.meta.dir, execPath: process.execPath, join, dirname }, existsSync);
  return cached;
}

/** Absolute path to a first-party asset under this repo (`repoAsset("harness", "omp", "x.ts")`).
 *  Use for every path handed to an omp child: a compiled binary's `import.meta.dir` is not a real
 *  directory, so `join(import.meta.dir, "..")` MUST NOT be reintroduced at a call site. */
export function repoAsset(...parts: string[]): string {
  return join(resolvedRepo().root, ...parts);
}

/** The security gate extension path, or null when it is not on disk anywhere we know to look.
 *
 *  A null is NOT a degraded mode. It means this process cannot gate an omp child, so the caller MUST
 *  refuse to spawn one (invariant 3: no code path may treat "scan unavailable" as "pass"). Dropping the
 *  `-e` and continuing, or passing an unresolvable path and letting omp log its own miss, both run the
 *  agent UNGATED, which is the failure this whole module exists to make impossible. */
export function gatePath(): string | null {
  const r = resolvedRepo();
  return r.proven ? join(r.root, ...KEYSTONE) : null;
}

/** The refusal text for a missing gate, naming every path probed. Shared so the chat surface, the
 *  fleet-lane surface, the util connection and the headless runner all refuse in the same words.
 *
 *  `r` defaults to this process's resolution and exists so the UNPROVEN message is testable: in a dev
 *  checkout the gate is always found, so a no-argument version could only ever be exercised in the one
 *  state it is never used in. */
export function gateRefusal(r: RepoResolution = resolvedRepo()): string {
  return `refusing to start the agent: the security gate extension is not on disk, so the session cannot be gated (invariant 3, fail-closed). Probed: ${r.rejected.join(", ")}`;
}
