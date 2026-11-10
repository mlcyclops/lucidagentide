// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-HERD.4 (ADR-0493, in the Herd add-on since ADR-0535): waits and the event stream over a FAKE
// engine whose /api/fleet/watch streams the test drives by hand. What a script relies on: a wait
// ends on the status it asked for and never on the one the lane rested in before a prompt; a stream
// event is never undone by a slower status read; a lane that leaves ends the wait agent_not_running;
// timeouts and the 5 s stall rule fire on an injected clock (no real timer anywhere); a prompt to a
// lane parked on an ask is refused agent_blocked WITHOUT being sent; events carry metadata only and
// resume from a cursor.

import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callHub, startHubControl } from "../../../harness/launcher/hub_control.ts";
import { HubOpError } from "../../../harness/launcher/hub_spaces.ts";
import { HerdAttention, type HerdAlert } from "../src/attention.ts";
import { LaneFeed, ndjsonResponse, streamHub, type FeedDeps, type LaneTransition, type Timers, type WatchHandlers } from "../src/events.ts";
import { DEFAULT_UNTIL, finalReply, herdWaitCommands, parseHerdVerb, waitLane, waitStep, type FinalReply, type WaitEnd, type WaitsHost } from "../src/waits.ts";

class FakeTimers implements Timers {
  now = 0;
  readonly #due: { at: number; fn: () => void; live: boolean }[] = [];
  after(ms: number, fn: () => void): () => void {
    const e = { at: this.now + ms, fn, live: true };
    this.#due.push(e);
    return () => { e.live = false; };
  }
  advance(ms: number): void {
    this.now += ms;
    for (const e of [...this.#due]) if (e.live && e.at <= this.now) { e.live = false; e.fn(); }
  }
}

/** The engine side: a fleet, one watch stream per followed lane, and status reads. */
class FakeEngine {
  lanes: Record<string, unknown>[] = [];
  readonly streams = new Map<string, WatchHandlers>();
  holdReads = false;
  readonly held: PromiseWithResolvers<Record<string, unknown>[]>[] = [];
  deps(): FeedDeps {
    return {
      openWatch: (laneId, signal, on) => {
        const { promise, resolve } = Promise.withResolvers<void>();
        this.streams.set(laneId, on);
        signal.addEventListener("abort", () => resolve(), { once: true });
        on.opened();
        return promise;
      },
      readLanes: () => {
        if (!this.holdReads) return Promise.resolve(this.lanes.map((l) => ({ ...l })));
        const d = Promise.withResolvers<Record<string, unknown>[]>();
        this.held.push(d);
        return d.promise;
      },
      now: () => 42,
      pause: (_ms, signal) => new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true })),
    };
  }
  /** fleet_lanes' #setStatus: the lane changes, then its watch stream says so. */
  status(id: string, status: string, extra: Record<string, unknown> = {}): void {
    this.lanes = this.lanes.map((l) => (l.id === id ? { ...l, status, ...extra } : l));
    this.streams.get(id)?.event({ type: "status", status });
  }
}

/** Let the feed's read loop and the stream callbacks run (microtasks only, no clock). */
async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

let engine: FakeEngine;
let feed: LaneFeed;
let timers: FakeTimers;

beforeEach(async () => {
  engine = new FakeEngine();
  engine.lanes = [{ id: "lane_1", name: "scout", status: "working", turns: 2 }];
  feed = new LaneFeed(engine.deps(), "b007");
  timers = new FakeTimers();
  feed.snapshot(engine.lanes);
  await settle();
});

const ended = (p: Promise<WaitEnd>): { end: WaitEnd | null } => {
  const box: { end: WaitEnd | null } = { end: null };
  void p.then((e) => { box.end = e; });
  return box;
};

describe("waitStep", () => {
  test("an armed wait ends on an until status and on nothing else", () => {
    expect(waitStep(["done"], true, "working")).toEqual({ armed: true, end: null });
    expect(waitStep(["done"], true, "done")).toEqual({ armed: true, end: { end: "reached", status: "done" } });
  });
  test("a prompt's wait arms on the turn starting, so the status it rested in never ends it", () => {
    expect(waitStep(["done"], false, "done")).toEqual({ armed: false, end: null });
    expect(waitStep(["done"], false, "working")).toEqual({ armed: true, end: null });
    expect(waitStep(["working"], false, "working")).toEqual({ armed: true, end: { end: "reached", status: "working" } });
  });
  test("a lane leaving the fleet ends any wait", () => {
    expect(waitStep(["done"], false, null).end).toEqual({ end: "gone" });
  });
});

