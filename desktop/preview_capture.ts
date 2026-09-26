// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/preview_capture.ts - the PURE crop math for a preview capture, in ONE place.
//
// THE BUG THIS EXISTS FOR: the renderer measures the preview iframe with `getBoundingClientRect()`, which
// returns CSS pixels, and handed that rect straight to Electron's `webContents.capturePage(rect)`, whose
// Rectangle is in DIP (device-independent pixels). Those two spaces are only the same at zoom 1.0:
//
//     DIP = CSS * zoomFactor
//
// So at LUCID's 118% zoom every capture was cropped at 1/1.18 of the intended box: the origin landed ~18%
// LEFT of the preview panel (so the snip bled into the CHAT/COMPOSER column beside it) and the width/height
// were ~18% short (so the right and bottom of the previewed app were sliced off). That hit all four capture
// callers at once - the agent's `preview_screenshot` cache, the user's "Screenshot -> chat", and both
// send-to-phone snapshot paths - because they all share this one IPC seam.
//
// The scale therefore belongs HERE, at the seam, applied in the Electron main process where the authoritative
// zoom factor lives (`webContents.getZoomFactor()`). Doing it in the renderer would need the zoom plumbed
// through the preload bridge and would leave every existing caller to remember the multiply.
//
// Edge handling: both EDGES are scaled and then rounded, and the size is derived as the difference. Scaling a
// rounded width instead would let the rounding error land inside the crop and shave a pixel column off the
// right/bottom edge at fractional zooms (1.1, 1.18, 1.25 are all fractional in CSS px).

/** An integer pixel rect, the shape Electron's `capturePage` Rectangle wants. */
export interface CaptureRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Read one rect field as a usable CSS-pixel measure, else 0. The rect crosses an IPC boundary, so it is
 *  genuinely untyped by the time main sees it and is NARROWED rather than asserted: a NaN or negative width
 *  would make `capturePage` throw or silently fall back to capturing the whole window. */
function rectField(rect: unknown, key: "x" | "y" | "width" | "height"): number {
  if (!rect || typeof rect !== "object") return 0;
  // Runtime-checked as a non-null object above. The IPC payload is an arbitrary bag with no shape to
  // validate against, so this asserts only "string-keyed"; the VALUE stays `unknown` and is typeof-checked
  // on the next line. (`key in rect` narrowing is not enough to index under desktop/tsconfig.json.)
  const fields = rect as Record<string, unknown>;
  const v: unknown = fields[key];
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

/** Convert a CSS-pixel rect measured in the renderer into the DIP crop `webContents.capturePage` expects.
 *  Pure. `zoomFactor` is the page's zoom (`webContents.getZoomFactor()`); 1.0 is the identity case, so a
 *  never-zoomed window keeps byte-identical behavior to before this existed. */
export function captureCropFromCssRect(rect: unknown, zoomFactor: unknown): CaptureRect {
  // A usable multiplier: finite and > 0, else 1 - an unknown zoom must degrade to "capture unscaled",
  // never to a zero-area crop. Electron reports 1.0 when the user has never zoomed.
  const z = typeof zoomFactor === "number" && Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  const x = rectField(rect, "x"), y = rectField(rect, "y");
  const w = rectField(rect, "width"), h = rectField(rect, "height");
  // Scale the far edges, not the sizes: round(right) - round(left) keeps the crop flush with the element.
  const left = Math.round(x * z), top = Math.round(y * z);
  const right = Math.round((x + w) * z), bottom = Math.round((y + h) * z);
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}
