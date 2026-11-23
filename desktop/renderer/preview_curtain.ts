// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/preview_curtain.ts - P-PREVIEW-CURTAIN.1 (ADR-0621): the loading curtain in front of
// AUTO previews. How a preview target reaches the screen (before this increment):
//   1. Agent write: the engine emits `preview-available` (acp_backend's write / preview_open path), app.ts
//      onPreviewAvailable(path) stat-probes it (/api/preview/probe), then OPENED the panel on the Agent tab
//      (#prevFrameA) and loadPreview'd it there.
//   2. Lane write: fleet_grid's lane sink (deps.previewLaneFile) and the attached-lane stream in app.ts call
//      previewShowLaneFile, which upserted a "lane:<id>" tab (preview_tabs.ts) with its own iframe
//      (laneTabFrames) and OPENED the panel on it when it was closed.
//   3. User intent: openPreviewFile -> the Yours tab (#prevFrame); Ask Lucid edits and plugins open their
//      own tabs. loadPreview serves a local file through /api/preview/serve (a failure answers HTTP 200 with
//      a "Can't preview this file" page), remote URLs after the egress check.
//   4. Inside a served HTML page the injected bridge (preview_bridge.ts) answers inspect queries.
// Now 1 and 2 pass this gate first: probe -> hidden probe frame -> paint looks -> ready | blank | error.
// Only `ready` earns an invitation (a chip); nothing auto-opens and blank or error pages are never shown.
//
// Pure: no DOM, no I/O. app.ts owns the probe frame, the chip DOM and the swing; this module owns the
// classification, its thresholds, the pending-chip registry and the small geometry/motion decisions.

import { icon } from "./icons.ts"; // pure string markup, no DOM
import { baseTier, type PerfTier } from "./perf_tier.ts";

export type CurtainVerdict = "ready" | "blank" | "error" | "loading";

/** The engine's answer about the target (/api/preview/probe). `bytes` is the file size (or, for a loopback
 *  URL, the body length); absent when the engine did not say. */
export interface CurtainProbe {
  resolves: boolean;
  kind?: string;
  bytes?: number;
  status?: number;
  error?: string;
}

/** One canvas, read back by the in-frame bridge on a `sampleEdge` x `sampleEdge` nearest-neighbor grid.
 *  `px` is RGBA bytes, or null when the readback was refused (a tainted canvas, which means it DID draw an
 *  image). */
export interface CanvasSample { w: number; h: number; px: number[] | null }

/** What one in-frame paint look reports (preview_bridge.ts `what: 'paint'`). Counts exclude LUCID's own
 *  injected banners, so a dead page carrying only "This preview stopped early" is not "content". */
export interface PaintStats {
  title: string;
  /** Visible text characters, whitespace removed. */
  textChars: number;
  /** Loaded images, video, inline svg with children, nested frames, embeds. */
  media: number;
  /** Boxes that paint something the page background does not: a fill that differs from the background, a
   *  background image, a visible border, a shadow. Boxes covering nearly the whole viewport only restate
   *  the background and are not counted. */
  boxes: number;
  canvases: CanvasSample[];
  /** Captured `error:` / `unhandledrejection:` entries. */
  errors: number;
  /** The early shim's "stopped early" banner is up. */
  scriptError: boolean;
  /** The blocked-remote-references banner is up (a CDN script or font the sandbox refused). */
  blockedRefs: boolean;
  /** A small PNG of the largest canvas, when there is one. */
  thumb?: string;
}

/** Every number the curtain decides by, in one place. The bridge receives the paint ones with each look. */
export const CURTAIN = {
  /** The engine announces a write when the tool call OPENS, so the file may not exist (or be empty) yet: a
   *  missing, empty or refusing target is asked again this many times, this far apart, before any verdict. */
  probeRetries: 5,
  probeRetryMs: 700,
  /** First paint look, after the probe frame's load event. */
  firstLookMs: 700,
  /** Second (last) look for a page that had nothing on the first: late renderers get one more chance. */
  secondLookMs: 2200,
  /** A paint look that gets no answer in this long counts as no answer. */
  lookTimeoutMs: 2500,
  /** The probe frame never fired `load` in this long: the page hung. */
  loadTimeoutMs: 9000,
  /** Visible text below this many characters is not content on its own. */
  minTextChars: 3,
  /** Boxes, media and canvases smaller than this (CSS px squared) are ignored. */
  minBoxPx: 64,
  /** A box covering at least this share of the viewport is background, not content. */
  fullFrac: 0.9,
  /** Canvas readback grid edge (samples per side). */
  sampleEdge: 48,
  /** A canvas is one solid color when at least this share of its samples sit within `colorTol`. */
  uniformShare: 0.985,
  /** Per-channel tolerance for "the same color". */
  colorTol: 12,
  /** A solid color whose every channel is at least this is near-white. */
  nearWhite: 240,
  /** Samples with alpha below this read as transparent. */
  alphaFloor: 8,
  thumbW: 112,
  thumbH: 70,
  /** The panel swing-out duration (reduced motion: instant). */
  swingMs: 380,
} as const;

