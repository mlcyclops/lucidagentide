// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/design_draw.ts - Canvas 2D drawing shared by the Design viewport (main thread) and the
// design worker (OffscreenCanvas): vector shapes as Path2D, text with system font families only (no font
// is ever loaded), and the W3C blend modes as canvas composite operations (Canvas 2D implements the same
// Compositing and Blending Level 1 formulas the engine's compositeInto does).

import type { BlendMode, PathCmd, VShape, VectorLayer } from "../../harness/creator/design/types.ts";

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export const CANVAS_BLEND: Record<BlendMode, GlobalCompositeOperation> = {
  normal: "source-over", multiply: "multiply", screen: "screen", overlay: "overlay", darken: "darken", lighten: "lighten",
  "color-dodge": "color-dodge", "color-burn": "color-burn", "hard-light": "hard-light", "soft-light": "soft-light",
  difference: "difference", exclusion: "exclusion", hue: "hue", saturation: "saturation", color: "color", luminosity: "luminosity",
};

export function cmdsToPath2D(cmds: readonly PathCmd[]): Path2D {
  const p = new Path2D();
  for (const c of cmds) {
    switch (c.c) {
      case "M": p.moveTo(c.x, c.y); break;
      case "L": p.lineTo(c.x, c.y); break;
      case "C": p.bezierCurveTo(c.x1, c.y1, c.x2, c.y2, c.x, c.y); break;
      case "Q": p.quadraticCurveTo(c.x1, c.y1, c.x, c.y); break;
      case "Z": p.closePath(); break;
    }
  }
  return p;
}

/** The fillable outline of a shape (text has none: it is drawn with fillText). */
export function shapePath(s: VShape): Path2D | null {
  if (s.kind === "path" && s.d) return cmdsToPath2D(s.d);
  if (s.kind === "rect" && s.rect) {
    const p = new Path2D();
    const r = s.rect, rx = Math.max(0, Math.min(s.rx ?? 0, r.w / 2, r.h / 2));
    if (rx > 0) p.roundRect(r.x, r.y, r.w, r.h, rx);
    else p.rect(r.x, r.y, r.w, r.h);
    return p;
  }
  if (s.kind === "ellipse" && s.rect) {
    const p = new Path2D();
    const r = s.rect;
    p.ellipse(r.x + r.w / 2, r.y + r.h / 2, Math.abs(r.w / 2), Math.abs(r.h / 2), 0, 0, Math.PI * 2);
    return p;
  }
  return null;
}

export const textFont = (size: number, family: string): string => `${Math.max(1, size)}px ${family === "serif" || family === "monospace" ? family : "sans-serif"}`;

/** Draw one shape in the context's current transform. `alpha` is the layer's effective opacity. */
export function drawShape(ctx: Ctx2D, s: VShape, alpha: number): void {
  ctx.save();
  if (s.transform) ctx.transform(...s.transform);
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha * s.paint.opacity));
  ctx.lineCap = s.paint.lineCap ?? "round";
  ctx.lineJoin = s.paint.lineJoin ?? "round";
  ctx.lineWidth = Math.max(0, s.paint.strokeWidth);
  if (s.kind === "text" && s.text && s.rect) {
    // (rect.x, rect.y) is the baseline-left anchor, like SVG <text x y> in the engine's export.
    ctx.font = textFont(s.text.size, s.text.family);
    ctx.textBaseline = "alphabetic";
    const lines = s.text.content.split("\n");
    lines.forEach((line, i) => {
      const y = s.rect!.y + i * s.text!.size * 1.2;
      if (s.paint.fill) { ctx.fillStyle = s.paint.fill; ctx.fillText(line, s.rect!.x, y); }
      if (s.paint.stroke && s.paint.strokeWidth > 0) { ctx.strokeStyle = s.paint.stroke; ctx.strokeText(line, s.rect!.x, y); }
    });
    ctx.restore();
    return;
  }
  const p = shapePath(s);
  if (p) {
    if (s.paint.fill) { ctx.fillStyle = s.paint.fill; ctx.fill(p); }
    if (s.paint.stroke && s.paint.strokeWidth > 0) { ctx.strokeStyle = s.paint.stroke; ctx.stroke(p); }
  }
  ctx.restore();
}

export function drawVectorLayer(ctx: Ctx2D, layer: VectorLayer, alpha: number): void {
  for (const s of layer.shapes) drawShape(ctx, s, alpha);
}

/** Text shape bounds estimate (for hit testing and selection boxes). */
export function textBounds(s: VShape): { x: number; y: number; w: number; h: number } | null {
  if (s.kind !== "text" || !s.text || !s.rect) return null;
  const lines = s.text.content.split("\n");
  const longest = lines.reduce((n, l) => Math.max(n, l.length), 0);
  return { x: s.rect.x, y: s.rect.y - s.text.size, w: Math.max(s.rect.w, longest * s.text.size * 0.6), h: lines.length * s.text.size * 1.2 };
}
