// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/creator_dgx_vision.ts - the HTTP client for the DGX Loader's vision service (design contract
// section 4), mirroring creator_dgx_cad.ts.
//
// The service runs on a DGX box bound to 127.0.0.1:8090 and is reached through the Loader's SSH forward.
// Rules that hold here:
//   * Every input image is sniffed from its header and refused before any byte leaves this machine when its
//     format is not on the allowlist or width * height * frames exceeds the decode budget.
//   * Every request is rebuilt from validated fields (`buildVisionRequest`): a caller's body is never passed
//     through, so an unknown key cannot reach the box.
//   * Every response is validated fail-closed: masks and images must be PNGs of the expected dimensions,
//     layer counts and label counts are capped, ids are slugs, and an SVG must pass svgSafetyCheck.
//   * Model text (labels, captions, errors) is UNTRUSTED data: control and bidi characters stripped, capped at
//     200 characters, and never merged into instructions by anything in LUCID.

import type { CreatorCapabilityId } from "./creator_registry.ts";
import type { FetchLike } from "./creator_probe.ts";
import { DESIGN_LIMITS } from "../harness/creator/design/limits.ts";
import { checkDecodeBudget, sniffImage } from "../harness/creator/design/sniff.ts";
import { svgSafetyCheck } from "../harness/creator/design/svg_check.ts";

export type VisionOp = "segment" | "decompose" | "matte" | "inpaint" | "upscale" | "depth" | "label" | "vectorize";
export const VISION_OPS: readonly VisionOp[] = ["segment", "decompose", "matte", "inpaint", "upscale", "depth", "label", "vectorize"] as const;
export const isVisionOp = (v: unknown): v is VisionOp => typeof v === "string" && (VISION_OPS as readonly string[]).includes(v);

/** Largest input file LUCID forwards (the engine's own request body limit is 128 MB of base64). */
export const VISION_MAX_IMAGE_BYTES = 64 * 1024 * 1024;
/** Input decode budget: the design engine's raster ceiling. */
export const VISION_MAX_PIXELS = DESIGN_LIMITS.maxRasterPixels;
/** Largest JSON answer read from the box; an upscale bigger than the service's 64 MB inline cap comes back as an artifact. */
export const VISION_MAX_RESPONSE_BYTES = 256 * 1024 * 1024;
/** Largest artifact download (a tiled 8x upscale PNG). */
export const VISION_MAX_ARTIFACT_BYTES = 768 * 1024 * 1024;
export const VISION_MAX_LAYERS = 32;
export const VISION_MAX_LABELS = 256;
export const VISION_MAX_POINTS = 256;
export const VISION_MAX_BOXES = 64;
export const VISION_MAX_SVG_CHARS = 20 * 1024 * 1024;
export const VISION_LABEL_MAX = DESIGN_LIMITS.maxLabel;
/** The service names jobs and artifacts by 32 lowercase hex. */
export const VISION_REMOTE_ID = /^[0-9a-f]{32}$/;
const LAYER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const B64 = /^[A-Za-z0-9+/]*={0,2}$/;
const ROLE = /^[a-z0-9][a-z0-9_-]{0,47}$/;

export type ClientResult<T> = { ok: true; data: T } | { ok: false; error: string; status?: number };

// ── untrusted text ──────────────────────────────────────────────────────────

/** Untrusted model text as DATA: C0/C1 controls, bidi overrides, zero-width and BOM characters dropped, runs of
 *  whitespace collapsed, capped. One linear pass; no regex runs over the untrusted string. */
export function untrustedText(v: unknown, max: number = VISION_LABEL_MAX): string {
  if (typeof v !== "string") return "";
  let out = "";
  let space = false;
  for (const ch of v) {
    const c = ch.codePointAt(0) ?? 0;
    const drop = c < 0x20 || (c >= 0x7f && c <= 0x9f) || (c >= 0x200b && c <= 0x200f) || (c >= 0x202a && c <= 0x202e)
      || (c >= 0x2060 && c <= 0x2069) || c === 0xfeff;
    if (drop) { if (c === 0x09 || c === 0x0a || c === 0x0d) space = out.length > 0; continue; }
    if (ch === " ") { space = out.length > 0; continue; }
    if (space) { out += " "; space = false; }
    out += ch;
    if (out.length >= max) break;
  }
  return out.slice(0, max);
}

