// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

import { Snowflake } from "@oh-my-pi/pi-utils";

export interface TurnStatus {
  turnId: string;
  sessionId: string | null;
  startedAt: number;
  running: boolean;
}

export interface TurnSnapshot extends TurnStatus {
  prompt: string;
  text: string;
  pending: { label: string; elapsedMs: number }[];
}

export type TurnRecoveryEvent =
  | { type: "turn-snapshot"; snapshot: TurnSnapshot }
  | { type: "done"; text: string };

export interface TurnAttachment {
  attached: boolean;
  running: boolean;
  ended?: Promise<void>;
  detach: () => void;
}

/** One execution owns its answer, not its transports. Only the current/latest turn is retained. */
export class LiveTurn<E extends { type: string; id?: string }> {
  readonly turnId = Snowflake.next();
  readonly startedAt = Date.now();
  text = "";
  running = true;
  private readonly observers = new Set<(event: E | TurnRecoveryEvent) => void>();
  private readonly detachments = new Set<() => void>();
  private readonly permissions = new Map<string, E>();
  private readonly completion = Promise.withResolvers<void>();
  private pending: (() => TurnSnapshot["pending"]) | null;
  readonly ended = this.completion.promise;

  constructor(readonly prompt: string, public sessionId: string | null, pending: () => TurnSnapshot["pending"], readonly requestId?: string) {
    this.pending = pending;
  }

  status(): TurnStatus {
    return { turnId: this.turnId, sessionId: this.sessionId, startedAt: this.startedAt, running: this.running };
  }

  matches(turnId?: string, requestId?: string): boolean {
    return turnId !== undefined ? turnId === this.turnId : requestId === undefined || requestId === this.requestId;
  }

  snapshot(): TurnSnapshot {
    return { ...this.status(), prompt: this.prompt, text: this.text, pending: this.pending?.() ?? [] };
  }

  get subscriberCount(): number { return this.observers.size; }

  attach(onEvent: (event: E | TurnRecoveryEvent) => void, signal?: AbortSignal): TurnAttachment {
    const running = this.running;
    let detached = false;
    const detach = () => {
      detached = true;
      this.observers.delete(deliver);
      this.detachments.delete(detach);
      signal?.removeEventListener("abort", detach);
    };
    const deliver = (event: E | TurnRecoveryEvent) => {
      if (detached) return;
      try { onEvent(event); } catch { detach(); }
    };
    if (signal?.aborted) detached = true;
    else {
      if (running) { this.observers.add(deliver); this.detachments.add(detach); }
      signal?.addEventListener("abort", detach, { once: true });
      deliver({ type: "turn-snapshot", snapshot: this.snapshot() });
      if (running) {
        for (const event of this.permissions.values()) deliver(event);
      } else {
        deliver({ type: "done", text: this.text });
        detach();
      }
    }
    return { attached: true, running, ended: this.ended, detach };
  }

  emit(event: E): void {
    if (!this.running) return;
    if (event.type === "permission" && event.id) this.permissions.set(event.id, event);
    for (const observer of this.observers) observer(event);
  }

  resolvePermission(id: string): void { this.permissions.delete(id); }

  finish(): void {
    if (!this.running) return;
    this.running = false;
    this.permissions.clear();
    this.pending = null;
    try {
      for (const observer of this.observers) observer({ type: "done", text: this.text });
    } finally {
      for (const detach of this.detachments) detach();
      this.completion.resolve();
    }
  }
}
