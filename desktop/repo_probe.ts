// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/repo_probe.ts
//
// P-REPO.1 (ADR-0406): the engine half of "which repo, and where do commits go". Three jobs:
//   1. probe a folder with git (top-level, branch, HEAD, push target), cached, non-blocking;
//   2. track, per ACP session id, the repos that session's tool calls touched (Main and every lane feed
//      the same tracker from their session/update stream, replayed history included);
//   3. list repos the user can start a spoke on without typing: local ones LUCID already knows or can
//      see next to the workspace, and the user's GitHub repos.
//
// This is a FIRST-PARTY control-plane action like repo_collect.ts and workspace.ts cloneRepo: host git
// spawned by the engine behind the loopback + token gate, never routed through the agent's tool gate.
// Every git call here is READ-ONLY (rev-parse, symbolic-ref, config --get-regexp, remote get-url), none
// of them runs hooks or reads the index, and core.fsmonitor is forced off anyway. `safe.directory=*` is
// passed because the owner's repos live on a NAS share whose files git sees as owned by another SID; a
// command-line value is protected config, so a repository cannot set it for itself.

import { readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { gitCmdDir } from "../harness/runs/sandbox_exec.ts";
import { emitSecurityEvent, type SecurityEventInput } from "./audit_export.ts";
import type { GitProvider } from "./git_url.ts";
import { parseGitConfigZ, pushFrom, pushSlug, pushTarget, PUSH_CONFIG_REGEXP, toolCallTouches, type RepoContext, type RepoView } from "./repo_identity.ts";

const GIT_TIMEOUT_MS = 6_000;
/** A repo's branch and push target change when the user or the agent runs git; 15 s keeps a chip honest
 *  without a git spawn per poll. */
const VIEW_TTL_MS = 15_000;
/** Which repo a folder belongs to almost never changes. */
const ROOT_TTL_MS = 120_000;
const MAX_TRACKED_SESSIONS = 200;
const MAX_OTHERS = 4;
const FORCED = ["-c", "safe.directory=*", "-c", "core.fsmonitor=false"];

let gitExeCache: string | undefined;
/** The host git executable: MinGit / Git for Windows found by gitCmdDir on Windows, else PATH's git. */
export function gitExe(): string {
  if (gitExeCache !== undefined) return gitExeCache;
  const dir = process.platform === "win32" ? gitCmdDir() : null;
  gitExeCache = dir ? join(dir, "git.exe") : "git";
  return gitExeCache;
}

/** Run one read-only git command in `dir`. Never throws; a timeout kills the child. The process cwd is
 *  the temp dir and the repo is named with -C, so a folder on a UNC share is never a process cwd. */
async function git(dir: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const p = Bun.spawn([gitExe(), ...FORCED, "-C", dir, ...args], { cwd: tmpdir(), stdin: "ignore", stdout: "pipe", stderr: "ignore", windowsHide: true });
    const timer = setTimeout(() => { try { p.kill(); } catch { /* already exited */ } }, GIT_TIMEOUT_MS);
    const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    clearTimeout(timer);
    return { ok: code === 0, out };
  } catch {
    return { ok: false, out: "" };
  }
}

/** Case-folded on Windows, where `C:\X` and `c:\x` are one folder. */
function keyOf(p: string): string { return process.platform === "win32" ? p.toLowerCase() : p; }

// ---------------------------------------------------------------------------------------- probing

const roots = new Map<string, { at: number; root: string | null; pending?: Promise<string | null> }>();
const views = new Map<string, { at: number; view: RepoView | null; pending?: Promise<RepoView | null> }>();

/** The nearest existing folder for a path (a file's folder; for a path not created yet, its closest
 *  existing ancestor). null when nothing on the way up exists. */
async function existingDir(p: string): Promise<string | null> {
  let cur = p;
  for (let i = 0; i < 32; i++) {
    try {
      const s = await stat(cur);
      return s.isDirectory() ? cur : dirname(cur);
    } catch {
      const up = dirname(cur);
      if (up === cur) return null;
      cur = up;
    }
  }
  return null;
}

