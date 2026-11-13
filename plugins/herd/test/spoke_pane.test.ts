// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Herd (ADR-0541; P-HERD.7b, ADR-0559): a spoke task in a pane. Against a fake engine on loopback that
// answers the /api/remote-spokes routes with the shapes desktop/remote_spokes.ts returns (recall
// entries already through the engine's scan, a flagged one withheld): the pane draws the header from
// the poll and the recalled entries, terminal-safe and bounded; a recall is not repeated while the
// task is unchanged; a typed line is exactly the `agent prompt` follow-up; a follow-up reads the
// task fresh and refuses a task that parked since the last poll; a down hub keeps the last content,
// stale. In a running server a focused spoke pane clears `unseen` and `next` reaches a settled spoke
// row. Nothing here reaches /api/remote-spokes/decide.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineDiscovery } from "../../../desktop/engine_discovery.ts";
import { callHub } from "../../../harness/launcher/hub_control.ts";
import { HubOpError, Spaces } from "../../../harness/launcher/hub_spaces.ts";
import { HerdAttention } from "../src/attention.ts";
import { MachineSet, machinesPath, saveMachines, SPOKES_MACHINE } from "../src/engines.ts";
import { attachHub } from "../src/hub_client.ts";
import { startHubServer, type HubServer } from "../src/hub_server.ts";
import { connectInstance } from "../src/instance.ts";
import { MAX_PANE_ENTRIES, MAX_PANE_TEXT, paneEntries, SPOKE_RECALL_MIN_MS, spokeBody, spokePaneCommand, SpokePanes } from "../src/spoke_pane.ts";

const rec = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

const NODE_A = `n_${"a".repeat(32)}`;
const NODE_B = `n_${"b".repeat(32)}`;
const TASK_1 = `t_${"1".repeat(16)}`;
const TASK_2 = `t_${"2".repeat(16)}`;
const TASK_3 = `t_${"3".repeat(16)}`;
const TASK_4 = `t_${"4".repeat(16)}`;
const REF_2 = `spokes/${NODE_A}:${TASK_2}`;
const REF_3 = `spokes/${NODE_B}:${TASK_3}`;
const REF_4 = `spokes/${NODE_B}:${TASK_4}`;

type Task = { id: string; name: string; state: string; turns: number; updatedAt: number };

const spokesView = (tasks: { a?: Task[]; b?: Task[] } = {}): Record<string, unknown> => ({
  available: true,
  hub: { node: `n_${"c".repeat(32)}`, label: "hub", scopes: ["recall", "drive"], presence: "none" },
  actions: { recall: true, drive: true, approve: false, deny: true },
  spokes: [
    { node: NODE_A, label: "box-a", state: "approval", tasks: tasks.a ?? [
      { id: TASK_1, name: "train", state: "working", turns: 2, updatedAt: 1 },
      { id: TASK_2, name: "review", state: "awaiting_approval", turns: 1, updatedAt: 1 },
    ] },
    { node: NODE_B, label: "box-b", state: "idle", tasks: tasks.b ?? [{ id: TASK_3, name: "eval", state: "idle", turns: 3, updatedAt: 1 }] },
  ],
});

/** No task waits on a person: one working, two settled (idle and error), so next goes by unseen. */
const settledView = (): Record<string, unknown> => spokesView({
  a: [{ id: TASK_1, name: "train", state: "working", turns: 2, updatedAt: 1 }],
  b: [{ id: TASK_3, name: "eval", state: "idle", turns: 3, updatedAt: 1 }, { id: TASK_4, name: "lint", state: "error", turns: 1, updatedAt: 1 }],
});

const UNAVAILABLE = { available: false, plugin: "stopped", reason: "The Remote Spokes plugin is not running. Start it to see your remote spokes here." };

/** What the engine's recall returns for TASK_3: a turn with hostile bytes, a withheld entry, a turn
 *  the scanner marked suspicious. */
