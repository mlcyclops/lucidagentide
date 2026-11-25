// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/viz_panel_size.ts - P-VIZ.LANE1 (ADR-0683): the Agent Worlds node panel's user size. Pure: the
// size a drag or an arrow key asks for, clamped to the stage (never under PANEL_MIN_W x PANEL_MIN_H, never past the
// stage less its margins), and the persisted choice (localStorage `lucid.viz.panelSize.v1`). No saved size means
// the panel's natural size. viz_view applies it; viz_panel_place keeps the panel beside its node at any size.

import { PANEL_MARGIN, type PanelSide } from "./viz_panel_place.ts";

export const PANEL_SIZE_KEY = "lucid.viz.panelSize.v1";
export const PANEL_MIN_W = 320;
export const PANEL_MIN_H = 240;
/** One arrow key press on the grip; Shift takes four. */
export const PANEL_STEP = 24;

export interface PanelSize { w: number; h: number }
/** Which handle: the panel's outer side edge, its bottom edge, or the outer bottom corner (both). */
export type PanelEdge = "x" | "y" | "xy";

export interface SizeStore { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(Math.max(lo, hi), v));

/** `s` inside a stage of `room`: at least the minimum, at most the stage less a margin on each side. A stage
 *  smaller than the minimum gets the minimum (the placement then clamps the panel's position, as for any size). */
export function clampPanelSize(s: PanelSize, room: { w: number; h: number }): PanelSize {
  return {
    w: Math.round(clamp(s.w, PANEL_MIN_W, room.w - 2 * PANEL_MARGIN)),
    h: Math.round(clamp(s.h, PANEL_MIN_H, room.h - 2 * PANEL_MARGIN)),
  };
}

/** The size a drag of (dx, dy) from `start` asks for. The outer edge is the one away from the node: the right edge
 *  while the panel sits right of its node (`side` "right"), the left edge while it sits left, so dragging outward
 *  always widens it. The panel stays centered on its node vertically, so the bottom edge follows the pointer when
 *  the height changes by twice the drag. */
export function dragPanelSize(start: PanelSize, edge: PanelEdge, side: PanelSide, dx: number, dy: number, room: { w: number; h: number }): PanelSize {
  const w = edge === "y" ? start.w : start.w + (side === "right" ? dx : -dx);
  const h = edge === "x" ? start.h : start.h + 2 * dy;
  return clampPanelSize({ w, h }, room);
}

/** The grip's keyboard: Right and Left widen and narrow, Down and Up grow and shrink; null for any other key. */
export function stepPanelSize(cur: PanelSize, key: string, big: boolean, room: { w: number; h: number }): PanelSize | null {
  const d = big ? PANEL_STEP * 4 : PANEL_STEP;
  const delta: Record<string, [number, number]> = { ArrowRight: [d, 0], ArrowLeft: [-d, 0], ArrowDown: [0, d], ArrowUp: [0, -d] };
  const m = delta[key];
  return m ? clampPanelSize({ w: cur.w + m[0], h: cur.h + m[1] }, room) : null;
}

/** The saved size, or null (none, unreadable, or not two positive finite numbers). */
export function loadPanelSize(store: SizeStore): PanelSize | null {
  let raw: string | null = null;
  try { raw = store.getItem(PANEL_SIZE_KEY); } catch { return null; }
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object") return null;
    const { w, h } = v as Record<string, unknown>;
    if (typeof w !== "number" || typeof h !== "number" || !Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
    return { w: Math.round(w), h: Math.round(h) };
  } catch {
    return null;
  }
}

/** Remember `s` (null forgets it: the panel goes back to its natural size). A storage that refuses keeps the size
 *  for this session only. */
export function savePanelSize(store: SizeStore, s: PanelSize | null): void {
  try {
    if (s) store.setItem(PANEL_SIZE_KEY, JSON.stringify({ w: Math.round(s.w), h: Math.round(s.h) }));
    else store.removeItem(PANEL_SIZE_KEY);
  } catch { /* the size still applies until the app closes */ }
}
