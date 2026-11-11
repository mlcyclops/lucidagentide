// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/scenes/yosemite.ts
//
// P-SEASON.1 (ADR-0525): a granite valley at golden hour, composed like the classic tunnel view: a
// great El Capitan-like monolith on the left, a Half Dome-like dome far off centre-right, spired
// cathedral rocks with a ribbon waterfall on the right, and pine forest on the valley floor. Each
// distance is its own cached layer tinted toward the sky (atmospheric perspective); slow fog bands
// drift between them, sun rays break through, and two or three bald eagles (dark body, white head
// and tail) soar in slow, wide circles. Memorial Day reads late-spring gold; Veterans Day a deeper
// autumn amber.

import type { SeasonId } from "../seasons.ts";
import { fbm1, frameDpr, glow, hash01, layerCache, noise1, wrap, type SceneDef, type SceneFrame } from "../scene_kit.ts";

interface Look {
  sky: [number, string][];
  sun: string;      // `r g b`
  far: string[];    // two far ranges
  dome: string;     // the backlit dome's shadowed granite
  cliff: [string, string];
  forest: [string, string]; // near, mid
  fog: string;      // `r g b`
}

function look(season: SeasonId | null): Look {
  if (season === "veterans-day") {
    return {
      sky: [[0, "#26304f"], [0.28, "#4f5677"], [0.5, "#a08488"], [0.66, "#e2a46e"], [0.78, "#f2b977"]],
      sun: "255 200 130",
      far: ["#a0889a", "#7f6f88"],
      dome: "#5f5674",
      cliff: ["#4d4558", "#c08a62"],
      forest: ["#161a1c", "#2a2e2c"],
      fog: "246 214 186",
    };
  }
  return {
    sky: [[0, "#2c4570"], [0.28, "#5b7397"], [0.5, "#b4a9a4"], [0.66, "#ecc28c"], [0.78, "#f6cf8e"]],
    sun: "255 218 150",
    far: ["#9a99b0", "#7a7c98"],
    dome: "#575e7c",
    cliff: ["#474c5e", "#c49a72"],
    forest: ["#141c1c", "#26322e"],
    fog: "246 226 204",
  };
}

const SUN = { x: 0.7, y: 0.36 };

/** A rough granite edge: jitter a polyline with fine noise so the silhouettes are not vector-smooth. */
function roughTo(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, rough: number, salt: number): void {
  const steps = Math.max(2, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 6));
  const nx = -(y1 - y0);
  const ny = x1 - x0;
  const nl = Math.hypot(nx, ny) || 1;
  for (let i = 1; i <= steps; i++) {
    const k = i / steps;
    const j = i === steps ? 0 : (fbm1(k * 6 + salt, 3, salt) - 0.5) * rough;
    ctx.lineTo(x0 + (x1 - x0) * k + (nx / nl) * j, y0 + (y1 - y0) * k + (ny / nl) * j);
  }
}

/** Fill a polygon of fractional points with rough edges. */
function rock(ctx: CanvasRenderingContext2D, w: number, h: number, pts: number[][], rough: number, salt: number): void {
  ctx.beginPath();
  ctx.moveTo(pts[0][0] * w, pts[0][1] * h);
  for (let i = 1; i < pts.length; i++) roughTo(ctx, pts[i - 1][0] * w, pts[i - 1][1] * h, pts[i][0] * w, pts[i][1] * h, rough, salt + i * 7);
  ctx.closePath();
}

/** A band of conifers: jagged pointed crowns along a baseline from x0 to x1. `solid` fills everything
 *  below the crowns down to the frame bottom (a forest); otherwise each tree is its own spire. */