const bounded = (v: unknown, max = 300): string => untrustedText(v, max);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
/** The one plain-JSON-object guard the Design suite's server modules share (creator_design.ts imports it).
 *  It proves an object only: every field read off it is still checked with typeof. */
export const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

// ── bytes ───────────────────────────────────────────────────────────────────

/** Strict base64 to bytes, refusing anything over `maxBytes` before decoding. */
export function decodeB64(v: unknown, maxBytes: number): { ok: true; bytes: Uint8Array } | { ok: false; error: string } {
  if (typeof v !== "string" || !v.length) return { ok: false, error: "expected base64 data" };
  if (v.length > Math.ceil(maxBytes / 3) * 4 + 4) return { ok: false, error: `over the ${Math.round(maxBytes / (1024 * 1024))} MB limit` };
  if (v.length % 4 !== 0 || !B64.test(v)) return { ok: false, error: "not valid base64" };
  const bytes = new Uint8Array(Buffer.from(v, "base64"));
  if (!bytes.length) return { ok: false, error: "decoded to nothing" };
  return { ok: true, bytes };
}

export const toB64 = (bytes: Uint8Array): string => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");

export interface PngInfo { readonly width: number; readonly height: number; readonly bitDepth: number; readonly colorType: number }

/** Read a PNG's IHDR. Null unless the signature and a well-formed first IHDR chunk are present. */
export function pngInfo(bytes: Uint8Array): PngInfo | null {
  if (bytes.length < 33) return null;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (bytes[i] !== sig[i]) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(8) !== 13 || bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) return null;
  const width = dv.getUint32(16);
  const height = dv.getUint32(20);
  if (!width || !height || width > DESIGN_LIMITS.maxSide || height > DESIGN_LIMITS.maxSide) return null;
  return { width, height, bitDepth: bytes[24]!, colorType: bytes[25]! };
}

/** A base64 PNG of exactly `w` x `h`, else the reason. */
export function checkPngB64(v: unknown, w: number, h: number, what: string, maxBytes = VISION_MAX_RESPONSE_BYTES): { ok: true; info: PngInfo } | { ok: false; error: string } {
  const d = decodeB64(v, maxBytes);
  if (!d.ok) return { ok: false, error: `${what}: ${d.error}` };
  const info = pngInfo(d.bytes);
  if (!info) return { ok: false, error: `${what} is not a PNG` };
  if (info.width !== w || info.height !== h) return { ok: false, error: `${what} is ${info.width}x${info.height}, expected ${w}x${h}` };
  return { ok: true, info };
}

// ── input image ─────────────────────────────────────────────────────────────

export type VisionImageFormat = "png" | "jpeg" | "webp" | "bmp" | "gif";
const INPUT_FORMATS: readonly string[] = ["png", "jpeg", "webp", "bmp", "gif"];
export interface VisionImage { readonly bytes: Uint8Array; readonly width: number; readonly height: number; readonly format: VisionImageFormat }

/** Sniff an input image from its header and apply the format allowlist and decode budget. */
export function checkVisionImage(bytes: Uint8Array, maxPixels = VISION_MAX_PIXELS): { ok: true; image: VisionImage } | { ok: false; error: string } {
  if (!bytes.length) return { ok: false, error: "The image is empty." };
  if (bytes.length > VISION_MAX_IMAGE_BYTES) return { ok: false, error: "The image is over the 64 MB limit for the vision service." };
  const info = sniffImage(bytes);
  if (!INPUT_FORMATS.includes(info.format)) return { ok: false, error: `The vision service takes PNG, JPEG, WebP, BMP, or GIF (first frame), not ${info.format}.` };
  if (!info.width || !info.height) return { ok: false, error: "The image header does not state its size." };
  const budget = checkDecodeBudget({ ...info, frames: 1 }, maxPixels);
  if (budget) return { ok: false, error: budget };
  return { ok: true, image: { bytes, width: info.width, height: info.height, format: info.format as VisionImageFormat } };
}

// ── health ──────────────────────────────────────────────────────────────────

