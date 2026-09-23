// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/engine_boot.ts - P-WINBOOT.1 (ADR-0259): diagnose why the packaged Bun engine
// failed to start, and detect the protected-install-directory failure mode.
//
// v1.12.0 bricked on Windows when installed under C:\Program Files: main.ts spawns
// `bun run desktop/dev.ts` from <resources>/repo, and Bun's runtime module loader returns
// EPERM loading the TypeScript entrypoint out of that ACL-protected tree (Bun.file().text()
// reads the same bytes, but the loader's file mapping is refused). The engine exits before it
// binds the port, and the window sat blank for the full 30s health timeout behind a generic
// "could not start" dialog. The portable build works only because it runs from a user-owned dir.
//
// This module is the PURE brain the boot path uses to turn that dead-end into an IMMEDIATE,
// actionable message: it decides which of three failures happened and writes the exact recovery
// step. History: ADR-0259 first CLAMPED the installer away from Program Files as a mitigation;
// ADR-0262 re-allowed per-machine installs once the compiled engine (ADR-0260) + the strict CI boot
// gate (ADR-0261) proved a protected-tree boot. This classifier stays: it covers installs from a
// STALE pre-engine package, a future regression the gate has not yet caught, and any other early
// engine death.

import { join } from "node:path";

/** A raw string tail carries a permission failure (Windows/POSIX spellings). */
const PERMISSION_SIGNAL = /\b(EPERM|EACCES)\b|access is denied|operation not permitted|permission denied/i;
/** A tail line worth surfacing as "what the engine last said". */
const ERROR_SIGNAL = /\b(error|EPERM|EACCES|denied|not permitted|panic|uncaught|throw)\b/i;
/** A Windows system-protected root that Bun's loader cannot map a script out of. */
const PROTECTED_WIN_ROOT = /[\\/]Program Files( \(x86\))?[\\/]|[\\/]Windows[\\/]/i;
/** A raw tail carries a port-bind refusal: libuv's code, POSIX prose, or Bun's own phrasing
 *  ("Failed to start server. Is port 5319 in use?", which is what engine.log actually contained). */
const PORT_BUSY_SIGNAL = /\bEADDRINUSE\b|address already in use|is port \d+ in use/i;

/**
 * P-PORTGUARD.2: the exit code the engine uses when it could not BIND its port. A distinct code (not
 * bun's generic 1) is what lets main classify this without pattern-matching prose: the engine owns the
 * diagnosis, main owns the attribution. 48 is outside the shell-signal range and unused elsewhere.
 */
export const ENGINE_EXIT_PORT_BUSY = 48;

/**
 * True when `repoRoot` sits inside a Windows system-protected location (Program Files or
 * the Windows dir). Path-based and side-effect free; the real writability of the directory
 * is probed separately (probeDirWritable) so the two signals corroborate each other.
 */
export function isProtectedInstallRoot(repoRoot: string): boolean {
  return !!repoRoot && PROTECTED_WIN_ROOT.test(repoRoot);
}

/**
 * From an engine-output tail, pick the single most informative line to show the user: the last
 * line that looks like an error, else the last non-empty line. Pure; caller keeps a bounded tail.
 */
export function bestEngineLine(tail: string): string {
  const lines = tail.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!lines.length) return "";
  // Indexed reads are narrowed explicitly: dev.ts now imports this module, so it is checked under
  // desktop/tsconfig.server.json's noUncheckedIndexedAccess as well as the Electron-main project.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (ERROR_SIGNAL.test(line)) return line;
  }
  return lines[lines.length - 1]!;
}

/** Minimal write probe so the writability check is injectable (real fs in main, fake in tests). */
export interface WriteProbe {
  write(path: string, data: string): void;
  remove(path: string): void;
}

/**
 * True iff a throwaway file can be created (then removed) inside `dir`. This is the general,
 * cross-platform signal for "the engine's own directory is not user-writable", which is what a
 * Program Files install looks like. Only ever called on the failure path, so the probe file never
 * touches a healthy install. Any throw (EPERM/EACCES/ENOENT) means not writable.
 */
export function probeDirWritable(dir: string, probe: WriteProbe): boolean {
  if (!dir) return false;
  const p = join(dir, `.lucid-write-probe-${process.pid}-${Date.now()}`);
  try {
    probe.write(p, "ok");
    probe.remove(p);
    return true;
  } catch {
    return false;
  }
}

export type EngineFailureKind = "port-busy" | "protected-location" | "engine-exited" | "timeout";

