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

/** A card's size in PX, both axes. P-FLEET.L12: `w` replaced a `cols` column span.
 *
 *  The span model quantized every width to a 300px track with a half-track deadzone, so the right edge
 *  moved in 300px jumps and a drag under 150px did nothing at all. Reported as "I would like more
 *  adjustable right side handlers, not just snap". Width is now a plain pixel value like height already
 *  was, so the edge tracks the pointer 1:1. */
export interface CardSize { w: number; h: number }
/** P-FLEET.FIT1 (ADR-pending): a lane's share of its AUTOFIT row. `fw` weighs its width against the other
 *  cards in the same row, `fh` weighs its row's height against the other rows. 1 is the equal share; the
 *  absence of an entry means "equal" too, so a layout that never touched autofit carries none. */
export interface FitWeight { fw: number; fh: number }
/** `autofit` and `fit` are OPTIONAL on purpose: a layout saved before P-FLEET.FIT1 has neither, and must
 *  load as autofit ON with equal shares. Only the non-default values are ever written (`autofit:false`,
 *  a non-empty `fit`), so a default layout still serializes to exactly the pre-FIT1 bytes. */
export interface LaneLayout { order: string[]; size: Record<string, CardSize>; autofit?: boolean; fit?: Record<string, FitWeight> }

export const CARD_COL_W = 300;      // the DEFAULT card width, and the legacy track width migrations read
export const CARD_GAP = 10;
export const CARD_MIN_H = 150;
export const CARD_MAX_H = 1200;
/** Narrower than this and the header controls have nowhere to go even wrapped (invariant 11). */
export const CARD_MIN_W = 260;
export const CARD_MAX_W = 2400;
export const CARD_DEF_W = CARD_COL_W;

/** Coerce anything (a persisted string, a pointer delta off a detached event, undefined) to a usable number.
 *  Non-finite is never propagated: NaN reaching a style property silently blanks the whole rule. */
function num(v: unknown, fallback: number): number { const n = Number(v); return Number.isFinite(n) ? n : fallback; }

