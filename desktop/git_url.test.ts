// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-FLEET.L2: the pure git remote parser shared by the renderer's spawn form, workspace.ts's clone auth,
// and main.ts's vault -> env injection. What matters: the three real clone-button spellings all parse, a
// Windows path is NEVER mistaken for a remote (that would send a local folder off to `git clone`), a
// pasted `user:password@` prefix is discarded rather than carried into a label, and the vault ref / env
// name derived from a host round-trip exactly (a mismatch silently loses the user's saved token).

import { expect, test } from "bun:test";
import {
  GIT_CRED_LEGACY_REF,
  gitAuthHint,
  gitCredRef,
  gitEnvNameFromRef,
  gitHostSlug,
  gitTokenEnvName,
  parseGitRemote,
  providerLabel,
} from "./git_url.ts";
import { isValidRef } from "./cred_vault.ts";

test("https remotes parse, with .git and query junk stripped", () => {
  expect(parseGitRemote("https://github.com/acme/widgets.git")).toEqual({ host: "github.com", scheme: "https", provider: "github", repo: "widgets", owner: "acme" });
  expect(parseGitRemote("https://gitlab.com/group/sub/thing")).toEqual({ host: "gitlab.com", scheme: "https", provider: "gitlab", repo: "thing", owner: "group/sub" });
  expect(parseGitRemote("https://dev.azure.com/org/project/_git/repo")?.provider).toBe("azure");
  expect(parseGitRemote("https://acme.visualstudio.com/proj/_git/repo")?.provider).toBe("azure");
  expect(parseGitRemote("https://GitHub.com/A/B?tab=readme#x")).toEqual({ host: "github.com", scheme: "https", provider: "github", repo: "B", owner: "A" });
});

test("both ssh spellings parse as ssh, port and user discarded", () => {
  expect(parseGitRemote("git@github.com:acme/widgets.git")).toEqual({ host: "github.com", scheme: "ssh", provider: "github", repo: "widgets", owner: "acme" });
  expect(parseGitRemote("ssh://git@ssh.dev.azure.com/v3/org/project/repo")).toEqual({ host: "ssh.dev.azure.com", scheme: "ssh", provider: "azure", repo: "repo", owner: "v3/org/project" });
  expect(parseGitRemote("ssh://git@gitlab.example.com:2222/team/app.git")).toEqual({ host: "gitlab.example.com", scheme: "ssh", provider: "gitlab", repo: "app", owner: "team" });
});

test("self-hosted hosts are recognized by name; anything else is `other`, never guessed", () => {
  expect(parseGitRemote("https://gitlab.mycorp.com/team/app.git")?.provider).toBe("gitlab");
  expect(parseGitRemote("https://github.mycorp.com/team/app.git")?.provider).toBe("github");
  expect(parseGitRemote("https://bitbucket.org/team/app.git")?.provider).toBe("bitbucket");
  expect(parseGitRemote("https://code.internal.example/team/app.git")?.provider).toBe("other");
});

test("a local path is NEVER a remote - the scp-like form demands a dotted host", () => {
  expect(parseGitRemote("C:\\Users\\me\\src\\repo")).toBeNull();
  expect(parseGitRemote("D:/work/repo")).toBeNull();
  expect(parseGitRemote("/home/me/src/repo")).toBeNull();
  expect(parseGitRemote("./relative/repo")).toBeNull();
  expect(parseGitRemote("localhost:repo.git")).toBeNull(); // no dot -> not a host we will trust
  expect(parseGitRemote("")).toBeNull();
  expect(parseGitRemote("just some words")).toBeNull();
  expect(parseGitRemote("https://github.com/")).toBeNull(); // no repo segment
});

test("embedded credentials are DISCARDED, never carried into the parsed remote", () => {
  const r = parseGitRemote("https://someone:ghp_secrettoken@github.com/acme/widgets.git");
  expect(r).toEqual({ host: "github.com", scheme: "https", provider: "github", repo: "widgets", owner: "acme" });
  expect(JSON.stringify(r)).not.toContain("ghp_secrettoken");
});

test("host -> vault ref -> env name round-trips, and the ref is filename-safe for the vault", () => {
  for (const host of ["github.com", "dev.azure.com", "gitlab.my-corp.example", "ssh.dev.azure.com"]) {
    const ref = gitCredRef(host);
    expect(isValidRef(ref)).toBe(true); // cred_vault would reject anything else
    expect(gitEnvNameFromRef(ref)).toBe(gitTokenEnvName(host));
  }
  expect(gitHostSlug("dev.azure.com")).toBe("dev_azure_com");
  expect(gitCredRef("github.com")).toBe("git_pat_github_com");
  expect(gitTokenEnvName("github.com")).toBe("LUCID_GIT_PAT_GITHUB_COM");
  expect(gitCredRef("")).toBe("");
  expect(gitTokenEnvName("...")).toBe("");
});

test("the LEGACY host-agnostic ref is never read as a host-scoped one", () => {
  expect(GIT_CRED_LEGACY_REF).toBe("git_pat");
  expect(gitEnvNameFromRef("git_pat")).toBeNull();
  expect(gitEnvNameFromRef("figma_token")).toBeNull();
  expect(gitEnvNameFromRef("git_pat_")).toBeNull(); // empty slug is not a host
});

test("the auth hint names the credential the remote actually takes - keys for ssh, a PAT per provider", () => {
  expect(gitAuthHint(parseGitRemote("git@github.com:a/b.git")!)).toContain("ssh keys");
  expect(gitAuthHint(parseGitRemote("https://github.com/a/b")!)).toContain("GitHub personal access token");
  expect(gitAuthHint(parseGitRemote("https://gitlab.com/a/b")!)).toContain("read_repository");
  expect(gitAuthHint(parseGitRemote("https://dev.azure.com/o/p/_git/r")!)).toContain("Azure DevOps");
  expect(gitAuthHint(parseGitRemote("https://code.internal.example/a/b")!)).toContain("code.internal.example");
  expect(providerLabel("azure")).toBe("Azure DevOps");
  expect(providerLabel("other")).toBe("Git");
});