export const VISION_HEALTH_CAPS = ["segment", "decompose", "generative_decompose", "matte", "inpaint", "upscale", "depth", "label", "vectorize"] as const;
export type VisionHealthCap = (typeof VISION_HEALTH_CAPS)[number];

export interface VisionHealth {
  readonly ok: true;
  readonly service: "dgx-vision";
  readonly version: string;
  readonly capabilities: Readonly<Record<VisionHealthCap, boolean>>;
  readonly models: readonly { readonly role: string; readonly ready: boolean; readonly detail: string }[];
  readonly versions: { readonly torch: string; readonly transformers: string; readonly diffusers: string };
}

export function parseVisionHealth(raw: unknown): VisionHealth | null {
  if (!isRecord(raw) || raw.ok !== true || raw.service !== "dgx-vision") return null;
  const caps: Record<string, unknown> = isRecord(raw.capabilities) ? raw.capabilities : {};
  const capabilities: Record<VisionHealthCap, boolean> = {
    segment: caps.segment === true, decompose: caps.decompose === true, generative_decompose: caps.generative_decompose === true,
    matte: caps.matte === true, inpaint: caps.inpaint === true, upscale: caps.upscale === true, depth: caps.depth === true,
    label: caps.label === true, vectorize: caps.vectorize === true,
  };
  const models: { role: string; ready: boolean; detail: string }[] = [];
  if (isRecord(raw.models)) {
    for (const [role, m] of Object.entries(raw.models)) {
      if (models.length >= 32) break;
      if (!ROLE.test(role) || !isRecord(m)) continue;
      models.push({ role, ready: m.ready === true, detail: bounded(m.detail, 200) });
    }
  }
  const v: Record<string, unknown> = isRecord(raw.versions) ? raw.versions : {};
  return {
    ok: true, service: "dgx-vision", version: bounded(raw.version, 40), capabilities, models,
    versions: { torch: bounded(v.torch, 40), transformers: bounded(v.transformers, 40), diffusers: bounded(v.diffusers, 40) },
  };
}

/** What a health answer PROVES, as Creator capability ids. */
export function visionHealthCapabilities(h: VisionHealth): CreatorCapabilityId[] {
  const c = h.capabilities;
  const out: CreatorCapabilityId[] = [];
  if (c.segment) out.push("segment");
  if (c.decompose || c.generative_decompose) out.push("layer-decompose");
  if (c.matte) out.push("matte");
  if (c.inpaint) out.push("inpaint");
  if (c.upscale) out.push("upscale");
  if (c.depth) out.push("depth");
  if (c.label) out.push("vision-label");
  if (c.vectorize) out.push("vectorize");
  return out;
}

/** The probe's one honest line: what is proven and which models are not ready, with their reasons. */
export function visionHealthDetail(h: VisionHealth): string {
  const proven = visionHealthCapabilities(h);
  const notReady = h.models.filter((m) => !m.ready).map((m) => `${m.role}${m.detail ? ` (${m.detail})` : ""}`);
  return `dgx-vision ${h.version}: proven ${proven.length ? proven.join(", ") : "nothing"}${notReady.length ? `; not ready: ${notReady.slice(0, 8).join(", ")}` : ""}.`;
}

// ── requests ────────────────────────────────────────────────────────────────

type Pt = [number, number];
type Box = [number, number, number, number];

function points(raw: unknown, w: number, h: number, what: string): { ok: true; pts: Pt[] } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, pts: [] };
  if (!Array.isArray(raw)) return { ok: false, error: `${what} must be a list of [x, y] points.` };
  if (raw.length > VISION_MAX_POINTS) return { ok: false, error: `${what} is capped at ${VISION_MAX_POINTS} points.` };
  const pts: Pt[] = [];
  for (const p of raw) {
    if (!Array.isArray(p) || p.length !== 2 || !finite(p[0]) || !finite(p[1])) return { ok: false, error: `${what} must be a list of [x, y] points.` };
    if (p[0] < 0 || p[1] < 0 || p[0] > w || p[1] > h) return { ok: false, error: `A ${what} point lies outside the ${w}x${h} image.` };
    pts.push([p[0], p[1]]);
  }
  return { ok: true, pts };
}

