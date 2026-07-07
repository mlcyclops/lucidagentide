// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/stall_notice.test.ts — P-STALL.1 (ADR-0186): provider-silence wording.
// Pins: the minute math (floors, never says "0 min"), the phase line, the toast copy (names the cap so
// the user knows LUCID is waiting on purpose), and the patience constant staying in lockstep with the
// backend's IDLE_MS (read from the acp_backend source - the two files must never drift).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TURN_PATIENCE_MS, slowPhaseLabel, slowToastCopy } from "./stall_notice.ts";

describe("slowPhaseLabel", () => {
  test("floors to whole minutes and never says 0", () => {
    expect(slowPhaseLabel(120_000)).toBe("Still waiting on the provider · silent for 2 min");
    expect(slowPhaseLabel(359_999)).toBe("Still waiting on the provider · silent for 5 min");
    expect(slowPhaseLabel(45_000)).toContain("1 min"); // early fire safety - never "0 min"
  });
});

describe("slowToastCopy", () => {
  test("explains the overload and names the patience cap", () => {
    const c = slowToastCopy(120_000, TURN_PATIENCE_MS);
    expect(c.title).toBe("The provider is slow to respond");
    expect(c.desc).toContain("2 min");
    expect(c.desc).toContain("10 minutes"); // the cap, so the wait reads as deliberate
    expect(c.desc).toContain("Stop cancels");
  });
});

describe("patience lockstep", () => {
  test("TURN_PATIENCE_MS mirrors acp_backend's IDLE_MS (the toast must never lie about the cap)", () => {
    const src = readFileSync(join(import.meta.dir, "..", "acp_backend.ts"), "utf8");
    const m = src.match(/IDLE_MS = (\d[\d_]*)/);
    expect(m).not.toBeNull();
    expect(Number(m![1]!.replace(/_/g, ""))).toBe(TURN_PATIENCE_MS);
  });
  test("the backend's stall message states the real wait (the old text said 2 minutes at a 5-minute cap)", () => {
    const src = readFileSync(join(import.meta.dir, "..", "acp_backend.ts"), "utf8");
    expect(src).toContain("Math.round(Backend.IDLE_MS / 60_000)"); // derived, can't go stale again
    expect(src).not.toContain("did not respond for 2 minutes");
  });
});
