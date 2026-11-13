// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/scenes/pitch.ts
//
// P-SEASON.1 (ADR-0525): a night soccer stadium. A striped, freshly mown pitch in true perspective
// with its full line markings, the goal and net on the right, LED boards rolling color along the far
// touchline, packed stands catching camera flashes, two floodlight towers blooming above the roofline,
// ticker tape drifting down, and every so often a ball curling in a long arc into the net. No
// tournament or federation marks. Uses the arena helpers from stadium.ts.

import { frameDpr, glow, hash01, layerCache, wrap, type SceneDef, type SceneFrame } from "../scene_kit.ts";
import { bloom, camera, camX, camY, flashes, paintBank, paintCrowd, paintFlashSprite, quad, type Cam } from "./stadium.ts";

const TAU = Math.PI * 2;
const TOWERS = [0.1, 0.9];
const HEAD_Y = 0.075;
const TAPE = ["#f5c542", "#ffffff", "#3ccf6e", "#5ab4ff", "#ff6a5a", "#f5c542"];

const pitchCam = (w: number, h: number): Cam => camera(w, h, h * 1.08, h * 0.6, 68, 45, 0.95, 34);

/** Stroke a ground-plane polyline given in field metres. */
function groundLine(c: CanvasRenderingContext2D, cam: Cam, pts: [number, number][], lw: number): void {
  c.beginPath();
  for (const [i, [X, Z]] of pts.entries()) {
    if (i === 0) c.moveTo(camX(cam, X, Z), camY(cam, Z));
    else c.lineTo(camX(cam, X, Z), camY(cam, Z));
  }
  c.lineWidth = lw;
  c.stroke();
}

function arc(cx: number, cz: number, r: number, a0: number, a1: number): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i <= 48; i++) {
    const a = a0 + ((a1 - a0) * i) / 48;
    pts.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r]);
  }
  return pts;
}