function box(raw: unknown, w: number, h: number, what: string): { ok: true; box: Box } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length !== 4 || !raw.every(finite)) return { ok: false, error: `${what} must be [x0, y0, x1, y1].` };
  const [x0, y0, x1, y1] = raw as number[];
  if (x0! < 0 || y0! < 0 || x1! > w || y1! > h || x1! <= x0! || y1! <= y0!) return { ok: false, error: `${what} must lie inside the ${w}x${h} image with x1 > x0 and y1 > y0.` };
  return { ok: true, box: [x0!, y0!, x1!, y1!] };
}

function intIn(raw: unknown, def: number, lo: number, hi: number, what: string): { ok: true; n: number } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, n: def };
  if (!finite(raw) || Math.trunc(raw) !== raw || raw < lo || raw > hi) return { ok: false, error: `${what} must be a whole number from ${lo} to ${hi}.` };
  return { ok: true, n: raw };
}

function maskFor(raw: unknown, img: VisionImage, what: string): { ok: true; b64: string } | { ok: false; error: string } {
  const c = checkPngB64(raw, img.width, img.height, what, VISION_MAX_IMAGE_BYTES);
  return c.ok ? { ok: true, b64: raw as string } : c;
}

/** The ONLY way to build a request body for the box. Unknown input keys are ignored, every kept field is
 *  validated against the image it applies to, and defaults come from the contract. */
export function buildVisionRequest(op: VisionOp, input: Record<string, unknown>, img: VisionImage): { ok: true; body: Record<string, unknown> } | { ok: false; error: string } {
  const body: Record<string, unknown> = { image: { dataB64: toB64(img.bytes) } };
  const { width: w, height: h } = img;
  switch (op) {
    case "segment": {
      const pos = points(input.positive, w, h, "positive");
      if (!pos.ok) return pos;
      const neg = points(input.negative, w, h, "negative");
      if (!neg.ok) return neg;
      body.positive = pos.pts;
      body.negative = neg.pts;
      if (input.box !== undefined && input.box !== null) {
        const b = box(input.box, w, h, "box");
        if (!b.ok) return b;
        body.box = b.box;
      }
      if (input.maskB64 !== undefined && input.maskB64 !== null) {
        const m = maskFor(input.maskB64, img, "The brush mask");
        if (!m.ok) return m;
        body.maskB64 = m.b64;
      }
      if (!pos.pts.length && !body.box && !body.maskB64) return { ok: false, error: "Segment needs at least one positive point, a box, or a brush mask." };
      if (input.multimask !== undefined && typeof input.multimask !== "boolean") return { ok: false, error: "multimask must be true or false." };
      body.multimask = input.multimask === true;
      return { ok: true, body };
    }
    case "decompose": {
      const n = intIn(input.maxLayers, 8, 2, VISION_MAX_LAYERS, "maxLayers");
      if (!n.ok) return n;
      const mode = input.mode === undefined ? "fast" : input.mode;
      if (mode !== "fast" && mode !== "generative") return { ok: false, error: "mode must be fast or generative." };
      if (input.fillBackground !== undefined && typeof input.fillBackground !== "boolean") return { ok: false, error: "fillBackground must be true or false." };
      Object.assign(body, { maxLayers: n.n, mode, fillBackground: input.fillBackground !== false });
      // Fast mode only: the smallest automatic mask kept, in pixels. Omitted means the service default.
      if (input.minArea !== undefined && input.minArea !== null) {
        const a = intIn(input.minArea, 0, 1, w * h, "minArea");
        if (!a.ok) return a;
        body.minArea = a.n;
      }
      return { ok: true, body };
    }
    case "matte":
    case "depth":
      return { ok: true, body };
    case "inpaint": {
      const m = maskFor(input.maskB64, img, "The inpaint mask");
      if (!m.ok) return m;
      body.maskB64 = m.b64;
      return { ok: true, body };
    }
    case "upscale": {
      const scale = input.scale === undefined ? 4 : input.scale;
      if (scale !== 2 && scale !== 4 && scale !== 8) return { ok: false, error: "scale must be 2, 4, or 8." };
      const tile = intIn(input.tile, 512, 128, 1024, "tile");
      if (!tile.ok) return tile;
      const overlap = intIn(input.overlap, 32, 0, 128, "overlap");
      if (!overlap.ok) return overlap;
      if (overlap.n * 2 >= tile.n) return { ok: false, error: "overlap must be under half the tile size." };
      const ow = w * scale;
      const oh = h * scale;
      if (ow > DESIGN_LIMITS.maxSide || oh > DESIGN_LIMITS.maxSide || ow * oh > DESIGN_LIMITS.maxRasterPixels) {
        return { ok: false, error: `A ${scale}x upscale of ${w}x${h} would be ${ow}x${oh}, over the ${DESIGN_LIMITS.maxSide} px side or ${DESIGN_LIMITS.maxRasterPixels} pixel limit.` };
      }
      Object.assign(body, { scale, tile: tile.n, overlap: overlap.n });
      return { ok: true, body };
    }
    case "label": {
      if (input.boxes !== undefined && input.boxes !== null) {
        if (!Array.isArray(input.boxes) || input.boxes.length > VISION_MAX_BOXES) return { ok: false, error: `boxes must be a list of at most ${VISION_MAX_BOXES} boxes.` };
        const boxes: Box[] = [];
        for (const raw of input.boxes) {
          const b = box(raw, w, h, "Each box");
          if (!b.ok) return b;
          boxes.push(b.box);
        }
        body.boxes = boxes;
      }
      return { ok: true, body };
    }
    case "vectorize": {
      const colors = intIn(input.colors, 16, 2, 64, "colors");
      if (!colors.ok) return colors;
      const speckle = intIn(input.filterSpeckle, 4, 0, 128, "filterSpeckle");
      if (!speckle.ok) return speckle;
      const mode = input.mode === undefined ? "spline" : input.mode;
      if (mode !== "spline" && mode !== "polygon") return { ok: false, error: "mode must be spline or polygon." };
      Object.assign(body, { colors: colors.n, filterSpeckle: speckle.n, mode });
      return { ok: true, body };
    }
  }
}

