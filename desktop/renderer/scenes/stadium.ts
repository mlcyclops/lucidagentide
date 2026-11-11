// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/scenes/stadium.ts
//
// P-SEASON.1 (ADR-0525): a night football stadium seen from high on the near sideline. The turf is
// laid out in true perspective (mowing stripes, yard lines, hash marks, numbers that face their own
// sideline, unbranded end zones), the far stands are packed and catch camera flashes, roof-mounted
// floodlight banks bloom with lens glow and light the haze, and every so often a football spirals
// across in a long arc. No team or league marks. The pitch scene reuses the arena helpers exported
// here (camera, crowd, floodlight, flashes).

import { frameDpr, glow, hash01, layerCache, wrap, type SceneDef, type SceneFrame } from "../scene_kit.ts";

const TAU = Math.PI * 2;

/** A pinhole camera over a flat field: X along the field, Z away from the near sideline, Y up. */
export interface Cam { hz: number; A: number; F: number; D: number; cx: number; x0: number }

/** Fit a camera so the near line (Z = 0) lands at `yNear`, the far line (Z = depth) at `yFar`;
 *  `D` is the camera's distance behind the near line, `fw` the focal length in frame widths. */
export function camera(w: number, h: number, yNear: number, yFar: number, depth: number, D: number, fw: number, x0: number): Cam {
  const hz = (yFar * (D + depth) - yNear * D) / depth;
  return { hz, A: (yNear - hz) * D, F: fw * w, D, cx: w / 2, x0 };
}
export const camX = (c: Cam, X: number, Z: number): number => c.cx + (c.F * (X - c.x0)) / (c.D + Z);
export const camY = (c: Cam, Z: number, Y = 0): number => c.hz + (c.A - c.F * Y) / (c.D + Z);

/** Fill the projected ground rectangle [X0, X1] x [Z0, Z1]. */
export function quad(c: CanvasRenderingContext2D, cam: Cam, X0: number, Z0: number, X1: number, Z1: number, fill: string | CanvasGradient): void {
  c.beginPath();
  c.moveTo(camX(cam, X0, Z0), camY(cam, Z0));
  c.lineTo(camX(cam, X1, Z0), camY(cam, Z0));
  c.lineTo(camX(cam, X1, Z1), camY(cam, Z1));
  c.lineTo(camX(cam, X0, Z1), camY(cam, Z1));
  c.closePath();
  c.fillStyle = fill;
  c.fill();
}

/** A packed stand: rows of muted spectators under night light, with stair aisles. Cache-only. */
export function paintCrowd(c: CanvasRenderingContext2D, w: number, yTop: number, yBot: number, rows: number, salt: number, light: number): void {
  const rh = (yBot - yTop) / rows;
  const g = c.createLinearGradient(0, yTop, 0, yBot);
  g.addColorStop(0, "#14161f");
  g.addColorStop(1, "#1d2030");
  c.fillStyle = g;
  c.fillRect(0, yTop, w, yBot - yTop);
  for (let r = 0; r < rows; r++) {
    const y = yTop + r * rh;
    const sp = Math.max(2.2, rh * 0.78);
    const lit = light * (0.55 + 0.45 * (r / rows));
    let i = 0;
    for (let x = (r % 2) * sp * 0.5; x < w; x += sp, i++) {
      if (wrap(x, w / 9) < sp * 1.6) continue;
      if (hash01(i + r * 977, salt) < 0.08) continue;
      const hue = Math.floor(hash01(i + r * 977, salt + 1) * 360);
      const l = Math.round((12 + 12 * hash01(i + r * 977, salt + 2)) * lit);
      c.fillStyle = `hsl(${hue} ${hash01(i, salt + 3) < 0.6 ? 12 : 30}% ${l}%)`;
      c.fillRect(x, y + rh * 0.3, sp * 0.72, rh * 0.62);
      c.fillStyle = `hsl(28 22% ${Math.round(l * 1.1)}%)`;
      c.fillRect(x + sp * 0.18, y + rh * 0.06, sp * 0.36, rh * 0.3);
    }
  }
  c.fillStyle = "rgb(0 0 0 / 0.25)";
  for (let r = 0; r < rows; r += 1) c.fillRect(0, yTop + r * rh + rh * 0.93, w, Math.max(0.6, rh * 0.07));
}

