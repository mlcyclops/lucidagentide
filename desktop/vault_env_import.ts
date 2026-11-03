// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/vault_env_import.ts
//
// P-VAULT-ENV.1 (ADR-0477): `.env` import into the engine vault and workspace-scoped secrets. Engine-only
// (Bun). The parsing and slot mapping are pure (env_file.ts); this module does the I/O:
//   - scanEnvFile: names, slot, last-4 and vault status of each `NAME=value` in the workspace's `.env`,
//     plus whether the file is git-ignored and whether git history ever held it. Never a value.
//   - importEnvFile: every chosen name into its slot in ONE locked vault write (all or nothing), verified
//     from what the vault returned, then (each opt-in) blank the file to `NAME=` placeholders and add it
//     to `.gitignore`. A failed store blanks nothing.
//   - workspaceSecretEnv: the env overlay of a session whose cwd is a workspace (or one of its lane
//     worktrees, `<repo>.lucid-worktrees/<slug>`): that workspace's `ws:` secrets and no other's. The
//     master agent spawn (acp_backend.ts) and every fleet lane spawn (dev.ts lane env) add it, so the
//     agent's own shell and the commands it runs see them; nothing goes into the engine's process.env.
//   - materializeEnvFile / unmaterializeEnvFile: the explicit "write .env temporarily" action for tools
//     that only read a file. Never the default; refused unless the file is git-ignored; re-blanked by a
//     timer, on engine exit, or on request.
// Values never reach a log line, an HTTP response or an event: only names, counts and last-4.

import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { gitExe } from "../harness/runs/sandbox_exec.ts";
import { writeAtomic } from "./atomic_file.ts";
import { GATEWAY, MAJORS, OTHERS } from "./auth_status.ts";
import { blankDotEnv, mapEnvName, parseDotEnv, type DotEnvProblem, type EnvSlotKind } from "./env_file.ts";
import { isEnvName, mutateVault, readVault, vaultLast4, type VaultKind, type VaultMetaPatch } from "./engine_vault.ts";
import { keyVaultDir } from "./settings_store.ts";
import { applyVaultEnv } from "./vault_env.ts";
import { workspaceRef } from "./vault_store.ts";

/** The file names a scan may read: `.env` and `.env.<suffix>` directly in the workspace folder. */
const ENV_FILE_RE = /^\.env(\.[A-Za-z0-9_-]{1,40})?$/;
export const DEFAULT_ENV_FILE = ".env";

/** Names a workspace secret may never take: they steer the process itself, the agent runtime or LUCID,
 *  and a `.env` overriding them for a session would change what runs rather than what it can reach. */
const RESERVED_RE = /^(LUCID_|OMP_|PI_|BUN_|NODE_OPTIONS$|PATH$|PATHEXT$|HOME$|USERPROFILE$|APPDATA$|LOCALAPPDATA$|SYSTEMROOT$|WINDIR$|COMSPEC$|TEMP$|TMP$|TMPDIR$|SHELL$|LD_PRELOAD$|LD_LIBRARY_PATH$|DYLD_)/i;

/** The provider key slots (`key:<ENV>`): the primary key env of every provider Settings lists. */
export function providerKeyEnvs(): Set<string> {
  return new Set([...GATEWAY, ...MAJORS, ...OTHERS].map((p) => p.env).filter((e) => !!e));
}

export interface EnvScanRow {
  name: string;
  line: number;
  slot: EnvSlotKind;
  ref: string;
  /** The env var it is injected as (`LUCID_GIT_PAT_<HOST>` for a git host slot). */
  envName: string;
  kind: VaultKind;
  host?: string;
  /** UI only; absent for values shorter than 12 characters. */
  last4?: string;
  /** new = the slot is empty; same = it already holds this value; replaces = it holds a different one. */
  status: "new" | "same" | "replaces";
  /** Why this row cannot be imported (empty value, reserved name, a higher-ranked name fills the slot). */
  blocked?: string;
}
export interface EnvScan {
  workspace: string;
  file: string;
  exists: boolean;
  rows: EnvScanRow[];
  problems: DotEnvProblem[];
  isGit: boolean;
  /** The file is ignored by git (or, outside git, named in `.gitignore`). */
  ignored: boolean;
  /** Git history ever held this file (any branch). Null when unknown (no git, not a repo, git failed). */
  committed: boolean | null;
}

