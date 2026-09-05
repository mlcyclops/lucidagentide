// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_preview_2.ts
//
// Increment P-PREVIEW.2 (ADR-0096) — auto-surface the app the agent just built. Proves (no live omp/DOM)
// the pure detection that drives it: when the agent's tool stream carries a write/edit of a browser-
// previewable file, LUCID emits a `preview-available` event and lights up the Preview panel on it.
//   (1) a write of a previewable file → its path (auto-surfaced);
//   (2) a write of a non-previewable file (.ts/.css/.exe) → null (no preview);
//   (3) a NON-write tool (read/bash) → null, even on an .html (only the agent BUILDING a page surfaces);
//   (4) the surfaced path then flows through the same fail-safe resolver before anything renders.
//
// P-PREVIEW.12 widened "previewable" from .html/.svg to the whole kind table (images, markdown, text-ish
// data, pdf), because a model that wrote a markdown report or a chart PNG previously had NO way to show it.
// So step (1) now covers those kinds too, and step (2) keeps only genuinely non-renderable files out.

import { previewablePath, resolvePreview } from "../preview_resolve.ts";

const fail = (msg: string): never => { console.error(`FAIL: ${msg}`); process.exit(1); };
const ok = (msg: string): void => console.log(`   ${msg} ✓`);

console.log("== P-PREVIEW.2 — auto-surface the agent's freshly-written app ==");

// (1) The minesweeper case continued: the agent's write tool produces game.html → auto-surface.
console.log("\n1) a write of a previewable file → surfaced");
for (const [tool, ri, want] of [
  ["write", { path: "C:\\Users\\neorc\\Documents\\My Music\\hormuz-minesweeper.html" }, "C:\\Users\\neorc\\Documents\\My Music\\hormuz-minesweeper.html"],
  ["edit", { file_path: "/home/n/app.htm" }, "/home/n/app.htm"],
  ["write", { filename: "diagram.svg" }, "diagram.svg"],
  // P-PREVIEW.12: the kinds that used to be silently refused.
  ["write", { path: "/home/n/REPORT.md" }, "/home/n/REPORT.md"],
  ["write", { path: "/home/n/data.json" }, "/home/n/data.json"],
  ["write", { path: "/home/n/rows.csv" }, "/home/n/rows.csv"],
  ["write", { path: "/home/n/chart.png" }, "/home/n/chart.png"],
  ["write", { path: "/home/n/run.log" }, "/home/n/run.log"],
  ["write", { path: "/home/n/spec.pdf" }, "/home/n/spec.pdf"],
] as Array<[string, any, string]>) {
  const got = previewablePath(tool, ri);
  if (got !== want) fail(`${tool} ${JSON.stringify(ri)} → ${got}, want ${want}`);
  ok(`${tool} → surfaces ${got}`);
}

// (2) Non-previewable writes don't fire: source, stylesheets, bundles and binaries stay out of the panel.
console.log("\n2) a write of a non-previewable file → no preview");
for (const ri of [{ path: "src/index.ts" }, { path: "styles.css" }, { path: "bundle.js" }, { path: "setup.exe" }, { path: "Makefile" }]) {
  if (previewablePath("write", ri) !== null) fail(`should not surface: ${JSON.stringify(ri)}`);
  ok(`write ${ri.path} → not surfaced`);
}

// (3) Only BUILDING a page surfaces — reading/inspecting one does not.
console.log("\n3) a non-write tool → no preview (even on an .html)");
// The write-class gate is what stops a `read` of some random .png hijacking the panel now that images
// are previewable, so it is exercised against a newly-admitted kind too.
for (const tool of ["read", "bash", "search", "grep"]) {
  if (previewablePath(tool, { path: "game.html" }) !== null) fail(`${tool} must not surface a preview`);
  if (previewablePath(tool, { path: "/home/n/chart.png" }) !== null) fail(`${tool} must not surface a preview`);
  ok(`${tool} game.html / chart.png → not surfaced`);
}

// (4) The surfaced path is still gated by the resolver before it renders.
console.log("\n4) the surfaced path flows through the fail-safe resolver");
const p = previewablePath("write", { path: "C:\\app\\index.html" })!;
const r = resolvePreview(p);
if (r.kind !== "local" || !r.src.startsWith("file://")) fail("surfaced path must resolve to a local file:// src");
ok(`surfaced ${p} → ${r.kind} (${r.src})`);

console.log("\nPASS — building a browser page auto-surfaces it; reading or non-page writes never do.");
