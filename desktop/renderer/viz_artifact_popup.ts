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
// request fails or the answer is malformed, it shows only why. It is labeled Untrusted (and Demo sample for the
// ?vizDemo=1 sample). Nothing runs until the user presses Play: then an iframe with sandbox="allow-scripts" (never
// allow-same-origin), no referrer and no permissions loads the engine-served frame, whose own CSP
// (default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline') holds the artifact in a srcdoc child
// (a srcdoc directly under this page would inherit the renderer's script-src 'self' and never run, ADR-0096).
// Keep holds the artifact on its node for this session; Discard drops it here and in the engine.

import { authHeaders } from "./bridge.ts";
import { esc } from "./format.ts";
import { icon } from "./icons.ts";
import { popover } from "./ui.ts";
import { frameAttrs, readVerdict, type ArtifactVerdict, type BuildArtifact } from "./viz_build_model.ts";

async function postJson(path: string, body: unknown): Promise<unknown> {
  try {
    const r = await fetch(path, { method: "POST", headers: authHeaders({ "content-type": "application/json" }), body: JSON.stringify(body) });
    return ((await r.json()) as { data?: unknown } | null)?.data ?? null;
  } catch { return null; }
}

export interface ArtifactPopupState { open: boolean; id: string | null; title: string; demo: boolean; verdict: ArtifactVerdict["state"] | null; reason: string; playing: boolean; sandbox: string | null; src: string | null }

let cur: { a: BuildArtifact; verdict: ArtifactVerdict; close: () => void; node: HTMLElement } | null = null;

/** What the popup shows now (the ?vizDemo=1 probe reads it). */
export function artifactPopupState(): ArtifactPopupState {
  const f = cur?.node.querySelector<HTMLIFrameElement>("iframe[data-viz-art-frame]") ?? null;
  const v = cur?.verdict;
  return {
    open: !!cur, id: cur?.a.id ?? null, title: cur?.a.title ?? "", demo: cur?.a.demo ?? false,
    verdict: v?.state ?? null, reason: v?.state === "blocked" ? v.reason : "",
    playing: !!f, sandbox: f?.getAttribute("sandbox") ?? null, src: f?.getAttribute("src") ?? null,
  };
}

export function closeArtifactPopup(): void { cur?.close(); }

export interface ArtifactPopupDeps {
  /** Keep: hold it on its node for this session. */
  keep(a: BuildArtifact): void;
  /** Discard: the node's build empties. */
  discard(a: BuildArtifact): void;
}

