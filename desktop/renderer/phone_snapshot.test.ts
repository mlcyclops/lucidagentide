// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/phone_snapshot.test.ts - P-PREVIEW-PWA.4. The reported bug was a FAILED preview being
// captured and published to a phone guest as a permanent transcript fixture, so the assertion that matters
// most is `unresolved`, and specifically that it is decided BEFORE the rate-limit slot is claimed.

import { describe, expect, test } from "bun:test";
import { snapshotLabel, snapshotVerdict, type SnapshotInputs } from "./phone_snapshot.ts";

const ok = (over: Partial<SnapshotInputs> = {}): SnapshotInputs => ({
  shareActive: true,
  laneVisible: true,
  rect: { width: 800, height: 600 },
  resolves: true,
  now: 100_000,
  lastSentAt: 0,
  gapMs: 3000,
  ...over,
});

describe("snapshotVerdict", () => {
  test("a resolving preview in a visible lane during a live share sends", () => {
    expect(snapshotVerdict(ok())).toBe("send");
  });

  test("THE BUG: a preview that did not resolve is never published", () => {
    // `/api/preview/serve` answers a failure with HTTP 200 and an HTML body, so without this the capture
    // path cannot tell an app from an error page, and the error page becomes a permanent guest-facing card.
    expect(snapshotVerdict(ok({ resolves: false }))).toBe("unresolved");
  });

  test("unresolved is decided BEFORE too-soon, so a failure never burns the rate-limit slot", () => {
    // Both conditions true at once. If `too-soon` won, the caller could not distinguish "wait" from
    // "nothing worth sending", and a failed preview would suppress the good one right behind it.
    expect(snapshotVerdict(ok({ resolves: false, lastSentAt: 99_000 }))).toBe("unresolved");
  });

  test("no share means no guest, and that outranks everything", () => {
    expect(snapshotVerdict(ok({ shareActive: false, resolves: false, laneVisible: false }))).toBe("no-share");
  });

  test("a hidden or wrong lane does not broadcast", () => {
    expect(snapshotVerdict(ok({ laneVisible: false }))).toBe("no-lane");
  });

  test("a zero-area or sub-pixel frame captures nothing", () => {
    for (const rect of [{ width: 0, height: 0 }, { width: 1, height: 600 }, { width: 800, height: 1 }]) {
      expect(snapshotVerdict(ok({ rect }))).toBe("no-area");
    }
  });

  test("a garbage rect refuses rather than capturing a nonsense region", () => {
    for (const rect of [{ width: NaN, height: 600 }, { width: 800, height: Infinity }]) {
      expect(snapshotVerdict(ok({ rect }))).toBe("no-area");
    }
  });

  test("the rate limit suppresses a burst down to one send", () => {
    expect(snapshotVerdict(ok({ now: 100_000, lastSentAt: 98_000 }))).toBe("too-soon");
    expect(snapshotVerdict(ok({ now: 100_000, lastSentAt: 97_000 }))).toBe("send"); // exactly the gap
    expect(snapshotVerdict(ok({ now: 100_000, lastSentAt: 96_999 }))).toBe("send");
  });

  test("a non-finite clock or gap refuses instead of reading as 'plenty of time has passed'", () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(snapshotVerdict(ok({ now: bad }))).toBe("too-soon");
      expect(snapshotVerdict(ok({ lastSentAt: bad }))).toBe("too-soon");
      expect(snapshotVerdict(ok({ gapMs: bad }))).toBe("too-soon");
    }
  });

  test("a clock that moved backwards does not unlock an early send", () => {
    expect(snapshotVerdict(ok({ now: 90_000, lastSentAt: 100_000 }))).toBe("too-soon");
  });
});

describe("snapshotLabel", () => {
  test("a guest sees the basename, never the operator's directory layout", () => {
    expect(snapshotLabel("C:/Users/neorc/secret-project/game.html")).toBe("Preview: game.html");
    expect(snapshotLabel("/home/n/work/report.md")).toBe("Preview: report.md");
  });

  test("a trailing separator does not produce an empty caption", () => {
    expect(snapshotLabel("/home/n/work/")).toBe("Preview: work");
  });

  test("degenerate input still reads as a caption", () => {
    expect(snapshotLabel("")).toBe("Preview: file");
    expect(snapshotLabel("/")).toBe("Preview: file");
    expect(snapshotLabel("   ")).toBe("Preview: file");
  });

  test("no em dash in the caption", () => {
    expect(snapshotLabel("game.html")).not.toContain("\u2014");
  });
});
