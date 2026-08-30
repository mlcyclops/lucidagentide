// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/lane_event_adapter.ts - P-PWA-FOCUS.1: the ONE translation from a fleet lane's engine
// stream (`LaneEvent`) into the event union a guest actually renders (`ChatEvent`).
//
// Why a separate module: the lane engine and the chat transcript grew up as disjoint unions, and the phone
// now needs a lane's CONVERSATION, not just its status card. Rather than widening either union to please the
// other (which would leak lane-only concepts into the master transcript and vice versa), the seam is one
// pure function that decides, per variant, whether it is conversation at all.
//
// PURE, DOM-free, IO-free, global-free, and both imports are `import type` so they ERASE at build time.
// That matters more than it looks: `../fleet_lanes.ts` pulls node:fs/node:path/node:crypto and the ACP
// client, so a value import here would drag the whole lane engine into the phone PWA bundle and break it.
// Keep every import in this file type-only.

import type { LaneEvent } from "../fleet_lanes.ts";
import type { ChatEvent } from "../renderer/chat_events.ts";

type ToolEvent = Extract<ChatEvent, { type: "tool" }>;

/**
 * Translate one lane engine event into the guest-facing chat event, or null when it is not conversation.
 *
 * Returning null is a first-class outcome, not a failure: three lane variants are ALREADY on the phone by
 * another route, and anything this build cannot recognize is dropped rather than guessed.
 */
export function laneEventToChatEvent(e: LaneEvent): ChatEvent | null {
  switch (e.type) {
    case "token":
      return { type: "token", text: e.text };

    case "thinking":
      return { type: "thinking", text: e.text };

    case "tool": {
      const out: ToolEvent = { type: "tool", name: e.name, detail: e.detail };
      if (e.code) {
        // `LaneToolCode` and the ChatEvent `code` shape are field-for-field identical (path + the
        // content / oldText+newText / patch alternatives fleet_lanes.ts's #toolCode produces), so every
        // field carries across under its own meaning. Rebuilt key by key instead of spread or aliased:
        // a lane object that ever grows an engine-only field must not ride to a guest inside `code`, and
        // an absent field must stay ABSENT rather than serialize as an explicit undefined.
        const code: NonNullable<ToolEvent["code"]> = { path: e.code.path };
        if (e.code.content !== undefined) code.content = e.code.content;
        if (e.code.oldText !== undefined) code.oldText = e.code.oldText;
        if (e.code.newText !== undefined) code.newText = e.code.newText;
        if (e.code.patch !== undefined) code.patch = e.code.patch;
        out.code = code;
      }
      return out;
    }

    case "done":
      // Deliberately NO `text`. In the master stream `done.text` is the AUTHORITATIVE full reply and the
      // renderer replaces the streamed text with it to repair lossy streaming. The lane's `done` carries
      // no such reply, so synthesizing one (even "") would hand the phone an authoritative empty string
      // and erase the tokens it just streamed. Absent means "keep what you have".
      return { type: "done" };

    case "error":
      return { type: "lane-error", message: e.message };

    // The lane CARD already reports these, and it ships in the fleet-status snapshot every guest gets
    // regardless of what it is watching: `permission` and `auto-approved` are the card's pendingApproval,
    // `status` is its status colour. Re-emitting them as conversation would double-report the same fact in
    // two places that can then disagree, and an approval rendered as a transcript line would look
    // actionable on a surface that cannot answer it.
    case "permission":
    case "auto-approved":
    case "status":
      return null;

    default:
      // Fail-closed. A variant this build has no mapping for (a newer engine, a hand-rolled event) is
      // DROPPED, never coerced into the nearest-looking ChatEvent: a wrong event renders as confident
      // wrong content on the phone, which is strictly worse than a missing line.
      return null;
  }
}
