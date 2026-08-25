// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-FLEET.L1: the lane manager against a REAL subprocess boundary (the faithful fake ACP agent the
// firewall integration tests use). What matters: admission is guarded (75% + ceiling) with measured
// reasons, the lane defaults to the MASTER's model, one turn at a time per lane, permission asks are
// fail-closed and land needs-approval, and stop never orphans an ask.

import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { FleetLaneManager, type LaneEvent } from "./fleet_lanes.ts";
import type { SystemSnapshot } from "./system_profile.ts";

const FAKE = join(import.meta.dir, "..", "harness", "mcp", "testing", "fake_acp_agent.ts");
const TIMEOUT = 20_000;

const healthy: SystemSnapshot = { cpuModel: "t", cores: 8, speedMHz: 4000, cpuBusyPct: 10, memTotalMB: 16_000, memFreeMB: 12_000 };

function manager(opts: { snap?: SystemSnapshot; mode?: string } = {}): FleetLaneManager {
  if (opts.mode) process.env.FAKE_ACP_MODE = opts.mode; else delete process.env.FAKE_ACP_MODE;
  return new FleetLaneManager({
    argv: () => ({ cmd: "bun", args: [FAKE] }),
    masterModel: () => "master-model-a",
    sample: async () => opts.snap ?? healthy,
  });
}

let live: FleetLaneManager | null = null;
afterEach(() => { live?.stopAll(); live = null; delete process.env.FAKE_ACP_MODE; });

test("spawn lands awaiting-input with the MASTER's model as the default", async () => {
  live = manager();
  const r = await live.spawn({ cwd: import.meta.dir });
  expect(r.ok).toBe(true);
  expect(r.lane!.status).toBe("awaiting-input");
  expect(r.lane!.model).toBe("master-model-a"); // the default follows the orchestrator
  expect(r.lane!.id).toMatch(/^lane-/);
  expect(r.lane!.name).toBe("desktop"); // basename(cwd) when unnamed
}, TIMEOUT);

test("admission refuses over the watermark with the measured number; a bad cwd never spawns", async () => {
  live = manager({ snap: { ...healthy, memTotalMB: 16_000, memFreeMB: 2_000 } }); // 87% used
  const r = await live.spawn({ cwd: import.meta.dir });
  expect(r.ok).toBe(false);
  expect(r.reason).toContain("88%"); // rounded measured number in the refusal
  const bad = await manager().spawn({ cwd: join(import.meta.dir, "nope-does-not-exist") });
  expect(bad.ok).toBe(false);
  expect(bad.reason).toContain("not a directory");
}, TIMEOUT);

test("a prompt turn streams tokens, lands done, and counts the turn", async () => {
  live = manager();
  const r = await live.spawn({ cwd: import.meta.dir, name: "worker-1" });
  const events: LaneEvent[] = [];
  await live.prompt(r.lane!.id, "ping", (e) => events.push(e));
  const text = events.filter((e) => e.type === "token").map((e) => (e as { text: string }).text).join("");
  expect(text).toContain("You said: ping");
  expect(events.some((e) => e.type === "done")).toBe(true);
  const st = await live.status();
  expect(st.lanes[0]!.status).toBe("done");
  expect(st.lanes[0]!.turns).toBe(1);
  expect(st.masterModel).toBe("master-model-a");
  expect(st.resources.watermarkPct).toBe(75);
}, TIMEOUT);

test("one turn at a time per lane - an overlapping prompt is refused, not crossed", async () => {
  live = manager({ mode: "hang" });
  const r = await live.spawn({ cwd: import.meta.dir });
  const first: LaneEvent[] = [];
  const firstTurn = live.prompt(r.lane!.id, "long", (e) => first.push(e)); // hangs until cancel
  // Real clock on purpose: we wait for a REAL child process (fake ACP over stdio) to receive the prompt;
  // fake timers cannot advance another process's event loop.
  await Bun.sleep(150);
  const second: LaneEvent[] = [];
  await live.prompt(r.lane!.id, "overlap", (e) => second.push(e));
  expect(second.some((e) => e.type === "error" && /busy/.test((e as { message: string }).message))).toBe(true);
  live.cancel(r.lane!.id); // the fake answers session/cancel with stopReason cancelled
  await firstTurn;
  const st = await live.status();
  expect(st.lanes[0]!.status).toBe("awaiting-input"); // a cancelled turn is not an error
}, TIMEOUT);

test("a permission ask lands needs-approval and DENY resolves it fail-closed", async () => {
  live = manager({ mode: "permission" });
  const r = await live.spawn({ cwd: import.meta.dir });
  const events: LaneEvent[] = [];
  const turn = live.prompt(r.lane!.id, "do something risky", (e) => events.push(e));
  // Real clock on purpose: the ask crosses a REAL subprocess stdio boundary mid-turn; there is no local
  // promise to await and fake timers cannot advance the child. Bounded poll, fails loudly at 4s.
  let pending = false;
  for (let i = 0; i < 40 && !pending; i++) { await Bun.sleep(100); pending = !!(await live.status()).lanes[0]!.pendingApproval; }
  expect(pending).toBe(true);
  expect((await live.status()).lanes[0]!.status).toBe("needs-approval");
  expect(live.answer(r.lane!.id, false).ok).toBe(true);
  await turn;
  const text = events.filter((e) => e.type === "token").map((e) => (e as { text: string }).text).join("");
  expect(text).toContain("cancelled"); // the fake echoes the outcome: we denied
  expect(events.some((e) => e.type === "permission")).toBe(true);
}, TIMEOUT);

test("stop kills the lane and dies as a deny for any open ask; stopped lanes refuse prompts", async () => {
  live = manager();
  const r = await live.spawn({ cwd: import.meta.dir });
  expect(live.stop(r.lane!.id).ok).toBe(true);
  expect((await live.status()).lanes[0]!.status).toBe("stopped");
  const events: LaneEvent[] = [];
  await live.prompt(r.lane!.id, "hello?", (e) => events.push(e));
  expect(events.some((e) => e.type === "error")).toBe(true);
}, TIMEOUT);
