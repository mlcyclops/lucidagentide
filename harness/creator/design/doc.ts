// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/creator/design/doc.ts - DesignDoc creation, fail-closed validation, and the op reducer.
//
// Three trust boundaries meet here:
//   * validateDoc: a doc arriving from disk, the renderer, or the server is rebuilt field by field into a
//     fresh object (null-prototype maps, capped strings, finite numbers, valid ids). Anything unexpected
//     is a refusal, never a best-effort repair. Unknown extra fields are dropped by construction.
//   * validateOps: an agent's op batch is checked the same way before it is queued.
//   * applyOps: the reducer. Immutable (copy-on-write per touched layer), never throws, and enforces that
//     an agent edits STRUCTURE only (names, order, visibility, opacity, blend, transforms, labels, groups,
//     keyframes). Pixel work does not exist as an op; agents ask for it with a `request` op that the user
//     must approve in the UI, and applyOps only collects those, it never runs them.

import { isEase } from "./anim.ts";
import { isHexColor, normalizeColor } from "./color.ts";
import {
  DESIGN_LIMITS, DESIGN_MAX_POINTS_PER_STROKE, DESIGN_MAX_STROKES_PER_HINT, DESIGN_MAX_TEXT, DESIGN_OPS_BATCH_MAX,
} from "./limits.ts";
import {
  ANIM_PROPS, BLEND_MODES, HINT_INTENTS, REQUEST_KINDS,
  type AnimProp, type BrushStroke, type DesignDoc, type DesignOp, type Ease, type GroupLayer, type Keyframe, type Layer,
  type LayerBase, type LayerMeta, type MaskHint, type MaskRecord, type PathCmd, type Rect, type Timeline, type Track,
  type VPaint, type VShape,
} from "./types.ts";
import { cleanText, isFiniteNumber, isPlainRecord, isValidId, nullRecord } from "./util.ts";

const MAX_COORD = 1e7;
const MAX_PATH_COORD = 1e9;
const MAX_SCALE = 1000;
const MAX_ROTATION = 36_000;
const MAX_DURATION_MS = 3_600_000;
const MAX_TREE_DEPTH = 32;
const MAX_HINT_POINTS_TOTAL = 200_000;
const MAX_REQUEST_PARAMS = 32;

type RequestOp = Extract<DesignOp, { op: "request" }>;

/** Thrown internally with a "<path>: <reason>" message; never escapes the public functions. */
class Invalid extends Error {}
function fail(path: string, msg: string): never {
  throw new Invalid(`${path}: ${msg}`);
}
const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

// ── field readers ────────────────────────────────────────────────────────────

function rec(v: unknown, path: string): Record<string, unknown> {
  if (!isPlainRecord(v)) fail(path, "must be a plain object without prototype keys");
  return v as Record<string, unknown>; // isPlainRecord narrowed; the cast only survives the never-returning fail()
}
function arr(v: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(v)) fail(path, "must be an array");
  const a = v as unknown[];
  if (a.length > max) fail(path, `too many entries (max ${max})`);
  return a;
}
function num(v: unknown, path: string, lo: number, hi: number): number {
  if (!isFiniteNumber(v) || v < lo || v > hi) fail(path, `must be a finite number in ${lo}..${hi}`);
  return v as number;
}
function int(v: unknown, path: string, lo: number, hi: number): number {
  if (!Number.isInteger(v) || (v as number) < lo || (v as number) > hi) fail(path, `must be an integer in ${lo}..${hi}`);
  return v as number;
}
function bool(v: unknown, path: string): boolean {
  if (typeof v !== "boolean") fail(path, "must be a boolean");
  return v as boolean;
}
/** A string within `max` UTF-16 units, returned with control/bidi characters stripped. */
function str(v: unknown, path: string, max: number): string {
  if (typeof v !== "string") fail(path, "must be a string");
  if ((v as string).length > max) fail(path, `too long (max ${max})`);
  return cleanText(v, max);
}
function readId(v: unknown, path: string): string {
  if (!isValidId(v)) fail(path, "must match /^[A-Za-z0-9_-]{1,64}$/ and not be a prototype key");
  return v as string;
}
function oneOf<T extends string>(v: unknown, list: readonly T[], path: string): T {
  if (typeof v !== "string" || !(list as readonly string[]).includes(v)) fail(path, `must be one of ${list.join(", ")}`);
  return v as T;
}
function readRect(v: unknown, path: string): Rect {
  const o = rec(v, path);
  return {
    x: num(o.x, `${path}.x`, -MAX_COORD, MAX_COORD),
    y: num(o.y, `${path}.y`, -MAX_COORD, MAX_COORD),
    w: num(o.w, `${path}.w`, 0, MAX_COORD),
    h: num(o.h, `${path}.h`, 0, MAX_COORD),
  };
}
function readColor(v: unknown, path: string): string | null {
  if (v === null) return null;
  if (!isHexColor(v)) fail(path, "must be null, #rrggbb, or #rrggbbaa");
  return (v as string).toLowerCase();
}
function readEase(v: unknown, path: string): Ease {
  if (!isEase(v)) fail(path, "must be linear, hold, ease, ease-in, ease-out, ease-in-out, or { cubic: [x1, y1, x2, y2] }");
  const e = v as Ease;
  return typeof e === "string" ? e : { cubic: [e.cubic[0], e.cubic[1], e.cubic[2], e.cubic[3]] };
}
function checkArea(w: number, h: number, path: string): void {
  if (w * h > DESIGN_LIMITS.maxRasterPixels) fail(path, `area ${w}x${h} exceeds ${DESIGN_LIMITS.maxRasterPixels} px`);
}

