// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/mascot_mini.ts - P-MINI.1 (ADR-0580): mini Lucid, seated.
//
// The scene composition comes from LUCID Tradepass's ui/js/mascot-mini.js (TP-010, same owner and license),
// which was itself drawn from this repo's mascot.ts frames. It is ported here to TypeScript so both products
// share one figure: the frames stay in mascot.ts and only the seated poses live in this file.
//
//   idle    : seated cross-legged (`meditate`), breathing; every 6 to 12 s he looks up for about a second
//   working : seated, eyes open, typing on a small keyboard on his lap (lit keys from keyboardLitKeys),
//             hands alternating
//   done    : a short `victory` beat, then idle
//   error   : a brief `blink`, then idle
//
// `sceneRows` is pure: the same state and time always give the same rows, so it is unit-tested and the
// prompt-bar runner (mascot_runner.ts) can paint the typing scene from it with no DOM of its own.
// `mountMiniMascot` is the small standalone canvas the Ask Lucid panel header uses: pixel-crisp (whole
// device pixels per cell), about 24 fps, paused while hidden or in a background tab, and one still frame
// per state under prefers-reduced-motion.

import { KEYBOARD_WHOLE, MASCOT_FRAMES, MASCOT_H, MASCOT_PALETTE, MASCOT_W, VICTORY_MS, keyboardLitKeys, paintRows } from "./mascot.ts";

export const SCENE_W = MASCOT_W + 4;
export const SCENE_H = MASCOT_H + 2;
export const MINI_STATES = ["idle", "working", "done", "error"] as const;
export type MiniState = (typeof MINI_STATES)[number];

const FIG_X = 2;
/** The seated figure ends at frame row 43; dropping it 10 rows rests the keyboard on the scene floor. */
const SEAT_Y = 10;
const STAND_Y = 2;
const KB_X = 6;
const KB_Y = 36;
/** Frame rows 0..27 are the head and hood (identical in idleA and meditate apart from the eyes). */
const HEAD_ROWS = 28;
const EYE_LEFTS = [7, 22] as const;
const EYE_TOP = 14;
const FPS = 24;
const BREATH_MS = 3200;
const LOOK_MS = 1000;
const ERROR_MS = 900;
/** One typing frame lasts this long; the runner uses it to repaint only when the scene changes. */
export const TYPING_BEAT_MS = 75;

type Grid = string[][];
type Point = readonly [number, number];

function frame(id: string): readonly string[] {
  const f = MASCOT_FRAMES[id] ?? MASCOT_FRAMES.idleA;
  if (!f) throw new Error(`mascot frame "${id}" is missing`);
  return f;
}

/** Seated pose: closed eyes (meditate), or open eyes (the idleA head on the meditate body), optionally
 *  gazing up. */
export function seatedRows(opts: { open?: boolean; lookUp?: boolean } = {}): string[] {
  const open = opts.open === true;
  const lookUp = opts.lookUp === true;
  const body = frame("meditate");
  const head = frame("idleA");
  const rows = body.map((r, y) => (open && y < HEAD_ROWS ? head[y]! : r));
  if (!open || !lookUp) return rows;
  const grid = rows.map((r) => [...r]);
  for (const left of EYE_LEFTS) {
    for (let y = EYE_TOP; y < EYE_TOP + 6; y++) for (let x = left; x < left + 9; x++) if (grid[y]?.[x] === "B") grid[y]![x] = "W";
    for (let y = EYE_TOP + 2; y <= EYE_TOP + 3; y++) for (let x = left + 4; x <= left + 5; x++) if (grid[y]?.[x] === "W") grid[y]![x] = "B";
  }
  return grid.map((r) => r.join(""));
}

function blank(): Grid {
  return Array.from({ length: SCENE_H }, () => Array<string>(SCENE_W).fill("."));
}

function stamp(grid: Grid, rows: readonly string[], ox: number, oy: number, shiftHead = 0): void {
  for (let y = 0; y < rows.length; y++) {
    const ty = oy + y + (y < HEAD_ROWS ? shiftHead : 0);
    if (ty < 0 || ty >= SCENE_H) continue;
    const row = rows[y]!;
    for (let x = 0; x < row.length; x++) {
      const c = row[x]!;
      const tx = ox + x;
      if (c !== "." && tx >= 0 && tx < SCENE_W) grid[ty]![tx] = c;
    }
  }
}

