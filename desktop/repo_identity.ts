// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/repo_identity.ts
//
// P-REPO.1 (ADR-0406): which repository a session works on, and where its commits go. PURE: no node
// builtins, no fs, no spawn, so the renderer bundles it for its labels and the unit tests need no git.
// The engine half (git probes, cache, per-session tracker) is desktop/repo_probe.ts.
//
// Two questions, answered separately because they have different sources of truth:
//   1. WHICH repo. A session's folder is often not the repo it edits (a home folder holding several
//      clones, or a worktree outside the folder). So the answer comes from the session's own tool calls:
//      the paths it edits, writes, deletes, moves and runs commands in. Reads only count until the first
//      of those, because agents read context from neighbouring repos all the time. The folder's own repo
//      is the fallback before the session has touched anything.
//   2. WHERE commits go. What a bare `git push` does on the current branch, read from git's own config
//      rules (branch.<b>.pushRemote, then remote.pushDefault, then branch.<b>.remote, then `origin` or
//      the only remote). The push URL is parsed through git_url.ts, which never keeps credentials, so no
//      `https://user:token@host` string can reach a label, a log or the renderer.

import { parseGitRemote, providerLabel, type GitProvider } from "./git_url.ts";

/** Where `git push` on the current branch goes. `host` is "" for a remote that is a local path. */
export interface RepoPush {
  /** The git remote name (`origin`, `upstream`, ...). */
  remote: string;
  /** The remote branch the push updates; "" on a detached HEAD. */
  branch: string;
  host: string;
  provider: GitProvider;
  /** Owner / group path; "" when there is none. */
  owner: string;
  repo: string;
  /** The repo's web page, or "" when the host has no known web layout. */
  webUrl: string;
}

export interface RepoView {
  /** The repository's top-level folder. */
  root: string;
  /** Folder name of `root`. */
  name: string;
  /** Current branch; "" on a detached HEAD. */
  branch: string;
  /** Short commit id of HEAD; "" in a repo with no commits yet. */
  head: string;
  /** A linked worktree (its git dir differs from the common one). */
  worktree: boolean;
  /** How many remotes the repo has; 0 means commits can only stay on this machine. */
  remotes: number;
  push: RepoPush | null;
}

/** `activity`: the repo the session's own tool calls touched last. `folder`: the session folder's repo. */
export type RepoSource = "activity" | "folder";

export interface RepoContext {
  /** The session's working folder. */
  cwd: string;
  /** The repo to show; null when neither the activity nor the folder is in a git repo. */
  repo: RepoView | null;
  source: RepoSource | null;
  /** Other repos this session touched, most recent first (the shown one excluded). */
  others: RepoView[];
}

// ---------------------------------------------------------------------------------------- git config

export interface GitRemoteConfig { url?: string; pushUrl?: string }
export interface GitBranchConfig { remote?: string; pushRemote?: string; merge?: string }
export interface PushConfig {
  remotes: Map<string, GitRemoteConfig>;
  branches: Map<string, GitBranchConfig>;
  /** remote.pushDefault: the remote every branch pushes to unless it names its own. */
  pushDefault?: string;
  /** push.default, lowercased (`simple` when unset). */
  pushMode?: string;
}

/** The regexp handed to `git config -z --get-regexp`: exactly the keys the push rules read. */
export const PUSH_CONFIG_REGEXP = "^(remote\\..*\\.(url|pushurl)|branch\\..*\\.(remote|pushremote|merge)|remote\\.pushdefault|push\\.default)$";

/** Parse `git config -z --get-regexp` output: entries end in NUL, key and value split at the first LF.
 *  git lowercases the section and the variable but keeps the subsection (remote or branch name) as
 *  written, so the name is everything between the first and the last dot. The first value wins for a
 *  multi-valued key, which is the URL git itself pushes to first. */
export function parseGitConfigZ(out: string): PushConfig {
  const cfg: PushConfig = { remotes: new Map(), branches: new Map() };
  for (const entry of String(out ?? "").split("\0")) {
    if (!entry) continue;
    const nl = entry.indexOf("\n");
    const key = nl < 0 ? entry : entry.slice(0, nl);
    const value = nl < 0 ? "" : entry.slice(nl + 1);
    const lower = key.toLowerCase();
    // Later scopes print later (system, global, local), and for a single-valued key the last one wins.
    if (lower === "remote.pushdefault") { if (value) cfg.pushDefault = value; continue; }
    if (lower === "push.default") { if (value) cfg.pushMode = value.toLowerCase(); continue; }
    const first = key.indexOf(".");
    const last = key.lastIndexOf(".");
    if (first < 0 || last <= first) continue;
    const section = key.slice(0, first).toLowerCase();
    const name = key.slice(first + 1, last);
    const variable = key.slice(last + 1).toLowerCase();
    if (!name || !value) continue;
    if (section === "remote") {
      const r = cfg.remotes.get(name) ?? {};
      if (variable === "url" && r.url === undefined) r.url = value;
      else if (variable === "pushurl" && r.pushUrl === undefined) r.pushUrl = value;
      cfg.remotes.set(name, r);
    } else if (section === "branch") {
      const b = cfg.branches.get(name) ?? {};
      if (variable === "remote") b.remote = value;
      else if (variable === "pushremote") b.pushRemote = value;
      else if (variable === "merge") b.merge = value;
      cfg.branches.set(name, b);
    }
  }
  return cfg;
}

