// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/phone_snapshot.ts - P-PREVIEW-PWA.4 (ADR-0335): may this preview be captured and
// published to a phone guest?
//
// THE REPORTED BUG. A guest opened the PWA and found a preview card captioned `Preview: game.html` whose
// image was the engine's own failure page, "Can't preview this file - file not found or unreadable", with a
// transient "Opening the preview" toast sitting in the corner of the shot. It came back on every load, and
// it had nothing to do with the session the user was actually watching.
//
// Three separate mistakes stacked up to produce that one card:
//
// 1. NOTHING CHECKED THAT THE PREVIEW WORKED. `/api/preview/serve` answers a failed preview with HTTP 200
//    and an HTML body that says so, deliberately, because an iframe pointed at a 404 shows the browser's
//    error chrome instead of our message. Every auto-send guard asked "should we send" and none asked
//    "is there anything worth sending", so a failure rendered, captured, and shipped exactly like a success.
// 2. A SNAPSHOT IS PERMANENT. It is not a live window: it is a PNG in the chat transcript. The transcript is
//    replayed on every PWA load, so one bad capture is not a glitch the user can dismiss, it is a fixture.
// 3. THE CAPTURE SAW UI CHROME. `#toasts` is `position:fixed; right:18px; top:52px`, which is directly over
//    the top-right of the right-edge preview panel, so any toast alive at capture time is in the image.
//
// This module owns (1). The verdict is a value rather than a pile of early returns because the ORDER matters
// for correctness, not just tidiness: the resolve check has to come before the rate-limit slot is claimed,
// or a failed preview would burn the slot and suppress the good one 900ms behind it.

/** Everything the decision depends on. All of it observable before any pixel is captured. */
export interface SnapshotInputs {
  /** A relay or P2P share is live. Without one there is no guest to send to. */
  shareActive: boolean;
  /** The preview frame exists, is not hidden, and is the lane we are allowed to broadcast. */
  laneVisible: boolean;
  /** The frame's on-screen size. A zero-area rect captures nothing. */
  rect: { width: number; height: number };
  /** `probePreviewFile` said the target resolves. THIS is the check that was missing. */
  resolves: boolean;
  now: number;
  lastSentAt: number;
  gapMs: number;
}

/** Why a snapshot was or was not published. Every non-`send` value is a distinct, testable refusal. */
export type SnapshotVerdict = "send" | "no-share" | "no-lane" | "no-area" | "unresolved" | "too-soon";

/** Should this preview be captured and broadcast?
 *
 *  Ordering is load-bearing:
 *  - `no-share` / `no-lane` / `no-area` first, because they are free and mean "there is nothing to do".
 *  - `unresolved` BEFORE `too-soon`, so a failed preview is reported as failed rather than as rate-limited.
 *    The caller keys "did I burn the slot" off the verdict, and only `send` may claim it.
 *  - `too-soon` last, so the rate limit only ever suppresses a send that would otherwise have been valid. */
export function snapshotVerdict(i: SnapshotInputs): SnapshotVerdict {
  if (!i.shareActive) return "no-share";
  if (!i.laneVisible) return "no-lane";
  const w = Number(i.rect.width);
  const h = Number(i.rect.height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 2 || h < 2) return "no-area";
  if (!i.resolves) return "unresolved";
  const now = Number(i.now);
  const last = Number(i.lastSentAt);
  const gap = Number(i.gapMs);
  // A non-finite clock or gap must not read as "plenty of time has passed". Refuse instead.
  if (!Number.isFinite(now) || !Number.isFinite(last) || !Number.isFinite(gap)) return "too-soon";
  if (now - last < gap) return "too-soon";
  return "send";
}

/** The caption a guest sees under the snapshot. Basename only: a guest has no business seeing the
 *  operator's directory layout, and the full path would not fit on a phone anyway.
 *
 *  There is deliberately NO fallback to the whole path. The version this replaces ended in `|| path`, which
 *  looks like a safety net and is actually the leak: `pop()` already returns the input when it contains no
 *  separator, so that branch is reached ONLY for input that has no basename at all (`"/"`, `""`, blanks),
 *  which is exactly when echoing the raw path is the wrong answer. */
export function snapshotLabel(path: string): string {
  const base = path.replace(/[\\/]+$/, "").split(/[\\/]/).pop()?.trim();
  return `Preview: ${base || "file"}`;
}