// ── responses ───────────────────────────────────────────────────────────────

/** Contract bbox: [x0, y0, x1, y1] with exclusive x1/y1, or null for an empty mask. */
export type VisionBBox = [number, number, number, number] | null;

function parseBBox(raw: unknown, w: number, h: number): { ok: true; bbox: VisionBBox } | { ok: false } {
  if (raw === null || raw === undefined) return { ok: true, bbox: null };
  if (!Array.isArray(raw) || raw.length !== 4 || !raw.every(finite)) return { ok: false };
  const [x0, y0, x1, y1] = raw as number[];
  if (x0! < 0 || y0! < 0 || x1! > w || y1! > h || x1! < x0! || y1! < y0!) return { ok: false };
  return { ok: true, bbox: [x0!, y0!, x1!, y1!] };
}

const unit = (v: unknown): number => (finite(v) ? Math.min(1, Math.max(0, v)) : 0);

export interface SegmentResult { maskB64: string; score: number; bbox: VisionBBox; area: number }
export interface DecomposeLayer { id: string; pngB64: string; x: number; y: number; width: number; height: number; label: string; confidence: number; depth: number; area: number }
export interface DecomposeResult { layers: DecomposeLayer[]; background: { pngB64: string } }
export interface UpscaleResult { pngB64?: string; artifactId?: string; width: number; height: number }
export interface LabelResult { labels: { box: [number, number, number, number]; text: string; score: number }[] }

type Parsed = { ok: true; data: Record<string, unknown> } | { ok: false; error: string };

