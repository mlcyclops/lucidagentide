// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/design_view.ts - the Design pane's markup.
//
// Two kinds of builder, on purpose:
//   * HTML strings for the chrome (toolbars, options, DGX panel): only this module's own fixed words and
//     numbers reach them, escaped anyway.
//   * DOM builders (createElement + textContent) for everything that shows file- or model-derived text:
//     layer names, model labels, hint labels, agent request params, the document name, status lines. No
//     such string ever passes through innerHTML.
// Invariant 11: every row label is its own nowrap + ellipsis element in a min-width:0 row.

import { esc } from "./format.ts";
import { icon } from "./icons.ts";
import type { CuiVerdictView } from "./creator_studio.ts";
import type { DesignDoc, Ease, Layer, MaskHint } from "../../harness/creator/design/types.ts";
import { BLEND_MODES, HINT_INTENTS } from "../../harness/creator/design/types.ts";
import { brushToSlider, layerRows } from "./design_logic.ts";

export type DesignMode = "image" | "vector" | "motion";
export type DesignTool =
  | "move" | "brush" | "eraser" | "wand" | "crop"
  | "select" | "pen" | "rect" | "ellipse" | "line" | "freehand" | "text" | "node";
export type ExportKind = "png" | "gif" | "apng" | "svg" | "svg-animated" | "psd" | "psb" | "layers" | "hyperframes" | "design";

export const MODE_TOOLS: Record<DesignMode, DesignTool[]> = {
  image: ["move", "brush", "eraser", "wand", "crop"],
  vector: ["select", "pen", "rect", "ellipse", "line", "freehand", "text", "node"],
  motion: ["move"],
};

const TOOL_INFO: Record<DesignTool, { label: string; ic: string; key: string; tip: string }> = {
  move: { label: "Move", ic: "move", key: "V", tip: "Move|Drag the selected layer. In Motion mode with Auto-key on, a drag writes x/y keyframes at the playhead." },
  brush: { label: "Brush mask", ic: "pen", key: "B", tip: "Brush mask tracer|Paint the region you mean. [ and ] or Shift+wheel change the size; hold Alt to subtract." },
  eraser: { label: "Eraser", ic: "minus", key: "E", tip: "Eraser|Remove coverage from the mask being traced." },
  wand: { label: "Magic wand", ic: "spark", key: "W", tip: "Magic wand|Click a color region of the selected layer; Alt subtracts from the mask." },
  crop: { label: "Crop", ic: "square", key: "C", tip: "Crop|Drag the new canvas rectangle, then Apply. Pixels outside stay in their layers." },
  select: { label: "Select", ic: "move", key: "V", tip: "Select|Click a shape to select it, drag to move it, Delete removes it." },
  pen: { label: "Pen", ic: "pen", key: "P", tip: "Pen|Click for corners, drag for curve handles, click the first point to close, Enter to finish, Esc to cancel." },
  rect: { label: "Rectangle", ic: "square", key: "R", tip: "Rectangle|Drag to draw." },
  ellipse: { label: "Ellipse", ic: "center", key: "O", tip: "Ellipse|Drag to draw." },
  line: { label: "Line", ic: "minus", key: "L", tip: "Line|Drag to draw a straight stroke." },
  freehand: { label: "Freehand", ic: "markup", key: "F", tip: "Freehand|Draw with the pointer: an ink outline, or a smooth fitted curve." },
  text: { label: "Text", ic: "textT", key: "T", tip: "Text|Click to place text. System font families only; no font is loaded." },
  node: { label: "Nodes", ic: "graph", key: "N", tip: "Node edit|Drag anchors and curve handles of the selected shape." },
};

export const TOOL_BY_KEY: Record<string, DesignTool> = { v: "move", b: "brush", e: "eraser", w: "wand", c: "crop", p: "pen", r: "rect", o: "ellipse", l: "line", f: "freehand", t: "text", n: "node" };

export const EXPORT_LABEL: Record<ExportKind, string> = {
  png: "PNG", gif: "Animated GIF", apng: "APNG", svg: "SVG (static)", "svg-animated": "SVG (animated, CSS keyframes)",
  psd: "PSD", psb: "PSB (large)", layers: "Layer PNGs", hyperframes: "HyperFrames MP4", design: "Design file (JSON)",
};

export interface DgxView { verdict: CuiVerdictView | null; endpointId: string; reason: string }

