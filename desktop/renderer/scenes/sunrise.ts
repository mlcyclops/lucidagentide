// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/scenes/sunrise.ts
//
// P-SEASON.1 (ADR-0525): dawn over layered rolling hills. The sun climbs slowly out of the far hills
// (an eased, asymptotic rise over the first few minutes, then it rests), soft god-rays fan from it and
// breathe, valley mist glows between the ridges, and a loose formation of white doves glides across
// with an occasional wingbeat. MLK Jr. Day reads cool indigo to warm gold with the last stars fading;
// Juneteenth reads a warmer red-gold dawn with a faint nova-star motif in the sky.

import type { SeasonId } from "../seasons.ts";
import { bird, fbm1, frameDpr, glow, hash01, layerCache, wrap, type SceneDef, type SceneFrame } from "../scene_kit.ts";

interface Look {
  sky: [number, string][];
  sun: string;      // `r g b` of the sun core glow
  halo: string;     // `r g b` of the wide warm halo
  hills: string[];  // far to near
  mist: string;     // `r g b`
  rim: string;      // `r g b` of the sunlit hill edges
}

function look(season: SeasonId | null): Look {
  if (season === "juneteenth") {
    return {
      sky: [[0, "#24142e"], [0.22, "#4a1f3a"], [0.42, "#8e3040"], [0.6, "#d4553a"], [0.74, "#f08f45"], [0.86, "#ffc46e"], [1, "#ffd994"]],
      sun: "255 236 190",
      halo: "255 150 80",
      hills: ["#c06a5a", "#8e4250", "#5c2a40", "#3a1c30", "#24121f"],
      mist: "255 196 140",
      rim: "255 200 130",
    };
  }
  return {
    sky: [[0, "#141a44"], [0.25, "#262c66"], [0.45, "#55508a"], [0.62, "#a7779a"], [0.76, "#eba27a"], [0.88, "#ffcd85"], [1, "#ffe2a6"]],
    sun: "255 244 214",
    halo: "255 186 112",
    hills: ["#a98aa6", "#77648f", "#4d4472", "#302c52", "#1b1a36"],
    mist: "255 214 170",
    rim: "255 214 160",
  };
}

const SUN_X = 0.6;

/** The rolling ridge of hill layer `i` at x: smooth, broad swells (low-octave noise, no jaggies). */
function hillY(i: number, x: number, w: number, h: number): number {
  const base = h * (0.62 + i * 0.075);
  const amp = h * (0.035 + i * 0.012);
  return base - (fbm1(x / (w * (0.32 - i * 0.03)), 2, 300 + i * 17) - 0.5) * 2 * amp;
}

