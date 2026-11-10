// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/scenes/fireworks.ts
//
// P-SEASON.1 (ADR-0525): night sky over a calm lake and a distant skyline. Staggered firework
// shells (a rising trail, then a spherical burst with drag and gravity whose sparks fade, glitter and
// burn out one by one) are mirrored as glints in the water and leave faint smoke drifting on the
// wind. New Year's paints champagne gold and silver willows with slow falling confetti; Independence
// Day paints red, white and blue peonies and rings. Every shell is a closed-form function of
// (slot, cycle, t), so any frame renders on demand.

import type { SeasonId } from "../seasons.ts";
import { frameDpr, glow, hash01, layerCache, ridge, wrap, type SceneDef, type SceneFrame } from "../scene_kit.ts";

/** Shell colours as `r g b` triplets, per season. */
function shellColors(season: SeasonId | null): string[] {
  if (season === "new-year") return ["255 200 105", "255 222 150", "226 232 248", "255 180 92", "255 236 190", "214 224 244"];
  if (season === "independence-day") return ["255 64 84", "248 250 255", "86 132 255", "255 96 110", "132 170 255"];
  return ["255 196 110", "120 196 255", "255 112 168", "170 255 196", "244 240 255"];
}

const SLOTS = 9;
const RISE_S = 1.6;
const BURST_S = 3.6;
const SMOKE_S = 6;

const PEONY = 0;
const RING = 1;
const DOUBLE = 2;
const WILLOW = 3;

interface Shell { x: number; y: number; r: number; kind: number; color: string; accent: string; seed: number; age: number; launchX: number }

/** The live shell (if any) of `slot` at `ts` seconds. `age` < 0 means still rising. */
function shellOf(slot: number, ts: number, w: number, horizon: number, colors: string[], unit: number, season: SeasonId | null): Shell | null {
  const period = 9 + hash01(slot, 11) * 5;
  const local = ts + slot * 2.3 + hash01(slot, 12) * period;
  const cycle = Math.floor(local / period);
  const u = local - cycle * period;
  const seed = slot * 7919 + cycle * 104729;
  // Some cycles stay dark, so the rhythm never reads as a metronome.
  if (hash01(seed, 1) < 0.22) return null;
  if (u > RISE_S + SMOKE_S) return null;
  const x = w * (0.08 + 0.84 * hash01(seed, 2));
  const depth = hash01(seed, 3); // 0 = far (small, low), 1 = near (large, high)
  const y = horizon * (0.5 - 0.36 * depth + 0.08 * hash01(seed, 9));
  const ci = Math.floor(hash01(seed, 4) * colors.length);
  const ai = (ci + 1 + Math.floor(hash01(seed, 5) * (colors.length - 1))) % colors.length;
  const roll = hash01(seed, 7);
  const kind = season === "new-year"
    ? (roll < 0.45 ? WILLOW : roll < 0.8 ? PEONY : DOUBLE)
    : (roll < 0.5 ? PEONY : roll < 0.75 ? DOUBLE : roll < 0.9 ? RING : WILLOW);
  return {
    x, y,
    r: unit * (90 + 120 * depth),
    kind,
    color: colors[ci],
    accent: kind === WILLOW ? colors[ci] : colors[ai],
    seed,
    age: u - RISE_S,
    launchX: x + (hash01(seed, 8) - 0.5) * unit * 50,
  };
}

/** Closed-form spark flight with linear drag k and gravity g: offset from the burst centre at age a. */
function flight(vx: number, vy: number, k: number, g: number, a: number, out: number[]): void {
  const e = (1 - Math.exp(-k * a)) / k;
  out[0] = vx * e;
  out[1] = vy * e + (g / k) * (a - e);
}

interface Tower { x: number; top: number; w: number }

/** The skyline as building rects, deterministic per size, shared by the cached layer and the
 *  per-frame aviation beacons. */
