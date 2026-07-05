// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/preview_activity.ts — P-PREVIEW.6a (ADR-0148): detect when the agent is LOOKING AT / testing the
// live preview (screenshot, open, inspect, or a future structured action) so the UI can glow the Preview
// panel + show a "reviewing / testing" pill. Pure + testable; drives visuals only (never a gate).
//
// A custom omp tool's NAME does not survive as ACP `kind` (mapped to "other"); omp renders the call TITLE,
// which for a preview tool keeps the tool name (e.g. "preview_open: /x.html", "preview_screenshot"). So we
// match the tool-name pattern against the title/kind. Some titles are human summaries — match those too.

/** A short, user-facing label for a preview tool-call title, or null when it isn't a preview activity. */
export function previewActivityLabel(titleOrKind: string): string | null {
  const t = (titleOrKind || "").toLowerCase();
  if (/\bpreview_screenshot\b/.test(t) || /screenshot of the (current )?preview|reviewing the preview/.test(t)) return "Reviewing the preview";
  if (/\bpreview_inspect\b/.test(t) || /inspect(ing)? the (preview|dom)/.test(t)) return "Inspecting the preview";
  if (/\bpreview_(click|type|fill|press|scroll)\b/.test(t) || /testing the (preview|ui)/.test(t)) return "Testing the preview";
  if (/\bpreview_open\b/.test(t)) return "Opening the preview";
  return null;
}

/** Whether a title/kind is any preview activity (convenience). */
export function isPreviewActivity(titleOrKind: string): boolean {
  return previewActivityLabel(titleOrKind) !== null;
}