function paintStatic(c: CanvasRenderingContext2D, w: number, h: number): void {
  const cam = pitchCam(w, h);
  const sky = c.createLinearGradient(0, 0, 0, h * 0.3);
  sky.addColorStop(0, "#04060e");
  sky.addColorStop(1, "#18203a");
  c.fillStyle = sky;
  c.fillRect(0, 0, w, h);

  // Floodlight towers behind the stands.
  for (const fx of TOWERS) {
    const x = fx * w;
    c.strokeStyle = "#0c0f18";
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(x - w * 0.012, h * 0.24);
    c.lineTo(x - w * 0.004, h * HEAD_Y);
    c.moveTo(x + w * 0.012, h * 0.24);
    c.lineTo(x + w * 0.004, h * HEAD_Y);
    for (let k = 0; k < 9; k++) {
      const y0 = h * 0.24 - (k * h * (0.24 - HEAD_Y)) / 9;
      const y1 = h * 0.24 - ((k + 1) * h * (0.24 - HEAD_Y)) / 9;
      const s0 = w * (0.012 - (0.008 * k) / 9);
      const s1 = w * (0.012 - (0.008 * (k + 1)) / 9);
      c.moveTo(x - s0, y0);
      c.lineTo(x + s1, y1);
      c.moveTo(x + s0, y0);
      c.lineTo(x - s1, y1);
    }
    c.stroke();
    paintBank(c, x, h * HEAD_Y, w * 0.06, h * 0.05, 6, 4);
  }

  // Stands: an upper and a lower tier over the far touchline, a roof edge above.
  const wall = camY(cam, 74);
  c.fillStyle = "#0a0c13";
  c.fillRect(0, h * 0.215, w, h * 0.02);
  paintCrowd(c, w, h * 0.235, h * 0.39, 20, 31, 0.75);
  c.fillStyle = "#0b0d14";
  c.fillRect(0, h * 0.39, w, h * 0.025);
  paintCrowd(c, w, h * 0.415, wall, 22, 37, 0.9);
  const wash = c.createLinearGradient(0, h * 0.215, 0, wall);
  wash.addColorStop(0, "rgb(0 0 0 / 0.35)");
  wash.addColorStop(1, "rgb(255 255 255 / 0.06)");
  c.fillStyle = wash;
  c.fillRect(0, h * 0.215, w, wall - h * 0.215);

  // Surround and the mown stripes, 20 bands across the length.
  quad(c, cam, -70, -6, 120, 74, "#1d4a2a");
  for (let k = 0; k < 20; k++) {
    const X0 = -52.5 + k * 5.25;
    quad(c, cam, X0, 0, X0 + 5.25, 68, k % 2 === 0 ? "#2f8040" : "#287236");
  }
  // Markings.
  const white = "rgb(246 248 244 / 0.9)";
  const lw = 0.12;
  for (const [X0, Z0, X1, Z1] of [
    [-52.5, -lw, 52.5, lw], [-52.5, 68 - lw, 52.5, 68 + lw], [52.5 - lw, 0, 52.5 + lw, 68], [-lw, 0, lw, 68],
    [36 - lw, 13.84, 36 + lw, 54.16], [36, 13.84 - lw, 52.5, 13.84 + lw], [36, 54.16 - lw, 52.5, 54.16 + lw],
    [47 - lw, 24.84, 47 + lw, 43.16], [47, 24.84 - lw, 52.5, 24.84 + lw], [47, 43.16 - lw, 52.5, 43.16 + lw],
  ] as const) quad(c, cam, X0, Z0, X1, Z1, white);
  c.strokeStyle = white;
  const scale = (Z: number): number => (cam.F * 0.24) / (cam.D + Z);
  groundLine(c, cam, arc(0, 34, 9.15, 0, TAU), scale(34));
  const dA = Math.acos(5.5 / 9.15);
  groundLine(c, cam, arc(41.5, 34, 9.15, Math.PI - dA, Math.PI + dA), scale(34));
  groundLine(c, cam, arc(52.5, 0, 1, Math.PI / 2, Math.PI), scale(0));
  groundLine(c, cam, arc(52.5, 68, 1, Math.PI, Math.PI * 1.5), scale(68));
  for (const [X, Z] of [[0, 34], [41.5, 34]]) {
    c.fillStyle = white;
    c.beginPath();
    c.ellipse(camX(cam, X, Z), camY(cam, Z), scale(Z) * 1.2, scale(Z) * 0.5, 0, 0, TAU);
    c.fill();
  }

  // Floodlit sheen and grain over the grass.
  const pool = c.createRadialGradient(w * 0.55, h * 0.74, h * 0.05, w * 0.55, h * 0.74, w * 0.6);
  pool.addColorStop(0, "rgb(230 250 220 / 0.14)");
  pool.addColorStop(1, "rgb(0 10 6 / 0.35)");
  c.fillStyle = pool;
  c.fillRect(0, wall, w, h - wall);
  for (let i = 0; i < 1800; i++) {
    const y = wall + Math.pow(hash01(i, 5), 0.9) * (h - wall);
    c.fillStyle = hash01(i, 6) < 0.5 ? "rgb(255 255 255 / 0.05)" : "rgb(0 0 0 / 0.08)";
    c.fillRect(hash01(i, 7) * w, y, 1 + (y / h) * 1.5, 1);
  }

  // The goal: posts and bar, with the net hanging back to a frame two metres deep.
  const P = (X: number, Z: number, Y: number): [number, number] => [camX(cam, X, Z), camY(cam, Z, Y)];
  const z0 = 34 - 3.66;
  const z1 = 34 + 3.66;
  c.strokeStyle = "rgb(235 240 250 / 0.32)";
  c.lineWidth = 0.8;
  c.beginPath();
  for (let k = 0; k <= 24; k++) {
    const Z = z0 + ((z1 - z0) * k) / 24;
    c.moveTo(...P(52.5, Z, 2.44));
    c.lineTo(...P(54.5, Z, 2.0));
    c.lineTo(...P(54.5, Z, 0));
  }
  for (let k = 0; k <= 8; k++) {
    const Y = (2.0 * k) / 8;
    c.moveTo(...P(54.5, z0, Y));
    c.lineTo(...P(54.5, z1, Y));
  }
  for (let k = 0; k <= 6; k++) {
    const X = 52.5 + (2 * k) / 6;
    const Y = 2.44 - (0.44 * k) / 6;
    c.moveTo(...P(X, z0, Y));
    c.lineTo(...P(X, z1, Y));
    for (const Z of [z0, z1]) {
      c.moveTo(...P(X, Z, Y));
      c.lineTo(...P(X, Z, 0));
    }
  }
  c.stroke();
  c.strokeStyle = "#f6f8fb";
  c.lineCap = "round";
  c.lineWidth = Math.max(2.5, (cam.F * 0.12) / (cam.D + 34));
  c.beginPath();
  c.moveTo(...P(52.5, z0, 0));
  c.lineTo(...P(52.5, z0, 2.44));
  c.lineTo(...P(52.5, z1, 2.44));
  c.lineTo(...P(52.5, z1, 0));
  c.stroke();
  // Corner flags.
  for (const Z of [0, 68]) {
    const [fx, fy] = P(52.5, Z, 0);
    const [, ty] = P(52.5, Z, 1.5);
    c.strokeStyle = "#e8e8e8";
    c.lineWidth = 1.5;
    c.beginPath();
    c.moveTo(fx, fy);
    c.lineTo(fx, ty);
    c.stroke();
    c.fillStyle = "#f5c542";
    c.beginPath();
    c.moveTo(fx, ty);
    c.lineTo(fx - (fy - ty) * 0.35, ty + (fy - ty) * 0.12);
    c.lineTo(fx, ty + (fy - ty) * 0.25);
    c.closePath();
    c.fill();
  }
}