/** Validate one finished result for `op` against the image it was computed from. `scale` is the upscale factor. */
export function parseVisionResult(op: VisionOp, raw: unknown, img: { width: number; height: number }, scale = 1): Parsed {
  if (!isRecord(raw)) return { ok: false, error: `the ${op} result was not an object` };
  const { width: w, height: h } = img;
  switch (op) {
    case "segment": {
      const m = checkPngB64(raw.maskB64, w, h, "The mask");
      if (!m.ok) return m;
      const b = parseBBox(raw.bbox, w, h);
      if (!b.ok) return { ok: false, error: "The mask bbox is outside the image." };
      const out: SegmentResult = { maskB64: raw.maskB64 as string, score: unit(raw.score), bbox: b.bbox, area: finite(raw.area) && raw.area >= 0 ? Math.min(raw.area, w * h) : 0 };
      return { ok: true, data: { ...out } };
    }
    case "matte": {
      const m = checkPngB64(raw.maskB64, w, h, "The matte");
      return m.ok ? { ok: true, data: { maskB64: raw.maskB64 } } : m;
    }
    case "inpaint": {
      const m = checkPngB64(raw.pngB64, w, h, "The inpainted image");
      return m.ok ? { ok: true, data: { pngB64: raw.pngB64 } } : m;
    }
    case "depth": {
      const m = checkPngB64(raw.depthB64, w, h, "The depth map");
      if (!m.ok) return m;
      if (m.info.colorType !== 0) return { ok: false, error: "The depth map is not a grayscale PNG." };
      return { ok: true, data: { depthB64: raw.depthB64, width: w, height: h, bitDepth: m.info.bitDepth } };
    }
    case "label": {
      if (!Array.isArray(raw.labels)) return { ok: false, error: "The label result carried no labels list." };
      const labels: LabelResult["labels"] = [];
      for (const l of raw.labels.slice(0, VISION_MAX_LABELS)) {
        if (!isRecord(l)) continue;
        const b = parseBBox(l.box, w, h);
        if (!b.ok || !b.bbox) continue;
        const text = untrustedText(l.text);
        if (!text) continue;
        labels.push({ box: b.bbox, text, score: unit(l.score) });
      }
      return { ok: true, data: { labels, untrusted: true } };
    }
    case "vectorize": {
      if (typeof raw.svg !== "string" || !raw.svg.length) return { ok: false, error: "The vectorize result carried no SVG." };
      if (raw.svg.length > VISION_MAX_SVG_CHARS) return { ok: false, error: "The SVG is over the 20 MB limit." };
      const safe = svgSafetyCheck(raw.svg);
      if (!safe.ok) return { ok: false, error: `The SVG from the box was refused: ${safe.reason}` };
      return { ok: true, data: { svg: raw.svg } };
    }
    case "decompose": {
      if (!Array.isArray(raw.layers)) return { ok: false, error: "The decompose result carried no layers list." };
      if (raw.layers.length > VISION_MAX_LAYERS) return { ok: false, error: `The box returned ${raw.layers.length} layers; the limit is ${VISION_MAX_LAYERS}.` };
      const seen = new Set<string>();
      const layers: DecomposeLayer[] = [];
      for (const [i, l] of raw.layers.entries()) {
        if (!isRecord(l)) return { ok: false, error: `Layer ${i + 1} is malformed.` };
        if (typeof l.id !== "string" || !LAYER_ID.test(l.id) || seen.has(l.id)) return { ok: false, error: `Layer ${i + 1} has a missing, malformed, or duplicate id.` };
        seen.add(l.id);
        const ints = [l.x, l.y, l.width, l.height];
        if (!ints.every((n) => finite(n) && Math.trunc(n) === n)) return { ok: false, error: `Layer ${l.id} has a non-integer position or size.` };
        const [x, y, lw, lh] = ints as number[];
        if (x! < 0 || y! < 0 || lw! < 1 || lh! < 1 || x! + lw! > w || y! + lh! > h) return { ok: false, error: `Layer ${l.id} lies outside the ${w}x${h} image.` };
        const png = checkPngB64(l.pngB64, lw!, lh!, `Layer ${l.id}`);
        if (!png.ok) return png;
        layers.push({
          id: l.id, pngB64: l.pngB64 as string, x: x!, y: y!, width: lw!, height: lh!,
          label: untrustedText(l.label), confidence: unit(l.confidence), depth: unit(l.depth),
          area: finite(l.area) && l.area >= 0 ? Math.min(l.area, lw! * lh!) : 0,
        });
      }
      if (!isRecord(raw.background)) return { ok: false, error: "The decompose result carried no background." };
      const bg = checkPngB64(raw.background.pngB64, w, h, "The background");
      if (!bg.ok) return bg;
      const out: DecomposeResult = { layers, background: { pngB64: raw.background.pngB64 as string } };
      return { ok: true, data: { ...out, labelsUntrusted: true } };
    }
    case "upscale": {
      const ow = w * scale;
      const oh = h * scale;
      if (raw.width !== ow || raw.height !== oh) return { ok: false, error: `The upscale reports ${String(raw.width)}x${String(raw.height)}, expected ${ow}x${oh}.` };
      const hasPng = typeof raw.pngB64 === "string";
      const hasArt = typeof raw.artifactId === "string";
      if (hasPng === hasArt) return { ok: false, error: "The upscale result must carry exactly one of pngB64 or artifactId." };
      if (hasArt) {
        if (!VISION_REMOTE_ID.test(raw.artifactId as string)) return { ok: false, error: "The upscale artifact id is malformed." };
        const out: UpscaleResult = { artifactId: raw.artifactId as string, width: ow, height: oh };
        return { ok: true, data: { ...out } };
      }
      const png = checkPngB64(raw.pngB64, ow, oh, "The upscaled image");
      if (!png.ok) return png;
      const out: UpscaleResult = { pngB64: raw.pngB64 as string, width: ow, height: oh };
      return { ok: true, data: { ...out } };
    }
  }
}

