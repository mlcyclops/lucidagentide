// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/scenes/haunt.ts
//
// P-SEASON.1 (ADR-0525): Halloween night, spooky-fun. A big full moon with a cold halo, ragged clouds
// sliding across it, gnarled bare trees and crooked headstones on moonlit hills, a hillside of
// jack-o'-lanterns whose candles flicker, bats flitting by and ground fog drifting in two layers. The
// sky with moon, the landscape and each cloud and fog bank are cached; per frame only the candle
// light, bats and the cached sprites' offsets change.

import { frameDpr, glow, hash01, layerCache, noise1, ridge, wrap, type SceneDef, type SceneFrame } from "../scene_kit.ts";

const TAU = Math.PI * 2;

const leftHill = (x: number, w: number, h: number): number => h * (0.62 + 0.9 * (x / w - 0.12) ** 2);
const rightHill = (x: number, w: number, h: number): number => h * (0.72 + 1.1 * (x / w - 0.8) ** 2);

interface Lantern { x: number; r: number; mouth: number }
const LANTERNS: readonly Lantern[] = [
  { x: 0.5, r: 0.032, mouth: 4 }, { x: 0.575, r: 0.044, mouth: 5 }, { x: 0.645, r: 0.026, mouth: 3 },
  { x: 0.87, r: 0.038, mouth: 4 }, { x: 0.945, r: 0.028, mouth: 3 },
];

function paintSky(c: CanvasRenderingContext2D, w: number, h: number): void {
  const g = c.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, "#07061a");
  g.addColorStop(0.35, "#17123a");
  g.addColorStop(0.62, "#2e2050");
  g.addColorStop(0.8, "#47295a");
  g.addColorStop(1, "#1a1028");
  c.fillStyle = g;
  c.fillRect(0, 0, w, h);
  c.fillStyle = "#e8e6ff";
  for (let i = 0; i < 120; i++) {
    c.globalAlpha = 0.2 + 0.5 * hash01(i, 2);
    const s = hash01(i, 3) < 0.08 ? 1.8 : 1;
    c.fillRect(hash01(i, 4) * w, Math.pow(hash01(i, 5), 1.4) * h * 0.6, s, s);
  }
  c.globalAlpha = 1;

  const mx = w * 0.66;
  const my = h * 0.29;
  const R = h * 0.115;
  glow(c, mx, my, R * 6, "150 150 230", 0.2);
  glow(c, mx, my, R * 3.8, "190 195 245", 0.14);
  glow(c, mx, my, R * 2.2, "225 228 255", 0.2);
  glow(c, mx, my, R * 1.4, "240 240 255", 0.25);
  // A faint 22-degree style ring around the moon.
  c.beginPath();
  c.arc(mx, my, R * 3.1, 0, TAU);
  c.strokeStyle = "rgb(200 200 255 / 0.025)";
  c.lineWidth = R * 0.7;
  c.stroke();
  const mg = c.createRadialGradient(mx - R * 0.25, my - R * 0.25, 0, mx, my, R);
  mg.addColorStop(0, "#fffdf0");
  mg.addColorStop(0.7, "#f3ead0");
  mg.addColorStop(1, "#d9cfb0");
  c.fillStyle = mg;
  c.beginPath();
  c.arc(mx, my, R, 0, TAU);
  c.fill();
  c.save();
  c.clip();
  // Maria and craters.
  for (let i = 0; i < 9; i++) {
    const a = hash01(i, 11) * TAU;
    const d = Math.sqrt(hash01(i, 12)) * R * 0.75;
    glow(c, mx + Math.cos(a) * d, my + Math.sin(a) * d, R * (0.18 + 0.3 * hash01(i, 13)), "150 140 120", 0.28);
  }
  for (let i = 0; i < 6; i++) {
    const a = hash01(i, 14) * TAU;
    const d = Math.sqrt(hash01(i, 15)) * R * 0.85;
    const r = R * (0.03 + 0.04 * hash01(i, 16));
    c.beginPath();
    c.arc(mx + Math.cos(a) * d, my + Math.sin(a) * d, r, 0, TAU);
    c.fillStyle = "rgb(160 150 130 / 0.14)";
    c.fill();
  }
  c.restore();
}

