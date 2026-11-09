// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/lane_holder.test.ts - P-HOLDER.1 (ADR-0528). The REAL lucid-holder binary, the REAL lane manager and the
// fake ACP agent as a real subprocess. "Engine A" and "engine B" are two lane managers over one holder folder: A
// letting go (its shutdown path) stands for an engine restart, an IDE update or a closed window. What must hold:
//   - a turn in flight when the engine went settles on the next engine, on the SAME agent process, never re-run;
//   - an ask answered before the engine went is not asked again on the replay; an ask left open is asked again;
//   - stopping a lane ends its holder and the agent's tree and forgets the record;
//   - a holder no engine comes back to ends its agent when its keep-for runs out;
//   - a wrong token, or an offset the holder no longer keeps, is refused.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetLaneManager } from "./fleet_lanes.ts";
import { HolderLink, HolderPool, holderBinary } from "./lane_holder.ts";
import type { SystemSnapshot } from "./system_profile.ts";

const FAKE = join(import.meta.dir, "..", "harness", "mcp", "testing", "fake_acp_agent.ts");
const TIMEOUT = 60_000;
const healthy: SystemSnapshot = { cpuModel: "t", cores: 8, speedMHz: 4000, cpuBusyPct: 10, memTotalMB: 16_000, memFreeMB: 12_000 };
const ASK = `[ask {"title":"write notes.md","kind":"edit"}]`;
const BIN = holderBinary();

const temps: string[] = [];
const temp = (tag: string) => { const d = mkdtempSync(join(tmpdir(), `lucid-holder-${tag}-`)); temps.push(d); return d; };
const fleets: FleetLaneManager[] = [];
const pools: HolderPool[] = [];
afterEach(async () => {
  for (const f of fleets.splice(0)) f.stopAll();
  // End every holder a test left, so nothing outlives the suite.
  for (const p of pools.splice(0)) {
    for (const r of p.all()) { try { await (await HolderLink.connect(r.endpoint, r.token, r.inFlight?.offset ?? r.consumed)).kill(); } catch { /* already gone */ } }
  }
});
afterAll(() => { for (const d of temps) { try { rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* still held */ } } });

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** The agents and holders are real processes on the real clock (fake timers cannot reach them), so wait for the
 *  observable condition, never a guessed delay. */
async function until(cond: () => boolean, what: string, tries = 600): Promise<void> {
  for (let i = 0; i < tries; i++) { if (cond()) return; await Bun.sleep(25); }
  throw new Error(`timed out waiting for ${what}`);
}

function engine(pool: HolderPool): FleetLaneManager {
  const fleet = new FleetLaneManager({ argv: () => ({ cmd: "bun", args: [FAKE] }), masterModel: () => "m", sample: async () => healthy, env: () => ({ LUCID_INTERJECT_TARGET: "lane-held" }), holders: pool });
  fleets.push(fleet);
  return fleet;
}
function holderFolder(): HolderPool {
  const pool = new HolderPool(join(temp("data"), "lane-holders"), BIN!);
  pools.push(pool);
  return pool;
}
const lastReply = (f: FleetLaneManager, id: string) => f.laneTranscript(id).filter((t) => t.role === "assistant").at(-1)?.text ?? "";
const statusOf = async (f: FleetLaneManager, id: string) => (await f.status()).lanes.find((l) => l.id === id)?.status;

