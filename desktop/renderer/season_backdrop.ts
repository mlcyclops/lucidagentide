// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/season_backdrop.ts
//
// P-SEASON.1 (ADR-0525): mounts an animated seasonal scene into a host element (the immersive stage,
// the chat column, or the Settings preview). The scenes themselves are stateless painters
// (scene_kit.ts), so this file only owns the canvas, the frame clock and the throttling:
//   * "full"    ~30 fps, the default
//   * "reduced" ~12 fps, for the reduced perf tier (battery, weak CPU)
//   * "still"   one frame, repainted only on resize or a scene change: prefers-reduced-motion and the
//               minimal perf tier. A still is a real frame of the scene, not a blank.
// Nothing paints while the tab is hidden or the host has no size, so a parked stage costs nothing.

import { MASCOT_FRAMES, MASCOT_H, MASCOT_PALETTE, MASCOT_W, mirrorFrame, paintRows } from "./mascot.ts";
import { paintSeasonExtras, seasonActAt, seasonActMs, seasonPalette } from "./mascot_season.ts";
import { SCENES } from "./season_scenes.ts";
import type { SceneId, SeasonId } from "./seasons.ts";

export type BackdropMotion = "full" | "reduced" | "still";

export interface BackdropHandle {
  /** Show `scene` painted for `season` (null scene = clear and idle). */
  set(scene: SceneId | null, season: SeasonId | null): void;
  setMotion(motion: BackdropMotion): void;
  dispose(): void;
}

const FRAME_MS: Record<BackdropMotion, number> = { full: 33, reduced: 83, still: Infinity };
// The moment a still frame is taken from: late enough that every scene's slow elements (a rising sun,
// the first firework, drifting fog) are on screen.
const STILL_T = 14_000;
// The preview tile's mascot plays the season's act, then holds an idle beat before looping.
const ACT_GAP_MS = 900;
// A full-window canvas at 2x DPR is 8M pixels per frame. 1.5 keeps edges crisp on a HiDPI panel at
// about half the fill cost, and these are soft painterly scenes, not text.
const MAX_DPR = 1.5;

/** `mascot` (the Settings preview tile) paints LUCID performing the season's act, bottom-centre, over
 *  the scene: the same frames, costume and props the prompt-bar runner and the splash use. */
export function mountSeasonBackdrop(host: HTMLElement, className = "season-backdrop", mascot = false): BackdropHandle {
  const cv = document.createElement("canvas");
  cv.className = className;
  cv.setAttribute("aria-hidden", "true");
  host.prepend(cv);
  const ctx = cv.getContext("2d", { alpha: false });
  let scene: SceneId | null = null;
  let season: SeasonId | null = null;
  let motion: BackdropMotion = "full";
  let raf = 0;
  let disposed = false;
  let last = -Infinity;
  const t0 = performance.now();
  let w = 0, h = 0, dpr = 1;
  const mirrored: Record<string, readonly string[]> = {};

  function measure(): boolean {
    const cw = host.clientWidth, ch = host.clientHeight;
    const d = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    if (cw === w && ch === h && d === dpr) return false;
    w = cw; h = ch; dpr = d;
    cv.width = Math.max(1, Math.round(w * dpr));
    cv.height = Math.max(1, Math.round(h * dpr));
    return true;
  }
  function paint(t: number): void {
    if (!ctx || !scene || w === 0 || h === 0) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    SCENES[scene].paint({ ctx, w, h, t, season });
    if (mascot && season) paintMascot(ctx, season, t);
  }
  function paintMascot(c: CanvasRenderingContext2D, id: SeasonId, t: number): void {
    // Device pixels and whole-cell scale, like every other mascot surface: no smoothing, no fractions.
    c.setTransform(1, 0, 0, 1, 0, 0);
    const scale = Math.max(1, Math.round(Math.min(2 * dpr, (cv.height * 0.5) / MASCOT_H)));
    const ox = Math.round((cv.width - MASCOT_W * scale) / 2);
    const oy = cv.height - MASCOT_H * scale - Math.round(8 * dpr);
    const actMs = seasonActMs(id);
    const at = t % (actMs + ACT_GAP_MS);
    const act = at < actMs ? seasonActAt(id, at) : null;
    const frame = act && act.frame in MASCOT_FRAMES ? act.frame : "idleA";
    const flip = act?.mirrored ?? false;
    const rows = flip ? (mirrored[frame] ??= mirrorFrame(MASCOT_FRAMES[frame]!)) : MASCOT_FRAMES[frame]!;
    paintRows(c, rows, scale, ox, oy - Math.round((act?.lift ?? 0) * scale), seasonPalette(id, MASCOT_PALETTE));
    paintSeasonExtras(c, id, act, frame, flip, scale, ox, oy);
  }
  function tick(now: number): void {
    raf = 0;
    if (disposed || !scene || document.hidden) return;
    if (now - last >= FRAME_MS[motion]) {
      last = now;
      measure();
      paint(now - t0);
    }
    if (motion !== "still") raf = requestAnimationFrame(tick);
  }
  function restart(): void {
    cancelAnimationFrame(raf);
    raf = 0;
    cv.hidden = !scene;
    if (disposed || !scene) return;
    measure();
    if (motion === "still") paint(STILL_T);
    else { last = -Infinity; raf = requestAnimationFrame(tick); }
  }
  const ro = new ResizeObserver(() => { if (measure() && motion === "still") paint(STILL_T); });
  ro.observe(host);
  const onVis = (): void => { if (!document.hidden) restart(); };
  document.addEventListener("visibilitychange", onVis);
  restart();
  return {
    set(nextScene, nextSeason) {
      if (nextScene === scene && nextSeason === season) return;
      scene = nextScene;
      season = nextSeason;
      restart();
    },
    setMotion(next) {
      if (next === motion) return;
      motion = next;
      restart();
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      cv.remove();
    },
  };
}
