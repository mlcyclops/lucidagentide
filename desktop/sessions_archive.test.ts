// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-SESS-ARCHIVE.1 (ADR-0554): the session index survives a restart (only changed files are re-read),
// archiving moves a session out of the scan without losing it (listed, searchable, readable, restorable),
// and the auto-archive rule never moves a live session.

import { afterAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __resetSessionIndex, __sessionIndexStats, __setSessionIndexStore, archivedSessions, archivePolicy, archiveRootFor, archiveSession,
  autoArchive, deleteSession, flushSessionIndex, listSessions, restoreSession, searchSessions, sessionMessages,
} from "./sessions.ts";

const CWD = "/test/repo";
const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const ln = (o: unknown): string => JSON.stringify(o);
const session = (id: string, said: string, cwd = CWD): string => [
  ln({ type: "session", id, cwd }),
  ln({ type: "message", message: { role: "user", content: [{ type: "text", text: `ask ${id}` }] } }),
  ln({ type: "message", message: { role: "assistant", usage: { input: 1, output: 1 }, model: "anthropic/m", content: [{ type: "text", text: said }] } }),
].join("\n");
const empty = (id: string): string => ln({ type: "session", id, cwd: CWD });

let dirs: string[] = [];
/** A sessions root with one workspace folder; `files` maps name -> [content, age in days]. */
function freshRoot(files: Record<string, [string, number]>): string {
  const base = mkdtempSync(join(tmpdir(), "lucid-sess-arch-"));
  dirs.push(base);
  const root = join(base, "sessions");
  mkdirSync(join(root, "enc"), { recursive: true });
  for (const [name, [content, age]] of Object.entries(files)) {
    const p = join(root, "enc", name);
    writeFileSync(p, content);
    const t = (NOW - age * DAY) / 1000;
    utimesSync(p, t, t);
  }
  return root;
}

beforeEach(() => {
  __setSessionIndexStore(null);
  __resetSessionIndex();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});
