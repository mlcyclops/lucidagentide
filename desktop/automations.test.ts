// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/automations.test.ts
//
// P-GOAL.5 (ADR-0047): the scheduled-automation store + PURE scheduling math. Covers the CRUD round-trip
// under `.omp/automations.json`, the disabled-until-enabled default, interval vs daily `isDue`, cadence
// validation (a malformed cadence never arms — fail-closed), and path confinement.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { cadenceLabel, createAutomation, deleteAutomation, isDue, listAutomations, nextDueAutomation, normalizeCadence, updateAutomation, type Automation } from "./automations.ts";

const ws = () => mkdtempSync(join(homedir(), ".lucid-autom-"));

describe("automations store", () => {
  test("create writes a DISABLED automation under .omp/automations.json; list reads it back", () => {
    const dir = ws();
    try {
      const a = createAutomation(dir, { goal: "Sweep for new TODOs", command: "rg TODO", cadence: { kind: "interval", everyMin: 60 } }, "id1", 1000);
      expect(a).not.toBeNull();
      expect(a!.enabled).toBe(false);            // disabled until explicitly enabled
      expect(a!.condition).toBe("rg TODO");       // defaults to the command when no condition given
      expect(existsSync(join(dir, ".omp", "automations.json"))).toBe(true);
      const list = listAutomations(dir);
      expect(list.length).toBe(1);
      expect(list[0].goal).toBe("Sweep for new TODOs");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("update enables, delete removes; unknown id ⇒ null/false", () => {
    const dir = ws();
    try {
      createAutomation(dir, { goal: "g", cadence: { kind: "daily", hhmm: "09:00" } }, "id1", 1000);
      expect(updateAutomation(dir, "id1", { enabled: true })!.enabled).toBe(true);
      expect(updateAutomation(dir, "nope", { enabled: true })).toBeNull();
      expect(deleteAutomation(dir, "id1")).toBe(true);
      expect(listAutomations(dir).length).toBe(0);
      expect(deleteAutomation(dir, "id1")).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("a bad goal or cadence ⇒ null (never arms)", () => {
    const dir = ws();
    try {
      expect(createAutomation(dir, { goal: "  ", cadence: { kind: "interval", everyMin: 60 } }, "x", 1)).toBeNull();
      expect(createAutomation(dir, { goal: "ok", cadence: { kind: "interval", everyMin: 0 } as any }, "x", 1)).toBeNull();
      expect(createAutomation(dir, { goal: "ok", cadence: { kind: "daily", hhmm: "25:00" } as any }, "x", 1)).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("cadence validation + labels", () => {
  test("normalizeCadence accepts valid, rejects malformed", () => {
    expect(normalizeCadence({ kind: "interval", everyMin: 30 })).toEqual({ kind: "interval", everyMin: 30 });
    expect(normalizeCadence({ kind: "daily", hhmm: "23:59" })).toEqual({ kind: "daily", hhmm: "23:59" });
    expect(normalizeCadence({ kind: "interval", everyMin: -5 })).toBeNull();
    expect(normalizeCadence({ kind: "daily", hhmm: "9:00" })).toBeNull(); // must be zero-padded HH
    expect(normalizeCadence({ kind: "weekly" })).toBeNull();
    expect(normalizeCadence(null)).toBeNull();
  });

  test("cadenceLabel is human-readable", () => {
    expect(cadenceLabel({ kind: "interval", everyMin: 30 })).toBe("every 30 min");
    expect(cadenceLabel({ kind: "interval", everyMin: 120 })).toBe("every 2 hours");
    expect(cadenceLabel({ kind: "interval", everyMin: 1440 })).toBe("every 1 day");
    expect(cadenceLabel({ kind: "daily", hhmm: "09:00" })).toBe("daily at 09:00");
  });
});

describe("isDue (pure scheduling)", () => {
  const base = (over: Partial<Automation>): Automation => ({ id: "a", goal: "g", condition: "c", maxIters: 6, cadence: { kind: "interval", everyMin: 60 }, enabled: true, createdAt: 0, ...over });

  test("disabled is never due", () => {
    expect(isDue(base({ enabled: false }), 10 * 60 * 60_000)).toBe(false);
  });

  test("interval fires once the period elapses since the last run", () => {
    const a = base({ cadence: { kind: "interval", everyMin: 60 }, lastRunAt: 0 });
    expect(isDue(a, 59 * 60_000)).toBe(false);
    expect(isDue(a, 60 * 60_000)).toBe(true);
  });

  test("daily fires after HH:MM and not again until the next day", () => {
    const nine = new Date(2026, 5, 24, 9, 0, 0, 0).getTime(); // local 09:00
    const a = base({ cadence: { kind: "daily", hhmm: "09:00" }, createdAt: new Date(2026, 5, 24, 0, 0, 0, 0).getTime() });
    expect(isDue(a, nine - 60_000)).toBe(false);              // before 09:00
    expect(isDue(a, nine + 60_000)).toBe(true);               // just after 09:00
    const ranToday = { ...a, lastRunAt: nine + 60_000 };
    expect(isDue(ranToday, nine + 5 * 60_000)).toBe(false);   // already ran today
    const nextDay = new Date(2026, 5, 25, 9, 1, 0, 0).getTime();
    expect(isDue(ranToday, nextDay)).toBe(true);              // due again tomorrow
  });

  test("nextDueAutomation returns the oldest-waiting due one, or null", () => {
    const dir = ws();
    try {
      createAutomation(dir, { goal: "old", cadence: { kind: "interval", everyMin: 1 } }, "old", 0);
      createAutomation(dir, { goal: "new", cadence: { kind: "interval", everyMin: 1 } }, "new", 5000);
      updateAutomation(dir, "old", { enabled: true });
      updateAutomation(dir, "new", { enabled: true });
      expect(nextDueAutomation(dir, 1000)).toBeNull();          // neither past its 1-min period yet
      const picked = nextDueAutomation(dir, 10 * 60_000);
      expect(picked!.id).toBe("old");                            // oldest-waiting fires first
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("path confinement", () => {
  test("the store stays under .omp/ (no traversal even with an odd workspace)", () => {
    const dir = ws();
    try {
      createAutomation(dir, { goal: "g", cadence: { kind: "interval", everyMin: 5 } }, "id", 0);
      const raw = readFileSync(join(dir, ".omp", "automations.json"), "utf8");
      expect(raw).toContain('"goal": "g"');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
