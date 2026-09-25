// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/git_broker.ts - P-SANDBOX.17 (ADR-0399): the contained agent's git, run on the HOST.
//
// Git for Windows cannot start inside the AppContainer (its getcwd needs GetFinalPathNameByHandleW's DOS
// form, which the mount manager denies to AppContainers, ADR-0397). So the agent's `git` is a shim
// (tools/git-broker/git.cmd) that POSTs {args, cwd} to /api/git/exec, and the engine runs the real git
// as the USER. That makes this module a confused-deputy boundary: host git has the user's full file and
// network reach, so everything the agent controls is checked before it runs.
//
//   args     an allowlist of built-in subcommands (no aliases, no external `git-*`, no global options);
//            options that run commands (`rebase -x`, `grep -O`, `--upload-pack`, `clone -c`) refused;
//            every path-like argument must resolve (junctions included) inside the workspace.
//   config   the repo's .git/config may hold only allowlisted keys (no hooks, fsmonitor, pager, editor,
//            credential helpers, filter/diff/merge drivers, includes). It is read and validated WHILE the
//            broker holds it open without write/delete sharing, and `.git` itself open without delete
//            sharing, so the agent cannot swap either between the check and git's own read.
//   forced   `-c` overrides that beat any config file: hooks point at an empty host-only dir, fsmonitor off,
//            only https transport, no submodule recursion, no detached auto-gc; editors and pagers are
//            no-ops; GIT_DIR / GIT_COMMON_DIR / GIT_WORK_TREE are set explicitly (a planted `commondir`
//            file is ignored).
//   network  fetch / pull / push / clone / ls-remote go through the sandbox's egress proxy, so the
//            agent's egress policy still decides every host.
//   OS       measured on the target host: the AppContainer cannot create a junction or hard link to
//            anything it cannot already write, so host git cannot be steered into the user's files that way.
//
// Commands that write .git/config but can execute nothing (`config`, `branch`, `remote add|rename|...`)
// run without the config hold; their result is validated on the next held call. `push -u` and tracking
// `checkout`/`switch` run held with tracking off, then set the upstream with an unheld `branch` call.