export type VisionJobState = "queued" | "running" | "done" | "error" | "cancelled";
export interface VisionJobView { id: string; state: VisionJobState; progress: number; message: string; error: string; result?: unknown }

export function parseVisionJob(raw: unknown): VisionJobView | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== "string" || !VISION_REMOTE_ID.test(raw.id)) return null;
  const st = raw.state;
  if (st !== "queued" && st !== "running" && st !== "done" && st !== "error" && st !== "cancelled") return null;
  return {
    id: raw.id, state: st, progress: unit(raw.progress), message: bounded(raw.message, 300), error: bounded(raw.error, 500),
    ...(st === "done" && "result" in raw ? { result: raw.result } : {}),
  };
}

export function parseJobSubmit(raw: unknown): string | null {
  return isRecord(raw) && typeof raw.jobId === "string" && VISION_REMOTE_ID.test(raw.jobId) ? raw.jobId : null;
}

// ── the LUCID-side remote job ledger ────────────────────────────────────────

/** One row per Creator job that is a vision job on the box, so a poll survives an engine restart. */
export interface VisionRemoteRow { jobId: string; endpointId: string; remoteJobId: string; op: "decompose" | "upscale"; width: number; height: number; scale: number; artifactId?: string; settled?: boolean }

/** The last row for `jobId` in the append-only ledger text, or null. Torn lines cost one row. */
export function visionRemoteRow(jsonl: string, jobId: string): VisionRemoteRow | null {
  let found: VisionRemoteRow | null = null;
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r: unknown = JSON.parse(line);
      if (!isRecord(r) || r.jobId !== jobId) continue;
      if (typeof r.endpointId !== "string" || typeof r.remoteJobId !== "string" || !VISION_REMOTE_ID.test(r.remoteJobId)) continue;
      if (r.op !== "decompose" && r.op !== "upscale") continue;
      if (!finite(r.width) || !finite(r.height) || !finite(r.scale)) continue;
      found = {
        jobId, endpointId: r.endpointId, remoteJobId: r.remoteJobId, op: r.op, width: r.width, height: r.height, scale: r.scale,
        ...(typeof r.artifactId === "string" ? { artifactId: r.artifactId } : {}), ...(r.settled === true ? { settled: true } : {}),
      };
    } catch { /* torn line */ }
  }
  return found;
}

// ── the client ──────────────────────────────────────────────────────────────

export interface DgxVisionClientOptions {
  readonly baseUrl: string;
  readonly fetchImpl?: FetchLike;
  readonly timeouts?: Partial<Record<"health" | "sync" | "submit" | "job" | "artifact", number>>;
}

const DEFAULT_TIMEOUTS = { health: 8_000, sync: 300_000, submit: 60_000, job: 15_000, artifact: 300_000 };

async function readCapped(res: Response, max: number): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > max) return null;
  const buf = new Uint8Array(await res.arrayBuffer());
  return buf.length > max ? null : buf;
}

export class DgxVisionClient {
  readonly #base: string;
  readonly #fetch: FetchLike;
  readonly #t: typeof DEFAULT_TIMEOUTS;

