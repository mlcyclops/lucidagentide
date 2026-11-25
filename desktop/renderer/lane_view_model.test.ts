// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/lane_view_model.test.ts - P-VIZ.LANE1 (ADR-0683): the rules the Fleet card and the Agent Worlds
// node panel share through lane_view: send or stage, which pasted images may ride a prompt, how a staged prompt
// moves, and the staged chip shown before the next poll.

import { describe, expect, test } from "bun:test";
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS } from "./composer_attachments.ts";
import { acceptLaneImage, laneStages, moveQueued, stagedChip } from "./lane_view_model.ts";
import type { LaneImage } from "./bridge.ts";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

describe("laneStages", () => {
  test("a busy lane stages: a turn this surface streams, working, or waiting on an approval", () => {
    expect(laneStages({ streaming: true, status: "awaiting-input" })).toBe(true);
    expect(laneStages({ streaming: false, status: "working" })).toBe(true);
    expect(laneStages({ streaming: false, status: "needs-approval" })).toBe(true);
  });

  test("an idle lane sends (the engine still stages a prompt that finds it busy)", () => {
    for (const status of ["awaiting-input", "done", "starting", "error", "stopped", ""]) expect(laneStages({ streaming: false, status })).toBe(false);
  });
});

describe("acceptLaneImage", () => {
  test("a pasted PNG becomes the lane's image block (mime and bare base64)", () => {
    expect(acceptLaneImage([], PNG)).toEqual({ ok: true, image: { mimeType: "image/png", data: "iVBORw0KGgo=" } });
    expect(acceptLaneImage([], "data:image/jpg;base64,AAAA")).toEqual({ ok: true, image: { mimeType: "image/jpeg", data: "AAAA" } });
  });

  test("fail-closed on anything that is not an allowed image (SVG can carry script)", () => {
    for (const url of ["", "data:text/html;base64,PGI+", "data:image/svg+xml;base64,PHN2Zz4=", "data:image/bmp;base64,Qk0=", "data:image/png;base64,<b>", "https://example.com/a.png"]) {
      expect(acceptLaneImage([], url).ok).toBe(false);
    }
  });

  test("at most MAX_ATTACHMENTS per prompt, as in the main composer", () => {
    const full: LaneImage[] = Array.from({ length: MAX_ATTACHMENTS }, () => ({ mimeType: "image/png", data: "AAAA" }));
    expect(acceptLaneImage(full.slice(1), PNG).ok).toBe(true);
    const r = acceptLaneImage(full, PNG);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain(String(MAX_ATTACHMENTS));
  });

  test("an image over the byte limit is refused, one at the limit is not", () => {
    const at = "A".repeat(Math.floor(MAX_ATTACHMENT_BYTES / 3) * 4);
    expect(acceptLaneImage([], `data:image/png;base64,${at}`).ok).toBe(true);
    expect(acceptLaneImage([], `data:image/png;base64,${at}AAAA`).ok).toBe(false);
  });
});

describe("moveQueued", () => {
  const q = ["a", "b", "c"];
  test("one place earlier or later, as the engine's queueMove does it", () => {
    expect(moveQueued(q, 1, -1)).toEqual(["b", "a", "c"]);
    expect(moveQueued(q, 1, 1)).toEqual(["a", "c", "b"]);
    expect(q).toEqual(["a", "b", "c"]); // the shown queue is not mutated
  });

  test("no move past either end or from a slot that is not there", () => {
    expect(moveQueued(q, 0, -1)).toBeNull();
    expect(moveQueued(q, 2, 1)).toBeNull();
    expect(moveQueued(q, 3, -1)).toBeNull();
    expect(moveQueued(q, Number.NaN, 1)).toBeNull();
  });
});

describe("stagedChip", () => {
  test("the engine's 140-character preview, and file counts only when there are files", () => {
    expect(stagedChip("short", 1, 0)).toEqual({ text: "short", images: 1 });
    const long = stagedChip("x".repeat(200), 0, 2);
    expect(long.text).toBe(`${"x".repeat(140)}\u2026`);
    expect(long.files).toBe(2);
  });
});
