// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Herd (ADR-0535; P-HERD.6, ADR-0495): Main is a pane. The ADR's proof list, with a fake engine on
// loopback speaking the renderer's routes: the pure row model over an NDJSON fixture; y/s/d pick the
// ask's own options and an ask is answered only by a keystroke; picker rows keep the engine's order
// with the current value selected; the pane observes a running turn it did not start (two viewers,
// one turn); `main prompt` during an ask is refused agent_blocked and never reaches /api/chat;
// `session open --as main` is refused busy while Main works and swaps the pane once it is free; and
// in a running server the Main pane is layout state, survives a restart, and send-keys cannot type
// into it. Every wait awaits a redraw signal or an engine request, never a clock.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineDiscovery } from "../../../desktop/engine_discovery.ts";
import { callHub } from "../../../harness/launcher/hub_control.ts";
import { HubOpError } from "../../../harness/launcher/hub_spaces.ts";
import type { HubOp } from "../../../harness/launcher/hub_tmux_verbs.ts";
import { startHubServer, type HubServer } from "../src/hub_server.ts";
import { connectInstance } from "../src/instance.ts";
import { answerOption, askKeys, foldMainEvent, idleTurn, MainPane, mainRows, pickerItems, type MainAsk } from "../src/main_pane.ts";

const rec = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

const EXEC_OPTIONS = [
  { optionId: "exec:allow-once", name: "Allow once (this command)", kind: "allow" },
  { optionId: "exec:allow-turn", name: "Allow for the rest of this turn", kind: "allow" },
  { optionId: "exec:allow-program", name: "Always allow this program", kind: "allow" },
  { optionId: "exec:danger", name: "Always allow every command", kind: "danger" },
  { optionId: "exec:deny", name: "Block", kind: "reject" },
];
const EGRESS_OPTIONS = [
  { optionId: "egress:allow-once", name: "Allow once", kind: "allow" },
  { optionId: "egress:allow-site", name: "Always allow this site", kind: "allow" },
  { optionId: "egress:danger", name: "Always allow every site", kind: "danger" },
  { optionId: "egress:deny", name: "Block", kind: "reject" },
];
const ACP_OPTIONS = [
  { optionId: "proceed_once", name: "Yes", kind: "allow_once" },
  { optionId: "proceed_always", name: "Yes, and don't ask again", kind: "allow_always" },
  { optionId: "cancel", name: "No", kind: "reject_once" },
];

const FIXTURE = [
  JSON.stringify({ type: "turn-snapshot", snapshot: { turnId: "t1", sessionId: "s1", startedAt: 1, running: true, prompt: "ship the fix", text: "", pending: [] } }),
  JSON.stringify({ type: "thinking", text: "look at the failing test first" }),
  JSON.stringify({ type: "tool", name: "read", detail: "src/a.ts" }),
  JSON.stringify({ type: "token", text: "Found " }),
  "not json at all",
  JSON.stringify({ type: "token", text: "it" }),
  JSON.stringify({ type: "permission", id: "p1", tool: "exec", detail: "bun test", options: EXEC_OPTIONS }),
  JSON.stringify({ type: "permission", id: "p1", tool: "exec", detail: "bun test", options: EXEC_OPTIONS }), // replayed on attach
].join("\n");

function foldFixture(ndjson: string) {
  let t = idleTurn();
  for (const line of ndjson.split("\n")) {
    let e: unknown;
    try { e = JSON.parse(line); } catch { continue; }
    t = foldMainEvent(t, e);
  }
  return t;
}

