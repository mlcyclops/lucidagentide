// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/viz_bus.ts - P-VIZ.1 (ADR-0622): the tiny typed tap the Visualize view listens on.
//
// app.ts's chat turn handler and fleet_grid.ts's lane sink call `vizBus.emit(source, origin, e)` for every
// event they already receive. The bus keeps no history and does no work while nobody listens: with the
// Visualize overlay closed `emit` is one length check, so the taps cost nothing on the hot token path.

/** Which stream carried an event. The same lane can be watched by several streams at once (its grid card,
 *  the main composer attached to it, the Visualize view's own watch); viz_model keeps one per source. */
export type VizOrigin = "chat" | "lane" | "watch" | "demo";

/** One tapped event. `source` is "main" for the master session, else the lane id. `e` is the raw ChatEvent
 *  or LaneEvent: viz_model narrows the few types it reads and ignores the rest. */
export interface VizBusEvent { source: string; origin: VizOrigin; e: { readonly type: string } }

type Listener = (ev: VizBusEvent) => void;

const listeners = new Set<Listener>();

export const vizBus = {
  /** Fan an event out to the listeners; a no-op with none (the overlay closed). Never throws into the tap. */
  emit(source: string, origin: VizOrigin, e: { readonly type: string }): void {
    if (!listeners.size) return;
    const ev: VizBusEvent = { source, origin, e };
    for (const fn of listeners) {
      try { fn(ev); } catch { /* a visualization fault must never break the chat or lane stream */ }
    }
  },
  /** Listen; returns the unsubscribe. */
  on(fn: Listener): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  },
  /** True while something listens (lets a caller skip building an event it would only drop). */
  get active(): boolean { return listeners.size > 0; },
};
