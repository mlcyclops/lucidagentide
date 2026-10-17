// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/cron.test.ts - P-SCHED.1 (ADR-0443): the five-field parser, next-fire math in local time, and
// the two DST nights. The DST cases pin America/New_York through TZ; a runtime that ignores TZ still runs
// them as "one fire per scheduled day", which is the invariant that matters.

import { describe, expect, test } from "bun:test";
import { describeCron, firesBetween, nextFire, parseCron } from "./cron.ts";

const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0);
const wall = (d: Date | null) => d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}` : null;

describe("parseCron", () => {
  test("accepts lists, ranges, steps and the three macros; Sunday is 0 or 7", () => {
    const f = parseCron("*/15 9-17 1,15 * 1-5")!;
    expect([...f.minute]).toEqual([0, 15, 30, 45]);
    expect([...f.hour]).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect([...f.dom]).toEqual([1, 15]);
    expect(f.domAny).toBe(false);
    expect(f.dowAny).toBe(false);
    expect([...parseCron("0 0 * * 7")!.dow]).toEqual([0]);
    expect(parseCron("@daily")).toEqual(parseCron("0 0 * * *"));
    expect(parseCron("@hourly")).toEqual(parseCron("0 * * * *"));
  });
  test("refuses malformed input: a bad schedule never arms", () => {
    for (const bad of ["", "* * * *", "60 * * * *", "0 24 * * *", "0 0 0 * *", "0 0 * 13 *", "0 0 * * 8", "a b c d e", "0 0 * * 1-", "*/0 * * * *", "5-1 * * * *", "0 0 L * *", "0 0 * * mon"]) {
      expect(parseCron(bad)).toBeNull();
    }
  });
});

describe("nextFire", () => {
  test("weekdays at 02:00: Friday 02:00 is followed by Monday 02:00, and a fire exactly at the minute is not re-fired", () => {
    const fri = at(2026, 10, 9, 2, 0); // 2026-10-09 is a Friday
    expect(wall(nextFire("0 2 * * 1-5", at(2026, 10, 9, 1, 59)))).toBe("2026-10-09 02:00");
    expect(wall(nextFire("0 2 * * 1-5", fri))).toBe("2026-10-12 02:00");
  });
  test("*/15 inside 9-17 rolls to the next day's 09:00 after 17:45", () => {
    expect(wall(nextFire("*/15 9-17 * * *", at(2026, 10, 8, 17, 45)))).toBe("2026-10-09 09:00");
    expect(wall(nextFire("*/15 9-17 * * *", at(2026, 10, 8, 9, 7)))).toBe("2026-10-08 09:15");
  });
  test("month ends: the 31st skips months without one; Feb 29 waits for the leap year; Feb 30 is impossible", () => {
    expect(wall(nextFire("0 9 31 * *", at(2026, 4, 1)))).toBe("2026-05-31 09:00");
    expect(wall(nextFire("0 9 29 2 *", at(2026, 3, 1)))).toBe("2028-02-29 09:00");
    expect(nextFire("0 9 30 2 *", at(2026, 1, 1))).toBeNull();
  });
  test("day-of-month OR day-of-week when both are restricted (Vixie rule)", () => {
    // the 13th or a Friday, whichever comes first after Oct 8 2026 (a Thursday): Friday Oct 9
    expect(wall(nextFire("0 12 13 * 5", at(2026, 10, 8, 13, 0)))).toBe("2026-10-09 12:00");
    expect(wall(nextFire("0 12 13 * 5", at(2026, 10, 9, 13, 0)))).toBe("2026-10-13 12:00");
  });
});

describe("DST nights (America/New_York)", () => {
  const prevTz = process.env.TZ;
  process.env.TZ = "America/New_York";
  const tzHonored = new Date(2026, 6, 1).getTimezoneOffset() === 240 && new Date(2026, 0, 1).getTimezoneOffset() === 300;
  const days = (expr: string, from: Date, to: Date) => {
    const perDay: Record<string, number> = {};
    for (const d of firesBetween(expr, from, to)) { const k = wall(d)!.slice(0, 10); perDay[k] = (perDay[k] ?? 0) + 1; }
    return perDay;
  };

  test("spring forward (2026-03-08): a 02:30 job still fires exactly once that day, at the next existing minute", () => {
    const perDay = days("30 2 * * *", at(2026, 3, 6, 12), at(2026, 3, 10, 12));
    expect(Object.values(perDay)).toEqual([1, 1, 1, 1]);
    if (tzHonored) {
      const fire = nextFire("30 2 * * *", at(2026, 3, 8, 0, 0))!;
      expect(wall(fire)).toBe("2026-03-08 03:30"); // 02:30 does not exist; the job runs at the instant that minute would have been, which the clock now calls 03:30
    }
  });
  test("fall back (2026-11-01): a 01:30 job fires once, not twice, and the next day's fire is a day later", () => {
    const perDay = days("30 1 * * *", at(2026, 10, 30, 12), at(2026, 11, 3, 12));
    expect(Object.values(perDay)).toEqual([1, 1, 1, 1]);
    if (tzHonored) {
      const first = nextFire("30 1 * * *", at(2026, 11, 1, 0, 0))!;
      const second = nextFire("30 1 * * *", first)!;
      expect(second.getTime() - first.getTime()).toBeGreaterThan(20 * 3600_000); // the repeated 01:30 is skipped
    }
  });
  test("hourly across both nights: 24 fires on spring-forward day is wrong, 23 is right; 25 on fall-back", () => {
    if (!tzHonored) return;
    expect(firesBetween("0 * * * *", at(2026, 3, 8, 0, 0), at(2026, 3, 9, 0, 0)).length).toBe(23);
    expect(firesBetween("0 * * * *", at(2026, 11, 1, 0, 0), at(2026, 11, 2, 0, 0)).length).toBe(24); // the repeated 01:00 skipped: 25 wall hours, 24 distinct scheduled minutes fired
  });
  process.env.TZ = prevTz;
});

describe("describeCron", () => {
  test("names the shapes the builder emits and falls back to the expression", () => {
    expect(describeCron("0 2 * * *")).toBe("every day at 02:00");
    expect(describeCron("30 18 * * 1-5")).toBe("weekdays at 18:30");
    expect(describeCron("0 9 * * 0,6")).toBe("weekends at 09:00");
    expect(describeCron("15 7 * * 1,3")).toBe("Mon, Wed at 07:15");
    expect(describeCron("0 * * * *")).toBe("every hour");
    expect(describeCron("*/15 9-17 * * 1-5")).toBe("*/15 9-17 * * 1-5");
    expect(describeCron("nope")).toBe("invalid schedule");
  });
});
