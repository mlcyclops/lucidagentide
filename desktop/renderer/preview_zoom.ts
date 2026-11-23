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

/** P-PREVIEW.FIT1: what the previewed document reported about its own size (preview_bridge PREVIEW_ZOOM_JS):
 *  its content box `w` x `h`, and `fixed` when html/body cannot scroll (a slide, a video card, a poster), so the
 *  content past the frame's edge is only reachable if the panel lays it out whole. */
export interface PreviewContentSize { w: number; h: number; fixed: boolean }

/** Never lay a document out wider or taller than this (a page sized in vw/vh grows with its frame). */
export const PREVIEW_CONTENT_MAX_PX = 8192;

/**
 * The stage (iframe) size and CSS zoom for one preview tab in the desktop device mode.
 * - The frame is at least as wide as the panel. A document wider than that (a 1920 px video card in a 780 px
 *   panel) gets a frame as wide as its content, so nothing is cut off and the panel pans across it.
 * - A document that cannot scroll itself (`fixed`) also gets a frame as tall as its content.
 * - `fit` (the default) picks the zoom that shows all of an oversized document: the panel width over the content
 *   width (and height, for a fixed document), never above 100%. A document that already fits keeps 100%.
 * - Otherwise the user's manual zoom applies.
 */
export function previewLayout(o: { viewportW: number; viewportH: number; content: PreviewContentSize | null; fit: boolean; manualZoom: number }): { stageW: number; stageH: number; zoom: number; fitZoom: number } {
  const vw = Math.max(1, o.viewportW), vh = Math.max(1, o.viewportH);
  const c = o.content;
  const cw = c ? Math.min(PREVIEW_CONTENT_MAX_PX, Math.max(0, c.w)) : 0;
  const ch = c && c.fixed ? Math.min(PREVIEW_CONTENT_MAX_PX, Math.max(0, c.h)) : 0;
  let fitZoom = 1;
  if (cw > vw + 1) fitZoom = Math.min(fitZoom, vw / cw);
  if (ch > vh + 1) fitZoom = Math.min(fitZoom, vh / ch);
  fitZoom = Math.max(PREVIEW_ZOOM_MIN, fitZoom);
  const zoom = o.fit ? fitZoom : Math.max(PREVIEW_ZOOM_MIN, Math.min(PREVIEW_ZOOM_MAX, o.manualZoom));
  // Below 100% the frame grows so the shrunken page still fills the panel; above 100% the page keeps the panel's
  // layout width and is magnified (the panel scrolls and pans across it), as before.
  const fill = Math.min(zoom, 1);
  return { stageW: Math.max(vw / fill, cw), stageH: Math.max(vh / fill, ch), zoom, fitZoom };
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
