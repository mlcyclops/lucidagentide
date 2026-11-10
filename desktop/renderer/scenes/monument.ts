// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/scenes/monument.ts
//
// P-SEASON.1 (ADR-0525): a civic dusk, strictly nonpartisan. A classical domed capitol and a tall
// obelisk stand in silhouette against a fading sky while the first stars emerge over a minute or
// two; a reflecting pool mirrors the obelisk; two faint searchlights sweep slowly; and a stylised
// stars-and-stripes flag ripples on its pole (sine-wave cloth with shaded folds). Presidents' Day
// reads a winter rose dusk; Election Season a deeper blue hour.

import type { SeasonId } from "../seasons.ts";
import { frameDpr, glow, hash01, layerCache, type SceneDef, type SceneFrame } from "../scene_kit.ts";

const GROUND = 0.8; // ground line, fraction of h
const POOL_TOP = 0.86;
const POOL_BOTTOM = 0.93;

function skyStops(season: SeasonId | null): [number, string][] {
  if (season === "elections") {
    return [[0, "#0a1030"], [0.3, "#18245a"], [0.55, "#34407c"], [0.72, "#7a6a9a"], [0.84, "#d79a8c"], [0.9, "#f2c49c"]];
  }
  return [[0, "#0e1132"], [0.3, "#22265a"], [0.55, "#4c3f78"], [0.72, "#9a6488"], [0.84, "#e39a82"], [0.9, "#f7c896"]];
}

const SIL = "#121731";
const SIL_FAR = "#2a2c55";

/** The obelisk outline (shaft plus pyramidion) at center x, base on `gy`. */
function obeliskPath(ctx: CanvasRenderingContext2D, x: number, gy: number, h: number, flip = 1): void {
  const tall = h * 0.46;
  const bw = h * 0.034;
  const tw = h * 0.024;
  const shaftTop = gy - flip * tall * 0.94;
  ctx.beginPath();
  ctx.moveTo(x - bw / 2, gy);
  ctx.lineTo(x - tw / 2, shaftTop);
  ctx.lineTo(x, gy - flip * tall);
  ctx.lineTo(x + tw / 2, shaftTop);
  ctx.lineTo(x + bw / 2, gy);
  ctx.closePath();
}

