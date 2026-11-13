// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/lane_holder.test.ts - P-HOLDER.1 (ADR-0534). The REAL lucid-holder binary, the REAL lane manager and the
// fake ACP agent as a real subprocess. "Engine A" and "engine B" are two lane managers over one holder folder: A
// letting go (its shutdown path) stands for an engine restart, an IDE update or a closed window. What must hold:
//   - a turn in flight when the engine went settles on the next engine, on the SAME agent process, never re-run;
//   - an ask answered before the engine went is not asked again on the replay; an ask left open is asked again;
//   - stopping a lane ends its holder and the agent's tree and forgets the record;
//   - a holder no engine comes back to ends its agent when its keep-for runs out;
//   - a wrong token, or an offset the holder no longer keeps, is refused;
//   - the token never crosses the endpoint: whoever answers on it must prove it holds the token before anything of
//     the user's is sent, and the holder answers only a client that proved itself the same way;
//   - a client that falls behind is cut off and comes back from its offset; a closed link still delivers a KILL;
//   - a holder that is alive but does not answer is never started over; a kill reaches only the recorded process.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHANNEL_ENV } from "../harness/omp/engine_channel.ts";
import { ACPClient, type HeldIO } from "./acp.ts";
import { FleetLaneManager } from "./fleet_lanes.ts";
import { endHolderProcess, HolderLink, HolderPool, holderBinary, holderProcessAlive, holderProof, MAX_FRAME, processStartId, socketFolderProblem } from "./lane_holder.ts";
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

/** A raw client: sends `first`, answers the holder's first line with `second` (when given and not a refusal), and
 *  returns the lines the holder sent until it refused or the second answer came. */
async function exchange(endpoint: string, first: object, second?: (challenge: Record<string, unknown>) => object): Promise<Record<string, unknown>[]> {
  const sock = connect({ path: endpoint });
  const got: Record<string, unknown>[] = [];
  const done = Promise.withResolvers<void>();
  let buf = "";
  sock.on("error", () => done.resolve());
  sock.on("close", () => done.resolve());
  sock.on("data", (d) => {
    buf += String(d);
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      const msg = JSON.parse(buf.slice(0, nl)) as Record<string, unknown>;
      buf = buf.slice(nl + 1);
      got.push(msg);
      if (got.length === 1 && second && msg.ok !== false) { sock.write(`${JSON.stringify(second(msg))}\n`); continue; }
      done.resolve();
      return;
    }
  });
  sock.once("connect", () => sock.write(`${JSON.stringify(first)}\n`));
  await done.promise;
  sock.destroy();
  return got;
}

/** A listener on an endpoint of its own (a pipe on Windows, a socket in a fresh 0700 folder elsewhere) that answers
 *  each line a client sends with `answer`, and keeps everything it was sent. */
