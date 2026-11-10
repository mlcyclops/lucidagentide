// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/scenes/beach.ts
//
// P-SEASON.1 (ADR-0525): golden-hour beach. A low sun over the sea lays a twinkling glitter path to the
// shore; waves crest, run up the sand with a foam lip, slide back and leave a wet band that slowly dries;
// gulls glide and dune grass leans in the breeze. Labor Day paints it later, with the sun touching the
// sea and the first stars out. The sky, sun, sea, sand and dune are one cached layer; everything that
// moves is closed-form in t.

import { bird, frameDpr, glow, hash01, layerCache, noise1, wrap, type SceneDef, type SceneFrame } from "../scene_kit.ts";

type Stops = readonly (readonly [number, string])[];

interface Look {
  sky: Stops;
  sea: Stops;
  /** Sun centre above the horizon, in sun radii (negative = partly set). */
  sunLift: number;
  sunRgb: string;
  cloudRgb: string;
  glint: string;
  sand: readonly [string, string, string];
  dune: readonly [string, string];
  wetRgb: string;
  ink: string;
  stars: number;
}

const GOLDEN: Look = {
  sky: [[0, "#34457a"], [0.3, "#6f6596"], [0.58, "#d8907e"], [0.82, "#f7bd7e"], [1, "#ffdca0"]],
  sea: [[0, "#f6c891"], [0.06, "#d9a48c"], [0.3, "#7b7f98"], [0.7, "#41607f"], [1, "#2f4f6d"]],
  sunLift: 1.6,
  sunRgb: "255 196 120",
  cloudRgb: "255 206 160",
  glint: "#fff4d6",
  sand: ["#a77a5a", "#c99a6c", "#e0b583"],
  dune: ["#a87650", "#6e4a33"],
  wetRgb: "92 62 48",
  ink: "#3a2c36",
  stars: 0,
};

const EVENING: Look = {
  sky: [[0, "#1b2150"], [0.32, "#46397a"], [0.6, "#a9577a"], [0.84, "#ec8259"], [1, "#ffae66"]],
  sea: [[0, "#f1a16e"], [0.06, "#c27a7c"], [0.32, "#5c5a80"], [0.7, "#2d4466"], [1, "#22385a"]],
  sunLift: 0.2,
  sunRgb: "255 150 90",
  cloudRgb: "248 150 140",
  glint: "#ffd9b0",
  sand: ["#8a6152", "#a8785e", "#c08f6c"],
  dune: ["#8a5e48", "#53372d"],
  wetRgb: "70 46 46",
  ink: "#2a2034",
  stars: 1,
};

const TAU = Math.PI * 2;
const ease = (x: number): number => x * x * (3 - 2 * x);

/** The resting waterline: slightly tilted so the beach reads as a shore, not a stripe. */
function shoreY(x: number, w: number, h: number): number {
  return h * 0.69 + (x / w) * h * 0.022;
}

/** The dune crest, a cubic from the left edge down to the bottom; s in [0,1]. */
function duneAt(s: number, w: number, h: number): [number, number] {
  const u = 1 - s;
  const x = 3 * u * u * s * w * 0.13 + 3 * u * s * s * w * 0.24 + s * s * s * w * 0.38;
  const y = u * u * u * h * 0.79 + 3 * u * u * s * h * 0.765 + 3 * u * s * s * h * 0.86 + s * s * s * h * 1.0;
  return [x, y];
}

