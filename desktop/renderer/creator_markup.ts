// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/creator_markup.ts - the PDF markup pane's pure core (no DOM, no pdf.js, no pdf-lib).
//
// Everything the Markup pane needs that can be proven without a browser lives here:
//
//   * GEOMETRY. A markup is stored in PDF user space (points, y up), never in canvas pixels, so a zoom or a
//     page re-render never moves it. The pane converts with the SAME matrix pdf.js renders with
//     (`viewport.transform`), inverted here.
//   * APPEARANCE STREAMS. Every annotation the writer emits carries its own /AP /N form, built here as plain
//     PDF content-stream text, so a viewer that does not synthesize appearances still draws exactly what the
//     user drew. Bluebeam Revu reads the standard keys (/Subtype, /C, /BS, /BE, /LE, /InkList, /DA,
//     /QuadPoints) and regenerates its own appearance anyway.
//   * XFDF (ISO 19444-1). Serialize and parse, including a small XML reader so import never depends on a
//     browser DOMParser and is unit-tested under bun. No entity expansion beyond the five XML entities and
//     numeric references (no DTD, no external entities).
//
// Bluebeam BAX is deliberately absent: its schema is undocumented, so the pane says "not supported" rather
// than guessing a format a reviewer would then trust.

import { esc } from "./format.ts";
import { icon } from "./icons.ts";

// ── model ────────────────────────────────────────────────────────────────────

export type Pt = readonly [number, number];
/** [llx, lly, urx, ury] in PDF user space, always normalized (ll <= ur). */
export type Rect = readonly [number, number, number, number];
/** A pdf.js viewport transform: canvas = [a c e; b d f] * [x y 1]. */
export type Matrix = readonly [number, number, number, number, number, number];

export type MarkupKind = "rect" | "cloud" | "ellipse" | "arrow" | "ink" | "text" | "highlight";
export type MarkupTool = "select" | MarkupKind;
export const MARKUP_TOOLS: readonly MarkupTool[] = ["select", "rect", "cloud", "ellipse", "arrow", "ink", "text", "highlight"];

export interface Markup {
  /** Stable unique name, written as /NM and XFDF `name`. */
  readonly id: string;
  /** 0-based page index (XFDF `page` is 0-based too). */
  readonly page: number;
  readonly kind: MarkupKind;
  /** #rrggbb */
  readonly color: string;
  /** Stroke width in PDF points. */
  readonly width: number;
  /** The drawn geometry: for rect/cloud/ellipse the path rectangle (stroke centre line); for text and
   *  highlight the box; for arrow/ink the bounds of the points (recomputed by `withBounds`). */
  readonly rect: Rect;
  /** arrow: one path [start, end]; ink: one path per stroke; empty otherwise. */
  readonly paths: readonly (readonly Pt[])[];
  /** FreeText contents, or a note carried on any other markup. */
  readonly text: string;
  readonly fontSize: number;
  readonly author: string;
  /** Epoch ms of the last edit. */
  readonly modified: number;
  /** Cloud intensity (/BE /I), 1 or 2. */
  readonly intensity?: number;
  /** Line endings [start, end] for arrows. Default ["None", "OpenArrow"]. */
  readonly lineEndings?: readonly [string, string];
  /** Highlight quads (8 numbers each), preserved from an import. Default: one quad from `rect`. */
  readonly quads?: readonly number[];
}

export const MARKUP_SUBJECT: Record<MarkupKind, string> = {
  rect: "Rectangle", cloud: "Cloud", ellipse: "Ellipse", arrow: "Arrow", ink: "Pen", text: "Text Box", highlight: "Highlight",
};
export const MARKUP_SUBTYPE: Record<MarkupKind, string> = {
  rect: "Square", cloud: "Square", ellipse: "Circle", arrow: "Line", ink: "Ink", text: "FreeText", highlight: "Highlight",
};

export function newMarkupId(): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return `lucid-${[...b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}

// ── numbers, colors, dates ───────────────────────────────────────────────────

/** A PDF/XFDF number: at most 3 decimals, no trailing zeros, never "-0" or exponent notation. */
export function num(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const r = Math.round(n * 1000) / 1000;
  if (Object.is(r, -0) || r === 0) return "0";
  return r.toFixed(3).replace(/\.?0+$/, "");
}

export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [1, 0, 0];
  const v = parseInt(m[1]!, 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

export function rgbToHex(r: number, g: number, b: number): string {
  const c = (x: number) => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`.toUpperCase();
}

const pad2 = (n: number) => String(n).padStart(2, "0");
/** PDF date string in UTC: D:YYYYMMDDHHmmSSZ */
export function pdfDate(ms: number): string {
  const d = new Date(ms);
  return `D:${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}Z`;
}