/** A gnarled branch: a bent quadratic stroke that forks two or three ways until it is a twig. */
function branch(c: CanvasRenderingContext2D, x: number, y: number, ang: number, len: number, wid: number, depth: number, seed: number): void {
  const bend = (hash01(seed, 1) - 0.5) * 1.2;
  const ex = x + Math.sin(ang) * len;
  const ey = y - Math.cos(ang) * len;
  c.lineWidth = wid;
  c.beginPath();
  c.moveTo(x, y);
  c.quadraticCurveTo((x + ex) / 2 + Math.cos(ang) * len * bend * 0.35, (y + ey) / 2 + Math.sin(ang) * len * bend * 0.35, ex, ey);
  c.stroke();
  if (depth === 0) return;
  const n = hash01(seed, 2) < 0.3 ? 3 : 2;
  for (let k = 0; k < n; k++) {
    const s = (seed * 31 + k * 7 + 1) | 0;
    let a = ang + (k - (n - 1) / 2) * (0.55 + 0.45 * hash01(s, 3)) + (hash01(s, 4) - 0.5) * 0.5;
    a = Math.max(-2.1, Math.min(2.1, a));
    branch(c, ex, ey, a, len * (0.62 + 0.2 * hash01(s, 5)), wid * 0.66, depth - 1, s);
  }
}

function lanternAt(l: Lantern, w: number, h: number): [number, number, number] {
  const x = l.x * w;
  const r = l.r * h;
  return [x, rightHill(x, w, h) + r * 0.15, r];
}

function facePath(c: CanvasRenderingContext2D, x: number, y: number, r: number, teeth: number): void {
  c.beginPath();
  // Eyes and nose: little triangles.
  for (const s of [-1, 1]) {
    c.moveTo(x + s * r * 0.5, y - r * 0.12);
    c.lineTo(x + s * r * 0.18, y - r * 0.08);
    c.lineTo(x + s * r * 0.36, y - r * 0.42);
    c.closePath();
  }
  c.moveTo(x - r * 0.09, y + r * 0.08);
  c.lineTo(x + r * 0.09, y + r * 0.08);
  c.lineTo(x, y - r * 0.08);
  c.closePath();
  // A toothy grin.
  c.moveTo(x - r * 0.6, y + r * 0.18);
  c.quadraticCurveTo(x, y + r * 0.85, x + r * 0.6, y + r * 0.18);
  const top = y + r * 0.26;
  for (let i = teeth; i >= 0; i--) {
    const tx = x - r * 0.6 + (i / teeth) * r * 1.2;
    c.lineTo(tx, top + (i % 2 === 0 ? 0 : r * 0.16));
  }
  c.closePath();
}

