// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/lane_shots.ts - P-LANESHOTS.1: the preview snapshots each agent took, kept per lane.
//
// The main composer has always photographed its preview (the agent lane) for the agent's own
// preview_screenshot tool; fleet lanes took none. This module is the renderer-side, in-memory record of
// those pictures for EVERY agent, so Agent Worlds can show them next to the agent that made them:
//   - a ring of the last LANE_SHOT_CAP thumbnails per lane (the main composer is lane "main"), with an
//     identical consecutive picture dropped (a cheap sampled hash, confirmed by a full compare);
//   - at most LANE_SHOT_LANES lanes; past that the lane recorded least recently is forgotten;
//   - subscribers told which lane changed;
//   - the thumbnail strip markup, pure, every string escaped.
// The capture itself stays in app.ts (Electron capturePage through the preload bridge). makeLaneThumb is
// the one DOM helper here: it scales a capture down to a small WebP so a ring of 8 stays a few hundred KB.
//
// Everything in a shot came from a page an agent wrote, so it is untrusted: only a base64 data:image URL
// of a raster type is ever stored (it lands in an <img src>), and the strip labels it "From the agent".

import { esc } from "./format.ts";
import { tipValue } from "./tip_text.ts";

export interface LaneShot { laneId: string; at: number; dataUrl: string; title: string; path: string }

/** Pictures kept per lane; the oldest goes first. */
export const LANE_SHOT_CAP = 8;
/** Lanes kept at once; the lane recorded least recently is forgotten first. */
export const LANE_SHOT_LANES = 32;
/** A thumbnail fits inside this box (CSS px of the encoded image). */
export const LANE_THUMB_MAX_W = 480;
export const LANE_THUMB_MAX_H = 480;
/** Encoder quality for the thumbnail. */
export const LANE_THUMB_QUALITY = 0.72;
/** A stored data URL longer than this is refused (a real 480px WebP is a few tens of KB). */
export const LANE_SHOT_MAX_CHARS = 400_000;

const SHOT_URL = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/;
const EMPTY: readonly LaneShot[] = Object.freeze([]);

interface LaneRing { shots: readonly LaneShot[]; hash: string }
const rings = new Map<string, LaneRing>();
const listeners = new Set<(laneId: string) => void>();

/** A cheap fingerprint of a data URL: FNV-1a over its length and at most ~2k evenly spaced characters plus
 *  the tail. Equal pictures always match; a match is confirmed with a full compare before anything is
 *  dropped, so a sampling collision can never lose a real change. */
export function shotHash(s: string): string {
  let h = 0x811c9dc5;
  const mix = (c: number): void => { h ^= c; h = Math.imul(h, 0x01000193); };
  const n = s.length;
  mix(n & 0xffff); mix(n >>> 16);
  const step = Math.max(1, Math.floor(n / 2048));
  for (let i = 0; i < n; i += step) mix(s.charCodeAt(i));
  for (let i = Math.max(0, n - 64); i < n; i++) mix(s.charCodeAt(i));
  return `${n}:${(h >>> 0).toString(36)}`;
}

/** Is this a data URL the strip may put in an <img src>? */
export function isLaneShotUrl(s: unknown): s is string {
  return typeof s === "string" && s.length <= LANE_SHOT_MAX_CHARS && SHOT_URL.test(s);
}

function notify(laneId: string): void {
  for (const cb of [...listeners]) {
    try { cb(laneId); } catch { /* one bad subscriber never stops the others */ }
  }
}

/** Record one picture for its lane. Ignored when the lane id is empty, the image is not a raster data URL
 *  (or is oversized), or it is identical to the lane's newest picture. */
export function recordLaneShot(shot: LaneShot): void {
  const laneId = typeof shot?.laneId === "string" ? shot.laneId : "";
  if (!laneId || !isLaneShotUrl(shot.dataUrl)) return;
  const hash = shotHash(shot.dataUrl);
  const prev = rings.get(laneId);
  const last = prev?.shots[prev.shots.length - 1];
  if (prev && last && prev.hash === hash && last.dataUrl === shot.dataUrl) return;
  const clean: LaneShot = Object.freeze({
    laneId,
    at: Number.isFinite(shot.at) ? shot.at : Date.now(),
    dataUrl: shot.dataUrl,
    title: String(shot.title ?? "").slice(0, 160),
    path: String(shot.path ?? "").slice(0, 1024),
  });
  // A NEW array each time: a caller holding an earlier laneShots() result keeps a stable snapshot.
  const shots = Object.freeze([...(prev?.shots ?? []), clean].slice(-LANE_SHOT_CAP));
  rings.delete(laneId); // re-insert at the end: Map order is the least-recently-recorded order
  rings.set(laneId, { shots, hash });
  const evicted: string[] = [];
  for (const id of rings.keys()) {
    if (rings.size - evicted.length <= LANE_SHOT_LANES) break;
    evicted.push(id);
  }
  for (const id of evicted) rings.delete(id);
  for (const id of evicted) notify(id);
  notify(laneId);
}

