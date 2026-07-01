// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_preview_4c.ts — P-PREVIEW.4c (ADR-0096): MULTI-FILE apps preview by INLINING their
// own relative assets, so an app split into index.html + style.css + game.js + images renders under the
// SAME opaque-origin, egress-blocked frame CSP — no CSP widening, no second origin.
//
// Proves (pure, no browser — the live render is screenshot-verified separately):
//   (1) a relative <link>/<script src>/<img>/url() is folded inline (css → <style>, js → inline <script>,
//       image/font → data:), so the app renders with only 'unsafe-inline' + data: (already in the frame CSP);
//   (2) remote / root-absolute / protocol-relative / `..`-traversal refs are LEFT ALONE (the CSP blocks them),
//       and reads never escape the app's own directory — an injected \`..\` never resolves;
//   (3) it's best-effort + bounded: a missing asset is left as-is, an oversized one is skipped, and an inlined
//       file can't break out of its <script> block; a self-contained single file is returned unchanged.

import { inlinePreviewAssets, resolveLocalRef } from "../preview_inline.ts";

const fail = (msg: string): never => { console.error(`FAIL: ${msg}`); process.exit(1); };
const ok = (msg: string): void => console.log(`   ${msg} ✓`);
const B = "/app";
const fs = (files: Record<string, string>) => ({
  readText: (p: string) => { if (!(p in files)) throw new Error("ENOENT"); return files[p]!; },
  readBytes: (p: string) => { if (!(p in files)) throw new Error("ENOENT"); return new TextEncoder().encode(files[p]!); },
});

console.log("== P-PREVIEW.4c — multi-file apps render by inlining their own relative assets ==");

console.log("\n1) relative css / js / img / font are folded inline");
const app = `<!doctype html><link rel="stylesheet" href="style.css"><img src="assets/dot.png"><script src="game.js"></script>`;
const out = inlinePreviewAssets(app, B, fs({ "/app/style.css": "#b{color:red}", "/app/assets/dot.png": "PNG", "/app/game.js": "run()" }));
if (/<link\b/i.test(out)) fail("<link> should be inlined away");
if (/<script[^>]*\bsrc=/i.test(out)) fail("<script src> should be inlined away");
if (!out.includes("#b{color:red}")) fail("css should be inline");
if (!out.includes("run()")) fail("js should be inline");
if (!/<img src="data:image\/png;base64,/.test(out)) fail("img should be a data: URI");
ok("link→<style>, script src→inline <script>, img→data:");

console.log("\n2) unsafe refs are left alone (CSP blocks them) and reads never escape the app dir");
for (const bad of ["https://cdn/x.css", "//cdn/x.js", "/root.css", "../secret.css", "a/../../esc.js", "data:text/css,x"]) {
  if (resolveLocalRef(B, bad) !== null) fail(`resolveLocalRef must reject: ${bad}`);
}
const traversal = `<link rel="stylesheet" href="../../etc/passwd">`;
if (inlinePreviewAssets(traversal, B, fs({ "/etc/passwd": "SECRET" })) !== traversal) fail("traversal must not be inlined");
ok("remote / root / protocol-relative / data: / `..` traversal → untouched");

console.log("\n3) best-effort + bounded, and injection-safe");
const missing = `<script src="nope.js"></script>`;
if (inlinePreviewAssets(missing, B, fs({})) !== missing) fail("a missing asset must be left as-is");
ok("missing asset → left as-is (never throws)");
const breakout = inlinePreviewAssets(`<script src="x.js"></script>`, B, fs({ "/app/x.js": "a</script><script>evil()" }));
if (breakout.includes("</script><script>evil()")) fail("an inlined file must not break out of its <script>");
ok("</script> inside an inlined file → neutralized");
const capped = inlinePreviewAssets(`<link rel="stylesheet" href="big.css">`, B, fs({ "/app/big.css": "x".repeat(50) }), { maxAssetBytes: 10 });
if (!capped.includes('href="big.css"')) fail("an oversized asset must be skipped");
ok("oversized asset → skipped (per-asset cap)");
const single = `<!doctype html><style>body{margin:0}</style><script>go()</script>`;
if (inlinePreviewAssets(single, B, fs({})) !== single) fail("a self-contained file must be unchanged");
ok("self-contained single file → unchanged");

console.log("\nPASS — multi-file apps inline cleanly under the existing frame CSP; unsafe/oversized refs are refused.");
