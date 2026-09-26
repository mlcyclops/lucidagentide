// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/creator_images.ts - CREATOR-IMG (ADR-0291): the Images pane (pure builders).
//
// Pure HTML only - app.ts owns the canvas work, the fetches, and the preview hand-off. This module owns its
// view types so it never imports bridge.ts (the layering rule) and never imports harness/creator/imaging.ts
// (that one pulls node:zlib for PNG deflate and must stay out of the browser bundle).
//
// The pane is four things stacked: the generator (model dropdown + prompt + a MIXER of input images with
// named roles), the builders (sprite sheet, GIF, meme) that need no provider at all, the artifact grid, and
// one honest line about what is configured.

import { esc } from "./format.ts";
import { icon } from "./icons.ts";

export interface DiscoveredModelView { id: string; kind: string; node: string }
export interface ArtifactView {
  id: string; kind: string; file: string; mime: string; bytes: number; sha256: string;
  createdAt: number; width: number; height: number; source: string; prompt: string; model: string;
  sidecars: readonly string[];
}
/** One image staged as a generation input, with the ROLE the workflow template binds it to. */
export interface MixInputView { role: string; name: string; dataUrl: string }
export interface CreatorImagesView {
  endpoint: string;
  models: readonly DiscoveredModelView[];
  note: string;
  artifacts: readonly ArtifactView[];
  inputs: readonly MixInputView[];
  selected: readonly string[];
  model: string;
  prompt: string;
  negative: string;
  busy: string;
}

export function isArtifactList(v: unknown): v is { artifacts: ArtifactView[] } {
  return !!v && typeof v === "object" && "artifacts" in v && Array.isArray(v.artifacts);
}

const KIND_LABEL: Record<string, string> = {
  image: "generated",
  sheet: "sprite sheet",
  gif: "gif",
  meme: "meme",
  markup: "markup",
};

export function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  const kb = bytes / 1024;
  if (kb < 900) return `${Math.max(1, Math.round(kb))} KB`;
  const mb = kb / 1024;
  return mb >= 10 ? `${Math.round(mb)} MB` : `${Math.round(mb * 10) / 10} MB`;
}

/** The generator: a live model dropdown, the prompt pair, and the image mixer. */
function generatorHtml(v: CreatorImagesView): string {
  const options = v.models.length
    ? v.models.map((m) => `<option value="${esc(m.id)}"${m.id === v.model ? " selected" : ""}>${esc(m.id)}${m.kind === "checkpoint" ? "" : esc(` (${m.kind})`)}</option>`).join("")
    : `<option value="">no models discovered</option>`;
  const mixer = v.inputs.length
    ? v.inputs.map((i, idx) => `<div class="cim-mix" data-mix="${idx}">
        <img class="cim-mix-img" data-mix-src="${idx}" alt="${esc(i.name)}" />
        <span class="cim-mix-name">${esc(i.name)}</span>
        <input class="prov-key cim-mix-role" data-mix-role="${idx}" value="${esc(i.role)}" spellcheck="false"
          data-tip="Role|The workflow template binds this image with {{image:role}}, so the name matters, not the order." />
        <button type="button" class="btn-mini danger" data-mix-drop="${idx}">Remove</button>
      </div>`).join("")
    : `<p class="cim-hint">No input images staged. Paste an image into this pane, or press Use as input on any artifact below, to mix pictures with your prompt.</p>`;
  return `<section class="cim-gen">
    <div class="cim-row">
      <label class="cim-lbl" for="cimModel">Model</label>
      <select id="cimModel" class="prov-key" data-tip="Model|Read live from the ComfyUI install you connected. LUCID never invents a model name.">${options}</select>
      <button type="button" class="btn-mini" data-cim-refresh data-tip="Re-probe|Ask that server for its checkpoints again.">${icon("refresh", 12)}</button>
    </div>
    <textarea id="cimPrompt" class="prov-key cim-prompt" rows="3" placeholder="Describe the image. The workflow template decides where this lands.">${esc(v.prompt)}</textarea>
    <textarea id="cimNegative" class="prov-key cim-prompt" rows="2" placeholder="Negative prompt (optional)">${esc(v.negative)}</textarea>
    <div class="cim-row cim-row-wrap">
      <label class="cim-lbl" for="cimWidth">Size</label>
      <input id="cimWidth" class="prov-key cim-num" value="1024" spellcheck="false" aria-label="width" />
      <input id="cimHeight" class="prov-key cim-num" value="1024" spellcheck="false" aria-label="height" />
      <label class="cim-lbl" for="cimSeed">Seed</label>
      <input id="cimSeed" class="prov-key cim-num" placeholder="random" spellcheck="false" />
      <button type="button" class="btn-mini ok" data-cim-generate${v.busy ? " disabled" : ""}>${v.busy ? esc(v.busy) : "Generate"}</button>
    </div>
    <div class="cim-mixer">${mixer}</div>
  </section>`;
}

