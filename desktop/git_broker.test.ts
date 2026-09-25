// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/git_broker.test.ts - P-SANDBOX.17 (ADR-0399): the host git broker's policy. Host git runs with the
// user's full reach, so each test here is a way the contained agent could turn it into a confused deputy.

import { describe, expect, test } from "bun:test";
import { brokerEnv, findRepo, forcedConfig, planGitCall, pushUpstreamCalls, refusedConfigKey } from "./git_broker.ts";

const WS = "C:\\Users\\U\\ws";
const plan = (argv: string[], cwd = WS) => planGitCall(argv, cwd, WS);
const refused = (argv: string[], cwd = WS) => { const r = plan(argv, cwd); return r.ok ? null : r.reason; };

describe("subcommands", () => {
  test("only built-in allowlisted subcommands run: no aliases, external git-* commands or global options", () => {
    expect(plan(["status"]).ok).toBe(true);
    expect(refused(["st"])).toContain("not one of the git subcommands");
    expect(refused(["lfs", "install"])).toContain("not one of the git subcommands");
    expect(refused(["submodule", "update"])).toContain("not one of the git subcommands");
    expect(refused(["-c", "core.fsmonitor=calc", "status"])).toContain("global options");
    expect(refused(["-C", "C:\\other", "status"])).toContain("global options");
    expect(plan(["--version"]).ok).toBe(true);
  });
});

describe("options that make git run a program", () => {
  test.each([
    [["rebase", "-x", "calc", "main"]], [["rebase", "-ix", "calc", "main"]], [["rebase", "--exec=calc", "main"]],
    [["grep", "-Ocalc", "x"]], [["grep", "--open-files-in-pager=calc", "x"]],
    [["clone", "-c", "core.fsmonitor=calc", "https://h/r"]], [["clone", "--config=core.fsmonitor=calc", "https://h/r"]],
    [["clone", "-u", "calc", "https://h/r"]], [["fetch", "--upload-pack=calc", "origin"]], [["push", "--receive-pack=calc", "origin"]],
    [["clone", "--template=t", "https://h/r"]], [["pull", "--recurse-submodules"]],
  ])("%j is refused", (argv) => {
    expect(refused(argv)).not.toBeNull();
  });
  test("the same letters stay usable where they are harmless", () => {
    expect(plan(["commit", "-am", "x"]).ok).toBe(true);
    expect(plan(["log", "-x"]).ok).toBe(true); // not rebase
    expect(plan(["push", "-u", "origin", "main"]).ok).toBe(true);
  });
});

describe("paths stay inside the workspace", () => {
  test.each([
    [["diff", "--no-index", "C:\\Users\\U\\.ssh\\id_rsa", "a.txt"]],
    [["commit", "-F", "..\\..\\secret.txt"]],
    [["log", "--output=C:\\Users\\U\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\x.bat"]],
    [["format-patch", "-o", "..\\out", "HEAD~1"]],
    [["apply", "\\\\server\\share\\p.patch"]],
    [["diff", "--no-index", "D:secret", "a"]],
    [["clone", "https://h/r", "C:\\elsewhere"]],
  ])("%j is refused", (argv) => {
    expect(refused(argv)).toContain("outside the workspace");
  });
  test("paths, refs, URLs and messages inside the workspace pass", () => {
    expect(plan(["add", "src\\a.ts", "docs/b.md"]).ok).toBe(true);
    expect(plan(["diff", "origin/main..HEAD", "--", "src"]).ok).toBe(true);
    expect(plan(["show", "HEAD:../x"], `${WS}\\src`).ok).toBe(true); // an object path, still inside
    expect(plan(["commit", "-m", "move C:\\temp handling"]).ok).toBe(true);
    expect(plan(["clone", "https://github.com/o/r.git", "vendor\\r"]).ok).toBe(true);
    expect(refused(["add", ".."], `${WS}\\sub`)).toBeNull();
    expect(refused(["add", ".."])).toContain("outside the workspace");
  });
});

describe("what holds the repo config", () => {
  test("config writers that execute nothing run unheld; everything else is held", () => {
    const held = (argv: string[]) => { const r = plan(argv); if (!r.ok) throw new Error(r.reason); return r.plan.held; };
    expect(held(["status"])).toBe(true);
    expect(held(["push", "origin"])).toBe(true);
    expect(held(["config", "user.email", "a@b"])).toBe(false);
    expect(held(["branch", "-d", "old"])).toBe(false);
    expect(held(["remote", "add", "origin", "https://h/r"])).toBe(false);
    expect(held(["remote", "show", "origin"])).toBe(true);
    expect(refused(["remote", "add", "-f", "o", "https://h/r"])).toContain("remote add -f");
    expect(refused(["config", "--global", "user.name", "x"])).toContain("--global");
    expect(refused(["config", "--file=C:\\x", "a.b", "c"])).not.toBeNull();
  });
});

