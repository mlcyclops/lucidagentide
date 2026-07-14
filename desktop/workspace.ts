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
 *  Exported for tests. */
export function hostTokenForUrl(url: string, env: Record<string, string | undefined> = process.env): string | null {
  if (!/^https:\/\//i.test(url)) return null;
  let host = "";
  try { host = new URL(url).host.toLowerCase(); } catch { return null; }
  const pick = (...names: string[]): string | null => {
    for (const n of names) { const v = env[n]; if (typeof v === "string" && v.trim()) return v.trim(); }
    return null;
  };
  // LUCID_GIT_PAT is the vault-backed personal access token (ADR-0216) main injects at spawn - the host-agnostic
  // fallback after any explicit CI-style env var. Ordered last so a workflow's own GITHUB_TOKEN still wins.
  if (host === "github.com" || host.endsWith(".github.com")) return pick("GITHUB_TOKEN", "GH_TOKEN", "LUCID_GITHUB_TOKEN", "LUCID_GIT_PAT");
  if (host === "gitlab.com" || host.endsWith(".gitlab.com")) return pick("GITLAB_TOKEN", "LUCID_GITLAB_TOKEN", "LUCID_GIT_PAT");
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
 *  and look nothing like a bad URL, so we name the real fix (configure a token / sign in). */
export function cloneErrorHint(stderr: string, hadToken: boolean): string {
  const s = stderr.trim();
  const auth = /authentication failed|could not read (?:username|password)|terminal prompts disabled|invalid username or password|403|permission denied|repository not found|fatal: could not read/i.test(s);
  if (auth) {
    return hadToken
      ? `Authentication failed — the configured git token was rejected (check it has access to this private repo). ${s}`.slice(0, 400)
      : `Authentication failed — this looks like a private repo. Set a GITHUB_TOKEN (or GH_TOKEN / GITLAB_TOKEN) with repo access, or clone via the agent (which uses your saved git credentials). ${s}`.slice(0, 400);
  }
  return s.slice(0, 400) || "git clone failed";
}

/** Clone a remote (GitHub/GitLab/…) under ~/.omp/lucid-workspaces and return its path. Runs git headlessly
 *  (piped stdio, no prompts), injecting a host token when available so PRIVATE repos work without an
 *  interactive credential prompt — closing the gap where the agent could clone a private repo but the
 *  Settings button couldn't. Partial/failed clones are cleaned up so a retry isn't blocked by leftovers. */
export async function cloneRepo(url: string, tokenOverride?: string): Promise<{ ok: boolean; path?: string; error?: string }> {
  url = String(url || "").trim();
  if (!/^(https?:\/\/|git@|ssh:\/\/)/.test(url)) return { ok: false, error: "Enter an https:// or git@ repo URL." };
  const dest = join(homedir(), ".omp", "lucid-workspaces", repoNameFromUrl(url));
  if (existsSync(join(dest, ".git"))) return { ok: true, path: dest }; // already cloned → reuse
  // A prior clone that failed after creating the dir (or a Windows trailing-dot desync) leaves a non-empty,
  // .git-less folder that makes every future clone fail with "already exists and is not empty". Clear it.
  if (existsSync(dest)) { try { rmSync(dest, { recursive: true, force: true }); } catch { /* best-effort */ } }
  try { mkdirSync(dirname(dest), { recursive: true }); } catch { /* ignore */ }

  const token = resolveCloneToken(url, tokenOverride);
  // GIT_TERMINAL_PROMPT=0: never hang waiting on a username/password we can't answer (piped, no tty). GCM
  // still resolves cached credentials, so this preserves the agent's working path while adding token auth.
  const proc = Bun.spawn(["git", ...cloneArgv(url, dest, token)], {
    stdout: "pipe", stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const code = await proc.exited;
  if (code !== 0) {
    const stderr = redact(await new Response(proc.stderr).text(), token);
    try { if (existsSync(dest) && !existsSync(join(dest, ".git"))) rmSync(dest, { recursive: true, force: true }); } catch { /* best-effort */ }
    return { ok: false, error: cloneErrorHint(stderr, token != null) };
  }
  return { ok: true, path: dest };
}
