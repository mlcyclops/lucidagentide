// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_preview_3b.ts
//
// Increment P-PREVIEW.3b (ADR-0096) — a remote URL may preview in the panel, but ONLY through the egress
// gate. Proves the pure gating contract that backs the renderer (no live backend):
//   (1) a remote URL loads only when the egress allow-list already approves the site AND it's https;
//   (2) an approved-but-http URL never loads (no plaintext into the sandbox);
//   (3) an un-approved site never loads, even over https (the agent must request it via the egress flow);
//   (4) the iframe stays opaque-origin + hardened (same sandbox as local) when a remote page does load.

import { canPreviewRemote, PREVIEW_SANDBOX } from "../preview_resolve.ts";

const fail = (msg: string): never => { console.error(`FAIL: ${msg}`); process.exit(1); };
const ok = (msg: string): void => console.log(`   ${msg} ✓`);

console.log("== P-PREVIEW.3b — remote preview is egress-gated ==");

console.log("\n1) approved + https → loads");
if (!canPreviewRemote("https://docs.example.com/app", true)) fail("approved https should load");
ok("https://docs.example.com/app (approved) → loads");

console.log("\n2) approved but http → blocked (no plaintext into the sandbox)");
if (canPreviewRemote("http://docs.example.com/app", true)) fail("http must never load");
ok("http://… (approved) → blocked");

console.log("\n3) not approved → blocked even over https (agent must request via egress flow)");
if (canPreviewRemote("https://evil.test/x", false)) fail("unapproved must never load");
ok("https://evil.test/x (not approved) → blocked");

console.log("\n4) when a remote page DOES load, the sandbox is unchanged (opaque-origin, hardened)");
if (PREVIEW_SANDBOX.includes("allow-same-origin")) fail("remote must stay opaque-origin");
ok(`sandbox="${PREVIEW_SANDBOX}" applies to remote too — no same-origin`);

console.log("\nPASS — remote previews only an egress-approved https site, sandboxed; everything else stays gated.");
