// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/viz_panel_place.ts - P-VIZ.5 (ADR-0629): where the Visualize node panel goes.
//
// The panel sits BESIDE its node, never over it: on the side with more room (right when the node is left of
// the stage's middle, left when it is right of it; a tie goes right), vertically centered on the node and
// clamped inside the stage with a margin. A side it already has is kept until the node crosses the middle by
// more than the hysteresis band, so a node drifting around the middle never makes it flicker; a side the panel
// does not fit on gives way to one it does. A node off screen leaves the panel docked at the nearest edge with
// its tail pointing out toward the node, instead of the panel leaving with it. Pure: no DOM, all stage pixels.

export type PanelSide = "left" | "right";

/** The node on screen in stage pixels: its center and its half extent. */
export interface NodeBox { x: number; y: number; r: number }

export interface PanelPlacement {
  left: number;
  top: number;
  /** Which side of the node the panel is on (its tail is on the opposite edge, facing the node). */
  side: PanelSide;
  /** The tail's offset from the panel's top edge, aimed at the node. */
  tailY: number;
  /** The node is off screen: the panel is docked at the edge nearest it. */
  docked: boolean;
  /** The 3D tilt (degrees, CSS rotateY): the edge nearest the node leans back, toward it. */
  ry: number;
}

export const PANEL_MARGIN = 10;
/** Room between the node's edge and the panel's tail. */
export const PANEL_GAP = 14;
/** How far past the stage's middle (px) the node has to go before the panel changes sides. */
export const PANEL_HYSTERESIS = 56;
const TAIL_INSET = 18;
const TILT_DEG = 7;

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(Math.max(lo, hi), v));

/** Place a panel of `panel` size beside `node` inside a stage of `stage` size; `prev` is the side it had last
 *  frame (null when it just opened). */
export function placePanel(stage: { w: number; h: number }, panel: { w: number; h: number }, node: NodeBox, prev: PanelSide | null): PanelPlacement {
  const { w, h } = stage;
  const offX = node.x < 0 ? -1 : node.x > w ? 1 : 0;
  const docked = offX !== 0 || node.y < 0 || node.y > h;
  // A node off screen counts as a point on the edge nearest it.
  const x = clamp(node.x, 0, w), y = clamp(node.y, 0, h), r = docked ? 0 : node.r;
  const fits = (s: PanelSide): boolean => (s === "right" ? w - PANEL_MARGIN - (x + r + PANEL_GAP) : x - r - PANEL_GAP - PANEL_MARGIN) >= panel.w;
  let side: PanelSide;
  if (offX < 0) side = "right"; // off to the left: docked at the left edge, the tail points left
  else if (offX > 0) side = "left";
  else {
    const d = x - w / 2;
    side = prev === "right" ? (d > PANEL_HYSTERESIS ? "left" : "right")
      : prev === "left" ? (d < -PANEL_HYSTERESIS ? "right" : "left")
      : d > 0 ? "left" : "right";
    const other: PanelSide = side === "right" ? "left" : "right";
    if (!fits(side) && fits(other)) side = other;
  }
  const left = Math.round(clamp(side === "right" ? x + r + PANEL_GAP : x - r - PANEL_GAP - panel.w, PANEL_MARGIN, w - panel.w - PANEL_MARGIN));
  const top = Math.round(clamp(y - panel.h / 2, PANEL_MARGIN, h - panel.h - PANEL_MARGIN));
  const tailY = Math.round(clamp(y - top, TAIL_INSET, panel.h - TAIL_INSET));
  return { left, top, side, tailY, docked, ry: side === "right" ? -TILT_DEG : TILT_DEG };
}