function paintStatic(c: CanvasRenderingContext2D, w: number, h: number, L: Look): void {
  const hz = h * 0.5;
  let g = c.createLinearGradient(0, 0, 0, hz);
  for (const [o, col] of L.sky) g.addColorStop(o, col);
  c.fillStyle = g;
  c.fillRect(0, 0, w, hz + 1);

  const sr = Math.min(w, h) * 0.05;
  const sx = w * 0.64;
  const sy = hz - sr * L.sunLift;
  glow(c, sx, sy, h * 0.95, L.sunRgb, 0.4);
  glow(c, sx, sy, sr * 5, "255 232 190", 0.45);
  const sg = c.createRadialGradient(sx, sy, 0, sx, sy, sr);
  sg.addColorStop(0, "#fffdf2");
  sg.addColorStop(0.55, "#ffeab0");
  sg.addColorStop(1, "#ffbf6a");
  c.fillStyle = sg;
  c.beginPath();
  c.arc(sx, sy, sr, 0, TAU);
  c.fill();

  // Two hazy headlands on the left horizon.
  for (const [x1, hgt, col] of [[w * 0.42, h * 0.03, "rgb(150 104 132 / 0.55)"], [w * 0.27, h * 0.05, "rgb(104 74 104 / 0.8)"]] as const) {
    c.beginPath();
    c.moveTo(0, hz + 1);
    for (let x = 0; x <= x1; x += 6) {
      const s = 1 - x / x1;
      c.lineTo(x, hz - hgt * Math.pow(s, 0.55) * (0.75 + 0.25 * noise1(x / 60, 5)));
    }
    c.lineTo(x1, hz + 1);
    c.fillStyle = col;
    c.fill();
  }

  // Sea, with the sun's soft reflection column.
  const seaBot = h * 0.72;
  g = c.createLinearGradient(0, hz, 0, seaBot);
  for (const [o, col] of L.sea) g.addColorStop(o, col);
  c.fillStyle = g;
  c.fillRect(0, hz, w, h - hz);
  c.save();
  c.beginPath();
  c.rect(0, hz, w, seaBot - hz);
  c.clip();
  c.translate(sx, hz);
  c.scale(0.3, 1);
  glow(c, 0, 0, h * 0.26, L.sunRgb, 0.4);
  c.restore();
  g = c.createLinearGradient(0, hz, 0, hz + 3);
  g.addColorStop(0, "rgb(255 240 210 / 0.5)");
  g.addColorStop(1, "rgb(255 240 210 / 0)");
  c.fillStyle = g;
  c.fillRect(0, hz, w, 3);

  // Sand.
  c.beginPath();
  c.moveTo(0, shoreY(0, w, h));
  for (let x = 12; x <= w + 12; x += 12) c.lineTo(x, shoreY(x, w, h));
  c.lineTo(w, h);
  c.lineTo(0, h);
  c.closePath();
  g = c.createLinearGradient(0, h * 0.69, 0, h);
  g.addColorStop(0, L.sand[0]);
  g.addColorStop(0.3, L.sand[1]);
  g.addColorStop(1, L.sand[2]);
  c.fillStyle = g;
  c.fill();
  c.save();
  c.clip();
  c.translate(sx, h * 0.8);
  c.scale(2.6, 1);
  glow(c, 0, 0, h * 0.26, L.sunRgb, 0.16);
  c.restore();
  // Wind ripples: soft paired shadow and highlight curves, widening toward the viewer.
  for (let i = 0; i < 34; i++) {
    const d = Math.pow((i + hash01(i, 4)) / 34, 1.6);
    const y0 = h * 0.76 + d * h * 0.24;
    const x0 = hash01(i, 5) * w * 1.2 - w * 0.2;
    const len = w * (0.15 + 0.3 * hash01(i, 6)) * (0.5 + d);
    const amp = 2 + d * 6;
    for (const [dy, col] of [[0, "rgb(90 58 44 / 0.1)"], [1.5 + d * 2, "rgb(255 232 196 / 0.12)"]] as const) {
      c.beginPath();
      for (let x = 0; x <= len; x += 10) {
        const y = y0 + dy + Math.sin(x / len * Math.PI) * -amp + Math.sin(x * 0.02 + i) * amp * 0.4;
        if (x === 0) c.moveTo(x0 + x, y);
        else c.lineTo(x0 + x, y);
      }
      c.strokeStyle = col;
      c.lineWidth = 1 + d * 2.5;
      c.stroke();
    }
  }

  // Backlit dune in the left foreground with a rim of sunlight on its crest.
  c.beginPath();
  c.moveTo(0, h);
  for (let i = 0; i <= 40; i++) {
    const [x, y] = duneAt(i / 40, w, h);
    c.lineTo(x, y);
  }
  c.lineTo(0, h);
  c.closePath();
  g = c.createLinearGradient(0, h * 0.77, 0, h);
  g.addColorStop(0, L.dune[0]);
  g.addColorStop(1, L.dune[1]);
  c.fillStyle = g;
  c.fill();
  c.beginPath();
  for (let i = 0; i <= 40; i++) {
    const [x, y] = duneAt(i / 40, w, h);
    if (i === 0) c.moveTo(x, y);
    else c.lineTo(x, y);
  }
  c.strokeStyle = `rgb(${L.sunRgb} / 0.45)`;
  c.lineWidth = 1.5;
  c.stroke();

  // Fine grain over sand and dune, cached so it costs nothing per frame.
  for (let i = 0; i < 3200; i++) {
    const x = hash01(i, 1) * w;
    const y0 = shoreY(x, w, h);
    const y = y0 + 6 + Math.pow(hash01(i, 2), 0.8) * (h - y0);
    c.fillStyle = hash01(i, 3) < 0.5 ? "rgb(255 236 200 / 0.16)" : "rgb(70 44 34 / 0.14)";
    const s = 0.8 + (y / h) * 1.4;
    c.fillRect(x, y, s, s * 0.7);
  }
}