/** Read a paint look's answer. It comes from the PREVIEWED page's frame, so it is untrusted: anything that
 *  is not the documented shape is null (a timeout note, an `{ error }`, a forged reply), counts are clamped
 *  to finite non-negative numbers, and an oversized pixel array is treated as a refused readback. */
export function parsePaint(raw: unknown): PaintStats | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.textChars !== "number" || !Array.isArray(r.canvases)) return null;
  const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  const maxPx = 4 * 96 * 96; // the bridge clamps its grid edge to 96
  const canvases: CanvasSample[] = r.canvases.slice(0, 3).map((c) => {
    const o = (c && typeof c === "object" ? c : {}) as Record<string, unknown>;
    const px = Array.isArray(o.px) && o.px.length <= maxPx && o.px.every((v) => typeof v === "number") ? (o.px as number[]) : null;
    return { w: n(o.w), h: n(o.h), px };
  });
  return {
    title: typeof r.title === "string" ? r.title.slice(0, 120) : "",
    textChars: n(r.textChars), media: n(r.media), boxes: n(r.boxes), canvases, errors: n(r.errors),
    scriptError: r.scriptError === true, blockedRefs: r.blockedRefs === true,
    ...(typeof r.thumb === "string" && r.thumb && r.thumb.length <= 200_000 ? { thumb: r.thumb } : {}),
  };
}

/** The paint-look command handed to the bridge: thresholds travel with it, so they live only here. */
export function paintCommand(): { what: "paint"; minBoxPx: number; fullFrac: number; sampleEdge: number; thumbW: number; thumbH: number } {
  return { what: "paint", minBoxPx: CURTAIN.minBoxPx, fullFrac: CURTAIN.fullFrac, sampleEdge: CURTAIN.sampleEdge, thumbW: CURTAIN.thumbW, thumbH: CURTAIN.thumbH };
}

export type PixelVerdict = "content" | "uniform" | "transparent" | "empty" | "unreadable";

/** Classify one canvas readback. `uniform` = nearly all samples one color (near-white or any solid);
 *  `transparent` = nearly all samples clear; `empty` = a 0-sized canvas; `unreadable` = refused readback. */
export function canvasVerdict(c: CanvasSample): { verdict: PixelVerdict; share: number; nearWhite: boolean } {
  if (c.w <= 0 || c.h <= 0) return { verdict: "empty", share: 1, nearWhite: false };
  if (!c.px) return { verdict: "unreadable", share: 0, nearWhite: false };
  const n = Math.floor(c.px.length / 4);
  if (n === 0) return { verdict: "empty", share: 1, nearWhite: false };
  let clear = 0;
  const buckets = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if ((c.px[o + 3] ?? 0) < CURTAIN.alphaFloor) { clear++; continue; }
    const key = ((c.px[o]! >> 4) << 8) | ((c.px[o + 1]! >> 4) << 4) | (c.px[o + 2]! >> 4);
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  if (clear / n >= CURTAIN.uniformShare) return { verdict: "transparent", share: clear / n, nearWhite: false };
  // The mode bucket's mean color, then everything within tolerance of it (a bucket edge cannot split one
  // flat fill in two).
  let modeKey = -1, modeCount = 0;
  for (const [k, v] of buckets) if (v > modeCount) { modeKey = k; modeCount = v; }
  let r = 0, g = 0, b = 0, m = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if ((c.px[o + 3] ?? 0) < CURTAIN.alphaFloor) continue;
    const key = ((c.px[o]! >> 4) << 8) | ((c.px[o + 1]! >> 4) << 4) | (c.px[o + 2]! >> 4);
    if (key !== modeKey) continue;
    r += c.px[o]!; g += c.px[o + 1]!; b += c.px[o + 2]!; m++;
  }
  if (m === 0) return { verdict: "content", share: 0, nearWhite: false };
  r /= m; g /= m; b /= m;
  let near = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if ((c.px[o + 3] ?? 0) < CURTAIN.alphaFloor) continue;
    if (Math.abs(c.px[o]! - r) <= CURTAIN.colorTol && Math.abs(c.px[o + 1]! - g) <= CURTAIN.colorTol && Math.abs(c.px[o + 2]! - b) <= CURTAIN.colorTol) near++;
  }
  // Transparent samples show whatever is behind the canvas, a color of their own: a half-clear,
  // half-red canvas shows two colors, not one.
  const share = near / n;
  const nearWhite = Math.min(r, g, b) >= CURTAIN.nearWhite;
  return share >= CURTAIN.uniformShare ? { verdict: "uniform", share, nearWhite } : { verdict: "content", share, nearWhite };
}