import { dlopen, FFIType, ptr, type Library } from "bun:ffi";
import { existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { win32 as w } from "node:path";

// ── pure policy ────────────────────────────────────────────────────────────────────────────────────────

/** How a subcommand touches the repo. `held`: validated config, held open for the whole call. */
interface SubSpec { repo: "required" | "optional" | "none"; network?: true; unheld?: true }
const SUBCOMMANDS: Record<string, SubSpec> = {
  add: { repo: "required" }, apply: { repo: "required" }, blame: { repo: "required" },
  branch: { repo: "required", unheld: true }, "cat-file": { repo: "required" }, checkout: { repo: "required" },
  cherry: { repo: "required" }, "cherry-pick": { repo: "required" }, clean: { repo: "required" },
  clone: { repo: "none", network: true }, commit: { repo: "required" }, config: { repo: "required", unheld: true },
  "count-objects": { repo: "required" }, describe: { repo: "required" }, diff: { repo: "optional" },
  "diff-tree": { repo: "required" }, fetch: { repo: "required", network: true }, "for-each-ref": { repo: "required" },
  "format-patch": { repo: "required" }, fsck: { repo: "required" }, gc: { repo: "required" }, grep: { repo: "required" },
  init: { repo: "none" }, log: { repo: "required" }, "ls-files": { repo: "required" },
  "ls-remote": { repo: "optional", network: true }, "ls-tree": { repo: "required" }, merge: { repo: "required" },
  "merge-base": { repo: "required" }, mv: { repo: "required" }, "name-rev": { repo: "required" },
  pull: { repo: "required", network: true }, push: { repo: "required", network: true }, "range-diff": { repo: "required" },
  rebase: { repo: "required" }, reflog: { repo: "required" }, remote: { repo: "required" }, reset: { repo: "required" },
  restore: { repo: "required" }, "rev-list": { repo: "required" }, "rev-parse": { repo: "optional" },
  revert: { repo: "required" }, rm: { repo: "required" }, shortlog: { repo: "required" }, show: { repo: "required" },
  "show-branch": { repo: "required" }, "show-ref": { repo: "required" }, stash: { repo: "required" },
  status: { repo: "required" }, switch: { repo: "required" }, "symbolic-ref": { repo: "required" },
  tag: { repo: "required" }, "update-index": { repo: "required" }, version: { repo: "none" }, whatchanged: { repo: "required" },
};
export const BROKERED_SUBCOMMANDS: readonly string[] = Object.keys(SUBCOMMANDS);

/** Long options that make git run a program, read config from the command line, or recurse into repos
 *  the broker never validated. `--opt` and `--opt=value` are both refused. */
const DENY_LONG = ["--upload-pack", "--receive-pack", "--exec", "--config", "--config-env", "--template", "--separate-git-dir",
  "--open-files-in-pager", "--recurse-submodules", "--recursive", "--unsafe-paths"];
/** Short option letters that run a program, per subcommand (also inside clusters like `-ix`). */
const DENY_SHORT: Record<string, string> = { rebase: "x", grep: "O", clone: "uc" };
/** Options whose next argument (or `=value`) is prose or a search string, not a path. */
const TEXT_OPTS = new Set(["-m", "--message", "--grep", "--author", "--committer", "-S", "-G", "--format", "--pretty"]);
/** The repo config keys host git may read. Anything else (hooks, fsmonitor, pagers, editors, credential
 *  helpers, ssh commands, filter/diff/merge drivers, includes, aliases, submodules) refuses the call. */
const CONFIG_ALLOW: readonly RegExp[] = [
  /^core\.(repositoryformatversion|filemode|bare|logallrefupdates|symlinks|ignorecase|autocrlf|eol|safecrlf|precomposeunicode|longpaths|quotepath|checkstat|trustctime|untrackedcache|fscache|preloadindex|abbrev|commentchar|whitespace|sparsecheckout|sparsecheckoutcone)$/i,
  /^remote\..+\.(url|pushurl|fetch|push|tagopt|prune|prunetags|mirror|skipdefaultupdate|skipfetchall|promisor|partialclonefilter)$/i,
  /^branch\..+\.(remote|merge|rebase|pushremote|description)$/i,
  /^user\.(name|email|signingkey|useconfigonly)$/i,
  /^init\.defaultbranch$/i, /^pull\.(rebase|ff)$/i, /^push\.(default|autosetupremote|followtags)$/i,
  /^fetch\.(prune|prunetags|writecommitgraph)$/i, /^merge\.(ff|conflictstyle)$/i, /^rebase\.(autostash|autosquash|updaterefs)$/i,
  /^commit\.(gpgsign|verbose)$/i, /^tag\.gpgsign$/i, /^gc\.(auto|autodetach|autopacklimit)$/i, /^maintenance\.(auto|strategy)$/i,
  /^extensions\.(objectformat|refstorage|partialclone|preciousobjects|noop)$/i,
  /^lfs\.(repositoryformatversion|url|locksverify|fetchinclude|fetchexclude)$/i, /^lfs\..+\.(access|locksverify)$/i,
  /^color\.[^.]+(\.[^.]+)?$/i, /^advice\.[^.]+$/i, /^status\.(showuntrackedfiles|short|branch|relativepaths)$/i,
  /^log\.(date|decorate|follow|abbrevcommit)$/i, /^diff\.(renames|algorithm|colormoved|mnemonicprefix|noprefix|context|indentheuristic|renamelimit)$/i,
  /^gui\.[^.]+$/i, /^i18n\.(commitencoding|logoutputencoding)$/i, /^index\.(version|skiphash)$/i, /^feature\.(manyfiles|experimental)$/i,
  /^checkout\.(defaultremote|workers)$/i, /^rerere\.(enabled|autoupdate)$/i,
];

/** The first repo config key host git must not read, or null when every key is allowed. */
export function refusedConfigKey(keys: readonly string[]): string | null {
  return keys.find((k) => !CONFIG_ALLOW.some((re) => re.test(k))) ?? null;
}

const within = (p: string, root: string): boolean => {
  const rel = w.relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !w.isAbsolute(rel));
};

