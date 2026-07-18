// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/preview_snapshot.ts - P-PREVIEW-PWA.1 (ADR-0237): the PURE sizing math for a "send the
// Preview panel to my phone" snapshot. The capture itself (Electron capturePage) and the canvas downscale
// live in the renderer (app.ts); the aspect-preserving fit is pure so it is unit-tested headless and shared.
//
// A raw preview capture is device-pixel-ratio-scaled and can be multiple megabytes as a PNG data URL - far too
// heavy to broadcast E2E over the relay. We downscale so the LONGEST edge is at most MAX_SNAPSHOT_EDGE before
// encoding, which keeps a snapshot in the tens-of-KB range while staying legible on a phone.

/** Longest-edge cap (px) for a broadcast preview snapshot. Legible on a phone, small enough to seal + relay. */
export const MAX_SNAPSHOT_EDGE = 1280;

/** Scale `(w, h)` so its LONGEST edge is at most `max`, preserving aspect ratio and NEVER upscaling. Returns
 *  integer dimensions. A non-positive input degrades to `{ w: 0, h: 0 }` (the caller skips a zero-area frame). */
export function fitWithin(w: number, h: number, max: number = MAX_SNAPSHOT_EDGE): { w: number; h: number } {
  if (!(w > 0) || !(h > 0) || !(max > 0)) return { w: 0, h: 0 };
  const longest = Math.max(w, h);
  if (longest <= max) return { w: Math.round(w), h: Math.round(h) };
  const scale = max / longest;
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}

// -- P-PREVIEW-PWA.2 (ADR-0239): phone markup strokes --

/** A markup stroke point in NORMALIZED image space (0..1 on each axis). Strokes stored normalized survive a
 *  rotation/resize of the on-screen viewer AND scale losslessly onto the natural-size composite sent back. */
export interface NormPoint { x: number; y: number }

/** Map a pointer position to normalized image space, CLAMPED into the image (a stroke that wanders off the
 *  edge pins to it instead of landing outside the composite). A degenerate rect degrades to 0 (never NaN). */
export function toNormPoint(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }): NormPoint {
  const x = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
  const y = rect.height > 0 ? (clientY - rect.top) / rect.height : 0;
  return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
}

/** Markup pen width for an image `w` px wide: scales with the image so the sent-back composite's ink reads
 *  the same as it did on screen. Floor of 3 keeps a visible line on tiny captures. */
export function penWidthFor(w: number): number {
  return Math.max(3, Math.round(w / 220));
}