// ── document pieces ──────────────────────────────────────────────────────────

interface Budget { shapes: number; cmds: number; hintPoints: number; keys: number }

function readCmd(v: unknown, path: string): PathCmd {
  const o = rec(v, path);
  const c = oneOf(o.c, ["M", "L", "C", "Q", "Z"] as const, `${path}.c`);
  const p = (k: string): number => num(o[k], `${path}.${k}`, -MAX_PATH_COORD, MAX_PATH_COORD);
  switch (c) {
    case "M": case "L": return { c, x: p("x"), y: p("y") };
    case "C": return { c, x1: p("x1"), y1: p("y1"), x2: p("x2"), y2: p("y2"), x: p("x"), y: p("y") };
    case "Q": return { c, x1: p("x1"), y1: p("y1"), x: p("x"), y: p("y") };
    case "Z": return { c };
  }
}

function readPaint(v: unknown, path: string): VPaint {
  const o = rec(v, path);
  const paint: VPaint = {
    fill: readColor(o.fill, `${path}.fill`),
    stroke: readColor(o.stroke, `${path}.stroke`),
    strokeWidth: num(o.strokeWidth, `${path}.strokeWidth`, 0, 10_000),
    opacity: num(o.opacity, `${path}.opacity`, 0, 1),
  };
  if (o.lineCap !== undefined) paint.lineCap = oneOf(o.lineCap, ["butt", "round", "square"] as const, `${path}.lineCap`);
  if (o.lineJoin !== undefined) paint.lineJoin = oneOf(o.lineJoin, ["miter", "round", "bevel"] as const, `${path}.lineJoin`);
  return paint;
}

function readShape(v: unknown, path: string, budget: Budget): VShape {
  const o = rec(v, path);
  const shape: VShape = {
    id: readId(o.id, `${path}.id`),
    kind: oneOf(o.kind, ["path", "rect", "ellipse", "text"] as const, `${path}.kind`),
    paint: readPaint(o.paint, `${path}.paint`),
  };
  if (o.d !== undefined) {
    const d = arr(o.d, `${path}.d`, DESIGN_LIMITS.maxPathCmds - budget.cmds);
    budget.cmds += d.length;
    shape.d = d.map((c, i) => readCmd(c, `${path}.d[${i}]`));
  }
  if (o.rect !== undefined) shape.rect = readRect(o.rect, `${path}.rect`);
  if (o.rx !== undefined) shape.rx = num(o.rx, `${path}.rx`, 0, MAX_COORD);
  if (o.text !== undefined) {
    const t = rec(o.text, `${path}.text`);
    shape.text = {
      content: str(t.content, `${path}.text.content`, DESIGN_MAX_TEXT),
      size: num(t.size, `${path}.text.size`, 0.1, 100_000),
      family: oneOf(t.family, ["sans-serif", "serif", "monospace"] as const, `${path}.text.family`),
    };
  }
  if (o.transform !== undefined) {
    const m = arr(o.transform, `${path}.transform`, 6);
    if (m.length !== 6) fail(`${path}.transform`, "must have 6 numbers");
    const n = m.map((x, i) => num(x, `${path}.transform[${i}]`, -MAX_PATH_COORD, MAX_PATH_COORD));
    shape.transform = [n[0]!, n[1]!, n[2]!, n[3]!, n[4]!, n[5]!];
  }
  if (shape.kind === "path" && !shape.d) fail(path, "a path shape needs d");
  if ((shape.kind === "rect" || shape.kind === "ellipse") && !shape.rect) fail(path, `a ${shape.kind} shape needs rect`);
  if (shape.kind === "text" && !shape.text) fail(path, "a text shape needs text");
  return shape;
}

function readMeta(v: unknown, path: string): LayerMeta {
  const o = rec(v, path);
  const meta: LayerMeta = {};
  if (o.source !== undefined) meta.source = oneOf(o.source, ["user", "decompose", "segment", "import", "agent"] as const, `${path}.source`);
  if (o.label !== undefined) meta.label = str(o.label, `${path}.label`, DESIGN_LIMITS.maxLabel);
  if (o.labelSource !== undefined) meta.labelSource = oneOf(o.labelSource, ["user", "model"] as const, `${path}.labelSource`);
  if (o.confidence !== undefined) meta.confidence = num(o.confidence, `${path}.confidence`, 0, 1);
  if (o.depth !== undefined) meta.depth = num(o.depth, `${path}.depth`, 0, 1);
  if (o.bbox !== undefined) meta.bbox = readRect(o.bbox, `${path}.bbox`);
  if (o.area !== undefined) meta.area = num(o.area, `${path}.area`, 0, 1e15);
  return meta;
}

