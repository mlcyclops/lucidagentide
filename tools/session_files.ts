// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// tools/session_files.ts - ONE shared, incremental index of omp's session transcripts: `<root>/<dir>/*.jsonl`.
//
// P-PERF.IDLE1: the sessions folder grows without bound (19k transcripts in 5.5k folders on the measured machine)
// and the sidebar listing, the usage ledger and the memory snapshot's session lookup each re-stat'ed the whole
// tree on their own 15 s clocks: seconds of CPU per poll with no agent running. They share this index instead.
// It is built once by an async batched walk. After that a recursive fs.watch marks what changed and a query
// re-stats only those paths, plus the "hot" files (modified in the last `hotMs`, whose folders it also lists
// again): a change whose watcher event is still in flight is always a recent one, so read-after-write holds
// without a tree walk. No watcher (it could not start, or it errored) = a full rewalk at most every `fallbackMs`,
// the old TTL behavior; a safety rewalk runs in the background at most every `safetyMs` either way.

import { readdirSync, statSync, watch, type Dirent, type FSWatcher } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";

/** One transcript: `p` its path, `dir` its folder (full path, `<root>/<dir>`), `name` its file name. */
export interface SessionFileEntry { readonly p: string; readonly dir: string; readonly name: string; readonly mtimeMs: number; readonly size: number }

interface Options { watch: boolean; hotMs: number; fallbackMs: number; safetyMs: number }
const DEFAULTS: Options = { watch: true, hotMs: 30_000, fallbackMs: 15_000, safetyMs: 600_000 };
let options: Options = DEFAULTS;
/** Folders listed and files stat'ed concurrently by the async paths. */
const BATCH = 64;
/** Versions come from one clock, so a root's version never repeats, not even across a test reset. */
let clock = 0;

interface RootIndex {
  readonly root: string;
  files: Map<string, SessionFileEntry>;
  /** folder path -> the transcript names in it */
  dirs: Map<string, Set<string>>;
  /** newest first; null = rebuilt on the next read */
  sorted: SessionFileEntry[] | null;
  version: number;
  built: boolean;
  walk: Promise<void> | null;
  walkedAt: number;
  walks: number;
  stats: number;
  watcher: FSWatcher | null;
  dirtyFiles: Set<string>;
  dirtyDirs: Set<string>;
  /** the watcher lost track (an overflowed queue, an error): the next query rewalks */
  rewalk: boolean;
}
const indexes = new Map<string, RootIndex>();

/** A stat result: null = the path is gone, undefined = it could not be read (the entry is left as it was). */
type Probe = { mtimeMs: number; size: number; isFile(): boolean } | null | undefined;

function indexFor(root: string): RootIndex {
  let ix = indexes.get(root);
  if (!ix) {
    ix = {
      root, files: new Map(), dirs: new Map(), sorted: null, version: 0, built: false, walk: null, walkedAt: 0, walks: 0, stats: 0,
      watcher: null, dirtyFiles: new Set(), dirtyDirs: new Set(), rewalk: false,
    };
    indexes.set(root, ix);
  }
  return ix;
}

/** ENOENT / ENOTDIR: the path is not there (removed, or its folder is). Any other error says nothing. */
function gone(e: unknown): boolean {
  const code = e && typeof e === "object" && "code" in e ? e.code : undefined;
  return code === "ENOENT" || code === "ENOTDIR";
}
const probeDir = (d: string): Promise<string[] | null | undefined> => readdir(d).catch((e: unknown) => (gone(e) ? null : undefined));
const probeFile = (p: string): Promise<Probe> => stat(p).catch((e: unknown) => (gone(e) ? null : undefined));

function sortedOf(ix: RootIndex): SessionFileEntry[] {
  if (!ix.sorted) ix.sorted = [...ix.files.values()].sort((a, b) => b.mtimeMs - a.mtimeMs);
  return ix.sorted;
}

/** Record one file's fresh stat. Entries are replaced, never mutated, so a snapshot a caller holds stays as it was. */
function apply(ix: RootIndex, p: string, st: Probe): void {
  if (st === undefined) return;
  const old = ix.files.get(p);
  const dir = old?.dir ?? dirname(p);
  const name = old?.name ?? basename(p);
  if (!st || !st.isFile()) {
    if (!old) return;
    ix.files.delete(p);
    ix.dirs.get(dir)?.delete(name);
  } else {
    if (old && old.mtimeMs === st.mtimeMs && old.size === st.size) return;
    ix.files.set(p, { p, dir, name, mtimeMs: st.mtimeMs, size: st.size });
    const names = ix.dirs.get(dir);
    if (names) names.add(name);
    else ix.dirs.set(dir, new Set([name]));
  }
  ix.version = ++clock;
  ix.sorted = null;
}

/** Reconcile one folder's listing (null = the folder is gone, undefined = unreadable, left as it was). Names
 *  that vanished are dropped; new ones go to `out` to be stat'ed. */
