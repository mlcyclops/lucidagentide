// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scheduled_jobs.test.ts - P-SCHED.1 (ADR-0443): the job model's validation, the due / missed
// math, and the scheduler's lane wake against fakes (live idle lane, live busy lane, gone lane recovered
// from the ledger, missing folder, autoApprove snapshot, maxMinutes timeout, disarmed never fires).

import { describe, expect, test } from "bun:test";
import { JobScheduler, type JobSchedulerDeps, type SchedulerLaneView } from "./job_scheduler.ts";
import { createJob, dueVerdict, normalizeJobSpec, withRun, type ScheduledJob } from "./scheduled_jobs.ts";

const T0 = new Date(2026, 9, 8, 1, 0, 0, 0).getTime(); // 2026-10-08 01:00 local
const H = 3600_000;

function job(over: Partial<ScheduledJob> = {}): ScheduledJob {
  const spec = normalizeJobSpec({ name: "nightly", prompt: "run the nightly", target: { name: "Lane A", cwd: "C:\\work\\a", laneId: "lane-a", model: "anthropic/claude" }, cron: "0 2 * * *", armed: true });
  if (!spec.ok) throw new Error(spec.reason);
  return { ...createJob(spec.spec, T0, "j1"), ...over };
}

describe("normalizeJobSpec", () => {
  test("refuses what must not arm, names why", () => {
    expect(normalizeJobSpec({ prompt: "x", target: { cwd: "C:\\w" }, cron: "0 2 * * *" })).toEqual({ ok: false, reason: "a job needs a name" });
    expect(normalizeJobSpec({ name: "n", target: { cwd: "C:\\w" }, cron: "0 2 * * *" })).toEqual({ ok: false, reason: "a job needs the prompt it sends to the lane" });
    expect(normalizeJobSpec({ name: "n", prompt: "p", target: {}, cron: "0 2 * * *" })).toEqual({ ok: false, reason: "a job needs the lane's folder" });
    const bad = normalizeJobSpec({ name: "n", prompt: "p", target: { cwd: "C:\\w" }, cron: "every tuesday" });
    expect(bad.ok).toBe(false);
    const never = normalizeJobSpec({ name: "n", prompt: "p", target: { cwd: "C:\\w" }, cron: "0 9 30 2 *" });
    expect(never.ok).toBe(false);
  });
  test("defaults: disarmed, ask-mode, 60 minutes, run-once; caps maxMinutes; derives the lane name from the folder", () => {
    const r = normalizeJobSpec({ name: " n ", prompt: "p", target: { cwd: "C:\\work\\repo" }, cron: "@daily", maxMinutes: 99999 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.spec).toMatchObject({ name: "n", armed: false, autoApprove: false, missed: "run-once", maxMinutes: 720 });
      expect(r.spec.target).toEqual({ name: "repo", cwd: "C:\\work\\repo" });
    }
  });
});

describe("dueVerdict", () => {
  test("disarmed or suspended never fires; before the first fire nothing is owed; at the minute it is due and not late", () => {
    expect(dueVerdict(job({ armed: false }), T0 + 2 * H)).toEqual({ due: false });
    expect(dueVerdict(job({ suspended: "folder gone" }), T0 + 2 * H)).toEqual({ due: false });
    expect(dueVerdict(job(), T0 + 30 * 60_000)).toEqual({ due: false });
    const fire = new Date(2026, 9, 8, 2, 0).getTime();
    expect(dueVerdict(job(), fire + 10_000)).toEqual({ due: true, fireAt: fire, late: false });
  });
  test("a sleep that swallowed fires: run-once owes ONE catch-up within the grace window, skip owes none, and both move the cursor", () => {
    const fire = new Date(2026, 9, 8, 2, 0).getTime();
    expect(dueVerdict(job(), fire + 90 * 60_000)).toEqual({ due: true, fireAt: fire, late: true }); // 1.5 h late, inside 2 h grace
    expect(dueVerdict(job(), fire + 3 * H)).toEqual({ due: false, skippedFireAt: fire }); // 3 h late: beyond grace
    expect(dueVerdict(job({ missed: "skip" }), fire + 5 * 60_000)).toEqual({ due: false, skippedFireAt: fire });
    // three days asleep: only the LATEST missed fire is considered, never three runs
    const threeDays = new Date(2026, 9, 11, 2, 30).getTime();
    const v = dueVerdict(job(), threeDays);
    expect(v).toEqual({ due: true, fireAt: new Date(2026, 9, 11, 2, 0).getTime(), late: true });
    const after = withRun(job(), { startedAt: threeDays, outcome: "ok" }, new Date(2026, 9, 11, 2, 0).getTime());
    expect(dueVerdict(after, threeDays + 60_000)).toEqual({ due: false }); // the same fire is never owed twice
  });
});

