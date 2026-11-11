// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/scenes/snow.ts
//
// P-SEASON.1 (ADR-0525): a cozy Christmas night. Moonlit snowy mountains and three parallax depths of
// snow-laden pines, a log cabin with firelit windows, a wreath on the door and smoke curling from the
// chimney, strings of red, green, gold and white lights draped between the near trees and along the
// eaves, and snow falling in three depths. The scenery and the light wires are one cached layer; per
// frame: smoke, window flicker, the twinkling bulbs, snow and a few glints on the drifts.

import { frameDpr, glow, hash01, layerCache, noise1, ridge, wrap, type SceneDef, type SceneFrame } from "../scene_kit.ts";

const TAU = Math.PI * 2;
const BULB_RGB = ["255 70 70", "80 230 120", "255 200 80", "235 240 255"] as const;

const groundY = (x: number, w: number, h: number): number =>
  h * 0.765 + h * 0.025 * Math.sin((x / w) * 4.4 + 0.6) + h * 0.006 * noise1(x / 60, 3);

interface Cabin { x: number; y: number; cw: number; ch: number }
function cabinBox(w: number, h: number): Cabin {
  const cw = Math.min(w * 0.15, h * 0.26);
  const x = w * 0.6;
  return { x, y: groundY(x + cw / 2, w, h) + h * 0.004, cw, ch: cw * 0.42 };
}

/** One snow-laden pine: drooping tiers drawn bottom-up, each with a snow cap along its upper edges. */
function pine(c: CanvasRenderingContext2D, x: number, base: number, H: number, body: string, snow: string, salt: number): void {
  c.fillStyle = "#1a120e";
  c.fillRect(x - H * 0.025, base - H * 0.08, H * 0.05, H * 0.1);
  const n = 6;
  for (let k = n - 1; k >= 0; k--) {
    const top = base - H + (k * H * 0.78) / n;
    const hw = H * (0.1 + (0.28 * (k + 1)) / n) * (0.9 + 0.2 * hash01(k, salt));
    const bot = top + H * 0.3;
    c.beginPath();
    c.moveTo(x, top);
    c.quadraticCurveTo(x + hw * 0.35, bot - H * 0.12, x + hw, bot + H * 0.012);
    for (let s = 4; s >= -4; s--) {
      const bx = x + (s / 4.5) * hw;
      c.quadraticCurveTo(bx + hw * 0.06, bot - H * 0.03, bx, bot + (s % 2 === 0 ? 0 : -H * 0.012));
    }
    c.lineTo(x - hw, bot + H * 0.012);
    c.quadraticCurveTo(x - hw * 0.35, bot - H * 0.12, x, top);
    c.fillStyle = body;
    c.fill();
    // Snow riding the tier's shoulders, heavier on the moonlit left.
    c.beginPath();
    c.moveTo(x, top - H * 0.006);
    c.quadraticCurveTo(x + hw * 0.33, bot - H * 0.13, x + hw * 0.92, bot - H * 0.005);
    c.quadraticCurveTo(x + hw * 0.55, bot - H * 0.06, x + hw * 0.3, bot - H * 0.09);
    c.quadraticCurveTo(x, bot - H * 0.06 - H * 0.04 * hash01(k, salt + 1), x - hw * 0.4, bot - H * 0.07);
    c.quadraticCurveTo(x - hw * 0.7, bot - H * 0.02, x - hw * 0.95, bot);
    c.quadraticCurveTo(x - hw * 0.36, bot - H * 0.14, x, top - H * 0.006);
    c.fillStyle = snow;
    c.fill();
  }
}

interface Bulb { x: number; y: number; color: number; phase: number }
interface Wire { pts: [number, number][] }
let rigKey = "";
let rig: { wires: Wire[]; bulbs: Bulb[] } = { wires: [], bulbs: [] };

