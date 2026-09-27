// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/checkout_registry.ts - P-OWN.1: who is writing in which git checkout, right now.
//
// The main composer and every fleet spoke can share one working tree. Before this, nothing tied a dirty
// file to the session that wrote it, so a spoke's `git add -A` swept another spoke's half-finished work
// into its own commit (PR #395), and a session starting in a busy checkout had no idea it was busy.
//
// This is the engine-side service over the pure pieces: checkout_owners.ts (who owns which path, the
// peers view, the briefing text) and git_sweep.ts (which git commands sweep, and the refusal). It adds
// the I/O those cannot have: the checkout root of a path (walk up to `.git`, cached per directory),
// `git status --porcelain -z` for the dirty set (cached for a couple of seconds, since every tool call
// of every session may ask), and the live session list dev.ts supplies. Truth about what is dirty is
// always git's: the owner ledger only says WHO, and an entry whose file is clean again is pruned.
//
// Metadata only: paths and names, never file contents. Every call fails soft to "no peers" rather than
// blocking a prompt; the commit gate is the one place a failure blocks, and only when the gate itself
// decided so (a git failure there is "no dirty files", so nothing to refuse).

import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { CheckoutOwners, briefing, normalizeCheckoutPath, peersView, type PeersViewResult } from "./checkout_owners.ts";
import { gitSweeps, sweepDecision } from "./git_sweep.ts";

/** One live agent session, as the registry needs to know it. */
export interface CheckoutSession { id: string; name: string; cwd: string; task: string; running: boolean }

export interface CheckoutRegistryDeps {
  /** The main composer plus every fleet spoke, live. */
  sessions: () => CheckoutSession[];
  /** Dirty paths (relative to root, forward slashes) via `git status`; [] when git is unavailable. */
  gitStatus: (root: string) => Promise<string[]>;
  now?: () => number;
}

/** How long one `git status` answer stands in for the next ones. */
const STATUS_TTL_MS = 2_000;

export class CheckoutRegistry {
  readonly owners = new CheckoutOwners();
  readonly #deps: CheckoutRegistryDeps;
  readonly #roots = new Map<string, string | null>();
  readonly #status = new Map<string, { at: number; dirty: string[]; pending: Promise<string[]> | null }>();

  constructor(deps: CheckoutRegistryDeps) { this.#deps = deps; }

  #now(): number { return this.#deps.now?.() ?? Date.now(); }

  /** The checkout root holding `p` (a file or directory), or null outside any checkout. A `.git`
   *  FILE counts too (a linked worktree), and that worktree is its own root: two worktrees of one
   *  repo are two working trees, so sessions in them never overlap. */
  root(p: string): string | null {
    if (!p || !isAbsolute(p)) return null;
    let dir = resolve(p);
    try { if (!statSync(dir).isDirectory()) dir = dirname(dir); } catch { dir = dirname(dir); }
    const key = normalizeCheckoutPath(dir);
    const cached = this.#roots.get(key);
    if (cached !== undefined) return cached;
    let found: string | null = null;
    for (let d = dir; ; d = dirname(d)) {
      if (existsSync(join(d, ".git"))) { found = normalizeCheckoutPath(d); break; }
      if (dirname(d) === d) break;
    }
    this.#roots.set(key, found);
    return found;
  }

  /** A session wrote `absPath` (a relative path resolves against `cwd`). Outside a checkout: ignored. */
  recordWrite(owner: { id: string; name: string }, path: string, cwd: string): void {
    const abs = isAbsolute(path) ? path : resolve(cwd, path);
    const root = this.root(abs);
    if (root) this.owners.record(root, abs, owner, this.#now());
  }

  /** Dirty paths for `root`, from git, cached for STATUS_TTL_MS. Concurrent askers share one call. */
  dirty(root: string): Promise<string[]> {
    const now = this.#now();
    const c = this.#status.get(root);
    if (c && now - c.at < STATUS_TTL_MS) return c.pending ?? Promise.resolve(c.dirty);
    if (c?.pending) return c.pending;
    const pending = this.#deps.gitStatus(root).catch(() => [] as string[]).then((dirty) => {
      this.#status.set(root, { at: this.#now(), dirty, pending: null });
      return dirty;
    });
    this.#status.set(root, { at: now, dirty: c?.dirty ?? [], pending });
    return pending;
  }