/** Parse a PDF date (D:YYYYMMDDHHmmSS with optional Z / +HH'mm'). Null when unreadable. */
export function parsePdfDate(s: string): number | null {
  const m = /^D?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(Z|[+-]\d{2}'?\d{2}'?)?/.exec(s.trim());
  if (!m) return null;
  const [y, mo = "01", d = "01", h = "00", mi = "00", se = "00"] = m.slice(1, 7) as string[];
  let ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(se));
  const tz = m[7];
  if (tz && tz !== "Z") {
    const sign = tz[0] === "-" ? -1 : 1;
    const digits = tz.replace(/[^0-9]/g, "");
    const off = (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4) || "0")) * 60_000;
    ms -= sign * off;
  }
  return Number.isFinite(ms) ? ms : null;
}

// ── geometry ─────────────────────────────────────────────────────────────────

export function applyMatrix(m: Matrix, x: number, y: number): Pt {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export function invertMatrix(m: Matrix): Matrix {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (!det) throw new Error("singular viewport transform");
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

/** Canvas pixel (CSS px of the rendered page) to PDF user space, for a pdf.js viewport transform. */
export function canvasToPdf(viewport: Matrix, cx: number, cy: number): Pt {
  return applyMatrix(invertMatrix(viewport), cx, cy);
}

export function pdfToCanvas(viewport: Matrix, px: number, py: number): Pt {
  return applyMatrix(viewport, px, py);
}

export function normRect(x1: number, y1: number, x2: number, y2: number): Rect {
  return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
}

/** Two canvas points (a drag) to a normalized PDF rectangle. Works for every page rotation, because both
 *  corners go through the inverse viewport transform before normalizing. */
export function dragToPdfRect(viewport: Matrix, a: Pt, b: Pt): Rect {
  const p = canvasToPdf(viewport, a[0], a[1]);
  const q = canvasToPdf(viewport, b[0], b[1]);
  return normRect(p[0], p[1], q[0], q[1]);
}

export function expandRect(r: Rect, by: number): Rect {
  return [r[0] - by, r[1] - by, r[2] + by, r[3] + by];
}

export function boundsOf(points: readonly Pt[]): Rect {
  if (!points.length) return [0, 0, 0, 0];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of points) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return [x0, y0, x1, y1];
}

/** Recompute `rect` from `paths` for the point-based kinds. */
export function withBounds(m: Markup): Markup {
  if (m.kind !== "arrow" && m.kind !== "ink") return m;
  return { ...m, rect: boundsOf(m.paths.flat()) };
}

export function translateMarkup(m: Markup, dx: number, dy: number): Markup {
  const r = m.rect;
  return {
    ...m,
    rect: [r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy],
    paths: m.paths.map((p) => p.map(([x, y]) => [x + dx, y + dy] as Pt)),
    quads: m.quads?.map((v, i) => v + (i % 2 === 0 ? dx : dy)),
  };
}

/** Arrow head geometry for an OpenArrow at `tip` coming from `from`. */
export function arrowHead(from: Pt, tip: Pt, width: number): [Pt, Pt] {
  const len = Math.max(8, width * 4);
  const ang = Math.atan2(tip[1] - from[1], tip[0] - from[0]);
  const spread = Math.PI / 7;
  return [
    [tip[0] - len * Math.cos(ang - spread), tip[1] - len * Math.sin(ang - spread)],
    [tip[0] - len * Math.cos(ang + spread), tip[1] - len * Math.sin(ang + spread)],
  ];
}

export const DEFAULT_LINE_ENDINGS: readonly [string, string] = ["None", "OpenArrow"];

/** The cloud's bump radius for a given intensity and stroke width (PDF points). */
export function cloudRadius(intensity: number, width: number): number {
  return 4 * Math.max(1, Math.min(2, intensity)) + width;
}

/** The /Rect an annotation occupies on the page, and the /RD inset back to the drawn geometry. */
export function annotationRect(m: Markup): { rect: Rect; rd: number } {
  const half = m.width / 2;
  switch (m.kind) {
    case "rect":
    case "ellipse":
      return { rect: expandRect(m.rect, half), rd: half };
    case "cloud": {
      const d = cloudRadius(m.intensity ?? 1, m.width) + half;
      return { rect: expandRect(m.rect, d), rd: d };
    }
    case "arrow": {
      const p = m.paths[0] ?? [];
      const pts: Pt[] = [...p];
      if (p.length >= 2) {
        const ends = m.lineEndings ?? DEFAULT_LINE_ENDINGS;
        if (ends[1] !== "None") pts.push(...arrowHead(p[p.length - 2]!, p[p.length - 1]!, m.width));
        if (ends[0] !== "None") pts.push(...arrowHead(p[1]!, p[0]!, m.width));
      }
      return { rect: expandRect(boundsOf(pts), half + 1), rd: 0 };
    }
    case "ink":
      return { rect: expandRect(boundsOf(m.paths.flat()), half + 1), rd: 0 };
    case "text":
    case "highlight":
      return { rect: m.rect, rd: 0 };
  }
}

/** One cubic segment: from the previous point through c1, c2 to `to`. */
export interface Cubic { readonly c1: Pt; readonly c2: Pt; readonly to: Pt }

const KAPPA = 0.5522847498;

/** A scalloped cloud around `r`: outward semicircles walked counter-clockwise (PDF space, y up). Returns
 *  the start point and the cubic segments; the same path draws the overlay and the /AP stream. */
export function cloudPath(r: Rect, intensity: number, width: number): { start: Pt; segs: Cubic[] } {
  const radius = cloudRadius(intensity, width);
  const corners: Pt[] = [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]];
  const segs: Cubic[] = [];
  for (let s = 0; s < 4; s++) {
    const a = corners[s]!, b = corners[(s + 1) % 4]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.round(len / (radius * 2)));
    const ux = len ? (b[0] - a[0]) / len : 1, uy = len ? (b[1] - a[1]) / len : 0;
    const nx = uy, ny = -ux; // outward normal for a counter-clockwise walk
    for (let i = 0; i < n; i++) {
      const p: Pt = [a[0] + (b[0] - a[0]) * (i / n), a[1] + (b[1] - a[1]) * (i / n)];
      const q: Pt = [a[0] + (b[0] - a[0]) * ((i + 1) / n), a[1] + (b[1] - a[1]) * ((i + 1) / n)];
      const rr = Math.hypot(q[0] - p[0], q[1] - p[1]) / 2;
      const c: Pt = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
      const apex: Pt = [c[0] + nx * rr, c[1] + ny * rr];
      const k = KAPPA * rr;
      segs.push({ c1: [p[0] + nx * k, p[1] + ny * k], c2: [apex[0] - ux * k, apex[1] - uy * k], to: apex });
      segs.push({ c1: [apex[0] + ux * k, apex[1] + uy * k], c2: [q[0] + nx * k, q[1] + ny * k], to: q });
    }
  }
  return { start: corners[0]!, segs };
}

