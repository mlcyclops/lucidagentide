// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Herd (ADR-0535; P-HERD.4, ADR-0493 items 1 and 4): the LANE FEED. The Herd server keeps one
// /api/fleet/watch NDJSON stream per lane of its engine's fleet, the engine's own push of every lane
// transition, and turns them into transitions `{ ts, lane, name, from, to, cursor }`: metadata only,
// never a token, a tool detail, an ask summary or reply text (ADR-0271). Waits (waits.ts) and
// `agent events` read this feed; nothing here polls.
//
// Where a status comes from, and why it is never stale:
//   - a lane's watch stream: every `status` event, as the engine emits it. Authoritative.
//   - one read of /api/fleet/status, asked for only when something needs settling: a stream just
//     opened (the engine sends no status on attach), a stream dropped (was the lane dismissed?), or a
//     poll snapshot disagrees with the feed (a lane appeared or vanished). A read applies to a lane
//     only when no status event arrived after the read STARTED (a monotonic tick, no clock), because
//     an event the engine emitted before answering the read could otherwise be undone by it.
//   - the hub's own poll snapshot (onFleet): only learns lanes and names, and asks for a read when it
//     disagrees. A lane absent from a read that started after the lane was known is gone (`to: null`).
// A stream that drops is reopened after a pause, never in a tight loop.
//
// Cursors are `<boot>-<seq>`: a resume with this server's boot id replays the retained transitions
// after it (the last 1000); a cursor from an earlier server replays everything retained.

import { randomBytes } from "node:crypto";
import type { HubDiscovery } from "../../../harness/launcher/hub_control.ts";
import { HubOpError } from "../../../harness/launcher/hub_spaces.ts";

export interface LaneTransition {
  ts: number;
  lane: string;
  name: string;
  /** null = the lane was not known before (it appeared). */
  from: string | null;
  /** null = the lane left the fleet. */
  to: string | null;
  cursor: string;
}

export interface WatchHandlers {
  /** The engine answered: its observer is attached, so every later transition arrives. */
  opened(): void;
  event(e: Record<string, unknown>): void;
}

export interface FeedDeps {
  /** Follow one lane's /api/fleet/watch; settles when the stream ends or `signal` aborts. */
  openWatch(laneId: string, signal: AbortSignal, on: WatchHandlers): Promise<void>;
  /** One read of the fleet's lanes (/api/fleet/status). */
  readLanes(): Promise<Record<string, unknown>[]>;
  now(): number;
  /** Settles after `ms`, or at once when `signal` aborts (the pause before a dropped stream reopens). */
  pause(ms: number, signal: AbortSignal): Promise<void>;
}

/** One-shot timers, injected so tests never wait on a clock. Returns a cancel. */
export interface Timers {
  after(ms: number, fn: () => void): () => void;
}

export const REAL_TIMERS: Timers = {
  after(ms, fn) {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  },
};

/** How many transitions a cursor can resume across. */
export const RETAINED_TRANSITIONS = 1000;
const REOPEN_MS = 2000;
/** A blank NDJSON line this often keeps a long reply under the control server's idle timeout. */
export const KEEPALIVE_MS = 5000;
export const CURSOR_RE = /^([0-9a-f]{1,16})-(\d{1,15})$/;

const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

interface Tracked {
  id: string;
  name: string;
  status: string | null;
  /** Tick at which the feed learned the lane exists. */
  known: number;
  /** Tick of the last status event its stream delivered (0 = none). */
  event: number;
  ctl: AbortController;
}

export class LaneFeed {
  readonly #deps: FeedDeps;
  readonly #boot: string;
  #seq = 0;
  #tick = 0;
  readonly #lanes = new Map<string, Tracked>();
  readonly #log: { seq: number; t: LaneTransition }[] = [];
  readonly #subs = new Set<{ lane: string | null; fn: (t: LaneTransition) => void }>();
  readonly #activity = new Set<{ lane: string; fn: () => void }>();
  #reading = false;
  #again = false;
  #closed = false;

  constructor(deps: FeedDeps, boot: string = randomBytes(4).toString("hex")) {
    this.#deps = deps;
    this.#boot = boot;
  }