function skyline(w: number, horizon: number, unit: number, salt: number, scale: number): Tower[] {
  const out: Tower[] = [];
  let x = -unit * 10;
  let i = 0;
  while (x < w + unit * 10) {
    const bw = unit * (9 + 26 * hash01(i, salt));
    const nx = (x + bw / 2) / w;
    // A downtown core right of centre, a smaller cluster to the left, low sprawl elsewhere.
    const env = 0.1 + 0.9 * Math.exp(-(((nx - 0.63) / 0.1) ** 2)) + 0.45 * Math.exp(-(((nx - 0.3) / 0.06) ** 2));
    const bh = unit * scale * (8 + 150 * env * (0.3 + 0.7 * Math.pow(hash01(i, salt + 1), 0.8)));
    out.push({ x, top: horizon - bh, w: bw - unit * 1.5 });
    x += bw * (0.75 + 0.25 * hash01(i, salt + 5));
    i++;
  }
  return out;
}

function paintBackLayer(ctx: CanvasRenderingContext2D, w: number, h: number, horizon: number, season: SeasonId | null): void {
  const g = ctx.createLinearGradient(0, 0, 0, horizon);
  if (season === "new-year") {
    g.addColorStop(0, "#04040c");
    g.addColorStop(0.5, "#0b0c22");
    g.addColorStop(0.85, "#1c1736");
    g.addColorStop(1, "#33264a");
  } else {
    g.addColorStop(0, "#03060f");
    g.addColorStop(0.5, "#08112a");
    g.addColorStop(0.85, "#152045");
    g.addColorStop(1, "#28305a");
  }
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, horizon + 2);
  // City glow: a warm haze over the downtown core.
  glow(ctx, w * 0.62, horizon, Math.max(w, h) * 0.42, season === "new-year" ? "140 96 120" : "96 92 150", 0.28);
  // Stars, denser and brighter toward the zenith.
  for (let i = 0; i < 300; i++) {
    const sx = hash01(i, 31) * w;
    const sy = Math.pow(hash01(i, 32), 1.7) * horizon * 0.8;
    const b = hash01(i, 33);
    ctx.fillStyle = `rgb(226 232 255 / ${(0.1 + b * 0.55) * (1 - sy / horizon)})`;
    const s = b > 0.95 ? 1.5 : 0.9;
    ctx.fillRect(sx, sy, s, s);
  }
}

function paintFrontLayer(ctx: CanvasRenderingContext2D, w: number, h: number, horizon: number, unit: number, season: SeasonId | null): void {
  // Low hills behind the far shore, then two skyline rows: hazy and far, darker and near.
  ridge(ctx, w, horizon + 1, horizon - unit * 14, unit * 12, unit * 260, 5, "#10152c", 3);
  const lights: number[] = [];
  const rows = [
    { fill: "#121834", salt: 41, scale: 0.75, lit: 0.05 },
    { fill: "#080b1c", salt: 42, scale: 1, lit: 0.09 },
  ];
  for (const row of rows) {
    ctx.fillStyle = row.fill;
    const towers = skyline(w, horizon, unit, row.salt, row.scale);
    towers.forEach((tw, i) => {
      ctx.fillRect(tw.x, tw.top, tw.w, horizon - tw.top + 1);
      const tall = horizon - tw.top > unit * 70;
      if (tall && hash01(i, row.salt + 2) > 0.5) {
        // Setback crown and a mast on the tall towers.
        ctx.fillRect(tw.x + tw.w * 0.2, tw.top - unit * 7, tw.w * 0.6, unit * 7);
        ctx.fillRect(tw.x + tw.w * 0.5 - unit * 0.6, tw.top - unit * 26, unit * 1.2, unit * 20);
      }
      for (let wy = tw.top + unit * 4; wy < horizon - unit * 3; wy += unit * 3.6) {
        for (let wx = tw.x + unit * 2; wx < tw.x + tw.w - unit * 2.5; wx += unit * 3.4) {
          const hv = hash01(Math.floor(wx * 7.3) * 92821 + Math.floor(wy * 3.1), row.salt + 3);
          if (hv < row.lit) lights.push(wx, wy, hv / row.lit);
        }
      }
    });
  }
  for (let i = 0; i < lights.length; i += 3) {
    const v = lights[i + 2];
    ctx.fillStyle = v > 0.75 ? `rgb(196 216 255 / ${0.3 + v * 0.4})` : `rgb(255 208 140 / ${0.3 + v * 0.5})`;
    ctx.fillRect(lights[i], lights[i + 1], unit * 1.3, unit * 1.3);
  }
  // The lake: dark, picking up the city glow near the shore.
  const wg = ctx.createLinearGradient(0, horizon, 0, h);
  wg.addColorStop(0, season === "new-year" ? "#1d1830" : "#141c3a");
  wg.addColorStop(0.18, "#0a0d1f");
  wg.addColorStop(1, "#03050c");
  ctx.fillStyle = wg;
  ctx.fillRect(0, horizon, w, h - horizon);
  // The city glow mirrored, then long broken reflections of the shore lights.
  glow(ctx, w * 0.62, horizon, Math.max(w, h) * 0.3, season === "new-year" ? "140 96 120" : "96 92 150", 0.12);
  for (let i = 0; i < lights.length; i += 3) {
    if (lights[i + 2] < 0.5) continue;
    const lx = lights[i];
    for (let k = 0; k < 7; k++) {
      const ry = horizon + unit * (2 + k * 5.5 + hash01(i + k, 51) * 4) + (horizon - lights[i + 1]) * 0.15;
      if (ry > h) break;
      const rw = unit * (2 + hash01(i, k) * 5) * (1 + k * 0.25);
      ctx.fillStyle = `rgb(255 206 140 / ${0.14 * (1 - k / 7)})`;
      ctx.fillRect(lx - rw / 2, ry, rw, unit * 0.9);
    }
  }
  // Faint horizontal swells across the open water.
  for (let i = 0; i < 70; i++) {
    const y = horizon + Math.pow(hash01(i, 81), 1.6) * (h - horizon);
    const d = h > horizon ? (y - horizon) / (h - horizon) : 0; // a host a pixel tall has no water band
    const lw = unit * (30 + 160 * hash01(i, 82)) * (0.4 + d);
    ctx.fillStyle = `rgb(150 166 220 / ${0.025 + 0.035 * (1 - d)})`;
    ctx.fillRect(hash01(i, 83) * w - lw / 2, y, lw, Math.max(1, unit * (0.6 + d)));
  }
  ctx.fillStyle = "rgb(170 176 230 / 0.16)";
  ctx.fillRect(0, horizon, w, Math.max(1, unit * 0.8));
}