  /** The /api/checkout/peers answer for session `meId` asking from `cwd`. */
  async peers(meId: string, cwd: string): Promise<{ root: string | null; me: { id: string; name: string } } & PeersViewResult> {
    const sessions = this.#deps.sessions();
    const me = sessions.find((s) => s.id === meId) ?? { id: meId, name: meId };
    const root = this.root(cwd);
    if (!root) return { root: null, me: { id: me.id, name: me.name }, peers: [], unowned: [] };
    const dirtyRel = await this.dirty(root);
    this.#prune(root, dirtyRel);
    const here = sessions.filter((s) => this.root(s.cwd) === root);
    const view = peersView({ root, me: { id: me.id, name: me.name }, dirtyRel, owners: this.owners, sessions: here });
    return { root, me: { id: me.id, name: me.name }, ...view };
  }

  /** The standing prompt block for `meId` working in `cwd`; "" when nobody else is here. */
  async briefingFor(meId: string, cwd: string): Promise<string> {
    try {
      const view = await this.peers(meId, cwd);
      return view.root ? briefing(view) : "";
    } catch { return ""; }
  }

  /** The commit gate: refuse a sweeping git command while another session's edits are uncommitted. */
  async gate(meId: string, cwd: string, command: string): Promise<{ block: boolean; reason?: string }> {
    const sweeps = gitSweeps(command);
    if (sweeps.length === 0) return { block: false };
    const root = this.root(cwd);
    if (!root) return { block: false };
    const dirtyRel = await this.dirty(root);
    this.#prune(root, dirtyRel);
    const sessions = this.#deps.sessions();
    const me = sessions.find((s) => s.id === meId) ?? { id: meId, name: meId };
    const dirty = dirtyRel.map((rel) => ({ path: rel, owner: this.owners.owner(root, join(root, rel)) }));
    return sweepDecision({ sweeps, me: { id: me.id, name: me.name }, dirty });
  }

  /** Drop owner entries for files git no longer reports dirty: committed, reverted, or deleted. */
  #prune(root: string, dirtyRel: string[]): void {
    const live = new Set(dirtyRel.map((rel) => normalizeCheckoutPath(join(root, rel))));
    const stale: string[] = [];
    for (const path of this.owners.owners(root).keys()) if (!live.has(path)) stale.push(path);
    if (stale.length) this.owners.release(root, stale);
  }
}

/** Parse `git status --porcelain -z` output into paths relative to the root. A rename or copy entry
 *  carries the ORIGINAL path in a second NUL field, which is skipped. */
export function parsePorcelainZ(out: string): string[] {
  const fields = out.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]!;
    if (f.length < 4) continue;
    const xy = f.slice(0, 2);
    paths.push(f.slice(3).replaceAll("\\", "/"));
    if (xy[0] === "R" || xy[0] === "C" || xy[1] === "R" || xy[1] === "C") i++;
  }
  return paths;
}

/** Run git status for `root` with the given executable; [] on any failure (no git, not a repo, timeout). */
export async function gitDirtyPaths(gitExe: string, root: string, timeoutMs = 8_000): Promise<string[]> {
  try {
    const proc = Bun.spawn([gitExe, "-c", "core.quotepath=off", "status", "--porcelain", "-z", "--untracked-files=all"], {
      cwd: root, stdout: "pipe", stderr: "ignore", stdin: "ignore",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    });
    const timer = setTimeout(() => { try { proc.kill(); } catch { /* already gone */ } }, timeoutMs);
    timer.unref?.();
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    clearTimeout(timer);
    return code === 0 ? parsePorcelainZ(out) : [];
  } catch { return []; }
}