function paintCapitol(ctx: CanvasRenderingContext2D, cx: number, gy: number, h: number): void {
  const S = h * 0.78; // overall scale
  const warm = "rgb(255 214 160 / ";
  ctx.fillStyle = SIL;
  // Wings and the central block, with low pediments.
  const wingW = S * 0.62;
  const wingH = S * 0.075;
  ctx.fillRect(cx - wingW, gy - wingH, wingW * 2, wingH);
  const midW = S * 0.26;
  const midH = S * 0.105;
  ctx.fillRect(cx - midW, gy - midH, midW * 2, midH);
  ctx.beginPath();
  ctx.moveTo(cx - S * 0.1, gy - midH);
  ctx.lineTo(cx, gy - midH - S * 0.035);
  ctx.lineTo(cx + S * 0.1, gy - midH);
  ctx.closePath();
  ctx.fill();
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(cx + side * wingW * 0.66 - S * 0.07, gy - wingH);
    ctx.lineTo(cx + side * wingW * 0.66, gy - wingH - S * 0.026);
    ctx.lineTo(cx + side * wingW * 0.66 + S * 0.07, gy - wingH);
    ctx.closePath();
    ctx.fill();
  }
  // Drum, attic, dome, lantern, statue.
  const drumW = S * 0.12;
  const drumH = S * 0.075;
  const drumTop = gy - midH - drumH;
  ctx.fillRect(cx - drumW, drumTop, drumW * 2, drumH);
  const atticW = S * 0.1;
  const atticH = S * 0.03;
  ctx.fillRect(cx - atticW, drumTop - atticH, atticW * 2, atticH);
  const domeBase = drumTop - atticH;
  const domeW = S * 0.092;
  const domeH = S * 0.11;
  ctx.beginPath();
  ctx.moveTo(cx - domeW, domeBase);
  ctx.bezierCurveTo(cx - domeW, domeBase - domeH * 0.75, cx - domeW * 0.45, domeBase - domeH, cx, domeBase - domeH);
  ctx.bezierCurveTo(cx + domeW * 0.45, domeBase - domeH, cx + domeW, domeBase - domeH * 0.75, cx + domeW, domeBase);
  ctx.closePath();
  ctx.fill();
  const lanW = S * 0.016;
  const lanTop = domeBase - domeH - S * 0.035;
  ctx.fillRect(cx - lanW, lanTop, lanW * 2, S * 0.04);
  ctx.beginPath();
  ctx.ellipse(cx, lanTop, lanW * 1.1, S * 0.012, 0, Math.PI, 0);
  ctx.fill();
  ctx.fillRect(cx - S * 0.003, lanTop - S * 0.034, S * 0.006, S * 0.024);
  // Floodlit details: colonnade on the drum, ribs on the dome, a lit portico and windows.
  ctx.fillStyle = `${warm}0.22)`;
  for (let i = 0; i <= 18; i++) {
    const x = cx - drumW * 0.92 + (i / 18) * drumW * 1.84;
    ctx.fillRect(x - S * 0.0018, drumTop + drumH * 0.12, S * 0.0036, drumH * 0.8);
  }
  for (let i = 0; i <= 12; i++) {
    const x = cx - drumW * 0.75 + (i / 12) * drumW * 1.5;
    ctx.fillRect(x - S * 0.0014, domeBase + atticH * 0.15, S * 0.0028, atticH * 0.7);
  }
  ctx.strokeStyle = `${warm}0.16)`;
  ctx.lineWidth = Math.max(1, S * 0.002);
  for (let i = 1; i < 8; i++) {
    const k = i / 8;
    const bx = cx - domeW + k * domeW * 2;
    ctx.beginPath();
    ctx.moveTo(bx, domeBase);
    ctx.quadraticCurveTo(cx + (bx - cx) * 0.8, domeBase - domeH * 0.8, cx, domeBase - domeH);
    ctx.stroke();
  }
  ctx.fillStyle = `${warm}0.14)`;
  for (let i = 0; i <= 10; i++) {
    const x = cx - S * 0.085 + (i / 10) * S * 0.17;
    ctx.fillRect(x - S * 0.002, gy - midH * 0.88, S * 0.004, midH * 0.8);
  }
  for (let row = 0; row < 2; row++) {
    for (let i = 0; i < 44; i++) {
      const x = cx - wingW * 0.97 + (i / 43) * wingW * 1.94;
      if (Math.abs(x - cx) < S * 0.1) continue;
      if (hash01(i + row * 50, 7) < 0.25) continue;
      ctx.fillStyle = `${warm}${0.18 + 0.25 * hash01(i + row * 50, 8)})`;
      ctx.fillRect(x, gy - wingH * (0.78 - row * 0.4), S * 0.004, S * 0.007);
    }
  }
  // A thin warm rim where the floodlights catch the dome's left shoulder.
  ctx.strokeStyle = `${warm}0.3)`;
  ctx.lineWidth = Math.max(1, S * 0.003);
  ctx.beginPath();
  ctx.moveTo(cx - domeW, domeBase);
  ctx.bezierCurveTo(cx - domeW, domeBase - domeH * 0.75, cx - domeW * 0.45, domeBase - domeH, cx, domeBase - domeH);
  ctx.stroke();
}

function paintTrees(ctx: CanvasRenderingContext2D, w: number, gy: number, h: number, salt: number, fill: string, scale: number): void {
  ctx.fillStyle = fill;
  ctx.beginPath();
  let x = -20;
  let i = 0;
  while (x < w + 20) {
    const r = h * scale * (0.018 + 0.016 * hash01(i, salt));
    const top = gy - r * (1.2 + 0.8 * hash01(i, salt + 1));
    ctx.moveTo(x + r, top);
    ctx.ellipse(x, top, r, r * 0.95, 0, 0, Math.PI * 2);
    ctx.rect(x - r, top, r * 2, gy - top + 1);
    x += r * (1.1 + 0.6 * hash01(i, salt + 2));
    i++;
  }
  ctx.fill();
}

function paintSky(ctx: CanvasRenderingContext2D, w: number, h: number, season: SeasonId | null): void {
  const g = ctx.createLinearGradient(0, 0, 0, h * GROUND);
  for (const [o, c] of skyStops(season)) g.addColorStop(o / 0.9, c);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  glow(ctx, w * 0.42, h * GROUND, Math.max(w, h) * 0.45, "255 170 120", 0.2);
}

