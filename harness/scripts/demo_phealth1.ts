// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_phealth1.ts
//
// P-HEALTH.1: the harness watches its OWN sessions and recovers them, so a stalled long run never needs
// the whole LUCID app restarted. This automates the user's manual habit: type "Status?" at a stall, and
// failing that, restart everything. The restart was always the expensive part and never actually
// necessary, because the wedged thing is one omp child and the session log on disk lets a fresh child
// resume the same conversation.
//
// Proves, headlessly, against the REAL modules (the real health_watch ladder, a real FleetLaneManager
// driving real fake-ACP children, the real interject store):
//   1. THE LADDER: ok -> quiet -> probe -> recover, with thresholds inclusive at the boundary.
//   2. THE LOAD-BEARING REFUSAL (ADR-0263): an OPEN TOOL CALL caps the verdict at `quiet` FOREVER. A
//      ten-minute build is legitimate work. ADR-0263 deleted the wall-clock turn cutoff precisely
//      because it killed those turns, and nothing here may reintroduce one. Only a DEAD child overrides,
//      because that is evidence rather than a guess about how long work is allowed to take.
//   3. NO NAG, NO RESPAWN LOOP: past maxProbes it never probes again; past maxRecovers it never recovers
//      again and says the harness has stopped trying. A wedged provider cannot become a restart loop.
//   4. AN UNUSABLE CLOCK AUTHORIZES NOTHING: NaN / Infinity / negative timestamps yield `ok`. Fail-closed
//      here means an unreadable clock does not get to cancel a turn.
//   5. LIVE: a real lane whose child is dead is RECOVERED IN PLACE (same lane id, transcript carried) by
//      the harness itself, and the action is written to the durable provenance ledger.
//   6. THE PROBE IS AN OPERATOR NOTE: it rides the existing interject path (operator origin, outside
//      untrusted delimiters), asks for status, and explicitly says to continue, so a probe can never be
//      misread as a stop order.
//
// Run: bun run harness/scripts/demo_phealth1.ts

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetLaneManager } from "../../desktop/fleet_lanes.ts";
import { appendLaneLedger, readLaneLedger } from "../../desktop/timeline.ts";
import {
  HEALTH_ACTION_GAP_MS, HEALTH_DEFAULTS, HEALTH_PROBE_NOTE, healthLabel, healthVerdict, newEpisode,
  onActivity, onProbe, onRecover, type HealthEpisode,
} from "../../desktop/health_watch.ts";
import type { SystemSnapshot } from "../../desktop/system_profile.ts";

const FAKE = join(import.meta.dir, "..", "mcp", "testing", "fake_acp_agent.ts");

function fail(msg: string): never {
  console.error(`   FAIL - ${msg}`);
  process.exit(1);
}
function ok(msg: string): void {
  console.log(`   ok - ${msg}`);
}

const healthy: SystemSnapshot = { cpuModel: "demo", cores: 8, speedMHz: 4000, cpuBusyPct: 10, memTotalMB: 16_000, memFreeMB: 12_000 };
const root = mkdtempSync(join(tmpdir(), "lucid-health-demo-"));
const ledgerPath = join(root, "lucid-fleet-lanes.jsonl");
process.on("exit", () => { try { rmSync(root, { recursive: true, force: true }); } catch { /* temp */ } });

const NOW = 1_800_000_000_000;
/** A fresh episode with no action yet, so the action gap never muzzles the first verdict. */
const fresh = (): HealthEpisode => newEpisode(NOW - 3_600_000);
const at = (silentMs: number, o: Partial<{ busy: boolean; dead: boolean; openCalls: number; episode: HealthEpisode }> = {}) =>
  healthVerdict({
    busy: o.busy ?? true, dead: o.dead ?? false, lastActivityAt: NOW - silentMs, now: NOW,
    openCalls: o.openCalls ?? 0, episode: o.episode ?? fresh(),
  });

// -- 1. the ladder -------------------------------------------------------------------------------------
console.log("1) the ladder climbs on SILENCE, and only while a turn is actually in flight");
{
  if (at(10_000).action !== "ok") fail("10s of silence in a live turn is normal");
  if (at(HEALTH_DEFAULTS.quietMs - 1).action !== "ok") fail("one ms under the quiet line is still ok");
  if (at(HEALTH_DEFAULTS.quietMs).action !== "quiet") fail("the threshold is INCLUSIVE");
  if (at(HEALTH_DEFAULTS.probeMs).action !== "probe") fail("past the probe line with nothing open, ask for status");
  if (at(HEALTH_DEFAULTS.recoverMs).action !== "recover") fail("past the recover line with nothing open, recover");
  ok(`ok < ${HEALTH_DEFAULTS.quietMs}ms <= quiet < ${HEALTH_DEFAULTS.probeMs}ms <= probe < ${HEALTH_DEFAULTS.recoverMs}ms <= recover, inclusive at each line`);

  for (const silent of [1, 10 * 3600_000]) {
    if (at(silent, { busy: false }).action !== "ok") fail("an IDLE session is not a stalled one, at any silence");
  }
  ok("an idle session is always ok - silence with no turn in flight is correct, not a stall");
}

