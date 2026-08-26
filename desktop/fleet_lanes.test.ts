// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-FLEET.L1/L2: the lane manager against a REAL subprocess boundary (the faithful fake ACP agent the
// firewall integration tests use). What matters: admission is guarded by SUSTAINED pressure (a burst never
// refuses, thirty unbroken seconds does, and there is NO lane ceiling), the lane defaults to the MASTER's
// model, one turn at a time per lane, permission asks are fail-closed and land needs-approval, and stop
// never orphans an ask.

import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { FleetLaneManager, type LaneEvent } from "./fleet_lanes.ts";
import type { SystemSnapshot } from "./system_profile.ts";

const FAKE = join(import.meta.dir, "..", "harness", "mcp", "testing", "fake_acp_agent.ts");
const TIMEOUT = 20_000;

const healthy: SystemSnapshot = { cpuModel: "t", cores: 8, speedMHz: 4000, cpuBusyPct: 10, memTotalMB: 16_000, memFreeMB: 12_000 };
/** Pegged on BOTH metrics: 100% cpu, ~94% memory used. */
const pegged: SystemSnapshot = { ...healthy, cpuBusyPct: 100, memTotalMB: 16_000, memFreeMB: 1_000 };

function manager(opts: { snap?: SystemSnapshot; mode?: string; now?: () => number } = {}): FleetLaneManager {
  if (opts.mode) process.env.FAKE_ACP_MODE = opts.mode; else delete process.env.FAKE_ACP_MODE;
  return new FleetLaneManager({
    argv: () => ({ cmd: "bun", args: [FAKE] }),
    masterModel: () => "master-model-a",
    sample: async () => opts.snap ?? healthy,
    ...(opts.now ? { now: opts.now } : {}),
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

test("a BURST never refuses a lane, even pegged - only a HELD line does; a bad cwd never spawns", async () => {
  // One reading of 100% CPU / 94% memory is a compile finishing, not a machine in trouble.
  live = manager({ snap: pegged });
  const burst = await live.spawn({ cwd: import.meta.dir });
  expect(burst.ok).toBe(true);
  const bad = await manager().spawn({ cwd: join(import.meta.dir, "nope-does-not-exist") });
  expect(bad.ok).toBe(false);
  expect(bad.reason).toContain("not a directory");
}, TIMEOUT);

test("thirty unbroken seconds over the line DOES refuse, carrying the percent and the duration", async () => {
  // A fake clock drives the pressure window: each status() poll takes another pegged reading 5s later, so
  // by the seventh the machine has provably held the line for 30s. Same shape as the real loop (the
  // manager's own sampler plus the dashboard's 2.5s poll), without waiting half a minute for it.
  let t = 1_000_000;
  live = manager({ snap: pegged, now: () => t });
  for (let i = 0; i < 8; i++) { await live.status(); t += 5_000; }
  const r = await live.spawn({ cwd: import.meta.dir });
  expect(r.ok).toBe(false);
  expect(r.reason).toContain("94%");     // measured memory percent
  expect(r.reason).toMatch(/at 94% for \d+s/); // measured duration beside it, not the policy number
  expect(r.reason).toContain("not a burst");
}, TIMEOUT);

test("lanes are UNLIMITED: a healthy box spawns past the old min(6, cores/2) ceiling", async () => {
  // cores: 2 capped this machine at ONE lane under P-FLEET.L1. Three concurrent lanes prove the ceiling is
  // gone and that admission looks only at pressure.
  live = manager({ snap: { ...healthy, cores: 2 } });
  const spawned = await Promise.all([
    live.spawn({ cwd: import.meta.dir, name: "l1" }),
    live.spawn({ cwd: import.meta.dir, name: "l2" }),
    live.spawn({ cwd: import.meta.dir, name: "l3" }),
  ]);
  expect(spawned.map((s) => s.ok)).toEqual([true, true, true]);
  expect(live.liveLanes()).toBe(3);
}, TIMEOUT);

test("a prompt turn streams tokens, lands done, and counts the turn", async () => {
  live = manager();
  const r = await live.spawn({ cwd: import.meta.dir, name: "worker-1" });
  const events: LaneEvent[] = [];
  await live.prompt(r.lane!.id, "ping", (e) => events.push(e));
  const text = events.flatMap((e) => (e.type === "token" ? [e.text] : [])).join("");
  expect(text).toContain("You said: ping");
  expect(events.some((e) => e.type === "done")).toBe(true);
  const st = await live.status();
  expect(st.lanes[0]!.status).toBe("done");
  expect(st.lanes[0]!.turns).toBe(1);
  expect(st.masterModel).toBe("master-model-a");
  expect(st.resources.pressurePct).toBe(90);
  expect(st.resources.sustainMs).toBe(30_000);
  expect(st.resources.cpuHotMs).toBe(0); // a healthy box is never "holding" anything
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
  expect(second.some((e) => e.type === "error" && /busy/.test(e.message))).toBe(true);
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
  const text = events.flatMap((e) => (e.type === "token" ? [e.text] : [])).join("");
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

// ── P-FLEET.L4 (ADR-0274): fault tolerance + recovery spawns ─────────────────────────────────────────

test("a mid-turn CRASH lands error event-driven (no clock), and the next prompt recovers WITH MEMORY", async () => {
  // The child streams half a thought then dies without answering session/prompt. acp.ts die() must
  // reject the pending request the instant the process exits - not after any timeout.
  live = manager({ mode: "crash" });
  const r = await live.spawn({ cwd: import.meta.dir, name: "worker" });
  const id = r.lane!.id;
  const t0 = Date.now();
  const first: LaneEvent[] = [];
  await live.prompt(id, "remember the codeword: PELICAN", (e) => first.push(e));
  expect(Date.now() - t0).toBeLessThan(5_000); // event-driven death, never a deadline
  expect(first.some((e) => e.type === "error")).toBe(true);
  let st = await live.status();
  expect(st.lanes[0]!.status).toBe("error");
  expect(st.lanes[0]!.canRetry).toBe(true);

  // The NEXT prompt recovers in place: a healthy child this time. The fake agent advertises no
  // loadSession capability, so recovery must take the FALLBACK path - the recorded transcript rides the
  // next wire prompt as a one-shot preamble, which the fake echoes back ("You said: ...").
  delete process.env.FAKE_ACP_MODE;
  const second: LaneEvent[] = [];
  await live.prompt(id, "what was the codeword?", (e) => second.push(e));
  const reply = second.flatMap((e) => (e.type === "token" ? [e.text] : [])).join("");
  expect(reply).toContain("PELICAN");                          // memory of the pre-crash turn survived
  expect(reply).toContain("what was the codeword?");           // the new prompt rode along
  expect(reply).toContain("TRANSCRIPT START");                 // clearly delimited as memory, not instructions
  st = await live.status();
  expect(st.lanes[0]!.id).toBe(id);                            // same logical lane, same id (invariant 9)
  expect(st.lanes[0]!.respawns).toBe(1);
  expect(st.lanes[0]!.status).toBe("done");
}, TIMEOUT);

test("retry re-sends the LAST prompt after a crash, without the user asking twice", async () => {
  live = manager({ mode: "crash" });
  const r = await live.spawn({ cwd: import.meta.dir });
  const id = r.lane!.id;
  await live.prompt(id, "ship the release notes", () => {});
  expect((await live.status()).lanes[0]!.status).toBe("error");
  delete process.env.FAKE_ACP_MODE;
  const events: LaneEvent[] = [];
  await live.retry(id, (e) => events.push(e));
  const reply = events.flatMap((e) => (e.type === "token" ? [e.text] : [])).join("");
  expect(reply).toContain("ship the release notes");           // the same ask went out again
  // the failed attempt's user turn was replaced, not duplicated: the preamble carries it at most once
  expect(reply.split("ship the release notes").length - 1).toBeLessThanOrEqual(2); // preamble echo + live prompt
  expect((await live.status()).lanes[0]!.status).toBe("done");
}, TIMEOUT);

test("a pre-respawn approval dies as a DENY, and the revived lane RE-ASKS - never auto-grants", async () => {
  live = manager({ mode: "permission" });
  const r = await live.spawn({ cwd: import.meta.dir });
  const id = r.lane!.id;
  const first: LaneEvent[] = [];
  const turn = live.prompt(id, "attempt the gated action", (e) => first.push(e));
  let pending = false;
  for (let i = 0; i < 40 && !pending; i++) { await Bun.sleep(100); pending = !!(await live.status()).lanes[0]!.pendingApproval; }
  expect(pending).toBe(true);
  // Stop with the ask OPEN: it must die as a deny (fail-closed), never dangle into the respawn.
  expect(live.stop(id).ok).toBe(true);
  await turn;
  const firstText = first.flatMap((e) => (e.type === "token" ? [e.text] : [])).join("");
  if (firstText) expect(firstText).not.toContain('"selected"'); // whatever settled, nothing was granted

  // Revive in place; the SAME gated action must ask a HUMAN again on the new child.
  const rev = await live.respawn(id);
  expect(rev.ok).toBe(true);
  const second: LaneEvent[] = [];
  const turn2 = live.prompt(id, "attempt the gated action again", (e) => second.push(e));
  let pending2 = false;
  for (let i = 0; i < 40 && !pending2; i++) { await Bun.sleep(100); pending2 = !!(await live.status()).lanes[0]!.pendingApproval; }
  expect(pending2).toBe(true);                                  // re-asked, not remembered as granted
  expect(live.answer(id, true).ok).toBe(true);
  await turn2;
  const reply = second.flatMap((e) => (e.type === "token" ? [e.text] : [])).join("");
  expect(reply).toContain('"selected"');                        // THIS allow was explicit and fresh
  expect((await live.status()).lanes[0]!.respawns).toBe(1);
}, TIMEOUT);

test("respawn revives a user-STOPPED lane; prompt alone never does", async () => {
  live = manager();
  const r = await live.spawn({ cwd: import.meta.dir });
  const id = r.lane!.id;
  await live.prompt(id, "first turn", () => {});
  expect(live.stop(id).ok).toBe(true);
  const refused: LaneEvent[] = [];
  await live.prompt(id, "hello?", (e) => refused.push(e));
  expect(refused.some((e) => e.type === "error" && /respawn/.test(e.message))).toBe(true);
  const rev = await live.respawn(id);
  expect(rev.ok).toBe(true);
  expect(rev.lane!.status).toBe("awaiting-input");
  const events: LaneEvent[] = [];
  await live.prompt(id, "second wind", (e) => events.push(e));
  const reply = events.flatMap((e) => (e.type === "token" ? [e.text] : [])).join("");
  expect(reply).toContain("second wind");
  expect(reply).toContain("first turn"); // the stop did not amputate the memory
}, TIMEOUT);