function readLayer(v: unknown, path: string, budget: Budget): Layer {
  const o = rec(v, path);
  const kind = oneOf(o.kind, ["raster", "vector", "group"] as const, `${path}.kind`);
  const base: Omit<LayerBase, "kind"> = {
    id: readId(o.id, `${path}.id`),
    name: str(o.name, `${path}.name`, DESIGN_LIMITS.maxLabel),
    visible: bool(o.visible, `${path}.visible`),
    locked: bool(o.locked, `${path}.locked`),
    opacity: num(o.opacity, `${path}.opacity`, 0, 1),
    blend: oneOf(o.blend, BLEND_MODES, `${path}.blend`),
    x: num(o.x, `${path}.x`, -MAX_COORD, MAX_COORD),
    y: num(o.y, `${path}.y`, -MAX_COORD, MAX_COORD),
    scale: num(o.scale, `${path}.scale`, 0, MAX_SCALE),
    rotation: num(o.rotation, `${path}.rotation`, -MAX_ROTATION, MAX_ROTATION),
    anchorX: num(o.anchorX, `${path}.anchorX`, -MAX_COORD, MAX_COORD),
    anchorY: num(o.anchorY, `${path}.anchorY`, -MAX_COORD, MAX_COORD),
  };
  if (o.maskId !== undefined) base.maskId = readId(o.maskId, `${path}.maskId`);
  if (o.parentId !== undefined) base.parentId = readId(o.parentId, `${path}.parentId`);
  if (o.meta !== undefined) base.meta = readMeta(o.meta, `${path}.meta`);
  if (kind === "raster") {
    const width = int(o.width, `${path}.width`, 1, DESIGN_LIMITS.maxSide);
    const height = int(o.height, `${path}.height`, 1, DESIGN_LIMITS.maxSide);
    checkArea(width, height, path);
    return { ...base, kind, width, height };
  }
  if (kind === "vector") {
    const raw = arr(o.shapes, `${path}.shapes`, DESIGN_LIMITS.maxShapes - budget.shapes);
    budget.shapes += raw.length;
    const shapes = raw.map((s, i) => readShape(s, `${path}.shapes[${i}]`, budget));
    const seen = new Set<string>();
    for (const s of shapes) {
      if (seen.has(s.id)) fail(`${path}.shapes`, `duplicate shape id ${s.id}`);
      seen.add(s.id);
    }
    return { ...base, kind, shapes };
  }
  const children = arr(o.children, `${path}.children`, DESIGN_LIMITS.maxLayers).map((c, i) => readId(c, `${path}.children[${i}]`));
  return { ...base, kind, children };
}

function readMaskRecord(v: unknown, path: string): MaskRecord {
  const o = rec(v, path);
  const width = int(o.width, `${path}.width`, 1, DESIGN_LIMITS.maxSide);
  const height = int(o.height, `${path}.height`, 1, DESIGN_LIMITS.maxSide);
  checkArea(width, height, path);
  return {
    id: readId(o.id, `${path}.id`),
    x: int(o.x, `${path}.x`, -MAX_COORD, MAX_COORD),
    y: int(o.y, `${path}.y`, -MAX_COORD, MAX_COORD),
    width, height,
  };
}

function readStroke(v: unknown, path: string, budget: Budget): BrushStroke {
  const o = rec(v, path);
  const rawPts = arr(o.points, `${path}.points`, DESIGN_MAX_POINTS_PER_STROKE);
  budget.hintPoints += rawPts.length;
  if (budget.hintPoints > MAX_HINT_POINTS_TOTAL) fail(path, `hint strokes exceed ${MAX_HINT_POINTS_TOTAL} points in total`);
  const points = rawPts.map((p, i) => {
    const q = rec(p, `${path}.points[${i}]`);
    const pt: BrushStroke["points"][number] = {
      x: num(q.x, `${path}.points[${i}].x`, -MAX_COORD, MAX_COORD),
      y: num(q.y, `${path}.points[${i}].y`, -MAX_COORD, MAX_COORD),
    };
    if (q.p !== undefined) pt.p = num(q.p, `${path}.points[${i}].p`, 0, 1);
    return pt;
  });
  return {
    points,
    radius: num(o.radius, `${path}.radius`, 0.01, 4096),
    hardness: num(o.hardness, `${path}.hardness`, 0, 1),
    mode: oneOf(o.mode, ["add", "subtract"] as const, `${path}.mode`),
  };
}

function readHint(v: unknown, path: string, masks: Record<string, MaskRecord>, budget: Budget): MaskHint {
  const o = rec(v, path);
  const maskId = readId(o.maskId, `${path}.maskId`);
  if (!hasOwn(masks, maskId)) fail(`${path}.maskId`, "unknown mask");
  return {
    id: readId(o.id, `${path}.id`),
    maskId,
    label: str(o.label, `${path}.label`, DESIGN_LIMITS.maxLabel),
    intent: oneOf(o.intent, HINT_INTENTS, `${path}.intent`),
    strokes: arr(o.strokes, `${path}.strokes`, DESIGN_MAX_STROKES_PER_HINT).map((s, i) => readStroke(s, `${path}.strokes[${i}]`, budget)),
    bbox: readRect(o.bbox, `${path}.bbox`),
    area: num(o.area, `${path}.area`, 0, 1e15),
    createdAt: num(o.createdAt, `${path}.createdAt`, 0, 1e15),
  };
}

function readTimeline(v: unknown, path: string, layers: Record<string, Layer>, budget: Budget): Timeline {
  const o = rec(v, path);
  const durationMs = num(o.durationMs, `${path}.durationMs`, 0, MAX_DURATION_MS);
  const seen = new Set<string>();
  const tracks = arr(o.tracks, `${path}.tracks`, DESIGN_LIMITS.maxLayers * ANIM_PROPS.length).map((tv, ti): Track => {
    const tp = `${path}.tracks[${ti}]`;
    const t = rec(tv, tp);
    const layerId = readId(t.layerId, `${tp}.layerId`);
    if (!hasOwn(layers, layerId)) fail(`${tp}.layerId`, "unknown layer");
    const prop = oneOf(t.prop, ANIM_PROPS, `${tp}.prop`);
    const pair = `${layerId}\u0000${prop}`;
    if (seen.has(pair)) fail(tp, `duplicate track for ${layerId}.${prop}`);
    seen.add(pair);
    const rawKeys = arr(t.keys, `${tp}.keys`, DESIGN_LIMITS.maxKeys - budget.keys);
    budget.keys += rawKeys.length;
    let prevT = -1;
    const keys = rawKeys.map((kv, ki): Keyframe => {
      const kp = `${tp}.keys[${ki}]`;
      const k = rec(kv, kp);
      const key: Keyframe = {
        t: num(k.t, `${kp}.t`, 0, durationMs),
        v: num(k.v, `${kp}.v`, -MAX_PATH_COORD, MAX_PATH_COORD),
        ease: readEase(k.ease, `${kp}.ease`),
      };
      if (key.t <= prevT) fail(`${kp}.t`, "keys must be strictly increasing in t");
      prevT = key.t;
      return key;
    });
    return { layerId, prop, keys };
  });
  return {
    fps: num(o.fps, `${path}.fps`, 1, 120),
    durationMs,
    loop: bool(o.loop, `${path}.loop`),
    tracks,
  };
}

