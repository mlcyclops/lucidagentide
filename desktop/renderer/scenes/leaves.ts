// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/scenes/leaves.ts
//
// P-SEASON.1 (ADR-0525): an autumn forest edge in warm late-afternoon light. Hazy hills and three
// depths of amber, rust and gold canopies, big framing trees, a stubble field with round bales, a
// haystack and a few pumpkins by a split-rail fence. Soft sunbeams breathe through the trees while
// maple and oak leaves fall, swinging like pendulums and flipping as they tumble. Everything but the
// beams and the leaves is one cached layer.

import { frameDpr, glow, hash01, layerCache, ridge, wrap, type SceneDef, type SceneFrame } from "../scene_kit.ts";

const TAU = Math.PI * 2;

/** Canopy color triples: sunlit edge, body, shade. */
type Tone = readonly [string, string, string];
const VIVID: readonly Tone[] = [
  ["#ffd56e", "#e9a43a", "#9c5a1c"], ["#ff9e4e", "#d8642a", "#843218"], ["#f2744e", "#b93c2a", "#6a1e1c"],
  ["#ffe38e", "#d6b04c", "#866626"], ["#ec8c4c", "#a9562a", "#5a2a1a"],
];
const HAZY: readonly Tone[] = [
  ["#f6d6a6", "#e3b58c", "#c4977c"], ["#f3c6a0", "#dca88c", "#bc8e7c"], ["#f7dcaa", "#e6c290", "#c9a280"],
];
const DEEP: readonly Tone[] = [
  ["#e98a3a", "#9a3a1e", "#4a1a14"], ["#f0b24a", "#a8581e", "#4e2414"], ["#d8603a", "#7e2a1e", "#3a1412"],
];
const LEAF_COLORS: readonly (readonly [string, string])[] = [
  ["#c8402a", "#9a2e20"], ["#e0662a", "#b04c1e"], ["#f0a030", "#c07a22"], ["#f4c43a", "#c49a2a"],
  ["#a8461e", "#7a3014"], ["#d4782e", "#a45a22"],
];

/** A leafy crown: an irregular clump silhouette, shade on the lee side, then dappled leaf clusters
 *  that catch the light on the sun side (upper left). */
function crown(c: CanvasRenderingContext2D, x: number, y: number, r: number, tone: Tone, salt: number): void {
  const blobs = (n: number, spread: number, rMin: number, rMax: number, s: number, pick: (dx: number, dy: number, k: number) => string | null): void => {
    for (let k = 0; k < n; k++) {
      const a = hash01(k, s) * TAU;
      const d = Math.sqrt(hash01(k, s + 1)) * spread;
      const dx = Math.cos(a) * d;
      const dy = Math.sin(a) * d * 1.15;
      const col = pick(dx / spread, dy / spread, k);
      if (!col) continue;
      c.fillStyle = col;
      c.beginPath();
      c.arc(x + dx * r, y + dy * r, r * (rMin + (rMax - rMin) * hash01(k, s + 2)), 0, TAU);
      c.fill();
    }
  };
  blobs(11, 0.62, 0.3, 0.5, salt, () => tone[1]);
  blobs(9, 0.6, 0.22, 0.38, salt + 10, (dx, dy) => (dx + dy > 0.15 ? tone[2] : null));
  const n = Math.round(30 + r * 2.2);
  blobs(n, 0.85, 0.04, 0.1, salt + 20, (dx, dy, k) => {
    const lit = -(dx + dy) + (hash01(k, salt + 30) - 0.5) * 0.9;
    return lit > 0.35 ? tone[0] : lit < -0.45 ? tone[2] : null;
  });
}

function treeline(c: CanvasRenderingContext2D, w: number, base: number, r0: number, r1: number, tones: readonly Tone[], trunk: string, salt: number): void {
  for (let i = 0, x = -r1; x < w + r1; i++) {
    const r = r0 + (r1 - r0) * Math.pow(hash01(i, salt), 0.7);
    const tall = r * (0.8 + 1.4 * hash01(i, salt + 1));
    c.strokeStyle = trunk;
    c.lineWidth = Math.max(1, r * 0.12);
    c.beginPath();
    c.moveTo(x, base);
    c.lineTo(x + (hash01(i, salt + 2) - 0.5) * r * 0.3, base - tall);
    c.stroke();
    crown(c, x, base - tall - r * 0.3, r, tones[Math.floor(hash01(i, salt + 3) * tones.length)], salt * 100 + i * 7);
    x += r * (0.6 + 0.6 * hash01(i, salt + 4));
  }
}

