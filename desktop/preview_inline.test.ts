// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/preview_inline.test.ts — P-PREVIEW.4c (ADR-0096): inline a multi-file app's own relative assets so
// it renders under the opaque-origin, egress-blocked preview CSP without widening the frame's origin.

import { describe, expect, test } from "bun:test";
import { inlinePreviewAssets, resolveLocalRef } from "./preview_inline.ts";

const B = "/app"; // base dir
// A fake filesystem keyed by resolved path; readBytes returns the same content as bytes.
const fs = (files: Record<string, string>) => ({
  readText: (p: string) => { if (!(p in files)) throw new Error("ENOENT " + p); return files[p]!; },
  readBytes: (p: string) => { if (!(p in files)) throw new Error("ENOENT " + p); return new TextEncoder().encode(files[p]!); },
});

describe("resolveLocalRef — only pure-relative, in-dir refs (P-PREVIEW.4c)", () => {
  test("pure relative resolves under the base dir", () => {
    expect(resolveLocalRef(B, "style.css")).toBe("/app/style.css");
    expect(resolveLocalRef(B, "./game.js")).toBe("/app/game.js");
    expect(resolveLocalRef(B, "assets/sprite.png")).toBe("/app/assets/sprite.png");
    expect(resolveLocalRef(B, "style.css?v=3#x")).toBe("/app/style.css"); // query/hash stripped
  });
  test("refuses schemes, protocol-relative, root-absolute, anchors, and traversal", () => {
    for (const bad of ["http://x/y.css", "https://x/y.js", "data:text/css,a", "//cdn/x.js", "/root.css", "#top", "javascript:1", "../secret.css", "a/../../esc.js", ""]) {
      expect(resolveLocalRef(B, bad)).toBeNull();
    }
  });
});

describe("inlinePreviewAssets (P-PREVIEW.4c)", () => {
  test("inlines a relative <link> stylesheet into <style>", () => {
    const out = inlinePreviewAssets(`<link rel="stylesheet" href="style.css">`, B, fs({ "/app/style.css": "body{color:red}" }));
    expect(out).toContain("<style>");
    expect(out).toContain("body{color:red}");
    expect(out).not.toContain("<link");
  });
  test("inlines a relative <script src> into an inline <script> (drops src, keeps type=module)", () => {
    const out = inlinePreviewAssets(`<script type="module" src="game.js"></script>`, B, fs({ "/app/game.js": "console.log(1)" }));
    expect(out).toContain("console.log(1)");
    expect(out).toMatch(/<script[^>]*type="module"[^>]*>/);
    expect(out).not.toContain('src="game.js"');
  });
  test("a </script> inside an inlined script can't break out of the block", () => {
    const out = inlinePreviewAssets(`<script src="x.js"></script>`, B, fs({ "/app/x.js": "a</script><script>steal()" }));
    expect(out).not.toContain("</script><script>steal()"); // the closer was neutralized
    expect(out).toContain("<\\/script");
  });
  test("inlines a relative <img src> as a data: URI", () => {
    const out = inlinePreviewAssets(`<img src="sprite.png">`, B, fs({ "/app/sprite.png": "PNGBYTES" }));
    expect(out).toMatch(/<img src="data:image\/png;base64,[A-Za-z0-9+/=]+"/);
  });
  test("inlines url(...) in an inline <style> block (fonts/backgrounds)", () => {
    const out = inlinePreviewAssets(`<style>@font-face{src:url('f.woff2')}</style>`, B, fs({ "/app/f.woff2": "FONT" }));
    expect(out).toMatch(/url\(data:font\/woff2;base64,/);
  });
  test("leaves remote / absolute / traversal refs untouched (the CSP then blocks them)", () => {
    const html = `<link rel="stylesheet" href="https://cdn/x.css"><script src="/root.js"></script><img src="../up.png"><script src="data:text/js,1"></script>`;
    const out = inlinePreviewAssets(html, B, fs({}));
    expect(out).toBe(html); // nothing local to inline → unchanged
  });
  test("a missing/unreadable asset is left as-is (best-effort, never throws)", () => {
    const html = `<link rel="stylesheet" href="missing.css">`;
    expect(inlinePreviewAssets(html, B, fs({}))).toBe(html);
  });
  test("only rel=stylesheet links are inlined (not preload/icon)", () => {
    const html = `<link rel="icon" href="favicon.png"><link rel="preload" href="a.css">`;
    expect(inlinePreviewAssets(html, B, fs({ "/app/favicon.png": "x", "/app/a.css": "y" }))).toBe(html);
  });
  test("respects the per-asset byte cap (an oversized asset is skipped)", () => {
    const big = "x".repeat(50);
    const out = inlinePreviewAssets(`<link rel="stylesheet" href="big.css">`, B, fs({ "/app/big.css": big }), { maxAssetBytes: 10 });
    expect(out).toContain('href="big.css"'); // not inlined
  });
  test("respects the total byte budget across assets", () => {
    const html = `<script src="a.js"></script><script src="b.js"></script>`;
    const out = inlinePreviewAssets(html, B, fs({ "/app/a.js": "AAAAAAAA", "/app/b.js": "BBBBBBBB" }), { maxTotalBytes: 10 });
    // first fits (8 ≤ 10), second (8 > remaining 2) is skipped
    expect(out).toContain("AAAAAAAA");
    expect(out).toContain('src="b.js"');
  });
  test("a self-contained single-file app is returned unchanged", () => {
    const html = `<!doctype html><style>body{margin:0}</style><script>game()</script>`;
    expect(inlinePreviewAssets(html, B, fs({}))).toBe(html);
  });

  test("a relative <iframe src=app.html> (self-test wrapper) → srcdoc with the target inlined recursively", () => {
    const wrapper = `<body><iframe src="game.html?selftest=1"></iframe></body>`;
    const files = { "/app/game.html": `<div class="hero">GAME</div><link rel="stylesheet" href="g.css">`, "/app/g.css": "div{color:red}" };
    const out = inlinePreviewAssets(wrapper, B, fs(files));
    expect(out).toContain("srcdoc=");
    expect(out).not.toContain('src="game.html');          // src dropped
    expect(out).toContain("GAME");                          // target folded in
    expect(out).toContain("div{color:red}");               // target's OWN assets inlined too (recursive)
    expect(out).toContain('class=&quot;hero&quot;');       // the srcdoc value is attribute-escaped
    expect(out).not.toContain('<div class="hero"');        // raw quotes must NOT leak into the attribute
  });
  test("iframe recursion is depth-capped (a self-referential wrapper can't loop forever)", () => {
    // a.html frames b.html frames a.html → bounded by MAX_IFRAME_DEPTH, returns without throwing/hanging
    const files = { "/app/a.html": `<iframe src="b.html"></iframe>`, "/app/b.html": `<iframe src="a.html"></iframe>` };
    const out = inlinePreviewAssets(`<iframe src="a.html"></iframe>`, B, fs(files));
    expect(out).toContain("srcdoc=");                       // completed (did not overflow the stack)
  });
  test("a remote / non-html iframe src is left alone", () => {
    const html = `<iframe src="https://x.com/a"></iframe><iframe src="data.json"></iframe>`;
    expect(inlinePreviewAssets(html, B, fs({ "/app/data.json": "{}" }))).toBe(html);
  });
});
