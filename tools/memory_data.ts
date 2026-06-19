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
import { join } from "node:path";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { Database as Sqlite } from "bun:sqlite";
import { DuckDBInstance } from "@duckdb/node-api";

// ── model context windows (tokens) ────────────────────────────────────────────
// Keyed by the SHORT model id (provider prefix stripped). Keep in sync with
// desktop/renderer/app.ts MODEL_CTX. omp's reported window is unreliable for the
// AskSage gateway models, so this map is the source of truth for the denominator.
export const CTX_WINDOW: Record<string, number> = {
  "claude-fable-5": 1_000_000, "claude-opus-4-8": 1_000_000, "claude-opus-4-7": 1_000_000,
  "claude-opus-4-6": 1_000_000, "claude-sonnet-4-6": 1_000_000, "claude-sonnet-4-5": 1_000_000,
  "claude-haiku-4-5": 200_000,
  "gpt-5.2": 256_000, "gpt-5.5": 256_000, "gpt-5.4": 256_000, "gpt-5.1": 256_000, "gpt-5": 256_000,
  "gpt-5-mini": 256_000, "gpt-4.1": 1_000_000, "gpt-o3": 200_000, "gpt-o3-mini": 200_000, "gpt-o4-mini": 200_000,
  "google-claude-45-opus": 200_000, "google-claude-45-sonnet": 200_000,
  "aws-bedrock-claude-45-sonnet-gov": 200_000, "claude-opus-4": 200_000, "claude-sonnet-4": 200_000,
  "google-gemini-3.1-pro-com": 1_000_000, "google-gemini-3.5-flash-gov": 1_000_000,
  "google-gemini-2.5-pro": 1_000_000, "google-gemini-2.5-flash": 1_000_000,
  "rag": 256_000,
};
const shortModelId = (m: string): string => m.replace(/^anthropic\//, "").replace(/^asksage-[a-z]+\//, "");
export const ctxWindow = (model: string): number => CTX_WINDOW[shortModelId(model)] ?? CTX_WINDOW[model] ?? 200_000;

// ── omp session transcript ────────────────────────────────────────────────────
export interface Turn {
  prompt: number; // input + cacheRead + cacheWrite  (= context occupancy that turn)
  output: number;
  cacheRead: number;
  cacheWrite: number;
  input: number;
  cost: number;
}
export interface Session {
  path: string;
  cwd: string;
  started: string;
  model: string;
  turns: Turn[];
}

/** Newest session whose `session.cwd` matches our cwd; else newest overall. */
export function findSession(explicit?: string): string | undefined {
  if (explicit) return existsSync(explicit) ? explicit : undefined;
  const root = join(homedir(), ".omp", "agent", "sessions");
  if (!existsSync(root)) return undefined;
  const cwd = process.cwd();
  const files: { p: string; mtime: number }[] = [];
  for (const d of readdirSync(root)) {
    const dir = join(root, d);
    try {
      if (!statSync(dir).isDirectory()) continue;
      for (const f of readdirSync(dir)) {
        if (f.endsWith(".jsonl")) files.push({ p: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs });
      }
    } catch {
      /* skip unreadable dir */
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  for (const { p } of files) {
    try {
      const first = readFileSync(p, "utf8").split("\n", 1)[0] ?? "";
      const o = JSON.parse(first);
      if (o?.type === "session" && o.cwd === cwd) return p;
    } catch {
      /* skip */
    }
  }
  return files[0]?.p;
}

export function parseSession(path: string): Session {
  const s: Session = { path, cwd: "?", started: "?", model: "?", turns: [] };
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type === "session") {
      s.cwd = o.cwd ?? s.cwd;
      s.started = o.timestamp ?? s.started;
    } else if (o.type === "model_change" && o.model) {
      s.model = o.model;
    } else if (o.type === "message" && o.message?.usage) {
      const u = o.message.usage;
      if (o.message.model) s.model = o.message.model;
      const input = u.input ?? 0,
        cacheRead = u.cacheRead ?? 0,
        cacheWrite = u.cacheWrite ?? 0;
      s.turns.push({
        prompt: input + cacheRead + cacheWrite,
        output: u.output ?? 0,
        cacheRead,
        cacheWrite,
        input,
        cost: u.cost?.total ?? 0,
      });
    }
  }
  return s;
}

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

// ── rate-limit budget (omp agent.db) ──────────────────────────────────────────
export interface Budget {
  label: string;
  used: number;
  status: string;
  resetsAt: number | null;
}
export function rateLimits(): Budget[] | null {
  const p = join(homedir(), ".omp", "agent", "agent.db");
  if (!existsSync(p)) return null;
  try {
    const db = new Sqlite(p, { readonly: true });
    try {
      return db
        .query(
          `select label, used_fraction as used, status, resets_at as resetsAt
           from usage_history u
           where recorded_at = (select max(recorded_at) from usage_history u2 where u2.label = u.label)
           order by used_fraction desc`,
        )
        .all() as Budget[];
    } finally {
      db.close();
    }
  } catch {
    return null;
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
  };
}