export interface EngineFailureInput {
  /** Electron app.isPackaged - a dev run never blames the install location. */
  packaged: boolean;
  /** The REPO the engine was spawned from (<resources>/repo when packaged). */
  repoRoot: string;
  /** Result of probeDirWritable(repoRoot): false ~ a protected system dir. */
  repoWritable: boolean;
  /** isProtectedInstallRoot(repoRoot). */
  protectedRoot: boolean;
  /** Did the engine child exit before /api/health answered? */
  exited: boolean;
  /** Its exit code, if known. */
  exitCode: number | null;
  /** bestEngineLine() over the captured engine tail (may be ""). */
  lastLogLine: string;
  /** The health port we waited on. */
  port: number;
  /** Absolute path to engine.log. */
  logPath: string;
  /** process.platform - tailors the recovery wording. */
  platform: NodeJS.Platform;
}

export interface EngineFailureReport {
  kind: EngineFailureKind;
  title: string;
  detail: string;
}

/**
 * Classify a failed engine start and produce the dialog the user should see. Order matters: a
 * protected/unwritable install (or a permission signal in the log) is the highest-confidence
 * diagnosis and gets a concrete relocation step; an engine that simply exited otherwise gets its
 * crash line; a still-silent engine keeps the "may still be starting" message. Never claims a
 * protected location without evidence (path match, failed write probe, or a permission signal).
 */
export function classifyEngineFailure(input: EngineFailureInput): EngineFailureReport {
  const { packaged, repoRoot, repoWritable, protectedRoot, exited, exitCode, lastLogLine, port, logPath, platform } = input;
  const lastLine = lastLogLine ? `\n\nLast engine message:\n${lastLogLine}` : "";
  const permissionSignal = PERMISSION_SIGNAL.test(lastLogLine);

  // P-PORTGUARD.2: the engine died because something else already held the port, so it never served
  // anything. This is checked FIRST because it is DIRECT evidence (an exit code the engine minted, or
  // the bind error itself) while the protected-location branch below is a path heuristic - a packaged
  // install under Program Files whose port is merely busy must not be told to reinstall.
  // The dominant field cause is LUCID's own ORPHANED engine: the Electron main was killed without
  // running its quit handler (crash, Task Manager, a forced update), the spawned engine survived, and
  // the NEXT launch found 5319 taken. That is why the recovery names the leftover process first.
  if (exited && (exitCode === ENGINE_EXIT_PORT_BUSY || PORT_BUSY_SIGNAL.test(lastLogLine))) {
    const endIt = platform === "win32"
      ? `End any leftover "lucid-engine" process in Task Manager (Details tab), then relaunch.`
      : `End any leftover lucid-engine process (\`pkill -f lucid-engine\`), then relaunch.`;
    return {
      kind: "port-busy",
      title: `Another process is already using port ${port}`,
      detail:
        `The local engine could not start because port ${port} was already taken, so it exited immediately.\n\n` +
        `Most often this is a leftover engine from a previous session that outlived its window. ` +
        `${endIt} If a different program genuinely needs that port, start this app with LUCID_PORT set ` +
        `to a free port instead (that creates a separate, deliberately isolated instance).\n\n` +
        `The engine's startup output is in:\n${logPath}${lastLine}`,
    };
  }

  if (packaged && (protectedRoot || !repoWritable || permissionSignal)) {
    const win = platform === "win32";
    const relocate = win
      ? "Reinstall to the default per-user location (normally %LOCALAPPDATA%\\Programs\\LucidAgentIDE) " +
        "without changing the folder or elevating, or run the portable build from a folder you own " +
        "(for example your Desktop or Documents)."
      : "Reinstall Lucid Agent under a folder you own (your home directory) rather than a system location.";
    return {
      kind: "protected-location",
      title: "Lucid Agent can't run from this install location",
      detail:
        "Lucid Agent is installed in a protected system folder, and its local engine cannot start from " +
        `there:\n\n${repoRoot}\n\n${relocate}\n\nThe engine's startup output is in:\n${logPath}${lastLine}`,
    };
  }

  if (exited) {
    const code = exitCode != null ? ` (exit code ${exitCode})` : "";
    return {
      kind: "engine-exited",
      title: "Lucid Agent's local engine stopped during startup",
      detail:
        `The background engine exited${code} before it could start, so the window may stay blank.\n\n` +
        `Its startup output, including the crash message, is in:\n${logPath}${lastLine}\n\n` +
        "Try reinstalling the latest release; if it keeps failing, send that log file to support.",
    };
  }

  return {
    kind: "timeout",
    title: "Lucid Agent could not start its local engine",
    detail:
      `The background engine did not respond on port ${port} within 30 seconds, so the window may stay ` +
      `blank. It may still be starting.\n\nThe engine's startup output is in:\n${logPath}${lastLine}\n\n` +
      "The app will keep retrying. If it stays blank, send that log file to support or reinstall the latest release.",
  };
}
