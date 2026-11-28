// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/viz_artifact_popup.ts - P-WORLDS.BUILD1 (ADR-0653): the artifact chip over a node whose build
// revealed an artifact, and the popup that shows the artifact.
//
// The chip: one button per node with an artifact, kept over the node's frame every animation frame
// (scene.screenBoxOf), hidden while the node is off screen. Clicking it opens the popup (a ui.popover).
//
// The popup NEVER renders before the engine's security gate passed the artifact (POST /api/viz/artifact: shape,
// then the scanner, fail-closed; desktop/viz_artifact_gate.ts). Until then, and for good when it is blocked, the
// request fails or the answer is malformed, it shows only why. Nothing runs until the user presses Play: then an
// iframe with sandbox="allow-scripts" (never allow-same-origin), no referrer and no permissions loads the
// engine-served frame, whose own CSP (default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline')
// holds the artifact in a srcdoc child (a srcdoc directly under this page would inherit the renderer's
// script-src 'self' and never run, ADR-0096). Keep holds the artifact on its node for this session; Discard drops it
// here and in the engine. Closing lets go of the engine's pass too (a reopen asks the gate again).
//
// P-WORLDS.BUILD2: a framed card. The header holds the title and the Untrusted, Sample (a template's ready-made
// sample) and Demo (the ?vizDemo=1 feed) chips and Close; the game area is 16:10 (viz_build_model.fitArtWidth),
// as big as the viewport allows up to ART_DEFAULT_W, and the grip at the end of the action row resizes it (drag or
// arrow keys) within the viewport; the size holds for the session. Play becomes Restart (a fresh frame).
//
// P-PREVIEW.CHIP1: the chip's spot over its node is preview_curtain.chipStackAt, the same rule the node's preview
// chip (preview_chip.ts) stacks above it by; heightOf tells that chip how much room this one takes.

import { authHeaders } from "./bridge.ts";
import { esc } from "./format.ts";
import { icon } from "./icons.ts";
import { chipStackAt } from "./preview_curtain.ts";
import { popover } from "./ui.ts";
import { ART_DEFAULT_W, fitArtWidth, frameAttrs, readVerdict, type ArtifactVerdict, type BuildArtifact } from "./viz_build_model.ts";

async function postJson(path: string, body: unknown): Promise<unknown> {
  try {
    const r = await fetch(path, { method: "POST", headers: authHeaders({ "content-type": "application/json" }), body: JSON.stringify(body) });
    return ((await r.json()) as { data?: unknown } | null)?.data ?? null;
  } catch { return null; }
}

export interface ArtifactPopupState {
  open: boolean; id: string | null; title: string; demo: boolean; sample: boolean; labels: string[];
  verdict: ArtifactVerdict["state"] | null; reason: string; playing: boolean; sandbox: string | null; src: string | null;
  /** The game area (client px), null when the gate blocked it. */
  stage: { x: number; y: number; w: number; h: number } | null;
}

let cur: { a: BuildArtifact; verdict: ArtifactVerdict; close: () => void; node: HTMLElement } | null = null;
/** The game area's width the user chose, for this session. */
let artW = ART_DEFAULT_W;
/** Room kept free around the card (px). */
const EDGE = 12;
/** The grip's arrow keys: px of game width per press. */
const GRIP_STEP: Record<string, number> = { ArrowRight: 40, ArrowUp: 40, ArrowLeft: -40, ArrowDown: -40 };

/** The labels every surface shows for `a`. */
export function artifactLabels(a: Pick<BuildArtifact, "demo" | "sample">): string[] {
  return ["Untrusted", ...(a.sample ? ["Sample"] : []), ...(a.demo ? ["Demo"] : [])];
}

/** What the popup shows now (the ?vizDemo=1 probe reads it). */
export function artifactPopupState(): ArtifactPopupState {
  const f = cur?.node.querySelector<HTMLIFrameElement>("iframe[data-viz-art-frame]") ?? null;
  const s = cur?.node.querySelector<HTMLElement>("[data-viz-art-stage]") ?? null;
  const r = s && s.childElementCount ? s.getBoundingClientRect() : null;
  const v = cur?.verdict;
  return {
    open: !!cur, id: cur?.a.id ?? null, title: cur?.a.title ?? "", demo: cur?.a.demo ?? false, sample: cur?.a.sample ?? false,
    labels: [...(cur?.node.querySelectorAll(".viz-art-tag") ?? [])].map((n) => n.textContent?.trim() ?? ""),
    verdict: v?.state ?? null, reason: v?.state === "blocked" ? v.reason : "",
    playing: !!f, sandbox: f?.getAttribute("sandbox") ?? null, src: f?.getAttribute("src") ?? null,
    stage: r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null,
  };
}