const recallView = (): Record<string, unknown> => ({
  ok: true, node: NODE_B, label: "box-b", task: TASK_3, quarantined: 1, omitted: 0, context: "(the delimited envelope)",
  entries: [
    { seq: 1, ts: 1, task: TASK_3, kind: "task.turn", trust: "untrusted", text: "plain \u001b[31mred\u001b[0m line\u0007\r\nsecond\u202e line\u001b]0;pwned\u0007 end\u009b2J" },
    { seq: 2, ts: 2, task: "-", kind: "withheld", trust: "quarantined", text: "", reason: "prompt injection" },
    { seq: 3, ts: 3, task: TASK_3, kind: "task.turn", trust: "suspicious", text: "all\ttests pass" },
  ],
});

interface FakeHub { record: EngineDiscovery; seen: { method: string; path: string; token: string | null; body: unknown }[]; view: Record<string, unknown>; recall: Record<string, unknown>; reply: Record<string, unknown>; stop(): void }

const hubs: FakeHub[] = [];
const servers: HubServer[] = [];
let data: string;

/** This server's own engine: the remote-spokes routes, and an empty fleet for the hub's own poll. */
function fakeHub(view: Record<string, unknown> = spokesView()): FakeHub {
  const nonce = crypto.randomUUID();
  const token = `token-${nonce}`;
  const seen: FakeHub["seen"] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const { pathname } = new URL(req.url);
      const body: unknown = req.method === "POST" ? await req.json().catch(() => null) : undefined;
      if (pathname.startsWith("/api/remote-spokes")) seen.push({ method: req.method, path: pathname, token: req.headers.get("x-lucid-token"), body });
      if (req.headers.get("x-lucid-token") !== token) return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
      if (pathname === "/api/remote-spokes" && req.method === "GET") return Response.json({ ok: true, data: hub.view });
      if (pathname === "/api/remote-spokes/recall" && req.method === "POST") return Response.json({ ok: true, data: hub.recall });
      if (pathname === "/api/remote-spokes/followup" && req.method === "POST") return Response.json({ ok: true, data: hub.reply });
      if (pathname.startsWith("/api/remote-spokes")) return new Response("not found", { status: 404 });
      if (pathname === "/api/fleet/status") return Response.json({ ok: true, data: { lanes: [] } });
      return Response.json({ ok: true, data: {} });
    },
  });
  const hub: FakeHub = {
    record: { v: 1, pid: process.pid, port: server.port!, nonce, version: "9.9", flavor: "agent", startedAt: new Date().toISOString(), token },
    seen,
    view,
    recall: recallView(),
    reply: { ok: true, data: { task: TASK_3 } },
    stop: () => { void server.stop(true); },
  };
  hubs.push(hub);
  return hub;
}

/** A spokes machine on the fake hub, polled once, and a pane set on it with a clock the test moves. */
async function setup(view?: Record<string, unknown>) {
  const hub = fakeHub(view);
  const set = new MachineSet(null, hub.record);
  set.machineCommand(["machine", "add", SPOKES_MACHINE]);
  await set.tick(SPOKES_MACHINE);
  const clock = { now: 1_000_000 };
  const waiters: (() => void)[] = [];
  const panes = new SpokePanes({
    machines: set,
    run: (argv) => set.command(argv, async () => { throw new Error("a spoke follow-up never reaches this engine's agent verbs"); }) ?? Promise.reject(new Error("not routed")),
    changed: () => { for (const w of waiters.splice(0)) w(); },
    now: () => clock.now,
  });
  /** Await the pane's redraw requests until `pred` holds (the test timeout bounds it). */
  const until = async (pred: () => boolean) => {
    while (!pred()) {
      const n = Promise.withResolvers<void>();
      waiters.push(n.resolve);
      await n.promise;
    }
  };
  return { hub, set, panes, clock, until };
}

const plain = (rows: readonly string[]) => rows.map((r) => Bun.stripANSI(r)).join("\n");
const recalls = (hub: FakeHub) => hub.seen.filter((s) => s.path === "/api/remote-spokes/recall").length;
const codeOf = async (f: () => Promise<unknown> | unknown): Promise<string> => {
  try { await f(); return "ok"; } catch (e) { return e instanceof HubOpError ? e.code : `?${String(e)}`; }
};

beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), "herd-spoke-pane-"));
});
afterEach(async () => {
  for (const s of servers.splice(0)) { s.stop(); await s.done; }
  for (const h of hubs.splice(0)) h.stop();
  rmSync(data, { recursive: true, force: true });
});

