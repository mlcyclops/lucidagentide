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
// decided so. A git failure is "unknown", not "clean": that one gate call fails open and the ownership
// ledger is kept, rather than pruned to nothing.

import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { CheckoutOwners, briefing, normalizeCheckoutPath, peersView, type PeersViewResult } from "./checkout_owners.ts";
import { gitSweeps, sweepDecision, type GitSweep } from "./git_sweep.ts";

/** One live agent session, as the registry needs to know it. */
export interface CheckoutSession { id: string; name: string; cwd: string; task: string; running: boolean }

export interface CheckoutRegistryDeps {
  /** The main composer plus every fleet spoke, live. */
  sessions: () => CheckoutSession[];
  /** Dirty paths (relative to root, forward slashes) via `git status`; null when git could not answer
   *  (not installed, timed out, failed). Null is NOT a clean tree: nothing is pruned on it. */
  gitStatus: (root: string) => Promise<string[] | null>;
  now?: () => number;
}

/** How long one `git status` answer stands in for the next ones. */
const STATUS_TTL_MS = 2_000;
/** Cache bounds. Directory lookups are per distinct directory (the checkin_peers tool accepts any
 *  absolute cwd), status snapshots per checkout; both are hints that can be recomputed, so the
 *  oldest entries are simply dropped. The owner ledger itself is bounded by git's dirty set. */
const ROOTS_CAP = 1_024;
const STATUS_CAP = 64;

/** Map.set that drops the oldest entries past `cap` (insertion order; a re-set moves the key to the end). */
function setBounded<K, V>(m: Map<K, V>, k: K, v: V, cap: number): void {
  m.delete(k);
  m.set(k, v);
  while (m.size > cap) m.delete(m.keys().next().value as K);
}

/** The real on-disk form of `p`: junctions, symlinks and substituted drives resolved, so one checkout
 *  opened through two aliases is ONE root (otherwise each alias saw an empty checkout and the gate let
 *  a sweep through). The deepest existing ancestor is resolved and any not-yet-created tail re-appended,
 *  so a path the agent is about to create still maps into its checkout. */
function realPath(p: string): string {
  let head = resolve(p);
  const tail: string[] = [];
  for (;;) {
    try { return tail.length ? join(realpathSync.native(head), ...tail.reverse()) : realpathSync.native(head); }
    catch {
      const up = dirname(head);
      if (up === head) return resolve(p);
      tail.push(basename(head));
      head = up;
    }
  }
}

/** A scoped sweep's pathspecs (relative to `base`) as root-relative keys, or null when they reach the
 *  whole checkout (one names the root itself) or name nothing inside it: both are weighed as a whole-tree
 *  sweep, the conservative reading. */
function scopeOf(root: string, base: string, paths: string[]): string[] | null {
  const out: string[] = [];
  for (const p of paths) {
    const key = normalizeCheckoutPath(realPath(resolve(base, p)));
    if (key === root) return null;
    if (key.startsWith(`${root}/`)) out.push(key.slice(root.length + 1));
  }
  return out.length ? out : null;
}

/** Is root-relative `rel` (normalized) the pathspec or under it? */
function inScope(rel: string, scope: string[]): boolean {
  return scope.some((s) => rel === s || rel.startsWith(`${s}/`));
}

export class CheckoutRegistry {
  readonly owners = new CheckoutOwners();
  readonly #deps: CheckoutRegistryDeps;
  readonly #roots = new Map<string, string | null>();
  readonly #status = new Map<string, { at: number; dirty: string[]; pending: Promise<string[] | null> | null }>();

