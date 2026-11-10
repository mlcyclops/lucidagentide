// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/scenes/canyon.ts
//
// P-SEASON.1 (ADR-0525): desert mesas at sunset. Three ranges of flat-topped mesas, buttes and a spire
// recede into dusty haze, their sedimentary bands and sun-facing cliffs lit by a sun that has just
// set off to the left. Thin cirrus drifts, the air over the far range shimmers, a hawk circles on a
// thermal and the first stars come out. A natural landscape only. The sky, each range and the desert
// floor are cached layers; the shimmer re-slices the far range per frame with plain drawImage strips.

import { bird, frameDpr, glow, hash01, layerCache, noise1, wrap, type SceneDef, type SceneFrame } from "../scene_kit.ts";

/** One landform, all in fractions of the frame: centre, half-width of the flat top, top height. */
interface Mesa { cx: number; hw: number; ht: number }

interface Range {
  /** Base line as a fraction of h. */
  base: number;
  mesas: readonly Mesa[];
  /** Cliff and talus widths as fractions of w. */
  cliff: number;
  talus: number;
  top: string;
  foot: string;
  ground: readonly [string, string];
  lit: string;
  haze: string;
  band: number;
  salt: number;
}

const FAR: Range = {
  base: 0.6,
  mesas: [
    { cx: 0.06, hw: 0.05, ht: 0.06 }, { cx: 0.29, hw: 0.1, ht: 0.095 }, { cx: 0.5, hw: 0.025, ht: 0.065 },
    { cx: 0.63, hw: 0.11, ht: 0.08 }, { cx: 0.9, hw: 0.07, ht: 0.105 },
  ],
  cliff: 0.006, talus: 0.022,
  top: "#b0718b", foot: "#cf9188", ground: ["#c98d84", "#b97a78"], lit: "255 196 160", haze: "246 184 160",
  band: 0.006, salt: 11,
};

const MID: Range = {
  base: 0.66,
  mesas: [
    { cx: 0.17, hw: 0.065, ht: 0.15 }, { cx: 0.41, hw: 0.022, ht: 0.18 }, { cx: 0.465, hw: 0.008, ht: 0.215 },
    { cx: 0.76, hw: 0.085, ht: 0.125 },
  ],
  cliff: 0.009, talus: 0.034,
  top: "#b0544a", foot: "#8c4342", ground: ["#9a5148", "#6e3538"], lit: "255 150 96", haze: "232 140 122",
  band: 0.009, salt: 23,
};

const NEAR: Range = {
  base: 0.76,
  mesas: [
    { cx: -0.03, hw: 0.09, ht: 0.27 }, { cx: 0.87, hw: 0.055, ht: 0.33 }, { cx: 1.0, hw: 0.05, ht: 0.25 },
  ],
  cliff: 0.012, talus: 0.05,
  top: "#86362a", foot: "#5c2425", ground: ["#6a3030", "#24111a"], lit: "255 128 70", haze: "190 90 80",
  band: 0.013, salt: 37,
};

const ease = (x: number): number => x * x * (3 - 2 * x);

/** One landform's height in px above the range base at x: flat caprock, a steep cliff, a concave talus apron. */
function mesaHeight(x: number, m: Mesa, r: Range, w: number, h: number): number {
  const d = Math.abs(x / w - m.cx);
  const H = m.ht * h;
  if (d <= m.hw) return H * (0.975 + 0.025 * noise1(x / 24, r.salt));
  if (d <= m.hw + r.cliff) return H * (1 - 0.4 * ease((d - m.hw) / r.cliff));
  if (d <= m.hw + r.cliff + r.talus) return H * 0.6 * Math.pow(Math.max(0, 1 - (d - m.hw - r.cliff) / r.talus), 1.5); // float rounding at the edge can dip below 0, and pow(<0, 1.5) is NaN
  return 0;
}

/** The range skyline: the tallest landform at x over a gently rolling floor. */
function profile(x: number, r: Range, w: number, h: number): number {
  let best = 0;
  for (const m of r.mesas) best = Math.max(best, mesaHeight(x, m, r, w, h));
  return best + h * 0.006 * noise1(x / 90, r.salt + 1);
}

