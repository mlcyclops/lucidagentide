// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/orbit_canvas.ts - P-ORBIT-CANVAS.1 (ADR-0522): the Fleet Orbit's spokes and rings on ONE
// Canvas 2D layer, drawn the way the Knowledge Orbit (graph_orbit.ts, ADR-0470) draws its graph: retained
// scene state, a devicePixelRatio-aware canvas sized by a ResizeObserver, theme colors read from the CSS
// custom properties, and a frame loop that runs only while something on it moves and parks otherwise.
//
// It replaces the SVG layer whose dash-flow, ring-drift and pulse animations were CSS keyframes on SVG
// elements: none of those run on the compositor, so every animated spoke cost a style recalc plus a paint
// of the whole SVG layer on the main thread, 60 times a second, for as long as the map was open. Here a
// frame is a dozen strokes from typed state, flowing spokes run at display rate, a map whose only motion is
// the 60 s ring drift ticks a few times a second, and a still map (Lite, reduced motion, or nothing
// working) draws once per change.
//
// The cards, hub and nebula stay DOM: they carry buttons, focus, tooltips and text that a canvas cannot.

import type { LaneStatus } from "./bridge.ts";
import type { OrbitMode } from "./orbit_layout.ts";
import type { RemoteTone } from "./remote_spokes_model.ts";

/** What a line shows: a local lane's status (or P-STUCK-SHOW.1's likely-stuck), or a remote spoke's tone. */
export type SpokeStatus = LaneStatus | "likely-stuck" | `remote-${RemoteTone}`;
/** One spoke: the card's offset from the stage center (orbitSlots' x, y) and what its line shows. */
export interface OrbitSpoke { x: number; y: number; status: SpokeStatus; promoted: boolean }
/** One decorative ring: ellipse radii around the stage center. */
export interface OrbitRing { rx: number; ry: number }
export interface OrbitScene { spokes: readonly OrbitSpoke[]; rings: readonly OrbitRing[] }

export interface OrbitCanvasHandle {
  setScene(scene: OrbitScene): void;
  setMode(mode: OrbitMode): void;
  /** Off while the map is hidden: the loop parks and nothing draws until it is shown again. */
  setVisible(on: boolean): void;
  destroy(): void;
}

/** How a status line moves: a dash that flows outward (px per second), an opacity pulse, or nothing. */
type Motion = { kind: "flow"; pxPerSec: number } | { kind: "pulse"; periodMs: number; lo: number } | { kind: "none" };
type Paint = "lineStrong" | "line" | "cyan" | "amber" | "red" | "green" | "blue";
export interface SpokeStyle { paint: Paint; alpha: number; width: number; dash: readonly number[]; motion: Motion }

