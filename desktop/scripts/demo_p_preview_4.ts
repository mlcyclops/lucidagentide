// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_preview_4.ts
//
// Increment P-PREVIEW.4 (ADR-0096) — actually RENDER a local file in the Preview panel. The renderer is
// served over http, and Chromium blocks a `file://` iframe from an http origin, so `iframe.src = file://…`
// never rendered (the gap flagged since P-PREVIEW.1). Fix: serve the file's CONTENT same-origin (behind the
// transport gate) and render it via the iframe's `srcdoc` in the same hardened opaque-origin sandbox.
// Proves the reader that backs it (the live render is DOM/screenshot-verified separately):
//   (1) a local .html/.svg file's content is read (with a filename label);
//   (2) file:// targets are normalized to an OS path before reading;
//   (3) non-local, non-previewable, oversized, or unreadable targets are rejected — never throws.

import { readPreviewFile } from "../preview_file.ts";

const fail = (msg: string): never => { console.error(`FAIL: ${msg}`); process.exit(1); };
const ok = (msg: string): void => console.log(`   ${msg} ✓`);
const io = (content: string, bytes = content.length) => ({ read: () => content, size: () => bytes });

console.log("== P-PREVIEW.4 — render a local file via srcdoc (no more blocked file://) ==");

console.log("\n1) reads a local previewable file's content");
const r = readPreviewFile("C:/Users/n/game.html", io("<h1>game</h1>"));
if (!r.ok || r.html !== "<h1>game</h1>" || r.label !== "game.html") fail("should read content + label");
ok(`C:/Users/n/game.html → ${r.html.length} bytes, label "${r.label}"`);

console.log("\n2) normalizes a file:// target to an OS path before reading");
const seen: string[] = [];
readPreviewFile("file:///C:/Users/n/app.html", { read: (p) => { seen.push(p); return "x"; }, size: () => 1 });
if (seen[0] !== "C:/Users/n/app.html") fail(`file:// not normalized: ${seen[0]}`);
ok(`file:///C:/Users/n/app.html → reads C:/Users/n/app.html`);

console.log("\n3) rejects everything that isn't a readable local previewable file (never throws)");
for (const [label, res] of [
  ["relative path", readPreviewFile("game.html", io("x"))],
  ["remote url", readPreviewFile("https://x.com/a.html", io("x"))],
  ["non-previewable", readPreviewFile("/a/app.ts", io("x"))],
  ["too large", readPreviewFile("/a/big.html", { read: () => "", size: () => 6 * 1024 * 1024 })],
  ["unreadable", readPreviewFile("/a/missing.html", { read: () => { throw new Error("ENOENT"); }, size: () => { throw new Error("ENOENT"); } })],
] as const) {
  if (res.ok) fail(`should reject: ${label}`);
  ok(`${label} → rejected (${res.error})`);
}

console.log("\nPASS — local files render via served-content + srcdoc; the http-origin file:// block is gone.");
