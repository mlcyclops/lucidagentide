// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, test } from "bun:test";
import {
  annotationRect, appearanceContent, canvasToPdf, cloudPath, cloudRadius, dragToPdfRect, freeTextRect, hitTest,
  markupsToXfdf, parsePdfDate, parseXml, pdfDate, pdfLiteral, translateMarkup, xfdfToMarkups,
  type Markup, type Matrix,
} from "./creator_markup.ts";

const T0 = Date.UTC(2026, 9, 3, 12, 30, 15);

const mk = (over: Partial<Markup>): Markup => ({
  id: "m1", page: 0, kind: "rect", color: "#FF0000", width: 2, rect: [100, 100, 200, 150], paths: [],
  text: "", fontSize: 12, author: "Reviewer", modified: T0, ...over,
});

const close = (a: readonly number[], b: readonly number[]) => {
  expect(a.length).toBe(b.length);
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, 2));
};

describe("canvas to PDF geometry", () => {
  // pdf.js viewport for a US Letter page at 150%, rotation 0: [s, 0, 0, -s, 0, 792 * s].
  const letter150: Matrix = [1.5, 0, 0, -1.5, 0, 792 * 1.5];

  test("unrotated page: y flips and scale divides out", () => {
    close(canvasToPdf(letter150, 150, 300), [100, 592]);
  });

  test("a drag in any direction becomes a normalized PDF rect", () => {
    close(dragToPdfRect(letter150, [300, 450], [150, 300]), [100, 492, 200, 592]);
  });

  test("a page rotated 90 degrees swaps the axes (pdf.js transform [0,1,1,0,0,0] at scale 1)", () => {
    const rot90: Matrix = [0, 1, 1, 0, 0, 0];
    close(dragToPdfRect(rot90, [700, 100], [720, 150]), [100, 700, 150, 720]);
  });

  test("a cropped page offsets the origin", () => {
    // viewBox [36, 36, 576, 756] at scale 1: canvas (0,0) is PDF (36, 756).
    const cropped: Matrix = [1, 0, 0, -1, -36, 756];
    close(canvasToPdf(cropped, 0, 0), [36, 756]);
  });
});

describe("annotation rects", () => {
  test("a rectangle's /Rect encloses its stroke and /RD insets back to the drawn path", () => {
    const { rect, rd } = annotationRect(mk({ width: 2 }));
    close(rect, [99, 99, 201, 151]);
    expect(rd).toBe(1);
  });

  test("a cloud's /Rect also encloses its scallops", () => {
    const d = cloudRadius(1, 2) + 1;
    const { rect, rd } = annotationRect(mk({ kind: "cloud", intensity: 1 }));
    expect(rd).toBeCloseTo(d);
    close(rect, [100 - d, 100 - d, 200 + d, 150 + d]);
  });

  test("an arrow's /Rect includes the arrow head, not just the shaft", () => {
    const m = mk({ kind: "arrow", paths: [[[100, 100], [200, 100]]] });
    const { rect } = annotationRect(m);
    expect(rect[1]).toBeLessThan(100 - 2);
    expect(rect[3]).toBeGreaterThan(100 + 2);
    expect(rect[2]).toBeGreaterThanOrEqual(200);
  });

  test("a FreeText box grows with its longest line and line count", () => {
    const one = freeTextRect([50, 700], "abc", 12);
    const two = freeTextRect([50, 700], "abcdef\nx", 12);
    expect(one[3]).toBe(700);
    expect(two[2] - two[0]).toBeGreaterThan(one[2] - one[0]);
    expect(two[3] - two[1]).toBeGreaterThan(one[3] - one[1]);
  });
});

describe("cloud path", () => {
  test("bumps bulge outward on every side and the path returns to its start", () => {
    const r = [100, 100, 220, 160] as const;
    const { start, segs } = cloudPath(r, 1, 1);
    expect(segs.length % 2).toBe(0);
    const last = segs[segs.length - 1]!.to;
    close(last, start);
    for (let i = 0; i < segs.length; i += 2) {
      const apex = segs[i]!.to;
      const inside = apex[0] > r[0] + 0.01 && apex[0] < r[2] - 0.01 && apex[1] > r[1] + 0.01 && apex[1] < r[3] - 0.01;
      expect(inside).toBe(false);
    }
  });
});

describe("hit testing and moving", () => {
  test("the topmost markup under the point wins, on the right page only", () => {
    const a = mk({ id: "a" });
    const b = mk({ id: "b", rect: [150, 120, 250, 170] });
    const other = mk({ id: "c", page: 1 });
    expect(hitTest([a, b, other], 0, 160, 130, 2)).toBe("b");
    expect(hitTest([a, b, other], 0, 110, 110, 2)).toBe("a");
    expect(hitTest([a, b, other], 0, 400, 400, 2)).toBeNull();
  });

  test("translate moves rect, paths and quads together", () => {
    const m = translateMarkup(mk({ kind: "highlight", quads: [0, 10, 10, 10, 0, 0, 10, 0] }), 5, -3);
    close(m.rect, [105, 97, 205, 147]);
    close(m.quads!, [5, 7, 15, 7, 5, -3, 15, -3]);
  });
});

describe("appearance streams", () => {
  test("FreeText escapes PDF string delimiters and declares the Helvetica resource", () => {
    const ap = appearanceContent(mk({ kind: "text", text: "a (b) \\ c", rect: [0, 0, 100, 20] }));
    expect(ap.font).toBe(true);
    expect(ap.content).toContain("(a \\(b\\) \\\\ c) Tj");
  });

  test("highlight paints with the multiply blend state", () => {
    const ap = appearanceContent(mk({ kind: "highlight" }));
    expect(ap.multiply).toBe(true);
    expect(ap.content).toContain("/GS0 gs");
  });

  test("pdfLiteral replaces characters WinAnsi cannot carry", () => {
    expect(pdfLiteral("caf\u00e9 \u4e2d")).toBe("caf\u00e9 ?");
  });
});

