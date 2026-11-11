// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/scenes/torch.ts
//
// P-SEASON.1 (ADR-0525): an Olympic-style night. Inside a great stadium bowl rimmed with lights,
// searchlight beams sweep the sky while a golden cauldron on a tall column holds a living flame:
// three layers of tongues flickering additively, embers rising and drifting, and gold sparkles
// twinkling through the air. The crowd's phone lights shimmer in the tiers. No protected marks (in
// particular, no rings). Sky, and bowl with cauldron, are two cached layers; beams sit between them.

import { frameDpr, glow, hash01, layerCache, noise1, wrap, type SceneDef, type SceneFrame } from "../scene_kit.ts";

const TAU = Math.PI * 2;

const rimY = (x: number, w: number, h: number): number => h * (0.53 - 0.24 * ((x - w / 2) / (w / 2)) ** 2);
const fieldY = (x: number, w: number, h: number): number => h * (0.74 + 0.06 * ((x - w / 2) / (w / 2)) ** 2);

interface Cauldron { x: number; y: number; r: number }
const cauldron = (w: number, h: number): Cauldron => ({ x: w * 0.66, y: h * 0.4, r: h * 0.085 });

function paintSky(c: CanvasRenderingContext2D, w: number, h: number): void {
  const g = c.createLinearGradient(0, 0, 0, h * 0.6);
  g.addColorStop(0, "#04061a");
  g.addColorStop(0.55, "#111641");
  g.addColorStop(1, "#2a2154");
  c.fillStyle = g;
  c.fillRect(0, 0, w, h);
  c.fillStyle = "#e8ecff";
  for (let i = 0; i < 110; i++) {
    c.globalAlpha = 0.15 + 0.45 * hash01(i, 1);
    c.fillRect(hash01(i, 2) * w, Math.pow(hash01(i, 3), 1.3) * h * 0.5, 1.2, 1.2);
  }
  c.globalAlpha = 1;
  // Light spill rising out of the bowl.
  c.save();
  c.translate(w / 2, h * 0.55);
  c.scale(2.2, 1);
  glow(c, 0, 0, h * 0.45, "120 110 200", 0.3);
  c.restore();
}

