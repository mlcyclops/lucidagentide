// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/turn_journal.test.ts - P-REMOTE.16 (ADR-0431): the seq-numbered rich turn journal and the
// replay bounder. Pure, headless.

import { describe, expect, it } from "bun:test";
import { MAX_TOOLS_PER_TURN, THINKING_CLIP, TOOL_CODE_CLIP, TOOL_INPUT_CLIP, TRANSCRIPT_CLIP, TurnJournal, boundTranscript } from "./turn_journal.ts";
import type { CollabTranscriptTurn } from "./frames.ts";

describe("TurnJournal seq minting", () => {
  it("user=1, assistant minted lazily=2, next user settles the live turn and takes 3", () => {
    const j = new TurnJournal();
    expect(j.user("hi")).toBe(1);
    expect(j.live()).toBeNull(); // nothing minted until the answer starts
    expect(j.fold({ type: "token", text: "he" })).toBe(2);
    expect(j.fold({ type: "token", text: "llo" })).toBe(2);
    expect(j.live()).toEqual({ role: "assistant", text: "hello", seq: 2, live: true });
    expect(j.lastSettledSeq()).toBe(1);
    expect(j.user("again", "bob")).toBe(3);
    expect(j.live()).toBeNull();
    const { turns } = j.since();
    expect(turns.map((t) => [t.seq, t.role, t.text])).toEqual([[1, "user", "hi"], [2, "assistant", "hello"], [3, "user", "again"]]);
    expect(turns[2].from).toBe("bob");
    expect(turns[0].from).toBeUndefined();
  });

  it("status events fold to null and mint nothing", () => {
    const j = new TurnJournal();
    expect(j.fold({ type: "usage", used: 1, size: 2, cost: 0 })).toBeNull();
    expect(j.fold({ type: "tool-meta", id: "x", name: "bash", ok: true })).toBeNull(); // no live turn
    expect(j.fold({ type: "done" })).toBeNull(); // nothing streamed, nothing said
    expect(j.live()).toBeNull();
    expect(j.user("q")).toBe(1); // the next seq was never consumed
  });
});

describe("TurnJournal folding", () => {
  it("folds token/thinking/tool/tool-meta/block/done into one rich settled turn", () => {
    const j = new TurnJournal();
    j.user("do it");
    expect(j.fold({ type: "thinking", text: "plan " })).toBe(2);
    expect(j.fold({ type: "thinking", text: "more" })).toBe(2);
    expect(j.fold({ type: "tool", id: "t1", name: "edit", detail: "a.ts", code: { path: "a.ts", oldText: "a\nb\n", newText: "a\nc\nd\n" }, intent: "Fixing it" })).toBe(2);
    expect(j.fold({ type: "tool", id: "t2", name: "bash", detail: "ls", input: "ls -la" })).toBe(2);
    expect(j.fold({ type: "tool-meta", id: "t1", name: "edit", ok: true, elapsedMs: 42 })).toBe(2);
    expect(j.fold({ type: "tool-meta", id: "nope", name: "x", ok: false })).toBeNull(); // unknown id: ignored
    expect(j.fold({ type: "block", tool: "bash", reason: "secret", severity: "high", findings: "" })).toBe(2);
    expect(j.fold({ type: "token", text: "streamed" })).toBe(2);
    expect(j.fold({ type: "done", text: "authoritative" })).toBe(2);
    expect(j.live()).toBeNull();
    const turn = j.since().turns[1];
    expect(turn.seq).toBe(2);
    expect(turn.text).toBe("authoritative");
    expect(turn.thinking).toBe("plan more");
    expect(turn.blocks).toEqual([{ reason: "secret", severity: "high" }]);
    expect(turn.tools).toEqual([
      { id: "t1", name: "edit", detail: "a.ts", code: { path: "a.ts", oldText: "a\nb\n", newText: "a\nc\nd\n" }, intent: "Fixing it", ok: true, elapsedMs: 42, add: 2, del: 1 },
      { id: "t2", name: "bash", detail: "ls", input: "ls -la" },
    ]);
  });

  it("done without text keeps the streamed text; no-response settles an empty turn", () => {
    const j = new TurnJournal();
    j.fold({ type: "token", text: "partial" });
    expect(j.fold({ type: "done" })).toBe(1);
    expect(j.since().turns[0]).toEqual({ role: "assistant", text: "partial", seq: 1 });
    expect(j.fold({ type: "no-response", model: "m" })).toBe(2);
    expect(j.since().turns[1]).toEqual({ role: "assistant", text: "", seq: 2 });
  });

  it("live() and since() hand out copies that cannot reach journal state", () => {
    const j = new TurnJournal();
    j.fold({ type: "tool", id: "t1", name: "write", detail: "f", code: { path: "f", content: "x\n" } });
    const live = j.live()!;
    live.tools![0].code!.content = "TAMPERED";
    live.text = "TAMPERED";
    expect(j.live()!.tools![0].code!.content).toBe("x\n");
    expect(j.live()!.text).toBe("");
    j.fold({ type: "done", text: "ok" });
    const got = j.since().turns;
    got[0].tools!.length = 0;
    got.length = 0;
    expect(j.since().turns[0].tools!.length).toBe(1);
  });

  it("caps text, thinking, code, input and the tool count per turn", () => {
    const j = new TurnJournal();
    j.fold({ type: "token", text: "a".repeat(TRANSCRIPT_CLIP + 500) });
    j.fold({ type: "token", text: "b" }); // past the cap: not appended
    j.fold({ type: "thinking", text: "t".repeat(THINKING_CLIP + 10) });
    for (let i = 0; i < MAX_TOOLS_PER_TURN + 5; i++) {
      j.fold({ type: "tool", id: `t${i}`, name: "write", detail: "big", code: { path: "p", content: "c".repeat(TOOL_CODE_CLIP + 10) }, input: "i".repeat(TOOL_INPUT_CLIP + 10) });
    }
    j.fold({ type: "done" });
    const turn = j.since().turns[0];
    expect(turn.text.length).toBe(TRANSCRIPT_CLIP + 1); // clip + ellipsis
    expect(turn.text.endsWith("\u2026")).toBe(true);
    expect(turn.thinking!.length).toBe(THINKING_CLIP + 1);
    expect(turn.tools!.length).toBe(MAX_TOOLS_PER_TURN);
    expect(turn.tools![0].code!.content!.length).toBe(TOOL_CODE_CLIP + 1);
    expect(turn.tools![0].input!.length).toBe(TOOL_INPUT_CLIP + 1);
    expect(turn.tools![0].add).toBe(1); // diffstat sized from the UNCLIPPED one-line content
  });
});