afterAll(() => { __setSessionIndexStore(undefined); __resetSessionIndex(); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

test("the saved index answers after a restart: unchanged files are not re-read, a changed one is", async () => {
  const root = freshRoot({ "a.jsonl": [session("a", "alpha reply"), 1], "b.jsonl": [session("b", "bravo reply"), 1] });
  const file = join(root, "..", "index.json");
  __setSessionIndexStore({ file, root });
  expect((await listSessions(CWD, root)).sessions).toHaveLength(2);
  flushSessionIndex();
  expect(existsSync(file)).toBe(true);

  __resetSessionIndex(); // a restart: memory gone, the file stays
  expect((await searchSessions("bravo", { cwd: CWD, root })).hits.map((h) => h.id)).toEqual(["b"]);
  expect(__sessionIndexStats().parses).toBe(0);

  writeFileSync(join(root, "enc", "a.jsonl"), session("a", "alpha changed"));
  __resetSessionIndex();
  expect((await searchSessions("changed", { cwd: CWD, root })).hits.map((h) => h.id)).toEqual(["a"]);
  expect(__sessionIndexStats().parses).toBe(1);
});

test("a malformed or foreign-version index file is ignored and rebuilt, never trusted", async () => {
  const root = freshRoot({ "a.jsonl": [session("a", "alpha"), 1] });
  const file = join(root, "..", "index.json");
  __setSessionIndexStore({ file, root });
  await listSessions(CWD, root);
  flushSessionIndex();
  // A genuine, current index whose only fault is the version: an older parser's titles must not survive.
  const foreign = readFileSync(file, "utf8").replace('"v":1', '"v":999');
  for (const bad of ["{not json", foreign, ln({ v: 1, entries: [["x", { meta: 5 }]] })]) {
    writeFileSync(file, bad);
    __setSessionIndexStore({ file, root });
    __resetSessionIndex();
    expect((await listSessions(CWD, root)).sessions.map((s) => s.id)).toEqual(["a"]);
    expect(__sessionIndexStats().parses).toBe(1);
  }
});

test("archive moves a session out of the list but keeps it counted, searchable, readable and restorable", async () => {
  const root = freshRoot({ "old.jsonl": [session("old", "the forgotten migration"), 40], "new.jsonl": [session("new", "today"), 1] });
  expect(archiveSession("old", { cwd: CWD, root })).toEqual({ ok: true });
  expect(existsSync(join(archiveRootFor(root), "enc", "old.jsonl"))).toBe(true);

  const list = await listSessions(CWD, root);
  expect(list.sessions.map((s) => s.id)).toEqual(["new"]);
  expect(list.archived).toBe(1);
  expect((await archivedSessions(CWD, root)).map((s) => [s.id, s.archived])).toEqual([["old", true]]);
  const hit = (await searchSessions("forgotten", { cwd: CWD, root })).hits;
  expect(hit.map((h) => [h.id, h.archived])).toEqual([["old", true]]);
  expect(sessionMessages("old", 0, root).messages.at(-1)!.text).toBe("the forgotten migration");

  expect(restoreSession("old", root)).toEqual({ ok: true, restored: true });
  expect((await listSessions(CWD, root)).sessions.map((s) => s.id).sort()).toEqual(["new", "old"]);
  expect(restoreSession("old", root)).toEqual({ ok: true, restored: false }); // already back: nothing to do
});

test("archive refuses another workspace's session, and restore never overwrites a file", () => {
  const root = freshRoot({ "x.jsonl": [session("x", "other", "/other/repo"), 40], "y.jsonl": [session("y", "mine"), 40] });
  expect(archiveSession("x", { cwd: CWD, root }).ok).toBe(false);
  expect(archiveSession("y", { cwd: CWD, root }).ok).toBe(true);
  writeFileSync(join(root, "enc", "y.jsonl"), session("y", "a new file took the name"));
  const r = restoreSession("y", root);
  expect(r).toEqual({ ok: true, restored: false }); // the active one wins; the archived copy is untouched
  expect(existsSync(join(archiveRootFor(root), "enc", "y.jsonl"))).toBe(true);
});

test("deleting an archived session removes its file and its count", async () => {
  const root = freshRoot({ "z.jsonl": [session("z", "zulu"), 40] });
  archiveSession("z", { cwd: CWD, root });
  expect(deleteSession("z", CWD, root)).toEqual({ ok: true });
  expect(existsSync(join(archiveRootFor(root), "enc", "z.jsonl"))).toBe(false);
  expect((await listSessions(CWD, root)).archived).toBe(0);
});

test("auto-archive: chats after `days`, spoke and empty sessions after `spokeDays`, live sessions never; dry run moves nothing", async () => {
  const root = freshRoot({
    "chat-old.jsonl": [session("chat-old", "a"), 31],
    "chat-young.jsonl": [session("chat-young", "b"), 20],
    "spoke-8d.jsonl": [session("spoke-8d", "c"), 8],
    "empty-8d.jsonl": [empty("empty-8d"), 8],
    "main-old.jsonl": [session("main-old", "d"), 90],
  });
  const policy = archivePolicy({ auto: true, days: 30, spokeDays: 7 });
  const keep = new Set(["main-old"]);
  const spokes = new Map([["spoke-8d", "Tom"]]);
  expect(await autoArchive(policy, keep, spokes, { root, now: NOW, dryRun: true })).toEqual({ candidates: 3, archived: 0, skipped: 0 });
  expect(existsSync(join(root, "enc", "chat-old.jsonl"))).toBe(true);

  expect(await autoArchive(policy, keep, spokes, { root, now: NOW })).toEqual({ candidates: 3, archived: 3, skipped: 0 });
  expect((await listSessions(CWD, root)).sessions.map((s) => s.id).sort()).toEqual(["chat-young", "main-old"]);
});

test("the policy is clamped: whole days 1-3650, off unless explicitly true", () => {
  expect(archivePolicy({ auto: "yes", days: 0, spokeDays: 99_999.6 })).toEqual({ auto: false, days: 1, spokeDays: 3650 });
  expect(archivePolicy(null)).toEqual({ auto: false, days: 30, spokeDays: 7 });
});
