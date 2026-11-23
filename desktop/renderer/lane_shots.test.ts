// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-LANESHOTS.1: unit tests for the per-lane preview snapshot ring and its strip markup.
// The store is module state, so every test uses its own lane ids.

import { describe, expect, test } from "bun:test";
import {
  LANE_SHOT_CAP, LANE_SHOT_LANES, LANE_SHOT_MAX_CHARS, isLaneShotUrl, laneShots, laneShotsStripHtml, laneThumbSize,
  onLaneShots, recordLaneShot, shotHash, type LaneShot,
} from "./lane_shots.ts";

/** A distinct, valid PNG data URL per n (the payload only has to be base64). */
const url = (n: number): string => `data:image/png;base64,iVBORw0KGgo${btoa(`shot-${n}`).replace(/=+$/, "")}`;
const shot = (laneId: string, n: number, extra: Partial<LaneShot> = {}): LaneShot =>
  ({ laneId, at: 1_700_000_000_000 + n, dataUrl: url(n), title: `page ${n}.html`, path: `C:/work/page${n}.html`, ...extra });

describe("recordLaneShot / laneShots", () => {
  test("keeps the newest LANE_SHOT_CAP per lane, oldest first", () => {
    for (let n = 1; n <= LANE_SHOT_CAP + 3; n++) recordLaneShot(shot("cap-a", n));
    const got = laneShots("cap-a");
    expect(got).toHaveLength(LANE_SHOT_CAP);
    expect(got[0]?.dataUrl).toBe(url(4));
    expect(got[got.length - 1]?.dataUrl).toBe(url(LANE_SHOT_CAP + 3));
  });

  test("drops an identical consecutive picture, keeps a repeat that is not consecutive", () => {
    recordLaneShot(shot("dup-a", 1));
    recordLaneShot(shot("dup-a", 1, { at: 9, title: "same pixels, later" }));
    expect(laneShots("dup-a")).toHaveLength(1);
    expect(laneShots("dup-a")[0]?.title).toBe("page 1.html");
    recordLaneShot(shot("dup-a", 2));
    recordLaneShot(shot("dup-a", 1));
    expect(laneShots("dup-a").map((s) => s.dataUrl)).toEqual([url(1), url(2), url(1)]);
  });

  test("lanes are isolated", () => {
    recordLaneShot(shot("iso-a", 1));
    recordLaneShot(shot("iso-b", 2));
    recordLaneShot(shot("iso-b", 3));
    expect(laneShots("iso-a").map((s) => s.dataUrl)).toEqual([url(1)]);
    expect(laneShots("iso-b").map((s) => s.dataUrl)).toEqual([url(2), url(3)]);
    expect(laneShots("iso-none")).toHaveLength(0);
  });

  test("an earlier result is a stable snapshot, never mutated by a later record", () => {
    recordLaneShot(shot("snap-a", 1));
    const before = laneShots("snap-a");
    recordLaneShot(shot("snap-a", 2));
    expect(before).toHaveLength(1);
    expect(laneShots("snap-a")).toHaveLength(2);
    expect(Object.isFrozen(before)).toBe(true);
  });

  test("refuses an empty lane id, a non-raster URL and an oversized one", () => {
    recordLaneShot(shot("", 1));
    recordLaneShot(shot("bad-a", 1, { dataUrl: "javascript:alert(1)" }));
    recordLaneShot(shot("bad-a", 1, { dataUrl: "data:image/svg+xml;base64,PHN2Zz4=" }));
    recordLaneShot(shot("bad-a", 1, { dataUrl: "data:image/png;base64,AAA\" onerror=\"x" }));
    recordLaneShot(shot("bad-a", 1, { dataUrl: `data:image/png;base64,${"A".repeat(LANE_SHOT_MAX_CHARS)}` }));
    expect(laneShots("")).toHaveLength(0);
    expect(laneShots("bad-a")).toHaveLength(0);
    expect(isLaneShotUrl("data:image/webp;base64,UklGRg==")).toBe(true);
    expect(isLaneShotUrl("data:image/jpeg;base64,/9j/4AAQ")).toBe(true);
  });

  test("forgets the least recently recorded lane past LANE_SHOT_LANES", () => {
    for (let n = 0; n <= LANE_SHOT_LANES; n++) recordLaneShot(shot(`many-${n}`, n));
    expect(laneShots("many-0")).toHaveLength(0);
    expect(laneShots("many-1")).toHaveLength(1);
    expect(laneShots(`many-${LANE_SHOT_LANES}`)).toHaveLength(1);
  });
});

