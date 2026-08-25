// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/mcp/jobs.ts
//
// P-FLEET.1 (ADR-0268): the per-connection job table and its state machine - the thing that turns the
// agent-firewall's blocking `prompt` round-trip into dispatch-and-collect handles, so a Chief-of-Staff
// LUCID can fan work out to N worker connections and harvest them later.
//
// PURE by design: no I/O, no timers, clock injected (`now`), id minting injectable for tests. The closed
// state set and the unknown-id rule live HERE so they are testable without a firewall around them.
//
// Custody (the ADR's load-bearing rules, enforced by shape):
//   - A record stores the POST-GATE envelope (`envelope`, done only) or a redacted reason (`reason`,
//     non-done terminal). The raw remote reply is never a field on any type in this file.
//   - The first-party outbound prompt is held only while `queued` (it has already passed the outbound
//     scan before admit) and is CLEARED on start - minimal retention.
//   - `viewAll()` is metadata-only: no envelope, no reason text beyond the redacted sentence, never a
//     character of remote output. Progress is counts and ages, never text.

/** The closed set. Everything but the first two is terminal. No other values, ever. */
export type JobState = "queued" | "running" | "done" | "blocked" | "error" | "timeout" | "cancelled";

export const TERMINAL_STATES: ReadonlySet<JobState> = new Set(["done", "blocked", "error", "timeout", "cancelled"]);

export function isTerminal(s: JobState): boolean {
  return TERMINAL_STATES.has(s);
}

/** Counts-only progress - the type has no text field ON PURPOSE (the ADR's anti-evasion rule: streaming
 *  remote text per chunk would let an adversary split a vector across chunks; counts cannot carry one). */
export interface JobProgress {
  textChars: number;
  toolLines: number;
  permissionAsks: number;
  /** Clock-of-record timestamp of the last observed remote activity (ms, injected clock). */
  lastActivityAt: number;
}

export interface JobRecord {
  id: string;
  key?: string;
  /** First-party outbound prompt (already outbound-scanned). Held while queued; cleared on start. */
  prompt: string;
  state: JobState;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  /** done only: the post-gate UNTRUSTED_CONTENT envelope, byte-identical to `prompt`'s return. */
  envelope?: string;
  /** Non-done terminal only: the redacted, user-facing reason sentence. Never remote text. */
  reason?: string;
  /** The gate failed closed (dead scanner) - distinct from a policy block for audit. */
  failClosed?: boolean;
  progress: JobProgress;
}

/** Metadata-only projection for the no-ids `job_status` table. NO envelope field exists on this type. */
export interface JobSummary {
  id: string;
  state: JobState;
  /** ms since admit. */
  ageMs: number;
  /** ms spent running (0 while queued; frozen at terminal). */
  elapsedMs: number;
  /** Jobs ahead of this one (running counts as 1). 0 = running or next up. */
  queuePosition: number;
  progress: JobProgress;
  /** For live jobs: "check again in about this many ms". */
  pollHintMs?: number;
  failClosed?: boolean;
}

export type AdmitResult =
  | { ok: true; id: string; state: JobState; queuePosition: number; deduped: boolean }
  | { ok: false; reason: string };

/** Queue cap beyond which dispatch refuses rather than silently accumulating worker turns. */
export const DEFAULT_MAX_QUEUE = 8;

/** "Check again in about N ms": half the elapsed time, clamped to 5-60s. Cheap, monotone, testable. */
export function pollHintMs(elapsedMs: number): number {
  return Math.min(60_000, Math.max(5_000, Math.round(elapsedMs / 2)));
}

export interface JobTableOptions {
  maxQueue?: number;
  now?: () => number;
  /** Id minting seam for tests. Production default mints `job-<8 hex>` (the harness id convention). */
  mintId?: () => string;
}

export class JobTable {
  readonly #jobs = new Map<string, JobRecord>(); // insertion order = admit order = queue order
  readonly #maxQueue: number;
  readonly #now: () => number;
  readonly #mint: () => string;

  constructor(opts: JobTableOptions = {}) {
    this.#maxQueue = opts.maxQueue ?? DEFAULT_MAX_QUEUE;
    this.#now = opts.now ?? Date.now;
    this.#mint = opts.mintId ?? (() => `job-${crypto.randomUUID().slice(0, 8)}`);
  }