function paintStatic(c: CanvasRenderingContext2D, w: number, h: number): void {
  const g = c.createLinearGradient(0, 0, 0, h * 0.7);
  g.addColorStop(0, "#86a6c2");
  g.addColorStop(0.35, "#c9c4b4");
  g.addColorStop(0.7, "#f2cd92");
  g.addColorStop(1, "#f6b468");
  c.fillStyle = g;
  c.fillRect(0, 0, w, h);
  const sx = w * 0.22;
  const sy = h * 0.36;
  glow(c, sx, sy, h * 0.9, "255 196 120", 0.45);
  glow(c, sx, sy, h * 0.16, "255 240 200", 0.8);

  ridge(c, w, h, h * 0.6, h * 0.035, 380, 5, "#c3a399");
  ridge(c, w, h, h * 0.635, h * 0.025, 260, 6, "#c09080");
  treeline(c, w, h * 0.665, h * 0.014, h * 0.024, HAZY, "#9c7a68", 2);
  // Haze between the far and middle woods.
  const hz = c.createLinearGradient(0, h * 0.55, 0, h * 0.68);
  hz.addColorStop(0, "rgb(250 220 170 / 0)");
  hz.addColorStop(1, "rgb(250 220 170 / 0.45)");
  c.fillStyle = hz;
  c.fillRect(0, h * 0.55, w, h * 0.13);
  treeline(c, w, h * 0.69, h * 0.03, h * 0.052, VIVID, "#5a3020", 3);
  // Undergrowth hugging the forest edge.
  for (let i = 0, x = 0; x < w + 20; i++) {
    const r = h * (0.012 + 0.012 * hash01(i, 8));
    crown(c, x, h * 0.688 - r * 0.45, r, DEEP[i % DEEP.length], 900 + i * 3);
    x += r * (1 + 0.8 * hash01(i, 9));
  }

  // The stubble field.
  const fieldTop = h * 0.68;
  const fg = c.createLinearGradient(0, fieldTop, 0, h);
  fg.addColorStop(0, "#e4b466");
  fg.addColorStop(0.4, "#c99048");
  fg.addColorStop(1, "#8e5a2a");
  c.fillStyle = fg;
  c.fillRect(0, fieldTop, w, h - fieldTop);
  const vx = w * 0.62;
  const vy = h * 0.6;
  c.save();
  c.beginPath();
  c.rect(0, fieldTop, w, h - fieldTop);
  c.clip();
  for (let i = -30; i <= 30; i++) {
    const bx = vx + i * w * 0.07;
    c.beginPath();
    c.moveTo(vx + (bx - vx) * 0.12, vy + (h - vy) * 0.12);
    c.lineTo(bx, h);
    c.strokeStyle = i % 2 === 0 ? "rgb(110 66 26 / 0.22)" : "rgb(255 230 170 / 0.16)";
    c.lineWidth = 2 + Math.abs(i) * 0.1;
    c.stroke();
  }
  // Stubble ticks, bigger toward the viewer.
  for (let i = 0; i < 2200; i++) {
    const d = Math.pow(hash01(i, 11), 1.4);
    const y = fieldTop + 4 + d * (h - fieldTop);
    const x = hash01(i, 12) * w;
    const l = 1 + d * 7;
    c.fillStyle = hash01(i, 13) < 0.55 ? "rgb(255 226 150 / 0.4)" : "rgb(100 60 24 / 0.3)";
    c.fillRect(x, y - l, 0.6 + d * 1.2, l);
  }
  // Fallen leaves on the field.
  for (let i = 0; i < 70; i++) {
    const d = Math.pow(hash01(i, 14), 0.8);
    const y = fieldTop + h * 0.04 + d * (h - fieldTop - h * 0.04);
    const s = 3 + d * 7;
    c.save();
    c.translate(hash01(i, 15) * w, y);
    c.rotate(hash01(i, 16) * TAU);
    c.scale(s, s * 0.55);
    c.fillStyle = LEAF_COLORS[Math.floor(hash01(i, 17) * LEAF_COLORS.length)][1];
    c.fill(hash01(i, 18) < 0.6 ? maple() : oak());
    c.restore();
  }
  c.restore();

  // Split-rail fence along the field edge.
  const fy = (x: number): number => h * 0.725 + (x / w) * h * 0.015;
  c.lineCap = "round";
  for (const [dy, lw] of [[-h * 0.035, 3], [-h * 0.018, 3]] as const) {
    c.beginPath();
    c.moveTo(-10, fy(0) + dy);
    for (let x = 0; x <= w * 0.56; x += w * 0.07) c.lineTo(x + w * 0.07, fy(x + w * 0.07) + dy + (hash01(Math.round(x), 19) - 0.5) * 3);
    c.strokeStyle = "#4a2c1a";
    c.lineWidth = lw;
    c.stroke();
    c.strokeStyle = "rgb(255 210 140 / 0.35)";
    c.lineWidth = 1;
    c.stroke();
  }
  for (let x = 0; x <= w * 0.63; x += w * 0.07) {
    c.fillStyle = "#3e2414";
    c.fillRect(x - 2.5, fy(x) - h * 0.045, 5, h * 0.05);
    c.fillStyle = "rgb(255 210 140 / 0.4)";
    c.fillRect(x - 2.5, fy(x) - h * 0.045, 1.5, h * 0.05);
  }

  // A conical haystack in the distance and two round bales nearer, shadows falling to the right.
  const stack = (x: number, y: number, s: number): void => {
    c.fillStyle = "rgb(80 44 16 / 0.3)";
    c.beginPath();
    c.ellipse(x + s * 0.7, y, s * 1.3, s * 0.18, 0, 0, TAU);
    c.fill();
    c.beginPath();
    c.moveTo(x - s, y);
    c.bezierCurveTo(x - s * 0.95, y - s * 0.9, x - s * 0.3, y - s * 1.55, x, y - s * 1.6);
    c.bezierCurveTo(x + s * 0.3, y - s * 1.55, x + s * 0.95, y - s * 0.9, x + s, y);
    c.closePath();
    const sg = c.createLinearGradient(x - s, 0, x + s, 0);
    sg.addColorStop(0, "#f4cf7a");
    sg.addColorStop(0.5, "#cf9a48");
    sg.addColorStop(1, "#7e5022");
    c.fillStyle = sg;
    c.fill();
    c.strokeStyle = "rgb(110 70 26 / 0.35)";
    c.lineWidth = 1;
    for (let k = 0; k < 14; k++) {
      const u = (k + 0.5) / 14;
      c.beginPath();
      c.moveTo(x - s + u * 2 * s, y);
      c.quadraticCurveTo(x - s * 0.5 + u * s, y - s * 0.9, x + (u - 0.5) * s * 0.3, y - s * 1.5);
      c.stroke();
    }
  };
  stack(w * 0.79, h * 0.765, h * 0.06);

  const bale = (x: number, y: number, r: number): void => {
    const L = r * 1.3;
    c.fillStyle = "rgb(80 44 16 / 0.35)";
    c.beginPath();
    c.ellipse(x + L * 0.8, y + r * 0.95, L * 1.3, r * 0.22, 0, 0, TAU);
    c.fill();
    c.beginPath();
    c.moveTo(x, y - r);
    c.lineTo(x + L, y - r);
    c.ellipse(x + L, y, r * 0.55, r, 0, -Math.PI / 2, Math.PI / 2);
    c.lineTo(x, y + r);
    c.closePath();
    const bg = c.createLinearGradient(0, y - r, 0, y + r);
    bg.addColorStop(0, "#f1c878");
    bg.addColorStop(0.5, "#c8904a");
    bg.addColorStop(1, "#7a4c22");
    c.fillStyle = bg;
    c.fill();
    c.strokeStyle = "rgb(110 70 26 / 0.3)";
    c.lineWidth = 1;
    for (let k = 1; k < 8; k++) {
      c.beginPath();
      c.moveTo(x, y - r + (k / 8) * 2 * r);
      c.lineTo(x + L, y - r + (k / 8) * 2 * r + (hash01(k, Math.round(r)) - 0.5) * 3);
      c.stroke();
    }
    const fgr = c.createRadialGradient(x - r * 0.15, y - r * 0.2, 0, x, y, r);
    fgr.addColorStop(0, "#ffe2a0");
    fgr.addColorStop(1, "#d39e52");
    c.fillStyle = fgr;
    c.beginPath();
    c.ellipse(x, y, r * 0.55, r, 0, 0, TAU);
    c.fill();
    c.strokeStyle = "rgb(140 90 36 / 0.45)";
    c.beginPath();
    for (let a = 0; a < 7 * TAU; a += 0.2) {
      const rr = (a / (7 * TAU)) * r * 0.95;
      const px = x + Math.cos(a) * rr * 0.55;
      const py = y + Math.sin(a) * rr;
      if (a === 0) c.moveTo(px, py);
      else c.lineTo(px, py);
    }
    c.stroke();
  };
  bale(w * 0.47, h * 0.775, h * 0.035);
  bale(w * 0.25, h * 0.85, h * 0.065);

  // A few pumpkins beside the near bale.
  for (const [px, py, pr] of [[0.2, 0.915, 0.022], [0.235, 0.93, 0.016], [0.36, 0.905, 0.014]] as const) {
    const x = px * w;
    const y = py * h;
    const r = pr * h;
    for (const [dx, col] of [[-0.42, "#b8501a"], [0.42, "#b8501a"], [0, "#e07020"]] as const) {
      const pg = c.createRadialGradient(x + dx * r - r * 0.3, y - r * 0.4, 0, x + dx * r, y, r);
      pg.addColorStop(0, "#ffb060");
      pg.addColorStop(0.5, col);
      pg.addColorStop(1, "#6a2a0c");
      c.fillStyle = pg;
      c.beginPath();
      c.ellipse(x + dx * r, y, r * 0.62, r * 0.82, 0, 0, TAU);
      c.fill();
    }
    c.fillStyle = "#4a5a22";
    c.fillRect(x - r * 0.08, y - r * 1.05, r * 0.16, r * 0.3);
  }

  // Big framing trees at both edges.
  for (const [tx, side, salt] of [[w * 0.035, 1, 41], [w * 0.97, -1, 43]] as const) {
    const base = h * 0.78;
    c.strokeStyle = "#2e180e";
    c.lineCap = "round";
    c.lineWidth = h * 0.035;
    c.beginPath();
    c.moveTo(tx, base);
    c.quadraticCurveTo(tx + side * h * 0.02, h * 0.45, tx + side * h * 0.01, h * 0.12);
    c.stroke();
    c.lineWidth = h * 0.012;
    for (const [by, len] of [[0.42, 0.14], [0.3, 0.12], [0.2, 0.1]]) {
      c.beginPath();
      c.moveTo(tx + side * h * 0.015, h * by);
      c.quadraticCurveTo(tx + side * h * len * 0.6, h * (by - 0.06), tx + side * h * len, h * (by - 0.1));
      c.stroke();
    }
    for (let k = 0; k < 9; k++) {
      const cx = tx + side * (hash01(k, salt) * h * 0.22 - h * 0.02);
      const cy = h * (0.02 + 0.32 * hash01(k, salt + 1));
      crown(c, cx, cy, h * (0.06 + 0.04 * hash01(k, salt + 2)), DEEP[k % DEEP.length], salt * 50 + k);
    }
  }

  // Warm vignette.
  const vg = c.createRadialGradient(w * 0.5, h * 0.55, h * 0.3, w * 0.5, h * 0.55, w * 0.75);
  vg.addColorStop(0, "rgb(60 24 10 / 0)");
  vg.addColorStop(1, "rgb(60 24 10 / 0.38)");
  c.fillStyle = vg;
  c.fillRect(0, 0, w, h);
}

