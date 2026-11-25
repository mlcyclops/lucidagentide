// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-PERF.IDLE1: the shared session file index. One build, then the watcher (or, without one, the fallback rewalk)
// keeps it current without re-stat'ing unchanged files; and the Ask Lucid sweep reads only a bounded head.

import { afterEach, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { __resetSessionFiles, __sessionFilesStats, noteSessionFileChanged, sessionFiles, sessionFilesSync, sessionFilesVersion } from "./session_files.ts";
import { ASK_LUCID_SYSTEM } from "../desktop/ask_lucid.ts";
import { __resetSessionIndex, clearAskLucidSessions } from "../desktop/sessions.ts";

const made: string[] = [];
afterEach(() => {
  __resetSessionIndex(); // resets the file index (and its options) too: every watcher is closed before its folder goes
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

const HOUR = 3_600_000;
const age = (p: string, ms: number): void => { const t = (Date.now() - ms) / 1000; utimesSync(p, t, t); };

/** A sessions root with two workspace folders of aged transcripts, plus files the index must ignore. */
function tree(): { root: string; a: string; b: string } {
  const root = mkdtempSync(join(tmpdir(), "lucid-sess-files-"));
  made.push(root);
  const a = join(root, "enc-a");
  const b = join(root, "enc-b");
  mkdirSync(join(a, "artifacts"), { recursive: true });
  mkdirSync(b, { recursive: true });
  const files: [string, string, number][] = [
    [join(a, "one.jsonl"), "1", 3 * HOUR],
    [join(a, "two.jsonl"), "22", HOUR],
    [join(b, "three.jsonl"), "333", 2 * HOUR],
    [join(a, "notes.txt"), "not a transcript", HOUR],
    [join(a, "artifacts", "deep.jsonl"), "below a workspace folder", HOUR],
    [join(root, "top.jsonl"), "not in a workspace folder", HOUR],
  ];
  for (const [p, body, ms] of files) { writeFileSync(p, body); age(p, ms); }
  return { root, a, b };
}

/** Poll until `cond` holds or the deadline passes. Real time on purpose: the events come from the OS file watcher,
 *  which fake timers cannot drive, and the wait ends as soon as the condition holds. */
async function until(what: string, cond: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 25);
    await promise;
  }
}
const names = async (root: string): Promise<string[]> => (await sessionFiles(root)).map((e) => e.name);

test("one build lists every <dir>/*.jsonl newest first, and nothing else", async () => {
  __resetSessionFiles({ hotMs: 0 });
  const { root, a } = tree();
  const files = await sessionFiles(root);
  expect(files.map((e) => e.name)).toEqual(["two.jsonl", "three.jsonl", "one.jsonl"]);
  expect(files[0]).toMatchObject({ p: join(a, "two.jsonl"), dir: a, name: "two.jsonl", size: 2 });
  expect(sessionFilesSync(root)).toBe(files); // the sync getter answers from the same snapshot
  expect(__sessionFilesStats(root)!.walks).toBe(1);
});

test("concurrent callers share one build; a sync caller with no snapshot walks once and seeds the index", async () => {
  __resetSessionFiles({ hotMs: 0 });
  const t1 = tree();
  const [x, y] = await Promise.all([sessionFiles(t1.root), sessionFiles(t1.root)]);
  expect(x).toBe(y);
  expect(__sessionFilesStats(t1.root)!.walks).toBe(1);

  const t2 = tree();
  expect(sessionFilesSync(t2.root).map((e) => e.name)).toEqual(["two.jsonl", "three.jsonl", "one.jsonl"]);
  expect(await sessionFiles(t2.root)).toHaveLength(3);
  expect(__sessionFilesStats(t2.root)!.walks).toBe(1);
});

test("the watcher keeps it current: an add, an append and a delete each show up and bump the version, with no rewalk", async () => {
  __resetSessionFiles({ hotMs: 0, fallbackMs: HOUR, safetyMs: HOUR });
  const { root, a, b } = tree();
  await sessionFiles(root);
  expect(__sessionFilesStats(root)!.watching).toBe(true);
  const built = __sessionFilesStats(root)!.stats;
  let v = sessionFilesVersion(root);
  await sessionFiles(root);
  expect(__sessionFilesStats(root)!.stats).toBe(built); // a warm query with nothing changed stats no file at all
  expect(sessionFilesVersion(root)).toBe(v);

  writeFileSync(join(b, "four.jsonl"), "4444");
  await until("the new file", async () => (await names(root)).includes("four.jsonl"));
  expect(sessionFilesVersion(root)).toBeGreaterThan(v);
  v = sessionFilesVersion(root);

  appendFileSync(join(a, "one.jsonl"), "11");
  await until("the append", async () => (await sessionFiles(root)).find((e) => e.name === "one.jsonl")?.size === 3);
  expect(sessionFilesVersion(root)).toBeGreaterThan(v);
  v = sessionFilesVersion(root);

  rmSync(join(a, "two.jsonl"));
  await until("the delete", async () => !(await names(root)).includes("two.jsonl"));
  expect(sessionFilesVersion(root)).toBeGreaterThan(v);

  expect((await names(root)).sort()).toEqual(["four.jsonl", "one.jsonl", "three.jsonl"]);
  expect((await sessionFiles(root)).at(-1)!.name).toBe("three.jsonl"); // still newest first: the untouched one is oldest
  expect(__sessionFilesStats(root)!.walks).toBe(1);
}, 30_000);

test("without a watcher it rewalks at most once per fallback window", async () => {
  __resetSessionFiles({ watch: false, hotMs: 0, fallbackMs: HOUR });
  const t1 = tree();
  await sessionFiles(t1.root);
  writeFileSync(join(t1.b, "four.jsonl"), "4444");
  expect(await names(t1.root)).not.toContain("four.jsonl"); // inside the window: no watcher, no rewalk
  expect(__sessionFilesStats(t1.root)).toMatchObject({ walks: 1, watching: false });

  __resetSessionFiles({ watch: false, hotMs: 0, fallbackMs: 0 });
  const t2 = tree();
  await sessionFiles(t2.root);
  writeFileSync(join(t2.b, "four.jsonl"), "4444");
  expect(await names(t2.root)).toContain("four.jsonl"); // the window passed: a full rewalk found it
  expect(__sessionFilesStats(t2.root)!.walks).toBe(2);
});

test("a noted change and a hot file are re-checked on the next query, without a watcher or a rewalk", async () => {
  __resetSessionFiles({ watch: false, fallbackMs: HOUR, safetyMs: HOUR });
  const { root, a, b } = tree();
  await sessionFiles(root);

  rmSync(join(a, "one.jsonl")); // three hours old: not hot, so only the note reveals it
  noteSessionFileChanged(join(a, "one.jsonl"));
  expect(await names(root)).not.toContain("one.jsonl");

  const four = join(b, "four.jsonl");
  writeFileSync(four, "4");
  noteSessionFileChanged(four);
  expect(await names(root)).toContain("four.jsonl");

  appendFileSync(four, "44"); // hot: re-stat'ed without being asked
  expect((await sessionFiles(root)).find((e) => e.name === "four.jsonl")?.size).toBe(3);

  writeFileSync(join(b, "five.jsonl"), "5"); // a hot file's folder is listed again
  expect(await names(root)).toContain("five.jsonl");
  expect(__sessionFilesStats(root)!.walks).toBe(1);
});

test("the Ask Lucid sweep reads only a bounded head: a brief beyond it is never judged, so that file is kept", () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-sess-head-"));
  made.push(root);
  const dir = join(root, "enc");
  mkdirSync(dir);
  const CWD = "/test/repo";
  const ln = (o: unknown): string => JSON.stringify(o);
  const brief = ln({ type: "message", message: { role: "user", content: [{ type: "text", text: `${ASK_LUCID_SYSTEM}\n\nwhat is the gate doing?` }] } });
  const near = join(dir, "near.jsonl");
  const far = join(dir, "far.jsonl");
  writeFileSync(near, [ln({ type: "session", id: "near", cwd: CWD }), brief].join("\n"));
  writeFileSync(far, [ln({ type: "session", id: "far", cwd: CWD }), ln({ type: "custom", pad: "x".repeat(300 * 1024) }), brief].join("\n"));
  age(near, 2 * HOUR);
  age(far, 2 * HOUR);
  expect(clearAskLucidSessions({ cwd: CWD, root })).toEqual({ ok: true, cleared: 1 });
  expect(existsSync(near)).toBe(false);
  expect(existsSync(far)).toBe(true);
});
