// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/gpu_watchdog.ts - ADR-0246 (P-GPUFIX.1): the zombie-SID GPU-sandbox watchdog, pure core.
//
// On some Windows machines an unresolvable AppContainer SID inherited in the DACL of the install
// dir under AppData\Local makes EVERY sandboxed Chromium GPU child die with 0xC0000022
// (STATUS_ACCESS_DENIED) at sandbox init (electron/electron#51761). Electron retries 9 times, logs
// FATAL "GPU process isn't usable. Goodbye." and kills the app before the window ever shows. An
// icacls grant fixes the machine only until the next NSIS upgrade recreates the folder, so the app
// self-heals instead: on repeated GPU child deaths BEFORE the first window renders, relaunch with
// --disable-gpu-sandbox (ONLY the GPU sandbox; the renderer sandbox stays intact) and persist a
// flag file so every later launch applies the switch before Chromium spawns the GPU process.
//
// This module is the PURE decision core (unit-tested, no Electron imports); main.ts owns the
// wiring: app.on("child-process-gone") -> decideGpuAction -> engine.log line + flag file +
// app.relaunch(relaunchArgs(...)).

/** The Chromium switch that disables ONLY the GPU-process sandbox. */
export const GPU_SANDBOX_SWITCH = "disable-gpu-sandbox";

/** Flag file (in userData, which survives an NSIS reinstall) that makes the mitigation stick. */
export const GPU_SANDBOX_FLAG_FILE = "gpu-sandbox-off.flag";

/** Relaunch on the Nth fatal GPU death: 1 death could be a one-off crash; Electron's own hard
 *  give-up is at 9, so 2 acts well before the FATAL while not overreacting. */
export const GPU_RELAUNCH_AFTER_DEATHS = 2;

/** child-process-gone reasons that indicate the GPU child never became usable. "clean-exit" and
 *  "killed" are normal lifecycle (shutdown, display change) and must not count. */
export const GPU_FATAL_REASONS = ["launch-failed", "abnormal-exit", "crashed"] as const;

/** The subset of Electron's Details we consult (shape per Electron 33 child-process-gone). */
export interface GpuGoneDetails {
  type?: string;
  reason?: string;
  exitCode?: number;
}

export type GpuAction = "ignore" | "log" | "relaunch";

export interface GpuWatchdogInput {
  /** Fatal GPU deaths seen so far, BEFORE this event. */
  deathsBefore: number;
  /** True once the first BrowserWindow reached ready-to-show: a later GPU crash is a driver
   *  hiccup Chromium recovers from, not the boot brick. */
  windowRendered: boolean;
  /** True when this instance already runs with the GPU sandbox off (flag file or argv switch).
   *  Then a GPU death is some OTHER problem: log it, never relaunch again (no relaunch loop). */
  sandboxOff: boolean;
}

export function isFatalGpuDeath(d: GpuGoneDetails): boolean {
  return d.type === "GPU" && (GPU_FATAL_REASONS as readonly string[]).includes(d.reason ?? "");
}

/** One event in: the action out, plus the updated death count. */
export function decideGpuAction(d: GpuGoneDetails, s: GpuWatchdogInput): { action: GpuAction; deaths: number } {
  if (!isFatalGpuDeath(d)) return { action: "ignore", deaths: s.deathsBefore };
  const deaths = s.deathsBefore + 1;
  if (s.sandboxOff || s.windowRendered) return { action: "log", deaths };
  return { action: deaths >= GPU_RELAUNCH_AFTER_DEATHS ? "relaunch" : "log", deaths };
}

/** Windows NTSTATUS codes arrive as signed 32-bit ints (-1073741790); render unsigned hex so the
 *  log literally shows 0xC0000022 and self-diagnoses against electron/electron#51761. */
export function formatExitCode(exitCode: number | undefined): string {
  if (typeof exitCode !== "number" || !isFinite(exitCode)) return "";
  return exitCode < 0 || exitCode > 0xffff ? `0x${(exitCode >>> 0).toString(16).toUpperCase()}` : String(exitCode);
}

/** The engine.log line for a non-ignored GPU death. */
export function gpuDeathLogLine(d: GpuGoneDetails, deaths: number, action: GpuAction, whenIso: string): string {
  const code = formatExitCode(d.exitCode);
  const tail = action === "relaunch"
    ? `-> relaunching with --${GPU_SANDBOX_SWITCH} (zombie-SID mitigation, electron/electron#51761; renderer sandbox stays ON)`
    : "-> logged";
  return `[gpu-watchdog] ${whenIso} GPU child gone reason=${d.reason ?? "?"}${code ? ` exitCode=${code}` : ""} death #${deaths} ${tail}\n`;
}

/** argv for app.relaunch: the current args plus the switch (once), so the mitigation applies even
 *  if the flag-file write failed. Pass process.argv.slice(1). */
export function relaunchArgs(argv: string[]): string[] {
  const flag = `--${GPU_SANDBOX_SWITCH}`;
  return argv.includes(flag) ? [...argv] : [...argv, flag];
}