function pines(ctx: CanvasRenderingContext2D, x0: number, x1: number, h: number, baseY: (x: number) => number, size: number, salt: number, fill: string, solid = true): void {
  ctx.fillStyle = fill;
  ctx.beginPath();
  if (solid) ctx.moveTo(x0 - size, h);
  let x = x0 - (solid ? size : 0);
  let i = 0;
  while (x < x1 + (solid ? size : 0)) {
    const s = size * (0.6 + 0.8 * hash01(i, salt));
    const by = baseY(x);
    const top = by - s * 2.4;
    // Each tree: a narrow spire with two stepped tiers of boughs.
    if (solid) ctx.lineTo(x - s * 0.5, by);
    else ctx.moveTo(x - s * 0.5, by);
    ctx.lineTo(x - s * 0.22, by - s * 0.9);
    ctx.lineTo(x - s * 0.36, by - s * 0.9);
    ctx.lineTo(x - s * 0.12, by - s * 1.7);
    ctx.lineTo(x - s * 0.22, by - s * 1.7);
    ctx.lineTo(x, top);
    ctx.lineTo(x + s * 0.22, by - s * 1.7);
    ctx.lineTo(x + s * 0.12, by - s * 1.7);
    ctx.lineTo(x + s * 0.36, by - s * 0.9);
    ctx.lineTo(x + s * 0.22, by - s * 0.9);
    ctx.lineTo(x + s * 0.5, by);
    if (!solid) ctx.closePath();
    x += s * (0.45 + 0.4 * hash01(i, salt + 1));
    i++;
  }
  if (solid) {
    ctx.lineTo(x1 + size, h);
    ctx.closePath();
  }
  ctx.fill();
}