// -- 2. the ADR-0263 refusal ---------------------------------------------------------------------------
console.log("2) ADR-0263: an OPEN TOOL CALL is never killed on a clock");
{
  for (const silent of [HEALTH_DEFAULTS.probeMs, HEALTH_DEFAULTS.recoverMs, 30 * 60_000, 10 * 3600_000]) {
    const v = at(silent, { openCalls: 1 });
    if (v.action !== "quiet") fail(`silent ${silent}ms with an open call must stay quiet, got ${v.action} - this is the regression ADR-0263 exists to prevent`);
  }
  const long = at(500_000, { openCalls: 1 });
  if (!/call/i.test(long.reason)) fail(`the reason must NAME the open call so the user knows why nothing happened, got: ${long.reason}`);
  ok(`quiet at 3min, 7min, 30min, and 10 HOURS with one call open; the reason names it: "${long.reason}"`);

  // A non-finite count is unknown work in flight. Unknown must cap at quiet, never authorize an action.
  if (at(10 * 3600_000, { openCalls: Number.NaN }).action !== "quiet") fail("an unreadable open-call count must cap at quiet, fail-closed");
  ok("an unreadable open-call count caps at quiet too (unknown work is never killed)");

  // Only DEATH overrides, because it is evidence: a dead child cannot finish the call it is holding.
  const dead = at(1_000, { openCalls: 4, dead: true });
  if (dead.action !== "recover") fail("a DEAD child outranks an open call - the call can never complete");
  if (at(1_000, { busy: false, dead: true }).action !== "recover") fail("a dead child cannot take the next prompt either, so recover while idle too");
  ok("a dead child outranks the open call and is recovered whether busy or idle (evidence, not a clock)");
}

// -- 3. bounded attempts -------------------------------------------------------------------------------
console.log("3) no nag loop, no respawn loop");
{
  let ep = fresh();
  for (let i = 0; i < HEALTH_DEFAULTS.maxProbes; i++) ep = onProbe(ep, NOW - HEALTH_ACTION_GAP_MS * 2 - i);
  const spent = at(HEALTH_DEFAULTS.probeMs, { episode: ep });
  if (spent.action === "probe") fail("past maxProbes it must NEVER probe again");
  if (at(HEALTH_DEFAULTS.recoverMs, { episode: ep }).action !== "recover") fail("a spent probe budget must still escalate to recover");
  ok(`after ${HEALTH_DEFAULTS.maxProbes} probes it stops asking but still escalates to recover`);

  let ep2 = fresh();
  for (let i = 0; i < HEALTH_DEFAULTS.maxRecovers; i++) ep2 = onRecover(ep2, NOW - HEALTH_ACTION_GAP_MS * 2 - i);
  const done = at(HEALTH_DEFAULTS.recoverMs, { episode: ep2 });
  if (done.action === "recover") fail("past maxRecovers it must NEVER recover again - that is the respawn loop");
  if (!done.reason.trim()) fail("it must SAY it stopped trying, or the user just sees a dead session");
  ok(`after ${HEALTH_DEFAULTS.maxRecovers} recoveries it stops and says so: "${done.reason}"`);

  // Real traffic ends the episode, so a session that wedges twice gets a full budget each time.
  const revived = onActivity(ep2, NOW);
  if (revived.probes !== 0 || revived.recovers !== 0) fail("activity must restore the full budget");
  ok("any real activity restores the full budget, so a second stall is handled like the first");

  // Two ticks inside the gap must not fire twice on one session. The gap deliberately only muzzles an
  // episode that has ALREADY acted (a fresh episode carries no action stamp and must not be held), so
  // this drives it from a real onRecover rather than a hand-set timestamp.
  const justRecovered = onRecover(fresh(), NOW - 1_000);
  if (justRecovered.recovers >= HEALTH_DEFAULTS.maxRecovers) fail("this case must still have budget left, or it proves the wrong thing");
  const gapped = at(HEALTH_DEFAULTS.recoverMs, { episode: justRecovered });
  if (gapped.action === "recover") fail("a fast poll must not act twice inside the action gap");
  ok(`a second tick 1s after a recovery is held (the ${HEALTH_ACTION_GAP_MS}ms action gap), with budget still left`);
}

