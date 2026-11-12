// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/creator_markup_view.ts - the Markup pane's DOM controller (fully on-device).
//
// pdf.js (Apache-2.0) renders the page into one canvas; the markups are drawn on a second canvas on top,
// in PDF user space through the SAME viewport transform pdf.js rendered with. Saving hands the ORIGINAL
// bytes plus the markup list to creator_markup_pdf.ts (pdf-lib, MIT), so the saved file is the source PDF
// with standard annotations appended.
//
// No network at any point: pdf.js normally spawns a Worker from a URL; here its worker module is bundled
// into the renderer and handed over as `globalThis.pdfjsWorker`, which pdf.js uses as a main-thread
// message handler instead. Both libraries load lazily on first open, so the app's boot never pays for them.
//
// State is module-level so a Studio repaint (which replaces the pane's DOM) keeps the open document, the
// markups and the tool; `mountMarkupPane` re-attaches to the fresh DOM and re-renders the current page.

import type { PDFDocumentProxy } from "pdfjs-dist";
import type * as PdfJsModule from "pdfjs-dist";
import {
  annotationRect, arrowHead, cloudPath, creatorMarkupHtml, dragToPdfRect, ellipsePath, freeTextRect, hitTest,
  markupBarHtml, markupsToXfdf, newMarkupId, pdfToCanvas, translateMarkup, withBounds, xfdfToMarkups, canvasToPdf,
  highlightQuads, DEFAULT_LINE_ENDINGS, MARKUP_TOOLS, type Markup, type MarkupKind, type MarkupTool, type Matrix, type Pt,
} from "./creator_markup.ts";

export { creatorMarkupHtml };

type PdfJs = typeof PdfJsModule;

let pdfjsPromise: Promise<PdfJs> | null = null;
function loadPdfJs(): Promise<PdfJs> {
  // Dynamic on purpose (the P-AVATAR.2a lazy-chunk seam in dev.ts bundleApp): pdf.js plus its worker are
  // about 3 MB of code that every Agent and Creator boot would otherwise evaluate before the first paint.
  pdfjsPromise ??= (async () => {
    const worker = await import("pdfjs-dist/build/pdf.worker.mjs");
    // pdf.js checks globalThis.pdfjsWorker.WorkerMessageHandler before it would ever build a Worker URL.
    Reflect.set(globalThis, "pdfjsWorker", worker);
    return import("pdfjs-dist");
  })();
  return pdfjsPromise;
}

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

const st = {
  bytes: null as Uint8Array | null,
  fileName: "",
  doc: null as PDFDocumentProxy | null,
  pageIndex: 0,
  pageCount: 0,
  zoom: 1,
  tool: "rect" as MarkupTool,
  color: "#E5252A",
  width: 2,
  markups: [] as Markup[],
  selectedId: "",
  dirty: false,
  busy: "",
  status: "",
  tone: "" as "" | "ok" | "error",
  viewport: [1, 0, 0, -1, 0, 0] as Matrix,
  renderSeq: 0,
};

let root: HTMLElement | null = null;
let draft: Markup | null = null;
let drag: { start: Pt; lastPdf: Pt; moving: string } | null = null;

const author = "LUCID Creator";

function paintBar(): void {
  const bar = root?.querySelector<HTMLElement>("[data-cmk-bar]");
  if (!bar) return;
  bar.innerHTML = markupBarHtml({
    fileName: st.fileName, hasDoc: !!st.doc, pageIndex: st.pageIndex, pageCount: st.pageCount, zoom: st.zoom, tool: st.tool,
    color: st.color, width: st.width, markupCount: st.markups.length, selected: !!st.selectedId, dirty: st.dirty,
    busy: st.busy, status: st.status, statusTone: st.tone,
  });
}

function setStatus(status: string, tone: "" | "ok" | "error" = ""): void {
  st.status = status;
  st.tone = tone;
  paintBar();
}