function applyDir(ix: RootIndex, dir: string, names: string[] | null | undefined, out: Set<string>): void {
  if (names === undefined) return;
  const listed = new Set(names ? names.filter((n) => n.endsWith(".jsonl")) : []);
  const known = ix.dirs.get(dir);
  if (known) for (const n of known) if (!listed.has(n)) apply(ix, join(dir, n), null);
  for (const n of listed) if (!known?.has(n)) out.add(join(dir, n));
  if (!names) ix.dirs.delete(dir);
}

/** What a query re-checks: the watcher's (and noteSessionFileChanged's) marks, plus the hot files and their folders. */
function pending(ix: RootIndex): { dirs: string[]; files: Set<string> } {
  const files = new Set(ix.dirtyFiles);
  const dirs = new Set(ix.dirtyDirs);
  ix.dirtyFiles.clear();
  ix.dirtyDirs.clear();
  const hotFrom = Date.now() - options.hotMs;
  for (const e of sortedOf(ix)) {
    if (e.mtimeMs < hotFrom) break;
    files.add(e.p);
    dirs.add(e.dir);
  }
  return { dirs: [...dirs], files };
}

function refreshSync(ix: RootIndex): void {
  const { dirs, files } = pending(ix);
  for (const d of dirs) {
    let names: string[] | null | undefined;
    try { names = readdirSync(d); } catch (e) { names = gone(e) ? null : undefined; }
    applyDir(ix, d, names, files);
  }
  for (const p of files) {
    let st: Probe;
    ix.stats++;
    try { st = statSync(p); } catch (e) { st = gone(e) ? null : undefined; }
    apply(ix, p, st);
  }
}

async function refreshAsync(ix: RootIndex): Promise<void> {
  const { dirs, files } = pending(ix);
  for (let i = 0; i < dirs.length; i += BATCH) {
    const chunk = dirs.slice(i, i + BATCH);
    const lists = await Promise.all(chunk.map(probeDir));
    chunk.forEach((d, j) => applyDir(ix, d, lists[j], files));
  }
  const paths = [...files];
  for (let i = 0; i < paths.length; i += BATCH) {
    const chunk = paths.slice(i, i + BATCH);
    ix.stats += chunk.length;
    const sts = await Promise.all(chunk.map(probeFile));
    chunk.forEach((p, j) => apply(ix, p, sts[j]));
  }
}

/** Watcher event: a transcript (`<dir>/<name>.jsonl`) or a folder (`<dir>`) changed. Deeper paths (artifact
 *  folders) are not transcripts. A nameless event (an overflowed queue) means anything may have changed. */
function mark(ix: RootIndex, name: string | Buffer | null): void {
  if (name == null) { ix.rewalk = true; return; }
  const [dir, file, deeper] = String(name).split(/[\\/]/);
  if (!dir) return;
  if (file === undefined) ix.dirtyDirs.add(join(ix.root, dir));
  else if (deeper === undefined && file.endsWith(".jsonl")) ix.dirtyFiles.add(join(ix.root, dir, file));
}

/** Never keeps the process alive (persistent: false + unref). An error closes it; the fallback rewalk takes over
 *  and starts a new one. */
function startWatcher(ix: RootIndex): void {
  let w: FSWatcher | null = null;
  try {
    const self = watch(ix.root, { recursive: true, persistent: false }, (_event, name) => mark(ix, name));
    w = self;
    self.on("error", () => {
      self.close();
      if (ix.watcher === self) { ix.watcher = null; ix.rewalk = true; }
    });
    self.unref();
    ix.watcher = self;
  } catch {
    w?.close(); // unsupported here, or no root yet: the fallback rewalk covers it, and retries
  }
}

/** Start of a full walk: (re)start the watcher first, so nothing that changes during the walk goes unseen, and
 *  drop the marks the walk supersedes. Returns the start time. */
function beginWalk(ix: RootIndex): number {
  if (options.watch && !ix.watcher) startWatcher(ix);
  ix.dirtyFiles.clear();
  ix.dirtyDirs.clear();
  ix.rewalk = false;
  ix.walks++;
  return Date.now();
}

/** Swap in a full walk's result (null = the root could not be listed: keep what we have, rewalk next query). */
function install(ix: RootIndex, fresh: Map<string, SessionFileEntry> | null, startedAt: number): void {
  ix.walkedAt = startedAt;
  ix.built = true;
  if (!fresh) { ix.rewalk = true; return; }
  let changed = fresh.size !== ix.files.size;
  if (!changed) {
    for (const [p, e] of fresh) {
      const o = ix.files.get(p);
      if (!o || o.mtimeMs !== e.mtimeMs || o.size !== e.size) { changed = true; break; }
    }
  }
  if (!changed) return;
  ix.files = fresh;
  ix.dirs = new Map();
  for (const e of fresh.values()) {
    const names = ix.dirs.get(e.dir);
    if (names) names.add(e.name);
    else ix.dirs.set(e.dir, new Set([e.name]));
  }
  ix.version = ++clock;
  ix.sorted = null;
}

