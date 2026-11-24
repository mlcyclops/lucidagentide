// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// tools/memory_data.ts
//
// Pure data layer for the MEMORY & CONTEXT view — no rendering. Both the TUI
// (memory_tui.ts) and the web dashboard (web/server.ts) import from here, so
// there is ONE source of truth for how we read omp's context/memory state.
//
// Everything is READ-ONLY and safe to run while omp is live:
//   - per-turn token usage + KV-cache stats : omp session .jsonl (append-only)
//   - rate-limit budget (5h / 7d windows)   : ~/.omp/agent/agent.db (sqlite RO)
//   - compaction policy                      : `omp config list --json`
//   - Lucid memory layers + promotion gate   : agent_obs.duckdb (DuckDB READ_ONLY)

import { homedir } from "node:os";
import { basename, join } from "node:path";
import { existsSync } from "node:fs";
import { open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { sessionFiles, sessionFilesVersion } from "./session_files.ts";
import { Db } from "../harness/memory/db.ts";
import { resolveMigrationsDir } from "../harness/migrations_dir.ts";
import { mirrorPathFor, readHarnessMirror, snapshotHarnessMemory, type HarnessMemory } from "../harness/memory/obs_mirror.ts";
import { pathWithin } from "../desktop/path_guard.ts";
import { gitExe } from "../harness/runs/sandbox_exec.ts";
import { aggregateAiLoc, readAiLocSamples } from "../desktop/ailoc_read.ts"; // P-LOC.4 (ADR-0211): AI-LOC from the GUI-owned ledger

// Session / context / KV-cache / spend metrics live in the DuckDB-FREE session_metrics.ts (so the
// `lucid` launcher can read them without loading the DuckDB addon). Re-exported here so this module
// stays the single import surface for the TUI / web dashboard / desktop.
import {
  CTX_WINDOW,
  shortModelId,
  ctxWindow,
  findSession,
  sessionPathById,
  parseSession,
  rateLimits,
  type Turn,
  type Session,
  type Budget,
} from "./session_metrics.ts";
export { CTX_WINDOW, ctxWindow, findSession, sessionPathById, parseSession, rateLimits };
export type { Turn, Session, Budget };


// ── cross-model usage & cost ledger (P10.2, ADR-0011) ─────────────────────────
// Aggregate per-model tokens + cost across ALL omp sessions, with an estimated
// prompt-cache savings. Read-only; a per-file mtime cache keeps repeat calls cheap.
//
// Savings is derived purely from the data (no price table → no drift): omp bills a
// cache READ at ~10% of the input rate, so the full no-cache price would have been
// ~10× what was paid, i.e. estimated savings ≈ cost.cacheRead × 9.

export interface ModelUsage {
  model: string; // short id (provider prefix stripped)
  provider: string; // anthropic | openai | google | asksage-rag | local | other
  source: "subscription" | "local";
  sessions: number;
  turns: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  savings: number; // estimated, = cost.cacheRead × 9
  cacheHitRate: number; // cacheRead / (cacheRead + cacheWrite + input)
}
export interface UsageLedger {
  models: ModelUsage[]; // sorted by cost.total desc
  totals: { sessions: number; turns: number; tokens: number; cost: number; savings: number; cacheHitRate: number };
  bySource: { subscription: { cost: number; tokens: number }; local: { cost: number; tokens: number } };
  files: number; // session files scanned
  truncated: boolean; // true if a file cap was applied
  generatedAt: string;
}

interface Acc { turns: number; input: number; output: number; cacheRead: number; cacheWrite: number; total: number; cInput: number; cOutput: number; cRead: number; cWrite: number; cTotal: number }
const newAcc = (): Acc => ({ turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cInput: 0, cOutput: 0, cRead: 0, cWrite: 0, cTotal: 0 });

export function ledgerProvider(modelShort: string): string {
  const m = modelShort.toLowerCase();
  if (/rag/.test(m)) return "asksage-rag";
  if (/ollama|llama|qwen|mistral|deepseek|local/.test(m)) return "local";
  if (/claude|anthropic/.test(m)) return "anthropic";
  if (/gpt|openai|^o[0-9]/.test(m)) return "openai";
  if (/gemini|google/.test(m)) return "google";
  return "other";
}

/** Per-model accumulators for ONE session file (a session may switch models mid-way). */
async function ledgerFromFile(path: string): Promise<Map<string, Acc>> {
  const out = new Map<string, Acc>();
  let model = "?";
  let text: string;
  try { text = await readFile(path, "utf8"); } catch { return out; }
  for (const line of text.split("\n")) {
    if (!line) continue;
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type === "model_change" && o.model) model = o.model;
    else if (o.type === "message" && o.message?.usage) {
      if (o.message.model) model = o.message.model;
      const u = o.message.usage, c = u.cost ?? {};
      const key = shortModelId(String(model));
      const a = out.get(key) ?? out.set(key, newAcc()).get(key)!;
      a.turns++;
      a.input += u.input ?? 0; a.output += u.output ?? 0; a.cacheRead += u.cacheRead ?? 0; a.cacheWrite += u.cacheWrite ?? 0;
      a.total += u.totalTokens ?? ((u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0));
      a.cInput += c.input ?? 0; a.cOutput += c.output ?? 0; a.cRead += c.cacheRead ?? 0; a.cWrite += c.cacheWrite ?? 0; a.cTotal += c.total ?? 0;
    }
  }
  return out;
}

