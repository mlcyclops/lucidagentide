// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/lane_worktree.ts - P-FLEET.WT1: a fleet lane can run in its OWN git worktree of the folder the user
// picked, so two agents work on one repository at the same time without sharing a checkout.
//
// WHY. Lanes that share a checkout coordinate: a write waits while another worker's turn edits that file
// (P-WAIT.1), a sweeping `git add -A` / `commit -a` is refused while another session has uncommitted edits
// (P-OWN.1), and every agent is briefed to check in before touching a peer's files. That is the right default,
// but it serializes work the user wants in parallel. A worktree gives the lane its own files and its own
// branch (`lucid/<name>-<id>`) on the same repository, so none of that coordination applies.
//
// THE RISK, which the user accepts explicitly in the spawn form: the two branches can edit the same lines,
// and merging the lane's branch back is then the user's merge conflict to resolve. Nothing here merges,
// rebases or deletes a branch that holds work. The worktree starts at the checkout's HEAD commit, so
// uncommitted edits in the original folder are NOT in it; the spawn result says so.
//
// FIRST-PARTY control-plane git, like workspace.ts cloneRepo and repo_probe.ts: the engine runs host git
// behind the loopback + token gate, never through the agent's tool gate. Every call names the repo with -C
// and runs from the temp dir (the repo_probe rule), never prompts, and times out.

import { randomBytes } from "node:crypto";
import { rmdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { gitExe } from "../harness/runs/sandbox_exec.ts";

const GIT_TIMEOUT_MS = 60_000;
const FORCED = ["-c", "safe.directory=*", "-c", "core.fsmonitor=false"];

export interface WorktreePlan {
  /** Where the worktree is created: a sibling folder of the repo, `<repo>.lucid-worktrees/<slug>`. */
  path: string;
  /** The new branch the lane works on. */
  branch: string;
  /** The lane's cwd: the same subfolder of the worktree that the user picked inside the repo. */
  laneCwd: string;
}

/** Where the worktree goes and what it is called. Pure: `root` is the repo's top level, `cwd` the folder the
 *  user picked (the root or a folder inside it), `suffix` the uniqueness tag. The slug keeps only
 *  [a-z0-9-] so it is a valid branch name and a valid folder name on every platform. The worktree sits
 *  OUTSIDE the repo, so it never shows up as untracked files in the original checkout. */
export function worktreePlan(root: string, cwd: string, name: string, suffix: string): WorktreePlan {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "lane";
  const slug = `${base}-${suffix}`;
  const path = join(dirname(root), `${basename(root)}.lucid-worktrees`, slug);
  const sub = relative(root, cwd);
  const inside = sub && !sub.startsWith("..") && !sub.startsWith(sep);
  return { path, branch: `lucid/${slug}`, laneCwd: inside ? join(path, sub) : path };
}

async function git(dir: string, args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  try {
    const p = Bun.spawn([gitExe(), ...FORCED, "-C", dir, ...args], {
      cwd: tmpdir(), stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    const timer = setTimeout(() => { try { p.kill(); } catch { /* already exited */ } }, GIT_TIMEOUT_MS);
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    clearTimeout(timer);
    return { ok: code === 0, out: out.trim(), err: err.trim() };
  } catch (e) {
    return { ok: false, out: "", err: e instanceof Error ? e.message : String(e) };
  }
}

export type WorktreeResult =
  | ({ ok: true; root: string } & WorktreePlan)
  | { ok: false; reason: string };

/** Create the lane's worktree on a new branch from the checkout's HEAD. Every refusal names why, in words
 *  the spawn form shows verbatim. */
export async function createLaneWorktree(cwd: string, name: string): Promise<WorktreeResult> {
  const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!top.ok || !top.out) return { ok: false, reason: `"${cwd}" is not inside a git repository, so it cannot have its own worktree. Spawn it without the worktree option, or pick a folder inside a repo.` };
  // git prints forward slashes on Windows; normalize so the plan's path math matches the picked folder.
  const root = process.platform === "win32" ? top.out.replace(/\//g, "\\") : top.out;
  const head = await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  if (!head.ok) return { ok: false, reason: `the repository at "${root}" has no commits yet, so there is nothing to start a worktree from. Commit once, then spawn again.` };
  const plan = worktreePlan(root, cwd, name, randomBytes(3).toString("hex"));
  const add = await git(root, ["worktree", "add", "-b", plan.branch, plan.path, "HEAD"]);
  if (!add.ok) return { ok: false, reason: `git could not create the worktree: ${add.err.split(/\r?\n/).pop() || "unknown error"}` };
  return { ok: true, root, ...plan };
}

/** Undo a worktree whose lane never started (the spawn was refused after git made it). Only ever called on
 *  a worktree created in the same request, which has no work in it yet; best-effort. */
export async function removeLaneWorktree(wt: { root: string; path: string; branch: string }): Promise<void> {
  await git(wt.root, ["worktree", "remove", "--force", wt.path]);
  await git(wt.root, ["branch", "-D", wt.branch]);
  // On Windows the refused lane's child can still hold the folder as its cwd while git runs, so git drops the
  // files and the registration but leaves the empty directory. Retry the delete past that handle, then drop
  // the `.lucid-worktrees` parent if this was its last worktree (rmdir refuses a non-empty one).
  try { rmSync(wt.path, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* still held: an empty folder, harmless */ }
  try { rmdirSync(dirname(wt.path)); } catch { /* other worktrees live there */ }
}
