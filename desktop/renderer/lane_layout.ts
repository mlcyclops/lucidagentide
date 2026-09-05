// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/lane_layout.ts - P-FLEET.L9: the PURE geometry for resizable + reorderable fleet lane
// cards, plus the two dock edges share_dock.ts never grew (n / w and their corners). DOM-free, IO-free and
// global-free so it is unit-tested headless; app.ts owns pointer capture and the CSS grid itself.
//
// Lane cards sit in a CSS grid with `align-self: end`, so every card is BOTTOM-anchored: the TOP edge is the
// grow handle and the composer underneath never shifts while you drag. That one layout choice is why
// `heightFromDrag` inverts dy and why `resizeShape("n")` holds `y + h` fixed. Get the sign wrong and the
// whole panel feels like it is fighting the pointer.
//
// Every entry point is defended against NaN / Infinity / negative input and every persisted payload is
// treated as hostile: a corrupt store yields an EMPTY layout rather than a throw, because a broken
// localStorage value must never brick the fleet panel (same doctrine as share_dock.loadDockState).

import type { DockShape } from "./share_dock.ts";

export interface CardSize { cols: number; h: number }
export interface LaneLayout { order: string[]; size: Record<string, CardSize> }

export const CARD_COL_W = 300;      // one grid track, px
export const CARD_GAP = 10;
export const CARD_MIN_H = 150;
export const CARD_MAX_H = 1200;
export const CARD_MIN_COLS = 1;
export const CARD_MAX_COLS = 6;

/** Coerce anything (a persisted string, a pointer delta off a detached event, undefined) to a usable number.
 *  Non-finite is never propagated: NaN reaching a style property silently blanks the whole rule. */
function num(v: unknown, fallback: number): number { const n = Number(v); return Number.isFinite(n) ? n : fallback; }

