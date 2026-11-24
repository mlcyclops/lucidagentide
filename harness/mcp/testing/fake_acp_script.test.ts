// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// The fake ACP agent's script mode (QA / video fleet, desktop/scripts/fleet_demo): the picker, the step
// replay and the shipped scripts, all on a virtual clock so a 60 second script tests in milliseconds.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { listSubagentRuns, type SubagentIo } from "../../../desktop/subagent_activity.ts";
import { BUILTIN_DEFAULT_SCRIPT, chunkDelay, chunkProse, parseScript, permissionAllowed, pickScript, replayScript, type FleetScript, type ReplayIo, type ReplayResult } from "./fake_acp_script.ts";

const SCRIPT_DIR = join(import.meta.dir, "..", "..", "..", "desktop", "scripts", "fleet_demo", "scripts");
const shipped = (): { file: string; text: string; script: FleetScript }[] =>
  readdirSync(SCRIPT_DIR).filter((f) => f.endsWith(".json")).sort().map((file) => {
    const text = readFileSync(join(SCRIPT_DIR, file), "utf8");
    return { file, text, script: parseScript(text) };
  });

/** Timers fire in time order, and only once every pending microtask and immediate has run, so concurrent
 *  sleepers (the turn and its background subagents) interleave exactly as on a real clock. */
class VirtualClock {
  now = 0;
  #timers: { at: number; seq: number; resolve: () => void }[] = [];
  #seq = 0;
  sleep = (ms: number): Promise<void> => {
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#timers.push({ at: this.now + ms, seq: this.#seq++, resolve });
    return promise;
  };
  async run<T>(p: Promise<T>): Promise<T> {
    let settled = false;
    p.then(() => { settled = true; }, () => { settled = true; });
    for (;;) {
      const { promise, resolve } = Promise.withResolvers<void>();
      setImmediate(resolve);
      await promise;
      if (settled) return p;
      this.#timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = this.#timers.shift();
      if (!next) throw new Error("replay stalled with no timer pending");
      this.now = next.at;
      next.resolve();
    }
  }
}

interface Harness { io: ReplayIo; clock: VirtualClock; updates: Record<string, unknown>[]; asks: Record<string, unknown>[]; files: Map<string, string> }

function harness(allow: boolean, dir: string | null = "sessions/ws/stamp_sess"): Harness {
  const clock = new VirtualClock();
  const updates: Record<string, unknown>[] = [];
  const asks: Record<string, unknown>[] = [];
  const files = new Map<string, string>();
  const io: ReplayIo = {
    emit: (u) => { updates.push(u); },
    sleep: clock.sleep,
    ask: async (tc) => { asks.push(tc); return allow; },
    transcript: dir ? {
      append: (name, line) => { const p = join(dir, `${name}.jsonl`); files.set(p, `${files.get(p) ?? ""}${line}\n`); },
      finish: (name, md) => { files.set(join(dir, `${name}.md`), md); },
    } : null,
    now: () => 1_790_000_000_000 + clock.now,
    cwd: "/work/sample-platform",
    cancelled: () => false,
  };
  return { io, clock, updates, asks, files };
}

const replay = (h: Harness, s: FleetScript, suffix = ""): Promise<ReplayResult> => h.clock.run(replayScript(s, h.io, { idPrefix: "t1", nameSuffix: suffix }));

const TINY: FleetScript = {
  id: "tiny", title: "tiny", prompt: "tiny", keywords: ["tiny"],
  steps: [
    { type: "say", text: "Looking at it now.\n\n" },
    { type: "read", path: "src/a.ts", output: "export const a = 1;\n", ms: 500 },
    { type: "task", context: "ctx", tasks: [{ name: "Helper", task: "Check the thing.", result: "# Helper\n\nAll good.", steps: [
      { type: "think", text: "Plan the check.", ms: 100 },
      { type: "tool", name: "bash", args: { command: "bun test", i: "Running tests" }, output: "3 pass", ms: 100 },
      { type: "say", text: "Checked.", ms: 100 },
    ] }] },
    { type: "join" },
    { type: "ask", command: "bun run db:migrate", output: "migrated", deny: [{ type: "say", text: "Skipping the migration." }] },
    { type: "edit", path: "src/a.ts", edits: [{ old_text: "1", new_text: "2" }] },
    { type: "usage", used: 1000, size: 200_000, cost: 0.01 },
  ],
};

