// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/git_sweep.test.ts - P-OWN.1: sweeping git command detection and the gate decision.

import { describe, expect, test } from "bun:test";
import { gitSweeps, sweepDecision } from "./git_sweep.ts";

const ME = { id: "master", name: "Hub" };
const A = { id: "lane-a", name: "Alpha" };
const B = { id: "lane-b", name: "Bravo" };

const kinds = (cmd: string) => gitSweeps(cmd).map((s) => s.kind);

describe("gitSweeps", () => {
  test("git add -A in a compound command, with the segment text", () => {
    const sweeps = gitSweeps("git add -A && git commit -m x");
    expect(sweeps).toEqual([{ kind: "add-all", text: "git add -A" }]);
  });

  test("add sweeps: dot, --all, -u, --update, :/, clustered flags", () => {
    expect(kinds("git add . ")).toEqual(["add-all"]);
    expect(kinds("git add --all")).toEqual(["add-all"]);
    expect(kinds("git add -u")).toEqual(["add-update"]);
    expect(kinds("git add --update src")).toEqual(["add-update"]);
    expect(kinds("git add :/")).toEqual(["add-all"]);
    expect(kinds("git add -vA")).toEqual(["add-all"]);
  });

  test("git add with explicit paths is not a sweep", () => {
    expect(kinds("git add src/a.ts")).toEqual([]);
    expect(kinds("git add -v src/a.ts src/b.ts")).toEqual([]);
    expect(kinds("git add -- src/a.ts")).toEqual([]);
  });

  test("commit -a in its spellings; plain commit -m is not", () => {
    expect(kinds("git commit -am msg")).toEqual(["commit-all"]);
    expect(kinds("git commit -qa -m x")).toEqual(["commit-all"]);
    expect(kinds("git commit --all -m x")).toEqual(["commit-all"]);
    expect(kinds("git commit -a")).toEqual(["commit-all"]);
    expect(kinds("git commit -m x")).toEqual([]);
    expect(kinds("git commit --amend --author=me -m x")).toEqual([]);
  });

  test("a -C directory rides the sweep so the gate can resolve the checkout it lands in", () => {
    expect(gitSweeps("git -C /repo add --all")).toEqual([{ kind: "add-all", text: "git -C /repo add --all", dir: "/repo" }]);
    expect(gitSweeps("git -Csub commit -am x")[0]!.dir).toBe("sub");
    expect(gitSweeps("git -C a -C b add .")[0]!.dir).toBe("b"); // the last one wins, as in git
    expect(gitSweeps("git add -A")[0]!.dir).toBeUndefined();
  });

  test("global options before the subcommand are skipped", () => {
    expect(kinds("git -C /repo add --all")).toEqual(["add-all"]);
    expect(kinds("git -c user.name=x -C /repo --no-pager commit -am wip")).toEqual(["commit-all"]);
    expect(kinds("git --git-dir=/repo/.git --work-tree /repo add .")).toEqual(["add-all"]);
  });

  test("stash: bare, push, save sweep; pathspec forms and other subcommands do not", () => {
    expect(kinds("git stash")).toEqual(["stash-all"]);
    expect(kinds("git stash push")).toEqual(["stash-all"]);
    expect(kinds("git stash push -m wip")).toEqual(["stash-all"]);
    expect(kinds("git stash -u")).toEqual(["stash-all"]);
    expect(kinds("git stash save 'work in progress'")).toEqual(["stash-all"]);
    expect(kinds("git stash push -- a.ts")).toEqual([]);
    expect(kinds("git stash push a.ts")).toEqual([]);
    expect(kinds("git stash -- a.ts")).toEqual([]);
    expect(kinds("git stash list")).toEqual([]);
    expect(kinds("git stash pop")).toEqual([]);
    expect(kinds("git stash show -p")).toEqual([]);
  });

  test("first token must be git (or a path to git)", () => {
    expect(kinds("echo git add -A")).toEqual([]);
    expect(kinds("/usr/bin/git add -A")).toEqual(["add-all"]);
    expect(kinds('"C:\\Program Files\\Git\\bin\\git.exe" add -A')).toEqual(["add-all"]);
    expect(kinds("'C:\\Program Files\\Git\\bin\\git.exe' add -A")).toEqual(["add-all"]);
    expect(kinds("GIT_AUTHOR_NAME=x git add -A")).toEqual(["add-all"]);
  });

  test("quotes keep separators inside messages from splitting; multiple sweeps are all reported", () => {
    expect(kinds(`git commit -m "fix; git add -A && more" src/a.ts`)).toEqual([]);
    expect(kinds("git add -A; git commit -am 'a && b'")).toEqual(["add-all", "commit-all"]);
    expect(kinds("git status\ngit stash\n")).toEqual(["stash-all"]);
    expect(kinds("(cd sub && git add .)")).toEqual(["add-all"]);
  });

  test("non-git and read-only git commands produce nothing", () => {
    expect(kinds("bun test")).toEqual([]);
    expect(kinds("git status --short | cat")).toEqual([]);
    expect(kinds("git")).toEqual([]);
    expect(kinds("")).toEqual([]);
  });
});

