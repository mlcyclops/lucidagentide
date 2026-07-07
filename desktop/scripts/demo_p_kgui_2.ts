// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Increment P-KGUI.2 — the Data dropdown (ADR-0185). The follow-up P-KGUI.1 promised: Import history /
// Export vault / CUI archive (plus the AI-extraction checkbox) fold from three header buttons into ONE
// "Data" dropdown on the same pattern as the views menu - hover tip lists the options, menu rows
// self-describe, the AI toggle is remembered state (never closes the menu), CUI keeps its danger look
// and its confirm toast.
//
// Run with: bun run desktop/scripts/demo_p_kgui_2.ts

import { kgDataMenuHtml } from "../renderer/kg_header.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) { console.error("  ✗ " + msg); process.exit(1); }
  console.log("  ✓ " + msg);
}

console.log("== #ADR-0185 P-KGUI.2: the Data dropdown ==\n");

console.log("[1] three buttons + a checkbox become one menu");
const h = kgDataMenuHtml(false);
assert(["import", "export", "cui"].every((v) => h.includes(`data-kgdata="${v}"`)), "Import / Export vault / CUI archive all live in the menu");
assert(h.includes("scanned by the security gate") && h.includes("CUI excluded by design") && h.includes("32 CFR 2002"),
  "every option explains itself inline - gate on import, CUI boundary on export, NARA on the archive");

console.log("\n[2] the AI-extraction toggle is state, not an action");
assert(h.includes('id="kgImportAI"') && !h.includes('id="kgImportAI" checked'), "toggle renders unchecked from state=false");
assert(kgDataMenuHtml(true).includes('id="kgImportAI" checked'), "…and checked from state=true (remembered across menu opens)");
assert((h.match(/data-kgdata=/g) ?? []).length === 3, "the toggle row carries NO action handle - flipping it never closes the menu");

console.log("\n[3] CUI keeps its guard rails");
assert((h.match(/kgv-danger/g) ?? []).length === 1, "only the CUI row carries the danger look (its confirm toast still guards the export)");

console.log("\n✓ P-KGUI.2 demo passed — the KG header is two labeled dropdowns instead of six controls.");
