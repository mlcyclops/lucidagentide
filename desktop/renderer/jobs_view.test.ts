// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/jobs_view.test.ts - P-SCHED.2 (ADR-0443): the tile's show/attn rules, the hover grid's
// day/hour placement and row shape, the cadence builder, and the sheet's rows.

import { describe, expect, test } from "bun:test";
import { cadenceToCron, fmtNext, jobRowHtml, jobsHoverHtml, jobsSheetHtml, jobsTile, type JobView, type JobsData } from "./jobs_view.ts";

const now = new Date(2026, 9, 8, 14, 0).getTime(); // Thu 14:00
const H = 3600_000;
function job(over: Partial<JobView> = {}): JobView {
  return { id: "j1", name: "Nightly triage", prompt: "triage the tickets", cron: "0 2 * * *", armed: true, autoApprove: false, maxMinutes: 60, missed: "run-once", createdAt: now - 86_400_000, nextFireAt: now + 12 * H, history: [], target: { laneId: "l1", name: "Customer Portal", cwd: "C:\\work\\portal", repo: "https://github.com/acme/portal.git" }, ...over };
}
function data(over: Partial<JobsData> = {}): JobsData {
  return { jobs: [job()], running: [], upcoming: [{ at: now + 12 * H, jobId: "j1", name: "Nightly triage", lane: "Customer Portal", repo: "acme/portal" }], ...over };
}

describe("jobsTile", () => {
  test("no tile without jobs; the next fire once armed; `attn` on running, waiting, failed or suspended", () => {
    expect(jobsTile(null, now)).toBeNull();
    expect(jobsTile({ jobs: [], running: [], upcoming: [] }, now)).toBeNull();
    expect(jobsTile(data(), now)).toMatchObject({ n: "in 12h", label: "jobs", attn: false });
    expect(jobsTile(data({ jobs: [job({ armed: false })] }), now)).toMatchObject({ n: "off", attn: false });
    expect(jobsTile(data({ running: ["j1"] }), now)).toMatchObject({ n: "1 live", attn: true });
    expect(jobsTile(data({ jobs: [job({ lastOutcome: "error" })] }), now)?.attn).toBe(true);
    expect(jobsTile(data({ jobs: [job({ suspended: "folder gone", armed: false })] }), now)?.attn).toBe(true);
    expect(jobsTile(data(), now)?.tip).toContain("LUCID must stay open");
  });
  test("fmtNext: minutes, hours, then weekday + clock", () => {
    expect(fmtNext(now + 30_000, now)).toBe("now");
    expect(fmtNext(now + 25 * 60_000, now)).toBe("in 25m");
    expect(fmtNext(now + 3 * H, now)).toBe("in 3h");
    expect(fmtNext(new Date(2026, 9, 10, 2, 0).getTime(), now)).toBe("Sat 02:00");
    expect(fmtNext(null, now)).toBe("none");
  });
});

describe("jobsHoverHtml", () => {
  test("places each fire in its day column and hour row (today first), marks a crowded cell, lists the next five as single-line rows", () => {
    const fires = [now + 12 * H, now + 12 * H + 60_000, now + 36 * H, now + 5 * 86_400_000 + 3 * H];
    const h = jobsHoverHtml(data({ upcoming: fires.map((at, i) => ({ at, jobId: `j${i}`, name: `job ${i}`, lane: "L", repo: "r" })) }), now);
    const cells = h.match(/<div class="jg-c[^"]*"/g) ?? [];
    expect(cells.length).toBe(7 * 24);
    // today 02:00 (tomorrow actually: now is Thu 14:00, +12h = Fri 02:00 => day 1, hour 2)
    const idx = (day: number, hour: number) => hour * 7 + day;
    expect(cells[idx(1, 2)]).toContain("many"); // two fires in the same hour
    expect(cells[idx(2, 2)]).toContain("one"); // +36h = Sat 02:00
    expect(cells[idx(5, 17)]).toContain("one"); // +5d 3h = Tue 17:00
    expect(cells[idx(0, 14)]).not.toContain("one");
    expect(h.match(/jn-row/g)?.length).toBe(4);
    expect(h).toContain("today");
    expect(h).toContain("LUCID must stay open");
  });
  test("fires beyond the week are ignored; with none it says so", () => {
    const h = jobsHoverHtml(data({ upcoming: [{ at: now + 9 * 86_400_000, jobId: "j", name: "far", lane: "L", repo: "r" }] }), now);
    expect(h).not.toContain('jg-c one');
    expect(h).toContain("No fires in the next seven days");
  });
});

describe("cadenceToCron", () => {
  test("daily and weekly build from the pickers; cron passes through only when it parses; bad input is null", () => {
    expect(cadenceToCron("daily", "02:30", [], "")).toBe("30 2 * * *");
    expect(cadenceToCron("weekly", "18:00", [1, 3, 5, 5], "")).toBe("0 18 * * 1,3,5");
    expect(cadenceToCron("weekly", "18:00", [], "")).toBeNull();
    expect(cadenceToCron("daily", "25:00", [], "")).toBeNull();
    expect(cadenceToCron("cron", "", [], "*/15 9-17 * * 1-5")).toBe("*/15 9-17 * * 1-5");
    expect(cadenceToCron("cron", "", [], "every tuesday")).toBeNull();
  });
});

describe("the sheet", () => {
  test("a row names the job, its schedule in words, the target with repo and model, and offers Arm/Disarm, Run now, History, Delete", () => {
    const r = jobRowHtml(job({ target: { laneId: "l1", name: "Portal", cwd: "C:\\w\\portal", model: "anthropic/claude-haiku-5-5", repo: "https://github.com/acme/portal.git" } }), now, false);
    expect(r).toContain("every day at 02:00");
    expect(r).toContain("acme/portal");
    expect(r).toContain("claude-haiku-5-5");
    expect(r).toContain('data-arm-to="0"'); // armed -> Disarm
    expect(r).toContain("data-job-run");
    expect(r).toContain("data-job-del");
    expect(jobRowHtml(job({ armed: false }), now, false)).toContain('data-arm-to="1"');
    expect(jobRowHtml(job({ suspended: "the lane's folder no longer exists: C:\\w" }), now, false)).toContain("suspended");
    expect(jobRowHtml(job(), now, true)).toContain("running");
  });
  test("the sheet lists live lanes and remembered lanes as targets and carries the add form with a disarmed default", () => {
    const h = jobsSheetHtml(data(), [{ laneId: "l1", name: "Portal", cwd: "C:\\w\\portal", live: true }, { laneId: "l9", name: "Old", cwd: "C:\\w\\old", live: false }], now);
    expect(h).toContain("Portal · portal</option>");
    expect(h).toContain("Old · old (remembered)</option>");
    expect(h).toContain('name="armed"');
    expect(h).not.toContain('name="armed" checked');
    expect(h).toContain("data-job-form");
  });
});
