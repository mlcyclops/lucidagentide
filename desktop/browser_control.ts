// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/browser_control.ts - P-BROWSER.1 (wave 2): the agent-browser command queue + status store.
//
// Pure and process-local: the dev server (dev.ts) is the ONLY importer. The Electron main process
// cannot be imported from here (separate process), so it drives the visible agent BrowserWindow by
// POLLING GET /api/browser/commands and POSTing results back - this module is the mailbox between
// the /api/browser routes (which enqueue + await) and that poll loop. No Electron, no Bun, no I/O:
// everything is unit-testable with fake time-free assertions (browser_control.test.ts).
//
// Lifecycle of one command: route enqueues { id, op, ... } -> main drains it -> main executes on the
// window -> main POSTs { id, ok, ... } -> completeBrowserCommand settles the route's waitBrowserResult.
// A user closing the window is a KILL SWITCH: failAllBrowserCommands drops the queue and settles every
// pending waiter with the error, so no route (and no agent tool call) is left hanging.

export type BrowserOp = "open" | "capture" | "scroll" | "close" | "click" | "type" | "drag" | "keys";

/** One queued instruction for the Electron main's agent-browser executor.
 *
 *  `x`/`y` (click, drag start) and `toX`/`toY` (drag end) are SNAPSHOT pixel coordinates - the space the
 *  agent actually sees, since a capture is downscaled to 1100px wide before it reaches the model. Main
 *  maps them back onto the window's content bounds using the width of the last shot it sent, so the
 *  agent never has to know the real viewport size or the display's pixel ratio. */
export interface BrowserCommand {
  id: string;
  op: BrowserOp;
  url?: string;
  dy?: number;
  x?: number;
  y?: number;
  toX?: number;
  toY?: number;
  /** click only: which mouse button. Absent = left. */
  button?: "left" | "right";
  text?: string;
  pressEnter?: boolean;
  /** keys only: the raw combo the agent asked for ("Control+a"); main re-parses it as the authority. */
  keys?: string;
}

/** The executor's report for one command. `png` is a data:image/png;base64 URL (capture only). */
export interface BrowserCommandResult {
  ok: boolean;
  error?: string;
  png?: string;
  title?: string;
  url?: string;
}

/** The live agent-browser session, as the renderer pill and GET /api/browser/status see it. */
export interface BrowserStatus {
  active: boolean;
  title: string;
  url: string;
  startedAt: number | null;
  shots: number;
}

interface PendingEntry {
  result: BrowserCommandResult | null;
  waiters: ((r: BrowserCommandResult) => void)[];
  at: number;
}

// Settled-but-unconsumed entries older than this are pruned (a result that raced past its waiter's
// timeout has nobody left to consume it; without pruning the map would grow for the app's lifetime).
const PENDING_TTL_MS = 120_000;

let queue: BrowserCommand[] = [];
const pending = new Map<string, PendingEntry>();
let status: BrowserStatus = { active: false, title: "", url: "", startedAt: null, shots: 0 };
let latestShot: string | null = null;
let activityAt = 0;

const touch = (): void => { activityAt = Date.now(); };

function prunePending(): void {
  const now = Date.now();
  for (const [id, e] of pending) {
    if (e.waiters.length === 0 && now - e.at > PENDING_TTL_MS) pending.delete(id);
  }
}

/** Queue a command for the main-process executor and open its result mailbox. */
export function enqueueBrowserCommand(cmd: BrowserCommand): void {
  prunePending();
  queue.push(cmd);
  if (!pending.has(cmd.id)) pending.set(cmd.id, { result: null, waiters: [], at: Date.now() });
  touch();
}

/** Hand the queued commands to the executor, in enqueue order, and clear the queue (atomic drain). */
export function drainBrowserCommands(): BrowserCommand[] {
  const out = queue;
  queue = [];
  return out;
}

/** Settle a command: wake every waiter, or park the result for a late waitBrowserResult. */
export function completeBrowserCommand(id: string, result: BrowserCommandResult): void {
  const entry = pending.get(id) ?? { result: null, waiters: [], at: Date.now() };
  pending.set(id, entry);
  entry.result = result;
  entry.at = Date.now();
  const waiters = entry.waiters;
  entry.waiters = [];
  for (const wake of waiters) wake(result);
  touch();
}

/** Await a command's result. Resolves with the result, or - cleanly, never a rejection - with
 *  `{ ok: false, error: "timed out..." }` after `timeoutMs`. Consuming a result deletes its entry. */
export function waitBrowserResult(id: string, timeoutMs: number): Promise<BrowserCommandResult> {
  const entry = pending.get(id);
  if (entry?.result) {
    pending.delete(id);
    return Promise.resolve(entry.result);
  }
  const { promise, resolve } = Promise.withResolvers<BrowserCommandResult>();
  const live = entry ?? { result: null, waiters: [], at: Date.now() };
  pending.set(id, live);
  const timer = setTimeout(() => {
    const idx = live.waiters.indexOf(wake);
    if (idx !== -1) live.waiters.splice(idx, 1);
    if (live.waiters.length === 0 && !live.result) pending.delete(id);
    resolve({ ok: false, error: "timed out waiting for the browser window" });
  }, timeoutMs);
  const wake = (r: BrowserCommandResult): void => {
    clearTimeout(timer);
    pending.delete(id);
    resolve(r);
  };
  live.waiters.push(wake);
  return promise;
}

/** KILL SWITCH: the user closed the window (or main declared it dead). Drop everything queued and
 *  settle every pending waiter with `error`, so no route or agent tool call is left hanging. */
export function failAllBrowserCommands(error: string): void {
  queue = [];
  for (const id of [...pending.keys()]) completeBrowserCommand(id, { ok: false, error });
  pending.clear();
  touch();
}

/** Merge a partial update into the live status (routes + main status pushes both land here). */
export function setBrowserStatus(patch: Partial<BrowserStatus>): void {
  status = { ...status, ...patch };
  touch();
}

/** Snapshot copy of the live status - callers can never mutate the store through it. */
export function getBrowserStatus(): BrowserStatus {
  return { ...status };
}

/** Cache the newest capture (data:image/png;base64 URL) for GET /api/browser/shot. */
export function setLatestBrowserShot(png: string | null): void {
  latestShot = png;
  touch();
}

export function latestBrowserShot(): string | null {
  return latestShot;
}

/** When the browser subsystem last did anything - feeds ProcessView.lastActivityAt. */
export function lastBrowserActivityAt(): number {
  return activityAt;
}

/** Test seam: wipe every piece of module state (queue, mailboxes, status, shot, activity). */
export function resetBrowserControl(): void {
  queue = [];
  pending.clear();
  status = { active: false, title: "", url: "", startedAt: null, shots: 0 };
  latestShot = null;
  activityAt = 0;
}