export interface BarView {
  hasDoc: boolean; mode: DesignMode; zoom: number; canUndo: boolean; canRedo: boolean; undoLabel: string; redoLabel: string;
  busy: boolean; workerMode: "worker" | "main-thread"; docSize: string; historyMb: number;
}

const btn = (attr: string, label: string, opts: { ic?: string; dis?: boolean; tip?: string; cls?: string } = {}) =>
  `<button type="button" class="btn-mini${opts.cls ? ` ${opts.cls}` : ""}" ${attr}${opts.dis ? " disabled" : ""}${opts.tip ? ` data-tip="${esc(opts.tip)}"` : ""}>${opts.ic ? icon(opts.ic, 12) + " " : ""}${esc(label)}</button>`;

export function designBarHtml(v: BarView): string {
  const dis = !v.hasDoc || v.busy;
  const mode = (m: DesignMode, label: string) => `<button type="button" class="cmk-tool${v.mode === m ? " on" : ""}" data-dsn-mode="${m}"><span>${esc(label)}</span></button>`;
  return `<div class="cmk-bar-row">
      ${btn("data-dsn-new", "New", { ic: "plus", dis: v.busy, cls: "ok" })}
      ${btn("data-dsn-open", "Open image", { ic: "folder", dis: v.busy, tip: "Open image|PNG, JPEG, GIF (first frame), WebP or BMP. The header is checked against the decode budget before any pixel is decoded. PSD import is not supported this phase." })}
      ${btn("data-dsn-place", "Place image", { dis: dis, tip: "Place image|Adds an image as a new layer." })}
      ${btn("data-dsn-svg", "Import SVG", { dis: v.busy, tip: "Import SVG|Sanitized with DOMPurify, parsed inert, converted to editable shapes. Scripts, styles, images, links and animations are dropped." })}
      <span class="cmk-file" data-dsn-docname></span>
      <span class="cmk-count">${esc(v.docSize)}</span>
      <span class="cmk-count" data-tip="${esc(v.workerMode === "worker" ? "Heavy work|Runs in the design worker; the UI stays responsive." : "Heavy work|The design worker did not start; heavy work runs on the main thread.")}">${esc(v.workerMode === "worker" ? "worker" : "main thread")}</span>
    </div>
    <div class="cmk-bar-row cmk-bar-wrap">
      <div class="cmk-tools">${mode("image", "Image")}${mode("vector", "Vector")}${mode("motion", "Motion")}</div>
      <span class="cmk-sep"></span>
      ${btn("data-dsn-undo", "Undo", { dis: !v.canUndo || v.busy, tip: v.undoLabel ? `Undo|${v.undoLabel}` : "Undo|Nothing to undo." })}
      ${btn("data-dsn-redo", "Redo", { dis: !v.canRedo || v.busy, tip: v.redoLabel ? `Redo|${v.redoLabel}` : "Redo|Nothing to redo." })}
      <span class="cmk-pageno" data-tip="Undo history|Pixel undo is capped by bytes; the oldest steps drop first.">${esc(`${v.historyMb} MB`)}</span>
      <span class="cmk-sep"></span>
      ${btn("data-dsn-zoom-out", "", { ic: "minus", dis: !v.hasDoc })}
      <span class="cmk-pageno">${esc(`${v.zoom >= 1 ? Math.round(v.zoom * 100) : Math.round(v.zoom * 1000) / 10}%`)}</span>
      ${btn("data-dsn-zoom-in", "", { ic: "plus", dis: !v.hasDoc })}
      ${btn("data-dsn-fit", "Fit", { dis: !v.hasDoc })}
      ${btn("data-dsn-100", "100%", { dis: !v.hasDoc })}
    </div>
    <p class="cpl-status" data-dsn-status></p>`;
}

export function toolsHtml(mode: DesignMode, tool: DesignTool, hasDoc: boolean): string {
  return MODE_TOOLS[mode].map((t) => {
    const d = TOOL_INFO[t];
    return `<button type="button" class="cmk-tool${tool === t ? " on" : ""}" data-dsn-tool="${t}" data-tip="${esc(`${d.tip.split("|")[0]} (${d.key})|${d.tip.split("|")[1] ?? ""}`)}"${hasDoc ? "" : " disabled"}>${icon(d.ic, 13)}<span>${esc(d.label)}</span></button>`;
  }).join("");
}

