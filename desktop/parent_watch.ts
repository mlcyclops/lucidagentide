// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/parent_watch.ts - P-PORTGUARD.2: the engine's parent-death watchdog, pure core.
//
// Field incident, 2026-09-23: LUCID launched, the engine logged its banner, and the next line in
// engine.log was `[Uncaught Exception] Error: Failed to start server. Is port 5319 in use?`. Nothing
// foreign was squatting - it was LUCID's OWN engine from the previous session. main.ts kills the child
// from `app.on("quit")`, but that handler does not run when Electron's main process dies any other way
// (a crash, Task Manager, `app.exit()`, an installer replacing the binary), and on Windows a spawned
// child is NOT reaped with its parent. The orphan kept 5319 (plus its whisper-server and headroom
// children) forever, so every later launch lost the bind race against a ghost.
//
// The fix is ownership, not cleanup-on-exit: the engine is only ever meaningful while the main process
// that spawned it is alive, so it watches that pid and exits itself when it disappears. A GRACEFUL
// self-exit also runs the engine's own "exit" handlers, which is what finally stops orphaning the
// managed whisper-server that SIGTERM/TerminateProcess skipped (P-STT.5).
//
// This module is the pure decision core (no timers, no process access): dev.ts owns the interval and
// the real `process.kill(pid, 0)` probe, so the policy is unit-tested instead of hand-rolled inline.

/** What dev.ts should watch, once the env says a parent exists. */
export interface ParentWatch {
  /** The pid of the process whose death must end this engine. */
  pid: number;
  /** Poll period. Cheap (a signal-0 probe), so seconds, not minutes: the point is to free the port
   *  before the user relaunches, and a human relaunch is many seconds away at best. */
  intervalMs: number;
}

const DEFAULT_INTERVAL_MS = 2000;
const MIN_INTERVAL_MS = 100;
const MAX_INTERVAL_MS = 60_000;

/**
 * Decide whether this engine has a parent to watch, from its environment. Returns null - watchdog
 * OFF - for every standalone run (`bun run desktop/dev.ts`, CI, a bare engine binary), because those
 * have no Electron main and must never self-terminate. LUCID_MAIN_PID is set only by main.ts's spawn.
 *
 * `selfPid` guards the degenerate case where the variable was inherited by the wrong process: a pid
 * equal to our own would make the watchdog either a no-op or a suicide pact, so it disables instead.
 */
export function parentWatchConfig(
  env: Record<string, string | undefined>,
  selfPid: number,
): ParentWatch | null {
  const pid = Number(env.LUCID_MAIN_PID);
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === selfPid) return null;
  const raw = Number(env.LUCID_PARENT_WATCH_MS); // test/demo hook; unset => the default cadence
  const intervalMs = Number.isFinite(raw) && raw > 0
    ? Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.trunc(raw)))
    : DEFAULT_INTERVAL_MS;
  return { pid, intervalMs };
}

/**
 * Is the watched parent still there? `probe` is `process.kill(pid, 0)`: it delivers no signal and
 * only asks the OS whether the pid is addressable.
 *
 * FAIL-SAFE, deliberately asymmetric: ONLY a definite "no such process" (ESRCH) counts as death.
 * EPERM means the pid exists but is owned by someone else, and any other error means the probe itself
 * failed - in both cases the engine keeps running, because wrongly exiting kills a live session's
 * agent mid-turn, while wrongly surviving costs one extra poll.
 */
export function parentAlive(pid: number, probe: (pid: number) => void): boolean {
  try {
    probe(pid);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code !== "ESRCH";
  }
}
