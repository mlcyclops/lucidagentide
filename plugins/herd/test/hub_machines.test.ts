// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Herd (ADR-0541; P-HERD.7, ADR-0496): machines. The ADR's proof list, against fake engines on
// loopback: the saved list is untrusted input (off-shape entries, the reserved name and SSH entries
// drop out); lane ids prefix as `<machine>/<lane>` with the default machine's prefix optional; each
// machine reconnects on its own backoff, keeping its last lanes dimmed while it is away; a discovery
// file whose engine fails the nonce handshake is never sent a token; `agent list` names every row's
// machine; and an agent verb reaches only the machine that owns the lane. No test sleeps: every step
// is a direct `tick` or an awaited verb.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoveryPath, writeDiscovery, type EngineDiscovery } from "../../../desktop/engine_discovery.ts";
import { HubOpError, Spaces } from "../../../harness/launcher/hub_spaces.ts";
import type { HubOp } from "../../../harness/launcher/hub_tmux_verbs.ts";
import { railLine, railRows } from "../../../harness/launcher/hub_tui.ts";
import {
  addMachine, BACKOFF_MS, connFail, connOk, DEFAULT_MACHINE, DOWN_AFTER, freshConn, laneRef, loadMachines, MACHINE_POLL_MS,
  MachineSet, machinesPath, nextDelay, parseMachines, removeMachine, routeAgentArgv, routeSpokesArgv, splitLaneRef,
  SPOKES_MACHINE, spokeTaskLanes, spokeTaskRef,
} from "../src/engines.ts";

interface FakeEngine { record: EngineDiscovery; seen: { path: string; token: string | null }[]; lanes: Record<string, unknown>[]; stop(): void }

const engines: FakeEngine[] = [];
let dir: string;

/** An engine on loopback with its own nonce and UI token. `answerNonce` lets it fail the handshake. */
function fakeEngine(opts: { lanes?: Record<string, unknown>[]; answerNonce?: string } = {}): FakeEngine {
  const nonce = crypto.randomUUID();
  const token = `token-${nonce}`;
  const seen: FakeEngine["seen"] = [];
  const lanes = opts.lanes ?? [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url);
      seen.push({ path: pathname, token: req.headers.get("x-lucid-token") });
      if (pathname === "/api/health") return Response.json({ ok: true, nonce: opts.answerNonce ?? nonce });
      if (req.headers.get("x-lucid-token") !== token) return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
      if (pathname === "/api/fleet/status") return Response.json({ ok: true, data: { lanes } });
      if (pathname === "/api/fleet/transcript") return Response.json({ ok: true, data: { turns: [{ role: "user", text: "hi" }] } });
      if (pathname === "/api/fleet/cancel") return Response.json({ ok: true, data: { cancelled: true } });
      if (pathname === "/api/workspace") return Response.json({ ok: true, data: { current: "/work/b" } });
      if (pathname === "/api/fleet/spawn") {
        const lane = { id: "lane_new", name: "fresh", status: "starting" };
        lanes.push(lane);
        return Response.json({ ok: true, data: { lane } });
      }
      return Response.json({ ok: true, data: {} });
    },
  });
  const e: FakeEngine = {
    record: { v: 1, pid: process.pid, port: server.port!, nonce, version: "9.9", flavor: "agent", startedAt: new Date().toISOString(), token },
    seen,
    lanes,
    stop: () => { void server.stop(true); },
  };
  engines.push(e);
  return e;
}

/** Put an engine's discovery file in a machine's folder (one folder per data root). */
function publish(e: FakeEngine, folder: string): string {
  const path = discoveryPath(folder, e.record.port);
  writeDiscovery(path, e.record);
  return path;
}

const local = (): EngineDiscovery => ({ v: 1, pid: process.pid, port: 1, nonce: "n", version: "9.9", flavor: "agent", startedAt: new Date().toISOString(), token: "local-token" });

