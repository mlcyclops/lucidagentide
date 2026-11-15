// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/screen_shot.ts - P-ASKLUCID.7 (ADR-0588): take the picture of the screen, and paint over what must not leave.
//
// The DOM half of ../ask_lucid_shot.ts. The capture itself is the window capture the Preview panel already
// uses (Electron's capturePage, through the preload bridge); in a plain browser there is none and this
// returns null, so Lucid gets the text view alone.
//
// Order matters. The rectangles to paint over are measured BEFORE the capture and again AFTER it, and both
// sets are painted: a field that appeared or moved while the capture was in flight is still covered. If
// anything in the path fails, there is no picture. A picture with a missing mask is never sent.

import { fitSize, maskRects, normalizeShot, parseShotDataUrl, SHOT_LIMITS, type CssRect, type ScreenShot } from "../ask_lucid_shot.ts";

export const PICTURE_KEY = "lucid.asklucid.picture";
/** The slice of Storage this module uses. */
export interface PictureStore { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }

/** "Lucid may look at a picture of the screen": on unless the user turned it off. */
export function pictureEnabled(store: PictureStore | null): boolean {
  try { return store?.getItem(PICTURE_KEY) !== "0"; } catch { return true; }
}
export function setPictureEnabled(store: PictureStore | null, on: boolean): void {
  try { if (on) store?.removeItem(PICTURE_KEY); else store?.setItem(PICTURE_KEY, "0"); } catch { /* storage blocked: the choice lasts for this window only */ }
}

/** PURE: the Settings row, in the `set-toggle` shape (one span of text). */
export function pictureToggleHtml(on: boolean): string {
  return `<label class="set-toggle"><input type="checkbox" id="lucidPicture"${on ? " checked" : ""}/>
      <span><b>Lucid may look at a picture of the screen</b> - sent with a question in Ask Lucid when the model can read pictures, so he can see layout, colors and charts. Anything you typed and his own panel are painted over first, and no picture is sent when the screen shows something shaped like a key.</span></label>`;
}

/** Everything that is painted over: what the user typed or can type into, and the panel asking the question. */
export const MASKED = "input, textarea, select, [contenteditable]:not([contenteditable='false']), .ald, .ald-pill";
export const MASK_COLOR = "#7f7f7f";

/** The window rectangles (CSS pixels) of every element that must be painted over and is on screen. */
export function collectMaskRects(doc: Document): CssRect[] {
  const win = doc.defaultView;
  if (!win) return [];
  const out: CssRect[] = [];
  for (const el of doc.querySelectorAll(MASKED)) {
    // An element that is not drawn (opacity 0, visibility hidden, display none: the closed command palette's
    // field is one) is not in the capture, so painting its rectangle would only hide what IS drawn there.
    // Anything drawn at all, however faintly, is painted over.
    const check = (el as Element & { checkVisibility?: (o?: object) => boolean }).checkVisibility;
    if (typeof check === "function" && !check.call(el, { checkOpacity: true, checkVisibilityCSS: true })) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    if (r.right <= 0 || r.bottom <= 0 || r.left >= win.innerWidth || r.top >= win.innerHeight) continue;
    out.push({ x: r.left, y: r.top, width: r.width, height: r.height });
  }
  return out;
}

function loadImage(doc: Document, url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = doc.createElement("img");
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("the capture could not be decoded"));
    img.src = url; // a DOM property, never markup
  });
}

/** Capture the window, scale it down, paint the masks, and hand back a JPEG. Null when there is no capture
 *  (a plain browser), when it cannot be decoded, or when any step fails. */
export async function captureScreen(doc: Document, capture: (rect: CssRect) => Promise<string | null>): Promise<ScreenShot | null> {
  try {
    const win = doc.defaultView;
    if (!win) return null;
    const before = collectMaskRects(doc);
    const url = await capture({ x: 0, y: 0, width: 0, height: 0 }); // a zero rectangle is the whole window
    if (!parseShotDataUrl(url)) return null;
    const after = collectMaskRects(doc);
    const img = await loadImage(doc, url!);
    const fit = fitSize(img.naturalWidth, img.naturalHeight);
    if (fit.width < SHOT_LIMITS.minEdge || fit.height < SHOT_LIMITS.minEdge) return null;
    const canvas = doc.createElement("canvas");
    canvas.width = fit.width;
    canvas.height = fit.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, fit.width, fit.height);
    ctx.fillStyle = MASK_COLOR;
    for (const m of maskRects([...before, ...after], { width: win.innerWidth, height: win.innerHeight }, fit)) ctx.fillRect(m.x, m.y, m.width, m.height);
    const out = parseShotDataUrl(canvas.toDataURL("image/jpeg", SHOT_LIMITS.quality));
    return out ? normalizeShot({ mime: out.mime, data: out.data, width: fit.width, height: fit.height }) : null;
  } catch { return null; }
}