/** A floodlight bank: a dark frame holding a grid of hot lamps. Cache-only. */
export function paintBank(c: CanvasRenderingContext2D, x: number, y: number, bw: number, bh: number, cols: number, rows: number): void {
  c.fillStyle = "#1a1d26";
  c.fillRect(x - bw / 2 - 3, y - bh / 2 - 3, bw + 6, bh + 6);
  for (let r = 0; r < rows; r++) {
    for (let k = 0; k < cols; k++) {
      const lx = x - bw / 2 + ((k + 0.5) * bw) / cols;
      const ly = y - bh / 2 + ((r + 0.5) * bh) / rows;
      const rr = Math.min(bw / cols, bh / rows) * 0.42;
      glow(c, lx, ly, rr * 2.2, "220 235 255", 0.5);
      c.fillStyle = "#ffffff";
      c.beginPath();
      c.arc(lx, ly, rr * 0.7, 0, TAU);
      c.fill();
    }
  }
}

/** Per-frame lens bloom on a floodlight bank: a soft halo plus a horizontal anamorphic streak. */
export function bloom(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, t: number, seed: number): void {
  const breath = 0.92 + 0.08 * Math.sin(t * 0.0009 + seed);
  glow(ctx, x, y, size * 2.6, "190 210 255", 0.28 * breath);
  glow(ctx, x, y, size * 0.9, "245 248 255", 0.45 * breath);
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(1, 0.04);
  glow(ctx, 0, 0, size * 3.2, "200 220 255", 0.35 * breath);
  ctx.restore();
}

/** Camera flashes popping across the stands: each slot fires once per cycle at a fresh seat. */
export function flashes(ctx: CanvasRenderingContext2D, t: number, n: number, x0: number, x1: number, y0: number, y1: number, sprite: CanvasImageSource, salt: number): void {
  for (let i = 0; i < n; i++) {
    const period = 2600 + 5200 * hash01(i, salt);
    const local = t + hash01(i, salt + 1) * period;
    const cycle = Math.floor(local / period);
    const age = local - cycle * period;
    if (age > 160) continue;
    const k = i * 7919 + cycle;
    const x = x0 + hash01(k, salt + 2) * (x1 - x0);
    const y = y0 + hash01(k, salt + 3) * (y1 - y0);
    const s = 10 + 12 * hash01(k, salt + 4);
    ctx.globalAlpha = 1 - age / 160;
    ctx.drawImage(sprite, x - s / 2, y - s / 2, s, s);
  }
  ctx.globalAlpha = 1;
}

/** The shared flash sprite: a white core with a cool halo and a tiny cross glint. */
export function paintFlashSprite(c: CanvasRenderingContext2D): void {
  glow(c, 16, 16, 16, "220 230 255", 0.6);
  glow(c, 16, 16, 5, "255 255 255", 1);
  c.fillStyle = "rgb(255 255 255 / 0.8)";
  c.fillRect(15.5, 4, 1, 24);
  c.fillRect(4, 15.5, 24, 1);
}

const BANKS = [0.1, 0.36, 0.64, 0.9];
const BANK_Y = 0.12;