function paintSky(ctx: CanvasRenderingContext2D, w: number, h: number, L: Look): void {
  const g = ctx.createLinearGradient(0, 0, 0, h);
  for (const [o, c] of L.sky) g.addColorStop(o, c);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  glow(ctx, w * SUN.x, h * SUN.y, Math.max(w, h) * 0.6, L.sun, 0.35);
  glow(ctx, w * SUN.x, h * SUN.y, Math.min(w, h) * 0.12, "255 246 220", 0.6);
  // Two far ranges, pale and cool, the farthest nearly the colour of the sky.
  for (let k = 0; k < 2; k++) {
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let x = 0; x <= w + 6; x += 6) ctx.lineTo(x, h * (0.44 + k * 0.05) - fbm1(x / (w * 0.12), 4, 900 + k) * h * (0.08 - k * 0.02));
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fillStyle = L.far[k];
    ctx.globalAlpha = 0.55 + k * 0.25;
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function paintDome(ctx: CanvasRenderingContext2D, w: number, h: number, L: Look): void {
  // Ridges left of the dome, a shade nearer than the far ranges.
  rock(ctx, w, h, [[0.3, 0.62], [0.34, 0.5], [0.42, 0.47], [0.5, 0.49], [0.57, 0.52], [0.57, 0.62]], 8, 21);
  ctx.fillStyle = L.far[1];
  ctx.fill();
  // Half Dome, backlit by the low sun just past its shoulder: the sheer cut face on the left in
  // cool shadow, the rounded dome falling away to the right, its crest rimmed with warm light.
  const outline = (): void => {
    ctx.beginPath();
    ctx.moveTo(w * 0.555, h * 0.62);
    roughTo(ctx, w * 0.555, h * 0.62, w * 0.566, h * 0.4, 4, 11);
    roughTo(ctx, w * 0.566, h * 0.4, w * 0.572, h * 0.315, 3, 12);
    ctx.bezierCurveTo(w * 0.585, h * 0.285, w * 0.62, h * 0.28, w * 0.645, h * 0.305);
    ctx.bezierCurveTo(w * 0.67, h * 0.33, w * 0.69, h * 0.38, w * 0.71, h * 0.41);
    roughTo(ctx, w * 0.71, h * 0.41, w * 0.78, h * 0.46, 6, 13);
    roughTo(ctx, w * 0.78, h * 0.46, w * 0.86, h * 0.47, 6, 14);
  };
  outline();
  ctx.lineTo(w * 0.86, h * 0.62);
  ctx.closePath();
  const g = ctx.createLinearGradient(0, h * 0.28, 0, h * 0.6);
  g.addColorStop(0, L.dome);
  g.addColorStop(1, L.far[1]);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.save();
  ctx.clip();
  // Warm light wrapping the dome's sunward side, and faint granite streaks down the shaded face.
  glow(ctx, w * SUN.x, h * SUN.y, w * 0.13, "255 200 140", 0.45);
  ctx.strokeStyle = "rgb(40 40 70 / 0.16)";
  ctx.lineWidth = 1.2;
  for (let i = 0; i < 9; i++) {
    const x = w * (0.565 + i * 0.006);
    ctx.beginPath();
    ctx.moveTo(x, h * (0.3 + 0.03 * hash01(i, 3)));
    ctx.lineTo(x + w * 0.003, h * (0.42 + 0.08 * hash01(i, 4)));
    ctx.stroke();
  }
  ctx.restore();
  outline();
  const rim = ctx.createLinearGradient(w * 0.6, 0, w * 0.86, 0);
  rim.addColorStop(0, `rgb(${L.sun} / 0)`);
  rim.addColorStop(0.35, `rgb(${L.sun} / 0.7)`);
  rim.addColorStop(1, `rgb(${L.sun} / 0.15)`);
  ctx.strokeStyle = rim;
  ctx.lineWidth = 1.6;
  ctx.stroke();
}

function paintCliffs(ctx: CanvasRenderingContext2D, w: number, h: number, L: Look, unit: number): void {
  // El Capitan: a vast monolith, its prow catching the low sun.
  const elCap = [[-0.02, 0.85], [-0.02, 0.2], [0.06, 0.17], [0.16, 0.165], [0.215, 0.19], [0.25, 0.24], [0.268, 0.3], [0.283, 0.45], [0.3, 0.62], [0.33, 0.85]];
  rock(ctx, w, h, elCap, 7, 31);
  const eg = ctx.createLinearGradient(0, 0, w * 0.31, 0);
  eg.addColorStop(0, L.cliff[0]);
  eg.addColorStop(0.62, L.cliff[0]);
  eg.addColorStop(0.82, L.cliff[1]);
  eg.addColorStop(1, L.cliff[1]);
  ctx.fillStyle = eg;
  ctx.fill();
  ctx.save();
  ctx.clip();
  // Shading: cooler toward the base, warm along the top; granite streaks down the face.
  const vg = ctx.createLinearGradient(0, h * 0.17, 0, h * 0.85);
  vg.addColorStop(0, "rgb(255 220 170 / 0.12)");
  vg.addColorStop(1, "rgb(30 30 50 / 0.45)");
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, w * 0.35, h);
  for (let i = 0; i < 70; i++) {
    const x = w * (0.02 + 0.3 * hash01(i, 41));
    const y0 = h * (0.18 + 0.2 * hash01(i, 42));
    const len = h * (0.1 + 0.3 * hash01(i, 43));
    ctx.strokeStyle = hash01(i, 44) < 0.6 ? "rgb(30 28 40 / 0.16)" : "rgb(255 230 200 / 0.08)";
    ctx.lineWidth = 1 + 2 * hash01(i, 45);
    ctx.beginPath();
    ctx.moveTo(x, y0);
    ctx.quadraticCurveTo(x + w * 0.004 * (hash01(i, 46) - 0.5), y0 + len / 2, x + w * 0.006 * (hash01(i, 47) - 0.3), y0 + len);
    ctx.stroke();
  }
  ctx.restore();
  // Warm rim light tracing the summit and down the sunlit prow (same rough segments as the fill).
  const rim = ctx.createLinearGradient(w * 0.1, 0, w * 0.3, 0);
  rim.addColorStop(0, `rgb(${L.sun} / 0)`);
  rim.addColorStop(0.6, `rgb(${L.sun} / 0.55)`);
  rim.addColorStop(1, `rgb(${L.sun} / 0.3)`);
  ctx.strokeStyle = rim;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(elCap[2][0] * w, elCap[2][1] * h);
  for (let i = 3; i <= 8; i++) roughTo(ctx, elCap[i - 1][0] * w, elCap[i - 1][1] * h, elCap[i][0] * w, elCap[i][1] * h, 7, 31 + i * 7);
  ctx.stroke();
  // Pines along El Cap's summit, tiny with distance.
  // The baseline follows the summit outline above (piecewise linear between its first points).
  const summit = (x: number): number => {
    const u = x / w;
    const f = u < 0.06 ? 0.2 - ((u + 0.02) / 0.08) * 0.03 : u < 0.16 ? 0.17 - ((u - 0.06) / 0.1) * 0.005 : 0.165 + ((u - 0.16) / 0.055) * 0.025;
    return h * (f + 0.004);
  };
  pines(ctx, 0, w * 0.2, h, summit, unit * 3.4, 51, L.cliff[0], false);
  // Cathedral rocks on the right: spires, then the ribbon waterfall from a notch.
  rock(ctx, w, h, [[0.74, 0.85], [0.765, 0.56], [0.79, 0.44], [0.805, 0.37], [0.82, 0.43], [0.845, 0.4], [0.87, 0.31], [0.9, 0.29], [0.93, 0.33], [0.97, 0.3], [1.02, 0.34], [1.02, 0.85]], 6, 61);
  // The spires face the sun on their left, so the warm light sits on that side.
  const cg = ctx.createLinearGradient(w * 0.75, 0, w * 0.9, 0);
  cg.addColorStop(0, L.cliff[1]);
  cg.addColorStop(0.35, L.cliff[0]);
  cg.addColorStop(1, L.cliff[0]);
  ctx.fillStyle = cg;
  ctx.fill();
  ctx.save();
  ctx.clip();
  const sg = ctx.createLinearGradient(0, h * 0.3, 0, h * 0.85);
  sg.addColorStop(0, "rgb(255 210 160 / 0.14)");
  sg.addColorStop(1, "rgb(20 20 40 / 0.4)");
  ctx.fillStyle = sg;
  ctx.fillRect(w * 0.7, 0, w * 0.35, h);
  ctx.restore();
}