function download(bytes: BlobPart, name: string, type: string): void {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

const baseName = () => st.fileName.replace(/\.pdf$/i, "") || "document";

// ── drawing ──────────────────────────────────────────────────────────────────

function overlay(): HTMLCanvasElement | null {
  return root?.querySelector<HTMLCanvasElement>("[data-cmk-overlay]") ?? null;
}

function tracePath(ctx: CanvasRenderingContext2D, start: Pt, segs: { c1: Pt; c2: Pt; to: Pt }[]): void {
  ctx.beginPath();
  ctx.moveTo(start[0], start[1]);
  for (const s of segs) ctx.bezierCurveTo(s.c1[0], s.c1[1], s.c2[0], s.c2[1], s.to[0], s.to[1]);
  ctx.closePath();
}

function drawMarkup(ctx: CanvasRenderingContext2D, m: Markup, base: DOMMatrix): void {
  ctx.setTransform(base.multiply(new DOMMatrix([...st.viewport])));
  ctx.strokeStyle = m.color;
  ctx.fillStyle = m.color;
  ctx.lineWidth = m.width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const [x0, y0, x1, y1] = m.rect;
  switch (m.kind) {
    case "rect":
      ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
      break;
    case "ellipse": {
      const p = ellipsePath(m.rect);
      tracePath(ctx, p.start, p.segs);
      ctx.stroke();
      break;
    }
    case "cloud": {
      const p = cloudPath(m.rect, m.intensity ?? 1, m.width);
      tracePath(ctx, p.start, p.segs);
      ctx.stroke();
      break;
    }
    case "arrow": {
      const p = m.paths[0] ?? [];
      if (p.length < 2) break;
      ctx.beginPath();
      ctx.moveTo(p[0]![0], p[0]![1]);
      for (const pt of p.slice(1)) ctx.lineTo(pt[0], pt[1]);
      const ends = m.lineEndings ?? DEFAULT_LINE_ENDINGS;
      const head = (from: Pt, tip: Pt) => {
        const [h1, h2] = arrowHead(from, tip, m.width);
        ctx.moveTo(h1[0], h1[1]); ctx.lineTo(tip[0], tip[1]); ctx.lineTo(h2[0], h2[1]);
      };
      if (ends[1] !== "None") head(p[p.length - 2]!, p[p.length - 1]!);
      if (ends[0] !== "None") head(p[1]!, p[0]!);
      ctx.stroke();
      break;
    }
    case "ink":
      for (const path of m.paths) {
        if (!path.length) continue;
        ctx.beginPath();
        ctx.moveTo(path[0]![0], path[0]![1]);
        for (const pt of path.slice(1)) ctx.lineTo(pt[0], pt[1]);
        if (path.length === 1) ctx.lineTo(path[0]![0] + 0.01, path[0]![1]);
        ctx.stroke();
      }
      break;
    case "highlight": {
      const q = highlightQuads(m);
      ctx.save();
      ctx.globalCompositeOperation = "multiply";
      ctx.globalAlpha = 0.45;
      for (let i = 0; i + 7 < q.length; i += 8) {
        ctx.beginPath();
        ctx.moveTo(q[i]!, q[i + 1]!); ctx.lineTo(q[i + 2]!, q[i + 3]!); ctx.lineTo(q[i + 6]!, q[i + 7]!); ctx.lineTo(q[i + 4]!, q[i + 5]!);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
      break;
    }
    case "text": {
      if (m.width > 0) ctx.strokeRect(x0 + m.width / 2, y0 + m.width / 2, x1 - x0 - m.width, y1 - y0 - m.width);
      // Glyphs are drawn unflipped in CSS space at the PDF baseline the appearance stream uses.
      ctx.setTransform(base);
      ctx.font = `${m.fontSize * st.zoom}px Helvetica, Arial, sans-serif`;
      ctx.textBaseline = "alphabetic";
      m.text.split(/\r?\n/).forEach((line, i) => {
        const [cx, cy] = pdfToCanvas(st.viewport, x0 + 4, y1 - 3 - m.fontSize - i * m.fontSize * 1.2);
        ctx.fillText(line, cx, cy);
      });
      break;
    }
  }
}

function redraw(): void {
  const cv = overlay();
  if (!cv) return;
  const ctx = cv.getContext("2d");
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cv.width, cv.height);
  const base = new DOMMatrix([dpr, 0, 0, dpr, 0, 0]);
  const list = draft ? [...st.markups, draft] : st.markups;
  for (const m of list) if (m.page === st.pageIndex) drawMarkup(ctx, m, base);
  const sel = st.markups.find((m) => m.id === st.selectedId && m.page === st.pageIndex);
  if (sel) {
    const r = annotationRect(sel).rect;
    ctx.setTransform(base.multiply(new DOMMatrix([...st.viewport])));
    ctx.save();
    ctx.setLineDash([4 / st.zoom, 3 / st.zoom]);
    ctx.lineWidth = 1 / st.zoom;
    ctx.strokeStyle = "#3B82F6";
    ctx.strokeRect(r[0] - 2, r[1] - 2, r[2] - r[0] + 4, r[3] - r[1] + 4);
    ctx.restore();
  }
}

async function renderPage(): Promise<void> {
  const stage = root?.querySelector<HTMLElement>("[data-cmk-stage]");
  if (!stage || !st.doc) return;
  const seq = ++st.renderSeq;
  const page = await st.doc.getPage(st.pageIndex + 1);
  if (seq !== st.renderSeq) return;
  const vp = page.getViewport({ scale: st.zoom });
  const dpr = window.devicePixelRatio || 1;
  stage.innerHTML = `<div class="cmk-sheet" style="width:${Math.ceil(vp.width)}px;height:${Math.ceil(vp.height)}px">
    <canvas data-cmk-pdf></canvas><canvas class="cmk-overlay cmk-tool-${st.tool}" data-cmk-overlay></canvas></div>`;
  const pdfCanvas = stage.querySelector<HTMLCanvasElement>("[data-cmk-pdf]")!;
  const ov = stage.querySelector<HTMLCanvasElement>("[data-cmk-overlay]")!;
  for (const c of [pdfCanvas, ov]) {
    c.width = Math.ceil(vp.width * dpr);
    c.height = Math.ceil(vp.height * dpr);
    c.style.width = `${Math.ceil(vp.width)}px`;
    c.style.height = `${Math.ceil(vp.height)}px`;
  }
  const [a, b, c, d, e, f] = vp.transform;
  st.viewport = [a!, b!, c!, d!, e!, f!];
  const ctx = pdfCanvas.getContext("2d");
  if (!ctx) { setStatus("This window cannot create a 2D canvas.", "error"); return; }
  try {
    await page.render({ canvas: pdfCanvas, canvasContext: ctx, viewport: vp, transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0] }).promise;
  } catch (err) {
    if (seq === st.renderSeq) setStatus(`pdf.js could not render page ${st.pageIndex + 1}: ${err instanceof Error ? err.message : String(err)}`, "error");
  }
  if (seq === st.renderSeq) { wireOverlay(ov); redraw(); }
}

