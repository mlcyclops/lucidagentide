// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/code_activity.test.ts — ADR-0030 P-CODE.1: git workspace diffstat.
//
// The numstat PARSER is the keystone (over-tested): renames, binary files, dedup,
// blank separators, CRLF. The codeActivity() integration is exercised against a real
// throwaway git repo created UNDER homedir() — because codeActivity confines every
// workspace to the home subtree (pathWithin, ADR-0022/0023), and on Linux CI the
// system tmpdir (/tmp) is OUTSIDE home and would be (correctly) omitted.

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, parse } from "node:path";
import { homedir } from "node:os";
import { __resetCodeActivity, activityKey, cachedCodeActivity, codeActivity, parseNumstat, renamedPath, setCodeActivityStore } from "../tools/memory_data.ts";

const cleanup: string[] = [];
afterAll(() => { for (const d of cleanup) try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } });

const git = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
const gitAvailable = Bun.spawnSync(["git", "--version"], { stdout: "pipe", stderr: "pipe" }).success;

/** A throwaway git repo UNDER home (so pathWithin admits it on every platform). */
function tmpRepoUnderHome(): string {
  const dir = mkdtempSync(join(homedir(), ".lucid-codeact-test-"));
  cleanup.push(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t.test");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "commit.gpgsign", "false");
  return dir;
}

// ── pure parser (keystone) ────────────────────────────────────────────────────

test("parseNumstat: sums adds/deletes and collects the file set", () => {
  const out = "12\t3\tsrc/a.ts\n\n4\t0\tsrc/b.ts\n";
  const r = parseNumstat(out);
  expect(r.added).toBe(16);
  expect(r.deleted).toBe(3);
  expect(r.files).toEqual(["src/a.ts", "src/b.ts"]);
});

test("parseNumstat: binary files (- -) count as touched but add no lines", () => {
  const r = parseNumstat("-\t-\tlogo.png\n5\t2\tsrc/a.ts\n");
  expect(r.added).toBe(5);
  expect(r.deleted).toBe(2);
  expect(r.files).toContain("logo.png");
  expect(r.files.length).toBe(2);
});

test("parseNumstat: dedups a file touched across multiple commits", () => {
  const r = parseNumstat("10\t0\tsrc/a.ts\n\n5\t3\tsrc/a.ts\n");
  expect(r.added).toBe(15);
  expect(r.deleted).toBe(3);
  expect(r.files).toEqual(["src/a.ts"]); // one distinct file
});

test("parseNumstat: rename rows normalize to the final path (no double count)", () => {
  const r = parseNumstat("1\t1\tsrc/old.ts => src/new.ts\n2\t0\tsrc/{a => b}/x.ts\n");
  expect(r.files).toEqual(["src/b/x.ts", "src/new.ts"]);
});

test("parseNumstat: ignores blank lines and stray non-numstat rows", () => {
  const r = parseNumstat("\n\nnot a row\n3\t1\tf.ts\r\n");
  expect(r.added).toBe(3);
  expect(r.deleted).toBe(1);
  expect(r.files).toEqual(["f.ts"]); // CRLF stripped
});

test("renamedPath: handles plain, brace, and non-rename forms", () => {
  expect(renamedPath("a.ts => b.ts")).toBe("b.ts");
  expect(renamedPath("src/{old => new}/x.ts")).toBe("src/new/x.ts");
  expect(renamedPath("dir/{ => sub}/x.ts")).toBe("dir/sub/x.ts");
  expect(renamedPath("plain/path.ts")).toBe("plain/path.ts");
});

// ── codeActivity() shape + fail-closed ────────────────────────────────────────

test("codeActivity: always returns the pinned shape (month, daysInMonth, totals)", async () => {
  const ca = await codeActivity({ workspaces: [], now: new Date(2026, 5, 15) }); // June 2026
  expect(ca.month).toBe("June 2026");
  expect(ca.daysInMonth).toBe(30);
  expect(ca.workspaces).toEqual([]);
  expect(ca.totals).toEqual({ added: 0, deleted: 0, files: 0 });
});

test("codeActivity: a non-git dir is omitted (fail-closed, never faked)", async () => {
  const dir = mkdtempSync(join(homedir(), ".lucid-nogit-test-"));
  cleanup.push(dir);
  const ca = await codeActivity({ workspaces: [dir] });
  expect(ca.workspaces).toEqual([]);
});

test("codeActivity: a path outside the home subtree is omitted (pathWithin)", async () => {
  const outside = join(parse(homedir()).root, "definitely-not-under-home-xyz");
  const ca = await codeActivity({ workspaces: [outside] });
  expect(ca.workspaces).toEqual([]);
});

test.skipIf(!gitAvailable)("codeActivity: real repo → workspace listed with diffstat for this month", async () => {
  const repo = tmpRepoUnderHome();
  writeFileSync(join(repo, "a.ts"), "one\ntwo\nthree\n", "utf8");
  mkdirSync(join(repo, "node_modules"), { recursive: true });
  writeFileSync(join(repo, "node_modules", "dep.js"), "junk\nchurn\n", "utf8"); // must be EXCLUDED
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "seed");

  const ca = await codeActivity({ workspaces: [repo] });
  expect(ca.workspaces.length).toBe(1);
  const ws = ca.workspaces[0]!;
  expect(ws.added).toBe(3);              // a.ts only — node_modules churn excluded
  expect(ws.deleted).toBe(0);
  expect(ws.files).toBe(1);
  expect(ws.spend).toBe(0);             // spend attribution is P-CODE.2
  expect(ws.name).toBe(repo.split(/[\\/]/).pop() ?? "");
  expect(ca.totals).toEqual({ added: 3, deleted: 0, files: 1 });
});

