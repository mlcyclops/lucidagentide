// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/creator/design/svg_export.ts - DesignDoc to static or CSS-animated SVG.
//
// Built for hostile input (fabric.js GHSA-hfvx-25r5-qc3w was stored XSS through exported ids and colors):
//   * no user or model string is ever written into an attribute except through esc(); layer NAMES are not
//     emitted at all, ids are re-validated and prefixed, colors are re-normalized, numbers re-formatted;
//   * text content is escaped and split into <tspan> runs before every ':' and '(' so even a scanner that
//     strips whitespace never sees "javascript:" or "url(" in prose (rendering is unchanged);
//   * raster layers appear only as <image href="data:image/png;base64,..."> when the caller returns a
//     well-formed PNG data URL, never an external reference;
//   * animation is CSS @keyframes (transform + opacity only, generated names, linear sampled keys) in one
//     <style>; no SMIL, no script, no url();
//   * the finished document is run through svgSafetyCheck and refused (thrown) if it would not pass.
// Masks are not exported (their pixels live in the renderer's TileStore); hidden layers are omitted.

import { frameTimes, layerMatrix, layerStateAt, type LayerState } from "./anim.ts";
import { normalizeColor } from "./color.ts";
import { DESIGN_LIMITS, DESIGN_MAX_TEXT } from "./limits.ts";
import { serializePath } from "./path.ts";
import { svgSafetyCheck } from "./svg_check.ts";
import { BLEND_MODES, type DesignDoc, type Layer, type VPaint, type VShape } from "./types.ts";
import { cleanText, isValidId } from "./util.ts";

export interface SvgExportOptions {
  /** Caller-encoded `data:image/png;base64,...` for a raster layer, or null to omit it. */
  rasterHref: (layerId: string) => string | null;
  animate: boolean;
  /** Decimal places for coordinates (0..6, default 3). */
  precision?: number;
  /** Prefix for emitted ids/classes; must match /^[A-Za-z][A-Za-z0-9_-]{0,15}$/ (default "lc-"). */
  idPrefix?: string;
}

const MAX_DEPTH = 32;
const MAX_MAGNITUDE = 1e9;
const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&apos;" };
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? "");
const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

function fmt(v: number, precision: number): string {
  if (!Number.isFinite(v)) return "0";
  const clamped = Math.max(-MAX_MAGNITUDE, Math.min(MAX_MAGNITUDE, v));
  const f = 10 ** precision;
  const r = Math.round(clamped * f) / f;
  if (r === 0) return "0"; // also folds -0
  let s = r.toFixed(precision);
  if (s.includes(".")) {
    let end = s.length;
    while (s[end - 1] === "0") end--;
    if (s[end - 1] === ".") end--;
    s = s.slice(0, end);
  }
  return s;
}

const PNG_DATA_PREFIX = "data:image/png;base64,";

/** The href only when it is a syntactically clean base64 PNG data URL. */
function safePngHref(h: unknown): string | null {
  if (typeof h !== "string" || !h.startsWith(PNG_DATA_PREFIX) || h.length === PNG_DATA_PREFIX.length) return null;
  for (let i = PNG_DATA_PREFIX.length; i < h.length; i++) {
    const c = h.charCodeAt(i);
    const ok = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 47 || c === 61;
    if (!ok) return null;
  }
  return h;
}

/** Escaped prose, broken into tspans before ':' and '(' (see header). */
function textContent(s: string): string {
  const clean = cleanText(s, DESIGN_MAX_TEXT);
  let out = "<tspan>";
  for (const ch of clean) {
    if (ch === ":" || ch === "(") out += "</tspan><tspan>";
    out += ESCAPES[ch] ?? ch;
  }
  return out + "</tspan>";
}

function colorAttrs(name: "fill" | "stroke", value: string | null): string[] {
  const c = value === null ? null : normalizeColor(value);
  if (c === null) return [`${name}="none"`];
  if (c.length === 9) return [`${name}="${c.slice(0, 7)}"`, `${name}-opacity="${fmt(parseInt(c.slice(7), 16) / 255, 4)}"`];
  return [`${name}="${c}"`];
}

function matrixAttr(m: readonly number[], p: number): string {
  return `matrix(${m.map((v) => fmt(v, Math.max(p, 6))).join(" ")})`;
}

const isIdentity = (m: readonly number[]): boolean =>
  m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0;

