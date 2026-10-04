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
import { DurationHistory } from "./turn_progress.ts";
import { WriteClaims } from "./write_claims.ts";

const FAKE = join(import.meta.dir, "..", "harness", "mcp", "testing", "fake_acp_agent.ts");
const TIMEOUT = 20_000;

const healthy: SystemSnapshot = { cpuModel: "t", cores: 8, speedMHz: 4000, cpuBusyPct: 10, memTotalMB: 16_000, memFreeMB: 12_000 };
/** Pegged on BOTH metrics: 100% cpu, ~94% memory used. */
const pegged: SystemSnapshot = { ...healthy, cpuBusyPct: 100, memTotalMB: 16_000, memFreeMB: 1_000 };

function manager(opts: { snap?: SystemSnapshot; mode?: string; now?: () => number; history?: DurationHistory; claims?: WriteClaims } = {}): FleetLaneManager {
  if (opts.mode) process.env.FAKE_ACP_MODE = opts.mode; else delete process.env.FAKE_ACP_MODE;
  return new FleetLaneManager({
    argv: () => ({ cmd: "bun", args: [FAKE] }),
    masterModel: () => "master-model-a",
    sample: async () => opts.snap ?? healthy,
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.history ? { history: opts.history } : {}),
    ...(opts.claims ? { claims: opts.claims } : {}),
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

// P-GATE-PATH.1 (ADR-0356): the argv thunk (acp_backend.fleetLaneArgv) REFUSES when the security gate is
// not on disk, because there is no such thing as an ungated lane. That refusal has to arrive as a named
// reason on the card like every other one, not as a rejected promise from spawn(), and above all it must
// not leave a half-built lane in the map for the grid to render as if it were alive.
test("a gate-less argv refuses the lane by NAME and creates nothing", async () => {
  const refusal = "refusing to start the agent: the security gate extension is not on disk";
  live = new FleetLaneManager({
    argv: () => { throw new Error(refusal); },
    masterModel: () => "master-model-a",
    sample: async () => healthy,
  });
  const r = await live.spawn({ cwd: import.meta.dir });
  expect(r.ok).toBe(false);
  expect(r.reason).toBe(refusal);
  expect(r.lane).toBeUndefined();
  expect((await live.status()).lanes).toEqual([]); // no orphan lane in the map
}, TIMEOUT);

// P-FLEET.L17 (found live): Recover handed omp a model id it did not know, the handshake failed, and the
// half-built lane stayed in the map as "error": a crashed spoke on the orbit whose Respawn could only
// fail the same way. A spawn refused in the handshake reports WHY and creates nothing.
test("a model omp refuses in the handshake is a named refusal and leaves no orphan lane", async () => {
  live = manager({ mode: "badmodel" });
  const r = await live.spawn({ cwd: import.meta.dir, model: "gpt-6-astra" });
  expect(r.ok).toBe(false);
  expect(r.reason).toContain("Unknown ACP model: gpt-6-astra");
  expect(r.lane).toBeUndefined();
  expect((await live.status()).lanes).toEqual([]);
}, TIMEOUT);

// P-FLEET.L16 (the frozen "Spawning\u2026" button): a filesystem that never answers the directory check
// (a OneDrive dehydrated placeholder, a dead network drive) must become a NAMED refusal on the stat
// clock - never a wedge. The old statSync blocked the whole event loop, so no timeout could even run.
test("a directory check that never answers refuses on the stat clock instead of hanging", async () => {
  const never = Promise.withResolvers<boolean>(); // intentionally never resolved: the hydration stall
  live = new FleetLaneManager({
    argv: () => ({ cmd: "bun", args: [FAKE] }),
    masterModel: () => "master-model-a",
    sample: async () => healthy,
    statDir: () => never.promise,
    statDirMs: 120,
  });
  const t0 = Date.now();
  const r = await live.spawn({ cwd: import.meta.dir });
  expect(r.ok).toBe(false);
  expect(r.reason).toContain("not answering");
  expect(r.reason).toContain("OneDrive");
  expect(Date.now() - t0).toBeLessThan(5_000); // bounded by the clock, nowhere near a human-visible hang
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

// P-FLEET.L8: the transcript holds SETTLED turns only, so a composer attached mid-turn used to land on the
// bare prompt of a lane that had been working for minutes and read as "the spoke stopped".
test("promote MID-TURN carries the in-flight output (tools + text); an idle lane carries none", async () => {
  live = manager({ mode: "midturn" });
  const r = await live.spawn({ cwd: import.meta.dir });
  const firstToken = Promise.withResolvers<void>();
  const turn = live.prompt(r.lane!.id, "long task", (e) => { if (e.type === "token") firstToken.resolve(); });
  await firstToken.promise; // the chunk crossing the real subprocess boundary IS the mid-turn signal
  const mid = live.promote(r.lane!.id);
  expect(mid.ok).toBe(true);
  expect(mid.lane!.status).toBe("working");
  expect(mid.transcript?.map((t) => t.role)).toEqual(["user"]); // the running turn is not settled yet
  expect(mid.live).toEqual({ text: "so far: ", tools: ["read notes.md"] });
  live.cancel(r.lane!.id);
  await turn;
  const idle = live.promote(r.lane!.id);
  expect(idle.live).toBeUndefined();
  expect(idle.transcript?.map((t) => t.role)).toEqual(["user", "assistant"]); // folded on settle
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

// P-FLEET.L17 (found live): Recover on a historical spoke came back with "the whole history gone", because
// it was a plain spawn under the old name. A spawn with `resume` is the spoke's OLD session: the seeded
// transcript is what promote shows, the recorded turn count stands, and (with an agent that cannot load
// sessions natively, like this fake) the memory rides the first prompt as the recovery preamble.
test("spawn with resume brings the recorded conversation back: seeded transcript, kept turns, memory on the wire", async () => {
  live = manager();
  const r = await live.spawn({
    cwd: import.meta.dir, name: "fix it", resume: {
      sessionId: "01a0-recorded",
      transcript: [{ role: "user", text: "the codeword is PELICAN" }, { role: "assistant", text: "noted" }],
      turns: 434,
    },
  });
  expect(r.ok).toBe(true);
  expect(r.lane!.turns).toBe(434);
  expect(r.lane!.name).toBe("fix it");
  expect(live.promote(r.lane!.id).transcript?.map((t) => t.text)).toEqual(["the codeword is PELICAN", "noted"]);
  const events: LaneEvent[] = [];
  await live.prompt(r.lane!.id, "what was the codeword?", (e) => events.push(e));
  const reply = events.flatMap((e) => (e.type === "token" ? [e.text] : [])).join("");
  expect(reply).toContain("PELICAN");
  expect(reply).toContain("TRANSCRIPT START");
  expect((await live.status()).lanes[0]!.turns).toBe(435);
}, TIMEOUT);

// P-SWITCH.2 (ADR-0404): one session, one owner. A lane never loads a session Main or another live lane
// holds; a spawn that would is refused by name and creates nothing, and a stopped lane cannot come back
// on a session someone else opened meanwhile.
test("spawn refuses a session Main or a live lane holds, and creates nothing", async () => {
  let mainSession: string | null = "main-held";
  delete process.env.FAKE_ACP_MODE;
  live = new FleetLaneManager({ argv: () => ({ cmd: "bun", args: [FAKE] }), masterModel: () => "m", masterSessionId: () => mainSession, sample: async () => healthy });
  const resume = (sessionId: string) => ({ cwd: import.meta.dir, resume: { sessionId, transcript: [], turns: 0 } });

  const onMain = await live.spawn(resume("main-held"));
  expect(onMain.ok).toBe(false);
  expect(onMain.reason).toContain("main composer");

  const first = await live.spawn({ cwd: import.meta.dir, name: "first" });
  const held = first.lane!.sessionId!;
  const twice = await live.spawn(resume(held));
  expect(twice.ok).toBe(false);
  expect(twice.reason).toContain(`spoke "first"`);
  expect((await live.status()).lanes).toHaveLength(1);

  // Stopped, the lane lets go; Main opens that session; the lane may not come back onto it.
  live.stop(first.lane!.id);
  mainSession = held;
  const back = await live.respawn(first.lane!.id);
  expect(back.ok).toBe(false);
  expect(back.reason).toContain("main composer");
  mainSession = null;
  expect((await live.respawn(first.lane!.id)).ok).toBe(true);
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

// ── P-FLEET.L3 (ADR-0274): lane fidelity - diffs on the wire, images in prompts, staged queue ────────

test("a write/edit tool_call carries its authored code over the lane wire, path resolved to the LANE cwd", async () => {
  live = manager();
  const r = await live.spawn({ cwd: import.meta.dir });
  const events: LaneEvent[] = [];
  await live.prompt(r.lane!.id, "edit something", (e) => events.push(e));
  const tool = events.find((e) => e.type === "tool" && e.code);
  expect(tool).toBeDefined();
  if (tool?.type !== "tool" || !tool.code) throw new Error("unreachable");
  expect(tool.code.oldText).toBe("hello");
  expect(tool.code.newText).toBe("hello\nworld");
  expect(tool.code.path.replace(/\\/g, "/")).toContain("desktop/src/greeting.ts"); // lane cwd, not the master's
}, TIMEOUT);

test("images ride the prompt as ACP blocks; the transcript remembers the COUNT, never the bytes", async () => {
  live = manager();
  const r = await live.spawn({ cwd: import.meta.dir });
  const id = r.lane!.id;
  const events: LaneEvent[] = [];
  const png = { data: "aGVsbG8=", mimeType: "image/png" };
  await live.prompt(id, "what is in this screenshot?", (e) => events.push(e), [png, png]);
  const reply = events.flatMap((e) => (e.type === "token" ? [e.text] : [])).join("");
  expect(reply).toContain("[images: 2]"); // the fake counts the image blocks it actually received
  // Crash-free way to see the transcript: respawn and read the preamble on the next turn.
  await live.respawn(id);
  const events2: LaneEvent[] = [];
  await live.prompt(id, "still there?", (e) => events2.push(e));
  const reply2 = events2.flatMap((e) => (e.type === "token" ? [e.text] : [])).join("");
  expect(reply2).toContain("[attached 2 images]"); // the count, in memory
  expect(reply2).not.toContain("aGVsbG8="); // the bytes, never
}, TIMEOUT);

// P-FLEET.L19: a composer attaching to an IDLE lane seeds its ctx counter from status, so the manager must
// keep the last measured usage after the turn that reported it ends - and never invent one before that.
test("status carries the lane's last measured usage after the turn ends, and none before omp reports", async () => {
  live = manager({ mode: "lanefidelity" });
  const r = await live.spawn({ cwd: import.meta.dir });
  expect(r.lane!.usage).toBeUndefined();
  await live.prompt(r.lane!.id, "measure me", () => {});
  const lane = (await live.status()).lanes[0]!;
  expect(lane.status).toBe("done");
  expect(lane.usage).toEqual({ used: 4200, size: 200_000, cost: 0.0731 });
  expect(live.promote(r.lane!.id).lane?.usage).toEqual({ used: 4200, size: 200_000, cost: 0.0731 });
}, TIMEOUT);

test("staged prompts run FIFO when the lane goes idle; reorder and remove work; the cap refuses loudly", async () => {
  live = manager();
  const r = await live.spawn({ cwd: import.meta.dir });
  const id = r.lane!.id;
  expect(live.enqueue(id, "first staged").ok).toBe(true);
  expect(live.enqueue(id, "second staged").ok).toBe(true);
  expect(live.enqueue(id, "third staged").ok).toBe(true);
  expect((await live.status()).lanes[0]!.queued.map((q) => q.text)).toEqual(["first staged", "second staged", "third staged"]);
  // Reorder: third before second; then drop first.
  expect(live.queueMove(id, 2, -1).ok).toBe(true);
  expect(live.queueRemove(id, 0).ok).toBe(true);
  expect((await live.status()).lanes[0]!.queued.map((q) => q.text)).toEqual(["third staged", "second staged"]);
  // Drain streams the HEAD like any turn.
  const events: LaneEvent[] = [];
  await live.drain(id, (e) => events.push(e));
  const reply = events.flatMap((e) => (e.type === "token" ? [e.text] : [])).join("");
  expect(reply).toContain("third staged");
  expect((await live.status()).lanes[0]!.queued.length).toBe(1);
  // The cap: fill to QUEUE_MAX and the next one is refused with the number.
  for (let i = 0; i < 7; i++) live.enqueue(id, `filler ${i}`);
  const overflow = live.enqueue(id, "one too many");
  expect(overflow.ok).toBe(false);
  expect(overflow.reason).toContain("full");
  // Draining while BUSY is refused, not crossed (one turn per lane).
  process.env.FAKE_ACP_MODE = "hang";
  const l2 = await live.spawn({ cwd: import.meta.dir, name: "busy" });
  const hangTurn = live.prompt(l2.lane!.id, "long", () => {});
  await Bun.sleep(150);
  live.enqueue(l2.lane!.id, "queued behind the hang");
  const refused: LaneEvent[] = [];
  await live.drain(l2.lane!.id, (e) => refused.push(e));
  expect(refused.some((e) => e.type === "error" && /busy/.test(e.message))).toBe(true);
  live.cancel(l2.lane!.id);
  await hangTurn;
}, TIMEOUT);

// ── P-FLEET.L5 (ADR-0274): the durable lane-session ledger ───────────────────────────────────────────

test("spawn and every recovery NAME the session in the ledger; the view exposes the session id", async () => {
  const records: { laneId: string; name: string; sessionId: string; event: string }[] = [];
  process.env.FAKE_ACP_MODE = "";
  delete process.env.FAKE_ACP_MODE;
  live = new FleetLaneManager({
    argv: () => ({ cmd: "bun", args: [FAKE] }),
    masterModel: () => "master-model-a",
    sample: async () => healthy,
    // A bare spawn, pinned: a run from inside a LUCID lane inherits that lane's target, and the fake then
    // tags its ids with it ("fake-session-lane-<id>-1").
    env: () => ({ LUCID_INTERJECT_TARGET: "master" }),
    recordLaneSession: (rec) => records.push({ laneId: rec.laneId, name: rec.name, sessionId: rec.sessionId, event: rec.event }),
  });
  const r = await live.spawn({ cwd: import.meta.dir, name: "ledgered" });
  expect(r.ok).toBe(true);
  expect(r.lane!.sessionId).toBe("fake-session-1"); // the timeline's key into the on-disk .jsonl
  expect(records).toEqual([{ laneId: r.lane!.id, name: "ledgered", sessionId: "fake-session-1", event: "spawn" }]);
  await live.respawn(r.lane!.id);
  expect(records.length).toBe(2);
  expect(records[1]!.event).toBe("respawn");
  expect(records[1]!.laneId).toBe(r.lane!.id); // same logical lane, whole lineage in the ledger
}, TIMEOUT);

// ── P-SWITCH.3 (ADR-0410): a spoke is born under the master session of the moment and keeps it ──────

test("a spoke keeps the hub it was born under after the master starts a new session; the ledger names it", async () => {
  const hubs: (string | undefined)[] = [];
  let master: string | null = "sess-one";
  delete process.env.FAKE_ACP_MODE;
  live = new FleetLaneManager({
    argv: () => ({ cmd: "bun", args: [FAKE] }),
    masterModel: () => "master-model-a",
    masterSessionId: () => master,
    sample: async () => healthy,
    recordLaneSession: (rec) => hubs.push(rec.hub),
  });
  const first = await live.spawn({ cwd: import.meta.dir, name: "under-one" });
  expect(first.lane!.hubSessionId).toBe("sess-one");
  master = "sess-two"; // the user started a new session: a new hub
  const second = await live.spawn({ cwd: import.meta.dir, name: "under-two" });
  expect(second.lane!.hubSessionId).toBe("sess-two");
  const s = await live.status();
  expect(s.hub).toBe("sess-two");
  expect(s.lanes.map((l) => l.hubSessionId)).toEqual(["sess-one", "sess-two"]); // the first spoke was not reparented
  expect(hubs).toEqual(["sess-one", "sess-two"]);
  master = null; // no master session at all: a hubless spoke, and no hub on its ledger line
  const third = await live.spawn({ cwd: import.meta.dir, name: "hubless" });
  expect(third.lane!.hubSessionId).toBeNull();
  expect(hubs[2]).toBeUndefined();
}, TIMEOUT);

// ── P-FLEET.L6: approval scopes ("allow for session") + full auto-mode ───────────────────────────────

test("scope 'session' remembers the ask's KIND - the next identical ask is granted without a human", async () => {
  live = manager({ mode: "permission" });
  const r = await live.spawn({ cwd: import.meta.dir });
  const id = r.lane!.id;
  const first: LaneEvent[] = [];
  const turn = live.prompt(id, "risky one", (e) => first.push(e));
  // Real clock on purpose: the ask crosses a REAL subprocess stdio boundary. Bounded poll, fails loudly.
  let pending: { summary: string; kind: string } | undefined;
  for (let i = 0; i < 40 && !pending; i++) { await Bun.sleep(100); pending = (await live.status()).lanes[0]!.pendingApproval; }
  expect(pending).toBeDefined();
  expect(pending!.kind).toBe("execute"); // the fake's toolCall kind, threaded into the view
  expect(live.answer(id, true, "session").ok).toBe(true);
  await turn;
  // Turn 2: the SAME kind of ask is granted silently - no permission event, an auto-approved one instead.
  const second: LaneEvent[] = [];
  await live.prompt(id, "risky two", (e) => second.push(e));
  expect(second.some((e) => e.type === "permission")).toBe(false);
  const text = second.flatMap((e) => (e.type === "token" ? [e.text] : [])).join("");
  expect(text).toContain("selected"); // the fake echoes the outcome: we allowed
  expect(second.some((e) => e.type === "auto-approved" && e.mode === "session")).toBe(true);
  expect((await live.status()).lanes[0]!.sessionAllow).toContain("execute");
}, TIMEOUT);

test("full auto-mode answers asks with NO human ask - auto-approved event, never a permission event", async () => {
  live = manager({ mode: "permission" });
  const r = await live.spawn({ cwd: import.meta.dir });
  const set = live.setAuto(r.lane!.id, true);
  expect(set.ok).toBe(true);
  expect(set.lane!.autoApprove).toBe(true);
  const events: LaneEvent[] = [];
  await live.prompt(r.lane!.id, "risky", (e) => events.push(e));
  expect(events.some((e) => e.type === "permission")).toBe(false);
  const text = events.flatMap((e) => (e.type === "token" ? [e.text] : [])).join("");
  expect(text).toContain("selected");
  expect(events.some((e) => e.type === "auto-approved" && e.mode === "auto")).toBe(true);
  expect((await live.status()).lanes[0]!.autoApprove).toBe(true);
}, TIMEOUT);

test("turning auto ON with an ask open resolves the pending ask as an ALLOW - it rides along", async () => {
  live = manager({ mode: "permission" });
  const r = await live.spawn({ cwd: import.meta.dir });
  const events: LaneEvent[] = [];
  const turn = live.prompt(r.lane!.id, "risky", (e) => events.push(e));
  let pending = false;
  for (let i = 0; i < 40 && !pending; i++) { await Bun.sleep(100); pending = !!(await live.status()).lanes[0]!.pendingApproval; }
  expect(pending).toBe(true);
  expect(live.setAuto(r.lane!.id, true).ok).toBe(true);
  await turn;
  const text = events.flatMap((e) => (e.type === "token" ? [e.text] : [])).join("");
  expect(text).toContain("selected"); // the human granted everything; the open ask went with it
}, TIMEOUT);

test("a DENY with scope 'session' records NOTHING - the next ask still lands needs-approval", async () => {
  live = manager({ mode: "permission" });
  const r = await live.spawn({ cwd: import.meta.dir });
  const id = r.lane!.id;
  const first: LaneEvent[] = [];
  const turn1 = live.prompt(id, "risky one", (e) => first.push(e));
  let pending = false;
  for (let i = 0; i < 40 && !pending; i++) { await Bun.sleep(100); pending = !!(await live.status()).lanes[0]!.pendingApproval; }
  expect(pending).toBe(true);
  expect(live.answer(id, false, "session").ok).toBe(true); // refusals never build allowlists
  await turn1;
  expect((await live.status()).lanes[0]!.sessionAllow).toEqual([]);
  // Turn 2: a FRESH ask surfaces - nothing was remembered from the denied one.
  const second: LaneEvent[] = [];
  const turn2 = live.prompt(id, "risky two", (e) => second.push(e));
  pending = false;
  for (let i = 0; i < 40 && !pending; i++) { await Bun.sleep(100); pending = !!(await live.status()).lanes[0]!.pendingApproval; }
  expect(pending).toBe(true);
  expect(live.answer(id, false).ok).toBe(true);
  await turn2;
}, TIMEOUT);

// ── P-PWA-FOCUS.1: watching a lane's CONVERSATION - cross-lane observers + the catch-up transcript ──

test("an observer follows lanes spawned AFTER it registers, tagged by lane id", async () => {
  live = manager();
  const seen: { lane: string; type: string }[] = [];
  live.observe((laneId, e) => seen.push({ lane: laneId, type: e.type }));
  // Registered before ANY lane exists: spawn() is what has to attach it.
  const a = await live.spawn({ cwd: import.meta.dir, name: "watched-a" });
  await live.prompt(a.lane!.id, "alpha", () => {});
  expect(seen.some((s) => s.lane === a.lane!.id && s.type === "token")).toBe(true);
  // A SECOND lane, spawned later still, joins the same observer - "all lanes, present and future".
  const b = await live.spawn({ cwd: import.meta.dir, name: "watched-b" });
  await live.prompt(b.lane!.id, "beta", () => {});
  expect(seen.some((s) => s.lane === b.lane!.id && s.type === "token")).toBe(true);
  expect(new Set(seen.map((s) => s.lane))).toEqual(new Set([a.lane!.id, b.lane!.id]));
}, TIMEOUT);

test("an observer survives a turn ending - prompt()'s finally drops only ITS OWN sink - until dispose", async () => {
  live = manager();
  const seen: LaneEvent[] = [];
  const dispose = live.observe((_laneId, e) => seen.push(e));
  const r = await live.spawn({ cwd: import.meta.dir });
  const id = r.lane!.id;
  await live.prompt(id, "first", () => {});
  const afterFirst = seen.length;
  expect(afterFirst).toBeGreaterThan(0);

  // Turn two on the SAME lane: the observer was never unsubscribed by turn one's teardown.
  await live.prompt(id, "second", () => {});
  const secondTurn = seen.slice(afterFirst);
  expect(secondTurn.flatMap((e) => (e.type === "token" ? [e.text] : [])).join("")).toContain("You said: second");
  expect(secondTurn.some((e) => e.type === "done")).toBe(true);

  dispose();
  const afterDispose = seen.length;
  const turn: LaneEvent[] = [];
  await live.prompt(id, "third", (e) => turn.push(e));
  expect(turn.some((e) => e.type === "done")).toBe(true); // the lane still streams to its own sink
  expect(seen.length).toBe(afterDispose);                 // the observer heard nothing more
}, TIMEOUT);

test("a THROWING observer never breaks the lane nor starves the sinks behind it", async () => {
  live = manager();
  const bad: string[] = [];
  live.observe((_laneId, e) => { bad.push(e.type); throw new Error("observer exploded"); });
  const good: string[] = [];
  live.observe((_laneId, e) => good.push(e.type)); // registered AFTER the thrower, so it is emitted second
  const r = await live.spawn({ cwd: import.meta.dir });
  const turn: LaneEvent[] = [];
  await live.prompt(r.lane!.id, "ping", (e) => turn.push(e));
  expect(turn.flatMap((e) => (e.type === "token" ? [e.text] : [])).join("")).toContain("You said: ping");
  expect(turn.some((e) => e.type === "done")).toBe(true);
  expect(bad.length).toBeGreaterThan(0);   // it really was called, and really did throw every time
  expect(good.length).toBe(bad.length);    // every event still reached the sink behind it
  expect((await live.status()).lanes[0]!.status).toBe("done");
}, TIMEOUT);

test("laneTranscript hands out a COPY of the lane's memory, and [] for an unknown lane", async () => {
  live = manager();
  expect(live.laneTranscript("lane-does-not-exist")).toEqual([]);
  const r = await live.spawn({ cwd: import.meta.dir });
  const id = r.lane!.id;
  await live.prompt(id, "remember: OTTER", () => {});
  const first = live.laneTranscript(id);
  expect(first.length).toBeGreaterThanOrEqual(2); // the user turn plus the folded assistant turn
  expect(first[0]).toEqual({ role: "user", text: "remember: OTTER" });
  // Tampering with the copy must not reach lane state - #resumePreamble replays that same array.
  first[0]!.text = "tampered";
  first.length = 0;
  const again = live.laneTranscript(id);
  expect(again.length).toBeGreaterThanOrEqual(2);
  expect(again[0]).toEqual({ role: "user", text: "remember: OTTER" });
  // P-REMOTE.16: a user record carries no rich fields, a settled assistant record never claims an error for
  // a turn that completed, and an idle lane has no in-flight turn to replay.
  expect(again[0]!.thinking).toBeUndefined();
  expect(again[0]!.tools).toBeUndefined();
  expect(again.find((t) => t.role === "assistant")!.error).toBeUndefined();
  expect(live.laneLiveTurn(id)).toBeNull();
  expect(live.laneLiveTurn("lane-does-not-exist")).toBeNull();
}, TIMEOUT);

// ── P-WAIT.1: workers in one folder run at once; only a write to the same file waits ─────────────

/** Resolves once `events` holds one matching `pred` (no guessed sleep). */
function firstEvent<T extends LaneEvent>(events: LaneEvent[], pred: (e: LaneEvent) => e is T): Promise<T> {
  const { promise, resolve } = Promise.withResolvers<T>();
  const tick = () => { const hit = events.find(pred); if (hit) resolve(hit); else setTimeout(tick, 10); };
  tick();
  return promise;
}
const isOutput = (e: LaneEvent): e is Extract<LaneEvent, { type: "token" }> => e.type === "token";

test("two lanes on ONE folder both reach their agent at once: no folder lease, no waiting", async () => {
  // `midturn`: each child streams output as soon as its prompt arrives, then keeps the turn open. Under the
  // old folder lease, beta's prompt never left the engine while alpha's turn was open.
  live = manager({ mode: "midturn" });
  const a = await live.spawn({ cwd: import.meta.dir, name: "alpha" });

  const b = await live.spawn({ cwd: import.meta.dir, name: "beta" });
  const aEvents: LaneEvent[] = [];
  const bEvents: LaneEvent[] = [];
  const aTurn = live.prompt(a.lane!.id, "first", (e) => aEvents.push(e));
  const bTurn = live.prompt(b.lane!.id, "second", (e) => bEvents.push(e));
  await Promise.all([firstEvent(aEvents, isOutput), firstEvent(bEvents, isOutput)]);
  const st = await live.status();
  expect(st.lanes.filter((l) => l.status === "working").map((l) => l.name).sort()).toEqual(["alpha", "beta"]);
  expect([...aEvents, ...bEvents].some((e) => e.type === "waiting")).toBe(false);
  expect(st.lanes.every((l) => l.waiting === undefined)).toBe(true);
  live.cancel(a.lane!.id); live.cancel(b.lane!.id);
  await Promise.all([aTurn, bTurn]);
}, TIMEOUT);

test("a lane's write wait shows on its card, and its turn end frees its files and clears the wait", async () => {
  const claims = new WriteClaims();
  live = manager({ mode: "midturn", claims });
  const a = await live.spawn({ cwd: import.meta.dir, name: "alpha" });
  const aEvents: LaneEvent[] = [];
  const aTurn = live.prompt(a.lane!.id, "first", (e) => aEvents.push(e));
  await firstEvent(aEvents, isOutput);
  // Alpha's running turn claims a file; Main's write to that file waits on it.
  expect(await claims.acquire({ id: a.lane!.id, name: "alpha" }, ["shared.ts"], import.meta.dir, { waitMs: 0 })).toEqual({ held: false });
  const mainWrite = claims.acquire({ id: "master", name: "Main" }, ["shared.ts"], import.meta.dir, { waitMs: 10_000 });
  // The engine route reports an alpha-side wait the same way; the card reads it from status and the event.
  live.noteWriteWait(a.lane!.id, { on: { id: "master", name: "Main" }, file: "other.ts" });
  const waited = await firstEvent(aEvents, (e): e is Extract<LaneEvent, { type: "waiting" }> => e.type === "waiting");
  expect(waited.wait).toEqual({ on: { id: "master", name: "Main" }, file: "other.ts" });
  expect((await live.status()).lanes[0]!.waiting?.file).toBe("other.ts");
  live.cancel(a.lane!.id);
  await aTurn;
  expect(await mainWrite).toEqual({ held: false }); // alpha's turn ended: Main's write goes through
  expect((await live.status()).lanes[0]!.waiting).toBeUndefined();
  live.noteWriteWait(a.lane!.id, { on: { id: "master", name: "Main" }, file: "late.ts" }); // idle lane: ignored
  expect((await live.status()).lanes[0]!.waiting).toBeUndefined();
}, TIMEOUT);

test("a code-less tool call carries the command, its intent, and settles its own step", async () => {
  live = manager({ mode: "lanefidelity" });
  const r = await live.spawn({ cwd: import.meta.dir });
  const events: LaneEvent[] = [];
  await live.prompt(r.lane!.id, "go", (e) => events.push(e));
  const tools = events.filter((e): e is Extract<LaneEvent, { type: "tool" }> => e.type === "tool");
  expect(tools).toHaveLength(2); // the edit-shaped call (no id) and the bash call
  expect(tools[0]!.id).toBeUndefined();
  expect(tools[0]!.status).toBeUndefined(); // no id: nothing to settle against
  expect(tools[1]!.id).toBe("call-bash-1");
  expect(tools[1]!.input).toContain("bun test desktop/health_watch.test.ts");
  expect(tools[1]!.status).toBe("done"); // the fake reports the call already completed: settled at once
}, TIMEOUT);