describe("sweepDecision", () => {
  const sweeps = gitSweeps("git add -A");

  test("no sweeps: allowed even with foreign dirty files", () => {
    expect(sweepDecision({ sweeps: [], me: ME, dirty: [{ path: "a.ts", owner: A }] })).toEqual({ block: false });
  });

  test("sweeps over only my files and unowned files: allowed", () => {
    const r = sweepDecision({ sweeps, me: ME, dirty: [{ path: "mine.ts", owner: ME }, { path: "README.md", owner: null }] });
    expect(r).toEqual({ block: false });
  });

  test("sweeps over foreign files: blocked with owners, files, unowned warning and explicit git add", () => {
    const r = sweepDecision({
      sweeps,
      me: ME,
      dirty: [
        { path: "src/z.ts", owner: A },
        { path: "src/a.ts", owner: A },
        { path: "docs/b.md", owner: B },
        { path: "src/mine two.ts", owner: ME },
        { path: "src/mine.ts", owner: ME },
        { path: "README.md", owner: null },
      ],
    });
    expect(r.block).toBe(true);
    const reason = r.reason ?? "";
    expect(reason.startsWith("Refused: `git add -A`")).toBe(true);
    expect(reason).toContain(`- "Alpha" (lane-a): src/a.ts, src/z.ts`);
    expect(reason).toContain(`- "Bravo" (lane-b): docs/b.md`);
    expect(reason.indexOf("Alpha")).toBeLessThan(reason.indexOf("Bravo"));
    expect(reason).toContain("Warning: unowned dirty files");
    expect(reason).toContain("README.md");
    expect(reason.endsWith(`Stage explicit paths you own instead: git add "src/mine two.ts" src/mine.ts`)).toBe(true);
    expect(reason).not.toMatch(/[\u2013\u2014]/);
  });

  test("blocked with no owned edits of my own", () => {
    const r = sweepDecision({ sweeps, me: ME, dirty: [{ path: "a.ts", owner: A }] });
    expect(r.block).toBe(true);
    expect(r.reason?.endsWith("Stage explicit paths you own instead: you have no recorded edits in this checkout")).toBe(true);
    expect(r.reason).not.toContain("Warning");
  });

  test("caps: 8 files per owner, 8 unowned, 12 of mine", () => {
    const dirty = [
      ...Array.from({ length: 10 }, (_, i) => ({ path: `a/${i}.ts`, owner: A })),
      ...Array.from({ length: 11 }, (_, i) => ({ path: `u/${String(i).padStart(2, "0")}.ts`, owner: null })),
      ...Array.from({ length: 14 }, (_, i) => ({ path: `m/${String(i).padStart(2, "0")}.ts`, owner: ME })),
    ];
    const reason = sweepDecision({ sweeps, me: ME, dirty }).reason ?? "";
    expect(reason).toContain("a/7.ts (+2 more)");
    expect(reason).toContain("u/07.ts (+3 more)");
    expect(reason).toContain("m/11.ts");
    expect(reason).not.toContain("m/12.ts");
  });
});