describe.skipIf(!BIN)("P-HOLDER.1: lanes under lucid-holder", () => {
  test("a turn in flight when the engine goes settles on the next engine, on the same agent, never re-run", async () => {
    const pool = holderFolder();
    const a = engine(pool);
    const s = await a.spawn({ cwd: temp("ws") });
    expect(s.ok).toBe(true);
    const id = s.lane!.id;
    const before = pool.all()[0]!;
    void a.prompt(id, "[slow 3s] keep going", () => {});
    await until(() => pool.all()[0]?.inFlight !== null, "the turn to be recorded in flight");
    a.stopAll(); // engine A goes away mid-turn
    expect(alive(before.childPid)).toBe(true);

    const b = engine(pool);
    const back = await b.reattach(pool.all()[0]!);
    expect(back.ok).toBe(true);
    expect(b.laneRunning(id)).toBe(true); // still the same turn, still running
    await until(() => b.laneRunning(id) === false, "the resumed turn to settle");
    expect(lastReply(b, id)).toContain("You said: [slow 3s] keep going");
    expect(b.laneTranscript(id).filter((t) => t.role === "user").length).toBe(1); // nothing re-sent
    const after = pool.all()[0]!;
    expect(after.childPid).toBe(before.childPid); // the agent never restarted
    expect(after.inFlight).toBeNull();
    expect(after.turns).toBe(1);
  }, TIMEOUT);

  test("an ask answered before the engine went is not asked again; an ask left open is", async () => {
    const pool = holderFolder();
    const a = engine(pool);
    const id = (await a.spawn({ cwd: temp("ws") })).lane!.id;
    a.setAuto(id, true);
    void a.prompt(id, `${ASK} [then 3s] answered`, () => {});
    await until(() => (pool.all()[0]?.inFlight?.answered.length ?? 0) === 1, "the ask to be answered and recorded");
    a.stopAll();

    const b = engine(pool); // auto approve off: an ask it saw would wait for a human
    expect((await b.reattach(pool.all()[0]!)).ok).toBe(true);
    await until(() => b.laneRunning(id) === false, "the resumed turn to settle");
    expect(lastReply(b, id)).toContain(`"optionId":"allow"`);

    void b.prompt(id, `${ASK} left open`, () => {});
    let parked = false;
    for (let i = 0; i < 400 && !parked; i++) { parked = (await statusOf(b, id)) === "needs-approval"; if (!parked) await Bun.sleep(25); }
    expect(parked).toBe(true);
    b.stopAll(); // the open ask goes with engine B unanswered: no deny reaches the agent

    // Engine C runs with fleet auto ON, but the lane had auto off when B went: the replayed ask must still reach a
    // human, never be approved by C's default (LH-01).
    const c = engine(pool);
    c.setAutoAll(true);
    expect((await c.reattach(pool.all()[0]!)).ok).toBe(true);
    let asked = false;
    for (let i = 0; i < 400 && !asked; i++) { asked = (await statusOf(c, id)) === "needs-approval"; if (!asked) await Bun.sleep(25); }
    expect(asked).toBe(true); // asked again, of the engine that is here now
    expect(c.answer(id, true).ok).toBe(true);
    await until(() => c.laneRunning(id) === false, "the turn to settle after the answer");
    expect(lastReply(c, id)).toContain(`"optionId":"allow"`);
  }, TIMEOUT);

  test("stopping a lane ends its holder and the agent, and forgets the record", async () => {
    const pool = holderFolder();
    const a = engine(pool);
    const id = (await a.spawn({ cwd: temp("ws") })).lane!.id;
    const rec = pool.all()[0]!;
    expect(alive(rec.pid) && alive(rec.childPid)).toBe(true);
    expect(a.stop(id).ok).toBe(true);
    await until(() => !alive(rec.pid) && !alive(rec.childPid), "the holder and the agent to end");
    expect(pool.all()).toEqual([]);
  }, TIMEOUT);

  test("a holder no engine comes back to ends its agent when its keep-for runs out", async () => {
    const pool = holderFolder();
    const h = await pool.launch("lane-0a0b0c0d", "bun", [FAKE], temp("ws"), { ...process.env });
    h.link.resume();
    h.link.keepFor(300);
    h.link.detach();
    await until(() => !alive(h.pid) && !alive(h.childPid), "the orphaned holder to end its agent");
  }, TIMEOUT);

  test("a wrong token, or an offset the holder no longer keeps, is refused", async () => {
    const pool = holderFolder();
    const h = await pool.launch("lane-0e0f0a0b", "bun", [FAKE], temp("ws"), { ...process.env });
    await expect(HolderLink.connect(h.endpoint, "0".repeat(64), 0)).rejects.toThrow(/refused/);
    await expect(HolderLink.connect(h.endpoint, h.token, 10_000_000)).rejects.toThrow(/not kept/);
    await h.link.kill();
  }, TIMEOUT);

  test("a connection that never says hello is closed, and the engine still attaches", async () => {
    const pool = holderFolder();
    const h = await pool.launch("lane-0c0d0e0f", "bun", [FAKE], temp("ws"), { ...process.env });
    const silent = connect({ path: h.endpoint });
    const closed = Promise.withResolvers<number>();
    const t0 = Date.now();
    silent.on("error", () => {});
    silent.on("close", () => closed.resolve(Date.now() - t0));
    const after = await Promise.race([closed.promise, Bun.sleep(15_000).then(() => -1)]);
    expect(after).toBeGreaterThan(0); // the holder hung up on it (5 s handshake deadline), on every platform
    const again = await HolderLink.connect(h.endpoint, h.token, 0);
    expect(again.hello.childPid).toBe(h.childPid);
    await again.kill();
  }, TIMEOUT);

  test("a record that names another endpoint or another lane is not trusted", async () => {
    const pool = holderFolder();
    const h = await pool.launch("lane-0d0e0f0a", "bun", [FAKE], temp("ws"), { ...process.env });
    const base = { v: 1 as const, laneId: "lane-0d0e0f0a", holderId: h.holderId, endpoint: h.endpoint, token: h.token, pid: h.pid, childPid: h.childPid, name: "n", cwd: ".", model: "m", sessionId: null, canLoadSession: false, turns: 0, transcript: [], supervised: false, autoApprove: false, remote: null, hubSessionId: null, createdAt: 0, consumed: 0, lastRequestId: 0, inFlight: null };
    pool.save(base);
    expect(pool.all().map((r) => r.laneId)).toEqual(["lane-0d0e0f0a"]);
    for (const endpoint of [String.raw`\\fileserver\pipe\lucid-holder-x`, "/tmp/elsewhere.sock", `${h.endpoint}x`]) {
      pool.save({ ...base, endpoint });
      expect(pool.all()).toEqual([]);
    }
    pool.save({ ...base, holderId: "lane-0a0a0a0a-1234" }); // a holder id of another lane
    expect(pool.all()).toEqual([]);
    pool.save(base);
    await h.link.kill();
  }, TIMEOUT);
});

// The suite above skips without a holder binary; a gate that skipped silently would pass with the feature broken.
test.skipIf(!!BIN || !process.env.CI)("CI builds the holder before the tests", () => {
  throw new Error("lucid-holder is not built: run `bun run build-holder` in desktop/ (needs Rust), or set LUCID_HOLDER_BIN");
});