export interface OptionsView {
  mode: DesignMode; tool: DesignTool; hasDoc: boolean; busy: boolean;
  brushSize: number; hardness: number; brushMode: "add" | "subtract"; tint: string; tintAlpha: number; showMask: boolean; hasMask: boolean;
  wandTolerance: number; wandContiguous: boolean;
  crop: { w: number; h: number } | null;
  docW: number; docH: number; keepAspect: boolean;
  hasRaster: boolean; hasVector: boolean; hasShape: boolean;
  fill: string; fillNone: boolean; stroke: string; strokeNone: boolean; strokeWidth: number; paintOpacity: number;
  textFamily: string; textSize: number; freehandMode: "ink" | "smooth";
  autoKey: boolean; traceColors: number;
}

const range = (attr: string, min: number, max: number, step: number, value: number, dis: boolean) =>
  `<input type="range" class="dsn-range" ${attr} min="${min}" max="${max}" step="${step}" value="${value}"${dis ? " disabled" : ""} />`;

export function optionsHtml(v: OptionsView): string {
  const dis = !v.hasDoc || v.busy;
  const parts: string[] = [];
  if (v.tool === "brush" || v.tool === "eraser") {
    parts.push(`<div class="dsn-sec-title">Brush mask tracer</div>
      <label class="dsn-row"><span class="dsn-lbl">Size</span>${range("data-dsn-brush-size", 0, 1000, 1, brushToSlider(v.brushSize), dis)}<span class="dsn-val" data-dsn-brush-val>${esc(`${v.brushSize} px`)}</span></label>
      <label class="dsn-row"><span class="dsn-lbl">Hardness</span>${range("data-dsn-hardness", 0, 100, 1, Math.round(v.hardness * 100), dis)}<span class="dsn-val">${esc(`${Math.round(v.hardness * 100)}%`)}</span></label>
      <div class="dsn-row"><span class="dsn-lbl">Mode</span>
        <button type="button" class="cmk-tool${v.brushMode === "add" ? " on" : ""}" data-dsn-brush-mode="add"${dis ? " disabled" : ""}><span>Add</span></button>
        <button type="button" class="cmk-tool${v.brushMode === "subtract" ? " on" : ""}" data-dsn-brush-mode="subtract"${dis ? " disabled" : ""}><span>Subtract (Alt)</span></button></div>
      <label class="dsn-row"><span class="dsn-lbl">Overlay</span><input type="color" data-dsn-tint value="${esc(v.tint)}"${dis ? " disabled" : ""} />${range("data-dsn-tint-alpha", 5, 100, 1, Math.round(v.tintAlpha * 100), dis)}</label>
      <label class="dsn-row"><input type="checkbox" data-dsn-show-mask${v.showMask ? " checked" : ""}${dis ? " disabled" : ""} /><span class="dsn-lbl-wide">Show mask overlay</span></label>
      <div class="dsn-row">${btn("data-dsn-new-mask", "New mask", { dis, tip: "New mask|Start tracing a fresh region; the current one stays with its hint." })}${btn("data-dsn-clear-mask", "Clear mask", { dis: dis || !v.hasMask })}</div>`);
  }
  if (v.tool === "wand") {
    parts.push(`<div class="dsn-sec-title">Magic wand</div>
      <label class="dsn-row"><span class="dsn-lbl">Tolerance</span>${range("data-dsn-wand-tol", 0, 255, 1, v.wandTolerance, dis)}<span class="dsn-val">${esc(String(v.wandTolerance))}</span></label>
      <label class="dsn-row"><input type="checkbox" data-dsn-wand-contig${v.wandContiguous ? " checked" : ""}${dis ? " disabled" : ""} /><span class="dsn-lbl-wide">Contiguous</span></label>
      <p class="dsn-note">Click a region of the selected raster layer. The selection is added to the mask being traced (Alt subtracts).</p>`);
  }
  if (v.tool === "crop") {
    parts.push(`<div class="dsn-sec-title">Crop</div>
      <p class="dsn-note">${esc(v.crop ? `Crop to ${Math.round(v.crop.w)} x ${Math.round(v.crop.h)} px.` : "Drag the new canvas rectangle on the image.")}</p>
      <div class="dsn-row">${btn("data-dsn-crop-apply", "Apply crop", { dis: dis || !v.crop, cls: "ok" })}${btn("data-dsn-crop-cancel", "Cancel", { dis: !v.crop })}</div>`);
  }
  if (v.mode === "image") {
    parts.push(`<div class="dsn-sec-title">Image</div>
      <div class="dsn-row"><span class="dsn-lbl">Size</span><input class="prov-key dsn-num" type="number" min="1" max="65535" data-dsn-resize-w value="${v.docW}"${dis ? " disabled" : ""} /><span class="dsn-x">x</span><input class="prov-key dsn-num" type="number" min="1" max="65535" data-dsn-resize-h value="${v.docH}"${dis ? " disabled" : ""} /></div>
      <label class="dsn-row"><input type="checkbox" data-dsn-keep-aspect${v.keepAspect ? " checked" : ""}${dis ? " disabled" : ""} /><span class="dsn-lbl-wide">Keep aspect</span></label>
      <div class="dsn-row">${btn("data-dsn-resize", "Resize (Lanczos3)", { dis, tip: "Resize|Every raster layer and mask is resampled with Lanczos-3 in the worker; vectors scale exactly." })}</div>
      <div class="dsn-row">${btn("data-dsn-layer-from-mask", "New layer from mask", { dis: dis || !v.hasMask || !v.hasRaster })}</div>
      <div class="dsn-row"><span class="dsn-lbl">Colors</span><input class="prov-key dsn-num" type="number" min="2" max="64" data-dsn-trace-colors value="${v.traceColors}"${dis ? " disabled" : ""} />${btn("data-dsn-trace", "Trace to vector", { dis: dis || !v.hasRaster, tip: "Trace to vector|On-device raster to vector of the selected layer (layered color quantization, contours, curve fit)." })}</div>`);
  }
  if (v.mode === "vector") {
    parts.push(`<div class="dsn-sec-title">Paint</div>
      <label class="dsn-row"><span class="dsn-lbl">Fill</span><input type="color" data-dsn-fill value="${esc(v.fill)}"${dis ? " disabled" : ""} /><input type="checkbox" data-dsn-fill-none${v.fillNone ? " checked" : ""}${dis ? " disabled" : ""} /><span class="dsn-lbl-wide">none</span></label>
      <label class="dsn-row"><span class="dsn-lbl">Stroke</span><input type="color" data-dsn-stroke value="${esc(v.stroke)}"${dis ? " disabled" : ""} /><input type="checkbox" data-dsn-stroke-none${v.strokeNone ? " checked" : ""}${dis ? " disabled" : ""} /><span class="dsn-lbl-wide">none</span></label>
      <label class="dsn-row"><span class="dsn-lbl">Width</span><input class="prov-key dsn-num" type="number" min="0" max="500" step="0.5" data-dsn-stroke-width value="${v.strokeWidth}"${dis ? " disabled" : ""} /></label>
      <label class="dsn-row"><span class="dsn-lbl">Opacity</span>${range("data-dsn-paint-opacity", 0, 100, 1, Math.round(v.paintOpacity * 100), dis)}</label>
      <label class="dsn-row"><span class="dsn-lbl">Text</span><select class="prov-key" data-dsn-text-family${dis ? " disabled" : ""}>${["sans-serif", "serif", "monospace"].map((f) => `<option value="${f}"${v.textFamily === f ? " selected" : ""}>${f}</option>`).join("")}</select><input class="prov-key dsn-num" type="number" min="4" max="2000" data-dsn-text-size value="${v.textSize}"${dis ? " disabled" : ""} /></label>
      <label class="dsn-row"><span class="dsn-lbl">Freehand</span><select class="prov-key" data-dsn-freehand${dis ? " disabled" : ""}><option value="ink"${v.freehandMode === "ink" ? " selected" : ""}>Ink outline</option><option value="smooth"${v.freehandMode === "smooth" ? " selected" : ""}>Smooth curve</option></select></label>
      <div class="dsn-row">${btn("data-dsn-new-vector", "New vector layer", { dis })}${btn("data-dsn-delete-shape", "Delete shape", { dis: dis || !v.hasShape, cls: "danger" })}</div>`);
  }
  if (v.mode === "motion") {
    parts.push(`<div class="dsn-sec-title">Motion</div>
      <label class="dsn-row"><input type="checkbox" data-dsn-autokey${v.autoKey ? " checked" : ""}${dis ? " disabled" : ""} /><span class="dsn-lbl-wide">Auto-key moves at the playhead</span></label>
      <p class="dsn-note">Click a track lane to add a keyframe with the layer's current value; drag a key to retime it.</p>`);
  }
  return parts.join("");
}

