// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Increment P-KGUI.1 — the KG flyout header, decluttered (ADR-0184). The header carried a vertical
// three-button stack (Relate / Code graph / Compiled KB) that made it thick, plus a redundant tiny
// icon next to a long title. Now: the title is "KG" (hover says Knowledge Graph), the icon is gone,
// and the stack is ONE dropdown button - its label names the graph you're viewing, its hover tip
// says it's a dropdown and lists the options, and the menu explains each option inline.
//
// Run with: bun run desktop/scripts/demo_p_kgui_1.ts

import { kgViewActive, kgViewLabel, kgViewsMenuHtml } from "../renderer/kg_header.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) { console.error("  ✗ " + msg); process.exit(1); }
  console.log("  ✓ " + msg);
}

console.log("== #ADR-0184 P-KGUI.1: the KG header, decluttered ==\n");

console.log("[1] one button tells you where you are");
assert(kgViewLabel({ relateOn: false, codeMode: false, kbMode: false }) === "Personal", "default label: Personal");
assert(kgViewLabel({ relateOn: false, codeMode: true, kbMode: false }) === "Code graph", "code mode: the label follows");
assert(kgViewLabel({ relateOn: true, codeMode: false, kbMode: false }) === "Personal", "relate is a tool, not a view - label stays Personal");
assert(kgViewActive({ relateOn: true, codeMode: false, kbMode: false }), "…but relate still lights the button");

console.log("\n[2] the dropdown replaces the triple stack - and documents itself");
const menu = kgViewsMenuHtml({ relateOn: false, codeMode: true, kbMode: false });
assert(["relate", "code", "kb"].every((v) => menu.includes(`data-kgview="${v}"`)), "all three former buttons live in the menu");
assert(menu.includes("Code graph ✓"), "the active view is checked in the menu");
assert(menu.includes("your own relationships") && menu.includes("page graph"), "every option explains itself inline (no hover hunting)");

console.log("\n✓ P-KGUI.1 demo passed — one labeled dropdown instead of a three-button stack; 'KG' with a Knowledge Graph hover.");