function realWorkspace(workspace: string): string {
  const real = realpathSync(workspace);
  if (!statSync(real).isDirectory()) throw new Error("the workspace is not a folder");
  return real;
}
function envFileOf(workspace: string, file: string): string {
  if (!ENV_FILE_RE.test(file)) throw new Error("only a .env file directly in the workspace can be imported");
  return join(workspace, file);
}

function git(cwd: string, args: string[]): { code: number; out: string } | null {
  try {
    const r = Bun.spawnSync([gitExe(), ...args], {
      cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 15_000, windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    });
    return { code: r.exitCode ?? 1, out: r.stdout.toString() };
  } catch { return null; }
}
const insideGit = (workspace: string): boolean => git(workspace, ["rev-parse", "--is-inside-work-tree"])?.out.trim() === "true";

/** Did any commit on any ref ever contain `file` (relative to `workspace`)? Null when git cannot say.
 *  Removing the file now does not remove it from that history: the caller warns to ROTATE. */
export function gitEverCommitted(workspace: string, file: string): boolean | null {
  if (!insideGit(workspace)) return null;
  const r = git(workspace, ["log", "--all", "--format=%H", "-n", "1", "--", file]);
  if (!r || r.code !== 0) return null;
  return r.out.trim().length > 0;
}

/** Is `file` ignored? Git's own answer inside a repository (`check-ignore`); outside one, whether the
 *  workspace `.gitignore` names it (exactly, rooted, or by a `.env*` / `.env.*` pattern). */
export function isIgnored(workspace: string, file: string): boolean {
  if (insideGit(workspace)) {
    const r = git(workspace, ["check-ignore", "-q", "--", file]);
    if (r && (r.code === 0 || r.code === 1)) return r.code === 0; // 128 = git failed: read the file below
  }
  const gi = join(workspace, ".gitignore");
  if (!existsSync(gi)) return false;
  const patterns = new Set([file, `/${file}`, ".env*", "/.env*", ...(file === ".env" ? [] : [".env.*", "/.env.*"])]);
  return readFileSync(gi, "utf8").split(/\r?\n/).some((l) => patterns.has(l.trim()));
}

/** Append `/<file>` to the workspace's `.gitignore` (created when absent). False when already ignored. */
export function ensureGitignored(workspace: string, file: string): boolean {
  if (isIgnored(workspace, file)) return false;
  const gi = join(workspace, ".gitignore");
  const prev = existsSync(gi) ? readFileSync(gi, "utf8") : "";
  const eol = prev.includes("\r\n") ? "\r\n" : "\n";
  const sepNl = prev && !prev.endsWith("\n") ? eol : "";
  writeAtomic(gi, `${prev}${sepNl}# secrets live in the LUCID vault (P-VAULT-ENV.1)${eol}/${file}${eol}`);
  return true;
}

interface PlannedRow { row: EnvScanRow; value: string }

