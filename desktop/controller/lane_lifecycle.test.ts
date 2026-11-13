// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/controller/lane_lifecycle.test.ts - ADR-0500/0501/0502. The REAL lane manager and the REAL controller
// routes over the fake ACP agent (a real subprocess per lane) and real git. What must hold:
//   - close denies a parked ask and cancels the turn before the lane goes, and the freed slot takes a new lane;
//   - an engine that dies mid-turn gives the lane back after the restart: same lane id, same omp session, idle,
//     the cut-off turn reported interrupted and never re-run; a follow-up continues that session;
//   - a pairing revoked before the restart gets nothing back, and its review branch survives;
//   - a remote lane in a git workspace runs in its own worktree on `remote/<lane id>`, the tier policy's boundary
//     is that worktree, and close commits what is left onto the branch, removes the worktree and keeps the branch.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { GateDecision } from "../../harness/security/gate.ts";
import { gitExe } from "../../harness/runs/sandbox_exec.ts";
import type { TelemetryEvent } from "../../harness/telemetry/events.ts";
import { FleetLaneManager } from "../fleet_lanes.ts";
import { HolderLink, HolderPool, holderBinary } from "../lane_holder.ts";
import type { SystemSnapshot } from "../system_profile.ts";
import { ControllerLaneStore } from "./lane_store.ts";
import { handleController, INTERRUPTED_NOTE, restoreControllerLanes, RESTORING_ERROR, type ControllerDeps } from "./routes.ts";
import { PairingStore, type Pairing } from "./store.ts";

const FAKE = join(import.meta.dir, "..", "..", "harness", "mcp", "testing", "fake_acp_agent.ts");
const TIMEOUT = 60_000;
const healthy: SystemSnapshot = { cpuModel: "t", cores: 8, speedMHz: 4000, cpuBusyPct: 10, memTotalMB: 16_000, memFreeMB: 12_000 };
const CLEAN: GateDecision = { block: false, reason: "clean", trustLabel: "trusted", findings: [], failClosed: false };
const ALLOWED = `"optionId":"allow"`;
const CANCELLED = `"outcome":"cancelled"`;
const ROOT = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ type: "spki", format: "der" }).toString("base64url");