/** The hub's own executor: records what reached it and answers agent.list with one lane. */
function localExec(log: HubOp[]): (op: HubOp) => Promise<unknown> {
  return async (op) => {
    log.push(op);
    if (op.op === "agent.list") return [{ id: "lane_a", name: "scout", status: "working" }];
    return { lane: "lane_a", op: op.op };
  };
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "herd-machines-")); });
afterEach(() => {
  for (const e of engines.splice(0)) e.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("the machine list is untrusted input", () => {
  test("off-shape entries, the reserved name, duplicates, relative folders and SSH entries drop out", () => {
    const raw = JSON.stringify({ v: 1, machines: [
      { name: "b", kind: "local", discoveryDir: join(dir, "b") },
      { name: "b", kind: "local", discoveryDir: join(dir, "b2") },
      { name: "local", kind: "local", discoveryDir: join(dir, "x") },
      { name: "Bad Name", kind: "local", discoveryDir: join(dir, "y") },
      { name: "rel", kind: "local", discoveryDir: "relative/dir" },
      { name: "far", kind: "ssh", host: "far.example" },
      "junk",
    ] });
    expect(parseMachines(raw)).toEqual([{ name: "b", kind: "local", discoveryDir: join(dir, "b") }]);
    expect(parseMachines("{not json")).toEqual([]);
    expect(parseMachines(JSON.stringify({ v: 2, machines: [] }))).toEqual([]);
  });

  test("add refuses a bad or reserved name, a duplicate and a relative folder; remove refuses an unknown name", () => {
    const one = addMachine([], "b", join(dir, "b"));
    const code = (f: () => unknown) => { try { f(); return "ok"; } catch (e) { return e instanceof HubOpError ? e.code : "?"; } };
    expect(code(() => addMachine(one, "local", join(dir, "x")))).toBe("bad_name");
    expect(code(() => addMachine(one, "../b", join(dir, "x")))).toBe("bad_name");
    expect(code(() => addMachine(one, "b", join(dir, "x")))).toBe("exists");
    expect(code(() => addMachine(one, "c", "relative"))).toBe("usage");
    expect(code(() => removeMachine(one, "nope"))).toBe("not_found");
    expect(removeMachine(one, "b")).toEqual([]);
  });

  test("machine add saves the list 0600 and a new MachineSet reads it back; --ssh and --profile are refused", () => {
    const path = machinesPath(dir, "main");
    const set = new MachineSet(path, local());
    expect(set.machineCommand(["machine", "add", "b", "--dir", join(dir, "b")])).toEqual({ added: "b", discoveryDir: join(dir, "b"), state: "down" });
    expect(loadMachines(path)).toEqual([{ name: "b", kind: "local", discoveryDir: join(dir, "b") }]);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(new MachineSet(path, local()).names()).toEqual([DEFAULT_MACHINE, "b"]);
    const code = (argv: string[]) => { try { set.machineCommand(argv); return "ok"; } catch (e) { return e instanceof HubOpError ? e.code : "?"; } };
    expect(code(["machine", "add", "far", "--ssh", "far.example"])).toBe("not_supported");
    expect(code(["machine", "add", "p", "--profile", "repo-a"])).toBe("not_supported");
  });
});

describe("lane ids on the control plane", () => {
  const known = ["local", "b"];

  test("a known machine prefix splits; the default prefix is optional; anything else stays on the default machine", () => {
    expect(splitLaneRef("b/lane_3", known)).toEqual({ machine: "b", lane: "lane_3" });
    expect(splitLaneRef("local/lane_3", known)).toEqual({ machine: "local", lane: "lane_3" });
    expect(splitLaneRef("lane_3", known)).toEqual({ machine: "local", lane: "lane_3" });
    expect(splitLaneRef("zz/lane_3", known)).toEqual({ machine: "local", lane: "zz/lane_3" });
    expect(laneRef("local", "lane_3")).toBe("lane_3");
    expect(laneRef("b", "lane_3")).toBe("b/lane_3");
  });

  test("agent verbs route by ref or --machine; scripts written before machines parse exactly as before", () => {
    expect(routeAgentArgv(["agent", "status", "lane_3"], known)).toEqual({ machine: "local", op: { op: "agent.status", lane: "lane_3" } });
    expect(routeAgentArgv(["agent", "read", "b/lane_3", "-n", "5"], known)).toEqual({ machine: "b", op: { op: "agent.read", lane: "lane_3", turns: 5 } });
    expect(routeAgentArgv(["agent", "spawn", "--machine", "b", "--name", "x"], known)).toEqual({ machine: "b", op: { op: "agent.spawn", name: "x" } });
    expect(routeAgentArgv(["agent", "list"], known)).toEqual({ machine: null, op: { op: "agent.list" } });
    expect(routeAgentArgv(["agent", "wait", "b/lane_3"], known)).toBeNull(); // another owner's verb
    expect(routeAgentArgv(["pane", "list"], known)).toBeNull();
    const code = (argv: string[]) => { try { routeAgentArgv(argv, known); return "ok"; } catch (e) { return e instanceof HubOpError ? e.code : "?"; } };
    expect(code(["agent", "spawn", "--machine", "nope"])).toBe("not_found");
    expect(code(["agent", "status", "x", "--machine", "b"])).toBe("usage");
    expect(code(["agent", "priority", "b/lane_3", "2"])).toBe("usage");
  });
});

describe("backoff", () => {
  test("a machine that was up reconnects, and reads down after DOWN_AFTER failures; it keeps its last lanes", () => {
    const up = connOk(fakeEngine().record, [{ id: "l1", status: "working" }]);
    expect(nextDelay(up)).toBe(MACHINE_POLL_MS);
    let c = connFail(up, "gone");
    expect([c.state, c.engine, c.lanes]).toEqual(["reconnecting", null, [{ id: "l1", status: "working" }]]);
    const delays = [nextDelay(c)];
    for (let i = 1; i < DOWN_AFTER + 3; i++) { c = connFail(c, "gone"); delays.push(nextDelay(c)); }
    expect(delays.slice(0, BACKOFF_MS.length)).toEqual([...BACKOFF_MS]);
    expect(delays.at(-1)).toBe(BACKOFF_MS.at(-1)!);
    expect(c.state).toBe("down");
    expect(connFail(freshConn(), "no file").state).toBe("down"); // never connected: down, not reconnecting
  });
});

describe("a MachineSet", () => {
  test("a discovery file whose engine fails the handshake is never sent a token", async () => {
    const impostor = fakeEngine({ answerNonce: "someone-else" });
    const folder = join(dir, "b");
    publish(impostor, folder);
    const set = new MachineSet(null, local());
    set.add("b", folder);
    await set.tick("b");
    expect(set.state("b")).toBe("down");
    expect(set.engine("b")).toBeNull();
    expect(impostor.seen.map((s) => s.path)).toEqual(["/api/health"]);
    expect(impostor.seen.every((s) => s.token === null)).toBe(true);
  });

  test("each machine connects, drops and reconnects on its own; a dropped machine's rows stay with their last status", async () => {
    const b = fakeEngine({ lanes: [{ id: "lane_b", name: "builder", status: "working" }] });
    const c = fakeEngine({ lanes: [{ id: "lane_c", name: "checker", status: "done" }] });
    const fb = join(dir, "b");
    const fc = join(dir, "c");
    const bFile = publish(b, fb);
    publish(c, fc);
    const set = new MachineSet(null, local());
    set.add("b", fb);
    set.add("c", fc);
    set.setLocalLanes([{ id: "lane_a", name: "scout", status: "working" }]);
    await Promise.all([set.tick("b"), set.tick("c")]);
    expect([set.state("b"), set.state("c")]).toEqual(["connected", "connected"]);
    expect(set.lanes().map((l) => [l.machine, l.ref, l.stale ?? false])).toEqual([
      ["local", "lane_a", false], ["b", "b/lane_b", false], ["c", "c/lane_c", false],
    ]);

    // Engine b goes away: its rows stay, dimmed, with the last status; c is untouched.
    b.stop();
    rmSync(bFile);
    await Promise.all([set.tick("b"), set.tick("c")]);
    expect([set.state("b"), set.state("c")]).toEqual(["reconnecting", "connected"]);
    expect(set.engine("b")).toBeNull();
    expect(set.lanes().find((l) => l.machine === "b")).toMatchObject({ ref: "b/lane_b", status: "working", stale: true });
    const rail = railRows(new Spaces(), [], set.railGroups());
    const bRow = rail.find((r) => r.kind === "agent" && r.row.id === "b/lane_b");
    expect(bRow?.kind === "agent" && bRow.dim).toBe(true);
    expect(rail.filter((r) => r.kind === "machine").map((r) => (r.kind === "machine" ? `${r.name}:${r.state}` : ""))).toEqual(["local:connected", "b:reconnecting", "c:connected"]);
    for (const r of rail) expect(Bun.stringWidth(railLine(r, 27))).toBe(27);

    // b comes back on a new port with a new token: found again through its folder and the handshake.
    const b2 = fakeEngine({ lanes: [{ id: "lane_b", name: "builder", status: "done" }] });
    publish(b2, fb);
    await set.tick("b");
    expect(set.state("b")).toBe("connected");
    expect(set.engine("b")).toEqual({ base: `http://127.0.0.1:${b2.record.port}`, token: b2.record.token });
    expect(set.lanes().find((l) => l.machine === "b")).toMatchObject({ status: "done" });
    expect(set.lanes().find((l) => l.machine === "b")?.stale).toBeUndefined();
  });

  test("start runs each machine on its own clock: the poll interval when up, the backoff when not", async () => {
    const b = fakeEngine();
    const fb = join(dir, "b");
    publish(b, fb);
    const delays: number[] = [];
    const scheduled = Promise.withResolvers<void>();
    const set = new MachineSet(null, local(), {
      schedule: (_fn, ms) => {
        delays.push(ms);
        if (delays.length === 2) scheduled.resolve();
        return () => {};
      },
    });
    set.add("b", fb);
    set.add("gone", join(dir, "nothing-here"));
    set.start();
    await scheduled.promise; // both machines took their first step
    set.stop();
    expect(delays.sort((x, y) => x - y)).toEqual([BACKOFF_MS[0]!, MACHINE_POLL_MS].sort((x, y) => x - y));
  });

  test("agent list names every row's machine; a verb on b/<lane> reaches only engine b, unprefixed refs only the hub's own", async () => {
    const b = fakeEngine({ lanes: [{ id: "lane_b", name: "builder", status: "working" }] });
    const fb = join(dir, "b");
    publish(b, fb);
    const annotated: string[] = [];
    const set = new MachineSet(null, local(), { annotate: (l) => { annotated.push(String(l.id)); return { ...l, attention: "none" }; } });
    set.add("b", fb);
    await set.tick("b");
    const log: HubOp[] = [];
    const exec = localExec(log);

    const list = await set.command(["agent", "list"], exec);
    expect(list).toEqual([
      { id: "lane_a", name: "scout", status: "working", machine: "local", attention: "none" },
      { id: "b/lane_b", name: "builder", status: "working", machine: "b", attention: "none" },
    ]);
    expect(annotated.sort()).toEqual(["b/lane_b", "lane_a"]);

    b.seen.length = 0;
    expect(await set.command(["agent", "read", "b/lane_b", "-n", "1"], exec)).toMatchObject({ machine: "b", lane: "b/lane_b", turns: [{ role: "user", text: "hi" }] });
    expect(await set.command(["agent", "cancel", "b/lane_b"], exec)).toMatchObject({ machine: "b", lane: "b/lane_b" });
    expect(await set.command(["agent", "spawn", "--machine", "b"], exec)).toMatchObject({ lane: { id: "b/lane_new", machine: "b" } });
    expect(b.seen.map((s) => s.path)).toContain("/api/fleet/cancel");
    expect(b.seen.every((s) => s.token === b.record.token)).toBe(true);
    expect(log.map((op) => op.op)).toEqual(["agent.list"]); // nothing for b reached the hub's own engine

    await set.command(["agent", "status", "local/lane_a"], exec);
    await set.command(["agent", "cancel", "lane_a"], exec);
    expect(log.slice(1)).toEqual([{ op: "agent.status", lane: "lane_a" }, { op: "agent.cancel", lane: "lane_a" }]);
  });

  test("a verb for a machine that is not connected is refused machine_down; the list still shows its last rows", async () => {
    const set = new MachineSet(null, local());
    set.add("b", join(dir, "empty"));
    await set.tick("b");
    let code = "";
    try { await set.command(["agent", "status", "b/lane_b"], localExec([])); } catch (e) { code = e instanceof HubOpError ? e.code : "?"; }
    expect(code).toBe("machine_down");
    expect(set.list().map((m) => [m.name, m.state])).toEqual([["local", "connected"], ["b", "down"]]);
  });

  test("an unparseable machines file is an empty list, never a crash", () => {
    const path = machinesPath(dir, "main");
    writeFileSync(path, "\u0000\u0000");
    expect(new MachineSet(path, local()).names()).toEqual([DEFAULT_MACHINE]);
  });
});

// ADR-0549: the `spokes` machine. A fake engine answers the /api/remote-spokes routes the renderer
// uses (desktop/remote_spokes.ts) with the shapes that module returns; the Herd server reaches them
// with its own engine's UI token and nothing else.

const NODE_A = `n_${"a".repeat(32)}`;
const NODE_B = `n_${"b".repeat(32)}`;
const TASK_1 = `t_${"1".repeat(16)}`;
const TASK_2 = `t_${"2".repeat(16)}`;
const TASK_3 = `t_${"3".repeat(16)}`;
const TASK_NEW = `t_${"9".repeat(16)}`;

interface FakeHub { record: EngineDiscovery; seen: { method: string; path: string; token: string | null; body: unknown }[]; view: Record<string, unknown>; reply: Record<string, unknown>; stop(): void }

const hubs: FakeHub[] = [];

const spokesView = (): Record<string, unknown> => ({
  available: true,
  hub: { node: `n_${"c".repeat(32)}`, label: "hub", scopes: ["recall", "drive"], presence: "none" },
  actions: { recall: true, drive: true, approve: false, deny: true },
  spokes: [
    { node: NODE_A, label: "box-a\u0007", state: "approval", tasks: [
      { id: TASK_1, name: "train\u202e", state: "working", turns: 2, updatedAt: 1 },
      { id: TASK_2, name: "review", state: "awaiting_approval", turns: 1, updatedAt: 1 },
      { id: "t_bad", name: "dropped", state: "working", turns: 0, updatedAt: 1 },
      { id: `t_${"4".repeat(16)}`, name: "dropped", state: "sleeping", turns: 0, updatedAt: 1 },
    ] },
    { node: "n_bad", label: "dropped", state: "idle", tasks: [{ id: TASK_3, name: "x", state: "idle", turns: 0, updatedAt: 1 }] },
    { node: NODE_B, label: "box-b", state: "idle", tasks: [{ id: TASK_3, name: "", state: "idle", turns: 3, updatedAt: 1 }] },
  ],
});

const UNAVAILABLE = { available: false, plugin: "missing", reason: "Install the Remote Spokes plugin to see remote spokes here." };

/** This server's own engine, answering the remote-spokes routes only. */
function fakeHub(view: Record<string, unknown> = spokesView()): FakeHub {
  const nonce = crypto.randomUUID();
  const token = `token-${nonce}`;
  const seen: FakeHub["seen"] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const { pathname } = new URL(req.url);
      const body: unknown = req.method === "POST" ? await req.json() : undefined;
      seen.push({ method: req.method, path: pathname, token: req.headers.get("x-lucid-token"), body });
      if (req.headers.get("x-lucid-token") !== token) return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
      if (pathname === "/api/remote-spokes" && req.method === "GET") return Response.json({ ok: true, data: hub.view });
      if ((pathname === "/api/remote-spokes/submit" || pathname === "/api/remote-spokes/followup") && req.method === "POST") return Response.json({ ok: true, data: hub.reply });
      return new Response("not found", { status: 404 });
    },
  });
  const hub: FakeHub = {
    record: { v: 1, pid: process.pid, port: server.port!, nonce, version: "9.9", flavor: "agent", startedAt: new Date().toISOString(), token },
    seen,
    view,
    reply: { ok: true, data: { task: TASK_NEW } },
    stop: () => { void server.stop(true); },
  };
  hubs.push(hub);
  return hub;
}

