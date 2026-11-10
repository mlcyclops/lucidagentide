// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/scenes/hearts.ts
//
// P-SEASON.1 (ADR-0525): Valentine's. A deep wine-to-rose field with soft bokeh orbs drifting up,
// hearts of three depths floating, swaying and slowly turning (near ones larger, brighter, faster,
// each lit with a soft sheen), and the occasional four-point sparkle winking in and out.

import { frameDpr, glow, hash01, layerCache, wrap, type SceneDef, type SceneFrame } from "../scene_kit.ts";

/** A unit heart (about 2 wide, centered on the origin), built once. */
const HEART = (() => {
  const p = new Path2D();
  p.moveTo(0, 0.62);
  p.bezierCurveTo(-0.32, 0.36, -1, 0.02, -1, -0.38);
  p.bezierCurveTo(-1, -0.78, -0.62, -0.98, -0.32, -0.98);
  p.bezierCurveTo(-0.14, -0.98, -0.04, -0.88, 0, -0.68);
  p.bezierCurveTo(0.04, -0.88, 0.14, -0.98, 0.32, -0.98);
  p.bezierCurveTo(0.62, -0.98, 1, -0.78, 1, -0.38);
  p.bezierCurveTo(1, 0.02, 0.32, 0.36, 0, 0.62);
  p.closePath();
  return p;
})();

/** Heart colors: rose, blush, crimson, coral, and a pale pearl pink. */
const TINTS = [
  ["#ff6f91", "#c2275a"],
  ["#ffb3c6", "#e0708f"],
  ["#e8344f", "#931c35"],
  ["#ff8a80", "#cf4f5f"],
  ["#ffd6e0", "#e8a0b4"],
];

const HEARTS = 26;
const ORBS = 34;

function paintBack(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const g = ctx.createLinearGradient(0, 0, w * 0.3, h);
  g.addColorStop(0, "#1c0612");
  g.addColorStop(0.45, "#3e0d24");
  g.addColorStop(0.8, "#6b1a3a");
  g.addColorStop(1, "#8e2a4c");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  // Two broad warm glows give the field depth, like out-of-focus lamps far behind.
  glow(ctx, w * 0.72, h * 0.78, Math.max(w, h) * 0.55, "230 90 120", 0.22);
  glow(ctx, w * 0.18, h * 0.25, Math.max(w, h) * 0.4, "160 40 90", 0.18);
  // A soft vignette keeps the edges deep and the center airy.
  const v = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.max(w, h) * 0.75);
  v.addColorStop(0, "rgb(10 0 6 / 0)");
  v.addColorStop(1, "rgb(10 0 6 / 0.5)");
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, w, h);
}

/** A bokeh disc sprite: flat body, slightly brighter rim, built once per size. */
function orbSprite(dpr: number): CanvasImageSource {
  return layerCache("hearts-orb", 64, 64, dpr, (c) => {
    const g = c.createRadialGradient(32, 32, 0, 32, 32, 31);
    g.addColorStop(0, "rgb(255 210 225 / 0.55)");
    g.addColorStop(0.78, "rgb(255 210 225 / 0.65)");
    g.addColorStop(0.92, "rgb(255 225 235 / 0.9)");
    g.addColorStop(1, "rgb(255 225 235 / 0)");
    c.fillStyle = g;
    c.fillRect(0, 0, 64, 64);
  });
}

