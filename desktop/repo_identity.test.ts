// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/repo_identity.test.ts - P-REPO.1 (ADR-0406): where `git push` goes, and which paths a tool call
// touches. These are the two answers the chip shows; a wrong one sends the user's commits somewhere they
// did not expect, or names the wrong repo for a session.

import { describe, expect, test } from "bun:test";
import { cleanToolPath, commandDir, parseGitConfigZ, pushFrom, pushLabel, pushTarget, toolCallTouches, type RepoView } from "./repo_identity.ts";

const cfgOf = (entries: [string, string][]) => parseGitConfigZ(entries.map(([k, v]) => `${k}\n${v}\0`).join(""));

describe("pushTarget follows git's precedence", () => {
  const base: [string, string][] = [
    ["remote.origin.url", "https://github.com/me/fork.git"],
    ["remote.upstream.url", "https://github.com/org/repo.git"],
    ["branch.Feat/X.remote", "upstream"],
    ["branch.Feat/X.merge", "refs/heads/main"],
  ];
  test("the branch's upstream remote, same-named branch under the default push.default", () => {
    expect(pushTarget(cfgOf(base), "Feat/X")).toEqual({ remote: "upstream", branch: "Feat/X" });
  });
  test("push.default=upstream pushes to the tracked branch", () => {
    expect(pushTarget(cfgOf([...base, ["push.default", "upstream"]]), "Feat/X")).toEqual({ remote: "upstream", branch: "main" });
  });
  test("remote.pushDefault beats the upstream remote, branch.pushRemote beats both", () => {
    expect(pushTarget(cfgOf([...base, ["remote.pushdefault", "origin"]]), "Feat/X")?.remote).toBe("origin");
    expect(pushTarget(cfgOf([...base, ["remote.pushdefault", "upstream"], ["branch.Feat/X.pushremote", "origin"]]), "Feat/X")?.remote).toBe("origin");
  });
  test("no upstream falls back to origin, then to the only remote", () => {
    expect(pushTarget(cfgOf(base), "other")).toEqual({ remote: "origin", branch: "other" });
    expect(pushTarget(cfgOf([["remote.gh.url", "git@github.com:a/b.git"]]), "main")).toEqual({ remote: "gh", branch: "main" });
  });
  test("no remote, or a branch tracking the local repo, pushes nowhere", () => {
    expect(pushTarget(cfgOf([]), "main")).toBeNull();
    expect(pushTarget(cfgOf([["remote.a.url", "x"], ["remote.b.url", "y"]]), "main")).toBeNull();
    expect(pushTarget(cfgOf([...base, ["branch.main.remote", "."]]), "main")).toBeNull();
  });
  test("a detached HEAD still names the remote, with no branch", () => {
    expect(pushTarget(cfgOf(base), "")).toEqual({ remote: "origin", branch: "" });
  });
});

describe("push labels never carry credentials", () => {
  test("a token in the URL is dropped; the web page is the plain repo", () => {
    const p = pushFrom("origin", "main", "https://x-access-token:ghp_secret@github.com/emertins/JanelleSEO.git");
    expect(JSON.stringify(p)).not.toContain("ghp_secret");
    expect(p).toMatchObject({ provider: "github", owner: "emertins", repo: "JanelleSEO", webUrl: "https://github.com/emertins/JanelleSEO" });
  });
  test("an ssh host alias still links to github.com", () => {
    expect(pushFrom("origin", "", "git@github.com-work:org/app.git").webUrl).toBe("https://github.com/org/app");
  });
  test("a local-path remote is named by its folder and says so", () => {
    const v: RepoView = { root: "C:/r", name: "r", branch: "main", head: "abc", worktree: false, remotes: 1, push: pushFrom("mirror", "main", "D:\\mirrors\\app.git") };
    expect(v.push?.host).toBe("");
    expect(pushLabel(v)).toBe("mirror, a folder on disk (main)");
  });
  test("no remote reads as local only; remotes without a target read differently", () => {
    const v: RepoView = { root: "C:/r", name: "r", branch: "main", head: "abc", worktree: false, remotes: 0, push: null };
    expect(pushLabel(v)).toBe("Local only: no remote");
    expect(pushLabel({ ...v, remotes: 2 })).toBe("No push target for this branch");
  });
});

describe("toolCallTouches", () => {
  test("edits, writes and commands are strong; reads and searches weak; other kinds nothing", () => {
    expect(toolCallTouches({ kind: "edit", locations: [{ path: "C:\\r\\a.ts" }] })).toEqual([{ path: "C:\\r\\a.ts", strong: true }]);
    expect(toolCallTouches({ kind: "read", rawInput: { path: "src/a.ts:10-40" } })).toEqual([{ path: "src/a.ts", strong: false }]);
    expect(toolCallTouches({ kind: "other", rawInput: { path: "C:\\r" } })).toEqual([]);
    expect(toolCallTouches({ kind: "fetch", rawInput: { url: "https://x" } })).toEqual([]);
    expect(toolCallTouches({ kind: "toString", rawInput: { path: "C:\\r" } })).toEqual([]);
  });
  test("a command's cwd input and the folder its text changes into both count", () => {
    const t = toolCallTouches({ kind: "execute", rawInput: { command: 'cd "D:\\src\\app" && git status', cwd: "E:\\w" } });
    expect(t.map((x) => x.path).sort()).toEqual(["D:\\src\\app", "E:\\w"]);
  });
  test("internal URLs and xd devices are not paths; globs keep their folder; lists split", () => {
    expect(toolCallTouches({ kind: "execute", rawInput: { path: "xd://ast_edit", content: "{}" } })).toEqual([]);
    expect(toolCallTouches({ kind: "search", rawInput: { path: "src/**/*.ts; test/**/*.ts" } }).map((t) => t.path)).toEqual(["src", "test"]);
  });
});

test("cleanToolPath keeps drive letters and UNC roots, drops selectors", () => {
  expect(cleanToolPath("C:\\a\\b.ts:12")).toBe("C:\\a\\b.ts");
  expect(cleanToolPath("//FastNas/Data/x/y.md:raw")).toBe("//FastNas/Data/x/y.md");
  expect(cleanToolPath("C:")).toBe("C:");
  expect(cleanToolPath("local://PLAN.md")).toBe("");
  expect(cleanToolPath("file:///C:/a/b.txt")).toBe("C:/a/b.txt");
});

test("commandDir reads cd and git -C, nothing else", () => {
  expect(commandDir("cd /srv/app && make")).toBe("/srv/app");
  expect(commandDir("git -c safe.directory=* -C 'D:\\x y' log")).toBe("D:\\x y");
  expect(commandDir("echo cd /tmp")).toBe("");
});