function paintRange(c: CanvasRenderingContext2D, w: number, h: number, r: Range): void {
  const base = r.base * h;
  const maxH = Math.max(...r.mesas.map((m) => m.ht)) * h;
  const step = 2;
  const ys: number[] = [];
  for (let x = 0; x <= w + step; x += step) ys.push(base - profile(x, r, w, h));

  c.beginPath();
  c.moveTo(0, h);
  for (let i = 0; i < ys.length; i++) c.lineTo(i * step, ys[i]);
  c.lineTo(w, h);
  c.closePath();
  let g = c.createLinearGradient(0, base - maxH, 0, h);
  g.addColorStop(0, r.top);
  g.addColorStop((maxH / (h - base + maxH)) * 0.98, r.foot);
  g.addColorStop((maxH / (h - base + maxH)) * 0.98 + 0.001, r.ground[0]);
  g.addColorStop(1, r.ground[1]);
  c.fillStyle = g;
  c.fill();

  c.save();
  c.clip();
  // Sedimentary bands across the rock.
  const bh = r.band * h;
  for (let k = 0, y = base - maxH; y < base; k++, y += bh * (0.6 + 0.8 * hash01(k, r.salt + 2))) {
    const lightBand = hash01(k, r.salt + 3) < 0.5;
    c.fillStyle = lightBand ? `rgb(255 214 180 / ${0.04 + 0.06 * hash01(k, r.salt + 4)})` : `rgb(60 20 24 / ${0.05 + 0.08 * hash01(k, r.salt + 5)})`;
    c.fillRect(0, y, w, bh * (0.3 + 0.5 * hash01(k, r.salt + 6)));
  }
  // Volume: the low sun is off to the left, so west faces glow and east faces fall into shadow.
  for (const [mi, m] of r.mesas.entries()) {
    const H = m.ht * h;
    const reach = m.hw + r.cliff + r.talus;
    const x0 = (m.cx - reach) * w;
    const x1 = (m.cx + reach) * w;
    g = c.createLinearGradient(x0, 0, x1, 0);
    g.addColorStop(0, `rgb(${r.lit} / 0.5)`);
    g.addColorStop((r.talus * 0.6) / (reach * 2), `rgb(${r.lit} / 0.42)`);
    g.addColorStop((r.talus + r.cliff * 1.5) / (reach * 2), `rgb(${r.lit} / 0.14)`);
    g.addColorStop(0.55, `rgb(${r.lit} / 0)`);
    g.addColorStop(0.8, "rgb(40 10 24 / 0.16)");
    g.addColorStop(1, "rgb(40 10 24 / 0.34)");
    c.save();
    c.beginPath();
    c.moveTo(x0, base + 1);
    for (let x = x0; x <= x1 + step; x += step) c.lineTo(x, base - mesaHeight(x, m, r, w, h) - 2);
    c.lineTo(x1, base + 1);
    c.closePath();
    c.clip();
    c.fillStyle = g;
    c.fillRect(x0, base - H - 2, x1 - x0, H + 3);
    c.restore();
    // Desert-varnish streaks running down from the caprock.
    const n = Math.round((m.hw * w) / 5);
    for (let k = 0; k < n; k++) {
      const id = mi * 1000 + k;
      c.fillStyle = `rgb(40 12 20 / ${0.05 + 0.08 * hash01(id, r.salt + 7)})`;
      c.fillRect(m.cx * w + (hash01(id, r.salt + 8) * 2 - 1) * (m.hw + r.cliff * 0.5) * w, base - H * 0.98, 0.8 + hash01(id, r.salt + 9) * 1.6, H * (0.12 + 0.3 * hash01(id, r.salt + 10)));
    }
  }
  // Dust haze thickening toward the ground and lingering over the floor.
  g = c.createLinearGradient(0, base - maxH * 0.7, 0, h);
  const at = (maxH * 0.7) / (h - base + maxH * 0.7);
  g.addColorStop(0, `rgb(${r.haze} / 0)`);
  g.addColorStop(at, `rgb(${r.haze} / 0.38)`);
  g.addColorStop(1, `rgb(${r.haze} / 0.06)`);
  c.fillStyle = g;
  c.fillRect(0, base - maxH, w, h - base + maxH);
  c.restore();

  // Warm rim light along every skyline.
  c.beginPath();
  for (let i = 0; i < ys.length; i++) {
    if (i === 0) c.moveTo(0, ys[0]);
    else c.lineTo(i * step, ys[i]);
  }
  c.strokeStyle = `rgb(${r.lit} / 0.32)`;
  c.lineWidth = 1;
  c.stroke();
}

function paintSky(c: CanvasRenderingContext2D, w: number, h: number): void {
  const g = c.createLinearGradient(0, 0, 0, h * 0.66);
  g.addColorStop(0, "#121838");
  g.addColorStop(0.3, "#33295a");
  g.addColorStop(0.56, "#86466a");
  g.addColorStop(0.76, "#d46f5c");
  g.addColorStop(0.9, "#f0a062");
  g.addColorStop(1, "#ffcb86");
  c.fillStyle = g;
  c.fillRect(0, 0, w, h);
  glow(c, w * 0.18, h * 0.62, h * 0.8, "255 150 90", 0.45);
  glow(c, w * 0.18, h * 0.62, h * 0.25, "255 214 150", 0.5);
}