  /** Admit an outbound-scanned prompt. Dedupe by live `key` (a model retry cannot double-run a worker);
   *  refuse past the queue cap. Ids are minted once and never reused (re-rolled on collision). */
  admit(prompt: string, key?: string): AdmitResult {
    if (key) {
      const live = this.#liveByKey(key);
      if (live) return { ok: true, id: live.id, state: live.state, queuePosition: this.queuePosition(live.id), deduped: true };
    }
    const queued = [...this.#jobs.values()].filter((j) => j.state === "queued").length;
    if (queued >= this.#maxQueue) return { ok: false, reason: `queue is full (${queued}/${this.#maxQueue} queued) - collect or cancel existing jobs first` };
    let id = this.#mint();
    while (this.#jobs.has(id)) id = this.#mint(); // never reuse an id, even across a colliding mint
    const t = this.#now();
    this.#jobs.set(id, {
      id,
      key,
      prompt,
      state: "queued",
      createdAt: t,
      progress: { textChars: 0, toolLines: 0, permissionAsks: 0, lastActivityAt: t },
    });
    return { ok: true, id, state: "queued", queuePosition: this.queuePosition(id), deduped: false };
  }

  /** The id of the oldest queued job, or undefined. The pump's worklist. */
  nextQueued(): string | undefined {
    for (const j of this.#jobs.values()) if (j.state === "queued") return j.id;
    return undefined;
  }

  /** queued -> running. Returns the prompt to send and CLEARS it from the record (minimal retention).
   *  Calling start on anything but a queued job is a programmer error in the pump - throw loudly. */
  start(id: string): string {
    const j = this.#jobs.get(id);
    if (!j || j.state !== "queued") throw new Error(`jobs.start: "${id}" is not queued`);
    const prompt = j.prompt;
    j.prompt = "";
    j.state = "running";
    j.startedAt = this.#now();
    j.progress.lastActivityAt = j.startedAt;
    return prompt;
  }

  /** Update counts for a live job. Unknown or terminal ids are ignored (a late notification is not an error). */
  progress(id: string, counts: { textChars: number; toolLines: number; permissionAsks: number }): void {
    const j = this.#jobs.get(id);
    if (!j || isTerminal(j.state)) return;
    j.progress.textChars = counts.textChars;
    j.progress.toolLines = counts.toolLines;
    j.progress.permissionAsks = counts.permissionAsks;
    j.progress.lastActivityAt = this.#now();
  }

  /** running -> done, storing the post-gate envelope. Terminal states are STICKY: finishing an already
   *  terminal job (e.g. a cancelled one whose remote turn later settled) is a no-op. */
  finish(id: string, envelope: string): void {
    const j = this.#jobs.get(id);
    if (!j || isTerminal(j.state)) return;
    j.state = "done";
    j.envelope = envelope;
    j.endedAt = this.#now();
  }

  /** live -> blocked | error, with the redacted reason. Sticky like finish. */
  fail(id: string, state: "blocked" | "error", reason: string, failClosed?: boolean): void {
    const j = this.#jobs.get(id);
    if (!j || isTerminal(j.state)) return;
    j.state = state;
    j.reason = reason;
    if (failClosed) j.failClosed = true;
    j.endedAt = this.#now();
  }

  /** live -> timeout (the deadline). Sticky like finish. */
  expire(id: string, reason: string): void {
    const j = this.#jobs.get(id);
    if (!j || isTerminal(j.state)) return;
    j.state = "timeout";
    j.reason = reason;
    j.endedAt = this.#now();
  }

  /** queued | running -> cancelled. Returns the prior state so the caller knows whether the remote must be
   *  reached (running) or was never reached (queued). Unknown id -> undefined (the fail-closed answer is
   *  the caller's explicit error result, never "running"). Terminal -> prior state, no change. */
  cancel(id: string, reason = "cancelled by the caller"): { prior: JobState } | undefined {
    const j = this.#jobs.get(id);
    if (!j) return undefined;
    const prior = j.state;
    if (isTerminal(prior)) return { prior };
    j.state = "cancelled";
    j.reason = reason;
    j.prompt = ""; // a dropped queued prompt is not retained
    j.endedAt = this.#now();
    return { prior };
  }

  /** Full record copy for one id (the ids-given `job_status` path), or undefined for an unknown id. */
  view(id: string): JobRecord | undefined {
    const j = this.#jobs.get(id);
    return j ? { ...j, progress: { ...j.progress } } : undefined;
  }

  /** Metadata-only summaries for every job, admit order. This projection CANNOT leak an envelope. */
  viewAll(): JobSummary[] {
    const t = this.#now();
    return [...this.#jobs.values()].map((j) => {
      const elapsedMs = j.startedAt ? (j.endedAt ?? t) - j.startedAt : 0;
      const s: JobSummary = {
        id: j.id,
        state: j.state,
        ageMs: t - j.createdAt,
        elapsedMs,
        queuePosition: this.queuePosition(j.id),
        progress: { ...j.progress },
      };
      if (!isTerminal(j.state)) s.pollHintMs = pollHintMs(elapsedMs);
      if (j.failClosed) s.failClosed = true;
      return s;
    });
  }

  /** Jobs ahead of this one: the running job (if any) plus earlier-admitted queued jobs. 0 for the
   *  running job itself, terminal jobs, and unknown ids. */
  queuePosition(id: string): number {
    const j = this.#jobs.get(id);
    if (!j || j.state !== "queued") return 0;
    let ahead = this.runningId() ? 1 : 0;
    for (const other of this.#jobs.values()) {
      if (other.id === id) break;
      if (other.state === "queued") ahead++;
    }
    return ahead;
  }

  runningId(): string | undefined {
    for (const j of this.#jobs.values()) if (j.state === "running") return j.id;
    return undefined;
  }

  /** queued + running ids, admit order - the shutdown path's cancel worklist. */
  liveIds(): string[] {
    return [...this.#jobs.values()].filter((j) => !isTerminal(j.state)).map((j) => j.id);
  }

  #liveByKey(key: string): JobRecord | undefined {
    for (const j of this.#jobs.values()) if (j.key === key && !isTerminal(j.state)) return j;
    return undefined;
  }
}