function paintHills(ctx: CanvasRenderingContext2D, w: number, h: number, L: Look): void {
  const sx = w * SUN_X;
  for (let i = 0; i < L.hills.length; i++) {
    // Mist pooled in the valley behind this ridge: a warm band, brightest under the sun.
    const top = hillY(i, sx, w, h) - h * 0.05;
    const mg = ctx.createLinearGradient(0, top, 0, top + h * 0.09);
    mg.addColorStop(0, `rgb(${L.mist} / 0)`);
    mg.addColorStop(0.6, `rgb(${L.mist} / ${0.16 - i * 0.025})`);
    mg.addColorStop(1, `rgb(${L.mist} / 0)`);
    ctx.fillStyle = mg;
    ctx.fillRect(0, top, w, h * 0.09);
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let x = 0; x <= w + 6; x += 6) ctx.lineTo(x, hillY(i, x, w, h));
    ctx.lineTo(w, h);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, h * (0.55 + i * 0.07), 0, h);
    g.addColorStop(0, L.hills[i]);
    g.addColorStop(1, L.hills[Math.min(L.hills.length - 1, i + 1)]);
    ctx.fillStyle = g;
    ctx.fill();
    // Rim light along the crest, strongest toward the sun.
    const rim = ctx.createLinearGradient(0, 0, w, 0);
    const a = 0.5 - i * 0.08;
    rim.addColorStop(0, `rgb(${L.rim} / 0)`);
    rim.addColorStop(Math.max(0, SUN_X - 0.35), `rgb(${L.rim} / ${a * 0.15})`);
    rim.addColorStop(SUN_X, `rgb(${L.rim} / ${a})`);
    rim.addColorStop(Math.min(1, SUN_X + 0.35), `rgb(${L.rim} / ${a * 0.15})`);
    rim.addColorStop(1, `rgb(${L.rim} / 0)`);
    ctx.strokeStyle = rim;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let x = 0; x <= w + 6; x += 6) {
      const y = hillY(i, x, w, h) + 0.8;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  // Scattered trees on the nearest swells: small rounded crowns, silhouetted.
  for (let k = 0; k < 26; k++) {
    const layer = 3 + (k % 2);
    const x = hash01(k, 401) * w;
    const y = hillY(layer, x, w, h);
    const s = h * (0.012 + 0.014 * hash01(k, 402)) * (layer === 4 ? 1.4 : 1);
    ctx.fillStyle = L.hills[layer];
    ctx.fillRect(x - s * 0.08, y - s * 1.2, s * 0.16, s * 1.3);
    ctx.beginPath();
    ctx.ellipse(x, y - s * 1.5, s * 0.7, s * 0.9, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Juneteenth's motif: a five-point star inside a twelve-point nova burst, drawn as faint outlines. */
function paintNova(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, alpha: number): void {
  glow(ctx, x, y, r * 2.4, "255 226 190", alpha * 0.35);
  ctx.lineJoin = "miter";
  ctx.strokeStyle = `rgb(255 240 220 / ${alpha})`;
  ctx.lineWidth = Math.max(1, r * 0.035);
  ctx.beginPath();
  for (let i = 0; i <= 24; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 12;
    const rr = i % 2 === 0 ? r * 1.55 : r * 1.05;
    if (i === 0) ctx.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    else ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  ctx.stroke();
  ctx.beginPath();
  for (let i = 0; i <= 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 === 0 ? r * 0.8 : r * 0.33;
    if (i === 0) ctx.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    else ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  ctx.fillStyle = `rgb(255 244 228 / ${alpha * 0.5})`;
  ctx.fill();
  ctx.stroke();
}

export const scene: SceneDef = {
  id: "sunrise",
  label: "Sunrise over the hills",
  paint(f: SceneFrame): void {
    const { ctx, w, h, t } = f;
    const L = look(f.season);
    const unit = Math.max(0.6, Math.min(w / 1400, h / 800));
    const dpr = frameDpr(f);
    // The rise: eased toward a resting height over the first minutes, so it is never "done" abruptly.
    const rise = 1 - Math.exp(-t / 70000);
    const sunR = Math.min(w, h) * 0.05;
    const sx = w * SUN_X;
    const sy = h * (0.64 - 0.17 * rise);
    ctx.drawImage(layerCache(`sunrise-sky-${f.season}`, w, h, dpr, (c) => {
      const g = c.createLinearGradient(0, 0, 0, h * 0.75);
      for (const [o, col] of L.sky) g.addColorStop(o, col);
      c.fillStyle = g;
      c.fillRect(0, 0, w, h);
      // The last stars of the night in the high, still-dark sky.
      for (let i = 0; i < 160; i++) {
        const y = Math.pow(hash01(i, 21), 1.8) * h * 0.4;
        c.fillStyle = `rgb(240 236 255 / ${(0.15 + 0.5 * hash01(i, 22)) * (1 - y / (h * 0.4))})`;
        c.fillRect(hash01(i, 23) * w, y, 1.1, 1.1);
      }
      // A few long, thin cloud streaks catching the first light.
      for (let i = 0; i < 7; i++) {
        const cy = h * (0.2 + 0.32 * hash01(i, 31));
        const cw = w * (0.18 + 0.25 * hash01(i, 32));
        const cx = w * hash01(i, 33);
        const cg = c.createLinearGradient(cx - cw / 2, 0, cx + cw / 2, 0);
        const lit = 0.1 + 0.18 * (cy / (h * 0.52));
        cg.addColorStop(0, `rgb(${L.halo} / 0)`);
        cg.addColorStop(0.5, `rgb(${L.halo} / ${lit})`);
        cg.addColorStop(1, `rgb(${L.halo} / 0)`);
        c.fillStyle = cg;
        c.beginPath();
        c.ellipse(cx, cy, cw / 2, h * (0.004 + 0.006 * hash01(i, 34)), 0, 0, Math.PI * 2);
        c.fill();
      }
    }), 0, 0, w, h);
    // Morning brightens as the sun climbs: a broad warm wash, then the halo and the disc.
    glow(ctx, sx, sy, Math.max(w, h) * 0.75, L.halo, 0.18 + 0.2 * rise);
    glow(ctx, sx, sy, sunR * 6, L.sun, 0.35 + 0.15 * rise);
    // God-rays: soft wedges fanning from the sun, slowly turning and breathing.
    ctx.globalCompositeOperation = "lighter";
    const rayLen = Math.max(w, h) * 0.95;
    const rg = ctx.createRadialGradient(sx, sy, sunR, sx, sy, rayLen);
    rg.addColorStop(0, `rgb(${L.sun} / 0)`);
    rg.addColorStop(0.06, `rgb(${L.sun} / 0.045)`);
    rg.addColorStop(0.25, `rgb(${L.sun} / 0.016)`);
    rg.addColorStop(0.7, `rgb(${L.sun} / 0)`);
    ctx.fillStyle = rg;
    const turn = Math.sin(t / 26000) * 0.05;
    // Each ray is three nested wedges added together, so its edges fall off softly, not as a hard cut.
    for (let layer = 1; layer <= 3; layer++) {
      ctx.beginPath();
      for (let i = 0; i < 12; i++) {
        const breathe = 0.55 + 0.45 * Math.sin(t / (5200 + i * 700) + i * 2.1);
        const a = Math.PI * 1.08 + (i + 0.5) * (Math.PI * 0.84 / 12) + turn + (hash01(i, 41) - 0.5) * 0.1;
        const half = (0.01 + 0.03 * hash01(i, 42)) * breathe * layer * 0.6;
        ctx.moveTo(sx, sy);
        ctx.lineTo(sx + Math.cos(a - half) * rayLen, sy + Math.sin(a - half) * rayLen);
        ctx.lineTo(sx + Math.cos(a + half) * rayLen, sy + Math.sin(a + half) * rayLen);
        ctx.closePath();
      }
      ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
    // The disc: a bright core with a soft limb.
    const dg = ctx.createRadialGradient(sx, sy, 0, sx, sy, sunR);
    dg.addColorStop(0, "rgb(255 253 244)");
    dg.addColorStop(0.75, `rgb(${L.sun})`);
    dg.addColorStop(1, `rgb(${L.sun} / 0.85)`);
    ctx.fillStyle = dg;
    ctx.beginPath();
    ctx.arc(sx, sy, sunR, 0, Math.PI * 2);
    ctx.fill();
    if (f.season === "juneteenth") {
      paintNova(ctx, w * 0.17, h * 0.2, unit * 40, 0.22 + 0.06 * Math.sin(t / 4200));
    }
    ctx.drawImage(layerCache(`sunrise-hills-${f.season}`, w, h, dpr, (c) => paintHills(c, w, h, L)), 0, 0, w, h);
    // White doves in a loose V, crossing slowly and gliding between a few wingbeats.
    const lap = 95000;
    const p = wrap(t + 26000, lap) / lap;
    const leadX = -w * 0.15 + p * w * 1.35;
    const leadY = h * (0.3 - 0.06 * p) + Math.sin(t / 5000) * h * 0.012;
    const flock = [[0, 0], [-1, 1], [-1, -1], [-2, 1.8], [-2.1, -1.7]];
    for (let i = 0; i < flock.length; i++) {
      const [row, side] = flock[i];
      const sp = unit * 44;
      const x = leadX + row * sp * 1.6 + Math.sin(t / 3100 + i * 1.3) * unit * 6;
      const y = leadY + side * sp * 0.7 + Math.sin(t / 2600 + i * 2.2) * unit * 4;
      const u = wrap(t / 1000 + i * 0.9, 4.2);
      const flap = u < 1.4 ? (u / 0.47) % 1 : 0;
      const span = unit * (46 - i * 2);
      bird(ctx, x, y, span, flap, "rgb(255 250 242 / 0.94)", 1);
      ctx.fillStyle = "rgb(255 250 242 / 0.94)";
      ctx.beginPath();
      ctx.ellipse(x + span * 0.08, y + span * 0.06, span * 0.17, span * 0.07, 0.1, 0, Math.PI * 2);
      ctx.fill();
    }
  },
};