const tmp = [0, 0];
const TRAIL_ALPHA = [0.95, 0.5, 0.2];

function paintShells(ctx: CanvasRenderingContext2D, f: SceneFrame, live: Shell[], horizon: number, unit: number): void {
  // Smoke first (normal blending), so sparks sit on top: a soft puff that spreads and drifts.
  for (const b of live) {
    if (b.age <= 0) continue;
    const k = Math.min(1, b.age / 1.5) * Math.max(0, 1 - b.age / SMOKE_S);
    if (k > 0) glow(ctx, b.x + b.age * unit * 10, b.y + b.age * unit * 5, b.r * (0.8 + b.age * 0.1), "112 118 150", 0.09 * k);
  }
  ctx.globalCompositeOperation = "lighter";
  ctx.lineCap = "round";
  for (const b of live) {
    if (b.age < 0) {
      // The rising trail: decelerating toward the apex, a hot head trailing faint embers.
      const p = 1 + b.age / RISE_S;
      const ease = 1 - (1 - p) ** 2.2;
      const hx = b.launchX + (b.x - b.launchX) * ease + Math.sin(p * 9 + b.seed) * unit * 1.5;
      const hy = horizon + (b.y - horizon) * ease;
      const tp = Math.max(0, ease - 0.16);
      const tx = b.launchX + (b.x - b.launchX) * tp;
      const ty = horizon + (b.y - horizon) * tp;
      const tg = ctx.createLinearGradient(tx, ty, hx, hy);
      tg.addColorStop(0, "rgb(255 220 170 / 0)");
      tg.addColorStop(1, "rgb(255 226 180 / 0.6)");
      ctx.strokeStyle = tg;
      ctx.lineWidth = unit * 1.4;
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(hx, hy);
      ctx.stroke();
      glow(ctx, hx, hy, unit * 8, "255 226 180", 0.55);
      continue;
    }
    if (b.age > BURST_S) continue;
    const a = b.age;
    const life = a / BURST_S;
    // The flash lights the sky around the shell and lingers briefly as a coloured bloom.
    if (a < 1.4) glow(ctx, b.x, b.y, b.r * 1.3, b.color, 0.4 * (1 - a / 1.4) ** 2.2);
    const willow = b.kind === WILLOW;
    const count = willow ? 84 : 110;
    const drag = willow ? 1.3 : 2.4;
    const grav = unit * (willow ? 46 : 30);
    const tail = willow ? 0.75 : 0.22;
    const fade = (1 - life) ** (willow ? 0.9 : 1.4);
    const heads: number[] = [];
    for (let pass = 0; pass < 2; pass++) {
      // Each streak is cut into three segments, bright at the head and fading toward the tail.
      const seg = [new Path2D(), new Path2D(), new Path2D()];
      for (let i = pass; i < count; i += 2) {
        // Each spark burns out at its own moment in the last half of the shell's life.
        if (life > 0.45 + 0.55 * hash01(b.seed + i, 24)) continue;
        const ang = hash01(b.seed + i, 21) * Math.PI * 2;
        // Uniform on a sphere, projected: sparks crowd toward the rim like a real shell.
        const z = hash01(b.seed + i, 22) * 2 - 1;
        let speed = b.r * drag * (b.kind === RING ? 1 : Math.sqrt(1 - z * z) * (0.92 + 0.08 * hash01(b.seed + i, 25)));
        if (b.kind === DOUBLE && pass === 1) speed *= 0.55;
        const vx = Math.cos(ang) * speed;
        const vy = Math.sin(ang) * speed;
        flight(vx, vy, drag, grav, a, tmp);
        let px = b.x + tmp[0];
        let py = b.y + tmp[1];
        heads.push(px, py);
        for (let s = 0; s < 3; s++) {
          flight(vx, vy, drag, grav, Math.max(0, a - (tail * (s + 1)) / 3), tmp);
          const qx = b.x + tmp[0];
          const qy = b.y + tmp[1];
          seg[s].moveTo(px, py);
          seg[s].lineTo(qx, qy);
          px = qx;
          py = qy;
        }
      }
      const col = pass === 0 ? b.color : b.accent;
      // A wide soft halo on the leading two segments, then a thin core fading down the streak.
      ctx.strokeStyle = `rgb(${col} / ${0.24 * fade})`;
      ctx.lineWidth = unit * (willow ? 3.6 : 4.6);
      ctx.stroke(seg[0]);
      ctx.stroke(seg[1]);
      ctx.lineWidth = unit * (willow ? 1.3 : 1.7);
      for (let s = 0; s < 3; s++) {
        ctx.strokeStyle = `rgb(${col} / ${TRAIL_ALPHA[s] * fade})`;
        ctx.stroke(seg[s]);
      }
    }
    // Hot heads early on, then a glitter of twinkling points as the shell dies.
    ctx.beginPath();
    const tw = Math.floor(a * 12);
    const s = unit * 1.7;
    for (let i = 0; i < heads.length; i += 2) {
      if (life < 0.3 || hash01(b.seed + i * 13 + tw, 26) < 0.4) ctx.rect(heads[i] - s / 2, heads[i + 1] - s / 2, s, s);
    }
    ctx.fillStyle = `rgb(255 248 228 / ${0.7 * fade})`;
    ctx.fill();
  }
  ctx.globalCompositeOperation = "source-over";
}