/** A classic ball: shaded white sphere with dark patches turning about its center. */
function ball(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, spin: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, TAU);
  const g = ctx.createRadialGradient(-r * 0.35, -r * 0.4, 0, 0, 0, r);
  g.addColorStop(0, "#ffffff");
  g.addColorStop(0.7, "#dfe3ea");
  g.addColorStop(1, "#8d95a6");
  ctx.fillStyle = g;
  ctx.fill();
  ctx.clip();
  ctx.rotate(spin);
  ctx.fillStyle = "#1c1f28";
  const patch = (px: number, py: number, s: number): void => {
    ctx.beginPath();
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * TAU - Math.PI / 2;
      if (k === 0) ctx.moveTo(px + Math.cos(a) * s, py + Math.sin(a) * s);
      else ctx.lineTo(px + Math.cos(a) * s, py + Math.sin(a) * s);
    }
    ctx.closePath();
    ctx.fill();
  };
  patch(0, 0, r * 0.32);
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * TAU + Math.PI / 2;
    patch(Math.cos(a) * r * 0.92, Math.sin(a) * r * 0.92, r * 0.28);
  }
  ctx.restore();
}

export const scene: SceneDef = {
  id: "pitch",
  label: "Floodlit pitch",
  paint(f: SceneFrame): void {
    const { ctx, w, h, t } = f;
    const dpr = frameDpr(f);
    const cam = pitchCam(w, h);
    ctx.drawImage(layerCache("pitch:static", w, h, dpr, (c) => paintStatic(c, w, h)), 0, 0, w, h);

    // LED boards along the far touchline, color slowly rolling along them.
    const top = camY(cam, 71, 0.9);
    const bot = camY(cam, 71);
    // Three repeats of a half-width color cycle, slid left by `roll`, always cover the frame.
    const roll = wrap(t * 0.03, w * 0.5);
    const led = ctx.createLinearGradient(-roll, 0, w * 1.5 - roll, 0);
    const cycle = ["#1460d8", "#18b46a", "#e8a830"];
    for (let k = 0; k <= 9; k++) led.addColorStop(k / 9, cycle[k % 3]);
    ctx.fillStyle = "#07090f";
    ctx.fillRect(0, top - 2, w, bot - top + 3);
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = led;
    ctx.fillRect(0, top, w, bot - top);
    ctx.globalAlpha = 1;
    glow(ctx, w * 0.5, (top + bot) / 2, w * 0.5, "120 170 255", 0.05);

    const flash = layerCache("arena:flash", 32, 32, dpr, paintFlashSprite);
    flashes(ctx, t, 30, 0, w, h * 0.24, top - h * 0.01, flash, 7);
    for (const [i, fx] of TOWERS.entries()) bloom(ctx, fx * w, h * HEAD_Y, h * 0.07, t, i * 3.3);

    // A ball curls from midfield into the net every 15 s.
    const P = 15000;
    const age = wrap(t, P);
    const FLY = 2800;
    if (age < FLY + 600) {
      const u = Math.min(1, age / FLY);
      const X = 18 + (53.3 - 18) * u;
      const Z = 20 + (36 - 20) * u + Math.sin(Math.PI * u) * 4;
      const Y = Math.sin(Math.PI * Math.min(1, u * 1.08)) * 5.5 + 1.2 * u;
      const fade = Math.min(1, age / 200, (FLY + 600 - age) / 400);
      const r = Math.max(5, (cam.F * 0.55) / (cam.D + Z));
      ctx.globalAlpha = 0.3 * fade * Math.max(0.2, 1 - Y / 12);
      ctx.fillStyle = "#000";
      ctx.beginPath();
      ctx.ellipse(camX(cam, X, Z), camY(cam, Z), r * 1.1, r * 0.35, 0, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = fade;
      ball(ctx, camX(cam, X, Z), camY(cam, Z, Y + 0.55), r, t * 0.012);
      ctx.globalAlpha = 1;
    }

    // Ticker tape drifting down, each strip fluttering as it turns.
    for (let i = 0; i < 70; i++) {
      const z = 0.5 + 0.5 * hash01(i, 41);
      const y = wrap(hash01(i, 42) * (h + 40) + t * (0.018 + 0.016 * hash01(i, 43)) * z, h + 40) - 20;
      const x = wrap(hash01(i, 44) * w + t * 0.004 + Math.sin(t * 0.0008 + i) * 30 * z, w);
      const L = (8 + 8 * hash01(i, 45)) * z * (h / 800);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(hash01(i, 46) * TAU + t * 0.0011 * (hash01(i, 47) - 0.5) * 2);
      ctx.scale(Math.cos(t * (0.003 + 0.003 * hash01(i, 48)) + i), 1);
      ctx.globalAlpha = 0.55 + 0.4 * z;
      ctx.fillStyle = TAPE[i % TAPE.length];
      ctx.fillRect(-1.4 * z, -L / 2, 2.8 * z, L);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  },
};
