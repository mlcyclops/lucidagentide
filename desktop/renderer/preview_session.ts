// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/preview_session.ts - P-PREVIEW.19 (ADR-0339): the Preview panel does not follow you into
// the next conversation.
//
// THE BUG THIS EXISTS FOR, reported with a screenshot: starting a NEW prompt session opened the Preview
// panel, every time, on `/tmp/x.pdf`, reading "Can't preview this file - file not found or unreadable".
// A POSIX path, on a Windows machine, for a file the user never opened, in a conversation that had nothing
// to do with it.
//
// Three defects compounded, and each alone would have been survivable:
//
// 1. AN UNRESOLVABLE TARGET WAS STILL REMEMBERED. `onPreviewAvailable` set `state.lastPreviewablePath` from
//    the path alone. It never asked whether the file previews, so a failed open was memorialised exactly
//    like a successful one. That is how a path that never once rendered became sticky.
// 2. IT SURVIVED THE SESSION BOUNDARY. `state.lastPreviewablePath` is renderer module state, and a new chat
//    session does NOT reload the window, so `newSession()` left it sitting there. The agent's last write
//    belongs to a conversation that is over; carrying it forward is carrying a stranger's context.
// 3. AND IT RE-OPENED THE PANEL. Both `openPreview()` and the preview-activity pill read that field and
//    surface the panel for it, so the stale value did not merely persist, it took over the screen.
//
// ADR-0329 already drew this line once for file KINDS: being able to render something is not the same as
// being worth interrupting a human for. This is that principle applied to TIME. A preview earns the screen
// because it is live and relevant, not because it once existed.
//
// Pure decision only: app.ts owns the DOM, the probe call, and the frame teardown.

/** The preview panel's per-lane targets, as the session boundary sees them. */
export interface PreviewLanes {
  /** The user's OWN tab. Theirs, opened by hand. Never cleared by us. */
  yours: string;
  /** The AGENT tab: whatever the agent last wrote or opened. Scoped to its conversation. */
  agent: string;
  /** `state.lastPreviewablePath`: the field that re-opens the panel. */
  lastPreviewable: string;
}

/** What the preview state becomes when a NEW session starts, plus whether anything actually moved.
 *
 *  The ASYMMETRY is the substance here: the agent lane is conversation-scoped and gets dropped, while the
 *  user's own lane is not ours to close. Someone reading a PDF in the Yours tab who starts a new chat keeps
 *  their PDF, and that difference is the reason this is a decision rather than a `reset()`.
 *
 *  `changed` lets the caller skip the DOM teardown and its repaint in the common case where the agent lane
 *  was already empty, which is most new sessions. */
export function previewAfterNewSession(prev: PreviewLanes): { lanes: PreviewLanes; changed: boolean } {
  const changed = prev.agent !== "" || prev.lastPreviewable !== "";
  return { lanes: { yours: prev.yours, agent: "", lastPreviewable: "" }, changed };
}