describe("pickScript", () => {
  const a: FleetScript = { ...BUILTIN_DEFAULT_SCRIPT, id: "a", default: false, keywords: ["pci", "checkout"] };
  const b: FleetScript = { ...BUILTIN_DEFAULT_SCRIPT, id: "b", default: true, keywords: ["release notes"] };
  test("the best keyword match wins, case-insensitively", () => {
    expect(pickScript([a, b], "Ship a PCI-safe CHECKOUT service")?.id).toBe("a");
    expect(pickScript([a, b], "write the Release Notes")?.id).toBe("b");
  });
  test("keywords match whole words only", () => {
    expect(pickScript([a, b], "tune the pcie bus for checkouts")?.id).toBe("b");
  });
  test("an explicit [script id] marker beats keywords", () => {
    expect(pickScript([a, b], "PCI checkout [script b]")?.id).toBe("b");
  });
  test("no match falls back to the default script, then the first", () => {
    expect(pickScript([a, b], "hello")?.id).toBe("b");
    expect(pickScript([a, { ...b, default: false }], "hello")?.id).toBe("a");
    expect(pickScript([], "hello")).toBeNull();
  });
});

describe("streaming helpers", () => {
  test("chunkProse is lossless and splits into several natural chunks", () => {
    const text = "I'll build it security-first: strict validation, no PHI in logs.\n\n```html\n<p>hi</p>\n```\n";
    const chunks = chunkProse(text);
    expect(chunks.join("")).toBe(text);
    expect(chunks.length).toBeGreaterThan(5);
    expect(chunks.every((c) => c.length > 0)).toBe(true);
  });
  test("chunkDelay grows with length and is capped", () => {
    expect(chunkDelay("ab")).toBeLessThan(chunkDelay("a longer chunk"));
    expect(chunkDelay("x".repeat(500))).toBe(160);
    expect(chunkDelay("x".repeat(500), true)).toBe(120);
  });
  test("permissionAllowed only accepts a selected allow option", () => {
    expect(permissionAllowed({ outcome: { outcome: "selected", optionId: "allow" } })).toBe(true);
    expect(permissionAllowed({ outcome: { outcome: "selected", optionId: "deny" } })).toBe(false);
    expect(permissionAllowed({ outcome: { outcome: "cancelled" } })).toBe(false);
    expect(permissionAllowed(undefined)).toBe(false);
  });
});

describe("parseScript", () => {
  const base = { id: "x", title: "x", prompt: "x", keywords: [] };
  test("rejects an unknown step type, naming the step", () => {
    expect(() => parseScript(JSON.stringify({ ...base, steps: [{ type: "dance" }] }))).toThrow("x.steps[0]");
  });
  test("rejects a second ask and an ask inside a deny path", () => {
    const ask = { type: "ask", command: "c", output: "o", deny: [] };
    expect(() => parseScript(JSON.stringify({ ...base, steps: [ask, ask] }))).toThrow("at most one ask");
    expect(() => parseScript(JSON.stringify({ ...base, steps: [{ ...ask, deny: [ask] }] }))).toThrow("cannot ask again");
  });
  test("rejects a subagent name that cannot be a transcript file name", () => {
    const task = { type: "task", context: "c", tasks: [{ name: "../x", task: "t", result: "r", steps: [] }] };
    expect(() => parseScript(JSON.stringify({ ...base, steps: [task] }))).toThrow("malformed task");
  });
});

