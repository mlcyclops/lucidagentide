// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/creator/design/anim.ts - keyframe sampling and easing for the Motion mode.
//
// Easing follows CSS Easing Functions Level 1 (https://www.w3.org/TR/css-easing-1/): the named curves are
// the spec's cubic-bezier constants, and cubic-bezier(x1, y1, x2, y2) is solved for the curve parameter by
// Newton-Raphson with a bisection fallback (x1/x2 clamped to 0..1 as the spec requires). A keyframe's
// `ease` shapes the segment that STARTS at it; "hold" keeps its value until the next key.
//
// Transform convention (shared with the renderer and svg_export): a layer point p maps to the doc as
//   doc = (x + anchorX, y + anchorY) + R(rotation) * scale * (p - (anchorX, anchorY))
// with R = [cos -sin; sin cos], so positive degrees turn clockwise on a y-down screen (CSS rotate).
// Group transforms apply to their children (SVG nesting semantics).

import { DESIGN_LIMITS } from "./limits.ts";
import type { DesignDoc, Ease, LayerBase, Timeline, Track } from "./types.ts";

export type EaseFn = (t: number) => number;

const linear: EaseFn = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t);
const hold: EaseFn = (t) => (t >= 1 ? 1 : 0);

/** CSS cubic-bezier(x1, y1, x2, y2) as a progress -> output function. */
export function cubicBezierEase(x1: number, y1: number, x2: number, y2: number): EaseFn {
  if (!Number.isFinite(x1) || !Number.isFinite(y1) || !Number.isFinite(x2) || !Number.isFinite(y2)) return linear;
  const px1 = Math.min(1, Math.max(0, x1));
  const px2 = Math.min(1, Math.max(0, x2));
  if (px1 === y1 && px2 === y2) return linear;
  // Polynomial coefficients of B(s) with P0 = (0,0), P3 = (1,1).
  const cx = 3 * px1, bx = 3 * (px2 - px1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sampleX = (s: number): number => ((ax * s + bx) * s + cx) * s;
  const sampleY = (s: number): number => ((ay * s + by) * s + cy) * s;
  const slopeX = (s: number): number => (3 * ax * s + 2 * bx) * s + cx;
  const solve = (x: number): number => {
    let s = x;
    for (let i = 0; i < 8; i++) {
      const err = sampleX(s) - x;
      if (Math.abs(err) < 1e-7) return s;
      const d = slopeX(s);
      if (Math.abs(d) < 1e-6) break;
      s -= err / d;
    }
    let lo = 0, hi = 1;
    s = x;
    for (let i = 0; i < 60; i++) {
      const v = sampleX(s);
      if (Math.abs(v - x) < 1e-7) return s;
      if (x > v) lo = s; else hi = s;
      s = (lo + hi) / 2;
    }
    return s;
  };
  return (t) => (t <= 0 ? 0 : t >= 1 ? 1 : sampleY(solve(t)));
}

const EASE = cubicBezierEase(0.25, 0.1, 0.25, 1);
const EASE_IN = cubicBezierEase(0.42, 0, 1, 1);
const EASE_OUT = cubicBezierEase(0, 0, 0.58, 1);
const EASE_IN_OUT = cubicBezierEase(0.42, 0, 0.58, 1);

/** True for a well-formed Ease value (named, or a cubic with four finite numbers and x1/x2 in 0..1). */
export function isEase(e: unknown): e is Ease {
  if (e === "linear" || e === "hold" || e === "ease" || e === "ease-in" || e === "ease-out" || e === "ease-in-out") return true;
  if (typeof e !== "object" || e === null || Array.isArray(e) || !("cubic" in e)) return false;
  const c = e.cubic;
  if (!Array.isArray(c) || c.length !== 4 || !c.every((v) => typeof v === "number" && Number.isFinite(v))) return false;
  return c[0] >= 0 && c[0] <= 1 && c[2] >= 0 && c[2] <= 1 && Math.abs(c[1]) <= 10 && Math.abs(c[3]) <= 10;
}

/** The progress function for an Ease; malformed values fall back to linear. */
export function easeFn(e: Ease): EaseFn {
  // Explicit cases, no lookup by name: the name comes from the document, so it can never resolve to an
  // inherited member (`constructor`, `toString`) and be called as a curve.
  switch (e) {
    case "linear": return linear;
    case "hold": return hold;
    case "ease": return EASE;
    case "ease-in": return EASE_IN;
    case "ease-out": return EASE_OUT;
    case "ease-in-out": return EASE_IN_OUT;
  }
  if (typeof e === "string" || !isEase(e)) return linear;
  const [x1, y1, x2, y2] = e.cubic;
  return cubicBezierEase(x1, y1, x2, y2);
}

/** Value of a track at tMs (keys sorted by t). Before the first key: the first value; after the last: the
 *  last value; undefined when the track has no keys. */
export function sampleTrack(track: Track, tMs: number): number | undefined {
  const keys = track.keys;
  if (!keys.length) return undefined;
  const first = keys[0]!;
  if (!(tMs > first.t)) return first.v; // also catches NaN
  const last = keys[keys.length - 1]!;
  if (tMs >= last.t) return last.v;
  let lo = 0, hi = keys.length - 1; // invariant: keys[lo].t <= tMs < keys[hi].t
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (keys[mid]!.t <= tMs) lo = mid; else hi = mid;
  }
  const a = keys[lo]!, b = keys[hi]!;
  const span = b.t - a.t;
  if (span <= 0) return b.v;
  const p = easeFn(a.ease)((tMs - a.t) / span);
  return a.v + (b.v - a.v) * p;
}