function paintBowl(c: CanvasRenderingContext2D, w: number, h: number): void {
  // Stands: dark tiers between the rim and the field edge.
  c.beginPath();
  c.moveTo(0, h);
  for (let x = 0; x <= w + 8; x += 8) c.lineTo(x, rimY(x, w, h));
  c.lineTo(w, h);
  c.closePath();
  const sg = c.createLinearGradient(0, h * 0.28, 0, h * 0.8);
  sg.addColorStop(0, "#0b0d22");
  sg.addColorStop(1, "#181a36");
  c.fillStyle = sg;
  c.fill();
  // Tier walkways and radial aisles.
  for (let k = 1; k < 9; k++) {
    c.beginPath();
    for (let x = 0; x <= w + 8; x += 8) {
      const y = rimY(x, w, h) + (fieldY(x, w, h) - rimY(x, w, h)) * Math.pow(k / 9, 1.15);
      if (x === 0) c.moveTo(x, y);
      else c.lineTo(x, y);
    }
    c.strokeStyle = k === 4 ? "rgb(180 170 255 / 0.18)" : "rgb(0 0 0 / 0.35)";
    c.lineWidth = k === 4 ? 2 : 1;
    c.stroke();
  }
  c.strokeStyle = "rgb(0 0 0 / 0.3)";
  c.lineWidth = 1;
  for (let i = 0; i <= 28; i++) {
    const x = (i / 28) * w;
    const x2 = w / 2 + (x - w / 2) * 1.12;
    c.beginPath();
    c.moveTo(x, rimY(x, w, h));
    c.lineTo(x2, fieldY(x2, w, h));
    c.stroke();
  }
  // Roof ring with a row of rim lamps.
  c.beginPath();
  for (let x = 0; x <= w + 8; x += 8) {
    if (x === 0) c.moveTo(x, rimY(x, w, h) - 3);
    else c.lineTo(x, rimY(x, w, h) - 3);
  }
  c.strokeStyle = "#20234a";
  c.lineWidth = 6;
  c.stroke();
  for (let i = 0; i < 60; i++) {
    const x = ((i + 0.5) / 60) * w;
    glow(c, x, rimY(x, w, h) - 4, 7, "255 236 200", 0.6);
  }

  // Field: dark infield, lit centre, a running-track oval.
  c.beginPath();
  c.moveTo(0, h);
  for (let x = 0; x <= w + 8; x += 8) c.lineTo(x, fieldY(x, w, h));
  c.lineTo(w, h);
  c.closePath();
  const fg = c.createLinearGradient(0, h * 0.74, 0, h);
  fg.addColorStop(0, "#0d2a20");
  fg.addColorStop(1, "#06140f");
  c.fillStyle = fg;
  c.fill();
  for (const [rx, ry, col, lw] of [[0.62, 0.17, "#5a2a26", 14], [0.55, 0.14, "#4a2220", 10]] as const) {
    c.beginPath();
    c.ellipse(w / 2, h * 0.92, w * rx, h * ry, 0, Math.PI, TAU);
    c.strokeStyle = col;
    c.lineWidth = lw;
    c.stroke();
  }
  c.strokeStyle = "rgb(255 255 255 / 0.12)";
  c.lineWidth = 1;
  for (let k = 0; k < 6; k++) {
    c.beginPath();
    c.ellipse(w / 2, h * 0.92, w * (0.545 + k * 0.016), h * (0.135 + k * 0.007), 0, Math.PI, TAU);
    c.stroke();
  }

  // The cauldron column: tapered, with gold collars.
  const { x, y, r } = cauldron(w, h);
  const colTop = y + r * 0.55;
  const colBot = fieldY(x, w, h) + 4;
  const cg = c.createLinearGradient(x - r * 0.3, 0, x + r * 0.3, 0);
  cg.addColorStop(0, "#5a4a3a");
  cg.addColorStop(0.35, "#2a2230");
  cg.addColorStop(1, "#0e0c18");
  c.fillStyle = cg;
  c.beginPath();
  c.moveTo(x - r * 0.14, colTop);
  c.lineTo(x + r * 0.14, colTop);
  c.lineTo(x + r * 0.32, colBot);
  c.lineTo(x - r * 0.32, colBot);
  c.closePath();
  c.fill();
  for (const fy of [0.08, 0.45, 0.8]) {
    const yy = colTop + (colBot - colTop) * fy;
    const hw = r * (0.16 + 0.17 * fy);
    const gg = c.createLinearGradient(x - hw, 0, x + hw, 0);
    gg.addColorStop(0, "#ffe08a");
    gg.addColorStop(0.5, "#c08a2a");
    gg.addColorStop(1, "#5a3a10");
    c.fillStyle = gg;
    c.fillRect(x - hw - 2, yy, hw * 2 + 4, Math.max(3, r * 0.06));
  }
  // The bowl: a wide golden chalice lit from the flame above.
  c.beginPath();
  c.moveTo(x - r * 1.1, y - r * 0.05);
  c.bezierCurveTo(x - r * 1.0, y + r * 0.45, x - r * 0.4, y + r * 0.62, x - r * 0.14, y + r * 0.62);
  c.lineTo(x + r * 0.14, y + r * 0.62);
  c.bezierCurveTo(x + r * 0.4, y + r * 0.62, x + r * 1.0, y + r * 0.45, x + r * 1.1, y - r * 0.05);
  c.closePath();
  const bg = c.createLinearGradient(x - r * 1.1, 0, x + r * 1.1, 0);
  bg.addColorStop(0, "#7a5418");
  bg.addColorStop(0.3, "#ffd77a");
  bg.addColorStop(0.55, "#d29a3a");
  bg.addColorStop(1, "#4a300c");
  c.fillStyle = bg;
  c.fill();
  c.strokeStyle = "rgb(60 36 8 / 0.5)";
  c.lineWidth = 1.2;
  for (let k = 1; k < 9; k++) {
    const u = k / 9 - 0.5;
    c.beginPath();
    c.moveTo(x + u * r * 2.1, y);
    c.quadraticCurveTo(x + u * r * 1.6, y + r * 0.45, x + u * r * 0.3, y + r * 0.6);
    c.stroke();
  }
  c.beginPath();
  c.ellipse(x, y - r * 0.05, r * 1.1, r * 0.16, 0, 0, TAU);
  c.fillStyle = "#2a1606";
  c.fill();
  c.strokeStyle = "#ffe6a0";
  c.lineWidth = 2.5;
  c.stroke();
}

