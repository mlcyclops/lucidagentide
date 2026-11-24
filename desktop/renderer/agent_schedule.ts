// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/agent_schedule.ts - P-SCHED.AGENT1: the Agents rail's "Schedule this Agent", as PURE pieces (form
// in, cron out; job in, words out) so the rules are unit-tested. agents_rail.ts owns the DOM and the clicks; the
// engine's scheduled jobs (desktop/scheduled_jobs.ts, ADR-0443) own the store and the runs.
//
// A schedule is one of five repeats, each a five-field cron the engine already runs: once (a date and a time,
// `once: true` so the engine disarms it after that fire), daily, weekdays, weekly (chosen days) or monthly (a day
// of the month, 1 to 28 so every month has it).

import { firesBetween, parseCron } from "../cron.ts";
import type { JobView } from "./jobs_view.ts";

export type Repeat = "once" | "daily" | "weekdays" | "weekly" | "monthly";
export const REPEATS: readonly { key: Repeat; label: string }[] = [
  { key: "once", label: "Once" }, { key: "daily", label: "Daily" }, { key: "weekdays", label: "Weekdays" },
  { key: "weekly", label: "Weekly" }, { key: "monthly", label: "Monthly" },
];
export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const DAY = 86_400_000;
/** The engine's limit for a one-time run (ONCE_MAX_AHEAD_MS), kept a day inside it. */
export const ONCE_MAX_DAYS = 365;
export const PROMPT_MAX = 8000;

export interface ScheduleForm {
  repeat: Repeat;
  /** "HH:MM", 24-hour (an <input type="time"> value). */
  time: string;
  /** "YYYY-MM-DD" (once). */
  date?: string;
  /** 0 = Sunday (weekly). */
  days?: number[];
  /** 1..28 (monthly). */
  dom?: number;
}

/** The form as a cron, or why it cannot be saved. `now` decides whether a one-time date is still ahead. */
export function scheduleCron(f: ScheduleForm, now: number): { ok: true; cron: string; once: boolean } | { ok: false; reason: string } {
  const t = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(f.time.trim());
  if (!t) return { ok: false, reason: "Pick a time of day." };
  const minute = Number(t[2]), hour = Number(t[1]);
  switch (f.repeat) {
    case "once": {
      const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(f.date ?? "");
      if (!d) return { ok: false, reason: "Pick the date it should run." };
      const at = new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3]), hour, minute).getTime();
      if (Number.isNaN(at) || new Date(at).getDate() !== Number(d[3])) return { ok: false, reason: "That date does not exist." };
      if (at <= now + 60_000) return { ok: false, reason: "That time has already passed. Pick a later one." };
      if (at - now > ONCE_MAX_DAYS * DAY) return { ok: false, reason: "A one-time run can be at most a year ahead." };
      return { ok: true, cron: `${minute} ${hour} ${Number(d[3])} ${Number(d[2])} *`, once: true };
    }
    case "daily": return { ok: true, cron: `${minute} ${hour} * * *`, once: false };
    case "weekdays": return { ok: true, cron: `${minute} ${hour} * * 1-5`, once: false };
    case "weekly": {
      const days = [...new Set((f.days ?? []).filter((x) => Number.isInteger(x) && x >= 0 && x <= 6))].sort((a, b) => a - b);
      if (!days.length) return { ok: false, reason: "Pick at least one day of the week." };
      return { ok: true, cron: `${minute} ${hour} * * ${days.join(",")}`, once: false };
    }
    case "monthly": {
      const dom = Number(f.dom);
      if (!Number.isInteger(dom) || dom < 1 || dom > 28) return { ok: false, reason: "Pick a day of the month from 1 to 28." };
      return { ok: true, cron: `${minute} ${hour} ${dom} * *`, once: false };
    }
  }
}

/** "9:05 AM" style, in the user's locale. */
export function fmtTime(hour: number, minute: number): string {
  return new Date(2000, 0, 1, hour, minute).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
export function fmtWhen(ms: number): string {
  const d = new Date(ms);
  return `${d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}, ${fmtTime(d.getHours(), d.getMinutes())}`;
}
const ordinal = (n: number): string => `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;

/** One line for a schedule: "Every weekday at 9:00 AM", "Once on Tue, Dec 2, 9:00 AM", "Monthly on the 1st at ...". */
export function describeSchedule(cron: string, once: boolean, now: number): string {
  const f = parseCron(cron);
  if (!f || f.minute.size !== 1 || f.hour.size !== 1) return cron;
  const [m] = f.minute, [h] = f.hour;
  const at = fmtTime(h!, m!);
  if (once) {
    const next = firesBetween(cron, new Date(now - 60_000), new Date(now + 400 * DAY), 1)[0];
    return next ? `Once on ${fmtWhen(next.getTime())}` : `Once at ${at}`;
  }
  if (!f.domAny && f.dowAny && f.dom.size === 1) return `Monthly on the ${ordinal([...f.dom][0]!)} at ${at}`;
  if (f.domAny && f.dowAny) return `Every day at ${at}`;
  const days = [...f.dow].sort((a, b) => a - b);
  if (days.join() === "1,2,3,4,5") return `Every weekday at ${at}`;
  return `Every ${days.map((d) => DAY_NAMES[d]).join(", ")} at ${at}`;
}

/** The next fire of a schedule after `now`, or null. */
export function nextRun(cron: string, now: number): number | null {
  return firesBetween(cron, new Date(now), new Date(now + 400 * DAY), 1)[0]?.getTime() ?? null;
}

/** Folder identity as the rail compares it (agents_store.normFolder's rule, local so this module stays pure). */
const fold = (p: string): string => { const s = String(p).trim().replace(/[\\/]+/g, "/"); return (s.length > 1 ? s.replace(/\/$/, "") : s).toLowerCase(); };

/** This Agent's schedules: jobs whose target folder is the Agent's, newest first. */
export function agentJobs(jobs: readonly JobView[], folder: string): JobView[] {
  const want = fold(folder);
  return jobs.filter((j) => fold(j.target.cwd) === want).sort((a, b) => b.createdAt - a.createdAt);
}

/** The Activate item's second line: what is scheduled, or the invitation. */
export function scheduleSummary(jobs: readonly JobView[], now: number): string {
  const armed = jobs.filter((j) => j.armed && !j.suspended && j.nextFireAt !== null);
  if (!armed.length) return jobs.length ? `${jobs.length} paused` : "Run it later, or on a repeat";
  const next = Math.min(...armed.map((j) => j.nextFireAt!));
  return `${armed.length} scheduled · next ${fmtWhen(Math.max(next, now))}`;
}

/** A job name the Jobs sheet can show on one line: the Agent and the first words of the instructions. */
export function jobName(agent: string, prompt: string): string {
  const words = prompt.trim().replace(/\s+/g, " ").slice(0, 48);
  return `${agent}: ${words}${prompt.trim().length > 48 ? "..." : ""}`.slice(0, 80);
}

/** The default time for a new schedule: the next whole hour. */
export function defaultTime(now: number): string {
  const d = new Date(now + 3600_000);
  return `${String(d.getHours()).padStart(2, "0")}:00`;
}
/** "YYYY-MM-DD" for a local day `days` from `now`. */
export function isoDay(now: number, days = 0): string {
  const d = new Date(now + days * DAY);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