describe("the row model (pure)", () => {
  test("settled turns, the running prompt, thinking, tools, streaming text and ONE parked ask with its keys", () => {
    const turn = foldFixture(FIXTURE);
    expect([turn.turnId, turn.working, turn.text, turn.tools, turn.asks.length]).toEqual(["t1", true, "Found it", ["read"], 1]);
    const rows = mainRows({ history: [{ role: "user", text: "earlier" }, { role: "assistant", text: "ok" }], turn }, 70);
    expect(rows).toContain("› earlier");
    expect(rows).toContain("  ok");
    expect(rows).toContain("› ship the fix");
    expect(rows).toContain("\u0001thinking (this turn)");
    expect(rows).toContain("\u0001  look at the failing test first");
    expect(rows).toContain("\u0001⚙ read");
    expect(rows).toContain("  Found it");
    expect(rows).toContain("\u0002⚠ approval needed (exec)");
    expect(rows).toContain("\u0002  y Allow once (this command) · s Allow for the rest of this turn · d Block");
  });

  test("done clears the streamed text and the ask, keeps the reasoning trail; a new turn's snapshot starts fresh", () => {
    const settled = foldMainEvent(foldFixture(FIXTURE), { type: "done", text: "Found it" });
    expect([settled.working, settled.text, settled.asks, settled.thinking]).toEqual([false, "", [], "look at the failing test first"]);
    // The history now carries the prompt: it is not drawn twice.
    const rows = mainRows({ history: [{ role: "user", text: "ship the fix" }, { role: "assistant", text: "Found it" }], turn: settled }, 70);
    expect(rows.filter((r) => r === "› ship the fix")).toHaveLength(1);
    const next = foldMainEvent(settled, { type: "turn-snapshot", snapshot: { turnId: "t2", running: true, prompt: "now test", text: "" } });
    expect([next.turnId, next.thinking, next.tools, next.prompt]).toEqual(["t2", "", [], "now test"]);
  });

  test("an empty session says how to start", () => {
    expect(mainRows({ history: [], turn: idleTurn() }, 40)).toEqual(["", "  no turns yet - press ⏎ and type to talk to Main"]);
  });
});

describe("y / s / d pick the ask's own options", () => {
  const ask = (options: MainAsk["options"]): MainAsk => ({ id: "p", tool: "exec", detail: "x", options });

  test("exec: once, the rest of this turn, block; a standing or danger option is never on a key", () => {
    const a = ask(EXEC_OPTIONS);
    expect([answerOption(a, "y")?.optionId, answerOption(a, "s")?.optionId, answerOption(a, "d")?.optionId]).toEqual(["exec:allow-once", "exec:allow-turn", "exec:deny"]);
  });

  test("egress has no session-length allow: s is not offered, and the key line says so by leaving it out", () => {
    const a = ask(EGRESS_OPTIONS);
    expect(answerOption(a, "s")).toBeNull();
    expect(askKeys(a)).toBe("y Allow once · d Block");
  });

  test("ACP kinds: allow_once, allow_always, reject_once", () => {
    const a = ask(ACP_OPTIONS);
    expect([answerOption(a, "y")?.optionId, answerOption(a, "s")?.optionId, answerOption(a, "d")?.optionId]).toEqual(["proceed_once", "proceed_always", "cancel"]);
  });

  test("an ask with no deny option is denied by sending no option (the engine's fail-closed read)", () => {
    expect(answerOption(ask([{ optionId: "grant:allow", name: "Grant until revoked", kind: "allow" }]), "d")).toEqual({ optionId: null, name: "Deny" });
  });
});

describe("pickers", () => {
  test("model and mode rows keep the engine's order with the current value selected", () => {
    const config = [{ id: "thought_level", options: [{ value: "high" }] }, { id: "model", value: "m-b", options: [{ value: "m-c", name: "C" }, { value: "m-a", name: "A" }, { value: "m-b", name: "B" }] }];
    expect(pickerItems("model", config, null)).toEqual({ items: [{ value: "m-c", name: "C" }, { value: "m-a", name: "A" }, { value: "m-b", name: "B" }], current: "m-b", configId: "model" });
    expect(pickerItems("mode", null, { available: [{ id: "default", name: "Agent" }, { id: "plan", name: "Plan" }], current: "plan" })).toEqual({ items: [{ value: "default", name: "Agent" }, { value: "plan", name: "Plan" }], current: "plan", configId: "" });
    expect(pickerItems("model", "not an array", null).items).toEqual([]);
  });
});

// ---- against a fake engine ------------------------------------------------------------------------

