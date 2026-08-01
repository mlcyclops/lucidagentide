// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/voice_eq.ts
//
// P-VOICE.4 (ADR-0248): the glowing spectrum analyser that dances to the agent's voice - a segmented,
// peak-holding LED display of the kind that sat on the front of a 1980s hi-fi.
//
// It taps the REAL audio: one persistent <audio> element is routed through a Web Audio AnalyserNode, so the
// bars follow the actual synthesized speech rather than a decorative animation. Two consequences shape the
// design:
//
//   · createMediaElementSource() may be called ONCE per element, and once called the element's sound flows
//     ONLY through the graph. If the AudioContext can't run (autoplay policy), routing it would mute the
//     agent. So the graph is built lazily and ONLY after resume() has actually succeeded - failing that,
//     playback stays native and the display simply idles. Sound is never traded for a visual.
//   · One analyser feeds EVERY mounted canvas (the mini strip under the prompt bar AND the floating dock),
//     from a single rAF loop that stops itself once the display has settled. Two canvases cost one FFT.
//
// The ballistics + band folding are pure and tested (harness/voice/eq_bands.ts); this file is the audio graph
// and the paint.

import {
  EQ_MAX_HZ, EQ_MIN_HZ, bandEdges, eqAtRest, foldBands, newEqFrame, stepEq, type EqFrame,
} from "../../harness/voice/eq_bands.ts";

/** Bars across the display. Fourteen reads as an instrument; more turns to mush at composer-chip width. */
export const EQ_BANDS = 14;
/** LED rows per bar. The segmentation IS the look - a smooth gradient bar reads as a progress meter. */
const SEGMENTS = 12;

/** Classic analyser ramp, nudged towards LUCID's palette at the quiet end: teal -> amber -> red. */
function segColor(t: number, alpha: number): string {
  const rgb = t < 0.55 ? "62,214,178" : t < 0.8 ? "240,196,84" : "236,92,92";
  return `rgba(${rgb},${alpha})`;
}

/** Paint one canvas from the current frame. Re-sizes its backing store on DPR/layout change so the LEDs stay
 *  crisp in a dock the user can resize. */
function drawEq(cv: HTMLCanvasElement, f: EqFrame): void {
  const g = cv.getContext("2d");
  if (!g) return;
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth;
  const h = cv.clientHeight;
  if (w <= 0 || h <= 0) return; // hidden (display:none) - nothing to paint
  const bw = Math.max(1, Math.round(w * dpr));
  const bh = Math.max(1, Math.round(h * dpr));
  if (cv.width !== bw || cv.height !== bh) { cv.width = bw; cv.height = bh; }
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);

  const n = f.levels.length;
  if (!n) return;
  const gap = Math.max(1, w * 0.014);
  const barW = Math.max(1, (w - gap * (n - 1)) / n);
  const segGap = Math.max(0.8, h * 0.022);
  const segH = Math.max(1, (h - segGap * (SEGMENTS - 1)) / SEGMENTS);

  for (let i = 0; i < n; i++) {
    const x = i * (barW + gap);
    const lit = Math.round((f.levels[i] ?? 0) * SEGMENTS);
    for (let s = 0; s < SEGMENTS; s++) {
      const t = SEGMENTS > 1 ? s / (SEGMENTS - 1) : 0;
      const y = h - (s + 1) * segH - s * segGap;
      const on = s < lit;
      // An unlit segment stays faintly visible: the empty grid is what makes it read as a display rather
      // than a handful of floating bars.
      g.shadowBlur = on ? (t > 0.72 ? 10 : 6) : 0;
      g.shadowColor = on ? segColor(t, 0.85) : "transparent";
      g.fillStyle = on ? segColor(t, 1) : segColor(t, 0.085);
      g.fillRect(x, y, barW, segH);
    }
    // The hanging peak cap - the signature of the era. Sits on the segment its level last reached.
    const peak = f.peaks[i] ?? 0;
    if (peak > 0.02) {
      const s = Math.min(SEGMENTS - 1, Math.floor(peak * SEGMENTS));
      const t = SEGMENTS > 1 ? s / (SEGMENTS - 1) : 0;
      const y = h - (s + 1) * segH - s * segGap;
      g.shadowBlur = 10;
      g.shadowColor = segColor(t, 0.95);
      g.fillStyle = segColor(t, 0.95);
      g.fillRect(x, y, barW, Math.max(1.5, segH * 0.28));
    }
  }
  g.shadowBlur = 0;
}

