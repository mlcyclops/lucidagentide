// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_p_sched_1.ts
//
// P-SCHED.1 + .2 (ADR-0443): scheduled jobs that wake a Fleet lane while the operator is away. Proves,
// on the pure modules and the scheduler over fakes (the real lane wake is the manager's own prompt path,
// exercised live in the engine smoke):
//   (a) cron next-fire on weekdays, */15 in a window, a month end, and the spring-forward hour;
//   (b) a lane job on a live idle lane lands as a prompt, and not while the lane is busy;
//   (c) a job on a gone lane recovers it from the ledger (name, cwd, model, session), then prompts;
//   (d) a disarmed job never fires; run-once fires once after a 3 h gap; skip does not;
//   (e) the autoApprove snapshot is applied for the run and restored;
//   (f) maxMinutes records a timeout; (g) a missing folder suspends with the reason;
//   (h) the store refuses a schedule that never fires; (i) the rail tile hides with no jobs, shows the next
//       fire, flags attention, and the hover grid places fires by day and hour.
//
// Run: bun run harness/scripts/demo_p_sched_1.ts

import { nextFire } from "../../desktop/cron.ts";
import { JobScheduler, type JobSchedulerDeps, type SchedulerLaneView } from "../../desktop/job_scheduler.ts";
import { createJob, dueVerdict, normalizeJobSpec, withRun, type ScheduledJob } from "../../desktop/scheduled_jobs.ts";
import { jobsHoverHtml, jobsTile } from "../../desktop/renderer/jobs_view.ts";