function set(grid: Grid, x: number, y: number, c: string): void {
  if (y >= 0 && y < SCENE_H && x >= 0 && x < SCENE_W) grid[y]![x] = c;
}

export interface LimbCell { x: number; y: number; edge: number; below: number }

/** Cells of a tapered capsule from a to b: radius rA at a, rB at b, plus `bulge` at the middle (a muscle
 *  belly). Each cell carries its signed distance below the bone, so the caller can shade the underside. */
export function limbCells(a: Point, b: Point, rA: number, rB: number, bulge = 0): LimbCell[] {
  const out = new Map<string, LimbCell>();
  const [ax, ay] = a;
  const [bx, by] = b;
  const len = Math.hypot(bx - ax, by - ay) || 1;
  const steps = Math.ceil(len * 3);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const cx = ax + (bx - ax) * t;
    const cy = ay + (by - ay) * t;
    const r = rA + (rB - rA) * t + bulge * Math.sin(Math.PI * t);
    for (let y = Math.floor(cy - r - 1); y <= Math.ceil(cy + r + 1); y++)
      for (let x = Math.floor(cx - r - 1); x <= Math.ceil(cx + r + 1); x++) {
        const d = Math.hypot(x - cx, y - cy);
        const k = `${x},${y}`;
        const prev = out.get(k);
        const edge = d - r;
        if (!prev || edge < prev.edge) out.set(k, { x, y, edge, below: (y - cy) / Math.max(r, 0.5) });
      }
  }
  return [...out.values()];
}

/** One working arm: an outline pass for every part first (so shoulder, sleeve, forearm and fist read as one
 *  limb), then fills. A short gi sleeve over a broad shoulder, a bare bicep, a forearm that tapers to the
 *  wrist, and a three-cell fist on the key. Shading on the underside carries the mass. */
function arm(grid: Grid, shoulder: Point, elbow: Point, fist: Point): void {
  const sleeveEnd: Point = [shoulder[0] + (elbow[0] - shoulder[0]) * 0.35, shoulder[1] + (elbow[1] - shoulder[1]) * 0.35];
  const parts = [
    { cells: limbCells(shoulder, sleeveEnd, 2.9, 2.7, 0.2), fill: "K", shade: "D", hi: "L" },
    { cells: limbCells(sleeveEnd, elbow, 2.5, 2.0, 0.9), fill: "S", shade: "s", hi: "W" },
    { cells: limbCells(elbow, fist, 2.2, 1.5, 0.5), fill: "S", shade: "s", hi: "W" },
  ];
  for (const p of parts) for (const c of p.cells) if (c.edge <= 1 && c.edge > 0) set(grid, c.x, c.y, "k");
  for (const p of parts)
    for (const c of p.cells) {
      if (c.edge > 0) continue;
      const top = c.below < -0.55 && c.edge > -0.9;
      set(grid, c.x, c.y, c.below > 0.35 ? p.shade : top && p.hi === "W" ? "S" : p.fill);
    }
  // A thin highlight along the top of the bicep only (a forearm highlight reads as noise at this size).
  for (const c of parts[1]!.cells) if (c.edge <= 0 && c.edge > -0.7 && c.below < -0.6) set(grid, c.x, c.y, "W");
  const fx = Math.round(fist[0]);
  const fy = Math.round(fist[1]);
  for (let y = fy - 2; y <= fy + 1; y++) for (let x = fx - 2; x <= fx + 2; x++) set(grid, x, y, "k");
  for (let y = fy - 1; y <= fy; y++) for (let x = fx - 1; x <= fx + 1; x++) set(grid, x, y, "S");
  set(grid, fx - 1, fy, "s");
  set(grid, fx + 1, fy, "s");
}

const DONE_BEATS: readonly (readonly [string, number])[] = [["victoryA", 200], ["victoryB", 340], ["victoryA", 150], ["victoryC", 310]];

/** PURE: scene rows (SCENE_W x SCENE_H) for a state at time t (ms since the state began). `lookUp` and
 *  `breathe` apply to idle; t drives the typing and the victory and blink beats. */