const fileCache = new Map<string, { mtime: number; per: Map<string, Acc> }>();

/** P-PERF.IDLE1: the per-file totals survive a restart. A cold ledger read and parsed the newest 1,500 transcripts
 *  (gigabytes here, six seconds of CPU) in the boot burst; with the store only files that changed since the last
 *  run are read. Off until the engine names a file (tests never write one). */
let ledgerStore: string | null = null;
let ledgerLoaded = false;
let ledgerSavedAt = 0;
const LEDGER_SAVE_MS = 60_000;
export function setUsageLedgerStore(file: string | null): void { ledgerStore = file; ledgerLoaded = false; }
/** Test hook: forget the in-memory per-file totals, as a restart would. */
export function __resetUsageLedger(): void { fileCache.clear(); ledgerLoaded = false; ledgerSavedAt = 0; }
async function loadLedgerStore(): Promise<void> {
  if (ledgerLoaded || !ledgerStore) return;
  ledgerLoaded = true;
  try {
    const j = JSON.parse(await readFile(ledgerStore, "utf8")) as Record<string, { mtime?: unknown; per?: [string, Acc][] }>;
    for (const [p, e] of Object.entries(j)) {
      if (typeof e?.mtime === "number" && Array.isArray(e.per) && !fileCache.has(p)) fileCache.set(p, { mtime: e.mtime, per: new Map(e.per) });
    }
  } catch { /* no store yet, or unreadable: start empty */ }
}
async function saveLedgerStore(scan: SessionFile[]): Promise<void> {
  if (!ledgerStore) return;
  const out: Record<string, { mtime: number; per: [string, Acc][] }> = {};
  for (const { p } of scan) { const e = fileCache.get(p); if (e) out[p] = { mtime: e.mtime, per: [...e.per] }; }
  const tmp = `${ledgerStore}.${process.pid}.tmp`;
  try { await writeFile(tmp, JSON.stringify(out)); await rename(tmp, ledgerStore); }
  catch { /* best effort: the next change writes it again */ }
}

// P-PERF.3: the sessions dir grows without bound (thousands of .jsonl files). readdir + stat-ing them ALL on
// every dashboard poll is a multi-second SYNCHRONOUS block that stalls the server event loop — and the model's
// reply streaming with it. Cache the directory WALK for a short TTL so repeat polls reuse the file list; the
// per-file `fileCache` already re-parses only genuinely-changed files, and a brand-new session shows within the
// TTL. Shared by the two walkers (usageLedger + discoverWorkspaces). Live token counts still come from the HUD.
// P-BOOTPERF.1 (ADR-pending): the walk, the ledger reads and the code-activity git calls are ASYNC. The
// renderer's first dashboard refresh lands with the boot burst, when every cache here is cold, and the
// synchronous versions held the engine's one event loop for the whole cold pass (thousands of transcripts,
// a `git log --numstat` per repo): the workspace bar, the turn-status probe and every other route waited.
// P-PERF.IDLE1: the walk is the shared incremental index (tools/session_files.ts): built once, then kept current by
// a file watcher, so a poll re-stats only what changed instead of the whole tree every 15 s. The `{p, mtime}` list
// is re-derived only when the index's version moves.
interface SessionFile { p: string; mtime: number }
const sessionScanCache = new Map<string, { version: number; files: SessionFile[] }>();
async function scanSessionFiles(root: string): Promise<SessionFile[]> {
  const entries = await sessionFiles(root);
  const version = sessionFilesVersion(root);
  const hit = sessionScanCache.get(root);
  if (hit?.version === version) return hit.files;
  const files = entries.map((e) => ({ p: e.p, mtime: e.mtimeMs }));
  sessionScanCache.set(root, { version, files });
  return files;
}

