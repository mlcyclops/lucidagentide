// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/boot_cinematic.ts - P-AVATAR.6 (ADR-0251): the hero opening for the lucid-agent role.
//
// The renderer paints its shell instantly, but the agent session takes ~6-9s to warm (CONFIG_WARM_MS +
// the model warm-poll). For the lucid-agent role that dead air becomes a SHORT cinematic: classic 2D
// glyph rain (canvas, no three.js), the pixel ninja sprinting across the foot of the screen, and staged
// progress lines bound to REAL boot signals - never a fake progress bar. Rules, all tested in the pure
// half: a minimum beat so it never strobes, a HARD CAP so it can never outlive readiness by long, done
// gates on the session actually arriving (voice is reported, never awaited), Esc/Skip always works, and
// prefers-reduced-motion collapses it to a static card. Mounts at most once per app load (caller gates).

import { BLADE_DIAG, BLADE_FLAT, KEYBOARD_LEFT, KEYBOARD_RIGHT, KEYBOARD_WHOLE, MASCOT_PALETTE, keyboardLitKeys, paintFrame, paintRows } from "./mascot.ts";

export interface BootSignals {
  /** The local gate answered (we are running, so this is true the moment the shell paints). */
  settings: boolean;
  /** The agent session reported its config (the real "we are alive" moment). */
  config: boolean;
  /** Model options the session offers (0 until config lands). */
  models: number;
  /** Voice settings loaded (reported only - an unconfigured voice must never hold boot hostage). */
  voice: boolean;
}

export interface BootLine { id: string; label: string; done: boolean }

/** The staged terminal lines. Labels are stable per stage so the list never reflows (invariant #11:
 *  lines are block rows, one string each). */
export function bootLines(s: BootSignals): BootLine[] {
  return [
    { id: "link", label: "Secure channel to the local gate", done: s.settings },
    { id: "session", label: "Waking the agent session", done: s.config },
    { id: "models", label: s.models > 0 ? `Model grid online - ${s.models} routes` : "Charting the model grid", done: s.models > 0 },
    { id: "voice", label: s.voice ? "Voice tuned" : "Tuning the voice", done: s.voice },
  ];
}

export const BOOT_MIN_MS = 2200;
export const BOOT_CAP_MS = 12000;

/** When the cinematic should hand off: the session arrived (config) after the minimum beat, or the hard
 *  cap elapsed - whichever first. Voice/models never gate (they are reported, not awaited). Pure. */
export function bootDone(s: BootSignals, elapsedMs: number): boolean {
  if (elapsedMs >= BOOT_CAP_MS) return true;
  return elapsedMs >= BOOT_MIN_MS && s.config;
}

/** Where the sprinting ninja is at `t` ms: sprints across every few seconds, resting between passes.
 *  Returns the sprite's x in [0,1] stage widths (offscreen < 0 / > 1 while resting) + the gait beat. */
export function bootRunnerX(tMs: number, stageWidthPx: number, spriteWidthPx: number): { x: number; frame: string } {
  const PASS_MS = 2600, REST_MS = 1900;
  const cycle = PASS_MS + REST_MS;
  const tt = Math.max(0, tMs) % cycle;
  const frames = ["runA", "runB", "runC", "runD"] as const;
  const frame = frames[Math.floor(tMs / 95) % 4]!;
  if (tt >= PASS_MS) return { x: -2 * spriteWidthPx, frame }; // resting offscreen
  const k = tt / PASS_MS;
  return { x: -spriteWidthPx + k * (stageWidthPx + 2 * spriteWidthPx), frame };
}

const GLYPHS = "アイウエオカキクケコサシスセソタチツ0123456789<>*+=";

