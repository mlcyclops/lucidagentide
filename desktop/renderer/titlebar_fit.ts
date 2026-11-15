// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/titlebar_fit.ts - P-TITLEBAR.1 (ADR-0603): the titlebar fits a narrow window.
//
// The model badge keeps its whole name on one line and does not shrink; the repo chip gives up room first (CSS:
// it shrinks with an ellipsis down to a minimum). When the bar still does not fit, this folds the optional chips
// (Persona, Skills, Knowledge or Datasets) into one "More" chip, then hides the zoom group (its keyboard
// shortcuts still work), and only then lets the model name end in an ellipsis. Each pass starts from everything
// shown and measures the real layout, so the result depends only on the current width and contents: it cannot
// flap at a boundary.

/** How far the bar is folded: 0 everything shown, 1 optional chips in More, 2 also the zoom group hidden,
 *  3 also the model name may be cut. */
export type FoldLevel = 0 | 1 | 2 | 3;

export interface TitlebarFitParts {
  bar: HTMLElement;
  /** The chips that fold into More. A chip whose `hidden` is set by its owner is never shown or listed. */
  foldable: HTMLElement[];
  more: HTMLElement;
  zoom: HTMLElement | null;
  /** The text that must not be cut while folding can still make room (the model name). Its badge shrinks only at
   *  level 3. */
  keep: HTMLElement;
  /** A chip that may shrink first (its text ends in an ellipsis even at full width, by its own cap). It counts as
   *  squeezed only when the bar has no slack left and it is narrower than `shrinkFloorPx`. */
  shrinkFirst: HTMLElement | null;
  shrinkFloorPx: number;
  spacer: HTMLElement | null;
}

const FOLDED = "tb-folded";
const NO_ZOOM = "tb-fold-zoom";
const CUT_NAME = "tb-fold-name";

const clipped = (e: Element): boolean => e.scrollWidth > e.clientWidth + 1;

/** The next fold level to try, or null after the last. A level that would change nothing (no applicable chip to
 *  fold, no zoom group) is skipped; cutting the model name is always the last resort. PURE. */
export function nextFoldLevel(level: FoldLevel, has: { foldable: number; zoom: boolean }): FoldLevel | null {
  if (level === 0 && has.foldable > 0) return 1;
  if (level < 2 && has.zoom) return 2;
  if (level < 3) return 3;
  return null;
}

/** The chips that apply right now (their owner has not hidden them). */
export function applicableChips(parts: Pick<TitlebarFitParts, "foldable">): HTMLElement[] {
  return parts.foldable.filter((c) => !c.hidden);
}

function apply(parts: TitlebarFitParts, level: FoldLevel): void {
  const folding = level >= 1;
  for (const c of parts.foldable) c.classList.toggle(FOLDED, folding);
  const moreHidden = !folding || applicableChips(parts).length === 0;
  if (parts.more.hidden !== moreHidden) parts.more.hidden = moreHidden; // an unchanged write would re-queue the observer
  parts.bar.classList.toggle(NO_ZOOM, level >= 2);
  parts.bar.classList.toggle(CUT_NAME, level >= 3);
}

/** True when the bar needs the `next` level: it has no slack and something overflows it, or (before the name may
 *  be cut) the shrink-first chip has shrunk below its floor. The name is cut only on a real overflow, i.e. once
 *  the shrink-first chip is at its own CSS minimum. */
function squeezed(parts: TitlebarFitParts, next: FoldLevel): boolean {
  const slack = parts.spacer ? parts.spacer.getBoundingClientRect().width : 1;
  if (slack >= 1) return false;
  if (parts.bar.scrollWidth > parts.bar.clientWidth + 1) return true;
  if (next === 3) return false;
  const s = parts.shrinkFirst;
  return !!s && !s.hidden && s.getBoundingClientRect().width < parts.shrinkFloorPx;
}

/** Fold as little as the current width allows. Synchronous measure-and-apply, so nothing paints between passes. */
export function fitTitlebar(parts: TitlebarFitParts): FoldLevel {
  let level: FoldLevel = 0;
  apply(parts, level);
  const has = { foldable: applicableChips(parts).length, zoom: !!parts.zoom };
  for (let next = nextFoldLevel(level, has); next !== null && squeezed(parts, next); next = nextFoldLevel(level, has)) {
    level = next;
    apply(parts, level);
  }
  return level;
}

/** Refit on every bar resize and whenever anything in the bar is shown, hidden or relabeled (a chip appears, the
 *  model or repo changes). Class changes made by the fit itself are not observed. */
export function installTitlebarFit(parts: TitlebarFitParts): { refit: () => FoldLevel; level: () => FoldLevel } {
  let queued = false;
  let level: FoldLevel = 0;
  const schedule = (): void => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; run(); });
  };
  const mo = new MutationObserver(schedule);
  // The fit's own writes (More shown or hidden while trying levels) are dropped, so a pass never schedules another.
  const run = (): FoldLevel => { level = fitTitlebar(parts); mo.takeRecords(); return level; };
  new ResizeObserver(schedule).observe(parts.bar);
  mo.observe(parts.bar, { attributes: true, attributeFilter: ["hidden"], childList: true, subtree: true, characterData: true });
  run();
  return { refit: run, level: () => level };
}