function paintStatic(c: CanvasRenderingContext2D, w: number, h: number): void {
  const cam = camera(w, h, h * 1.05, h * 0.6, 53.33, 38, 0.62, 0);
  // Night sky lit from below by the stadium.
  const sky = c.createLinearGradient(0, 0, 0, h * 0.3);
  sky.addColorStop(0, "#05070f");
  sky.addColorStop(1, "#1a2238");
  c.fillStyle = sky;
  c.fillRect(0, 0, w, h);

  // Upper deck, suite band with a glowing ribbon board, lower bowl.
  const farWall = camY(cam, 58);
  paintCrowd(c, w, h * 0.205, h * 0.37, 20, 11, 0.85);
  c.fillStyle = "#0b0d14";
  c.fillRect(0, h * 0.37, w, h * 0.03);
  const ribbon = c.createLinearGradient(0, 0, w, 0);
  for (let i = 0; i <= 12; i++) ribbon.addColorStop(i / 12, i % 3 === 0 ? "#1f6fd1" : i % 3 === 1 ? "#0f3f86" : "#e3a33a");
  c.fillStyle = ribbon;
  c.globalAlpha = 0.75;
  c.fillRect(0, h * 0.4, w, h * 0.012);
  c.globalAlpha = 1;
  c.fillStyle = "#0b0d14";
  c.fillRect(0, h * 0.412, w, h * 0.006);
  paintCrowd(c, w, h * 0.418, farWall - h * 0.012, 24, 23, 1);
  // Floodlight falling across the stands, brightest on the lower rows.
  const wash = c.createLinearGradient(0, h * 0.2, 0, farWall);
  wash.addColorStop(0, "rgb(0 0 0 / 0.35)");
  wash.addColorStop(0.5, "rgb(180 200 255 / 0.04)");
  wash.addColorStop(1, "rgb(255 255 255 / 0.08)");
  c.fillStyle = wash;
  c.fillRect(0, h * 0.205, w, farWall - h * 0.205);
  // Roof rim and the far wall.
  c.fillStyle = "#0a0c13";
  c.fillRect(0, h * 0.185, w, h * 0.022);
  c.fillStyle = "#11131c";
  c.fillRect(0, farWall - h * 0.012, w, h * 0.016);

  // Turf: surround, then 5-yard mowing stripes across the playing field.
  quad(c, cam, -80, -8, 80, 58, "#1d4a2a");
  for (let k = -12; k < 12; k++) quad(c, cam, k * 5, 0, k * 5 + 5, 53.33, k % 2 === 0 ? "#2f7a3e" : "#286d36");
  // Unbranded end zones.
  quad(c, cam, -60, 0, -50, 53.33, "#6e1a28");
  quad(c, cam, 50, 0, 60, 53.33, "#1c3a78");
  for (let i = 0; i < 10; i++) {
    quad(c, cam, -59 + i, 0, -58.6 + i, 53.33, "rgb(0 0 0 / 0.08)");
    quad(c, cam, 50.6 + i, 0, 51 + i, 53.33, "rgb(0 0 0 / 0.08)");
  }

  // Lines: sidelines, end lines, yard lines every 5, hash ticks every yard.
  const white = "rgb(246 248 244 / 0.92)";
  const lw = 0.22;
  quad(c, cam, -60, -2, 60, 0, white);
  quad(c, cam, -60, 53.33, 60, 55.33, white);
  for (const X of [-60, 60]) quad(c, cam, X - lw, 0, X + lw, 53.33, white);
  for (let X = -50; X <= 50; X += 5) quad(c, cam, X - lw / 2, 0, X + lw / 2, 53.33, white);
  for (let X = -49; X <= 49; X++) {
    if (X % 5 === 0) continue;
    for (const [Z0, Z1] of [[0.4, 1.1], [23.3, 24], [29.3, 30], [52.2, 52.9]]) quad(c, cam, X - 0.08, Z0, X + 0.08, Z1, white);
  }
  // Yard numbers, each facing its own sideline.
  c.fillStyle = "rgb(246 248 244 / 0.85)";
  c.textAlign = "center";
  c.textBaseline = "middle";
  c.font = "700 100px system-ui, sans-serif";
  for (let X = -40; X <= 40; X += 10) {
    const label = String(50 - Math.abs(X));
    for (const [Z, flip] of [[12, false], [41.3, true]] as const) {
      const sx = camX(cam, X, Z);
      const sy = camY(cam, Z);
      const kx = cam.F / (cam.D + Z);
      const ky = cam.A / ((cam.D + Z) * (cam.D + Z));
      c.save();
      c.translate(sx, sy);
      c.scale((kx * 2) / 100, (ky * 2) / 100);
      if (flip) c.rotate(Math.PI);
      c.fillText(label, 0, 0);
      c.restore();
    }
  }

  // Floodlit turf: brighter centre, darker edges, faint grain.
  const pool = c.createRadialGradient(w * 0.5, h * 0.72, h * 0.05, w * 0.5, h * 0.72, w * 0.6);
  pool.addColorStop(0, "rgb(230 245 220 / 0.14)");
  pool.addColorStop(1, "rgb(0 10 6 / 0.35)");
  c.fillStyle = pool;
  c.fillRect(0, farWall, w, h - farWall);
  for (let i = 0; i < 1800; i++) {
    const y = farWall + Math.pow(hash01(i, 5), 0.9) * (h - farWall);
    c.fillStyle = hash01(i, 6) < 0.5 ? "rgb(255 255 255 / 0.05)" : "rgb(0 0 0 / 0.08)";
    c.fillRect(hash01(i, 7) * w, y, 1 + (y / h) * 1.5, 1);
  }

  // Haze beams from each bank down toward the field.
  for (const fx of BANKS) {
    const x = fx * w;
    const y = h * BANK_Y;
    const g = c.createLinearGradient(0, y, 0, h * 0.9);
    g.addColorStop(0, "rgb(200 220 255 / 0.05)");
    g.addColorStop(0.6, "rgb(200 220 255 / 0.015)");
    g.addColorStop(1, "rgb(200 220 255 / 0)");
    c.fillStyle = g;
    c.beginPath();
    c.moveTo(x - w * 0.035, y);
    c.lineTo(x + w * 0.035, y);
    c.lineTo(w * 0.5 + (x - w * 0.5) * 0.4 + w * 0.16, h * 0.9);
    c.lineTo(w * 0.5 + (x - w * 0.5) * 0.4 - w * 0.16, h * 0.9);
    c.closePath();
    c.fill();
  }
  // Light masts and banks.
  for (const fx of BANKS) {
    c.fillStyle = "#0b0d14";
    c.fillRect(fx * w - 2, h * BANK_Y, 4, h * 0.075);
    paintBank(c, fx * w, h * BANK_Y, w * 0.075, h * 0.04, 8, 3);
  }
}