function clampInt(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

/** How many tracks fit in a dock body of this width (>= 1 always). */
export function gridCols(bodyW: number, colW: number = CARD_COL_W, gap: number = CARD_GAP): number {
  const w = num(colW, CARD_COL_W);
  const g = Math.max(0, num(gap, CARD_GAP));
  const track = w > 0 ? w : CARD_COL_W;
  // n tracks occupy n*track + (n-1)*gap, so add one gap back before dividing.
  const n = Math.floor((num(bodyW, 0) + g) / (track + g));
  return Math.max(1, Number.isFinite(n) ? n : 1);
}

/** Right-edge drag -> column span. `dx` is px from the drag origin; a drag that has not crossed half a
 *  track does not change the span (no jitter). Clamped to [CARD_MIN_COLS, min(CARD_MAX_COLS, maxCols)]. */
export function colsFromDrag(startCols: number, dx: number, maxCols: number, colW: number = CARD_COL_W): number {
  const w = num(colW, CARD_COL_W);
  const track = w > 0 ? w : CARD_COL_W;
  const hi = Math.max(CARD_MIN_COLS, Math.min(CARD_MAX_COLS, Math.floor(num(maxCols, CARD_MAX_COLS))));
  // Math.round is the half-track deadzone: 149px moves nothing, 150px moves one track.
  const span = num(startCols, CARD_MIN_COLS) + Math.round(num(dx, 0) / track);
  return clampInt(span, CARD_MIN_COLS, hi);
}

/** BOTTOM-edge drag -> height. Dragging DOWN is a POSITIVE dy and INCREASES height, the conventional
 *  window-resize direction: the handle follows the cursor. Clamped to [CARD_MIN_H, CARD_MAX_H].
 *
 *  This was briefly inverted (a TOP-edge handle on bottom-anchored cards, where dragging up grew the
 *  card). That was rejected in use: the bottom-right corner is where a window grip belongs, and cards
 *  read top-down so pinning their tops keeps the list stable while one card grows. Sign pinned by an
 *  exact-equality test because getting it backwards makes the whole gesture feel broken. */
export function heightFromDrag(startH: number, dy: number): number {
  return clampInt(num(startH, CARD_MIN_H) + num(dy, 0), CARD_MIN_H, CARD_MAX_H);
}

export function clampSize(s: CardSize, maxCols: number): CardSize {
  const hi = Math.max(CARD_MIN_COLS, Math.min(CARD_MAX_COLS, Math.floor(num(maxCols, CARD_MAX_COLS))));
  return {
    cols: clampInt(num(s?.cols, CARD_MIN_COLS), CARD_MIN_COLS, hi),
    h: clampInt(num(s?.h, CARD_MIN_H), CARD_MIN_H, CARD_MAX_H),
  };
}

/** Drag-to-snap: given the laid-out card rectangles (viewport px, in `order`) and the pointer, which slot
 *  index should the dragged card land in? Returns the insertion slot in [0, rects.length-1]. The rule is
 *  nearest-center by (row, then column), so a drag across a row boundary snaps to that row. `-1` only when
 *  `rects` is empty. */
export interface CardRect { id: string; x: number; y: number; w: number; h: number }

interface Cell { i: number; top: number; bottom: number; cx: number }

export function snapSlot(rects: readonly CardRect[], x: number, y: number): number {
  if (!rects || rects.length === 0) return -1;
  const px = num(x, 0);
  const py = num(y, 0);

  const cells: Cell[] = [];
  let top = Infinity;
  let bottom = -Infinity;
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    const ry = num(r?.y, 0);
    const rb = ry + Math.max(0, num(r?.h, 0));
    const cx = num(r?.x, 0) + Math.max(0, num(r?.w, 0)) / 2;
    cells.push({ i, top: ry, bottom: rb, cx });
    if (ry < top) top = ry;
    if (rb > bottom) bottom = rb;
  }

  // Dragging clear of the grid is an explicit "make it first" / "make it last", independent of x. That is
  // the list mental model, and it keeps both gestures reachable without hunting for the right column.
  if (py < top) return 0;
  if (py > bottom) return rects.length - 1;

  // TOP-anchored cards in one grid row share a TOP edge, not a bottom: their heights differ, so `y + h`
  // varies within a row while `y` does not. Row identity is therefore `y`. (This keyed on the bottom
  // edge while cards were bottom-anchored; flipping the anchor without flipping this would scatter one
  // visual row across several buckets and snap a drag to a row the user is not pointing at.)
  const rows = new Map<number, Cell[]>();
  for (const c of cells) {
    const key = Math.round(c.top);
    const bucket = rows.get(key);
    if (bucket) bucket.push(c); else rows.set(key, [c]);
  }
  // Iterate the buckets DIRECTLY rather than indexing back through a key array: a `keys[0]` lookup is
  // `number | undefined` under noUncheckedIndexedAccess, and casting that away would hide the one case
  // that actually matters (an empty grid), which the early return above is what really rules out.
  const bands = [...rows.values()].sort((a, b) => (a[0]?.top ?? 0) - (b[0]?.top ?? 0));
  let best: Cell[] = [];
  let bestDist = Infinity;
  for (const row of bands) {
    let rTop = Infinity;
    let rBottom = -Infinity;
    for (const c of row) {
      if (c.top < rTop) rTop = c.top;
      if (c.bottom > rBottom) rBottom = c.bottom;
    }
    const dist = py < rTop ? rTop - py : py > rBottom ? py - rBottom : 0;
    if (dist < bestDist) { bestDist = dist; best = row; }
  }

  // `cells` is non-empty here (the length check above returned early), so a band was always chosen and
  // this fallback is unreachable. It stays because returning a real slot beats a non-null assertion.
  let slot = best[0]?.i ?? 0;
  let bestDx = Infinity;
  for (const c of best) {
    const d = Math.abs(px - c.cx);
    if (d < bestDx) { bestDx = d; slot = c.i; }
  }
  return slot;
}

/** Move `id` to slot `to`. Pure; returns a NEW array. Unknown id or out-of-range slot is a no-op that
 *  returns an equal (but new) array, never a throw and never a silent drop. */
export function reorder(order: readonly string[], id: string, to: number): string[] {
  const next = (order ?? []).slice();
  const from = next.indexOf(id);
  if (from < 0) return next;
  const t = Math.trunc(num(to, -1));
  if (t < 0 || t >= next.length || t === from) return next;
  next.splice(from, 1);
  next.splice(t, 0, id);
  return next;
}

/** Merge the server's lane list into a persisted layout: unknown lanes APPEND in server order, vanished
 *  lanes drop (and their size entry is released), surviving order is preserved. Pure. */
export function reconcile(layout: LaneLayout, laneIds: readonly string[]): LaneLayout {
  const live = new Set<string>();
  for (const id of laneIds ?? []) if (typeof id === "string" && id) live.add(id);

  const order: string[] = [];
  const placed = new Set<string>();
  for (const id of layout?.order ?? []) {
    if (typeof id !== "string" || !live.has(id) || placed.has(id)) continue;
    placed.add(id);
    order.push(id);
  }
  for (const id of laneIds ?? []) {
    if (typeof id !== "string" || !id || placed.has(id)) continue;
    placed.add(id);
    order.push(id);
  }

  // Size entries are keyed by lane, so a vanished lane must release its entry or the store grows forever.
  const size: Record<string, CardSize> = {};
  const src = layout?.size ?? {};
  for (const id of order) {
    const s = src[id];
    if (s) size[id] = { cols: s.cols, h: s.h };
  }
  return { order, size };
}