interface Fake {
  record: EngineDiscovery;
  state: { sid: string; busy: string | null; running: boolean; ask: boolean };
  posts: { path: string; body: Record<string, unknown> }[];
  paths: string[];
  /** Resolves with the body of the next POST to `path`. */
  next(path: string): Promise<Record<string, unknown>>;
  stop(): void;
}

let fake: Fake;
let data: string;
const servers: HubServer[] = [];

function fakeEngine(): Fake {
  const state: Fake["state"] = { sid: "s1", busy: null, running: false, ask: false };
  const history: Record<string, { role: string; text: string }[]> = {
    s1: [{ role: "user", text: "first question" }, { role: "assistant", text: "first answer" }],
    s2: [{ role: "user", text: "from the second session" }],
  };
  const posts: Fake["posts"] = [];
  const paths: string[] = [];
  const waiters: { path: string; resolve: (b: Record<string, unknown>) => void }[] = [];
  const held: ReadableStreamDefaultController<Uint8Array>[] = [];
  const enc = new TextEncoder();
  /** NDJSON in ONE chunk; `open` keeps the stream open like a live turn. */
  const ndjson = (events: unknown[], open: boolean) => new Response(new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode(events.map((e) => JSON.stringify(e) + "\n").join("")));
      if (open) held.push(c); else c.close();
    },
  }), { headers: { "content-type": "application/x-ndjson" } });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const p = url.pathname;
      paths.push(p);
      const body = req.method === "POST" ? rec(await req.json().catch(() => ({}))) : {};
      if (req.method === "POST") {
        posts.push({ path: p, body });
        for (const w of waiters.filter((x) => x.path === p)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(body); }
      }
      const snapshot = { turnId: "t1", sessionId: state.sid, startedAt: 1, running: true, prompt: "deploy it", text: "Checking", pending: [] };
      switch (p) {
        case "/api/session/busy": return Response.json({ ok: true, data: { busy: state.busy, sessionId: state.sid } });
        case "/api/sessions": return Response.json({ ok: true, data: { sessions: [{ id: "s1", title: "Release work", turns: 2 }, { id: "s2", title: "Old notes", turns: 1 }] } });
        case "/api/session": return Response.json({ ok: true, data: { messages: history[url.searchParams.get("id") ?? ""] ?? [], total: 2, userTotal: 1 } });
        case "/api/config": return Response.json({ ok: true, data: [{ id: "model", value: "m-b", options: [{ value: "m-a", name: "A" }, { value: "m-b", name: "B" }] }] });
        case "/api/chat/status": return Response.json({ data: state.running ? { turnId: "t1", sessionId: state.sid, startedAt: 1, running: true } : null });
        case "/api/chat/attach":
          return ndjson([{ type: "turn-snapshot", snapshot }, ...(state.ask ? [{ type: "permission", id: "p1", tool: "exec", detail: "rm -rf build", options: EXEC_OPTIONS }] : [])], true);
        case "/api/chat":
          return ndjson([{ type: "token", text: "hel" }, { type: "token", text: "lo" }, { type: "done", text: "hello" }], false);
        case "/api/chat/permission": return Response.json({ ok: true, data: { resolved: true } });
        case "/api/chat/cancel": return Response.json({ ok: true, data: { cancelled: true } });
        case "/api/session/load":
          if (state.busy) return Response.json({ ok: false, busy: state.busy, sessionId: state.sid, error: `Main is busy (${state.busy}). Send force: true to stop it and switch.` }, { status: 409 });
          state.sid = String(body.id);
          return Response.json({ ok: true });
        case "/api/fleet/status": return Response.json({ ok: true, data: { lanes: [{ id: "lane_1", name: "spoke", status: "working" }] } });
        default: return Response.json({});
      }
    },
  });
  return {
    record: { v: 1, pid: process.pid, port: server.port!, nonce: "n", version: "9.9", flavor: "agent", startedAt: new Date().toISOString(), token: "engine-ui-token" },
    state, posts, paths,
    next: (path) => {
      const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
      waiters.push({ path, resolve });
      return promise;
    },
    stop: () => {
      for (const c of held.splice(0)) { try { c.close(); } catch { /* closed */ } }
      void server.stop(true);
    },
  };
}

