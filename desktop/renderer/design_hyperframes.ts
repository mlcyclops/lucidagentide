// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/design_hyperframes.ts - a Design document as a HyperFrames composition (pure).
//
// The project is index.html plus one asset per paintable layer (assets/l<N>.png for pixels, assets/l<N>.svg
// for vector layers). Timing is declarative: the root carries data-composition-id / data-width /
// data-height / data-fps / data-duration, each layer is a `class="clip"` element with data-start,
// data-duration and data-track-index. Motion is CSS @keyframes sampled at every frame time (one keyframe
// per frame, linear between them), which is seekable and deterministic: no script, no timers, no network.
// Nothing user- or model-authored reaches the markup: class names and paths are generated from indexes,
// the title is fixed, colors are re-serialized hex.

import type { DesignDoc } from "../../harness/creator/design/types.ts";
import { frameTimes } from "../../harness/creator/design/anim.ts";
import { parseColor, toHex } from "../../harness/creator/design/color.ts";
import { layerWorld, paintList } from "./design_logic.ts";

/** One layer's asset as the caller produced it (PNG bytes or a safe SVG string), in layer pixel space. */
export interface HfLayerAsset { layerId: string; ext: "png" | "svg"; width: number; height: number }

const fmt = (n: number): string => (Number.isFinite(n) ? String(Math.round(n * 10000) / 10000) : "0");

const BLEND_CSS: Record<string, string> = {
  normal: "normal", multiply: "multiply", screen: "screen", overlay: "overlay", darken: "darken", lighten: "lighten",
  "color-dodge": "color-dodge", "color-burn": "color-burn", "hard-light": "hard-light", "soft-light": "soft-light",
  difference: "difference", exclusion: "exclusion", hue: "hue", saturation: "saturation", color: "color", luminosity: "luminosity",
};

/** The asset path for the N-th paintable layer. */
export const hfAssetPath = (index: number, ext: "png" | "svg"): string => `assets/l${index}.${ext}`;

/** index.html for the composition. `assets` lists the layers to include, in any order. */
export function hyperframesIndexHtml(doc: DesignDoc, assets: readonly HfLayerAsset[]): string {
  const byId = new Map(assets.map((a) => [a.layerId, a]));
  const tl = doc.timeline;
  const durMs = Math.max(100, tl.durationMs);
  const times = frameTimes(tl);
  const bgRgba = doc.background ? parseColor(doc.background) : null;
  const bg = bgRgba ? toHex(bgRgba) : "transparent";
  const css: string[] = [
    "html,body{margin:0;padding:0;background:transparent}",
    `#stage{position:relative;width:${doc.width}px;height:${doc.height}px;overflow:hidden;background:${bg}}`,
    ".layer{position:absolute;left:0;top:0;transform-origin:0 0}",
    ".layer img{display:block}",
  ];
  const clips: string[] = [];
  let index = 0;
  for (const item of paintList(doc)) {
    const l = doc.layers[item.id];
    const a = byId.get(item.id);
    if (!l || !a || !item.visible || l.kind === "group") continue;
    const n = index++;
    const chain = [...item.groups, item.id];
    const animated = tl.tracks.some((t) => chain.includes(t.layerId) && t.keys.length > 0);
    const at = (t: number) => {
      const { m, opacity } = layerWorld(doc, item, t);
      return `transform:matrix(${m.map(fmt).join(",")});opacity:${fmt(Math.max(0, Math.min(1, opacity)))}`;
    };
    const blend = BLEND_CSS[l.blend] ?? "normal";
    if (animated && times.length > 1) {
      const frames = times.map((t) => `${fmt((t / durMs) * 100)}%{${at(t)}}`);
      css.push(`@keyframes k${n}{${frames.join("")}}`);
      css.push(`.l${n}{mix-blend-mode:${blend};animation:k${n} ${durMs}ms linear 0ms 1 both}`);
    } else css.push(`.l${n}{mix-blend-mode:${blend};${at(0)}}`);
    clips.push(`<div class="clip layer l${n}" data-start="0" data-duration="${fmt(durMs / 1000)}" data-track-index="${n}"><img src="${hfAssetPath(n, a.ext)}" width="${a.width}" height="${a.height}" alt=""></div>`);
  }
  return [
    "<!doctype html>",
    `<html lang="en"><head><meta charset="utf-8"><title>LUCID Design</title><style>${css.join("\n")}</style></head>`,
    `<body><div id="stage" data-composition-id="lucid-design" data-width="${doc.width}" data-height="${doc.height}" data-fps="${tl.fps}" data-start="0" data-duration="${fmt(durMs / 1000)}">`,
    ...clips,
    "</div></body></html>",
  ].join("\n");
}

/** The paintable layers in the order their assets are numbered (matches hyperframesIndexHtml). */
export function hfLayerOrder(doc: DesignDoc): string[] {
  return paintList(doc).filter((p) => p.visible && doc.layers[p.id] && doc.layers[p.id]!.kind !== "group").map((p) => p.id);
}
