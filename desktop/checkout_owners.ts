// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/checkout_owners.ts - P-OWN.1: "one checkout, known writers".
//
// A hub session and several fleet lanes share ONE git checkout. Before this ledger nobody knew who
// else was writing there, so `git add -A` from one agent swept another agent's half-finished edits
// into its commit (PR #395). This module is the engine-side memory of "which session last wrote
// which file", plus the two read models built on top of it:
//   - peersView: for a given session ("me"), the OTHER sessions that matter right now: anyone who
//     owns a currently dirty file, and anyone still running in the root (even with no edits yet).
//     Dirty files with no recorded owner (human edits, edits from before the ledger) surface as
//     `unowned` so the agent knows the tree is not entirely its own.
//   - briefing: the standing <checkout-peers> block for a newcomer's prompt preamble. Metadata only:
//     names, ids, task summaries (capped), relative paths, counts. Never file contents.
//
// Pure module, no I/O: dev.ts records writes from the file-write audit path and calls release after
// a commit succeeds; git_broker supplies the dirty list. Paths are normalized once on the way in
// (forward slashes, lowercase on win32) so that the same file reported by different tools with
// different casing or separators collapses to one key. Last writer owns a file: two sessions
// editing the same path is exactly the collision this feature exists to surface, and the newest
// recorded write is the best available answer to "whose edit is in the working tree right now".

export type Owner = { id: string; name: string };
export type OwnerAt = Owner & { at: number };

export type CheckoutSession = { id: string; name: string; task: string; running: boolean };
export type CheckoutPeer = { id: string; name: string; task: string; running: boolean; files: string[] };
export interface PeersViewResult { peers: CheckoutPeer[]; unowned: string[] }

const UNOWNED_CAP = 40;

/** Canonical key for a checkout path: forward slashes, duplicate separators collapsed, trailing
 *  separator dropped, lowercase on win32 (NTFS is case-insensitive; git reports the on-disk case,
 *  editors report what the user typed). `platform` is injectable so tests cover both branches. */
export function normalizeCheckoutPath(p: string, platform: string = process.platform): string {
  let s = p.replace(/\\/g, "/");
  // Keep a leading "//" (UNC share) but collapse every other run of slashes.
  const unc = s.startsWith("//");
  s = s.replace(/\/{2,}/g, "/");
  if (unc) s = `/${s}`;
  // Drop trailing slashes unless the path IS a root ("/" or "c:/").
  while (s.length > 1 && s.endsWith("/") && !/^[A-Za-z]:\/$/.test(s)) s = s.slice(0, -1);
  return platform === "win32" ? s.toLowerCase() : s;
}

export class CheckoutOwners {
  private readonly roots = new Map<string, Map<string, OwnerAt>>();
  private readonly platform: string;

  constructor(platform: string = process.platform) { this.platform = platform; }

  private key(p: string): string { return normalizeCheckoutPath(p, this.platform); }

  /** Record that `owner` wrote `absPath` inside `root` at `at`. Overwrites an earlier owner of the
   *  same path (last writer owns it). */
  record(root: string, absPath: string, owner: Owner, at: number): void {
    const r = this.key(root);
    let files = this.roots.get(r);
    if (!files) { files = new Map(); this.roots.set(r, files); }
    files.set(this.key(absPath), { id: owner.id, name: owner.name, at });
  }

  /** Forget the listed paths (call after a commit lands them). Unknown paths are ignored. */
  release(root: string, absPaths: string[]): void {
    const files = this.roots.get(this.key(root));
    if (!files) return;
    for (const p of absPaths) files.delete(this.key(p));
    if (files.size === 0) this.roots.delete(this.key(root));
  }

  /** Forget every recorded write under `root`. */
  releaseAll(root: string): void { this.roots.delete(this.key(root)); }

  /** Who last wrote `absPath` in `root`, or null when nobody is on record. */
  owner(root: string, absPath: string): Owner | null {
    const e = this.roots.get(this.key(root))?.get(this.key(absPath));
    return e ? { id: e.id, name: e.name } : null;
  }

  /** Normalized absolute paths in `root` last written by `ownerId`, sorted. */
  ownedBy(root: string, ownerId: string): string[] {
    const files = this.roots.get(this.key(root));
    if (!files) return [];
    const out: string[] = [];
    for (const [p, o] of files) if (o.id === ownerId) out.push(p);
    return out.sort();
  }

  /** Fresh snapshot of every recorded write under `root`: normalized abs path -> owner. */
  owners(root: string): Map<string, OwnerAt> {
    const files = this.roots.get(this.key(root));
    const out = new Map<string, OwnerAt>();
    if (files) for (const [p, o] of files) out.set(p, { id: o.id, name: o.name, at: o.at });
    return out;
  }
}

