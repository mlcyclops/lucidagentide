// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/popover_place.ts
//
// P-VOICE.2 (ADR-0247): where an anchored popover actually goes. Extracted from ui.ts's popover() because
// the old inline math had two holes that only show up on a SHORT window or a TALL card, and neither is
// reproducible by reading the code:
//   · it never capped the card's height, so a card taller than the room available was pinned to the top
//     margin and simply ran off the bottom of the window;
//   · when the card fit neither above nor below it still chose "above", even when below had more room.
// The composer's pickers (voice, persona, skills) are anchored to the BOTTOM of the window, so "flip above
// and cap the height" is their normal case, not an edge case.
//
// Pure: rectangles in, coordinates out. No DOM. Tested in harness/scripts/demo_pvoice2.ts.

export interface PopoverPlaceInput {
  /** The anchor's viewport rect (only the edges placement depends on). */
  anchor: { top: number; bottom: number; left: number };
  /** The card's NATURAL size, measured with no height cap applied. */
  card: { width: number; height: number };
  viewport: { width: number; height: number };
  /** Space between the anchor and the card. */
  gap?: number;
  /** Minimum distance the card keeps from every viewport edge. */
  margin?: number;
  /** The side tried first. Default "below" (reading order); a prompt bar's menu prefers "above". */
  prefer?: "above" | "below";
}

/** The popover's base layer (styles.css `.popover`). */
export const POPOVER_Z = 95;
/** The tooltip layer (#tip): a lifted popover stays below it so its row tips still show. */
const TIP_Z = 260;

/** The z-index a popover needs so it opens IN FRONT of the layer its anchor lives in, or null when the base
 *  layer already is. `ancestorZ` lists the numeric z-index of every positioned ancestor of the anchor. Without
 *  this a "+" menu inside Ask Lucid (z 250) opened behind the panel: invisible when docked, half hidden when
 *  floating (P-ASKPLUS.1). */
export function popoverLayer(ancestorZ: readonly number[]): number | null {
  const top = Math.max(-Infinity, ...ancestorZ.filter(Number.isFinite));
  return top >= POPOVER_Z ? Math.min(top + 1, TIP_Z - 1) : null;
}

export interface PopoverPlacement {
  left: number;
  top: number;
  /** Apply as `max-height`. Equal to the natural height when it fits; smaller means the card scrolls. */
  maxHeight: number;
  side: "above" | "below";
}

export function placePopover(i: PopoverPlaceInput): PopoverPlacement {
  const gap = i.gap ?? 8;
  const margin = i.margin ?? 10;
  const roomBelow = Math.max(0, i.viewport.height - i.anchor.bottom - gap - margin);
  const roomAbove = Math.max(0, i.anchor.top - gap - margin);
  // Prefer below (reading order). Flip above when the card doesn't fit below. When it fits NEITHER side,
  // take the roomier one and cap the height there, so the card scrolls internally instead of being clipped
  // by the window — which is what happens for a tall picker anchored to the composer.
  const fitsBelow = i.card.height <= roomBelow, fitsAbove = i.card.height <= roomAbove;
  const side = i.prefer === "above"
    ? (fitsAbove ? "above" : fitsBelow ? "below" : roomAbove >= roomBelow ? "above" : "below")
    : (fitsBelow ? "below" : fitsAbove ? "above" : roomAbove > roomBelow ? "above" : "below");
  const maxHeight = Math.min(i.card.height, side === "above" ? roomAbove : roomBelow);
  return {
    left: Math.max(margin, Math.min(i.anchor.left, i.viewport.width - i.card.width - margin)),
    top: side === "above" ? Math.max(margin, i.anchor.top - gap - maxHeight) : i.anchor.bottom + gap,
    maxHeight,
    side,
  };
}