/** Where a path-like argument lands on disk, or null when it is not path-like (a ref, a name, a URL, a
 *  pattern). Drive-relative `D:x` on another drive is treated as a path (it would resolve against that
 *  drive's own current directory on the host). */
export function argPath(value: string, cwd: string): string | null {
  if (!value || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return null; // URL: the transport policy decides
  const v = value.replace(/^:(\([^)]*\)|[/!^]*)/, ""); // pathspec magic, `:/`, `:!`
  if (/^[\\/]{2}/.test(v)) return v; // UNC or device path
  const drive = /^([a-zA-Z]):/.exec(v);
  if (drive) {
    if (/^[a-zA-Z]:[\\/]/.test(v)) return w.resolve(v);
    if (drive[1]!.toLowerCase() !== cwd.slice(0, 1).toLowerCase()) return v;
    return w.resolve(cwd, v.slice(2));
  }
  if (/^[\\/]/.test(v) || /[\\/]/.test(v) || v === ".." || v.startsWith("..")) return w.resolve(cwd, v);
  return null;
}

export type GitPlan = {
  sub: string;
  /** The argv after the subcommand, as it will run (tracking flags stripped). */
  args: string[];
  repo: SubSpec["repo"];
  network: boolean;
  /** true: validate + hold .git/config for the whole call. */
  held: boolean;
  /** `push -u`: set the upstream of each pushed branch afterwards. */
  pushUpstream: { remote: string; refs: string[] } | null;
  /** `checkout`/`switch`: the branch it may create or check out, and where it starts. */
  track: { branch: string | null; start: string | null; explicit: boolean; none: boolean; guess: string | null } | null;
  /** Every path-like argument, resolved, for the caller's real-path (junction-aware) confinement check. */
  paths: string[];
};

/** PURE: turn the agent's argv into a plan, or a refusal the agent reads on stderr. `cwd` must already be
 *  inside the workspace (the caller checks it with real paths). */
