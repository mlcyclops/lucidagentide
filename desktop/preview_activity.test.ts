// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/preview_activity.test.ts — P-PREVIEW.6a (ADR-0153): the preview-activity label detector.

import { test, expect, describe } from "bun:test";
import { PREVIEW_ACTIVITY, previewActivityLabel, isPreviewActivity, type PreviewActivityKind } from "./preview_activity.ts";

describe("previewActivityLabel", () => {
  test("maps each preview tool title to a user-facing label", () => {
    expect(previewActivityLabel("preview_screenshot")).toBe("Reviewing the preview");
    expect(previewActivityLabel("preview_open: /tmp/app.html")).toBe("Opening the preview");
    expect(previewActivityLabel("preview_inspect")).toBe("Inspecting the preview");
    expect(previewActivityLabel("preview_click")).toBe("Testing the preview");
    expect(previewActivityLabel("preview_type")).toBe("Testing the preview");
  });
  test("also matches human-summarized titles omp may render", () => {
    expect(previewActivityLabel("Taking a screenshot of the current preview")).toBe("Reviewing the preview");
    expect(previewActivityLabel("Inspecting the DOM of the preview")).toBe("Inspecting the preview");
  });
  test("returns null for non-preview tools + isPreviewActivity mirrors it", () => {
    expect(previewActivityLabel("edit")).toBeNull();
    expect(previewActivityLabel("bash: ls")).toBeNull();
    expect(previewActivityLabel("")).toBeNull();
    expect(isPreviewActivity("preview_screenshot")).toBe(true);
    expect(isPreviewActivity("write")).toBe(false);
  });
});

// P-PREVIEW.11b (ADR-0308): the pills are now emitted BY KIND from the route the agent hit, because the
// title they used to be inferred from is the model's intent prose once intent tracing is on. Two paths to
// the same user-facing string is exactly how they drift, so this pins them together.
describe("PREVIEW_ACTIVITY (by-kind labels)", () => {
  test("every kind has a non-empty label", () => {
    const kinds: PreviewActivityKind[] = ["open", "screenshot", "inspect", "act"];
    for (const k of kinds) expect(PREVIEW_ACTIVITY[k].length).toBeGreaterThan(0);
    expect(Object.keys(PREVIEW_ACTIVITY).sort()).toEqual(["act", "inspect", "open", "screenshot"]);
  });
  test("DRIFT GUARD: the by-kind label equals what the title path produces for the same tool", () => {
    expect(previewActivityLabel("preview_screenshot")).toBe(PREVIEW_ACTIVITY.screenshot);
    expect(previewActivityLabel("preview_inspect")).toBe(PREVIEW_ACTIVITY.inspect);
    expect(previewActivityLabel("preview_click")).toBe(PREVIEW_ACTIVITY.act);
    expect(previewActivityLabel("preview_type")).toBe(PREVIEW_ACTIVITY.act);
    expect(previewActivityLabel("preview_open: /tmp/app.html")).toBe(PREVIEW_ACTIVITY.open);
  });
  test("an intent-shadowed title still yields nothing - which is WHY the by-kind path exists", () => {
    // Real titles seen with intent tracing on. None of them names a tool, so the fallback cannot fire.
    expect(previewActivityLabel("Checking the rendered layout")).toBeNull();
    expect(previewActivityLabel("Looking at the deck")).toBeNull();
    expect(previewActivityLabel("Clicking the submit button")).toBeNull();
  });
});
