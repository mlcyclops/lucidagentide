// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/workspace.test.ts
//
// ADR-0208: the Settings "Clone a git repo" parity/auth fix. These cover the PURE, spawn-free helpers behind
// cloneRepo — the dest-name Windows quirk, host-token selection, safe header injection, and error hinting —
// so the private-repo path can't silently regress. The actual `git clone` spawn is network/git-dependent and
// is exercised by hand, matching how cred_vault.ts keeps its side-effecting edges out of the unit tests.

import { describe, expect, test } from "bun:test";
import { cloneArgv, cloneErrorHint, hostTokenForUrl, repoNameFromUrl, resolveCloneToken } from "./workspace.ts";

describe("repoNameFromUrl", () => {
  test("strips .git and path", () => {
    expect(repoNameFromUrl("https://github.com/acme/widget.git")).toBe("widget");
    expect(repoNameFromUrl("git@github.com:acme/widget.git")).toBe("widget");
  });
  test("trims trailing dots so the name matches the folder Windows actually creates", () => {
    // l.e.a.p.s..git → raw `l.e.a.p.s.`; Windows would create `l.e.a.p.s`, desyncing the .git reuse check.
    expect(repoNameFromUrl("https://github.com/mlcyclops/l.e.a.p.s..git")).toBe("l.e.a.p.s");
    expect(repoNameFromUrl("https://example.com/repo...git")).toBe("repo");
  });
  test("falls back to 'repo' when nothing usable remains", () => {
    expect(repoNameFromUrl("https://example.com/...")).toBe("repo");
  });
});

describe("hostTokenForUrl", () => {
  const env = { GITHUB_TOKEN: "ght", GH_TOKEN: "gh2", GITLAB_TOKEN: "glt", LUCID_GITHUB_TOKEN: "lgt" };
  test("picks the github token for github hosts (https only)", () => {
    expect(hostTokenForUrl("https://github.com/a/b.git", env)).toBe("ght");
    expect(hostTokenForUrl("https://api.github.com/a/b.git", env)).toBe("ght");
  });
  test("prefers GITHUB_TOKEN, then GH_TOKEN, then LUCID_GITHUB_TOKEN", () => {
    expect(hostTokenForUrl("https://github.com/a/b", { GH_TOKEN: "gh2", LUCID_GITHUB_TOKEN: "lgt" })).toBe("gh2");
    expect(hostTokenForUrl("https://github.com/a/b", { LUCID_GITHUB_TOKEN: "lgt" })).toBe("lgt");
  });
  test("picks the gitlab token for gitlab hosts", () => {
    expect(hostTokenForUrl("https://gitlab.com/a/b.git", env)).toBe("glt");
  });
  test("returns null for ssh/git@ URLs (key-based, not header tokens) and unknown hosts", () => {
    expect(hostTokenForUrl("git@github.com:a/b.git", env)).toBeNull();
    expect(hostTokenForUrl("ssh://git@github.com/a/b.git", env)).toBeNull();
    expect(hostTokenForUrl("https://example.com/a/b.git", env)).toBeNull();
  });
  test("returns null when the token env var is unset/blank", () => {
    expect(hostTokenForUrl("https://github.com/a/b", {})).toBeNull();
    expect(hostTokenForUrl("https://github.com/a/b", { GITHUB_TOKEN: "  " })).toBeNull();
  });
  test("ADR-0210: LUCID_GIT_PAT (vault-injected) is the host-agnostic fallback, after CI-style env vars", () => {
    expect(hostTokenForUrl("https://github.com/a/b", { LUCID_GIT_PAT: "vault" })).toBe("vault");
    expect(hostTokenForUrl("https://gitlab.com/a/b", { LUCID_GIT_PAT: "vault" })).toBe("vault");
    // a workflow's own GITHUB_TOKEN still wins over the vault PAT
    expect(hostTokenForUrl("https://github.com/a/b", { GITHUB_TOKEN: "ci", LUCID_GIT_PAT: "vault" })).toBe("ci");
  });
});

describe("resolveCloneToken (ADR-0210)", () => {
  test("an inline override wins over env/vault, for https", () => {
    expect(resolveCloneToken("https://github.com/a/b.git", "inline", { GITHUB_TOKEN: "ci", LUCID_GIT_PAT: "vault" })).toBe("inline");
  });
  test("falls back to the env/vault token when no override", () => {
    expect(resolveCloneToken("https://github.com/a/b.git", "", { LUCID_GIT_PAT: "vault" })).toBe("vault");
    expect(resolveCloneToken("https://github.com/a/b.git", undefined, { GITHUB_TOKEN: "ci" })).toBe("ci");
  });
  test("ignores an override on a non-https URL (ssh uses keys, not header tokens)", () => {
    expect(resolveCloneToken("git@github.com:a/b.git", "inline", {})).toBeNull();
  });
});

describe("cloneArgv", () => {
  test("no token → plain clone", () => {
    expect(cloneArgv("https://github.com/a/b.git", "/dst", null)).toEqual(["clone", "https://github.com/a/b.git", "/dst"]);
  });
  test("token → per-command http.extraHeader BEFORE the subcommand, Basic x-access-token", () => {
    const argv = cloneArgv("https://github.com/a/b.git", "/dst", "tok123");
    expect(argv[0]).toBe("-c");
    const basic = Buffer.from("x-access-token:tok123").toString("base64");
    expect(argv[1]).toBe(`http.extraHeader=Authorization: Basic ${basic}`);
    expect(argv.slice(2)).toEqual(["clone", "https://github.com/a/b.git", "/dst"]);
    // the raw token must NOT appear in the URL (which would persist into .git/config)
    expect(argv).not.toContain("https://tok123@github.com/a/b.git");
  });
});

describe("cloneErrorHint", () => {
  test("auth failure with no token → tells the user to set a token or use the agent", () => {
    const h = cloneErrorHint("fatal: Authentication failed for 'https://github.com/x/y.git'", false);
    expect(h).toMatch(/private repo/i);
    expect(h).toMatch(/GITHUB_TOKEN/);
  });
  test("auth failure with a token → says the token was rejected", () => {
    const h = cloneErrorHint("remote: Repository not found", true);
    expect(h).toMatch(/token was rejected|rejected/i);
  });
  test("non-auth error passes through, capped", () => {
    expect(cloneErrorHint("fatal: unable to access: could not resolve host", false)).toMatch(/could not resolve host/);
    expect(cloneErrorHint("", false)).toBe("git clone failed");
  });
});
