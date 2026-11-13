// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer_watchdog.ts - ADR-0481 (P-RECOVER.4): the main-window renderer watchdog, pure core.
//
// The main BrowserWindow is frameless and its only page is the app. When Chromium's renderer process
// for that window dies (a crash, an OOM kill, the OS or a user killing it), the window keeps painting
// its background color and nothing else, forever: the window object still exists, so a second launch
// only focuses it; the custom title-bar close button lived in the dead renderer; a frameless window
// has no menu, so Electron's default Ctrl+R accelerator never fires; and the browser build at the
// engine's port is token-gated (ADR-0396), so it cannot stand in. Observed live on 2026-11-03 (v2.5.0):
// closing the Preview panel took the renderer down and the only way out was Alt+F4, which also ended
// every agent session under the still-healthy engine.
//
// This module is the PURE decision core (unit-tested, no Electron imports); main.ts owns the wiring:
// win.webContents.on("render-process-gone") -> decideRendererAction -> engine.log line + a delayed
// loadURL of the app. A renderer that dies on every boot must not become a reload loop, so reloads are
// capped per sliding window and backed off; past the cap the window is left as it is and the log says so.

import { formatExitCode } from "./gpu_watchdog.ts";

/** Reloads allowed inside one sliding window before the watchdog gives up. */
export const RENDERER_MAX_RELOADS = 5;

/** The sliding window the cap applies to. */
export const RENDERER_RELOAD_WINDOW_MS = 60_000;

/** Delay before the Nth reload of a window (N from 1): a crash during teardown of the previous document
 *  gets a moment to settle, and a renderer that keeps dying is retried less and less eagerly. */
export const RENDERER_RELOAD_DELAYS_MS = [250, 1000, 2500, 5000, 10_000] as const;

/** Electron's render-process-gone reason for a renderer that exited on purpose (window close, a
 *  navigation that swapped processes). Never a death to recover from. */
export const RENDERER_CLEAN_REASON = "clean-exit";

/** The subset of Electron's RenderProcessGoneDetails we consult. */
export interface RendererGoneDetails {
  reason?: string;
  exitCode?: number;
}

/** Reload bookkeeping: epoch-ms timestamps of the reloads already issued. Pure data, so main.ts can
 *  keep it in a `let` and reset it whenever a window is created. */
export interface RendererWatchState {
  reloadsAt: readonly number[];
}

export const freshRendererWatch = (): RendererWatchState => ({ reloadsAt: [] });

export type RendererAction = "ignore" | "reload" | "give-up";

export interface RendererDecision {
  action: RendererAction;
  /** Reloads issued in the current window INCLUDING this one when action is "reload". */
  attempt: number;
  /** Wait this long before loading the app again (0 unless action is "reload"). */
  delayMs: number;
  state: RendererWatchState;
}

/** True when the renderer is gone for a reason the window cannot recover from on its own. */
export function isRendererDeath(d: RendererGoneDetails): boolean {
  return (d.reason ?? "") !== RENDERER_CLEAN_REASON;
}

/** One render-process-gone event in: the action out, plus the updated state. `nowMs` is injected so the
 *  sliding window is testable. */
export function decideRendererAction(d: RendererGoneDetails, s: RendererWatchState, nowMs: number): RendererDecision {
  if (!isRendererDeath(d)) return { action: "ignore", attempt: 0, delayMs: 0, state: s };
  return decideReloadRetry(s, nowMs);
}

/** P-RECOVER.4 (ADR-0481) upgrade review RELOAD-RETRY: a delayed loadURL that FAILED (the engine briefly
 *  down) is not a recovered window. installAppNavigation's did-fail-load retry only covers the first boot,
 *  so the watchdog retries itself, charging each retry against the SAME sliding-window cap and delay table
 *  as a renderer death: never more than RENDERER_MAX_RELOADS loads per window, then "give-up". */
export function decideReloadRetry(s: RendererWatchState, nowMs: number): RendererDecision {
  const recent = s.reloadsAt.filter((t) => nowMs - t < RENDERER_RELOAD_WINDOW_MS);
  if (recent.length >= RENDERER_MAX_RELOADS) return { action: "give-up", attempt: recent.length, delayMs: 0, state: { reloadsAt: recent } };
  const attempt = recent.length + 1;
  const delayMs = RENDERER_RELOAD_DELAYS_MS[Math.min(attempt, RENDERER_RELOAD_DELAYS_MS.length) - 1];
  return { action: "reload", attempt, delayMs, state: { reloadsAt: [...recent, nowMs] } };
}

/** The engine.log line for a render-process-gone event (every non-ignored one is logged: the reason and
 *  exit code are the only evidence of WHY the renderer died, and before this watchdog nothing kept them). */
export function rendererGoneLogLine(d: RendererGoneDetails, r: RendererDecision, whenIso: string): string {
  const code = formatExitCode(d.exitCode);
  const head = `[renderer-watchdog] ${whenIso} main-window renderer gone reason=${d.reason ?? "?"}${code ? ` exitCode=${code}` : ""}`;
  if (r.action === "ignore") return `${head} -> ignored (clean exit)\n`;
  if (r.action === "give-up") {
    return `${head} -> NOT reloaded: ${r.attempt} reloads in the last ${RENDERER_RELOAD_WINDOW_MS / 1000}s (cap ${RENDERER_MAX_RELOADS}); the window is left as it is, relaunch LUCID\n`;
  }
  return `${head} -> reloading the app in ${r.delayMs}ms (reload #${r.attempt} of ${RENDERER_MAX_RELOADS} per ${RENDERER_RELOAD_WINDOW_MS / 1000}s)\n`;
}

/** The engine log line for a failed watchdog reload and what happens next. */
export function reloadFailedLogLine(err: string, r: RendererDecision, whenIso: string): string {
  const head = `[renderer-watchdog] ${whenIso} reload failed: ${err}`;
  if (r.action === "give-up") {
    return `${head} -> NOT retried: ${r.attempt} reloads in the last ${RENDERER_RELOAD_WINDOW_MS / 1000}s (cap ${RENDERER_MAX_RELOADS}); the window is left as it is, relaunch LUCID\n`;
  }
  return `${head} -> retrying in ${r.delayMs}ms (reload #${r.attempt} of ${RENDERER_MAX_RELOADS} per ${RENDERER_RELOAD_WINDOW_MS / 1000}s)\n`;
}

/** P-RECOVER.4 (ADR-0481) upgrade review RELOAD-ORIGIN: the ONE app URL every privileged main-window load
 *  uses (first load, navigation policy, watchdog reload). The engine binds only IPv4 loopback; `localhost`
 *  can resolve to [::1] first, a socket any local process may own, which would then render inside our
 *  window with the preload bridge (ADR-0474 VAULT-TRANSPORT-LOCALHOST). */
export function engineAppUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/** An unresponsive renderer is a long synchronous task, not a death: it is logged, never reloaded. */
export function rendererResponsivenessLogLine(state: "unresponsive" | "responsive", whenIso: string): string {
  return state === "unresponsive"
    ? `[renderer-watchdog] ${whenIso} main-window renderer unresponsive (logged only; a hang is not a death)\n`
    : `[renderer-watchdog] ${whenIso} main-window renderer responsive again\n`;
}
