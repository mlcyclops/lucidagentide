// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/preview_inline.test.ts — P-PREVIEW.4c (ADR-0096): inline a multi-file app's own relative assets so
// it renders under the opaque-origin, egress-blocked preview CSP without widening the frame's origin.

import { describe, expect, test } from "bun:test";
import {
  blockedRefsBanner, blockedRefsMessage, findBlockedRefs, injectBlockedRefsBanner, inlinePreviewAssets,
  previewTextDocument, resolveLocalRef, type BlockedRef,
} from "./preview_inline.ts";

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

// P-PREVIEW.12: the frame CSP is not changing (no remote origins, `connect-src 'none'` stays). What changes
// is that it stops failing SILENTLY: these are the facts the agent and the user now get instead of a blank
// frame. A miss here means a model keeps writing CDN <script> tags forever, so the detection is over-tested.
describe("findBlockedRefs (P-PREVIEW.12): what the frame CSP will refuse", () => {
  const urls = (refs: BlockedRef[], kind: BlockedRef["kind"]) => refs.filter((r) => r.kind === kind).map((r) => r.url);

  test("finds a remote <script src> (the Chart.js / three.js / Tailwind CDN case)", () => {
    const refs = findBlockedRefs(`<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>`);
    expect(refs).toEqual([{ kind: "script", url: "https://cdn.jsdelivr.net/npm/chart.js" }]);
  });
  test("finds a remote stylesheet, and a remote modulepreload/preload by its `as`", () => {
    const refs = findBlockedRefs(
      `<link rel="stylesheet" href="https://cdn/x.css">`
      + `<link rel="preload" as="font" href="https://fonts.gstatic.com/a.woff2">`
      + `<link rel="modulepreload" href="https://cdn/m.js">`
      + `<link rel="preload" as="image" href="https://cdn/hero.png">`,
    );
    expect(urls(refs, "style")).toEqual(["https://cdn/x.css"]);
    expect(urls(refs, "font")).toEqual(["https://fonts.gstatic.com/a.woff2"]);
    expect(urls(refs, "script")).toEqual(["https://cdn/m.js"]);
    expect(urls(refs, "image")).toEqual(["https://cdn/hero.png"]);
  });
  test("finds remote media on img / source / video / audio", () => {
    const refs = findBlockedRefs(
      `<img src="https://i.imgur.com/a.png"><source src="https://x/b.webm">`
      + `<video src="https://x/c.mp4"></video><audio src="https://x/d.mp3"></audio>`,
    );
    expect(urls(refs, "image")).toEqual(["https://i.imgur.com/a.png", "https://x/b.webm", "https://x/c.mp4", "https://x/d.mp3"]);
  });
  test("finds a remote @font-face url as a FONT, and any other remote css url as an image", () => {
    const refs = findBlockedRefs(
      `<style>@font-face{font-family:x;src:url("https://fonts.gstatic.com/x.woff2")}`
      + `body{background:url('https://cdn/bg.jpg')}</style>`,
    );
    expect(urls(refs, "font")).toEqual(["https://fonts.gstatic.com/x.woff2"]);
    expect(urls(refs, "image")).toEqual(["https://cdn/bg.jpg"]);
  });
  test("finds a remote <iframe src>", () => {
    expect(findBlockedRefs(`<iframe src="https://example.com/embed"></iframe>`))
      .toEqual([{ kind: "frame", url: "https://example.com/embed" }]);
  });
  test("finds absolute-URL fetch() and XMLHttpRequest.open() in INLINE script text", () => {
    const refs = findBlockedRefs(
      `<script>fetch("https://api.example.com/v1/data").then(r=>r.json());`
      + `const x=new XMLHttpRequest();x.open("GET","https://api.example.com/v2/rows");</script>`,
    );
    expect(urls(refs, "fetch")).toEqual(["https://api.example.com/v1/data", "https://api.example.com/v2/rows"]);
  });
  test("a PROTOCOL-RELATIVE //host ref is remote too (it inherits the frame's scheme)", () => {
    const refs = findBlockedRefs(`<script src="//cdn.tailwindcss.com"></script><img src="//x/y.png">`);
    expect(urls(refs, "script")).toEqual(["//cdn.tailwindcss.com"]);
    expect(urls(refs, "image")).toEqual(["//x/y.png"]);
  });
  test("ignores relative, root-absolute, data:, blob: and anchor refs (nothing to report)", () => {
    const html = `<script src="game.js"></script><script src="/root.js"></script>`
      + `<link rel="stylesheet" href="style.css"><img src="sprite.png"><img src="data:image/png;base64,AA">`
      + `<img src="blob:abc"><iframe src="child.html"></iframe><a href="#top">x</a>`
      + `<style>body{background:url(bg.png)}</style><script>fetch("/api/local")</script>`;
    expect(findBlockedRefs(html)).toEqual([]);
  });
  test("a self-contained page reports nothing (the common, working case stays quiet)", () => {
    expect(findBlockedRefs(`<!doctype html><style>body{margin:0}</style><script>go()</script>`)).toEqual([]);
  });
  test("dedupes by kind+url but keeps the same url under a different kind", () => {
    const refs = findBlockedRefs(
      `<script src="https://cdn/x.js"></script><script src="https://cdn/x.js"></script>`
      + `<iframe src="https://cdn/x.js"></iframe>`,
    );
    expect(refs).toEqual([
      { kind: "script", url: "https://cdn/x.js" },
      { kind: "frame", url: "https://cdn/x.js" },
    ]);
  });
  test("caps the list at 20 entries so a pathological file cannot blow up the payload", () => {
    const many = Array.from({ length: 200 }, (_, i) => `<img src="https://cdn/${i}.png">`).join("");
    expect(findBlockedRefs(many)).toHaveLength(20);
  });
  test("reports in a deterministic kind order, and does not throw on junk input", () => {
    const refs = findBlockedRefs(
      `<img src="https://x/a.png"><iframe src="https://x/f"></iframe>`
      + `<script src="https://x/s.js"></script><link rel="stylesheet" href="https://x/c.css">`,
    );
    expect(refs.map((r) => r.kind)).toEqual(["script", "style", "image", "frame"]);
    expect(findBlockedRefs("")).toEqual([]);
    expect(findBlockedRefs("<script src=")).toEqual([]);
  });
  // The inliner folds local refs in FIRST, so detection must run on the inlined output: anything that
  // survived inlining is, by construction, exactly what the CSP is about to refuse.
  test("runs cleanly on inlined output: locals are gone, the remote ones remain", () => {
    const html = `<link rel="stylesheet" href="style.css"><script src="https://cdn/x.js"></script>`;
    const inlined = inlinePreviewAssets(html, B, fs({ "/app/style.css": "body{color:red}" }));
    expect(findBlockedRefs(inlined)).toEqual([{ kind: "script", url: "https://cdn/x.js" }]);
  });
});

