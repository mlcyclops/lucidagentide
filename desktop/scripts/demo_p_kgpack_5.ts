// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_kgpack_5.ts — P-KGPACK.5 (ADR-0205): the Role KG Packs storefront (pure builders).
//
// The public repo ships the SKU shopfront + the gated import path (P-KGPACK.4, demo'd there live); the packs
// themselves live in the private add-on repo. This exercises the PURE catalog builders (the app.ts scrim +
// window.open + import wiring is typechecked + QA'd live, like the Plugin Marketplace): the curated registry
// is well-formed, the filter narrows, rows link out to the product page, and the modal offers the gated
// "Import a pack you own" action.

import { KG_PACKS, KG_PACKS_URL, filterKgPacks, kgPackRowsHtml, kgPacksHtml } from "../renderer/kg_packs.ts";

function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(`ASSERT FAILED: ${msg}`); }

console.log("== [1/3] the curated storefront is well-formed ==");
assert(KG_PACKS.length >= 3, "at least a few role packs");
assert(new Set(KG_PACKS.map((p) => p.id)).size === KG_PACKS.length, "pack ids are unique");
assert(KG_PACKS.every((p) => p.url === KG_PACKS_URL && p.author.includes("TechLead 187")), "every row points at the product page + names the author");
console.log(`   ${KG_PACKS.length} role packs: ${KG_PACKS.map((p) => p.name).join(", ")}`);

console.log("== [2/3] filter-as-you-type narrows the shelf ==");
assert(filterKgPacks(KG_PACKS, "").length === KG_PACKS.length, "empty query → everything");
assert(filterKgPacks(KG_PACKS, "RMF").some((p) => p.id === "cmmc-rmf-security-lead"), "‘RMF’ → the security lead pack");
// 63d039c ("SPM flagship replaces capture") retired the `capture-proposal-manager` SKU and moved that word
// to the BD pack, but this assertion kept the old id, so the demo has been RED since that commit - demos
// are not in `bun test`, so nothing caught it. Assert against the pack the catalog actually ships.
assert(filterKgPacks(KG_PACKS, "capture").some((p) => p.id === "dow-dod-business-development"), "‘capture’ → the BD capture pack");
assert(filterKgPacks(KG_PACKS, "zzz").length === 0, "no match → empty");
console.log("   ‘RMF’ → CMMC & RMF Security Lead · ‘capture’ → Business Development Capture Manager");

console.log("== [3/3] rows link out; the modal offers the gated import ==");
const rows = kgPackRowsHtml(KG_PACKS, "");
// P-KGMARKET.5 (ADR-0333) turned "Get pack" from a link at KG_PACKS_URL into an in-app purchase flow, so
// the row now carries data-kgpack-get="<id>" instead of data-kgpack-repo="<url>". Same staleness as above:
// the increment that changed the markup did not update this demo.
assert(rows.includes(`data-kgpack-get="${KG_PACKS[0]!.id}"`) && rows.includes("Get pack"), "rows carry a Get-pack action");
assert(kgPackRowsHtml(KG_PACKS, "zzz").includes("No KG pack matches"), "empty state is a message");
const modal = kgPacksHtml(KG_PACKS, "");
assert(modal.includes('id="kgpackSearch"') && modal.includes("data-kgpack-import") && modal.includes("Import a pack you own"), "modal has search + the gated import action");
console.log("   Get-pack links present · Import-a-pack-you-own routes to the P-KGPACK.4 gate");

console.log("== demo-P-KGPACK.5 OK ==");