export function closeArtifactPopup(): void { cur?.close(); }

export interface ArtifactPopupDeps {
  /** Keep: hold it on its node for this session. */
  keep(a: BuildArtifact): void;
  /** Discard: the node's build empties (a sample opened from the panel was never on it). */
  discard(a: BuildArtifact): void;
}

const TAG_TIP: Record<string, string> = {
  Untrusted: "Untrusted: it runs sandboxed, with no network and no access to LUCID.",
  Sample: "Sample: a ready-made example of what this mini game template builds, not built by an agent.",
  Demo: "Demo: the ?vizDemo=1 feed put it here. No agent ran.",
};

/** Open the popup for `a`, anchored at `anchor` (its chip, or the node panel's actions). The gate runs first; Play
 *  stays off unless it passes. */
export function openArtifactPopup(anchor: HTMLElement, a: BuildArtifact, deps: ArtifactPopupDeps): void {
  cur?.close();
  const tags = artifactLabels(a).map((t) => `<span class="viz-art-tag ${t.toLowerCase()}" data-tip="${esc(TAG_TIP[t] ?? t)}">${t}</span>`).join("");
  let released = false; // the engine's pass was let go (Discard or close)
  let onWin: (() => void) | null = null;
  const p = popover(anchor, `<div class="viz-art" data-viz-art>
    <div class="viz-art-h">
      <span class="viz-art-ic">${icon("shield", 14)}</span>
      <b class="viz-art-title" title="${esc(a.title)}">${esc(a.title)}</b>
      <span class="viz-art-tags">${tags}</span>
      <button type="button" class="viz-art-x" data-viz-art-close aria-label="Close" data-tip="Close">${icon("close", 14)}</button>
    </div>
    <p class="viz-art-st" data-viz-art-st role="status">Checking it with the security gate...</p>
    <div class="viz-art-stage" data-viz-art-stage><p class="viz-art-ph">Nothing runs until you press Play.</p></div>
    <div class="viz-art-acts">
      <button type="button" class="viz-panel-act" data-viz-art-play disabled>${icon("play", 12)}<span>Play</span></button>
      <button type="button" class="viz-panel-act" data-viz-art-keep disabled>${icon("check", 12)}<span>${a.kept ? "Kept" : "Keep"}</span></button>
      <button type="button" class="viz-panel-act danger" data-viz-art-discard>${icon("trash", 12)}<span>Discard</span></button>
      <button type="button" class="viz-art-grip" data-viz-art-grip aria-label="Resize the game (arrow keys)" data-tip="Drag to resize the game; arrow keys work too"></button>
    </div>
  </div>`, () => {
    if (onWin) window.removeEventListener("resize", onWin);
    if (me.verdict.state === "pass" && !released) { released = true; void postJson("/api/viz/artifact/discard", { id: me.verdict.frameId }); }
    if (cur?.node === p.node) cur = null;
  });
  p.node.classList.add("viz-art-pop");
  const me = { a, verdict: { state: "pending" } as ArtifactVerdict, close: p.close, node: p.node };
  cur = me;
  const st = p.node.querySelector("[data-viz-art-st]") as HTMLElement;
  const stage = p.node.querySelector("[data-viz-art-stage]") as HTMLElement;
  const play = p.node.querySelector("[data-viz-art-play]") as HTMLButtonElement;
  const keep = p.node.querySelector("[data-viz-art-keep]") as HTMLButtonElement;
  const grip = p.node.querySelector("[data-viz-art-grip]") as HTMLButtonElement;

  // The card's width follows the game area's; `room` is what the card may fill (from its left/top while dragging).
  // Layout sizes (offset*), not rects: the card opens with a small scale transform.
  const fit = (want: number, from?: { left: number; top: number }): void => {
    if (!stage.isConnected || !stage.childElementCount) return;
    p.node.style.maxHeight = ""; // the natural height (place caps it again)
    const padX = p.node.offsetWidth - stage.offsetWidth, padY = p.node.offsetHeight - stage.offsetHeight;
    const roomW = (from ? window.innerWidth - EDGE - from.left : window.innerWidth - 2 * EDGE) - padX;
    const roomH = (from ? window.innerHeight - EDGE - from.top : window.innerHeight - 2 * EDGE) - padY;
    p.node.style.width = `${Math.round(fitArtWidth(want, roomW, roomH) + padX)}px`;
  };
  // A game card is too big for the anchored placement (one side of the anchor): below the anchor when it fits,
  // else above, else wherever it fits in the viewport (it may cover the anchor), centered on the anchor across.
  const place = (): void => {
    if (!stage.isConnected || !stage.childElementCount) { p.reposition(); return; }
    p.node.style.maxHeight = "";
    const a = anchor.getBoundingClientRect();
    const w = p.node.offsetWidth, h = p.node.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
    const top = a.bottom + 8 + h <= vh - EDGE ? a.bottom + 8 : a.top - 8 - h >= EDGE ? a.top - 8 - h : (vh - h) / 2;
    p.node.style.left = `${Math.round(Math.max(EDGE, Math.min(vw - EDGE - w, a.left + a.width / 2 - w / 2)))}px`;
    p.node.style.top = `${Math.round(Math.max(EDGE, Math.min(vh - EDGE - h, top)))}px`;
    p.node.style.maxHeight = `${vh - 2 * EDGE}px`; // a very short window: the content scrolls inside the card
  };
  const resize = (want: number): void => { artW = want; fit(artW); place(); artW = stage.offsetWidth || artW; };
  fit(artW);
  place();
  onWin = () => { fit(artW); place(); };
  window.addEventListener("resize", onWin);

  grip.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    grip.setPointerCapture(ev.pointerId);
    const card = p.node.getBoundingClientRect();
    const x0 = ev.clientX, y0 = ev.clientY, w0 = stage.offsetWidth;
    p.node.classList.add("resizing");
    const move = (e: PointerEvent): void => {
      const dx = e.clientX - x0, dy = (e.clientY - y0) * 1.6;
      fit(w0 + (Math.abs(dx) >= Math.abs(dy) ? dx : dy), { left: card.left, top: card.top });
    };
    const up = (): void => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", up);
      p.node.classList.remove("resizing");
      resize(stage.offsetWidth);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
  });
  grip.addEventListener("keydown", (ev) => {
    const step = GRIP_STEP[ev.key];
    if (step) { ev.preventDefault(); resize(stage.offsetWidth + step); }
    else if (ev.key === "Home") { ev.preventDefault(); resize(ART_DEFAULT_W); }
  });

  const startFrame = (frameId: string): void => {
    const f = document.createElement("iframe");
    for (const [k, val] of Object.entries(frameAttrs(frameId, authHeaders()["x-lucid-token"] ?? ""))) f.setAttribute(k, val);
    f.setAttribute("data-viz-art-frame", "");
    f.className = "viz-art-frame";
    stage.replaceChildren(f);
    play.innerHTML = `${icon("refresh", 12)}<span>Restart</span>`;
    play.setAttribute("aria-label", "Restart the game");
    f.focus();
  };
  p.node.addEventListener("click", (ev) => {
    const t = ev.target as HTMLElement;
    const v = me.verdict;
    if (t.closest("[data-viz-art-close]")) { p.close(); return; }
    if (t.closest("[data-viz-art-play]") && v.state === "pass") { startFrame(v.frameId); return; }
    if (t.closest("[data-viz-art-keep]") && v.state === "pass") {
      deps.keep(a);
      keep.disabled = true;
      (keep.querySelector("span") as HTMLElement).textContent = "Kept";
      st.textContent = "Kept on this agent for this session.";
      return;
    }
    if (t.closest("[data-viz-art-discard]")) {
      if (v.state === "pass" && !released) { released = true; void postJson("/api/viz/artifact/discard", { id: v.frameId }); }
      deps.discard(a);
      p.close();
    }
  });
  void postJson("/api/viz/artifact", { html: a.html }).then((data) => {
    const v = readVerdict(data);
    if (cur !== me) { // closed before the gate answered: let go of a pass the engine holds
      if (v.state === "pass") void postJson("/api/viz/artifact/discard", { id: v.frameId });
      return;
    }
    me.verdict = v;
    if (v.state === "pass") {
      st.textContent = a.sample
        ? "Passed the security gate. A ready-made sample: it still runs untrusted, sandboxed, with no network and no access to LUCID."
        : "Passed the security gate. It still runs untrusted: sandboxed, no network, no access to LUCID.";
      play.disabled = false;
      keep.disabled = a.kept;
    } else {
      st.textContent = `Not shown: ${v.reason}.`;
      st.classList.add("blocked");
      stage.replaceChildren();
      grip.hidden = true;
      p.node.style.width = "";
    }
    fit(artW); // the status line may have grown
    place();
  });
}