interface Tongue { n: number; wk: number; hk: number; c0: string; c1: string }
const TONGUES: readonly Tongue[] = [
  { n: 12, wk: 1.0, hk: 1.0, c0: "rgb(255 60 16 / 0.32)", c1: "rgb(180 20 8 / 0)" },
  { n: 10, wk: 0.8, hk: 0.85, c0: "rgb(255 130 30 / 0.36)", c1: "rgb(255 80 20 / 0)" },
  { n: 8, wk: 0.58, hk: 0.62, c0: "rgb(255 200 90 / 0.42)", c1: "rgb(255 150 40 / 0)" },
  { n: 6, wk: 0.36, hk: 0.42, c0: "rgb(255 250 220 / 0.55)", c1: "rgb(255 220 140 / 0)" },
];

function paintFlame(ctx: CanvasRenderingContext2D, x: number, by: number, bw: number, H: number, t: number): void {
  ctx.globalCompositeOperation = "lighter";
  for (const [L, tg] of TONGUES.entries()) {
    const g = ctx.createLinearGradient(0, by, 0, by - H * tg.hk);
    g.addColorStop(0, tg.c0);
    g.addColorStop(0.55, tg.c0);
    g.addColorStop(1, tg.c1);
    ctx.fillStyle = g;
    for (let i = 0; i < tg.n; i++) {
      const u = (i + 0.5) / tg.n - 0.5;
      const bx = x + u * bw * tg.wk;
      const hw = ((bw * tg.wk) / tg.n) * 1.6;
      const seed = i * 3.1 + L * 11;
      const fh = H * tg.hk * (0.35 + 0.65 * noise1(t * 0.0016 + seed, 5)) * (0.55 + 0.45 * hash01(i, L + 7)) * (1 - Math.abs(u) * 1.1);
      const tx = bx + Math.sin(t * 0.0021 + seed) * bw * 0.06 + (noise1(t * 0.0013 + seed, 6) - 0.5) * bw * 0.24 - u * bw * 0.12;
      const mx = (bx + tx) / 2 + Math.sin(t * 0.0031 + seed * 2) * hw * 0.5;
      ctx.beginPath();
      ctx.moveTo(bx - hw, by);
      ctx.bezierCurveTo(bx - hw, by - fh * 0.35, mx - hw * 0.45, by - fh * 0.62, tx, by - fh);
      ctx.bezierCurveTo(mx + hw * 0.45, by - fh * 0.62, bx + hw, by - fh * 0.35, bx + hw, by);
      ctx.closePath();
      ctx.fill();
    }
  }
  glow(ctx, x, by - H * 0.12, bw * 0.4, "255 236 190", 0.45);
  ctx.globalCompositeOperation = "source-over";
}

function sparkle(ctx: CanvasRenderingContext2D, x: number, y: number, s: number): void {
  ctx.beginPath();
  ctx.moveTo(x, y - s);
  ctx.quadraticCurveTo(x, y, x + s, y);
  ctx.quadraticCurveTo(x, y, x, y + s);
  ctx.quadraticCurveTo(x, y, x - s, y);
  ctx.quadraticCurveTo(x, y, x, y - s);
  ctx.fill();
}

