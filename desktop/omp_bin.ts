// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/omp_bin.ts - which omp binary do we actually run, and can we PROVE it runs?
//
// THE BUG THIS EXISTS FOR (v2.0.0, reported live): "Connect via OAuth" failed with
//   error: EPERM reading "C:\Program Files\LucidAgentIDE\resources\repo\node_modules\
//          @oh-my-pi\pi-coding-agent\dist\cli.js" Bun v1.3.14 (Windows x64)
//
// A packaged install ships omp inside the app's own directory, and on Windows that directory is
// ACL-protected (the same protection ADR-0261's boot gate exists to detect). The resolver accepted any
// candidate that merely EXISTED, so it handed the OAuth broker a path Bun then could not read, and the
// spawn died with Bun's own EPERM instead of producing a sign-in URL.
//
// `existsSync` was never the right question. A file can exist and still be unusable: unreadable under an
// ACL, a stale shim pointing at a package that has been removed, a zero-byte truncation, the wrong
// architecture. The only honest test of "can we run this" is to RUN it, which is the same doctrine as
// ADR-0261's write probe (probe the thing, do not infer it from a path) and ADR-0305's port handshake.
//
// This module holds the ORDER and the FALLBACK RULE as pure logic with the probe injected, so the decision
// is unit-tested without spawning anything. Three call sites had each grown their own copy of this resolver
// (dev.ts's OAuth broker, acp_backend.ts's chat session, agent_run.ts) and they had already drifted once:
// commit c2d8cf9 exists solely because the broker resolved a DIFFERENT omp than the model list. One
// resolver means that class of bug cannot come back.

/** Can this candidate actually be executed? The real implementation runs `<candidate> --version` with a
 *  short timeout; tests pass a fake. MUST NOT throw: a probe that throws is a probe that failed. */
export type OmpRunProbe = (candidate: string) => boolean;

export interface OmpCandidateInput {
  /** LUCID_OMP_BIN, resolved by the Electron main process (bundled install, or an app-managed one). */
  envBin?: string | undefined;
  /** The user's home directory, for the `~/.bun/bin` fallback. */
  home: string;
  /** ".exe" on Windows, "" elsewhere. */
  exeSuffix: string;
  /** Path join, injected so this module needs no node:path and stays trivially testable cross-platform. */
  join: (...parts: string[]) => string;
}

/** The candidate order, most specific first. Pure. Exported for the test and for diagnostics: when every
 *  candidate fails a probe, the caller logs THIS list so the failure names what it tried. */
export function ompCandidates(i: OmpCandidateInput): string[] {
  const out: string[] = [];
  if (i.envBin && i.envBin.trim()) out.push(i.envBin.trim());
  out.push(i.join(i.home, ".bun", "bin", `omp${i.exeSuffix}`));
  // Bare name last: let the OS PATH answer. On a dev box this is usually the right omp anyway, and it is
  // the one candidate that cannot be an unreadable file inside a protected install directory.
  out.push("omp");
  return out;
}

export interface OmpResolution {
  /** The binary to spawn. Never empty: the bare name is the final fallback, so a caller always has
   *  something to try and the OS reports a missing binary in its own words. */
  bin: string;
  /** True when a probe actually confirmed this binary runs. False means every candidate failed and `bin`
   *  is the last-resort bare name, which is the cue to surface a real diagnostic to the user. */
  proven: boolean;
  /** Every candidate that was probed and rejected, in order. For the log line. */
  rejected: string[];
}

/** Pick the first candidate that PROVABLY runs. Pure apart from the injected probe.
 *
 *  The bare `omp` fallback is deliberately probed too, but if it also fails we still return it with
 *  `proven: false` rather than throwing: the caller's job is to report a useful error, and "omp is not
 *  installed or not on PATH" is a better message than an exception from this function. */
export function resolveOmpBin(i: OmpCandidateInput, canRun: OmpRunProbe): OmpResolution {
  const candidates = ompCandidates(i);
  const rejected: string[] = [];
  for (const c of candidates) {
    let ok = false;
    try { ok = canRun(c) === true; } catch { ok = false; } // a throwing probe is a failed probe
    if (ok) return { bin: c, proven: true, rejected };
    rejected.push(c);
  }
  // Every candidate failed. Hand back the bare name so the caller's spawn produces the OS's own
  // "not found" rather than a silent no-op, and flag that nothing was proven.
  return { bin: "omp", proven: false, rejected };
}
