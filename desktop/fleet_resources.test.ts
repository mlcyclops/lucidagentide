// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-FLEET.L2: the SUSTAINED-pressure guard. What matters, in order:
//   1. a BURST never refuses a lane (this is the whole reason the 75% instantaneous watermark was wrong);
//   2. thirty unbroken seconds above the line DOES refuse, and the reason carries both measured numbers;
//   3. there is no lane ceiling anywhere in the verdict;
//   4. missing evidence - a failed sample, a gap in polling, a panel that just opened - FAILS OPEN,
//      because "we cannot prove sustained pressure" is not the same as "the machine is pegged".

import { expect, test } from "bun:test";
import {
  FLEET_HISTORY_MAX,
  FLEET_PRESSURE_PCT,
  FLEET_SUSTAIN_MS,
  hotMs,
  laneAdmission,
  memPctOf,
  pressureOf,
  pushSample,
  type PressureSample,
} from "./fleet_resources.ts";
import type { SystemSnapshot } from "./system_profile.ts";

const snap = (o: Partial<SystemSnapshot> = {}): SystemSnapshot =>
  ({ cpuModel: "test", cores: 8, speedMHz: 4000, cpuBusyPct: 20, memTotalMB: 16_000, memFreeMB: 10_000, ...o });

/** A run of readings `stepMs` apart, newest last. */
const series = (values: { cpu?: number | null; mem?: number | null }[], stepMs = 3_000): PressureSample[] =>
  values.map((v, i) => ({ at: i * stepMs, cpuPct: v.cpu ?? null, memPct: v.mem ?? null }));

const hotRun = (count: number, pct = 95, stepMs = 3_000): PressureSample[] =>
  series(Array.from({ length: count }, () => ({ cpu: pct, mem: 40 })), stepMs);

test("the policy is 90% held for 30s", () => {
  expect(FLEET_PRESSURE_PCT).toBe(90);
  expect(FLEET_SUSTAIN_MS).toBe(30_000);
});

test("a snapshot becomes a reading: used memory as a percent, cpu passed through, nulls preserved", () => {
  expect(memPctOf(snap({ memTotalMB: 16_000, memFreeMB: 4_000 }))).toBe(75);
  expect(memPctOf(snap({ memTotalMB: 0, memFreeMB: 0 }))).toBeNull(); // failed sample = no evidence
  const p = pressureOf(snap({ cpuBusyPct: 44, memTotalMB: 1_000, memFreeMB: 100 }), 1234);
  expect(p).toEqual({ at: 1234, cpuPct: 44, memPct: 90 });
  expect(pressureOf(snap({ cpuBusyPct: null }), 1).cpuPct).toBeNull();
});

test("hotMs measures the unbroken streak ending at the newest reading", () => {
  expect(hotMs([], "cpuPct")).toBe(0);
  // one hot reading is a SPIKE: a value, but no duration yet
  expect(hotMs(hotRun(1), "cpuPct")).toBe(0);
  expect(hotMs(hotRun(5), "cpuPct")).toBe(12_000); // 5 readings, 3s apart -> 12s of span
  expect(hotMs(hotRun(11), "cpuPct")).toBe(30_000);
  // the metric is currently BELOW the line: nothing is sustained, however hot the history was
  expect(hotMs([...hotRun(11), { at: 33_000, cpuPct: 10, memPct: 40 }], "cpuPct")).toBe(0);
});

test("a cool OR unknown reading breaks the streak - a sampling gap is never counted as load", () => {
  const dip = series([{ cpu: 99 }, { cpu: 99 }, { cpu: 12 }, { cpu: 99 }, { cpu: 99 }]);
  expect(hotMs(dip, "cpuPct")).toBe(3_000); // only the last two readings
  const blind = series([{ cpu: 99 }, { cpu: 99 }, { cpu: null }, { cpu: 99 }, { cpu: 99 }]);
  expect(hotMs(blind, "cpuPct")).toBe(3_000);
});

test("a BURST admits: 100% for 12 seconds is a compile, not a siege", () => {
  const a = laneAdmission(hotRun(5, 100));
  expect(a.ok).toBe(true);
  expect(a.cpuHotMs).toBe(12_000);
  expect(a.cpuPct).toBe(100);
});

test("30 unbroken seconds of CPU refuses, naming the percent AND the duration", () => {
  const a = laneAdmission(hotRun(11, 93));
  expect(a.ok).toBe(false);
  expect(a.reason).toContain("93%");
  expect(a.reason).toContain("30s");
  expect(a.reason).toContain("CPU");
});

test("30 unbroken seconds of MEMORY refuses, and memory is reported before cpu", () => {
  const hot = series(Array.from({ length: 11 }, () => ({ cpu: 97, mem: 96 })));
  const a = laneAdmission(hot);
  expect(a.ok).toBe(false);
  expect(a.reason).toContain("memory");
  expect(a.reason).toContain("96%");
  expect(a.memHotMs).toBe(30_000);
  expect(a.cpuHotMs).toBe(30_000);
});

test("one second short of the window still admits (the line is a duration, not a mood)", () => {
  const almost = series(Array.from({ length: 11 }, () => ({ cpu: 99, mem: 40 })), 2_900);
  expect(hotMs(almost, "cpuPct")).toBe(29_000);
  expect(laneAdmission(almost).ok).toBe(true);
});

test("no lane ceiling exists: the verdict is a function of pressure alone", () => {
  // Nothing in LaneAdmission counts lanes, and a healthy machine always admits - however many are running.
  const a = laneAdmission(series([{ cpu: 30, mem: 50 }, { cpu: 30, mem: 50 }]));
  expect(a.ok).toBe(true);
  expect(Object.keys(a).sort()).toEqual(["cpuHotMs", "cpuPct", "memHotMs", "memPct", "ok", "pressurePct", "sustainMs"]);
});

test("missing evidence FAILS OPEN - a UX guard must never brick the fleet", () => {
  expect(laneAdmission([]).ok).toBe(true);                                     // panel just opened
  expect(laneAdmission([]).cpuPct).toBeNull();
  const blind = series(Array.from({ length: 11 }, () => ({ cpu: null, mem: null })));
  expect(laneAdmission(blind).ok).toBe(true);                                  // profiler broken for 30s
});

test("the window keeps twice the sustain span, so a just-crossed streak is still measurable", () => {
  let h: PressureSample[] = [];
  for (let i = 0; i <= 40; i++) h = pushSample(h, { at: i * 3_000, cpuPct: 95, memPct: 40 });
  expect(hotMs(h, "cpuPct")).toBe(FLEET_SUSTAIN_MS * 2); // trimmed to 60s of span, not 27s
  expect(laneAdmission(h).ok).toBe(false);
  expect(h.length).toBeLessThanOrEqual(FLEET_HISTORY_MAX);
});

test("a clock that jumps BACKWARD resets rather than inventing a streak", () => {
  let h = hotRun(11);
  expect(hotMs(h, "cpuPct")).toBe(30_000);
  h = pushSample(h, { at: 1_000, cpuPct: 95, memPct: 40 }); // clock went back
  expect(hotMs(h, "cpuPct")).toBe(1_000);
  expect(laneAdmission(h).ok).toBe(true);
});

test("the history never grows without bound", () => {
  let h: PressureSample[] = [];
  for (let i = 0; i < 5_000; i++) h = pushSample(h, { at: i * 10, cpuPct: 95, memPct: 40 });
  expect(h.length).toBeLessThanOrEqual(FLEET_HISTORY_MAX);
});