const STILL: Motion = { kind: "none" };
const REMOTE_DASH = [3, 6] as const;
// The fleet grid's state language, identical to the retired .orbit-line[data-status] and .orbit-line.remote.rs-* rules.
const STYLE: Record<SpokeStatus, SpokeStyle> = {
  starting: { paint: "lineStrong", alpha: 0.6, width: 1.5, dash: [2, 6], motion: { kind: "flow", pxPerSec: 16 / 1.4 } },
  working: { paint: "cyan", alpha: 0.75, width: 2, dash: [7, 9], motion: { kind: "flow", pxPerSec: 16 / 0.9 } },
  "awaiting-input": { paint: "blue", alpha: 1, width: 1.5, dash: [], motion: { kind: "pulse", periodMs: 2600, lo: 0.55 } },
  "likely-stuck": { paint: "red", alpha: 1, width: 2, dash: [], motion: { kind: "pulse", periodMs: 2600, lo: 0.55 } },
  "needs-approval": { paint: "red", alpha: 1, width: 2.5, dash: [], motion: { kind: "pulse", periodMs: 1600, lo: 0.6 } },
  done: { paint: "green", alpha: 0.6, width: 1.5, dash: [], motion: STILL },
  error: { paint: "red", alpha: 0.55, width: 1.5, dash: [4, 5], motion: STILL },
  stopped: { paint: "line", alpha: 0.5, width: 1.5, dash: [], motion: STILL },
  // Remote spokes (P-IDE-SPOKES.1): always dashed, so a remote line never reads as a local one, Lite included.
  "remote-approval": { paint: "red", alpha: 1, width: 2.5, dash: REMOTE_DASH, motion: { kind: "pulse", periodMs: 1600, lo: 0.6 } },
  "remote-stuck": { paint: "red", alpha: 0.6, width: 1.5, dash: REMOTE_DASH, motion: STILL },
  "remote-maybe": { paint: "amber", alpha: 0.7, width: 1.5, dash: REMOTE_DASH, motion: STILL },
  "remote-busy": { paint: "cyan", alpha: 0.75, width: 2, dash: REMOTE_DASH, motion: STILL },
  "remote-ready": { paint: "blue", alpha: 0.7, width: 1.5, dash: REMOTE_DASH, motion: STILL },
  "remote-checking": { paint: "lineStrong", alpha: 1, width: 1.5, dash: REMOTE_DASH, motion: STILL },
  "remote-off": { paint: "line", alpha: 1, width: 1.5, dash: REMOTE_DASH, motion: STILL },
};
const RING_DASH = [3, 9] as const;
const RING_PX_PER_SEC = 4; // 240 px of dash offset per 60 s, the retired orbitRingDrift
/** The ring drift moves 4 px a second; a frame every quarter second keeps it smooth without a display-rate loop. */
export const RING_TICK_MS = 250;
/** Flowing dashes and pulses: FLOW_TICK_MS between frames. */
export const FLOW_TICK_MS = 50;

/** The line a spoke draws in this mode. Lite drops every motion and every dash except `starting`'s (its only
 *  cue that differs from a stopped spoke) and the remote dash; motion mode under reduced motion keeps dashes, still. */
export function spokeStyle(status: SpokeStatus, mode: OrbitMode, reducedMotion: boolean): SpokeStyle {
  const s = STYLE[status];
  if (mode === "static") return { ...s, dash: status === "starting" || status.startsWith("remote-") ? s.dash : [], motion: STILL };
  if (reducedMotion) return { ...s, motion: STILL };
  return s;
}

/** Milliseconds until the next frame: FLOW_TICK_MS while a spoke flows or pulses, RING_TICK_MS while only the
 *  rings drift, null (parked) while nothing moves. This is the whole resource contract of the layer. */
export function frameDelay(scene: OrbitScene, mode: OrbitMode, reducedMotion: boolean): number | null {
  if (mode === "static" || reducedMotion) return null;
  if (scene.spokes.some((s) => STYLE[s.status].motion.kind !== "none")) return FLOW_TICK_MS;
  return scene.rings.length ? RING_TICK_MS : null;
}

