// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/cron.ts - P-SCHED.1 (ADR-0443 decision 1): the five-field cron LUCID's scheduled jobs run on,
// evaluated in LOCAL wall-clock time, pure and DOM-free so the engine and the renderer share one answer
// ("next three fires" in the Jobs sheet is this same function).
//
//   minute hour day-of-month month day-of-week      lists `1,15`, ranges `9-17`, steps `*/15`, `1-5/2`
//   @hourly @daily @weekly                            the only macros; no seconds, no names, no `L`/`#`
//
// Day-of-month and day-of-week combine the classic way: when BOTH are restricted, a day matches if EITHER
// does (Vixie cron). `7` is Sunday like `0`.
//
// DST, the classic double-fire: the scan steps through real instants (epoch minutes) and tests their
// matches and the job runs at its next matching minute, and a wall-clock minute that exists twice (fall
// back) is matched the first time only: a candidate inside the hour after `after` whose wall clock equals
// `after`'s own wall clock is the repeated hour, and is skipped. One fire per scheduled minute, always.

export interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  /** `*` (or an unrestricted step) in the day-of-month / day-of-week field; drives the OR rule. */
  domAny: boolean;
  dowAny: boolean;
}

const MACROS: Record<string, string> = { "@hourly": "0 * * * *", "@daily": "0 0 * * *", "@weekly": "0 0 * * 0" };
const RANGES: readonly [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

function parseField(src: string, lo: number, hi: number): { set: Set<number>; any: boolean } | null {
  const set = new Set<number>();
  let any = false;
  for (const part of src.split(",")) {
    if (!part) return null;
    const [rangePart, stepPart] = part.split("/");
    if (stepPart !== undefined && (!/^\d+$/.test(stepPart) || Number(stepPart) < 1)) return null;
    const step = stepPart === undefined ? 1 : Number(stepPart);
    let a: number, b: number;
    if (rangePart === "*") { a = lo; b = hi; if (step === 1) any = true; }
    else if (/^\d+$/.test(rangePart!)) { a = Number(rangePart); b = stepPart === undefined ? a : hi; }
    else if (/^\d+-\d+$/.test(rangePart!)) { const [x, y] = rangePart!.split("-").map(Number); a = x!; b = y!; }
    else return null;
    if (a < lo || b > hi || a > b) return null;
    for (let v = a; v <= b; v += step) set.add(v);
  }
  return { set, any };
}

/** Parse a five-field expression (or a macro). Null for anything malformed: a bad schedule never arms. */
export function parseCron(expr: string): CronFields | null {
  const text = MACROS[expr.trim()] ?? expr.trim();
  const parts = text.split(/\s+/);
  if (parts.length !== 5) return null;
  const parsed = parts.map((p, i) => parseField(p, RANGES[i]![0], RANGES[i]![1]));
  if (parsed.some((p) => p === null)) return null;
  const [minute, hour, dom, month, dow] = parsed as { set: Set<number>; any: boolean }[];
  // Sunday is 0 and 7.
  if (dow!.set.has(7)) { dow!.set.add(0); dow!.set.delete(7); }
  return { minute: minute!.set, hour: hour!.set, dom: dom!.set, month: month!.set, dow: dow!.set, domAny: dom!.any, dowAny: dow!.any };
}

function dayMatches(f: CronFields, d: Date): boolean {
  const domOk = f.dom.has(d.getDate());
  const dowOk = f.dow.has(d.getDay());
  if (f.domAny && f.dowAny) return true;
  if (f.domAny) return dowOk;
  if (f.dowAny) return domOk;
  return domOk || dowOk;
}

const MINUTE = 60_000;
const HORIZON_MS = 5 * 366 * 24 * 3600 * 1000; // a schedule that never matches within five years is dead

/** The first instant strictly after `after` matching `fields`, or null (impossible schedule, e.g. 31 Feb). */
export function nextFireFrom(fields: CronFields, after: Date): Date | null {
  const afterMs = after.getTime();
  const afterWall = `${after.getHours()}:${after.getMinutes()}`;
  let t = Math.floor(afterMs / MINUTE) * MINUTE + MINUTE;
  const end = afterMs + HORIZON_MS;
  while (t <= end) {
    const d = new Date(t);
    if (!fields.month.has(d.getMonth() + 1)) {
      // jump to the first minute of next month
      t = new Date(d.getFullYear(), d.getMonth() + 1, 1, 0, 0, 0, 0).getTime();
      continue;
    }
    if (!dayMatches(fields, d)) {
      t = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0).getTime();
      continue;
    }
    if (!fields.hour.has(d.getHours())) {
      // Jump to the next scheduled hour of this day. If that wall-clock hour does not exist (the spring-
      // forward gap),       // which is exactly when the job should run: fire there rather than skipping the day.
      const later = [...fields.hour].filter((h) => h > d.getHours()).sort((a, b) => a - b);
      if (!later.length) { t = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0).getTime(); continue; }
      const firstMinute = Math.min(...fields.minute);
      const cand = new Date(d.getFullYear(), d.getMonth(), d.getDate(), later[0]!, firstMinute, 0, 0);
      if (cand.getTime() <= d.getTime()) { t = d.getTime() + MINUTE; continue; }
      if (cand.getHours() !== later[0]) return cand; // the scheduled minute fell in a DST gap
      t = new Date(d.getFullYear(), d.getMonth(), d.getDate(), later[0]!, 0, 0, 0).getTime();
      continue;
    }
    if (!fields.minute.has(d.getMinutes())) { t += MINUTE; continue; }
    // The repeated hour of a fall-back night: same wall clock as `after`, at most one hour after it.
    if (t - afterMs <= 3600_000 && `${d.getHours()}:${d.getMinutes()}` === afterWall) { t += MINUTE; continue; }
    return d;
  }
  return null;
}

export function nextFire(expr: string, after: Date): Date | null {
  const f = parseCron(expr);
  return f ? nextFireFrom(f, after) : null;
}

/** Up to `limit` fires in (from, to]. */
export function firesBetween(expr: string, from: Date, to: Date, limit = 500): Date[] {
  const f = parseCron(expr);
  if (!f) return [];
  const out: Date[] = [];
  let cursor = from;
  while (out.length < limit) {
    const n = nextFireFrom(f, cursor);
    if (!n || n.getTime() > to.getTime()) break;
    out.push(n);
    cursor = n;
  }
  return out;
}

/** A plain-English line for the sheet and the hover. Covers the shapes the cadence builder emits;
 *  anything else is shown as the raw expression. */
export function describeCron(expr: string): string {
  const f = parseCron(expr);
  if (!f) return "invalid schedule";
  const hhmm = (h: number, m: number) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  if (f.minute.size === 1 && f.hour.size === 1 && f.domAny && f.month.size === 12) {
    const [m] = f.minute; const [h] = f.hour;
    if (f.dowAny) return `every day at ${hhmm(h!, m!)}`;
    const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const days = [...f.dow].sort((a, b) => a - b);
    const label = days.length === 5 && days.join() === "1,2,3,4,5" ? "weekdays" : days.length === 2 && days.join() === "0,6" ? "weekends" : days.map((d) => names[d]).join(", ");
    return `${label} at ${hhmm(h!, m!)}`;
  }
  if (f.minute.size === 1 && f.hour.size === 24 && f.domAny && f.dowAny && f.month.size === 12) { const [m] = f.minute; return m === 0 ? "every hour" : `every hour at :${String(m).padStart(2, "0")}`; }
  return expr.trim();
}
