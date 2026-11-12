// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/creator/design/types.ts - the shared DesignDoc model (contract section 1).
//
// Pure types only. Every module in harness/creator/design/ runs in the renderer main thread, in Web
// Workers, and in Bun tests, so nothing here (or anywhere in this folder) touches the DOM, fs, or node:*.

export type BlendMode = "normal" | "multiply" | "screen" | "overlay" | "darken" | "lighten" | "color-dodge" | "color-burn" | "hard-light" | "soft-light" | "difference" | "exclusion" | "hue" | "saturation" | "color" | "luminosity";
export interface Rect { x: number; y: number; w: number; h: number }
/** Straight (non-premultiplied) RGBA8, row-major, `rgba.length === width * height * 4`. */
export interface RasterData { width: number; height: number; rgba: Uint8ClampedArray }
/** 0..255 coverage, row-major, `alpha.length === width * height`. */
export interface MaskData { width: number; height: number; alpha: Uint8Array }
export type LayerKind = "raster" | "vector" | "group";
export interface LayerMeta {
  source?: "user" | "decompose" | "segment" | "import" | "agent";
  /** Display label; when labelSource === "model" it is UNTRUSTED. */
  label?: string;
  labelSource?: "user" | "model";
  /** 0..1 */
  confidence?: number;
  /** 0 near .. 1 far (from depth model), for ordering. */
  depth?: number;
  /** In doc pixels. */
  bbox?: Rect; area?: number;
}
export interface LayerBase {
  id: string; name: string; kind: LayerKind; visible: boolean; locked: boolean;
  /** 0..1 */
  opacity: number;
  blend: BlendMode;
  /** Offset of layer origin in doc px. */
  x: number; y: number;
  /** Uniform scale, degrees; about (anchorX, anchorY) in layer px. */
  scale: number; rotation: number;
  anchorX: number; anchorY: number;
  maskId?: string; parentId?: string; meta?: LayerMeta;
}
/** Pixels live in a TileStore keyed by layer id. */
export interface RasterLayer extends LayerBase { kind: "raster"; width: number; height: number }
export type PathCmd =
  | { c: "M"; x: number; y: number } | { c: "L"; x: number; y: number }
  | { c: "C"; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { c: "Q"; x1: number; y1: number; x: number; y: number } | { c: "Z" };
/** Colors are #rrggbb or #rrggbbaa only. */
export interface VPaint { fill: string | null; stroke: string | null; strokeWidth: number; opacity: number; lineCap?: "butt" | "round" | "square"; lineJoin?: "miter" | "round" | "bevel" }
export interface VShape { id: string; kind: "path" | "rect" | "ellipse" | "text"; d?: PathCmd[]; rect?: Rect; rx?: number; text?: { content: string; size: number; family: "sans-serif" | "serif" | "monospace" }; paint: VPaint; transform?: [number, number, number, number, number, number] }
export interface VectorLayer extends LayerBase { kind: "vector"; shapes: VShape[] }
export interface GroupLayer extends LayerBase { kind: "group"; children: string[] }
export type Layer = RasterLayer | VectorLayer | GroupLayer;
/** Pixels live in a TileStore keyed "mask:" + id. */
export interface MaskRecord { id: string; x: number; y: number; width: number; height: number }
export interface BrushStroke { points: { x: number; y: number; p?: number }[]; radius: number; hardness: number; mode: "add" | "subtract" }
/** What the USER traced and typed; the agent's instruction source. */
export interface MaskHint {
  id: string; maskId: string; label: string; intent: "isolate" | "remove" | "keep" | "refine";
  strokes: BrushStroke[]; bbox: Rect; area: number; createdAt: number;
}
export type Ease = "linear" | "hold" | "ease" | "ease-in" | "ease-out" | "ease-in-out" | { cubic: [number, number, number, number] };
export type AnimProp = "x" | "y" | "scale" | "rotation" | "opacity";
/** t in ms. */
export interface Keyframe { t: number; v: number; ease: Ease }
export interface Track { layerId: string; prop: AnimProp; keys: Keyframe[] }
export interface Timeline { fps: number; durationMs: number; loop: boolean; tracks: Track[] }
export interface DesignDoc {
  version: 1; id: string; name: string; width: number; height: number; background: string | null;
  /** Build with Object.create(null). */
  layers: Record<string, Layer>;
  /** Top-level ids, bottom -> top. */
  order: string[];
  masks: Record<string, MaskRecord>;
  hints: MaskHint[]; timeline: Timeline;
}
export type DesignOp =
  | { op: "rename"; id: string; name: string } | { op: "visible"; id: string; value: boolean }
  | { op: "opacity"; id: string; value: number } | { op: "blend"; id: string; value: BlendMode }
  | { op: "reorder"; id: string; index: number } | { op: "move"; id: string; x: number; y: number }
  | { op: "transform"; id: string; scale?: number; rotation?: number }
  | { op: "label"; id: string; label: string } | { op: "delete"; id: string }
  | { op: "group"; ids: string[]; name: string } | { op: "ungroup"; id: string }
  | { op: "keyframe"; id: string; prop: AnimProp; t: number; v: number; ease?: Ease }
  | { op: "clear-keyframes"; id: string; prop?: AnimProp }
  | { op: "request"; kind: "decompose" | "segment-hint" | "matte" | "upscale" | "vectorize" | "label"; target?: string; params?: Record<string, number | string | boolean> };

export const BLEND_MODES: readonly BlendMode[] = [
  "normal", "multiply", "screen", "overlay", "darken", "lighten", "color-dodge", "color-burn",
  "hard-light", "soft-light", "difference", "exclusion", "hue", "saturation", "color", "luminosity",
];
export const ANIM_PROPS: readonly AnimProp[] = ["x", "y", "scale", "rotation", "opacity"];
export const HINT_INTENTS: readonly MaskHint["intent"][] = ["isolate", "remove", "keep", "refine"];
export const REQUEST_KINDS: readonly Extract<DesignOp, { op: "request" }>["kind"][] = [
  "decompose", "segment-hint", "matte", "upscale", "vectorize", "label",
];
