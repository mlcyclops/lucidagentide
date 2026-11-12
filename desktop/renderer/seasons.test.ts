// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/seasons.test.ts - P-SEASON.1 (ADR-0525): the special-theme calendar.
// The rules a person would get wrong by hand (nth weekdays, Easter, the year boundary, even-year
// events, overlapping windows) are pinned against real published dates.

import { describe, expect, test } from "bun:test";
import { THEMES } from "./theme.ts";
import { activeSeason, dateOf, dayNum, easter, electionDay, nextWindow, nthWeekday, rangeLabel, resolveSeason, SEASONS, superBowl } from "./seasons.ts";

const on = (y: number, m: number, d: number): Date => new Date(y, m - 1, d, 12);
const ymd = (day: number): string => { const { y, m, d } = dateOf(day); return `${y}-${m}-${d}`; };

describe("calendar rules", () => {
  test("nth and last weekday of a month land on the published federal holidays", () => {
    expect(ymd(nthWeekday(2027, 1, 1, 3))).toBe("2027-1-18"); // MLK Day 2027
    expect(ymd(nthWeekday(2026, 2, 1, 3))).toBe("2026-2-16"); // Presidents' Day 2026
    expect(ymd(nthWeekday(2026, 5, 1, -1))).toBe("2026-5-25"); // Memorial Day 2026
    expect(ymd(nthWeekday(2027, 5, 1, -1))).toBe("2027-5-31"); // Memorial Day when May ends on a Monday
    expect(ymd(nthWeekday(2026, 9, 1, 1))).toBe("2026-9-7"); // Labor Day 2026
    expect(ymd(nthWeekday(2026, 11, 4, 4))).toBe("2026-11-26"); // Thanksgiving 2026
    expect(ymd(nthWeekday(2027, 12, 5, -1))).toBe("2027-12-31"); // last Friday when the month ends on it
  });

  test("Easter follows the Gregorian computus, including its extreme dates", () => {
    expect(ymd(easter(2026))).toBe("2026-4-5");
    expect(ymd(easter(2027))).toBe("2027-3-28");
    expect(ymd(easter(2038))).toBe("2038-4-25"); // latest possible
    expect(ymd(easter(2285))).toBe("2285-3-22"); // earliest possible
  });

  test("Election Day is the Tuesday after the first Monday, even when Nov 1 is a Tuesday", () => {
    expect(ymd(electionDay(2026))).toBe("2026-11-3");
    expect(ymd(electionDay(2028))).toBe("2028-11-7");
    expect(ymd(electionDay(2033))).toBe("2033-11-8"); // Nov 1 2033 is a Tuesday: not Election Day
  });

  test("Super Bowl Sunday is the second Sunday of February", () => {
    expect(ymd(superBowl(2026))).toBe("2026-2-8");
    expect(ymd(superBowl(2027))).toBe("2027-2-14");
  });

  test("day numbers are contiguous across a DST change", () => {
    expect(dayNum(2026, 3, 9) - dayNum(2026, 3, 8)).toBe(1);
    expect(dayNum(2026, 11, 2) - dayNum(2026, 11, 1)).toBe(1);
  });
});

