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
export const CTX_WINDOW: Record<string, number> = {
  "claude-opus-4-8": 1_000_000,
  "claude-opus-4-7": 1_000_000,
  "claude-opus-4-6": 1_000_000,
  "claude-sonnet-4-6": 1_000_000,
  "claude-haiku-4-5": 200_000,
  "claude-fable-5": 1_000_000,
};
export const ctxWindow = (model: string): number => CTX_WINDOW[model] ?? 200_000;

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
