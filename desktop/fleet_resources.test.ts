// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-FLEET.L1: the 75% headroom guard. What matters: refusals always carry the measured number, the lane
// ceiling always applies, and missing evidence FAILS OPEN (a broken profiler must not brick the fleet).

import { expect, test } from "bun:test";
import { FLEET_WATERMARK_PCT, laneAdmission, maxLanesFor } from "./fleet_resources.ts";
import type { SystemSnapshot } from "./system_profile.ts";

const snap = (o: Partial<SystemSnapshot> = {}): SystemSnapshot =>
  ({ cpuModel: "test", cores: 8, speedMHz: 4000, cpuBusyPct: 20, memTotalMB: 16_000, memFreeMB: 10_000, ...o });

test("the watermark is 75 and maxLanes derives from cores, clamped 1..6", () => {
  expect(FLEET_WATERMARK_PCT).toBe(75);
  expect(maxLanesFor(8)).toBe(4);
  expect(maxLanesFor(2)).toBe(1);
  expect(maxLanesFor(64)).toBe(6);
  expect(maxLanesFor(0)).toBe(1);   // failed sample still yields a usable ceiling
  expect(maxLanesFor(-1)).toBe(1);
});

test("a healthy machine admits a lane", () => {
  const a = laneAdmission(snap(), 0);
  expect(a.ok).toBe(true);
  expect(a.maxLanes).toBe(4);
});

test("the lane ceiling refuses with the counted number", () => {
  const a = laneAdmission(snap(), 4);
  expect(a.ok).toBe(false);
  expect(a.reason).toContain("4/4");
});

test("memory above 75% refuses and names the measured percent", () => {
  const a = laneAdmission(snap({ memTotalMB: 16_000, memFreeMB: 3_200 }), 0); // 80% used
  expect(a.ok).toBe(false);
  expect(a.reason).toContain("80%");
  expect(a.reason).toContain("3200MB free");
});

test("cpu above 75% refuses and names the measured percent", () => {
  const a = laneAdmission(snap({ cpuBusyPct: 91 }), 0);
  expect(a.ok).toBe(false);
  expect(a.reason).toContain("91%");
});

test("missing evidence fails OPEN (UX guard, not a security gate) - but the ceiling still applies", () => {
  const noEvidence = snap({ cpuBusyPct: null, memTotalMB: 0, memFreeMB: 0, cores: 0 });
  expect(laneAdmission(noEvidence, 0).ok).toBe(true);
  expect(laneAdmission(noEvidence, 1).ok).toBe(false); // cores unknown -> ceiling 1
});