function paintLand(c: CanvasRenderingContext2D, w: number, h: number): void {
  // Far rolling hills with a faint moonlit haze above them.
  ridge(c, w, h, h * 0.68, h * 0.05, 320, 3, "#211a3c");
  const hz = c.createLinearGradient(0, h * 0.6, 0, h * 0.8);
  hz.addColorStop(0, "rgb(120 100 170 / 0)");
  hz.addColorStop(1, "rgb(120 100 170 / 0.18)");
  c.fillStyle = hz;
  c.fillRect(0, h * 0.6, w, h * 0.2);
  c.strokeStyle = "#140f26";
  c.lineCap = "round";
  for (let i = 0; i < 7; i++) {
    const x = (0.3 + 0.1 * i + 0.04 * hash01(i, 21)) * w;
    branch(c, x, h * 0.665, (hash01(i, 22) - 0.5) * 0.3, h * (0.02 + 0.015 * hash01(i, 23)), 2, 5, 100 + i);
  }

  const hill = (f: (x: number, w: number, h: number) => number, x0: number, x1: number, fill: string): void => {
    c.beginPath();
    c.moveTo(x0, h);
    for (let x = x0; x <= x1; x += 8) c.lineTo(x, f(x, w, h));
    c.lineTo(x1, h);
    c.closePath();
    c.fillStyle = fill;
    c.fill();
    c.beginPath();
    const r0 = x0 === 0 ? 0 : x0 + w * 0.1;
    for (let x = r0; x <= x1; x += 8) {
      if (x === r0) c.moveTo(x, f(x, w, h));
      else c.lineTo(x, f(x, w, h));
    }
    c.strokeStyle = "rgb(150 150 220 / 0.28)";
    c.lineWidth = 1.5;
    c.stroke();
  };
  hill(leftHill, 0, w * 0.56, "#130e24");

  // Crooked headstones, rim-lit on the moon side.
  for (const [i, fx] of [0.25, 0.31, 0.37, 0.43].entries()) {
    const x = fx * w;
    const y = leftHill(x, w, h) + 3;
    const sh = h * (0.034 + 0.016 * hash01(i, 31));
    const sw = sh * 0.62;
    c.save();
    c.translate(x, y);
    c.rotate((hash01(i, 32) - 0.5) * 0.35);
    c.beginPath();
    c.moveTo(-sw / 2, 0);
    c.lineTo(-sw / 2, -sh + sw / 2);
    c.arc(0, -sh + sw / 2, sw / 2, Math.PI, 0);
    c.lineTo(sw / 2, 0);
    c.closePath();
    c.fillStyle = "#1d1830";
    c.fill();
    c.strokeStyle = "rgb(170 170 230 / 0.35)";
    c.lineWidth = 1.2;
    c.beginPath();
    c.arc(0, -sh + sw / 2, sw / 2, -Math.PI * 0.45, 0);
    c.lineTo(sw / 2, 0);
    c.stroke();
    c.restore();
  }

  // The great gnarled tree on the left hill.
  c.strokeStyle = "#0b0816";
  branch(c, w * 0.13, leftHill(w * 0.13, w, h) + 6, 0.1, h * 0.17, h * 0.034, 8, 7);
  // A low root flare.
  c.fillStyle = "#0b0816";
  c.beginPath();
  c.ellipse(w * 0.13, leftHill(w * 0.13, w, h) + 6, h * 0.05, h * 0.012, 0, 0, TAU);
  c.fill();

  hill(rightHill, w * 0.36, w + 8, "#0f0b1d");
  // A second, smaller tree reaching across the moon.
  c.strokeStyle = "#0a0714";
  branch(c, w * 0.8, rightHill(w * 0.8, w, h) + 4, -0.18, h * 0.13, h * 0.024, 7, 41);

  // Foreground ground.
  const fg = c.createLinearGradient(0, h * 0.86, 0, h);
  fg.addColorStop(0, "#0c0918");
  fg.addColorStop(1, "#06050d");
  c.beginPath();
  c.moveTo(0, h);
  for (let x = 0; x <= w + 8; x += 8) c.lineTo(x, h * 0.9 - h * 0.025 * Math.sin(x / w * 3 + 1) - h * 0.01 * noise1(x / 70, 51));
  c.lineTo(w, h);
  c.closePath();
  c.fillStyle = fg;
  c.fill();

  // Lantern bodies with dark carved faces; the candlelight is painted per frame.
  for (const l of LANTERNS) {
    const [x, y, r] = lanternAt(l, w, h);
    for (const [dx, sx, col] of [[-0.45, 0.62, "#9c3d0e"], [0.45, 0.62, "#9c3d0e"], [-0.2, 0.7, "#c2531a"], [0.2, 0.7, "#c2531a"], [0, 0.55, "#d8661f"]] as const) {
      const g = c.createRadialGradient(x + dx * r - r * 0.2, y - r * 0.4, 0, x + dx * r, y, r);
      g.addColorStop(0, col);
      g.addColorStop(1, "#4a1a06");
      c.fillStyle = g;
      c.beginPath();
      c.ellipse(x + dx * r, y, r * sx, r * 0.85, 0, 0, TAU);
      c.fill();
    }
    c.fillStyle = "#3a4a1e";
    c.fillRect(x - r * 0.07, y - r * 1.05, r * 0.14, r * 0.3);
    facePath(c, x, y, r, l.mouth);
    c.fillStyle = "#2a0d04";
    c.fill();
  }
}

