// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/share_awareness.ts - P-PREVIEW-PWA.3 (ADR-0240): agent awareness of a live Session Share.
//
// While guests watch a shared session, the AGENT should know: it can then suggest broadcasting the Preview
// panel ("To phone"), phrase replies knowing an audience is present, and expect marked-up snapshots to come
// back as image prompts. The awareness block is delivered as a USER-TURN preamble (the same channel as the
// active-skill/recall blocks - never the frozen prefix, invariant #6) and is rebuilt from the live roster on
// EVERY turn, so it appears when the first guest joins and vanishes when the last one leaves (autodetect).
//
// SECURITY (invariant #5): the block is TRUSTED BY CONSTRUCTION - it is built from integers and fixed strings
// only. Guest display NAMES are guest-chosen (untrusted input) and are deliberately withheld: a name like
// "ignore previous instructions" must never ride into the prompt.

/** The roster reduced to what the agent may know: counts by access level. */
export interface ShareCounts { view: number; edit: number }

/** Reduce a roster to access counts (anything that isn't an edit guest counts as view-only). */
export function accessCounts(participants: ReadonlyArray<{ access?: string }>): ShareCounts {
  let view = 0;
  let edit = 0;
  for (const p of participants) {
    if (p.access === "edit") edit++;
    else view++;
  }
  return { view, edit };
}

/** Build the trusted awareness preamble, or null when nobody is watching (the block then simply vanishes
 *  from the next turn). Counts are clamped to sane non-negative integers. */
export function buildShareAwareness(counts: ShareCounts | null): string | null {
  if (!counts) return null;
  const view = Math.min(999, Math.max(0, Math.floor(counts.view)));
  const edit = Math.min(999, Math.max(0, Math.floor(counts.edit)));
  const n = view + edit;
  if (n <= 0) return null;
  const mix = [edit > 0 ? `${edit} can drive the session` : "", view > 0 ? `${view} view-only` : ""].filter(Boolean).join(", ");
  return `<session-share guests="${n}">${n === 1 ? "A remote guest is" : `${n} remote guests are`} watching this session live on their device (${mix}). They see replies and tool activity as they stream. When you build or change something visual, suggest broadcasting the Preview to them: the user taps "To phone" in the Preview toolbar, and phone guests can mark the snapshot up and send it back as an image prompt. Guest names are withheld (untrusted).</session-share>`;
}