export function planGitCall(argv: readonly string[], cwd: string, workspace: string): { ok: true; plan: GitPlan } | { ok: false; reason: string } {
  const refuse = (reason: string) => ({ ok: false as const, reason });
  if (!argv.length) return refuse("usage: git <subcommand> [<args>]");
  if (argv.length === 1 && argv[0] === "--version") return planGitCall(["version"], cwd, workspace);
  const sub = argv[0]!;
  if (sub.startsWith("-")) return refuse(`global options (${sub}) are not accepted: LUCID sets git's directory, config and pager itself`);
  const spec = SUBCOMMANDS[sub];
  if (!spec) return refuse(`\`${sub}\` is not one of the git subcommands LUCID runs outside the sandbox (aliases and external git-* commands never run). Allowed: ${BROKERED_SUBCOMMANDS.join(", ")}`);
  let args = argv.slice(1);
  const paths: string[] = [];
  let skipNext = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (skipNext) { skipNext = false; continue; }
    if (a === "--") continue;
    const long = DENY_LONG.find((d) => a === d || a.startsWith(`${d}=`));
    if (long) return refuse(`\`${long}\` can make git run a program or reach an unvalidated repository, so LUCID refuses it`);
    const deny = DENY_SHORT[sub];
    if (deny && /^-[^-]/.test(a) && [...deny].some((c) => a.slice(1).includes(c))) return refuse(`\`${sub} ${a}\` can make git run a program, so LUCID refuses it`);
    const eq = a.indexOf("=");
    const opt = a.startsWith("-") ? (eq > 0 ? a.slice(0, eq) : a) : "";
    if (opt && TEXT_OPTS.has(opt)) { if (eq < 0) skipNext = true; continue; }
    if (/^-[a-zA-Z]*m$/.test(a) && sub === "commit") { skipNext = true; continue; } // `-am "message"`
    const value = a.startsWith("--") ? (eq > 0 ? a.slice(eq + 1) : "") : a.startsWith("-") ? a.slice(2) : a;
    const p = argPath(value, cwd);
    if (p) paths.push(p);
  }
  for (const p of paths) if (!within(p, workspace)) return refuse(`${p} is outside the workspace, and git here runs with your full file access`);

  let held = !spec.unheld && spec.repo !== "none";
  let network = !!spec.network;
  const positional = args.filter((a) => !a.startsWith("-"));
  if (sub === "remote") {
    const verb = positional[0];
    if (verb === undefined || ["get-url"].includes(verb)) held = false;
    else if (["add", "rename", "remove", "rm", "set-url", "set-branches"].includes(verb)) {
      if (args.some((a) => a === "-f" || a === "--fetch" || /^-[^-]*f/.test(a))) return refuse("`remote add -f` fetches while it rewrites .git/config; run `git remote add` and then `git fetch`");
      held = false;
    } else if (["show", "prune", "update", "set-head"].includes(verb)) network = true;
    else return refuse(`\`remote ${verb}\` is not supported by LUCID's git broker`);
  }
  if (sub === "config") {
    const scope = args.find((a) => ["--global", "--system", "--file", "-f", "--blob", "--edit", "-e"].includes(a) || a.startsWith("--file=") || a.startsWith("--blob="));
    if (scope) return refuse(`\`config ${scope}\` reaches beyond this repository's own config`);
  }
  if ((sub === "fetch" || sub === "pull") && args.some((a) => a === "--set-upstream")) return refuse(`\`${sub} --set-upstream\` rewrites .git/config mid-call; set it with \`git branch --set-upstream-to\``);

  let pushUpstream: GitPlan["pushUpstream"] = null;
  if (sub === "push" && args.some((a) => a === "--set-upstream" || /^-[^-o]*u/.test(a))) {
    if (args.some((a) => /^-[^-o]*u/.test(a) && a !== "-u")) return refuse("write `-u` on its own (not inside a flag cluster) so LUCID can set the upstream after the push");
    args = args.filter((a) => a !== "-u" && a !== "--set-upstream");
    const pos: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (a === "-o" || a === "--push-option" || a === "--repo") { i++; continue; }
      if (!a.startsWith("-")) pos.push(a);
    }
    if (!pos.length) return refuse("`push -u` needs the remote named: git push -u <remote> [<branch>]");
    pushUpstream = { remote: pos[0]!, refs: pos.slice(1) };
  }

  let track: GitPlan["track"] = null;
  if (sub === "checkout" || sub === "switch") {
    const create = sub === "checkout" ? ["-b", "-B"] : ["-c", "-C", "--create", "--force-create"];
    let branch: string | null = null, start: string | null = null, explicit = false, none = false;
    const pos: string[] = [];
    const kept: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (a === "--") { kept.push(...args.slice(i)); break; }
      if (a === "-t" || a === "--track" || a.startsWith("--track=")) { explicit = true; continue; }
      if (a === "--no-track") { none = true; kept.push(a); continue; }
      kept.push(a);
      if (create.includes(a)) { branch = args[i + 1] ?? null; if (branch) kept.push(branch); i++; continue; }
      if (!a.startsWith("-")) pos.push(a);
    }
    args = kept;
    if (branch) start = pos[0] ?? null;
    else if (explicit && pos[0]) { start = pos[0]; branch = pos[0].replace(/^(refs\/remotes\/)?[^/]+\//, ""); args = [...args.filter((a) => a !== pos[0]), sub === "checkout" ? "-b" : "-c", branch, pos[0]]; }
    const guess = !branch && !explicit && pos.length === 1 && !args.includes("--") ? pos[0]! : null;
    if (explicit && !branch) return refuse(`\`${sub} --track\` needs a start point`);
    track = { branch, start, explicit, none, guess };
  }
  return { ok: true, plan: { sub, args, repo: spec.repo, network, held, pushUpstream, track, paths } };
}

