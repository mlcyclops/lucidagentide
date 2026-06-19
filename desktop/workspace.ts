// desktop/workspace.ts
//
// The workspace = the folder the agent actually works in (the cwd the omp ACP
// process + session run under). Defaults to the LucidAgentIDE repo. Local folders
// are selected directly; remote GitHub/GitLab repos are cloned under
// ~/.omp/lucid-workspaces/<name> and then opened. Current + recent are persisted
// in the GUI settings store.

import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { load, save } from "./settings_store.ts";

const REPO = join(import.meta.dir, "..");

export function currentWorkspace(): string {
  const w = load().workspace;
  return w && existsSync(w) ? w : REPO;
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

function repoNameFromUrl(url: string): string {
  const m = url.replace(/\.git$/i, "").match(/[\\/:]([^\\/:]+)$/);
  return (m?.[1] ?? "repo").replace(/[^A-Za-z0-9._-]/g, "") || "repo";
}

/** Clone a remote (GitHub/GitLab/…) under ~/.omp/lucid-workspaces and return its path. */
export async function cloneRepo(url: string): Promise<{ ok: boolean; path?: string; error?: string }> {
  url = String(url || "").trim();
  if (!/^(https?:\/\/|git@|ssh:\/\/)/.test(url)) return { ok: false, error: "Enter an https:// or git@ repo URL." };
  const dest = join(homedir(), ".omp", "lucid-workspaces", repoNameFromUrl(url));
  if (existsSync(join(dest, ".git"))) return { ok: true, path: dest }; // already cloned → reuse
  try { mkdirSync(dirname(dest), { recursive: true }); } catch { /* ignore */ }
  const proc = Bun.spawn(["git", "clone", url, dest], { stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) return { ok: false, error: (await new Response(proc.stderr).text()).slice(0, 400) || "git clone failed" };
  return { ok: true, path: dest };
}