describe("the lane feed over a fake watch stream", () => {
  test("a transition the stream missed before it attached is caught by the read on open", async () => {
    const fresh = new LaneFeed(engine.deps(), "b007");
    const seen: LaneTransition[] = [];
    fresh.subscribe(null, (t) => seen.push(t));
    engine.lanes = [{ id: "lane_1", name: "scout", status: "done" }];
    fresh.snapshot([{ id: "lane_1", name: "scout", status: "working" }]); // a stale poll snapshot
    await settle();
    expect(seen.map((t) => [t.from, t.to])).toEqual([[null, "working"], ["working", "done"]]);
    fresh.close();
  });

  test("a status read that started before a stream event never undoes it", async () => {
    const seen: LaneTransition[] = [];
    feed.subscribe("lane_1", (t) => seen.push(t));
    engine.holdReads = true;
    feed.snapshot([]); // disagrees (lane missing): asks for a read, which the engine holds
    await settle();
    engine.status("lane_1", "done"); // pushed while the read is in flight
    engine.held.shift()!.resolve([{ id: "lane_1", name: "scout", status: "working" }]); // answered before the change
    await settle();
    expect(feed.status("lane_1")?.status).toBe("done");
    expect(seen.map((t) => t.to)).toEqual(["done"]);
  });

  test("a lane absent from a fresh read leaves the fleet with to: null", async () => {
    const seen: LaneTransition[] = [];
    feed.subscribe(null, (t) => seen.push(t));
    engine.lanes = [];
    feed.snapshot([]);
    await settle();
    expect(seen.map((t) => [t.lane, t.from, t.to])).toEqual([["lane_1", "working", null]]);
    expect(feed.status("lane_1")).toBeUndefined();
  });

  test("transitions carry metadata only, and cursors resume", async () => {
    const seen: LaneTransition[] = [];
    feed.subscribe(null, (t) => seen.push(t));
    engine.streams.get("lane_1")!.event({ type: "token", text: "the secret reply" });
    engine.status("lane_1", "done");
    engine.status("lane_1", "working");
    expect(seen).toHaveLength(2);
    expect(Object.keys(seen[0]!).sort()).toEqual(["cursor", "from", "lane", "name", "to", "ts"]);
    expect(JSON.stringify(seen)).not.toContain("secret");
    expect(feed.since(seen[0]!.cursor, null).map((t) => t.to)).toEqual(["working"]);
    expect(feed.since("0ffe-1", "lane_1").length).toBeGreaterThan(2); // another server: all retained
    expect(() => feed.since("nope", null)).toThrow(HubOpError);
  });
});

describe("waitLane", () => {
  test("returns at once when the lane is already where the wait asks", async () => {
    engine.status("lane_1", "done");
    const w = waitLane(feed, "lane_1", { until: DEFAULT_UNTIL, armed: true, timeoutMs: null, stallMs: null, timers });
    expect(await w.result).toEqual({ end: "reached", status: "done" });
  });

  test("an agent wait follows the stream to its status", async () => {
    const w = ended(waitLane(feed, "lane_1", { until: ["done"], armed: true, timeoutMs: null, stallMs: null, timers }).result);
    engine.status("lane_1", "needs-approval");
    await settle();
    expect(w.end).toBeNull();
    engine.status("lane_1", "done");
    await settle();
    expect(w.end).toEqual({ end: "reached", status: "done" });
  });

  test("a timeout ends a wait on a working lane, on the injected clock", async () => {
    const w = ended(waitLane(feed, "lane_1", { until: ["done"], armed: true, timeoutMs: 1000, stallMs: null, timers }).result);
    timers.advance(999);
    await settle();
    expect(w.end).toBeNull();
    timers.advance(1);
    await settle();
    expect(w.end).toEqual({ end: "timeout" });
  });

  test("no event at all within the stall window is stalled; any event clears it", async () => {
    const quiet = ended(waitLane(feed, "lane_1", { until: ["done"], armed: false, timeoutMs: null, stallMs: 5000, timers }).result);
    timers.advance(5000);
    await settle();
    expect(quiet.end).toEqual({ end: "stalled" });

    const moving = ended(waitLane(feed, "lane_1", { until: ["done"], armed: false, timeoutMs: null, stallMs: 5000, timers }).result);
    engine.streams.get("lane_1")!.event({ type: "tool", name: "read" });
    timers.advance(10_000);
    await settle();
    expect(moving.end).toBeNull();
  });

  test("a lane that leaves the fleet ends the wait gone", async () => {
    const w = ended(waitLane(feed, "lane_1", { until: ["done"], armed: true, timeoutMs: null, stallMs: null, timers }).result);
    engine.lanes = [];
    feed.snapshot([]);
    await settle();
    expect(w.end).toEqual({ end: "gone" });
  });
});