/** A pane on the fake engine and a way to await its next redraw request. */
function pane(): { p: MainPane; until(pred: () => boolean): Promise<void> } {
  const waiters: (() => void)[] = [];
  const p = new MainPane({ base: `http://127.0.0.1:${fake.record.port}`, token: fake.record.token }, { changed: () => { for (const w of waiters.splice(0)) w(); } });
  const until = async (pred: () => boolean) => {
    while (!pred()) {
      const n = Promise.withResolvers<void>();
      waiters.push(n.resolve);
      await n.promise; // the pane's redraw request is the signal; the test timeout bounds it
    }
  };
  return { p, until };
}

const plain = (rows: string[]) => rows.map((r) => Bun.stripANSI(r)).join("\n");
const codeOf = async (f: () => Promise<unknown>): Promise<string> => {
  try { await f(); return "ok"; } catch (e) { return e instanceof HubOpError ? e.code : `?${String(e)}`; }
};

beforeEach(() => {
  fake = fakeEngine();
  data = mkdtempSync(join(tmpdir(), "herd-main-"));
});
afterEach(async () => {
  for (const s of servers.splice(0)) { s.stop(); await s.done; }
  fake.stop();
  rmSync(data, { recursive: true, force: true });
});

describe("the Main pane on an engine", () => {
  test("it observes a turn another client started, ask included, and y answers it through the permission route", async () => {
    fake.state.running = true;
    fake.state.ask = true;
    const { p, until } = pane();
    await p.refresh();
    await until(() => p.ask() !== null);
    expect(p.ask()).toEqual({ kind: "exec", summary: "rm -rf build" });
    const frame = plain(p.pane(80, 20, true));
    expect(frame).toContain("◆ Main · Release work · 0 spokes");
    expect(frame).toContain("WAITING");
    expect(frame).toContain("› first question");
    expect(frame).toContain("› deploy it");
    expect(frame).toContain("y Allow once (this command) · s Allow for the rest of this turn · d Block");
    // Enter while an ask is parked never opens the composer (a "y" must not become a prompt).
    expect(p.input("\r", true)).toBe(true);
    expect(p.modal()).toBe(false);
    const answered = fake.next("/api/chat/permission");
    expect(p.input("y", false)).toBe(true);
    expect(await answered).toEqual({ id: "p1", optionId: "exec:allow-once" });
    await until(() => p.ask() === null);
    p.stop();
  });

  test("main prompt during an ask is refused agent_blocked and never reaches /api/chat or the permission route", async () => {
    fake.state.running = true;
    fake.state.ask = true;
    const { p } = pane();
    expect(await codeOf(() => p.mainCommand(["main", "prompt", "keep", "going"]))).toBe("agent_blocked");
    expect(fake.posts.map((x) => x.path)).toEqual(["/api/chat/attach"]);
    p.stop();
  });

  test("main prompt rides /api/chat as typed; --wait returns the reply", async () => {
    const { p } = pane();
    expect(await p.mainCommand(["main", "prompt", "say", "hello"])).toEqual({ main: true, accepted: true, event: "token" });
    expect(await p.mainCommand(["main", "prompt", "--wait", "again"])).toEqual({ main: true, accepted: true, done: true, text: "hello" });
    expect(fake.posts.filter((x) => x.path === "/api/chat").map((x) => x.body)).toEqual([{ text: "say hello" }, { text: "again" }]);
    expect(await codeOf(() => p.mainCommand(["main", "prompt"]))).toBe("usage");
    expect(fake.paths).not.toContain("/api/chat/permission");
    p.stop();
  });

  test("session open --as main is refused busy while Main works; once free it swaps the pane's session", async () => {
    const { p } = pane();
    await p.refresh();
    expect(plain(p.pane(80, 20, false))).toContain("› first question");
    fake.state.busy = "a turn is running";
    const lane: HubOp[] = [];
    const local = async (op: HubOp) => { lane.push(op); return { lane: { id: "lane_9" } }; };
    expect(await codeOf(() => p.sessionCommand(["session", "open", "s2", "--as", "main"], local))).toBe("busy");
    expect(p.sessionId).toBe("s1");
    fake.state.busy = null;
    expect(await p.sessionCommand(["session", "open", "s2", "--as", "main"], local)).toEqual({ main: true, session: "s2" });
    const frame = plain(p.pane(80, 20, false));
    expect(frame).toContain("◆ Main · Old notes");
    expect(frame).toContain("› from the second session");
    expect(frame).not.toContain("first question");
    // As a lane is the classic resume; nothing about Main changes.
    await p.sessionCommand(["session", "open", "s1"], local);
    expect(lane).toEqual([{ op: "agent.spawn", session: "s1" }]);
    expect(await p.sessionCommand(["session", "list"], local)).toEqual([
      { id: "s1", title: "Release work", updatedAt: undefined, turns: 2 },
      { id: "s2", title: "Old notes", updatedAt: undefined, turns: 1 },
    ]);
    expect(fake.paths).not.toContain("/api/chat/permission");
    p.stop();
  });

  test("Sessions ⏎ offers the choice: l runs the classic resume, m opens as Main", async () => {
    const { p, until } = pane();
    await p.refresh();
    let resumed = 0;
    p.sessionEnter("s2", "Old notes", () => { resumed++; });
    expect(p.modal()).toBe(true);
    expect(p.hint()).toContain('open "Old notes": l resume as a lane · m open as Main');
    p.input("x", false); // any other key keeps the choice open
    expect(p.modal()).toBe(true);
    p.input("l", false);
    expect([resumed, p.modal()]).toEqual([1, false]);
    p.sessionEnter("s2", "Old notes", () => { resumed++; });
    p.input("m", false);
    await until(() => p.sessionId === "s2");
    expect(resumed).toBe(1);
    p.stop();
  });

  test("the composer sends a typed prompt and the pane shows the reply streaming in", async () => {
    const { p, until } = pane();
    await p.refresh();
    p.input("\r", true);
    expect(p.modal()).toBe(true);
    p.input("hi there", false);
    const sent = fake.next("/api/chat");
    p.input("\r", true);
    expect(await sent).toEqual({ text: "hi there" });
    await until(() => !p.turn.working);
    expect(p.modal()).toBe(false);
  });
});