// A temp folder must read as "not a git repository" even when a parent of the temp dir is one (a home-directory
// dotfiles repo): git stops looking at the temp dir.
const ceiling = process.env.GIT_CEILING_DIRECTORIES;
process.env.GIT_CEILING_DIRECTORIES = realpathSync.native(tmpdir());
const temps: string[] = [];
const temp = (tag: string) => { const d = mkdtempSync(join(tmpdir(), `lucid-lanes-${tag}-`)); temps.push(d); return d; };
const fleets: FleetLaneManager[] = [];
afterEach(() => { for (const f of fleets.splice(0)) f.stopAll(); });
afterAll(() => {
  if (ceiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = ceiling;
  // a lane's agent can still hold its cwd open on Windows; the OS temp cleaner takes what is left
  for (const d of temps) { try { rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* still held */ } }
});

function git(dir: string, ...args: string[]): { ok: boolean; out: string } {
  const p = Bun.spawnSync([gitExe(), "-c", "safe.directory=*", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  return { ok: p.exitCode === 0, out: p.stdout.toString().trim() };
}

/** A repository with one commit, in a folder of its own (the review worktrees go beside it). */
function newRepo(): string {
  const repo = join(temp("repo"), "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
  expect(git(repo, "init", "-q").ok).toBe(true);
  git(repo, "add", "-A");
  expect(git(repo, "-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init").ok).toBe(true);
  return realpathSync.native(repo);
}

/** The lanes are real agent subprocesses and the routes run their turns detached, so there is no promise to
 *  await: poll the observable condition (a turn ended, an ask parked, a folder went), never a guessed delay. */
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) { if (cond()) return; await Bun.sleep(25); }
  throw new Error(`timed out waiting for ${what}`);
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** End every holder a pool still has records for, so nothing outlives the test. */
async function endHolders(pool: HolderPool): Promise<void> {
  for (const rec of pool.all()) { try { await (await HolderLink.connect(rec.endpoint, rec.token, rec.inFlight?.offset ?? rec.consumed)).kill(); } catch { /* gone */ } }
}

type Json = { ok?: boolean; error?: string; data?: Record<string, unknown> };

/** One engine: its own data root (the pairing and lane stores), lane manager and routes. `tag` makes the session
 *  ids its agents mint its own (the fake agent tags them with LUCID_INTERJECT_TARGET), so a session that crossed a
 *  restart is told apart from a fresh one. */
function engine(dataDir: string, opts: { loadSession?: boolean; tag?: string; holders?: HolderPool } = {}) {
  const events: TelemetryEvent[] = [];
  const fleet = new FleetLaneManager({
    argv: () => ({ cmd: "bun", args: [FAKE] }), masterModel: () => "m", sample: async () => healthy,
    env: () => ({ LUCID_INTERJECT_TARGET: `lane-${opts.tag ?? "x"}`, ...(opts.loadSession ? { FAKE_ACP_LOAD_SESSION: "1" } : {}) }),
    ...(opts.holders ? { holders: opts.holders } : {}),
  });
  fleets.push(fleet);
  const store = new PairingStore(join(dataDir, "controller-pairings.json"));
  const deps: ControllerDeps = { store, lanes: new ControllerLaneStore(join(dataDir, "controller-lanes.json")), fleet, scan: async () => CLEAN, sink: (e) => events.push(e) };
  const call = async (path: string, pairing: Pairing | null, body?: unknown, query = "") => {
    const req = new Request(`http://127.0.0.1/api/controller/${path}${query}`, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) });
    const res = await handleController(req, `/api/controller/${path}`, pairing, deps);
    const text = await res.text();
    return { status: res.status, json: (res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : {}) as Json };
  };
  const pairRemote = async (workspace: string) => {
    const p = await call("pair", null, { name: "spoke", workspace, approverRoot: ROOT, approvalHours: "1", offTask: "off" });
    expect(p.status).toBe(200);
    const token = String(p.json.data!.token);
    return { token, pairing: (await store.verify(token))! };
  };
  const spawn = async (pairing: Pairing) => {
    const s = await call("spawn", pairing, { name: "remote" });
    expect(s.status).toBe(200);
    return s.json.data!.lane as { id: string; reviewBranch?: string };
  };
  const view = async (laneId: string) => (await fleet.status()).lanes.find((l) => l.id === laneId);
  /** Wait for the turn to end AND for the route to record it (the in-flight mark gone). */
  const settled = async (laneId: string) => {
    await until(() => fleet.laneRunning(laneId) !== true, "the turn to end");
    await until(() => !deps.lanes.get(laneId)?.inFlight, "the turn to be recorded");
    return fleet.laneTranscript(laneId).filter((t) => t.role === "assistant").at(-1)?.text ?? "";
  };
  const rulings = () => events.filter((e) => e.event === "controller_ruling");
  return { fleet, store, deps, events, rulings, call, pairRemote, spawn, view, settled };
}

describe("ADR-0500: close", () => {
  test("denies a parked ask and cancels the turn first, then frees the slot; a non-git workspace runs in place", async () => {
    const ws = realpathSync(temp("ws"));
    const e = engine(temp("data"));
    const { pairing } = await e.pairRemote(ws);
    const one = await e.spawn(pairing);
    const two = await e.spawn(pairing);
    expect((await e.call("spawn", pairing, {})).status).toBe(429);
    // not a git repository: the lane works in the workspace itself and reports no review branch
    expect((await e.view(two.id))?.cwd).toBe(pairing.workspace);
    expect(two).not.toHaveProperty("reviewBranch");

    expect((await e.call("prompt", pairing, { laneId: one.id, text: `go [ask ${JSON.stringify({ kind: "fetch", title: "fetch https://x", rawInput: { url: "https://x" } })}]` })).status).toBe(202);
    await until(() => e.fleet.pendingAsk(one.id) !== null, "the fetch to park");
    const ask = e.fleet.pendingAsk(one.id)!;
    const closed = await e.call("close", pairing, { laneId: one.id });
    expect(closed.status).toBe(200);
    expect(closed.json.data).toEqual({ closed: one.id, cancelledTurn: true, deniedAsk: ask.id });
    expect(e.fleet.laneRunning(one.id)).toBeNull();
    // audit before effect: the deny, then the close
    expect(e.rulings().filter((r) => r.lane_id === one.id).map((r) => [r.ruling, r.reason])).toEqual([
      ["controller_denied", "the lane was closed"],
      ["lane_closed", "its running turn was cancelled"],
    ]);
    // the slot is free again, and the closed lane is not-found like any foreign lane
    expect((await e.call("status", pairing, undefined, `?laneId=${one.id}`)).status).toBe(404);
    const three = await e.spawn(pairing);
    expect((await e.call("lanes", pairing)).json.data!.lanes).toEqual([expect.objectContaining({ id: two.id }), expect.objectContaining({ id: three.id })]);
  }, TIMEOUT);
});

describe("ADR-0502: a remote lane's review worktree", () => {
  test("the lane runs on remote/<lane>, the boundary is the worktree, and close keeps the branch", async () => {
    const repo = newRepo();
    const e = engine(temp("data"));
    const { pairing } = await e.pairRemote(repo);
    const lane = await e.spawn(pairing);
    expect(lane.reviewBranch).toBe(`remote/${lane.id}`);
    const cwd = (await e.view(lane.id))!.cwd;
    expect(basename(cwd)).toBe(`remote-${lane.id}`);
    expect(git(cwd, "rev-parse", "--abbrev-ref", "HEAD").out).toBe(`remote/${lane.id}`);

    // the tier policy follows the worktree: an edit in it runs on its own, an edit to the original is outside
    const edit = async (path: string) => {
      expect((await e.call("prompt", pairing, { laneId: lane.id, text: `go [ask ${JSON.stringify({ kind: "edit", title: "edit", rawInput: { path } })}]` })).status).toBe(202);
      return e.settled(lane.id);
    };
    expect(await edit(join(cwd, "src", "a.ts"))).toContain(ALLOWED);
    expect(await edit(join(repo, "src", "a.ts"))).toContain(CANCELLED);

    // what the lane left in its worktree
    writeFileSync(join(cwd, "src", "a.ts"), "export const a = 2;\n");
    writeFileSync(join(cwd, "NOTES.md"), "lane work\n");
    const closed = await e.call("close", pairing, { laneId: lane.id });
    expect(closed.status).toBe(200);
    expect(closed.json.data).toMatchObject({ closed: lane.id, reviewBranch: `remote/${lane.id}`, commit: expect.stringMatching(/^[0-9a-f]{40}$/) });
    expect(closed.json.data).not.toHaveProperty("worktreeKept");
    await until(() => !existsSync(cwd), "the worktree folder to go");
    expect(git(repo, "worktree", "list").out).not.toContain(`remote-${lane.id}`);
    // the branch keeps everything, as one engine-authored snapshot commit on top of the base
    expect(git(repo, "show", `remote/${lane.id}:NOTES.md`).out).toBe("lane work");
    expect(git(repo, "show", `remote/${lane.id}:src/a.ts`).out).toBe("export const a = 2;");
    expect(git(repo, "log", "-1", "--format=%an", `remote/${lane.id}`).out).toBe("LUCID remote lane");
    // the originals are untouched
    expect(readFileSync(join(repo, "src", "a.ts"), "utf8")).toBe("export const a = 1;\n");
    expect(git(repo, "status", "--porcelain").out).toBe("");
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD").out).not.toBe(`remote/${lane.id}`);
  }, TIMEOUT);
});

describe("ADR-0501: lanes survive an engine restart", () => {
  /** Engine A runs a lane in a git workspace, settles one turn, starts a long one and dies: engine B boots from
   *  the files exactly as A left them. */
  async function diedMidTurn(opts: { loadSession: boolean }) {
    const repo = newRepo();
    const dataA = temp("data-a"), dataB = temp("data-b");
    const a = engine(dataA, { ...opts, tag: "a" });
    const { token, pairing } = await a.pairRemote(repo);
    const lane = await a.spawn(pairing);
    expect((await a.call("prompt", pairing, { laneId: lane.id, text: "hello" })).status).toBe(202);
    expect(await a.settled(lane.id)).toContain("You said:");
    const before = (await a.view(lane.id))!;
    writeFileSync(join(before.cwd, "NOTES.md"), "lane work\n");
    // Five seconds: far longer than the copy below takes, and short enough that the fallback test's follow-up (whose
    // recovery preamble repeats this text, marker included, so the fake agent waits again) still settles.
    expect((await a.call("prompt", pairing, { laneId: lane.id, text: "a long task [slow 5s]" })).status).toBe(202);
    expect(a.deps.lanes.get(lane.id)?.inFlight).toBeDefined();
    for (const f of ["controller-pairings.json", "controller-lanes.json"]) copyFileSync(join(dataA, f), join(dataB, f));
    a.fleet.stopAll();
    return { repo, token, laneId: lane.id, before, b: engine(dataB, { ...opts, tag: "b" }) };
  }

  /** The same under a holder: A's lane is mid-turn when A lets go, and its agent runs on. `bootB` starts engine B
   *  from A's files (a test may change them first) and, as dev.ts does, takes the held lanes back before anything. */
  async function heldDiedMidTurn() {
    const repo = newRepo();
    const pool = new HolderPool(join(temp("holders"), "lane-holders"), holderBinary()!);
    const dataA = temp("data-a"), dataB = temp("data-b");
    const a = engine(dataA, { loadSession: true, tag: "a", holders: pool });
    const { token, pairing } = await a.pairRemote(repo);
    const lane = await a.spawn(pairing);
    const before = (await a.view(lane.id))!;
    writeFileSync(join(before.cwd, "NOTES.md"), "lane work\n");
    expect((await a.call("prompt", pairing, { laneId: lane.id, text: "a long task [slow 30s]" })).status).toBe(202);
    await until(() => !!pool.all()[0]?.inFlight, "the turn to be recorded in flight");
    for (const f of ["controller-pairings.json", "controller-lanes.json"]) copyFileSync(join(dataA, f), join(dataB, f));
    a.fleet.stopAll();
    const rec = pool.all()[0]!;
    const bootB = async (reattach = true) => {
      const b = engine(dataB, { loadSession: true, tag: "b", holders: pool });
      if (reattach) for (const r of pool.all()) expect((await b.fleet.reattach(r)).ok).toBe(true);
      return b;
    };
    return { repo, token, pool, dataB, laneId: lane.id, before, rec, bootB };
  }

  test("the lane comes back idle on its id and session; the cut-off turn is interrupted, not re-run; a follow-up continues", async () => {
    const { token, laneId, before, b } = await diedMidTurn({ loadSession: true });
    expect(await restoreControllerLanes(b.deps)).toEqual([laneId]);
    const pairing = (await b.store.verify(token))!;
    const listed = (await b.call("lanes", pairing)).json.data!.lanes as Record<string, unknown>[];
    expect(listed).toEqual([{ id: laneId, name: "remote", status: "awaiting-input", turns: 1, reviewBranch: `remote/${laneId}`, interrupted: expect.any(String) }]);
    const after = (await b.view(laneId))!;
    expect([after.sessionId, after.cwd]).toEqual([before.sessionId, before.cwd]);
    expect(b.fleet.laneRunning(laneId)).toBe(false); // nothing re-ran the long turn
    const result = (await b.call("result", pairing, undefined, `?laneId=${laneId}&since=0`)).json.data!;
    expect(result.running).toBe(false);
    expect((result.turns as { index: number; text: string }[]).map((t) => [t.index, t.text])).toEqual([[1, expect.stringContaining("You said:")], [3, INTERRUPTED_NOTE]]);
    expect(b.rulings()).toEqual([expect.objectContaining({ ruling: "lane_restored", lane_id: laneId, reason: "a running turn was interrupted" })]);

    // the follow-up runs in the SAME omp session, in the new engine's process
    expect((await b.call("prompt", pairing, { laneId, text: "carry on" })).status).toBe(202);
    const reply = await b.settled(laneId);
    expect(reply).toContain("carry on");
    expect(reply).toContain(`[session ${before.sessionId}]`);
    expect(reply).not.toContain("[slow");
    expect(((await b.call("lanes", pairing)).json.data!.lanes as Record<string, unknown>[])[0]).not.toHaveProperty("interrupted");
    // the cap counts the restored lane
    expect((await b.call("spawn", pairing, {})).status).toBe(200);
    expect((await b.call("spawn", pairing, {})).status).toBe(429);
  }, TIMEOUT);

  // P-HOLDER.1 (ADR-0534): with a holder the same restart interrupts nothing: the turn carries on and records itself.
  test.skipIf(!holderBinary())("under a holder, the turn in flight carries on after the restart and records itself", async () => {
    const repo = newRepo();
    const pool = new HolderPool(join(temp("holders"), "lane-holders"), holderBinary()!);
    const dataA = temp("data-a"), dataB = temp("data-b");
    const a = engine(dataA, { loadSession: true, tag: "a", holders: pool });
    const { token, pairing } = await a.pairRemote(repo);
    const lane = await a.spawn(pairing);
    expect((await a.call("prompt", pairing, { laneId: lane.id, text: "a long task [slow 3s]" })).status).toBe(202);
    await (async () => { for (let i = 0; i < 400 && !pool.all()[0]?.inFlight; i++) await Bun.sleep(25); })();
    for (const f of ["controller-pairings.json", "controller-lanes.json"]) copyFileSync(join(dataA, f), join(dataB, f));
    a.fleet.stopAll();

    const b = engine(dataB, { loadSession: true, tag: "b", holders: pool });
    try {
      // As dev.ts does: the held lanes come back first, then the controller restore finds them running.
      for (const rec of pool.all()) expect((await b.fleet.reattach(rec)).ok).toBe(true);
      expect(await restoreControllerLanes(b.deps)).toEqual([lane.id]);
      expect(b.rulings()).toEqual([expect.objectContaining({ ruling: "lane_restored", lane_id: lane.id, reason: "reattached to its running agent; the turn carries on" })]);
      const reply = await b.settled(lane.id);
      expect(reply).toContain("a long task [slow 3s]");
      expect(reply).toContain("[session fake-session-lane-a-1]"); // answered by engine A's agent process, not a new one
      expect(reply).not.toContain(INTERRUPTED_NOTE);
      const p = (await b.store.verify(token))!;
      expect(((await b.call("lanes", p)).json.data!.lanes as Record<string, unknown>[])[0]).not.toHaveProperty("interrupted");
    } finally {
      await endHolders(pool);
    }
  }, TIMEOUT);

  test("a controller that lists lanes while the restore is still running gets the full set, never a half list", async () => {
    const { token, laneId, b } = await diedMidTurn({ loadSession: true });
    const pairing = (await b.store.verify(token))!;
    // As dev.ts does: the gate is shut before anything can ask, and the restore starts later (here: on release).
    const start = Promise.withResolvers<void>();
    const restore = start.promise.then(() => restoreControllerLanes(b.deps));
    b.deps.restoring = restore.finally(() => { b.deps.restoring = null; });
    // Both requests are in flight before the restore has spawned anything; without the gate they would answer
    // with no lanes and a 404, which is what made a live spoke mark its task stopped.
    const listing = b.call("lanes", pairing);
    const status = b.call("status", pairing, undefined, `?laneId=${laneId}`);
    start.resolve();
    const listed = await listing;
    expect(listed.status).toBe(200);
    expect((listed.json.data!.lanes as { id: string }[]).map((l) => l.id)).toEqual([laneId]);
    expect((await status).status).toBe(200);
    expect(await restore).toEqual([laneId]);
  }, TIMEOUT);

  test("a restore that outlasts the wait answers 503 restoring (every route), and the routes open when it ends", async () => {
    const e = engine(temp("data"));
    const { pairing } = await e.pairRemote(realpathSync(temp("ws")));
    const stuck = Promise.withResolvers<void>();
    e.deps.restoring = stuck.promise;
    // The production wait is RESTORE_WAIT_MS; a short one keeps this test from sitting on a real 15 s clock.
    e.deps.restoreWaitMs = 50;
    for (const [path, who] of [["lanes", pairing], ["spawn", pairing], ["lanes", null]] as const) {
      const r = await e.call(path, who, path === "spawn" ? {} : undefined);
      expect([r.status, r.json.error]).toEqual([503, RESTORING_ERROR]);
    }
    expect((await e.fleet.status()).lanes).toEqual([]); // the refused spawn started nothing
    stuck.resolve();
    e.deps.restoring = null;
    expect((await e.call("lanes", pairing)).status).toBe(200);
  }, TIMEOUT);

  test("without session/load the lane gets a fresh session that carries the recorded transcript", async () => {
    const { token, laneId, before, b } = await diedMidTurn({ loadSession: false });
    expect(await restoreControllerLanes(b.deps)).toEqual([laneId]);
    expect(before.sessionId).toStartWith("fake-session-lane-a-");
    expect((await b.view(laneId))!.sessionId).toStartWith("fake-session-lane-b-");
    const pairing = (await b.store.verify(token))!;
    expect((await b.call("prompt", pairing, { laneId, text: "carry on" })).status).toBe(202);
    // the fallback preamble rode the follow-up: the agent echoes the recorded conversation, interruption included
    const reply = await b.settled(laneId);
    expect(reply).toContain("[SESSION RECOVERY]");
    expect(reply).toContain(INTERRUPTED_NOTE);
  }, TIMEOUT);

  test("a pairing revoked before the restart gets nothing back, and its review branch keeps the work", async () => {
    const { repo, laneId, before, b } = await diedMidTurn({ loadSession: true });
    expect(b.store.unpair("spoke")).not.toBeNull();
    expect(await restoreControllerLanes(b.deps)).toEqual([]);
    expect((await b.fleet.status()).lanes).toEqual([]);
    expect(b.deps.lanes.all()).toEqual([]);
    await until(() => !existsSync(before.cwd), "the worktree folder to go");
    expect(git(repo, "show", `remote/${laneId}:NOTES.md`).out).toBe("lane work");
    expect(b.rulings()).toEqual([expect.objectContaining({ ruling: "lane_not_restored", lane_id: laneId, reason: "pairing revoked", branch: `remote/${laneId}` })]);
  }, TIMEOUT);

  test("a broken lane store restores nothing, touches nothing, and refuses new controller lanes", async () => {
    const data = temp("data");
    writeFileSync(join(data, "controller-lanes.json"), "{torn", { mode: 0o600 });
    const e = engine(data);
    const { pairing } = await e.pairRemote(realpathSync(temp("ws")));
    expect(await restoreControllerLanes(e.deps)).toEqual([]);
    const s = await e.call("spawn", pairing, {});
    expect([s.status, s.json.error]).toEqual([503, "controller lane store is malformed"]);
    expect(readFileSync(join(data, "controller-lanes.json"), "utf8")).toBe("{torn");
  }, TIMEOUT);

  // The held variants: the holder kept the agent running and the fleet took the lane back before the restore.
  test.skipIf(!holderBinary())("under a holder, a revoked pairing's lane is ended before it is retired, and its branch keeps the work", async () => {
    const { repo, pool, laneId, before, rec, bootB } = await heldDiedMidTurn();
    const b = await bootB();
    try {
      expect(b.fleet.laneRunning(laneId)).toBe(true); // its turn carries on under the holder
      expect(b.store.unpair("spoke")).not.toBeNull();
      expect(await restoreControllerLanes(b.deps)).toEqual([]);
      expect((await b.fleet.status()).lanes).toEqual([]);
      await until(() => !alive(rec.pid) && !alive(rec.childPid), "the holder and its agent to end");
      expect(pool.all()).toEqual([]);
      expect(b.deps.lanes.all()).toEqual([]);
      await until(() => !existsSync(before.cwd), "the worktree folder to go");
      expect(git(repo, "show", `remote/${laneId}:NOTES.md`).out).toBe("lane work");
      expect(b.rulings()).toEqual([expect.objectContaining({ ruling: "lane_not_restored", lane_id: laneId, reason: "pairing revoked", branch: `remote/${laneId}` })]);
    } finally {
      await endHolders(pool);
    }
  }, TIMEOUT);

  test.skipIf(!holderBinary())("under a holder, a broken lane store ends the controller lanes the holders brought back and touches no store", async () => {
    const { pool, dataB, rec, bootB } = await heldDiedMidTurn();
    writeFileSync(join(dataB, "controller-lanes.json"), "{torn", { mode: 0o600 });
    const b = await bootB();
    try {
      expect(await restoreControllerLanes(b.deps)).toEqual([]);
      expect((await b.fleet.status()).lanes).toEqual([]); // no supervised lane runs with no pairing to check it against
      await until(() => !alive(rec.pid) && !alive(rec.childPid), "the holder and its agent to end");
      expect(pool.all()).toEqual([]);
      expect(readFileSync(join(dataB, "controller-lanes.json"), "utf8")).toBe("{torn");
    } finally {
      await endHolders(pool);
    }
  }, TIMEOUT);

  test.skipIf(!holderBinary())("under a holder that is alive but does not answer, the lane is neither started again over it nor retired", async () => {
    const { token, pool, laneId, before, rec, bootB } = await heldDiedMidTurn();
    const b = await bootB(false);
    try {
      // The holder runs but cannot prove a token it never had: to this engine it did not answer.
      expect((await b.fleet.reattach({ ...rec, token: "f".repeat(64) })).ok).toBe(false);
      expect(await restoreControllerLanes(b.deps)).toEqual([]);
      expect((await b.fleet.status()).lanes).toEqual([]); // nothing was spawned over it
      expect(alive(rec.childPid)).toBe(true);
      expect(existsSync(before.cwd)).toBe(true); // its worktree is still in use, so it stays
      expect(b.deps.lanes.get(laneId)).toBeDefined(); // tried again at the next start
      expect(pool.all().map((r) => r.laneId)).toEqual([laneId]);
      expect((await b.store.verify(token))!.lanes).toContain(laneId); // its slot is kept
      expect(b.rulings()).toEqual([expect.objectContaining({ ruling: "lane_not_restored", lane_id: laneId, reason: expect.stringContaining("did not answer") })]);
    } finally {
      await endHolders(pool);
    }
  }, TIMEOUT);
});