describe("PDF dates", () => {
  test("round trip in UTC", () => {
    expect(pdfDate(T0)).toBe("D:20261003123015Z");
    expect(parsePdfDate(pdfDate(T0))).toBe(T0);
  });

  test("an offset date is normalized to UTC", () => {
    expect(parsePdfDate("D:20261003083015-04'00'")).toBe(T0);
  });
});

describe("XFDF", () => {
  const all: Markup[] = [
    mk({ id: "r1", kind: "rect" }),
    mk({ id: "c1", kind: "cloud", intensity: 2, color: "#0055FF", width: 1 }),
    mk({ id: "e1", kind: "ellipse", page: 1 }),
    mk({ id: "a1", kind: "arrow", paths: [[[10, 10], [80, 60]]], rect: [10, 10, 80, 60] }),
    mk({ id: "i1", kind: "ink", paths: [[[1, 1], [2, 3], [4, 4]], [[10, 10], [12, 14]]], rect: [1, 1, 12, 14] }),
    mk({ id: "t1", kind: "text", text: "Check <this> & \"that\"", color: "#008000", fontSize: 14, rect: [300, 600, 420, 620] }),
    mk({ id: "h1", kind: "highlight", color: "#FFFF00", rect: [50, 500, 250, 515] }),
  ];

  test("every kind survives a serialize/parse round trip", () => {
    const xml = markupsToXfdf(all, "plan & detail.pdf");
    const back = xfdfToMarkups(xml, 0);
    expect(back.skipped).toEqual([]);
    expect(back.href).toBe("plan & detail.pdf");
    expect(back.markups.map((m) => m.kind)).toEqual(all.map((m) => m.kind));
    back.markups.forEach((m, i) => {
      const src = all[i]!;
      expect(m.id).toBe(src.id);
      expect(m.page).toBe(src.page);
      expect(m.color).toBe(src.color);
      expect(m.author).toBe(src.author);
      expect(m.modified).toBe(T0);
      close(m.rect, src.rect); // /RD (fringe) brings a stroked shape back to its drawn path
    });
    const byId = new Map(back.markups.map((m) => [m.id, m]));
    expect(byId.get("c1")!.intensity).toBe(2);
    expect(byId.get("a1")!.lineEndings).toEqual(["None", "OpenArrow"]);
    close(byId.get("a1")!.paths[0]!.flat(), [10, 10, 80, 60]);
    expect(byId.get("i1")!.paths.length).toBe(2);
    close(byId.get("i1")!.paths[1]!.flat(), [10, 10, 12, 14]);
    expect(byId.get("t1")!.text).toBe("Check <this> & \"that\"");
    expect(byId.get("t1")!.fontSize).toBe(14);
  });

  test("a text box's colour is written to the default appearance, never as its box fill", () => {
    const xml = markupsToXfdf([all[5]!], "x.pdf");
    expect(xml).toMatch(/<freetext (?![^>]*color=)/);
    expect(xml).toContain("<defaultappearance>/Helv 14 Tf 0 0.502 0 rg</defaultappearance>");
  });

  test("Acrobat-style XFDF: rich text contents, unknown annotation types are named, not guessed", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!-- exported -->
<xfdf xmlns="http://ns.adobe.com/xfdf/" xml:space="preserve">
  <annots>
    <freetext page="2" rect="10,20,110,40" name="ft" title="A" date="D:20260101000000Z">
      <contents-richtext><body xmlns="http://www.w3.org/1999/xhtml"><p>Line one</p><p>Line &amp; two</p></body></contents-richtext>
      <defaultappearance>0 0 1 rg /Helv 10 Tf</defaultappearance>
    </freetext>
    <stamp page="0" rect="0,0,10,10" name="s"/>
    <square page="0" rect="0,0,50,50" style="cloudy" intensity="1" fringe="5,5,5,5" color="#ff0000" width="1"/>
  </annots>
</xfdf>`;
    const r = xfdfToMarkups(xml);
    expect(r.skipped).toEqual(["stamp"]);
    const ft = r.markups[0]!;
    expect(ft.kind).toBe("text");
    expect(ft.page).toBe(2);
    expect(ft.text).toBe("Line one\nLine & two");
    expect(ft.color).toBe("#0000FF");
    expect(ft.fontSize).toBe(10);
    const cloud = r.markups[1]!;
    expect(cloud.kind).toBe("cloud");
    close(cloud.rect, [5, 5, 45, 45]);
  });

  test("a non-XFDF document is refused", () => {
    expect(() => xfdfToMarkups("<html><body/></html>")).toThrow(/not an XFDF/);
  });
});

describe("XML reader", () => {
  test("entities, numeric references and CDATA decode; a DOCTYPE's entities are never expanded", () => {
    const root = parseXml(`<!DOCTYPE x [<!ENTITY boom "BOOM">]><a k='1 &lt; 2'>x &amp;&#65;&#x42; &boom;<![CDATA[<raw>]]></a>`);
    const a = root.children[0]!;
    expect(a.attrs.k).toBe("1 < 2");
    expect(a.text).toBe("x &AB &boom;<raw>");
  });

  test("namespace prefixes are dropped from element names", () => {
    expect(parseXml(`<x:xfdf xmlns:x="u"><x:annots/></x:xfdf>`).children[0]!.children[0]!.name).toBe("annots");
  });

  test("malformed nesting throws", () => {
    expect(() => parseXml("<a><b></a></b>")).toThrow();
    expect(() => parseXml("<a>")).toThrow(/unclosed/);
  });
});