/** Each shell's light breaks into short horizontal glints across the water below it. */
function paintReflections(ctx: CanvasRenderingContext2D, f: SceneFrame, live: Shell[], horizon: number, unit: number): void {
  ctx.globalCompositeOperation = "lighter";
  for (const b of live) {
    if (b.age < 0 || b.age > BURST_S) continue;
    const fade = (1 - b.age / BURST_S) ** 1.4;
    const ry = horizon + (horizon - b.y) * 0.3;
    if (b.age < 0.7) glow(ctx, b.x, horizon + unit * 10, b.r * 1.2, b.color, 0.16 * (1 - b.age / 0.7));
    glow(ctx, b.x, ry, b.r * 0.7, b.color, 0.13 * fade);
    ctx.fillStyle = `rgb(${b.color} / ${0.6 * fade})`;
    ctx.beginPath();
    for (let i = 0; i < 22; i++) {
      const gy = horizon + unit * 3 + (ry - horizon) * 1.8 * hash01(b.seed + i, 61);
      if (gy > f.h) continue;
      const shimmer = Math.sin(f.t * 0.0022 + i * 1.7);
      const spread = (gy - horizon) / (ry - horizon + 1);
      const gx = b.x + (hash01(b.seed + i, 62) - 0.5) * b.r * (0.6 + spread * 0.8) + shimmer * unit * 3;
      const gw = unit * (5 + 16 * hash01(b.seed + i, 63)) * (0.5 + 0.5 * shimmer * shimmer);
      ctx.rect(gx - gw / 2, gy, gw, unit * 1.1);
    }
    ctx.fill();
  }
  ctx.globalCompositeOperation = "source-over";
}

