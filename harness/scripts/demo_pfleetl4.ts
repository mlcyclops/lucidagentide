// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_pfleetl4.ts
//
// P-FLEET.L4 (ADR-0274): lanes that survive. This demo drives the REAL FleetLaneManager against REAL
// fake-ACP subprocesses and proves, headlessly:
//   1. NO LANE CLOCK: a mid-turn child CRASH lands `error` event-driven (milliseconds, never a
//      600s deadline) - the exact failure the user's screenshot showed is now recoverable.
//   2. RECOVERY WITH MEMORY: the next prompt on an error lane respawns it IN PLACE (same lane id,
//      invariant 9) and the recorded transcript rides the wire, so the lane remembers pre-crash turns.
//   3. RETRY: the failed last prompt re-sends without the user asking twice.
//   4. FAIL-CLOSED SURVIVES RECOVERY: an ask open at death dies as a DENY; the revived lane RE-ASKS a
//      human for the same gated action - approvals are never replayed or remembered as granted.
//   5. A user-STOPPED lane is refused by prompt but revived by explicit respawn, memory intact.
//
// Run: bun run harness/scripts/demo_pfleetl4.ts

import { join } from "node:path";
import { FleetLaneManager, type LaneEvent } from "../../desktop/fleet_lanes.ts";
import type { SystemSnapshot } from "../../desktop/system_profile.ts";

const FAKE = join(import.meta.dir, "..", "mcp", "testing", "fake_acp_agent.ts");

function fail(msg: string): never {
  console.error(`   FAIL - ${msg}`);
  process.exit(1);
}
function ok(msg: string): void {
  console.log(`   ok - ${msg}`);
}
function tokens(events: LaneEvent[]): string {
  return events.flatMap((e) => (e.type === "token" ? [e.text] : [])).join("");
}

const healthy: SystemSnapshot = { cpuModel: "demo", cores: 8, speedMHz: 4000, cpuBusyPct: 10, memTotalMB: 16_000, memFreeMB: 12_000 };

function mgr(mode?: string): FleetLaneManager {
  if (mode) process.env.FAKE_ACP_MODE = mode; else delete process.env.FAKE_ACP_MODE;
  return new FleetLaneManager({ argv: () => ({ cmd: "bun", args: [FAKE] }), masterModel: () => "orchestrator-model", sample: async () => healthy });
}

const sleep = (ms: number) => { const w = Promise.withResolvers<void>(); setTimeout(w.resolve, ms); return w.promise; };

// ── 1 + 2. Crash -> event-driven error -> recovery with memory ───────────────────────────────────────
console.log("1) a mid-turn crash is an EVENT, not a 600-second wait");
const fleet = mgr("crash");
{
  const r = await fleet.spawn({ cwd: process.cwd(), name: "worker" });
  if (!r.ok) fail(r.reason ?? "spawn failed");
  const t0 = Date.now();
  const events: LaneEvent[] = [];
  await fleet.prompt(r.lane!.id, "remember the codeword: PELICAN", (e) => events.push(e));
  const elapsed = Date.now() - t0;
  if (elapsed > 5_000) fail(`death took ${elapsed}ms to surface - that is a clock, not an event`);
  if (!events.some((e) => e.type === "error")) fail("the crash must land an error event");
  const st = await fleet.status();
  if (st.lanes[0]!.status !== "error") fail("lane must be in error");
  if (!st.lanes[0]!.canRetry) fail("an errored lane with a recorded prompt must offer Retry");
  ok(`child died mid-turn; the lane read 'error' in ${elapsed}ms with Retry on offer`);
}

