// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/write_claims.ts - P-WAIT.1: two workers wait for each other only on the SAME file.
//
// P-PROGRESS.1 made a turn a lease on its whole folder: a spoke created in Main's folder sat in line until
// Main's turn ended, even when the two touched nothing in common. The operator's rule is narrower: waiting
// is for workers on the same part of the code. So the unit is a FILE, and the moment is the write:
//   - a write/edit tool call claims its file(s) for the caller's running turn;
//   - another session's write to a claimed file waits until the claimant's turn ends;
//   - a turn's claims all drop when that turn ends (endTurn), which admits whoever waited on them.
// Reads, searches, builds and writes to any other file never wait. Git is not needed: claims are live turn
// state, not the uncommitted-ownership ledger (checkout_owners.ts), so this also works in a plain folder.
//
// A wait is BOUNDED by the caller (`waitMs`): omp gives a tool_call hook 30 s before it fails the call, so
// the hook asks for less and, if the file is still held, hands the model a refusal that names the holder
// and says to do other work first or check in. Two sessions waiting on each other's files is refused at
// once for the second one (deadlock), never left to time out. Pure decisions over two small tables; the
// only timer is the caller's own wait bound.

import { posix, win32 } from "node:path";
import { normalizeCheckoutPath } from "./checkout_owners.ts";

/** The longest one write may wait in the engine. omp fails a tool_call hook that runs past 30 s (and fails
 *  it CLOSED, as "extension timed out"), so the hook's own ask plus its network slack must stay under that. */
export const WRITE_WAIT_MAX_MS = 25_000;

export interface Claimant { id: string; name: string }

/** What a waiting worker is told. `file` is a BASENAME only: this view crosses the wire to phone guests
 *  (frames.ts: no file paths). */
export interface WaitView { on: Claimant; file: string }

/** "busy": the holder was still running when the wait bound ran out. "deadlock": the holder is itself
 *  waiting on a file the asker claimed. "ended": the asker's own turn ended (Stop) while it waited. */
export type WriteVerdict = { held: false } | { held: true; on: Claimant; file: string; why: "busy" | "deadlock" | "ended" };

interface Waiter { me: string; on: string; wake: (how: "retry" | "ended") => void }

export class WriteClaims {
  readonly #claims = new Map<string, Claimant>();
  readonly #waiters = new Set<Waiter>();
  readonly #platform: string;
  readonly #now: () => number;
  /** Is session `id` running a turn right now? endTurn is the normal release; this is the backstop for a
   *  turn that ended on a path that skipped it (a superseded or crashed turn), so a stale claim never makes
   *  anyone wait. dev.ts wires it to the master and the fleet; the default trusts every claim. */
  isRunning: (id: string) => boolean = () => true;

  constructor(opts: { platform?: string; now?: () => number } = {}) {
    this.#platform = opts.platform ?? process.platform;
    this.#now = opts.now ?? Date.now;
  }

  /** Claim `paths` for `me`'s running turn, first waiting (at most `waitMs`) while another session's turn
   *  holds any of them. Claims are all-or-nothing: a call touching two files never holds one of them while
   *  it waits for the other. `onWait` fires with the view when the wait starts or its holder changes, and
   *  once with null when a wait that was announced ends (either way). */
  async acquire(me: Claimant, paths: string[], cwd: string, opts: { waitMs: number; onWait?: (w: WaitView | null) => void }): Promise<WriteVerdict> {
    // One key per file: resolved against `cwd`, forward slashes, case-folded on Windows. Resolution
    // follows the INJECTED platform, not the host: a win32-configured instance must read "C:\\Repo"
    // as absolute even in a test running on darwin/linux, where the host isAbsolute() says no and
    // resolve() would silently prefix the test runner's cwd (the workspace_gate.ts bug, refound here).
    const path = this.#platform === "win32" ? win32 : posix;
    const keys = [...new Set(paths.map((p) => normalizeCheckoutPath(path.isAbsolute(p) ? path.resolve(p) : path.resolve(cwd, p), this.#platform)))];
    const deadline = this.#now() + Math.max(0, opts.waitMs);
    let announced: string | null = null;
    try {
      for (;;) {
        const heldKey = keys.find((k) => {
          const c = this.#claims.get(k);
          if (!c || c.id === me.id) return false;
          if (this.isRunning(c.id)) return true;
          this.#claims.delete(k); // stale: its turn is over
          return false;
        });
        if (heldKey === undefined) {
          for (const k of keys) this.#claims.set(k, { id: me.id, name: me.name });
          return { held: false };
        }
        const on = this.#claims.get(heldKey)!;
        const file = posix.basename(heldKey) || heldKey; // keys are already forward-slash normalized
        if (this.#reaches(on.id, me.id)) return { held: true, on: { ...on }, file, why: "deadlock" };
        const left = deadline - this.#now();
        if (left <= 0) return { held: true, on: { ...on }, file, why: "busy" };
        if (announced !== on.id) { announced = on.id; opts.onWait?.({ on: { ...on }, file }); }
        // Woken early by endTurn (the holder's turn, or my own); otherwise the bound runs out.
        const waiter: Waiter = { me: me.id, on: on.id, wake: () => {} };
        const how = await new Promise<"retry" | "ended" | "timeout">((res) => {
          const timer = setTimeout(() => res("timeout"), left);
          waiter.wake = (h) => { clearTimeout(timer); res(h); };
          this.#waiters.add(waiter);
        });
        this.#waiters.delete(waiter);
        if (how === "ended") return { held: true, on: { ...on }, file, why: "ended" };
      }
    } finally {
      if (announced !== null) opts.onWait?.(null);
    }
  }

  /** `id`'s turn is over: its claims drop, whoever waited on them retries, and its own waits end. */
  endTurn(id: string): void {
    for (const [k, c] of this.#claims) if (c.id === id) this.#claims.delete(k);
    for (const w of [...this.#waiters]) {
      if (w.me === id) w.wake("ended");
      else if (w.on === id) w.wake("retry");
    }
  }

  /** Does `from` wait, directly or through other waiters, on `to`? */
  #reaches(from: string, to: string): boolean {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length) {
      const id = stack.pop()!;
      if (id === to) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const w of this.#waiters) if (w.me === id) stack.push(w.on);
    }
    return false;
  }
}

/** The text a refused write hands the model. Names the holder by name AND session id (the id is what
 *  checkin_send takes), and says what to do instead. Harness text: the holder's name is a session name the
 *  operator or the engine chose, never file content. */
export function writeRefusal(v: Extract<WriteVerdict, { held: true }>, waitedMs: number): string {
  const who = `"${v.on.name}" (session id "${v.on.id}")`;
  if (v.why === "deadlock") {
    return `${v.file} is being edited by ${who}, which is itself waiting for a file you are editing, so waiting here would deadlock. ` +
      `Call checkin_send to "${v.on.id}" to agree who goes first, or leave ${v.file} for later.`;
  }
  if (v.why === "ended") return `Your turn ended while this write waited for ${who} to finish with ${v.file}.`;
  return `${v.file} is being edited by ${who}, whose turn is still running (waited ${Math.round(waitedMs / 1000)} s). ` +
    `Work on other files first and retry this edit later, or call checkin_send to "${v.on.id}" to coordinate. ` +
    `Do not change ${v.file} another way (a shell command, a copy) to get around this.`;
}