function paintStars(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  for (let i = 0; i < 220; i++) {
    const y = Math.pow(hash01(i, 61), 1.5) * h * 0.55;
    const b = hash01(i, 62);
    ctx.fillStyle = `rgb(236 238 255 / ${(0.2 + 0.7 * b) * (1 - y / (h * 0.6))})`;
    const s = b > 0.93 ? 1.7 : 1;
    ctx.fillRect(hash01(i, 63) * w, y, s, s);
  }
}

function paintLand(ctx: CanvasRenderingContext2D, w: number, h: number, season: SeasonId | null): void {
  const gy = h * GROUND;
  const ox = w * 0.24;
  // Distant tree line in haze, then the monuments, then nearer trees framing them.
  paintTrees(ctx, w, gy, h, 71, SIL_FAR, 0.8);
  // The obelisk: floodlit faces, the left face a little brighter.
  obeliskPath(ctx, ox, gy, h);
  const og = ctx.createLinearGradient(ox - h * 0.017, 0, ox + h * 0.017, 0);
  og.addColorStop(0, "#5c5874");
  og.addColorStop(0.5, "#4a4664");
  og.addColorStop(0.51, "#2c2c4a");
  og.addColorStop(1, "#232541");
  ctx.fillStyle = og;
  ctx.fill();
  paintCapitol(ctx, w * 0.58, gy, h);
  paintTrees(ctx, w * 0.4, gy + 2, h, 81, SIL, 1);
  ctx.save();
  ctx.translate(w * 0.86, 0);
  paintTrees(ctx, w * 0.2, gy + 2, h, 91, SIL, 1.1);
  ctx.restore();
  // The lawn and the pool's stone rim.
  const lg = ctx.createLinearGradient(0, gy, 0, h);
  lg.addColorStop(0, "#0e1228");
  lg.addColorStop(1, "#070914");
  ctx.fillStyle = lg;
  ctx.fillRect(0, gy, w, h - gy);
  const py0 = h * POOL_TOP;
  const py1 = h * POOL_BOTTOM;
  // The pool mirrors the sky (inverted) and the obelisk.
  ctx.save();
  ctx.beginPath();
  ctx.rect(w * 0.04, py0, w * 0.92, py1 - py0);
  ctx.clip();
  // Dark water carrying a dim, inverted echo of the horizon glow, fading out toward both ends.
  ctx.fillStyle = "#0b0e22";
  ctx.fillRect(0, py0, w, py1 - py0);
  const rg = ctx.createLinearGradient(0, py0, 0, py1);
  const stops = skyStops(season);
  rg.addColorStop(0, stops[stops.length - 2][1]);
  rg.addColorStop(0.5, stops[stops.length - 3][1]);
  rg.addColorStop(1, stops[stops.length - 5][1]);
  ctx.fillStyle = rg;
  ctx.globalAlpha = 0.3;
  ctx.fillRect(0, py0, w, py1 - py0);
  ctx.globalAlpha = 0.7;
  ctx.save();
  ctx.translate(0, py0);
  ctx.scale(1, 0.3);
  obeliskPath(ctx, ox, 0, h, -1);
  ctx.fillStyle = "#2c2a48";
  ctx.fill();
  ctx.restore();
  ctx.globalAlpha = 1;
  const ends = ctx.createLinearGradient(w * 0.04, 0, w * 0.96, 0);
  ends.addColorStop(0, "rgb(11 14 34 / 0.9)");
  ends.addColorStop(0.25, "rgb(11 14 34 / 0)");
  ends.addColorStop(0.75, "rgb(11 14 34 / 0)");
  ends.addColorStop(1, "rgb(11 14 34 / 0.9)");
  ctx.fillStyle = ends;
  ctx.fillRect(0, py0, w, py1 - py0);
  ctx.restore();
  ctx.fillStyle = "rgb(200 190 220 / 0.1)";
  ctx.fillRect(w * 0.04, py0, w * 0.92, 1);
}