function edgePath(c: CanvasRenderingContext2D, w: number, h: number, y: (x: number) => number, back: boolean): void {
  const step = 10;
  if (!back) {
    for (let x = 0; x <= w + step; x += step) c.lineTo(x, y(x));
  } else {
    for (let x = Math.ceil(w / step) * step + step; x >= 0; x -= step) c.lineTo(x, y(x));
  }
}

function paintWaves(f: SceneFrame, L: Look): void {
  const { ctx, w, h, t } = f;
  const P = 9500;
  const cyc = t / P;
  const n = Math.floor(cyc);
  const p = cyc - n;
  const reach = h * 0.07;
  const shore = (x: number): number => shoreY(x, w, h);
  const edge = (x: number, k: number, s: number): number =>
    shore(x) + reach * (0.55 + 0.45 * hash01(k, 7)) * s * (0.6 + 0.8 * noise1(x / 230 + k * 3.1, 11));

  const sx = w * 0.64;
  const wetFill = (alpha: number): CanvasGradient => {
    const g = ctx.createLinearGradient(sx - w * 0.2, 0, sx + w * 0.2, 0);
    g.addColorStop(0, `rgb(${L.wetRgb} / ${alpha})`);
    g.addColorStop(0.5, `rgb(${L.sunRgb} / ${alpha * 0.55})`);
    g.addColorStop(1, `rgb(${L.wetRgb} / ${alpha})`);
    return g;
  };
  const band = (k: number, s: number, alpha: number): void => {
    if (alpha < 0.01 || s <= 0) return;
    ctx.beginPath();
    ctx.moveTo(0, shore(0) - 1);
    edgePath(ctx, w, h, (x) => shore(x) - 1, false);
    edgePath(ctx, w, h, (x) => edge(x, k, s), true);
    ctx.closePath();
    ctx.fillStyle = wetFill(alpha);
    ctx.fill();
    ctx.beginPath();
    edgePath(ctx, w, h, (x) => edge(x, k, s), false);
    ctx.strokeStyle = `rgb(255 244 228 / ${alpha * 0.4})`;
    ctx.lineWidth = 1.2;
    ctx.stroke();
  };

  // Previous wave's wet band drying out, then this wave's.
  band(n - 1, 1, 0.5 * (1 - ease(Math.min(1, p / 0.85))));
  const SW = 0.35;
  if (p >= SW) {
    const q = (p - SW) / (1 - SW);
    const s = q < 0.32 ? 1 - (1 - q / 0.32) * (1 - q / 0.32) : 1 - ease((q - 0.32) / 0.68);
    band(n, q < 0.32 ? s : 1, 0.5);

    // The thin water sheet itself.
    ctx.beginPath();
    ctx.moveTo(0, shore(0) - 2);
    edgePath(ctx, w, h, (x) => shore(x) - 2, false);
    edgePath(ctx, w, h, (x) => edge(x, n, s), true);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, h * 0.69, 0, h * 0.69 + reach * 1.4 + h * 0.022);
    g.addColorStop(0, "rgb(60 92 120 / 0.92)");
    g.addColorStop(0.45, "rgb(104 146 156 / 0.6)");
    g.addColorStop(1, "rgb(170 206 200 / 0.4)");
    ctx.fillStyle = g;
    ctx.fill();

    // Foam lip: a soft body and a crisp leading line, thinning as the wave slides back.
    const foamA = q < 0.32 ? 0.9 : 0.9 - 0.6 * ease((q - 0.32) / 0.68);
    ctx.beginPath();
    edgePath(ctx, w, h, (x) => edge(x, n, s) - 3, false);
    ctx.strokeStyle = `rgb(255 250 240 / ${foamA * 0.3})`;
    ctx.lineWidth = 6;
    ctx.stroke();
    ctx.beginPath();
    edgePath(ctx, w, h, (x) => edge(x, n, s), false);
    ctx.strokeStyle = `rgb(255 252 244 / ${foamA})`;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = `rgb(255 252 244 / ${foamA * 0.7})`;
    for (let i = 0; i < 70; i++) {
      const x = hash01(i + n * 97, 21) * w;
      const y = edge(x, n, s) - 2 - hash01(i, 22) * (6 + 10 * s);
      const r = 1 + hash01(i, 23) * 1.6;
      ctx.fillRect(x, y, r * 1.6, r);
    }
  } else {
    // Resting lap line while the next crest rolls in.
    ctx.beginPath();
    edgePath(ctx, w, h, (x) => shore(x) - 1, false);
    ctx.strokeStyle = "rgb(255 250 240 / 0.35)";
    ctx.lineWidth = 1.4;
    ctx.stroke();
  }

  // Incoming crests: the one about to break and a faint one forming behind it.
  const yB = h * 0.645;
  const crest = (from: number, to: (x: number) => number, c: number, k: number, alpha: number, lw: number): void => {
    ctx.beginPath();
    edgePath(ctx, w, h, (x) => from + (to(x) - from) * c + 3 * Math.sin(x * 0.008 + k * 2.3) + 4 * noise1(x / 180 + k, 31), false);
    ctx.strokeStyle = `rgb(255 248 236 / ${alpha})`;
    ctx.lineWidth = lw;
    ctx.stroke();
  };
  if (p < SW) {
    const c = ease(p / SW);
    crest(yB, shore, c, n, 0.2 + 0.55 * c, 1.2 + 2.4 * c);
  }
  crest(h * 0.6, () => yB, ease(p), n + 1, 0.06 + 0.16 * p, 1 + p);
}