describe("in a running server", () => {
  test("Main is layout state: rebind puts it in a pane, send-keys cannot type into it, and it survives a restart", async () => {
    fake.state.running = true;
    fake.state.ask = true;
    const attached = { engine: fake.record, spawned: false, child: null };
    const s = startHubServer({ data, classic: null, attached });
    servers.push(s);
    const d = await connectInstance(data, "main");
    if (!d) throw new Error("no handshake");
    const cmd = async (...argv: string[]) => callHub(d, argv);

    const rebound = await cmd("pane", "rebind", "main");
    expect(rebound.status).toBe(200);
    const paneId = String(rec(rebound.body.data).id);
    expect(rec(rebound.body.data).deck).toBe("main");
    const read = await cmd("pane", "read");
    expect(String(rec(read.body.data).title)).toContain("Main");

    const keys = await cmd("send-keys", "-t", paneId, "y", "Enter");
    expect([keys.status, keys.body.error]).toEqual([409, "not_agent"]);
    const blocked = await cmd("main", "prompt", "go");
    expect(blocked.body.error).toBe("agent_blocked");
    expect(fake.paths).not.toContain("/api/chat/permission");
    expect(fake.posts.some((x) => x.path === "/api/chat")).toBe(false);

    s.stop();
    await s.done;
    servers.splice(0);
    const again = startHubServer({ data, classic: null, attached });
    servers.push(again);
    const d2 = await connectInstance(data, "main");
    if (!d2) throw new Error("no handshake");
    const panes = await callHub(d2, ["pane", "list"]);
    expect((Array.isArray(panes.body.data) ? panes.body.data : []).map((x) => rec(x).deck)).toContain("main");
  }, 20_000);
});