export interface LayerState { x: number; y: number; scale: number; rotation: number; opacity: number }

/** Animated transform state of a layer at tMs: base layer props overridden by any tracks. A looping
 *  timeline wraps tMs into [0, durationMs). Unknown layer -> identity at the origin. */
export function layerStateAt(doc: DesignDoc, id: string, tMs: number): LayerState {
  const layer = Object.prototype.hasOwnProperty.call(doc.layers, id) ? doc.layers[id] : undefined;
  const state: LayerState = layer
    ? { x: layer.x, y: layer.y, scale: layer.scale, rotation: layer.rotation, opacity: layer.opacity }
    : { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 };
  const tl = doc.timeline;
  let t = Number.isFinite(tMs) ? tMs : 0;
  if (tl.loop && tl.durationMs > 0 && (t >= tl.durationMs || t < 0)) t = ((t % tl.durationMs) + tl.durationMs) % tl.durationMs;
  for (const track of tl.tracks) {
    if (track.layerId !== id) continue;
    const v = sampleTrack(track, t);
    if (v === undefined || !Number.isFinite(v)) continue;
    // Explicit cases, not state[track.prop]: the prop comes from the document, so an unknown name
    // (validation skipped somewhere upstream) is ignored instead of written onto the state object.
    switch (track.prop) {
      case "x": state.x = v; break;
      case "y": state.y = v; break;
      case "scale": state.scale = v; break;
      case "rotation": state.rotation = v; break;
      case "opacity": state.opacity = v; break;
    }
  }
  state.opacity = Math.min(1, Math.max(0, state.opacity));
  if (!(state.scale >= 0)) state.scale = 0;
  return state;
}

/** Sample times (ms) for rendering the timeline at its fps: [0, 1000/fps, ...) covering durationMs,
 *  at least one frame, at most DESIGN_LIMITS.maxFrames. */
export function frameTimes(tl: Timeline): number[] {
  const fps = Number.isFinite(tl.fps) ? Math.min(120, Math.max(1, tl.fps)) : 30;
  const dur = Number.isFinite(tl.durationMs) ? Math.max(0, tl.durationMs) : 0;
  const count = Math.max(1, Math.min(DESIGN_LIMITS.maxFrames, Math.ceil((dur * fps) / 1000 - 1e-9)));
  const step = 1000 / fps;
  const out: number[] = new Array(count);
  for (let i = 0; i < count; i++) out[i] = i * step;
  return out;
}

/** The layer's affine matrix [a, b, c, d, e, f] (canvas setTransform / SVG matrix order) for its base
 *  props, or for an animated `state` when given. */
export function layerMatrix(
  layer: Pick<LayerBase, "x" | "y" | "scale" | "rotation" | "anchorX" | "anchorY">,
  state?: Pick<LayerState, "x" | "y" | "scale" | "rotation">,
): [number, number, number, number, number, number] {
  const x = state ? state.x : layer.x;
  const y = state ? state.y : layer.y;
  const s = state ? state.scale : layer.scale;
  const r = ((state ? state.rotation : layer.rotation) * Math.PI) / 180;
  const cos = Math.cos(r) * s, sin = Math.sin(r) * s;
  const ax = layer.anchorX, ay = layer.anchorY;
  const a = cos, b = sin, c = -sin, d = cos;
  return [a, b, c, d, x + ax - (a * ax + c * ay), y + ay - (b * ax + d * ay)];
}