/** Every other sunbeam (set `k` of two), fanning down from the low sun. Cache-only. */
function paintBeams(c: CanvasRenderingContext2D, w: number, h: number, k: number): void {
  const sx = w * 0.22;
  const sy = h * 0.36;
  const len = w * 1.1;
  const g = c.createRadialGradient(sx, sy, 0, sx, sy, len);
  g.addColorStop(0, "rgb(255 236 190 / 0)");
  g.addColorStop(0.12, "rgb(255 236 190 / 0.16)");
  g.addColorStop(0.5, "rgb(255 226 170 / 0.07)");
  g.addColorStop(1, "rgb(255 226 170 / 0)");
  c.fillStyle = g;
  for (let i = k; i < 7; i += 2) {
    const a = 0.05 + i * 0.16;
    const half = 0.018 + 0.02 * hash01(i, 21);
    c.beginPath();
    c.moveTo(sx, sy);
    c.lineTo(sx + Math.cos(a - half) * len, sy + Math.sin(a - half) * len);
    c.lineTo(sx + Math.cos(a + half) * len, sy + Math.sin(a + half) * len);
    c.closePath();
    c.fill();
  }
}

let MAPLE: Path2D | null = null;
let OAK: Path2D | null = null;

/** A unit maple leaf: five toothed lobes, the lower two smaller, stem at the bottom. */
function maple(): Path2D {
  if (MAPLE) return MAPLE;
  const p = new Path2D();
  const N = 90;
  for (let i = 0; i <= N; i++) {
    const th = -Math.PI / 2 + (i / N) * TAU;
    const d = th + Math.PI / 2;
    let r = 0.32 + 0.68 * Math.pow(Math.abs(Math.cos(2.5 * d)), 2.2) + 0.07 * Math.abs(Math.sin(12.5 * d));
    r *= 1 - 0.3 * Math.max(0, Math.sin(th));
    const x = Math.cos(th) * r;
    const y = Math.sin(th) * r;
    if (i === 0) p.moveTo(x, y);
    else p.lineTo(x, y);
  }
  p.closePath();
  p.rect(-0.03, 0.2, 0.06, 0.55);
  MAPLE = p;
  return p;
}

