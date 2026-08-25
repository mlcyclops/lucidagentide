// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/workspace.ts
//
// The workspace = the folder the agent actually works in (the cwd the omp ACP
// process + session run under). Defaults to the LucidAgentIDE repo. Local folders
// are selected directly; remote GitHub/GitLab repos are cloned under
// ~/.omp/lucid-workspaces/<name> and then opened. Current + recent are persisted
// in the GUI settings store.

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { load, save } from "./settings_store.ts";
import { gitTokenEnvName, parseGitRemote } from "./git_url.ts";

const REPO = join(import.meta.dir, "..");

/** A STABLE, version-independent default workspace (ADR-0111). Chat sessions are matched by the cwd
 *  recorded INSIDE each session file (sessions.ts: `norm(scwd) === norm(currentWorkspace())`), so the
 *  default cwd must never change across app versions — otherwise every prior chat is orphaned on upgrade
 *  (the exact "I lose my chat history when I update" bug).
 *  - Dev-from-source: the checkout is a real git repo and a good default, so keep REPO.
 *  - Packaged app: `import.meta.dir` points into the versioned install dir (resources/repo, no .git),
 *    which changes every release. Fall back to a fixed `~/.omp/lucid-workspaces/default` instead. */
export function defaultWorkspace(): string {
  if (existsSync(join(REPO, ".git"))) return REPO; // dev-from-source: the repo itself
  const dir = join(homedir(), ".omp", "lucid-workspaces", "default");
  try { mkdirSync(dir, { recursive: true }); } catch { /* best-effort */ }
  return existsSync(dir) ? dir : REPO; // only fall back to the install dir if we truly can't create it
}

export function currentWorkspace(): string {
  const w = load().workspace;
  return w && existsSync(w) ? w : defaultWorkspace();
}
export function isGitRepo(p: string): boolean { return existsSync(join(p, ".git")); }
export function wsName(p: string): string { return basename(p.replace(/[\\/]+$/, "")) || p; }

export function recent(): { path: string; name: string; isGit: boolean }[] {
  const cur = currentWorkspace();
  return (load().recentWorkspaces ?? []).filter((p) => existsSync(p) && p !== cur).map((p) => ({ path: p, name: wsName(p), isGit: isGitRepo(p) }));
}
export interface WorkspaceInfo { current: string; name: string; isGit: boolean; recent: { path: string; name: string; isGit: boolean }[] }
export function workspaceInfo(): WorkspaceInfo {
  const cur = currentWorkspace();
  return { current: cur, name: wsName(cur), isGit: isGitRepo(cur), recent: recent() };
}

export function setWorkspace(path: string): WorkspaceInfo {
  if (existsSync(path)) {
    const s = load();
    s.workspace = path;
    s.recentWorkspaces = [path, ...(s.recentWorkspaces ?? []).filter((p) => p !== path)].slice(0, 10);
    save(s);
  }
  return workspaceInfo();
}

/** Drop one folder from the recents list. Never touches the current workspace (so no backend respawn is
 *  needed - the active cwd is unchanged). Idempotent: removing an absent path is a no-op. */
export function removeRecentWorkspace(path: string): WorkspaceInfo {
  const s = load();
  const prev = s.recentWorkspaces ?? [];
  const next = prev.filter((p) => p !== path);
  if (next.length !== prev.length) { s.recentWorkspaces = next; save(s); }
  return workspaceInfo();
}

/** The on-disk folder name for a clone. Windows silently DROPS trailing dots/spaces from folder names, so
 *  a repo like `l.e.a.p.s..git` (→ raw name `l.e.a.p.s.`) would be created as `l.e.a.p.s`, desyncing the
 *  `.git` reuse check below and stranding failed clones. We strip leading/trailing dots+spaces so the name
 *  we compute is the name the OS actually creates. Exported for tests. */
export function repoNameFromUrl(url: string): string {
  const m = url.replace(/\.git$/i, "").match(/[\\/:]([^\\/:]+)$/);
  const safe = (m?.[1] ?? "repo").replace(/[^A-Za-z0-9._-]/g, "");
  return safe.replace(/^[.\s]+|[.\s]+$/g, "") || "repo";
}

