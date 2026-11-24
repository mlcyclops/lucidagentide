// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/repo_fs.ts
//
// P-PERF.IDLE1: a repo's identity (top-level folder, branch, HEAD, push target) read straight from the
// files git keeps on disk, with ZERO child processes. The titlebar chip and every fleet status poll ask
// for this; spawning 4-5 git processes per repo every few seconds cost real CPU and ran git the moment
// the app opened. Reading .git/HEAD, a ref file and the config is a few small file reads.
//
// What is reproduced, and how it maps to the git commands it replaces:
//   - root          `git rev-parse --show-toplevel`: the nearest folder upward holding a `.git` entry.
//   - git/common dir `--absolute-git-dir` / `--git-common-dir`: `.git` folder or `gitdir:` file, then
//                   `<gitdir>/commondir`.
//   - branch, head  `symbolic-ref --short HEAD` / `rev-parse --short HEAD`: HEAD, loose ref, packed-refs.
//                   The short id is always 7 chars (git lengthens it only when 7 is ambiguous).
//   - push config   `config -z --get-regexp PUSH_CONFIG_REGEXP`: a git INI parser producing the same
//                   NUL stream, so repo_identity.ts parseGitConfigZ / pushTarget run unchanged.
//   - push URL      `remote get-url --push`: pushurl (insteadOf applied), else url via pushInsteadOf, else
//                   url via insteadOf, longest prefix wins.
// Known limits, all rare for a repo's identity: `[include]` / `[includeIf]` files are NOT followed, the
// system config (/etc/gitconfig, Git for Windows' etc\gitconfig) is not read, core.worktree, GIT_DIR and
// legacy .git/remotes files are ignored, and a reftable repo reports no branch or head (its refs are a
// binary format; spawning git for them would defeat the point).

import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseGitConfigZ, pushFrom, pushTarget, PUSH_CONFIG_REGEXP, type RepoView } from "./repo_identity.ts";

/** Case-folded on Windows, where `C:\X` and `c:\x` are one folder. */
export function keyOf(p: string): string { return process.platform === "win32" ? p.toLowerCase() : p; }

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
/** Refs git keeps per worktree (in the worktree's own git dir); every other ref lives in the common dir. */
const PER_WORKTREE_REF = /^refs\/(?:bisect|worktree|rewritten)\//;
const KEY_CHAR = /[A-Za-z0-9-]/;
const SPACE = /[ \t\r\n]/;
const PUSH_KEYS = new RegExp(PUSH_CONFIG_REGEXP);

async function readText(p: string): Promise<string | null> {
  try { return await readFile(p, "utf8"); } catch { return null; }
}

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

// ---------------------------------------------------------------------------------------- root

/** The top-level folder of the repo holding `dir` (an existing folder), or null when it is in none.
 *  A folder inside a `.git` directory is in no work tree, as git says. Stops at the filesystem root or
 *  a UNC share root, where dirname() returns its input. */
