// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/preview_chip.ts - P-PREVIEW.CHIP1: the ONE preview chip. Wherever a preview loads behind the
// curtain (preview_curtain.ts decides ready / blank / error) the user sees this same button: one class family (.pchip
// in styles.css), one wording (preview_curtain.chipText), one loading look and one ready look.
//   - The composer: #prevCurtainChip at the chat column's top-right corner (size "full"), beside its "Not now" X.
//   - A fleet lane: floating in the upper-right corner of the lane's transcript (a .pchip-host inside
//     .fleet-out-wrap, absolutely positioned, so it takes no layout space and sits above the lane's own composer,
//     never over it). A narrow card shows the miniature page alone (a container query on the host).
//   - An orbit spoke: the same compact chip floating just above the spoke card's upper-right corner.
//   - Agent Worlds: beside each agent (and Main, the hub) whose preview loads or is ready, kept over its node every
//     animation frame (scene.screenBoxOf) and stacked over the node's artifact chip, with a hover card: the page
//     title and path, Open preview, and the agent's preview snapshots (lane_shots.ts).
// Loading is the composer's look: a miniature page with a scanning shimmer and three dots orbiting it. Ready shows
// the page's own thumbnail when it drew one; a click swings the Preview panel out of the chip (app.ts
// swingOutPreview, hinged by preview_curtain.swingOrigin). Motion follows html[data-pchip-motion] (the perf tier's
// preview_curtain.curtainMotion, set by app.ts) and prefers-reduced-motion.

import { esc } from "./format.ts";
import { icon } from "./icons.ts";
import { laneShots, laneShotsStripHtml, onLaneShots } from "./lane_shots.ts"; // P-LANESHOTS.1: the agent's snapshots
import { chipCardAt, chipStackAt, chipText, type ChipState } from "./preview_curtain.ts";
import { setTip } from "./ui.ts";

export type ChipSize = "full" | "compact";

/** The miniature page: four skeleton lines, the scanning shimmer, three orbiting dots, and the page's thumbnail
 *  once it rendered one. */
const ART = `<span class="pchip-art" aria-hidden="true"><span class="pchip-page"><i></i><i></i><i></i><i></i></span><span class="pchip-scan"></span><span class="pchip-orbit"><b></b><b></b><b></b></span><img class="pchip-thumb" alt="" hidden></span>`;

/** The chip's markup, hidden until painted. `attrs` carries the caller's hooks (an id, a data-* attribute) and
 *  must be trusted markup: escape any value in it. Invariant 11: the two lines are ONE block. */
export function previewChipHtml(size: ChipSize, attrs = ""): string {
  return `<button type="button" class="pchip" data-size="${size}"${attrs ? ` ${attrs}` : ""} hidden>${ART}<span class="pchip-txt"><span class="pchip-k"></span><span class="pchip-name"></span></span><span class="pchip-more" hidden></span></button>`;
}

/** A fleet lane's or an orbit spoke's chip in its floating host. The host spans the corner it floats in and lets
 *  every press through except on the chip itself. */
export function laneChipHostHtml(where: "lane" | "spoke", attrs: string): string {
  return `<div class="pchip-host" data-where="${where}">${previewChipHtml("compact", attrs)}</div>`;
}

/** Paint a chip from its state; null hides it. Unchanged state touches nothing (polls repaint every card).
 *  `tip: false` leaves the tooltip off, for a chip whose hover card says the same. */
export function paintPreviewChip(btn: HTMLElement, v: ChipState | null, opts: { tip?: boolean } = {}): void {
  btn.hidden = !v;
  if (!v) return;
  const t = chipText(v);
  const sig = [v.phase, t.name, v.thumb ?? "", String(v.more ?? 0)].join("\u0001");
  if (btn.dataset.sig === sig) return;
  btn.dataset.sig = sig;
  btn.dataset.phase = v.phase;
  btn.setAttribute("aria-disabled", String(v.phase !== "ready"));
  btn.setAttribute("aria-label", t.aria);
  (btn.querySelector(".pchip-k") as HTMLElement).textContent = t.k;
  (btn.querySelector(".pchip-name") as HTMLElement).textContent = t.name;
  const thumb = btn.querySelector(".pchip-thumb") as HTMLImageElement;
  if (v.phase === "ready" && v.thumb) { if (thumb.getAttribute("src") !== v.thumb) thumb.src = v.thumb; thumb.hidden = false; }
  else { thumb.hidden = true; thumb.removeAttribute("src"); }
  const more = btn.querySelector(".pchip-more") as HTMLElement;
  more.hidden = !v.more;
  more.textContent = v.more ? `+${v.more}` : "";
  if (opts.tip !== false) setTip(btn, t.tipTitle, t.tipDesc);
}

// ── Agent Worlds ────────────────────────────────────────────────────────────────────────────────────