/** Four cubics approximating the ellipse inscribed in `r`, starting at the right-middle point. */
export function ellipsePath(r: Rect): { start: Pt; segs: Cubic[] } {
  const cx = (r[0] + r[2]) / 2, cy = (r[1] + r[3]) / 2;
  const rx = (r[2] - r[0]) / 2, ry = (r[3] - r[1]) / 2;
  const kx = rx * KAPPA, ky = ry * KAPPA;
  return {
    start: [cx + rx, cy],
    segs: [
      { c1: [cx + rx, cy + ky], c2: [cx + kx, cy + ry], to: [cx, cy + ry] },
      { c1: [cx - kx, cy + ry], c2: [cx - rx, cy + ky], to: [cx - rx, cy] },
      { c1: [cx - rx, cy - ky], c2: [cx - kx, cy - ry], to: [cx, cy - ry] },
      { c1: [cx + kx, cy - ry], c2: [cx + rx, cy - ky], to: [cx + rx, cy] },
    ],
  };
}

/** The box a FreeText of `text` at `fontSize` needs, anchored at its top-left corner `at` (PDF space). */
export function freeTextRect(at: Pt, text: string, fontSize: number): Rect {
  const lines = text.split(/\r?\n/);
  const longest = Math.max(1, ...lines.map((l) => l.length));
  const w = longest * fontSize * 0.56 + 8;
  const h = lines.length * fontSize * 1.2 + 6;
  return [at[0], at[1] - h, at[0] + w, at[1]];
}

/** The highlight's quad points (UL, UR, LL, LR per quad, the order Acrobat and Revu write). */
export function highlightQuads(m: Markup): number[] {
  if (m.quads && m.quads.length >= 8 && m.quads.length % 8 === 0) return [...m.quads];
  const [x0, y0, x1, y1] = m.rect;
  return [x0, y1, x1, y1, x0, y0, x1, y0];
}

/** Topmost markup on `page` whose drawn bounds contain (x, y) within `tol` PDF points. */
export function hitTest(markups: readonly Markup[], page: number, x: number, y: number, tol: number): string | null {
  for (let i = markups.length - 1; i >= 0; i--) {
    const m = markups[i]!;
    if (m.page !== page) continue;
    const r = annotationRect(m).rect;
    if (x >= r[0] - tol && x <= r[2] + tol && y >= r[1] - tol && y <= r[3] + tol) return m.id;
  }
  return null;
}

// ── appearance streams (PDF content-stream text, in page space; BBox = /Rect) ──

/** A WinAnsi-safe PDF literal string body: escapes \ ( ) and replaces anything outside Latin-1 with "?". */
export function pdfLiteral(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === "\\" || ch === "(" || ch === ")") out += `\\${ch}`;
    else if ((c >= 32 && c <= 126) || (c >= 160 && c <= 255)) out += ch;
    else out += "?";
  }
  return out;
}