function plan(workspace: string, file: string): { scan: EnvScan; rows: PlannedRow[] } {
  const ws = realWorkspace(workspace);
  const path = envFileOf(ws, file);
  const exists = existsSync(path);
  const parsed = parseDotEnv(exists ? readFileSync(path, "utf8") : "");
  const vault = readVault(keyVaultDir());
  if (vault.problem) throw new Error(`the vault is unreadable: ${vault.problem}`);
  const providers = providerKeyEnvs();
  const filled = new Map<string, string>(); // ref -> the name that fills it (first-ranked wins)
  const rows: PlannedRow[] = [];
  // Claim slots in rank order (GITHUB_TOKEN before GH_TOKEN, the order hostTokenForUrl reads them), then
  // report rows in file order.
  const ranked = [...parsed.entries].sort((x, y) => Number(x.name === "GH_TOKEN") - Number(y.name === "GH_TOKEN"));
  for (const a of ranked) {
    const slot = mapEnvName(a.name, a.value, providers, (n) => (isEnvName(n) ? workspaceRef(ws, n) : "")); // an over-long name is blocked below
    const held = vault.entries[slot.ref]?.value;
    const last4 = a.value ? vaultLast4(a.value, slot.kind) : undefined;
    const row: EnvScanRow = {
      name: a.name, line: a.startLine, slot: slot.slot, ref: slot.ref, envName: slot.envName, kind: slot.kind,
      ...(slot.host ? { host: slot.host } : {}),
      ...(last4 ? { last4 } : {}),
      status: held === undefined ? "new" : held === a.value ? "same" : "replaces",
    };
    if (!a.value) row.blocked = "empty value";
    else if (slot.slot === "workspace" && (RESERVED_RE.test(a.name) || !isEnvName(a.name))) row.blocked = "reserved name";
    else if (filled.has(slot.ref)) row.blocked = `same slot as ${filled.get(slot.ref)}`;
    else filled.set(slot.ref, a.name);
    rows.push({ row, value: a.value });
  }
  rows.sort((x, y) => x.row.line - y.row.line);
  // No file, nothing to import: skip the git probes (the one-time offer scans every workspace once).
  const isGit = exists && insideGit(ws);
  return {
    scan: {
      workspace: ws, file, exists, rows: rows.map((r) => r.row), problems: parsed.problems, isGit,
      ignored: exists ? isIgnored(ws, file) : false,
      committed: isGit ? gitEverCommitted(ws, file) : null,
    },
    rows,
  };
}

/** Names, slots, last-4 and status of each entry of `<workspace>/<file>`. Never a value. */
export function scanEnvFile(workspace: string, file: string = DEFAULT_ENV_FILE): EnvScan {
  return plan(workspace, file).scan;
}

export interface EnvImportOptions {
  /** The names to import (default: every importable row). */
  names?: readonly string[];
  /** Rewrite the imported names to `NAME=` placeholders in the file. */
  blank?: boolean;
  /** Add the file to `.gitignore`. */
  gitignore?: boolean;
}
export interface EnvImportResult {
  imported: Array<{ name: string; ref: string; slot: EnvSlotKind; envName: string }>;
  skipped: Array<{ name: string; reason: string }>;
  blanked: boolean;
  gitignored: boolean;
  /** Git history held the file: its values must be ROTATED (removal does not clean history). */
  committed: boolean | null;
}

/** Import into the vault, then the opt-in file actions. Throws (blanking and ignoring nothing) when the
 *  vault refuses the write or does not hand every value back. */