/** The light strings: sagging catenary-like wires between near trees and along the cabin eaves. */
function lights(w: number, h: number): { wires: Wire[]; bulbs: Bulb[] } {
  const key = `${w}x${h}`;
  if (key === rigKey) return rig;
  const wires: Wire[] = [];
  const bulbs: Bulb[] = [];
  const span = (x0: number, y0: number, x1: number, y1: number, sag: number, count: number): void => {
    const pts: [number, number][] = [];
    for (let i = 0; i <= 40; i++) {
      const u = i / 40;
      pts.push([x0 + (x1 - x0) * u, y0 + (y1 - y0) * u + sag * 4 * u * (1 - u)]);
    }
    wires.push({ pts });
    for (let i = 1; i < count; i++) {
      const u = i / count;
      bulbs.push({
        x: x0 + (x1 - x0) * u,
        y: y0 + (y1 - y0) * u + sag * 4 * u * (1 - u) + 3,
        color: bulbs.length % 4,
        phase: hash01(bulbs.length, 77) * TAU,
      });
    }
  };
  span(w * 0.045, h * 0.6, w * 0.185, h * 0.68, h * 0.07, 14);
  span(w * 0.19, h * 0.7, w * 0.31, h * 0.79, h * 0.06, 12);
  span(w * 0.88, h * 0.56, w * 0.985, h * 0.52, h * 0.06, 11);
  span(w * 0.045, h * 0.76, w * 0.185, h * 0.81, h * 0.05, 13);
  const cb = cabinBox(w, h);
  const eave = cb.y - cb.ch - cb.cw * 0.02;
  for (let k = 0; k < 4; k++) {
    const x0 = cb.x - cb.cw * 0.06 + (k * cb.cw * 1.12) / 4;
    span(x0, eave, x0 + (cb.cw * 1.12) / 4, eave, cb.cw * 0.035, 5);
  }
  rigKey = key;
  rig = { wires, bulbs };
  return rig;
}

