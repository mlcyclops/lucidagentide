// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/ailoc_view.ts — P-LOC.3 (ADR-0095): the pure rule behind the AI-authored code section's
// visibility, kept out of the renderer so it is testable.
//
// The section USED to render only `if (d?.aiLoc)`, so when the roll-up came back null (empty ledger, or
// the obs DB momentarily unreadable) the whole thing silently disappeared — indistinguishable from "the
// feature was removed" (the "where did the AI-LOC go?" report). The fix: the section is ALWAYS present
// while a session is active; it shows DATA only when at least one edit was actually recorded, and an
// explicit empty state otherwise. This module encodes that decision; the renderer just paints it.

import type { AiLocSummary } from "./renderer/bridge.ts";

/** Does the AI-authored code section have real data to show (≥1 recorded edit)? When false, the renderer
 *  shows the empty state rather than nothing — so the section never silently vanishes. Pure, null-safe. */
export function aiLocHasData(aiLoc: AiLocSummary | null | undefined): boolean {
  return !!aiLoc && aiLoc.totals.edits > 0;
}
