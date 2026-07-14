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
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { DuckDBInstance } from "@duckdb/node-api";
import { pathWithin } from "../desktop/path_guard.ts";
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
function ledgerFromFile(path: string): Map<string, Acc> {
  const out = new Map<string, Acc>();
  let model = "?";
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return out; }
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

/** Aggregate per-model usage + cost across all omp sessions. `root`/`maxFiles` are for tests. */
export function usageLedger(opts: { root?: string; maxFiles?: number } = {}): UsageLedger {
  const root = opts.root ?? join(homedir(), ".omp", "agent", "sessions");
  const cap = opts.maxFiles ?? 1500;
  const generatedAt = new Date().toISOString();
  const empty: UsageLedger = { models: [], totals: { sessions: 0, turns: 0, tokens: 0, cost: 0, savings: 0, cacheHitRate: 0 }, bySource: { subscription: { cost: 0, tokens: 0 }, local: { cost: 0, tokens: 0 } }, files: 0, truncated: false, generatedAt };
  if (!existsSync(root)) return empty;

  const files: { p: string; mtime: number }[] = [];
  for (const d of readdirSync(root)) {
    const dir = join(root, d);
    try { if (!statSync(dir).isDirectory()) continue; for (const f of readdirSync(dir)) if (f.endsWith(".jsonl")) files.push({ p: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }); }
    catch { /* skip */ }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const truncated = files.length > cap;
  const scan = truncated ? files.slice(0, cap) : files;

  const byModel = new Map<string, Acc & { sessions: number }>();
  for (const { p, mtime } of scan) {
    let per = fileCache.get(p);
    if (!per || per.mtime !== mtime) { per = { mtime, per: ledgerFromFile(p) }; fileCache.set(p, per); }
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

/** Light read of an omp session file's working dir (the `session` line is first). */
function readSessionCwd(path: string): string | undefined {
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line) continue;
      if (line.includes('"type":"session"')) {
        try { const o = JSON.parse(line); if (o.cwd) return String(o.cwd); } catch { /* keep scanning */ }
      }
    }
  } catch { /* unreadable */ }
  return undefined;
}

/** Distinct git-repo working dirs seen across recent omp sessions (newest first). */
function discoverWorkspaces(root?: string, cap = 500): string[] {
  const base = root ?? join(homedir(), ".omp", "agent", "sessions");
  if (!existsSync(base)) return [];
  const files: { p: string; mtime: number }[] = [];
  for (const d of readdirSync(base)) {
    const dir = join(base, d);
    try { if (!statSync(dir).isDirectory()) continue; for (const f of readdirSync(dir)) if (f.endsWith(".jsonl")) files.push({ p: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }); }
    catch { /* skip */ }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const { p } of files.slice(0, cap)) {
    const cwd = readSessionCwd(p);
    if (!cwd || seen.has(cwd)) continue;
    seen.add(cwd);
    if (existsSync(join(cwd, ".git"))) out.push(cwd);
  }
  return out;
}

/** Per-workspace git diffstat for the current calendar month.
 *  Workspaces: `opts.workspaces` if given, else discovered from omp session cwds.
 *  Fail-closed: a workspace outside the home subtree, a non-git dir, or a failed
 *  `git` invocation is OMITTED — never faked (CLAUDE.md invariant #3). */
export function codeActivity(opts: { workspaces?: string[]; root?: string; now?: Date; timeoutMs?: number } = {}): CodeActivity {
  const now = opts.now ?? new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const month = monthStart.toLocaleString("en-US", { month: "long", year: "numeric" });
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const timeout = opts.timeoutMs ?? 15_000; // generous — a large repo's `git log --numstat`
  // can take several seconds; the result is cached 30s, so we'd rather wait than fail-close to
  // an empty dashboard. A truly hung git still trips the timeout and the workspace is omitted.
  const candidates = opts.workspaces ?? discoverWorkspaces(opts.root);

  const workspaces: CodeActivity["workspaces"] = [];
  for (const ws of candidates) {
    const safe = pathWithin(homedir(), ws);            // confine to the home subtree (ADR-0022/0023)
    if (!safe) continue;                                // outside home → omit (fail-closed)
    if (!existsSync(join(safe, ".git"))) continue;      // not a git repo → omit
    // Args ARRAY, never a shell string (no injection via paths/refs). Exclude vendored/
    // generated churn so the metric reflects real source. `--format=` suppresses commit
    // headers, leaving only numstat rows + blank separators.
    const r = Bun.spawnSync(
      ["git", "log", `--since=${monthStart.toISOString()}`, "--numstat", "--no-color", "--format=",
        "--", ".", ":(exclude)node_modules", ":(exclude)vendor", ":(exclude)dist", ":(exclude)*.lock", ":(exclude)*.min.*"],
      { cwd: safe, timeout, stdout: "pipe", stderr: "pipe" },
    );
    if (!r.success) continue;                           // git missing/failed/timeout → omit (never fake)
    const { added, deleted, files } = parseNumstat(r.stdout.toString());
    if (files.length === 0) continue;                   // no activity this month → not listed
    workspaces.push({ name: basename(safe), path: safe, added, deleted, files: files.length, spend: 0 });
  }

  workspaces.sort((a, b) => b.added + b.deleted - (a.added + a.deleted));
  const totals = workspaces.reduce(
    (t, w) => ({ added: t.added + w.added, deleted: t.deleted + w.deleted, files: t.files + w.files }),
    { added: 0, deleted: 0, files: 0 },
  );
  return { workspaces, totals, month, daysInMonth };
}

