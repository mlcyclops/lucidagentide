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

// ---------------------------------------------------------------- P-SCROLL.1 (ADR-0405): follow + anchor

/** Within this many px of the bottom the reader counts as "on the newest message". */
export const STICK_PX = 72;

/** P-SCROLL.1: is the chat following new output after this scroll event? Following is the default and
 *  only the READER ends it: a scroll UP that their own input drove (wheel, touch, keys, scrollbar drag)
 *  releases it, and reaching the bottom by any means re-engages it. Content growth, reflow and our own
 *  programmatic writes never release it. The old rule measured the distance to the bottom AFTER new
 *  content had landed, so one fast burst taller than the stick window released the follow on its own
 *  and the chat stopped scrolling while the reader had not touched it. */
export function nextFollow(following: boolean, prevTop: number, m: ScrollMetrics, userDriven: boolean, stickPx: number = STICK_PX): boolean {
  const top = num(m?.scrollTop, 0);
  if (userDriven && top < num(prevTop, top) - 1) return false;
  if (belowFold(m) < Math.max(0, num(stickPx, STICK_PX))) return true;
  return following;
}

/** A scrollable element between an input's target and the chat. `overflowY` is its computed style. */
export interface ScrollBox { scrollTop: number; scrollHeight: number; clientHeight: number; overflowY: string }

/** P-SCROLL.1: does an upward wheel or key that starts inside `chain` (the elements between the target and
 *  the chat, innermost first) move the CHAT? Not when the chat is already at its top, and not when a nested
 *  scroller (an open reasoning block, a tall code block) can still scroll up and absorbs it. Releasing the
 *  follow for an input the chat never saw left it released at the bottom, because no scroll event came. */
export function chatTakesUpScroll(chatTop: number, chain: readonly ScrollBox[]): boolean {
  if (!(num(chatTop, 0) > 0)) return false;
  return !chain.some((n) => num(n.scrollTop, 0) > 0 && num(n.scrollHeight, 0) > num(n.clientHeight, 0) + 1 && /auto|scroll/.test(n.overflowY));
}

/** One rendered message: `key` identifies it across re-renders (role plus its markdown), `top` and
 *  `height` are px in the scroller's content coordinates. */
export interface MsgBox { key: string; top: number; height: number }

/** Where the reader was: the message at the top of the viewport and how far into it they had read. */
export interface ScrollAnchor { key: string; index: number; offset: number }

/** The reading anchor for `scrollTop`: the first message whose bottom edge is still below the viewport
 *  top. Null for an empty thread. */
export function readingAnchor(boxes: readonly MsgBox[], scrollTop: number): ScrollAnchor | null {
  const top = num(scrollTop, 0);
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i]!;
    // Negative when the viewport top sits in the gap (or the thread padding) above this message.
    if (num(b.top, 0) + num(b.height, 0) > top) return { key: b.key, index: i, offset: top - num(b.top, 0) };
  }
  return null;
}

/** The scrollTop that puts the reader back on their anchor, or null when that message is no longer
 *  rendered (a bounded transcript dropped it). A re-render may add or drop messages around it, so the
 *  match is by key, and among equal keys (two "ok" prompts) the one nearest the old index wins. */
export function anchorTop(boxes: readonly MsgBox[], a: ScrollAnchor): number | null {
  let best = -1;
  for (let i = 0; i < boxes.length; i++) {
    if (boxes[i]!.key !== a.key) continue;
    if (best < 0 || Math.abs(i - a.index) < Math.abs(best - a.index)) best = i;
  }
  return best < 0 ? null : Math.max(0, num(boxes[best]!.top, 0) + num(a.offset, 0));
}