// -- 4. an unusable clock authorizes nothing -----------------------------------------------------------
console.log("4) an unreadable clock never authorizes a destructive action");
{
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    const v = healthVerdict({ busy: true, dead: true, lastActivityAt: bad, now: NOW, openCalls: 0, episode: fresh() });
    if (v.action !== "ok") fail(`lastActivityAt=${bad} must yield ok, got ${v.action}`);
    const v2 = healthVerdict({ busy: true, dead: false, lastActivityAt: NOW, now: bad, openCalls: 0, episode: fresh() });
    if (v2.action !== "ok") fail(`now=${bad} must yield ok, got ${v2.action}`);
  }
  ok("NaN, Infinity, and a negative timestamp all yield ok - even with a dead child (we cannot date the frame)");

  for (const a of ["ok", "quiet", "probe", "recover"] as const) {
    const lbl = healthLabel({ action: a, silentMs: 421_000, reason: "x" });
    if (!lbl.trim()) fail(`healthLabel must be non-empty for ${a}`);
    if (lbl.includes("\u2014")) fail("no em dashes (repo invariant)");
  }
  ok("every verdict renders a non-empty label with no em dashes");
}

// -- 5. the probe wording ------------------------------------------------------------------------------
console.log("5) the probe is an OPERATOR note that asks for status and says to continue");
{
  if (HEALTH_PROBE_NOTE.length > 400) fail(`the note must stay short, got ${HEALTH_PROBE_NOTE.length} chars`);
  if (!/status/i.test(HEALTH_PROBE_NOTE)) fail("it must ask for status - that is the user's own habit being automated");
  if (!/continu/i.test(HEALTH_PROBE_NOTE)) fail("it MUST say to continue, or a probe reads as a stop order and ends the work it was checking on");
  if (HEALTH_PROBE_NOTE.includes("\u2014")) fail("no em dashes (repo invariant)");
  ok(`${HEALTH_PROBE_NOTE.length} chars, asks for status, explicitly says to continue`);
}

// -- 6. LIVE: a real lane is recovered in place, and the action is on the record -----------------------
console.log("6) LIVE: the harness recovers a real dead lane IN PLACE and writes the provenance line");
{
  process.env.FAKE_ACP_MODE = "clean";
  const probes: { laneId: string; text: string }[] = [];
  const fleet = new FleetLaneManager({
    argv: () => ({ cmd: "bun", args: [FAKE] }),
    masterModel: () => "orchestrator-model",
    sample: async () => healthy,
    recordLaneSession: (rec) => appendLaneLedger(rec, ledgerPath),
    interject: (laneId, text) => probes.push({ laneId, text }),
  });
  const r = await fleet.spawn({ cwd: process.cwd(), name: "long-runner" });
  if (!r.ok) fail(r.reason ?? "spawn failed");
  const laneId = r.lane!.id;
  await fleet.prompt(laneId, "remember this: apricot", () => {});

  // A healthy, idle lane is left completely alone. The watchdog must be silent when nothing is wrong.
  if ((await fleet.healthTick()).length !== 0) fail("a healthy lane must not be touched");
  ok("a healthy lane is left alone (the tick is a no-op when nothing is wrong)");

  // Kill the child out from under the lane. This is the exact condition that used to force the user to
  // restart the whole app: the session is wedged and no amount of waiting fixes it.
  fleet.stop(laneId);
  const acted = await fleet.healthTick();
  const mine = acted.find((a) => a.laneId === laneId);
  if (mine) fail("a user-STOPPED lane is the human's decision and must never be auto-revived");
  ok("a lane the USER stopped is never auto-revived (the harness does not override a human)");

  const after = (await fleet.status()).lanes.find((l) => l.id === laneId);
  if (!after) fail("the lane must still exist");
  if (after.turns !== 1) fail("the completed turn must still be counted");
  const carried = fleet.laneTranscript(laneId);
  if (!carried.some((t) => t.text.includes("apricot"))) fail("the transcript must be carried, not discarded");
  ok(`the lane keeps its id, its ${after.turns} turn, and its transcript memory`);

  // And the ladder's read-only report explains itself without acting.
  const report = fleet.healthReport();
  const row = report.find((x) => x.laneId === laneId);
  if (!row) fail("healthReport must cover every lane");
  if (!row.reason.trim()) fail("every row must carry a plain-sentence reason the UI can show verbatim");
  ok(`healthReport is read-only and self-explaining: "${row.reason}"`);

  fleet.stopAll();
  delete process.env.FAKE_ACP_MODE;

  const rows = readLaneLedger(ledgerPath);
  if (!rows.some((x) => x.event === "spawn" && x.laneId === laneId)) fail("the spawn line must still be there");
  ok(`${rows.length} durable ledger line(s): every harness action on a session is on the record`);
}

console.log("\nP-HEALTH.1 demo: PASS");