describe("replayScript", () => {
  test("allowed: tool calls open then settle with their output, the ask runs, usage is reported", async () => {
    const h = harness(true);
    const res = await replay(h, TINY);
    const kinds = h.updates.map((u) => u.sessionUpdate);
    expect(kinds[0]).toBe("agent_message_chunk");
    const read = h.updates.find((u) => u.sessionUpdate === "tool_call" && u.kind === "read")!;
    expect(read.status).toBe("pending");
    expect(read.rawInput).toEqual({ path: "src/a.ts" });
    const settled = h.updates.find((u) => u.sessionUpdate === "tool_call_update" && u.toolCallId === read.toolCallId)!;
    expect(settled.status).toBe("completed");
    expect(settled.rawOutput).toEqual({ output: "export const a = 1;\n" });
    const edit = h.updates.find((u) => u.sessionUpdate === "tool_call" && u.kind === "edit")!;
    expect(edit.rawInput).toEqual({ path: "src/a.ts", edits: [{ old_text: "1", new_text: "2" }] });
    expect(h.asks).toHaveLength(1);
    expect(h.asks[0]!.rawInput).toEqual({ command: "bun run db:migrate", timeout: 300 });
    expect(res.allowed).toBe(true);
    expect(res.text).toBe("Looking at it now.\n\n");
    expect(res.usage).toEqual({ used: 1000, size: 200_000, cost: 0.01 });
    expect(h.updates.at(-1)).toEqual({ sessionUpdate: "usage_update", used: 1000, size: 200_000, cost: { amount: 0.01, currency: "USD" } });
    // every opened call is settled
    const opened = h.updates.filter((u) => u.sessionUpdate === "tool_call").map((u) => u.toolCallId);
    const closed = new Set(h.updates.filter((u) => u.sessionUpdate === "tool_call_update").map((u) => u.toolCallId));
    expect(opened.every((id) => closed.has(id))).toBe(true);
    expect(new Set(opened).size).toBe(opened.length);
  });

  test("denied: the call fails, the deny path streams, and the turn still finishes", async () => {
    const h = harness(false);
    const res = await replay(h, TINY);
    const ask = h.updates.find((u) => u.sessionUpdate === "tool_call" && u.kind === "execute")!;
    const failed = h.updates.find((u) => u.sessionUpdate === "tool_call_update" && u.toolCallId === ask.toolCallId)!;
    expect(failed.status).toBe("failed");
    expect(res.allowed).toBe(false);
    expect(res.text).toContain("Skipping the migration.");
    expect(h.updates.some((u) => u.sessionUpdate === "tool_call" && u.kind === "edit")).toBe(true);
    expect(res.usage).not.toBeNull();
  });

  test("a task call has omp's batch shape and writes transcripts /api/subagents can read", async () => {
    const h = harness(true);
    await replay(h, TINY, "2");
    const task = h.updates.find((u) => u.sessionUpdate === "tool_call" && u.title === "task")!;
    expect(task.rawInput).toEqual({ context: "ctx", tasks: [{ name: "Helper2", agent: "task", task: "Check the thing." }] });
    const memIo: SubagentIo = {
      exists: (p) => p === "sessions/ws/stamp_sess" || h.files.has(p),
      readText: (p) => h.files.get(p) ?? "",
      list: () => [...h.files.keys()].map((p) => p.split(/[\\/]/).at(-1)!),
      mtime: () => 1,
      size: (p) => (h.files.get(p) ?? "").length,
    };
    const runs = listSubagentRuns("sessions/ws/stamp_sess.jsonl", memIo);
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run.name).toBe("Helper2");
    expect(run.done).toBe(true);
    expect(run.assignment.startsWith("Check the thing.")).toBe(true);
    expect(run.model).toBe("lucid-demo/coder-large");
    expect(run.startedAt).toBeGreaterThan(1_790_000_000_000); // the run's own `session` header line
    expect(run.tools).toBe(2); // the bash call and the closing yield
    expect(run.steps.map((s) => s.kind)).toEqual(["thinking", "tool", "text", "tool"]);
    expect(run.steps[1]).toEqual({ kind: "tool", tool: "bash", label: "Running tests" });
    expect(h.files.get(join("sessions/ws/stamp_sess", "Helper2.md"))).toBe("# Helper\n\nAll good.");
  });

  test("join waits for the background subagents before the turn goes on", async () => {
    const h = harness(true);
    const order: string[] = [];
    const io: ReplayIo = { ...h.io, emit: (u) => { if (u.sessionUpdate === "tool_call") order.push(String(u.title)); h.io.emit(u); }, transcript: { append: () => {}, finish: (n) => { order.push(`done ${n}`); } } };
    await h.clock.run(replayScript(TINY, io, { idPrefix: "t1" }));
    expect(order.indexOf("done Helper")).toBeLessThan(order.indexOf("bash bun run db:migrate"));
  });

  test("a cancel stops the replay at the next step", async () => {
    const h = harness(true);
    let calls = 0;
    const io: ReplayIo = { ...h.io, cancelled: () => ++calls > 2 };
    const res = await h.clock.run(replayScript(TINY, io, { idPrefix: "t1" }));
    expect(res.cancelled).toBe(true);
    expect(res.usage).toBeNull();
  });
});