/** The ball: a leather lens with a lace row that rolls round as it spirals. */
function football(ctx: CanvasRenderingContext2D, x: number, y: number, L: number, ang: number, spin: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(ang);
  ctx.beginPath();
  ctx.moveTo(-L / 2, 0);
  ctx.quadraticCurveTo(0, -L * 0.62, L / 2, 0);
  ctx.quadraticCurveTo(0, L * 0.62, -L / 2, 0);
  const g = ctx.createLinearGradient(0, -L * 0.3, 0, L * 0.3);
  g.addColorStop(0, "#b4723e");
  g.addColorStop(0.5, "#7a3e1c");
  g.addColorStop(1, "#3e1c0c");
  ctx.fillStyle = g;
  ctx.fill();
  const s = Math.sin(spin);
  if (s > -0.2) {
    const off = Math.cos(spin) * L * 0.2;
    ctx.globalAlpha = Math.min(1, (s + 0.2) * 2);
    ctx.strokeStyle = "#f4efe6";
    ctx.lineWidth = Math.max(1, L * 0.04);
    ctx.beginPath();
    ctx.moveTo(-L * 0.16, off);
    ctx.lineTo(L * 0.16, off);
    for (let k = -2; k <= 2; k++) {
      ctx.moveTo(k * L * 0.07, off - L * 0.05);
      ctx.lineTo(k * L * 0.07, off + L * 0.05);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}

export const scene: SceneDef = {
  id: "stadium",
  label: "Night stadium",
  paint(f: SceneFrame): void {
    const { ctx, w, h, t } = f;
    const dpr = frameDpr(f);
    ctx.drawImage(layerCache("stadium:static", w, h, dpr, (c) => paintStatic(c, w, h)), 0, 0, w, h);
    const flash = layerCache("arena:flash", 32, 32, dpr, paintFlashSprite);
    flashes(ctx, t, 34, 0, w, h * 0.21, h * 0.57, flash, 3);
    for (const [i, fx] of BANKS.entries()) bloom(ctx, fx * w, h * BANK_Y, h * 0.06, t, i * 2.1);

    // A football spirals across every 14 s, alternating direction.
    const P = 14000;
    const cyc = Math.floor(t / P);
    const age = t - cyc * P;
    const FLY = 3400;
    if (age < FLY) {
      const dir = cyc % 2 === 0 ? 1 : -1;
      const at = (u: number): [number, number] => [
        w * (0.5 + dir * (-0.36 + 0.72 * u)),
        h * (0.7 - 0.08 * u) - Math.sin(Math.PI * u) * h * 0.34,
      ];
      const u = age / FLY;
      const L = h * 0.034;
      const fade = Math.min(1, u * 8, (1 - u) * 8);
      for (let k = 6; k >= 1; k--) {
        const [gx, gy] = at(Math.max(0, u - k * 0.012));
        ctx.globalAlpha = 0.05 * (7 - k) * fade;
        ctx.fillStyle = "#e8d2b8";
        ctx.beginPath();
        ctx.arc(gx, gy, L * 0.18, 0, TAU);
        ctx.fill();
      }
      ctx.globalAlpha = fade;
      const [x, y] = at(u);
      const [nx, ny] = at(Math.min(1, u + 0.01));
      football(ctx, x, y, L, Math.atan2(ny - y, nx - x), t * 0.03);
      ctx.globalAlpha = 1;
    }
  },
};
