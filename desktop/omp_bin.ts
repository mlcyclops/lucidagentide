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

/** Can this candidate actually be executed?
 *
 *  `true` it ran, `false` it ran and failed, `"timeout"` it did not answer in time. The third case is
 *  NOT a failure and P-OMP-BOOT.2 (ADR-0358) exists because collapsing it into one was an outage: the
 *  bundled omp is a shim over a 98 MB bun that JIT-loads a large cli.js, and on a cold, antivirus-scanned
 *  first launch on a low-power laptop that takes longer than a short probe allows. A timeout means "this
 *  machine is slow", never "this binary is missing".
 *
 *  MUST NOT throw: a probe that throws is a probe that failed. */
export type OmpRunProbe = (candidate: string) => boolean | "timeout";

export interface OmpCandidateInput {
  /** LUCID_OMP_BIN, resolved by the Electron main process (bundled install, or an app-managed one). */
  envBin?: string | undefined;
  /** P-OMP-BOOT.1 (ADR-0357): absolute candidates the CALLER already knows about, probed after `envBin`
   *  and before the generic fallbacks. Electron main passes the packaged `resources/repo` shim, the
   *  app-managed userData install, and the platform bin dirs, which is how `runtime.ts:findOmp()` stops
   *  being a fourth, existence-based copy of this resolver. Blank entries are ignored. */
  installed?: (string | null | undefined)[];
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
  for (const c of i.installed ?? []) if (c && c.trim()) out.push(c.trim());
  out.push(i.join(i.home, ".bun", "bin", `omp${i.exeSuffix}`));
  // Bare name last: let the OS PATH answer. On a dev box this is usually the right omp anyway, and it is
  // the one candidate that cannot be an unreadable file inside a protected install directory.
  out.push("omp");
  return [...new Set(out)]; // main's `installed` can repeat envBin; probing the same path twice is waste
}

export interface OmpResolution {
  /** The binary to spawn. Never empty: the bare name is the final fallback, so a caller always has
   *  something to try and the OS reports a missing binary in its own words. */
  bin: string;
  /** True when a probe actually CONFIRMED this binary runs. */
  proven: boolean;
  /** P-OMP-BOOT.2 (ADR-0358): nothing was proven, but a candidate TIMED OUT rather than failing, and
   *  `bin` is that candidate. The caller must treat this as "probably fine, machine is slow": use it,
   *  say so once, and NEVER show the it-is-missing diagnostic. Distinguishing this from `proven: false`
   *  is the whole fix: the old resolver counted a timeout as a rejection and fell through to the bare
   *  name, which on a packaged install is the one candidate guaranteed not to exist. */
  indeterminate?: boolean;
  /** Every candidate that was probed and REJECTED (ran and failed, or threw), in order. A timed-out
   *  candidate is deliberately NOT in here: it was never shown to be broken. */
  rejected: string[];
  /** Candidates that did not answer in time, in order. Reported so a slow machine is diagnosable. */
  timedOut: string[];
}

/** Pick the first candidate that PROVABLY runs. Pure apart from the injected probe.
 *
 *  Order of preference when nothing is proven: the first candidate that TIMED OUT (it exists and was
 *  merely slow), then the bare name. Returning `proven: false` rather than throwing keeps the caller in
 *  charge of the message, because "omp is not installed or not on PATH" is a better thing for a user to
 *  read than an exception out of a resolver. */
export function resolveOmpBin(i: OmpCandidateInput, canRun: OmpRunProbe): OmpResolution {
  const candidates = ompCandidates(i);
  const rejected: string[] = [];
  const timedOut: string[] = [];
  for (const c of candidates) {
    let verdict: boolean | "timeout" = false;
    try { verdict = canRun(c); } catch { verdict = false; } // a throwing probe is a failed probe
    if (verdict === true) return { bin: c, proven: true, rejected, timedOut };
    if (verdict === "timeout") timedOut.push(c); // slow, not broken: still a usable fallback
    else rejected.push(c);
  }
  // Nothing answered successfully. A candidate that timed out beats the bare name, which on a packaged
  // install is the ONLY candidate we know is absent.
  if (timedOut.length) return { bin: timedOut[0]!, proven: false, indeterminate: true, rejected, timedOut };
  return { bin: "omp", proven: false, rejected, timedOut };
}

/** How long a capability probe may take before we call it INDETERMINATE rather than failed.
 *
 *  P-OMP-BOOT.2 (ADR-0358): this was 6000, and 6 seconds is simply not enough. The bundled omp is a shim
 *  that execs a 98 MB bun which then loads a large cli.js; measured warm on a desktop it answers in about
 *  1.2 s, but on a cold first launch after an upgrade, with a real-time antivirus scanner reading both
 *  files for the first time, on a 15 W mobile CPU, it exceeds 6 s often enough that the reporting user's
 *  engine log shows 10 of 21 boots deciding omp was unrunnable, from an install where it plainly worked
 *  on the other 11. Raised to 30 s because this is a ONE-OFF cost on an otherwise dead launch, and
 *  because a timeout no longer condemns the candidate anyway. */
