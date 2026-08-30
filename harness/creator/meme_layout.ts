// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/creator/meme_layout.ts - CREATOR-IMG (ADR-0291): meme text geometry.
//
// Split out of imaging.ts on purpose: the RENDERER needs this math (it owns the fonts and the canvas), and
// imaging.ts imports node:zlib for PNG deflate, which must never reach a browser bundle. This module has no
// node import, no DOM import, and no side effects - it takes a measuring function and returns boxes.

/** Measure one line of text. The renderer passes canvas `measureText`; tests pass a fixed-width stub. */
export type MeasureText = (text: string, fontPx: number) => number;

/** Greedy word wrap. A single word longer than the line is SPLIT rather than allowed to overflow, because a
 *  meme that spills off the image is a broken meme. */
export function wrapLines(text: string, maxWidth: number, fontPx: number, measure: MeasureText): string[] {
  const words = (text ?? "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const lines: string[] = [];
  let line = "";
  const push = () => { if (line) { lines.push(line); line = ""; } };
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (measure(candidate, fontPx) <= maxWidth) { line = candidate; continue; }
    push();
    if (measure(word, fontPx) <= maxWidth) { line = word; continue; }
    let part = "";
    for (const ch of word) {
      if (measure(part + ch, fontPx) > maxWidth && part) { lines.push(part); part = ch; continue; }
      part += ch;
    }
    line = part;
  }
  push();
  return lines;
}

export interface MemeTextBlock {
  readonly lines: readonly string[];
  readonly fontPx: number;
  readonly lineHeight: number;
  /** Baseline y of the FIRST line; the renderer draws line i at `y + i * lineHeight`. */
  readonly y: number;
  readonly align: "center";
}

export interface MemeLayout {
  readonly width: number;
  readonly height: number;
  readonly top: MemeTextBlock | null;
  readonly bottom: MemeTextBlock | null;
  readonly strokePx: number;
}

/** Classic top/bottom meme geometry: text shrinks to fit, wraps, and never leaves the image. Each block is
 *  capped at a third of the height so the picture stays the point. */
export function memeLayout(opts: {
  width: number; height: number; top?: string; bottom?: string;
  measure: MeasureText; maxFontPx?: number; minFontPx?: number; padding?: number;
}): MemeLayout {
  const { width, height, measure } = opts;
  if (width <= 0 || height <= 0) throw new Error("memeLayout: image size must be positive");
  const pad = Math.max(4, Math.round(opts.padding ?? width * 0.04));
  const maxFont = Math.max(8, Math.round(opts.maxFontPx ?? height * 0.14));
  const minFont = Math.max(6, Math.round(opts.minFontPx ?? Math.min(18, maxFont)));
  const maxBlockHeight = height / 3;
  const fit = (text: string | undefined, anchor: "top" | "bottom"): MemeTextBlock | null => {
    const raw = (text ?? "").trim();
    if (!raw) return null;
    for (let font = maxFont; font >= minFont; font -= 1) {
      const lineHeight = Math.round(font * 1.15);
      const lines = wrapLines(raw, width - pad * 2, font, measure);
      if (!lines.length) return null;
      if (lines.length * lineHeight <= maxBlockHeight || font === minFont) {
        const y = anchor === "top" ? pad + font : height - pad - lines.length * lineHeight + font;
        return { lines, fontPx: font, lineHeight, y, align: "center" };
      }
    }
    return null;
  };
  return { width, height, top: fit(opts.top, "top"), bottom: fit(opts.bottom, "bottom"), strokePx: Math.max(2, Math.round(maxFont / 12)) };
}