describe("shipped fleet demo scripts", () => {
  const all = shipped();
  const footage = all.filter((s) => !s.script.side);

  test("there are eight footage scripts, with unique ids and exactly one default", () => {
    expect(footage).toHaveLength(8);
    expect(new Set(all.map((s) => s.script.id)).size).toBe(all.length);
    expect(all.filter((s) => s.script.default)).toHaveLength(1);
  });

  // P-BUDDY.1: a side completion (the buddy's ideas) answers at once with the JSON its caller parses.
  for (const { file, script } of all.filter((s) => s.script.side)) {
    test(`${file}: a side answer, quick and parseable`, async () => {
      const h = harness(true);
      const res = await replay(h, script);
      expect(h.clock.now).toBeLessThan(10_000); // streamed prose takes a few virtual seconds; footage takes 40+
      expect(h.asks).toHaveLength(0);
      const reply = JSON.parse(res.text.trim()) as { doing?: unknown; ideas?: { title?: unknown; prompt?: unknown }[] };
      expect(typeof reply.doing).toBe("string");
      expect(reply.ideas?.length).toBe(3);
      for (const i of reply.ideas ?? []) { expect(typeof i.title).toBe("string"); expect(typeof i.prompt).toBe("string"); }
    });
  }

  test("each script's own prompt selects it", () => {
    const scripts = all.map((s) => s.script);
    for (const s of scripts) expect(pickScript(scripts, s.prompt)?.id).toBe(s.id);
  });

  test("no em dashes", () => {
    for (const s of all) expect(s.text.includes("\u2014")).toBe(false);
  });

  for (const { file, script } of footage) {
    test(`${file}: 40 to 90 seconds of activity, one ask, a delegation, usage`, async () => {
      for (const allow of [true, false]) {
        const h = harness(allow);
        const res = await replay(h, script);
        const seconds = h.clock.now / 1000;
        expect(seconds).toBeGreaterThanOrEqual(40);
        expect(seconds).toBeLessThanOrEqual(90);
        expect(h.asks).toHaveLength(1);
        expect(res.usage).not.toBeNull();
        expect(h.updates.some((u) => u.sessionUpdate === "agent_thought_chunk")).toBe(true);
        expect(h.updates.some((u) => u.sessionUpdate === "tool_call" && u.title === "task")).toBe(true);
        expect([...h.files.keys()].filter((p) => p.endsWith(".md")).length).toBeGreaterThan(0);
      }
    });
  }

  test("the mini game ends with a fenced html block holding a working canvas game", async () => {
    const game = all.find((s) => s.script.id === "penalty-shootout-game")!.script;
    const h = harness(true);
    const res = await replay(h, game);
    expect(res.text).toMatch(/```html\n<!doctype html>[\s\S]*<canvas[\s\S]*addEventListener\('click'[\s\S]*<\/html>\n```\n$/);
  });
});