function paintSea(f: SceneFrame, L: Look): void {
  const { ctx, w, h, t } = f;
  const hz = h * 0.5;
  const depth = h * 0.685 - hz;
  // Swell lines drifting shoreward, spaced by perspective.
  ctx.fillStyle = "rgb(255 236 214 / 1)";
  for (let k = 0; k < 18; k++) {
    const pp = wrap(k / 18 + t / 70000, 1);
    const y = hz + depth * pp * pp;
    ctx.globalAlpha = 0.04 + 0.08 * pp;
    for (let j = 0; j < 9; j++) {
      const len = (40 + hash01(k * 31 + j, 41) * 160) * (0.3 + pp);
      const x = wrap(hash01(k * 31 + j, 42) * w + t * 0.003 * (hash01(j, 43) - 0.5), w + len) - len;
      ctx.fillRect(x, y, len, 0.8 + pp * 1.4);
    }
  }

  // Glitter path under the sun.
  const sr = Math.min(w, h) * 0.05;
  const sx = w * 0.64;
  const gl = L.sunLift > 1 ? 1 : 0.7;
  ctx.fillStyle = L.glint;
  for (let r = 0; r < 64; r++) {
    const pr = (r + 0.5) / 64;
    const y = hz + 1 + (h * 0.69 - hz) * Math.pow(pr, 1.7);
    const half = sr * 0.7 + pr * w * 0.09;
    for (let g = 0; g < 6; g++) {
      const id = r * 13 + g;
      const u = hash01(id, 51) * 2 - 1;
      const x = sx + u * Math.abs(u) * half;
      const tw = Math.sin(t * 0.0025 * (0.6 + hash01(id, 52)) + hash01(id, 53) * TAU);
      if (tw <= 0.2) continue;
      const a = Math.pow((tw - 0.2) / 0.8, 3) * (1 - Math.abs(u) * 0.7) * gl;
      const len = (2 + hash01(id, 54) * 10) * (0.4 + pr * 1.6);
      ctx.globalAlpha = a;
      ctx.fillRect(x - len / 2, y, len, 0.8 + pr * 1.2);
    }
  }
  ctx.globalAlpha = 1;
}

