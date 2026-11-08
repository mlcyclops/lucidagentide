// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/scenes/meadow.ts
//
// P-SEASON.1 (ADR-0525): Easter, and the one LIGHT scene (the Pastel palette is a light theme). An
// airy spring morning: a pale sky with soft clouds drifting, pastel hills fading into haze, trees in
// blossom, painted eggs nestled in the grass, a few petals on the breeze and butterflies fluttering
// along lazy looping paths. Everything stays pale and low-contrast so dark text on top stays readable.

import { fbm1, frameDpr, glow, hash01, layerCache, wrap, type SceneDef, type SceneFrame } from "../scene_kit.ts";

const HILLS = ["#dcdcf0", "#d3e9dc", "#c4e3cc", "#b4dcbd", "#a5d3ae"];
const BLOSSOM = ["#f8cfdc", "#fde7ee", "#f3b9cd", "#fff4f7"];
const EGGS = [
  { base: "#f9c9d6", ink: "#f2a3ba" },
  { base: "#d9c8f5", ink: "#b9a0ea" },
  { base: "#c7ead9", ink: "#94d2b6" },
  { base: "#fff0b8", ink: "#f6d77a" },
  { base: "#c9e2fa", ink: "#9cc6f0" },
  { base: "#ffd9c4", ink: "#f8b796" },
];
const WINGS = [
  ["#d7bdf5", "#b597e6"],
  ["#ffe39a", "#f2c860"],
  ["#ffc9b3", "#f5a184"],
  ["#b9dcff", "#88bdf0"],
];

function hillY(i: number, x: number, w: number, h: number): number {
  return h * (0.56 + i * 0.075) - (fbm1(x / (w * (0.4 - i * 0.05)), 2, 700 + i * 11) - 0.5) * h * (0.08 + i * 0.02);
}