/** Every layer must hang off `order` exactly once through parent/children links that agree, with no
 *  cycles and bounded depth. Iterative, so a hostile deep tree cannot overflow the stack. */
function checkTree(layers: Record<string, Layer>, order: readonly string[]): void {
  for (const id of order) {
    if (!hasOwn(layers, id)) fail("doc.order", `unknown layer ${id}`);
    if (layers[id]!.parentId !== undefined) fail("doc.order", `${id} has a parentId, so it cannot be top-level`);
  }
  for (const id of Object.keys(layers)) {
    const l = layers[id]!;
    if (l.parentId !== undefined) {
      const p = hasOwn(layers, l.parentId) ? layers[l.parentId] : undefined;
      if (!p || p.kind !== "group" || !p.children.includes(id)) fail(`layers.${id}.parentId`, "must name a group that lists this layer");
    }
    if (l.kind === "group") {
      const seen = new Set<string>();
      for (const c of l.children) {
        if (seen.has(c)) fail(`layers.${id}.children`, `duplicate child ${c}`);
        seen.add(c);
        const child = hasOwn(layers, c) ? layers[c] : undefined;
        if (!child || child.parentId !== id) fail(`layers.${id}.children`, `${c} must exist and name this group as parentId`);
      }
    }
  }
  const visited = new Set<string>();
  const stack: [string, number][] = order.map((id) => [id, 1]);
  while (stack.length) {
    const [id, depth] = stack.pop()!;
    if (visited.has(id)) fail("doc.layers", `layer ${id} is reachable twice`);
    if (depth > MAX_TREE_DEPTH) fail("doc.layers", `group nesting deeper than ${MAX_TREE_DEPTH}`);
    visited.add(id);
    const l = layers[id]!;
    if (l.kind === "group") for (const c of l.children) stack.push([c, depth + 1]);
  }
  if (visited.size !== Object.keys(layers).length) fail("doc.layers", "every layer must be reachable from doc.order");
}

function readDoc(raw: unknown): DesignDoc {
  const o = rec(raw, "doc");
  if (o.version !== 1) fail("doc.version", "must be 1");
  const width = int(o.width, "doc.width", 1, DESIGN_LIMITS.maxSide);
  const height = int(o.height, "doc.height", 1, DESIGN_LIMITS.maxSide);
  checkArea(width, height, "doc");
  const budget: Budget = { shapes: 0, cmds: 0, hintPoints: 0, keys: 0 };

  const masksIn = rec(o.masks, "doc.masks");
  const maskKeys = Object.keys(masksIn);
  if (maskKeys.length > DESIGN_LIMITS.maxLayers) fail("doc.masks", `too many masks (max ${DESIGN_LIMITS.maxLayers})`);
  const masks = nullRecord<MaskRecord>();
  for (const k of maskKeys) {
    const m = readMaskRecord(masksIn[k], `masks.${readId(k, "doc.masks key")}`);
    if (m.id !== k) fail(`masks.${k}.id`, "must equal its key");
    masks[k] = m;
  }

  const layersIn = rec(o.layers, "doc.layers");
  const layerKeys = Object.keys(layersIn);
  if (layerKeys.length > DESIGN_LIMITS.maxLayers) fail("doc.layers", `too many layers (max ${DESIGN_LIMITS.maxLayers})`);
  const layers = nullRecord<Layer>();
  for (const k of layerKeys) {
    const l = readLayer(layersIn[k], `layers.${readId(k, "doc.layers key")}`, budget);
    if (l.id !== k) fail(`layers.${k}.id`, "must equal its key");
    if (l.maskId !== undefined && !hasOwn(masks, l.maskId)) fail(`layers.${k}.maskId`, "unknown mask");
    layers[k] = l;
  }

  const order = arr(o.order, "doc.order", DESIGN_LIMITS.maxLayers).map((v, i) => readId(v, `doc.order[${i}]`));
  checkTree(layers, order);

  const hints = arr(o.hints, "doc.hints", DESIGN_LIMITS.maxHints).map((h, i) => readHint(h, `hints[${i}]`, masks, budget));
  const hintIds = new Set<string>();
  for (const h of hints) {
    if (hintIds.has(h.id)) fail("doc.hints", `duplicate hint id ${h.id}`);
    hintIds.add(h.id);
  }

  return {
    version: 1,
    id: readId(o.id, "doc.id"),
    name: str(o.name, "doc.name", DESIGN_LIMITS.maxLabel),
    width, height,
    background: o.background === null || o.background === undefined ? null : readColor(o.background, "doc.background"),
    layers, order, masks, hints,
    timeline: readTimeline(o.timeline, "doc.timeline", layers, budget),
  };
}