// The finale: he stops, draws the blade, and slices a keyboard clean in half (user call, 2026-08-01 -
// the fist-pump read weird). Pure timeline so the beats are testable.
export const FINALE_MS = 2050;
export interface FinaleBeat {
  frame: string;          // mascot frame id
  split: boolean;         // the keyboard is in two pieces
  kbSep: number;          // halves' separation, 0..1 (of a half-width)
  kbDrop: number;         // halves' fall, 0..1 (of a keyboard height)
  done: boolean;
}
export function bootFinale(tMs: number): FinaleBeat {
  const t = Math.max(0, tMs);
  const frame = t < 380 ? "idleA" : t < 760 ? "draw" : t < 1000 ? "slashUp" : t < 1180 ? "slash" : "slashEnd";
  const split = t >= 1090; // mid-swing - the cut lands inside the slash beat
  const k = split ? Math.min(1, (t - 1090) / 520) : 0;
  return { frame, split, kbSep: k, kbDrop: k * k, done: t >= FINALE_MS };
}

/** Paint one finale moment: ninja + the katana PROP (long blades cannot live in a 20-col character
 *  grid) + the keyboard (whole, or two jagged halves separating and dropping). Shared by the live loop
 *  AND the QA pins, so what is tested visually is exactly what ships. `nx/footY` = ninja top-left. */
export function paintFinaleScene(ctx: CanvasRenderingContext2D, tMs: number, scale: number, nx: number, footY: number): void {
  const f = bootFinale(tMs);
  paintFrame(ctx, f.frame, scale, nx, footY);
  // The blade rides the beat: unsheathe = diagonal over the shoulder, cut = full horizontal extension
  // across the keyboard, follow-through = diagonal down past the hip.
  if (f.frame === "slashUp") paintRows(ctx, BLADE_DIAG, scale, nx + 14 * scale, footY - 1 * scale);
  else if (f.frame === "slash") paintRows(ctx, BLADE_FLAT, scale, nx + 18 * scale, footY + 14 * scale);
  else if (f.frame === "slashEnd") paintRows(ctx, [...BLADE_DIAG].reverse(), scale, nx + 15 * scale, footY + 16 * scale);
  // The keyboard sits on the ground to his right; its bottom aligns with his feet.
  const kbX = nx + 21 * scale;
  const kbY = footY + 18 * scale;
  if (!f.split) {
    paintRows(ctx, KEYBOARD_WHOLE, scale, kbX, kbY);
    // Alive: a few caps glow and hop like typing. The cut kills the lights (keyboardLitKeys returns
    // [] once sliced), which is the whole gag - it types until the very last moment.
    ctx.fillStyle = MASCOT_PALETTE.G!;
    for (const k of keyboardLitKeys(tMs, false)) ctx.fillRect(kbX + k.col * scale, kbY + k.row * scale, scale, scale);
  } else {
    const sep = Math.floor(f.kbSep * 7 * scale);
    const drop = Math.floor(f.kbDrop * 5 * scale);
    paintRows(ctx, KEYBOARD_LEFT, scale, kbX - sep, kbY + Math.floor(drop * 0.6));
    paintRows(ctx, KEYBOARD_RIGHT, scale, kbX + 12 * scale + sep, kbY + drop);
  }
}

export interface BootHandle { dispose(): void }

/** Mount the full-screen cinematic. `reducedMotion` renders the static card variant (no rain, no
 *  sprint). Calls `onDone` exactly once - after the done gate + a short victory beat, or on skip. */