export interface WorldChipDeps {
  /** The node's frame on screen (client px), or null while it is off screen or gone. */
  boxOf: (id: string) => { x: number; y: number; r: number } | null;
  /** Px already standing over the node (its artifact chip plus the gap above it), 0 for none. */
  below: (id: string) => number;
  /** The node's name, for the hover card's snapshot strip. */
  nameOf: (id: string) => string;
  /** A ready chip, its card's Open preview or one of its snapshots asked for the preview. */
  open: (id: string, chip: HTMLElement) => void;
}

export interface WorldChips {
  /** Show, update or (null) remove the chip over node `id` ("main" is the hub). */
  set(id: string, v: ChipState | null): void;
  /** Esc: hide the hover card. True when one was showing. */
  escape(): boolean;
  /** For the real-UI check: every chip, its phase, its box on screen (null while hidden) and its card. */
  probe(): Array<{ id: string; phase: string; box: { x: number; y: number; w: number; h: number } | null; card: boolean }>;
  destroy(): void;
}

/** Hover intent before the card shows, and grace before it hides (the pointer crossing the gap to it). */
const CARD_SHOW_MS = 160;
const CARD_HIDE_MS = 240;

/** The chips layer inside the Visualize stage. Each chip keeps its node every animation frame, like the artifact
 *  chips, and stacks above the node's artifact chip. Hovering a chip (or reaching it with Tab) shows its card. */
