// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/workspace_gate.ts - P-PROGRESS.1: two workers never run turns in the same folder at once.
//
// Fleet lanes run in parallel and each serializes only ITS OWN turns (one ACP prompt per lane). When two
// lanes, or a lane and the master chat, point at the same folder (or one at a parent of the other), their
// edits and git operations interleave with nobody watching. The fix is boring: a turn on a folder is a
// LEASE. A turn whose folder overlaps a running lease waits, first come first served, and the user is shown
// the sequence (who runs, who waits, in what order, and when each is expected to start, from the
// turn_progress estimate of the holders ahead).
//
// Overlap is the only test: same normalized folder, or ancestor/descendant. Disjoint folders never wait.
// A waiter that is cancelled leaves the line at once; a holder's release admits every waiter it was
// blocking, in order. Pure decisions; the only state is the lease table. Time arrives as `now`.

import { basename, resolve, sep } from "node:path";

export interface GateHolder {
  id: string;
  name: string;
  cwd: string;
  /** Ms until this holder's turn is expected to end, from its progress estimate; null when unknown. */
  etaMs?: () => number | null;
}

export interface SequenceEntry {
  id: string;
  name: string;
  /** The folder's BASENAME only: these views cross the wire to phone guests (frames.ts: no file paths). */
  folder: string;
  state: "running" | "waiting";
  /** 0 for the running holder, 1.. for waiters in admission order. */
  position: number;
  /** Epoch ms the holder started running, or the waiter joined the line. */
  sinceAt: number;
  /** The holder's own expected remaining ms (running) or expected turn length (waiting); null when unknown. */
  etaMs: number | null;
  /** Epoch ms this entry is expected to start; null when any holder ahead has no estimate. Running = sinceAt. */
  expectedStartAt: number | null;
}

/** A shared folder with more than one worker on it: the strip the fleet grid and the HUD show. `folder`
 *  is the basename (see SequenceEntry). */
export interface FolderQueue { folder: string; entries: SequenceEntry[] }

/** What a waiter is told while it waits. */
export interface WaitView {
  /** The running holder this waiter is directly behind. */
  on: { id: string; name: string };
  position: number;
  etaMs: number | null;
  /** Basename only (see SequenceEntry). */
  folder: string;
  sequence: SequenceEntry[];
}

interface Lease { holder: GateHolder; folder: string; sinceAt: number; state: "running" | "waiting"; admit: (() => void) | null }

export class WorkspaceGate {
  readonly #leases: Lease[] = [];
  readonly #now: () => number;
  readonly #platform: string;

  constructor(opts: { now?: () => number; platform?: string } = {}) {
    this.#now = opts.now ?? Date.now;
    this.#platform = opts.platform ?? process.platform;
  }