export function mountOrbitCanvas(stage: HTMLElement, initialMode: OrbitMode): OrbitCanvasHandle {
  const cv = document.createElement("canvas");
  cv.className = "orbit-cv";
  cv.setAttribute("aria-hidden", "true");
  stage.prepend(cv); // under the hub (z 2) and the cards (z 3)
  const ctx = cv.getContext("2d");
  const mq = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
  let reduced = !!mq?.matches;
  let mode = initialMode;
  let scene: OrbitScene = { spokes: [], rings: [] };
  let visible = true, stopped = false;
  let raf = 0, timer = 0;
  let W = 0, H = 0, dpr = 1;
  let theme: Record<Paint | "lineSoft" | "accentRgb", string> = {
    lineStrong: "#323a4f", line: "#252a3a", lineSoft: "#1a1e2a", cyan: "70 200 220", amber: "#e8b23c", red: "#e5534b", green: "80 200 120", blue: "#5b8def", accentRgb: "198 75 214",
  };

  const readTheme = () => {
    const cs = getComputedStyle(stage);
    const v = (k: string, d: string) => cs.getPropertyValue(k).trim() || d;
    theme = {
      lineStrong: v("--line-strong", theme.lineStrong), line: v("--line", theme.line), lineSoft: v("--line-soft", theme.lineSoft),
      cyan: v("--cyan-rgb", theme.cyan), amber: v("--amber", theme.amber), red: v("--red", theme.red), green: v("--green-rgb", theme.green),
      blue: v("--blue", theme.blue), accentRgb: v("--accent-rgb", theme.accentRgb),
    };
  };
  const paint = (t: number) => {
    if (!ctx || !W || !H) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const cx = W / 2, cy = H / 2;
    const moving = mode === "motion" && !reduced;

    ctx.lineWidth = 1;
    ctx.strokeStyle = theme.lineSoft;
    ctx.globalAlpha = 1;
    ctx.setLineDash(mode === "static" ? [] : RING_DASH);
    ctx.lineDashOffset = moving ? -((t / 1000) * RING_PX_PER_SEC) % 12 : 0;
    ctx.beginPath();
    for (const r of scene.rings) { ctx.moveTo(cx + r.rx, cy); ctx.ellipse(cx, cy, r.rx, r.ry, 0, 0, Math.PI * 2); }
    ctx.stroke();

    for (const s of scene.spokes) {
      const st = spokeStyle(s.status, mode, reduced);
      let alpha = st.alpha;
      if (st.motion.kind === "pulse") { // ease-in-out between lo and 1, peaking mid-period like the keyframes did
        const ph = (t % st.motion.periodMs) / st.motion.periodMs;
        alpha = st.motion.lo + (1 - st.motion.lo) * (0.5 - 0.5 * Math.cos(ph * Math.PI * 2));
      }
      ctx.globalAlpha = alpha;
      // --cyan-rgb and --green-rgb are space-separated channels (the stylesheet writes rgb(var(--cyan-rgb) / a));
      // the rest are plain colors. Every alpha rides on globalAlpha.
      ctx.strokeStyle = st.paint === "cyan" || st.paint === "green" ? `rgb(${theme[st.paint]})` : theme[st.paint];
      ctx.lineWidth = s.promoted ? 3 : st.width;
      ctx.setLineDash(st.dash);
      const period = st.dash.reduce((a, b) => a + b, 0);
      ctx.lineDashOffset = st.motion.kind === "flow" && period ? -((t / 1000) * st.motion.pxPerSec) % period : 0;
      if (s.promoted) { ctx.shadowColor = `rgb(${theme.accentRgb} / .6)`; ctx.shadowBlur = 4; }
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + s.x, cy + s.y); ctx.stroke();
      if (s.promoted) { ctx.shadowColor = "transparent"; ctx.shadowBlur = 0; }
    }
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
  };

  const frame = (t: number) => {
    raf = 0;
    if (stopped || !visible) return;
    paint(t);
    schedule();
  };
  const schedule = () => {
    const delay = frameDelay(scene, mode, reduced);
    if (delay !== null) timer = window.setTimeout(() => { timer = 0; kick(); }, delay);
  };
  /** Draw once on the next frame; the loop continues from there only if the cadence asks for it. */
  const kick = () => {
    if (stopped || !visible || raf) return;
    if (timer) { window.clearTimeout(timer); timer = 0; }
    raf = requestAnimationFrame(frame);
  };
  const park = () => {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (timer) { window.clearTimeout(timer); timer = 0; }
  };

  const resize = () => {
    const w = stage.clientWidth, h = stage.clientHeight;
    const d = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    if (!w || !h || (w === W && h === H && d === dpr)) return;
    W = w; H = h; dpr = d;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    kick();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(stage);
  const onMq = () => { reduced = !!mq?.matches; kick(); };
  mq?.addEventListener("change", onMq);
  readTheme();

  return {
    setScene(next) {
      scene = next;
      readTheme(); // once per poll: a theme switch lands with the next census
      resize();
      kick();
    },
    setMode(m) { mode = m; kick(); },
    setVisible(on) { visible = on; if (on) kick(); else park(); },
    destroy() {
      stopped = true;
      park();
      ro.disconnect();
      mq?.removeEventListener("change", onMq);
      cv.remove();
    },
  };
}