export function dgxHtml(v: DgxView, o: { hasDoc: boolean; busy: boolean; hasMask: boolean; hasRaster: boolean; upscale: number }): string {
  const allowed = !!v.verdict?.allowed;
  const reason = !v.verdict ? (v.reason || "dgx-vision is not declared on this engine.") : !v.verdict.allowed ? `Refused under CUI lockdown: ${v.verdict.reason}` : "";
  const dis = (extra: boolean) => !allowed || !o.hasDoc || o.busy || extra;
  const tip = (what: string) => (reason ? `${what}|${reason}` : `${what}|Sends the pixels to the dgx-vision service (posture ${v.verdict?.posture ?? "unknown"}).`);
  return `<div class="dsn-sec-title">DGX vision</div>
    <p class="dsn-note${allowed ? "" : " dsn-refused"}" data-dsn-dgx-reason></p>
    <div class="dsn-btn-grid">
      ${btn("data-dsn-dgx-decompose", "Decompose", { dis: dis(false), tip: tip("Decompose into layers") })}
      ${btn("data-dsn-dgx-matte", "Remove background", { dis: dis(!o.hasRaster), tip: tip("Remove background") })}
      ${btn("data-dsn-dgx-refine", "Refine mask", { dis: dis(!o.hasMask), tip: tip("Refine mask") })}
      ${btn("data-dsn-dgx-label", "Label layers", { dis: dis(false), tip: tip("Label layers") })}
      ${btn("data-dsn-dgx-vectorize", "Vectorize", { dis: dis(!o.hasRaster), tip: tip("Vectorize") })}
      <div class="dsn-split">
        <select class="prov-key" aria-label="Upscale factor" data-dsn-upscale-scale${dis(false) ? " disabled" : ""}>${[2, 4, 8].map((s) => `<option value="${s}"${o.upscale === s ? " selected" : ""}>${s}x</option>`).join("")}</select>
        ${btn("data-dsn-dgx-upscale", "Upscale", { dis: dis(!o.hasRaster), tip: tip("AI upscale") })}
      </div>
    </div>`;
}

