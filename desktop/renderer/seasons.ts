// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/seasons.ts
//
// P-SEASON.1 (ADR-0525): special themes for U.S. holidays and event months. PURE and DOM-free, so the
// whole calendar (nth-weekday rules, Easter, even-year events, year-spanning windows, overlap
// precedence) is unit-tested in seasons.test.ts without a renderer.
//
// A special theme is NOT a palette. It names one: several seasons share a palette (Thanksgiving rides
// Ember, the user's call), and every palette it names is a real ThemeDef with its own `@palette` block,
// so the token-completeness test in theme.test.ts covers seasonal colors exactly like the base ones.
// On top of the palette a season picks an animated backdrop scene (season_scenes.ts) and a mascot act
// (mascot_season.ts), both keyed by the season id.
//
// Runtime wiring: app.ts resolves the active season from the user's prefs and stamps it on the
// document element as `data-season="<id>"` (absent when none). The runner, the splash and the backdrop
// read that one attribute, so no module has to be handed the season through a call chain.

export type SeasonKind = "holiday" | "event";

/** The animated backdrops. Several seasons share one; each scene may vary its colors by season id. */
export type SceneId =
  | "fireworks" | "sunrise" | "hearts" | "monument" | "clover" | "meadow" | "blossoms" | "yosemite"
  | "beach" | "canyon" | "haunt" | "leaves" | "snow" | "stadium" | "pitch" | "torch";

export type SeasonId =
  | "new-year" | "mlk-day" | "super-bowl" | "valentines" | "presidents-day" | "st-patricks" | "easter"
  | "mothers-day" | "memorial-day" | "fathers-day" | "juneteenth" | "world-cup" | "independence-day"
  | "olympics" | "labor-day" | "indigenous-peoples" | "elections" | "halloween" | "veterans-day"
  | "thanksgiving" | "christmas";

export interface SeasonDef {
  id: SeasonId;
  label: string;   // one-line UI label, must not wrap (invariant 11)
  kind: SeasonKind;
  palette: string; // a ThemeDef id in theme.ts
  scene: SceneId;  // the default backdrop
  blurb: string;   // what the mascot does, one short sentence
  when: string;    // the human description of the window, for the picker
  /** The inclusive local-date windows that START in `year` (a window may end in year + 1). */
  windows(year: number): DayRange[];
}

/** An inclusive range of local calendar days, as day numbers (see dayNum). `peak` is the day itself
 *  (Valentine's on the 14th, the Monday of a long weekend); an event month without one has none. */
export interface DayRange { start: number; end: number; peak?: number }

// ── calendar arithmetic (all local dates, day granularity, no time zones) ─────────────────────────

const DAY_MS = 86_400_000;

