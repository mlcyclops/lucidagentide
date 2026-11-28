// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/viz_ledger.ts - P-VIZ.6 (ADR-0635): the Visualize stage's session ledger (the DOM; the rules live
// in viz_ledger_model.ts, viz_view.ts feeds it).
//
// Collapsed (the default) it is a two-line soft box in the stage's lower right; it zooms in from that corner when
// Visualize opens. It is a button (aria-expanded): a click, Enter or Space pops it up into a small card, zooming out
// of the box: a header (Session ledger, collapse) and a list showing five agents at a time, scrollable for more.
// The card drags by its header anywhere inside the stage, in 2D and 3D alike (it is DOM over the canvas; its pointer
// events never reach the camera), tilting a little with the drag; where it was left is kept (`lucid.viz.ledger.v1`
// in the store mountLedger is given, engine-kept since P-VIZ.PREFS1) and re-clamped when the stage resizes.
// Collapsing (the button, or Esc inside it) zooms it back into the lower-right box wherever it was. A value that
// changed flashes briefly. Reduced motion: no zoom, no tilt, no flash.

import { el } from "./dom.ts";
import { esc } from "./format.ts";
import { icon } from "./icons.ts";
import { tipValue } from "./tip_text.ts";
import { fmtCompact, fmtLocCell, fmtTokCell, type LedgerRow, type LedgerSummary } from "./viz_ledger_model.ts";
import { PERSONAS } from "./viz_model.ts";

const POS_KEY = "lucid.viz.ledger.v1";
/** Kept clear of the stage's edges. */
const EDGE = 8;
const ZOOM_MS = 240;
const TILT_MAX = 8;

export interface LedgerView {
  /** Show the latest rows and summary (cheap while collapsed: only the two lines). */
  paint(rows: readonly LedgerRow[], sum: LedgerSummary): void;
  /** Focus is inside the popped-up card (Esc there collapses it instead of closing Visualize). */
  ownsFocus(): boolean;
  collapse(): void;
  destroy(): void;
}

type Pos = { x: number; y: number };

/** Where the ledger's place persists: viz_prefs_store (P-VIZ.PREFS1, ADR-0697), engine-kept and mirrored locally. */
type PosStore = Pick<Storage, "getItem" | "setItem">;

function loadPos(store: PosStore): Pos | null {
  try {
    const v = JSON.parse(store.getItem(POS_KEY) ?? "null") as Partial<Pos> | null;
    return v && Number.isFinite(v.x) && Number.isFinite(v.y) ? { x: v.x!, y: v.y! } : null;
  } catch { return null; }
}

/** The cells a row shows, and their tooltips: what is compared to decide what flashes. */
interface Cells { name: string; subs: string; tok: string; loc: string; repo: string; nameTip: string; tokTip: string; locTip: string; repoTip: string }

function cellsOf(r: LedgerRow): Cells {
  const kind = r.kind === "hub" ? "Main session" : "Fleet agent";
  const cost = r.cost ? `, $${r.cost.toFixed(2)} so far` : "";
  const tokTip = r.ctx !== null
    ? `Context ${fmtCompact(r.ctx)} measured${r.estSince > 0 ? ` + ${fmtCompact(r.estSince)} est. streamed since` : ""}${cost}.`
    : r.tokens > 0 ? "Estimated from the streamed text (characters / 4). No measured usage reported yet." : "Nothing streamed yet this session.";
  const locTip = `${r.edits} write/edit call${r.edits === 1 ? "" : "s"} counted from their authored code; failed calls are taken back${r.locEst ? ". A preview hit the engine's size cap, so this may undercount" : ""}.`;
  const subs = r.subs ? ` It started ${r.subs} subagent${r.subs === 1 ? "" : "s"} this session; subagents stream no tokens or edits to LUCID, so their work is not in these numbers.` : "";
  return {
    name: r.name, subs: r.subs ? `${r.subs} sub` : "", tok: fmtTokCell(r), loc: fmtLocCell(r), repo: r.folderName || "-",
    nameTip: tipValue(r.name, `${kind}${r.gone ? ", no longer running" : ""}.${subs}`), tokTip: tipValue("Tokens", tokTip), locTip: tipValue("Lines of code", locTip),
    repoTip: tipValue("Repo or folder", r.folder ?? "Not known yet."),
  };
}

const CELL_KEYS = ["tok", "loc", "repo"] as const;

