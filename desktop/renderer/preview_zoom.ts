// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/preview_zoom.ts - the Preview panel's zoom steps (operator, 2026-10-19: "the zoom should
// go up and down by whole 10% points"). The buttons used to multiply by 1.1 and the wheel by a continuous
// exponential, so the readout landed on values like 214%. Every change now moves on the whole-10% grid:
// an off-grid zoom (one saved before this change) snaps to the next grid point in the direction asked.

export const PREVIEW_ZOOM_MIN = 0.25;
export const PREVIEW_ZOOM_MAX = 4;
/** A wheel event at least this large is a mouse NOTCH and is one step by itself. A notch is 100 px at 100%
 *  display scaling but reports smaller under OS scaling (80 px at 125%), so the line sits well below it. */
export const PREVIEW_WHEEL_NOTCH_PX = 50;
/** Smaller deltas (trackpads, smooth scrolling) add up to this much travel per step. */
export const PREVIEW_WHEEL_STEP_PX = 100;

/** One 10-point step up (dir 1) or down (dir -1) from `zoom` (1 = 100%), clamped to the zoom range. */
export function stepPreviewZoom(zoom: number, dir: 1 | -1): number {
  const pct = Math.round(zoom * 1000) / 10; // 2.0999999 reads as 210, not 209.99999
  const next = dir > 0 ? Math.floor(pct / 10) * 10 + 10 : Math.ceil(pct / 10) * 10 - 10;
  return Math.max(PREVIEW_ZOOM_MIN, Math.min(PREVIEW_ZOOM_MAX, next / 100));
}

/** Turns wheel travel into whole zoom steps: one notch is one step, small trackpad deltas add up, and a
 *  reversal starts over. */
export class PreviewWheelSteps {
  #acc = 0;
  /** Feed wheel pixels (deltaY sign: negative zooms in). Returns the signed number of steps to take now. */
  feed(pixels: number): number {
    if (Math.abs(pixels) >= PREVIEW_WHEEL_NOTCH_PX) { this.#acc = 0; return pixels < 0 ? 1 : -1; }
    if (Math.sign(pixels) !== Math.sign(this.#acc)) this.#acc = 0;
    this.#acc += pixels;
    const n = Math.trunc(this.#acc / PREVIEW_WHEEL_STEP_PX);
    this.#acc -= n * PREVIEW_WHEEL_STEP_PX;
    return n === 0 ? 0 : -n;
  }
}