function clampInt(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

/** The widest a card may be right now: the panel body it lives in, never less than one minimum card.
 *  Every width clamp measures against THIS, so a card can never persist wider than the panel that holds
 *  it (which the span model guaranteed via the track count, and px has to state explicitly).
 *
 *  An UNMEASURABLE body (0, negative, NaN, Infinity) falls back to the hard maximum, deliberately NOT to
 *  the minimum. `getBoundingClientRect().width` is 0 while the panel is hidden or has not laid out yet, so
 *  clamping down there would rewrite every card the user had sized to 260px on the strength of one bad
 *  measurement. Being briefly too permissive costs nothing: `.fleet-card` carries `max-width:100%` and a
 *  shrinkable flex basis, so an over-wide card gives way visually and the next real measurement re-clamps
 *  it. Losing the user's sizes is not recoverable. */
export function maxCardW(bodyW: number): number {
  const body = num(bodyW, 0);
  if (!(body > 0)) return CARD_MAX_W; // 0 / negative / NaN / -Infinity all mean "not measured"
  return Math.max(CARD_MIN_W, Math.min(CARD_MAX_W, Math.floor(body)));
}

/** The width an UNSIZED card (one the user has never dragged) takes: the panel tiled into as many
 *  default-width columns as fit, each column sharing the slack. Without this the card's flex basis was
 *  `auto`, i.e. its max-content width, so one long code line or URL in a transcript made a fresh lane as
 *  wide as the whole panel and pushed every other card to the next row (reported as "massive
 *  horizontally"). Three default cards and two gaps fit a 1180px body, so each takes 386px; a 700px body
 *  tiles two at 345px; a body narrower than one default card becomes one full-width column.
 *  Unmeasured (0 / NaN) falls back to the default width rather than the minimum, for the same reason
 *  maxCardW does. */
export function defaultCardW(bodyW: number): number {
  const body = num(bodyW, 0);
  if (!(body > 0)) return CARD_DEF_W;
  const cols = Math.max(1, Math.floor((body + CARD_GAP) / (CARD_DEF_W + CARD_GAP)));
  // Floored, never rounded: a half-pixel up on each of three columns is a row that no longer fits.
  return clampInt(Math.floor((body - CARD_GAP * (cols - 1)) / cols), CARD_MIN_W, maxCardW(body));
}

/** Right-edge drag -> width in PX. `dx` is px from the drag origin and moves the edge 1:1: no track, no
 *  deadzone, no rounding to a span. Clamped to [CARD_MIN_W, min(CARD_MAX_W, maxW)]. */
export function widthFromDrag(startW: number, dx: number, maxW: number): number {
  return clampInt(num(startW, CARD_DEF_W) + num(dx, 0), CARD_MIN_W, maxCardW(maxW));
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

export function clampSize(s: CardSize, maxW: number): CardSize {
  return {
    w: clampInt(num(s?.w, CARD_DEF_W), CARD_MIN_W, maxCardW(maxW)),
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
    if (s) size[id] = { w: s.w, h: s.h };
  }
  // P-FLEET.FIT1: the mode survives, and fit shares are released with their lane exactly like sizes.
  return withFit({ order, size }, layout?.autofit, layout?.fit, order);
}

/** Attach the optional P-FLEET.FIT1 fields: `autofit` only when explicitly OFF, `fit` only when some lane
 *  holds a non-equal share. Shared by reconcile / loadLayout / saveLayout so the three cannot disagree on
 *  what "default" means. Entries are copied (never aliased), clamped, and kept only for lanes in `order`. */
function withFit(base: LaneLayout, autofit: unknown, fit: unknown, order: readonly string[]): LaneLayout {
  const out: LaneLayout = base;
  if (autofit === false) out.autofit = false;
  if (fit && typeof fit === "object" && !Array.isArray(fit)) {
    const bag = fit as Record<string, unknown>;
    // Built through fromEntries, never `kept[id] = w`: a stored lane id is untrusted, and `__proto__` as
    // an assignment target would set the prototype instead of an own entry (CodeQL remote-property-injection).
    const kept: [string, FitWeight][] = [];
    for (const id of order) {
      const w = Object.hasOwn(bag, id) ? fitWeight(bag[id]) : null;
      if (w) kept.push([id, w]);
    }
    if (kept.length) out.fit = Object.fromEntries(kept);
  }
  return out;
}

/** A persisted share, or null when it is unreadable or exactly equal (equal is what absence already means). */
function fitWeight(v: unknown): FitWeight | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const c = v as { fw?: unknown; fh?: unknown };
  const fw = clampWeight(c.fw);
  const fh = clampWeight(c.fh);
  return fw === 1 && fh === 1 ? null : { fw, fh };
}

/** Persistence. A corrupt/absent payload yields an EMPTY layout, never a throw: a broken store must never
 *  brick the panel (same doctrine as loadDockState). Round-trips exactly. */
export function loadLayout(raw: string | null | undefined): LaneLayout {
  const empty: LaneLayout = { order: [], size: {} };
  if (typeof raw !== "string" || raw === "") return empty;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return empty; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return empty;

  const p = parsed as { order?: unknown; size?: unknown; autofit?: unknown; fit?: unknown };
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

  // Collected as entries and built with Object.fromEntries, so a stored lane id can never write the prototype
  // (the same rule as the autofit shares, CodeQL js/remote-property-injection).
  const sizes: [string, CardSize][] = [];
  const rawSize = p.size;
  if (rawSize !== undefined && rawSize !== null) {
    if (typeof rawSize !== "object" || Array.isArray(rawSize)) return empty;
    const bag = rawSize as Record<string, unknown>;
    for (const id of order) {
      const s = bag[id];
      if (!s || typeof s !== "object" || Array.isArray(s)) continue;
      const cell = s as { w?: unknown; cols?: unknown; h?: unknown };
      const h = Number(cell.h);
      if (!Number.isFinite(h)) continue; // a size we cannot read is DROPPED, never invented
      // P-FLEET.L12 MIGRATION: a layout persisted before widths were px carries `cols` (a 300px track
      // span). Converting it beats discarding it, because dropping the entry would silently reset every
      // card the user had already sized. n tracks occupied n*300 + (n-1)*10, so the gaps come back too.
      const w = Number.isFinite(Number(cell.w))
        ? Number(cell.w)
        : Number.isFinite(Number(cell.cols))
          ? Number(cell.cols) * CARD_COL_W + Math.max(0, Number(cell.cols) - 1) * CARD_GAP
          : Number.NaN;
      if (!Number.isFinite(w)) continue;
      sizes.push([id, clampSize({ w, h }, CARD_MAX_W)]);
    }
  }
  const size: Record<string, CardSize> = Object.fromEntries(sizes);
  // P-FLEET.FIT1: a payload from before autofit has no `autofit` key and loads as ON; a malformed `fit`
  // only loses the shares (equal is a safe answer), never the order or sizes beside it.
  return withFit({ order, size }, p.autofit, p.fit, order);
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
    if (s) size[id] = clampSize(s, CARD_MAX_W);
  }
  // Keys are emitted in `order` sequence, so an unchanged layout always serializes to identical bytes.
  // P-FLEET.FIT1: the optional fields go through the same normalizer as load, so save(load(x)) is stable.
  return JSON.stringify(withFit({ order, size }, l?.autofit, l?.fit, order));
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

// ------------------------------------------------------------------ P-FLEET.FIT1: autofit tiling
//
// P-FLEET.FIT1 (ADR-pending): the DEFAULT fleet layout. Instead of tile-width cards with content height
// (which left most of a tall dock empty and wrapped a fourth lane onto a half-empty row), the visible lanes
// tile the WHOLE grid body in both axes. The grid shape (cols x rows) is chosen per panel aspect; within
// that shape every row fills the panel's width and the rows fill its height. A user drag re-weights one
// card (or one row) and the OTHER members share what is left equally, so the panel stays full.

/** The smallest tile autofit will lay out before it stops filling the panel and scrolls instead. Wider
 *  than CARD_MIN_W because a TILED card must show a usable transcript and composer, not just a header. */
export const FIT_MIN_W = 320;
export const FIT_MIN_H = 260;
/** The tile shape autofit prefers (w / h). Transcripts read in lines, so a slightly wide card wins a tie. */
export const FIT_ASPECT = 1.4;
/** Score cost of one empty grid cell. Not dead space (the last row's cards stretch across it) but an
 *  uneven row, so a full grid beats a ragged one unless the ragged one's tiles are a far better shape. */
const FIT_EMPTY_COST = 0.35;
/** Persisted shares are clamped here: one card can be 100x another, never 0 wide and never NaN. */
export const FIT_WEIGHT_MIN = 0.1;
export const FIT_WEIGHT_MAX = 10;

/** `cardW`/`cardH` are the EQUAL tile size; `scroll` is true when even that could not fit at FIT_MIN_*
 *  and the tiles overflow the panel (the body scrolls, the tiles stay equal). */
export interface FitGrid { cols: number; rows: number; cardW: number; cardH: number; scroll: boolean }
/** One lane's tile in px, and the plan row it landed in. */
export interface FitCell { w: number; h: number; row: number }
/** The whole tiling: lane ids per visual row, each row's card widths and height, and a per-lane lookup. */
export interface FitPlan { grid: FitGrid; rows: string[][]; rowW: number[][]; rowH: number[]; cells: Record<string, FitCell> }

/** Shares are stored rounded to 3 places, so clamp(clamp(x)) === clamp(x) and save/load is byte-stable.
 *  Unreadable or non-positive means "no opinion", i.e. the equal share. */
function clampWeight(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.round(Math.max(FIT_WEIGHT_MIN, Math.min(FIT_WEIGHT_MAX, n)) * 1000) / 1000;
}

function sum(xs: readonly number[]): number { let t = 0; for (const x of xs) t += x; return t; }

/** The autofit grid for `n` lanes in a `w` x `h` px body. Null when there is nothing to tile or the body
 *  is unmeasured (0 / NaN while hidden or minimized): the caller keeps its last plan rather than collapse
 *  every card on one bad measurement, the same doctrine as maxCardW. */
export function autofitGrid(n: number, w: number, h: number): FitGrid | null {
  return autofitSections([num(n, 0)], w, h);
}

/** autofitGrid for a grid split into SECTIONS (P-FLEET.L18 lane groups): each section starts a fresh row,
 *  so rows = sum of ceil(count / cols). Every column count from 1 to the largest section is scored; a shape
 *  is feasible only when its tiles reach FIT_MIN_W x FIT_MIN_H. Among feasible shapes the winner is the one
 *  whose tiles are closest to FIT_ASPECT (log distance, so 2x too wide and 2x too tall cost the same) plus
 *  FIT_EMPTY_COST per empty cell; ties keep the fewer columns. Nothing feasible: as many FIT_MIN_W columns
 *  as the width holds, tiles at least FIT_MIN_H tall, and the body scrolls. */
export function autofitSections(counts: readonly number[], w: number, h: number): FitGrid | null {
  const secs = (counts ?? []).map((c) => Math.trunc(num(c, 0))).filter((c) => c > 0);
  const W = Math.floor(num(w, 0));
  const H = Math.floor(num(h, 0));
  if (secs.length === 0 || !(W > 0) || !(H > 0)) return null;
  const n = sum(secs);
  const widest = Math.max(...secs);
  const rowsFor = (cols: number): number => secs.reduce((a, c) => a + Math.ceil(c / cols), 0);
  // Floored, never rounded: a half-pixel up per tile is a row that no longer fits (defaultCardW's rule).
  const cellW = (cols: number): number => Math.floor((W - CARD_GAP * (cols - 1)) / cols);
  const cellH = (rows: number): number => Math.floor((H - CARD_GAP * (rows - 1)) / rows);

  let best: FitGrid | null = null;
  let bestScore = Infinity;
  for (let cols = 1; cols <= widest; cols++) {
    const rows = rowsFor(cols);
    const cw = cellW(cols);
    const ch = cellH(rows);
    if (cw < FIT_MIN_W || ch < FIT_MIN_H) continue;
    const score = Math.abs(Math.log(cw / ch / FIT_ASPECT)) + FIT_EMPTY_COST * (rows * cols - n);
    if (score < bestScore) { bestScore = score; best = { cols, rows, cardW: cw, cardH: ch, scroll: false }; }
  }
  if (best) return best;

  const cols = Math.max(1, Math.min(widest, Math.floor((W + CARD_GAP) / (FIT_MIN_W + CARD_GAP))));
  const rows = rowsFor(cols);
  const cardW = Math.max(1, cellW(cols));
  const cardH = Math.max(FIT_MIN_H, cellH(rows));
  return { cols, rows, cardW, cardH, scroll: rows * cardH + CARD_GAP * (rows - 1) > H };
}

/** Split `total` px across members in proportion to `weights`, honoring a per-member minimum, in WHOLE
 *  px that sum to exactly `total` (a row that sums one px over wraps its last card; one px under is a
 *  visible seam). A member whose share falls under `min` is pinned there and the rest re-split; when
 *  `min * k` cannot fit at all, the minimum degrades to the equal floor rather than overflow. */
export function distribute(total: number, weights: readonly number[], min: number): number[] {
  const k = weights?.length ?? 0;
  if (k === 0) return [];
  const T = Math.max(0, Math.floor(num(total, 0)));
  const ws = weights.map(clampWeight);
  const lo = Math.min(Math.max(0, Math.floor(num(min, 0))), Math.floor(T / k));
  const pinned = new Array<boolean>(k).fill(false);
  const raw = new Array<number>(k).fill(0);
  // Terminates: every pass pins at least one member or stops, and since lo <= T/k the free members' sum
  // (`rem`) is always >= lo * free, so at least one member can never pin.
  for (;;) {
    let rem = T;
    let sw = 0;
    for (let i = 0; i < k; i++) { if (pinned[i]) rem -= lo; else sw += ws[i]!; }
    let changed = false;
    for (let i = 0; i < k; i++) {
      if (pinned[i]) { raw[i] = lo; continue; }
      raw[i] = (rem * ws[i]!) / sw;
      if (raw[i]! < lo) { pinned[i] = true; changed = true; }
    }
    if (!changed) break;
  }
  const out = raw.map((v) => Math.floor(v));
  let left = T - sum(out);
  // The leftover is the free members' summed fractions, so it is < their count: one pass hands it out.
  for (let i = 0; i < k && left > 0; i++) { if (!pinned[i]) { out[i] = out[i]! + 1; left--; } }
  return out;
}

/** The full tiling for the visible lanes. `sections` is the grid's group sections in display order (one
 *  section when there are no groups); each is chunked into rows of `grid.cols`. Every row's widths fill
 *  `w` exactly (gaps included) and, unless the grid scrolls, the rows' heights fill `h` exactly. `fit`
 *  re-weights: a lane's `fw` against its row-mates, its row's mean `fh` against the other rows. Null when
 *  autofitSections is null (nothing to tile / unmeasured). Duplicate or junk ids are skipped. */
export function autofitPlan(sections: readonly (readonly string[])[], w: number, h: number, fit?: Record<string, FitWeight>): FitPlan | null {
  const seen = new Set<string>();
  const secs: string[][] = [];
  for (const s of sections ?? []) {
    const ids: string[] = [];
    for (const id of s ?? []) {
      if (typeof id !== "string" || !id || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
    if (ids.length) secs.push(ids);
  }
  const grid = autofitSections(secs.map((s) => s.length), w, h);
  if (!grid) return null;
  const rows: string[][] = [];
  for (const s of secs) for (let i = 0; i < s.length; i += grid.cols) rows.push(s.slice(i, i + grid.cols));

  const W = Math.floor(num(w, 0));
  const rowW = rows.map((r) => distribute(W - CARD_GAP * (r.length - 1), r.map((id) => clampWeight(fit?.[id]?.fw)), CARD_MIN_W));
  const totalH = grid.scroll ? grid.cardH * rows.length : Math.floor(num(h, 0)) - CARD_GAP * (rows.length - 1);
  const rowH = distribute(totalH, rows.map((r) => sum(r.map((id) => clampWeight(fit?.[id]?.fh))) / r.length), CARD_MIN_H);

  const cells: Record<string, FitCell> = {};
  rows.forEach((r, ri) => r.forEach((id, ci) => { cells[id] = { w: rowW[ri]![ci]!, h: rowH[ri]!, row: ri }; }));
  return { grid, rows, rowW, rowH, cells };
}

/** P-FLEET.FIT1 "auto fit and equally resize": member `idx` of a run that must keep its total (one row's
 *  widths, or the rows' heights) takes `next` px, clamped so every OTHER member keeps `min`, and the others
 *  share what is left EQUALLY. Fewer than two members, or a bad index, returns the sizes unchanged: there
 *  is no sibling to give way, so a lone card already fills its row. Pure; whole px; total preserved. */
export function shareResize(sizes: readonly number[], idx: number, next: number, min: number): number[] {
  const s = (sizes ?? []).map((v) => Math.max(0, Math.floor(num(v, 0))));
  const k = s.length;
  const i = Math.trunc(num(idx, -1));
  if (k < 2 || i < 0 || i >= k) return s;
  const total = sum(s);
  const lo = Math.min(Math.max(0, Math.floor(num(min, 0))), Math.floor(total / k));
  const mine = clampInt(num(next, s[i]!), lo, total - lo * (k - 1));
  const rest = distribute(total - mine, new Array<number>(k - 1).fill(1), lo);
  return s.map((_, j) => (j === i ? mine : rest[j < i ? j : j - 1]!));
}

/** px sizes -> the mean-1 shares FitWeight stores (an equal run is all 1s). Shares, not px, are persisted
 *  so a drag made in a 900px dock still means "this card gets twice its neighbour" in a 1600px one. */
export function sharesOf(sizes: readonly number[]): number[] {
  const k = sizes?.length ?? 0;
  const total = sum((sizes ?? []).map((v) => Math.max(0, num(v, 0))));
  if (k === 0 || !(total > 0)) return (sizes ?? []).map(() => 1);
  return sizes.map((v) => clampWeight((Math.max(0, num(v, 0)) * k) / total));
}

/** Autofit is the DEFAULT: only an explicit `autofit:false` turns it off. */
export function isAutofit(l: LaneLayout | null | undefined): boolean { return l?.autofit !== false; }