function paintStatic(c: CanvasRenderingContext2D, w: number, h: number): void {
  const g = c.createLinearGradient(0, 0, 0, h * 0.8);
  g.addColorStop(0, "#070d24");
  g.addColorStop(0.4, "#122147");
  g.addColorStop(0.75, "#26395f");
  g.addColorStop(1, "#3b4c74");
  c.fillStyle = g;
  c.fillRect(0, 0, w, h);
  c.fillStyle = "#eef2ff";
  for (let i = 0; i < 160; i++) {
    c.globalAlpha = 0.15 + 0.55 * hash01(i, 1);
    const s = hash01(i, 2) < 0.08 ? 1.8 : 1;
    c.fillRect(hash01(i, 3) * w, Math.pow(hash01(i, 4), 1.5) * h * 0.55, s, s);
  }
  c.globalAlpha = 1;
  const mx = w * 0.17;
  const my = h * 0.17;
  const R = h * 0.042;
  glow(c, mx, my, h * 0.6, "150 175 235", 0.22);
  glow(c, mx, my, R * 3, "220 230 255", 0.3);
  const mg = c.createRadialGradient(mx - R * 0.3, my - R * 0.3, 0, mx, my, R);
  mg.addColorStop(0, "#ffffff");
  mg.addColorStop(1, "#dfe6f6");
  c.fillStyle = mg;
  c.beginPath();
  c.arc(mx, my, R, 0, TAU);
  c.fill();

  // Snowy mountains: a pale moonlit body with a soft lit crest.
  ridge(c, w, h, h * 0.5, h * 0.09, 420, 21, "#5d7298");
  ridge(c, w, h, h * 0.56, h * 0.06, 300, 22, "#3f557d");
  const haze = c.createLinearGradient(0, h * 0.45, 0, h * 0.66);
  haze.addColorStop(0, "rgb(140 165 210 / 0)");
  haze.addColorStop(1, "rgb(140 165 210 / 0.35)");
  c.fillStyle = haze;
  c.fillRect(0, h * 0.45, w, h * 0.21);

  // Far and middle forests.
  for (let i = 0; i < 80; i++) {
    const x = (i / 80) * w + (hash01(i, 31) - 0.5) * w * 0.02;
    pine(c, x, h * 0.64 + h * 0.01 * hash01(i, 32), h * (0.05 + 0.04 * hash01(i, 33)), "#2a3d62", "#91a7cb", 500 + i);
  }
  ridge(c, w, h, h * 0.655, h * 0.012, 200, 23, "#9fb3d4");
  for (let i = 0; i < 34; i++) {
    const x = (i / 34) * w + (hash01(i, 41) - 0.5) * w * 0.03;
    if (Math.abs(x - w * 0.67) < w * 0.07) continue;
    pine(c, x, h * 0.72 + h * 0.015 * hash01(i, 42), h * (0.1 + 0.07 * hash01(i, 43)), "#18284a", "#c2d1ea", 600 + i);
  }

  // Snowfield with soft drifts.
  c.beginPath();
  c.moveTo(0, h);
  for (let x = 0; x <= w + 8; x += 8) c.lineTo(x, groundY(x, w, h));
  c.lineTo(w, h);
  c.closePath();
  const sg = c.createLinearGradient(0, h * 0.72, 0, h);
  sg.addColorStop(0, "#c9d6ee");
  sg.addColorStop(0.5, "#a6b8da");
  sg.addColorStop(1, "#7d91ba");
  c.fillStyle = sg;
  c.fill();
  for (let i = 0; i < 9; i++) {
    const x = hash01(i, 51) * w;
    const y = h * (0.82 + 0.15 * hash01(i, 52));
    c.save();
    c.translate(x, y);
    c.scale(1, 0.12);
    glow(c, 0, 0, w * (0.08 + 0.1 * hash01(i, 53)), hash01(i, 54) < 0.5 ? "70 90 140" : "235 242 255", 0.22);
    c.restore();
  }

  // The cabin.
  const { x: cx, y: cy, cw, ch } = cabinBox(w, h);
  c.save();
  c.translate(cx + cw * 0.55, cy + 2);
  c.scale(1, 0.12);
  glow(c, 0, 0, cw * 0.75, "30 40 80", 0.35);
  c.restore();
  const wall = c.createLinearGradient(cx, 0, cx + cw, 0);
  wall.addColorStop(0, "#6a4330");
  wall.addColorStop(1, "#3c241a");
  c.fillStyle = wall;
  c.fillRect(cx, cy - ch, cw, ch);
  c.strokeStyle = "rgb(20 10 6 / 0.55)";
  c.lineWidth = 1;
  for (let k = 1; k < 7; k++) {
    c.beginPath();
    c.moveTo(cx, cy - ch + (k * ch) / 7);
    c.lineTo(cx + cw, cy - ch + (k * ch) / 7);
    c.stroke();
  }
  // Chimney.
  c.fillStyle = "#4a4250";
  c.fillRect(cx + cw * 0.72, cy - ch - cw * 0.36, cw * 0.09, cw * 0.3);
  c.fillStyle = "#eef3ff";
  c.fillRect(cx + cw * 0.71, cy - ch - cw * 0.37, cw * 0.11, cw * 0.025);
  // Snow-heavy roof with an overhang.
  c.beginPath();
  c.moveTo(cx - cw * 0.08, cy - ch + cw * 0.01);
  c.lineTo(cx + cw * 0.5, cy - ch - cw * 0.3);
  c.lineTo(cx + cw * 1.08, cy - ch + cw * 0.01);
  c.closePath();
  c.fillStyle = "#2c1c16";
  c.fill();
  c.beginPath();
  c.moveTo(cx - cw * 0.1, cy - ch - cw * 0.005);
  c.quadraticCurveTo(cx + cw * 0.2, cy - ch - cw * 0.2, cx + cw * 0.5, cy - ch - cw * 0.335);
  c.quadraticCurveTo(cx + cw * 0.8, cy - ch - cw * 0.2, cx + cw * 1.1, cy - ch - cw * 0.005);
  for (let k = 10; k >= 0; k--) c.lineTo(cx - cw * 0.1 + (k * cw * 1.2) / 10, cy - ch + cw * (k % 2 === 0 ? 0.012 : 0.03));
  c.closePath();
  const roof = c.createLinearGradient(cx, 0, cx + cw, 0);
  roof.addColorStop(0, "#f4f8ff");
  roof.addColorStop(1, "#b9c7e2");
  c.fillStyle = roof;
  c.fill();
  // Windows (lit per frame), door and wreath.
  for (const wx of [0.12, 0.66]) {
    c.fillStyle = "#2a160c";
    c.fillRect(cx + cw * wx - 2, cy - ch * 0.78 - 2, cw * 0.2 + 4, ch * 0.42 + 4);
  }
  c.fillStyle = "#3a2216";
  c.fillRect(cx + cw * 0.41, cy - ch * 0.72, cw * 0.18, ch * 0.72);
  c.strokeStyle = "#2f6a3a";
  c.lineWidth = cw * 0.022;
  c.beginPath();
  c.arc(cx + cw * 0.5, cy - ch * 0.5, cw * 0.045, 0, TAU);
  c.stroke();
  c.fillStyle = "#d8323a";
  c.beginPath();
  c.arc(cx + cw * 0.5, cy - ch * 0.5 + cw * 0.045, cw * 0.012, 0, TAU);
  c.fill();
  // Snow piled along the cabin's foot.
  c.fillStyle = "#dfe8f8";
  c.beginPath();
  c.ellipse(cx + cw * 0.5, cy, cw * 0.6, ch * 0.08, 0, Math.PI, 0);
  c.fill();

  // Near pines framing both sides.
  for (const [fx, fH, salt] of [[0.045, 0.6, 1], [0.19, 0.44, 2], [0.31, 0.3, 3], [0.88, 0.52, 4], [0.985, 0.64, 5]] as const) {
    const x = fx * w;
    pine(c, x, groundY(x, w, h) + h * 0.12, h * fH, "#0d1a2c", "#e6eeff", 700 + salt * 13);
  }

  // Light wires.
  c.strokeStyle = "#0a1220";
  c.lineWidth = 1.2;
  for (const wire of lights(w, h).wires) {
    c.beginPath();
    for (const [i, [x, y]] of wire.pts.entries()) {
      if (i === 0) c.moveTo(x, y);
      else c.lineTo(x, y);
    }
    c.stroke();
  }
}