/** The refusal or posture line, set via textContent (the reason text comes from the server). */
export function dgxReasonText(v: DgxView): string {
  if (!v.verdict) return v.reason || "dgx-vision is not declared on this engine.";
  if (!v.verdict.allowed) return `Refused under CUI lockdown: ${v.verdict.reason}`;
  return v.endpointId
    ? `dgx-vision allowed (${v.verdict.posture}), endpoint ${v.endpointId}.`
    : `dgx-vision allowed (${v.verdict.posture}); no endpoint is declared, so the engine uses its default.`;
}

export interface ExportView { kind: ExportKind; hasDoc: boolean; busy: boolean; fps: number; dither: string; palette: string; maxSide: number; loop: boolean }

export function exportHtml(v: ExportView): string {
  const dis = !v.hasDoc || v.busy;
  const kinds = (Object.keys(EXPORT_LABEL) as ExportKind[]).map((k) => `<option value="${k}"${v.kind === k ? " selected" : ""}>${esc(EXPORT_LABEL[k])}</option>`).join("");
  const anim = v.kind === "gif" || v.kind === "apng";
  return `<div class="dsn-sec-title">Export</div>
    <div class="dsn-row"><select class="prov-key dsn-grow" data-dsn-export-kind${dis ? " disabled" : ""}>${kinds}</select></div>
    ${anim ? `<div class="dsn-row"><span class="dsn-lbl">Max side</span><input class="prov-key dsn-num" type="number" min="16" max="4096" data-dsn-export-max value="${v.maxSide}"${dis ? " disabled" : ""} /></div>` : ""}
    ${v.kind === "gif" ? `<div class="dsn-row"><span class="dsn-lbl">Dither</span><select class="prov-key" data-dsn-gif-dither${dis ? " disabled" : ""}>${["floyd-steinberg", "bayer4", "none"].map((d) => `<option value="${d}"${v.dither === d ? " selected" : ""}>${d}</option>`).join("")}</select></div>
      <div class="dsn-row"><span class="dsn-lbl">Palette</span><select class="prov-key" data-dsn-gif-palette${dis ? " disabled" : ""}>${["global", "per-frame"].map((d) => `<option value="${d}"${v.palette === d ? " selected" : ""}>${d}</option>`).join("")}</select></div>` : ""}
    ${anim ? `<p class="dsn-note">${esc(`${v.fps} fps from the timeline; ${v.loop ? "loops forever" : "plays once"}.`)}</p>` : ""}
    <div class="dsn-row">${btn("data-dsn-export", v.busy ? "Export (busy)" : "Export", { ic: "download", dis: !v.hasDoc, cls: "ok", tip: "Export|Stored in the Creator library through the engine (magic bytes and SVG safety checked) and downloaded here." })}</div>`;
}

