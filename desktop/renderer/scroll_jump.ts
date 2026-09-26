// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/scroll_jump.ts - the PURE scroll math behind the catch-up buttons, shared by the main
// chat thread and every fleet lane transcript.
//
// The main composer grew a page stepper (single chevron) and a run-to-end button (double chevron), and the
// math lived inline in app.ts keyed to `#chat`. A fleet lane needs the identical behaviour in its own
// scroller, and a second copy of "one viewport minus a line of overlap" is how the two would drift: the
// main chat would get a tuning pass the lanes never saw. So the arithmetic lives here, DOM-free, and both
// callers read it.
//
// Every entry point is defended against the shapes a live scroller actually produces: a zero-height
// element mid-layout, a fractional devicePixelRatio scrollHeight, a NaN line height from a font that has
// not loaded. None of those may yield a NaN scroll target, because assigning NaN to scrollTop silently
// does nothing and the button reads as broken.

/** Content below the fold, in px, before a catch-up button is worth showing. Below this the reader can
 *  just flick the wheel. */
export const JUMP_SHOW_PX = 140;

/** A lane transcript is a fraction of the window's height, so it needs its own, smaller threshold: 140px
 *  of overflow in a 180px-tall scroller means the buttons would essentially never appear. */
export const LANE_JUMP_SHOW_PX = 48;

function num(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export interface ScrollMetrics {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

/** How much content sits below the fold. Never negative: an over-scrolled or mid-layout element can
 *  report a scrollTop past the bottom, and a negative "below" would read as "plenty left to scroll". */
export function belowFold(m: ScrollMetrics): number {
  const h = num(m?.scrollHeight, 0), top = num(m?.scrollTop, 0), view = num(m?.clientHeight, 0);
  return Math.max(0, h - top - view);
}

/** Should the catch-up buttons be visible? */
export function shouldShowJump(m: ScrollMetrics, threshold: number = JUMP_SHOW_PX): boolean {
  return belowFold(m) > Math.max(0, num(threshold, JUMP_SHOW_PX));
}

/** One page down, minus a line of overlap so the reader resumes on a line they have already read rather
 *  than landing on an unfamiliar one. The floor keeps the gesture useful in a short scroller: in a 180px
 *  lane transcript, "one viewport minus a line" is small enough that without a floor the button would
 *  barely move. */
export function pageStep(clientHeight: number, lineHeight: number, minStep = 80): number {
  const view = Math.max(0, num(clientHeight, 0));
  const line = Math.max(0, num(lineHeight, 0));
  return Math.max(view - line - 8, Math.max(1, num(minStep, 80)));
}

/** Where a page-down should land, clamped to the bottom so a smooth scroll never overshoots into the
 *  rubber-band region (which then springs back and reads as a bug). */
export function pageDownTarget(m: ScrollMetrics, lineHeight: number, minStep = 80): number {
  const h = num(m?.scrollHeight, 0);
  const top = num(m?.scrollTop, 0);
  return Math.min(top + pageStep(num(m?.clientHeight, 0), lineHeight, minStep), Math.max(0, h));
}