function paintAttrs(paint: VPaint, p: number): string[] {
  const a = [...colorAttrs("fill", paint.fill), ...colorAttrs("stroke", paint.stroke)];
  if (paint.stroke !== null) {
    a.push(`stroke-width="${fmt(paint.strokeWidth, p)}"`);
    if (paint.lineCap === "butt" || paint.lineCap === "round" || paint.lineCap === "square") a.push(`stroke-linecap="${paint.lineCap}"`);
    if (paint.lineJoin === "miter" || paint.lineJoin === "round" || paint.lineJoin === "bevel") a.push(`stroke-linejoin="${paint.lineJoin}"`);
  }
  if (Number.isFinite(paint.opacity) && paint.opacity < 1) a.push(`opacity="${fmt(Math.max(0, paint.opacity), 4)}"`);
  return a;
}

function shapeMarkup(s: VShape, p: number): string {
  const attrs = paintAttrs(s.paint, p);
  if (s.transform && s.transform.length === 6 && s.transform.every(Number.isFinite) && !isIdentity(s.transform)) {
    attrs.push(`transform="${matrixAttr(s.transform, p)}"`);
  }
  const extra = attrs.join(" ");
  if (s.kind === "path" && s.d && s.d.length) {
    const d = serializePath(s.d, p);
    return d ? `<path d="${esc(d)}" ${extra}/>` : "";
  }
  if ((s.kind === "rect" || s.kind === "ellipse") && s.rect) {
    const { x, y } = s.rect;
    const w = Math.max(0, s.rect.w), h = Math.max(0, s.rect.h);
    if (s.kind === "rect") {
      const rx = Number.isFinite(s.rx) && (s.rx ?? 0) > 0 ? ` rx="${fmt(s.rx!, p)}"` : "";
      return `<rect x="${fmt(x, p)}" y="${fmt(y, p)}" width="${fmt(w, p)}" height="${fmt(h, p)}"${rx} ${extra}/>`;
    }
    return `<ellipse cx="${fmt(x + w / 2, p)}" cy="${fmt(y + h / 2, p)}" rx="${fmt(w / 2, p)}" ry="${fmt(h / 2, p)}" ${extra}/>`;
  }
  if (s.kind === "text" && s.text) {
    const family = s.text.family === "serif" || s.text.family === "monospace" ? s.text.family : "sans-serif";
    return `<text x="${fmt(s.rect?.x ?? 0, p)}" y="${fmt(s.rect?.y ?? 0, p)}" font-size="${fmt(s.text.size, p)}" font-family="${family}" ${extra}>${textContent(s.text.content)}</text>`;
  }
  return "";
}

/** CSS transform equal to layerMatrix(layer, state): translate(x+ax, y+ay) rotate(r) scale(s) translate(-ax, -ay).
 *  Every keyframe uses the same function list, so CSS interpolates each function linearly. */
function cssTransform(l: Layer, s: LayerState, p: number): string {
  return `translate(${fmt(s.x + l.anchorX, p)}px,${fmt(s.y + l.anchorY, p)}px) rotate(${fmt(s.rotation, 4)}deg) scale(${fmt(s.scale, 5)}) translate(${fmt(-l.anchorX, p)}px,${fmt(-l.anchorY, p)}px)`;
}

const PROPS = ["x", "y", "scale", "rotation", "opacity"] as const;

/** Drop interior samples that lie on the straight line between their kept neighbours (linear timing
 *  reproduces them exactly), keeping the output small for mostly-linear motion. */
function simplifySamples(samples: { pct: number; s: LayerState }[]): { pct: number; s: LayerState }[] {
  if (samples.length <= 2) return samples;
  const out = [samples[0]!];
  for (let i = 1; i < samples.length - 1; i++) {
    const a = out[out.length - 1]!, b = samples[i]!, c = samples[i + 1]!;
    const f = (b.pct - a.pct) / (c.pct - a.pct);
    const onLine = PROPS.every((k) => Math.abs(a.s[k] + (c.s[k] - a.s[k]) * f - b.s[k]) <= 1e-4 * Math.max(1, Math.abs(b.s[k])));
    if (!onLine) out.push(b);
  }
  out.push(samples[samples.length - 1]!);
  return out;
}