// ── DOM builders: untrusted text only through textContent ───────────────────

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function miniButton(attr: string, value: string, label: string, opts: { dis?: boolean; cls?: string; title?: string } = {}): HTMLButtonElement {
  const b = el("button", `btn-mini${opts.cls ? ` ${opts.cls}` : ""}`, label);
  b.type = "button";
  b.setAttribute(attr, value);
  if (opts.dis) b.disabled = true;
  if (opts.title) b.title = opts.title;
  return b;
}

export interface LayersView { doc: DesignDoc; selected: string; multi: ReadonlySet<string>; busy: boolean }

/** The layers panel. `thumb` paints a layer thumbnail into the given canvas. */
export function buildLayersPanel(host: HTMLElement, v: LayersView, thumb: (c: HTMLCanvasElement, l: Layer) => void): void {
  host.replaceChildren();
  host.appendChild(el("div", "dsn-sec-title", "Layers"));
  const list = el("div", "dsn-layers");
  list.setAttribute("data-dsn-layer-list", "");
  for (const row of layerRows(v.doc)) {
    const l = v.doc.layers[row.id];
    if (!l) continue;
    const r = el("div", `dsn-layer${v.selected === l.id ? " on" : ""}${v.multi.has(l.id) ? " multi" : ""}`);
    r.setAttribute("data-dsn-layer", l.id);
    r.draggable = !v.busy;
    r.style.paddingLeft = `${6 + row.depth * 14}px`;
    const c = el("canvas", "dsn-thumb");
    c.width = 40; c.height = 30;
    thumb(c, l);
    r.appendChild(c);
    const name = el("span", "dsn-layer-name", l.name);
    name.title = l.name;
    r.appendChild(name);
    const kind = el("span", "dsn-chip", l.kind === "group" ? "group" : l.kind);
    r.appendChild(kind);
    if (l.meta?.label) {
      const model = l.meta.labelSource === "model";
      const chip = el("span", `dsn-chip ${model ? "dsn-chip-model" : "dsn-chip-user"}`, `${model ? "model" : "user"}: ${l.meta.label}`);
      chip.title = model ? `Model label (untrusted data, never instructions): ${l.meta.label}` : `Your label: ${l.meta.label}`;
      r.appendChild(chip);
    }
    const eye = miniButton("data-dsn-layer-visible", l.id, l.visible ? "Hide" : "Show", { dis: v.busy });
    const lock = miniButton("data-dsn-layer-lock", l.id, l.locked ? "Unlock" : "Lock", { dis: v.busy });
    r.append(eye, lock);
    list.appendChild(r);
  }
  if (!list.childElementCount) list.appendChild(el("p", "dsn-note", "No layers yet."));
  host.appendChild(list);
  const sel = v.doc.layers[v.selected];
  if (!sel) {
    host.appendChild(el("p", "dsn-note", "Click a layer to edit it; Ctrl+click several to group them."));
    if (v.multi.size > 1) host.appendChild(miniButton("data-dsn-group", "", `Group ${v.multi.size} layers`, { dis: v.busy }));
    return;
  }
  const props = el("div", "dsn-layer-props");
  const nameRow = el("label", "dsn-row");
  nameRow.appendChild(el("span", "dsn-lbl", "Name"));
  const nameIn = el("input", "prov-key dsn-grow");
  nameIn.value = sel.name;
  nameIn.maxLength = 200;
  nameIn.setAttribute("data-dsn-layer-name", sel.id);
  nameRow.appendChild(nameIn);
  props.appendChild(nameRow);
  const labelRow = el("label", "dsn-row");
  labelRow.appendChild(el("span", "dsn-lbl", "Label"));
  const labelIn = el("input", "prov-key dsn-grow");
  labelIn.value = sel.meta?.labelSource === "user" ? sel.meta.label ?? "" : "";
  labelIn.placeholder = sel.meta?.labelSource === "model" ? "Replace the model label with your own" : "Your label for agents";
  labelIn.maxLength = 200;
  labelIn.setAttribute("data-dsn-layer-label", sel.id);
  labelRow.appendChild(labelIn);
  props.appendChild(labelRow);
  const opRow = el("label", "dsn-row");
  opRow.appendChild(el("span", "dsn-lbl", "Opacity"));
  const op = el("input", "dsn-range");
  op.type = "range"; op.min = "0"; op.max = "100"; op.value = String(Math.round(sel.opacity * 100));
  op.setAttribute("data-dsn-layer-opacity", sel.id);
  opRow.appendChild(op);
  opRow.appendChild(el("span", "dsn-val", `${Math.round(sel.opacity * 100)}%`));
  props.appendChild(opRow);
  const blRow = el("label", "dsn-row");
  blRow.appendChild(el("span", "dsn-lbl", "Blend"));
  const bl = el("select", "prov-key");
  for (const m of BLEND_MODES) { const o = el("option", undefined, m); o.value = m; o.selected = sel.blend === m; bl.appendChild(o); }
  bl.setAttribute("data-dsn-layer-blend", sel.id);
  blRow.appendChild(bl);
  props.appendChild(blRow);
  const actions = el("div", "dsn-row dsn-wrap");
  actions.append(
    miniButton("data-dsn-layer-up", sel.id, "Up", { dis: v.busy }),
    miniButton("data-dsn-layer-down", sel.id, "Down", { dis: v.busy }),
    ...(v.multi.size > 1 ? [miniButton("data-dsn-group", "", `Group ${v.multi.size}`, { dis: v.busy })] : []),
    ...(sel.kind === "group" ? [miniButton("data-dsn-ungroup", sel.id, "Ungroup", { dis: v.busy })] : []),
    miniButton("data-dsn-layer-delete", sel.id, "Delete", { dis: v.busy, cls: "danger" }),
  );
  props.appendChild(actions);
  host.appendChild(props);
}