/** Fail-closed structural validation. Returns a freshly built doc (null-prototype maps, cleaned strings),
 *  never the input object. */
export function validateDoc(raw: unknown): { ok: true; doc: DesignDoc } | { ok: false; error: string } {
  try {
    return { ok: true, doc: readDoc(raw) };
  } catch (e) {
    return { ok: false, error: e instanceof Invalid ? e.message : "doc: malformed document" };
  }
}

// ── creation ─────────────────────────────────────────────────────────────────

/** `<prefix>_<10 base36 chars>`; the prefix is reduced to [A-Za-z0-9_-] and 16 chars. */
export function newId(prefix: string): string {
  let p = "";
  for (const ch of typeof prefix === "string" ? prefix : "") {
    if (/^[A-Za-z0-9_-]$/.test(ch)) p += ch;
    if (p.length >= 16) break;
  }
  if (!p) p = "id";
  const bytes = new Uint8Array(10);
  const c = globalThis.crypto;
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  let r = "";
  for (const b of bytes) r += (b % 36).toString(36);
  return `${p}_${r}`;
}

/** A blank document. Throws on dimensions outside the limits or an unparsable background color. */
export function createDoc(name: string, width: number, height: number, background?: string | null): DesignDoc {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > DESIGN_LIMITS.maxSide || height > DESIGN_LIMITS.maxSide) {
    throw new Error(`createDoc: width and height must be integers in 1..${DESIGN_LIMITS.maxSide}`);
  }
  if (width * height > DESIGN_LIMITS.maxRasterPixels) throw new Error(`createDoc: area exceeds ${DESIGN_LIMITS.maxRasterPixels} px`);
  let bg: string | null = null;
  if (background !== undefined && background !== null) {
    bg = normalizeColor(background);
    if (bg === null) throw new Error("createDoc: background must be a #hex or rgb()/rgba() color");
  }
  return {
    version: 1,
    id: newId("doc"),
    name: cleanText(name, DESIGN_LIMITS.maxLabel) || "Untitled",
    width, height, background: bg,
    layers: nullRecord<Layer>(),
    order: [],
    masks: nullRecord<MaskRecord>(),
    hints: [],
    timeline: { fps: 30, durationMs: 3000, loop: true, tracks: [] },
  };
}

/** Layers bottom -> top with groups expanded (a group precedes its children), each with its tree depth
 *  (0 = top-level) and z (index in this list). Cycle-safe and iterative. */
export function flattenLayers(doc: DesignDoc): { layer: Layer; depth: number; z: number }[] {
  const out: { layer: Layer; depth: number; z: number }[] = [];
  const seen = new Set<string>();
  const stack: [string, number][] = [];
  for (let i = doc.order.length - 1; i >= 0; i--) stack.push([doc.order[i]!, 0]);
  while (stack.length && out.length < DESIGN_LIMITS.maxLayers) {
    const [id, depth] = stack.pop()!;
    if (seen.has(id) || !hasOwn(doc.layers, id)) continue;
    seen.add(id);
    const layer = doc.layers[id]!;
    out.push({ layer, depth, z: out.length });
    if (layer.kind === "group" && depth < MAX_TREE_DEPTH) {
      for (let i = layer.children.length - 1; i >= 0; i--) stack.push([layer.children[i]!, depth + 1]);
    }
  }
  return out;
}

// ── ops ──────────────────────────────────────────────────────────────────────

/** Op names that would touch pixels. None are DesignOps; they get a specific refusal for agents. */
const PIXEL_OPS: ReadonlySet<string> = new Set([
  "paint", "erase", "fill", "brush", "draw", "pixels", "set-pixels", "write-pixels", "replace-pixels", "write-tile",
  "mask", "set-mask", "stroke", "crop", "resize", "filter", "adjust", "import-image", "set-raster",
]);