/** Persistence. A corrupt/absent payload yields an EMPTY layout, never a throw: a broken store must never
 *  brick the panel (same doctrine as loadDockState). Round-trips exactly. */
export function loadLayout(raw: string | null | undefined): LaneLayout {
  const empty: LaneLayout = { order: [], size: {} };
  if (typeof raw !== "string" || raw === "") return empty;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return empty; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return empty;

  const p = parsed as { order?: unknown; size?: unknown };
  // Fail closed on the load-bearing field: an `order` that is not a clean string array makes the WHOLE
  // payload untrustworthy, so it is discarded rather than partially salvaged.
  if (!Array.isArray(p.order)) return empty;
  const order: string[] = [];
  const seen = new Set<string>();
  for (const id of p.order) {
    if (typeof id !== "string" || !id) return empty;
    if (seen.has(id)) continue;
    seen.add(id);
    order.push(id);
  }

  const size: Record<string, CardSize> = {};
  const rawSize = p.size;
  if (rawSize !== undefined && rawSize !== null) {
    if (typeof rawSize !== "object" || Array.isArray(rawSize)) return empty;
    const bag = rawSize as Record<string, unknown>;
    for (const id of order) {
      const s = bag[id];
      if (!s || typeof s !== "object" || Array.isArray(s)) continue;
      const cell = s as { cols?: unknown; h?: unknown };
      // A size we cannot read is DROPPED, not invented: the card falls back to the caller's default rather
      // than to a fabricated number.
      if (!Number.isFinite(Number(cell.cols)) || !Number.isFinite(Number(cell.h))) continue;
      size[id] = clampSize({ cols: Number(cell.cols), h: Number(cell.h) }, CARD_MAX_COLS);
    }
  }
  return { order, size };
}

export function saveLayout(l: LaneLayout): string {
  const order: string[] = [];
  const size: Record<string, CardSize> = {};
  const seen = new Set<string>();
  for (const id of l?.order ?? []) {
    if (typeof id !== "string" || !id || seen.has(id)) continue;
    seen.add(id);
    order.push(id);
    const s = l?.size?.[id];
    if (s) size[id] = clampSize(s, CARD_MAX_COLS);
  }
  // Keys are emitted in `order` sequence, so an unchanged layout always serializes to identical bytes.
  return JSON.stringify({ order, size });
}

/** The dock's missing edges. `dir` is any subset of "n"/"s"/"e"/"w" (e.g. "n", "ne", "se"). A north drag
 *  moves `y` and `h` together so the BOTTOM edge stays put; a west drag does the same for `x`/`w`. Result is
 *  clamped to the given minimums; it does NOT clamp to the viewport (callers pipe it through
 *  share_dock.clampToViewport, which owns that). Pure; returns a NEW shape. */
export function resizeShape(dir: string, start: DockShape, dx: number, dy: number, minW: number, minH: number): DockShape {
  // A non-finite minimum is unusable, so fall back to 1px rather than to 0: a zero-size window is a
  // vanished window, and an unknown bound must never authorize that.
  const mw = Math.max(1, Math.round(num(minW, 1)));
  const mh = Math.max(1, Math.round(num(minH, 1)));
  const sx = Math.round(num(start?.x, 0));
  const sy = Math.round(num(start?.y, 0));
  const sw = Math.max(mw, Math.round(num(start?.w, mw)));
  const sh = Math.max(mh, Math.round(num(start?.h, mh)));
  const base: DockShape = { x: sx, y: sy, w: sw, h: sh };

  const d = typeof dir === "string" ? dir.trim().toLowerCase() : "";
  let n = false, s = false, e = false, w = false, bad = d.length === 0;
  for (const ch of d) {
    if (ch === "n") n = true;
    else if (ch === "s") s = true;
    else if (ch === "e") e = true;
    else if (ch === "w") w = true;
    else bad = true;
  }
  // Fail closed on an unparseable or self-contradictory direction: leave the window exactly where it is.
  if (bad || (n && s) || (e && w)) return base;

  const ddx = num(dx, 0);
  const ddy = num(dy, 0);
  const out: DockShape = { ...base };
  if (e) out.w = Math.max(mw, Math.round(sw + ddx));
  if (s) out.h = Math.max(mh, Math.round(sh + ddy));
  if (w) { out.w = Math.max(mw, Math.round(sw - ddx)); out.x = sx + sw - out.w; }   // right edge invariant
  if (n) { out.h = Math.max(mh, Math.round(sh - ddy)); out.y = sy + sh - out.h; }   // bottom edge invariant
  return out;
}
