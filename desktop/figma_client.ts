// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/figma_client.ts — P-FIGMA.1 (ADR-0154): the pure core of the Figma import. Network I/O (the actual
// api.figma.com calls) lives in dev.ts (server-side, with the vault PAT); this module holds the pure,
// unit-testable pieces: parse a Figma URL → file key, walk the file document → top-level frame node ids, and
// build the "design board" HTML (frames as inlined data-URL images) that loads in the sandboxed preview.
//
// WHY images, not a live embed: the preview iframe is opaque-origin + `connect-src 'none'` — a live figma.com
// embed can't load. So we render the frames to PNGs server-side and inline them; the agent then reviews the
// board with preview_screenshot / preview_inspect (P-PREVIEW.6).

export const FIGMA_API = "https://api.figma.com/v1";
export const MAX_FRAMES = 24; // cap the board (and the images-API id list) so a huge file stays manageable

/** Extract the file key from a Figma URL (figma.com/file/<KEY>/… or /design/<KEY>/…), or accept a bare key.
 *  Returns null if it isn't a plausible Figma file reference. */
export function parseFigmaFileKey(input: string): string | null {
  const s = (input || "").trim();
  if (!s) return null;
  const m = /figma\.com\/(?:file|design|proto)\/([A-Za-z0-9]{10,})/i.exec(s);
  if (m?.[1]) return m[1]; // group 1 always captures on a match; the guard narrows for noUncheckedIndexedAccess
  // a bare key (what the user might paste directly)
  if (/^[A-Za-z0-9]{10,}$/.test(s)) return s;
  return null;
}

export interface FigmaNode { id?: string; name?: string; type?: string; children?: FigmaNode[] }
export interface FrameRef { id: string; name: string; page: string }

/** Walk a Figma file document → the top-level frame-like nodes (FRAME / COMPONENT / SECTION) across pages,
 *  capped at `cap`. Pure over the parsed `/v1/files/:key` response's `document`. */
export function collectTopFrames(document: FigmaNode | null | undefined, cap = MAX_FRAMES): FrameRef[] {
  const out: FrameRef[] = [];
  const pages = document?.children ?? [];
  for (const page of pages) {
    const pageName = (page.name || "Page").trim();
    for (const node of page.children ?? []) {
      if (out.length >= cap) return out;
      const t = (node.type || "").toUpperCase();
      if ((t === "FRAME" || t === "COMPONENT" || t === "COMPONENT_SET" || t === "SECTION" || t === "INSTANCE") && node.id) {
        out.push({ id: node.id, name: (node.name || "Frame").trim(), page: pageName });
      }
    }
  }
  return out;
}

const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

export interface BoardFrame { name: string; page: string; dataUrl: string }

/** Build the design-board HTML: each frame is a labelled card with its PNG inlined as a data URL. This is
 *  written to a local file and loaded through the normal preview pipeline (serve + inline + the inspect
 *  bridge). Only `data:image/*` URLs are accepted for the src (a bad/missing render is shown as a placeholder),
 *  so nothing but an image can land in the markup. */
export function figmaBoardHtml(fileName: string, frames: BoardFrame[]): string {
  const cards = frames.map((f) => {
    const okImg = /^data:image\//i.test(f.dataUrl || "");
    const body = okImg
      ? `<img class="ff-img" alt="${esc(f.name)}" src="${esc(f.dataUrl)}" loading="lazy" />`
      : `<div class="ff-missing">Couldn't render this frame.</div>`;
    return `<figure class="ff-card"><figcaption class="ff-cap"><span class="ff-name">${esc(f.name)}</span><span class="ff-page">${esc(f.page)}</span></figcaption>${body}</figure>`;
  }).join("\n");
  const count = frames.length;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(fileName)} — Figma</title>
<style>
  :root{color-scheme:dark}
  body{margin:0;background:#0b0b10;color:#e7e7ee;font:14px/1.4 system-ui,Segoe UI,Roboto,sans-serif}
  header{position:sticky;top:0;background:#12121a;border-bottom:1px solid #262633;padding:12px 18px;font-weight:600;z-index:1}
  header .sub{color:#9aa;font-weight:400;margin-left:8px;font-size:12.5px}
  .ff-board{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:18px;padding:18px}
  .ff-card{margin:0;background:#15151f;border:1px solid #262633;border-radius:10px;overflow:hidden}
  .ff-cap{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px 11px;border-bottom:1px solid #232330;font-size:12.5px}
  .ff-name{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .ff-page{color:#8a8aa0;font-size:11px;white-space:nowrap}
  .ff-img{display:block;width:100%;height:auto;background:#fff}
  .ff-missing{padding:22px;color:#8a8aa0;text-align:center;font-size:12.5px}
</style></head>
<body>
  <header>${esc(fileName)}<span class="sub">${count} frame${count === 1 ? "" : "s"} · imported from Figma</span></header>
  <main class="ff-board" id="board">${count ? cards : '<div class="ff-missing">No frames were found to render in this file.</div>'}</main>
</body></html>`;
}