export async function findRepoRoot(dir: string): Promise<string | null> {
  let cur = resolve(dir);
  for (;;) {
    if (keyOf(basename(cur)) === ".git") return null;
    if (await exists(join(cur, ".git"))) return cur;
    const up = dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
}

// ---------------------------------------------------------------------------------------- config

/** One config entry. `section` and `name` are lowercased; `sub` keeps its case for `[s "Sub"]`, is
 *  lowercased for the legacy `[s.sub]` form, and is null without a subsection. `value` null is a bare
 *  key, which git reads as boolean true. */
export interface GitConfigEntry { section: string; sub: string | null; name: string; value: string | null }

/** `[section]`, `[section "Sub"]` or `[section.sub]`, starting just after the `[`. null on a malformed
 *  header (git refuses the whole file there; this parser keeps the entries before it). */
function parseHeader(s: string, start: number): { section: string; sub: string | null; end: number } | null {
  let i = start;
  let name = "";
  for (;;) {
    const c = s[i++];
    if (c === undefined) return null;
    if (c === "]") break;
    if (SPACE.test(c)) {
      let d: string | undefined = c;
      while (d !== undefined && SPACE.test(d)) { if (d === "\n") return null; d = s[i++]; }
      if (d !== '"' || !name) return null;
      let sub = "";
      for (;;) {
        let e = s[i++];
        if (e === undefined || e === "\n") return null;
        if (e === '"') break;
        // In a subsection a backslash escapes any character (`\"` and `\\` are the useful ones).
        if (e === "\\") { e = s[i++]; if (e === undefined || e === "\n") return null; }
        sub += e;
      }
      if (s[i++] !== "]") return null;
      return { section: name, sub, end: i };
    }
    if (!KEY_CHAR.test(c) && c !== ".") return null;
    name += c.toLowerCase();
  }
  if (!name) return null;
  const dot = name.indexOf(".");
  return dot < 0 ? { section: name, sub: null, end: i } : { section: name.slice(0, dot), sub: name.slice(dot + 1), end: i };
}

/** A value after `=`, git's parse_value: leading blanks dropped, inner blanks kept as spaces, trailing
 *  blanks dropped, `"` toggles quoting, `#`/`;` outside quotes start a comment, `\t \b \n \\ \"` escapes,
 *  a trailing backslash continues the line. null on an unknown escape or an unclosed quote. */
function parseValue(s: string, start: number): { value: string; end: number } | null {
  let i = start;
  let quote = false;
  let comment = false;
  let space = 0;
  let v = "";
  while (i < s.length) {
    let c = s[i++]!;
    if (c === "\n") return quote ? null : { value: v, end: i };
    if (comment) continue;
    if (!quote && SPACE.test(c)) { if (v.length) space++; continue; }
    if (!quote && (c === "#" || c === ";")) { comment = true; continue; }
    if (space) { v += " ".repeat(space); space = 0; }
    if (c === "\\") {
      const e = s[i++];
      if (e === undefined || e === "\n") continue;
      if (e === "t") c = "\t";
      else if (e === "b") c = "\b";
      else if (e === "n") c = "\n";
      else if (e === "\\" || e === '"') c = e;
      else return null;
      v += c;
      continue;
    }
    if (c === '"') { quote = !quote; continue; }
    v += c;
  }
  return quote ? null : { value: v, end: i };
}

/** Parse one git config file the way git's config.c does. Includes are NOT followed: an `[include]` or
 *  `[includeIf]` entry is returned like any other and has no effect. Stops at the first syntax error. */
export function parseGitConfig(text: string): GitConfigEntry[] {
  const s = `${text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n")}\n`;
  const out: GitConfigEntry[] = [];
  let section = "";
  let sub: string | null = null;
  let comment = false;
  let i = 0;
  while (i < s.length) {
    const c = s[i++]!;
    if (c === "\n") { comment = false; continue; }
    if (comment || SPACE.test(c)) continue;
    if (c === "#" || c === ";") { comment = true; continue; }
    if (c === "[") {
      const h = parseHeader(s, i);
      if (!h) return out;
      ({ section, sub } = h);
      i = h.end;
      continue;
    }
    if (!/[A-Za-z]/.test(c) || !section) return out;
    let name = c.toLowerCase();
    while (i < s.length && KEY_CHAR.test(s[i]!)) name += s[i++]!.toLowerCase();
    while (s[i] === " " || s[i] === "\t") i++;
    let value: string | null = null;
    if (s[i] === "=") {
      const v = parseValue(s, i + 1);
      if (!v) return out;
      value = v.value;
      i = v.end;
    } else if (s[i] !== "\n") {
      return out;
    }
    out.push({ section, sub, name, value });
  }
  return out;
}

/** The `git config -z --get-regexp PUSH_CONFIG_REGEXP` stream for these entries, in file order: `key\nvalue\0`,
 *  or `key\0` for a bare key, exactly as git prints it. */
export function pushConfigZ(entries: GitConfigEntry[]): string {
  let out = "";
  for (const e of entries) {
    // The key exactly as `git config --get-regexp` prints it.
    const key = e.sub === null ? `${e.section}.${e.name}` : `${e.section}.${e.sub}.${e.name}`;
    if (PUSH_KEYS.test(key)) out += e.value === null ? `${key}\0` : `${key}\n${e.value}\0`;
  }
  return out;
}

/** Rewrite `url` by the longest matching prefix among `url.<base>.<variable>` entries. On a tie the
 *  first one read wins, as in git's remote.c. null when nothing matches. */
function aliasUrl(url: string, entries: GitConfigEntry[], variable: "insteadof" | "pushinsteadof"): string | null {
  let best: { base: string; len: number } | null = null;
  for (const e of entries) {
    if (e.section !== "url" || e.sub === null || e.name !== variable || e.value === null) continue;
    if (url.startsWith(e.value) && (!best || e.value.length > best.len)) best = { base: e.sub, len: e.value.length };
  }
  return best ? best.base + url.slice(best.len) : null;
}

/** The URL `git remote get-url --push <remote>` prints: the first pushurl (insteadOf applied); without
 *  one, the first url that a pushInsteadOf rewrites; else the first url with insteadOf applied. "" when
 *  the remote has no url at all. */
export function pushUrlOf(entries: GitConfigEntry[], remote: string): string {
  const values = (name: string) => entries.filter((e) => e.section === "remote" && e.sub === remote && e.name === name && e.value).map((e) => e.value!);
  const pushUrls = values("pushurl");
  if (pushUrls.length) return aliasUrl(pushUrls[0]!, entries, "insteadof") ?? pushUrls[0]!;
  const urls = values("url");
  for (const u of urls) {
    const pushAlias = aliasUrl(u, entries, "pushinsteadof");
    if (pushAlias !== null) return pushAlias;
  }
  return urls.length ? aliasUrl(urls[0]!, entries, "insteadof") ?? urls[0]! : "";
}

/** The user's global git config files in git's read order: `$XDG_CONFIG_HOME/git/config` (or
 *  `~/.config/git/config`), then `~/.gitconfig`. Home is HOME, else USERPROFILE, as Git for Windows does. */
export function globalConfigPaths(env: Record<string, string | undefined> = process.env): string[] {
  const home = env.HOME || env.USERPROFILE || homedir();
  const xdg = env.XDG_CONFIG_HOME ? join(env.XDG_CONFIG_HOME, "git", "config") : join(home, ".config", "git", "config");
  return [xdg, join(home, ".gitconfig")];
}

// ---------------------------------------------------------------------------------------- refs

/** The commit a ref points at, following symbolic refs: loose file first, then packed-refs. "" when the
 *  ref does not exist yet (an unborn branch). Only `refs/...` names without `..` are looked up, so a
 *  crafted HEAD cannot point the reader outside the git dir. */
async function resolveRef(gitDir: string, common: string, ref: string): Promise<string> {
  let packed: string | null | undefined;
  for (let depth = 0; depth < 5; depth++) {
    if (!ref.startsWith("refs/") || ref.includes("..")) return "";
    const loose = (await readText(join(PER_WORKTREE_REF.test(ref) ? gitDir : common, ref)))?.trim();
    if (loose) {
      const sym = /^ref:\s*(\S+)$/.exec(loose);
      if (sym) { ref = sym[1]!; continue; }
      return SHA.test(loose) ? loose : "";
    }
    if (packed === undefined) packed = await readText(join(common, "packed-refs"));
    for (const line of (packed ?? "").split(/\r?\n/)) {
      if (!line || line.startsWith("#") || line.startsWith("^")) continue;
      const sp = line.indexOf(" ");
      if (sp > 0 && line.slice(sp + 1).trim() === ref) return SHA.test(line.slice(0, sp)) ? line.slice(0, sp) : "";
    }
    return "";
  }
  return "";
}

// ---------------------------------------------------------------------------------------- view

export interface RepoFsOptions {
  /** Global config files, read before the repo's own. Default: globalConfigPaths(). Tests inject. */
  globalConfigs?: string[];
}

/** The git dir for a work tree root: the `.git` folder, or the target of a `.git` file's `gitdir:` line
 *  (a relative path resolves against the folder holding the file). null when there is neither. */
async function gitDirOf(root: string): Promise<string | null> {
  const dotGit = join(root, ".git");
  try {
    if ((await stat(dotGit)).isDirectory()) return dotGit;
  } catch { return null; }
  const m = /^gitdir:\s*(.+?)\s*$/.exec((await readText(dotGit))?.split("\n")[0] ?? "");
  return m ? resolve(root, m[1]!) : null;
}

/** A repo's view from its files alone (no process). null when `root` is not a work tree root with a
 *  readable HEAD. */
export async function readRepoView(root: string, opts: RepoFsOptions = {}): Promise<RepoView | null> {
  const gitDir = await gitDirOf(root);
  if (!gitDir) return null;
  const [headText, commonText] = await Promise.all([readText(join(gitDir, "HEAD")), readText(join(gitDir, "commondir"))]);
  if (headText === null) return null;
  const common = commonText?.trim() ? resolve(gitDir, commonText.trim()) : gitDir;
  const worktree = keyOf(resolve(gitDir)) !== keyOf(resolve(common));

  const globals = opts.globalConfigs ?? globalConfigPaths();
  const [globalTexts, localText, reftableDir] = await Promise.all([
    Promise.all(globals.map(readText)),
    readText(join(common, "config")),
    exists(join(common, "reftable")),
  ]);
  const local = parseGitConfig(localText ?? "");
  const wtc = local.findLast((e) => e.section === "extensions" && e.sub === null && e.name === "worktreeconfig");
  const worktreeOn = !!wtc && (wtc.value === null || /^(?:true|yes|on|1)$/i.test(wtc.value));
  const worktreeEntries = worktreeOn ? parseGitConfig((await readText(join(gitDir, "config.worktree"))) ?? "") : [];
  // git's precedence order: global (XDG, then ~/.gitconfig), local, worktree. Later wins for single keys.
  const entries = [...globalTexts.flatMap((t) => (t === null ? [] : parseGitConfig(t))), ...local, ...worktreeEntries];

  let branch = "";
  let head = "";
  const h = headText.trim();
  if (!reftableDir && h !== "ref: refs/heads/.invalid") {
    const sym = /^ref:\s*(\S+)$/.exec(h);
    if (sym) {
      const ref = sym[1]!;
      branch = ref.replace(/^refs\/(?:heads|tags|remotes)\//, "").replace(/^refs\//, "");
      head = (await resolveRef(gitDir, common, ref)).slice(0, 7);
    } else if (SHA.test(h)) {
      head = h.slice(0, 7);
    }
  }

  const cfg = parseGitConfigZ(pushConfigZ(entries));
  const target = pushTarget(cfg, branch);
  const push = target ? pushFrom(target.remote, target.branch, pushUrlOf(entries, target.remote)) : null;
  return { root, name: basename(root) || root, branch, head, worktree, remotes: cfg.remotes.size, push };
}