  /** The hub's poll snapshot: learns new lanes (and opens their streams) and names; a disagreement
   *  about a known lane's status or presence asks for a read instead of trusting a stale snapshot. */
  snapshot(lanes: readonly Record<string, unknown>[]): void {
    if (this.#closed) return;
    const ids = new Set<string>();
    let differs = false;
    for (const l of lanes) {
      const id = str(l.id);
      if (!id) continue;
      ids.add(id);
      const t = this.#lanes.get(id);
      if (!t) { this.#learn(id, str(l.name) || id, str(l.status) || null); continue; }
      if (str(l.name)) t.name = str(l.name);
      if ((str(l.status) || null) !== t.status) differs = true;
    }
    for (const id of this.#lanes.keys()) if (!ids.has(id)) differs = true;
    if (differs) this.#requestRead();
  }

  /** Follow a lane a caller just resolved (a spawn reply, an `agent status` read). A lane the feed
   *  already follows keeps its own status. */
  track(id: string, name: string, status: string | null): void {
    if (this.#closed || this.#lanes.has(id)) return;
    this.#learn(id, name || id, status);
  }

  status(id: string): { name: string; status: string | null } | undefined {
    const t = this.#lanes.get(id);
    return t ? { name: t.name, status: t.status } : undefined;
  }

  /** Every transition from now on (one lane, or all with null). Returns the unsubscribe. */
  subscribe(lane: string | null, fn: (t: LaneTransition) => void): () => void {
    const s = { lane, fn };
    this.#subs.add(s);
    return () => { this.#subs.delete(s); };
  }

  /** Any watch event at all on `lane` (a token, a tool, a status): what "the lane moved" means for
   *  the stall rule. Carries nothing of the event. */
  onActivity(lane: string, fn: () => void): () => void {
    const a = { lane, fn };
    this.#activity.add(a);
    return () => { this.#activity.delete(a); };
  }

  /** The retained transitions after `cursor` (one lane, or all with null). A cursor from another
   *  server replays everything retained; a malformed one is a usage error. */
  since(cursor: string, lane: string | null): LaneTransition[] {
    const m = CURSOR_RE.exec(cursor);
    if (!m) throw new HubOpError("usage", `--since takes a cursor from an earlier event (like "${this.#boot}-1")`);
    const after = m[1] === this.#boot ? Number(m[2]) : 0;
    return this.#log.filter((x) => x.seq > after && (lane === null || x.t.lane === lane)).map((x) => x.t);
  }

  close(): void {
    this.#closed = true;
    for (const t of this.#lanes.values()) t.ctl.abort();
    this.#lanes.clear();
    this.#subs.clear();
    this.#activity.clear();
  }

  #learn(id: string, name: string, status: string | null): void {
    const t: Tracked = { id, name, status, known: ++this.#tick, event: 0, ctl: new AbortController() };
    this.#lanes.set(id, t);
    this.#emit(t, null, status);
    void this.#follow(t);
  }

  async #follow(t: Tracked): Promise<void> {
    const signal = t.ctl.signal;
    while (!signal.aborted) {
      try {
        await this.#deps.openWatch(t.id, signal, {
          opened: () => { if (!signal.aborted) this.#requestRead(); },
          event: (e) => { if (!signal.aborted) this.#event(t, e); },
        });
      } catch { /* refused, dropped or aborted: settled below */ }
      if (signal.aborted) return;
      this.#requestRead(); // a dismissed lane's stream ends: a read says whether it is gone
      await this.#deps.pause(REOPEN_MS, signal);
    }
  }

  #event(t: Tracked, e: Record<string, unknown>): void {
    if (e.type === "watch-seed" || e.type === "ping") return; // history and keepalives are not movement
    for (const a of [...this.#activity]) if (a.lane === t.id) { try { a.fn(); } catch { /* one bad listener */ } }
    if (e.type === "status" && typeof e.status === "string" && e.status) {
      t.event = ++this.#tick;
      this.#set(t, e.status);
    }
  }

  #requestRead(): void {
    this.#again = true;
    if (!this.#reading) void this.#readLoop();
  }

  async #readLoop(): Promise<void> {
    this.#reading = true;
    try {
      while (this.#again && !this.#closed) {
        this.#again = false;
        const start = ++this.#tick;
        let lanes: Record<string, unknown>[];
        try { lanes = await this.#deps.readLanes(); } catch { return; } // engine away: the next snapshot or stream end asks again
        if (!this.#closed) this.#apply(lanes, start);
      }
    } finally {
      this.#reading = false;
    }
  }

  #apply(lanes: readonly Record<string, unknown>[], start: number): void {
    const ids = new Set<string>();
    for (const l of lanes) {
      const id = str(l.id);
      if (!id) continue;
      ids.add(id);
      const status = str(l.status) || null;
      const t = this.#lanes.get(id);
      if (!t) { this.#learn(id, str(l.name) || id, status); continue; }
      if (str(l.name)) t.name = str(l.name);
      if (t.event < start && status !== null) this.#set(t, status);
    }
    for (const t of [...this.#lanes.values()]) {
      if (ids.has(t.id) || t.known >= start) continue;
      t.ctl.abort();
      this.#lanes.delete(t.id);
      this.#emit(t, t.status, null);
    }
  }

  #set(t: Tracked, status: string): void {
    if (t.status === status) return;
    const from = t.status;
    t.status = status;
    this.#emit(t, from, status);
  }

  #emit(t: Tracked, from: string | null, to: string | null): void {
    if (from === to) return;
    const seq = ++this.#seq;
    const tr: LaneTransition = { ts: this.#deps.now(), lane: t.id, name: t.name, from, to, cursor: `${this.#boot}-${seq}` };
    this.#log.push({ seq, t: tr });
    if (this.#log.length > RETAINED_TRANSITIONS) this.#log.splice(0, this.#log.length - RETAINED_TRANSITIONS);
    for (const s of [...this.#subs]) if (s.lane === null || s.lane === t.id) { try { s.fn(tr); } catch { /* one bad subscriber */ } }
  }
}

/** Read an NDJSON body line by line (a trailing line without a newline included); blank lines are
 *  skipped. */
export async function readNdjson(body: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) onLine(line);
      }
    }
    buf += dec.decode();
    if (buf.trim()) onLine(buf.trim());
  } finally {
    reader.releaseLock();
  }
}

/** The feed bound to the server's engine: the same routes and token the hub already uses. */
export function engineFeedDeps(engine: { base: string; token: string }): FeedDeps {
  const headers = { "x-lucid-token": engine.token };
  return {
    async openWatch(laneId, signal, on) {
      const res = await fetch(`${engine.base}/api/fleet/watch`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ laneId }),
        signal,
      });
      if (!res.ok || !res.body) return;
      on.opened();
      await readNdjson(res.body, (line) => {
        let e: unknown;
        try { e = JSON.parse(line); } catch { return; }
        if (isRecord(e)) on.event(e);
      });
    },
    async readLanes() {
      const res = await fetch(`${engine.base}/api/fleet/status`, { headers, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`/api/fleet/status -> ${res.status}`);
      const j: unknown = await res.json();
      const body = isRecord(j) && isRecord(j.data) ? j.data : j;
      const lanes = isRecord(body) && Array.isArray(body.lanes) ? body.lanes : [];
      return lanes.filter(isRecord);
    },
    now: Date.now,
    pause: (ms, signal) =>
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, ms);
        signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
      }),
  };
}

/** A failure as the control plane words it: `{ error: code, message }`. */
export function errorBody(e: unknown): { error: string; message: string } {
  if (e instanceof HubOpError) return { error: e.code, message: e.message };
  return { error: "internal", message: e instanceof Error ? e.message : String(e) };
}

/** A /cmd reply that streams NDJSON: `run` writes lines until it settles; a blank line every
 *  KEEPALIVE_MS keeps the connection from idling out; a client that leaves aborts `signal`. A
 *  failure in `run` becomes a final `{ error, message }` line. */
export function ndjsonResponse(run: (write: (line: string) => void, signal: AbortSignal) => Promise<void>, timers: Timers = REAL_TIMERS): Response {
  const ctl = new AbortController();
  const enc = new TextEncoder();
  let stopBeat = (): void => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;
      const write = (line: string): void => {
        if (!open) return;
        try { controller.enqueue(enc.encode(`${line}\n`)); } catch { open = false; }
      };
      const beat = (): void => { write(""); if (open) stopBeat = timers.after(KEEPALIVE_MS, beat); };
      stopBeat = timers.after(KEEPALIVE_MS, beat);
      void run(write, ctl.signal)
        .catch((e: unknown) => { write(JSON.stringify(errorBody(e))); })
        .finally(() => {
          open = false;
          stopBeat();
          try { controller.close(); } catch { /* the client already left */ }
        });
    },
    cancel() {
      stopBeat();
      ctl.abort();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" } });
}

/** Client side: send one argv to a verified hub and read its reply line by line, with no deadline
 *  (a wait may last as long as the script wants). Resolves with the HTTP status. */
export async function streamHub(d: HubDiscovery, argv: readonly string[], onLine: (line: string) => void, signal?: AbortSignal): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${d.port}/cmd`, {
    method: "POST",
    headers: { "x-lucid-hub-token": d.token, "content-type": "application/json" },
    body: JSON.stringify({ argv }),
    ...(signal ? { signal } : {}),
  });
  if (res.body) await readNdjson(res.body, onLine);
  return res.status;
}
