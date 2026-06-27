// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/chat_gate.ts — P-KG-INGEST.3 (ADR-0081): let background extraction YIELD to a live chat turn.
//
// Model-mode ingest fires a model `complete()` per message, back-to-back, through the one omp connection.
// Without a gate, a 25-minute AI import keeps the connection busy and live chat stalls. This tiny gate lets
// `complete()` await `whenIdle()` before each extraction: while a chat turn is in flight the import pauses,
// so chat preempts the import (at most one in-flight extraction of latency), then the import resumes.

export class ChatGate {
  #active = false;
  #waiters: Array<() => void> = [];

  /** Whether a chat turn is currently in flight. */
  get active(): boolean { return this.#active; }

  /** Mark a chat turn as started. */
  begin(): void { this.#active = true; }

  /** Mark the chat turn as finished and release anything waiting for idle. Safe to call when idle. */
  end(): void {
    if (!this.#active) return;
    this.#active = false;
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const resolve of waiters) resolve();
  }

  /** Resolves immediately when no chat turn is active, otherwise when the current one ends. */
  whenIdle(): Promise<void> {
    return this.#active ? new Promise<void>((resolve) => this.#waiters.push(resolve)) : Promise.resolve();
  }
}