function paintFloor(c: CanvasRenderingContext2D, w: number, h: number): void {
  paintRange(c, w, h, MID);
  paintRange(c, w, h, NEAR);
  const top = NEAR.base * h;
  // A pale, dry sandy wash meandering out of the distance, catching the afterglow.
  const wash = (s: number, side: number): [number, number] => {
    const y = top + h * 0.01 + Math.pow(s, 1.7) * (h - top);
    const cx = w * (0.58 - 0.16 * s) + Math.sin(s * 7.5) * w * 0.05 * s;
    return [cx + side * (2 + s * w * 0.06 * (0.6 + 0.8 * noise1(s * 9 + side * 5, 230))), y];
  };
  c.beginPath();
  for (let i = 0; i <= 60; i++) {
    const [x, y] = wash(i / 60, -1);
    if (i === 0) c.moveTo(x, y);
    else c.lineTo(x, y);
  }
  for (let i = 60; i >= 0; i--) {
    const [x, y] = wash(i / 60, 1);
    c.lineTo(x, y);
  }
  c.closePath();
  const wg = c.createLinearGradient(0, top, 0, h);
  wg.addColorStop(0, "rgb(236 160 130 / 0.4)");
  wg.addColorStop(1, "rgb(170 96 84 / 0.22)");
  c.fillStyle = wg;
  c.fill();

  // Scrub and rocks scattered over the foreground floor, larger toward the viewer.
  for (let i = 0; i < 240; i++) {
    const d = Math.pow(hash01(i, 101), 1.5);
    const y = top + h * 0.012 + d * (h - top);
    const x = hash01(i, 102) * w;
    const s = 1.2 + d * 11;
    if (hash01(i, 103) < 0.22) {
      c.fillStyle = "rgb(38 18 24 / 0.9)";
      c.beginPath();
      c.ellipse(x, y, s * 0.9, s * 0.4, 0, Math.PI, 0);
      c.fill();
      c.beginPath();
      c.ellipse(x, y, s * 0.9, s * 0.4, 0, Math.PI * 1.05, Math.PI * 1.45);
      c.strokeStyle = "rgb(255 150 100 / 0.3)";
      c.lineWidth = 1;
      c.stroke();
    } else {
      c.fillStyle = `rgb(${38 + 14 * hash01(i, 107)} 20 26 / 0.85)`;
      c.beginPath();
      for (let k = 0; k < 8; k++) {
        const bx = x + (hash01(i * 9 + k, 104) - 0.5) * s * 2;
        const by = y - hash01(i * 9 + k, 105) * s * 0.6;
        const br = s * (0.18 + 0.22 * hash01(i * 9 + k, 106));
        c.moveTo(bx + br, by);
        c.arc(bx, by, br, 0, Math.PI * 2);
      }
      c.fill();
    }
  }

  // A dark sandstone ledge in the left foreground, its top edge catching the last light, with grass tufts.
  const ledge: [number, number][] = [];
  for (let i = 0; i <= 14; i++) {
    const s = i / 14;
    ledge.push([s * w * 0.34, h * (0.885 + 0.11 * Math.pow(s, 2.2)) - h * 0.012 * hash01(i, 210)]);
  }
  c.beginPath();
  c.moveTo(0, h);
  for (const [x, y] of ledge) c.lineTo(x, y);
  c.lineTo(w * 0.34, h);
  c.closePath();
  const lg = c.createLinearGradient(0, h * 0.88, 0, h);
  lg.addColorStop(0, "#3a1a1c");
  lg.addColorStop(1, "#150a0f");
  c.fillStyle = lg;
  c.fill();
  c.beginPath();
  for (const [i, [x, y]] of ledge.entries()) {
    if (i === 0) c.moveTo(x, y);
    else c.lineTo(x, y);
  }
  c.strokeStyle = "rgb(255 150 100 / 0.35)";
  c.lineWidth = 1.5;
  c.stroke();
  c.fillStyle = "#170a10";
  c.beginPath();
  for (let i = 0; i < 9; i++) {
    const s = 0.05 + hash01(i, 220) * 0.8;
    const k = Math.min(13, Math.floor(s * 14));
    const [ax, ay] = ledge[k];
    const [bx2, by2] = ledge[k + 1];
    const u = s * 14 - k;
    const x = ax + (bx2 - ax) * u;
    const y = ay + (by2 - ay) * u + 2;
    const len = h * (0.025 + 0.03 * hash01(i, 221));
    for (let b = 0; b < 9; b++) {
      const lean = (b / 8 - 0.5) * 1.3 + (hash01(i * 9 + b, 222) - 0.5) * 0.3;
      const l = len * (0.6 + 0.4 * hash01(i * 9 + b, 223));
      c.moveTo(x - 1.2, y);
      c.quadraticCurveTo(x + Math.sin(lean) * l * 0.4, y - l * 0.6, x + Math.sin(lean) * l, y - Math.cos(lean) * l);
      c.quadraticCurveTo(x + Math.sin(lean) * l * 0.4 + 1, y - l * 0.55, x + 1.2, y);
    }
  }
  c.fill();
}