/** Aggregate per-model usage + cost across all omp sessions. `root`/`maxFiles` are for tests. */
export async function usageLedger(opts: { root?: string; maxFiles?: number } = {}): Promise<UsageLedger> {
  const root = opts.root ?? join(homedir(), ".omp", "agent", "sessions");
  const cap = opts.maxFiles ?? 1500;
  const generatedAt = new Date().toISOString();
  const empty: UsageLedger = { models: [], totals: { sessions: 0, turns: 0, tokens: 0, cost: 0, savings: 0, cacheHitRate: 0 }, bySource: { subscription: { cost: 0, tokens: 0 }, local: { cost: 0, tokens: 0 } }, files: 0, truncated: false, generatedAt };
  if (!existsSync(root)) return empty;

  const files = await scanSessionFiles(root); // P-PERF.IDLE1: the shared incremental index (was a per-poll stat storm over 1000s of files)
  const truncated = files.length > cap;
  const scan = truncated ? files.slice(0, cap) : files;

  await loadLedgerStore();
  let parsed = 0;
  const byModel = new Map<string, Acc & { sessions: number }>();
  for (const { p, mtime } of scan) {
    let per = fileCache.get(p);
    if (!per || per.mtime !== mtime) { per = { mtime, per: await ledgerFromFile(p) }; fileCache.set(p, per); parsed++; }
    for (const [model, a] of per.per) {
      const m = byModel.get(model) ?? byModel.set(model, { ...newAcc(), sessions: 0 }).get(model)!;
      m.sessions++; m.turns += a.turns;
      m.input += a.input; m.output += a.output; m.cacheRead += a.cacheRead; m.cacheWrite += a.cacheWrite; m.total += a.total;
      m.cInput += a.cInput; m.cOutput += a.cOutput; m.cRead += a.cRead; m.cWrite += a.cWrite; m.cTotal += a.cTotal;
    }
  }

  const models: ModelUsage[] = [...byModel.entries()].map(([model, a]) => {
    const provider = ledgerProvider(model);
    const denom = a.cacheRead + a.cacheWrite + a.input;
    return {
      model, provider, source: (provider === "local" ? "local" : "subscription") as "subscription" | "local",
      sessions: a.sessions, turns: a.turns,
      tokens: { input: a.input, output: a.output, cacheRead: a.cacheRead, cacheWrite: a.cacheWrite, total: a.total },
      cost: { input: a.cInput, output: a.cOutput, cacheRead: a.cRead, cacheWrite: a.cWrite, total: a.cTotal },
      savings: a.cRead * 9, cacheHitRate: denom > 0 ? a.cacheRead / denom : 0,
    };
  }).sort((x, y) => y.cost.total - x.cost.total);

  const totals = { sessions: 0, turns: 0, tokens: 0, cost: 0, savings: 0, cacheHitRate: 0 };
  const bySource = { subscription: { cost: 0, tokens: 0 }, local: { cost: 0, tokens: 0 } };
  let dRead = 0, dDenom = 0;
  for (const m of models) {
    totals.sessions += m.sessions; totals.turns += m.turns; totals.tokens += m.tokens.total; totals.cost += m.cost.total; totals.savings += m.savings;
    bySource[m.source].cost += m.cost.total; bySource[m.source].tokens += m.tokens.total;
    dRead += m.tokens.cacheRead; dDenom += m.tokens.cacheRead + m.tokens.cacheWrite + m.tokens.input;
  }
  totals.cacheHitRate = dDenom > 0 ? dRead / dDenom : 0;
  // P-PERF.IDLE1: at most once a minute while agents keep their transcripts changing; a crash loses only re-parses.
  if (parsed > 0 && Date.now() - ledgerSavedAt > LEDGER_SAVE_MS) { ledgerSavedAt = Date.now(); await saveLedgerStore(scan); }
  return { models, totals, bySource, files: scan.length, truncated, generatedAt };
}

// ── code activity (git workspace diffstat, ADR-0030 P-CODE.1) ──────────────────
// Per-workspace lines added/deleted + files touched this calendar month, from
// `git log --numstat`. Honest framing: this is REPO/WORKSPACE activity (every
// commit — yours, others', merges), NOT AI authorship. The AI-authored metric is
// a different source (ADR-0031, see aiLoc). Spend attribution per workspace is
// deferred to P-CODE.2; spend is reported as 0 here.
export interface CodeActivity {
  workspaces: { name: string; path: string; added: number; deleted: number; files: number; spend: number }[];
  totals: { added: number; deleted: number; files: number };
  month: string; // e.g. "June 2026"
  daysInMonth: number;
  /** P-PERF.IDLE1: when git last counted these numbers (ISO); null when nothing has been counted yet. */
  countedAt: string | null;
}

/** Resolve a `git log --numstat` rename path to its final path. Handles the two
 *  git rename notations: `old => new` and `dir/{old => new}/file`. */
export function renamedPath(p: string): string {
  const brace = p.match(/^(.*)\{(.*?) => (.*?)\}(.*)$/);
  if (brace) return ((brace[1] ?? "") + (brace[3] ?? "") + (brace[4] ?? "")).replace(/\/{2,}/g, "/");
  const i = p.indexOf(" => ");
  return i >= 0 ? p.slice(i + 4) : p;
}

/** PURE parser for `git log --numstat` output (keystone — over-tested). Sums
 *  added/deleted lines and collects the set of files touched. Binary files show
 *  as `-\t-\tpath`: the file counts as touched but contributes no line counts.
 *  Rename rows are normalized to the final path so a rename isn't double-counted. */