export class VoiceEqualizer {
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private bins: Uint8Array<ArrayBuffer> | null = null;
  private edges: number[] = [];
  private sourced = false; // createMediaElementSource has been called for our element — never call it twice
  private frame = newEqFrame(EQ_BANDS);
  private readonly canvases = new Set<HTMLCanvasElement>();
  private raf = 0;
  private lastAt = 0;
  private live = false; // audio is currently playing — keep painting even through a silent passage

  /** Whether real spectrum data is flowing (false = the display idles; playback is unaffected). */
  get analysing(): boolean { return this.analyser !== null; }

  /** Route `el` through the analyser, building the graph on first use. Returns false when Web Audio can't be
   *  started - the caller must carry on playing regardless, because silence is worse than a still display. */
  async ensure(el: HTMLAudioElement): Promise<boolean> {
    if (typeof AudioContext === "undefined") return false;
    try {
      this.audioCtx ??= new AudioContext();
      const ctx = this.audioCtx;
      if (ctx.state !== "running") await ctx.resume().catch(() => { /* still suspended below */ });
      // Only commit the element to the graph once the context is genuinely running. Routing into a suspended
      // context is what silently mutes the agent, and it cannot be undone for this element.
      if (ctx.state !== "running") return false;
      if (!this.sourced) {
        const src = ctx.createMediaElementSource(el);
        const an = ctx.createAnalyser();
        an.fftSize = 2048;
        an.smoothingTimeConstant = 0.6; // a little smoothing before our own ballistics
        src.connect(an);
        an.connect(ctx.destination); // MUST reach the speakers - the analyser is a tap, not a sink
        this.analyser = an;
        this.bins = new Uint8Array(new ArrayBuffer(an.frequencyBinCount));
        this.edges = bandEdges(an.frequencyBinCount, EQ_BANDS, EQ_MIN_HZ, EQ_MAX_HZ, ctx.sampleRate / 2);
        this.sourced = true;
      }
      return true;
    } catch { return false; } // a blocked/unsupported context must never break playback
  }

  mount(cv: HTMLCanvasElement): void { this.canvases.add(cv); this.tick(); }
  unmount(cv: HTMLCanvasElement): void { this.canvases.delete(cv); }

  /** Audio started: hold the loop open even during a quiet passage between words. */
  begin(): void { this.live = true; this.tick(); }
  /** Audio stopped: let the bars glide down, then the loop retires itself. */
  end(): void { this.live = false; this.tick(); }

  private tick(): void {
    if (this.raf || (!this.canvases.size)) return;
    this.lastAt = 0;
    this.raf = requestAnimationFrame(this.paint);
  }

  private readonly paint = (now: number): void => {
    const dt = this.lastAt ? now - this.lastAt : 16;
    this.lastAt = now;
    let target: number[];
    if (this.analyser && this.bins) {
      this.analyser.getByteFrequencyData(this.bins);
      target = foldBands(this.bins, this.edges);
    } else target = new Array(EQ_BANDS).fill(0);
    this.frame = stepEq(this.frame, target, dt);
    for (const cv of this.canvases) drawEq(cv, this.frame);
    // Retire the loop once nothing is playing AND the bars have finished falling, so an idle window costs
    // nothing. begin()/mount() restart it.
    if (!this.live && eqAtRest(this.frame)) { cancelAnimationFrame(this.raf); this.raf = 0; return; }
    this.raf = requestAnimationFrame(this.paint);
  };
}