describe("TurnJournal since() windows + eviction", () => {
  function filled(maxTurns: number, n: number): TurnJournal {
    const j = new TurnJournal({ maxTurns });
    for (let i = 0; i < n; i++) j.user(`u${i + 1}`);
    return j;
  }

  it("returns only turns after since, complete while nothing after since was evicted", () => {
    const j = filled(10, 6);
    const r = j.since(4);
    expect(r.turns.map((t) => t.seq)).toEqual([5, 6]);
    expect(r.complete).toBe(true);
    expect(j.since(6)).toEqual({ turns: [], complete: true });
    expect(j.since(0).turns.length).toBe(6);
  });

  it("flags complete=false once a turn after since fell out of the window", () => {
    const j = filled(4, 10); // retains 7..10, evicted through 6
    expect(j.since().turns.map((t) => t.seq)).toEqual([7, 8, 9, 10]);
    expect(j.since().complete).toBe(true); // a fresh window is complete by definition
    expect(j.since(6)).toMatchObject({ complete: true });
    expect(j.since(6).turns.map((t) => t.seq)).toEqual([7, 8, 9, 10]);
    expect(j.since(5).complete).toBe(false);
    expect(j.since(0).complete).toBe(false);
    expect(j.since(10).complete).toBe(true);
    expect(j.lastSettledSeq()).toBe(10);
  });

  it("appends the live turn last, after since, marked live", () => {
    const j = filled(10, 3);
    j.fold({ type: "token", text: "wip" });
    const r = j.since(2);
    expect(r.turns.map((t) => [t.seq, !!t.live])).toEqual([[3, false], [4, true]]);
    expect(j.since(4).turns.map((t) => t.seq)).toEqual([4]); // the live turn always rides
  });
});

describe("boundTranscript", () => {
  const big = (n: number) => "x".repeat(n);
  function turn(i: number, opts: { code?: number; thinking?: number } = {}): CollabTranscriptTurn {
    const t: CollabTranscriptTurn = { role: "assistant", text: `turn ${i}`, seq: i };
    if (opts.thinking) t.thinking = big(opts.thinking);
    if (opts.code) t.tools = [{ id: `t${i}`, name: "write", detail: "f", code: { path: `f${i}.ts`, content: big(opts.code) }, add: 7, del: 2 }];
    return t;
  }

  it("returns untrimmed copies when under budget", () => {
    const input = [turn(1, { code: 100, thinking: 50 })];
    const r = boundTranscript(input, 10_000);
    expect(r.trimmed).toBe(false);
    expect(r.turns).toEqual(input);
    r.turns[0].tools![0].code!.content = "TAMPERED";
    expect(input[0].tools![0].code!.content).toBe(big(100)); // never mutates its input
  });

  it("sheds code bodies oldest-first (path + add/del survive) before touching thinking", () => {
    const input = [turn(1, { code: 1000, thinking: 100 }), turn(2, { code: 1000, thinking: 100 })];
    // Budget fits everything but the first code body.
    const full = JSON.stringify(input).length;
    const r = boundTranscript(input, full - 500);
    expect(r.trimmed).toBe(false);
    expect(r.turns[0].tools![0].code).toEqual({ path: "f1.ts" });
    expect(r.turns[0].tools![0]).toMatchObject({ add: 7, del: 2 });
    expect(r.turns[1].tools![0].code!.content).toBe(big(1000)); // the newer body is kept
    expect(r.turns[0].thinking).toBe(big(100)); // thinking untouched while code could still go
  });

  it("then sheds thinking oldest-first, and only then drops whole turns (trimmed=true)", () => {
    const input = [turn(1, { code: 1000, thinking: 1000 }), turn(2, { code: 1000, thinking: 1000 }), turn(3, { thinking: 1000 })];
    const bare = JSON.stringify(input.map((t) => ({ ...t, thinking: undefined, tools: t.tools?.map((x) => ({ ...x, code: { path: x.code!.path } })) }))).length;
    // Enough for everything stripped of code + the newest two thinkings, so only turn 1's thinking goes.
    const r1 = boundTranscript(input, bare + 2 * 1000 + 100);
    expect(r1.trimmed).toBe(false);
    expect(r1.turns.length).toBe(3);
    expect(r1.turns.every((t) => !t.tools || t.tools[0].code!.content === undefined)).toBe(true);
    expect(r1.turns[0].thinking).toBeUndefined();
    expect(r1.turns[1].thinking).toBe(big(1000));
    expect(r1.turns[2].thinking).toBe(big(1000));
    // Not even the stripped turns fit: the oldest turn is dropped.
    const r2 = boundTranscript(input, bare - 10);
    expect(r2.trimmed).toBe(true);
    expect(r2.turns.map((t) => t.seq)).toEqual([2, 3]);
    expect(r2.turns.every((t) => t.thinking === undefined)).toBe(true);
  });
});