function paintBulbSprite(c: CanvasRenderingContext2D, rgb: string): void {
  glow(c, 16, 16, 16, rgb, 0.55);
  glow(c, 16, 16, 6, "255 255 245", 0.5);
  c.fillStyle = `rgb(${rgb})`;
  c.beginPath();
  c.arc(16, 16, 2.4, 0, TAU);
  c.fill();
  c.fillStyle = "rgb(255 255 255 / 0.8)";
  c.beginPath();
  c.arc(15.3, 15.3, 1, 0, TAU);
  c.fill();
}

export const scene: SceneDef = {
  id: "snow",
  label: "Snowy night",
  paint(f: SceneFrame): void {
    const { ctx, w, h, t } = f;
    const dpr = frameDpr(f);
    ctx.drawImage(layerCache("snow:static", w, h, dpr, (c) => paintStatic(c, w, h)), 0, 0, w, h);
    const cb = cabinBox(w, h);

    // Chimney smoke: soft puffs rising, widening, leaning downwind and fading.
    const puff = layerCache("snow:puff", 64, 64, dpr, (c) => glow(c, 32, 32, 32, "190 200 225", 0.5));
    const chx = cb.x + cb.cw * 0.765;
    const chy = cb.y - cb.ch - cb.cw * 0.37;
    for (let i = 0; i < 12; i++) {
      const p = wrap(t / 9000 + i / 12, 1);
      const r = cb.cw * (0.05 + p * 0.3);
      const x = chx + p * p * cb.cw * 0.9 + Math.sin(t * 0.0007 + i * 1.3) * cb.cw * 0.04 * p;
      const y = chy - p * h * 0.22;
      ctx.globalAlpha = (1 - p) * Math.min(1, p * 8) * 0.55;
      ctx.drawImage(puff, x - r, y - r, r * 2, r * 2);
    }

    // Firelit windows.
    const fl = 0.8 + 0.2 * (0.6 * noise1(t * 0.003, 9) + 0.4 * noise1(t * 0.011, 10));
    for (const wx of [0.12, 0.66]) {
      const x = cb.x + cb.cw * wx;
      const y = cb.y - cb.ch * 0.78;
      const ww = cb.cw * 0.2;
      const wh = cb.ch * 0.42;
      ctx.globalAlpha = 1;
      const wg = ctx.createLinearGradient(0, y, 0, y + wh);
      wg.addColorStop(0, `rgb(255 214 130 / ${fl})`);
      wg.addColorStop(1, `rgb(255 150 60 / ${fl})`);
      ctx.fillStyle = wg;
      ctx.fillRect(x, y, ww, wh);
      ctx.fillStyle = "#2a160c";
      ctx.fillRect(x + ww / 2 - 1, y, 2, wh);
      ctx.fillRect(x, y + wh / 2 - 1, ww, 2);
      glow(ctx, x + ww / 2, y + wh / 2, ww * 1.6, "255 170 80", 0.25 * fl);
      ctx.save();
      ctx.translate(x + ww / 2, cb.y + cb.ch * 0.2);
      ctx.scale(2.2, 0.35);
      glow(ctx, 0, 0, ww * 1.1, "255 170 90", 0.28 * fl);
      ctx.restore();
    }

    // Twinkling bulbs: a slow breathing glow per bulb plus a gentle chase along each string.
    const sprites = BULB_RGB.map((rgb, k) => layerCache(`snow:bulb${k}`, 32, 32, dpr, (c) => paintBulbSprite(c, rgb)));
    const s = Math.max(20, h * 0.038);
    for (const [i, b] of lights(w, h).bulbs.entries()) {
      const tw = 0.55 + 0.25 * Math.sin(t * 0.0018 + b.phase) + 0.2 * Math.max(0, Math.sin(t * 0.0012 - i * 0.45));
      ctx.globalAlpha = tw;
      ctx.drawImage(sprites[b.color], b.x - s / 2, b.y - s / 2, s, s);
    }

    // Snowfall in three depths.
    ctx.fillStyle = "#f2f6ff";
    for (let i = 0; i < 160; i++) {
      const x = wrap(hash01(i, 61) * w + Math.sin(t * 0.0005 + i) * 8 + t * 0.003, w);
      const y = wrap(hash01(i, 62) * h + t * 0.012 * (0.8 + 0.4 * hash01(i, 63)), h);
      ctx.globalAlpha = 0.45;
      ctx.fillRect(x, y, 1.3, 1.3);
    }
    for (let i = 0; i < 80; i++) {
      const x = wrap(hash01(i, 71) * w + Math.sin(t * 0.0007 + i * 2) * 16 + t * 0.005, w);
      const y = wrap(hash01(i, 72) * h + t * 0.022 * (0.8 + 0.4 * hash01(i, 73)), h);
      ctx.globalAlpha = 0.75;
      ctx.beginPath();
      ctx.arc(x, y, 1.6, 0, TAU);
      ctx.fill();
    }
    const flake = layerCache("snow:flake", 32, 32, dpr, (c) => {
      glow(c, 16, 16, 16, "240 246 255", 0.9);
      glow(c, 16, 16, 8, "255 255 255", 0.9);
    });
    for (let i = 0; i < 26; i++) {
      const r = (4 + 4 * hash01(i, 81)) * (h / 800);
      const x = wrap(hash01(i, 82) * w + Math.sin(t * 0.0006 + i * 3) * 30 + t * 0.008, w + 40) - 20;
      const y = wrap(hash01(i, 83) * (h + 40) + t * 0.04 * (0.8 + 0.4 * hash01(i, 84)), h + 40) - 20;
      ctx.globalAlpha = 0.85;
      ctx.drawImage(flake, x - r, y - r, r * 2, r * 2);
    }

    // Glints on the drifts.
    ctx.fillStyle = "#ffffff";
    for (let i = 0; i < 30; i++) {
      const a = Math.sin(t * 0.002 * (0.5 + hash01(i, 91)) + i * 5);
      if (a < 0.6) continue;
      const x = hash01(i, 92) * w;
      const y = groundY(x, w, h) + 6 + hash01(i, 93) * (h - groundY(x, w, h) - 10);
      ctx.globalAlpha = (a - 0.6) * 2.5;
      ctx.fillRect(x - 0.5, y - 2.5, 1, 5);
      ctx.fillRect(x - 2.5, y - 0.5, 5, 1);
    }
    ctx.globalAlpha = 1;
  },
};