function paintSky(f: SceneFrame, L: Look): void {
  const { ctx, w, h, t } = f;
  const hz = h * 0.5;
  if (L.stars) {
    ctx.fillStyle = "#fff6ea";
    for (let i = 0; i < 40; i++) {
      const y = hash01(i, 61) * hz * 0.45;
      ctx.globalAlpha = (0.25 + 0.35 * Math.sin(t * 0.0012 * (0.5 + hash01(i, 62)) + i)) * (1 - y / (hz * 0.45));
      if (ctx.globalAlpha > 0) ctx.fillRect(hash01(i, 63) * w, y, 1.4, 1.4);
    }
    ctx.globalAlpha = 1;
  }
  // Long, thin lit cloud streaks drifting across the sun.
  for (let i = 0; i < 6; i++) {
    const rw = w * (0.1 + 0.16 * hash01(i, 71));
    const cx = wrap(hash01(i, 72) * w + t * 0.005 * (0.5 + hash01(i, 73)), w + rw * 2) - rw;
    const cy = hz * (0.18 + 0.68 * hash01(i, 74));
    const rh = 4 + 9 * hash01(i, 75);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(1, rh / rw);
    glow(ctx, 0, 0, rw, L.cloudRgb, 0.22 + 0.2 * (cy / hz));
    ctx.restore();
  }
  // Gulls.
  for (let i = 0; i < 4; i++) {
    const v = 0.012 + 0.01 * hash01(i, 81);
    const x = wrap(hash01(i, 82) * w + t * v, w + 300) - 150;
    const y = h * (0.14 + 0.2 * hash01(i, 83)) + Math.sin(t * 0.00035 + i * 2) * 14;
    const span = 18 + 16 * hash01(i, 84);
    const beat = Math.sin(t * 0.00045 + i * 3) > 0.75;
    const flap = beat ? t * 0.0028 + i : 0.04 * Math.sin(t * 0.0016 + i * 2);
    bird(ctx, x, y, span, flap, L.ink, 1);
  }
}

function paintGrass(f: SceneFrame, L: Look): void {
  const { ctx, w, h, t } = f;
  ctx.beginPath();
  for (let i = 0; i < 70; i++) {
    const s = 0.04 + hash01(i, 91) * 0.62;
    const [bx, by] = duneAt(s, w, h);
    const len = h * (0.04 + 0.07 * hash01(i, 92)) * (1 - s * 0.6);
    const lean = 0.25 + 0.35 * hash01(i, 93) + 0.12 * Math.sin(t * 0.0009 + bx * 0.012) + 0.05 * Math.sin(t * 0.0023 + i);
    const tx = bx + Math.sin(lean) * len;
    const ty = by + 2 - Math.cos(lean) * len;
    ctx.moveTo(bx - 1.5, by + 3);
    ctx.quadraticCurveTo(bx + (tx - bx) * 0.3, by - len * 0.55, tx, ty);
    ctx.quadraticCurveTo(bx + (tx - bx) * 0.3 + 1, by - len * 0.5, bx + 1.5, by + 3);
  }
  ctx.fillStyle = L.ink;
  ctx.fill();
}

export const scene: SceneDef = {
  id: "beach",
  label: "Golden beach",
  paint(f: SceneFrame): void {
    const { ctx, w, h } = f;
    const L = f.season === "labor-day" ? EVENING : GOLDEN;
    const layer = layerCache(`beach:${L === EVENING ? "eve" : "gold"}`, w, h, frameDpr(f), (c) => paintStatic(c, w, h, L));
    ctx.drawImage(layer, 0, 0, w, h);
    paintSky(f, L);
    paintSea(f, L);
    paintWaves(f, L);
    paintGrass(f, L);
  },
};
