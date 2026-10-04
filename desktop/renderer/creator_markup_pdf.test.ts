// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, test } from "bun:test";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFString } from "pdf-lib";
import type { Markup } from "./creator_markup.ts";
import { listPdfAnnotations, writeMarkupsToPdf } from "./creator_markup_pdf.ts";

const mk = (over: Partial<Markup>): Markup => ({
  id: "m", page: 0, kind: "rect", color: "#FF0000", width: 2, rect: [100, 100, 200, 150], paths: [],
  text: "", fontSize: 12, author: "Reviewer", modified: Date.UTC(2026, 0, 1), ...over,
});

async function samplePdf(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([612, 792]);
  return doc.save();
}

async function annotDicts(bytes: Uint8Array, page: number): Promise<PDFDict[]> {
  const doc = await PDFDocument.load(bytes);
  const annots = doc.getPages()[page]!.node.Annots();
  const out: PDFDict[] = [];
  for (let k = 0; annots && k < annots.size(); k++) out.push(annots.lookup(k, PDFDict));
  return out;
}

describe("writeMarkupsToPdf", () => {
  const markups: Markup[] = [
    mk({ id: "rect-1" }),
    mk({ id: "cloud-1", kind: "cloud", intensity: 1 }),
    mk({ id: "ellipse-1", kind: "ellipse" }),
    mk({ id: "arrow-1", kind: "arrow", paths: [[[50, 50], [150, 120]]], rect: [50, 50, 150, 120] }),
    mk({ id: "ink-1", kind: "ink", paths: [[[10, 10], [20, 30], [40, 35]]], rect: [10, 10, 40, 35] }),
    mk({ id: "text-1", kind: "text", text: "Verify this dimension", rect: [300, 600, 450, 620], color: "#0000FF" }),
    mk({ id: "hl-1", kind: "highlight", page: 1, color: "#FFFF00", rect: [72, 700, 300, 714] }),
  ];

  test("every tool lands as its standard /Subtype on the right page, with its /NM", async () => {
    const out = await writeMarkupsToPdf(await samplePdf(2), markups);
    const list = await listPdfAnnotations(out);
    expect(list.map((a) => [a.page, a.subtype, a.nm])).toEqual([
      [0, "Square", "rect-1"], [0, "Square", "cloud-1"], [0, "Circle", "ellipse-1"], [0, "Line", "arrow-1"],
      [0, "Ink", "ink-1"], [0, "FreeText", "text-1"], [1, "Highlight", "hl-1"],
    ]);
    expect(list.filter((a) => a.cloudy).map((a) => a.nm)).toEqual(["cloud-1"]);
  });

  test("the keys a viewer needs: /LE arrow ending, /InkList, /QuadPoints, /DA without a /C fill, /AP on all", async () => {
    const out = await writeMarkupsToPdf(await samplePdf(2), markups);
    const p0 = await annotDicts(out, 0);
    const p1 = await annotDicts(out, 1);
    const [, , , line, ink, text] = p0;
    const le = line!.lookup(PDFName.of("LE"), PDFArray).asArray().map((n) => (n instanceof PDFName ? n.decodeText() : ""));
    expect(le).toEqual(["None", "OpenArrow"]);
    expect(ink!.lookup(PDFName.of("InkList"), PDFArray).lookup(0, PDFArray).size()).toBe(6);
    expect(text!.has(PDFName.of("C"))).toBe(false);
    expect(text!.lookup(PDFName.of("DA"), PDFString).decodeText()).toBe("/Helv 12 Tf 0 0 1 rg");
    expect(p1[0]!.lookup(PDFName.of("QuadPoints"), PDFArray).size()).toBe(8);
    for (const a of [...p0, ...p1]) expect(a.lookup(PDFName.of("AP"), PDFDict).has(PDFName.of("N"))).toBe(true);
  });

  test("existing annotations are kept and new ones appended", async () => {
    const once = await writeMarkupsToPdf(await samplePdf(1), [mk({ id: "first" })]);
    const twice = await writeMarkupsToPdf(once, [mk({ id: "second", kind: "ellipse" })]);
    expect((await listPdfAnnotations(twice)).map((a) => a.nm)).toEqual(["first", "second"]);
  });

  test("a markup past the last page is refused, not silently dropped", async () => {
    await expect(writeMarkupsToPdf(await samplePdf(1), [mk({ page: 3 })])).rejects.toThrow(/page 4/);
  });
});