/** PURE: the `-c` overrides every brokered call carries. Command-line config beats every config file, so
 *  none of these can be undone from .git/config. `http.proxy` routes network commands through the
 *  sandbox's egress proxy. `--no-pager` last. */
export function forcedConfig(o: { hooksDir: string; proxyUrl: string | null }): string[] {
  const kv = [
    `core.hooksPath=${o.hooksDir}`, "core.fsmonitor=false",
    "protocol.allow=never", "protocol.https.allow=always",
    "submodule.recurse=false", "diff.ignoreSubmodules=all", "fetch.recurseSubmodules=false", "push.recurseSubmodules=no",
    "branch.autoSetupMerge=false", "gc.autoDetach=false", "maintenance.autoDetach=false",
    ...(o.proxyUrl ? [`http.proxy=${o.proxyUrl}`] : []),
  ];
  return [...kv.flatMap((c) => ["-c", c]), "--no-pager"];
}

/** PURE: the host git's environment: the engine's own minus every GIT_* and proxy variable, then the
 *  broker's. Editors are the no-op `:` (git never launches it), pagers are `cat`, prompts are off. */
export function brokerEnv(base: Record<string, string | undefined>, o: { gitDir: string | null; workTree: string | null; proxyUrl: string | null }): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !/^GIT_/i.test(k) && !/^(https?|all|no)_proxy$/i.test(k)) env[k] = v;
  Object.assign(env, { GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", PAGER: "cat", GIT_EDITOR: ":", GIT_SEQUENCE_EDITOR: ":" });
  if (o.gitDir && o.workTree) Object.assign(env, { GIT_DIR: o.gitDir, GIT_COMMON_DIR: o.gitDir, GIT_WORK_TREE: o.workTree });
  if (o.proxyUrl) Object.assign(env, { HTTPS_PROXY: o.proxyUrl, HTTP_PROXY: o.proxyUrl, NO_PROXY: "" });
  return env;
}

/** PURE: the `branch --set-upstream-to` calls a `push -u` implies, given the current branch. */
export function pushUpstreamCalls(up: { remote: string; refs: string[] }, current: string | null): string[][] {
  const refs = up.refs.length ? up.refs : current ? [current] : [];
  const out: string[][] = [];
  for (const r of refs) {
    const spec = r.replace(/^\+/, "");
    const [srcRaw, dstRaw] = spec.includes(":") ? spec.split(":", 2) as [string, string] : [spec, spec];
    const src = (srcRaw === "HEAD" ? current : srcRaw)?.replace(/^refs\/heads\//, "");
    const dst = (dstRaw === "HEAD" ? current : dstRaw)?.replace(/^refs\/heads\//, "");
    if (src && dst) out.push(["branch", `--set-upstream-to=${up.remote}/${dst}`, src]);
  }
  return out;
}

/** PURE: the repo a cwd belongs to, walking up no further than the workspace root. */
export function findRepo(cwd: string, workspace: string, io: { kind(p: string): "dir" | "file" | "reparse" | null }): { top: string; gitDir: string } | { refuse: string } | null {
  let d = cwd;
  for (;;) {
    const gitDir = w.join(d, ".git");
    const k = io.kind(gitDir);
    if (k === "reparse") return { refuse: `${gitDir} is a link; LUCID runs git only on a real .git directory` };
    if (k === "file") return { refuse: `${gitDir} is a gitfile (linked worktree or submodule); LUCID's git broker supports plain repositories` };
    if (k === "dir") {
      if (io.kind(w.join(gitDir, "commondir"))) return { refuse: `${gitDir}\\commondir redirects git elsewhere; LUCID refuses it` };
      return { top: d, gitDir };
    }
    if (w.relative(workspace, d) === "") return null;
    const up = w.dirname(d);
    if (up === d || !within(up, workspace)) return null;
    d = up;
  }
}

// ── the Windows runner ───────────────────────────────────────────────────────────────────────────────

export interface BrokerResult { code: number; stdout: Uint8Array; stderr: string; refused: string | null; sub: string }
export interface BrokerDeps { workspace: string; gitExe: string | null; proxyUrl: string | null; env?: Record<string, string | undefined> }

const OUT_CAP = 16 * 1024 * 1024;
const ERR_CAP = 1024 * 1024;

type Held = { close(): void };
const KERNEL32 = {
  CreateFileW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.i64 },
  CloseHandle: { args: [FFIType.i64], returns: FFIType.i32 },
  GetFileAttributesW: { args: [FFIType.ptr], returns: FFIType.u32 },
} as const;
let k32: Library<typeof KERNEL32> | null = null;
/** kernel32, opened on first use (Windows only: the runner refuses every other platform first). */
function kernel32(): Library<typeof KERNEL32>["symbols"] {
  k32 ??= dlopen("kernel32.dll", KERNEL32);
  return k32.symbols;
}
/** A NUL-terminated UTF-16 copy of `s` for the W APIs. */
function wide(s: string) {
  const a = new Uint16Array(s.length + 1);
  for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
  return ptr(a);
}

const GENERIC_READ = 0x80000000, FILE_LIST_DIRECTORY = 0x1, SHARE_READ = 0x1, SHARE_WRITE = 0x2;
const OPEN_EXISTING = 3, CREATE_NEW = 1, BACKUP_SEMANTICS = 0x02000000, OPEN_REPARSE_POINT = 0x00200000;
const ATTR_DIRECTORY = 0x10, ATTR_REPARSE = 0x400, INVALID_ATTRS = 0xffffffff;

/** Open `path` so nobody else can write, rename or delete it until close (share read only; a directory
 *  also shares write so git can create entries in it). Null when it cannot be held. Exported so the
 *  P-SANDBOX.17 demo can prove the share-mode guarantee on a real Windows filesystem. */
export function hold(path: string, o: { dir?: boolean; create?: boolean } = {}): Held | null {
  const sym = kernel32();
  const h = BigInt(sym.CreateFileW(wide(path), o.dir ? FILE_LIST_DIRECTORY : GENERIC_READ, o.dir ? SHARE_READ | SHARE_WRITE : SHARE_READ, null,
    o.create ? CREATE_NEW : OPEN_EXISTING, o.dir ? BACKUP_SEMANTICS | OPEN_REPARSE_POINT : OPEN_REPARSE_POINT, null));
  if (h === -1n) return null;
  return { close: () => { sym.CloseHandle(h); } };
}

function pathKind(p: string): "dir" | "file" | "reparse" | null {
  const a = kernel32().GetFileAttributesW(wide(p));
  if (a === INVALID_ATTRS) return null;
  return a & ATTR_REPARSE ? "reparse" : a & ATTR_DIRECTORY ? "dir" : "file";
}

/** The deepest existing ancestor's real path (junctions resolved) plus the rest, lexically. */
function realish(p: string): string {
  let head = p, tail = "";
  for (;;) {
    try { return w.join(realpathSync.native(head), tail); } catch { /* missing: climb */ }
    const up = w.dirname(head);
    if (up === head) return p;
    tail = tail ? w.join(w.basename(head), tail) : w.basename(head);
    head = up;
  }
}

async function run(gitExe: string, argv: string[], o: { cwd: string; env: Record<string, string>; timeoutMs: number }): Promise<{ code: number; stdout: Uint8Array; stderr: string }> {
  const proc = Bun.spawn([gitExe, ...argv], { cwd: o.cwd, env: o.env, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; proc.kill(); }, o.timeoutMs);
  const read = async (s: ReadableStream<Uint8Array>, cap: number) => {
    const chunks: Uint8Array[] = [];
    let n = 0;
    for await (const c of s) { if (n < cap) { chunks.push(c.subarray(0, cap - n)); } n += c.length; }
    return { bytes: Buffer.concat(chunks), cut: n > cap };
  };
  const [out, err] = await Promise.all([read(proc.stdout, OUT_CAP), read(proc.stderr, ERR_CAP)]);
  const code = await proc.exited;
  clearTimeout(timer);
  let stderr = err.bytes.toString("utf8");
  if (out.cut) stderr += `\nlucid-git: output truncated at ${OUT_CAP} bytes`;
  if (timedOut) stderr += `\nlucid-git: stopped after ${Math.round(o.timeoutMs / 1000)}s`;
  return { code: code ?? 128, stdout: out.bytes, stderr };
}

let hooksDir: string | null = null;
/** An empty hooks dir in the ENGINE's temp dir, which the AppContainer cannot reach, so no hook exists. */
function emptyHooksDir(): string {
  if (!hooksDir) { hooksDir = w.join(tmpdir(), "lucid-git-nohooks"); mkdirSync(hooksDir, { recursive: true }); }
  return hooksDir;
}

const queues = new Map<string, Promise<unknown>>();
/** One brokered call per repository at a time, so held and unheld calls never race each other. */
function serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  queues.set(key, tail);
  void tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  return run;
}

/** Run one agent git call on the host, or refuse it. Never throws: every failure is a refusal (exit 128). */
export async function runBrokeredGit(req: { args: readonly string[]; cwd: string }, d: BrokerDeps): Promise<BrokerResult> {
  const sub = String(req.args[0] ?? "");
  const refuse = (why: string): BrokerResult => ({ code: 128, stdout: new Uint8Array(), stderr: `lucid-git: refused: ${why}\n`, refused: why, sub });
  try {
    if (process.platform !== "win32") return refuse("the git broker exists for the Windows AppContainer only");
    const workspace = realish(d.workspace);
    const cwd = realish(req.cwd);
    if (!within(cwd, workspace)) return refuse(`the working directory ${req.cwd} is outside the workspace`);
    const planned = planGitCall(req.args, cwd, workspace);
    if (!planned.ok) return refuse(planned.reason);
    const plan = planned.plan;
    for (const p of plan.paths) if (!within(realish(p), workspace)) return refuse(`${p} leads outside the workspace (through a link), and git here runs with your full file access`);
    if (!d.gitExe) return refuse("no git is installed on this machine (LUCID looked on PATH and in the usual Git for Windows, MinGit, scoop, Chocolatey, winget and GitHub Desktop locations)");
    if (plan.network && !d.proxyUrl) return refuse("network git runs through the sandbox's egress proxy, which is not running");

    const kinds = new Map<string, "dir" | "file" | "reparse" | null>();
    for (let p = cwd; ; p = w.dirname(p)) {
      kinds.set(w.join(p, ".git"), pathKind(w.join(p, ".git")));
      kinds.set(w.join(p, ".git", "commondir"), pathKind(w.join(p, ".git", "commondir")));
      if (!within(w.dirname(p), workspace) || w.dirname(p) === p) break;
    }
    const found = plan.repo === "none" ? null : findRepo(cwd, workspace, { kind: (p) => kinds.get(p) ?? null });
    if (found && "refuse" in found) return refuse(found.refuse);
    if (!found && plan.repo === "required") return refuse("not a git repository inside the workspace");
    const repo = found && "gitDir" in found ? found : null;

    const forced = forcedConfig({ hooksDir: emptyHooksDir(), proxyUrl: plan.network ? d.proxyUrl : null });
    const env = brokerEnv(d.env ?? process.env, { gitDir: repo?.gitDir ?? null, workTree: repo?.top ?? null, proxyUrl: plan.network ? d.proxyUrl : null });
    const git = (argv: string[], timeoutMs = 180_000) => run(d.gitExe!, [...forced, ...argv], { cwd, env, timeoutMs });
    const timeoutMs = plan.network ? 600_000 : 180_000;

    if (!repo) return { ...(await git([plan.sub, ...plan.args], timeoutMs)), refused: null, sub };
    return await serialize(repo.gitDir.toLowerCase(), async () => {
      const held: Held[] = [];
      let createdAlternates: string | null = null;
      try {
        const gitDirHold = hold(repo.gitDir, { dir: true });
        if (!gitDirHold) return refuse(`could not hold ${repo.gitDir} (it is in use)`);
        held.push(gitDirHold);
        if (plan.held) {
          const configPath = w.join(repo.gitDir, "config");
          const cfg = hold(configPath);
          if (!cfg) return refuse(`could not hold ${configPath} open for validation`);
          held.push(cfg);
          const listed = await run(d.gitExe!, ["config", "--file", configPath, "--list", "--name-only", "-z"], { cwd: emptyHooksDir(), env: brokerEnv(d.env ?? process.env, { gitDir: null, workTree: null, proxyUrl: null }), timeoutMs: 30_000 });
          if (listed.code !== 0) return refuse(`could not read ${configPath}: ${listed.stderr.trim()}`);
          const bad = refusedConfigKey(Buffer.from(listed.stdout).toString("utf8").split("\0").filter(Boolean));
          if (bad) return refuse(`.git/config sets \`${bad}\`, which could make git run a program or reach beyond this repository when it runs as you. Remove it (\`git config --unset ${bad}\`) or run git yourself`);
          // A planted objects/info/alternates would let host git read another repository's objects.
          const alt = w.join(repo.gitDir, "objects", "info", "alternates");
          if (existsSync(alt)) {
            const altHold = hold(alt);
            if (!altHold) return refuse(`could not hold ${alt}`);
            held.push(altHold);
            for (const line of readFileSync(alt, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))) {
              if (!within(realish(w.resolve(w.join(repo.gitDir, "objects"), line)), workspace)) return refuse(`${alt} points outside the workspace`);
            }
          } else {
            mkdirSync(w.dirname(alt), { recursive: true });
            const altHold = hold(alt, { create: true });
            if (!altHold) return refuse(`could not reserve ${alt}`);
            held.push(altHold);
            createdAlternates = alt;
          }
        }
        let current: string | null = null;
        if (plan.pushUpstream) {
          const r = await git(["symbolic-ref", "--short", "-q", "HEAD"]);
          current = r.code === 0 ? Buffer.from(r.stdout).toString("utf8").trim() || null : null;
        }
        const upstreams: string[][] = [];
        if (plan.track && !plan.track.none) {
          const t = plan.track;
          if (t.guess) {
            const local = await git(["show-ref", "--verify", "--quiet", `refs/heads/${t.guess}`]);
            if (local.code !== 0) {
              const remotes = Buffer.from((await git(["for-each-ref", "--format=%(refname:short)", `refs/remotes/*/${t.guess}`])).stdout).toString("utf8").split(/\r?\n/).filter(Boolean);
              if (remotes.length === 1) upstreams.push(["branch", `--set-upstream-to=${remotes[0]}`, t.guess]);
            }
          } else if (t.branch && t.start) {
            const full = Buffer.from((await git(["rev-parse", "--symbolic-full-name", t.start])).stdout).toString("utf8").trim();
            if (full.startsWith("refs/remotes/")) upstreams.push(["branch", `--set-upstream-to=${full.slice("refs/remotes/".length)}`, t.branch]);
            else if (t.explicit && full.startsWith("refs/heads/")) upstreams.push(["branch", `--set-upstream-to=${full.slice("refs/heads/".length)}`, t.branch]);
          }
        }
        const main = await git([plan.sub, ...plan.args], timeoutMs);
        if (plan.pushUpstream && main.code === 0) upstreams.push(...pushUpstreamCalls(plan.pushUpstream, current));
        // Tracking config is written AFTER the held window: `branch` rewrites .git/config and runs nothing.
        for (const h of held.splice(0)) h.close();
        let stderr = main.stderr;
        if (main.code === 0) {
          for (const call of upstreams) {
            const r = await git(call);
            stderr += r.code === 0 ? `lucid-git: ${call[2]} now tracks ${call[1]!.slice("--set-upstream-to=".length)}\n` : r.stderr;
          }
        }
        return { code: main.code, stdout: main.stdout, stderr, refused: null, sub };
      } finally {
        for (const h of held) h.close();
        if (createdAlternates) { try { unlinkSync(createdAlternates); } catch { /* git or the agent removed it */ } }
      }
    });
  } catch (e) {
    return refuse(`internal error: ${e instanceof Error ? e.message : String(e)}`);
  }
}