console.log("2) the next prompt RECOVERS the lane in place, memory carried");
{
  delete process.env.FAKE_ACP_MODE; // the respawned child is healthy
  const id = (await fleet.status()).lanes[0]!.id;
  const events: LaneEvent[] = [];
  await fleet.prompt(id, "what was the codeword?", (e) => events.push(e));
  const reply = tokens(events);
  if (!reply.includes("PELICAN")) fail("the recovered lane lost its memory of the pre-crash turn");
  if (!reply.includes("TRANSCRIPT START")) fail("the replay must be delimited as a transcript, not instructions");
  const st = await fleet.status();
  if (st.lanes[0]!.id !== id) fail("recovery must keep the SAME lane id (invariant 9)");
  if (st.lanes[0]!.respawns !== 1) fail(`respawns must count 1, got ${st.lanes[0]!.respawns}`);
  if (st.lanes[0]!.status !== "done") fail("the recovered turn must land done");
  ok(`same lane id, respawns=1, and the reply remembers PELICAN from before the crash`);
  fleet.stopAll();
}

// ── 3. Retry ──────────────────────────────────────────────────────────────────────────────────────
console.log("3) Retry re-sends the failed prompt without asking twice");
{
  const f = mgr("crash");
  const r = await f.spawn({ cwd: process.cwd() });
  await f.prompt(r.lane!.id, "ship the release notes", () => {});
  delete process.env.FAKE_ACP_MODE;
  const events: LaneEvent[] = [];
  await f.retry(r.lane!.id, (e) => events.push(e));
  const reply = tokens(events);
  if (!reply.includes("ship the release notes")) fail("retry must re-send the last prompt");
  if ((await f.status()).lanes[0]!.status !== "done") fail("the retried turn must land done");
  ok("the exact ask went out again and completed on the fresh child");
  f.stopAll();
}

// ── 4. Fail-closed survives recovery ─────────────────────────────────────────────────────────────────
console.log("4) an open ask dies as a DENY; the revived lane RE-ASKS - never auto-grants");
{
  const f = mgr("permission");
  const r = await f.spawn({ cwd: process.cwd() });
  const id = r.lane!.id;
  const turn = f.prompt(id, "attempt the gated action", () => {});
  let pending = false;
  for (let i = 0; i < 50 && !pending; i++) { await sleep(100); pending = !!(await f.status()).lanes[0]!.pendingApproval; }
  if (!pending) fail("the ask never surfaced");
  f.stop(id); // dies with the ask OPEN -> the resolve must be a deny
  await turn;
  const rev = await f.respawn(id);
  if (!rev.ok) fail(rev.reason ?? "respawn failed");
  const events: LaneEvent[] = [];
  const turn2 = f.prompt(id, "attempt it again", (e) => events.push(e));
  let pending2 = false;
  for (let i = 0; i < 50 && !pending2; i++) { await sleep(100); pending2 = !!(await f.status()).lanes[0]!.pendingApproval; }
  if (!pending2) fail("the revived lane must RE-ASK for the same gated action");
  f.answer(id, true);
  await turn2;
  if (!tokens(events).includes('"selected"')) fail("the fresh explicit allow must reach the agent");
  ok("pre-respawn ask denied fail-closed; the revived lane asked a human again and only an explicit allow passed");
  f.stopAll();
}

// ── 5. Stopped is a decision ─────────────────────────────────────────────────────────────────────────
console.log("5) prompt never revives a user-stopped lane; explicit respawn does, with memory");
{
  const f = mgr();
  const r = await f.spawn({ cwd: process.cwd() });
  const id = r.lane!.id;
  await f.prompt(id, "first turn", () => {});
  f.stop(id);
  const refused: LaneEvent[] = [];
  await f.prompt(id, "hello?", (e) => refused.push(e));
  if (!refused.some((e) => e.type === "error" && /respawn/.test(e.message))) fail("a stopped lane must refuse prompts and name the fix");
  const rev = await f.respawn(id);
  if (!rev.ok) fail(rev.reason ?? "respawn failed");
  const events: LaneEvent[] = [];
  await f.prompt(id, "second wind", (e) => events.push(e));
  if (!tokens(events).includes("first turn")) fail("the respawned lane must remember its pre-stop turns");
  ok("stopped stayed stopped for prompts; respawn revived it with its memory intact");
  f.stopAll();
}

console.log("\ndemo_pfleetl4 OK - no lane clock (death is an event), error is a recoverable state, recovery spawns carry the transcript on the SAME lane id, retries re-send the last ask, and fail-closed approvals survive every revival.");
process.exit(0);
