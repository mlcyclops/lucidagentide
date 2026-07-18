// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_preview_pwa1.ts
//
// P-PREVIEW-PWA.1 (ADR-0237): "send the desktop Preview panel to my phone", proven on the PURE data path.
// The live capture (Electron capturePage) + broadcast + on-device display are Electron/deploy-gated, exactly
// like the Drive path; here we prove the parts that ARE headless-testable: the bandwidth-light downscale
// sizing, and that a host `preview-snapshot` event folds into a tappable phone thumbnail whose image data URL
// is NEVER inlined into the transcript HTML (hydrated as an <img> property) and whose label is HTML-escaped.
//
// Run with: bun run harness/scripts/demo_preview_pwa1.ts

import { fitWithin, MAX_SNAPSHOT_EDGE } from "../../desktop/collab/preview_snapshot.ts";
import { foldEvent, renderItem, type ViewItem } from "../../desktop/collab/pwa_view.ts";
import type { ChatEvent } from "../../desktop/renderer/chat_events.ts";

function fail(m: string): never { console.error(`FAIL: ${m}`); process.exit(1); }
function ok(m: string): void { console.log(`  PASS  ${m}`); }
const fold = (events: ChatEvent[]): ViewItem[] => events.reduce(foldEvent, [] as ViewItem[]);

console.log("P-PREVIEW-PWA.1 demo - preview snapshot to phone (pure path; live capture is on-device)\n");

// [1] downscale sizing: cap the longest edge, preserve aspect, never upscale
const big = fitWithin(2560, 1440);
if (big.w !== 1280 || big.h !== 720) fail(`a 2560x1440 capture should downscale to 1280x720, got ${big.w}x${big.h}`);
if (MAX_SNAPSHOT_EDGE !== 1280) fail("MAX_SNAPSHOT_EDGE drifted from the demo's expectation");
ok("a 2560x1440 capture downscales to 1280x720 (longest edge capped, aspect kept, tens-of-KB not MBs)");
const small = fitWithin(800, 600);
if (small.w !== 800 || small.h !== 600) fail("a small capture must never be upscaled");
ok("an already-small capture is never upscaled");

// [2] the host broadcasts a `preview-snapshot`; the phone folds it into a tappable snapshot item
const image = "data:image/png;base64,VESSELPIXELS0000";
const items = fold([{ type: "token", text: "building the UI..." }, { type: "preview-snapshot", image, label: "Home screen" }]);
const shot = items.find((i) => i.kind === "preview");
if (!shot || shot.kind !== "preview") fail("a preview-snapshot event must fold into a preview item");
if (shot.image !== image || shot.label !== "Home screen" || shot.id !== "shot-0") fail("the preview item lost image/label/id");
ok(`the phone folds the snapshot into a preview item (id ${shot.id}, label "${shot.label}")`);

// [3] render is hydration-safe: the image data URL is NEVER inlined into the transcript HTML
const html = renderItem(shot);
if (html.includes("VESSELPIXELS")) fail("the image data URL must NOT be inlined into the HTML (hydrated as an <img> property)");
if (!html.includes('data-shot="shot-0"') || !html.includes("cu-shot-img")) fail("the thumbnail must be a tappable, hydratable element");
ok("the snapshot renders as a tappable thumbnail; the data URL is hydrated as a property, never inlined");

// [4] a hostile snapshot label is HTML-escaped (the phone never turns host-authored text into markup)
const evil = renderItem({ kind: "preview", image: "data:image/png;base64,x", label: "<img src=x onerror=alert(1)>", id: "shot-0" });
if (evil.includes("onerror=alert(1)>")) fail("a hostile snapshot label must be HTML-escaped");
if (!evil.includes("&lt;img")) fail("the escaped label should be present as text");
ok("a hostile snapshot label is HTML-escaped - no markup injection on the phone");

// [5] multiple snapshots get stable, distinct ids so their <img> src survives every transcript re-render
const two = fold([{ type: "preview-snapshot", image: "data:image/png;base64,A" }, { type: "preview-snapshot", image: "data:image/png;base64,B" }]);
if (two[0]?.kind !== "preview" || two[1]?.kind !== "preview" || two[0].id !== "shot-0" || two[1].id !== "shot-1") fail("multiple snapshots must get stable distinct ids");
ok("multiple snapshots get stable distinct ids (shot-0, shot-1) for re-render hydration");

console.log("\nP-PREVIEW-PWA.1 demo complete - the preview downscales small, folds into a tappable phone thumbnail, is hydration-safe + escaped, and stays stable across re-renders. Live capture->broadcast->phone is the on-device step (Electron capturePage + deployed PWA).");
process.exit(0);
