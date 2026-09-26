// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-PERF.4 (ADR-0131): the incremental session index + tail-first transcript pagination.
// listSessions must stop re-parsing unchanged .jsonl on every sidebar poll (the megabytes-per-poll
// stall found in the battery investigation), and a resume must be able to load only the tail.

import { beforeEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __resetSessionIndex, __sessionIndexStats, listSessions, sessionMessages } from "./sessions.ts";

const CWD = "/test/repo";
const ln = (o: unknown): string => JSON.stringify(o);
const chat = (id: string, texts: string[]): string => [
  ln({ type: "session", id, cwd: CWD }),
  ...texts.flatMap((t, i) => [
    ln({ type: "message", message: { role: "user", content: [{ type: "text", text: `${t} q${i}` }] } }),
    ln({ type: "message", message: { role: "assistant", usage: { input: 1, output: 1 }, model: "anthropic/m", content: [{ type: "text", text: `${t} a${i}` }] } }),
  ]),
].join("\n");

function freshRoot(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "lucid-sess-idx-")); // atomic, random name (js/insecure-temporary-file)
  const dir = join(root, "enc");
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return root;
}

beforeEach(() => __resetSessionIndex());

test("a poll with no changes parses NOTHING (stat-only); a changed file re-parses only itself", () => {
  const root = freshRoot({ "a.jsonl": chat("a", ["one"]), "b.jsonl": chat("b", ["two"]), "c.jsonl": chat("c", ["three"]) });
  try {
    listSessions(CWD, root);
    expect(__sessionIndexStats().parses).toBe(3); // cold scan parses all

    const again = listSessions(CWD, root);
    expect(__sessionIndexStats().parses).toBe(3); // warm poll: zero re-parses
    expect(again.sessions.map((s) => s.id).sort()).toEqual(["a", "b", "c"]); // …and identical results

    // an appended turn (the append-only .jsonl growth pattern) re-parses ONLY that file
    appendFileSync(join(root, "enc", "b.jsonl"), "\n" + ln({ type: "message", message: { role: "assistant", usage: { input: 1, output: 1 }, model: "anthropic/m", content: [{ type: "text", text: "more" }] } }));
    const after = listSessions(CWD, root);
    expect(__sessionIndexStats().parses).toBe(4);
    expect(after.sessions.find((s) => s.id === "b")!.turns).toBe(2); // the fresh parse is REFLECTED, not stale
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// P-FLEET.L17 (found live): the index kept the BARE model id omp writes on assistant rows ("gpt-6-astra",
// provider beside it) and stripped "anthropic/" on top, so the orbit's Recover handed omp an id it did not
// know and every historical spoke came back crashed. The record is the `provider/model` id omp accepts.
test("the session model is the provider/model id omp accepts, never the bare assistant-row id", () => {
  const codex = [
    ln({ type: "session", id: "x", cwd: CWD }),
    ln({ type: "model_change", model: "openai-codex/gpt-6-astra" }),
    ln({ type: "message", message: { role: "user", content: [{ type: "text", text: "fix it" }] } }),
    ln({ type: "message", message: { role: "assistant", usage: { input: 1, output: 1 }, model: "gpt-6-astra", provider: "openai-codex", content: [{ type: "text", text: "on it" }] } }),
  ].join("\n");
  // No provider on the row and no model_change at all: the bare id is all there is, so it stays bare.
  const bare = [
    ln({ type: "session", id: "y", cwd: CWD }),
    ln({ type: "message", message: { role: "user", content: [{ type: "text", text: "hi there" }] } }),
    ln({ type: "message", message: { role: "assistant", usage: { input: 1, output: 1 }, model: "claude-opus-5-5", content: [{ type: "text", text: "hello" }] } }),
  ].join("\n");
  // A bare row after a prefixed model_change restates the same model: the prefix is kept.
  const restated = [
    ln({ type: "session", id: "z", cwd: CWD }),
    ln({ type: "model_change", model: "anthropic/claude-opus-5-5" }),
    ln({ type: "message", message: { role: "user", content: [{ type: "text", text: "hi there" }] } }),
    ln({ type: "message", message: { role: "assistant", usage: { input: 1, output: 1 }, model: "claude-opus-5-5", content: [{ type: "text", text: "hello" }] } }),
  ].join("\n");
  const root = freshRoot({ "x.jsonl": codex, "y.jsonl": bare, "z.jsonl": restated, "a.jsonl": chat("a", ["one"]) });
  try {
    const byId: Record<string, string> = {};
    for (const s of listSessions(CWD, root).sessions) byId[s.id] = s.model;
    expect(byId.x).toBe("openai-codex/gpt-6-astra");
    expect(byId.y).toBe("claude-opus-5-5");
    expect(byId.z).toBe("anthropic/claude-opus-5-5");
    expect(byId.a).toBe("anthropic/m"); // no more "anthropic/" stripping: display shortens, the record does not
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deleted files are pruned from the index; other roots are untouched", () => {
  const rootA = freshRoot({ "a.jsonl": chat("a", ["one"]) });
  const rootB = freshRoot({ "b.jsonl": chat("b", ["two"]) });
  try {
    listSessions(CWD, rootA);
    listSessions(CWD, rootB);
    expect(__sessionIndexStats().entries).toBe(2);
    rmSync(join(rootA, "enc", "a.jsonl"));
    expect(listSessions(CWD, rootA).sessions).toHaveLength(0);
    expect(__sessionIndexStats().entries).toBe(1); // a pruned; b (another root) kept
  } finally {
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  }
});

test("empty/probe sessions are cached too - remembered as skips, not re-parsed every poll", () => {
  const root = freshRoot({ "probe.jsonl": ln({ type: "session", id: "p", cwd: CWD }) });
  try {
    expect(listSessions(CWD, root).sessions).toHaveLength(0);
    expect(__sessionIndexStats().parses).toBe(1);
    listSessions(CWD, root);
    expect(__sessionIndexStats().parses).toBe(1); // the skip verdict was cached
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sessionMessages: limit=0 returns everything; a limit returns the TAIL plus the true total", () => {
  const root = freshRoot({ "long.jsonl": chat("long", ["t1", "t2", "t3", "t4", "t5"]) }); // 10 messages
  try {
    const all = sessionMessages("long", 0, root);
    expect(all.messages).toHaveLength(10);
    expect(all.total).toBe(10);

    const page = sessionMessages("long", 4, root);
    expect(page.total).toBe(10);
    expect(page.messages).toHaveLength(4);
    expect(page.messages[0]!.text).toBe("t4 q3"); // the LAST four, in order
    expect(page.messages[3]!.text).toBe("t5 a4");

    const generous = sessionMessages("long", 99, root);
    expect(generous.messages).toHaveLength(10); // limit above total = everything, no padding
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// omp 18 writes a fixed-width `{ type: "title" }` slot as LINE ONE of every session file, ahead of the
// session record. The sidebar (which scans for the record) kept listing sessions while the transcript
// reader (which trusted line one) matched none of them: every click landed on the empty state.
test("sessionMessages: finds the transcript when an omp 18 title slot precedes the session record", () => {
  const titled = [ln({ type: "title", v: 1, title: "", updatedAt: "2026-09-21T00:00:00.000Z", pad: " ".repeat(180) }), chat("real-id", ["hello"])].join("\n");
  const root = freshRoot({ "2026-09-21T00-00-00-000Z_real-id.jsonl": titled });
  try {
    const page = sessionMessages("real-id", 10, root);
    expect(page.total).toBe(2);
    expect(page.messages[0]).toEqual({ role: "user", text: "hello q0", turn: 1 });
    expect(listSessions(CWD, root).sessions.map((s) => s.id)).toEqual(["real-id"]); // the same id the sidebar hands back
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sessionMessages: unknown id is an empty page, not an error", () => {
  const root = freshRoot({ "a.jsonl": chat("a", ["one"]) });
  try {
    expect(sessionMessages("nope", 10, root)).toEqual({ messages: [], total: 0, userTotal: 0 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