/** Aviation beacons on the tallest towers: a slow red blink, a New-Year's-Eve-quiet detail. */
function paintBeacons(ctx: CanvasRenderingContext2D, f: SceneFrame, horizon: number, unit: number): void {
  const on = (Math.sin(f.t * 0.0016) + 1) / 2;
  const key = `${f.w}x${horizon}x${unit}`;
  if (beaconKey !== key) {
    beaconKey = key;
    beacons = [];
    // The same towers that got a crown and mast in the front layer.
    skyline(f.w, horizon, unit, 42, 1).forEach((tw, i) => {
      if (horizon - tw.top > unit * 70 && hash01(i, 44) > 0.5) beacons.push(tw.x + tw.w / 2, tw.top - unit * 26);
    });
  }
  for (let i = 0; i < beacons.length; i += 2) glow(ctx, beacons[i], beacons[i + 1], unit * 6, "255 70 60", 0.15 + 0.55 * on);
}

let beaconKey = "";
let beacons: number[] = [];

/** Slow champagne confetti for New Year's: gold, silver and blush flakes that flip as they fall. */
function paintConfetti(ctx: CanvasRenderingContext2D, f: SceneFrame, unit: number): void {
  const fills = ["rgb(240 200 112 / 0.6)", "rgb(226 232 246 / 0.5)", "rgb(246 190 166 / 0.5)", "rgb(255 222 150 / 0.75)"];
  const ts = f.t / 1000;
  for (let c = 0; c < fills.length; c++) {
    ctx.beginPath();
    for (let i = c; i < 64; i += fills.length) {
      const speed = unit * (12 + 14 * hash01(i, 71));
      const y = wrap(ts * speed + hash01(i, 72) * f.h, f.h + 40) - 20;
      const x = wrap(hash01(i, 73) * f.w + Math.sin(ts * (0.3 + 0.3 * hash01(i, 74)) + i) * unit * 28, f.w);
      const spin = ts * (0.6 + 1.2 * hash01(i, 75)) + i;
      const s = unit * (2.4 + 2.2 * hash01(i, 76));
      const cw = Math.cos(spin) * s;
      const sw = Math.sin(spin) * s;
      const flip = Math.max(0.12, Math.abs(Math.cos(spin * 1.3 + i))) * 0.55;
      // A flipping rectangle: the long axis rotates, the short axis foreshortens with the flip.
      ctx.moveTo(x + cw, y + sw);
      ctx.lineTo(x - sw * flip, y + cw * flip);
      ctx.lineTo(x - cw, y - sw);
      ctx.lineTo(x + sw * flip, y - cw * flip);
      ctx.closePath();
    }
    ctx.fillStyle = fills[c];
    ctx.fill();
  }
}

export const scene: SceneDef = {
  id: "fireworks",
  label: "Fireworks over the lake",
  paint(f: SceneFrame): void {
    const { ctx, w, h } = f;
    const unit = Math.max(0.6, Math.min(w / 1400, h / 800));
    const horizon = Math.round(h * 0.7);
    const dpr = frameDpr(f);
    const season = f.season;
    const colors = shellColors(season);
    const live: Shell[] = [];
    for (let s = 0; s < SLOTS; s++) {
      const b = shellOf(s, f.t / 1000, w, horizon, colors, unit, season);
      if (b) live.push(b);
    }
    ctx.drawImage(layerCache(`fireworks-back-${season}`, w, h, dpr, (c) => paintBackLayer(c, w, h, horizon, season)), 0, 0, w, h);
    paintShells(ctx, f, live, horizon, unit);
    // The skyline hides the low end of each rising trail; the opaque lake then takes the glints.
    ctx.drawImage(layerCache(`fireworks-front-${season}`, w, h, dpr, (c) => paintFrontLayer(c, w, h, horizon, unit, season)), 0, 0, w, h);
    paintBeacons(ctx, f, horizon, unit);
    paintReflections(ctx, f, live, horizon, unit);
    if (season === "new-year") paintConfetti(ctx, f, unit);
  },
};
