// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/figma_client.test.ts — P-FIGMA.1 (ADR-0154): the pure Figma-import core.

import { test, expect, describe } from "bun:test";
import { parseFigmaFileKey, collectTopFrames, figmaBoardHtml, MAX_FRAMES, type FigmaNode } from "./figma_client.ts";

describe("parseFigmaFileKey", () => {
  test("extracts the key from file/design/proto URLs and bare keys", () => {
    expect(parseFigmaFileKey("https://www.figma.com/file/abcDEF123456/My-App?node-id=1-2")).toBe("abcDEF123456");
    expect(parseFigmaFileKey("https://figma.com/design/XyZ9876543210/Board")).toBe("XyZ9876543210");
    expect(parseFigmaFileKey("Q1w2E3r4T5y6")).toBe("Q1w2E3r4T5y6"); // bare key
  });
  test("rejects non-Figma / too-short input", () => {
    expect(parseFigmaFileKey("https://example.com/x")).toBeNull();
    expect(parseFigmaFileKey("short")).toBeNull();
    expect(parseFigmaFileKey("")).toBeNull();
  });
});

describe("collectTopFrames", () => {
  const doc: FigmaNode = {
    children: [
      { name: "Page 1", children: [
        { id: "1:1", name: "Home", type: "FRAME" },
        { id: "1:2", name: "vector", type: "VECTOR" }, // not a frame → skipped
        { id: "1:3", name: "Card", type: "COMPONENT" },
      ] },
      { name: "Page 2", children: [{ id: "2:1", name: "Settings", type: "FRAME" }] },
    ],
  };
  test("collects FRAME/COMPONENT/SECTION nodes across pages with their page name", () => {
    const f = collectTopFrames(doc);
    expect(f.map((x) => x.name)).toEqual(["Home", "Card", "Settings"]);
    expect(f[0]).toEqual({ id: "1:1", name: "Home", page: "Page 1" });
    expect(f[2].page).toBe("Page 2");
  });
  test("caps the number of frames + tolerates an empty/missing document", () => {
    const many: FigmaNode = { children: [{ name: "P", children: Array.from({ length: 50 }, (_, i) => ({ id: `${i}`, name: `F${i}`, type: "FRAME" })) }] };
    expect(collectTopFrames(many).length).toBe(MAX_FRAMES);
    expect(collectTopFrames(null)).toEqual([]);
    expect(collectTopFrames({})).toEqual([]);
  });
});

describe("figmaBoardHtml", () => {
  const png = "data:image/png;base64,iVBORw0KGgo=";
  test("renders a labelled card per frame with the PNG inlined; escapes names", () => {
    const h = figmaBoardHtml("My App", [{ name: '<b>Home</b>', page: "Page 1", dataUrl: png }]);
    expect(h).toContain("1 frame");
    expect(h).toContain(png);
    expect(h).toContain("&lt;b&gt;Home&lt;/b&gt;"); // name escaped, not raw HTML
    expect(h).not.toContain("<b>Home</b>");
  });
  test("a non-image dataUrl becomes a placeholder (only data:image/* is ever set as a src)", () => {
    const h = figmaBoardHtml("X", [{ name: "F", page: "P", dataUrl: "javascript:alert(1)" }]);
    expect(h).toContain("Couldn't render this frame");
    expect(h).not.toContain("javascript:alert(1)");
  });
  test("empty board shows a friendly message", () => {
    expect(figmaBoardHtml("Empty", [])).toContain("No frames were found");
  });
});