describe("activeSeason", () => {
  test("lands on the holiday whose window covers the day, inclusive at both ends", () => {
    expect(activeSeason(on(2026, 11, 8))?.id).toBe("veterans-day");
    expect(activeSeason(on(2026, 11, 11))?.id).toBe("veterans-day");
    expect(activeSeason(on(2026, 11, 12))).toBeNull();
    expect(activeSeason(on(2026, 11, 29))?.id).toBe("thanksgiving"); // the Sunday after
    expect(activeSeason(on(2026, 12, 25))?.id).toBe("christmas");
    expect(activeSeason(on(2026, 4, 5))?.id).toBe("easter");
  });

  test("New Year's spans the year boundary from both sides", () => {
    expect(activeSeason(on(2026, 12, 31))?.id).toBe("new-year");
    expect(activeSeason(on(2027, 1, 1))?.id).toBe("new-year");
    expect(activeSeason(on(2027, 1, 2))?.id).toBe("new-year");
    expect(activeSeason(on(2027, 1, 3))).toBeNull();
  });

  test("a holiday beats an event month, and the shorter of two events wins", () => {
    expect(activeSeason(on(2027, 2, 10))?.id).toBe("valentines"); // inside the Super Bowl weeks
    expect(activeSeason(on(2027, 2, 9))?.id).toBe("super-bowl");
    expect(activeSeason(on(2027, 2, 14))?.id).toBe("valentines"); // both peak that day; the holiday wins
    expect(activeSeason(on(2027, 2, 13))?.id).toBe("presidents-day"); // the long weekend beats the longer lead-in
    expect(activeSeason(on(2026, 2, 14))?.id).toBe("valentines"); // the day itself beats the Presidents' weekend
    expect(activeSeason(on(2026, 6, 18))?.id).toBe("juneteenth"); // inside Father's Day and World Cup
    expect(activeSeason(on(2026, 6, 15))?.id).toBe("fathers-day"); // shorter than the World Cup window
    expect(activeSeason(on(2026, 6, 25))?.id).toBe("world-cup");
    expect(activeSeason(on(2026, 2, 7))?.id).toBe("olympics"); // Winter Games beat the longer Super Bowl run
    expect(activeSeason(on(2028, 10, 20))?.id).toBe("elections");
    expect(activeSeason(on(2028, 10, 28))?.id).toBe("halloween");
  });

  test("four-year and two-year events only run in their years", () => {
    expect(activeSeason(on(2027, 10, 20))).toBeNull(); // no federal general election in odd years
    expect(activeSeason(on(2028, 7, 20))?.id).toBe("olympics");
    expect(activeSeason(on(2029, 7, 20))).toBeNull();
    expect(activeSeason(on(2028, 6, 25))).toBeNull(); // neither World Cup
  });
});

describe("resolveSeason", () => {
  test("a pinned season wins over the calendar; a stale pin is ignored", () => {
    const now = on(2026, 11, 8);
    expect(resolveSeason({ auto: true, pick: "christmas" }, now)?.id).toBe("christmas");
    expect(resolveSeason({ auto: false, pick: "christmas" }, now)?.id).toBe("christmas");
    expect(resolveSeason({ auto: true, pick: "retired-holiday" }, now)?.id).toBe("veterans-day");
    expect(resolveSeason({ auto: false, pick: "retired-holiday" }, now)).toBeNull();
  });

  test("the calendar applies only when the user opted in", () => {
    expect(resolveSeason({ auto: false, pick: "" }, on(2026, 12, 25))).toBeNull();
    expect(resolveSeason({ auto: true, pick: "" }, on(2026, 12, 25))?.id).toBe("christmas");
    expect(resolveSeason({ auto: true, pick: "" }, on(2026, 8, 20))).toBeNull();
  });
});

describe("registry", () => {
  test("every season names a registered palette and fits on one picker line", () => {
    const ids = new Set(THEMES.map((t) => t.id));
    for (const s of SEASONS) {
      expect(ids.has(s.palette), `${s.id} -> ${s.palette}`).toBe(true);
      expect(s.label.length).toBeLessThanOrEqual(20);
      for (const text of [s.label, s.blurb, s.when]) expect(text).not.toContain("\u2014");
    }
    expect(new Set(SEASONS.map((s) => s.id)).size).toBe(SEASONS.length);
  });

  test("every special palette is used by some season", () => {
    const used = new Set(SEASONS.map((s) => s.palette));
    for (const t of THEMES) if (t.special) expect(used.has(t.id), t.id).toBe(true);
  });

  test("every season has an upcoming window within the next four years", () => {
    const now = on(2026, 11, 12);
    for (const s of SEASONS) {
      const w = nextWindow(s, now);
      expect(w, s.id).not.toBeNull();
      expect(w!.end).toBeGreaterThanOrEqual(dayNum(2026, 11, 12));
      expect(w!.start).toBeLessThanOrEqual(w!.end);
    }
    expect(rangeLabel(nextWindow(SEASONS.find((s) => s.id === "new-year")!, now)!)).toBe("Dec 31 - Jan 2");
    expect(rangeLabel(nextWindow(SEASONS.find((s) => s.id === "olympics")!, now)!)).toBe("Jul 15 - Aug 15"); // Feb 2026 has passed
  });
});