function readOp(v: unknown, path: string): DesignOp {
  const o = rec(v, path);
  if (typeof o.op !== "string") fail(path, "op must be a string");
  const name = o.op as string;
  if (PIXEL_OPS.has(name)) fail(path, `pixel edits are not design ops (${name})`);
  const p = `${path} (${name})`;
  const id = (): string => readId(o.id, `${p}.id`);
  const coord = (k: string): number => num(o[k], `${p}.${k}`, -MAX_COORD, MAX_COORD);
  switch (name) {
    case "rename": {
      const n = str(o.name, `${p}.name`, DESIGN_LIMITS.maxLabel);
      if (!n.trim()) fail(`${p}.name`, "must not be empty");
      return { op: "rename", id: id(), name: n };
    }
    case "visible": return { op: "visible", id: id(), value: bool(o.value, `${p}.value`) };
    case "opacity": return { op: "opacity", id: id(), value: num(o.value, `${p}.value`, 0, 1) };
    case "blend": return { op: "blend", id: id(), value: oneOf(o.value, BLEND_MODES, `${p}.value`) };
    case "reorder": return { op: "reorder", id: id(), index: int(o.index, `${p}.index`, 0, DESIGN_LIMITS.maxLayers) };
    case "move": return { op: "move", id: id(), x: coord("x"), y: coord("y") };
    case "transform": {
      const op: Extract<DesignOp, { op: "transform" }> = { op: "transform", id: id() };
      if (o.scale !== undefined) op.scale = num(o.scale, `${p}.scale`, 0, MAX_SCALE);
      if (o.rotation !== undefined) op.rotation = num(o.rotation, `${p}.rotation`, -MAX_ROTATION, MAX_ROTATION);
      if (op.scale === undefined && op.rotation === undefined) fail(p, "needs scale and/or rotation");
      return op;
    }
    case "label": return { op: "label", id: id(), label: str(o.label, `${p}.label`, DESIGN_LIMITS.maxLabel) };
    case "delete": return { op: "delete", id: id() };
    case "group": {
      const ids = arr(o.ids, `${p}.ids`, DESIGN_LIMITS.maxLayers).map((x, i) => readId(x, `${p}.ids[${i}]`));
      if (!ids.length) fail(`${p}.ids`, "must not be empty");
      if (new Set(ids).size !== ids.length) fail(`${p}.ids`, "must not repeat");
      const n = str(o.name, `${p}.name`, DESIGN_LIMITS.maxLabel);
      return { op: "group", ids, name: n.trim() ? n : "Group" };
    }
    case "ungroup": return { op: "ungroup", id: id() };
    case "keyframe": {
      const op: Extract<DesignOp, { op: "keyframe" }> = {
        op: "keyframe", id: id(),
        prop: oneOf(o.prop, ANIM_PROPS, `${p}.prop`),
        t: num(o.t, `${p}.t`, 0, MAX_DURATION_MS),
        v: num(o.v, `${p}.v`, -MAX_COORD, MAX_COORD),
      };
      if (o.ease !== undefined) op.ease = readEase(o.ease, `${p}.ease`);
      return op;
    }
    case "clear-keyframes": {
      const op: Extract<DesignOp, { op: "clear-keyframes" }> = { op: "clear-keyframes", id: id() };
      if (o.prop !== undefined) op.prop = oneOf(o.prop, ANIM_PROPS, `${p}.prop`);
      return op;
    }
    case "request": {
      const op: RequestOp = { op: "request", kind: oneOf(o.kind, REQUEST_KINDS, `${p}.kind`) };
      if (o.target !== undefined) op.target = readId(o.target, `${p}.target`);
      if (o.params !== undefined) {
        const raw = rec(o.params, `${p}.params`);
        const keys = Object.keys(raw);
        if (keys.length > MAX_REQUEST_PARAMS) fail(`${p}.params`, `too many params (max ${MAX_REQUEST_PARAMS})`);
        // Plain object is safe: every key passed readId, which refuses __proto__/constructor/prototype.
        const params: Record<string, number | string | boolean> = {};
        for (const k of keys) {
          const kp = `${p}.params.${readId(k, `${p}.params key`)}`;
          const val = raw[k];
          if (typeof val === "boolean") params[k] = val;
          else if (typeof val === "number") params[k] = num(val, kp, -MAX_PATH_COORD, MAX_PATH_COORD);
          else if (typeof val === "string") params[k] = str(val, kp, DESIGN_LIMITS.maxLabel);
          else fail(kp, "must be a number, string, or boolean");
        }
        op.params = params;
      }
      return op;
    }
    default:
      return fail(path, `unknown op ${cleanText(name, 40)}`);
  }
}

/** Validate an op batch from the wire (agent tools, server queue): capped at DESIGN_OPS_BATCH_MAX,
 *  every op rebuilt from known fields only. Fail-closed: one bad op refuses the batch. */
export function validateOps(raw: unknown): { ok: true; ops: DesignOp[] } | { ok: false; error: string } {
  try {
    const list = arr(raw, "ops", DESIGN_OPS_BATCH_MAX);
    return { ok: true, ops: list.map((v, i) => readOp(v, `op ${i}`)) };
  } catch (e) {
    return { ok: false, error: e instanceof Invalid ? e.message : "ops: malformed batch" };
  }
}

/** Shallow working copy: new maps/arrays, layer objects replaced (never mutated) when touched. */
function beginEdit(doc: DesignDoc): DesignDoc {
  const layers = nullRecord<Layer>();
  for (const k of Object.keys(doc.layers)) layers[k] = doc.layers[k]!;
  return { ...doc, layers, order: [...doc.order], timeline: { ...doc.timeline, tracks: [...doc.timeline.tracks] } };
}

function getLayer(doc: DesignDoc, id: string, path: string): Layer {
  if (!hasOwn(doc.layers, id)) fail(path, `unknown layer ${id}`);
  return doc.layers[id]!;
}

function siblings(doc: DesignDoc, parentId: string | undefined): string[] {
  if (parentId === undefined) return doc.order;
  const p = doc.layers[parentId];
  return p && p.kind === "group" ? p.children : [];
}

function setSiblings(doc: DesignDoc, parentId: string | undefined, list: string[]): void {
  if (parentId === undefined) { doc.order = list; return; }
  const p = doc.layers[parentId];
  if (p && p.kind === "group") doc.layers[parentId] = { ...p, children: list };
}

function ancestorDepth(doc: DesignDoc, id: string | undefined): number {
  let d = 0;
  for (let cur = id; cur !== undefined && d <= MAX_TREE_DEPTH + 1; d++) cur = doc.layers[cur]?.parentId;
  return d;
}

function subtreeHeight(doc: DesignDoc, id: string): number {
  let max = 0;
  const stack: [string, number][] = [[id, 1]];
  while (stack.length) {
    const [cur, h] = stack.pop()!;
    if (h > max) max = h;
    const l = doc.layers[cur];
    if (l && l.kind === "group" && h <= MAX_TREE_DEPTH) for (const c of l.children) stack.push([c, h + 1]);
  }
  return max;
}

function descendants(doc: DesignDoc, id: string): Set<string> {
  const out = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    if (out.has(cur)) continue;
    out.add(cur);
    const l = doc.layers[cur];
    if (l && l.kind === "group") stack.push(...l.children);
  }
  return out;
}

