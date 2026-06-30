// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_preview_2.ts
//
// Increment P-PREVIEW.2 (ADR-0096) — auto-surface the app the agent just built. Proves (no live omp/DOM)
// the pure detection that drives it: when the agent's tool stream carries a write/edit of a browser-
// previewable file, LUCID emits a `preview-available` event and lights up the Preview panel on it.
//   (1) a write of an .html/.svg → its path (auto-surfaced);
//   (2) a write of a non-previewable file (.ts/.md) → null (no preview);
//   (3) a NON-write tool (read/bash) → null, even on an .html (only the agent BUILDING a page surfaces);
//   (4) the surfaced path then flows through the same fail-safe resolver before anything renders.

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
] as Array<[string, any, string]>) {
  const got = previewablePath(tool, ri);
  if (got !== want) fail(`${tool} ${JSON.stringify(ri)} → ${got}, want ${want}`);
  ok(`${tool} → surfaces ${got}`);
}

// (2) Non-previewable writes don't fire.
console.log("\n2) a write of a non-previewable file → no preview");
for (const ri of [{ path: "src/index.ts" }, { path: "notes.md" }, { path: "data.json" }]) {
  if (previewablePath("write", ri) !== null) fail(`should not surface: ${JSON.stringify(ri)}`);
  ok(`write ${ri.path} → not surfaced`);
}

// (3) Only BUILDING a page surfaces — reading/inspecting one does not.
console.log("\n3) a non-write tool → no preview (even on an .html)");
for (const tool of ["read", "bash", "search", "grep"]) {
  if (previewablePath(tool, { path: "game.html" }) !== null) fail(`${tool} must not surface a preview`);
  ok(`${tool} game.html → not surfaced`);
}

// (4) The surfaced path is still gated by the resolver before it renders.
console.log("\n4) the surfaced path flows through the fail-safe resolver");
const p = previewablePath("write", { path: "C:\\app\\index.html" })!;
const r = resolvePreview(p);
if (r.kind !== "local" || !r.src.startsWith("file://")) fail("surfaced path must resolve to a local file:// src");
ok(`surfaced ${p} → ${r.kind} (${r.src})`);

console.log("\nPASS — building a browser page auto-surfaces it; reading or non-page writes never do.");