describe("onLaneShots", () => {
  test("tells subscribers which lane changed, not for a dropped duplicate, and unsubscribes", () => {
    const seen: string[] = [];
    const off = onLaneShots((id) => seen.push(id));
    const boom = onLaneShots(() => { throw new Error("bad subscriber"); });
    recordLaneShot(shot("sub-a", 1));
    recordLaneShot(shot("sub-a", 1));
    recordLaneShot(shot("sub-b", 2));
    off(); boom();
    recordLaneShot(shot("sub-a", 3));
    // Earlier tests filled the lane cap, so these records also evict (and announce) old lanes; only this test's
    // lanes are asserted here.
    expect(seen.filter((id) => id.startsWith("sub-"))).toEqual(["sub-a", "sub-b"]);
  });
});

describe("shotHash", () => {
  test("equal strings hash equal; a change or a length change hashes differently", () => {
    const a = url(1);
    expect(shotHash(a)).toBe(shotHash(`${a}`));
    expect(shotHash(a)).not.toBe(shotHash(url(2)));
    expect(shotHash(a)).not.toBe(shotHash(`${a}A`));
  });
});

describe("laneThumbSize", () => {
  test("fits inside 480x480 without upscaling", () => {
    expect(laneThumbSize(1200, 800)).toEqual({ w: 480, h: 320 });
    expect(laneThumbSize(400, 1200)).toEqual({ w: 160, h: 480 });
    expect(laneThumbSize(300, 200)).toEqual({ w: 300, h: 200 });
    expect(laneThumbSize(0, 200)).toEqual({ w: 0, h: 0 });
    expect(laneThumbSize(Number.NaN, 200)).toEqual({ w: 0, h: 0 });
  });
});

describe("laneShotsStripHtml", () => {
  test("renders nothing for no shots", () => {
    expect(laneShotsStripHtml([], { laneName: "Builder" })).toBe("");
  });

  test("newest first, each thumb indexed into the input, labeled as from the agent", () => {
    const shots = [shot("strip-a", 1), shot("strip-a", 2), shot("strip-a", 3)];
    const html = laneShotsStripHtml(shots, { laneName: "Builder" });
    const order = [...html.matchAll(/data-lane-shot="(\d+)"/g)].map((m) => m[1]);
    expect(order).toEqual(["2", "1", "0"]);
    expect(html).toContain("From the agent");
    expect(html).toContain("3 preview snapshots");
    expect(html).toContain("untrusted");
    expect(html).toContain(`alt="Preview snapshot from Builder: page 3.html"`);
    expect(html.match(/<button type="button" class="lane-shot"/g)).toHaveLength(3);
  });

  test("escapes every string from the agent", () => {
    const evil = "<img src=x onerror=alert(1)>\"&'";
    const html = laneShotsStripHtml([shot("strip-b", 1, { title: evil })], { laneName: `"><script>x</script>` });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;&quot;&amp;'");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("1 preview snapshot<");
  });

  test("skips an entry whose image is not a raster data URL", () => {
    const html = laneShotsStripHtml([shot("strip-c", 1), shot("strip-c", 2, { dataUrl: "javascript:alert(1)" })], { laneName: "" });
    expect(html).not.toContain("javascript:");
    expect(html).toContain(`data-lane-shot="0"`);
    expect(html).not.toContain(`data-lane-shot="1"`);
    expect(html).toContain("from this agent");
  });
});
