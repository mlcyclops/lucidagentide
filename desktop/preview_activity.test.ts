// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/preview_activity.test.ts — P-PREVIEW.6a (ADR-0148): the preview-activity label detector.

import { test, expect, describe } from "bun:test";
import { previewActivityLabel, isPreviewActivity } from "./preview_activity.ts";

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
