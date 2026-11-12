// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/scenes/clover.ts
//
// P-SEASON.1 (ADR-0525): St. Patrick's. Soft green rolling hills under a pale spring sky, a faint
// rainbow arcing down to the far hills, gold sparkles rising where it lands, and three- and
// four-leaf clovers drifting across on the breeze, tumbling (spin plus a 3-D flip) as they go.

import { fbm1, frameDpr, glow, hash01, layerCache, wrap, type SceneDef, type SceneFrame } from "../scene_kit.ts";

/** One heart-shaped leaflet pointing up from the origin, unit length. */
function leaflet(p: Path2D, rot: number): void {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const pt = (x: number, y: number): [number, number] => [x * c - y * s, x * s + y * c];
  const m = pt(0, 0);
  p.moveTo(m[0], m[1]);
  const a = pt(-0.55, -0.15);
  const b = pt(-0.62, -0.95);
  const e = pt(0, -0.82);
  p.bezierCurveTo(a[0], a[1], b[0], b[1], e[0], e[1]);
  const a2 = pt(0.62, -0.95);
  const b2 = pt(0.55, -0.15);
  p.bezierCurveTo(a2[0], a2[1], b2[0], b2[1], m[0], m[1]);
  p.closePath();
}

function cloverPath(leaves: number): Path2D {
  const p = new Path2D();
  for (let i = 0; i < leaves; i++) leaflet(p, (i / leaves) * Math.PI * 2 + (leaves === 4 ? Math.PI / 4 : 0));
  return p;
}

const CLOVER3 = cloverPath(3);
const CLOVER4 = cloverPath(4);
const STEM = (() => {
  const p = new Path2D();
  p.moveTo(0, 0);
  p.quadraticCurveTo(0.25, 0.7, 0.1, 1.25);
  return p;
})();

const HILLS = ["#5e8a66", "#4c7f52", "#3a6d40", "#2a5631", "#1a3c22"];

function hillY(i: number, x: number, w: number, h: number): number {
  return h * (0.6 + i * 0.085) - (fbm1(x / (w * (0.35 - i * 0.04)), 2, 500 + i * 13) - 0.5) * h * (0.09 + i * 0.015);
}

const BOW_X = 0.36;
const BOW_END = 0.76;