const pathOps = (start: Pt, segs: readonly Cubic[]) =>
  `${num(start[0])} ${num(start[1])} m\n${segs.map((s) => `${num(s.c1[0])} ${num(s.c1[1])} ${num(s.c2[0])} ${num(s.c2[1])} ${num(s.to[0])} ${num(s.to[1])} c`).join("\n")}\nh\n`;

/** The /AP /N content stream for a markup, plus which resources it needs. */
export function appearanceContent(m: Markup): { content: string; font: boolean; multiply: boolean } {
  const [r, g, b] = hexToRgb(m.color);
  const stroke = `${num(r)} ${num(g)} ${num(b)} RG\n`;
  const fill = `${num(r)} ${num(g)} ${num(b)} rg\n`;
  const w = `${num(m.width)} w\n`;
  switch (m.kind) {
    case "rect": {
      const [x0, y0, x1, y1] = m.rect;
      return { content: `q\n${w}${stroke}${num(x0)} ${num(y0)} ${num(x1 - x0)} ${num(y1 - y0)} re\nS\nQ\n`, font: false, multiply: false };
    }
    case "ellipse": {
      const p = ellipsePath(m.rect);
      return { content: `q\n${w}${stroke}${pathOps(p.start, p.segs)}S\nQ\n`, font: false, multiply: false };
    }
    case "cloud": {
      const p = cloudPath(m.rect, m.intensity ?? 1, m.width);
      return { content: `q\n${w}1 j\n${stroke}${pathOps(p.start, p.segs)}S\nQ\n`, font: false, multiply: false };
    }
    case "arrow": {
      const p = m.paths[0] ?? [];
      if (p.length < 2) return { content: "", font: false, multiply: false };
      const ends = m.lineEndings ?? DEFAULT_LINE_ENDINGS;
      let ops = `q\n${w}1 J 1 j\n${stroke}${num(p[0]![0])} ${num(p[0]![1])} m\n`;
      for (const pt of p.slice(1)) ops += `${num(pt[0])} ${num(pt[1])} l\n`;
      ops += "S\n";
      const head = (from: Pt, tip: Pt) => {
        const [h1, h2] = arrowHead(from, tip, m.width);
        return `${num(h1[0])} ${num(h1[1])} m\n${num(tip[0])} ${num(tip[1])} l\n${num(h2[0])} ${num(h2[1])} l\nS\n`;
      };
      if (ends[1] !== "None") ops += head(p[p.length - 2]!, p[p.length - 1]!);
      if (ends[0] !== "None") ops += head(p[1]!, p[0]!);
      return { content: `${ops}Q\n`, font: false, multiply: false };
    }
    case "ink": {
      let ops = `q\n${w}1 J 1 j\n${stroke}`;
      for (const path of m.paths) {
        if (!path.length) continue;
        ops += `${num(path[0]![0])} ${num(path[0]![1])} m\n`;
        for (const pt of path.slice(1)) ops += `${num(pt[0])} ${num(pt[1])} l\n`;
        if (path.length === 1) ops += `${num(path[0]![0])} ${num(path[0]![1])} l\n`;
        ops += "S\n";
      }
      return { content: `${ops}Q\n`, font: false, multiply: false };
    }
    case "text": {
      const [x0, y0, x1, y1] = m.rect;
      const fs = m.fontSize;
      const lines = m.text.split(/\r?\n/);
      let ops = "q\n";
      if (m.width > 0) ops += `${w}${stroke}${num(x0 + m.width / 2)} ${num(y0 + m.width / 2)} ${num(x1 - x0 - m.width)} ${num(y1 - y0 - m.width)} re\nS\n`;
      ops += `BT\n/Helv ${num(fs)} Tf\n${fill}${num(fs * 1.2)} TL\n${num(x0 + 4)} ${num(y1 - 3 - fs)} Td\n`;
      lines.forEach((line, i) => { ops += `${i ? "T* " : ""}(${pdfLiteral(line)}) Tj\n`; });
      ops += "ET\nQ\n";
      return { content: ops, font: true, multiply: false };
    }
    case "highlight": {
      const q = highlightQuads(m);
      let ops = `q\n/GS0 gs\n${fill}`;
      for (let i = 0; i + 7 < q.length; i += 8) {
        // UL, UR, LL, LR -> a closed polygon UL UR LR LL
        ops += `${num(q[i]!)} ${num(q[i + 1]!)} m\n${num(q[i + 2]!)} ${num(q[i + 3]!)} l\n${num(q[i + 6]!)} ${num(q[i + 7]!)} l\n${num(q[i + 4]!)} ${num(q[i + 5]!)} l\nh\nf\n`;
      }
      return { content: `${ops}Q\n`, font: false, multiply: true };
    }
  }
}