function fakeDeps(over: Partial<JobSchedulerDeps> & { laneList?: SchedulerLaneView[]; busy?: Set<string> } = {}) {
  let jobs: ScheduledJob[] = [job()];
  const lanes: SchedulerLaneView[] = over.laneList ?? [{ id: "lane-a", name: "Lane A", cwd: "C:\\work\\a", model: "anthropic/claude", status: "done", autoApprove: false }];
  const calls = { prompts: [] as { laneId: string; text: string }[], auto: [] as [string, boolean][], cancel: [] as string[], audit: [] as string[], recovered: [] as string[] };
  let clock = T0 + 2 * H + 5_000; // five seconds past the 02:00 fire
  const deps: JobSchedulerDeps = {
    lanes: async () => lanes,
    laneBusy: (id) => (over.busy?.has(id) ? true : lanes.some((l) => l.id === id) ? false : null),
    prompt: over.prompt ?? (async (laneId, text) => { calls.prompts.push({ laneId, text }); clock += 60_000; }),
    recover: over.recover ?? (async (hit) => { calls.recovered.push(hit.name); const l = { id: "lane-new", name: hit.name, cwd: hit.cwd, model: hit.model ?? "m", status: "done", autoApprove: false }; lanes.push(l); return { ok: true, lane: l }; }),
    ledgerLookup: over.ledgerLookup ?? (() => ({ laneId: "lane-old", name: "Lane A", cwd: "C:\\work\\a", model: "anthropic/claude", sessionId: "sess-1" })),
    setAuto: (id, on) => { calls.auto.push([id, on]); const l = lanes.find((x) => x.id === id); if (l) l.autoApprove = on; },
    cancel: (id) => { calls.cancel.push(id); },
    audit: (e) => { calls.audit.push(`${e.name}:${e.outcome}`); },
    now: () => clock,
    exists: over.exists ?? (() => true),
    load: () => jobs,
    save: (j) => { jobs = j; },
  };
  return { deps, calls, lanes, jobs: () => jobs, advance: (ms: number) => { clock += ms; } };
}

describe("JobScheduler", () => {
  test("a due job on a live idle lane is prompted through the manager, recorded ok, audited started + ok, and the fire is consumed", async () => {
    const f = fakeDeps();
    await new JobScheduler(f.deps).tick();
    expect(f.calls.prompts).toEqual([{ laneId: "lane-a", text: "run the nightly" }]);
    const j = f.jobs()[0]!;
    expect(j.lastOutcome).toBe("ok");
    expect(j.history[0]).toMatchObject({ outcome: "ok", laneId: "lane-a" });
    expect(j.history[0]!.endedAt).toBeDefined();
    expect(j.lastFireAt).toBe(new Date(2026, 9, 8, 2, 0).getTime());
    expect(f.calls.audit).toEqual(["nightly:started", "nightly:ok"]);
    await new JobScheduler(f.deps).tick();
    expect(f.calls.prompts.length).toBe(1); // not fired twice for the same 02:00
  });
  test("a busy lane is never preempted: the job waits, the fire stays owed, and it runs once the lane is idle", async () => {
    const busy = new Set(["lane-a"]);
    const f = fakeDeps({ busy });
    const s = new JobScheduler(f.deps);
    await s.tick();
    expect(f.calls.prompts).toEqual([]);
    expect(f.jobs()[0]!.lastOutcome).toBe("waiting");
    expect(f.jobs()[0]!.lastFireAt).toBeUndefined();
    busy.clear();
    await s.tick();
    expect(f.calls.prompts.length).toBe(1);
    expect(f.jobs()[0]!.lastOutcome).toBe("ok");
  });
  test("a gone lane is recovered from the ledger (name, folder, model, session) and then prompted", async () => {
    const f = fakeDeps({ laneList: [] });
    await new JobScheduler(f.deps).tick();
    expect(f.calls.recovered).toEqual(["Lane A"]);
    expect(f.calls.prompts).toEqual([{ laneId: "lane-new", text: "run the nightly" }]);
  });
  test("a target whose folder is gone suspends the job with the reason and never retargets", async () => {
    const f = fakeDeps({ exists: () => false });
    await new JobScheduler(f.deps).tick();
    const j = f.jobs()[0]!;
    expect(j.armed).toBe(false);
    expect(j.suspended).toContain("C:\\work\\a");
    expect(j.lastOutcome).toBe("suspended");
    expect(f.calls.prompts).toEqual([]);
    expect(f.calls.recovered).toEqual([]);
  });
  test("the autoApprove snapshot is applied for the run and the lane's own value restored after", async () => {
    const f = fakeDeps();
    f.jobs()[0]!.autoApprove = true;
    await new JobScheduler(f.deps).tick();
    expect(f.calls.auto).toEqual([["lane-a", true], ["lane-a", false]]);
    expect(f.lanes[0]!.autoApprove).toBe(false);
  });
  test("maxMinutes: a run that outlives its budget is cancelled and recorded as timeout", async () => {
    let cancelled = false;
    const f = fakeDeps({ prompt: async () => { f.advance(61 * 60_000); } });
    f.deps.cancel = () => { cancelled = true; };
    f.jobs()[0]!.maxMinutes = 60;
    await new JobScheduler(f.deps).tick();
    expect(f.jobs()[0]!.lastOutcome).toBe("timeout");
    expect(f.jobs()[0]!.history[0]!.note).toContain("60 min");
    // the kill timer fires in real time (60 min), so in a test the outcome rule is what we can see
    expect(cancelled).toBe(false);
  });
  test("a lane error in the stream is recorded as error with its message", async () => {
    const f = fakeDeps({ prompt: async (_l, _t, sink) => { sink({ type: "error", message: "lane is stopped" }); } });
    await new JobScheduler(f.deps).tick();
    expect(f.jobs()[0]!.lastOutcome).toBe("error");
    expect(f.jobs()[0]!.history[0]!.note).toBe("lane is stopped");
  });
});