describe("the spoke pane (ADR-0559)", () => {
  test("it draws the header from the poll and the recalled entries, newest at the bottom; escapes and controls are stripped; a withheld entry is a note", async () => {
    const { hub, panes } = await setup();
    await panes.sync([REF_3]);
    expect(hub.seen.filter((s) => s.method === "POST").map((s) => [s.path, s.token, s.body])).toEqual([
      ["/api/remote-spokes/recall", hub.record.token, { node: NODE_B, task: TASK_3 }],
    ]);
    const rows = panes.pane(REF_3, 80, 24, true);
    expect(rows).toHaveLength(24);
    const frame = plain(rows);
    expect(frame).toContain("spokes · box-b · eval · idle · 3 turns");
    expect(frame).toContain("#1 task.turn");
    expect(frame).toContain("plain red line");
    expect(frame).toContain("second line end");
    expect(frame).toContain("#2 withheld by the scanner");
    expect(frame).not.toContain("prompt injection");
    expect(frame).toContain("#3 task.turn (suspicious)");
    expect(frame).toContain("all tests pass");
    expect(frame.indexOf("#1 task.turn")).toBeLessThan(frame.indexOf("#3 task.turn"));
    // Nothing the spoke wrote survives as a control: no OSC title, no bidi override, no C1 CSI.
    expect(frame).not.toContain("pwned");
    for (const row of rows) expect(Bun.stripANSI(row)).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202e]/);
  });

  test("spokeBody and paneEntries: escape sequences go whole, newlines stay, at most 200 entries and 64 KiB", () => {
    expect(spokeBody("a\u001b[2Jb\u001b]8;;http://x\u0007c\r\nd\u200be\u2028f\u0000")).toBe("abc\ndef");
    const many = Array.from({ length: MAX_PANE_ENTRIES + 50 }, (_, i) => ({ seq: i, kind: "task.turn", trust: "untrusted", text: `entry ${i}` }));
    const kept = paneEntries(many, 7);
    expect(kept.entries).toHaveLength(MAX_PANE_ENTRIES);
    expect(kept.entries.at(-1)?.seq).toBe(MAX_PANE_ENTRIES + 49);
    expect(kept.omitted).toBe(57);
    const big = paneEntries([{ seq: 1, kind: "task.turn", trust: "untrusted", text: "old" }, { seq: 2, kind: "task.turn", trust: "untrusted", text: "x".repeat(MAX_PANE_TEXT + 10) }], 0);
    expect(big.entries.map((e) => [e.seq, e.text.length, e.trimmed])).toEqual([[2, MAX_PANE_TEXT, true]]);
    expect(big.omitted).toBe(1);
  });

  test("a recall is not repeated while turns and state are unchanged, never while one is in flight, and at most once per 5 s", async () => {
    const { hub, set, panes, clock } = await setup();
    const first = panes.sync([REF_3]);
    clock.now += 10 * SPOKE_RECALL_MIN_MS;
    const during = panes.sync([REF_3]); // the first is still in flight
    await Promise.all([first, during]);
    expect(recalls(hub)).toBe(1);
    clock.now += 10 * SPOKE_RECALL_MIN_MS;
    await panes.sync([REF_3]);
    expect(recalls(hub)).toBe(1); // same turns, same state
    // The task moves on; the next listing brings it, and the pane recalls once.
    hub.view = spokesView({ b: [{ id: TASK_3, name: "eval", state: "working", turns: 4, updatedAt: 2 }] });
    await set.tick(SPOKES_MACHINE);
    await panes.sync([REF_3]);
    expect(recalls(hub)).toBe(2);
    // It settles 1 s later: within the 5 s floor nothing is recalled, after it one recall.
    hub.view = spokesView({ b: [{ id: TASK_3, name: "eval", state: "idle", turns: 4, updatedAt: 3 }] });
    await set.tick(SPOKES_MACHINE);
    clock.now += 1000;
    await panes.sync([REF_3]);
    expect(recalls(hub)).toBe(2);
    clock.now += SPOKE_RECALL_MIN_MS;
    await panes.sync([REF_3]);
    expect(recalls(hub)).toBe(3);
    expect(plain(panes.pane(REF_3, 80, 24, false))).toContain("eval · idle · 4 turns");
  });

  test("a typed line is the agent prompt follow-up, body exact; decision keys are refused human_only and send nothing", async () => {
    const { hub, panes, until } = await setup();
    await panes.sync([REF_3]);
    hub.seen.length = 0;
    for (const key of ["y", "s", "d", "a", "i"]) {
      expect(panes.input(REF_3, key, false)).toBe(true);
      expect(panes.hint(REF_3)).toStartWith("human_only:");
    }
    expect(panes.input(REF_3, "c", false)).toBe(true);
    expect(panes.hint(REF_3)).toStartWith("not_supported:");
    expect(hub.seen).toEqual([]);
    expect(panes.input(REF_3, "\r", true)).toBe(true);
    expect(panes.modal()).toBe(true);
    panes.input(REF_3, "now run the full suite", false);
    expect(plain(panes.pane(REF_3, 80, 24, true))).toContain("› now run the full suite");
    panes.input(REF_3, "\r", true);
    expect(panes.modal()).toBe(false);
    await until(() => panes.hint(REF_3) === "follow-up sent");
    expect(hub.seen.map((s) => [s.method, s.path, s.body])).toEqual([
      ["GET", "/api/remote-spokes", undefined],
      ["POST", "/api/remote-spokes/followup", { node: NODE_B, task: TASK_3, text: "now run the full suite" }],
    ]);
  });

  test("a task that parked after the last poll is refused agent_blocked from the pane and the CLI alike, and nothing is sent", async () => {
    const { hub, set, panes, until } = await setup();
    await panes.sync([REF_3]);
    // The poll says idle; the task has since parked on an approval.
    hub.view = spokesView({ b: [{ id: TASK_3, name: "eval", state: "awaiting_approval", turns: 3, updatedAt: 2 }] });
    hub.seen.length = 0;
    panes.input(REF_3, "\r", true);
    panes.input(REF_3, "go on\r", false);
    await until(() => panes.hint(REF_3).startsWith("agent_blocked:"));
    expect(await codeOf(() => set.command(["agent", "prompt", REF_3, "go", "on"], async () => null))).toBe("agent_blocked");
    expect(hub.seen.map((s) => [s.method, s.path])).toEqual([["GET", "/api/remote-spokes"], ["GET", "/api/remote-spokes"]]);
    // A fresh read that fails falls back to the last poll, which still says parked for REF_2.
    hub.view = UNAVAILABLE;
    expect(await codeOf(() => set.command(["agent", "prompt", REF_2, "go"], async () => null))).toBe("agent_blocked");
    expect(hub.seen.some((s) => s.path === "/api/remote-spokes/followup" || s.path === "/api/remote-spokes/decide")).toBe(false);
    // The pane says where the decision is, and Enter opens no composer on a parked task.
    expect(plain(panes.pane(REF_2, 120, 24, true))).toContain("decide it in the IDE's Remote Spokes panel");
    expect(panes.input(REF_2, "\r", true)).toBe(true);
    expect(panes.modal()).toBe(false);
  });

  test("a down hub keeps the last content, marked stale with the hub's reason, and recalls nothing", async () => {
    const { hub, set, panes, clock } = await setup();
    await panes.sync([REF_3]);
    hub.view = UNAVAILABLE;
    await set.tick(SPOKES_MACHINE);
    clock.now += 10 * SPOKE_RECALL_MIN_MS;
    await panes.sync([REF_3]);
    expect(recalls(hub)).toBe(1);
    const frame = plain(panes.pane(REF_3, 160, 24, false));
    expect(frame).toContain("· stale");
    expect(frame).toContain("The Remote Spokes plugin is not running");
    expect(frame).toContain("second line end");
  });

  test("pane rebind binds a pane to a listed spoke task; an unlisted one is not_found; send-keys into a spoke pane is refused", async () => {
    const { set } = await setup();
    const spaces = new Spaces();
    const leaf = await spokePaneCommand(["pane", "rebind", "agent", REF_3], spaces, () => set.spokeLanes());
    expect(leaf).toMatchObject({ deck: "agent", lane: REF_3, laneName: "eval" });
    expect(await codeOf(() => spokePaneCommand(["pane", "rebind", "agent", `spokes/${NODE_B}:${TASK_4}`], spaces, () => set.spokeLanes()))).toBe("not_found");
    expect(await codeOf(() => spokePaneCommand(["pane", "rebind", "agent", `spokes/${NODE_B}:t_bad`], spaces, () => set.spokeLanes()))).toBe("usage");
    expect(await codeOf(() => spokePaneCommand(["send-keys", "hi", "Enter"], spaces, () => set.spokeLanes()))).toBe("not_supported");
    expect(spokePaneCommand(["pane", "rebind", "agent", "lane_1"], spaces, () => set.spokeLanes())).toBeUndefined();
    expect(spokePaneCommand(["agent", "list"], spaces, () => set.spokeLanes())).toBeUndefined();
  });

  test("attention: a spoke row in the focused pane is seen like a lane, and next jumps to a settled spoke row", async () => {
    const { set } = await setup(settledView());
    let focused: string | null = null;
    const shown: [string, string][] = [];
    const attention = new HerdAttention({
      focused: () => focused,
      clients: () => 1,
      show: async (id, name) => { shown.push([id, name]); focused = id; },
      alert: () => {},
      settings: () => ({ bell: false, desktop: false, sound: false }),
      now: () => 1,
    });
    attention.update(set.spokeLanes());
    expect([attention.attention(REF_3), attention.attention(REF_4)]).toEqual(["unseen", "unseen"]);
    focused = REF_3;
    attention.touch();
    expect([attention.attention(REF_3), attention.attention(REF_4)]).toEqual(["none", "unseen"]);
    expect(await attention.focusNext()).toBe("lint: unseen");
    expect(shown).toEqual([[REF_4, "lint"]]);
    expect(attention.attention(REF_4)).toBe("none");
  });
});