/** The top-level folder of the repo containing `path`, or null when it is in none. Cached per folder. */
export async function repoRootOf(path: string): Promise<string | null> {
  const dir = await existingDir(path);
  if (!dir) return null;
  const k = keyOf(dir);
  const hit = roots.get(k);
  if (hit?.pending) return hit.pending;
  if (hit && Date.now() - hit.at < ROOT_TTL_MS) return hit.root;
  const pending = git(dir, ["rev-parse", "--show-toplevel"]).then((r) => {
    // git prints `C:/a/b` and `//host/share/x`; resolve() gives the native spelling the engine uses.
    const root = r.ok && r.out.trim() ? resolve(r.out.trim()) : null;
    roots.set(k, { at: Date.now(), root });
    return root;
  });
  roots.set(k, { at: hit?.at ?? 0, root: hit?.root ?? null, pending });
  return pending;
}

async function probeView(root: string): Promise<RepoView | null> {
  const [dirs, branchR, headR, cfgR] = await Promise.all([
    git(root, ["rev-parse", "--absolute-git-dir", "--git-common-dir"]),
    git(root, ["symbolic-ref", "-q", "--short", "HEAD"]),
    git(root, ["rev-parse", "--short", "HEAD"]),
    git(root, ["config", "-z", "--get-regexp", PUSH_CONFIG_REGEXP]),
  ]);
  if (!dirs.ok) return null;
  const [gitDir = "", commonRaw = ""] = dirs.out.split(/\r?\n/);
  const common = commonRaw ? resolve(root, commonRaw.trim()) : "";
  const worktree = !!gitDir && !!common && keyOf(resolve(gitDir.trim())) !== keyOf(common);
  const branch = branchR.ok ? branchR.out.trim() : "";
  const head = headR.ok ? headR.out.trim() : "";
  const cfg = parseGitConfigZ(cfgR.out);
  const target = pushTarget(cfg, branch);
  let push = null;
  if (target) {
    // `remote get-url --push` applies pushurl and url.<base>.pushInsteadOf the way `git push` will.
    const u = await git(root, ["remote", "get-url", "--push", target.remote]);
    const conf = cfg.remotes.get(target.remote);
    const url = u.ok && u.out.trim() ? u.out.trim() : (conf?.pushUrl ?? conf?.url ?? "");
    push = pushFrom(target.remote, target.branch, url);
  }
  return { root, name: basename(root) || root, branch, head, worktree, remotes: cfg.remotes.size, push };
}

/** A repo's view, at most `maxAgeMs` old. Concurrent callers share one probe. */
export async function repoView(root: string, maxAgeMs = VIEW_TTL_MS): Promise<RepoView | null> {
  const k = keyOf(root);
  const hit = views.get(k);
  if (hit?.pending) return hit.pending;
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.view;
  const pending = probeView(root).then((view) => { views.set(k, { at: Date.now(), view }); return view; });
  views.set(k, { at: hit?.at ?? 0, view: hit?.view ?? null, pending });
  return pending;
}

// ---------------------------------------------------------------------------------------- tracking

interface Track {
  /** Bumped on every change, so a cached context knows it is stale. */
  version: number;
  strong: { root: string; seq: number } | null;
  weak: { root: string; seq: number } | null;
  /** Every repo a strong call touched: root key -> { root, seq }. */
  changed: Map<string, { root: string; seq: number }>;
}
const tracks = new Map<string, Track>();
let seqCounter = 0;

function trackFor(sessionId: string): Track {
  let t = tracks.get(sessionId);
  if (t) { tracks.delete(sessionId); tracks.set(sessionId, t); return t; } // LRU: most recent last
  t = { version: 0, strong: null, weak: null, changed: new Map() };
  tracks.set(sessionId, t);
  while (tracks.size > MAX_TRACKED_SESSIONS) tracks.delete(tracks.keys().next().value!);
  return t;
}