/** One full listing of every `<root>/<dir>/*.jsonl` with its stat. A missing root lists nothing. */
async function walkAsync(ix: RootIndex): Promise<Map<string, SessionFileEntry> | null> {
  const out = new Map<string, SessionFileEntry>();
  const tops = await readdir(ix.root, { withFileTypes: true }).catch((e: unknown): Dirent[] | null => (gone(e) ? [] : null));
  if (!tops) return null;
  const dirs = tops.filter((t) => t.isDirectory() || t.isSymbolicLink()).map((t) => join(ix.root, t.name));
  const found: [string, string][] = [];
  for (let i = 0; i < dirs.length; i += BATCH) {
    const chunk = dirs.slice(i, i + BATCH);
    const lists = await Promise.all(chunk.map(probeDir));
    chunk.forEach((d, j) => { for (const n of lists[j] ?? []) if (n.endsWith(".jsonl")) found.push([d, n]); });
  }
  for (let i = 0; i < found.length; i += BATCH) {
    const chunk = found.slice(i, i + BATCH);
    ix.stats += chunk.length;
    const sts = await Promise.all(chunk.map(([d, n]) => probeFile(join(d, n))));
    chunk.forEach(([dir, name], j) => {
      const st = sts[j];
      if (!st || !st.isFile()) return; // vanished mid-walk, or not a file
      const p = join(dir, name);
      out.set(p, { p, dir, name, mtimeMs: st.mtimeMs, size: st.size });
    });
  }
  return out;
}

function walkSync(ix: RootIndex): Map<string, SessionFileEntry> | null {
  const out = new Map<string, SessionFileEntry>();
  let tops: Dirent[];
  try { tops = readdirSync(ix.root, { withFileTypes: true }); } catch (e) { return gone(e) ? out : null; }
  for (const t of tops) {
    if (!t.isDirectory() && !t.isSymbolicLink()) continue;
    const dir = join(ix.root, t.name);
    let names: string[];
    try { names = readdirSync(dir); } catch { continue; } // unreadable folder
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const p = join(dir, name);
      ix.stats++;
      try {
        const st = statSync(p);
        if (st.isFile()) out.set(p, { p, dir, name, mtimeMs: st.mtimeMs, size: st.size });
      } catch { /* vanished mid-walk */ }
    }
  }
  return out;
}

/** The shared async full walk: concurrent callers join the one in flight. */
function startWalk(ix: RootIndex): Promise<void> {
  if (!ix.walk) {
    const startedAt = beginWalk(ix);
    ix.walk = walkAsync(ix).then((fresh) => install(ix, fresh, startedAt)).finally(() => { ix.walk = null; });
  }
  return ix.walk;
}

/** Is a full rewalk owed? Never built, a watcher that lost track, or no watcher and the fallback window passed. */
function walkOwed(ix: RootIndex, now: number): boolean {
  return !ix.built || ix.rewalk || (!ix.watcher && now - ix.walkedAt >= options.fallbackMs);
}

/** Every transcript under `root`, newest first. The first call builds the index (async, batched); later calls
 *  re-stat only what changed. Treat the array as read-only: it is shared until something changes. */
export async function sessionFiles(root: string): Promise<readonly SessionFileEntry[]> {
  const ix = indexFor(root);
  const now = Date.now();
  if (walkOwed(ix, now)) await startWalk(ix);
  else if (now - ix.walkedAt >= options.safetyMs) void startWalk(ix);
  await refreshAsync(ix);
  return sortedOf(ix);
}

/** sessionFiles for synchronous callers: the current snapshot, refreshed in place (a few stats). Only when no
 *  snapshot exists yet does it walk the tree, once and synchronously, and that walk seeds the shared index. A
 *  rewalk that falls due meanwhile runs in the background. */
export function sessionFilesSync(root: string): readonly SessionFileEntry[] {
  const ix = indexFor(root);
  const now = Date.now();
  if (!ix.built) {
    const startedAt = beginWalk(ix);
    install(ix, walkSync(ix), startedAt);
  } else if (walkOwed(ix, now) || now - ix.walkedAt >= options.safetyMs) void startWalk(ix);
  refreshSync(ix);
  return sortedOf(ix);
}

/** Changes whenever the index of `root` does (as of its last query): a memo key for work derived from it. */
export function sessionFilesVersion(root: string): number {
  return indexes.get(root)?.version ?? 0;
}

/** The engine's own deletes and moves: the next query re-stats `p` without waiting for the watcher. */
export function noteSessionFileChanged(p: string): void {
  for (const ix of indexes.values()) if (p.startsWith(ix.root + sep)) { ix.dirtyFiles.add(p); return; }
}

/** Test seam: close every watcher, drop every index, and set the options (defaults for anything not given). */
export function __resetSessionFiles(o: Partial<Options> = {}): void {
  for (const ix of indexes.values()) ix.watcher?.close();
  indexes.clear();
  options = { ...DEFAULTS, ...o };
}

/** Test seam: full walks run, files stat'ed (walks and refreshes), and whether a watcher is live. */
export function __sessionFilesStats(root: string): { walks: number; stats: number; watching: boolean } | null {
  const ix = indexes.get(root);
  return ix ? { walks: ix.walks, stats: ix.stats, watching: ix.watcher !== null } : null;
}