describe("parseHerdVerb", () => {
  test("a prompt without --wait stays the classic verb", () => {
    expect(parseHerdVerb(["agent", "prompt", "scout", "hello"])).toBeNull();
    expect(parseHerdVerb(["agent", "list"])).toBeNull();
  });
  test("prompt flags lead the lane or follow it; the rest is text", () => {
    expect(parseHerdVerb(["agent", "prompt", "scout", "--wait", "--until", "done,error", "--timeout", "5000", "fix", "--it"])).toEqual({
      verb: "agent.prompt.wait", lane: "scout", text: "fix --it", until: ["done", "error"], timeoutMs: 5000,
    });
    expect(parseHerdVerb(["agent", "prompt", "--wait", "scout", "go"])).toMatchObject({ until: DEFAULT_UNTIL, timeoutMs: null });
  });
  test("usage errors answer before anything is sent", () => {
    for (const argv of [
      ["agent", "prompt", "--until", "done", "scout", "go"],
      ["agent", "wait", "scout", "--until", "idle"],
      ["agent", "wait", "scout", "--timeout", "soon"],
      ["agent", "wait"],
      ["pane", "wait-output", "s1:p1", "--match", "a", "--regex", "b"],
      ["pane", "wait-output", "s1:p1", "--regex", "("],
      ["agent", "events", "extra"],
      ["notify"],
    ]) expect(() => parseHerdVerb(argv)).toThrow(HubOpError);
  });
  test("spawn --wait keeps the spawn flags for the classic grammar", () => {
    expect(parseHerdVerb(["agent", "spawn", "--name", "a", "--wait", "--timeout", "9000"])).toEqual({ verb: "agent.spawn.wait", spawn: ["--name", "a"], timeoutMs: 9000 });
    expect(parseHerdVerb(["agent", "spawn", "--name", "a"])).toBeNull();
  });
});