/** The provider-free builders. Enabled state is honest: a GIF needs two frames, a meme needs one image. */
function buildersHtml(v: CreatorImagesView): string {
  const n = v.selected.length;
  const need = (min: number) => (n >= min ? "" : " disabled");
  return `<section class="cim-tools">
    <div class="cim-tools-h"><span class="cim-tools-t">${icon("spark", 13)}<span>Build from selection</span></span>
      <span class="cim-count">${esc(n ? `${n} selected` : "select artifacts below")}</span></div>
    <div class="cim-tool-row">
      <button type="button" class="btn-mini" data-cim-sheet${need(2)} data-tip="Sprite sheet|Pack the selected images into one PNG grid with a frame manifest and a ready-to-paste CSS animation.">Sprite sheet</button>
      <button type="button" class="btn-mini" data-cim-gif${need(2)} data-tip="Animated GIF|Encode the selection into a looping GIF89a, in-process. No provider, no key, no network.">GIF</button>
      <button type="button" class="btn-mini" data-cim-meme${need(1)} data-tip="Meme|Top and bottom text, auto-fitted and wrapped over the first selected image.">Meme</button>
      <button type="button" class="btn-mini" data-cim-clear${n ? "" : " disabled"}>Clear selection</button>
    </div>
    <p class="cim-hint">Sheets, GIFs, and memes are encoded inside LUCID, so they keep working with no provider configured and no network at all.</p>
  </section>`;
}

function artifactCardHtml(a: ArtifactView, selected: boolean): string {
  const label = KIND_LABEL[a.kind] ?? a.kind;
  const size = a.width && a.height ? `${a.width}x${a.height}` : fmtBytes(a.bytes);
  return `<div class="cim-card${selected ? " on" : ""}" data-art="${esc(a.id)}">
    <button type="button" class="cim-thumb" data-art-pick="${esc(a.id)}" aria-pressed="${selected ? "true" : "false"}"
      aria-label="${esc(`Select ${label} ${a.id}`)}"><img data-art-src="${esc(a.id)}" alt="" /></button>
    <div class="cim-card-h">
      <span class="cim-card-t">${esc(a.prompt || a.source || label)}</span>
      <span class="cim-kind">${esc(label)}</span>
    </div>
    <div class="cim-card-meta"><span class="cim-dim">${esc(size)}</span>${a.model ? `<span class="cim-model">${esc(a.model)}</span>` : ""}
      <span class="cim-sha" data-tip="Provenance|sha256 ${esc(a.sha256)}">${esc(a.sha256.slice(0, 8))}</span></div>
    <div class="cim-card-acts">
      <button type="button" class="btn-mini" data-art-preview="${esc(a.id)}" data-tip="Open in Preview|Opens in the sandboxed Preview panel, where the markup tools and Screenshot to chat already live.">Preview</button>
      <button type="button" class="btn-mini" data-art-input="${esc(a.id)}" data-tip="Use as input|Stage it as a named input image for the next generation.">Use as input</button>
      ${a.sidecars.length ? `<span class="cim-side" data-tip="Sidecars|${esc(a.sidecars.join(", "))}">${esc(`${a.sidecars.length} sidecar${a.sidecars.length === 1 ? "" : "s"}`)}</span>` : ""}
    </div>
  </div>`;
}

export function artifactGridHtml(v: CreatorImagesView): string {
  if (!v.artifacts.length) {
    return `<p class="cst-empty">No images yet. Generate one through your ComfyUI workflow, or build a sprite sheet, GIF, or meme from images you already have.</p>`;
  }
  const sel = new Set(v.selected);
  return `<div class="cim-grid">${v.artifacts.map((a) => artifactCardHtml(a, sel.has(a.id))).join("")}</div>`;
}

/** The whole pane. `note` is the honest line: which endpoint answered, or what is missing. */
export function creatorImagesHtml(v: CreatorImagesView | null): string {
  if (!v) return `<div class="cim-body"><p class="cst-empty">The image tools could not read their state. Nothing was generated; try Refresh.</p></div>`;
  const status = v.endpoint
    ? `Connected to ${v.endpoint}${v.models.length ? ` - ${v.models.length} model${v.models.length === 1 ? "" : "s"} discovered.` : "."}`
    : "No image provider is connected. The sprite sheet, GIF, and meme builders below still work.";
  return `<div class="cim-body">
    <p class="cim-status">${icon("info", 12)}${esc(v.note || status)}</p>
    ${generatorHtml(v)}
    ${buildersHtml(v)}
    ${artifactGridHtml(v)}
  </div>`;
}