function keyRange(prop: AnimProp, v: number, path: string): void {
  if (prop === "opacity" && (v < 0 || v > 1)) fail(path, "opacity keys must be in 0..1");
  if (prop === "scale" && (v < 0 || v > MAX_SCALE)) fail(path, `scale keys must be in 0..${MAX_SCALE}`);
  if (prop === "rotation" && Math.abs(v) > MAX_ROTATION) fail(path, `rotation keys must be within +-${MAX_ROTATION}`);
}

function countKeys(doc: DesignDoc): number {
  let n = 0;
  for (const t of doc.timeline.tracks) n += t.keys.length;
  return n;
}

/** Ops that change geometry or existence. A locked layer refuses them for every actor; agents are
 *  refused EVERY op on a locked layer. */
const LOCK_GUARDED: ReadonlySet<string> = new Set(["move", "transform", "delete", "keyframe", "clear-keyframes", "ungroup"]);

function applyOne(doc: DesignDoc, op: Exclude<DesignOp, RequestOp>, actor: "user" | "agent", path: string): void {
  const guard = (l: Layer): void => {
    if (l.locked && (actor === "agent" || LOCK_GUARDED.has(op.op))) fail(path, `layer ${l.id} is locked`);
  };
  switch (op.op) {
    case "rename": case "visible": case "opacity": case "blend": case "move": case "transform": case "label": {
      const l = getLayer(doc, op.id, path);
      guard(l);
      let next: Layer;
      // A name written by an agent is model output: the layer's source flips to "agent" (unless it already
      // came from a model or file) so the agent manifest moves the name into its untrusted field.
      if (op.op === "rename") {
        next = actor === "agent" && (l.meta?.source === undefined || l.meta.source === "user")
          ? { ...l, name: op.name, meta: { ...l.meta, source: "agent" } }
          : { ...l, name: op.name };
      }
      else if (op.op === "visible") next = { ...l, visible: op.value };
      else if (op.op === "opacity") next = { ...l, opacity: op.value };
      else if (op.op === "blend") next = { ...l, blend: op.value };
      else if (op.op === "move") next = { ...l, x: op.x, y: op.y };
      else if (op.op === "transform") next = { ...l, scale: op.scale ?? l.scale, rotation: op.rotation ?? l.rotation };
      // A label written by an agent is model output, so it is marked untrusted like any model label.
      else next = { ...l, meta: { ...l.meta, label: op.label, labelSource: actor === "agent" ? "model" : "user" } };
      doc.layers[op.id] = next;
      return;
    }
    case "reorder": {
      const l = getLayer(doc, op.id, path);
      guard(l);
      const list = siblings(doc, l.parentId).filter((x) => x !== op.id);
      list.splice(Math.min(op.index, list.length), 0, op.id);
      setSiblings(doc, l.parentId, list);
      return;
    }
    case "delete": {
      const l = getLayer(doc, op.id, path);
      guard(l);
      const gone = descendants(doc, op.id);
      if (actor === "agent") for (const d of gone) if (doc.layers[d]?.locked) fail(path, `descendant ${d} is locked`);
      setSiblings(doc, l.parentId, siblings(doc, l.parentId).filter((x) => x !== op.id));
      for (const d of gone) delete doc.layers[d];
      doc.timeline = { ...doc.timeline, tracks: doc.timeline.tracks.filter((t) => !gone.has(t.layerId)) };
      return;
    }
    case "group": {
      const members = op.ids.map((id) => getLayer(doc, id, path));
      const parentId = members[0]!.parentId;
      for (const m of members) {
        if (m.parentId !== parentId) fail(path, "grouped layers must share one parent");
        if (actor === "agent" && m.locked) fail(path, `layer ${m.id} is locked`);
      }
      if (Object.keys(doc.layers).length + 1 > DESIGN_LIMITS.maxLayers) fail(path, `layer cap ${DESIGN_LIMITS.maxLayers} reached`);
      let height = 0;
      for (const m of members) height = Math.max(height, subtreeHeight(doc, m.id));
      if (ancestorDepth(doc, parentId) + 1 + height > MAX_TREE_DEPTH) fail(path, `group nesting deeper than ${MAX_TREE_DEPTH}`);
      const list = siblings(doc, parentId);
      const memberSet = new Set(op.ids);
      const ordered = list.filter((x) => memberSet.has(x));
      let topPos = -1;
      for (let i = 0; i < list.length; i++) if (memberSet.has(list[i]!)) topPos = i;
      const rest: string[] = [];
      let insertAt = 0;
      for (let i = 0; i < list.length; i++) {
        if (memberSet.has(list[i]!)) continue;
        if (i < topPos) insertAt++;
        rest.push(list[i]!);
      }
      let gid = newId("group");
      while (hasOwn(doc.layers, gid)) gid = newId("group");
      rest.splice(insertAt, 0, gid);
      const group: GroupLayer = {
        id: gid, name: op.name, kind: "group", visible: true, locked: false, opacity: 1, blend: "normal",
        x: 0, y: 0, scale: 1, rotation: 0, anchorX: 0, anchorY: 0, children: ordered,
        meta: { source: actor === "agent" ? "agent" : "user" },
      };
      if (parentId !== undefined) group.parentId = parentId;
      doc.layers[gid] = group;
      for (const m of members) doc.layers[m.id] = { ...m, parentId: gid };
      setSiblings(doc, parentId, rest);
      return;
    }
    case "ungroup": {
      const g = getLayer(doc, op.id, path);
      if (g.kind !== "group") fail(path, `${op.id} is not a group`);
      guard(g);
      const grp = g as GroupLayer;
      if (grp.scale !== 1 || grp.rotation !== 0) fail(path, "reset the group's scale and rotation before ungrouping");
      if (doc.timeline.tracks.some((t) => t.layerId === grp.id)) fail(path, "clear the group's keyframes before ungrouping");
      if (actor === "agent") for (const c of grp.children) if (doc.layers[c]?.locked) fail(path, `child ${c} is locked`);
      const kids = new Set(grp.children);
      for (const c of grp.children) {
        const child = doc.layers[c];
        if (!child) continue;
        const next: Layer = {
          ...child, x: child.x + grp.x, y: child.y + grp.y,
          opacity: child.opacity * grp.opacity, visible: child.visible && grp.visible,
        };
        if (grp.parentId === undefined) delete next.parentId; else next.parentId = grp.parentId;
        doc.layers[c] = next;
      }
      // Child x/y/opacity tracks move with the baked group transform.
      doc.timeline = {
        ...doc.timeline,
        tracks: doc.timeline.tracks.map((t) => {
          if (!kids.has(t.layerId) || (t.prop !== "x" && t.prop !== "y" && t.prop !== "opacity")) return t;
          const shift = (v: number): number => (t.prop === "x" ? v + grp.x : t.prop === "y" ? v + grp.y : v * grp.opacity);
          return { ...t, keys: t.keys.map((k) => ({ ...k, v: shift(k.v) })) };
        }),
      };
      const list = siblings(doc, grp.parentId);
      const at = list.indexOf(grp.id);
      const merged = list.filter((x) => x !== grp.id);
      merged.splice(at < 0 ? merged.length : at, 0, ...grp.children.filter((c) => hasOwn(doc.layers, c)));
      delete doc.layers[grp.id];
      setSiblings(doc, grp.parentId, merged);
      return;
    }
    case "keyframe": {
      const l = getLayer(doc, op.id, path);
      guard(l);
      if (op.t > doc.timeline.durationMs) fail(path, `t ${op.t} is past the timeline duration ${doc.timeline.durationMs}`);
      keyRange(op.prop, op.v, path);
      const ti = doc.timeline.tracks.findIndex((t) => t.layerId === op.id && t.prop === op.prop);
      const keys = ti >= 0 ? [...doc.timeline.tracks[ti]!.keys] : [];
      const key: Keyframe = { t: op.t, v: op.v, ease: op.ease ?? "linear" };
      let at = 0;
      while (at < keys.length && keys[at]!.t < op.t) at++;
      if (at < keys.length && keys[at]!.t === op.t) keys[at] = key;
      else {
        if (countKeys(doc) + 1 > DESIGN_LIMITS.maxKeys) fail(path, `keyframe cap ${DESIGN_LIMITS.maxKeys} reached`);
        keys.splice(at, 0, key);
      }
      const track: Track = { layerId: op.id, prop: op.prop, keys };
      const tracks = [...doc.timeline.tracks];
      if (ti >= 0) tracks[ti] = track; else tracks.push(track);
      doc.timeline = { ...doc.timeline, tracks };
      return;
    }
    case "clear-keyframes": {
      const l = getLayer(doc, op.id, path);
      guard(l);
      doc.timeline = {
        ...doc.timeline,
        tracks: doc.timeline.tracks.filter((t) => !(t.layerId === op.id && (op.prop === undefined || t.prop === op.prop))),
      };
      return;
    }
  }
}