describe("tracking is set after the held window", () => {
  test("push -u is stripped and needs its remote named", () => {
    const r = plan(["push", "-u", "origin", "feature"]);
    expect(r.ok && r.plan.args).toEqual(["origin", "feature"]);
    expect(r.ok && r.plan.pushUpstream).toEqual({ remote: "origin", refs: ["feature"] });
    expect(refused(["push", "-u"])).toContain("remote named");
    expect(refused(["push", "-fu", "origin"])).toContain("on its own");
  });
  test("pushUpstreamCalls maps HEAD, src:dst, forced and full refs to the local branch", () => {
    expect(pushUpstreamCalls({ remote: "origin", refs: [] }, "feat")).toEqual([["branch", "--set-upstream-to=origin/feat", "feat"]]);
    expect(pushUpstreamCalls({ remote: "origin", refs: ["HEAD", "+a:b", "refs/heads/c", ":gone"] }, "feat")).toEqual([
      ["branch", "--set-upstream-to=origin/feat", "feat"], ["branch", "--set-upstream-to=origin/b", "a"], ["branch", "--set-upstream-to=origin/c", "c"],
    ]);
  });
  test("checkout/switch: create, --track and a bare name are recognized; --track is rewritten to a create", () => {
    const t = (argv: string[]) => { const r = plan(argv); if (!r.ok) throw new Error(r.reason); return { args: r.plan.args, track: r.plan.track }; };
    expect(t(["checkout", "-b", "x", "origin/x"]).track).toMatchObject({ branch: "x", start: "origin/x", explicit: false });
    expect(t(["checkout", "--track", "origin/foo"])).toMatchObject({ args: ["-b", "foo", "origin/foo"], track: { branch: "foo", explicit: true } });
    expect(t(["switch", "feature"]).track).toMatchObject({ guess: "feature", branch: null });
    expect(t(["switch", "-c", "y", "--no-track", "origin/y"]).track).toMatchObject({ none: true });
  });
});

describe("repo config allowlist", () => {
  test("a freshly cloned repo's config is allowed", () => {
    expect(refusedConfigKey(["core.repositoryformatversion", "core.filemode", "core.bare", "core.logallrefupdates", "core.symlinks", "core.ignorecase",
      "remote.origin.url", "remote.origin.fetch", "branch.master.remote", "branch.master.merge", "remote.my.fork.url"])).toBeNull();
  });
  test.each(["core.fsmonitor", "core.hooksPath", "core.pager", "core.editor", "core.sshCommand", "credential.helper", "credential.https://h.helper",
    "filter.lfs.clean", "diff.x.textconv", "diff.external", "merge.x.driver", "include.path", "includeIf.gitdir:x.path", "alias.st",
    "remote.origin.uploadpack", "core.worktree", "extensions.worktreeconfig", "lfs.customtransfer.x.path", "submodule.x.update", "http.proxy"])(
    "%s is refused", (key) => { expect(refusedConfigKey(["core.bare", key])).toBe(key); });
});

describe("forced overrides and environment", () => {
  test("every call turns hooks and fsmonitor off, allows only https, and never recurses into submodules", () => {
    const c = forcedConfig({ hooksDir: "C:\\t\\nohooks", proxyUrl: null }).join(" ");
    for (const want of ["core.hooksPath=C:\\t\\nohooks", "core.fsmonitor=false", "protocol.allow=never", "protocol.https.allow=always", "submodule.recurse=false", "gc.autoDetach=false"]) expect(c).toContain(want);
    expect(forcedConfig({ hooksDir: "h", proxyUrl: "http://127.0.0.1:9" }).join(" ")).toContain("http.proxy=http://127.0.0.1:9");
  });
  test("the engine's GIT_* and proxy variables never reach host git; editors are no-ops", () => {
    const env = brokerEnv({ Path: "C:\\x", GIT_DIR: "C:\\evil", git_config_parameters: "'core.fsmonitor=calc'", HTTPS_PROXY: "http://evil", NO_PROXY: "*" }, { gitDir: `${WS}\\.git`, workTree: WS, proxyUrl: null });
    expect(env.GIT_DIR).toBe(`${WS}\\.git`);
    expect(env.GIT_COMMON_DIR).toBe(`${WS}\\.git`);
    expect(Object.keys(env).some((k) => /config_parameters|https_proxy|no_proxy/i.test(k))).toBe(false);
    expect(env.GIT_EDITOR).toBe(":");
    expect(env.Path).toBe("C:\\x");
  });
});

describe("findRepo", () => {
  const kinds = (m: Record<string, "dir" | "file" | "reparse">) => ({ kind: (p: string) => m[p] ?? null });
  test("walks up to the repo, but never above the workspace", () => {
    expect(findRepo(`${WS}\\src\\a`, WS, kinds({ [`${WS}\\.git`]: "dir" }))).toEqual({ top: WS, gitDir: `${WS}\\.git` });
    expect(findRepo(`${WS}\\src`, WS, kinds({ "C:\\Users\\U\\.git": "dir" }))).toBeNull();
  });
  test("a gitfile, a linked .git, or a commondir redirect is refused", () => {
    expect(findRepo(WS, WS, kinds({ [`${WS}\\.git`]: "file" }))).toHaveProperty("refuse");
    expect(findRepo(WS, WS, kinds({ [`${WS}\\.git`]: "reparse" }))).toHaveProperty("refuse");
    expect(findRepo(WS, WS, kinds({ [`${WS}\\.git`]: "dir", [`${WS}\\.git\\commondir`]: "file" }))).toHaveProperty("refuse");
  });
});