async function fakeHolder(answer: (line: Record<string, unknown>, sock: Socket) => void): Promise<{ endpoint: string; seen: () => string; close: () => void }> {
  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\lucid-squat-${randomBytes(8).toString("hex")}` : join(temp("squat"), "s.sock");
  let seen = "";
  const server = createServer((sock) => {
    let buf = "";
    sock.on("error", () => {});
    sock.on("data", (d) => {
      seen += String(d);
      buf += String(d);
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const line = JSON.parse(buf.slice(0, nl)) as Record<string, unknown>;
        buf = buf.slice(nl + 1);
        answer(line, sock);
      }
    });
  });
  const listening = Promise.withResolvers<void>();
  server.listen(endpoint, () => listening.resolve());
  await listening.promise;
  return { endpoint, seen: () => seen, close: () => { server.close(); } };
}

/** A HeldIO that records what the client sent, and hands out `next` when asked to reconnect. */
function fakeIO(offset: number, next: (from: number) => Promise<HeldIO>) {
  const sent: string[] = [];
  const io: HeldIO & { sent: string[] } = {
    hello: { childPid: 1 }, offset, sent,
    onStdout: () => {}, onStderr: () => {}, onExit: () => {}, onClose: () => {},
    resume: () => {}, write: (d) => { sent.push(d); }, trim: () => {}, keepFor: () => {},
    kill: async () => true, detach: () => {}, reconnect: next,
  };
  return io;
}

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
    // LH-05: the record goes once the holder has CONFIRMED the end, which can land just after the processes are
    // gone; waiting for it (bounded) keeps the assertion and drops the race the ubuntu runner hit.
    await until(() => pool.all().length === 0, "the record to be forgotten");
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
    // With the wrong token the holder's proof does not verify: the engine gives up before it proves anything itself.
    await expect(HolderLink.connect(h.endpoint, "0".repeat(64), 0)).rejects.toThrow(/did not prove it is this lane's holder/);
    await expect(HolderLink.connect(h.endpoint, h.token, 10_000_000)).rejects.toThrow(/not kept/);
    await h.link.kill();
  }, TIMEOUT);

  test("the holder proves itself with the engine's proof function, and refuses a client that cannot prove the token", async () => {
    const pool = holderFolder();
    const h = await pool.launch("lane-0a0e0c0d", "bun", [FAKE], temp("ws"), { ...process.env });
    const nonce = randomBytes(16).toString("hex");
    // A client from before handshake v2 sends the token in clear: refused at once, and nothing is echoed.
    const v1 = await exchange(h.endpoint, { v: 1, token: h.token, from: 0 });
    expect(v1).toEqual([{ v: 2, ok: false, error: expect.stringContaining("handshake v2") }]);
    // A client that cannot prove the token gets the challenge (the holder's proof over its nonce), never a hello.
    const guessed = await exchange(h.endpoint, { v: 2, nonce }, () => ({ v: 2, proof: "0".repeat(64), from: 0 }));
    expect(guessed[0]).toEqual({ v: 2, nonce: expect.stringMatching(/^[0-9a-f]{32}$/), proof: holderProof(h.token, "holder", nonce) });
    expect(guessed[1]).toEqual({ v: 2, ok: false, error: "refused" });
    // Nor can it hand the holder's own proof back as its own.
    const reflected = await exchange(h.endpoint, { v: 2, nonce }, (c) => ({ v: 2, proof: c.proof, from: 0 }));
    expect(reflected[1]).toEqual({ v: 2, ok: false, error: "refused" });
    await h.link.kill();
  }, TIMEOUT);

  test("a client that falls behind is cut off on both halves and comes back from its offset with every byte", async () => {
    const pool = holderFolder();
    const total = 24 * 1024 * 1024;
    // 24 MiB of output at once, three times the most the holder queues for one client. The agent writes only once
    // the go file exists, which is after launch() returned with the client attached: output that reached the spool
    // before the attach would be streamed as the replay snapshot, which no queue counts, so nothing would be cut.
    const go = join(temp("go"), "go");
    const script =
      "const fs = require('node:fs'); const t = setInterval(() => { if (!fs.existsSync(process.env.LUCID_TEST_GO)) return; clearInterval(t); " +
      "const b = Buffer.alloc(1 << 20, 120); for (let i = 0; i < 24; i++) process.stdout.write(b); setInterval(() => {}, 1000); }, 20);";
    const h = await pool.launch("lane-0f0e0d0c", "bun", ["-e", script], temp("ws"), { ...process.env, LUCID_TEST_GO: go });
    writeFileSync(go, "");
    const spool = join(pool.dir, `${h.holderId}.spool`);
    // The link is not resumed yet: its frames wait in the socket, so the holder's queue for it fills.
    await until(() => statSync(spool, { throwIfNoEntry: false })?.size === total, "the agent's output to reach the spool", 1200);
    const closed = Promise.withResolvers<void>();
    h.link.onClose = () => closed.resolve();
    h.link.resume();
    // Before the fix only the queue was dropped: the connection stayed open and this client waited forever.
    expect(await Promise.race([closed.promise.then(() => true), Bun.sleep(20_000).then(() => false)])).toBe(true);
    expect(h.link.offset).toBeLessThan(total);
    const again = await h.link.reconnect(h.link.offset);
    let more = 0;
    again.onStdout = (chunk) => { more += chunk.length; };
    again.resume();
    await until(() => h.link.offset + more >= total, "the rest of the output to replay", 1200);
    expect(h.link.offset + more).toBe(total);
    expect(await again.kill()).toBe(true);
  }, TIMEOUT);

  test("kill() on a link the holder already closed sends the KILL on a new connection; with no holder left it is not confirmed", async () => {
    const pool = holderFolder();
    const h = await pool.launch("lane-0e0d0c0b", "bun", [FAKE], temp("ws"), { ...process.env });
    h.link.resume();
    h.link.detach();
    await h.link.closedPromise;
    expect(await h.link.kill()).toBe(true);
    await until(() => !alive(h.pid) && !alive(h.childPid), "the holder and the agent to end");
    expect(await h.link.kill()).toBe(false); // nothing confirmed it: the caller keeps the record
  }, TIMEOUT);

  test("a held lane whose holder is alive but does not answer keeps its record, and is never started over it", async () => {
    const pool = holderFolder();
    const a = engine(pool);
    const id = (await a.spawn({ cwd: temp("ws") })).lane!.id;
    const rec = pool.all()[0]!;
    a.stopAll();
    const b = engine(pool);
    // The holder runs, but cannot prove a token it never had: to this engine it did not answer.
    const r = await b.reattach({ ...rec, token: "f".repeat(64) });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("its record is kept");
    expect(pool.all().map((x) => x.laneId)).toEqual([id]);
    expect(b.unreachedHolder(id)).toContain("did not prove");
    const s = await b.spawn({ cwd: rec.cwd, id });
    expect([s.ok, s.reason]).toEqual([false, expect.stringContaining("not started again over it")]);
    expect(alive(rec.childPid)).toBe(true);
    // The true record reaches it: the lane comes back, and its id is free again.
    expect((await b.reattach(rec)).ok).toBe(true);
    expect(b.unreachedHolder(id)).toBeNull();
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
    const base = { v: 1 as const, laneId: "lane-0d0e0f0a", holderId: h.holderId, endpoint: h.endpoint, token: h.token, pid: h.pid, childPid: h.childPid, start: h.start, childStart: h.childStart, channel: h.channel, name: "n", cwd: ".", model: "m", sessionId: null, canLoadSession: false, turns: 0, transcript: [], supervised: false, autoApprove: false, remote: null, hubSessionId: null, createdAt: 0, consumed: 0, lastRequestId: 0, inFlight: null };
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

  test("LH-03: the lane's channel survives its engine; the next engine accepts it only once it reattached the lane", async () => {
    const pool = holderFolder();
    const a = engine(pool);
    const id = (await a.spawn({ cwd: temp("ws") })).lane!.id;
    const rec = pool.all()[0]!;
    expect(pool.channels.knows(id, rec.channel)).toBe(true);
    a.stopAll(); // engine A goes away; the agent keeps the channel it was started with
    const later = new HolderPool(pool.dir, BIN!); // engine B: same data root, nothing in memory
    pools.push(later);
    expect(later.channels.knows(id, rec.channel)).toBe(false);
    expect((await engine(later).reattach(later.all()[0]!)).ok).toBe(true);
    expect(later.channels.knows(id, rec.channel)).toBe(true);
  }, TIMEOUT);

  test.skipIf(process.platform !== "linux")("LH-06: the attach token is in neither the holder's nor the agent's environment", async () => {
    const pool = holderFolder();
    const h = await pool.launch("lane-0b0c0d0e", "bun", [FAKE], temp("ws"), { ...process.env });
    const environ = (pid: number) => readFileSync(`/proc/${pid}/environ`, "utf8");
    expect(environ(h.pid)).not.toContain(h.token);
    expect(environ(h.childPid)).not.toContain(h.token);
    expect(environ(h.childPid)).toContain(`${CHANNEL_ENV}=${h.channel}`);
    await h.link.kill();
  }, TIMEOUT);
});

describe("LH-07: the last-resort kill signals only the processes the holder reported", () => {
  const id = { pid: 400, childPid: 500, start: "s-400", childStart: "s-500" };
  /** What was signalled, and whether the holder counts as gone (its record may go). `exists`: the live pids. */
  const run = (platform: NodeJS.Platform, starts: Record<number, string | null>, exists: number[] = [], who = id) => {
    const sent: [number, string][] = [];
    const gone = endHolderProcess(who, { platform, startOf: (pid) => starts[pid] ?? null, kill: (pid, sig) => { sent.push([pid, sig]); }, exists: (pid) => exists.includes(pid) });
    return { sent, gone };
  };

  test("same identities: the agent's group first (while the holder pins it), then the holder", () => {
    expect(run("linux", { 400: "s-400", 500: "s-500" })).toEqual({ sent: [[-500, "SIGKILL"], [400, "SIGKILL"]], gone: true });
  });

  test("a pid that now names another process (another start time) or no process is left alone", () => {
    expect(run("linux", { 400: "s-400", 500: "reused" })).toEqual({ sent: [[400, "SIGKILL"]], gone: true });
    expect(run("darwin", { 400: "reused", 500: null }, [400, 500])).toEqual({ sent: [], gone: true }); // another process has the pid
  });

  test("an identity never sampled is never trusted, and a live pid then keeps the record", () => {
    const unsampled = { ...id, start: null, childStart: null };
    expect(run("linux", {}, [400], unsampled)).toEqual({ sent: [], gone: false });
    expect(run("linux", {}, [], unsampled)).toEqual({ sent: [], gone: true });
  });

  test("Windows ends the holder only while its pid has the creation time recorded at spawn; no group is signalled", () => {
    expect(run("win32", { 400: "s-400", 500: "s-500" })).toEqual({ sent: [[400, "SIGKILL"]], gone: true });
    // The holder died and Windows gave its pid to another process: nothing is sent, the holder is gone.
    expect(run("win32", { 400: "another" }, [400])).toEqual({ sent: [], gone: true });
    // A pid whose creation time cannot be read while something runs under it: nothing is sent, the record stays.
    expect(run("win32", {}, [400])).toEqual({ sent: [], gone: false });
    expect(run("win32", { 400: "s-400" }, [400], { ...id, start: null })).toEqual({ sent: [], gone: false });
  });

  test("a holder is alive only while its pid names the recorded process", () => {
    const deps = (now: string | null, exists: boolean) => ({ startOf: () => now, exists: () => exists });
    expect(holderProcessAlive(400, "s-400", deps("s-400", true))).toBe(true);
    expect(holderProcessAlive(400, "s-400", deps("reused", true))).toBe(false);
    expect(holderProcessAlive(400, "s-400", deps(null, true))).toBe(true); // cannot tell: the record is kept
    expect(holderProcessAlive(400, "s-400", deps(null, false))).toBe(false);
    expect(holderProcessAlive(400, null, deps("x", true))).toBe(true);
    expect(holderProcessAlive(0, "s-400", deps("s-400", true))).toBe(false);
  });

  test.skipIf(!["linux", "darwin", "win32"].includes(process.platform))("a live process reads the same identity twice; an ended one has none", async () => {
    expect(processStartId(process.pid)).not.toBeNull();
    expect(processStartId(process.pid)).toBe(processStartId(process.pid));
    const p = Bun.spawn(["bun", "-e", ""], { stdout: "ignore", stderr: "ignore" });
    await p.exited;
    expect(processStartId(p.pid)).toBeNull();
  });
});

describe("handshake v2: whoever answers on the endpoint must prove it holds the token", () => {
  const token = "7".repeat(64);

  test("a squatter that answers ok, or a challenge it cannot prove, is refused and learns nothing", async () => {
    const answers: ((line: Record<string, unknown>) => object)[] = [
      () => ({ v: 2, ok: true, base: 0, end: 0, pid: 1, childPid: 2, exited: null, from: 0 }), // trust me
      () => ({ v: 2, nonce: randomBytes(16).toString("hex"), proof: "0".repeat(64) }), // a guess
      (line) => ({ v: 2, nonce: line.nonce, proof: holderProof("8".repeat(64), "holder", String(line.nonce)) }), // another token
    ];
    for (const answer of answers) {
      const squat = await fakeHolder((line, sock) => { sock.write(`${JSON.stringify(answer(line))}\n`); });
      try {
        await expect(HolderLink.connect(squat.endpoint, token, 0)).rejects.toThrow(/did not prove it is this lane's holder/);
        expect(squat.seen()).not.toContain(token);
        // The engine sent one line, its nonce, and nothing else: no proof of its own, no offset, nothing of the user's.
        expect(squat.seen().trim().split("\n").map((l) => Object.keys(JSON.parse(l)).sort())).toEqual([["nonce", "v"]]);
      } finally { squat.close(); }
    }
  });

  test("an old holder (handshake v1) is refused by name", async () => {
    const old = await fakeHolder((_line, sock) => { sock.write(`${JSON.stringify({ v: 1, ok: false, error: "refused" })}\n`); });
    try {
      await expect(HolderLink.connect(old.endpoint, token, 0)).rejects.toThrow(/holder refused the attach: it speaks handshake v1 and this engine v2/);
      expect(old.seen()).not.toContain(token);
    } finally { old.close(); }
  });

  test("a frame longer than any the holder sends closes the link instead of being buffered", async () => {
    let theirs = "";
    const ours = randomBytes(16).toString("hex");
    let proved = false;
    const holder = await fakeHolder((line, sock) => {
      if (typeof line.nonce === "string") { theirs = line.nonce; sock.write(`${JSON.stringify({ v: 2, nonce: ours, proof: holderProof(token, "holder", theirs) })}\n`); return; }
      proved = line.proof === holderProof(token, "engine", ours);
      sock.write(`${JSON.stringify({ v: 2, ok: true, base: 0, end: 0, pid: 1, childPid: 2, exited: null, from: 0 })}\n`);
      const head = Buffer.alloc(5);
      head[0] = 0x4f;
      head.writeUInt32LE(MAX_FRAME + 1, 1);
      sock.write(Buffer.concat([head, Buffer.alloc(64 * 1024, 120)]));
    });
    try {
      const link = await HolderLink.connect(holder.endpoint, token, 0);
      expect(proved).toBe(true); // the engine proved itself over the holder's nonce, once the holder had proved itself
      expect(holder.seen()).not.toContain(token);
      const closed = Promise.withResolvers<void>();
      link.onClose = () => closed.resolve();
      link.resume();
      await closed.promise;
      expect([link.closed, link.offset]).toEqual([true, 0]);
    } finally { holder.close(); }
  });

  test.skipIf(process.platform === "win32")("a socket in a folder that is not this account's 0700 folder is not connected to", async () => {
    const shared = join(temp("open"), "shared");
    mkdirSync(shared);
    chmodSync(shared, 0o755);
    const endpoint = join(shared, "s.sock");
    let accepted = false;
    const server = createServer(() => { accepted = true; });
    const listening = Promise.withResolvers<void>();
    server.listen(endpoint, () => listening.resolve());
    await listening.promise;
    try {
      expect(socketFolderProblem(endpoint)).toContain("is not a 0700 folder of this account");
      await expect(HolderLink.connect(endpoint, token, 0)).rejects.toThrow(/is not a 0700 folder of this account/);
      expect(accepted).toBe(false);
      chmodSync(shared, 0o700);
      expect(socketFolderProblem(endpoint)).toBeNull();
      expect(socketFolderProblem(endpoint, "linux", (process.getuid?.() ?? 0) + 1)).toContain("is not a 0700 folder of this account");
    } finally { server.close(); }
  });

  test("Windows pipes are answered through the proof alone", () => {
    expect(socketFolderProblem(String.raw`\\.\pipe\lucid-holder-x`, "win32")).toBeNull();
  });
});

describe("a held connection the holder drops", () => {
  const line = `${JSON.stringify({ jsonrpc: "2.0", method: "x" })}\n`;
  const handled = Buffer.byteLength(line);

  test("the client attaches again from the last handled line, and what it sent meanwhile goes to the new connection", async () => {
    const client = new ACPClient("x", [], ".");
    let exits = 0;
    client.onExit = () => { exits++; };
    const second = fakeIO(handled, async () => { throw new Error("not again"); });
    const asked: number[] = [];
    const gate = Promise.withResolvers<void>();
    const first = fakeIO(0, async (from) => { asked.push(from); await gate.promise; return second; });
    client.attachHeld(first);
    first.onStdout(Buffer.from(`${line}{"partial`), handled + 9);
    first.onClose();
    client.notify("session/cancel", { sessionId: "s" }); // while the new connection is being made
    expect(first.sent).toEqual([]);
    gate.resolve();
    await until(() => second.sent.length === 1, "the queued notification to reach the new connection");
    expect(asked).toEqual([handled]); // the partial line is replayed whole, never handled twice
    expect(second.sent[0]).toContain("session/cancel");
    expect(client.consumedOffset).toBe(handled);
    expect([client.isDead, exits]).toEqual([false, 0]);
  });

  test("a reconnect that fails, or a connection that closes again with nothing handled since, ends the client", async () => {
    const failing = new ACPClient("x", [], ".");
    let exits = 0;
    failing.onExit = () => { exits++; };
    const lost = fakeIO(0, async () => { throw new Error("the holder is gone"); });
    failing.attachHeld(lost);
    lost.onClose();
    await until(() => failing.isDead, "the client to end");
    expect(exits).toBe(1);

    const looping = new ACPClient("x", [], ".");
    let ended = 0;
    looping.onExit = () => { ended++; };
    const again = fakeIO(0, async () => { throw new Error("never asked"); });
    let wired = false;
    again.resume = () => { wired = true; };
    const first = fakeIO(0, async () => again);
    looping.attachHeld(first);
    first.onClose();
    await until(() => wired, "the new connection to be wired");
    again.onClose(); // closed again before anything new was handled: no third connection
    await until(() => looping.isDead, "the client to end");
    expect(ended).toBe(1);
  });
});

// The suite above skips without a holder binary; a gate that skipped silently would pass with the feature broken.
test.skipIf(!!BIN || !process.env.CI)("CI builds the holder before the tests", () => {
  throw new Error("lucid-holder is not built: run `bun run build-holder` in desktop/ (needs Rust), or set LUCID_HOLDER_BIN");
});
