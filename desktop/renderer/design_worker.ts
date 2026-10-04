// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/design_worker.ts - the Design suite's Web Worker entry.
//
// Built as a SECOND bun bundle entry (`build-renderer` writes renderer/design_worker.bundle.js) and served
// same-origin by the engine at /design_worker.js, so `worker-src 'self'` admits it: no blob: URL, no eval,
// no CDN, no CSP change. One task runs at a time per message id; the client cancels by terminating the
// worker (a fresh one is spawned for the next task), so no task needs cooperative cancellation.

import { runDesignTask, transferablesOf, type DesignTask } from "./design_tasks.ts";

interface Inbound { id: number; task: DesignTask }

// The renderer tsconfig types `self` as Window (DOM lib); in a dedicated worker it is the worker scope,
// whose postMessage takes (message, transfer).
const scope = self as unknown as { postMessage(m: unknown, t: Transferable[]): void };
const post = (msg: unknown, transfer: Transferable[] = []) => scope.postMessage(msg, transfer);

self.addEventListener("message", (e: MessageEvent<Inbound>) => {
  const { id, task } = e.data ?? ({} as Inbound);
  if (typeof id !== "number" || !task || typeof task !== "object") return;
  let last = 0;
  const progress = (fraction: number, note?: string) => {
    const now = Date.now();
    if (now - last < 100 && fraction < 1) return;
    last = now;
    post({ id, progress: Math.max(0, Math.min(1, fraction)), note: note ?? "" });
  };
  runDesignTask(task, progress).then(
    (result) => post({ id, ok: true, result }, transferablesOf(result)),
    (err: unknown) => post({ id, ok: false, error: err instanceof Error ? err.message : String(err) }),
  );
});

// The client holds tasks (and their transferable buffers) until this arrives, so a script that failed to
// load never swallows a task's pixels.
post({ ready: true });
