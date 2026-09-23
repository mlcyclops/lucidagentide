// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/orphan_engine.ts - P-PORTGUARD.3 (ADR-0382): reap our OWN orphaned engine, with a warning.
//
// P-PORTGUARD.2 (ADR-0381) stops future orphans (the engine now watches its parent) and names the
// squatter when a bind is lost. It deliberately refused to kill whatever holds the port, because the app
// cannot prove an arbitrary listener is its own orphan rather than a user's unrelated service. That
// leaves one population stranded: everyone upgrading FROM a build without the parent watch, whose old
// engine (and the omp session it was running) is still holding 5319 from the last time the app died.
// For them the fix arrives too late by construction, and every launch dies on the port until they find
// the process by hand.
//
// This module draws the line ADR-0381 asked for. A listener is reaped ONLY when the owner probe
// attributes it to a LUCID engine: the compiled `lucid-engine` binary by process name or image path,
// or the dev fallback `bun run desktop/dev.ts`. Anything else (a fork's `bun server.ts`, a stranger's
// service, an unattributable socket) is left alone and the ADR-0305 / ADR-0381 dialogs still apply.
// And it is never silent: the user sees who is holding the port and chooses "Stop it and continue" or
// "Quit"; "Stop" is the default because the orphan's owner is, by definition, gone.
//
// Pure: no Electron, no I/O. main.ts owns the wiring (TCP probe, owner probe, dialog, kill, re-probe).

import type { SquatterInfo } from "./port_guard.ts";

export type PortHolder =
  | { kind: "free" }
  | { kind: "ours"; pid: number; evidence: string }
  | { kind: "foreign" }
  | { kind: "unknown" };

/** Process names and command-line fragments that identify a LUCID engine. The compiled binary is
 *  `lucid-engine[.exe]` (desktop/engine_launch.ts); the dev fallback is `bun run desktop/dev.ts`. */
const ENGINE_NAME = /^lucid-engine(?:\.exe)?$/i;
const ENGINE_IN_COMMAND = /[\\/]lucid-engine(?:\.exe)?(?:["'\s]|$)/i;
const DEV_FALLBACK = /\bbun(?:\.exe)?["']?\s+run\s+["']?desktop[\\/]dev\.ts\b/i;

/**
 * Decide whether the process holding the port is one of ours. `selfPid` is the caller's own pid,
 * which can never be an orphan (a probe that returns it would mean the port is ours already).
 */
export function classifyPortHolder(observed: SquatterInfo | null, selfPid: number): PortHolder {
  if (!observed) return { kind: "unknown" };
  const { pid, name, command } = observed;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 || pid === selfPid) return { kind: "unknown" };
  if (name && ENGINE_NAME.test(name.trim())) return { kind: "ours", pid, evidence: `process name ${name}` };
  if (command && ENGINE_IN_COMMAND.test(command)) return { kind: "ours", pid, evidence: `command ${command}` };
  if (command && DEV_FALLBACK.test(command)) return { kind: "ours", pid, evidence: `command ${command}` };
  return { kind: "foreign" };
}

/** The command that ends an orphan AND its children (the omp session, whisper) on Windows. POSIX has
 *  no tree-kill primitive in one argv; main.ts signals there through process.kill. */
export function reapSpec(platform: string, pid: number): { cmd: string; args: string[] } | null {
  if (platform === "win32") return { cmd: "taskkill.exe", args: ["/PID", String(pid), "/T", "/F"] };
  return null;
}

export interface OrphanDialog { title: string; message: string; detail: string; buttons: [string, string]; defaultId: 0; cancelId: 1 }

/** The warning the user sees before anything is killed. Names the process so the choice is informed,
 *  and says plainly that any agent session the orphan was running is already over. */
export function orphanDialog(o: { port: number; productName: string; observed: SquatterInfo; evidence: string }): OrphanDialog {
  const { observed } = o;
  const started = observed.startedAt ? ` since ${observed.startedAt}` : "";
  return {
    title: `An older ${o.productName} engine is still running`,
    message:
      `A ${o.productName} engine from a previous session (process ${observed.pid}${started}) is still holding port ${o.port}. ` +
      `It was left behind when ${o.productName} closed unexpectedly, and any agent session it was running is already over. ` +
      `Stop it now so this ${o.productName} can start?`,
    detail: [
      `Identified as ours by ${o.evidence}.`,
      `- PID: ${observed.pid}`,
      `- Name: ${observed.name ?? "unknown"}`,
      `- Started: ${observed.startedAt ?? "unknown"}`,
      `- Command: ${observed.command ?? "unknown"}`,
      "",
      "Stop it and continue: ends that process and the omp session under it, then starts normally.",
      `Quit: leaves it running; end it yourself and relaunch ${o.productName}.`,
    ].join("\n"),
    buttons: ["Stop it and continue", "Quit"],
    defaultId: 0,
    cancelId: 1,
  };
}