/** A blossoming tree: a slim forked trunk and a cloud of pink and white blossom clusters. */
function tree(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, seed: number): void {
  ctx.strokeStyle = "#b39a9e";
  ctx.lineCap = "round";
  ctx.lineWidth = s * 0.07;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.quadraticCurveTo(x - s * 0.04, y - s * 0.4, x, y - s * 0.62);
  ctx.moveTo(x, y - s * 0.4);
  ctx.quadraticCurveTo(x - s * 0.15, y - s * 0.6, x - s * 0.3, y - s * 0.78);
  ctx.moveTo(x, y - s * 0.45);
  ctx.quadraticCurveTo(x + s * 0.18, y - s * 0.6, x + s * 0.32, y - s * 0.8);
  ctx.stroke();
  for (let i = 0; i < 46; i++) {
    const a = hash01(seed + i, 1) * Math.PI * 2;
    const d = Math.sqrt(hash01(seed + i, 2));
    const cx = x + Math.cos(a) * d * s * 0.5;
    const cy = y - s * 0.82 + Math.sin(a) * d * s * 0.32;
    const r = s * (0.07 + 0.08 * hash01(seed + i, 3));
    // Lower clusters sit in their own shade, upper ones catch the light.
    const lit = (y - s * 0.82 - cy) / (s * 0.32);
    ctx.fillStyle = BLOSSOM[Math.floor(hash01(seed + i, 4) * BLOSSOM.length)];
    ctx.globalAlpha = 0.75 + 0.25 * lit;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

/** An egg shape: rounder at the bottom, narrower at the top. */
function eggPath(ctx: CanvasRenderingContext2D, x: number, y: number, rw: number, rh: number): void {
  ctx.beginPath();
  ctx.moveTo(x, y - rh);
  ctx.bezierCurveTo(x + rw * 0.78, y - rh, x + rw, y - rh * 0.05, x + rw, y + rh * 0.25);
  ctx.bezierCurveTo(x + rw, y + rh * 0.78, x + rw * 0.55, y + rh, x, y + rh);
  ctx.bezierCurveTo(x - rw * 0.55, y + rh, x - rw, y + rh * 0.78, x - rw, y + rh * 0.25);
  ctx.bezierCurveTo(x - rw, y - rh * 0.05, x - rw * 0.78, y - rh, x, y - rh);
  ctx.closePath();
}

function egg(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, i: number, tilt: number): void {
  const c = EGGS[i % EGGS.length];
  const rw = s * 0.62;
  const rh = s * 0.82;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(tilt);
  // Soft contact shadow in the grass.
  ctx.fillStyle = "rgb(120 160 130 / 0.18)";
  ctx.beginPath();
  ctx.ellipse(0, rh * 0.9, rw * 1.1, rh * 0.22, 0, 0, Math.PI * 2);
  ctx.fill();
  eggPath(ctx, 0, 0, rw, rh);
  const g = ctx.createLinearGradient(-rw, -rh, rw, rh);
  g.addColorStop(0, "#ffffff");
  g.addColorStop(0.35, c.base);
  g.addColorStop(1, c.ink);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.strokeStyle = c.ink;
  ctx.fillStyle = "rgb(255 255 255 / 0.75)";
  ctx.lineWidth = s * 0.07;
  const kind = i % 3;
  if (kind === 0) {
    // A zigzag band between two plain stripes.
    ctx.beginPath();
    for (let k = 0; k <= 8; k++) ctx.lineTo(-rw + (k / 8) * rw * 2, (k % 2 === 0 ? -0.08 : 0.12) * rh);
    ctx.stroke();
    ctx.fillRect(-rw, -rh * 0.32, rw * 2, s * 0.06);
    ctx.fillRect(-rw, rh * 0.32, rw * 2, s * 0.06);
  } else if (kind === 1) {
    // Polka dots.
    for (let k = 0; k < 9; k++) {
      ctx.beginPath();
      ctx.arc(-rw * 0.6 + (k % 3) * rw * 0.6 + (Math.floor(k / 3) % 2) * rw * 0.3, -rh * 0.5 + Math.floor(k / 3) * rh * 0.5, s * 0.07, 0, Math.PI * 2);
      ctx.fill();
    }
  } else {
    // Wavy bands.
    for (let b = -1; b <= 1; b++) {
      ctx.beginPath();
      for (let k = 0; k <= 12; k++) ctx.lineTo(-rw + (k / 12) * rw * 2, b * rh * 0.42 + Math.sin(k * 1.4) * rh * 0.06);
      ctx.stroke();
    }
  }
  ctx.restore();
  // Glossy highlight.
  ctx.fillStyle = "rgb(255 255 255 / 0.55)";
  ctx.beginPath();
  ctx.ellipse(-rw * 0.35, -rh * 0.45, rw * 0.16, rh * 0.22, -0.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function blades(ctx: CanvasRenderingContext2D, x0: number, x1: number, yAt: (x: number) => number, h: number, seed: number, n: number, alpha: number): void {
  ctx.lineCap = "round";
  for (let i = 0; i < n; i++) {
    const x = x0 + hash01(seed + i, 1) * (x1 - x0);
    const y = yAt(x) + h * 0.005;
    const len = h * (0.018 + 0.03 * hash01(seed + i, 2));
    const lean = (hash01(seed + i, 3) - 0.5) * len * 0.8;
    ctx.strokeStyle = hash01(seed + i, 4) < 0.5 ? `rgb(140 196 140 / ${alpha})` : `rgb(170 214 156 / ${alpha})`;
    ctx.lineWidth = 1.2 + hash01(seed + i, 5) * 1.4;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(x + lean * 0.2, y - len * 0.6, x + lean, y - len);
    ctx.stroke();
  }
}

function paintBack(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const g = ctx.createLinearGradient(0, 0, 0, h * 0.62);
  g.addColorStop(0, "#c9def3");
  g.addColorStop(0.55, "#e4eefa");
  g.addColorStop(1, "#fbf4ee");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  glow(ctx, w * 0.2, h * 0.12, Math.max(w, h) * 0.5, "255 248 228", 0.7);
}

function paintLand(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  for (let i = 0; i < HILLS.length; i++) {
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let x = 0; x <= w + 6; x += 6) ctx.lineTo(x, hillY(i, x, w, h));
    ctx.lineTo(w, h);
    ctx.closePath();
    const hg = ctx.createLinearGradient(0, h * (0.5 + i * 0.07), 0, h);
    hg.addColorStop(0, HILLS[i]);
    hg.addColorStop(1, i + 1 < HILLS.length ? HILLS[i + 1] : "#98c9a2");
    ctx.fillStyle = hg;
    ctx.fill();
    // A pale haze settles on each farther hill.
    if (i < 3) {
      const top = hillY(i, w / 2, w, h);
      const mg = ctx.createLinearGradient(0, top, 0, top + h * 0.12);
      mg.addColorStop(0, "rgb(255 255 255 / 0)");
      mg.addColorStop(1, "rgb(255 255 255 / 0.28)");
      ctx.fillStyle = mg;
      ctx.fillRect(0, top, w, h * 0.12);
    }
    if (i === 1) {
      for (let k = 0; k < 7; k++) {
        const x = w * (0.04 + 0.14 * k + 0.05 * hash01(k, 61));
        tree(ctx, x, hillY(1, x, w, h) + h * 0.01, h * (0.09 + 0.04 * hash01(k, 62)), 900 + k * 97);
      }
    }
    if (i === 2) {
      for (const [fx, sc] of [[0.12, 0.2], [0.86, 0.23], [0.63, 0.16]]) {
        const x = w * fx;
        tree(ctx, x, hillY(2, x, w, h) + h * 0.015, h * sc, Math.round(fx * 1000));
      }
    }
  }
  // Foreground: grass, eggs nestled in it, and the grass in front of them.
  const yNear = (x: number): number => hillY(4, x, w, h);
  blades(ctx, 0, w, yNear, h, 1000, Math.round(w / 3), 0.55);
  const spots = [[0.07, 0.04, -0.2], [0.17, 0.08, 0.15], [0.33, 0.06, -0.05], [0.71, 0.07, 0.2], [0.84, 0.05, -0.15], [0.93, 0.09, 0.05]];
  spots.forEach(([fx, dy, tilt], i) => {
    const x = w * fx;
    egg(ctx, x, yNear(x) + h * dy, h * 0.042, i, tilt);
  });
  for (let i = 0; i < spots.length; i++) {
    const x = w * spots[i][0];
    blades(ctx, x - h * 0.05, x + h * 0.05, (xx) => yNear(xx) + h * spots[i][1] + h * 0.03, h, 2000 + i * 50, 22, 0.8);
  }
  blades(ctx, 0, w, (x) => yNear(x) + h * 0.14, h, 3000, Math.round(w / 4), 0.6);
}

/** One drifting cloud sprite: overlapping soft puffs with a faintly lilac-shaded base. */
function cloud(dpr: number, k: number): CanvasImageSource {
  const W = 360;
  const H = 150;
  return layerCache(`meadow-cloud-${k}`, W, H, dpr, (c) => {
    for (let i = 0; i < 9; i++) {
      const x = W * (0.18 + 0.64 * hash01(i + k * 20, 71));
      const y = H * (0.48 + 0.18 * hash01(i + k * 20, 72)) - Math.sin((x / W) * Math.PI) * H * 0.15;
      const r = H * (0.22 + 0.16 * hash01(i + k * 20, 73));
      const g = c.createRadialGradient(x, y - r * 0.3, 0, x, y, r);
      g.addColorStop(0, "rgb(255 255 255 / 0.95)");
      g.addColorStop(0.7, "rgb(250 248 255 / 0.6)");
      g.addColorStop(1, "rgb(236 232 250 / 0)");
      c.fillStyle = g;
      c.fillRect(x - r, y - r, r * 2, r * 2);
    }
  });
}

function butterfly(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, flap: number, heading: number, colors: string[]): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(heading);
  // Each wing pair foreshortens as it beats; the near pair is drawn a touch brighter.
  const open = 0.18 + 0.82 * Math.abs(Math.cos(flap));
  for (const side of [-1, 1]) {
    ctx.save();
    ctx.scale(side * open, 1);
    ctx.fillStyle = colors[0];
    ctx.strokeStyle = colors[1];
    ctx.lineWidth = s * 0.06;
    ctx.beginPath();
    ctx.moveTo(0, -s * 0.05);
    ctx.bezierCurveTo(s * 0.4, -s * 0.85, s * 1.05, -s * 0.7, s * 0.85, -s * 0.15);
    ctx.bezierCurveTo(s * 0.75, s * 0.05, s * 0.3, s * 0.05, 0, 0);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, s * 0.02);
    ctx.bezierCurveTo(s * 0.55, s * 0.05, s * 0.7, s * 0.55, s * 0.32, s * 0.6);
    ctx.bezierCurveTo(s * 0.12, s * 0.62, s * 0.04, s * 0.3, 0, s * 0.1);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "rgb(255 255 255 / 0.6)";
    ctx.beginPath();
    ctx.arc(s * 0.55, -s * 0.4, s * 0.09, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  ctx.fillStyle = "#8f7c96";
  ctx.beginPath();
  ctx.ellipse(0, s * 0.1, s * 0.06, s * 0.36, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#8f7c96";
  ctx.lineWidth = s * 0.03;
  ctx.beginPath();
  ctx.moveTo(-s * 0.02, -s * 0.22);
  ctx.quadraticCurveTo(-s * 0.1, -s * 0.45, -s * 0.18, -s * 0.5);
  ctx.moveTo(s * 0.02, -s * 0.22);
  ctx.quadraticCurveTo(s * 0.1, -s * 0.45, s * 0.18, -s * 0.5);
  ctx.stroke();
  ctx.restore();
}

export const scene: SceneDef = {
  id: "meadow",
  label: "Spring meadow",
  paint(f: SceneFrame): void {
    const { ctx, w, h } = f;
    const ts = f.t / 1000;
    const unit = Math.max(0.6, Math.min(w / 1400, h / 800));
    const dpr = frameDpr(f);
    ctx.drawImage(layerCache("meadow-back", w, h, dpr, (c) => paintBack(c, w, h)), 0, 0, w, h);
    // Clouds drift right at a stroll, each at its own height and pace.
    for (let i = 0; i < 6; i++) {
      const cw = unit * (300 + 160 * hash01(i, 81));
      const ch = cw * (150 / 360);
      const span = w + cw;
      const x = wrap(hash01(i, 82) * span + ts * unit * (3 + 3 * hash01(i, 83)), span) - cw;
      const y = h * (0.04 + 0.3 * hash01(i, 84));
      ctx.globalAlpha = 0.65 + 0.3 * hash01(i, 85);
      ctx.drawImage(cloud(dpr, i % 3), x, y, cw, ch);
    }
    ctx.globalAlpha = 1;
    ctx.drawImage(layerCache("meadow-land", w, h, dpr, (c) => paintLand(c, w, h)), 0, 0, w, h);
    // A few blossom petals riding the breeze.
    ctx.fillStyle = "#f6c3d4";
    for (let i = 0; i < 16; i++) {
      const s = unit * (3 + 2.5 * hash01(i, 91));
      const span = w + 40;
      const x = wrap(hash01(i, 92) * span + ts * unit * (18 + 14 * hash01(i, 93)), span) - 20;
      const y = h * (0.25 + 0.55 * hash01(i, 94)) + Math.sin(ts * 0.7 + i) * unit * 24 + (x / w) * h * 0.08;
      const rot = ts * (0.8 + hash01(i, 95)) + i;
      ctx.globalAlpha = 0.75;
      ctx.beginPath();
      ctx.ellipse(x, y, s, s * (0.35 + 0.3 * Math.abs(Math.sin(rot * 1.3))), rot, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    // Butterflies on slow looping paths, wings beating, pausing now and then to glide.
    for (let i = 0; i < 4; i++) {
      const px = (k: number): number => w * (0.15 + 0.7 * hash01(i, 101)) + Math.sin(k * (0.11 + 0.04 * i) + i * 2) * w * 0.12 + Math.sin(k * 0.37 + i) * unit * 30;
      const py = (k: number): number => h * (0.4 + 0.3 * hash01(i, 102)) + Math.sin(k * (0.17 + 0.03 * i) + i) * h * 0.08 + Math.sin(k * 1.1 + i * 3) * unit * 10;
      const x = px(ts);
      const y = py(ts);
      const vx = px(ts + 0.1) - x;
      const vy = py(ts + 0.1) - y;
      const heading = Math.max(-0.6, Math.min(0.6, Math.atan2(vy, Math.abs(vx)) * 0.5)) * Math.sign(vx || 1);
      const flap = ts * 11 + i * 1.7;
      butterfly(ctx, x, y, unit * (17 + 4 * hash01(i, 103)), flap, heading, WINGS[i]);
    }
  },
};