/** A lane's pictures, oldest first (index 0 is the oldest; the newest is last). Never mutated in place. */
export function laneShots(laneId: string): readonly LaneShot[] {
  return rings.get(laneId)?.shots ?? EMPTY;
}

/** Be told the id of every lane whose pictures changed. Returns the unsubscribe. */
export function onLaneShots(cb: (laneId: string) => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** The thumbnail size that fits `w` x `h` inside the max box without upscaling. Zero for an empty input. */
export function laneThumbSize(w: number, h: number, maxW: number = LANE_THUMB_MAX_W, maxH: number = LANE_THUMB_MAX_H): { w: number; h: number } {
  if (!(w > 0) || !(h > 0) || !Number.isFinite(w) || !Number.isFinite(h)) return { w: 0, h: 0 };
  const k = Math.min(1, maxW / w, maxH / h);
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

/** Scale a capture down to a thumbnail data URL (WebP, or whatever raster the canvas falls back to).
 *  Decoding is asynchronous (`img.decode()`), and the draw is one small canvas, so the UI thread is held
 *  for a few milliseconds at most. Null on any failure. */
export async function makeLaneThumb(doc: Document, capture: string): Promise<string | null> {
  try {
    const img = doc.createElement("img");
    img.src = capture; // a DOM property, never markup
    await img.decode();
    const { w, h } = laneThumbSize(img.naturalWidth, img.naturalHeight);
    if (!w || !h) return null;
    const canvas = doc.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, w, h);
    const out = canvas.toDataURL("image/webp", LANE_THUMB_QUALITY);
    return isLaneShotUrl(out) ? out : null;
  } catch { return null; }
}

function shotClock(at: number): string {
  try { return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); } catch { return ""; }
}

/** PURE: the compact strip of a lane's pictures. Newest first on screen; each thumb is a
 *  `<button data-lane-shot="<i>">` where `i` indexes the `shots` array passed in (laneShots order). Empty
 *  input renders nothing. Every string is escaped; the label says the pictures came from the agent. */
export function laneShotsStripHtml(shots: readonly LaneShot[], opts: { laneName: string }): string {
  if (!shots.length) return "";
  const name = String(opts.laneName ?? "").trim() || "this agent";
  const thumbs: string[] = [];
  for (let i = shots.length - 1; i >= 0; i--) {
    const s = shots[i]!;
    if (!isLaneShotUrl(s.dataUrl)) continue;
    const title = s.title || "Preview";
    const when = shotClock(s.at);
    const tip = tipValue(title, `${when ? `Taken at ${when} from` : "From"} ${name}'s preview. The agent made this page, so treat it as untrusted. Click to open the preview.`);
    thumbs.push(
      `<button type="button" class="lane-shot" data-lane-shot="${i}" aria-label="${esc(`Open the preview: ${title}, from ${name}`)}" data-tip="${esc(tip)}">` +
      `<img class="lane-shot-img" src="${esc(s.dataUrl)}" alt="${esc(`Preview snapshot from ${name}: ${title}`)}" loading="lazy" decoding="async" draggable="false">` +
      `</button>`,
    );
  }
  if (!thumbs.length) return "";
  const count = `${thumbs.length} preview snapshot${thumbs.length === 1 ? "" : "s"}`;
  return `<div class="lane-shots" role="group" aria-label="${esc(`Preview snapshots from ${name}, made by the agent (untrusted)`)}">` +
    `<div class="lane-shots-head"><span class="lane-shots-tag">From the agent</span><span class="lane-shots-lbl">${esc(count)}</span></div>` +
    `<div class="lane-shots-row">${thumbs.join("")}</div>` +
    `</div>`;
}