// ------------------------------------------------------------------------------------------ chips

export interface ArtifactChips {
  /** Show (or replace) the chip over `node`, or remove it (null). */
  set(node: string, a: BuildArtifact | null): void;
  has(node: string): boolean;
  /** The chip's height over `node` (px), 0 when it has none or it is off screen. */
  heightOf(node: string): number;
  /** P-OVERLAP.1: the chip over `node` in stage px as last placed, or null while it has none or is off screen. */
  rectOf(node: string): { left: number; top: number; right: number; bottom: number } | null;
  destroy(): void;
}

/** The chips layer inside the stage. `boxOf` is the scene's screenBoxOf (client px); `open` runs on a click. */
export function mountArtifactChips(stage: HTMLElement, boxOf: (id: string) => { x: number; y: number; r: number } | null, open: (node: string, chip: HTMLElement) => void): ArtifactChips {
  const chips = new Map<string, HTMLButtonElement>();
  const spots = new Map<string, { x: number; y: number }>();
  let raf = 0;
  const place = (): void => {
    raf = 0;
    if (!chips.size) return;
    const s = stage.getBoundingClientRect();
    for (const [id, chip] of chips) {
      const b = boxOf(id);
      chip.hidden = !b;
      if (!b) { spots.delete(id); continue; }
      const at = chipStackAt(b, s, { w: chip.offsetWidth, h: chip.offsetHeight });
      spots.set(id, at);
      chip.style.transform = `translate(${at.x}px, ${at.y}px)`;
    }
    raf = requestAnimationFrame(place);
  };
  const onClick = (ev: Event): void => {
    const chip = (ev.target as HTMLElement).closest<HTMLElement>("[data-viz-art-chip]");
    if (chip?.dataset.vizArtChip) open(chip.dataset.vizArtChip, chip);
  };
  stage.addEventListener("click", onClick);
  return {
    set(node, a) {
      chips.get(node)?.remove();
      chips.delete(node);
      spots.delete(node);
      if (a) {
        const badge = a.demo ? "DEMO SAMPLE" : a.sample ? "SAMPLE" : "";
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = `viz-art-chip${a.demo ? " demo" : ""}`;
        chip.dataset.vizArtChip = node;
        chip.title = a.title;
        chip.setAttribute("aria-label", `Open ${a.title}${badge ? ` (${badge.toLowerCase()})` : ""}, untrusted`);
        chip.innerHTML = `${icon("play", 11)}<span>${esc(a.title)}</span>${badge ? `<b class="viz-art-badge">${badge}</b>` : ""}`;
        stage.appendChild(chip);
        chips.set(node, chip);
      }
      if (chips.size && !raf) raf = requestAnimationFrame(place);
    },
    has: (node) => chips.has(node),
    heightOf(node) {
      const chip = chips.get(node);
      return chip && !chip.hidden ? chip.offsetHeight : 0;
    },
    rectOf(node) {
      const chip = chips.get(node), at = spots.get(node);
      return chip && at && !chip.hidden ? { left: at.x, top: at.y, right: at.x + chip.offsetWidth, bottom: at.y + chip.offsetHeight } : null;
    },
    destroy() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      stage.removeEventListener("click", onClick);
      for (const c of chips.values()) c.remove();
      chips.clear();
      spots.clear();
    },
  };
}