function paintForest(ctx: CanvasRenderingContext2D, w: number, h: number, L: Look, unit: number): void {
  // A mid band of forest in haze across the valley, then the near ridge of pines.
  pines(ctx, 0, w, h, (x) => h * 0.76 + (noise1(x / (w * 0.2), 71) - 0.5) * h * 0.03, unit * 9, 72, L.forest[1]);
  pines(ctx, 0, w, h, (x) => h * 0.9 - Math.sin((x / w) * Math.PI) * h * 0.04 + (noise1(x / (w * 0.1), 81) - 0.5) * h * 0.04, unit * 17, 82, L.forest[0]);
}

/** A horizontally tileable fog strip: soft overlapping puffs whose positions wrap across `W`. */
function fogStrip(ctx: CanvasRenderingContext2D, W: number, H: number, fog: string, salt: number): void {
  // Puffs stay inside the strip's height, so the band has no hard top or bottom edge.
  for (let i = 0; i < 22; i++) {
    const x = (i / 22) * W + hash01(i, salt) * W * 0.04;
    const y = H * (0.5 + 0.12 * (hash01(i, salt + 1) - 0.5));
    const r = H * (0.3 + 0.16 * hash01(i, salt + 2));
    for (const dx of [-W, 0, W]) {
      ctx.save();
      ctx.translate(x + dx, y);
      ctx.scale(4.5, 1);
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
      g.addColorStop(0, `rgb(${fog} / ${0.3 + 0.2 * hash01(i, salt + 3)})`);
      g.addColorStop(1, `rgb(${fog} / 0)`);
      ctx.fillStyle = g;
      ctx.fillRect(-r, -r, r * 2, r * 2);
      ctx.restore();
    }
  }
}

function drawFog(ctx: CanvasRenderingContext2D, strip: CanvasImageSource, w: number, y: number, bh: number, offset: number, alpha: number): void {
  const o = wrap(offset, w);
  ctx.globalAlpha = alpha;
  ctx.drawImage(strip, o - w, y, w, bh);
  ctx.drawImage(strip, o, y, w, bh);
  ctx.globalAlpha = 1;
}