export function mountWorldPreviewChips(stage: HTMLElement, deps: WorldChipDeps): WorldChips {
  interface Chip { btn: HTMLButtonElement; v: ChipState; at: { x: number; y: number } | null }
  const chips = new Map<string, Chip>();
  const card = document.createElement("div");
  card.className = "pchip-pop";
  card.setAttribute("role", "dialog");
  card.hidden = true;
  stage.appendChild(card);
  let cardFor: string | null = null;
  let cardSig = "";
  let showTimer = 0, hideTimer = 0, raf = 0;
  /** The last key pressed was Tab: a focus that follows it shows the card; a focus handed back by a script
   *  (closing the Preview panel returns focus here) or a click does not. */
  let tabbing = false;

  const placeOne = (id: string, c: Chip, s: DOMRect): void => {
    const b = deps.boxOf(id);
    c.btn.hidden = !b;
    if (!b) { c.at = null; if (cardFor === id) hideCard(); return; }
    c.at = chipStackAt(b, s, { w: c.btn.offsetWidth, h: c.btn.offsetHeight }, deps.below(id));
    c.btn.style.setProperty("translate", `${c.at.x}px ${c.at.y}px`); // not `transform`: the chip's hover lift and entrance use that
    if (cardFor === id) placeCard(c, s);
  };
  const placeCard = (c: Chip, s: DOMRect): void => {
    if (!c.at) return;
    const p = chipCardAt({ left: c.at.x, top: c.at.y, width: c.btn.offsetWidth, height: c.btn.offsetHeight }, { w: card.offsetWidth, h: card.offsetHeight }, { width: s.width, height: s.height });
    card.style.setProperty("translate", `${p.left}px ${p.top}px`);
  };
  const frame = (): void => {
    raf = 0;
    if (!chips.size) return;
    const s = stage.getBoundingClientRect();
    for (const [id, c] of chips) placeOne(id, c, s);
    raf = requestAnimationFrame(frame);
  };

  const paintCard = (id: string): void => {
    const c = chips.get(id);
    if (!c) return;
    const shots = laneShots(id);
    const name = deps.nameOf(id);
    const sig = [id, c.v.phase, c.v.title ?? "", c.v.label, c.v.path, String(shots.length), String(shots[shots.length - 1]?.at ?? 0), name].join("\u0001");
    if (sig === cardSig) return;
    cardSig = sig;
    const t = chipText(c.v);
    const ready = c.v.phase === "ready";
    card.setAttribute("aria-label", `Preview of ${t.name}`);
    card.innerHTML = `<div class="pchip-pop-id"><b class="pchip-pop-title" title="${esc(t.name)}">${esc(t.name)}</b><span class="pchip-pop-path" title="${esc(c.v.path)}">${esc(c.v.path)}</span></div>`
      + (ready ? "" : `<p class="pchip-pop-note">Preparing the preview. It opens here only if the page renders.</p>`)
      + laneShotsStripHtml(shots, { laneName: name })
      + `<div class="pchip-pop-acts"><button type="button" class="btn-mini ok" data-pchip-open${ready ? "" : " disabled"}>${icon("eye", 12)}<span>Open preview</span></button></div>`;
  };
  const showCard = (id: string): void => {
    window.clearTimeout(showTimer); window.clearTimeout(hideTimer);
    const c = chips.get(id);
    if (!c || c.btn.hidden) return;
    if (cardFor !== id) { cardSig = ""; cardFor = id; }
    paintCard(id);
    card.hidden = false;
    placeCard(c, stage.getBoundingClientRect());
  };
  const hideCard = (): void => {
    window.clearTimeout(showTimer); window.clearTimeout(hideTimer);
    cardFor = null;
    cardSig = "";
    card.hidden = true;
  };
  const later = (id: string | null): void => {
    window.clearTimeout(showTimer); window.clearTimeout(hideTimer);
    if (id) showTimer = window.setTimeout(() => showCard(id), cardFor ? 0 : CARD_SHOW_MS);
    else hideTimer = window.setTimeout(hideCard, CARD_HIDE_MS);
  };
  const chipAt = (t: EventTarget | null): HTMLElement | null => (t instanceof Element ? t.closest<HTMLElement>("[data-viz-preview-chip]") : null);
  const inCard = (t: EventTarget | null): boolean => t instanceof Node && card.contains(t);
  const open = (id: string): void => {
    const c = chips.get(id);
    if (!c || c.v.phase !== "ready") return;
    hideCard();
    deps.open(id, c.btn);
  };

  const onOver = (ev: PointerEvent): void => {
    const chip = chipAt(ev.target);
    if (chip?.dataset.vizPreviewChip) later(chip.dataset.vizPreviewChip);
    else if (inCard(ev.target)) window.clearTimeout(hideTimer);
  };
  const onOut = (ev: PointerEvent): void => {
    const from = chipAt(ev.target)?.dataset.vizPreviewChip ?? (inCard(ev.target) ? cardFor : null);
    if (!from) return;
    const to = ev.relatedTarget;
    if (inCard(to) || chipAt(to)?.dataset.vizPreviewChip === from) return; // still on the chip, or crossing to its card
    later(null);
  };
  const onFocusIn = (ev: FocusEvent): void => {
    const chip = chipAt(ev.target);
    if (chip?.dataset.vizPreviewChip && tabbing) showCard(chip.dataset.vizPreviewChip);
  };
  const onFocusOut = (ev: FocusEvent): void => {
    if (!cardFor) return;
    const to = ev.relatedTarget;
    if (inCard(to) || chipAt(to)?.dataset.vizPreviewChip === cardFor) return;
    later(null);
  };
  const onClick = (ev: MouseEvent): void => {
    const chip = chipAt(ev.target);
    if (chip?.dataset.vizPreviewChip) { open(chip.dataset.vizPreviewChip); return; }
    if (!cardFor || !inCard(ev.target)) return;
    const t = ev.target as Element;
    if (t.closest("[data-pchip-open]:not([disabled]), [data-lane-shot]")) open(cardFor);
  };
  const onKeyTrack = (ev: KeyboardEvent): void => { tabbing = ev.key === "Tab"; };
  const onPointerTrack = (): void => { tabbing = false; };
  stage.addEventListener("pointerover", onOver);
  stage.addEventListener("pointerout", onOut);
  stage.addEventListener("focusin", onFocusIn);
  stage.addEventListener("focusout", onFocusOut);
  stage.addEventListener("click", onClick);
  document.addEventListener("keydown", onKeyTrack, true);
  document.addEventListener("pointerdown", onPointerTrack, true);
  const offShots = onLaneShots((laneId) => { if (laneId === cardFor) paintCard(laneId); });

  return {
    set(id, v) {
      const had = chips.get(id);
      if (!v) {
        if (!had) return;
        had.btn.remove();
        chips.delete(id);
        if (cardFor === id) hideCard();
        return;
      }
      let c = had;
      if (!c) {
        const host = document.createElement("div");
        host.innerHTML = previewChipHtml("compact", `data-viz-preview-chip="${esc(id)}"`);
        const btn = host.firstElementChild as HTMLButtonElement;
        stage.appendChild(btn);
        c = { btn, v, at: null };
        chips.set(id, c);
      }
      c.v = v;
      paintPreviewChip(c.btn, v, { tip: false });
      placeOne(id, c, stage.getBoundingClientRect()); // placed now, so a new chip never flashes at the stage's corner
      if (cardFor === id) paintCard(id);
      if (!raf) raf = requestAnimationFrame(frame);
    },
    escape() {
      if (!cardFor) return false;
      const back = chips.get(cardFor)?.btn;
      const focusInCard = inCard(document.activeElement);
      hideCard();
      if (focusInCard && back && !back.hidden) back.focus({ preventScroll: true });
      return true;
    },
    probe: () => [...chips].map(([id, c]) => {
      const r = c.btn.hidden ? null : c.btn.getBoundingClientRect();
      return { id, phase: c.v.phase, box: r ? { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height } : null, card: cardFor === id };
    }),
    destroy() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      window.clearTimeout(showTimer); window.clearTimeout(hideTimer);
      offShots();
      stage.removeEventListener("pointerover", onOver);
      stage.removeEventListener("pointerout", onOut);
      stage.removeEventListener("focusin", onFocusIn);
      stage.removeEventListener("focusout", onFocusOut);
      stage.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKeyTrack, true);
      document.removeEventListener("pointerdown", onPointerTrack, true);
      for (const c of chips.values()) c.btn.remove();
      chips.clear();
      card.remove();
      cardFor = null;
    },
  };
}