describe("blockedRefsMessage (P-PREVIEW.12): the agent's feedback loop", () => {
  test("an empty list is the empty string (nothing to say)", () => {
    expect(blockedRefsMessage([])).toBe("");
  });
  test("one sentence that names the counts, the first url, and the ACTIONABLE fix", () => {
    const msg = blockedRefsMessage([
      { kind: "script", url: "https://cdn/chart.js" },
      { kind: "script", url: "https://cdn/d3.js" },
      { kind: "image", url: "https://x/a.png" },
    ]);
    expect(msg).toContain("2 remote scripts");
    expect(msg).toContain("1 remote image");
    expect(msg).toContain("https://cdn/chart.js");
    expect(msg).toContain("no network access");
    expect(msg).toMatch(/inline/i);        // fix #1: inline the script/CSS
    expect(msg).toMatch(/relative path/i); // fix #2: vendor the asset beside the file
    expect(msg.trimEnd().split(". ")).toHaveLength(1); // one sentence
    expect(msg).not.toContain("\u2014");   // project rule: never an em dash
  });
  test("singular vs plural nouns per kind", () => {
    expect(blockedRefsMessage([{ kind: "style", url: "//cdn/a.css" }])).toContain("1 remote stylesheet");
    expect(blockedRefsMessage([{ kind: "font", url: "//f/a.woff2" }])).toContain("1 remote font");
    expect(blockedRefsMessage([{ kind: "frame", url: "https://x/e" }])).toContain("1 remote iframe");
    expect(blockedRefsMessage([{ kind: "fetch", url: "https://api/x" }])).toContain("1 network call");
    expect(blockedRefsMessage([
      { kind: "fetch", url: "https://api/x" }, { kind: "fetch", url: "https://api/y" },
    ])).toContain("2 network calls");
  });
});

