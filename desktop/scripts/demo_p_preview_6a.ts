// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Increment P-PREVIEW.6a — live "reviewing / testing" indicator (ADR-0148). When the agent looks at / tests
// the live preview (screenshot, inspect, open, or a future structured action), LUCID glows the Preview panel
// and shows a pill so the user SEES the review happen. This demo proves the pure detector that drives it.

import { previewActivityLabel, isPreviewActivity } from "../preview_activity.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) { console.error("  ✗ " + msg); process.exit(1); }
  console.log("  ✓ " + msg);
}

console.log("== #ADR-0148 P-PREVIEW.6a: a preview tool-call → a user-facing 'reviewing/testing' label ==\n");

console.log("[1] each preview tool maps to a label the pill shows");
assert(previewActivityLabel("preview_screenshot") === "Reviewing the preview", "preview_screenshot → Reviewing the preview");
assert(previewActivityLabel("preview_open: /tmp/app.html") === "Opening the preview", "preview_open → Opening the preview");
assert(previewActivityLabel("preview_inspect") === "Inspecting the preview", "preview_inspect → Inspecting the preview");
assert(previewActivityLabel("preview_click") === "Testing the preview", "preview_click → Testing the preview");

console.log("\n[2] human-summarized titles omp may render are matched too");
assert(previewActivityLabel("Taking a screenshot of the current preview") === "Reviewing the preview", "a summarized screenshot title still lights the pill");

console.log("\n[3] non-preview tools never trigger the indicator (visuals only, no false positives)");
assert(previewActivityLabel("edit") === null && previewActivityLabel("bash: ls") === null, "edit / bash → no indicator");
assert(isPreviewActivity("preview_screenshot") && !isPreviewActivity("write"), "isPreviewActivity mirrors the label");

console.log("\n✓ P-PREVIEW.6a demo passed — preview activity is detected; the panel glow + pill are driven by it.");