/** A soaring bald eagle seen from slightly below: broad dark wings with splayed primaries, a white
 *  head toward `dir` and a white fan tail behind. `flex` (-1..1) gently flexes the wingtips. */
function eagle(ctx: CanvasRenderingContext2D, x: number, y: number, S: number, dir: number, bank: number, flex: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(bank);
  ctx.scale(dir, 1);
  const tipLift = S * (0.06 + 0.025 * flex);
  ctx.fillStyle = "#2a1e16";
  ctx.beginPath();
  for (const side of [-1, 1]) {
    // Leading edge out to the wrist, five splayed finger feathers, trailing edge back in.
    ctx.moveTo(0, -S * 0.02);
    ctx.quadraticCurveTo(side * S * 0.2, -S * 0.07, side * S * 0.36, -S * 0.05 - tipLift * 0.6);
    for (let f = 0; f < 5; f++) {
      const fx = side * S * (0.36 + 0.035 * f + 0.1);
      const fy = -S * 0.05 - tipLift + f * S * 0.024;
      ctx.lineTo(fx, fy);
      ctx.lineTo(side * S * (0.39 + 0.03 * f), -S * 0.035 - tipLift * 0.5 + f * S * 0.026);
    }
    ctx.quadraticCurveTo(side * S * 0.24, S * 0.07, side * S * 0.05, S * 0.06);
    ctx.lineTo(0, S * 0.04);
  }
  ctx.fill();
  // Body.
  ctx.beginPath();
  ctx.ellipse(0, S * 0.015, S * 0.05, S * 0.075, 0.25, 0, Math.PI * 2);
  ctx.fill();
  // White fan tail behind, white head forward, a hooked gold beak.
  ctx.fillStyle = "#efe9dc";
  ctx.beginPath();
  ctx.moveTo(-S * 0.03, S * 0.07);
  ctx.lineTo(-S * 0.1, S * 0.15);
  ctx.quadraticCurveTo(-S * 0.06, S * 0.18, -S * 0.015, S * 0.16);
  ctx.lineTo(S * 0.01, S * 0.08);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(S * 0.06, -S * 0.07, S * 0.04, S * 0.033, -0.3, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#e6ad38";
  ctx.beginPath();
  ctx.moveTo(S * 0.09, -S * 0.08);
  ctx.lineTo(S * 0.125, -S * 0.065);
  ctx.lineTo(S * 0.092, -S * 0.055);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

export const scene: SceneDef = {
  id: "yosemite",
  label: "Granite valley",
  paint(f: SceneFrame): void {
    const { ctx, w, h } = f;
    const ts = f.t / 1000;
    const unit = Math.max(0.6, Math.min(w / 1400, h / 800));
    const dpr = frameDpr(f);
    const L = look(f.season);
    const key = `yosemite-${f.season}`;
    const fogH = Math.round(h * 0.16);
    const strip = layerCache(`${key}-fog`, w, fogH, dpr, (c) => fogStrip(c, w, fogH, L.fog, 5));
    ctx.drawImage(layerCache(`${key}-sky`, w, h, dpr, (c) => paintSky(c, w, h, L)), 0, 0, w, h);
    drawFog(ctx, strip, w, h * 0.4, fogH, ts * unit * 6, 0.5);
    ctx.drawImage(layerCache(`${key}-dome`, w, h, dpr, (c) => paintDome(c, w, h, L)), 0, 0, w, h);
    // Rays fanning down and out from the sun, breathing slowly through the haze.
    ctx.globalCompositeOperation = "lighter";
    const sx = w * SUN.x;
    const sy = h * SUN.y;
    const len = Math.max(w, h) * 0.9;
    const rg = ctx.createRadialGradient(sx, sy, 0, sx, sy, len);
    // Transparent at the sun itself (the glow covers it), so the shafts never meet at a hard point.
    rg.addColorStop(0, `rgb(${L.sun} / 0)`);
    rg.addColorStop(0.08, `rgb(${L.sun} / 0.04)`);
    rg.addColorStop(0.3, `rgb(${L.sun} / 0.018)`);
    rg.addColorStop(0.75, `rgb(${L.sun} / 0)`);
    ctx.fillStyle = rg;
    // Nested wedges per ray, added together, give each shaft a soft falloff at its edges.
    for (let layer = 1; layer <= 4; layer++) {
      ctx.beginPath();
      for (let i = 0; i < 9; i++) {
        const b = 0.55 + 0.45 * Math.sin(ts / (4 + i * 0.7) + i * 1.9);
        const a = Math.PI * (0.22 + 0.6 * (i / 8)) + (hash01(i, 91) - 0.5) * 0.1;
        const half = (0.012 + 0.03 * hash01(i, 92)) * b * layer * 0.45;
        ctx.moveTo(sx, sy);
        ctx.lineTo(sx + Math.cos(a - half) * len, sy + Math.sin(a - half) * len);
        ctx.lineTo(sx + Math.cos(a + half) * len, sy + Math.sin(a + half) * len);
        ctx.closePath();
      }
      ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
    drawFog(ctx, strip, w, h * 0.5, fogH, -ts * unit * 9 + w * 0.3, 0.55);
    ctx.drawImage(layerCache(`${key}-cliffs`, w, h, dpr, (c) => paintCliffs(c, w, h, L, unit)), 0, 0, w, h);
    // The ribbon waterfall: a pale strand that shimmers as the water falls.
    const fx = w * 0.785;
    const fy0 = h * 0.5;
    const fy1 = h * 0.7;
    const wg = ctx.createLinearGradient(0, fy0, 0, fy1);
    const sh = wrap(ts * 0.35, 1);
    wg.addColorStop(0, "rgb(240 236 230 / 0.55)");
    wg.addColorStop(Math.min(0.95, sh), "rgb(255 250 240 / 0.8)");
    wg.addColorStop(1, "rgb(240 236 230 / 0.1)");
    ctx.fillStyle = wg;
    ctx.beginPath();
    ctx.moveTo(fx - unit * 2, fy0);
    ctx.lineTo(fx + unit * 2, fy0);
    ctx.lineTo(fx + unit * 5, fy1);
    ctx.lineTo(fx - unit * 4, fy1);
    ctx.closePath();
    ctx.fill();
    glow(ctx, fx, fy1, unit * 30, "240 236 230", 0.25);
    drawFog(ctx, strip, w, h * 0.62, fogH, ts * unit * 12 + w * 0.6, 0.7);
    ctx.drawImage(layerCache(`${key}-forest`, w, h, dpr, (c) => paintForest(c, w, h, L, unit)), 0, 0, w, h);
    // Bald eagles soaring in slow, wide circles (a flattened ellipse, nearer at the bottom).
    for (let i = 0; i < 3; i++) {
      const period = 38 + 14 * i;
      const th = (ts / period) * Math.PI * 2 * (i === 1 ? -1 : 1) + i * 2.1;
      const cx = w * [0.42, 0.66, 0.25][i];
      const cy = h * [0.16, 0.22, 0.3][i];
      const rx = w * [0.1, 0.08, 0.06][i];
      const ry = rx * 0.32;
      const x = cx + Math.cos(th) * rx;
      const y = cy + Math.sin(th) * ry;
      const vx = -Math.sin(th) * (i === 1 ? -1 : 1);
      const near = 1 + 0.15 * Math.sin(th);
      const S = unit * [92, 78, 64][i] * near;
      const bank = Math.cos(th) * 0.18 * (i === 1 ? -1 : 1);
      // The span foreshortens through the turns at the ellipse's ends, so the mirror flip is hidden.
      const dir = (vx >= 0 ? 1 : -1) * (0.45 + 0.55 * Math.abs(vx));
      eagle(ctx, x, y, S, dir, bank, Math.sin(ts * 0.8 + i * 2));
    }
  },
};
