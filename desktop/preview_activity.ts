// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/preview_activity.ts — P-PREVIEW.6a (ADR-0153): detect when the agent is LOOKING AT / testing the
// live preview (screenshot, open, inspect, or a future structured action) so the UI can glow the Preview
// panel + show a "reviewing / testing" pill. Pure + testable; drives visuals only (never a gate).
//
// A custom omp tool's NAME does not survive as ACP `kind` (mapped to "other"); omp renders the call TITLE,
// which for a preview tool keeps the tool name (e.g. "preview_open: /x.html", "preview_screenshot"). So we
// match the tool-name pattern against the title/kind. Some titles are human summaries — match those too.

// P-PREVIEW.11b (ADR-0308): the title match below is DEAD whenever omp's intent tracing is on - the ACP
// call title becomes the model's intent prose, and the tool_call update carries no tool-name field at all.
// So each preview route now reports its own activity by KIND (dev.ts), and these labels are the single
// source both paths read. Keep them here, not duplicated at the call sites: two copies of a user-facing
// string drift, and then the same action shows two different pills depending on which path fired.
export type PreviewActivityKind = "open" | "screenshot" | "inspect" | "act";
export const PREVIEW_ACTIVITY: Record<PreviewActivityKind, string> = {
  open: "Opening the preview",
  screenshot: "Reviewing the preview",
  inspect: "Inspecting the preview",
  act: "Testing the preview",
};

/** A short, user-facing label for a preview tool-call title, or null when it isn't a preview activity.
 *  Retained as the intent-tracing-OFF fallback; the by-kind path above is what fires in practice. */
export function previewActivityLabel(titleOrKind: string): string | null {
  const t = (titleOrKind || "").toLowerCase();
  if (/\bpreview_screenshot\b/.test(t) || /screenshot of the (current )?preview|reviewing the preview/.test(t)) return PREVIEW_ACTIVITY.screenshot;
  if (/\bpreview_inspect\b/.test(t) || /inspect(ing)? the (preview|dom)/.test(t)) return PREVIEW_ACTIVITY.inspect;
  if (/\bpreview_(click|type|fill|press|scroll)\b/.test(t) || /testing the (preview|ui)/.test(t)) return PREVIEW_ACTIVITY.act;
  if (/\bpreview_open\b/.test(t)) return PREVIEW_ACTIVITY.open;
  return null;
}

/** Whether a title/kind is any preview activity (convenience). */
export function isPreviewActivity(titleOrKind: string): boolean {
  return previewActivityLabel(titleOrKind) !== null;
}