  constructor(deps: CheckoutRegistryDeps) { this.#deps = deps; }

  #now(): number { return this.#deps.now?.() ?? Date.now(); }

  /** The checkout root holding `p` (a file or directory), or null outside any checkout. A `.git`
   *  FILE counts too (a linked worktree), and that worktree is its own root: two worktrees of one
   *  repo are two working trees, so sessions in them never overlap. Roots are keyed by the REAL path
   *  (realPath), so aliases of one checkout agree. */
  root(p: string): string | null {
    if (!p || !isAbsolute(p)) return null;
    let dir = resolve(p);
    try { if (!statSync(dir).isDirectory()) dir = dirname(dir); } catch { dir = dirname(dir); }
    const key = normalizeCheckoutPath(dir);
    const cached = this.#roots.get(key);
    if (cached !== undefined) return cached;
    let found: string | null = null;
    for (let d = realPath(dir); ; d = dirname(d)) {
      if (existsSync(join(d, ".git"))) { found = normalizeCheckoutPath(d); break; }
      if (dirname(d) === d) break;
    }
    setBounded(this.#roots, key, found, ROOTS_CAP);
    return found;
  }

  /** A session wrote `absPath` (a relative path resolves against `cwd`). Outside a checkout: ignored.
   *  Recorded under its real path, the same form root() and git's relative paths join to. */
  recordWrite(owner: { id: string; name: string }, path: string, cwd: string): void {
    const abs = realPath(isAbsolute(path) ? path : resolve(cwd, path));
    const root = this.root(abs);
    if (root) this.owners.record(root, abs, owner, this.#now());
  }

  /** Dirty paths for `root`, from git, cached for STATUS_TTL_MS; null when git could not answer (never
   *  cached, so the next asker retries). Concurrent askers share one call. */
  dirty(root: string): Promise<string[] | null> {
    const now = this.#now();
    const c = this.#status.get(root);
    if (c && now - c.at < STATUS_TTL_MS) return c.pending ?? Promise.resolve(c.dirty);
    if (c?.pending) return c.pending;
    const pending = this.#deps.gitStatus(root).catch(() => null).then((dirty) => {
      if (dirty) setBounded(this.#status, root, { at: this.#now(), dirty, pending: null }, STATUS_CAP);
      else this.#status.delete(root);
      return dirty;
    });
    setBounded(this.#status, root, { at: now, dirty: c?.dirty ?? [], pending }, STATUS_CAP);
    return pending;
  }

  /** The /api/checkout/peers answer for session `meId` asking from `cwd`. */
  async peers(meId: string, cwd: string): Promise<{ root: string | null; me: { id: string; name: string } } & PeersViewResult> {
    const sessions = this.#deps.sessions();
    const me = sessions.find((s) => s.id === meId) ?? { id: meId, name: meId };
    const root = this.root(cwd);
    if (!root) return { root: null, me: { id: me.id, name: me.name }, peers: [], unowned: [] };
    // Git unavailable: say nothing about files this time, and keep the ledger for the next answer.
    const status = await this.dirty(root);
    const dirtyRel = status ?? [];
    if (status) this.#prune(root, status);
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
    // A `git -C <dir>` sweep lands in <dir>'s checkout, not the caller's: a session sitting outside a
    // checkout and reaching in with -C is gated on the tree it reaches into. One decision per root.
    const byRoot = new Map<string, { sweep: GitSweep; scope: string[] | null }[]>();
    for (const s of sweeps) {
      const base = s.dir ? (isAbsolute(s.dir) ? s.dir : resolve(cwd, s.dir)) : cwd;
      const root = this.root(base);
      if (!root) continue;
      const list = byRoot.get(root) ?? [];
      list.push({ sweep: s, scope: s.paths ? scopeOf(root, base, s.paths) : null });
      byRoot.set(root, list);
    }
    if (byRoot.size === 0) return { block: false };
    const sessions = this.#deps.sessions();
    const me = sessions.find((s) => s.id === meId) ?? { id: meId, name: meId };
    for (const [root, list] of byRoot) {
      const dirtyRel = await this.dirty(root);
      // Git could not answer: fail open for THIS call only (the ledger is kept for the next one).
      if (!dirtyRel) continue;
      this.#prune(root, dirtyRel);
      const dirty = dirtyRel.map((rel) => ({ path: rel, owner: this.owners.owner(root, join(root, rel)) }));
      for (const { sweep, scope } of list) {
        // A sweep scoped to named paths is weighed against the dirty files under them; my own files stay
        // in so the refusal can still list what I may stage.
        const weighed = scope ? dirty.filter((d) => d.owner?.id === me.id || inScope(normalizeCheckoutPath(d.path), scope)) : dirty;
        const d = sweepDecision({ sweeps: [sweep], me: { id: me.id, name: me.name }, dirty: weighed });
        if (d.block) return d;
      }
    }
    return { block: false };
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

/** Run git status for `root` with the given executable; null on any failure (no git, not a repo,
 *  timeout). Null is deliberately not [], which would read as "clean" and prune every owner. */
export async function gitDirtyPaths(gitExe: string, root: string, timeoutMs = 8_000): Promise<string[] | null> {
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
    return code === 0 ? parsePorcelainZ(out) : null;
  } catch { return null; }
}
