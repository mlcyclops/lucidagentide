// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/scenes/blossoms.ts
//
// P-SEASON.1 (ADR-0525): Mother's Day. A twilight plum sky with a soft moon, faint hills below, and
// cherry blossom branches framing both top corners, swaying very slightly on the breeze, while petals
// drift and tumble across the frame (each petal spins and flips, so it flashes pale then deep pink).

import { fbm1, frameDpr, glow, hash01, layerCache, wrap, type SceneDef, type SceneFrame } from "../scene_kit.ts";

/** A single notched cherry petal, unit length along +y from the origin. */
const PETAL = (() => {
  const p = new Path2D();
  p.moveTo(0, 0);
  p.bezierCurveTo(-0.55, 0.2, -0.55, 0.8, -0.14, 1);
  p.lineTo(0, 0.88);
  p.lineTo(0.14, 1);
  p.bezierCurveTo(0.55, 0.8, 0.55, 0.2, 0, 0);
  p.closePath();
  return p;
})();

/** A five-petal blossom with a deep pink centre and stamens. */
function flower(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, rot: number, tint: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.scale(r, r);
  ctx.fillStyle = tint < 0.33 ? "#fbd3e2" : tint < 0.66 ? "#f7bdd2" : "#fde6ee";
  for (let i = 0; i < 5; i++) {
    ctx.rotate((Math.PI * 2) / 5);
    ctx.fill(PETAL);
  }
  ctx.fillStyle = "#d9577f";
  ctx.beginPath();
  ctx.arc(0, 0, 0.22, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#ffe0a0";
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.3;
    ctx.beginPath();
    ctx.arc(Math.cos(a) * 0.36, Math.sin(a) * 0.36, 0.06, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** A recursive branch from (x, y) heading `ang`, tapering, with blossoms along the outer twigs. */
function branch(ctx: CanvasRenderingContext2D, x: number, y: number, ang: number, len: number, width: number, depth: number, seed: number, flowers: number[]): void {
  const bend = (hash01(seed, 1) - 0.5) * 0.5;
  const ex = x + Math.cos(ang) * len;
  const ey = y + Math.sin(ang) * len;
  const mx = x + Math.cos(ang + bend) * len * 0.5;
  const my = y + Math.sin(ang + bend) * len * 0.5;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.quadraticCurveTo(mx, my, ex, ey);
  ctx.stroke();
  if (depth <= 2) {
    const n = 2 + Math.floor(hash01(seed, 2) * 3);
    for (let i = 0; i < n; i++) {
      const k = 0.35 + 0.65 * hash01(seed + i, 3);
      flowers.push(x + (ex - x) * k + (hash01(seed + i, 4) - 0.5) * len * 0.25, y + (ey - y) * k + (hash01(seed + i, 5) - 0.5) * len * 0.25, hash01(seed + i, 6));
    }
  }
  if (depth === 0) return;
  const kids = depth > 2 ? 2 : 2 + Math.floor(hash01(seed, 7) * 2);
  for (let i = 0; i < kids; i++) {
    const spread = (i - (kids - 1) / 2) * (0.5 + 0.3 * hash01(seed + i, 8));
    branch(ctx, ex, ey, ang + spread + bend * 0.5, len * (0.62 + 0.18 * hash01(seed + i, 9)), width * 0.62, depth - 1, seed * 3 + i * 17 + 1, flowers);
  }
}

/** One corner's branch, drawn in a box `bw` x `bh` with its anchor at the box's top-left. */
function paintCorner(ctx: CanvasRenderingContext2D, bw: number, bh: number, unit: number, seed: number): void {
  ctx.strokeStyle = "#4e2c40";
  ctx.lineCap = "round";
  const flowers: number[] = [];
  // Lengths are chosen so the whole recursive reach (about 3x the first limb) stays inside the box.
  branch(ctx, -unit * 10, unit * 30, 0.32, bw * 0.24, unit * 14, 5, seed, flowers);
  branch(ctx, unit * 40, -unit * 10, 1.05, bh * 0.2, unit * 9, 4, seed + 101, flowers);
  // Soft bloom glow behind the flower clusters, then the flowers themselves.
  for (let i = 0; i < flowers.length; i += 3) glow(ctx, flowers[i], flowers[i + 1], unit * 22, "255 170 200", 0.08);
  for (let i = 0; i < flowers.length; i += 3) {
    flower(ctx, flowers[i], flowers[i + 1], unit * (5 + 4 * flowers[i + 2]), flowers[i + 2] * 6, flowers[i + 2]);
  }
}

function paintBack(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, "#1a0d22");
  g.addColorStop(0.4, "#3a1d40");
  g.addColorStop(0.72, "#6e3a5e");
  g.addColorStop(0.9, "#a65f74");
  g.addColorStop(1, "#c07b82");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 140; i++) {
    const y = Math.pow(hash01(i, 11), 1.5) * h * 0.55;
    ctx.fillStyle = `rgb(255 236 246 / ${(0.12 + 0.45 * hash01(i, 12)) * (1 - y / (h * 0.6))})`;
    ctx.fillRect(hash01(i, 13) * w, y, 1.1, 1.1);
  }
  // Far hills in haze along the bottom, two layers.
  for (let k = 0; k < 2; k++) {
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let x = 0; x <= w + 8; x += 8) ctx.lineTo(x, h * (0.84 + k * 0.06) - (fbm1(x / (w * 0.3), 3, 50 + k) - 0.5) * h * 0.1);
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fillStyle = k === 0 ? "#5a3050" : "#3a1c36";
    ctx.fill();
  }
}