export const OMP_PROBE_TIMEOUT_MS = 30_000;

/** Interpret a Bun.spawnSync result. Bun reports a timeout by killing the child, so there is no exit
 *  code and a signal is present; newer Bun also sets `exitedDueToTimeout`, preferred when available.
 *
 *  TRADEOFF: a child that dies on a SIGNAL for a real reason (a segfaulting omp) also reads as a timeout
 *  here. That is deliberate and safe in this direction: the cost is that we try to use a binary that
 *  will fail loudly at the real spawn, which is strictly better than the old behaviour of silently
 *  substituting a bare `omp` that does not exist at all. */
export function bunProbeVerdict(r: { exitCode?: number | null; signalCode?: string | null; exitedDueToTimeout?: boolean }): boolean | "timeout" {
  if (r.exitedDueToTimeout === true) return "timeout";
  if (r.exitCode === 0) return true;
  if ((r.exitCode === null || r.exitCode === undefined) && r.signalCode) return "timeout";
  return false;
}

/** Same rule for node's child_process.spawnSync, which reports a timeout as `signal` set (SIGTERM) and
 *  `status` null, or as an ETIMEDOUT error. Used by the Electron main process, which has no Bun.
 *
 *  `error` is typed as `Error & { code?: string }` (node's ErrnoException shape) rather than a bare
 *  `{ code?: string }`: a structural type with only optional members has nothing in common with `Error`,
 *  so passing a real `SpawnSyncReturns` at the call site was rejected outright. */
export function nodeProbeVerdict(r: { status?: number | null; signal?: string | null; error?: (Error & { code?: string }) | null }): boolean | "timeout" {
  if (r.error?.code === "ETIMEDOUT") return "timeout";
  if (r.status === 0) return true;
  if ((r.status === null || r.status === undefined) && r.signal) return "timeout";
  return false;
}

// ── P-OMP-BOOT.1 (ADR-0357): saying it ONCE, loudly, instead of a stack per UI poll ──────────────────
//
// The reported v2.2.0 outage: turns died on roughly half of all launches, and the engine log carried
// 192 identical ten-line stack traces, one per `/api/commands` and `/api/modes` poll, all of them the
// same `acp: agent process failed to start: Executable not found in $PATH: "omp"`. Nothing was shown in
// the UI, so the one fact that mattered was the least visible thing in the file. (An earlier draft of
// this comment said "ten days in which every turn died"; the log says 10 of 21 boots. See ADR-0358.)

/** Is this the known "omp cannot be started" failure, rather than a real internal error? Pure, and
 *  deliberately matched on the message TEXT because it arrives from three different layers (Bun's spawn,
 *  node's uv_spawn, our own ACP `die`) and none of them carries a code we control.
 *
 *  A FALSE POSITIVE here is worse than the log spam it prevents: it would hide a genuine internal error
 *  behind a reassuring "omp cannot start" and suppress its stack. So the errno clause demands a
 *  reference to the omp EXECUTABLE itself (the `.bin/omp` shim) or to the package the shim launches, and
 *  not merely the substring "omp". A first pass used `\bomp\b`, which matches `.omp` in
 *  `~/.omp/agent/agent.db` (a `.` is a word boundary), so every EPERM on the user's own config directory
 *  classified as a spawn failure. The test for that case is what caught it. */
export function isOmpSpawnFailure(e: unknown): boolean {
  const msg = e instanceof Error ? `${e.message}` : typeof e === "string" ? e : "";
  if (!msg) return false;
  if (/agent process failed to start/i.test(msg)) return true;
  if (/Executable not found in \$PATH/i.test(msg)) return true;
  const namesOmpBinary = /[\\/]\.bin[\\/]omp(\.exe)?\b/i.test(msg) || /pi-coding-agent/i.test(msg);
  return namesOmpBinary && /\b(ENOENT|EPERM|EACCES)\b/.test(msg);
}

/** The user-facing report for "no omp could be started", built from the resolution that failed. Pure so
 *  the wording is tested rather than eyeballed; Electron main shows it with `dialog.showErrorBox` and the
 *  engine prints `detail` at boot. NAMES every path tried, because the field report for the v2.0.0 EPERM
 *  bug lacked exactly that and cost a diagnosis cycle. */
export function ompUnavailableReport(r: OmpResolution): { title: string; detail: string } {
  return {
    title: "LUCID cannot start its agent",
    detail: [
      "The omp agent could not be started, so no model can run. LUCID is otherwise fine: this is the one",
      "missing piece.",
      "",
      "Tried, in order:",
      ...r.rejected.map((c, n) => `  ${n + 1}. ${c}`),
      "",
      "The bundled agent is a shim that needs the bundled `bun` runtime beside it. If this install was",
      "unpacked by hand, run from a temp folder, or had its resources directory pruned, reinstall from the",
      "official installer. Otherwise install bun (https://bun.sh) and restart LUCID.",
    ].join("\n"),
  };
}