// ── pointer tools ────────────────────────────────────────────────────────────

function cssPoint(cv: HTMLCanvasElement, e: PointerEvent): Pt {
  const r = cv.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

function newMarkup(kind: MarkupKind, over: Partial<Markup>): Markup {
  return {
    id: newMarkupId(), page: st.pageIndex, kind, color: st.color, width: st.width, rect: [0, 0, 0, 0], paths: [], text: "",
    fontSize: 12, author, modified: Date.now(), ...(kind === "cloud" ? { intensity: 1 } : {}), ...over,
  };
}

function commit(m: Markup): void {
  st.markups = [...st.markups, m];
  st.selectedId = "";
  st.dirty = true;
  st.status = "";
  paintBar();
  redraw();
}

function openTextInput(at: Pt): void {
  const pageEl = root?.querySelector<HTMLElement>(".cmk-sheet");
  if (!pageEl) return;
  pageEl.querySelector(".cmk-text-in")?.remove();
  const ta = document.createElement("textarea");
  ta.className = "cmk-text-in";
  ta.rows = 2;
  ta.placeholder = "Type, then Enter (Shift+Enter for a new line)";
  ta.style.left = `${at[0]}px`;
  ta.style.top = `${at[1]}px`;
  ta.style.color = st.color;
  pageEl.appendChild(ta);
  ta.focus();
  let done = false;
  const finish = (keep: boolean) => {
    if (done) return;
    done = true;
    const text = ta.value.replace(/\s+$/, "");
    ta.remove();
    if (!keep || !text) return;
    const fontSize = 12 + (st.width - 1) * 2;
    const pdfAt = canvasToPdf(st.viewport, at[0], at[1]);
    commit(newMarkup("text", { text, fontSize, width: 1, rect: freeTextRect(pdfAt, text, fontSize) }));
  };
  ta.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") finish(false);
    else if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); finish(true); }
  });
  ta.addEventListener("blur", () => finish(true));
}