/** The FreeText default appearance string (/DA). */
export function freeTextDA(m: Markup): string {
  const [r, g, b] = hexToRgb(m.color);
  return `/Helv ${num(m.fontSize)} Tf ${num(r)} ${num(g)} ${num(b)} rg`;
}

// ── XFDF (ISO 19444-1) ───────────────────────────────────────────────────────

const xmlEsc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
const nums = (xs: readonly number[]) => xs.map(num).join(",");

/** Serialize markups as an XFDF document. `href` names the PDF the annotations belong to. */
export function markupsToXfdf(markups: readonly Markup[], href: string): string {
  const out: string[] = [];
  for (const m of markups) {
    const { rect, rd } = annotationRect(m);
    const date = pdfDate(m.modified);
    // FreeText's `color` (/C) is the BOX FILL in Acrobat and Revu, so a text box carries its colour in the
    // default appearance only; writing it as `color` too would paint red text on a red box.
    const colorAttr = m.kind === "text" ? "" : ` color="${m.color.toUpperCase()}"`;
    const common = `page="${m.page}" rect="${nums(rect)}"${colorAttr} width="${num(m.width)}" name="${xmlEsc(m.id)}" title="${xmlEsc(m.author)}" subject="${xmlEsc(MARKUP_SUBJECT[m.kind])}" date="${date}" creationdate="${date}" flags="print"`;
    const contents = m.text ? `<contents>${xmlEsc(m.text)}</contents>` : "";
    switch (m.kind) {
      case "rect":
        out.push(`<square ${common} fringe="${nums([rd, rd, rd, rd])}">${contents}</square>`);
        break;
      case "cloud":
        out.push(`<square ${common} style="cloudy" intensity="${num(m.intensity ?? 1)}" fringe="${nums([rd, rd, rd, rd])}">${contents}</square>`);
        break;
      case "ellipse":
        out.push(`<circle ${common} fringe="${nums([rd, rd, rd, rd])}">${contents}</circle>`);
        break;
      case "arrow": {
        const p = m.paths[0] ?? [];
        const a = p[0] ?? [rect[0], rect[1]], b = p[p.length - 1] ?? [rect[2], rect[3]];
        const ends = m.lineEndings ?? DEFAULT_LINE_ENDINGS;
        out.push(`<line ${common} start="${nums(a)}" end="${nums(b)}" head="${xmlEsc(ends[0])}" tail="${xmlEsc(ends[1])}">${contents}</line>`);
        break;
      }
      case "ink":
        out.push(`<ink ${common}><inklist>${m.paths.map((p) => `<gesture>${p.map((pt) => nums(pt)).join(";")}</gesture>`).join("")}</inklist>${contents}</ink>`);
        break;
      case "text":
        out.push(`<freetext ${common}>${contents}<defaultappearance>${xmlEsc(freeTextDA(m))}</defaultappearance></freetext>`);
        break;
      case "highlight":
        out.push(`<highlight ${common} coords="${nums(highlightQuads(m))}">${contents}</highlight>`);
        break;
    }
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<xfdf xmlns="http://ns.adobe.com/xfdf/" xml:space="preserve">\n<f href="${xmlEsc(href)}"/>\n<annots>\n${out.join("\n")}\n</annots>\n</xfdf>\n`;
}

export interface XmlNode { name: string; attrs: Record<string, string>; children: XmlNode[]; text: string }

const XML_ENT: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
    }
    return XML_ENT[e] ?? all;
  });
}
const localName = (n: string) => n.slice(n.indexOf(":") + 1).toLowerCase();

/** A small, strict-enough XML reader for XFDF: elements, attributes, text, CDATA. Comments, processing
 *  instructions and DOCTYPE are skipped (no entity definitions are honoured). Throws on malformed input. */
export function parseXml(src: string): XmlNode {
  if (src.length > 50 * 1024 * 1024) throw new Error("XFDF file is larger than 50 MB");
  const root: XmlNode = { name: "#root", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    const top = stack[stack.length - 1]!;
    if (lt < 0) { top.text += decodeXml(src.slice(i)); break; }
    if (lt > i) top.text += decodeXml(src.slice(i, lt));
    if (src.startsWith("<!--", lt)) { const e = src.indexOf("-->", lt + 4); if (e < 0) throw new Error("unterminated comment"); i = e + 3; continue; }
    if (src.startsWith("<![CDATA[", lt)) { const e = src.indexOf("]]>", lt + 9); if (e < 0) throw new Error("unterminated CDATA"); top.text += src.slice(lt + 9, e); i = e + 3; continue; }
    if (src.startsWith("<?", lt)) { const e = src.indexOf("?>", lt + 2); if (e < 0) throw new Error("unterminated processing instruction"); i = e + 2; continue; }
    if (src.startsWith("<!", lt)) {
      // DOCTYPE (possibly with an internal subset): skipped, its entities are never expanded.
      let depth = 0, j = lt + 2;
      for (; j < src.length; j++) { const ch = src[j]; if (ch === "[") depth++; else if (ch === "]") depth--; else if (ch === ">" && depth <= 0) break; }
      i = j + 1;
      continue;
    }
    if (src[lt + 1] === "/") {
      const e = src.indexOf(">", lt);
      if (e < 0) throw new Error("unterminated end tag");
      const name = localName(src.slice(lt + 2, e).trim());
      if (stack.length < 2 || top.name !== name) throw new Error(`mismatched </${name}>`);
      stack.pop();
      i = e + 1;
      continue;
    }
    // start tag: scan to the closing '>' outside quotes
    let j = lt + 1, quote = "";
    for (; j < src.length; j++) {
      const ch = src[j]!;
      if (quote) { if (ch === quote) quote = ""; } else if (ch === '"' || ch === "'") quote = ch; else if (ch === ">") break;
    }
    if (j >= src.length) throw new Error("unterminated start tag");
    let body = src.slice(lt + 1, j);
    const selfClose = body.endsWith("/");
    if (selfClose) body = body.slice(0, -1);
    const nm = /^\s*([^\s/>]+)/.exec(body);
    if (!nm) throw new Error("element without a name");
    const node: XmlNode = { name: localName(nm[1]!), attrs: {}, children: [], text: "" };
    const attrRe = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let am: RegExpExecArray | null;
    const rest = body.slice(nm[0].length);
    while ((am = attrRe.exec(rest))) node.attrs[localName(am[1]!)] = decodeXml(am[3] ?? am[4] ?? "");
    top.children.push(node);
    if (!selfClose) stack.push(node);
    i = j + 1;
  }
  if (stack.length !== 1) throw new Error(`unclosed <${stack[stack.length - 1]!.name}>`);
  return root;
}

const child = (n: XmlNode, name: string) => n.children.find((c) => c.name === name);
const floats = (s: string | undefined): number[] =>
  (s ?? "").split(/[\s,;]+/).filter(Boolean).map(Number).filter((v) => Number.isFinite(v));
const rectAttr = (s: string | undefined): Rect | null => {
  const v = floats(s);
  return v.length >= 4 ? normRect(v[0]!, v[1]!, v[2]!, v[3]!) : null;
};
const ptAttr = (s: string | undefined): Pt | null => {
  const v = floats(s);
  return v.length >= 2 ? [v[0]!, v[1]!] : null;
};
function richText(n: XmlNode | undefined): string {
  if (!n) return "";
  const parts: string[] = [];
  const walk = (x: XmlNode, isBlock: boolean) => {
    if (x.text) parts.push(x.text);
    for (const c of x.children) walk(c, c.name === "p");
    if (isBlock) parts.push("\n");
  };
  walk(n, false);
  return parts.join("").replace(/\n+$/, "").trim();
}

export interface XfdfImport { markups: Markup[]; skipped: string[]; href: string }

/** Parse an XFDF document into markups. Unknown annotation types are named in `skipped`, never guessed. */
export function xfdfToMarkups(xml: string, now = Date.now()): XfdfImport {
  const root = parseXml(xml);
  const xfdf = child(root, "xfdf");
  if (!xfdf) throw new Error("not an XFDF document (no <xfdf> root)");
  const href = child(xfdf, "f")?.attrs.href ?? "";
  const annots = child(xfdf, "annots");
  const markups: Markup[] = [];
  const skipped: string[] = [];
  for (const a of annots?.children ?? []) {
    const page = Math.max(0, Math.trunc(Number(a.attrs.page ?? "0")) || 0);
    const outer = rectAttr(a.attrs.rect);
    const width = Number(a.attrs.width ?? "1");
    const w = Number.isFinite(width) && width >= 0 ? width : 1;
    const color = /^#[0-9a-f]{6}$/i.test(a.attrs.color ?? "") ? a.attrs.color!.toUpperCase() : "#FF0000";
    const base = {
      id: a.attrs.name || newMarkupId(),
      page,
      color,
      width: w,
      text: richText(child(a, "contents")) || richText(child(a, "contents-richtext")),
      fontSize: 12,
      author: a.attrs.title ?? "",
      modified: parsePdfDate(a.attrs.date ?? "") ?? now,
    };
    const fringe = floats(a.attrs.fringe);
    const inset = (r: Rect, fallback: number): Rect => fringe.length >= 4
      ? normRect(r[0] + fringe[0]!, r[1] + fringe[1]!, r[2] - fringe[2]!, r[3] - fringe[3]!)
      : expandRect(r, -fallback);
    switch (a.name) {
      case "square":
      case "circle": {
        if (!outer) { skipped.push(`${a.name} without a rect`); break; }
        const cloudy = (a.attrs.style ?? "").toLowerCase() === "cloudy" && a.name === "square";
        const intensity = Math.max(1, Math.min(2, Number(a.attrs.intensity ?? "1") || 1));
        const kind: MarkupKind = a.name === "circle" ? "ellipse" : cloudy ? "cloud" : "rect";
        const fallback = cloudy ? cloudRadius(intensity, w) + w / 2 : w / 2;
        markups.push({ ...base, kind, rect: inset(outer, fallback), paths: [], ...(cloudy ? { intensity } : {}) });
        break;
      }
      case "line": {
        const s = ptAttr(a.attrs.start), e = ptAttr(a.attrs.end);
        if (!s || !e) { skipped.push("line without start/end"); break; }
        const ends: [string, string] = [a.attrs.head || "None", a.attrs.tail || "None"];
        markups.push({ ...base, kind: "arrow", paths: [[s, e]], rect: boundsOf([s, e]), lineEndings: ends });
        break;
      }
      case "ink": {
        const gestures = (child(a, "inklist")?.children ?? []).filter((g) => g.name === "gesture");
        const paths = gestures.map((g) => g.text.split(";").map((pair) => ptAttr(pair)).filter((p): p is Pt => !!p)).filter((p) => p.length);
        if (!paths.length) { skipped.push("ink without gestures"); break; }
        markups.push({ ...base, kind: "ink", paths, rect: boundsOf(paths.flat()) });
        break;
      }
      case "freetext": {
        if (!outer) { skipped.push("freetext without a rect"); break; }
        const da = child(a, "defaultappearance")?.text ?? "";
        const fs = /([\d.]+)\s+Tf/.exec(da);
        const rg = /([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg/.exec(da);
        const fontSize = fs ? Math.max(4, Math.min(144, Number(fs[1]))) : 12;
        // The text colour lives in the default appearance; `color` on a freetext is its box fill.
        const textColor = rg ? rgbToHex(Number(rg[1]), Number(rg[2]), Number(rg[3])) : color;
        markups.push({ ...base, kind: "text", color: textColor, rect: outer, paths: [], fontSize });
        break;
      }
      case "highlight": {
        const q = floats(a.attrs.coords);
        const quads = q.length >= 8 ? q.slice(0, q.length - (q.length % 8)) : undefined;
        const pts: Pt[] = [];
        for (let k = 0; quads && k + 1 < quads.length; k += 2) pts.push([quads[k]!, quads[k + 1]!]);
        const rect = pts.length ? boundsOf(pts) : outer;
        if (!rect) { skipped.push("highlight without coords"); break; }
        markups.push({ ...base, kind: "highlight", rect, paths: [], ...(quads ? { quads } : {}) });
        break;
      }
      default:
        skipped.push(a.name);
    }
  }
  return { markups, skipped, href };
}

// ── the pane (pure HTML) ─────────────────────────────────────────────────────

export interface MarkupPaneView {
  readonly fileName: string;
  readonly hasDoc: boolean;
  readonly pageIndex: number;
  readonly pageCount: number;
  readonly zoom: number;
  readonly tool: MarkupTool;
  readonly color: string;
  readonly width: number;
  readonly markupCount: number;
  readonly selected: boolean;
  readonly dirty: boolean;
  readonly busy: string;
  readonly status: string;
  readonly statusTone: "" | "ok" | "error";
}

const TOOL_LABEL: Record<MarkupTool, { label: string; ic: string; tip: string }> = {
  select: { label: "Select", ic: "move", tip: "Select|Click a markup to select it, drag to move it, Delete to remove it." },
  rect: { label: "Rectangle", ic: "square", tip: "Rectangle|Drag to draw a /Square annotation." },
  cloud: { label: "Cloud", ic: "markup", tip: "Cloud|Drag to draw a revision cloud (/Square with a cloudy /BE border effect)." },
  ellipse: { label: "Ellipse", ic: "center", tip: "Ellipse|Drag to draw a /Circle annotation." },
  arrow: { label: "Arrow", ic: "arrowRight", tip: "Arrow|Drag from tail to tip: a /Line with an /OpenArrow ending." },
  ink: { label: "Freehand", ic: "pen", tip: "Freehand|Draw with the pointer: an /Ink annotation." },
  text: { label: "Text", ic: "textT", tip: "Text|Click where the text box goes: a /FreeText annotation." },
  highlight: { label: "Highlight", ic: "eye", tip: "Highlight|Drag over a region: a /Highlight annotation (multiply blend)." },
};

/** The Markup toolbar + status line. The stage (canvases) is owned by the controller, never re-rendered. */
export function markupBarHtml(v: MarkupPaneView): string {
  const dis = v.hasDoc && !v.busy ? "" : " disabled";
  const tools = MARKUP_TOOLS.map((t) => {
    const d = TOOL_LABEL[t];
    return `<button type="button" class="cmk-tool${v.tool === t ? " on" : ""}" data-cmk-tool="${t}" aria-label="${esc(d.label)}" data-tip="${esc(d.tip)}"${dis}>${icon(d.ic, 13)}<span>${esc(d.label)}</span></button>`;
  }).join("");
  const widths = [1, 2, 3, 5, 8].map((n) => `<option value="${n}"${n === v.width ? " selected" : ""}>${n} pt</option>`).join("");
  const page = v.hasDoc ? `${v.pageIndex + 1} / ${v.pageCount}` : "- / -";
  const status = v.busy || v.status;
  return `<div class="cmk-bar-row">
      <button type="button" class="btn-mini ok" data-cmk-open${v.busy ? " disabled" : ""}>${icon("folder", 12)} Open PDF</button>
      <span class="cmk-file" title="${esc(v.fileName)}">${esc(v.fileName || "No PDF open")}</span>
      ${v.dirty ? `<span class="cmk-dirty">unsaved</span>` : ""}
      <span class="cmk-count">${esc(`${v.markupCount} markup${v.markupCount === 1 ? "" : "s"}`)}</span>
    </div>
    <div class="cmk-tools">${tools}</div>
    <div class="cmk-bar-row cmk-bar-wrap">
      <label class="cmk-ctl"><span>Color</span><input type="color" data-cmk-color value="${esc(v.color)}"${dis} /></label>
      <label class="cmk-ctl"><span>Width</span><select class="prov-key" data-cmk-width${dis}>${widths}</select></label>
      <span class="cmk-sep"></span>
      <button type="button" class="btn-mini" data-cmk-prev${v.hasDoc && v.pageIndex > 0 ? "" : " disabled"} aria-label="Previous page">${icon("expand", 12)}</button>
      <span class="cmk-pageno">${esc(page)}</span>
      <button type="button" class="btn-mini" data-cmk-next${v.hasDoc && v.pageIndex < v.pageCount - 1 ? "" : " disabled"} aria-label="Next page">${icon("collapse", 12)}</button>
      <span class="cmk-sep"></span>
      <button type="button" class="btn-mini" data-cmk-zoom-out${dis} aria-label="Zoom out">${icon("minus", 12)}</button>
      <span class="cmk-pageno">${esc(`${Math.round(v.zoom * 100)}%`)}</span>
      <button type="button" class="btn-mini" data-cmk-zoom-in${dis} aria-label="Zoom in">${icon("plus", 12)}</button>
      <button type="button" class="btn-mini" data-cmk-fit${dis}>Fit</button>
      ${v.selected ? `<button type="button" class="btn-mini danger" data-cmk-delete>${icon("trash", 12)} Delete</button>` : ""}
    </div>
    <div class="cmk-bar-row cmk-bar-wrap">
      <button type="button" class="btn-mini ok" data-cmk-save${dis} data-tip="Save annotated PDF|Writes standard PDF annotations with appearance streams. Bluebeam Revu, Acrobat and pdf.js read them natively.">${icon("download", 12)} Save PDF</button>
      <button type="button" class="btn-mini" data-cmk-xfdf-export${dis} data-tip="Export XFDF|ISO 19444-1 annotation exchange. Revu: Markups list, Import.">XFDF export</button>
      <button type="button" class="btn-mini" data-cmk-xfdf-import${dis} data-tip="Import XFDF|Adds the annotations of an XFDF file to this document as editable markups.">XFDF import</button>
      <button type="button" class="btn-mini" disabled data-tip="Bluebeam BAX: not supported|The BAX schema is not publicly documented, so LUCID does not guess at it. Use XFDF, which Revu imports and exports.">BAX (not supported)</button>
    </div>
    ${status ? `<p class="cpl-status${v.statusTone ? ` ${v.statusTone}` : ""}">${esc(status)}</p>` : ""}`;
}

/** The pane shell. `data-cmk-bar` is repainted from `markupBarHtml`; `data-cmk-stage` hosts the canvases. */
export function creatorMarkupHtml(): string {
  return `<div class="cmk-pane" data-cmk-root>
    <p class="cim-status">${icon("shield", 13)}Fully on-device: the PDF is rendered by pdf.js and annotated by pdf-lib inside this window. Nothing is uploaded.</p>
    <div class="cmk-bar" data-cmk-bar></div>
    <input type="file" hidden accept=".pdf,application/pdf" data-cmk-file />
    <input type="file" hidden accept=".xfdf,application/vnd.adobe.xfdf,text/xml,application/xml" data-cmk-xfdf-file />
    <div class="cmk-stage" data-cmk-stage><p class="cst-empty">Open a PDF to start marking it up.</p></div>
  </div>`;
}