export function parseNumstat(output: string): { added: number; deleted: number; files: string[] } {
  let added = 0, deleted = 0;
  const files = new Set<string>();
  for (const raw of output.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim()) continue; // blank lines between commits (from --format=)
    const tab = line.split("\t");
    if (tab.length < 3) continue; // not a numstat row (e.g. a stray commit header)
    const [a = "", d = "", ...rest] = tab;
    const file = renamedPath(rest.join("\t").trim());
    if (!file) continue;
    files.add(file);
    if (a !== "-") added += Number.parseInt(a, 10) || 0;   // "-" == binary → no line count
    if (d !== "-") deleted += Number.parseInt(d, 10) || 0;
  }
  return { added, deleted, files: [...files].sort() };
}

/** P-PERF.IDLE1: bytes of a transcript readSessionCwd looks at. */
const CWD_HEAD_BYTES = 64 * 1024;
/** Light read of an omp session file's working dir. P-PERF.IDLE1: only a bounded head is read (the `session` line
 *  sits at the top, after omp 18's fixed-width title slot), never the whole transcript. */
async function readSessionCwd(path: string): Promise<string | undefined> {
  try {
    const h = await open(path, "r");
    try {
      const { buffer, bytesRead } = await h.read(Buffer.alloc(CWD_HEAD_BYTES), 0, CWD_HEAD_BYTES, 0);
      for (const line of buffer.toString("utf8", 0, bytesRead).split("\n")) {
        if (!line.includes('"type":"session"')) continue;
        try { const o = JSON.parse(line); if (o.cwd) return String(o.cwd); } catch { /* keep scanning */ }
      }
    } finally { await h.close(); }
  } catch { /* unreadable */ }
  return undefined;
}

/** Distinct git-repo working dirs seen across recent omp sessions (newest first). */
async function discoverWorkspaces(root?: string, cap = 500): Promise<string[]> {
  const base = root ?? join(homedir(), ".omp", "agent", "sessions");
  if (!existsSync(base)) return [];
  const files = await scanSessionFiles(base); // P-PERF.IDLE1: the shared incremental index
  const seen = new Set<string>();
  const out: string[] = [];
  for (const { p } of files.slice(0, cap)) {
    const cwd = await readSessionCwd(p);
    if (!cwd || seen.has(cwd)) continue;
    seen.add(cwd);
    if (existsSync(join(cwd, ".git"))) out.push(cwd);
  }
  return out;
}

/** P-PERF.GIT1: what makes a workspace's month total stale: the month, and its HEAD reflog (`.git/logs/HEAD`, which
 *  git rewrites on every commit, checkout, merge, reset and pull; a linked worktree's `.git` file points at its own).
 *  A `git log --since=<month> --numstat` only changes when one of those does. Null when the reflog cannot be read
 *  (codeActivity then re-counts on a 10 minute clock instead). */
export async function activityKey(ws: string, monthStart: Date): Promise<string | null> {
  let gitDir = join(ws, ".git");
  try {
    const s = await stat(gitDir);
    if (s.isFile()) {
      const m = /^gitdir:\s*(.+)\s*$/m.exec(await readFile(gitDir, "utf8"));
      if (!m) return null;
      gitDir = m[1]!.trim();
      if (!/^([A-Za-z]:[\\/]|[\\/])/.test(gitDir)) gitDir = join(ws, gitDir);
    }
    const log = await stat(join(gitDir, "logs", "HEAD"));
    return `${monthStart.toISOString()}|${log.mtimeMs}|${log.size}`;
  } catch { return null; }
}

/** P-PERF.GIT1: each workspace's last month total and the key it was computed under. The dashboard polls every few
 *  seconds and the route recomputes every 30 s; asking git for a month of numstat in every session repo each time
 *  kept a `git log` running more than half of every minute (18 repos, seconds each), pinning a core and the
 *  Program Compatibility Assistant service that watches each spawn. */
type ActivityStat = { added: number; deleted: number; files: number };
const activityMemo = new Map<string, { key: string; stat: ActivityStat | null; retryAt?: number }>();
/** How long a repo with no reflog, or one whose count failed or timed out, waits before git is asked again. */
const NO_KEY_TTL_MS = 10 * 60_000;

/** P-PERF.IDLE1: the memo survives a restart, so opening LUCID shows last session's numbers without one git
 *  process. Off until the engine names a file (tests never write one). */