export const scene: SceneDef = {
  id: "hearts",
  label: "Floating hearts",
  paint(f: SceneFrame): void {
    const { ctx, w, h } = f;
    const ts = f.t / 1000;
    const unit = Math.max(0.6, Math.min(w / 1400, h / 800));
    const dpr = frameDpr(f);
    ctx.drawImage(layerCache("hearts-back", w, h, dpr, (c) => paintBack(c, w, h)), 0, 0, w, h);

    // Bokeh: soft discs rising slowly, gently pulsing in brightness.
    const orb = orbSprite(dpr);
    for (let i = 0; i < ORBS; i++) {
      const r = unit * (8 + 46 * hash01(i, 1) ** 2);
      const speed = unit * (5 + 10 * hash01(i, 2));
      const y = h + r - wrap(ts * speed + hash01(i, 3) * (h + 2 * r), h + 2 * r);
      const x = hash01(i, 4) * w + Math.sin(ts * 0.12 + i) * unit * 20;
      ctx.globalAlpha = (0.06 + 0.12 * hash01(i, 5)) * (0.75 + 0.25 * Math.sin(ts * 0.5 + i * 1.7));
      ctx.drawImage(orb, x - r, y - r, r * 2, r * 2);
    }
    ctx.globalAlpha = 1;

    // Hearts, far to near: each rises, sways and turns on its own slow clock.
    const base = ctx.getTransform();
    // One shading gradient per tint, in the heart's unit space, reused under every heart's transform.
    const shades = TINTS.map(([lit, deep]) => {
      const g = ctx.createLinearGradient(-0.8, -1, 0.6, 0.7);
      g.addColorStop(0, lit);
      g.addColorStop(1, deep);
      return g;
    });
    for (let i = 0; i < HEARTS; i++) {
      const depth = (i % 3) / 2 + hash01(i, 11) * 0.2; // 0 far .. ~1.2 near
      const size = unit * (9 + 30 * depth + 10 * hash01(i, 12));
      const speed = unit * (7 + 16 * depth);
      const span = h + size * 4;
      const y = h + size * 2 - wrap(ts * speed + hash01(i, 13) * span, span);
      const x = wrap(hash01(i, 14) * w + Math.sin(ts * (0.18 + 0.12 * hash01(i, 15)) + i * 2.3) * unit * (24 + 30 * depth), w + size * 4) - size * 2;
      const rot = Math.sin(ts * (0.22 + 0.2 * hash01(i, 16)) + i) * 0.28;
      // A slow 3-D turn: the heart narrows as it rotates about its vertical axis.
      const turn = 0.8 + 0.2 * Math.cos(ts * (0.3 + 0.25 * hash01(i, 17)) + i * 1.9);
      const tint = Math.floor(hash01(i, 18) * TINTS.length);
      const alpha = 0.32 + 0.5 * Math.min(1, depth);
      if (depth > 0.9) {
        // The previous heart left its transform and alpha on the context; the halo needs neither.
        ctx.setTransform(base);
        ctx.globalAlpha = 1;
        glow(ctx, x, y, size * 2.6, "255 120 150", 0.1);
      }
      const c = Math.cos(rot);
      const s = Math.sin(rot);
      // base (the dpr scale) x translate(x, y) x rotate(rot) x scale(size * turn, size).
      const sx = size * turn;
      ctx.setTransform(base.a * c * sx, base.d * s * sx, -base.a * s * size, base.d * c * size, base.e + x * base.a, base.f + y * base.d);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = shades[tint];
      ctx.fill(HEART);
      // Sheen: a small soft highlight on the upper-left lobe.
      ctx.globalAlpha = alpha * 0.55;
      ctx.fillStyle = "rgb(255 255 255 / 0.5)";
      ctx.beginPath();
      ctx.ellipse(-0.5, -0.6, 0.24, 0.12, -0.6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.setTransform(base);
    ctx.globalAlpha = 1;

    // Sparkles: a handful of four-point glints, each winking briefly in its own slot.
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < 9; i++) {
      const period = 3.5 + 3 * hash01(i, 21);
      const k = Math.floor((ts + i * 1.3) / period);
      const u = ((ts + i * 1.3) / period) % 1;
      const a = Math.sin(Math.PI * Math.min(1, u / 0.35)) ** 3;
      if (u > 0.35 || a < 0.02) continue;
      const x = hash01(k * 31 + i, 22) * w;
      const y = hash01(k * 31 + i, 23) * h;
      const r = unit * (6 + 8 * hash01(k * 31 + i, 24)) * a;
      glow(ctx, x, y, r * 2.2, "255 214 228", 0.35 * a);
      ctx.fillStyle = `rgb(255 244 248 / ${0.9 * a})`;
      ctx.beginPath();
      ctx.moveTo(x, y - r);
      ctx.quadraticCurveTo(x, y, x + r * 0.7, y);
      ctx.quadraticCurveTo(x, y, x, y + r);
      ctx.quadraticCurveTo(x, y, x - r * 0.7, y);
      ctx.quadraticCurveTo(x, y, x, y - r);
      ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
  },
};