export function importEnvFile(workspace: string, file: string = DEFAULT_ENV_FILE, opts: EnvImportOptions = {}): EnvImportResult {
  const { scan, rows } = plan(workspace, file);
  if (!scan.exists) throw new Error(`${file} was not found in the workspace`);
  const want = opts.names ? new Set(opts.names) : null;
  const take: PlannedRow[] = [];
  const skipped: EnvImportResult["skipped"] = [];
  for (const r of rows) {
    if (want && !want.has(r.row.name)) continue;
    if (r.row.blocked) skipped.push({ name: r.row.name, reason: r.row.blocked });
    else take.push(r);
  }
  if (want) for (const n of want) if (!rows.some((r) => r.row.name === n)) skipped.push({ name: n, reason: "not in the file" });
  const wsLabel = basename(scan.workspace) || scan.workspace;
  if (take.length) {
    const set: Record<string, string> = {};
    const meta: Record<string, VaultMetaPatch> = {};
    const now = Date.now();
    for (const { row, value } of take) {
      set[row.ref] = value;
      meta[row.ref] = {
        kind: row.kind,
        label: row.slot === "git-host" ? `${row.host} token (from ${file})` : row.slot === "workspace" ? `${row.name} (${wsLabel})` : row.name,
        envName: row.envName,
        ...(row.slot === "workspace" ? { scope: { workspace: scan.workspace } } : {}),
        ...(row.status === "replaces" ? { rotatedAt: now } : {}),
      };
    }
    const entries = mutateVault(keyVaultDir(), () => ({ set, del: [], meta, source: "env-import" }));
    for (const { row, value } of take) {
      if (entries[row.ref]?.value !== value) throw new Error(`the vault did not keep ${row.name}; the file was left as it was`);
    }
    // Provider keys live in process.env the way settings_store.setKey keeps them; git host tokens and the
    // rest of the credential env are re-resolved by vault_env.ts. Workspace secrets stay out of process.env.
    for (const { row, value } of take) if (row.slot === "provider-key") process.env[row.envName] = value;
    try { applyVaultEnv(); } catch (e) { console.error(`[vault-env] env refresh after .env import failed: ${String((e as Error)?.message ?? e).slice(0, 160)}`); }
  }
  const path = envFileOf(scan.workspace, file);
  let blanked = false;
  if (opts.blank && take.length) {
    const text = readFileSync(path, "utf8");
    const next = blankDotEnv(text, new Set(take.map((t) => t.row.name)));
    if (next !== text) { writeAtomic(path, next); blanked = true; }
  }
  const gitignored = opts.gitignore ? ensureGitignored(scan.workspace, file) : false;
  console.error(`[vault-env] imported ${take.length} name(s) from ${file}: ${take.map((t) => t.row.name).join(", ") || "none"}${blanked ? " (file blanked)" : ""}`);
  return {
    imported: take.map(({ row }) => ({ name: row.name, ref: row.ref, slot: row.slot, envName: row.envName })),
    skipped, blanked, gitignored, committed: scan.committed,
  };
}

// ── injection into sessions ──────────────────────────────────────────────────────────────────────────

const norm = (p: string): string => (process.platform === "win32" ? p.toLowerCase() : p);
const under = (child: string, parent: string): boolean => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

/** The workspace (one of `workspaces`, realpaths) a session cwd belongs to: the cwd itself, a folder
 *  inside it, or a lane worktree `<parent>/<name>.lucid-worktrees/...` of it. The most specific wins. */
export function owningWorkspace(cwdReal: string, workspaces: Iterable<string>): string | null {
  const c = norm(cwdReal);
  let best: string | null = null;
  for (const ws of workspaces) {
    const w = norm(ws);
    const lanes = norm(join(dirname(ws), `${basename(ws)}.lucid-worktrees`));
    if ((under(c, w) || under(c, lanes)) && (!best || ws.length > best.length)) best = ws;
  }
  return best;
}

/** Env overlay for an agent or lane session running in `cwd`: the `ws:` secrets of the workspace that
 *  cwd belongs to (name -> value), and nothing from any other workspace. Empty when the cwd is in no
 *  workspace that holds secrets, or the vault cannot be read (a session still starts, without them). */
export function workspaceSecretEnv(cwd: string): Record<string, string> {
  let real: string;
  try { real = realpathSync(cwd); } catch { return {}; }
  const vault = readVault(keyVaultDir());
  if (vault.problem) return {};
  const scoped = Object.values(vault.entries).filter((e) => e.ref.startsWith("ws:") && e.scope?.workspace && e.envName);
  const ws = owningWorkspace(real, new Set(scoped.map((e) => e.scope!.workspace!)));
  if (!ws) return {};
  const prefix = workspaceRef(ws, "X").slice(0, -1);
  const env: Record<string, string> = {};
  for (const e of scoped) {
    if (e.scope!.workspace === ws && e.ref.startsWith(prefix) && e.value && !RESERVED_RE.test(e.envName!)) env[e.envName!] = e.value;
  }
  return env;
}

// ── "write .env temporarily" (never the default) ─────────────────────────────────────────────────────