/** A ragged night cloud built from soft puffs: a moonlit upper fringe, then the dark body over it. */
function paintCloud(c: CanvasRenderingContext2D, cw: number, ch: number, seed: number): void {
  for (const pass of [0, 1]) {
    for (let k = 0; k < 26; k++) {
      const u = (k + hash01(k, seed + 2)) / 26;
      const x = cw * (0.13 + 0.74 * u);
      const r = ch * (0.12 + 0.15 * Math.sin(u * Math.PI) * (0.5 + 0.7 * hash01(k, seed)));
      const y = ch * 0.56 - r * 0.35 + (hash01(k, seed + 1) - 0.5) * ch * 0.1;
      if (pass === 0) glow(c, x, y - r * 0.18, r * 1.05, "150 145 205", 0.5);
      else glow(c, x, y + r * 0.08, r, "24 19 46", 0.85);
    }
  }
}

function paintFog(c: CanvasRenderingContext2D, fw: number, fh: number, seed: number): void {
  for (let i = 0; i < 60; i++) {
    const x = hash01(i, seed) * fw;
    const y = fh * (0.4 + 0.3 * hash01(i, seed + 1));
    const rx = fw * (0.08 + 0.1 * hash01(i, seed + 2));
    const ry = fh * (0.14 + 0.16 * hash01(i, seed + 3));
    for (const ox of [-fw, 0, fw]) {
      c.save();
      c.translate(x + ox, y);
      c.scale(1, ry / rx);
      glow(c, 0, 0, rx, "176 168 218", 0.075);
      c.restore();
    }
  }
}

/** A bat: a small body and two scalloped wings whose tips beat with `ph`. */
function bat(c: CanvasRenderingContext2D, x: number, y: number, s: number, ph: number): void {
  const lift = Math.sin(ph) * s * 0.7;
  const fold = 0.75 + 0.25 * Math.cos(ph);
  c.save();
  c.translate(x, y);
  c.beginPath();
  for (const side of [-1, 1]) {
    const tx = side * s * fold;
    c.moveTo(0, -s * 0.05);
    c.quadraticCurveTo(side * s * 0.5 * fold, -lift - s * 0.25, tx, -lift);
    c.quadraticCurveTo(side * s * 0.78 * fold, -lift * 0.5 + s * 0.02, side * s * 0.62 * fold, -lift * 0.35 + s * 0.12);
    c.quadraticCurveTo(side * s * 0.5 * fold, -lift * 0.3 + s * 0.02, side * s * 0.36 * fold, -lift * 0.2 + s * 0.14);
    c.quadraticCurveTo(side * s * 0.25 * fold, s * 0.04, side * s * 0.08, s * 0.14);
    c.closePath();
  }
  c.ellipse(0, s * 0.04, s * 0.09, s * 0.17, 0, 0, TAU);
  c.moveTo(-s * 0.08, -s * 0.1);
  c.lineTo(-s * 0.05, -s * 0.22);
  c.lineTo(0, -s * 0.11);
  c.lineTo(s * 0.05, -s * 0.22);
  c.lineTo(s * 0.08, -s * 0.1);
  c.fill();
  c.restore();
}