/** The remote and remote branch a bare `git push` targets, by git's own precedence. null when the
 *  repo has no usable remote (none configured, or the branch tracks `.`, the local repository).
 *  On a detached HEAD the remote is still named (it is where a push would have to go) with branch "". */
export function pushTarget(cfg: PushConfig, branch: string): { remote: string; branch: string } | null {
  const b = branch ? cfg.branches.get(branch) : undefined;
  const fallback = cfg.remotes.has("origin") ? "origin" : cfg.remotes.size === 1 ? [...cfg.remotes.keys()][0] : undefined;
  const remote = b?.pushRemote ?? cfg.pushDefault ?? b?.remote ?? fallback;
  if (!remote || remote === "." || !cfg.remotes.has(remote)) return null;
  if (!branch) return { remote, branch: "" };
  // Only push.default=upstream pushes to a differently named tracked branch. The default (simple) and
  // `current` push to the same name; simple refuses a mismatched upstream, and the fix it prints is a
  // push to the same name, so that is the honest answer.
  const upstreamMode = cfg.pushMode === "upstream" || cfg.pushMode === "tracking";
  const tracked = upstreamMode && b?.merge && remote === b.remote ? b.merge.replace(/^refs\/heads\//, "") : "";
  return { remote, branch: tracked || branch };
}

/** The repo's web page for hosts with a known layout; "" otherwise. ssh host aliases such as
 *  `github.com-work` (an ~/.ssh/config trick for two accounts) still point at github.com. */
export function webUrlFor(host: string, provider: GitProvider, owner: string, repo: string): string {
  if (!host || !repo) return "";
  const path = owner ? `${owner}/${repo}` : repo;
  if (provider === "github") return /^(ssh\.)?github\.com(-|$)/.test(host) ? `https://github.com/${path}` : `https://${host}/${path}`;
  if (provider === "gitlab") return /^(altssh\.)?gitlab\.com(-|$)/.test(host) ? `https://gitlab.com/${path}` : `https://${host}/${path}`;
  if (provider === "bitbucket") return `https://bitbucket.org/${path}`;
  if (provider === "azure" && host === "dev.azure.com") return `https://dev.azure.com/${path}`;
  return "";
}

/** Build the push half from a remote name, a branch and the remote's push URL (as git resolved it). */
export function pushFrom(remote: string, branch: string, url: string): RepoPush {
  const r = parseGitRemote(url);
  if (r) return { remote, branch, host: r.host, provider: r.provider, owner: r.owner, repo: r.repo, webUrl: webUrlFor(r.host, r.provider, r.owner, r.repo) };
  // A local-path remote (`../bare.git`, `D:\mirrors\x`): name it by its last folder, never echo the path.
  const tail = String(url ?? "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
  return { remote, branch, host: "", provider: "other", owner: "", repo: tail.replace(/\.git$/i, "") || remote, webUrl: "" };
}

// ---------------------------------------------------------------------------------------- labels

/** `owner/repo`, or just `repo` when the remote has no owner path. */
export function pushSlug(p: RepoPush): string { return p.owner ? `${p.owner}/${p.repo}` : p.repo; }

/** Where commits go, in one line. The wording distinguishes "no remote at all" (commits stay here)
 *  from "remotes exist but this branch has none to push to", because the fixes differ. */
export function pushLabel(v: RepoView): string {
  if (!v.push) return v.remotes === 0 ? "Local only: no remote" : "No push target for this branch";
  const p = v.push;
  const where = p.host ? `${providerLabel(p.provider) === "Git" ? p.host : providerLabel(p.provider)} ${pushSlug(p)}` : `${p.remote}, a folder on disk`;
  return p.branch ? `${where} (${p.branch})` : where;
}

/** The short chip text: `repo · branch`, or `repo · @abc1234` on a detached HEAD. */
export function repoChip(v: RepoView): string {
  const at = v.branch || (v.head ? `@${v.head}` : "");
  return at ? `${v.name} \u00b7 ${at}` : v.name;
}

/** The long tooltip: every fact the chip compresses, one per line. */
export function repoTooltip(ctx: RepoContext): string {
  const v = ctx.repo;
  if (!v) return ctx.cwd ? `Not a git repository\n${ctx.cwd}` : "No folder";
  const lines = [
    `Repository: ${v.name}${v.worktree ? " (worktree)" : ""}`,
    v.root,
    `Branch: ${v.branch || (v.head ? `detached at ${v.head}` : "no commits yet")}`,
    `Pushes to: ${pushLabel(v)}`,
  ];
  if (v.push?.webUrl) lines.push(v.push.webUrl);
  lines.push(ctx.source === "activity" ? "Known from the files this session changed" : "From the session's folder");
  if (ctx.cwd && ctx.cwd !== v.root) lines.push(`Session folder: ${ctx.cwd}`);
  if (ctx.others.length) lines.push(`Also touched: ${ctx.others.map((o) => o.name).join(", ")}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------- tool calls

/** One path a tool call touched. `strong` = the call changes something there (edit, write, delete,
 *  move) or runs a command there; a read or search is weak. */
export interface ToolTouch { path: string; strong: boolean }

/** ACP ToolKind -> whether a call of that kind is a strong signal. Kinds not listed contribute nothing. */
const KIND_STRENGTH: Record<string, boolean> = { edit: true, delete: true, move: true, execute: true, read: false, search: false };
/** Input keys that name one path, and keys that name several. */
const PATH_KEYS = ["path", "file", "file_path", "filePath", "oldPath", "newPath", "target", "dir", "directory"];
const LIST_KEYS = ["paths", "files"];

/** Drop the selectors and globs this harness's tools accept on a path (`src/a.ts:50-90`, `x.ts:raw`,
 *  `src/**\/*.ts`) and anything that is a URL rather than a file (`https://`, `local://`, `agent://`).
 *  A Windows drive colon (`C:\`, `C:/`) is kept. Returns "" when nothing path-like is left. */
export function cleanToolPath(raw: string): string {
  let p = String(raw ?? "").trim().replace(/^["']|["']$/g, "");
  if (!p) return "";
  if (/^file:\/\//i.test(p)) p = decodeURIComponent(p.replace(/^file:\/\/(localhost)?/i, "")).replace(/^\/([A-Za-z]:)/, "$1");
  else if (/^[A-Za-z][A-Za-z0-9+.-]+:\/\//.test(p)) return "";
  p = p.replace(/(?<=.{2}):(?:\d[\d,+-]*|raw|conflicts|img)(?::.*)?$/i, "");
  const glob = p.search(/[*?[{]/);
  if (glob >= 0) p = p.slice(0, glob).replace(/[^\\/]*$/, "");
  return p.replace(/[\\/]+$/, "") || (glob >= 0 ? "." : "");
}

/** The folder a shell command works in, when it says so: a leading `cd <dir> &&` or `git -C <dir>`. */
export function commandDir(command: string): string {
  const s = String(command ?? "");
  const cd = /^\s*(?:cd|pushd|Set-Location)\s+("([^"]+)"|'([^']+)'|(\S+))\s*(?:&&|;|\n)/i.exec(s);
  if (cd) return cd[2] ?? cd[3] ?? cd[4] ?? "";
  const gc = /\bgit\s+(?:-c\s+\S+\s+)*-C\s+("([^"]+)"|'([^']+)'|(\S+))/.exec(s);
  return gc ? (gc[2] ?? gc[3] ?? gc[4] ?? "") : "";
}

/** Every path an ACP `tool_call` names: its `locations`, its path-like inputs, and for a command its
 *  `cwd` input or the folder its text changes into. Paths may be relative (the caller resolves them
 *  against the session folder). Kinds other than read / search / edit / delete / move / execute (think,
 *  fetch, other) contribute nothing, so a subagent task or a web fetch never moves the repo. */
export function toolCallTouches(u: unknown): ToolTouch[] {
  if (!u || typeof u !== "object") return [];
  const kind = "kind" in u && typeof u.kind === "string" ? u.kind : "";
  if (!Object.hasOwn(KIND_STRENGTH, kind)) return [];
  const strong = KIND_STRENGTH[kind] === true;
  const raw: string[] = [];
  const locations = "locations" in u ? u.locations : undefined;
  if (Array.isArray(locations)) {
    for (const l of locations) if (l && typeof l === "object" && "path" in l && typeof l.path === "string") raw.push(l.path);
  }
  const ri = "rawInput" in u && u.rawInput ? u.rawInput : "input" in u ? u.input : undefined;
  if (ri && typeof ri === "object") {
    const o: Record<string, unknown> = { ...ri };
    for (const k of PATH_KEYS) { const v = o[k]; if (typeof v === "string") raw.push(...v.split(";")); }
    for (const k of LIST_KEYS) { const v = o[k]; if (Array.isArray(v)) for (const s of v) if (typeof s === "string") raw.push(s); }
    if (kind === "execute") {
      if (typeof o.cwd === "string") raw.push(o.cwd);
      const cmd = typeof o.command === "string" ? o.command : typeof o.code === "string" ? o.code : "";
      const dir = commandDir(cmd);
      if (dir) raw.push(dir);
    }
  }
  const seen = new Set<string>();
  const out: ToolTouch[] = [];
  for (const r of raw) {
    const path = cleanToolPath(r);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    out.push({ path, strong });
  }
  return out;
}