async function spokesSet(hub: FakeHub): Promise<MachineSet> {
  const set = new MachineSet(null, hub.record);
  set.machineCommand(["machine", "add", SPOKES_MACHINE]);
  await set.tick(SPOKES_MACHINE);
  return set;
}

async function codeOf(f: () => Promise<unknown> | unknown): Promise<string> {
  try { await f(); return "ok"; } catch (e) { return e instanceof HubOpError ? e.code : String(e); }
}

describe("the spokes machine (ADR-0549)", () => {
  afterEach(() => { for (const h of hubs.splice(0)) h.stop(); });

  test("the list file keeps `spokes` only under its own name and kind; add takes no flags and no SSH", async () => {
    const raw = JSON.stringify({ v: 1, machines: [
      { name: "spokes", kind: "spokes" },
      { name: "spokes", kind: "spokes" },
      { name: "other", kind: "spokes" },
      { name: "spokes", kind: "local", discoveryDir: join(dir, "s") },
    ] });
    expect(parseMachines(raw)).toEqual([{ name: "spokes", kind: "spokes" }]);

    const path = machinesPath(dir, "main");
    const set = new MachineSet(path, local());
    expect(set.machineCommand(["machine", "add", "spokes"])).toEqual({ added: "spokes", kind: "spokes", state: "down" });
    expect(loadMachines(path)).toEqual([{ name: "spokes", kind: "spokes" }]);
    expect(new MachineSet(path, local()).names()).toEqual([DEFAULT_MACHINE, "spokes"]);
    expect(await codeOf(() => set.machineCommand(["machine", "add", "spokes"]))).toBe("exists");
    expect(await codeOf(() => set.machineCommand(["machine", "add", "spokes", "--dir", join(dir, "s")]))).toBe("usage");
    expect(await codeOf(() => set.machineCommand(["machine", "add", "spokes", "--ssh", "192.0.2.10"]))).toBe("not_supported");
    expect(await codeOf(() => set.machineCommand(["machine", "add", "box", "--profile", "gpu"]))).toBe("not_supported");
    expect(set.list().at(-1)).toMatchObject({ name: "spokes", kind: "spokes", discoveryDir: null });
  });

  test("spokeTaskLanes: one row per task with the spoke label and the task state verbatim; malformed rows drop; text is terminal-safe", () => {
    expect(spokeTaskLanes(spokesView().spokes)).toEqual([
      { id: `${NODE_A}:${TASK_1}`, name: "train", status: "working", taskState: "working", spoke: "box-a", spokeState: "approval", node: NODE_A, task: TASK_1, turns: 2 },
      { id: `${NODE_A}:${TASK_2}`, name: "review", status: "needs-approval", taskState: "awaiting_approval", spoke: "box-a", spokeState: "approval", node: NODE_A, task: TASK_2, turns: 1 },
      { id: `${NODE_B}:${TASK_3}`, name: TASK_3, status: "done", taskState: "idle", spoke: "box-b", spokeState: "idle", node: NODE_B, task: TASK_3, turns: 3 },
    ]);
    expect(spokeTaskLanes("junk")).toEqual([]);
  });

  test("listing: the poll reads /api/remote-spokes with this engine's token; agent list and the rail name the spoke and the task state", async () => {
    const hub = fakeHub();
    const set = await spokesSet(hub);
    expect(set.state(SPOKES_MACHINE)).toBe("connected");
    expect(hub.seen.map((s) => [s.method, s.path, s.token])).toEqual([["GET", "/api/remote-spokes", hub.record.token]]);
    expect(set.list().at(-1)).toMatchObject({ name: "spokes", kind: "spokes", state: "connected", lanes: 3, port: hub.record.port });

    const list = await set.command(["agent", "list"], localExec([]));
    expect(list).toEqual([
      { id: "lane_a", name: "scout", status: "working", machine: "local" },
      { id: `spokes/${NODE_A}:${TASK_1}`, name: "train", status: "working", taskState: "working", spoke: "box-a", spokeState: "approval", node: NODE_A, task: TASK_1, turns: 2, machine: "spokes" },
      { id: `spokes/${NODE_A}:${TASK_2}`, name: "review", status: "needs-approval", taskState: "awaiting_approval", spoke: "box-a", spokeState: "approval", node: NODE_A, task: TASK_2, turns: 1, machine: "spokes" },
      { id: `spokes/${NODE_B}:${TASK_3}`, name: TASK_3, status: "done", taskState: "idle", spoke: "box-b", spokeState: "idle", node: NODE_B, task: TASK_3, turns: 3, machine: "spokes" },
    ]);
    const only = await set.command(["agent", "list", "--machine", "spokes"], localExec([]));
    expect(Array.isArray(only) ? only.length : -1).toBe(3);

    const rail = railRows(new Spaces(), [], set.railGroups());
    const row = rail.find((r) => r.kind === "agent" && r.row.id === `spokes/${NODE_A}:${TASK_1}`);
    expect(row?.kind === "agent" ? [row.row.location, row.row.model, row.dim ?? false] : null).toEqual(["box-a", "working", false]);
    expect(rail.filter((r) => r.kind === "machine").map((r) => (r.kind === "machine" ? `${r.name}:${r.state}:${r.count}` : ""))).toEqual(["local:connected:0", "spokes:connected:3"]);
    for (const r of rail) expect(Bun.stringWidth(railLine(r, 27))).toBe(27);
  });

  test("an unavailable hub is down with its reason; rows it had stay, dimmed and stale", async () => {
    const missing = fakeHub(UNAVAILABLE);
    const down = await spokesSet(missing);
    expect(down.list().at(-1)).toMatchObject({ name: "spokes", state: "down", error: UNAVAILABLE.reason, lanes: 0 });

    const hub = fakeHub();
    const set = await spokesSet(hub);
    hub.view = UNAVAILABLE;
    await set.tick(SPOKES_MACHINE);
    expect(set.state(SPOKES_MACHINE)).toBe("reconnecting");
    const rows = await set.command(["agent", "list", "--machine", "spokes"], localExec([]));
    expect(Array.isArray(rows) && rows.length === 3 && rows.every((r) => typeof r === "object" && r !== null && "stale" in r && r.stale === true)).toBe(true);
    const rail = railRows(new Spaces(), [], set.railGroups());
    expect(rail.filter((r) => r.kind === "agent").every((r) => r.kind === "agent" && r.dim === true)).toBe(true);
  });

  test("refs: spokes/<node>:<task> parses; anything else is a usage refusal", () => {
    expect(spokeTaskRef(`${NODE_A}:${TASK_1}`)).toEqual({ node: NODE_A, task: TASK_1 });
    for (const bad of [NODE_A, `${NODE_A}:t_bad`, `n_bad:${TASK_1}`, `${NODE_A}:${TASK_1}:x`, ""]) {
      expect(() => spokeTaskRef(bad)).toThrow(HubOpError);
    }
    expect(routeSpokesArgv(["agent", "list", "--machine", "spokes"])).toEqual({ kind: "list" });
    expect(routeSpokesArgv(["agent", "spawn", "--machine", "spokes", "--spoke", NODE_A, "--text", "run the eval", "--name", "eval"])).toEqual({ kind: "submit", node: NODE_A, text: "run the eval", name: "eval" });
    expect(routeSpokesArgv(["agent", "prompt", `spokes/${NODE_A}:${TASK_1}`, "and", "then", "-v"])).toEqual({ kind: "followup", node: NODE_A, task: TASK_1, text: "and then -v" });
    expect(routeSpokesArgv(["agent", "list"])).toBeNull();
    expect(routeSpokesArgv(["agent", "status", "b/lane_3"])).toBeNull();
    expect(routeSpokesArgv(["pane", "list"])).toBeNull();
  });

  test("refusals: a decision is human_only, every other verb not_supported, malformed spawns usage; nothing is sent", async () => {
    const hub = fakeHub();
    const set = await spokesSet(hub);
    hub.seen.length = 0;
    const ref = `spokes/${NODE_A}:${TASK_2}`;
    const run = (argv: string[]) => codeOf(() => set.command(argv, localExec([])));
    for (const verb of ["approve", "deny", "decide", "answer"]) expect(await run(["agent", verb, ref])).toBe("human_only");
    for (const verb of ["status", "read", "cancel", "close"]) expect(await run(["agent", verb, ref])).toBe("not_supported");
    expect(await run(["agent", "priority", ref, "2"])).toBe("not_supported");
    expect(await run(["agent", "spawn", "--machine", "spokes", "--text", "x"])).toBe("usage");
    expect(await run(["agent", "spawn", "--machine", "spokes", "--spoke", NODE_A])).toBe("usage");
    expect(await run(["agent", "spawn", "--machine", "spokes", "--spoke", NODE_A, "--text", "x", "--cwd", "/tmp"])).toBe("usage");
    expect(await run(["agent", "prompt", `spokes/${NODE_A}:t_bad`, "x"])).toBe("usage");
    expect(await run(["agent", "prompt", `spokes/${NODE_A}:${TASK_1}`])).toBe("usage");
    // A follow-up to a task parked on a person's approval is refused before anything is sent: the one
    // request is the fresh read of the task's state (ADR-0559).
    expect(await run(["agent", "prompt", ref, "go on"])).toBe("agent_blocked");
    expect(hub.seen.map((s) => [s.method, s.path])).toEqual([["GET", "/api/remote-spokes"]]);
    // Without a spokes machine, `--machine spokes` names no machine.
    expect(await codeOf(() => new MachineSet(null, hub.record).command(["agent", "spawn", "--machine", "spokes"], localExec([])))).toBe("not_found");
  });

  test("spawn submits and prompt follows up through the remote-spokes routes; the hub's refusal comes back verbatim", async () => {
    const hub = fakeHub();
    const set = await spokesSet(hub);
    hub.seen.length = 0;
    const log: HubOp[] = [];
    expect(await set.command(["agent", "spawn", "--machine", "spokes", "--spoke", NODE_A, "--text", "run the eval", "--model", "local/qwen"], localExec(log)))
      .toEqual({ lane: { id: `spokes/${NODE_A}:${TASK_NEW}`, machine: "spokes", node: NODE_A, task: TASK_NEW } });
    hub.reply = { ok: true, data: { task: TASK_1 } };
    expect(await set.command(["agent", "prompt", `spokes/${NODE_A}:${TASK_1}`, "and", "then"], localExec(log)))
      .toEqual({ lane: `spokes/${NODE_A}:${TASK_1}`, machine: "spokes", accepted: true, task: TASK_1 });
    expect(hub.seen.map((s) => [s.method, s.path, s.token, s.body])).toEqual([
      ["POST", "/api/remote-spokes/submit", hub.record.token, { node: NODE_A, text: "run the eval", model: "local/qwen" }],
      ["GET", "/api/remote-spokes", hub.record.token, undefined], // ADR-0559: the task's state, read fresh
      ["POST", "/api/remote-spokes/followup", hub.record.token, { node: NODE_A, task: TASK_1, text: "and then" }],
    ]);
    expect(log).toEqual([]); // nothing reached the hub's own agent verbs

    hub.reply = { ok: false, error: "this hub's certificate does not carry the drive scope" };
    let message = "";
    try { await set.command(["agent", "prompt", `spokes/${NODE_B}:${TASK_3}`, "more"], localExec(log)); } catch (e) { message = e instanceof HubOpError ? `${e.code}: ${e.message}` : String(e); }
    expect(message).toBe("refused: this hub's certificate does not carry the drive scope");
  });
});