/** Apply ops to a (valid) doc without mutating it. Never throws: each refused op adds one error and is
 *  skipped atomically. `request` ops are only collected for the UI's approval prompt. Agents may edit
 *  structure only, never pixels, and never touch locked layers. */
export function applyOps(
  doc: DesignDoc,
  ops: DesignOp[],
  actor: "user" | "agent",
): { doc: DesignDoc; applied: number; errors: string[]; requests: RequestOp[] } {
  const errors: string[] = [];
  const requests: RequestOp[] = [];
  let applied = 0;
  const who: "user" | "agent" = actor === "user" ? "user" : "agent"; // anything unexpected gets the stricter rules
  let next: DesignDoc;
  try {
    next = beginEdit(doc);
  } catch {
    return { doc, applied: 0, errors: ["doc: malformed document"], requests };
  }
  const list: unknown[] = Array.isArray(ops) ? ops : [];
  if (!Array.isArray(ops)) errors.push("ops: must be an array");
  if (list.length > DESIGN_OPS_BATCH_MAX) errors.push(`ops: batch capped at ${DESIGN_OPS_BATCH_MAX}, ${list.length - DESIGN_OPS_BATCH_MAX} op(s) ignored`);
  for (let i = 0; i < Math.min(list.length, DESIGN_OPS_BATCH_MAX); i++) {
    const raw = list[i];
    try {
      if (who === "agent" && isPlainRecord(raw) && typeof raw.op === "string" && PIXEL_OPS.has(raw.op)) {
        fail(`op ${i}`, `agents may not edit pixels (${raw.op}); ask with a request op instead`);
      }
      const op = readOp(raw, `op ${i}`);
      if (op.op === "request") { requests.push(op); continue; }
      // Each op runs against a scratch copy so a refusal midway leaves no partial edit behind.
      const scratch = beginEdit(next);
      applyOne(scratch, op, who, `op ${i} (${op.op})`);
      next = scratch;
      applied++;
    } catch (e) {
      errors.push(e instanceof Invalid ? e.message : `op ${i}: failed`);
    }
  }
  return { doc: next, applied, errors, requests };
}