export interface HintsView { hints: readonly MaskHint[]; pending: boolean; label: string; intent: MaskHint["intent"]; busy: boolean; dgxAllowed: boolean; activeMaskId: string }

export function buildHintsPanel(host: HTMLElement, v: HintsView): void {
  host.replaceChildren();
  host.appendChild(el("div", "dsn-sec-title", "Hints for agents"));
  if (v.pending) {
    const form = el("div", "dsn-hint-form");
    form.appendChild(el("p", "dsn-note", "Name what you traced. Agents read this label and intent as your instruction."));
    const labelIn = el("input", "prov-key dsn-grow");
    labelIn.placeholder = "e.g. the red car";
    labelIn.maxLength = 200;
    labelIn.value = v.label;
    labelIn.setAttribute("data-dsn-hint-label", "");
    const intent = el("select", "prov-key");
    for (const i of HINT_INTENTS) { const o = el("option", undefined, i); o.value = i; o.selected = v.intent === i; intent.appendChild(o); }
    intent.setAttribute("data-dsn-hint-intent", "");
    const row = el("div", "dsn-row");
    row.append(labelIn, intent);
    form.appendChild(row);
    const actions = el("div", "dsn-row");
    actions.append(
      miniButton("data-dsn-hint-create", "", "Create hint", { dis: v.busy, cls: "ok" }),
      miniButton("data-dsn-hint-refine-pending", "", "Refine with DGX", { dis: v.busy || !v.dgxAllowed }),
      miniButton("data-dsn-hint-discard", "", "Discard trace", { dis: v.busy }),
    );
    form.appendChild(actions);
    host.appendChild(form);
  }
  if (!v.hints.length) { host.appendChild(el("p", "dsn-note", "Trace a region with the brush to create a hint.")); return; }
  const list = el("div", "dsn-hints");
  for (const h of v.hints) {
    const r = el("div", `dsn-hint${h.maskId === v.activeMaskId ? " on" : ""}`);
    r.setAttribute("data-dsn-hint", h.id);
    const label = el("span", "dsn-layer-name", h.label || "(no label)");
    label.title = h.label;
    r.append(label, el("span", "dsn-chip", h.intent), el("span", "dsn-chip", `${Math.round(h.area)} px`));
    r.append(
      miniButton("data-dsn-hint-show", h.id, "Show", { dis: v.busy }),
      miniButton("data-dsn-hint-refine", h.id, "Refine", { dis: v.busy || !v.dgxAllowed, title: "Refine this hint's mask with dgx-vision" }),
      miniButton("data-dsn-hint-delete", h.id, "Delete", { dis: v.busy, cls: "danger" }),
    );
    list.appendChild(r);
  }
  host.appendChild(list);
}

