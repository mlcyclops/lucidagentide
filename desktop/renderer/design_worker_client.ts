// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/design_worker_client.ts - the main-thread side of the design worker.
//
// `run(task)` posts one task and resolves with its result; progress arrives through a callback. `cancel()`
// terminates the worker (the only cancellation that is instant for a tight pixel loop) and rejects every
// pending task with DesignCancelled; the next task spawns a fresh worker.
//
// The worker is the same-origin script /design_worker.js (see design_worker.ts). Tasks wait for its
// `ready` message before they are posted (posting transfers their buffers, which a script that never
// loaded would swallow). If it cannot start (an engine without the route), the waiting tasks run on the
// main thread through the same runDesignTask code, and `mode()` says so, so the pane can tell the user.

import { runDesignTask, type DesignTask, type DesignTaskResult } from "./design_tasks.ts";

export class DesignCancelled extends Error {
  constructor() { super("Cancelled."); this.name = "DesignCancelled"; }
}

export const DESIGN_WORKER_URL = "/design_worker.js";

interface Pending { resolve: (r: DesignTaskResult) => void; reject: (e: Error) => void; onProgress?: (f: number, note: string) => void }
interface Waiting { id: number; task: DesignTask; transfer: Transferable[] }

export class DesignWorkerClient {
  private worker: Worker | null = null;
  private ready = false;
  private inline = false;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private waiting: Waiting[] = [];
  private cancelledInline = new Set<number>();

  mode(): "worker" | "main-thread" { return this.inline ? "main-thread" : "worker"; }
  busy(): boolean { return this.pending.size > 0; }

  private spawn(): void {
    if (this.inline || this.worker) return;
    let w: Worker;
    try { w = new Worker(DESIGN_WORKER_URL, { type: "module", name: "lucid-design" }); }
    catch { this.fallBack(); return; }
    this.worker = w;
    this.ready = false;
    // A script that loads but never announces itself (an error page served as JS) must not hang tasks.
    setTimeout(() => { if (this.worker === w && !this.ready) { w.terminate(); this.fallBack(); } }, 10_000);
    w.addEventListener("message", (e: MessageEvent) => this.onMessage(e.data));
    w.addEventListener("error", (e) => {
      e.preventDefault();
      w.terminate();
      if (this.worker !== w) return;
      this.worker = null;
      if (!this.ready) { this.fallBack(); return; }
      // A crash after start: fail what was in flight; the next task spawns a fresh worker.
      for (const [, p] of this.pending) p.reject(new Error("The design worker stopped unexpectedly."));
      this.pending.clear();
    });
  }

  /** The worker script never started: run everything waiting on the main thread from now on. */
  private fallBack(): void {
    this.inline = true;
    this.worker = null;
    const waiting = this.waiting;
    this.waiting = [];
    for (const w of waiting) this.runInline(w.id, w.task);
  }

  private onMessage(m: unknown): void {
    if (!m || typeof m !== "object") return;
    if ("ready" in m && m.ready === true) {
      this.ready = true;
      const waiting = this.waiting;
      this.waiting = [];
      for (const w of waiting) this.post(w);
      return;
    }
    if (!("id" in m) || typeof m.id !== "number") return;
    const p = this.pending.get(m.id);
    if (!p) return;
    if ("progress" in m && typeof m.progress === "number") {
      p.onProgress?.(m.progress, "note" in m && typeof m.note === "string" ? m.note : "");
      return;
    }
    this.pending.delete(m.id);
    if ("ok" in m && m.ok === true && "result" in m) p.resolve(m.result as DesignTaskResult);
    else p.reject(new Error("error" in m && typeof m.error === "string" ? m.error : "The design worker failed."));
  }

  private post(w: Waiting): void {
    const p = this.pending.get(w.id);
    if (!p || !this.worker) return;
    try { this.worker.postMessage({ id: w.id, task: w.task }, w.transfer); }
    catch (e) { this.pending.delete(w.id); p.reject(e instanceof Error ? e : new Error(String(e))); }
  }

  private runInline(id: number, task: DesignTask): void {
    // Yield once so the UI paints the busy state before the main thread is taken.
    setTimeout(() => {
      if (this.cancelledInline.delete(id)) return;
      const p = this.pending.get(id);
      if (!p) return;
      runDesignTask(task, (f, note) => p.onProgress?.(f, note ?? "")).then(
        (r) => { if (this.pending.delete(id)) p.resolve(r); },
        (e: unknown) => { if (this.pending.delete(id)) p.reject(e instanceof Error ? e : new Error(String(e))); },
      );
    }, 0);
  }

  run<T extends DesignTaskResult>(task: DesignTask, opts: { transfer?: Transferable[]; onProgress?: (f: number, note: string) => void } = {}): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      // The caller names the result type of the task it posted; the worker returns exactly that shape.
      this.pending.set(id, { resolve: (r) => resolve(r as T), reject, onProgress: opts.onProgress });
      this.spawn();
      const w: Waiting = { id, task, transfer: opts.transfer ?? [] };
      if (this.inline) this.runInline(id, task);
      else if (this.ready) this.post(w);
      else this.waiting.push(w);
    });
  }

  /** Stop everything now. Pending promises reject with DesignCancelled. */
  cancel(): void {
    this.worker?.terminate();
    this.worker = null;
    this.ready = false;
    this.waiting = [];
    for (const [id, p] of this.pending) { if (this.inline) this.cancelledInline.add(id); p.reject(new DesignCancelled()); }
    this.pending.clear();
  }
}