/** Feed one ACP `tool_call` update. Fire-and-forget: resolving the repo runs off the notify handler,
 *  and a sequence number taken NOW keeps a slow resolve from overwriting a newer call's answer. */
export function observeToolCall(sessionId: string | null | undefined, update: unknown, cwd: string): void {
  if (!sessionId) return;
  const touches = toolCallTouches(update);
  if (!touches.length) return;
  const seq = ++seqCounter;
  void (async () => {
    for (const t of touches) {
      const abs = isAbsolute(t.path) ? t.path : resolve(cwd || tmpdir(), t.path);
      const root = await repoRootOf(abs);
      if (!root) continue;
      const tr = trackFor(sessionId);
      if (t.strong) {
        if (!tr.strong || tr.strong.seq < seq) tr.strong = { root, seq };
        tr.changed.set(keyOf(root), { root, seq });
        tr.version++;
      } else if (!tr.strong && (!tr.weak || tr.weak.seq < seq)) {
        // Reads steer only until the session first changes something: after that they are context.
        tr.weak = { root, seq };
        tr.version++;
      }
    }
  })();
}

/** The repo a session is working on, fresh (probes git as needed). */
export async function repoContext(sessionId: string | null | undefined, cwd: string): Promise<RepoContext> {
  const t = sessionId ? tracks.get(sessionId) : undefined;
  const active = t?.strong?.root ?? t?.weak?.root ?? null;
  let repo: RepoView | null = null;
  let source: RepoContext["source"] = null;
  if (active) { repo = await repoView(active); source = repo ? "activity" : null; }
  if (!repo && cwd) {
    const root = await repoRootOf(cwd);
    if (root) { repo = await repoView(root); source = repo ? "folder" : null; }
  }
  const shownKey = repo ? keyOf(repo.root) : "";
  const otherRoots = t ? [...t.changed.entries()].filter(([k]) => k !== shownKey).sort((a, b) => b[1].seq - a[1].seq).slice(0, MAX_OTHERS).map(([, v]) => v.root) : [];
  const others = (await Promise.all(otherRoots.map((r) => repoView(r)))).filter((v): v is RepoView => v !== null);
  return { cwd, repo, source, others };
}

const peeked = new Map<string, { at: number; version: number; ctx?: RepoContext; pending?: Promise<void> }>();

/** Synchronous, for status polls that must not wait on git: the last computed context for this session
 *  (undefined before the first one lands), refreshed in the background when it is stale. */
export function peekRepoContext(sessionId: string | null | undefined, cwd: string): RepoContext | undefined {
  const k = `${sessionId ?? ""}\u0001${keyOf(cwd)}`;
  let hit = peeked.get(k);
  if (!hit) {
    hit = { at: 0, version: -1 };
    peeked.set(k, hit);
    if (peeked.size > MAX_TRACKED_SESSIONS * 2) peeked.delete(peeked.keys().next().value!);
  }
  const version = sessionId ? (tracks.get(sessionId)?.version ?? 0) : 0;
  if ((hit.version !== version || Date.now() - hit.at >= VIEW_TTL_MS) && !hit.pending) {
    const entry = hit;
    entry.pending = repoContext(sessionId, cwd)
      .then((ctx) => { entry.ctx = ctx; entry.at = Date.now(); entry.version = version; }, () => { /* keep the last answer */ })
      .finally(() => { entry.pending = undefined; });
  }
  return hit.ctx;
}

// ---------------------------------------------------------------------------------------- choices

export type RepoChoiceSource = "workspace" | "lane" | "recent" | "report" | "nearby" | "clone";
export interface LocalRepoChoice {
  path: string;
  name: string;
  source: RepoChoiceSource;
  isGit: boolean;
  branch: string;
  /** `owner/repo` of the push target, or "" when the repo pushes nowhere. */
  slug: string;
  provider: GitProvider | "";
  worktree: boolean;
}
export interface RemoteRepoChoice {
  /** `owner/repo`. */
  slug: string;
  name: string;
  /** https clone URL (the host token path), never with credentials. */
  cloneUrl: string;
  private: boolean;
  pushedAt: number;
  description: string;
}