let activityStore: string | null = null;
let activityLoaded = false;
let activityCountedAt: string | null = null;
export function setCodeActivityStore(file: string | null): void { activityStore = file; activityLoaded = false; }
/** Test hook: forget the in-memory counts, as a restart would. */
export function __resetCodeActivity(): void { activityMemo.clear(); activityCountedAt = null; activityLoaded = false; }
async function loadActivityStore(): Promise<void> {
  if (activityLoaded || !activityStore) return;
  activityLoaded = true;
  try {
    const j = JSON.parse(await readFile(activityStore, "utf8")) as { countedAt?: unknown; repos?: Record<string, { key?: unknown; stat?: ActivityStat | null }> };
    if (typeof j.countedAt === "string") activityCountedAt = j.countedAt;
    for (const [path, e] of Object.entries(j.repos ?? {})) {
      if (typeof e?.key === "string" && !activityMemo.has(path)) activityMemo.set(path, { key: e.key, stat: e.stat ?? null });
    }
  } catch { /* no store yet, or unreadable: start empty */ }
}
async function saveActivityStore(): Promise<void> {
  if (!activityStore) return;
  const repos: Record<string, { key: string; stat: ActivityStat | null }> = {};
  for (const [path, e] of activityMemo) repos[path] = { key: e.key, stat: e.stat };
  const tmp = `${activityStore}.${process.pid}.tmp`;
  try { await writeFile(tmp, JSON.stringify({ countedAt: activityCountedAt, repos })); await rename(tmp, activityStore); }
  catch { /* best effort: the next count writes it again */ }
}

function monthOf(now: Date): { monthStart: Date; month: string; daysInMonth: number } {
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  return { monthStart, month: monthStart.toLocaleString("en-US", { month: "long", year: "numeric" }), daysInMonth: new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate() };
}
function activitySummary(workspaces: CodeActivity["workspaces"], now: Date): CodeActivity {
  workspaces.sort((a, b) => b.added + b.deleted - (a.added + a.deleted));
  const totals = workspaces.reduce(
    (t, w) => ({ added: t.added + w.added, deleted: t.deleted + w.deleted, files: t.files + w.files }),
    { added: 0, deleted: 0, files: 0 },
  );
  const { month, daysInMonth } = monthOf(now);
  return { workspaces, totals, month, daysInMonth, countedAt: activityCountedAt };
}

/** P-PERF.IDLE1: this month's numbers as last counted, from memory or the store. Never spawns git and never walks
 *  the session tree, so the dashboard can show it at boot; a repo that moved since is shown with its last count
 *  until the user asks for a recount (codeActivity). */
export async function cachedCodeActivity(now: Date = new Date()): Promise<CodeActivity> {
  await loadActivityStore();
  const stamp = monthOf(now).monthStart.toISOString();
  const workspaces: CodeActivity["workspaces"] = [];
  for (const [path, e] of activityMemo) {
    if (e.stat && e.key.includes(stamp)) workspaces.push({ name: basename(path), path, ...e.stat, spend: 0 });
  }
  return activitySummary(workspaces, now);
}

/** Per-workspace git diffstat for the current calendar month.
 *  Workspaces: `opts.workspaces` if given, else discovered from omp session cwds.
 *  Fail-closed: a workspace outside the home subtree, a non-git dir, or a failed
 *  `git` invocation is OMITTED — never faked (CLAUDE.md invariant #3). */
export async function codeActivity(opts: { workspaces?: string[]; root?: string; now?: Date; timeoutMs?: number } = {}): Promise<CodeActivity> {
  const now = opts.now ?? new Date();
  const { monthStart } = monthOf(now);
  await loadActivityStore();
  // P-PERF.GIT1: 60 s. A busy repo's month of numstat takes 18 s here; at 15 s it was killed and re-run every 30 s
  // forever (and never shown). It now runs once per HEAD move, so letting it finish costs far less. A truly hung git
  // still trips the timeout, the workspace is omitted, and it is retried after NO_KEY_TTL_MS.
  const timeout = opts.timeoutMs ?? 60_000;
  const candidates = opts.workspaces ?? await discoverWorkspaces(opts.root);

  const workspaces: CodeActivity["workspaces"] = [];
  const seen = new Set<string>();
  for (const ws of candidates) {
    const safe = pathWithin(homedir(), ws);            // confine to the home subtree (ADR-0022/0023)
    if (!safe) continue;                                // outside home → omit (fail-closed)
    if (!existsSync(join(safe, ".git"))) continue;      // not a git repo → omit
    seen.add(safe);
    // P-PERF.GIT1: HEAD has not moved since the last count this month: the count stands, no git spawned.
    // A repo with no readable reflog (a fresh clone with logAllRefUpdates off, a scratch dir) is re-counted at most
    // every NO_KEY_TTL_MS instead of on every 30 s recompute.
    const key = (await activityKey(safe, monthStart)) ?? `nokey|${monthStart.toISOString()}|${Math.floor(now.getTime() / NO_KEY_TTL_MS)}`;
    const memo = activityMemo.get(safe);
    if (memo && memo.key === key && !(memo.retryAt !== undefined && now.getTime() >= memo.retryAt)) {
      if (memo.stat) workspaces.push({ name: basename(safe), path: safe, ...memo.stat, spend: 0 });
      continue;
    }
    // Args ARRAY, never a shell string (no injection via paths/refs). Exclude vendored/
    // generated churn so the metric reflects real source. `--format=` suppresses commit
    // headers, leaving only numstat rows + blank separators.
    // gitExe(), never a bare "git": the installed app's PATH commonly has no git (MinGit is not on it), and
    // Bun.spawn THROWS ENOENT for a missing executable rather than returning a failed result.
    let out: string | null;
    try {
      out = await runStdout(
        [gitExe(), "log", `--since=${monthStart.toISOString()}`, "--numstat", "--no-color", "--format=",
          "--", ".", ":(exclude)node_modules", ":(exclude)vendor", ":(exclude)dist", ":(exclude)*.lock", ":(exclude)*.min.*"],
        { cwd: safe, timeoutMs: timeout },
      );
    } catch { break; }                                  // no git at all → every workspace would fail: omit all
    // git failed/timeout → omit (never fake). Remembered too, with a retry clock: a month of numstat that outlives
    // the timeout (this repo: 15 s) used to run again on every 30 s recompute, forever, and still show nothing.
    if (out === null) { activityMemo.set(safe, { key, stat: null, retryAt: now.getTime() + NO_KEY_TTL_MS }); continue; }
    const { added, deleted, files } = parseNumstat(out);
    const counted = files.length ? { added, deleted, files: files.length } : null;
    activityMemo.set(safe, { key, stat: counted });
    if (!counted) continue;                             // no activity this month → not listed
    workspaces.push({ name: basename(safe), path: safe, ...counted, spend: 0 });
  }

  // P-PERF.IDLE1: a discovered set is the whole picture, so repos no longer in it leave the store; an explicit list
  // (tests, a single repo) only adds.
  if (!opts.workspaces) for (const k of activityMemo.keys()) if (!seen.has(k)) activityMemo.delete(k);
  activityCountedAt = now.toISOString();
  await saveActivityStore();
  return activitySummary(workspaces, now);
}