  constructor(opts: DgxVisionClientOptions) {
    this.#base = opts.baseUrl.replace(/\/+$/, "");
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#t = { ...DEFAULT_TIMEOUTS, ...opts.timeouts };
  }

  get baseUrl(): string { return this.#base; }

  async #json(path: string, init: RequestInit, timeoutMs: number): Promise<ClientResult<unknown>> {
    let res: Response;
    try { res = await this.#fetch(`${this.#base}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) }); }
    catch { return { ok: false, error: `${this.#base} did not answer.` }; }
    let body: unknown = null;
    try {
      const bytes = await readCapped(res, VISION_MAX_RESPONSE_BYTES);
      if (!bytes) return { ok: false, status: res.status, error: "the vision service answered with more data than LUCID accepts." };
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch { body = null; }
    if (!res.ok) {
      const remote = isRecord(body) ? bounded(body.error) : "";
      if (res.status === 409) return { ok: false, status: 409, error: remote ? `the vision service is busy: ${remote}` : "the vision service queue is full; try again shortly." };
      return { ok: false, status: res.status, error: remote ? `the vision service answered ${res.status}: ${remote}` : `the vision service answered ${res.status}.` };
    }
    return { ok: true, data: body };
  }

  async health(): Promise<ClientResult<VisionHealth>> {
    const r = await this.#json("/health", { method: "GET" }, this.#t.health);
    if (!r.ok) return r;
    const h = parseVisionHealth(r.data);
    return h ? { ok: true, data: h } : { ok: false, error: `${this.#base} answered, but not as the dgx-vision service.` };
  }

  /** A synchronous op: POST /v1/<op> and validate the answer against the input image. */
  async run(op: Exclude<VisionOp, "decompose" | "upscale">, body: Record<string, unknown>, img: { width: number; height: number }): Promise<ClientResult<Record<string, unknown>>> {
    const r = await this.#json(`/v1/${op}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }, this.#t.sync);
    if (!r.ok) return r;
    const p = parseVisionResult(op, r.data, img);
    return p.ok ? p : { ok: false, error: p.error };
  }

  /** A job op: POST /v1/<op> returns `{ jobId }`. */
  async submit(op: "decompose" | "upscale", body: Record<string, unknown>): Promise<ClientResult<{ remoteJobId: string }>> {
    const r = await this.#json(`/v1/${op}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }, this.#t.submit);
    if (!r.ok) return r;
    const id = parseJobSubmit(r.data);
    return id ? { ok: true, data: { remoteJobId: id } } : { ok: false, error: `the ${op} submission did not return a job id.` };
  }

  async job(remoteJobId: string): Promise<ClientResult<VisionJobView>> {
    if (!VISION_REMOTE_ID.test(remoteJobId)) return { ok: false, error: "That is not a vision job id." };
    const r = await this.#json(`/v1/jobs/${remoteJobId}`, { method: "GET" }, this.#t.job);
    if (!r.ok) return r;
    const j = parseVisionJob(r.data);
    return j ? { ok: true, data: j } : { ok: false, error: "the job status was not in the expected shape." };
  }

  /** GET /v1/artifacts/{id}: a PNG of exactly `w` x `h`. */
  async artifact(id: string, w: number, h: number): Promise<ClientResult<{ bytes: Uint8Array }>> {
    if (!VISION_REMOTE_ID.test(id)) return { ok: false, error: "That is not a vision artifact id." };
    let res: Response;
    try { res = await this.#fetch(`${this.#base}/v1/artifacts/${id}`, { method: "GET", signal: AbortSignal.timeout(this.#t.artifact) }); }
    catch { return { ok: false, error: `${this.#base} did not answer the artifact download.` }; }
    if (!res.ok) return { ok: false, status: res.status, error: `the vision service answered ${res.status} for that artifact.` };
    const bytes = await readCapped(res, VISION_MAX_ARTIFACT_BYTES);
    if (!bytes) return { ok: false, error: "That artifact is over the download limit." };
    const info = pngInfo(bytes);
    if (!info) return { ok: false, error: "That artifact is not a PNG." };
    if (info.width !== w || info.height !== h) return { ok: false, error: `That artifact is ${info.width}x${info.height}, expected ${w}x${h}.` };
    return { ok: true, data: { bytes } };
  }
}