export function mountBootCinematic(getSignals: () => BootSignals, onDone: () => void, reducedMotion: boolean): BootHandle {
  const ov = document.createElement("div");
  ov.id = "bootCine";
  ov.className = "boot-cine";
  ov.innerHTML = `<canvas class="bc-rain" aria-hidden="true"></canvas>
    <div class="bc-panel"><div class="bc-word">LUCID</div><div class="bc-lines" role="status"></div></div>
    <button class="bc-skip" type="button">Skip \u00b7 Esc</button>`;
  document.body.appendChild(ov);
  const cv = ov.querySelector(".bc-rain") as HTMLCanvasElement;
  const linesEl = ov.querySelector(".bc-lines") as HTMLElement;
  const ctx = cv.getContext("2d")!;
  const t0 = performance.now();
  let disposed = false;
  let finishing = false;
  let raf = 0;
  let lineTimer = 0;

  // Classic rain state: one falling head per column, trails via translucent black wash.
  let cols: { y: number; speed: number }[] = [];
  let readyAt = 0; // when the done gate opened - drives the finale clock
  const CELL = 16;
  const resize = (): void => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = Math.floor(innerWidth * dpr); cv.height = Math.floor(innerHeight * dpr);
    const n = Math.ceil(cv.width / (CELL * dpr) / 1.4);
    cols = Array.from({ length: n }, () => ({ y: Math.random() * -40, speed: 0.35 + Math.random() * 0.9 }));
    ctx.font = `${CELL * dpr * 0.9}px monospace`;
  };
  window.addEventListener("resize", resize);
  resize();

  const paintLines = (): void => {
    const lines = bootLines(getSignals());
    linesEl.innerHTML = lines.map((l) =>
      `<div class="bc-line${l.done ? " done" : ""}"><span class="bc-dot">${l.done ? "\u25c9" : "\u25cb"}</span>${l.label}</div>`).join("");
  };

  const finish = (skipped: boolean): void => {
    if (finishing || disposed) return;
    finishing = true;
    ov.classList.add("out");
    window.setTimeout(() => { dispose(); onDone(); }, skipped ? 120 : 450);
  };
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(raf);
    window.clearInterval(lineTimer);
    window.removeEventListener("resize", resize);
    document.removeEventListener("keydown", onKey, true);
    ov.remove();
  };
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); finish(true); }
  };
  document.addEventListener("keydown", onKey, true);
  ov.querySelector(".bc-skip")!.addEventListener("click", () => finish(true));

  if (reducedMotion) {
    // Static card: word + live lines only; done gate still applies, no animation frames at all.
    cv.remove();
    lineTimer = window.setInterval(() => {
      paintLines();
      if (bootDone(getSignals(), performance.now() - t0)) finish(false);
    }, 300);
    paintLines();
    return { dispose };
  }

  const loop = (): void => {
    raf = requestAnimationFrame(loop);
    if (document.hidden || finishing) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const now = performance.now();
    // Trail wash + falling heads.
    ctx.fillStyle = "rgba(5, 8, 10, 0.16)";
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.fillStyle = "#41ff8b";
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i]!;
      c.y += c.speed;
      const gy = Math.floor(c.y) * CELL * dpr * 0.9;
      if (gy > cv.height + 60) { c.y = Math.random() * -30; c.speed = 0.35 + Math.random() * 0.9; }
      ctx.globalAlpha = 0.32 + Math.random() * 0.5;
      ctx.fillText(GLYPHS[(Math.random() * GLYPHS.length) | 0]!, i * CELL * dpr * 1.4, gy);
    }
    ctx.globalAlpha = 1;
    // The ninja sprints the foot of the screen; a victory beat once the session is up.
    const scale = Math.max(3, Math.round((cv.height / 220)));
    const spriteW = 20 * scale;
    const footY = cv.height - 26 * scale - 8;
    if (readyAt) {
      // The finale: stop, draw, slice the keyboard, follow through (shared painter - see QA pins).
      paintFinaleScene(ctx, now - readyAt, scale, Math.floor(cv.width / 2 - spriteW * 1.6), footY);
    } else {
      const r = bootRunnerX(now - t0, cv.width, spriteW);
      if (r.x > -spriteW && r.x < cv.width) paintFrame(ctx, r.frame, scale, Math.floor(r.x), footY);
    }
  };
  loop();
  lineTimer = window.setInterval(() => {
    paintLines();
    const elapsed = performance.now() - t0;
    if (bootDone(getSignals(), elapsed)) {
      // Play the blade finale to the end, then hand off.
      readyAt = performance.now();
      window.setTimeout(() => finish(false), FINALE_MS + 150);
      window.clearInterval(lineTimer);
    }
  }, 250);
  paintLines();
  return { dispose };
}