/** The flag: a ripple of 13 stripes and a starred canton, pinned at the pole. */
function paintFlag(ctx: CanvasRenderingContext2D, f: SceneFrame, unit: number): void {
  const { w, h } = f;
  const ts = f.t / 1000;
  const poleX = Math.min(w * 0.84, w - unit * 200);
  const top = h * 0.36;
  const FW = unit * 168;
  const FH = FW * 0.53;
  const N = 32;
  const amp = FH * 0.075;
  const phase = (u: number): number => u * Math.PI * 2.4 - ts * 1.5;
  const dy = (u: number): number => Math.sin(phase(u)) * amp * u + u * FH * 0.04;
  const dx = (u: number): number => u * FW * (0.97 + 0.03 * Math.cos(phase(u)));
  // Pole, finial and halyard first.
  const pg = ctx.createLinearGradient(poleX - unit * 3, 0, poleX + unit * 3, 0);
  pg.addColorStop(0, "#8a8aa0");
  pg.addColorStop(1, "#2a2c40");
  ctx.fillStyle = pg;
  ctx.fillRect(poleX - unit * 2.2, top - unit * 8, unit * 4.4, h * POOL_TOP - top + unit * 8);
  glow(ctx, poleX, top - unit * 12, unit * 10, "255 214 140", 0.25);
  ctx.fillStyle = "#e0b860";
  ctx.beginPath();
  ctx.arc(poleX, top - unit * 11, unit * 4.5, 0, Math.PI * 2);
  ctx.fill();
  const x0 = poleX + unit * 2;
  const red = new Path2D();
  const white = new Path2D();
  const blue = new Path2D();
  const stripe = FH / 13;
  for (let j = 0; j < N; j++) {
    const u0 = j / N;
    const u1 = (j + 1) / N;
    const ax = x0 + dx(u0);
    const bx = x0 + dx(u1) + 0.5;
    const ay = top + dy(u0);
    const by = top + dy(u1);
    for (let s = 0; s < 13; s++) {
      const p = s % 2 === 0 ? red : white;
      const y0 = s * stripe;
      const y1 = y0 + stripe + 0.5;
      p.moveTo(ax, ay + y0);
      p.lineTo(bx, by + y0);
      p.lineTo(bx, by + y1);
      p.lineTo(ax, ay + y1);
      p.closePath();
    }
    if (u1 <= 0.4 + 1e-9) {
      blue.moveTo(ax, ay);
      blue.lineTo(bx, by);
      blue.lineTo(bx, by + stripe * 7);
      blue.lineTo(ax, ay + stripe * 7);
      blue.closePath();
    }
  }
  ctx.fillStyle = "#b03a46";
  ctx.fill(red);
  ctx.fillStyle = "#dcd4ca";
  ctx.fill(white);
  ctx.fillStyle = "#2b3a72";
  ctx.fill(blue);
  // Fifty stars in nine staggered rows, as small points that ride the cloth.
  ctx.fillStyle = "rgb(240 236 228 / 0.92)";
  ctx.beginPath();
  const cs = unit * 1.3;
  for (let r = 0; r < 9; r++) {
    const n = r % 2 === 0 ? 6 : 5;
    for (let c = 0; c < n; c++) {
      const u = ((c + (r % 2 === 0 ? 0.5 : 1)) / 6.5) * 0.4 * 1.06;
      const yy = top + dy(u) + ((r + 1) / 10) * stripe * 7;
      ctx.rect(x0 + dx(u) - cs / 2, yy - cs / 2, cs, cs);
    }
  }
  ctx.fill();
  // Folds: each column darkens or catches light by the slope of the wave there.
  for (let j = 0; j < N; j++) {
    const u0 = j / N;
    const u1 = (j + 1) / N;
    const slope = Math.cos(phase((u0 + u1) / 2)) * Math.min(1, u0 * 3 + 0.2);
    ctx.fillStyle = slope < 0 ? `rgb(10 8 30 / ${-slope * 0.38})` : `rgb(255 236 220 / ${slope * 0.14})`;
    const ax = x0 + dx(u0);
    const bx = x0 + dx(u1) + 0.5;
    ctx.beginPath();
    ctx.moveTo(ax, top + dy(u0));
    ctx.lineTo(bx, top + dy(u1));
    ctx.lineTo(bx, top + dy(u1) + FH + 0.5);
    ctx.lineTo(ax, top + dy(u0) + FH + 0.5);
    ctx.closePath();
    ctx.fill();
  }
  // Dusk light: the whole flag sits a little in shadow, warmer on the top edge.
  const dg = ctx.createLinearGradient(0, top, 0, top + FH);
  dg.addColorStop(0, "rgb(255 190 150 / 0.06)");
  dg.addColorStop(1, "rgb(20 16 50 / 0.3)");
  ctx.fillStyle = dg;
  ctx.fillRect(x0, top - amp, FW + unit, FH + amp * 2 + FH * 0.05);
}