interface Materialized { path: string; names: string[]; until: number; timer: Timer }
const materialized = new Map<string, Materialized>();
let exitHooked = false;

const quoteEnv = (v: string): string =>
  !/['\r\n]/.test(v) ? `'${v}'` : `"${v.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`;

/** Write the workspace's own `ws:` secrets into `<workspace>/<file>` for `minutes` (1..240): existing
 *  `NAME=` lines are filled in place, missing names appended. Refused unless the file is git-ignored.
 *  Re-blanked when the timer fires, the engine exits, or unmaterializeEnvFile is called. */
export function materializeEnvFile(workspace: string, file: string = DEFAULT_ENV_FILE, minutes = 15): { path: string; names: string[]; until: number } {
  const ws = realWorkspace(workspace);
  const path = envFileOf(ws, file);
  if (!isIgnored(ws, file)) throw new Error(`${file} is not git-ignored; add it to .gitignore first`);
  const env = workspaceSecretEnv(ws);
  const names = Object.keys(env).sort();
  if (!names.length) throw new Error("this workspace has no workspace-scoped secrets to write");
  const mins = Math.min(240, Math.max(1, Math.floor(Number.isFinite(minutes) ? minutes : 15)));
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const blankedText = blankDotEnv(text, new Set(names));
  const present = new Set(parseDotEnv(blankedText).assignments.map((a) => a.name));
  const lines = blankedText.split(/\r?\n/).map((l) => {
    const m = /^(\s*)(export\s+)?([A-Za-z_][A-Za-z0-9_]*)=$/.exec(l);
    return m && env[m[3]!] !== undefined ? `${m[1]}${m[2] ?? ""}${m[3]}=${quoteEnv(env[m[3]!]!)}` : l;
  });
  let out = lines.join(eol);
  const missing = names.filter((n) => !present.has(n));
  if (missing.length) out += `${out && !out.endsWith(eol) ? eol : ""}${missing.map((n) => `${n}=${quoteEnv(env[n]!)}`).join(eol)}${eol}`;
  writeAtomic(path, out);
  const key = norm(path);
  const prev = materialized.get(key);
  if (prev) clearTimeout(prev.timer);
  const until = Date.now() + mins * 60_000;
  const timer = setTimeout(() => { try { unmaterializeEnvFile(ws, file); } catch (e) { console.error(`[vault-env] could not re-blank ${file}: ${String((e as Error)?.message ?? e).slice(0, 160)}`); } }, mins * 60_000);
  timer.unref?.();
  materialized.set(key, { path, names, until, timer });
  if (!exitHooked) {
    exitHooked = true;
    process.on("exit", () => { for (const m of materialized.values()) { try { writeFileSync(m.path, blankDotEnv(readFileSync(m.path, "utf8"), new Set(m.names))); } catch { /* best-effort at exit */ } } });
  }
  console.error(`[vault-env] wrote ${names.length} workspace secret name(s) into ${file} for ${mins} min: ${names.join(", ")}`);
  return { path: relative(ws, path) || file, names, until };
}

/** Blank the names a materialize wrote (or, with nothing recorded, every workspace-secret name). */
export function unmaterializeEnvFile(workspace: string, file: string = DEFAULT_ENV_FILE): { blanked: boolean; names: string[] } {
  const ws = realWorkspace(workspace);
  const path = envFileOf(ws, file);
  const key = norm(path);
  const rec = materialized.get(key);
  if (rec) clearTimeout(rec.timer);
  materialized.delete(key);
  if (!existsSync(path)) return { blanked: false, names: [] };
  const names = rec?.names ?? Object.keys(workspaceSecretEnv(ws));
  const text = readFileSync(path, "utf8");
  const next = blankDotEnv(text, new Set(names));
  if (next === text) return { blanked: false, names };
  writeAtomic(path, next);
  return { blanked: true, names };
}

/** Test-only: drop timers and records without touching files. */
export function _resetMaterializedForTest(): void {
  for (const m of materialized.values()) clearTimeout(m.timer);
  materialized.clear();
}