function paintAir(f: SceneFrame): void {
  const { ctx, w, h, t } = f;
  // First stars: brighter higher up, each slowly swelling in and out.
  ctx.fillStyle = "#fff4ea";
  for (let i = 0; i < 90; i++) {
    const y = Math.pow(hash01(i, 1), 1.3) * h * 0.42;
    const a = (1 - y / (h * 0.42)) * (0.35 + 0.35 * Math.sin(t * 0.0009 * (0.4 + hash01(i, 2)) + hash01(i, 3) * 9)) *
      (0.55 + 0.45 * Math.sin(t * 0.00007 + i * 1.7));
    if (a <= 0.02) continue;
    ctx.globalAlpha = a;
    const s = hash01(i, 4) < 0.1 ? 2 : 1.2;
    ctx.fillRect(hash01(i, 5) * w, y, s, s);
  }
  // The evening star, steady, low over the afterglow.
  ctx.globalAlpha = 1;
  glow(ctx, w * 0.27, h * 0.3, 9, "255 246 230", 0.7);
  ctx.fillRect(w * 0.27 - 1, h * 0.3 - 1, 2, 2);

  // High cirrus: soft lit streaks plus a few fine mare's-tail strands.
  for (let i = 0; i < 5; i++) {
    const rw = w * (0.12 + 0.14 * hash01(i, 11));
    const cx = wrap(hash01(i, 12) * w + t * 0.004 * (0.6 + hash01(i, 13)), w + rw * 2) - rw;
    const cy = h * (0.08 + 0.3 * hash01(i, 14));
    const rh = 3 + 7 * hash01(i, 15);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(1, rh / rw);
    glow(ctx, 0, 0, rw, cy > h * 0.22 ? "255 170 140" : "220 150 190", 0.3);
    ctx.restore();
  }
  ctx.lineWidth = 1;
  for (let i = 0; i < 9; i++) {
    const len = w * (0.08 + 0.12 * hash01(i, 21));
    const x = wrap(hash01(i, 22) * w + t * 0.005 * (0.6 + hash01(i, 23)), w + len * 2) - len;
    const y = h * (0.1 + 0.32 * hash01(i, 24));
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.bezierCurveTo(x + len * 0.3, y - 6, x + len * 0.6, y + 5, x + len, y - 3 - 6 * hash01(i, 25));
    ctx.strokeStyle = `rgb(255 196 170 / ${0.1 + 0.1 * hash01(i, 26)})`;
    ctx.stroke();
  }
}

function paintHawk(f: SceneFrame): void {
  const { ctx, w, h, t } = f;
  const a = t * 0.00022;
  const x = w * 0.5 + Math.cos(a) * w * 0.09;
  const y = h * 0.25 + Math.sin(a) * h * 0.035 + Math.sin(t * 0.00009) * h * 0.02;
  const near = 0.5 + 0.5 * Math.sin(a);
  bird(ctx, x, y, 26 + 10 * near, 0.03 * Math.sin(t * 0.0011), "#1d1119", -Math.sin(a) >= 0 ? 1 : -1);
}

export const scene: SceneDef = {
  id: "canyon",
  label: "Mesa sunset",
  paint(f: SceneFrame): void {
    const { ctx, w, h, t } = f;
    const dpr = frameDpr(f);
    ctx.drawImage(layerCache("canyon:sky", w, h, dpr, (c) => paintSky(c, w, h)), 0, 0, w, h);
    paintAir(f);

    // Far range with heat shimmer: the band just above its base is redrawn as thin, sideways-wobbling strips.
    const far = layerCache("canyon:far", w, h, dpr, (c) => paintRange(c, w, h, FAR));
    const top = Math.floor(h * (FAR.base - 0.035));
    const base = Math.ceil(FAR.base * h);
    ctx.drawImage(far, 0, 0, w * dpr, top * dpr, 0, 0, w, top);
    for (let y = top; y < base; y += 2) {
      const k = (y - top) / (base - top);
      const dx = (Math.sin(t * 0.0021 + y * 0.75) * 1.2 + Math.sin(t * 0.0013 + y * 0.31) * 0.6) * k;
      ctx.drawImage(far, 0, y * dpr, w * dpr, 2 * dpr, dx, y, w, 2);
    }
    ctx.drawImage(far, 0, base * dpr, w * dpr, (h - base) * dpr, 0, base, w, h - base);

    ctx.drawImage(layerCache("canyon:floor", w, h, dpr, (c) => paintFloor(c, w, h)), 0, 0, w, h);
    paintHawk(f);
  },
};