export const scene: SceneDef = {
  id: "torch",
  label: "Cauldron night",
  paint(f: SceneFrame): void {
    const { ctx, w, h, t } = f;
    const dpr = frameDpr(f);
    ctx.drawImage(layerCache("torch:sky", w, h, dpr, (c) => paintSky(c, w, h)), 0, 0, w, h);

    // Searchlights sweeping up from the rim.
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < 6; i++) {
      const bx = ((i + 0.5) / 6) * w;
      const by = rimY(bx, w, h) - 4;
      const lean = (bx - w / 2) / (w / 2);
      const a = -Math.PI / 2 + lean * 0.35 + Math.sin(t * 0.00022 + i * 1.3) * 0.32;
      const len = h * 1.1;
      const spread = 0.035;
      const g = ctx.createLinearGradient(bx, by, bx + Math.cos(a) * len, by + Math.sin(a) * len);
      const rgb = i % 2 === 0 ? "255 238 200" : "190 210 255";
      g.addColorStop(0, `rgb(${rgb} / 0.2)`);
      g.addColorStop(1, `rgb(${rgb} / 0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(bx - 3, by);
      ctx.lineTo(bx + Math.cos(a - spread) * len, by + Math.sin(a - spread) * len);
      ctx.lineTo(bx + Math.cos(a + spread) * len, by + Math.sin(a + spread) * len);
      ctx.lineTo(bx + 3, by);
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";

    ctx.drawImage(layerCache("torch:bowl", w, h, dpr, (c) => paintBowl(c, w, h)), 0, 0, w, h);

    // Phone lights shimmering in the tiers.
    ctx.fillStyle = "#fff6e0";
    for (let i = 0; i < 320; i++) {
      const x = hash01(i, 11) * w;
      const top = rimY(x, w, h) + 6;
      const y = top + hash01(i, 12) * (fieldY(x, w, h) - top - 6);
      const a = 0.35 + 0.4 * Math.sin(t * 0.0015 * (0.5 + hash01(i, 13)) + i);
      if (a <= 0) continue;
      ctx.globalAlpha = a;
      ctx.fillRect(x, y, 1.6, 1.6);
    }
    ctx.globalAlpha = 1;

    // The flame and its light.
    const { x, y, r } = cauldron(w, h);
    const fl = 0.85 + 0.15 * noise1(t * 0.003, 21);
    glow(ctx, x, y - r * 0.6, r * 4.5, "255 140 50", 0.32 * fl);
    glow(ctx, x, y - r * 0.4, r * 2.2, "255 200 120", 0.35 * fl);
    paintFlame(ctx, x, y + r * 0.02, r * 2.0, r * 2.6, t);

    // Embers rising off the flame, drifting with the breeze.
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < 46; i++) {
      const p = wrap(t / (3800 + 2400 * hash01(i, 31)) + hash01(i, 32), 1);
      const ex = x + (hash01(i, 33) - 0.5) * r * 1.4 + p * r * 1.6 + Math.sin(t * 0.002 + i) * r * 0.25 * p;
      const ey = y - r * 0.8 - p * h * 0.36;
      ctx.globalAlpha = (1 - p) * Math.min(1, p * 10) * 0.9;
      ctx.fillStyle = p < 0.4 ? "#ffd27a" : "#ff7a3a";
      const s = 1.2 + 1.6 * hash01(i, 34) * (1 - p * 0.5);
      ctx.fillRect(ex, ey, s, s);
    }
    ctx.globalCompositeOperation = "source-over";

    // Gold sparkles: brief four-point glints, some drifting slowly down.
    ctx.fillStyle = "#ffe39a";
    for (let i = 0; i < 44; i++) {
      const tw = Math.sin(t * 0.0012 * (0.5 + hash01(i, 41)) + hash01(i, 42) * TAU);
      if (tw < 0.5) continue;
      const sx = hash01(i, 43) * w;
      const sy = wrap(hash01(i, 44) * h * 0.7 + t * 0.004 * hash01(i, 45), h * 0.7);
      ctx.globalAlpha = Math.pow((tw - 0.5) * 2, 2);
      sparkle(ctx, sx, sy, 3 + 5 * hash01(i, 46));
    }
    ctx.globalAlpha = 1;
  },
};
