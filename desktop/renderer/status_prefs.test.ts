// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/status_prefs.test.ts - P-PROGRESS.3 (ADR-0412): with the experimental estimate off no
// expected time is ever printed, and with it on the user sees a number or nothing, never a placeholder.

import { describe, expect, test } from "bun:test";
import { ringView, shownEta } from "./status_prefs.ts";
import { ETA_ESTIMATING, NO_ESTIMATE, type ProgressView } from "../turn_progress.ts";

describe("shownEta", () => {
  test("off hides every phrase; on shows a number and suppresses the no-history placeholder", () => {
    expect(shownEta("about 2 m left (est.)", false)).toBe("");
    expect(shownEta("about 2 m left (est.)", true)).toBe("about 2 m left (est.)");
    expect(shownEta(ETA_ESTIMATING, true)).toBe("");
  });
});

describe("ringView", () => {
  const view = (over: Partial<ProgressView> = {}): ProgressView => ({
    elapsedMs: 40_000, lastSignalMs: 500, stepsDone: 3, stepsOpen: [],
    liveness: { state: "streaming", label: "alive, streaming", detail: "" },
    estimate: { etaMs: 40_000, percent: 50, basis: "model", samples: 8, typicalMs: 80_000, overrun: false },
    ...over,
  });
  test("with history the arc is the percent; the time left joins the tooltip only with the estimate opted in", () => {
    const off = ringView(view(), false);
    expect(off.pct).toBe(50);
    expect(off.tone).toBe("run");
    expect(off.tip).not.toContain("left");
    expect(ringView(view(), true).tip).toContain("About 40 s left");
  });
  test("without history the ring is empty, and says why instead of guessing", () => {
    const r = ringView(view({ estimate: NO_ESTIMATE }), true);
    expect(r.pct).toBeNull();
    expect(r.tip).not.toMatch(/\d+%|left/);
  });
  test("a dead process turns the ring red and points at the restart", () => {
    const r = ringView(view({ liveness: { state: "dead", label: "gone", detail: "" } }), false);
    expect(r.tone).toBe("dead");
    expect(r.tip).toContain("Restart agent");
    // A lane card's ring points at the lane's own button, not the master's.
    const lane = ringView(view({ liveness: { state: "dead", label: "gone", detail: "" } }), false, "Restart this lane");
    expect(lane.tip).toContain("Restart this lane");
    expect(lane.tip).not.toContain("Restart agent");
  });
  test("past the typical length the tooltip says longer than usual, never a negative time", () => {
    const r = ringView(view({ estimate: { etaMs: 0, percent: 95, basis: "model", samples: 8, typicalMs: 80_000, overrun: true } }), true);
    expect(r.pct).toBe(95);
    expect(r.tip).toContain("longer than usual");
    expect(r.tip).not.toContain("left");
  });
});