/** A unit oak leaf: an elongated blade with rounded wavy lobes, stem at the bottom. */
function oak(): Path2D {
  if (OAK) return OAK;
  const p = new Path2D();
  const N = 40;
  const half = (s: number): number => 0.36 * Math.pow(Math.sin(Math.PI * s), 0.8) * (0.7 + 0.3 * Math.cos(s * TAU * 3.5));
  for (let i = 0; i <= N; i++) {
    const s = i / N;
    const y = 0.9 - s * 1.8;
    if (i === 0) p.moveTo(half(s), y);
    else p.lineTo(half(s), y);
  }
  for (let i = N; i >= 0; i--) {
    const s = i / N;
    p.lineTo(-half(s), 0.9 - s * 1.8);
  }
  p.closePath();
  p.rect(-0.03, 0.85, 0.06, 0.3);
  OAK = p;
  return p;
}

function paintLeaves(f: SceneFrame): void {
  const { ctx, w, h, t } = f;
  const unit = h / 800;
  for (let i = 0; i < 48; i++) {
    const z = i < 18 ? 0.45 : i < 36 ? 0.7 : 1;
    const size = (9 + 9 * hash01(i, 1)) * z * unit;
    const vy = (0.016 + 0.012 * hash01(i, 2)) * z * unit;
    const sway = (0.0006 + 0.0006 * hash01(i, 3));
    const ph = hash01(i, 4) * TAU;
    const amp = (25 + 40 * hash01(i, 5)) * z * unit;
    const y = wrap(hash01(i, 6) * (h + 80) + t * vy, h + 80) - 40;
    const x = wrap(hash01(i, 7) * (w + 80) + t * 0.006 * z * unit + Math.sin(t * sway + ph) * amp, w + 80) - 40;
    const swing = Math.cos(t * sway + ph);
    const rot = hash01(i, 8) * TAU + swing * 0.8 + t * 0.0002 * (hash01(i, 9) - 0.5);
    const flip = Math.cos(t * (0.0012 + 0.0016 * hash01(i, 10)) + ph * 2);
    const [front, back] = LEAF_COLORS[Math.floor(hash01(i, 11) * LEAF_COLORS.length)];
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.scale(size * (0.25 + 0.75 * Math.abs(flip)), size);
    ctx.globalAlpha = z === 0.45 ? 0.7 : 1;
    ctx.fillStyle = flip >= 0 ? front : back;
    ctx.fill(hash01(i, 12) < 0.6 ? maple() : oak());
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}

export const scene: SceneDef = {
  id: "leaves",
  label: "Autumn woods",
  paint(f: SceneFrame): void {
    const { ctx, w, h, t } = f;
    const dpr = frameDpr(f);
    ctx.drawImage(layerCache("leaves:static", w, h, dpr, (c) => paintStatic(c, w, h)), 0, 0, w, h);

    // Sunbeams fanning down from the low sun: two cached sets breathing in counterphase (a radial
    // gradient this large is too costly to rasterise every frame).
    // The beams all lie right of and below the sun, so only that part of each layer is blitted.
    const bx = Math.floor(w * 0.2);
    const by = Math.floor(h * 0.34);
    for (let k = 0; k < 2; k++) {
      ctx.globalAlpha = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * 0.0004 + k * Math.PI));
      const beams = layerCache(`leaves:beams${k}`, w, h, dpr, (c) => paintBeams(c, w, h, k));
      ctx.drawImage(beams, bx * dpr, by * dpr, (w - bx) * dpr, (h - by) * dpr, bx, by, w - bx, h - by);
    }
    ctx.globalAlpha = 1;
    paintLeaves(f);
  },
};
