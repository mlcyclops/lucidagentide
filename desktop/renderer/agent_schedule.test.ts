// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-SCHED.AGENT1: the Agents rail's schedule form, as pure rules.

import { describe, expect, it } from "bun:test";
import { agentJobs, describeSchedule, jobName, nextRun, scheduleCron, scheduleSummary } from "./agent_schedule.ts";
import type { JobView } from "./jobs_view.ts";

// Mon 2026-11-23 10:00 local
const NOW = new Date(2026, 10, 23, 10, 0).getTime();

describe("scheduleCron", () => {
  it("builds each repeat's cron", () => {
    expect(scheduleCron({ repeat: "daily", time: "09:05" }, NOW)).toEqual({ ok: true, cron: "5 9 * * *", once: false });
    expect(scheduleCron({ repeat: "weekdays", time: "18:30" }, NOW)).toEqual({ ok: true, cron: "30 18 * * 1-5", once: false });
    expect(scheduleCron({ repeat: "weekly", time: "07:00", days: [5, 1, 1] }, NOW)).toEqual({ ok: true, cron: "0 7 * * 1,5", once: false });
    expect(scheduleCron({ repeat: "monthly", time: "00:15", dom: 28 }, NOW)).toEqual({ ok: true, cron: "15 0 28 * *", once: false });
    expect(scheduleCron({ repeat: "once", time: "14:00", date: "2026-12-02" }, NOW)).toEqual({ ok: true, cron: "0 14 2 12 *", once: true });
  });
  it("refuses what cannot run, and says why", () => {
    const why = (f: Parameters<typeof scheduleCron>[0]) => { const r = scheduleCron(f, NOW); return r.ok ? "" : r.reason; };
    expect(why({ repeat: "daily", time: "25:00" })).toMatch(/time/);
    expect(why({ repeat: "weekly", time: "09:00", days: [] })).toMatch(/day of the week/);
    expect(why({ repeat: "monthly", time: "09:00", dom: 31 })).toMatch(/1 to 28/);
    expect(why({ repeat: "once", time: "09:00", date: "" })).toMatch(/date/);
    expect(why({ repeat: "once", time: "09:00", date: "2026-02-30" })).toMatch(/does not exist/);
    expect(why({ repeat: "once", time: "09:59", date: "2026-11-23" })).toMatch(/already passed/);
    expect(why({ repeat: "once", time: "09:00", date: "2027-12-01" })).toMatch(/year/);
  });
});

describe("describeSchedule and nextRun", () => {
  it("reads like a sentence for every repeat", () => {
    expect(describeSchedule("0 9 * * 1-5", false, NOW)).toMatch(/^Every weekday at 9:00/);
    expect(describeSchedule("0 9 * * *", false, NOW)).toMatch(/^Every day at 9:00/);
    expect(describeSchedule("0 9 * * 1,3", false, NOW)).toMatch(/^Every Mon, Wed at 9:00/);
    expect(describeSchedule("0 9 1 * *", false, NOW)).toMatch(/^Monthly on the 1st at 9:00/);
    expect(describeSchedule("0 14 2 12 *", true, NOW)).toMatch(/^Once on .*Dec.*2/);
  });
  it("finds the next run after now", () => {
    expect(nextRun("0 9 * * 1-5", NOW)).toBe(new Date(2026, 10, 24, 9, 0).getTime());
    expect(nextRun("30 10 * * *", NOW)).toBe(new Date(2026, 10, 23, 10, 30).getTime());
  });
});

const job = (over: Partial<JobView>): JobView => ({
  id: "j", name: "n", prompt: "p", cron: "0 9 * * *", armed: true, autoApprove: false, maxMinutes: 60, missed: "run-once", createdAt: 1,
  nextFireAt: NOW + 3600_000, history: [], target: { name: "A", cwd: "C:\\Work\\Alpha" }, ...over,
});

describe("agentJobs and scheduleSummary", () => {
  it("matches the Agent's folder however it is spelled, newest first", () => {
    const jobs = [job({ id: "a", createdAt: 1 }), job({ id: "b", createdAt: 2, target: { name: "A", cwd: "c:/work/alpha/" } }), job({ id: "c", target: { name: "B", cwd: "C:\\Work\\Beta" } })];
    expect(agentJobs(jobs, "C:\\Work\\Alpha").map((j) => j.id)).toEqual(["b", "a"]);
  });
  it("names the count and the soonest run, or invites one", () => {
    expect(scheduleSummary([], NOW)).toBe("Run it later, or on a repeat");
    expect(scheduleSummary([job({ armed: false, nextFireAt: null })], NOW)).toBe("1 paused");
    expect(scheduleSummary([job({ nextFireAt: NOW + 7200_000 }), job({ nextFireAt: NOW + 3600_000 })], NOW)).toMatch(/^2 scheduled · next /);
  });
  it("names a job by its Agent and the start of its instructions, on one line", () => {
    expect(jobName("Alpha", "Run the tests")).toBe("Alpha: Run the tests");
    expect(jobName("Alpha", "x".repeat(100))).toHaveLength(Math.min(80, "Alpha: ".length + 48 + 3));
  });
});
