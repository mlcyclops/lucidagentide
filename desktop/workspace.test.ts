// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/workspace.test.ts
//
// ADR-0214: the Settings "Clone a git repo" parity/auth fix. These cover the PURE, spawn-free helpers behind
// cloneRepo — the dest-name Windows quirk, host-token selection, safe header injection, and error hinting —
// so the private-repo path can't silently regress. The actual `git clone` spawn is network/git-dependent and
// is exercised by hand, matching how cred_vault.ts keeps its side-effecting edges out of the unit tests.

import { describe, expect, test } from "bun:test";
import { CLONE_ROOT, cloneArgv, cloneErrorHint, hostTokenForUrl, repoNameFromUrl, resolveCloneToken } from "./workspace.ts";
import { gitTokenEnvName } from "./git_url.ts";

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
  test("ADR-0216: LUCID_GIT_PAT (vault-injected) is the host-agnostic fallback, after CI-style env vars", () => {
    expect(hostTokenForUrl("https://github.com/a/b", { LUCID_GIT_PAT: "vault" })).toBe("vault");
    expect(hostTokenForUrl("https://gitlab.com/a/b", { LUCID_GIT_PAT: "vault" })).toBe("vault");
    // a workflow's own GITHUB_TOKEN still wins over the vault PAT
    expect(hostTokenForUrl("https://github.com/a/b", { GITHUB_TOKEN: "ci", LUCID_GIT_PAT: "vault" })).toBe("ci");
  });
  // P-FLEET.L2: the host-scoped vault token. This is what makes "save this PAT for dev.azure.com" work,
  // and what stops a generic PAT being handed to a host it was never meant for.
  test("P-FLEET.L2: the HOST-SCOPED vault token wins over every CI-style var", () => {
    const scoped = { [gitTokenEnvName("github.com")]: "scoped", GITHUB_TOKEN: "ci", LUCID_GIT_PAT: "vault" };
    expect(hostTokenForUrl("https://github.com/a/b", scoped)).toBe("scoped");
    // ...and it is scoped: the github token is not offered to gitlab
    expect(hostTokenForUrl("https://gitlab.com/a/b", { [gitTokenEnvName("github.com")]: "scoped" })).toBeNull();
  });
  test("P-FLEET.L2: a self-hosted / unknown host gets ONLY its own scoped token, never the generic PAT", () => {
    expect(hostTokenForUrl("https://git.internal.example/a/b", { LUCID_GIT_PAT: "vault" })).toBeNull();
    expect(hostTokenForUrl("https://git.internal.example/a/b", { [gitTokenEnvName("git.internal.example")]: "mine" })).toBe("mine");
  });
  test("P-FLEET.L2: Azure DevOps hosts authenticate with a PAT on the same Basic header", () => {
    expect(hostTokenForUrl("https://dev.azure.com/org/proj/_git/repo", { AZURE_DEVOPS_EXT_PAT: "az" })).toBe("az");
    expect(hostTokenForUrl("https://dev.azure.com/org/proj/_git/repo", { SYSTEM_ACCESSTOKEN: "pipe" })).toBe("pipe");
    expect(hostTokenForUrl("https://acme.visualstudio.com/p/_git/r", { LUCID_GIT_PAT: "vault" })).toBe("vault");
    // a Pipelines-style var still loses to the token the user saved for this host
    expect(hostTokenForUrl("https://dev.azure.com/o/p/_git/r", { SYSTEM_ACCESSTOKEN: "pipe", [gitTokenEnvName("dev.azure.com")]: "saved" })).toBe("saved");
  });
});

describe("resolveCloneToken (ADR-0216)", () => {
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
  test("auth failure with no token → names the token the user can actually paste in the form", () => {
    const h = cloneErrorHint("fatal: Authentication failed for 'https://github.com/x/y.git'", false);
    expect(h).toMatch(/private repo/i);
    expect(h).toMatch(/personal access token/i);
  });
  test("auth failure with a token → says the token was rejected", () => {
    const h = cloneErrorHint("remote: Repository not found", true);
    expect(h).toMatch(/token was rejected|rejected/i);
  });
  // P-FLEET.L2: an ssh remote has a DIFFERENT fix. Telling someone to set a PAT for a `git@` URL sends
  // them to configure something git will never read.
  test("an ssh failure points at keys, never at a token", () => {
    const h = cloneErrorHint("git@github.com: Permission denied (publickey).", false, true);
    expect(h).toMatch(/ssh key/i);
    expect(h).not.toMatch(/personal access token for/i);
    expect(cloneErrorHint("Host key verification failed.", false, true)).toMatch(/ssh/i);
    // BatchMode turns a passphrase prompt into a fast failure; that must read as a key problem too
    expect(cloneErrorHint("Permission denied, please try again. (batch mode)", false, true)).toMatch(/ssh/i);
  });
  test("non-auth error passes through, capped", () => {
    expect(cloneErrorHint("fatal: unable to access: could not resolve host", false)).toMatch(/could not resolve host/);
    expect(cloneErrorHint("", false)).toBe("git clone failed");
  });
});

describe("CLONE_ROOT (P-FLEET.L2)", () => {
  test("is the shared workspaces folder - the fallback when a lane names no parent", () => {
    expect(CLONE_ROOT().replace(/\\/g, "/")).toMatch(/\.omp\/lucid-workspaces$/);
  });
});