/** A local calendar day as an integer, so ranges compare without time-of-day or DST noise. */
export function dayNum(y: number, m: number, d: number): number {
  // Date.UTC on purpose: the INPUT is already a local calendar date, and UTC arithmetic has no DST
  // gaps, so consecutive days are always exactly 1 apart.
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

/** The local calendar day of an instant. */
export function dayOf(now: Date): number {
  return dayNum(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

/** The calendar date of a day number, for display. */
export function dateOf(day: number): { y: number; m: number; d: number } {
  const t = new Date(day * DAY_MS);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** The nth (1-based) `dow` (0 = Sunday) of a month; n = -1 means the last one. */
export function nthWeekday(y: number, m: number, dow: number, n: number): number {
  if (n > 0) {
    const first = dayNum(y, m, 1);
    return first + ((dow - new Date(first * DAY_MS).getUTCDay() + 7) % 7) + (n - 1) * 7;
  }
  const last = dayNum(y, m + 1, 1) - 1; // Date.UTC normalizes month 13 to January of y + 1
  return last - ((new Date(last * DAY_MS).getUTCDay() - dow + 7) % 7);
}

/** Western (Gregorian) Easter Sunday: the anonymous Gregorian computus (Meeus/Jones/Butcher). */
export function easter(y: number): number {
  const a = y % 19;
  const b = Math.floor(y / 100);
  const c = y % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return dayNum(y, month, day);
}

const SUN = 0;
const MON = 1;
const THU = 4;

/** U.S. general Election Day: the Tuesday after the first Monday of November. */
export function electionDay(y: number): number {
  return nthWeekday(y, 11, MON, 1) + 1;
}

/** Super Bowl Sunday: the second Sunday of February (true since the 2022 schedule expansion). */
export function superBowl(y: number): number {
  return nthWeekday(y, 2, SUN, 2);
}

/** A fixed-date window in one month pair; `peakD` is the holiday's day in the END month. */
const fixed = (y: number, m1: number, d1: number, m2: number, d2: number, peakD?: number): DayRange[] => [
  { start: dayNum(y, m1, d1), end: dayNum(y, m2, d2), peak: peakD === undefined ? undefined : dayNum(y, m2, peakD) },
];
/** The long weekend that ends on a Monday holiday: Friday through Monday. */
const longWeekend = (monday: number): DayRange[] => [{ start: monday - 3, end: monday, peak: monday }];

// ── the registry ──────────────────────────────────────────────────────────────────────────────────
// Ordered by calendar so the picker reads as a year. Labels stay short enough for one line.

export const SEASONS: readonly SeasonDef[] = [
  {
    id: "new-year", label: "New Year's", kind: "holiday", palette: "gilded", scene: "fireworks",
    blurb: "LUCID pops a confetti cannon under midnight fireworks.", when: "Dec 31 to Jan 2",
    windows: (y) => [{ start: dayNum(y, 12, 31), end: dayNum(y + 1, 1, 2), peak: dayNum(y + 1, 1, 1) }],
  },
  {
    id: "mlk-day", label: "MLK Jr. Day", kind: "holiday", palette: "dawn", scene: "sunrise",
    blurb: "LUCID releases a white dove into the sunrise.", when: "3rd Monday of January",
    windows: (y) => longWeekend(nthWeekday(y, 1, MON, 3)),
  },
  {
    id: "super-bowl", label: "Super Bowl", kind: "event", palette: "gridiron", scene: "stadium",
    blurb: "A football spirals in and LUCID slices it clean in half.", when: "The four weeks to the big game",
    windows: (y) => { const g = superBowl(y); return [{ start: g - 27, end: g, peak: g }]; },
  },
  {
    id: "valentines", label: "Valentine's Day", kind: "holiday", palette: "rosewood", scene: "hearts",
    blurb: "LUCID throws a heart-shaped shuriken.", when: "Feb 10 to 14",
    windows: (y) => fixed(y, 2, 10, 2, 14, 14),
  },
  {
    id: "presidents-day", label: "Presidents' Day", kind: "holiday", palette: "liberty", scene: "monument",
    blurb: "LUCID tips a tall stovepipe hat.", when: "3rd Monday of February",
    windows: (y) => longWeekend(nthWeekday(y, 2, MON, 3)),
  },
  {
    id: "st-patricks", label: "St. Patrick's Day", kind: "holiday", palette: "shamrock", scene: "clover",
    blurb: "LUCID finds a pot of gold at the end of the rainbow.", when: "Mar 14 to 17",
    windows: (y) => fixed(y, 3, 14, 3, 17, 17),
  },
  {
    id: "easter", label: "Easter", kind: "holiday", palette: "pastel", scene: "meadow",
    blurb: "LUCID hunts for a painted egg in the spring grass.", when: "Palm Sunday to Easter Monday",
    windows: (y) => { const e = easter(y); return [{ start: e - 7, end: e + 1, peak: e }]; },
  },
  {
    id: "mothers-day", label: "Mother's Day", kind: "event", palette: "blossom", scene: "blossoms",
    blurb: "LUCID presents a bouquet under drifting petals.", when: "May 1 to Mother's Day",
    windows: (y) => { const d = nthWeekday(y, 5, SUN, 2); return [{ start: dayNum(y, 5, 1), end: d, peak: d }]; },
  },
  {
    id: "memorial-day", label: "Memorial Day", kind: "holiday", palette: "honor", scene: "yosemite",
    blurb: "LUCID stands and salutes as eagles circle the valley.", when: "Last Monday of May",
    windows: (y) => longWeekend(nthWeekday(y, 5, MON, -1)),
  },
  {
    id: "fathers-day", label: "Father's Day", kind: "event", palette: "harbor", scene: "beach",
    blurb: "LUCID casts a line off the beach and reels one in.", when: "June 1 to Father's Day",
    windows: (y) => { const d = nthWeekday(y, 6, SUN, 3); return [{ start: dayNum(y, 6, 1), end: d, peak: d }]; },
  },
  {
    id: "juneteenth", label: "Juneteenth", kind: "holiday", palette: "jubilee", scene: "sunrise",
    blurb: "LUCID lights a sparkler to celebrate freedom.", when: "Jun 17 to 19",
    windows: (y) => fixed(y, 6, 17, 6, 19, 19),
  },
  {
    // FIFA World Cup years: the men's tournament in y % 4 == 2 (2026 is hosted in North America),
    // the women's in y % 4 == 3. Mid-June to mid-July either way.
    id: "world-cup", label: "World Cup", kind: "event", palette: "pitch", scene: "pitch",
    blurb: "LUCID juggles a soccer ball, then volleys it away.", when: "Mid-June to mid-July, cup years",
    windows: (y) => (y % 4 === 2 ? fixed(y, 6, 11, 7, 19) : y % 4 === 3 ? fixed(y, 6, 20, 7, 20) : []),
  },
  {
    id: "independence-day", label: "Independence Day", kind: "holiday", palette: "liberty", scene: "fireworks",
    blurb: "LUCID waves a sparkler under the fireworks.", when: "Jul 1 to 5",
    windows: (y) => fixed(y, 7, 1, 7, 5, 4),
  },
  {
    // Summer Games in y % 4 == 0 (Los Angeles hosts 2028), Winter Games in y % 4 == 2.
    id: "olympics", label: "Olympic Games", kind: "event", palette: "podium", scene: "torch",
    blurb: "LUCID runs the torch, then takes the top step.", when: "Summer or winter Games",
    windows: (y) => (y % 4 === 0 ? fixed(y, 7, 15, 8, 15) : y % 4 === 2 ? fixed(y, 2, 5, 2, 22) : []),
  },
  {
    id: "labor-day", label: "Labor Day", kind: "holiday", palette: "harbor", scene: "beach",
    blurb: "LUCID puts on a hard hat and drives a nail home.", when: "1st Monday of September",
    windows: (y) => longWeekend(nthWeekday(y, 9, MON, 1)),
  },
  {
    id: "indigenous-peoples", label: "Indigenous Peoples'", kind: "holiday", palette: "heritage", scene: "canyon",
    blurb: "LUCID plants a seedling that sprouts in the mesa light.", when: "2nd Monday of October",
    windows: (y) => longWeekend(nthWeekday(y, 10, MON, 2)),
  },
  {
    // Federal general elections are in even years; the month leading in to Election Day.
    id: "elections", label: "Election Season", kind: "event", palette: "liberty", scene: "monument",
    blurb: "LUCID drops his ballot in the box and earns a sticker.", when: "The month to Election Day",
    windows: (y) => { if (y % 2 !== 0) return []; const e = electionDay(y); return [{ start: e - 29, end: e, peak: e }]; },
  },
  {
    id: "halloween", label: "Halloween", kind: "holiday", palette: "nightshade", scene: "haunt",
    blurb: "LUCID slices a jack-o'-lantern under the full moon.", when: "Oct 24 to 31",
    windows: (y) => fixed(y, 10, 24, 10, 31, 31),
  },
  {
    id: "veterans-day", label: "Veterans Day", kind: "holiday", palette: "honor", scene: "yosemite",
    blurb: "LUCID raises the flag and salutes as bald eagles soar.", when: "Nov 8 to 11",
    windows: (y) => fixed(y, 11, 8, 11, 11, 11),
  },
  {
    id: "thanksgiving", label: "Thanksgiving", kind: "holiday", palette: "ember", scene: "leaves",
    blurb: "LUCID catches falling leaves and serves a pie.", when: "Thanksgiving week",
    windows: (y) => { const t = nthWeekday(y, 11, THU, 4); return [{ start: t - 6, end: t + 3, peak: t }]; },
  },
  {
    id: "christmas", label: "Christmas", kind: "holiday", palette: "evergreen", scene: "snow",
    blurb: "LUCID unwraps a gift in the falling snow.", when: "Dec 1 to 26",
    windows: (y) => fixed(y, 12, 1, 12, 26, 25),
  },
];

const BY_ID: ReadonlyMap<string, SeasonDef> = new Map(SEASONS.map((s) => [s.id, s]));

export function seasonById(id: string | null | undefined): SeasonDef | undefined {
  return id ? BY_ID.get(id) : undefined;
}

/** Every window of `s` that covers `day`, looking one year back for windows that span New Year. */
function coveringWindow(s: SeasonDef, day: number, year: number): DayRange | undefined {
  for (const y of [year - 1, year]) {
    for (const w of s.windows(y)) if (day >= w.start && day <= w.end) return w;
  }
  return undefined;
}

/** The season whose window covers `now`, or null. Overlaps resolve by precedence:
 *    1. a season ON its actual day beats another's lead-in (Valentine's Day itself beats the
 *       Presidents' Day weekend that starts on Feb 12, 2027)
 *    2. a holiday beats an event month (Valentine's week inside the Super Bowl run)
 *    3. between equals, the SHORTER window wins (the more specific occasion)
 *    4. then registry order, so the answer is total and deterministic. */
export function activeSeason(now: Date): SeasonDef | null {
  const day = dayOf(now);
  const year = now.getFullYear();
  let best: { s: SeasonDef; len: number; rank: number } | null = null;
  for (const s of SEASONS) {
    const w = coveringWindow(s, day, year);
    if (!w) continue;
    const rank = (w.peak === day ? 2 : 0) + (s.kind === "holiday" ? 1 : 0);
    const len = w.end - w.start;
    if (!best || rank > best.rank || (rank === best.rank && len < best.len)) best = { s, len, rank };
  }
  return best?.s ?? null;
}

/** The next window of `s` that has not ended yet, from `now` (the current one if it is live). */
export function nextWindow(s: SeasonDef, now: Date): DayRange | null {
  const day = dayOf(now);
  const year = now.getFullYear();
  // Look ahead far enough to reach the next four-year event (Olympics, World Cup).
  for (let y = year - 1; y <= year + 4; y++) {
    const hit = s.windows(y).filter((w) => w.end >= day).sort((a, b) => a.start - b.start)[0];
    if (hit) return hit;
  }
  return null;
}

export interface SeasonPrefs {
  /** Follow the calendar: switch to whichever special theme is live today. */
  auto: boolean;
  /** A season the user pinned by hand ("" = none). A pin wins over the calendar. */
  pick: string;
}

/** The season to paint, or null for the user's own base theme. An explicit pick beats the calendar,
 *  and a stale/unknown pick is ignored rather than trusted (same rule as resolveTheme). */
export function resolveSeason(prefs: SeasonPrefs, now: Date): SeasonDef | null {
  const pinned = seasonById(prefs.pick);
  if (pinned) return pinned;
  return prefs.auto ? activeSeason(now) : null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Nov 8 - 11" or "Dec 31 - Jan 2", for the picker's date column. */
export function rangeLabel(w: DayRange): string {
  const a = dateOf(w.start);
  const b = dateOf(w.end);
  if (a.m === b.m) return a.d === b.d ? `${MONTHS[a.m - 1]} ${a.d}` : `${MONTHS[a.m - 1]} ${a.d} - ${b.d}`;
  return `${MONTHS[a.m - 1]} ${a.d} - ${MONTHS[b.m - 1]} ${b.d}`;
}