export const scene: SceneDef = {
  id: "haunt",
  label: "Haunted hill",
  paint(f: SceneFrame): void {
    const { ctx, w, h, t } = f;
    const dpr = frameDpr(f);
    ctx.drawImage(layerCache("haunt:sky", w, h, dpr, (c) => paintSky(c, w, h)), 0, 0, w, h);

    // A few stars twinkle on top of the cached field.
    ctx.fillStyle = "#ffffff";
    for (let i = 0; i < 14; i++) {
      const a = Math.sin(t * 0.0016 * (0.5 + hash01(i, 91)) + i * 4);
      if (a < 0.4) continue;
      ctx.globalAlpha = (a - 0.4) * 1.2;
      const x = hash01(i, 92) * w;
      const y = hash01(i, 93) * h * 0.45;
      ctx.fillRect(x - 0.5, y - 2, 1, 4);
      ctx.fillRect(x - 2, y - 0.5, 4, 1);
    }
    ctx.globalAlpha = 1;

    // Clouds sliding across the moon.
    const cw = Math.round(w * 0.36);
    const ch = Math.round(h * 0.22);
    for (let i = 0; i < 4; i++) {
      const spr = layerCache(`haunt:cloud${i}`, cw, ch, dpr, (c) => paintCloud(c, cw, ch, 60 + i * 5));
      const x = wrap(hash01(i, 71) * (w + cw) + t * (0.006 + 0.004 * hash01(i, 72)), w + cw) - cw;
      const y = h * (0.03 + 0.075 * i) + Math.sin(t * 0.00005 + i) * h * 0.01;
      ctx.globalAlpha = 0.75 + 0.2 * hash01(i, 73);
      ctx.drawImage(spr, x, y, cw * (0.8 + 0.4 * hash01(i, 74)), ch);
    }
    ctx.globalAlpha = 1;

    ctx.drawImage(layerCache("haunt:land", w, h, dpr, (c) => paintLand(c, w, h)), 0, 0, w, h);

    // Candlelight: a warm pool on the hill, a halo and the glowing carved face, each flickering.
    for (const [i, l] of LANTERNS.entries()) {
      const [x, y, r] = lanternAt(l, w, h);
      const fl = 0.7 + 0.3 * (0.6 * noise1(t * 0.004 + i * 17, 81) + 0.4 * noise1(t * 0.009 + i * 5, 82));
      ctx.save();
      ctx.translate(x, y + r * 0.9);
      ctx.scale(2.4, 0.5);
      glow(ctx, 0, 0, r * 2.4, "255 140 40", 0.3 * fl);
      ctx.restore();
      glow(ctx, x, y, r * 3.2, "255 150 50", 0.22 * fl);
      facePath(ctx, x, y, r, l.mouth);
      const fg = ctx.createRadialGradient(x, y + r * 0.1, 0, x, y, r * 0.8);
      fg.addColorStop(0, `rgb(255 244 180 / ${fl})`);
      fg.addColorStop(1, `rgb(255 170 40 / ${0.85 * fl})`);
      ctx.fillStyle = fg;
      ctx.fill();
    }

    // Bats flitting across.
    ctx.fillStyle = "#06040c";
    for (let i = 0; i < 6; i++) {
      const dir = hash01(i, 61) < 0.5 ? 1 : -1;
      const v = 0.018 + 0.016 * hash01(i, 62);
      const span = w + 240;
      const x = wrap(hash01(i, 63) * span + dir * t * v, span) - 120;
      const y = h * (0.12 + 0.4 * hash01(i, 64)) + Math.sin(t * 0.0011 + i * 2) * h * 0.04 + Math.sin(t * 0.0037 + i) * h * 0.01;
      const s = h * (0.014 + 0.012 * hash01(i, 65));
      bat(ctx, x, y, s, t * 0.011 * (0.85 + 0.3 * hash01(i, 66)) + i);
    }

    // Two banks of ground fog drifting opposite ways.
    const fw = w;
    const fh = Math.round(h * 0.26);
    for (const [k, y, v, a] of [[0, h * 0.68, 0.006, 0.8], [1, h * 0.8, -0.01, 0.9]] as const) {
      const fog = layerCache(`haunt:fog${k}`, fw, fh, dpr, (c) => paintFog(c, fw, fh, 300 + k * 10));
      const x = wrap(t * v, fw);
      ctx.globalAlpha = a;
      ctx.drawImage(fog, x - fw, y, fw, fh);
      ctx.drawImage(fog, x, y, fw, fh);
    }
    ctx.globalAlpha = 1;
  },
};
