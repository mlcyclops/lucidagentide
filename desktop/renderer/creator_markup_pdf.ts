// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/creator_markup_pdf.ts - write Markup Studio annotations into a PDF with pdf-lib (MIT).
//
// Standard PDF annotation dictionaries only (ISO 32000 12.5): /Square, /Circle, /Line (+ /LE OpenArrow),
// /Ink, /FreeText, /Highlight, and a revision cloud as /Square with a cloudy /BE border effect, which is
// how Bluebeam Revu and Acrobat store clouds. Each one carries its own /AP /N appearance stream (built in
// creator_markup.ts) so every viewer draws the same thing. Runs in the renderer and under bun test; no
// network, no node builtins.

import { PDFDict, PDFDocument, PDFHexString, PDFName, PDFString, type PDFContext, type PDFPage } from "pdf-lib";
import {
  MARKUP_SUBJECT, MARKUP_SUBTYPE, DEFAULT_LINE_ENDINGS, annotationRect, appearanceContent, freeTextDA,
  hexToRgb, highlightQuads, pdfDate, type Markup,
} from "./creator_markup.ts";

/** pdf-lib's literal dictionary shape (not exported by name, so derived from the method that takes it). */
type Literal = NonNullable<Parameters<PDFContext["stream"]>[1]>;

/** Annotation flag 4 = Print (ISO 32000 12.5.3), so markups survive a print/flatten. */
const FLAG_PRINT = 4;

function addAnnotation(doc: PDFDocument, page: PDFPage, m: Markup): void {
  const ctx = doc.context;
  const { rect, rd } = annotationRect(m);
  const ap = appearanceContent(m);
  const resources: Literal = {};
  if (ap.font) resources.Font = { Helv: { Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" } };
  if (ap.multiply) resources.ExtGState = { GS0: { Type: "ExtGState", BM: "Multiply" } };
  // ctx.obj/ctx.stream turn plain strings into NAMES, which is exactly what /Type, /Subtype and the font
  // keys need; text values are wrapped as PDFHexString / PDFString explicitly.
  const apRef = ctx.register(ctx.stream(ap.content, { Type: "XObject", Subtype: "Form", FormType: 1, BBox: [...rect], Resources: resources }));
  const date = PDFString.of(pdfDate(m.modified));
  const [r, g, b] = hexToRgb(m.color);
  const dict: Literal = {
    Type: "Annot",
    Subtype: MARKUP_SUBTYPE[m.kind],
    Rect: [...rect],
    P: page.ref,
    NM: PDFHexString.fromText(m.id),
    T: PDFHexString.fromText(m.author),
    Subj: PDFHexString.fromText(MARKUP_SUBJECT[m.kind]),
    M: date,
    CreationDate: date,
    F: FLAG_PRINT,
    CA: 1,
    BS: { Type: "Border", W: m.width, S: "S" },
    Border: [0, 0, m.width],
    AP: { N: apRef },
  };
  // FreeText's /C is the box FILL in Acrobat and Revu, so its colour rides /DA (and /DS) instead.
  if (m.kind !== "text") dict.C = [r, g, b];
  if (m.text) dict.Contents = PDFHexString.fromText(m.text);
  switch (m.kind) {
    case "rect":
    case "ellipse":
      dict.RD = [rd, rd, rd, rd];
      break;
    case "cloud":
      dict.BE = { S: "C", I: m.intensity ?? 1 };
      dict.RD = [rd, rd, rd, rd];
      break;
    case "arrow": {
      const p = m.paths[0] ?? [];
      const a = p[0] ?? [rect[0], rect[1]];
      const z = p[p.length - 1] ?? [rect[2], rect[3]];
      const ends = m.lineEndings ?? DEFAULT_LINE_ENDINGS;
      dict.L = [a[0], a[1], z[0], z[1]];
      dict.LE = [ends[0], ends[1]];
      break;
    }
    case "ink":
      dict.InkList = m.paths.map((path) => path.flatMap(([x, y]) => [x, y]));
      break;
    case "text":
      dict.DA = PDFString.of(freeTextDA(m));
      dict.DS = PDFString.of(`font: Helvetica ${m.fontSize}pt; color: ${m.color.toUpperCase()}`);
      dict.Q = 0;
      break;
    case "highlight":
      dict.QuadPoints = highlightQuads(m);
      break;
  }
  page.node.addAnnot(ctx.register(ctx.obj(dict)));
}

/** Load `bytes`, append every markup as a standard annotation on its page, and return the saved PDF.
 *  Refuses (throws) an encrypted PDF or a markup that points past the last page rather than dropping it. */
export async function writeMarkupsToPdf(bytes: Uint8Array, markups: readonly Markup[]): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const pages = doc.getPages();
  for (const m of markups) {
    const page = pages[m.page];
    if (!page) throw new Error(`markup ${m.id} is on page ${m.page + 1}, but the PDF has ${pages.length} page(s)`);
    addAnnotation(doc, page, m);
  }
  return doc.save({ useObjectStreams: false });
}

export interface PdfAnnotationInfo { page: number; subtype: string; nm: string; cloudy: boolean }

/** Every annotation on every page, in page order (0-based page index): its /Subtype, /NM, and whether it
 *  carries a cloudy /BE border effect. */
export async function listPdfAnnotations(bytes: Uint8Array): Promise<PdfAnnotationInfo[]> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const out: PdfAnnotationInfo[] = [];
  doc.getPages().forEach((page, i) => {
    const annots = page.node.Annots();
    if (!annots) return;
    for (let k = 0; k < annots.size(); k++) {
      const a = annots.lookup(k);
      if (!(a instanceof PDFDict)) continue;
      const sub = a.get(PDFName.of("Subtype"));
      const nm = a.get(PDFName.of("NM"));
      const be = a.lookup(PDFName.of("BE"));
      const beS = be instanceof PDFDict ? be.get(PDFName.of("S")) : undefined;
      out.push({
        page: i,
        subtype: sub instanceof PDFName ? sub.decodeText() : "",
        nm: nm instanceof PDFHexString || nm instanceof PDFString ? nm.decodeText() : "",
        cloudy: beS instanceof PDFName && beS.decodeText() === "C",
      });
    }
  });
  return out;
}
