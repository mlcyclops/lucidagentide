// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/preview_inspect_relay.ts — P-PREVIEW.6b (ADR-0148): the cross-process relay that lets the agent's
// `preview_inspect` tool READ the live preview DOM. The preview iframe is opaque-origin sandboxed, so only the
// RENDERER (via a postMessage bridge, preview_bridge.ts) can read it — not the omp subprocess. Flow:
//
//   agent tool (omp) --POST /api/preview/inspect--> [enqueue + await] --GET next--> renderer
//                     <--------- result ----------- [resolve] <--POST result-- renderer (bridge → back)
//
// This module is the PURE queue+waiter core (no HTTP, no DOM), so it unit-tests. dev.ts wires the endpoints
// and races each waiter against a timeout. Read-only by construction: commands only ever describe a query.

// A preview command carried by the relay: a READ (inspect: `what`/`selector`) or a STRUCTURED action
// (`action` = click|type|focus|scroll, on a CSS `selector`, optional `value` for type). The bridge routes on
// `action`. No arbitrary JS ever crosses this — only these named, bounded operations.
export interface InspectCommand { selector?: string; what?: string; action?: string; value?: string }
export interface QueuedInspect { id: string; command: InspectCommand }

export class InspectRelay {
  private queue: QueuedInspect[] = [];
  private waiters = new Map<string, (r: unknown) => void>();
  private seq = 0;

  /** Enqueue a command from the tool; returns its id + a promise that resolves when the renderer posts the
   *  result (or when `abandon(id)` is called on timeout). */
  enqueue(command: InspectCommand): { id: string; promise: Promise<unknown> } {
    const id = `insp_${++this.seq}`;
    const clean: InspectCommand = {
      selector: typeof command?.selector === "string" ? command.selector.slice(0, 400) : undefined,
      what: typeof command?.what === "string" ? command.what.slice(0, 40) : undefined,
      action: typeof command?.action === "string" ? command.action.slice(0, 20) : undefined,
      value: typeof command?.value === "string" ? command.value.slice(0, 2000) : undefined,
    };
    const promise = new Promise<unknown>((resolve) => { this.waiters.set(id, resolve); });
    this.queue.push({ id, command: clean });
    return { id, promise };
  }

  /** The renderer takes the oldest un-dispatched command (or null). */
  next(): QueuedInspect | null {
    return this.queue.shift() ?? null;
  }

  /** The renderer posts a command's result; resolves the tool's waiter. Returns false if unknown/late. */
  resolve(id: string, result: unknown): boolean {
    const w = this.waiters.get(id);
    if (!w) return false;
    this.waiters.delete(id);
    w(result);
    return true;
  }

  /** Give up on a command (timeout): drop it from the queue and resolve its waiter with a timeout result. */
  abandon(id: string, result: unknown): void {
    this.queue = this.queue.filter((q) => q.id !== id);
    const w = this.waiters.get(id);
    if (w) { this.waiters.delete(id); w(result); }
  }

  /** Diagnostics: pending (queued) + waiting (awaiting result) counts. */
  stats(): { queued: number; waiting: number } {
    return { queued: this.queue.length, waiting: this.waiters.size };
  }
}