// P-PERF.GIT1: the month total is remembered per repo until its HEAD moves, so a poll costs no git spawn, but a new
// commit (or a checkout) is never missed.
test.skipIf(!gitAvailable)("codeActivity: a repo whose HEAD did not move is not asked again; a new commit is counted", async () => {
  const repo = tmpRepoUnderHome();
  writeFileSync(join(repo, "a.ts"), "one\ntwo\n", "utf8");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "seed");
  const first = await codeActivity({ workspaces: [repo] });
  expect(first.totals).toEqual({ added: 2, deleted: 0, files: 1 });
  const k1 = await activityKey(repo, new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  expect(k1).not.toBeNull();

  // Nothing moved: the same total, and the key it is remembered under is unchanged.
  const again = await codeActivity({ workspaces: [repo] });
  expect(again.totals).toEqual(first.totals);
  expect(await activityKey(repo, new Date(new Date().getFullYear(), new Date().getMonth(), 1))).toBe(k1);

  // The commit appends a reflog line, so the key changes by size even within one mtime tick.
  writeFileSync(join(repo, "b.ts"), "x\ny\nz\n", "utf8");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "more");
  const after = await codeActivity({ workspaces: [repo] });
  expect(after.totals).toEqual({ added: 5, deleted: 0, files: 2 });
});

test("activityKey: no reflog (not a repo) gives no key (codeActivity falls back to a 10 minute clock)", async () => {
  const dir = mkdtempSync(join(homedir(), ".lucid-nokey-test-"));
  cleanup.push(dir);
  expect(await activityKey(dir, new Date())).toBeNull();
});

test.skipIf(!gitAvailable)("codeActivity: commits before this month are excluded by the window", async () => {
  const repo = tmpRepoUnderHome();
  writeFileSync(join(repo, "old.ts"), "x\n", "utf8");
  git(repo, "add", "-A");
  // Backdate the commit well before the current month.
  const past = "2020-01-15T12:00:00";
  git(repo, "-c", `user.name=Test`, "commit", "-q", "-m", "old", "--date", past);
  Bun.spawnSync(["git", "commit", "--amend", "--no-edit", "--date", past], { cwd: repo, env: { ...process.env, GIT_COMMITTER_DATE: past } });

  const ca = await codeActivity({ workspaces: [repo] });
  expect(ca.workspaces).toEqual([]); // nothing landed THIS month
});

test.skipIf(!gitAvailable)("codeActivity: confirms our own .git layout is detected", () => {
  // sanity: the helper actually produced a git repo
  const repo = tmpRepoUnderHome();
  expect(existsSync(join(repo, ".git"))).toBe(true);
});

// P-PERF.IDLE1: opening LUCID shows the last count without running git. The counts survive a restart through the
// store, and the cached read never recounts: a commit made after the count only shows once the user asks again.
test.skipIf(!gitAvailable)("cachedCodeActivity: serves the stored count after a restart and never recounts on its own", async () => {
  const repo = tmpRepoUnderHome();
  const storeDir = mkdtempSync(join(homedir(), ".lucid-codeact-store-"));
  cleanup.push(storeDir);
  const store = join(storeDir, "code-activity.json");
  setCodeActivityStore(store);
  try {
    __resetCodeActivity();
    expect((await cachedCodeActivity()).countedAt).toBeNull();
    writeFileSync(join(repo, "a.ts"), "one\ntwo\n", "utf8");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "seed");
    const counted = await codeActivity({ workspaces: [repo] });
    expect(counted.totals).toEqual({ added: 2, deleted: 0, files: 1 });
    expect(existsSync(store)).toBe(true);

    __resetCodeActivity(); // a restart: memory empty, the store remains
    writeFileSync(join(repo, "b.ts"), "x\ny\nz\n", "utf8");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "more");
    const cached = await cachedCodeActivity();
    expect(cached.workspaces.find((w) => w.path === counted.workspaces[0]!.path)?.added).toBe(2);
    expect(cached.countedAt).toBe(counted.countedAt);

    const recount = await codeActivity({ workspaces: [repo] });
    expect(recount.totals).toEqual({ added: 5, deleted: 0, files: 2 });
  } finally {
    setCodeActivityStore(null);
    __resetCodeActivity();
  }
});