export function mountLedger(stage: HTMLElement, reducedMotion: () => boolean, store: PosStore): LedgerView {
  const root = el(`<div class="viz-ledger" data-viz-ledger>
    <button type="button" class="viz-ledger-pill" data-lg-pill aria-expanded="false" aria-controls="vizLedgerCard"
      data-tip="${esc(tipValue("Session ledger", "Each agent's tokens, lines of code and repo this session. Click to open."))}">
      <span class="viz-ledger-l1" data-lg-l1></span><span class="viz-ledger-l2" data-lg-l2></span>
    </button>
    <section class="viz-ledger-card" id="vizLedgerCard" data-lg-card role="region" aria-label="Session ledger" hidden>
      <div class="viz-ledger-h" data-lg-drag>
        <span class="viz-ledger-grip" aria-hidden="true"></span>
        <b class="viz-ledger-title">Session ledger</b>
        <button type="button" class="viz-ledger-x" data-lg-collapse aria-expanded="true" aria-controls="vizLedgerCard" aria-label="Collapse the ledger"
          data-tip="${esc(tipValue("Collapse (Esc)", "Back to the two-line box in the corner."))}">${icon("chevronDown", 13)}</button>
      </div>
      <div class="viz-ledger-cols" aria-hidden="true"><span>Agent</span><span>Tokens</span><span>LoC</span><span>Repo</span></div>
      <div class="viz-ledger-list" data-lg-list role="list" aria-label="Agents this session" tabindex="0"></div>
      <p class="viz-ledger-empty" data-lg-empty>No activity yet this session</p>
    </section>
  </div>`);
  const q = <T extends HTMLElement>(sel: string): T => root.querySelector(sel) as T;
  const pill = q<HTMLButtonElement>("[data-lg-pill]");
  const l1 = q("[data-lg-l1]"), l2 = q("[data-lg-l2]");
  const card = q("[data-lg-card]"), head = q("[data-lg-drag]"), list = q("[data-lg-list]"), empty = q("[data-lg-empty]");
  stage.appendChild(root);

  let expanded = false;
  let pos = loadPos(store);
  let anim: Animation | null = null;
  let last: { rows: readonly LedgerRow[]; sum: LedgerSummary } | null = null;
  const painted = new Map<string, { node: HTMLElement; cells: Cells }>();
  const motion = (): boolean => !reducedMotion();

  if (motion()) pill.classList.add("zoom-in");
  pill.addEventListener("animationend", () => pill.classList.remove("zoom-in"));

  /** Card top-left (stage px) clamped inside the stage. */
  const clamp = (p: Pos): Pos => {
    const w = stage.clientWidth, h = stage.clientHeight, cw = card.offsetWidth, ch = card.offsetHeight;
    return { x: Math.round(Math.min(Math.max(EDGE, p.x), Math.max(EDGE, w - cw - EDGE))), y: Math.round(Math.min(Math.max(EDGE, p.y), Math.max(EDGE, h - ch - EDGE))) };
  };
  const place = (): void => {
    if (!pos) { card.style.left = card.style.top = ""; card.classList.remove("placed"); return; }
    const p = clamp(pos);
    card.style.left = `${p.x}px`; card.style.top = `${p.y}px`;
    card.classList.add("placed");
  };
  const ro = new ResizeObserver(() => { if (expanded) place(); });
  ro.observe(stage);

  /** Zoom the card between its own box and the pill's (FLIP): `out` shrinks it into the pill. */
  const zoom = (out: boolean, done?: () => void): void => {
    anim?.cancel(); anim = null;
    if (!motion()) { done?.(); return; }
    const c = card.getBoundingClientRect(), p = pill.getBoundingClientRect();
    if (!c.width || !c.height) { done?.(); return; }
    const small = `translate(${p.left - c.left}px, ${p.top - c.top}px) scale(${p.width / c.width}, ${p.height / c.height})`;
    const frames = [{ transform: small, opacity: 0.2 }, { transform: "none", opacity: 1 }];
    anim = card.animate(out ? frames.reverse() : frames, { duration: ZOOM_MS, easing: "cubic-bezier(.2,.8,.2,1)" });
    anim.onfinish = () => { anim = null; done?.(); };
  };

  const expand = (): void => {
    if (expanded) return;
    expanded = true;
    card.hidden = false;
    place();
    painted.clear(); list.textContent = "";
    if (last) paintCard(last.rows, last.sum, false);
    pill.setAttribute("aria-expanded", "true");
    pill.classList.add("away");
    zoom(false);
    q<HTMLElement>("[data-lg-collapse]").focus({ preventScroll: true });
  };

  const collapse = (): void => {
    if (!expanded) return;
    expanded = false;
    const refocus = card.contains(document.activeElement);
    pill.setAttribute("aria-expanded", "false");
    pill.classList.remove("away");
    if (refocus) pill.focus({ preventScroll: true });
    zoom(true, () => { if (!expanded) card.hidden = true; });
  };

  pill.addEventListener("click", expand);
  q("[data-lg-collapse]").addEventListener("click", collapse);
  // Nothing in the ledger reaches the canvas (no camera orbit, pan, zoom or pick from here).
  for (const t of ["pointerdown", "wheel", "dblclick", "contextmenu"] as const) root.addEventListener(t, (e) => e.stopPropagation());

  // ---------------------------------------------------------------------------------------- drag
  let drag: { id: number; dx: number; dy: number; lastX: number; lastT: number } | null = null;
  head.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    const c = card.getBoundingClientRect();
    drag = { id: e.pointerId, dx: e.clientX - c.left, dy: e.clientY - c.top, lastX: e.clientX, lastT: e.timeStamp };
    head.setPointerCapture(e.pointerId);
    card.classList.add("dragging");
  });
  head.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const s = stage.getBoundingClientRect();
    pos = clamp({ x: e.clientX - s.left - drag.dx, y: e.clientY - s.top - drag.dy });
    card.style.left = `${pos.x}px`; card.style.top = `${pos.y}px`;
    card.classList.add("placed");
    if (motion()) {
      const v = (e.clientX - drag.lastX) / Math.max(8, e.timeStamp - drag.lastT); // px per ms
      card.style.setProperty("--lg-ry", `${Math.max(-TILT_MAX, Math.min(TILT_MAX, v * 6)).toFixed(2)}deg`);
    }
    drag.lastX = e.clientX; drag.lastT = e.timeStamp;
  });
  const endDrag = (e: PointerEvent): void => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    card.classList.remove("dragging");
    card.style.removeProperty("--lg-ry");
    if (pos) store.setItem(POS_KEY, JSON.stringify(pos));
  };
  head.addEventListener("pointerup", endDrag);
  head.addEventListener("pointercancel", endDrag);

  // ---------------------------------------------------------------------------------------- paint
  const rowNode = (r: LedgerRow): HTMLElement => {
    const n = el(`<div class="viz-ledger-row" role="listitem">
      <span class="viz-ledger-name"><i aria-hidden="true"></i><span data-c="name"></span><b class="viz-ledger-subs" data-c="subs" hidden></b></span>
      <span class="viz-ledger-num" data-c="tok"></span><span class="viz-ledger-num" data-c="loc"></span><span class="viz-ledger-repo" data-c="repo"></span>
    </div>`);
    n.dataset.id = r.id;
    return n;
  };
  const cell = (n: HTMLElement, k: string): HTMLElement => n.querySelector(`[data-c="${k}"]`) as HTMLElement;

  function paintCard(rows: readonly LedgerRow[], sum: LedgerSummary, flash: boolean): void {
    empty.hidden = !sum.empty;
    list.hidden = rows.length === 0;
    const keep = new Set(rows.map((r) => r.id));
    for (const [id, p] of painted) if (!keep.has(id)) { p.node.remove(); painted.delete(id); }
    let prev: HTMLElement | null = null;
    for (const r of rows) {
      let p = painted.get(r.id);
      const c = cellsOf(r);
      if (!p) { p = { node: rowNode(r), cells: { name: "", subs: "", tok: "", loc: "", repo: "", nameTip: "", tokTip: "", locTip: "", repoTip: "" } }; painted.set(r.id, p); }
      const n = p.node;
      n.classList.toggle("gone", r.gone);
      n.style.setProperty("--viz-c", PERSONAS[r.persona].color);
      if (p.cells.name !== c.name) cell(n, "name").textContent = c.name;
      if (p.cells.subs !== c.subs) { const b = cell(n, "subs"); b.textContent = c.subs; b.hidden = !c.subs; }
      if (p.cells.nameTip !== c.nameTip) cell(n, "name").parentElement!.setAttribute("data-tip", c.nameTip);
      for (const k of CELL_KEYS) {
        const tipKey = `${k}Tip` as const;
        const node = cell(n, k);
        if (p.cells[tipKey] !== c[tipKey]) node.setAttribute("data-tip", c[tipKey]);
        if (p.cells[k] === c[k]) continue;
        const was = p.cells[k];
        node.textContent = c[k];
        if (flash && was && motion()) { node.classList.remove("bump"); void node.offsetWidth; node.classList.add("bump"); }
      }
      n.setAttribute("aria-label", `${c.name}${c.subs ? ` (${c.subs}agents)` : ""}: ${c.tok} tokens, ${c.loc} lines, ${c.repo}`);
      p.cells = c;
      const at: ChildNode | null = prev ? prev.nextSibling : list.firstChild;
      if (at !== n) list.insertBefore(n, at);
      prev = n;
    }
  }
  list.addEventListener("animationend", (e) => (e.target as HTMLElement).classList.remove("bump"));

  return {
    paint(rows, sum) {
      last = { rows, sum };
      if (l1.textContent !== sum.line1) l1.textContent = sum.line1;
      if (l2.textContent !== sum.line2) l2.textContent = sum.line2;
      pill.classList.toggle("empty", sum.empty);
      const label = `Session ledger. ${sum.line1}. ${sum.line2}.`;
      if (pill.getAttribute("aria-label") !== label) pill.setAttribute("aria-label", label);
      if (expanded) paintCard(rows, sum, true);
    },
    ownsFocus: () => expanded && card.contains(document.activeElement),
    collapse,
    destroy() {
      anim?.cancel(); anim = null;
      ro.disconnect();
      root.remove();
    },
  };
}
