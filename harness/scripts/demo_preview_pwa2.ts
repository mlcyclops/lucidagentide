// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_preview_pwa2.ts
//
// P-PREVIEW-PWA.2 (ADR-0239): phone MARKUP on a preview snapshot + send-back, proven on the PURE path.
// The canvas ink itself is DOM-only; what IS headless-provable and load-bearing:
//   1. strokes live in NORMALIZED image space - clamped into the image, resize/rotation-proof, and they scale
//      losslessly onto the natural-size composite;
//   2. the on-screen pen and the composite pen use the SAME width formula (ink parity, penWidthFor);
//   3. the sent-back composite rides the SAME fail-closed attachment validation as a pasted image
//      (P-REMOTE.8): image/(png|jpeg|webp|gif) accepted, script-capable SVG refused.
//
// Run with: bun run harness/scripts/demo_preview_pwa2.ts

import { penWidthFor, toNormPoint } from "../../desktop/collab/preview_snapshot.ts";
import { acceptAttachment, type Attachment } from "../../desktop/renderer/composer_attachments.ts";

function fail(m: string): never { console.error(`FAIL: ${m}`); process.exit(1); }
function ok(m: string): void { console.log(`  PASS  ${m}`); }

console.log("P-PREVIEW-PWA.2 demo - phone markup + send-back (pure path; the ink itself is on-device)\n");

// [1] a finger position maps into normalized image space and CLAMPS at the edges
const rect = { left: 40, top: 120, width: 320, height: 180 }; // the on-screen image rect
const mid = toNormPoint(200, 210, rect);
if (mid.x !== 0.5 || mid.y !== 0.5) fail(`center finger should be (0.5,0.5), got (${mid.x},${mid.y})`);
const off = toNormPoint(9999, -50, rect);
if (off.x !== 1 || off.y !== 0) fail("an off-image stroke must clamp to the edge, never leave the composite");
ok("strokes are normalized to image space and clamp at the edges (never outside the composite)");

// [2] the same normalized stroke lands at the right pixel at BOTH scales (screen canvas vs natural composite)
const p = toNormPoint(120, 165, rect); // 25% across, 25% down
const onScreen = { x: p.x * 320, y: p.y * 180 };
const onComposite = { x: p.x * 1280, y: p.y * 720 };
if (Math.round(onScreen.x) !== 80 || Math.round(onComposite.x) !== 320) fail("normalized strokes must scale losslessly to both targets");
ok("a stroke scales losslessly: 25% across = px 80 on a 320px screen, px 320 on the 1280px composite");

// [3] pen-width parity: screen and composite use the SAME formula, so the ink reads identically
if (penWidthFor(320) !== 3 || penWidthFor(1280) !== 6) fail("penWidthFor drifted");
ok(`pen width is one formula at every scale (320px -> ${penWidthFor(320)}, 1280px -> ${penWidthFor(1280)})`);

// [4] the composited PNG rides the SAME fail-closed attachment gate as a pasted image (P-REMOTE.8)
const staged: Attachment[] = [];
const png = acceptAttachment(staged, "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg", "att_1", "preview-markup.png");
if (!png.ok || !png.attachment) fail("a PNG composite must pass the attachment gate");
ok("the marked-up PNG passes the same validated attachment path as a pasted image");

// [5] a script-capable payload is refused (SVG can carry <script>)
const svg = acceptAttachment(staged, "data:image/svg+xml;base64,PHN2Zz48c2NyaXB0Pg", "att_2", "evil.svg");
if (svg.ok) fail("an SVG data URL must be refused (script-capable)");
ok("a script-capable SVG payload is refused by the same gate (fail-closed)");

console.log("\nP-PREVIEW-PWA.2 demo complete - normalized, clamped, scale-lossless strokes; one pen formula at every scale; and the send-back is gated by the exact P-REMOTE.8 attachment validation. The finger ink + composite render are the on-device step.");
process.exit(0);