export function sceneRows(state: MiniState, t = 0, opts: { lookUp?: boolean; breathe?: boolean } = {}): string[] {
  const grid = blank();
  const time = Math.max(0, Number(t) || 0);
  if (state === "done") {
    const cycle = DONE_BEATS.reduce((n, b) => n + b[1], 0);
    let at = time % cycle;
    let id = "victoryC";
    for (const [f, ms] of DONE_BEATS) {
      if (at < ms) { id = f; break; }
      at -= ms;
    }
    stamp(grid, frame(id), FIG_X, STAND_Y);
  } else if (state === "error") {
    const id = time < 140 || (time >= 300 && time < 440) ? "blink" : "idleA";
    stamp(grid, frame(id), FIG_X, STAND_Y);
  } else if (state === "working") {
    stamp(grid, seatedRows({ open: true }), FIG_X, SEAT_Y);
    // The meditate arms rest on the knees outside the torso; clear them so the working arms are the only arms.
    for (let y = SEAT_Y + 25; y < SEAT_Y + 31; y++)
      for (let x = 0; x < SCENE_W; x++) if (x < FIG_X + 6 || x > FIG_X + 31) grid[y]![x] = ".";
    const kx = FIG_X + KB_X;
    const ky = SEAT_Y + KB_Y;
    stamp(grid, KEYBOARD_WHOLE, kx, ky);
    const lit = keyboardLitKeys(time, false);
    for (const k of lit) if (grid[ky + k.row]?.[kx + k.col] === "M") grid[ky + k.row]![kx + k.col] = "G";
    const leftKey = lit.find((k) => k.col < 12) ?? { col: 6, row: 4 };
    const rightKey = lit.find((k) => k.col >= 12) ?? { col: 16, row: 4 };
    // Hands alternate: the striking fist drops onto its key, the other lifts two rows.
    const leftDown = Math.floor(time / 150) % 2 === 0;
    const lift = (down: boolean): number => (down ? 0 : 2);
    // Broad shoulders at the top corners of the torso, elbows flared out and down, fists on the keys.
    arm(grid, [FIG_X + 3, SEAT_Y + 22], [FIG_X + 1, SEAT_Y + 30], [kx + leftKey.col, ky + leftKey.row - lift(leftDown)]);
    arm(grid, [FIG_X + 31, SEAT_Y + 22], [FIG_X + 34, SEAT_Y + 30], [kx + rightKey.col, ky + rightKey.row - lift(!leftDown)]);
  } else {
    const lookUp = opts.lookUp === true;
    stamp(grid, seatedRows({ open: lookUp, lookUp }), FIG_X, SEAT_Y, opts.breathe ? 1 : 0);
  }
  return grid.map((r) => r.join(""));
}

/** PURE: the typing scene for a turn that has been running `elapsedMs`. One entry per TYPING_BEAT_MS, so a
 *  caller painting at 60 fps rebuilds the scene 13 times a second, not 60. */
const typingCache = new Map<number, string[]>();
export function typingRows(elapsedMs: number): string[] {
  // The typing pattern repeats every 6 s (keyboardLitKeys cycles 10 keys over 150 ms steps, hands every 300 ms).
  const beat = Math.floor(Math.max(0, elapsedMs) / TYPING_BEAT_MS) % Math.round(6000 / TYPING_BEAT_MS);
  let rows = typingCache.get(beat);
  if (!rows) {
    rows = sceneRows("working", beat * TYPING_BEAT_MS);
    typingCache.set(beat, rows);
  }
  return rows;
}

function reducedMotion(): boolean {
  try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; }
}

export interface MiniMascotHandle { setState(state: MiniState): void; setActive(on: boolean): void; destroy(): void }

/** Append a pixel canvas to `host` showing mini Lucid seated. `sm` is one CSS pixel per cell (44 x 54),
 *  `md` one and a half. */