describe("the control plane passes a streamed reply through (core seam)", () => {
  test("a `commands` verb's Response reaches the client line by line; the parser path still answers JSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "herd-waits-"));
    const ctl = startHubControl({
      dir,
      exec: () => Promise.resolve({ classic: true }),
      commands: (argv) => (argv[0] === "stream"
        ? Promise.resolve(ndjsonResponse(async (write) => { write('{"a":1}'); write(JSON.stringify({ ok: true, data: 2 })); }, timers))
        : undefined),
    });
    try {
      const lines: string[] = [];
      expect(await streamHub(ctl.discovery, ["stream"], (l) => lines.push(l))).toBe(200);
      expect(lines).toEqual(['{"a":1}', '{"ok":true,"data":2}']);
      expect(finalReply(lines.at(-1) ?? null)).toEqual({ ok: true, data: 2 });
      expect((await callHub(ctl.discovery, ["status"])).body).toEqual({ ok: true, data: { classic: true } });
    } finally {
      ctl.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the server verbs", () => {
  let calls: string[][];
  let pane: string[];
  let changes: Set<() => void>;
  let alerts: HerdAlert[];
  let handle: (argv: readonly string[]) => Promise<unknown> | undefined;

  beforeEach(() => {
    calls = [];
    pane = ["SECURITY", "quarantined 0"];
    changes = new Set();
    alerts = [];
    const attention = new HerdAttention({
      focused: () => null,
      clients: () => 1,
      show: () => Promise.resolve(),
      alert: (a) => alerts.push(a),
      settings: () => ({ bell: true, desktop: false, sound: false }),
      now: () => timers.now,
    });
    const host: WaitsHost = {
      feed,
      attention,
      run: async (argv) => {
        calls.push([...argv]);
        if (argv[1] === "status") {
          const l = engine.lanes.find((x) => x.id === argv[2] || x.name === argv[2]);
          if (!l) throw new HubOpError("not_found", `no agent "${argv[2]}"`);
          return { ...l };
        }
        if (argv[1] === "prompt") return { lane: argv[2], accepted: true };
        if (argv[1] === "spawn") {
          engine.lanes.push({ id: "lane_2", name: "fresh", status: "starting", turns: 0 });
          return { lane: { id: "lane_2", name: "fresh", status: "starting" } };
        }
        throw new Error(`unexpected ${argv.join(" ")}`);
      },
      paneDeck: (ref) => (ref === "s1:p1" ? "agent" : "security"),
      paneLines: () => pane,
      onChange: (fn) => { changes.add(fn); return () => { changes.delete(fn); }; },
      timers,
      now: () => timers.now,
    };
    handle = herdWaitCommands(host);
  });

  const respond = async (argv: string[]): Promise<Response> => {
    const r = await handle(argv);
    if (!(r instanceof Response)) throw new Error("expected a streamed reply");
    return r;
  };
  const lastLine = async (res: Response): Promise<FinalReply> => {
    const lines = (await res.text()).split("\n").filter(Boolean);
    return finalReply(lines.at(-1) ?? null);
  };

  test("prompt --wait submits once and returns at done with the turn count", async () => {
    engine.status("lane_1", "done");
    const res = await respond(["agent", "prompt", "--wait", "scout", "next step"]);
    await settle();
    expect(calls.filter((c) => c[1] === "prompt")).toEqual([["agent", "prompt", "lane_1", "next step"]]);
    engine.status("lane_1", "working");
    engine.status("lane_1", "done", { turns: 3 });
    expect(await lastLine(res)).toEqual({ ok: true, data: { lane: "lane_1", name: "scout", status: "done", elapsedMs: 0, turns: 3 } });
  });

  test("a prompt to a lane parked on an ask is refused agent_blocked and nothing is sent", async () => {
    engine.status("lane_1", "needs-approval", { pendingApproval: { summary: "run rm", kind: "exec" } });
    await expect(Promise.resolve(handle(["agent", "prompt", "--wait", "scout", "go on"]))).rejects.toMatchObject({ code: "agent_blocked" });
    expect(calls.some((c) => c[1] === "prompt")).toBe(false);
  });

  test("a lane resting in awaiting-input (fresh or cancelled) is not blocked", async () => {
    engine.status("lane_1", "awaiting-input");
    await respond(["agent", "prompt", "--wait", "scout", "start"]);
    await settle();
    expect(calls.some((c) => c[1] === "prompt")).toBe(true);
  });

  test("no event within 5 s is agent_prompt_stalled", async () => {
    engine.status("lane_1", "done");
    const res = await respond(["agent", "prompt", "--wait", "scout", "anyone?"]);
    await settle();
    timers.advance(5000);
    expect(await lastLine(res)).toMatchObject({ ok: false, body: { error: "agent_prompt_stalled" } });
  });

  test("agent wait --timeout on a working lane returns timeout; a vanished lane is agent_not_running", async () => {
    const slow = await respond(["agent", "wait", "scout", "--until", "done", "--timeout", "1000"]);
    timers.advance(1000);
    expect(await lastLine(slow)).toMatchObject({ ok: false, body: { error: "timeout" } });

    const gone = await respond(["agent", "wait", "scout"]);
    engine.lanes = [];
    feed.snapshot([]);
    expect(await lastLine(gone)).toMatchObject({ ok: false, body: { error: "agent_not_running" } });
  });

  test("spawn --wait returns once the lane leaves starting", async () => {
    const res = await respond(["agent", "spawn", "--name", "fresh", "--wait"]);
    await settle();
    engine.status("lane_2", "awaiting-input");
    expect(await lastLine(res)).toMatchObject({ ok: true, data: { lane: "lane_2", status: "awaiting-input" } });
  });

  test("agent events streams transitions until the client leaves, and resumes from a cursor", async () => {
    const res = await respond(["agent", "events", "--lane", "scout"]);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    engine.status("lane_1", "done");
    const first: LaneTransition = JSON.parse(dec.decode((await reader.read()).value));
    expect(first).toMatchObject({ lane: "lane_1", name: "scout", from: "working", to: "done" });
    engine.status("lane_1", "working");
    await reader.cancel();
    const again = await respond(["agent", "events", "--since", first.cursor]);
    const replay = again.body!.getReader();
    expect(JSON.parse(dec.decode((await replay.read()).value))).toMatchObject({ from: "done", to: "working" });
    await replay.cancel();
  });

  test("pane wait-output matches on a redraw and refuses an agent pane", async () => {
    await expect(Promise.resolve(handle(["pane", "wait-output", "s1:p1", "--match", "x"]))).rejects.toMatchObject({ code: "not_deck" });
    const res = await respond(["pane", "wait-output", "s1:p2", "--regex", "quarantined [1-9]"]);
    pane = ["SECURITY", "quarantined 2"];
    for (const fn of [...changes]) fn();
    expect(await lastLine(res)).toEqual({ ok: true, data: { pane: "s1:p2", line: "quarantined 2", elapsedMs: 0 } });
    expect(changes.size).toBe(0); // the wait let go of the redraw hook
  });

  test("notify is one per lane per 10 s", async () => {
    expect(await handle(["notify", "build", "done", "--lane", "scout"])).toMatchObject({ bell: true, clients: 1 });
    await expect(Promise.resolve(handle(["notify", "again", "--lane", "scout"]))).rejects.toMatchObject({ code: "rate_limited" });
    timers.advance(10_000);
    expect(await handle(["notify", "later", "--lane", "scout"])).toMatchObject({ bell: true });
    expect(alerts).toHaveLength(2);
  });
});