/** Open the popup for `a`, anchored at `anchor` (its chip). The gate runs first; Play stays off unless it passes. */
export function openArtifactPopup(anchor: HTMLElement, a: BuildArtifact, deps: ArtifactPopupDeps): void {
  cur?.close();
  const p = popover(anchor, `<div class="viz-art" data-viz-art>
    <div class="viz-art-h"><b class="viz-art-title">${esc(a.title)}</b><span class="viz-art-tag untrusted" data-tip="Untrusted: an agent built it. It runs sandboxed, with no network and no access to LUCID.">Untrusted</span>${a.demo ? `<span class="viz-art-tag demo">Demo sample</span>` : ""}</div>
    <p class="viz-art-st" data-viz-art-st role="status">Checking it with the security gate...</p>
    <div class="viz-art-stage" data-viz-art-stage><p class="viz-art-ph">Nothing runs until you press Play.</p></div>
    <div class="viz-art-acts">
      <button type="button" class="viz-panel-act" data-viz-art-play disabled>${icon("play", 12)}<span>Play</span></button>
      <button type="button" class="viz-panel-act" data-viz-art-keep disabled>${icon("check", 12)}<span>${a.kept ? "Kept" : "Keep"}</span></button>
      <button type="button" class="viz-panel-act danger" data-viz-art-discard>${icon("trash", 12)}<span>Discard</span></button>
    </div>
  </div>`, () => { if (cur?.node === p.node) cur = null; });
  p.node.classList.add("viz-art-pop");
  const me = { a, verdict: { state: "pending" } as ArtifactVerdict, close: p.close, node: p.node };
  cur = me;
  const st = p.node.querySelector("[data-viz-art-st]") as HTMLElement;
  const play = p.node.querySelector("[data-viz-art-play]") as HTMLButtonElement;
  const keep = p.node.querySelector("[data-viz-art-keep]") as HTMLButtonElement;
  p.node.addEventListener("click", (ev) => {
    const t = ev.target as HTMLElement;
    const v = me.verdict;
    if (t.closest("[data-viz-art-play]") && v.state === "pass") {
      const stage = p.node.querySelector("[data-viz-art-stage]") as HTMLElement;
      const f = document.createElement("iframe");
      for (const [k, val] of Object.entries(frameAttrs(v.frameId, authHeaders()["x-lucid-token"] ?? ""))) f.setAttribute(k, val);
      f.setAttribute("data-viz-art-frame", "");
      f.className = "viz-art-frame";
      stage.replaceChildren(f);
      play.disabled = true;
      p.reposition();
      return;
    }
    if (t.closest("[data-viz-art-keep]") && v.state === "pass") {
      deps.keep(a);
      keep.disabled = true;
      (keep.querySelector("span") as HTMLElement).textContent = "Kept";
      st.textContent = "Kept on this agent for this session.";
      return;
    }
    if (t.closest("[data-viz-art-discard]")) {
      if (v.state === "pass") void postJson("/api/viz/artifact/discard", { id: v.frameId });
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
      st.textContent = "Passed the security gate. It still runs untrusted: sandboxed, no network, no access to LUCID.";
      play.disabled = false;
      keep.disabled = a.kept;
    } else {
      st.textContent = `Not shown: ${v.reason}.`;
      st.classList.add("blocked");
      (p.node.querySelector("[data-viz-art-stage]") as HTMLElement).replaceChildren();
    }
    p.reposition();
  });
}

// ------------------------------------------------------------------------------------------ chips

export interface ArtifactChips {
  /** Show (or replace) the chip over `node`, or remove it (null). */
  set(node: string, a: BuildArtifact | null): void;
  has(node: string): boolean;
  destroy(): void;
}

/** The chips layer inside the stage. `boxOf` is the scene's screenBoxOf (client px); `open` runs on a click. */
export function mountArtifactChips(stage: HTMLElement, boxOf: (id: string) => { x: number; y: number; r: number } | null, open: (node: string, chip: HTMLElement) => void): ArtifactChips {
  const chips = new Map<string, HTMLButtonElement>();
  let raf = 0;
  const place = (): void => {
    raf = 0;
    if (!chips.size) return;
    const s = stage.getBoundingClientRect();
    for (const [id, chip] of chips) {
      const b = boxOf(id);
      chip.hidden = !b;
      if (!b) continue;
      chip.style.transform = `translate(${Math.round(b.x - s.left - chip.offsetWidth / 2)}px, ${Math.round(b.y - s.top - b.r - chip.offsetHeight - 6)}px)`;
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
      if (a) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = `viz-art-chip${a.demo ? " demo" : ""}`;
        chip.dataset.vizArtChip = node;
        chip.setAttribute("aria-label", `Open ${a.title}${a.demo ? " (demo sample)" : ""}, untrusted`);
        chip.innerHTML = `${icon("play", 11)}<span>${esc(a.title)}</span>${a.demo ? `<b class="viz-art-badge">DEMO</b>` : ""}`;
        stage.appendChild(chip);
        chips.set(node, chip);
      }
      if (chips.size && !raf) raf = requestAnimationFrame(place);
    },
    has: (node) => chips.has(node),
    destroy() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      stage.removeEventListener("click", onClick);
      for (const c of chips.values()) c.remove();
      chips.clear();
    },
  };
}