/** Does this canvas show something? A refused readback did draw (only a drawn image taints). A canvas that
 *  reads back fully transparent is either a 2D canvas nothing was drawn on or a WebGL canvas whose buffer
 *  was cleared after compositing (readback outside its render task); without an error on the page it gets
 *  the benefit of the doubt, with one it is the classic dead page. */
export function canvasShows(c: CanvasSample, pageErrors: number): boolean {
  const v = canvasVerdict(c).verdict;
  if (v === "content" || v === "unreadable") return true;
  if (v === "transparent") return pageErrors === 0;
  return false;
}

/** Is there anything on this page worth looking at? */
export function paintContentful(p: PaintStats): boolean {
  return p.textChars >= CURTAIN.minTextChars || p.media > 0 || p.boxes > 0 || p.canvases.some((c) => canvasShows(c, p.errors + (p.scriptError ? 1 : 0)));
}

/** Only a served HTML document carries the in-frame bridge, so only there does a paint look apply. */
export const paintApplies = (kind: string | undefined): boolean => kind === "html";

export interface CurtainInput {
  /** The engine's probe; null while it has not answered. */
  probe: CurtainProbe | null;
  /** The latest paint look; null when none answered (yet). */
  paint: PaintStats | null;
  /** How many paint looks were attempted (answered or not). */
  looks: number;
  /** The probe frame fired `load`. */
  loaded: boolean;
  /** Milliseconds since the gate started. */
  elapsedMs: number;
}

/** Ask the engine again? Only for answers a write still in flight (or a dev server still starting) can
 *  change: missing, unreadable, empty, refused, timed out, an HTTP error. A refusal by policy or by kind
 *  (not approved, not previewable, too large, not local) is final at once. */
export function shouldReprobe(p: CurtainProbe, attempt: number): boolean {
  if (attempt >= CURTAIN.probeRetries) return false;
  if (p.resolves) return p.bytes === 0;
  return !/not approved|not a previewable|too large|not a local|not a loopback/i.test(p.error ?? "");
}

/** A verdict and the one-line reason the dev log records. */
export interface CurtainDecision { verdict: CurtainVerdict; reason: string }

/** The decision. `loading` means "ask again later"; the caller schedules the next look. */
export function classifyCurtain(i: CurtainInput): CurtainDecision {
  const p = i.probe;
  if (!p) return { verdict: "loading", reason: "waiting for the engine probe" };
  if (!p.resolves) return { verdict: "error", reason: p.error || (p.status ? `HTTP ${p.status}` : "the target does not resolve") };
  if (p.bytes === 0) return { verdict: "blank", reason: "the file is empty" };
  if (!paintApplies(p.kind)) return { verdict: "ready", reason: `${p.kind || "target"} resolves and is not empty` };
  if (!i.loaded) {
    return i.elapsedMs >= CURTAIN.loadTimeoutMs
      ? { verdict: "error", reason: "the page never finished loading" }
      : { verdict: "loading", reason: "the page is loading" };
  }
  if (i.paint && paintContentful(i.paint)) return { verdict: "ready", reason: "the page painted content" };
  if (i.looks < 2) return { verdict: "loading", reason: i.paint ? "nothing painted yet, looking again" : "waiting for the first look" };
  if (!i.paint) return { verdict: "error", reason: "the page never answered (a served error page, or its script hung)" };
  if (i.paint.scriptError || i.paint.errors > 0) return { verdict: "error", reason: "its script failed and nothing painted" };
  if (i.paint.blockedRefs) return { verdict: "error", reason: "the sandbox refused its remote files and nothing painted" };
  return { verdict: "blank", reason: "nothing visible: no text, media, painted boxes or drawn canvas" };
}

/** The chip thumbnail: only a canvas that actually shows something (a cleared WebGL readback would be a
 *  transparent rectangle). */
export function thumbFor(p: PaintStats | null): string {
  if (!p?.thumb || !/^data:image\/png;base64,/.test(p.thumb)) return "";
  const first = p.canvases[0];
  return first && canvasVerdict(first).verdict === "content" ? p.thumb : "";
}

// ── the pending-chip registry ──────────────────────────────────────────────────────────────────────

export interface CurtainEntry {
  /** The preview tab this entry targets: "agent" or "lane:<laneId>". One entry per key. */
  key: string;
  path: string;
  /** File name (or host) shown on the chip. */
  label: string;
  phase: "loading" | "ready";
  /** Monotone order stamp; newest first. */
  seq: number;
  title?: string;
  thumb?: string;
}

