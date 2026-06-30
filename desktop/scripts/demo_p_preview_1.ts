// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_preview_1.ts
//
// Increment P-PREVIEW.1 (ADR-0096) — an in-app browser preview the user can open for the apps the agent
// builds. Proves (no Electron / no DOM) the fail-safe rule that decides what the sandboxed <iframe> renders:
//   (1) a local file the agent just wrote (the minesweeper case) resolves to a file:// src and IS rendered;
//   (2) a real http(s) URL is recognized but NOT auto-loaded — remote is egress-gated in P-PREVIEW.3;
//   (3) anything ambiguous (bare host / relative path) or empty is BLOCKED — never silently rendered;
//   (4) Windows / POSIX / file:// targets all normalize to a correct file:// URL.
// The panel + iframe are DOM-verified in the dev server; the Electron capturePage screenshot is verified
// live in the packaged app (it can't run here) — see the PR's verification-boundary note.

import { resolvePreview, toFileUrl } from "../preview_resolve.ts";

const fail = (msg: string): never => { console.error(`FAIL: ${msg}`); process.exit(1); };
const ok = (msg: string): void => console.log(`   ${msg} ✓`);

console.log("== P-PREVIEW.1 — in-app preview target resolver ==");

// (1) The minesweeper case: a local HTML file the agent wrote.
console.log("\n1) a local file the agent built → rendered");
const mine = resolvePreview("C:\\Users\\neorc\\Documents\\My Music\\hormuz-minesweeper.html");
if (mine.kind !== "local") fail("a local html file must render");
if (mine.src !== "file:///C:/Users/neorc/Documents/My Music/hormuz-minesweeper.html") fail(`bad src: ${mine.src}`);
ok(`local → ${mine.label} (${mine.src})`);

// (2) Remote is recognized but gated, not auto-loaded.
console.log("\n2) http(s) URL → recognized but NOT auto-loaded (egress-gated, P-PREVIEW.3)");
const rem = resolvePreview("https://example.com/app");
if (rem.kind !== "remote" || rem.src !== "") fail("remote must not be auto-rendered");
ok(`remote → gated (src empty): ${rem.reason}`);

// (3) Ambiguous / empty → blocked, never rendered.
console.log("\n3) ambiguous / empty → blocked (never silently rendered)");
for (const t of ["example.com/x", "game.html", "", "   "]) {
  const r = resolvePreview(t);
  if (r.kind !== "blocked" || r.src !== "") fail(`must be blocked: "${t}"`);
  ok(`blocked → "${t}" (${r.reason})`);
}

// (4) Path normalization.
console.log("\n4) file:// normalization across path shapes");
const cases: Array<[string, string]> = [
  ["C:\\a\\b.html", "file:///C:/a/b.html"],
  ["C:/a/b.html", "file:///C:/a/b.html"],
  ["/home/n/b.html", "file:///home/n/b.html"],
  ["file:///already/url.html", "file:///already/url.html"],
];
for (const [inp, want] of cases) {
  const got = toFileUrl(inp);
  if (got !== want) fail(`toFileUrl(${inp}) = ${got}, want ${want}`);
  ok(`${inp} → ${got}`);
}

console.log("\nPASS — the preview renders local files the agent builds, gates remote, and blocks the ambiguous.");
