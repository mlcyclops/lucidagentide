// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Increment P-VISION.1 — paste/drop images into the composer (ADR-0136). A user pastes a screenshot into the
// prompt bar; it becomes a validated attachment shown as a thumbnail, and — only on Enter/Send — travels to
// omp as an image content block alongside the text. This demo proves the pure core headlessly.

import {
  acceptAttachment,
  promptImageBlocks,
  thumbStripHtml,
  parseImageDataUrl,
  MAX_ATTACHMENTS,
  type Attachment,
} from "../renderer/composer_attachments.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) { console.error("  ✗ " + msg); process.exit(1); }
  console.log("  ✓ " + msg);
}

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
console.log("== #ADR-0136 P-VISION.1: paste a screenshot into the prompt bar → image content block ==\n");

console.log("[1] validate + stage a pasted image (fail-closed on type/size/count)");
const staged: Attachment[] = [];
const r = acceptAttachment(staged, PNG, "att_1", "clipboard.png");
assert(r.ok && r.attachment, "a PNG data URL is accepted as an attachment");
staged.push(r.attachment!);
assert(!acceptAttachment(staged, "data:image/svg+xml;base64,PHN2Zz4=", "att_svg").ok, "an SVG is refused (script risk)");
assert(!acceptAttachment(staged, "data:text/html;base64,PGgxPg==", "att_html").ok, "a non-image data URL is refused");
const full = Array.from({ length: MAX_ATTACHMENTS }, (_, i) => ({ id: `f${i}`, dataUrl: PNG, mimeType: "image/png", bytes: 12 }));
assert(!acceptAttachment(full, PNG, "att_over").ok, `more than ${MAX_ATTACHMENTS} images is refused`);

console.log("\n[2] the image travels to omp as a content block ({type:image,data,mimeType})");
const blocks = promptImageBlocks(staged);
assert(blocks.length === 1 && blocks[0].type === "image" && blocks[0].mimeType === "image/png", "one image block emitted");
assert(!blocks[0].data.startsWith("data:"), "the data: prefix is stripped — base64 only, as omp expects");
assert(parseImageDataUrl(PNG)!.base64 === blocks[0].data, "the block carries the exact base64 payload");

console.log("\n[3] the thumbnail strip NEVER interpolates the data URL into markup (XSS-safe)");
const strip = thumbStripHtml(staged);
assert(strip.includes('data-att="att_1"') && strip.includes("data-att-remove"), "renders a thumb + remove button");
assert(!strip.includes("data:image") && !strip.includes("src="), "no data URL / src in the HTML string (caller sets img.src as a property)");
assert(thumbStripHtml([{ id: "x", dataUrl: PNG, mimeType: "image/png", bytes: 1, name: '"><img src=x>' }]).includes("&lt;img"), "a hostile filename is escaped");

console.log("\n✓ P-VISION.1 demo passed — images validated, staged, and emitted as omp content blocks; markup stays safe.");