export const scene: SceneDef = {
  id: "blossoms",
  label: "Cherry blossoms",
  paint(f: SceneFrame): void {
    const { ctx, w, h } = f;
    const ts = f.t / 1000;
    const unit = Math.max(0.6, Math.min(w / 1400, h / 800));
    const dpr = frameDpr(f);
    ctx.drawImage(layerCache("blossoms-back", w, h, dpr, (c) => paintBack(c, w, h)), 0, 0, w, h);
    // The moon: a wide soft halo, then a pale disc with faint maria.
    const mx = w * 0.64;
    const my = h * 0.26;
    const mr = unit * 34;
    glow(ctx, mx, my, mr * 9, "255 214 236", 0.16 + 0.02 * Math.sin(ts * 0.3));
    glow(ctx, mx, my, mr * 2.6, "255 236 244", 0.3);
    ctx.drawImage(layerCache("blossoms-moon", mr * 2, mr * 2, dpr, (c) => {
      const g = c.createRadialGradient(mr * 0.8, mr * 0.75, 0, mr, mr, mr);
      g.addColorStop(0, "#fffaf6");
      g.addColorStop(1, "#f1dce6");
      c.fillStyle = g;
      c.beginPath();
      c.arc(mr, mr, mr, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = "rgb(200 170 196 / 0.22)";
      for (const [x, y, r] of [[0.7, 0.8, 0.22], [1.25, 0.65, 0.16], [1.1, 1.25, 0.26], [0.65, 1.3, 0.12]]) {
        c.beginPath();
        c.arc(mr * x, mr * y, mr * r, 0, Math.PI * 2);
        c.fill();
      }
    }), mx - mr, my - mr, mr * 2, mr * 2);

    // Petals behind the branches (smaller, dimmer) then the corner branches, then near petals.
    const petals = (from: number, to: number, near: boolean): void => {
      const base = ctx.getTransform();
      for (let i = from; i < to; i++) {
        const size = unit * (near ? 10 + 6 * hash01(i, 21) : 5 + 4 * hash01(i, 21));
        const speed = unit * (near ? 26 + 18 * hash01(i, 22) : 14 + 10 * hash01(i, 22));
        const span = w + size * 8;
        const x = wrap(hash01(i, 23) * span + ts * speed, span) - size * 4;
        const fall = wrap(hash01(i, 24) * (h + 60) + ts * speed * 0.45, h + 60) - 30;
        const y = fall + Math.sin(ts * (0.5 + 0.4 * hash01(i, 25)) + i) * unit * 22;
        const rot = ts * (0.6 + 0.9 * hash01(i, 26)) * (hash01(i, 27) < 0.5 ? -1 : 1) + i;
        const flip = Math.cos(ts * (0.8 + 0.8 * hash01(i, 28)) + i * 2.1);
        const c = Math.cos(rot);
        const s = Math.sin(rot);
        const sx = size * (0.2 + 0.8 * Math.abs(flip));
        ctx.setTransform(base.a * c * sx, base.d * s * sx, -base.a * s * size, base.d * c * size, base.e + x * base.a, base.f + y * base.d);
        ctx.globalAlpha = near ? 0.92 : 0.55;
        ctx.fillStyle = flip > 0 ? "#fcd6e4" : "#ee9fbd";
        ctx.fill(PETAL);
      }
      ctx.setTransform(base);
      ctx.globalAlpha = 1;
    };
    petals(0, 22, false);
    // The corner branches, each swaying a fraction of a degree about its anchor.
    const bw = Math.min(w * 0.55, unit * 700);
    const bh = Math.min(h * 0.7, unit * 480);
    for (const side of [0, 1]) {
      const layer = layerCache(`blossoms-branch-${side}`, bw, bh, dpr, (c) => paintCorner(c, bw, bh, unit, side === 0 ? 7 : 31));
      const sway = Math.sin(ts * 0.45 + side * 1.7) * 0.01 + Math.sin(ts * 0.9 + side) * 0.004;
      ctx.save();
      ctx.translate(side === 0 ? 0 : w, 0);
      ctx.scale(side === 0 ? 1 : -1, 1);
      ctx.rotate(sway);
      ctx.drawImage(layer, 0, 0, bw, bh);
      ctx.restore();
    }
    petals(22, 40, true);
  },
};