function wireOverlay(cv: HTMLCanvasElement): void {
  cv.addEventListener("pointerdown", (e) => {
    if (!st.doc || st.busy) return;
    const p = cssPoint(cv, e);
    const pdf = canvasToPdf(st.viewport, p[0], p[1]);
    if (st.tool === "text") { e.preventDefault(); openTextInput(p); return; }
    try { cv.setPointerCapture(e.pointerId); } catch { /* a pointer the browser no longer tracks: the drag still works inside the canvas */ }
    if (st.tool === "select") {
      st.selectedId = hitTest(st.markups, st.pageIndex, pdf[0], pdf[1], 4 / st.zoom) ?? "";
      drag = st.selectedId ? { start: p, lastPdf: pdf, moving: st.selectedId } : null;
      paintBar();
      redraw();
      return;
    }
    drag = { start: p, lastPdf: pdf, moving: "" };
    draft = st.tool === "ink" ? newMarkup("ink", { paths: [[pdf]], rect: [pdf[0], pdf[1], pdf[0], pdf[1]] })
      : st.tool === "arrow" ? newMarkup("arrow", { paths: [[pdf, pdf]], rect: [pdf[0], pdf[1], pdf[0], pdf[1]] })
      : newMarkup(st.tool, { rect: [pdf[0], pdf[1], pdf[0], pdf[1]] });
  });
  cv.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const p = cssPoint(cv, e);
    const pdf = canvasToPdf(st.viewport, p[0], p[1]);
    if (drag.moving) {
      const dx = pdf[0] - drag.lastPdf[0], dy = pdf[1] - drag.lastPdf[1];
      drag.lastPdf = pdf;
      st.markups = st.markups.map((m) => (m.id === drag!.moving ? translateMarkup(m, dx, dy) : m));
      st.dirty = true;
      redraw();
      return;
    }
    if (!draft) return;
    if (draft.kind === "ink") draft = withBounds({ ...draft, paths: [[...draft.paths[0]!, pdf]] });
    else if (draft.kind === "arrow") draft = withBounds({ ...draft, paths: [[draft.paths[0]![0]!, pdf]] });
    else draft = { ...draft, rect: dragToPdfRect(st.viewport, drag.start, p) };
    redraw();
  });
  const end = () => {
    const d = draft;
    const moved = drag?.moving;
    draft = null;
    drag = null;
    if (moved) { paintBar(); return; }
    if (!d) return;
    const [x0, y0, x1, y1] = d.rect;
    // A click without a drag is not a markup (2 PDF points is below anything a reviewer means to draw).
    const tiny = d.kind === "ink" ? (d.paths[0]?.length ?? 0) < 2 : Math.max(x1 - x0, y1 - y0) < 2;
    if (tiny) { redraw(); return; }
    commit(d);
  };
  cv.addEventListener("pointerup", end);
  cv.addEventListener("pointercancel", end);
}

// ── file actions ─────────────────────────────────────────────────────────────

async function openPdf(file: File): Promise<void> {
  st.busy = `Opening ${file.name}...`;
  paintBar();
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const pdfjs = await loadPdfJs();
    // pdf.js transfers the buffer it is given, so it gets a copy and the original stays ours for saving.
    // pdf.js 6 has no eval path at all (the CSP's script-src 'self' needs none), so no isEvalSupported flag.
    const doc = await pdfjs.getDocument({ data: bytes.slice(), enableXfa: false, verbosity: 0 }).promise;
    await st.doc?.loadingTask.destroy();
    Object.assign(st, { bytes, fileName: file.name, doc, pageIndex: 0, pageCount: doc.numPages, markups: [], selectedId: "", dirty: false, busy: "" });
    setStatus(`Opened ${file.name}: ${doc.numPages} page${doc.numPages === 1 ? "" : "s"}. Existing annotations render as part of the page.`, "ok");
    await fitWidth();
  } catch (err) {
    st.busy = "";
    setStatus(`Could not open ${file.name}: ${err instanceof Error ? err.message : String(err)}`, "error");
  }
}

async function fitWidth(): Promise<void> {
  const stage = root?.querySelector<HTMLElement>("[data-cmk-stage]");
  if (!st.doc || !stage) return;
  const page = await st.doc.getPage(st.pageIndex + 1);
  const w = page.getViewport({ scale: 1 }).width;
  st.zoom = Math.max(0.25, Math.min(4, Math.floor(((stage.clientWidth - 24) / w) * 100) / 100 || 1));
  paintBar();
  await renderPage();
}

async function savePdf(): Promise<void> {
  if (!st.bytes) return;
  st.busy = "Writing annotations...";
  paintBar();
  try {
    // Lazy for the same reason as pdf.js: pdf-lib is only needed at the moment of saving.
    const { writeMarkupsToPdf } = await import("./creator_markup_pdf.ts");
    const out = await writeMarkupsToPdf(st.bytes, st.markups);
    download(out.slice(), `${baseName()}-markup.pdf`, "application/pdf"); // slice(): an ArrayBuffer-backed view, which BlobPart requires
    st.busy = "";
    st.dirty = false;
    setStatus(`Saved ${baseName()}-markup.pdf with ${st.markups.length} standard annotation${st.markups.length === 1 ? "" : "s"}.`, "ok");
  } catch (err) {
    st.busy = "";
    setStatus(`Save failed: ${err instanceof Error ? err.message : String(err)}`, "error");
  }
}