function paintBack(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  // A clearing storm: slate cloud overhead, brightening toward a rain-washed horizon, with low sun
  // from the left. A rainbow reads strongest against exactly this kind of dark sky.
  const g = ctx.createLinearGradient(0, 0, 0, h * 0.68);
  g.addColorStop(0, "#151f2c");
  g.addColorStop(0.45, "#26394a");
  g.addColorStop(0.8, "#47605f");
  g.addColorStop(1, "#7a8d74");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  glow(ctx, w * 0.05, h * 0.5, Math.max(w, h) * 0.6, "255 220 150", 0.22);
  // The rainbow: one annulus filled with a radial gradient whose stops are the bands, so the
  // colours blend softly into each other and into the sky at both edges.
  const cx = w * ((BOW_X + BOW_END) / 2);
  const R = w * ((BOW_END - BOW_X) / 2);
  const cy = h * 0.66;
  const band = R * 0.14;
  const rg = ctx.createRadialGradient(cx, cy, R - band, cx, cy, R + band);
  const bands = ["150 110 210", "110 140 230", "110 200 220", "140 215 120", "250 225 110", "250 170 100", "240 110 110"];
  rg.addColorStop(0, "rgb(150 110 210 / 0)");
  bands.forEach((c, i) => rg.addColorStop(0.1 + (i / (bands.length - 1)) * 0.8, `rgb(${c} / 0.32)`));
  rg.addColorStop(1, "rgb(240 110 110 / 0)");
  ctx.save();
  // Fade the bow out toward its top, as if part of it is lost in thin cloud.
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = rg;
  ctx.beginPath();
  ctx.arc(cx, cy, R + band, Math.PI, 0);
  ctx.arc(cx, cy, R - band, 0, Math.PI, true);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  // Soft clouds: clustered ellipses, white and translucent.
  for (let k = 0; k < 5; k++) {
    const x = w * (0.1 + 0.2 * k + 0.08 * hash01(k, 3));
    const y = h * (0.12 + 0.2 * hash01(k, 4));
    const s = w * (0.05 + 0.04 * hash01(k, 5));
    ctx.fillStyle = "rgb(150 170 186 / 0.1)";
    ctx.beginPath();
    for (let j = 0; j < 6; j++) {
      const ex = x + (j - 2.5) * s * 0.5;
      const ey = y - Math.sin((j / 5) * Math.PI) * s * 0.3;
      ctx.moveTo(ex + s * 0.5, ey);
      ctx.ellipse(ex, ey, s * 0.5, s * 0.3, 0, 0, Math.PI * 2);
    }
    ctx.fill();
  }
  for (let i = 0; i < HILLS.length; i++) {
    // Morning haze lifts out of each valley before the next hill.
    const top = h * (0.56 + i * 0.085);
    const mg = ctx.createLinearGradient(0, top - h * 0.04, 0, top + h * 0.06);
    mg.addColorStop(0, "rgb(220 232 200 / 0)");
    mg.addColorStop(1, `rgb(220 232 200 / ${0.2 - i * 0.035})`);
    ctx.fillStyle = mg;
    ctx.fillRect(0, top - h * 0.04, w, h * 0.1);
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let x = 0; x <= w + 6; x += 6) ctx.lineTo(x, hillY(i, x, w, h));
    ctx.lineTo(w, h);
    ctx.closePath();
    const hg = ctx.createLinearGradient(0, h * (0.5 + i * 0.08), 0, h);
    hg.addColorStop(0, HILLS[i]);
    hg.addColorStop(1, HILLS[Math.min(HILLS.length - 1, i + 1)]);
    ctx.fillStyle = hg;
    ctx.fill();
    // Sunlit crest.
    ctx.strokeStyle = `rgb(240 255 210 / ${0.35 - i * 0.05})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let x = 0; x <= w + 6; x += 6) {
      if (x === 0) ctx.moveTo(x, hillY(i, x, w, h) + 1);
      else ctx.lineTo(x, hillY(i, x, w, h) + 1);
    }
    ctx.stroke();
    // Hedgerows: thin darker lines of hedge following the slope across the middle hills.
    if (i === 1 || i === 2) {
      ctx.strokeStyle = "rgb(20 50 28 / 0.35)";
      ctx.lineWidth = 2.5;
      for (let k = 0; k < 3; k++) {
        const off = h * (0.02 + 0.025 * k);
        const x0 = w * hash01(k + i * 9, 9) * 0.6;
        const x1 = x0 + w * (0.25 + 0.3 * hash01(k + i * 9, 10));
        ctx.beginPath();
        for (let x = x0; x <= x1; x += 8) {
          const y = hillY(i, x, w, h) + off;
          if (x === x0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    }
  }
}

export const scene: SceneDef = {
  id: "clover",
  label: "Clover hills",
  paint(f: SceneFrame): void {
    const { ctx, w, h } = f;
    const ts = f.t / 1000;
    const unit = Math.max(0.6, Math.min(w / 1400, h / 800));
    const dpr = frameDpr(f);
    ctx.drawImage(layerCache("clover-back", w, h, dpr, (c) => paintBack(c, w, h)), 0, 0, w, h);

    // Gold at the rainbow's end: a warm pulse and sparkles rising and winking out.
    const ex = w * BOW_END;
    const ey = hillY(1, ex, w, h) + h * 0.01;
    glow(ctx, ex, ey, unit * 70, "255 214 110", 0.22 + 0.06 * Math.sin(ts * 0.9));
    // Sparkles are batched into three brightness buckets: three fills instead of one per sparkle.
    ctx.globalCompositeOperation = "lighter";
    const glints = [new Path2D(), new Path2D(), new Path2D()];
    for (let i = 0; i < 18; i++) {
      const life = 4 + 3 * hash01(i, 31);
      const u = wrap(ts + hash01(i, 32) * life, life) / life;
      const k = Math.floor((ts + hash01(i, 32) * life) / life);
      const x = ex + (hash01(k * 19 + i, 33) - 0.5) * unit * 90 + Math.sin(u * 6 + i) * unit * 5;
      const y = ey - u * unit * 110;
      const a = Math.sin(Math.PI * u) * (0.6 + 0.4 * Math.sin(ts * 5 + i * 1.7));
      if (a < 0.1) continue;
      const r = unit * (3 + 3 * hash01(i, 34)) * (0.6 + 0.4 * a);
      const p = glints[Math.min(2, Math.floor(a * 3))];
      p.moveTo(x, y - r);
      p.quadraticCurveTo(x, y, x + r * 0.6, y);
      p.quadraticCurveTo(x, y, x, y + r);
      p.quadraticCurveTo(x, y, x - r * 0.6, y);
      p.quadraticCurveTo(x, y, x, y - r);
    }
    for (let b = 0; b < 3; b++) {
      ctx.fillStyle = `rgb(255 226 140 / ${(b + 1) / 3})`;
      ctx.fill(glints[b]);
    }
    ctx.globalCompositeOperation = "source-over";

    // Clovers on the breeze: drifting right and slightly down, swaying, spinning and flipping.
    // Each clover's leaves and stem are appended (transformed) to one path per depth and face, so the
    // whole drift is a handful of fills rather than several calls per clover.
    const leaves = [new Path2D(), new Path2D(), new Path2D(), new Path2D()]; // [far, near] x [top, under]
    const stems = [new Path2D(), new Path2D()];
    for (let i = 0; i < 24; i++) {
      const depth = hash01(i, 41);
      const size = unit * (11 + 24 * depth);
      const speed = unit * (14 + 22 * depth);
      const spanX = w + size * 6;
      const x = wrap(ts * speed + hash01(i, 42) * spanX, spanX) - size * 3;
      const y = wrap(hash01(i, 43) * h + ts * speed * 0.35 + Math.sin(ts * 0.5 + i) * unit * 26, h + size * 6) - size * 3;
      const rot = ts * (0.25 + 0.5 * hash01(i, 44)) * (hash01(i, 45) < 0.5 ? -1 : 1) + i;
      const flip = Math.cos(ts * (0.35 + 0.4 * hash01(i, 46)) + i * 1.3);
      const c = Math.cos(rot);
      const s = Math.sin(rot);
      const sx = size * (0.25 + 0.75 * Math.abs(flip));
      const m = { a: c * sx, b: s * sx, c: -s * size, d: c * size, e: x, f: y };
      const near = depth > 0.5 ? 1 : 0;
      // The leaf's top face is a brighter green than its underside, so the flip reads.
      leaves[near * 2 + (flip > 0 ? 0 : 1)].addPath(hash01(i, 47) < 0.3 ? CLOVER4 : CLOVER3, m);
      stems[near].addPath(STEM, m);
    }
    for (let near = 0; near < 2; near++) {
      ctx.globalAlpha = near ? 0.92 : 0.62;
      ctx.strokeStyle = "#2f8a46";
      ctx.lineWidth = unit * (near ? 2.2 : 1.4);
      ctx.lineCap = "round";
      ctx.stroke(stems[near]);
      ctx.fillStyle = "#45b260";
      ctx.fill(leaves[near * 2]);
      ctx.fillStyle = "#7cc98a";
      ctx.fill(leaves[near * 2 + 1]);
    }
    ctx.globalAlpha = 1;
  },
};
