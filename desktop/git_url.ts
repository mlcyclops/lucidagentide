// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/git_url.ts
//
// P-FLEET.L2: PURE git remote-URL parsing, shared by the server (workspace.ts clone auth, main.ts vault
// -> env injection) and the RENDERER (the fleet spawn form's repo field). It therefore imports nothing:
// no node builtins, no fs, no settings. That is the whole reason this module exists as its own file -
// workspace.ts pulls in node:fs + the settings store and can never be bundled into the renderer.
//
// Three remote spellings are accepted, because those are the three GitHub / GitLab / Azure DevOps hand
// you on their clone buttons:
//   https://host/org/repo(.git)          -> token/PAT auth (an Authorization header, per-command)
//   ssh://git@host[:port]/org/repo(.git) -> key auth (the user's ssh agent), never a token
//   git@host:org/repo(.git)              -> the scp-like form, also key auth
//
// A Windows path (`C:\src\repo`) must NEVER read as a remote, so the scp-like form insists on a DOTTED
// hostname: "C" is not a host. Query strings and fragments are dropped, and nothing here ever holds or
// echoes a secret - `parseGitRemote` deliberately discards any `user:password@` prefix rather than
// carrying it into a label or an error.

/** Closed set. `other` covers self-hosted GitLab/Gitea/Azure DevOps Server and anything unrecognized. */
export type GitProvider = "github" | "gitlab" | "azure" | "bitbucket" | "other";

export interface GitRemote {
  /** Lowercase host, port stripped. */
  host: string;
  /** How a clone authenticates: `https` takes a token header, `ssh` takes the user's keys. */
  scheme: "https" | "ssh";
  provider: GitProvider;
  /** Last path segment, `.git` removed. Never empty for a parsed remote. */
  repo: string;
  /** Everything before the repo (owner / group / project path), or "" when there is none. */
  owner: string;
}

const HTTPS_RE = /^https?:\/\/(?:[^/@]*@)?([A-Za-z0-9._-]+)(?::\d+)?\/(.+)$/i;
const SSH_URL_RE = /^ssh:\/\/(?:[^/@]*@)?([A-Za-z0-9._-]+)(?::\d+)?\/(.+)$/i;
/** scp-like `[user@]host:path`. The host MUST be dotted so a drive letter can never match. */
const SCP_RE = /^(?:[A-Za-z0-9._-]+@)?([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)(?::\d+)?:(?!\/)(.+)$/;

function providerOf(host: string): GitProvider {
  if (host === "github.com" || host.endsWith(".github.com") || /(^|\.)github\./.test(host)) return "github";
  if (host === "gitlab.com" || host.endsWith(".gitlab.com") || /(^|\.)gitlab\./.test(host)) return "gitlab";
  if (host === "dev.azure.com" || host === "ssh.dev.azure.com" || host.endsWith(".visualstudio.com")) return "azure";
  if (host === "bitbucket.org" || host.endsWith(".bitbucket.org")) return "bitbucket";
  return "other";
}

/** Parse a clone URL, or null when it is not one. Never throws, never retains credentials. */
export function parseGitRemote(raw: string): GitRemote | null {
  const url = String(raw ?? "").trim();
  if (!url) return null;
  let scheme: "https" | "ssh";
  let host: string;
  let rest: string;
  const https = HTTPS_RE.exec(url);
  const sshUrl = SSH_URL_RE.exec(url);
  const scp = SCP_RE.exec(url);
  if (https) { scheme = "https"; host = https[1]!; rest = https[2]!; }
  else if (sshUrl) { scheme = "ssh"; host = sshUrl[1]!; rest = sshUrl[2]!; }
  else if (scp) { scheme = "ssh"; host = scp[1]!; rest = scp[2]!; }
  else return null;
  const segs = rest.replace(/[?#].*$/, "").split("/").filter(Boolean);
  const last = segs.length ? segs[segs.length - 1]! : "";
  const repo = last.replace(/\.git$/i, "");
  if (!repo) return null;
  host = host.toLowerCase();
  return { host, scheme, provider: providerOf(host), repo, owner: segs.slice(0, -1).join("/") };
}

/** A filename/env-safe token for a host: `dev.azure.com` -> `dev_azure_com`. Clamped so the derived
 *  vault ref stays inside cred_vault's 120-char ref charset. */
export function gitHostSlug(host: string): string {
  return String(host ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 100);
}

/** Every host-scoped git credential ref starts with this. The LEGACY host-agnostic ref is exactly
 *  `git_pat` (no trailing underscore), so it can never be mistaken for a scoped one. */
export const GIT_CRED_PREFIX = "git_pat_";
export const GIT_CRED_LEGACY_REF = "git_pat";
/** The OS-vault ref that holds this host's token: `git_pat_github_com`. "" for an unusable host. */
export function gitCredRef(host: string): string {
  const slug = gitHostSlug(host);
  return slug ? `${GIT_CRED_PREFIX}${slug}` : "";
}
/** The env var the vault token is injected as: `LUCID_GIT_PAT_GITHUB_COM`. "" for an unusable host. */
export function gitTokenEnvName(host: string): string {
  const slug = gitHostSlug(host);
  return slug ? `LUCID_GIT_PAT_${slug.toUpperCase()}` : "";
}
/** Inverse, for main.ts: turn a stored vault ref back into the env var name. Null when the ref is not a
 *  host-scoped git credential (including the legacy `git_pat`, which main injects as LUCID_GIT_PAT). */
export function gitEnvNameFromRef(ref: string): string | null {
  const r = String(ref ?? "");
  if (!r.startsWith(GIT_CRED_PREFIX)) return null;
  const slug = r.slice(GIT_CRED_PREFIX.length).toLowerCase().replace(/[^a-z0-9_]/g, "");
  return slug ? `LUCID_GIT_PAT_${slug.toUpperCase()}` : null;
}

export function providerLabel(p: GitProvider): string {
  return p === "github" ? "GitHub" : p === "gitlab" ? "GitLab" : p === "azure" ? "Azure DevOps" : p === "bitbucket" ? "Bitbucket" : "Git";
}

/** Presentation-pure: what credential THIS remote actually needs, in one line for the spawn form. */
export function gitAuthHint(r: GitRemote): string {
  if (r.scheme === "ssh") return `SSH: authenticated by the ssh keys already on this machine - no token needed.`;
  switch (r.provider) {
    case "github": return `Private repo? A GitHub personal access token (classic: repo; fine-grained: Contents read).`;
    case "gitlab": return `Private repo? A GitLab personal access token with read_repository.`;
    case "azure": return `Private repo? An Azure DevOps personal access token with Code (Read).`;
    case "bitbucket": return `Private repo? A Bitbucket app password with Repositories read.`;
    default: return `Private repo? A personal access token for ${r.host}.`;
  }
}