  /** Take the lease for `holder.cwd`, waiting behind overlapping holders in line. Resolves with the release
   *  function. `onWait` fires once, immediately, when the holder must wait, with what it waits on. An
   *  aborted `signal` leaves the line and rejects. A holder id already leased is refused (a worker has one
   *  turn at a time; two leases would deadlock its own release). */
  acquire(holder: GateHolder, opts: { signal?: AbortSignal; onWait?: (w: WaitView) => void } = {}): Promise<() => void> {
    if (this.#leases.some((l) => l.holder.id === holder.id)) return Promise.reject(new Error(`"${holder.id}" already holds or awaits a folder lease`));
    if (opts.signal?.aborted) return Promise.reject(new Error("cancelled before the folder lease was taken"));
    const lease: Lease = { holder, folder: this.normalize(holder.cwd), sinceAt: this.#now(), state: "waiting", admit: null };
    this.#leases.push(lease);
    const release = () => {
      const i = this.#leases.indexOf(lease);
      if (i < 0) return;
      this.#leases.splice(i, 1);
      this.#admit();
    };
    if (!this.#blockers(lease).length) { lease.state = "running"; return Promise.resolve(release); }
    const w = this.waitView(holder.id);
    if (w) opts.onWait?.(w);
    return new Promise<() => void>((res, rej) => {
      const onAbort = () => { release(); rej(new Error("cancelled while waiting for the folder")); };
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      lease.admit = () => { opts.signal?.removeEventListener("abort", onAbort); lease.state = "running"; lease.sinceAt = this.#now(); res(release); };
    });
  }

  /** The waiter's view, or null when `id` is not waiting. */
  waitView(id: string): WaitView | null {
    const lease = this.#leases.find((l) => l.holder.id === id);
    if (!lease || lease.state !== "waiting") return null;
    const blockers = this.#blockers(lease);
    const running = blockers.find((b) => b.state === "running") ?? blockers[0]!;
    const seq = this.sequenceFor(lease.folder);
    const me = seq.find((e) => e.id === id);
    return { on: { id: running.holder.id, name: running.holder.name }, position: me?.position ?? blockers.length, etaMs: me?.expectedStartAt !== null && me?.expectedStartAt !== undefined ? Math.max(0, me.expectedStartAt - this.#now()) : null, folder: shown(lease.folder), sequence: seq };
  }

  /** Every holder whose folder overlaps `folder`, running first, then waiters in line order, with the time
   *  each is expected to start (running: when it started; waiting: after every entry ahead of it ends). */
  sequenceFor(folder: string): SequenceEntry[] {
    const f = this.normalize(folder);
    const now = this.#now();
    const rel = this.#leases.filter((l) => overlaps(l.folder, f));
    const running = rel.filter((l) => l.state === "running");
    const waiting = rel.filter((l) => l.state === "waiting");
    const out: SequenceEntry[] = [];
    let horizon: number | null = now;
    for (const l of running) {
      const eta = l.holder.etaMs?.() ?? null;
      const end = eta === null ? null : now + eta;
      horizon = horizon === null || end === null ? null : Math.max(horizon, end);
      out.push({ id: l.holder.id, name: l.holder.name, folder: shown(l.folder), state: "running", position: 0, sinceAt: l.sinceAt, etaMs: eta, expectedStartAt: l.sinceAt });
    }
    waiting.forEach((l, i) => {
      const eta = l.holder.etaMs?.() ?? null;
      out.push({ id: l.holder.id, name: l.holder.name, folder: shown(l.folder), state: "waiting", position: i + 1, sinceAt: l.sinceAt, etaMs: eta, expectedStartAt: horizon });
      horizon = horizon === null || eta === null ? null : horizon + eta;
    });
    return out;
  }

  /** Every folder with two or more workers on it right now. */
  queues(): FolderQueue[] {
    const seen: string[] = [];
    const out: FolderQueue[] = [];
    for (const l of this.#leases) {
      if (seen.some((s) => overlaps(s, l.folder))) continue;
      const entries = this.sequenceFor(l.folder);
      if (entries.length < 2) continue;
      seen.push(l.folder);
      out.push({ folder: shown(l.folder), entries });
    }
    return out;
  }

  /** Path normalization shared by every comparison: resolved, forward slashes, no trailing slash, and
   *  case-folded on Windows (NTFS is case-insensitive; C:\Repo and c:\repo are one folder). */
  normalize(p: string): string {
    let s = resolve((p || "").trim() || ".").split(sep).join("/").replace(/\/+$/, "");
    if (this.#platform === "win32") s = s.toLowerCase();
    return s || "/";
  }

  #blockers(lease: Lease): Lease[] {
    const idx = this.#leases.indexOf(lease);
    return this.#leases.filter((l, i) => l !== lease && overlaps(l.folder, lease.folder) && (l.state === "running" || i < idx));
  }

  /** After a release: every waiter with no blocker left runs, in line order. */
  #admit(): void {
    for (const l of this.#leases) {
      if (l.state !== "waiting" || !l.admit || this.#blockers(l).length) continue;
      const admit = l.admit;
      l.admit = null;
      admit();
    }
  }
}

/** What a view shows for a folder: its basename, never the path (a root shows as itself). */
function shown(folder: string): string {
  return basename(folder) || folder;
}

/** Same folder, or one inside the other. Both already normalized. */
export function overlaps(a: string, b: string): boolean {
  if (a === b) return true;
  const pa = a.endsWith("/") ? a : a + "/";
  const pb = b.endsWith("/") ? b : b + "/";
  return pa.startsWith(pb) || pb.startsWith(pa);
}