// ── omp compaction policy ─────────────────────────────────────────────────────
/** Resolve the omp binary: PATH (inside an omp session) or the global bun bin. */
export function ompBin(): string {
  for (const c of [join(homedir(), ".bun", "bin", "omp.exe"), join(homedir(), ".bun", "bin", "omp")]) {
    if (existsSync(c)) return c;
  }
  return "omp";
}

export function compactionPolicy(): Record<string, string> | undefined {
  try {
    const r = Bun.spawnSync([ompBin(), "config", "list", "--json"]);
    if (!r.success) return undefined;
    const o = JSON.parse(r.stdout.toString());
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


// ── Lucid harness memory (agent_obs.duckdb, READ_ONLY) ────────────────────────
export interface HarnessMemory {
  counts: { working: number; archive: number; entities: number; facts: number };
  layers: { layer: string; rows: string; detail: string }[];
  facts: { entity: string; statement: string; trust_label: string }[];
  gate: { promoted: number; blocked: number };
}

/** Path to the live observability DB written by the security gate. */
export const OBS_DB_PATH = join(import.meta.dir, "..", "agent_obs.duckdb");

export async function harnessMemory(): Promise<HarnessMemory | null> {
  if (!existsSync(OBS_DB_PATH)) return null;
  try {
    const instance = await DuckDBInstance.create(OBS_DB_PATH, { access_mode: "READ_ONLY" });
    const conn = await instance.connect();
    const one = async (sql: string): Promise<number> => {
      try {
        return Number((((await conn.runAndReadAll(sql)).getRowObjects()[0] as any)?.n) ?? 0);
      } catch {
        return 0;
      }
    };
    const rows = async (sql: string): Promise<any[]> => {
      try {
        return (await conn.runAndReadAll(sql)).getRowObjects() as any[];
      } catch {
        return [];
      }
    };

    const working = await one("SELECT count(*)::INT n FROM working_state");
    const archive = await one("SELECT count(*)::INT n FROM archive_chunks");
    const entities = await one("SELECT count(*)::INT n FROM semantic_entities");
    const facts = await one("SELECT count(*)::INT n FROM semantic_facts");
    const blocked = await one("SELECT count(*)::INT n FROM telemetry_events WHERE event = 'memory_promotion_blocked'");
    const factRows = (await rows(
      `SELECT e.name AS entity, f.statement, f.trust_label
       FROM semantic_facts f JOIN semantic_entities e ON e.entity_id = f.entity_id
       ORDER BY f.promoted_at DESC LIMIT 8`,
    )).map((r) => ({ entity: String(r.entity), statement: String(r.statement), trust_label: String(r.trust_label) }));

    instance.closeSync();
    return {
      counts: { working, archive, entities, facts },
      layers: [
        { layer: "working", rows: String(working), detail: "current goal / next-step / blockers per run" },
        { layer: "archive", rows: String(archive), detail: "raw source-of-truth spans (immutable)" },
        { layer: "semantic", rows: `${facts} facts / ${entities} entities`, detail: "promoted facts w/ provenance + trust" },
      ],
      facts: factRows,
      gate: { promoted: facts, blocked },
    };
  } catch {
    return null; // missing schema, or held read-write by the live gate
  }
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
export async function aiLocSummary(): Promise<AiLocSummary | null> {
  return aggregateAiLoc(readAiLocSamples(), new Date().toISOString());
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

export async function memorySnapshot(sessionArg?: string): Promise<MemorySnapshot> {
  const sp = findSession(sessionArg);
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
    compaction: compactionPolicy() ?? null,
    budgets: rateLimits(),
    harness: await harnessMemory(),
    aiLoc: await aiLocSummary(),
  };
}