/** A git-host token from the environment, chosen by the URL's host, or null when none applies. Only https
 *  hosts get header injection — ssh/git@ URLs authenticate with keys, not tokens. This is the reliable,
 *  HEADLESS path the agent's shell got "for free" from Git Credential Manager; the Settings clone runs git
 *  with piped stdio and no tty, so a private repo would fail there unless GCM already had a cached credential.
 *
 *  P-FLEET.L2 adds the HOST-SCOPED vault token (`LUCID_GIT_PAT_<HOST_SLUG>`, injected by main.ts from the
 *  OS-encrypted vault) as the FIRST choice. It wins because it is the most specific thing we know: the user
 *  saved that token for that host. It is also the only token an unrecognized host ever gets - a self-hosted
 *  GitLab or Azure DevOps Server works, and a random https host can never be handed the generic PAT, which
 *  would be a credential leak dressed up as a convenience. Exported for tests. */
export function hostTokenForUrl(url: string, env: Record<string, string | undefined> = process.env): string | null {
  if (!/^https:\/\//i.test(url)) return null;
  const remote = parseGitRemote(url);
  const host = remote?.host ?? "";
  if (!host) return null;
  const pick = (...names: string[]): string | null => {
    for (const n of names) { const v = env[n]; if (typeof v === "string" && v.trim()) return v.trim(); }
    return null;
  };
  const scoped = pick(gitTokenEnvName(host));
  if (scoped) return scoped;
  // LUCID_GIT_PAT is the vault-backed host-agnostic personal access token (ADR-0216) main injects at spawn -
  // the fallback after any explicit CI-style env var. Ordered last so a workflow's own GITHUB_TOKEN still wins.
  if (remote?.provider === "github") return pick("GITHUB_TOKEN", "GH_TOKEN", "LUCID_GITHUB_TOKEN", "LUCID_GIT_PAT");
  if (remote?.provider === "gitlab") return pick("GITLAB_TOKEN", "LUCID_GITLAB_TOKEN", "LUCID_GIT_PAT");
  // Azure DevOps PATs ride the same HTTP Basic header (any username, PAT as the password). SYSTEM_ACCESSTOKEN
  // is what a Pipelines run exports; AZURE_DEVOPS_EXT_PAT is what `az devops` reads.
  if (remote?.provider === "azure") return pick("AZURE_DEVOPS_EXT_PAT", "AZURE_DEVOPS_PAT", "SYSTEM_ACCESSTOKEN", "LUCID_AZURE_DEVOPS_TOKEN", "LUCID_GIT_PAT");
  return null;
}

/** The token to authenticate a clone with. An explicit override - a freshly-entered PAT passed inline from the
 *  UI so it works THIS session without waiting for the next-launch env injection - is the freshest signal and
 *  wins; otherwise fall back to the environment/vault-injected host token. Only https URLs get a token (ssh/
 *  git@ authenticate with keys), so an override on a non-https URL is ignored. Exported for tests. */
export function resolveCloneToken(url: string, override?: string | null, env: Record<string, string | undefined> = process.env): string | null {
  const ov = typeof override === "string" ? override.trim() : "";
  if (ov && /^https:\/\//i.test(url)) return ov;
  return hostTokenForUrl(url, env);
}

/** The `git clone` argv. When a token applies, inject it via a per-COMMAND `http.extraHeader` (HTTP Basic,
 *  `x-access-token:<token>`) placed BEFORE the subcommand — so the token authenticates the fetch but is
 *  NEVER written into the cloned repo's remote/config (embedding it in the URL would persist it into
 *  `.git/config`, a credential leak). Exported for tests. */
export function cloneArgv(url: string, dest: string, token: string | null): string[] {
  const clone = ["clone", url, dest];
  if (!token) return clone;
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return ["-c", `http.extraHeader=Authorization: Basic ${basic}`, ...clone];
}

/** Never let a token (or its base64) survive into a surfaced/logged error string. */
function redact(text: string, token: string | null): string {
  if (!token) return text;
  const b64 = Buffer.from(`x-access-token:${token}`).toString("base64");
  return text.split(token).join("***").split(b64).join("***");
}

/** Turn raw git stderr into a short, actionable message. Auth failures on a private repo are the common case
 *  and look nothing like a bad URL, so we name the real fix (configure a token / sign in). An SSH remote has
 *  a DIFFERENT fix (a key, not a token), so it gets its own line - telling someone to set GITHUB_TOKEN for a
 *  `git@` URL sends them to fix something git will never read. */
export function cloneErrorHint(stderr: string, hadToken: boolean, ssh = false): string {
  const s = stderr.trim();
  const auth = /authentication failed|could not read (?:username|password)|terminal prompts disabled|invalid username or password|403|permission denied|repository not found|fatal: could not read/i.test(s);
  const keyTrouble = ssh && /host key verification failed|permission denied \(publickey|no such identity|could not resolve hostname|passphrase|batch mode/i.test(s);
  if (keyTrouble || (ssh && auth)) {
    return `SSH authentication failed — this remote needs an ssh key this machine can use without a prompt. Add the key to your agent (ssh-add), or paste the https:// URL instead and use a personal access token. ${s}`.slice(0, 400);
  }
  if (auth) {
    return hadToken
      ? `Authentication failed — the configured git token was rejected (check it has access to this private repo). ${s}`.slice(0, 400)
      : `Authentication failed — this looks like a private repo. Paste a personal access token in the form (GitHub: repo · GitLab: read_repository · Azure DevOps: Code read), or clone via the agent (which uses your saved git credentials). ${s}`.slice(0, 400);
  }
  return s.slice(0, 400) || "git clone failed";
}

/** Where a clone lands when the caller names no parent: the shared workspaces root. */
export const CLONE_ROOT = (): string => join(homedir(), ".omp", "lucid-workspaces");

/** Clone a remote (GitHub / GitLab / Azure DevOps / …) and return its path. Runs git headlessly (piped
 *  stdio, no prompts), injecting a host token when available so PRIVATE repos work without an interactive
 *  credential prompt — closing the gap where the agent could clone a private repo but the Settings button
 *  couldn't. Partial/failed clones are cleaned up so a retry isn't blocked by leftovers.
 *
 *  `parentDir` (P-FLEET.L2) is the folder the user picked in the OS dialog; the repo lands inside it as
 *  `<parentDir>/<repo>`. Absent, it lands under CLONE_ROOT() as before. An already-cloned destination is
 *  REUSED, which is what makes "spawn a lane on this repo" idempotent. */
export async function cloneRepo(url: string, tokenOverride?: string, parentDir?: string): Promise<{ ok: boolean; path?: string; error?: string }> {
  url = String(url || "").trim();
  if (!/^(https?:\/\/|git@|ssh:\/\/)/.test(url)) return { ok: false, error: "Enter an https:// or git@ repo URL." };
  const parent = (parentDir ?? "").trim() || CLONE_ROOT();
  const dest = join(parent, repoNameFromUrl(url));
  if (existsSync(join(dest, ".git"))) return { ok: true, path: dest }; // already cloned → reuse
  // A prior clone that failed after creating the dir (or a Windows trailing-dot desync) leaves a non-empty,
  // .git-less folder that makes every future clone fail with "already exists and is not empty". Clear it.
  if (existsSync(dest)) { try { rmSync(dest, { recursive: true, force: true }); } catch { /* best-effort */ } }
  try { mkdirSync(dirname(dest), { recursive: true }); } catch { /* ignore */ }

  const token = resolveCloneToken(url, tokenOverride);
  const ssh = !/^https?:\/\//i.test(url);
  // GIT_TERMINAL_PROMPT=0: never hang waiting on a username/password we can't answer (piped, no tty). GCM
  // still resolves cached credentials, so this preserves the agent's working path while adding token auth.
  // GIT_SSH_COMMAND BatchMode=yes does the same job for an ssh remote: an encrypted key or an unknown host
  // key FAILS with a message instead of blocking forever on a passphrase prompt nobody can see.
  const proc = Bun.spawn(["git", ...cloneArgv(url, dest, token)], {
    stdout: "pipe", stderr: "pipe",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      ...(ssh && !process.env.GIT_SSH_COMMAND ? { GIT_SSH_COMMAND: "ssh -o BatchMode=yes" } : {}),
    },
  });
  const code = await proc.exited;
  if (code !== 0) {
    const stderr = redact(await new Response(proc.stderr).text(), token);
    try { if (existsSync(dest) && !existsSync(join(dest, ".git"))) rmSync(dest, { recursive: true, force: true }); } catch { /* best-effort */ }
    return { ok: false, error: cloneErrorHint(stderr, token != null, ssh) };
  }
  return { ok: true, path: dest };
}