describe("in a running server", () => {
  test("rebind opens a spoke pane, a focused one clears unseen, and next reaches a settled spoke row", async () => {
    const hub = fakeHub(settledView());
    saveMachines(machinesPath(data, "main"), [{ name: SPOKES_MACHINE, kind: "spokes" }]);
    const s = startHubServer({ data, classic: null, attached: { engine: hub.record, spawned: false, child: null } });
    servers.push(s);
    const d = await connectInstance(data, "main");
    if (!d) throw new Error("no handshake");
    const cmd = async (...argv: string[]) => callHub(d, argv);
    /** Poll a verb until `ok` holds. A real delay on purpose: the server's engine and machine polls run
     *  on their own real timers, which a test of the running server cannot drive, and a frame is sent
     *  only when it changes, so no frame is a dependable signal for an attention change. */
    const until = async <T>(f: () => Promise<T>, ok: (v: T) => boolean): Promise<T> => {
      for (let i = 0; ; i++) {
        const v = await f();
        if (ok(v)) return v;
        if (i > 500) throw new Error("timed out");
        await Bun.sleep(10);
      }
    };
    const attentionOf = async (ref: string) => {
      const list = (await cmd("agent", "list")).body.data;
      return rec((Array.isArray(list) ? list : []).find((r) => rec(r).id === ref)).attention;
    };
    await until(() => attentionOf(REF_3), (a) => a === "unseen");

    const frames: string[] = [];
    const att = await attachHub(d, { cols: 120, rows: 40, onFrame: (lines) => { frames.push(lines.map((l) => Bun.stripANSI(l)).join("\n")); } });
    const rebound = await cmd("pane", "rebind", "agent", REF_3);
    expect(rebound.status).toBe(200);
    expect(rec(rebound.body.data)).toMatchObject({ deck: "agent", lane: REF_3 });
    await until(async () => frames.at(-1) ?? "", (f) => f.includes("eval · idle · 3 turns") && f.includes("second line end"));
    await until(() => attentionOf(REF_3), (a) => a === "none");
    const read = await cmd("pane", "read");
    expect(String(rec(read.body.data).title)).toContain("spokes · box-b · eval");

    const next = await cmd("next");
    expect(rec(next.body.data).message).toBe("lint: unseen");
    const panes = (await cmd("pane", "list")).body.data;
    expect(rec((Array.isArray(panes) ? panes : []).find((p) => rec(p).focused === true)).lane).toBe(REF_4);
    expect(hub.seen.some((x) => x.path === "/api/remote-spokes/decide" || x.path === "/api/remote-spokes/approvals")).toBe(false);
    att.detach();
    await att.closed;
  }, 20_000);
});
