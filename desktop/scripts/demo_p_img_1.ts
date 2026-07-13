// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Increment P-IMG.1 — render generated / tool-produced images inside the chat reply (ADR-0208). A tool
// returns an image content block; LUCID lifts it out of the tool result, renders it inline (safe img.src),
// offers a Download, and can push it into the Preview panel (a self-contained wrapper HTML) for markup +
// iteration. This demo proves the PURE core headlessly: extraction is fail-closed, filenames are safe, and
// the preview wrapper embeds only a validated data: URI (no <script>, CSP-friendly).

import {
  extractToolImages,
  imageBlockToDataUrl,
  imageFileName,
  previewImageHtml,
  MAX_TOOL_IMAGES,
} from "../renderer/chat_images.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) { console.error("  ✗ " + msg); process.exit(1); }
  console.log("  ✓ " + msg);
}

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PNG_DATA_URL = `data:image/png;base64,${PNG_B64}`;

console.log("== #ADR-0208 P-IMG.1: a tool's image → inline in chat, downloadable, push-to-preview ==\n");

console.log("[1] lift images OUT of a tool result (ACP-wrapped AND bare omp blocks)");
const acp = [
  { type: "text", text: "Here's the image you asked for." },
  { type: "content", content: { type: "image", data: PNG_B64, mimeType: "image/png" } }, // ACP ToolCallContent
];
const bare = [{ type: "image", data: PNG_B64, mimeType: "image/png" }]; // omp/pi content block
assert(extractToolImages(acp).length === 1, "an ACP { type:'content', content:{image} } block is unwrapped");
assert(extractToolImages(bare).length === 1, "a bare { type:'image' } block is extracted");
assert(extractToolImages(acp)[0]!.dataUrl === PNG_DATA_URL, "the extracted image is a validated data: URL");

console.log("\n[2] the tool result is UNTRUSTED — malformed / script-bearing / oversized blocks drop fail-closed");
assert(imageBlockToDataUrl({ data: "PHN2Zz4=", mimeType: "image/svg+xml" }) === null, "an SVG is refused (script risk)");
assert(imageBlockToDataUrl({ data: "not base64 !!!", mimeType: "image/png" }) === null, "a non-base64 payload is refused");
const mixed = [
  { type: "image", data: PNG_B64, mimeType: "image/png" },
  { type: "image", data: "PHN2Zz4=", mimeType: "image/svg+xml" }, // dropped
  { type: "diff", path: "x.ts" },                                   // not an image → dropped
];
assert(extractToolImages(mixed).length === 1, "invalid parts are dropped, the valid image is kept");
const many = Array.from({ length: MAX_TOOL_IMAGES + 4 }, () => ({ type: "image", data: PNG_B64, mimeType: "image/png" }));
assert(extractToolImages(many).length === MAX_TOOL_IMAGES, `count is capped at MAX_TOOL_IMAGES (${MAX_TOOL_IMAGES})`);

console.log("\n[3] downloads get a safe filename (extension from the mime; no path traversal)");
assert(imageFileName("image/png", 0) === "lucid-image-1.png", "png → lucid-image-1.png (1-based)");
assert(imageFileName("image/jpeg", 1) === "lucid-image-2.jpg", "jpeg → .jpg");
const evil = imageFileName("image/png", 0, "../../etc/passwd");
assert(!evil.includes("/") && !evil.includes(".."), "a path-traversal stem is neutralized");

console.log("\n[4] 'Send to preview' builds a SELF-CONTAINED wrapper (data: URI only, no <script>, CSP-safe)");
const html = previewImageHtml(PNG_DATA_URL);
assert(html.includes("<img") && html.includes(PNG_DATA_URL), "the wrapper embeds the validated image as a data: URI");
assert(!html.toLowerCase().includes("<script"), "the wrapper never contains a <script> tag");
assert(previewImageHtml("javascript:alert(1)") === "", "a non-image URL yields no wrapper (caller then does nothing)");

console.log("\n✓ P-IMG.1 demo passed — tool images extracted fail-closed, safe filenames, CSP-safe preview wrapper.");