describe("blockedRefsBanner / injectBlockedRefsBanner (P-PREVIEW.12)", () => {
  const refs: BlockedRef[] = [{ kind: "script", url: "https://cdn/x.js" }];

  test("no refs means no banner and an UNCHANGED document", () => {
    expect(blockedRefsBanner([])).toBe("");
    const html = `<!doctype html><html><body><h1>fine</h1></body></html>`;
    expect(injectBlockedRefsBanner(html)).toBe(html);
  });
  test("the banner carries the message, is dismissible, and is styled inline (no stylesheet reaches the frame)", () => {
    const b = blockedRefsBanner(refs);
    expect(b).toContain("no network access");
    expect(b).toContain("onclick=\"this.parentNode.remove()\""); // dismissible under script-src 'unsafe-inline'
    expect(b).toMatch(/<div[^>]+style="/);                       // every rule is inline
    expect(b).not.toContain("<link");
    expect(b).not.toContain("class=");
  });
  // INVARIANT 11: prose inside a flex box shatters into stacked slivers. The banner is a BLOCK paragraph
  // with an absolutely-positioned icon, and the message lives in exactly ONE element.
  test("INVARIANT 11: no flex anywhere, icon absolutely positioned, message in ONE element", () => {
    const b = blockedRefsBanner(refs);
    expect(b).not.toContain("display:flex");
    expect(b).not.toContain("display: flex");
    expect(b).toMatch(/<span[^>]+style="position:absolute/); // the icon is out of the text flow
    expect(b.match(/<p\b/g) ?? []).toHaveLength(1);          // the prose is one block paragraph
    const p = /<p style="margin:0">([\s\S]*?)<\/p>/.exec(b);
    expect(p).not.toBeNull();
    expect(p![1]).toBe(blockedRefsMessage(refs)); // the whole sentence, one text node, nothing interleaved
  });
  test("a url from the document is HTML-escaped (it is untrusted, agent-authored text)", () => {
    const b = blockedRefsBanner([{ kind: "script", url: `https://x/"><script>steal()</script>` }]);
    expect(b).not.toContain("<script>steal()");
    expect(b).toContain("&lt;script&gt;");
    expect(b).toContain("&quot;");
  });
  test("injects at the top of <body> when there is one", () => {
    const out = injectBlockedRefsBanner(`<!doctype html><html><body><h1>hi</h1></body></html>`, refs);
    expect(out.indexOf("lucid-blocked-refs")).toBeGreaterThan(out.indexOf("<body>"));
    expect(out.indexOf("lucid-blocked-refs")).toBeLessThan(out.indexOf("<h1>"));
  });
  test("falls back to </head>, then <html>, then after the doctype: never BEFORE the doctype (quirks mode)", () => {
    const headOnly = injectBlockedRefsBanner(`<!doctype html><html><head><title>t</title></head>`, refs);
    expect(headOnly.indexOf("lucid-blocked-refs")).toBeGreaterThan(headOnly.indexOf("</head>"));
    const htmlOnly = injectBlockedRefsBanner(`<html><h1>x</h1></html>`, refs);
    expect(htmlOnly.indexOf("lucid-blocked-refs")).toBeLessThan(htmlOnly.indexOf("<h1>"));
    const doctypeOnly = injectBlockedRefsBanner(`<!doctype html><h1>x</h1>`, refs);
    expect(doctypeOnly.startsWith("<!doctype html>")).toBe(true);
    const fragment = injectBlockedRefsBanner(`<h1>x</h1>`, refs);
    expect(fragment.startsWith(`<div id="lucid-blocked-refs"`)).toBe(true);
  });
  test("computes the refs itself when they are not passed (safe to call unconditionally)", () => {
    const out = injectBlockedRefsBanner(`<body><script src="https://cdn/x.js"></script></body>`);
    expect(out).toContain("lucid-blocked-refs");
    expect(out).toContain("https://cdn/x.js");
    expect(out).toContain(`<script src="https://cdn/x.js">`); // the document itself is not rewritten
  });
});

describe("previewTextDocument (P-PREVIEW.12): a markdown/text/csv preview becomes a real document", () => {
  test("a NON-markdown text kind stays an escaped monospace source view", () => {
    // Right call for a .json / .csv / .log: you want the bytes, not a rendering of them.
    const doc = previewTextDocument("text", '{"a": "<b>1</b> & 2"}', "data.json");
    expect(doc.startsWith("<!doctype html>")).toBe(true);
    expect(doc).toContain("<title>data.json</title>");
    expect(doc).toContain("&lt;b&gt;1&lt;/b&gt; &amp; 2"); // never live markup
    expect(doc).toContain("white-space:pre-wrap");
  });
  test("P-PREVIEW.16: markdown is RENDERED, not shown as its source", () => {
    const doc = previewTextDocument("markdown", "# Report\n\nsome **bold** text\n\n- one\n- two\n", "REPORT.md");
    expect(doc.startsWith("<!doctype html>")).toBe(true);
    expect(doc).toContain("<title>REPORT.md</title>");
    expect(doc).toContain("<h1>Report</h1>");
    expect(doc).toContain("<strong>bold</strong>");
    expect(doc).toContain("<li>one</li>");
    // The regression this replaces: the literal syntax must NOT survive as text.
    expect(doc).not.toContain("# Report");
    expect(doc).not.toContain("**bold**");
  });
  test("markdown renders tables and fenced code (a generated report's staples)", () => {
    const doc = previewTextDocument("markdown", "| a | b |\n| - | - |\n| 1 | 2 |\n\n```ts\nconst x = 1;\n```\n", "r.md");
    expect(doc).toContain("<table>");
    expect(doc).toContain("<th>a</th>");
    expect(doc).toContain("<td>1</td>");
    expect(doc).toContain("<pre><code");
    expect(doc).toContain("const x = 1;");
  });
  test("SANITATION: raw HTML in a .md is DISPLAYED, never executed", () => {
    const doc = previewTextDocument("markdown", "before\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n", "evil.md");
    // No LIVE element may be emitted. (The escaped text legitimately still contains the characters
    // "onerror=" inside `&lt;img ...&gt;`, which is the point: it is inert text, so assert on the tags.)
    expect(doc).not.toContain("<script>");
    expect(doc).not.toContain("<img");
    expect(doc).toContain("&lt;script&gt;");
    expect(doc).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
  test("SANITATION: an unsafe link scheme degrades to plain text; http/relative survive", () => {
    const bad = previewTextDocument("markdown", "[click](javascript:alert(1))\n", "l.md");
    expect(bad).not.toContain("javascript:");
    expect(bad).toContain("click");
    const good = previewTextDocument("markdown", "[site](https://example.com) and [rel](./other.md)\n", "l.md");
    expect(good).toContain('href="https://example.com"');
    expect(good).toContain('href="./other.md"');
    expect(good).toContain('rel="noreferrer noopener"');
  });
  test("SANITATION: an unsafe image src degrades to its alt text; a data: image survives", () => {
    const bad = previewTextDocument("markdown", "![shot](javascript:alert(1))\n", "i.md");
    expect(bad).not.toContain("javascript:");
    expect(bad).toContain("shot");
    const good = previewTextDocument("markdown", "![chart](data:image/png;base64,iVBORw0KGgo=)\n", "i.md");
    expect(good).toContain('src="data:image/png;base64,iVBORw0KGgo="');
  });
  test("INVARIANT 11: the markdown shell lays prose out as blocks, never as flex items", () => {
    // A flex container makes every raw text run AND every inline <b>/<code> its own flex item, which
    // shatters a sentence into narrow stacked columns. Prose here must never be inside one.
    const doc = previewTextDocument("markdown", "a sentence with **bold** and `code` in it\n", "r.md");
    expect(doc).not.toContain("display:flex");
    expect(doc).toContain("max-width:820px"); // a reading measure instead
  });
  test("html and svg are already documents and pass through untouched", () => {
    const page = `<!doctype html><body><h1>app</h1></body>`;
    expect(previewTextDocument("html", page, "a.html")).toBe(page);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>`;
    expect(previewTextDocument("svg", svg, "a.svg")).toBe(svg);
  });
  test("a huge text file is truncated with a visible note (the frame never gets a multi-MB DOM)", () => {
    const doc = previewTextDocument("text", "x".repeat(3 * 1024 * 1024), "run.log");
    expect(doc).toContain("[truncated at 1024 KB of 3072 KB]");
    expect(doc.length).toBeLessThan(1024 * 1024 + 4096);
  });
  test("empty text and label never throw", () => {
    expect(previewTextDocument("text", "", "")).toContain("<pre");
    expect(previewTextDocument("markdown", "", "")).toContain("<!doctype html>");
  });
  test("a huge MARKDOWN file is truncated too, and the note is visible in the rendering", () => {
    const doc = previewTextDocument("markdown", "x".repeat(3 * 1024 * 1024), "big.md");
    expect(doc).toContain("[truncated at 1024 KB of 3072 KB]");
  });
});