/** Serialize the document as SVG. Throws only if the result would fail svgSafetyCheck (a bug guard). */
export function exportSvg(doc: DesignDoc, opts: SvgExportOptions): string {
  const p = Number.isInteger(opts.precision) ? Math.min(6, Math.max(0, opts.precision!)) : 3;
  const prefix = typeof opts.idPrefix === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,15}$/.test(opts.idPrefix) ? opts.idPrefix : "lc-";
  const w = Number.isInteger(doc.width) && doc.width > 0 ? doc.width : 1;
  const h = Number.isInteger(doc.height) && doc.height > 0 ? doc.height : 1;
  const parts: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`];

  // Animated layers get a generated class; their transform/opacity then come only from CSS.
  const animClass = new Map<string, string>();
  const css: string[] = [];
  const tl = doc.timeline;
  if (opts.animate && tl && Number.isFinite(tl.durationMs) && tl.durationMs > 0) {
    const times = frameTimes(tl);
    const ids: string[] = [];
    for (const t of tl.tracks) {
      if (t.keys.length && isValidId(t.layerId) && hasOwn(doc.layers, t.layerId) && !ids.includes(t.layerId)) ids.push(t.layerId);
    }
    const end = Math.max(0, tl.durationMs - 1e-3);
    for (const id of ids.slice(0, DESIGN_LIMITS.maxLayers)) {
      const layer = doc.layers[id]!;
      const n = animClass.size;
      const cls = `${prefix}a${n}`, kf = `${prefix}k${n}`;
      animClass.set(id, cls);
      const samples = times.map((t) => ({ pct: (t / tl.durationMs) * 100, s: layerStateAt(doc, id, t) }));
      samples.push({ pct: 100, s: layerStateAt(doc, id, end) });
      const frames = simplifySamples(samples)
        .map(({ pct, s }) => `${fmt(pct, 4)}%{transform:${cssTransform(layer, s, p)};opacity:${fmt(s.opacity, 4)}}`)
        .join("");
      css.push(`@keyframes ${kf}{${frames}}`);
      css.push(`.${cls}{animation:${kf} ${fmt(tl.durationMs / 1000, 3)}s linear ${tl.loop ? "infinite" : "1"} both}`);
    }
  }
  if (css.length) parts.push(`<style>${css.join("")}</style>`);

  const bg = doc.background === null ? null : normalizeColor(doc.background);
  if (bg) parts.push(`<rect width="${w}" height="${h}" ${colorAttrs("fill", bg).join(" ")}/>`);

  const visited = new Set<string>();
  const emit = (id: string, depth: number): void => {
    if (depth > MAX_DEPTH || visited.has(id) || !isValidId(id) || !hasOwn(doc.layers, id)) return;
    visited.add(id);
    const l = doc.layers[id]!;
    if (!l.visible) return;
    const attrs = [`id="${prefix}${id}"`];
    const cls = animClass.get(id);
    if (cls) attrs.push(`class="${cls}"`);
    else {
      const m = layerMatrix(l);
      if (m.every(Number.isFinite) && !isIdentity(m)) attrs.push(`transform="${matrixAttr(m, p)}"`);
      if (Number.isFinite(l.opacity) && l.opacity < 1) attrs.push(`opacity="${fmt(Math.max(0, l.opacity), 4)}"`);
    }
    if (l.blend !== "normal" && BLEND_MODES.includes(l.blend)) attrs.push(`style="mix-blend-mode:${l.blend}"`);
    parts.push(`<g ${attrs.join(" ")}>`);
    if (l.kind === "raster") {
      const href = safePngHref(opts.rasterHref(id));
      if (href && Number.isInteger(l.width) && Number.isInteger(l.height)) {
        parts.push(`<image width="${l.width}" height="${l.height}" preserveAspectRatio="none" href="${href}"/>`);
      }
    } else if (l.kind === "vector") {
      for (const s of l.shapes.slice(0, DESIGN_LIMITS.maxShapes)) parts.push(shapeMarkup(s, p));
    } else {
      for (const c of l.children) emit(c, depth + 1);
    }
    parts.push("</g>");
  };
  for (const id of doc.order) emit(id, 0);
  parts.push("</svg>");

  const svg = parts.join("");
  const verdict = svgSafetyCheck(svg);
  if (!verdict.ok) throw new Error(`exportSvg: refusing to emit an SVG that fails the safety check (${verdict.reason})`);
  return svg;
}