const SOURCE_ORDER: Record<RepoChoiceSource, number> = { workspace: 0, lane: 1, recent: 2, report: 3, nearby: 4, clone: 5 };
const MAX_NEARBY = 60;

/** Immediate subfolders of `dir` that are git checkouts (a `.git` folder, or a worktree's `.git` file). */
async function childRepos(dir: string): Promise<string[]> {
  let names: string[] = [];
  try { names = (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => d.name).slice(0, MAX_NEARBY); }
  catch { return []; }
  const found = await Promise.all(names.map(async (n) => {
    const p = join(dir, n);
    try { await stat(join(p, ".git")); return p; } catch { return null; }
  }));
  return found.filter((p): p is string => p !== null);
}

/** Every local folder a spoke could start in without typing a path: the workspace, live lanes' folders,
 *  recent workspaces, report repos, git checkouts directly inside the workspace and the clone root.
 *  Folders that are not repos are kept only when the user chose them before (workspace, lane, recent). */
export async function localRepoChoices(seeds: { path: string; source: RepoChoiceSource }[], scanDirs: { dir: string; source: RepoChoiceSource }[]): Promise<LocalRepoChoice[]> {
  const scanned = await Promise.all(scanDirs.map(async (s) => (await childRepos(s.dir)).map((path) => ({ path, source: s.source }))));
  const all = [...seeds, ...scanned.flat()];
  const seen = new Set<string>();
  const unique = all.filter((s) => {
    const k = keyOf(s.path.replace(/[\\/]+$/, ""));
    if (!s.path || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const rows = await Promise.all(unique.map(async (s): Promise<LocalRepoChoice | null> => {
    const dir = await existingDir(s.path);
    if (!dir || keyOf(dir) !== keyOf(resolve(s.path))) return null; // gone, or a file
    const root = await repoRootOf(dir);
    const v = root ? await repoView(root) : null;
    if (!v && (s.source === "nearby" || s.source === "clone" || s.source === "report")) return null;
    return {
      path: dir,
      name: basename(dir) || dir,
      source: s.source,
      isGit: !!v,
      branch: v?.branch ?? "",
      slug: v?.push && v.push.host ? pushSlug(v.push) : "",
      provider: v?.push && v.push.host ? v.push.provider : "",
      worktree: v?.worktree ?? false,
    };
  }));
  return rows.filter((r): r is LocalRepoChoice => r !== null)
    .sort((a, b) => SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source] || a.name.localeCompare(b.name));
}

/** Parse the GitHub REST `/user/repos` array defensively: every field is re-typed, archived repos are
 *  dropped (nothing can be pushed to them), and a clone URL that is not https://github.com is refused. */
export function parseGithubRepos(json: unknown): RemoteRepoChoice[] {
  if (!Array.isArray(json)) return [];
  const out: RemoteRepoChoice[] = [];
  for (const r of json) {
    if (!r || typeof r !== "object") continue;
    const o: Record<string, unknown> = { ...r };
    const slug = typeof o.full_name === "string" ? o.full_name : "";
    const cloneUrl = typeof o.clone_url === "string" ? o.clone_url : "";
    if (!slug || !/^https:\/\/github\.com\/[^/\s@]+\/[^/\s@]+$/.test(cloneUrl) || o.archived === true) continue;
    const pushed = typeof o.pushed_at === "string" ? Date.parse(o.pushed_at) : NaN;
    out.push({
      slug,
      name: typeof o.name === "string" ? o.name : slug.split("/").pop() ?? slug,
      cloneUrl,
      private: o.private === true,
      pushedAt: Number.isFinite(pushed) ? pushed : 0,
      description: typeof o.description === "string" ? o.description.slice(0, 160) : "",
    });
  }
  return out.sort((a, b) => b.pushedAt - a.pushedAt);
}

const GITHUB_TTL_MS = 5 * 60_000;
const GITHUB_PATH = "user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member";
let githubCache: { at: number; result: GithubRepoList } | null = null;
export interface GithubRepoList { repos: RemoteRepoChoice[]; via: "gh" | "token" | "none"; error?: string }

async function ghRepos(): Promise<{ ok: boolean; out: string }> {
  try {
    const p = Bun.spawn(["gh", "api", GITHUB_PATH], { cwd: tmpdir(), stdin: "ignore", stdout: "pipe", stderr: "ignore", windowsHide: true });
    const timer = setTimeout(() => { try { p.kill(); } catch { /* already exited */ } }, 15_000);
    const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    clearTimeout(timer);
    return { ok: code === 0, out };
  } catch { return { ok: false, out: "" }; }
}

/** The GitHub CLI's token for github.com, for cloning a private repo the picker listed through that same
 *  sign-in. Held only for the one git process (workspace.ts passes it as a per-command header, never into
 *  .git/config), never cached, never logged. "" when gh has none. */
export async function ghToken(): Promise<string> {
  try {
    const p = Bun.spawn(["gh", "auth", "token", "--hostname", "github.com"], { cwd: tmpdir(), stdin: "ignore", stdout: "pipe", stderr: "ignore", windowsHide: true });
    const timer = setTimeout(() => { try { p.kill(); } catch { /* already exited */ } }, 8_000);
    const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    clearTimeout(timer);
    return code === 0 ? out.trim() : "";
  } catch { return ""; }
}

/** The user's GitHub repos, most recently pushed first. The GitHub CLI's sign-in first (it is what the
 *  Reports panel already uses), else a GitHub token the vault or environment gives the engine. Each real
 *  request is one first-party egress SecurityEvent (the P-REPORT.10 precedent), host only. */
export async function githubRepoChoices(opts: { ghAuthed: () => Promise<boolean>; token: string | null; emit?: (e: SecurityEventInput) => void; refresh?: boolean }): Promise<GithubRepoList> {
  if (!opts.refresh && githubCache && Date.now() - githubCache.at < GITHUB_TTL_MS) return githubCache.result;
  const emit = opts.emit ?? emitSecurityEvent;
  let result: GithubRepoList;
  if (await opts.ghAuthed()) {
    const r = await ghRepos();
    emit({ category: "egress", type: "repo_list", decision: "allow", severity: "info", tool: "gh", reason: `spoke picker: gh api user/repos api.github.com (${r.ok ? "ok" : "failed"})` });
    let parsed: unknown = null;
    try { parsed = r.ok ? JSON.parse(r.out) : null; } catch { parsed = null; }
    result = r.ok ? { repos: parseGithubRepos(parsed), via: "gh" } : { repos: [], via: "gh", error: "The GitHub CLI could not list your repositories." };
  } else if (opts.token) {
    let ok = false;
    let parsed: unknown = null;
    try {
      const res = await fetch(`https://api.github.com/${GITHUB_PATH}`, { headers: { Authorization: `Bearer ${opts.token}`, Accept: "application/vnd.github+json", "User-Agent": "LUCID" }, signal: AbortSignal.timeout(15_000) });
      ok = res.ok;
      parsed = ok ? await res.json() : null;
    } catch { ok = false; }
    emit({ category: "egress", type: "repo_list", decision: "allow", severity: "info", tool: "github-api", reason: `spoke picker: GET user/repos api.github.com (${ok ? "ok" : "failed"})` });
    result = ok ? { repos: parseGithubRepos(parsed), via: "token" } : { repos: [], via: "token", error: "GitHub refused the saved token." };
  } else {
    result = { repos: [], via: "none" };
  }
  githubCache = { at: Date.now(), result };
  return result;
}
