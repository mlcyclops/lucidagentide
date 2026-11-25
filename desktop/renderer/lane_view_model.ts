// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/lane_view_model.ts - P-VIZ.LANE1 (ADR-0683): the pure rules behind lane_view.ts, the one lane
// renderer the Fleet card and the Agent Worlds node panel share. No DOM: whether a lane composer sends or stages,
// whether a pasted image may ride the next prompt (the composer's own type, count and byte limits), how a staged
// prompt moves in its queue, and what a staged chip shows before the next poll.

import { base64Bytes, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, parseImageDataUrl } from "./composer_attachments.ts";
import type { LaneImage } from "./bridge.ts";

/** P-FLEET.L3: a busy lane's Send becomes Stage. Busy is a turn this surface streams, or the lane working or waiting
 *  on an approval; one turn per lane (ADR-0268), so a second prompt waits in the lane's queue instead. */
export function laneStages(s: { streaming: boolean; status: string }): boolean {
  return s.streaming || s.status === "working" || s.status === "needs-approval";
}

export type LaneImageVerdict = { ok: true; image: LaneImage } | { ok: false; reason: string };

/** Whether one more image (a data URL, as a FileReader gives it) may join the `existing` ones on a lane prompt.
 *  Fail-closed and the same limits as the main composer (composer_attachments): PNG, JPEG, WebP or GIF only,
 *  MAX_ATTACHMENTS per prompt, MAX_ATTACHMENT_BYTES decoded per image. */
export function acceptLaneImage(existing: readonly LaneImage[], dataUrl: string): LaneImageVerdict {
  const p = parseImageDataUrl(dataUrl);
  if (!p) return { ok: false, reason: "only PNG, JPEG, WebP or GIF images can be attached" };
  if (existing.length >= MAX_ATTACHMENTS) return { ok: false, reason: `up to ${MAX_ATTACHMENTS} images per prompt` };
  if (base64Bytes(p.base64) > MAX_ATTACHMENT_BYTES) return { ok: false, reason: `each image must be under ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB` };
  return { ok: true, image: { mimeType: p.mimeType, data: p.base64 } };
}

/** A staged prompt moved one place (`dir` -1 earlier, 1 later), as the engine's queueMove does it; null when it
 *  cannot move (no such item, or already at that end). */
export function moveQueued<T>(list: readonly T[], i: number, dir: -1 | 1): T[] | null {
  const to = i + dir;
  if (!Number.isInteger(i) || i < 0 || i >= list.length || to < 0 || to >= list.length) return null;
  const next = list.slice();
  const [item] = next.splice(i, 1);
  next.splice(to, 0, item!);
  return next;
}

/** The chip a staged prompt shows until the next poll brings the engine's own (text clipped like the engine's). */
export function stagedChip(text: string, images: number, files: number): { text: string; images: number; files?: number } {
  return { text: text.length > 140 ? `${text.slice(0, 140)}\u2026` : text, images, ...(files ? { files } : {}) };
}
