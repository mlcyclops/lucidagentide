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

test("sessionMessages: unknown id is an empty page, not an error", () => {
  const root = freshRoot({ "a.jsonl": chat("a", ["one"]) });
  try {
    expect(sessionMessages("nope", 10, root)).toEqual({ messages: [], total: 0 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
