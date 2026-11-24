// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/repo_fs.test.ts - P-PERF.IDLE1: a repo's identity read from its files, no git process.
//
// Every repo here is built by WRITING the files git would have written (no git binary), and every
// expected value is what `git rev-parse` / `symbolic-ref` / `config --get-regexp` / `remote get-url
// --push` report for that layout. The global config is always injected, so the user's real ~/.gitconfig
// is never read.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findRepoRoot, globalConfigPaths, parseGitConfig, pushConfigZ, pushUrlOf, readRepoView } from "./repo_fs.ts";
import { pushFrom } from "./repo_identity.ts";

const TMP = mkdtempSync(join(tmpdir(), "lucid-repofs-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const SHA_MAIN = "3f786850e387550fdab836ed7e6dc881de23001b";
const SHA_DEV = "89e6c98d92887913cadf06b2adb97f26cde4849b";
const SHA_TAG = "2e65efe2a145dda7ee51d1741299f848e5bf752e";
const SHA_PEEL = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";
const NO_GLOBAL = { globalConfigs: [] };
const ORIGIN = `[remote "origin"]\n\turl = https://github.com/acme/widgets.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`;

/** Write `files` (paths relative to `TMP/name`) and return the folder. */
function repo(name: string, files: Record<string, string>): string {
  const root = join(TMP, name);
  mkdirSync(root, { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
  return root;
}

describe("findRepoRoot", () => {
  test("a nested folder resolves to the outer repo root", async () => {
    const root = repo("nested", { ".git/HEAD": "ref: refs/heads/main\n", "a/b/c.txt": "x" });
    expect(await findRepoRoot(join(root, "a", "b"))).toBe(root);
    expect(await findRepoRoot(root)).toBe(root);
  });

  test("a worktree's .git FILE marks a root too", async () => {
    const root = repo("gitfile-root", { ".git": "gitdir: /nowhere\n", "src/x.ts": "" });
    expect(await findRepoRoot(join(root, "src"))).toBe(root);
  });

  test("a folder inside .git is in no work tree", async () => {
    const root = repo("inside-git", { ".git/HEAD": "ref: refs/heads/main\n", ".git/objects/info/x": "" });
    expect(await findRepoRoot(join(root, ".git", "objects"))).toBeNull();
  });

  test("a folder in no repo is null, and has no view", async () => {
    const plain = repo("plain", { "sub/readme.txt": "x" });
    expect(await findRepoRoot(join(plain, "sub"))).toBeNull();
    expect(await readRepoView(plain, NO_GLOBAL)).toBeNull();
  });
});

describe("readRepoView: HEAD and refs", () => {
  test("normal repo with a loose ref", async () => {
    const root = repo("normal", {
      ".git/HEAD": "ref: refs/heads/main\n",
      ".git/refs/heads/main": `${SHA_MAIN}\n`,
      ".git/config": `[core]\n\tbare = false\n${ORIGIN}[branch "main"]\n\tremote = origin\n\tmerge = refs/heads/main\n`,
    });
    expect(await readRepoView(root, NO_GLOBAL)).toEqual({
      root, name: "normal", branch: "main", head: SHA_MAIN.slice(0, 7), worktree: false, remotes: 1,
      push: pushFrom("origin", "main", "https://github.com/acme/widgets.git"),
    });
  });

  test("packed-refs only: comment and peeled lines are skipped", async () => {
    const root = repo("packed", {
      ".git/HEAD": "ref: refs/heads/dev\n",
      ".git/packed-refs": `# pack-refs with: peeled fully-peeled sorted \n${SHA_TAG} refs/tags/v1\n^${SHA_PEEL}\n${SHA_DEV} refs/heads/dev\n${SHA_MAIN} refs/heads/main\n`,
      ".git/refs/heads/.keep": "",
    });
    const v = await readRepoView(root, NO_GLOBAL);
    expect(v?.branch).toBe("dev");
    expect(v?.head).toBe(SHA_DEV.slice(0, 7));
    expect(v?.remotes).toBe(0);
    expect(v?.push).toBeNull();
  });

  test("a loose ref wins over a stale packed one", async () => {
    const root = repo("loose-wins", {
      ".git/HEAD": "ref: refs/heads/main\n",
      ".git/refs/heads/main": `${SHA_DEV}\n`,
      ".git/packed-refs": `${SHA_MAIN} refs/heads/main\n`,
    });
    expect((await readRepoView(root, NO_GLOBAL))?.head).toBe(SHA_DEV.slice(0, 7));
  });

  test("detached HEAD: no branch, short sha, push still names the remote", async () => {
    const root = repo("detached", { ".git/HEAD": `${SHA_MAIN}\n`, ".git/config": ORIGIN });
    const v = await readRepoView(root, NO_GLOBAL);
    expect(v?.branch).toBe("");
    expect(v?.head).toBe(SHA_MAIN.slice(0, 7));
    expect(v?.push).toEqual(pushFrom("origin", "", "https://github.com/acme/widgets.git"));
  });

  test("unborn branch: branch named, no head", async () => {
    const root = repo("unborn", { ".git/HEAD": "ref: refs/heads/main\n", ".git/refs/heads/.keep": "" });
    const v = await readRepoView(root, NO_GLOBAL);
    expect(v?.branch).toBe("main");
    expect(v?.head).toBe("");
    expect(v?.push).toBeNull();
  });

  test("reftable: branch and head unknown, config still read", async () => {
    const root = repo("reftable", {
      ".git/HEAD": "ref: refs/heads/.invalid\n",
      ".git/reftable/tables.list": "0x000000000001-0x000000000002-abcd.ref\n",
      ".git/config": `[extensions]\n\trefStorage = reftable\n${ORIGIN}`,
    });
    const v = await readRepoView(root, NO_GLOBAL);
    expect(v?.branch).toBe("");
    expect(v?.head).toBe("");
    expect(v?.remotes).toBe(1);
    expect(v?.push).toEqual(pushFrom("origin", "", "https://github.com/acme/widgets.git"));
  });

  test("a gitdir with no HEAD is not a repo", async () => {
    const root = repo("no-head", { ".git/config": ORIGIN });
    expect(await readRepoView(root, NO_GLOBAL)).toBeNull();
  });
});

describe("readRepoView: linked worktrees and gitdir files", () => {
  test("linked worktree: absolute gitdir, commondir, refs and config from the common dir", async () => {
    const main = repo("wt-main", {
      ".git/HEAD": "ref: refs/heads/main\n",
      ".git/refs/heads/main": `${SHA_MAIN}\n`,
      ".git/refs/heads/feature": `${SHA_DEV}\n`,
      ".git/config": `[extensions]\n\tworktreeConfig = true\n${ORIGIN}[remote "fork"]\n\turl = git@github.com:me/widgets.git\n`,
      ".git/worktrees/wt-feature/HEAD": "ref: refs/heads/feature\n",
      ".git/worktrees/wt-feature/commondir": "../..\n",
      ".git/worktrees/wt-feature/config.worktree": `[branch "feature"]\n\tpushRemote = fork\n`,
    });
    const wt = repo("wt-feature", { ".git": `gitdir: ${join(main, ".git", "worktrees", "wt-feature").replace(/\\/g, "/")}\n`, "src/a.ts": "" });
    expect(await findRepoRoot(join(wt, "src"))).toBe(wt);
    expect(await readRepoView(wt, NO_GLOBAL)).toEqual({
      root: wt, name: "wt-feature", branch: "feature", head: SHA_DEV.slice(0, 7), worktree: true, remotes: 2,
      push: pushFrom("fork", "feature", "git@github.com:me/widgets.git"),
    });
    const m = await readRepoView(main, NO_GLOBAL);
    expect(m?.worktree).toBe(false);
    expect(m?.branch).toBe("main");
    expect(m?.push?.remote).toBe("origin");
  });

  test("config.worktree is ignored without extensions.worktreeConfig", async () => {
    const main = repo("wtc-off-main", {
      ".git/HEAD": "ref: refs/heads/main\n",
      ".git/config": `${ORIGIN}[remote "fork"]\n\turl = git@github.com:me/widgets.git\n`,
      ".git/worktrees/w/HEAD": "ref: refs/heads/feature\n",
      ".git/worktrees/w/commondir": "../..\n",
      ".git/worktrees/w/config.worktree": `[branch "feature"]\n\tpushRemote = fork\n`,
    });
    const wt = repo("wtc-off", { ".git": `gitdir: ${join(main, ".git", "worktrees", "w")}\n` });
    expect((await readRepoView(wt, NO_GLOBAL))?.push?.remote).toBe("origin");
  });

  test("relative gitdir (submodule layout) resolves against the folder holding .git", async () => {
    repo("parent", {
      ".git/HEAD": "ref: refs/heads/main\n",
      ".git/modules/sub/HEAD": `${SHA_MAIN}\n`,
      ".git/modules/sub/config": `[remote "origin"]\n\turl = https://gitlab.com/grp/lib.git\n`,
    });
    const sub = repo("parent/sub", { ".git": "gitdir: ../.git/modules/sub\r\n" });
    const v = await readRepoView(sub, NO_GLOBAL);
    expect(v?.worktree).toBe(false);
    expect(v?.head).toBe(SHA_MAIN.slice(0, 7));
    expect(v?.push).toEqual(pushFrom("origin", "", "https://gitlab.com/grp/lib.git"));
  });
});

describe("parseGitConfig", () => {
  test("quoted subsection keeps case and unescapes; legacy subsection is lowercased", () => {
    const e = parseGitConfig(`[Remote "My \\"Fork\\" \\\\x"]\n\tURL = a\n[Branch.Feature]\n\tRemote = b\n[branch ""]\n\tremote = c\n`);
    expect(e).toEqual([
      { section: "remote", sub: 'My "Fork" \\x', name: "url", value: "a" },
      { section: "branch", sub: "feature", name: "remote", value: "b" },
      { section: "branch", sub: "", name: "remote", value: "c" },
    ]);
  });

  test("comments, quotes, escapes, inner blanks, bare keys, continuation, key on the header line", () => {
    const text = [
      "# leading comment",
      "; another",
      "[core] editor = vim # trailing",
      "[x]",
      "  a =  one  two\t # c",
      '  b = "keep # this ; too"  ; gone',
      '  c = tab\\there \\"q\\" back\\\\slash',
      "  d = first \\",
      "    second",
      "  flag",
      '  e = " lead"',
      "  f =",
    ].join("\r\n");
    expect(parseGitConfig(text)).toEqual([
      { section: "core", sub: null, name: "editor", value: "vim" },
      { section: "x", sub: null, name: "a", value: "one  two" },
      { section: "x", sub: null, name: "b", value: "keep # this ; too" },
      { section: "x", sub: null, name: "c", value: 'tab\there "q" back\\slash' },
      { section: "x", sub: null, name: "d", value: "first     second" },
      { section: "x", sub: null, name: "flag", value: null },
      { section: "x", sub: null, name: "e", value: " lead" },
      { section: "x", sub: null, name: "f", value: "" },
    ]);
  });

  test("a syntax error stops the parse, keeping what came before", () => {
    expect(parseGitConfig("[a]\n\tk = v\n[broken\n\tz = 1\n")).toEqual([{ section: "a", sub: null, name: "k", value: "v" }]);
    expect(parseGitConfig("[a]\n\tk = \"open\n\tz = 1\n")).toEqual([]);
  });

  test("pushConfigZ emits git's -z --get-regexp stream for the push keys only", () => {
    const e = parseGitConfig(`[core]\n\tbare = false\n[remote "Up"]\n\turl = u\n\tpushurl = p\n\tfetch = f\n[branch "Main"]\n\tremote = Up\n\tpushRemote = Up\n\tmerge = refs/heads/main\n\trebase = true\n[remote]\n\tpushDefault = Up\n[push]\n\tdefault = current\n\tautoSetupRemote\n[include]\n\tpath = other\n`);
    expect(pushConfigZ(e)).toBe("remote.Up.url\nu\0remote.Up.pushurl\np\0branch.Main.remote\nUp\0branch.Main.pushremote\nUp\0branch.Main.merge\nrefs/heads/main\0remote.pushdefault\nUp\0push.default\ncurrent\0");
  });
});

describe("push URL like `git remote get-url --push`", () => {
  const rules = parseGitConfig([
    '[url "git@github.com:"]', "\tpushInsteadOf = https://github.com/",
    '[url "git@github.com:acme-push/"]', "\tpushInsteadOf = https://github.com/acme/",
    '[url "https://mirror.example.com/"]', "\tinsteadOf = https://github.com/",
    '[url "https://gh.example/"]', "\tinsteadOf = gh:",
  ].join("\n"));

  test("pushurl wins and gets insteadOf, never pushInsteadOf", () => {
    const e = [...rules, ...parseGitConfig(`[remote "o"]\n\turl = https://github.com/acme/x.git\n\tpushurl = gh:acme/x.git\n\tpushurl = second\n`)];
    expect(pushUrlOf(e, "o")).toBe("https://gh.example/acme/x.git");
  });

  test("url: the longest pushInsteadOf beats insteadOf", () => {
    const e = [...rules, ...parseGitConfig(`[remote "o"]\n\turl = https://github.com/acme/x.git\n[remote "z"]\n\turl = https://github.com/zed/y.git\n`)];
    expect(pushUrlOf(e, "o")).toBe("git@github.com:acme-push/x.git");
    expect(pushUrlOf(e, "z")).toBe("git@github.com:zed/y.git");
  });

  test("url with no pushInsteadOf match falls back to insteadOf, then to itself", () => {
    const e = [...rules, ...parseGitConfig(`[remote "o"]\n\turl = gh:acme/x.git\n[remote "p"]\n\turl = https://gitlab.com/a/b.git\n`)];
    expect(pushUrlOf(e, "o")).toBe("https://gh.example/acme/x.git");
    expect(pushUrlOf(e, "p")).toBe("https://gitlab.com/a/b.git");
    expect(pushUrlOf(e, "missing")).toBe("");
  });

  test("readRepoView applies rewrites from an injected global config and its push.default", async () => {
    const global = join(TMP, "global-gitconfig");
    writeFileSync(global, `[url "git@github.com:"]\n\tpushInsteadOf = https://github.com/\n[url "git@github.com:acme-push/"]\n\tpushInsteadOf = https://github.com/acme/\n[push]\n\tdefault = upstream\n`);
    const root = repo("rewrites", {
      ".git/HEAD": "ref: refs/heads/topic\n",
      ".git/refs/heads/topic": `${SHA_MAIN}\n`,
      ".git/config": `${ORIGIN}[branch "topic"]\n\tremote = origin\n\tmerge = refs/heads/trunk\n`,
    });
    const v = await readRepoView(root, { globalConfigs: [join(TMP, "absent-xdg-config"), global] });
    expect(v?.push).toEqual(pushFrom("origin", "trunk", "git@github.com:acme-push/widgets.git"));
  });

  test("globalConfigPaths follows XDG_CONFIG_HOME, then HOME, then USERPROFILE", () => {
    expect(globalConfigPaths({ XDG_CONFIG_HOME: join("x", "cfg"), HOME: join("h") })).toEqual([join("x", "cfg", "git", "config"), join("h", ".gitconfig")]);
    expect(globalConfigPaths({ USERPROFILE: join("u") })).toEqual([join("u", ".config", "git", "config"), join("u", ".gitconfig")]);
  });
});
