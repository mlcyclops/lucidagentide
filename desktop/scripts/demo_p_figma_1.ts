// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Increment P-FIGMA.1 — import a Figma design into the Preview (ADR-0154). `/figma` takes a file URL + a
// personal access token (→ OS-encrypted vault); the server fetches the file's frames as PNG renders, inlines
// them into a local design-board HTML, and loads it in the sandboxed preview (the agent then reviews it with
// preview_screenshot / preview_inspect). This demo proves the pure client core headlessly (no network/PAT).

import { parseFigmaFileKey, collectTopFrames, figmaBoardHtml, MAX_FRAMES, type FigmaNode } from "../figma_client.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) { console.error("  ✗ " + msg); process.exit(1); }
  console.log("  ✓ " + msg);
}

console.log("== #ADR-0154 P-FIGMA.1: /figma — import a Figma file's frames as an inlined preview board ==\n");

console.log("[1] parse the file key from a Figma URL (or a bare key)");
assert(parseFigmaFileKey("https://www.figma.com/design/abcDEF123456/App?node-id=1-2") === "abcDEF123456", "design URL → key");
assert(parseFigmaFileKey("https://www.figma.com/file/XyZ9876543210/Board") === "XyZ9876543210", "file URL → key");
assert(parseFigmaFileKey("https://example.com/x") === null, "a non-Figma URL is refused");

console.log("\n[2] walk the file document → the top-level frames across pages (capped)");
const doc: FigmaNode = { children: [
  { name: "Home", children: [{ id: "1:1", name: "Landing", type: "FRAME" }, { id: "1:2", name: "ico", type: "VECTOR" }] },
  { name: "Flows", children: [{ id: "2:1", name: "Checkout", type: "COMPONENT" }] },
] };
const frames = collectTopFrames(doc);
assert(frames.map((f) => f.name).join(",") === "Landing,Checkout", "FRAME/COMPONENT nodes collected, VECTOR skipped");
assert(frames[0].page === "Home" && frames[1].page === "Flows", "each frame carries its page name");
const many: FigmaNode = { children: [{ name: "P", children: Array.from({ length: 60 }, (_, i) => ({ id: `${i}`, name: `F${i}`, type: "FRAME" })) }] };
assert(collectTopFrames(many).length === MAX_FRAMES, `a huge file is capped at ${MAX_FRAMES} frames`);

console.log("\n[3] build the design-board HTML — frames as inlined PNGs, names escaped, only data:image src");
const png = "data:image/png;base64,iVBORw0KGgo=";
const html = figmaBoardHtml("My App", [{ name: '<b>Landing</b>', page: "Home", dataUrl: png }, { name: "Broken", page: "Home", dataUrl: "javascript:alert(1)" }]);
assert(html.includes(png), "a valid PNG frame is inlined as a data-URL <img>");
assert(html.includes("&lt;b&gt;Landing&lt;/b&gt;") && !html.includes("<b>Landing</b>"), "frame names are HTML-escaped");
assert(html.includes("Couldn't render this frame") && !html.includes("javascript:alert(1)"), "a non-image src becomes a placeholder — never injected");
assert(html.includes("2 frames"), "the board header counts the frames");

console.log("\n✓ P-FIGMA.1 demo passed — URL parsed, frames collected + capped, board HTML built safely.");