/** Build the peers/unowned read model for `me`.
 *  - `dirtyRel`: git's dirty list, paths relative to `root` (forward slashes, as git prints them).
 *  - `sessions`: the sessions currently attached to this root (the caller filters by cwd).
 *  A peer is any session other than me that owns at least one currently dirty file, or that is
 *  running in this root (then its file list may be empty). Owners of dirty files who are no longer
 *  in `sessions` still appear (name from the ledger, empty task, idle): their edits are still in the
 *  tree. Files owned by me appear in neither list. */
export function peersView(input: {
  root: string;
  me: Owner;
  dirtyRel: string[];
  owners: CheckoutOwners;
  sessions: CheckoutSession[];
  platform?: string;
}): PeersViewResult {
  const platform = input.platform ?? process.platform;
  const root = normalizeCheckoutPath(input.root, platform);
  const byRel = new Map<string, OwnerAt>();
  for (const [abs, o] of input.owners.owners(root)) {
    if (abs.startsWith(`${root}/`)) byRel.set(abs.slice(root.length + 1), o);
  }
  const peers = new Map<string, CheckoutPeer>();
  const sessionOf = new Map<string, CheckoutSession>();
  for (const s of input.sessions) sessionOf.set(s.id, s);
  const ensure = (id: string, name: string): CheckoutPeer => {
    let p = peers.get(id);
    if (!p) {
      const s = sessionOf.get(id);
      p = { id, name: s?.name ?? name, task: s?.task ?? "", running: s?.running ?? false, files: [] };
      peers.set(id, p);
    }
    return p;
  };
  const unowned: string[] = [];
  for (const rel of input.dirtyRel) {
    const o = byRel.get(normalizeCheckoutPath(rel, platform));
    if (!o) { unowned.push(rel); continue; }
    if (o.id === input.me.id) continue;
    ensure(o.id, o.name).files.push(rel);
  }
  for (const s of input.sessions) if (s.id !== input.me.id && s.running) ensure(s.id, s.name);
  const list = [...peers.values()];
  for (const p of list) p.files.sort();
  list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  unowned.sort();
  return { peers: list, unowned: unowned.slice(0, UNOWNED_CAP) };
}

const TASK_CAP = 160;
const FILES_CAP = 12;
const UNOWNED_LINE_CAP = 8;

function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (max <= 0) return "";
  return t.length <= max ? t : `${t.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

function listWithMore(items: string[], cap: number): string {
  if (items.length === 0) return "none";
  if (cap <= 0) return `${items.length} file${items.length === 1 ? "" : "s"}`;
  const shown = items.slice(0, cap).join(", ");
  return items.length > cap ? `${shown} (+${items.length - cap} more)` : shown;
}

function renderBriefing(view: PeersViewResult, fileCap: number, taskCap: number, peerCount: number): string {
  const lines: string[] = ["<checkout-peers>", "Other agent sessions share this git checkout. Their uncommitted edits are listed below."];
  const shown = view.peers.slice(0, peerCount);
  for (const p of shown) {
    const task = clip(p.task, taskCap);
    lines.push(`- "${p.name}" (${p.id}), ${p.running ? "running" : "idle"}${task ? `, task: ${task}` : ""}`);
    lines.push(`  files: ${listWithMore(p.files, fileCap)}`);
  }
  const dropped = view.peers.length - shown.length;
  if (dropped > 0) lines.push(`+${dropped} more session${dropped === 1 ? "" : "s"}`);
  if (view.unowned.length > 0) {
    lines.push(`Unowned dirty files (no session on record; likely the operator): ${listWithMore(view.unowned, Math.min(UNOWNED_LINE_CAP, fileCap))}`);
  }
  lines.push("Before editing a listed file, call checkin_send to its owner. git add -A, git add ., git add -u, git commit -a and bare git stash are refused while another session's edits are uncommitted: stage explicit paths you own.");
  lines.push("</checkout-peers>");
  return lines.join("\n");
}

/** Standing prompt-preamble block naming the other writers in this checkout. Empty string when
 *  there is nothing to say. Deterministic and never longer than `maxChars`: files lists shrink
 *  first, then task text, then peers are dropped behind a "+N more sessions" line. */
export function briefing(view: PeersViewResult & { root?: string | null; me?: Owner }, opts?: { maxChars?: number }): string {
  if (view.peers.length === 0 && view.unowned.length === 0) return "";
  const maxChars = opts?.maxChars ?? 900;
  let text = "";
  for (const fileCap of [FILES_CAP, 6, 3, 1, 0]) {
    text = renderBriefing(view, fileCap, TASK_CAP, view.peers.length);
    if (text.length <= maxChars) return text;
  }
  for (const taskCap of [80, 40, 0]) {
    text = renderBriefing(view, 0, taskCap, view.peers.length);
    if (text.length <= maxChars) return text;
  }
  for (let n = view.peers.length - 1; n >= 0; n--) {
    text = renderBriefing(view, 0, 0, n);
    if (text.length <= maxChars) return text;
  }
  // Only reachable with a maxChars smaller than the fixed frame: hard cut, still under the cap.
  return text.slice(0, maxChars);
}
