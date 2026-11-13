// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/scene_kit.ts
//
// P-SEASON.1 (ADR-0525): the shared contract and drawing kit for the animated seasonal backdrops.
//
// A scene is a STATELESS painter: every moving thing is a closed-form function of (seed, index, t),
// wrapped modulo the canvas, so a resize, a dropped frame, or a tab that slept for an hour can never
// leave a scene in a bad state, and a frame at any t can be rendered on demand (the reduced-motion
// still and the settings thumbnail are just paint(t = fixed)). Static layers that are expensive to
// rebuild (ridgelines, skylines, dunes) are cached per (scene, season, w, h) with `layerCache`.
//
// Budget: one paint at 1920x1080 CSS px must stay well under 4 ms on an integrated GPU. No
// per-frame ctx.filter blur, no shadowBlur in particle loops, no getImageData.

import type { SceneId, SeasonId } from "./seasons.ts";

/** Everything a scene may read for one frame. Sizes are CSS px; the context is pre-scaled by dpr. */
export interface SceneFrame {
  ctx: CanvasRenderingContext2D;
  w: number;
  h: number;
  /** Milliseconds since the backdrop mounted (monotonic, starts at 0). */
  t: number;
  /** The season the scene is painting for (null in a scene-only preview); scenes vary colors by it. */
  season: SeasonId | null;
}

export interface SceneDef {
  id: SceneId;
  /** One-line picker label, must not wrap (invariant 11). */
  label: string;
  paint(f: SceneFrame): void;
}

/** Deterministic hash of an integer (and optional salt) to [0, 1). */
export function hash01(i: number, salt = 0): number {
  let x = Math.imul((i | 0) ^ Math.imul(salt | 0, 0x9e3779b1), 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

/** Smooth 1-D value noise in [0, 1): cosine-interpolated hashed lattice. */
export function noise1(x: number, salt = 0): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = (1 - Math.cos(f * Math.PI)) / 2;
  return hash01(i, salt) * (1 - u) + hash01(i + 1, salt) * u;
}

/** Fractal (multi-octave) 1-D noise in roughly [0, 1). */
export function fbm1(x: number, octaves = 4, salt = 0): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let freq = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise1(x * freq, salt + o * 101);
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / norm;
}

/** Positive modulo: wrap a drifting coordinate into [0, m). */
export function wrap(v: number, m: number): number {
  return ((v % m) + m) % m;
}

/** A vertical sky gradient across the whole frame. Stops are [offset 0..1, css color]. */
export function sky(f: SceneFrame, stops: readonly (readonly [number, string])[]): void {
  const g = f.ctx.createLinearGradient(0, 0, 0, f.h);
  for (const [o, c] of stops) g.addColorStop(o, c);
  f.ctx.fillStyle = g;
  f.ctx.fillRect(0, 0, f.w, f.h);
}

/** A soft radial glow (sun, moon halo, floodlight, lantern). `color` is an `r g b` triplet. */
export function glow(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, rgb: string, alpha: number): void {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, `rgb(${rgb} / ${alpha})`);
  g.addColorStop(1, `rgb(${rgb} / 0)`);
  ctx.fillStyle = g;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
}

/** Fill a silhouette under a noise ridgeline: baseY +- amp, `scale` px per noise unit. */
export function ridge(ctx: CanvasRenderingContext2D, w: number, h: number, baseY: number, amp: number, scale: number, salt: number, fill: string | CanvasGradient, octaves = 4): void {
  ctx.beginPath();
  ctx.moveTo(0, h);
  for (let x = 0; x <= w + 8; x += 8) ctx.lineTo(x, baseY - (fbm1(x / scale, octaves, salt) - 0.5) * 2 * amp);
  ctx.lineTo(w, h);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}

/** A gliding bird silhouette (gull, dove, eagle, bat): two arcs whose tips beat with `flap` (0..1).
 *  `span` is the wingspan in px; a positive `dir` faces right. */
export function bird(ctx: CanvasRenderingContext2D, x: number, y: number, span: number, flap: number, fill: string, dir = 1): void {
  const s = span / 2;
  const lift = Math.sin(flap * Math.PI * 2) * s * 0.42;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(dir, 1);
  ctx.beginPath();
  ctx.moveTo(-s, -lift);
  ctx.quadraticCurveTo(-s * 0.45, -s * 0.28 - lift * 0.4, 0, 0);
  ctx.quadraticCurveTo(s * 0.45, -s * 0.28 - lift * 0.4, s, -lift);
  ctx.quadraticCurveTo(s * 0.5, -s * 0.06, s * 0.12, s * 0.16);
  ctx.lineTo(-s * 0.12, s * 0.16);
  ctx.quadraticCurveTo(-s * 0.5, -s * 0.06, -s, -lift);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.restore();
}

const layers = new Map<string, HTMLCanvasElement | OffscreenCanvas>();
const LAYER_SIZES = 3;

/** Cache an expensive static layer per key + size. `draw` receives a context already sized to (w, h)
 *  in CSS px at `dpr`; the returned canvas is meant for `ctx.drawImage(layer, 0, 0, w, h)`. The cache
 *  keeps the LAYER_SIZES most recently used sizes per key: the same scene can paint at two sizes at once
 *  (the chat backdrop and the Settings preview tile), and one slot would rebuild both every frame, while
 *  a window resize still never accumulates stale bitmaps. */
export function layerCache(key: string, w: number, h: number, dpr: number, draw: (ctx: CanvasRenderingContext2D) => void): CanvasImageSource {
  const full = `${key}@${w}x${h}x${dpr}`;
  const hit = layers.get(full);
  if (hit) {
    layers.delete(full); // Map order is insertion order: re-insert to mark it most recently used
    layers.set(full, hit);
    return hit;
  }
  const same = [...layers.keys()].filter((k) => k.startsWith(`${key}@`));
  for (const k of same.slice(0, Math.max(0, same.length - LAYER_SIZES + 1))) layers.delete(k);
  const pw = Math.max(1, Math.round(w * dpr));
  const ph = Math.max(1, Math.round(h * dpr));
  const canvas: HTMLCanvasElement | OffscreenCanvas = typeof OffscreenCanvas !== "undefined"
    ? new OffscreenCanvas(pw, ph)
    : Object.assign(document.createElement("canvas"), { width: pw, height: ph });
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
  ctx.scale(dpr, dpr);
  draw(ctx);
  layers.set(full, canvas);
  return canvas;
}

/** The dpr a scene's context is scaled by, for layerCache keys. */
export function frameDpr(f: SceneFrame): number {
  return f.ctx.getTransform().a || 1;
}