// ── omp compaction policy ─────────────────────────────────────────────────────
/** Resolve the omp binary: PATH (inside an omp session) or the global bun bin. */
export function ompBin(): string {
  for (const c of [join(homedir(), ".bun", "bin", "omp.exe"), join(homedir(), ".bun", "bin", "omp")]) {
    if (existsSync(c)) return c;
  }
  return "omp";
}

/** P-BOOTPERF.1 (ADR-pending): a fixed argv run OFF the event loop. stdout when it exits 0, null when it
 *  fails or outlives `timeoutMs` (then it is killed). Throws, like Bun.spawnSync did, only when the
 *  executable cannot be started at all (ENOENT). stderr is ignored, so a chatty child cannot fill a pipe. */
async function runStdout(argv: string[], opts: { cwd?: string; timeoutMs: number }): Promise<string | null> {
  const child = Bun.spawn(argv, { cwd: opts.cwd, stdin: "ignore", stdout: "pipe", stderr: "ignore", windowsHide: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, opts.timeoutMs);
  try {
    const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return !timedOut && code === 0 ? out : null;
  } finally { clearTimeout(timer); }
}

// P-PERF.3: this SPAWNS an omp subprocess (`config list`) SYNCHRONOUSLY on every call — ~2s of booting omp just
// to read basically-static compaction settings, and it's on the memory-snapshot poll path, so it blocked the
// event loop (and the model's reply) every few seconds. This was the single biggest stall. Cache it for a long
// TTL; the config almost never changes and a manual refresh re-reads within the window.
// P-BOOTPERF.1 (ADR-pending): and the spawn itself is async now. The first memory snapshot lands in the boot
// burst, where a cold, antivirus-scanned omp start held the engine's event loop for as long as it took. The
// cached promise is shared by concurrent callers; a hung omp is killed after CP_TIMEOUT_MS (reads as unknown).
// P-PERF.IDLE1: keyed on omp's config file instead of a 60 s clock. A 60 s TTL still booted a whole omp (a
// second of CPU under antivirus) every minute the dashboard polled; the answer only changes when that file does.
// A failed read (omp timed out under load) is retried after CP_RETRY_MS rather than kept until the file changes.
let _cpCache: { key: string; failedAt?: number; data: Promise<Record<string, string> | undefined> } | null = null;
const CP_TIMEOUT_MS = 30_000;
const CP_RETRY_MS = 10 * 60_000;
const OMP_CONFIG_FILE = join(homedir(), ".omp", "agent", "config.yml");
export async function compactionPolicy(): Promise<Record<string, string> | undefined> {
  let key = "none";
  try { const s = await stat(OMP_CONFIG_FILE); key = `${s.mtimeMs}|${s.size}`; } catch { /* no config: omp defaults */ }
  if (_cpCache?.key !== key || (_cpCache.failedAt !== undefined && Date.now() - _cpCache.failedAt > CP_RETRY_MS)) {
    const entry: NonNullable<typeof _cpCache> = { key, data: _compactionPolicyUncached() };
    void entry.data.then((r) => { if (r === undefined) entry.failedAt = Date.now(); });
    _cpCache = entry;
  }
  return _cpCache.data;
}
async function _compactionPolicyUncached(): Promise<Record<string, string> | undefined> {
  try {
    const out = await runStdout([ompBin(), "config", "list", "--json"], { timeoutMs: CP_TIMEOUT_MS });
    if (out === null) return undefined;
    const o = JSON.parse(out);
    const pick = (k: string) => (o[k]?.value === undefined ? "—" : String(o[k].value));
    return {
      enabled: pick("compaction.enabled"),
      strategy: pick("compaction.strategy"),
      thresholdTokens: pick("compaction.thresholdTokens"),
      thresholdPercent: pick("compaction.thresholdPercent"),
      keepRecentTokens: pick("compaction.keepRecentTokens"),
      reserveTokens: pick("compaction.reserveTokens"),
      idleEnabled: pick("compaction.idleEnabled"),
      contextPromotion: pick("contextPromotion.enabled"),
    };
  } catch {
    return undefined;
  }
}


// ── Lucid harness memory (agent_obs.duckdb READ_ONLY, else its lock-free mirror) ──────────────
export type { HarnessMemory };

/** Path to the live observability DB written by the security gate.
 *  NOT `join(import.meta.dir, "..")`: in the shipped `bun build --compile` engine (ADR-0260)
 *  import.meta.dir is a VIRTUAL bunfs path, so that resolved to `B:\~BUN\root\agent_obs.duckdb`,
 *  existsSync was false, and the Memory panel showed its empty state forever in installed builds
 *  (the ADR-0303 bug class). Derive the repo root by PROBING through the memory store's real
 *  migrations directory - dev runs, LUCID_RESOURCES, and the execPath fallback all covered. */
export const OBS_DB_PATH = join(
  resolveMigrationsDir("harness/memory", join(import.meta.dir, "..", "harness", "memory")),
  "..", "..", "..", "agent_obs.duckdb",
);

// P-PERF.3: harnessMemory + aiLocSummary each open a fresh READ_ONLY DuckDB per call (~1s each as the obs DB
// grows) — both on the memory-snapshot poll path, so they blocked model streaming. Semantic-memory + AI-LOC
// counts change slowly, so cache both for a short TTL. (Still read-only-per-open, so the gate's writer never
// blocks; we just call it far less often.)
const _OBS_TTL_MS = 20_000;
// P-PERF.IDLE1: also keyed on the obs DB, its WAL and its mirror. A 20 s TTL still re-opened a 150 MB DuckDB (1.5 s of
// CPU) on every dashboard poll while nothing had written to it; now an unchanged store is never re-read, and a
// changing one (a turn in progress) at most every _OBS_TTL_MS.
let _hmCache: { at: number; key: string; data: HarnessMemory | null } | null = null;
/** The obs store's change stamp (DB, WAL and mirror mtime + size). Shared with the engine's security snapshot memo. */
export async function obsKey(): Promise<string> {
  const parts = await Promise.all([OBS_DB_PATH, `${OBS_DB_PATH}.wal`, mirrorPathFor(OBS_DB_PATH)].map(async (f) => {
    try { const s = await stat(f); return `${s.mtimeMs}:${s.size}`; } catch { return "-"; }
  }));
  return parts.join("|");
}
export async function harnessMemory(): Promise<HarnessMemory | null> {
  const key = await obsKey();
  if (_hmCache && (_hmCache.key === key || Date.now() - _hmCache.at < _OBS_TTL_MS)) return _hmCache.data;
  const data = await _harnessMemoryUncached();
  _hmCache = { at: Date.now(), key, data };
  return data;
}
async function _harnessMemoryUncached(): Promise<HarnessMemory | null> {
  if (existsSync(OBS_DB_PATH)) {
    try {
      const db = await Db.openReadOnly(OBS_DB_PATH);
      try {
        return await snapshotHarnessMemory(db);
      } finally {
        db.close();
      }
    } catch {
      // The gate's omp child holds the DB read-write; DuckDB refuses ANY cross-process open of it
      // (even READ_ONLY - the ADR-0211 bug class). Fall through to the writer-maintained mirror.
    }
  }
  return readHarnessMirror(OBS_DB_PATH);
}

// ── P-LOC.2 (ADR-0031): AI-LOC attribution roll-up for the dashboard ──────────
// Read-only view of the `ai_loc_ledger` the security gate writes (P-LOC.1): how many lines the AI
// authored, per model · repo · identity. READ_ONLY so it coexists with the live gate's write lock;
// a missing table (no edits recorded yet) degrades to null via the per-query catch.
export interface AiLocModel { model: string; added: number; removed: number; edits: number }
export interface AiLocRow { model: string; repo: string; identity: string; identitySource: string; edits: number; added: number; removed: number }
export interface AiLocSummary {
  totals: { added: number; removed: number; edits: number; models: number; repos: number };
  byModel: AiLocModel[];   // per model, most lines first
  rows: AiLocRow[];        // per (model, repo, identity), most lines first (capped)
  identities: string[];    // distinct attribution identities seen
  generatedAt: string;
}

/** The AI-LOC roll-up, or null when nothing has been recorded yet.
 *
 *  P-LOC.4 (ADR-0211): reads the GUI-owned append-only ledger (`~/.omp/lucid-ailoc.jsonl`, written by the
 *  desktop from the ACP edit stream), NOT `agent_obs.duckdb`. The gate holds that DuckDB open read-write for
 *  the whole session, and DuckDB refuses a concurrent cross-process open (even READ_ONLY) — so the old
 *  direct read here always lock-failed → null → the "AI-authored code" panel showed "none yet" despite rows
 *  in the DB (the reported bug). The DuckDB `ai_loc_ledger` remains the BI/audit system-of-record; the live
 *  dashboard reads the lock-free JSONL mirror. Aggregation is pure (ailoc_read.ts). */
let _alCache: { at: number; data: AiLocSummary | null } | null = null;
export async function aiLocSummary(): Promise<AiLocSummary | null> {
  if (_alCache && Date.now() - _alCache.at < _OBS_TTL_MS) return _alCache.data;
  const data = aggregateAiLoc(readAiLocSamples(), new Date().toISOString());
  _alCache = { at: Date.now(), data };
  return data;
}

export function ageStr(epochMs: number | null): string {
  if (!epochMs) return "—";
  const secs = Math.round((epochMs - Date.now()) / 1000);
  if (secs <= 0) return "now";
  const h = Math.floor(secs / 3600),
    m = Math.floor((secs % 3600) / 60);
  return h > 0 ? `in ${h}h ${m}m` : `in ${m}m`;
}

// ── aggregate snapshot (consumed by the web dashboard as JSON) ─────────────────
export interface MemorySnapshot {
  session: null | {
    path: string;
    model: string;
    turns: number;
    window: number;
    current: number;
    peak: number;
    prompts: number[];
    cache: { read: number; write: number; fresh: number; hit: number };
    cost: number;
    started: string;
  };
  compaction: Record<string, string> | null;
  budgets: Budget[] | null;
  harness: HarnessMemory | null;
  aiLoc: AiLocSummary | null; // P-LOC.2 (ADR-0031): AI-authored lines per model/repo/identity
}

/** P-BOOTPERF.1 (ADR-pending): findSession's no-argument rule (the newest session whose first line is a
 *  session record for `cwd`, else the newest session) for the live dashboard, off the event loop. The sync
 *  version read EVERY transcript whole to look at its first line, and the GUI asks with no session at a
 *  fresh launch, when nothing matches the engine's cwd (and omp 18's title slot is line one), so the first
 *  memory snapshot read the entire corpus synchronously. Here each candidate costs one bounded head read. */
const HEAD_BYTES = 4096;
async function newestSessionFor(cwd: string): Promise<string | undefined> {
  const files = await scanSessionFiles(join(homedir(), ".omp", "agent", "sessions"));
  for (let i = 0; i < files.length; i += 64) {
    const batch = files.slice(i, i + 64);
    const hits = await Promise.all(batch.map(async ({ p }) => {
      try {
        const h = await open(p, "r");
        try {
          const { buffer, bytesRead } = await h.read(Buffer.alloc(HEAD_BYTES), 0, HEAD_BYTES, 0);
          const o = JSON.parse(buffer.toString("utf8", 0, bytesRead).split("\n", 1)[0] ?? "");
          return o?.type === "session" && o.cwd === cwd;
        } finally { await h.close(); }
      } catch { return false; }
    }));
    const at = hits.indexOf(true);
    if (at >= 0) return batch[at]!.p;
  }
  return files[0]?.p;
}

export async function memorySnapshot(sessionArg?: string): Promise<MemorySnapshot> {
  const sp = sessionArg ? findSession(sessionArg) : await newestSessionFor(process.cwd());
  let session: MemorySnapshot["session"] = null;
  if (sp) {
    const s = parseSession(sp);
    const win = ctxWindow(s.model);
    const prompts = s.turns.map((t) => t.prompt);
    const read = s.turns.reduce((a, t) => a + t.cacheRead, 0);
    const write = s.turns.reduce((a, t) => a + t.cacheWrite, 0);
    const fresh = s.turns.reduce((a, t) => a + t.input, 0);
    const cost = s.turns.reduce((a, t) => a + t.cost, 0);
    const hit = read + write + fresh > 0 ? read / (read + write + fresh) : 0;
    session = {
      path: sp.replace(homedir(), "~"),
      model: s.model,
      turns: s.turns.length,
      window: win,
      current: prompts.at(-1) ?? 0,
      peak: prompts.length ? Math.max(...prompts) : 0,
      prompts,
      cache: { read, write, fresh, hit },
      cost,
      started: s.started,
    };
  }
  return {
    session,
    compaction: (await compactionPolicy()) ?? null,
    budgets: rateLimits(),
    harness: await harnessMemory(),
    aiLoc: await aiLocSummary(),
  };
}