/** Add or restart an entry. A rewrite of the same tab replaces its entry and moves it to the front. */
export function upsertCurtain(list: readonly CurtainEntry[], e: Omit<CurtainEntry, "phase">): CurtainEntry[] {
  return [{ ...e, phase: "loading" }, ...list.filter((x) => x.key !== e.key)];
}

/** Settle an entry. `ready` keeps it (now clickable); anything else retires it. A settle for a superseded
 *  path (the tab moved on to a newer file) changes nothing. */
export function settleCurtain(list: readonly CurtainEntry[], key: string, path: string, verdict: Exclude<CurtainVerdict, "loading">, extra: { title?: string; thumb?: string } = {}): CurtainEntry[] {
  const at = list.find((x) => x.key === key);
  if (!at || at.path !== path) return list.slice();
  if (verdict !== "ready") return list.filter((x) => x.key !== key);
  return list.map((x) => (x.key === key ? { ...x, phase: "ready" as const, ...(extra.title ? { title: extra.title } : {}), ...(extra.thumb ? { thumb: extra.thumb } : {}) } : x));
}

export function dropCurtain(list: readonly CurtainEntry[], key: string): CurtainEntry[] {
  return list.filter((x) => x.key !== key);
}

/** What the single chip shows: the newest READY entry when there is one (the invitation outranks a
 *  spinner), else the newest loading one; `more` counts the other entries. */
export function chipView(list: readonly CurtainEntry[]): { head: CurtainEntry | null; more: number; ready: number } {
  const ready = list.filter((x) => x.phase === "ready");
  const head = ready[0] ?? list[0] ?? null;
  return { head, more: head ? list.length - 1 : 0, ready: ready.length };
}

/** The file name (or host) to name a target by. */
export function curtainLabel(path: string): string {
  const t = (path || "").trim();
  if (/^https?:\/\//i.test(t)) { try { return new URL(t).host || t; } catch { return t; } }
  return t.split(/[\\/]/).filter(Boolean).pop() || t;
}

// ── throttling, motion, geometry ───────────────────────────────────────────────────────────────────

/** How many hidden probe frames may run at once (each one runs the page). The Knowledge Graph's tiering,
 *  applied here: a battery or low-spec machine probes one page at a time. */
export function probeConcurrency(tier: PerfTier): number {
  return baseTier(tier) === "full" ? 3 : tier === "reduced" ? 2 : 1;
}

/** "full" animates everything; "calm" keeps the shimmer but drops the orbiting dots and the 3D swing
 *  depth; "still" animates nothing (reduced motion, or the minimal tier). ultra and cinematic are full here. */
export function curtainMotion(tier: PerfTier, reducedMotion: boolean): "full" | "calm" | "still" {
  if (reducedMotion || tier === "minimal") return "still";
  return tier === "reduced" ? "calm" : "full";
}

export interface Rect { left: number; top: number; width: number; height: number }

// ── the mini chip (fleet lane card, orbit spoke card) ──────────────────────────────────────────────

/** A lane's own curtain state, painted on its fleet card and its orbit spoke. Blank and error lanes have
 *  none (the chip is simply absent). */
export interface LaneMini { phase: "loading" | "ready"; label: string }

/** The mini chip's inner markup: a tiny page silhouette with a scanning shimmer while loading, the eye glyph
 *  once ready. ONE text element (invariant 11). Markup only; the label goes in the tooltip, set by the
 *  caller through setTip. */
export function miniChipHtml(phase: LaneMini["phase"]): string {
  return phase === "ready"
    ? `${icon("eye", 11)}<span class="pcur-mini-l">Preview</span>`
    : `<span class="pcur-mini-art" aria-hidden="true"><i></i></span><span class="pcur-mini-l">Preview</span>`;
}

/** The mini chip's accessible name and tooltip. */
export function miniChipTip(v: LaneMini): { aria: string; title: string; desc: string } {
  return v.phase === "ready"
    ? { aria: `Open the preview of ${v.label}`, title: "Open the preview", desc: `${v.label} rendered. Click to swing the Preview panel out on this agent's own tab.` }
    : { aria: `Preparing a preview of ${v.label}`, title: "Preparing a preview", desc: `${v.label} is loading out of sight. It appears here only if it renders; a blank or failed page is never shown.` };
}

/** Where the swing hinges, as a transform-origin inside the panel: the point of the panel nearest the chip
 *  the user clicked, so the panel unfolds out of it. Clamped to the panel. */
export function swingOrigin(chip: Rect | null, panel: Rect): { x: number; y: number } {
  if (!chip || panel.width <= 0 || panel.height <= 0) return { x: 0, y: 0 };
  const cx = chip.left + chip.width / 2, cy = chip.top + chip.height / 2;
  const x = Math.min(panel.width, Math.max(0, cx - panel.left));
  const y = Math.min(panel.height, Math.max(0, cy - panel.top));
  return { x: Math.round(x), y: Math.round(y) };
}