async function importXfdf(file: File): Promise<void> {
  try {
    const r = xfdfToMarkups(await file.text());
    const known = new Set(st.markups.map((m) => m.id));
    const fits = r.markups.filter((m) => m.page < st.pageCount && !known.has(m.id));
    const beyond = r.markups.filter((m) => m.page >= st.pageCount).length;
    st.markups = [...st.markups, ...fits];
    st.dirty = st.dirty || fits.length > 0;
    const notes = [
      `Imported ${fits.length} markup${fits.length === 1 ? "" : "s"} from ${file.name}.`,
      r.skipped.length ? `Not supported, skipped: ${r.skipped.join(", ")}.` : "",
      beyond ? `${beyond} pointed past the last page and were skipped.` : "",
    ].filter(Boolean).join(" ");
    setStatus(notes, r.skipped.length || beyond ? "" : "ok");
    redraw();
  } catch (err) {
    setStatus(`XFDF import failed: ${err instanceof Error ? err.message : String(err)}`, "error");
  }
}

function deleteSelected(): void {
  if (!st.selectedId) return;
  st.markups = st.markups.filter((m) => m.id !== st.selectedId);
  st.selectedId = "";
  st.dirty = true;
  paintBar();
  redraw();
}

function onClick(e: MouseEvent): void {
  const t = e.target as HTMLElement;
  const tool = t.closest<HTMLElement>("[data-cmk-tool]");
  if (tool) {
    st.tool = MARKUP_TOOLS.find((x) => x === tool.dataset.cmkTool) ?? st.tool;
    if (st.tool !== "select") st.selectedId = "";
    const ov = overlay();
    if (ov) ov.className = `cmk-overlay cmk-tool-${st.tool}`;
    paintBar();
    redraw();
    return;
  }
  if (t.closest("[data-cmk-open]")) { root?.querySelector<HTMLInputElement>("[data-cmk-file]")?.click(); return; }
  if (t.closest("[data-cmk-xfdf-import]")) { root?.querySelector<HTMLInputElement>("[data-cmk-xfdf-file]")?.click(); return; }
  if (t.closest("[data-cmk-save]")) { void savePdf(); return; }
  if (t.closest("[data-cmk-xfdf-export]")) {
    download(markupsToXfdf(st.markups, st.fileName), `${baseName()}.xfdf`, "application/vnd.adobe.xfdf");
    setStatus(`Exported ${st.markups.length} markup${st.markups.length === 1 ? "" : "s"} as XFDF (ISO 19444-1).`, "ok");
    return;
  }
  if (t.closest("[data-cmk-delete]")) { deleteSelected(); return; }
  if (t.closest("[data-cmk-prev]") && st.pageIndex > 0) { st.pageIndex--; st.selectedId = ""; paintBar(); void renderPage(); return; }
  if (t.closest("[data-cmk-next]") && st.pageIndex < st.pageCount - 1) { st.pageIndex++; st.selectedId = ""; paintBar(); void renderPage(); return; }
  if (t.closest("[data-cmk-zoom-in]")) { st.zoom = ZOOMS.find((z) => z > st.zoom + 0.001) ?? st.zoom; paintBar(); void renderPage(); return; }
  if (t.closest("[data-cmk-zoom-out]")) { st.zoom = [...ZOOMS].reverse().find((z) => z < st.zoom - 0.001) ?? st.zoom; paintBar(); void renderPage(); return; }
  if (t.closest("[data-cmk-fit]")) { void fitWidth(); }
}

function onChange(e: Event): void {
  const t = e.target as HTMLInputElement;
  if (t.matches("[data-cmk-file]") && t.files?.[0]) { void openPdf(t.files[0]); t.value = ""; return; }
  if (t.matches("[data-cmk-xfdf-file]") && t.files?.[0]) { void importXfdf(t.files[0]); t.value = ""; return; }
  if (t.matches("[data-cmk-color]")) { st.color = t.value; return; }
  if (t.matches("[data-cmk-width]")) st.width = Number(t.value) || 2;
}

// Delete / Backspace removes the selection while the pane is on screen and no field has focus.
document.addEventListener("keydown", (e) => {
  if (!root?.isConnected || !st.selectedId) return;
  if (e.key !== "Delete" && e.key !== "Backspace") return;
  const el = document.activeElement;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return;
  e.preventDefault();
  deleteSelected();
});

/** Attach to a freshly painted `creatorMarkupHtml()` and restore the open document, if any. */
export function mountMarkupPane(host: HTMLElement): void {
  const el = host.querySelector<HTMLElement>("[data-cmk-root]");
  if (!el) return;
  root = el;
  el.addEventListener("click", onClick);
  el.addEventListener("change", onChange);
  paintBar();
  if (st.doc) void renderPage();
}