export function mountMiniMascot(host: HTMLElement, opts: { size?: "sm" | "md" } = {}): MiniMascotHandle {
  const size = opts.size === "sm" ? "sm" : "md";
  host.classList.add("mini-mascot", `mini-${size}`);
  const cv = document.createElement("canvas");
  cv.setAttribute("aria-hidden", "true");
  cv.className = "mini-cv";
  host.appendChild(cv);
  const ctx = cv.getContext("2d");
  const cellCss = size === "sm" ? 1 : 1.5;
  let state: MiniState = "idle";
  let since = performance.now();
  let active = true;
  let visible = true;
  let raf = 0;
  let last = 0;
  let lastKey = "";
  let nextLook = since + 6000 + Math.random() * 6000;
  let lookUntil = 0;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let dpr = 0;

  const fit = (): number => {
    const d = Math.min(Math.max(window.devicePixelRatio || 1, 1), 3);
    if (d === dpr) return Math.max(1, Math.round(cellCss * dpr));
    dpr = d;
    const cell = Math.max(1, Math.round(cellCss * d));
    cv.width = SCENE_W * cell;
    cv.height = SCENE_H * cell;
    cv.style.width = `${cv.width / d}px`;
    cv.style.height = `${cv.height / d}px`;
    lastKey = "";
    return cell;
  };

  /** Soft brand-green halo behind the figure; its strength carries the breathing. */
  const glow = (strength: number): void => {
    if (!ctx) return;
    const w = cv.width;
    const hgt = cv.height;
    const g = ctx.createRadialGradient(w / 2, hgt * 0.62, 2, w / 2, hgt * 0.62, Math.max(w, hgt) * 0.55);
    g.addColorStop(0, `rgba(65, 255, 139, ${strength.toFixed(3)})`);
    g.addColorStop(1, "rgba(65, 255, 139, 0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, hgt);
  };

  const paint = (now: number, still: boolean): void => {
    if (!ctx) return;
    const cell = fit();
    const t = now - since;
    let rows: string[] | undefined;
    let strength: number;
    let key: string;
    if (state === "idle") {
      if (!still && now >= nextLook && !lookUntil) lookUntil = now + LOOK_MS;
      if (lookUntil && now >= lookUntil) { lookUntil = 0; nextLook = now + 6000 + Math.random() * 6000; }
      const phase = still ? 0 : (now % BREATH_MS) / BREATH_MS;
      const breathe = phase >= 0.5;
      const lookUp = lookUntil > 0;
      strength = 0.14 + 0.12 * (0.5 - 0.5 * Math.cos(phase * 2 * Math.PI));
      key = `i${breathe ? 1 : 0}${lookUp ? 1 : 0}${strength.toFixed(2)}`;
      if (key !== lastKey) rows = sceneRows("idle", t, { breathe, lookUp });
    } else if (state === "working") {
      const beat = still ? 0 : Math.floor(t / TYPING_BEAT_MS);
      strength = 0.22 + (still ? 0 : 0.1 * (0.5 - 0.5 * Math.cos((t / 900) * 2 * Math.PI)));
      key = `w${beat}${strength.toFixed(2)}`;
      if (key !== lastKey) rows = still ? sceneRows("working", 0) : typingRows(t);
    } else {
      const beat = still ? 0 : Math.floor(t / 40);
      strength = state === "done" ? 0.34 : 0.12;
      key = `${state}${beat}`;
      if (key !== lastKey) rows = sceneRows(state, still ? (state === "done" ? 900 : 0) : t);
    }
    if (!rows) return;
    lastKey = key;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, cv.width, cv.height);
    glow(strength);
    paintRows(ctx, rows, cell, 0, 0, MASCOT_PALETTE);
  };

  const running = (): boolean => active && visible && !document.hidden && host.isConnected;

  const loop = (now: number): void => {
    raf = 0;
    if (!running()) return;
    if (now - last >= 1000 / FPS) { last = now; paint(now, false); }
    raf = requestAnimationFrame(loop);
  };

  const kick = (): void => {
    if (reducedMotion()) { lastKey = ""; paint(performance.now(), true); return; }
    if (!raf && running()) raf = requestAnimationFrame(loop);
  };

  const onVis = (): void => kick();
  document.addEventListener("visibilitychange", onVis);
  let io: IntersectionObserver | null = null;
  if (typeof IntersectionObserver === "function") {
    io = new IntersectionObserver((list) => { visible = list.some((e) => e.isIntersecting); kick(); });
    io.observe(host);
  }
  paint(performance.now(), true);
  kick();

  return {
    setState(next) {
      const s: MiniState = (MINI_STATES as readonly string[]).includes(next) ? next : "idle";
      clearTimeout(settleTimer);
      if (s === state && s !== "done" && s !== "error") return;
      state = s;
      since = performance.now();
      lastKey = "";
      if (s === "idle") nextLook = since + 6000 + Math.random() * 6000;
      if (s === "done" || s === "error") {
        settleTimer = setTimeout(() => {
          state = "idle";
          since = performance.now();
          nextLook = since + 6000 + Math.random() * 6000;
          lastKey = "";
          kick();
        }, s === "done" ? VICTORY_MS : ERROR_MS);
      }
      kick();
    },
    setActive(on) { active = on; kick(); },
    destroy() {
      active = false;
      clearTimeout(settleTimer);
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      io?.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      cv.remove();
    },
  };
}