export const scene: SceneDef = {
  id: "monument",
  label: "Monuments at dusk",
  paint(f: SceneFrame): void {
    const { ctx, w, h, t } = f;
    const ts = t / 1000;
    const unit = Math.max(0.6, Math.min(w / 1400, h / 800));
    const dpr = frameDpr(f);
    const season = f.season;
    ctx.drawImage(layerCache(`monument-sky-${season}`, w, h, dpr, (c) => paintSky(c, w, h, season)), 0, 0, w, h);
    // Stars emerge over the first ~90 s, and a few twinkle.
    const emerge = 1 - Math.exp(-t / 45000);
    ctx.globalAlpha = 0.15 + 0.85 * emerge;
    ctx.drawImage(layerCache("monument-stars", w, h, dpr, (c) => paintStars(c, w, h)), 0, 0, w, h);
    ctx.globalAlpha = 1;
    for (let i = 0; i < 10; i++) {
      const a = Math.max(0, Math.sin(ts * (0.4 + 0.3 * hash01(i, 51)) + i * 2)) ** 4 * emerge;
      if (a > 0.02) glow(ctx, hash01(i, 52) * w, hash01(i, 53) ** 1.4 * h * 0.45, unit * 7, "230 236 255", 0.6 * a);
    }
    // Searchlights: two pale beams sweeping slowly from behind the trees.
    ctx.globalCompositeOperation = "lighter";
    const gy = h * GROUND;
    for (let k = 0; k < 2; k++) {
      const bx = w * (k === 0 ? 0.4 : 0.82);
      const ang = -Math.PI / 2 + Math.sin(ts / (11 + k * 3) + k * 2.2) * 0.42 + (k === 0 ? -0.12 : 0.1);
      const len = h * 0.95;
      const spread = 0.035;
      const ex = bx + Math.cos(ang) * len;
      const ey = gy + Math.sin(ang) * len;
      const bg = ctx.createLinearGradient(bx, gy, ex, ey);
      bg.addColorStop(0, "rgb(220 226 255 / 0.13)");
      bg.addColorStop(1, "rgb(220 226 255 / 0)");
      ctx.fillStyle = bg;
      ctx.beginPath();
      ctx.moveTo(bx - unit * 3, gy);
      ctx.lineTo(bx + Math.cos(ang - spread) * len, gy + Math.sin(ang - spread) * len);
      ctx.lineTo(bx + Math.cos(ang + spread) * len, gy + Math.sin(ang + spread) * len);
      ctx.lineTo(bx + unit * 3, gy);
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
    ctx.drawImage(layerCache(`monument-land-${season}`, w, h, dpr, (c) => paintLand(c, w, h, season)), 0, 0, w, h);
    // Aviation lights at the obelisk's tip blink a slow red.
    const blink = (Math.sin(ts * 1.4) + 1) / 2;
    glow(ctx, w * 0.24, h * GROUND - h * 0.43, unit * 9, "255 60 50", 0.2 + 0.5 * blink);
    // Ripples crossing the pool's reflection.
    ctx.fillStyle = "rgb(230 220 240 / 0.07)";
    ctx.beginPath();
    for (let i = 0; i < 16; i++) {
      const y = h * (POOL_TOP + 0.004 + 0.06 * hash01(i, 41));
      const len = w * (0.04 + 0.1 * hash01(i, 42));
      const x = w * 0.05 + ((hash01(i, 43) * w * 0.9 + ts * unit * (4 + 6 * hash01(i, 44))) % (w * 0.9 - len));
      ctx.rect(x, y, len, 1);
    }
    ctx.fill();
    paintFlag(ctx, f, unit);
  },
};