const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };
const ok = (cond: boolean, m: string) => { if (!cond) fail(m); console.log(`  ok  ${m}`); };
const wall = (d: Date | null) => d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}` : "null";

console.log("== #ADR-0443 P-SCHED.1/.2: scheduled lane jobs ==\n");

console.log("[a] cron in local time");
ok(wall(nextFire("0 2 * * 1-5", new Date(2026, 9, 9, 2, 0))) === "2026-10-12 02:00", "Friday 02:00 is followed by Monday 02:00 on weekdays");
ok(wall(nextFire("*/15 9-17 * * *", new Date(2026, 9, 8, 17, 45))) === "2026-10-09 09:00", "the window rolls to the next morning");
ok(wall(nextFire("0 9 31 * *", new Date(2026, 3, 1))) === "2026-05-31 09:00", "the 31st skips April");
{
  const prev = process.env.TZ; process.env.TZ = "America/New_York";
  const honored = new Date(2026, 6, 1).getTimezoneOffset() === 240;
  const a = nextFire("30 2 * * *", new Date(2026, 2, 8, 0, 0))!, b = nextFire("30 2 * * *", a)!;
  ok(b.getTime() - a.getTime() > 20 * 3600_000 && b.getTime() - a.getTime() < 28 * 3600_000, `spring-forward day fires once${honored ? ` (at ${wall(a)})` : ""}`);
  process.env.TZ = prev;
}

const T0 = new Date(2026, 9, 8, 1, 0).getTime();
const FIRE = new Date(2026, 9, 8, 2, 0).getTime();
const specRes = normalizeJobSpec({ name: "nightly", prompt: "run the nightly", target: { name: "Lane A", cwd: "C:\\work\\a", laneId: "lane-a", model: "anthropic/claude-haiku-5-5" }, cron: "0 2 * * *", armed: true });
if (!specRes.ok) throw new Error(specRes.reason);
const spec = specRes.spec;
const base = (): ScheduledJob => createJob(spec, T0, "j1");

function harness(o: { lanes?: SchedulerLaneView[]; busy?: Set<string>; exists?: boolean; prompt?: JobSchedulerDeps["prompt"] } = {}) {
  let jobs = [base()];
  const lanes = o.lanes ?? [{ id: "lane-a", name: "Lane A", cwd: "C:\\work\\a", model: "m", status: "done", autoApprove: false }];
  const log = { prompts: [] as string[], auto: [] as string[], recovered: [] as string[], audit: [] as string[] };
  let clock = FIRE + 5_000;
  const deps: JobSchedulerDeps = {
    lanes: async () => lanes,
    laneBusy: (id) => (o.busy?.has(id) ? true : lanes.some((l) => l.id === id) ? false : null),
    prompt: o.prompt ?? (async (laneId, text) => { log.prompts.push(`${laneId}:${text}`); }),
    recover: async (hit) => { log.recovered.push(`${hit.name}@${hit.cwd} ${hit.model} ${hit.sessionId}`); const l = { id: "lane-new", name: hit.name, cwd: hit.cwd, model: hit.model ?? "", status: "done", autoApprove: false }; lanes.push(l); return { ok: true, lane: l }; },
    ledgerLookup: () => ({ laneId: "lane-old", name: "Lane A", cwd: "C:\\work\\a", model: "anthropic/claude-haiku-5-5", sessionId: "sess-1" }),
    setAuto: (id, on) => { log.auto.push(`${id}=${on}`); },
    cancel: () => {},
    audit: (e) => { log.audit.push(e.outcome); },
    now: () => clock,
    exists: () => o.exists !== false,
    load: () => jobs, save: (j) => { jobs = j; },
  };
  return { deps, log, jobs: () => jobs, busy: o.busy, advance: (ms: number) => { clock += ms; } };
}

console.log("\n[b] a live lane: prompted when idle, left alone when busy");
{
  const h = harness();
  await new JobScheduler(h.deps).tick();
  ok(h.log.prompts[0] === "lane-a:run the nightly", "the job's prompt went to the lane through the manager");
  ok(h.jobs()[0]!.lastOutcome === "ok" && h.log.audit.join(",") === "started,ok", "recorded ok; audited started + ok");
  const busy = new Set(["lane-a"]);
  const h2 = harness({ busy });
  const s = new JobScheduler(h2.deps);
  await s.tick();
  ok(h2.log.prompts.length === 0 && h2.jobs()[0]!.lastOutcome === "waiting", "a busy lane is not preempted: the job waits");
  busy.clear(); await s.tick();
  ok(h2.log.prompts.length === 1, "and runs once the lane is idle");
}

console.log("\n[c] a gone lane comes back from the ledger");
{
  const h = harness({ lanes: [] });
  await new JobScheduler(h.deps).tick();
  ok(h.log.recovered[0] === "Lane A@C:\\work\\a anthropic/claude-haiku-5-5 sess-1", "recovered with its name, folder, model and session");
  ok(h.log.prompts[0]?.startsWith("lane-new:") === true, "then prompted on the recovered lane");
}

console.log("\n[d] disarmed, missed run-once, missed skip");
ok(dueVerdict({ ...base(), armed: false }, FIRE + 10_000).due === false, "a disarmed job is never due");
ok(dueVerdict(base(), FIRE + 90 * 60_000).due === true, "run-once: a fire 1.5 h ago is still owed (2 h grace)");
ok(dueVerdict(base(), FIRE + 3 * 3600_000).due === false, "run-once: a fire 3 h ago is skipped");
ok(dueVerdict({ ...base(), missed: "skip" }, FIRE + 5 * 60_000).due === false, "skip: a late fire is never owed");
{
  const after = withRun(base(), { startedAt: FIRE + 5_000, outcome: "ok" }, FIRE);
  ok(dueVerdict(after, FIRE + 60_000).due === false, "a consumed fire is never owed twice");
}

console.log("\n[e] autoApprove snapshot");
{
  const h = harness();
  h.jobs()[0]!.autoApprove = true;
  await new JobScheduler(h.deps).tick();
  ok(h.log.auto.join(",") === "lane-a=true,lane-a=false", "applied for the run, restored after");
}

console.log("\n[f] maxMinutes");
{
  const h = harness({ prompt: async () => {} });
  h.deps.prompt = async () => { h.advance(61 * 60_000); };
  await new JobScheduler(h.deps).tick();
  ok(h.jobs()[0]!.lastOutcome === "timeout", "a run past its cap is recorded as timeout");
}

console.log("\n[g] a missing folder suspends");
{
  const h = harness({ exists: false });
  await new JobScheduler(h.deps).tick();
  ok(h.jobs()[0]!.armed === false && !!h.jobs()[0]!.suspended && h.log.recovered.length === 0, "disarmed with the reason, nothing spawned");
}

console.log("\n[h] the store refuses what must not arm");
ok(!normalizeJobSpec({ name: "n", prompt: "p", target: { cwd: "C:\\w" }, cron: "0 9 30 2 *" }).ok, "a schedule that never fires is refused");
ok(!normalizeJobSpec({ name: "n", prompt: "p", target: { cwd: "C:\\w" }, cron: "tuesdays" }).ok, "a cron that does not parse is refused");

console.log("\n[i] the rail tile and the hover");
{
  const now = new Date(2026, 9, 8, 14, 0).getTime();
  ok(jobsTile({ jobs: [], running: [], upcoming: [] }, now) === null, "no jobs: no tile");
  const j = { ...base(), nextFireAt: now + 12 * 3600_000, history: [] };
  const data = { jobs: [j], running: [], upcoming: [{ at: now + 12 * 3600_000, jobId: "j1", name: "nightly", lane: "Lane A", repo: "a" }] };
  ok(jobsTile(data, now)?.n === "in 12h", "the tile shows the next fire");
  ok(jobsTile({ ...data, running: ["j1"] }, now)?.attn === true, "a running job flags attention");
  const html = jobsHoverHtml(data, now);
  const cells = html.match(/<div class="jg-c[^"]*"/g) ?? [];
  ok(cells.length === 168 && cells[2 * 7 + 1]!.includes("one"), "the hover grid has 7x24 cells and the fire sits at day 1 (tomorrow), hour 02");
}

console.log("\nALL CHECKS PASSED");
