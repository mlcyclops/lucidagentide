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
  MachineSet, machinesPath, nextDelay, parseMachines, removeMachine, routeAgentArgv, splitLaneRef,
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
