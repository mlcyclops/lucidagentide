// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/viz_world_kit.ts - P-WORLDS.1 (ADR-0648): the WorldKit and WorldHost a Lucid Agent World is
// built with (viz_world_api.ts). The same finish as the built-in figures (viz_anime.ts): the stepped toon ramp
// (2 steps flat, 3 in 3D, nearest filtered, the same tones), the inverted-hull ink (back faces pushed out along
// the normals), three's RoundedBoxGeometry and mergeGeometries, sRGB canvas textures, the sponsor emblem painter
// (viz_brand.drawEmblem), a seeded generator, 1D value noise and the easings. The ramps and the ink materials are
// shared for the session (a world never disposes them; disposing one only frees its GPU program, which three
// rebuilds on next use).

import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { ANIME_HEIGHT } from "./viz_anime.ts";
import { drawEmblem } from "./viz_brand.ts";
import { CUBE } from "./viz_model.ts";
import { WORLD_API_VERSION, type WorldHost, type WorldKit } from "./viz_world_api.ts";

/** viz_anime.toonGrad's tones: 2 steps flat, 3 in 3D. */
const GRADS = new Map<number, THREE.DataTexture>();
function toonGrad(steps: 2 | 3): THREE.DataTexture {
  let tex = GRADS.get(steps);
  if (tex) return tex;
  const tones = steps === 2 ? [120, 255] : [80, 175, 255];
  const data = new Uint8Array(tones.length * 4);
  tones.forEach((t, i) => { data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = t; data[i * 4 + 3] = 255; });
  tex = new THREE.DataTexture(data, tones.length, 1, THREE.RGBAFormat);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  GRADS.set(steps, tex);
  return tex;
}

/** viz_anime.inkMat: the back faces pushed out along the normals by `width` (object space), shared per width. */
const INKS = new Map<number, THREE.MeshBasicMaterial>();
function ink(width: number): THREE.MeshBasicMaterial {
  let m = INKS.get(width);
  if (m) return m;
  m = new THREE.MeshBasicMaterial({ color: 0x0a0a12, side: THREE.BackSide, toneMapped: false });
  m.onBeforeCompile = (s) => {
    s.uniforms.uW = { value: width };
    s.vertexShader = "uniform float uW;\n" + s.vertexShader.replace("#include <begin_vertex>", "vec3 transformed = position + normal * uW;");
  };
  m.customProgramCacheKey = () => `world-ink-${width}`;
  INKS.set(width, m);
  return m;
}

/** mulberry32: a deterministic 0..1 generator. */
function random(seed: number): () => number {
  let a = (seed >>> 0) || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A hash of an integer lattice point to -1..1. */
function lattice(i: number): number {
  const h = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return (h - Math.floor(h)) * 2 - 1;
}

/** Smooth 1D value noise, -1..1. */
function noise1(x: number): number {
  const i = Math.floor(x), f = x - i;
  const u = f * f * (3 - 2 * f);
  return lattice(i) * (1 - u) + lattice(i + 1) * u;
}

const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);

const kit: WorldKit = {
  FIGURE_HEIGHT: ANIME_HEIGHT,
  CELL: CUBE,
  toon(p, flat) {
    const params: THREE.MeshToonMaterialParameters = { gradientMap: toonGrad(flat ? 2 : 3), toneMapped: false, color: p.color };
    if (p.map) params.map = p.map;
    if (p.emissive !== undefined) params.emissive = p.emissive;
    if (p.emissiveIntensity !== undefined) params.emissiveIntensity = p.emissiveIntensity;
    if (p.transparent !== undefined) params.transparent = p.transparent;
    if (p.opacity !== undefined) params.opacity = p.opacity;
    if (p.side !== undefined) params.side = p.side;
    return new THREE.MeshToonMaterial(params);
  },
  ink,
  outline(mesh, width) {
    const hull = new THREE.Mesh(mesh.geometry, ink(width));
    hull.name = "ink";
    mesh.add(hull);
    return hull;
  },
  roundedBox(w, h, d, segments, radius) { return new RoundedBoxGeometry(w, h, d, segments, radius); },
  // three's mergeGeometries refuses a mix of indexed and non-indexed parts, or parts with different attribute
  // sets. A world merges rounded boxes, lathes and tubes freely, so the kit evens them out first: all non-indexed
  // when any part is, and only the attributes every part has. The inputs are left untouched.
  merge(geos) {
    if (!geos.length) return null;
    const mixed = geos.some((g) => g.index) && geos.some((g) => !g.index);
    const parts = mixed ? geos.map((g) => (g.index ? g.toNonIndexed() : g)) : geos;
    const names = Object.keys(parts[0]!.attributes).filter((n) => parts.every((g) => g.getAttribute(n)));
    const even = parts.map((g) => {
      if (Object.keys(g.attributes).length === names.length && !g.morphAttributes.position) return g;
      const c = new THREE.BufferGeometry();
      for (const n of names) c.setAttribute(n, g.getAttribute(n));
      if (g.index) c.setIndex(g.index);
      return c;
    });
    const out = mergeGeometries(even, false);
    for (const g of even) if (!geos.includes(g)) g.dispose();
    for (const g of parts) if (!geos.includes(g) && !even.includes(g)) g.dispose();
    return out;
  },
  canvasTexture(width, height, paint) {
    const cv = document.createElement("canvas");
    cv.width = Math.max(1, Math.round(width));
    cv.height = Math.max(1, Math.round(height));
    const ctx = cv.getContext("2d");
    if (ctx) paint(ctx);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.anisotropy = 4;
    return tex;
  },
  drawEmblem(ctx, brand, x, y, size) { drawEmblem(ctx, brand, x, y, size, size, { word: true }); },
  random,
  noise1,
  ease: {
    inOut: (t) => { const x = clamp01(t); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; },
    out: (t) => 1 - Math.pow(1 - clamp01(t), 3),
    in: (t) => { const x = clamp01(t); return x * x * x; },
    back: (t) => { const x = clamp01(t), c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); },
  },
};

/** The host every world module's default export receives: three.js, the contract version and the kit. */
export function createWorldHost(): WorldHost {
  return Object.freeze({ THREE, apiVersion: WORLD_API_VERSION, kit });
}