export interface RequestView { key: string; kind: string; target?: string; params?: Record<string, number | string | boolean> }

/** Agent-requested pixel work waiting for the user's Allow. Params are agent text: textContent only. */
export function buildRequestsPanel(host: HTMLElement, reqs: readonly RequestView[], busy: boolean): void {
  host.replaceChildren();
  if (!reqs.length) { host.hidden = true; return; }
  host.hidden = false;
  host.appendChild(el("div", "dsn-sec-title", "Agent requests"));
  host.appendChild(el("p", "dsn-note", "An agent asked for pixel work. Nothing runs until you allow it."));
  for (const r of reqs) {
    const row = el("div", "dsn-request");
    const params = r.params ? Object.entries(r.params).slice(0, 8).map(([k, v]) => `${k}=${String(v)}`).join(", ") : "";
    const text = el("span", "dsn-layer-name", `${r.kind}${r.target ? ` on ${r.target}` : ""}${params ? ` (${params})` : ""}`);
    text.title = text.textContent ?? "";
    row.append(text, miniButton("data-dsn-req-allow", r.key, "Allow", { dis: busy, cls: "ok" }), miniButton("data-dsn-req-dismiss", r.key, "Dismiss", { dis: busy }));
    host.appendChild(row);
  }
}

export const easeLabel = (e: Ease): string => (typeof e === "string" ? e : "cubic-bezier");

/** The pane shell. Bars and panels are painted by the controller; the stage hosts the canvases. */
export function creatorDesignHtml(): string {
  return `<div class="dsn-pane" data-dsn-root>
    <p class="cim-status">${icon("shield", 13)}Fully on-device editing: pixels stay in this window. Only the DGX buttons send an image, to the dgx-vision service, when the CUI policy allows it. Agents read your hints and the layer list, and may only request pixel work you allow.</p>
    <div class="cmk-bar" data-dsn-bar></div>
    <input type="file" hidden accept="image/png,image/jpeg,image/gif,image/webp,image/bmp,.psd,.psb" data-dsn-file />
    <input type="file" hidden accept="image/png,image/jpeg,image/gif,image/webp,image/bmp" data-dsn-place-file />
    <input type="file" hidden accept=".svg,image/svg+xml" data-dsn-svg-file />
    <div class="dsn-body">
      <div class="dsn-tools cmk-tools" data-dsn-tools></div>
      <div class="dsn-stage" data-dsn-stage tabindex="0">
        <canvas class="dsn-canvas" data-dsn-canvas></canvas>
        <canvas class="dsn-overlay" data-dsn-overlay></canvas>
        <input class="dsn-text-in" data-dsn-text-in hidden maxlength="2000" />
        <p class="dsn-empty" data-dsn-empty>Open or drop an image, or start a new document.</p>
      </div>
      <div class="dsn-side">
        <section class="dsn-sec" data-dsn-options></section>
        <section class="dsn-sec" data-dsn-requests hidden></section>
        <section class="dsn-sec" data-dsn-hints></section>
        <section class="dsn-sec" data-dsn-layers></section>
        <section class="dsn-sec" data-dsn-dgx></section>
        <section class="dsn-sec" data-dsn-export-sec></section>
      </div>
    </div>
    <div class="dsn-timeline" data-dsn-timeline hidden></div>
    <div class="dsn-progress" data-dsn-progress hidden><span class="dsn-progress-note" data-dsn-progress-note></span><progress max="1" value="0" data-dsn-progress-bar></progress><button type="button" class="btn-mini danger" data-dsn-cancel>Cancel</button></div>
  </div>`;
}
