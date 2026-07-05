// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Increment P-MARKET.1 — the Plugin Marketplace popup (ADR-0158). A curated, searchable catalog opened
// from the rail (or ⌘K), built on the same scrim-modal conventions as About//goal. Excalidraw is pinned
// first (product requirement); the rest follow Obsidian's "3rd Party Integrations" category by community
// downloads. The catalog is static and safe: each row's only live action is opening its GitHub repo.
// This demo proves the pure pieces (registry invariants, ordering, search, HTML builders, escaping).

import {
  MARKET_PLUGINS, sortMarket, filterMarket, fmtDownloads, marketplaceHtml, marketRowsHtml,
} from "../renderer/marketplace.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) { console.error("  ✗ " + msg); process.exit(1); }
  console.log("  ✓ " + msg);
}

console.log("== #ADR-0158 P-MARKET.1: the Plugin Marketplace popup ==\n");

console.log("[1] Excalidraw is the first option — the product requirement");
const sorted = sortMarket(MARKET_PLUGINS);
assert(sorted[0]!.id === "excalidraw", "Excalidraw sorts first (featured pin)");
assert(sorted[0]!.repo === "https://github.com/excalidraw/excalidraw", "…and points at github.com/excalidraw/excalidraw");

console.log("\n[2] the integrations follow Obsidian's category ranking (downloads desc)");
const ids = sorted.map((p) => p.id);
assert(ids.indexOf("git") < ids.indexOf("remotely-save") && ids.indexOf("remotely-save") < ids.indexOf("copilot"),
  "Git (2.8M) → Remotely Save (2M) → Copilot (1.5M) hold their community order");
assert(MARKET_PLUGINS.every((p) => /^https:\/\/github\.com\//.test(p.repo)), "every row's action is an https GitHub URL");
assert(fmtDownloads(6_487_654) === "6.5M" && fmtDownloads(2_765_510) === "2.8M" && fmtDownloads(null) === "",
  "download badges format as 6.5M / 2.8M; unverified counts show no badge");

console.log("\n[3] simple to use: one search box filters the list live");
assert(filterMarket(MARKET_PLUGINS, "ZOTERO").length === 1, "search is case-insensitive (ZOTERO → 1 hit)");
assert(filterMarket(MARKET_PLUGINS, "").length === MARKET_PLUGINS.length, "empty query keeps the full catalog");

console.log("\n[4] the modal is built like the other menus (scrim + dialog + close control)");
const h = marketplaceHtml(MARKET_PLUGINS, "");
assert(h.includes('role="dialog"') && h.includes("data-mkt-close") && h.includes('id="mktSearch"'),
  "dialog + close control + search input are all present");
assert(h.indexOf('data-mkt-id="excalidraw"') < h.indexOf('data-mkt-id="git"'), "Excalidraw renders above Git");
assert(marketRowsHtml(MARKET_PLUGINS, "<script>x</script>").includes("mkt-empty")
  && !marketRowsHtml(MARKET_PLUGINS, "<script>x</script>").includes("<script>"),
  "a hostile query renders escaped (no raw HTML)");

console.log("\n✓ P-MARKET.1 demo passed — the marketplace popup lists Excalidraw first, then Obsidian's top integrations.");
