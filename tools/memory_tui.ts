// tools/memory_tui.ts
//
// In-terminal MEMORY & CONTEXT dashboard. Shows how omp is managing the context
// window + memory for the live session, alongside the Lucid harness memory layers.
//
//   bun run memory:tui            # auto-detect the current omp session
//   bun run memory:tui <file.jsonl>   # a specific session transcript
//
// Everything here is READ-ONLY and safe to run while omp is live:
//   - per-turn token usage + KV-cache stats : omp session .jsonl (append-only)
//   - rate-limit budget (5h / 7d windows)   : ~/.omp/agent/agent.db (sqlite RO)
//   - compaction policy                      : `omp config list --json`
//   - Lucid memory layers (working/archive/semantic + promotion gate) : agent_obs.duckdb (RO)
//
// Nothing here writes; the harness DB is opened READ_ONLY so it never contends
// with the live security gate's writer.

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { Database as Sqlite } from "bun:sqlite";
import { DuckDBInstance } from "@duckdb/node-api";
import { C, banner, table, gauge, sparkline, fmtNum, fmtUSD } from "./_tui.ts";

// ── model context windows (tokens) ────────────────────────────────────────────
const CTX_WINDOW: Record<string, number> = {
  "claude-opus-4-8": 1_000_000,
  "claude-opus-4-7": 1_000_000,
  "claude-opus-4-6": 1_000_000,
  "claude-sonnet-4-6": 1_000_000,
  "claude-haiku-4-5": 200_000,
  "claude-fable-5": 1_000_000,
};
const ctxWindow = (model: string): number => CTX_WINDOW[model] ?? 200_000;

// ── omp session transcript ────────────────────────────────────────────────────
interface Turn {
  prompt: number; // input + cacheRead + cacheWrite  (= context occupancy that turn)
  output: number;
  cacheRead: number;
  cacheWrite: number;
  input: number;
  cost: number;
}
interface Session {
  path: string;
  cwd: string;
  started: string;
  model: string;
  turns: Turn[];
}

/** Newest session whose `session.cwd` matches our cwd; else newest overall. */
function findSession(explicit?: string): string | undefined {
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

function parseSession(path: string): Session {
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
function ompBin(): string {
  for (const c of [join(homedir(), ".bun", "bin", "omp.exe"), join(homedir(), ".bun", "bin", "omp")]) {
    if (existsSync(c)) return c;
  }
  return "omp";
}

function compactionPolicy(): Record<string, string> | undefined {
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
interface Budget {
  label: string;
  used: number;
  status: string;
  resetsAt: number | null;
}
function rateLimits(): Budget[] | null {
  const p = join(homedir(), ".omp", "agent", "agent.db");
  if (!existsSync(p)) return null;
  try {
    const db = new Sqlite(p, { readonly: true });
    try {
      const rows = db
        .query(
          `select label, used_fraction as used, status, resets_at as resetsAt
           from usage_history u
           where recorded_at = (select max(recorded_at) from usage_history u2 where u2.label = u.label)
           order by used_fraction desc`,
        )
        .all() as Budget[];
      return rows;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

// ── Lucid harness memory (agent_obs.duckdb, READ_ONLY) ────────────────────────
async function harnessMemory(): Promise<
  | { layers: { layer: string; rows: string; detail: string }[]; facts: any[]; gate: { promoted: number; blocked: number } }
  | null
> {
  const dbPath = join(import.meta.dir, "..", "agent_obs.duckdb");
  if (!existsSync(dbPath)) return null;
  try {
    const instance = await DuckDBInstance.create(dbPath, { access_mode: "READ_ONLY" });
    const conn = await instance.connect();
    const one = async (sql: string): Promise<number> => {
      try {
        const r = await conn.runAndReadAll(sql);
        return Number((r.getRowObjects()[0] as any)?.n ?? 0);
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
    const promoted = facts;
    const blocked = await one("SELECT count(*)::INT n FROM telemetry_events WHERE event = 'memory_promotion_blocked'");
    const factRows = await rows(
      `SELECT e.name AS entity, f.statement, f.trust_label
       FROM semantic_facts f JOIN semantic_entities e ON e.entity_id = f.entity_id
       ORDER BY f.promoted_at DESC LIMIT 8`,
    );

    instance.closeSync();
    return {
      layers: [
        { layer: "working", rows: String(working), detail: "current goal / next-step / blockers per run" },
        { layer: "archive", rows: String(archive), detail: "raw source-of-truth spans (immutable)" },
        { layer: "semantic", rows: `${facts} facts / ${entities} entities`, detail: "promoted facts w/ provenance + trust" },
      ],
      facts: factRows,
      gate: { promoted, blocked },
    };
  } catch {
    return null; // missing schema, or held read-write by the live gate
  }
}

// ── render ────────────────────────────────────────────────────────────────────
function ageStr(epochMs: number | null): string {
  if (!epochMs) return "—";
  const secs = Math.round((epochMs - Date.now()) / 1000);
  if (secs <= 0) return "now";
  const h = Math.floor(secs / 3600),
    m = Math.floor((secs % 3600) / 60);
  return h > 0 ? `in ${h}h ${m}m` : `in ${m}m`;
}

async function main(): Promise<void> {
  console.log(banner("MEMORY & CONTEXT", "context window · kv-cache · compaction · semantic memory"));
  console.log();

  // 1) omp context window for the live session
  const sessionPath = findSession(process.argv[2]);
  if (!sessionPath) {
    console.log(`${C.yellow}  No omp session transcript found yet.${C.reset}`);
    console.log(`${C.dim}  Launch omp (LucidAgentIDE.bat -> 1), send a message, then re-run this.${C.reset}\n`);
  } else {
    const s = parseSession(sessionPath);
    const win = ctxWindow(s.model);
    const prompts = s.turns.map((t) => t.prompt);
    const current = prompts.at(-1) ?? 0;
    const peak = prompts.length ? Math.max(...prompts) : 0;
    const sumRead = s.turns.reduce((a, t) => a + t.cacheRead, 0);
    const sumWrite = s.turns.reduce((a, t) => a + t.cacheWrite, 0);
    const sumInput = s.turns.reduce((a, t) => a + t.input, 0);
    const sumCost = s.turns.reduce((a, t) => a + t.cost, 0);
    const hit = sumRead + sumWrite + sumInput > 0 ? sumRead / (sumRead + sumWrite + sumInput) : 0;

    console.log(`${C.cyan}${C.bold}▸ Context window${C.reset}  ${C.dim}model ${s.model} · ${s.turns.length} turns${C.reset}`);
    console.log(`    current   ${gauge(current / win)}  ${fmtNum(current)} / ${fmtNum(win)}`);
    console.log(`    peak      ${gauge(peak / win)}  ${fmtNum(peak)} / ${fmtNum(win)}`);
    console.log(`    growth    ${sparkline(prompts)}  ${C.dim}(prompt tokens per turn)${C.reset}`);
    console.log();
    console.log(`${C.cyan}${C.bold}▸ KV-cache efficiency${C.reset}  ${C.dim}(frozen prefix → cache hits; invariant #6)${C.reset}`);
    console.log(`    cache hit ${gauge(hit)}  ${fmtNum(sumRead)} read vs ${fmtNum(sumWrite)} written, ${fmtNum(sumInput)} fresh`);
    console.log(`    ${C.dim}session cost so far: ${fmtUSD(sumCost)}${C.reset}`);
    console.log(`    ${C.dim}source: ${sessionPath.replace(homedir(), "~")}${C.reset}`);
    console.log();
  }

  // 2) compaction policy (how omp keeps context bounded)
  const cp = compactionPolicy();
  if (cp) {
    console.log(
      table(
        "Compaction policy (omp keeps context bounded)",
        ["setting", "value"],
        Object.entries(cp).map(([setting, value]) => ({ setting, value })),
        C.blue,
      ),
    );
  } else {
    console.log(`${C.blue}${C.bold}▸ Compaction policy${C.reset}\n${C.dim}  (run inside omp, or with omp on PATH, to read config)${C.reset}`);
  }
  console.log();

  // 3) rate-limit budget
  const rl = rateLimits();
  if (rl && rl.length) {
    console.log(`${C.magenta}${C.bold}▸ Provider budget (rate-limit windows)${C.reset}`);
    for (const b of rl) console.log(`    ${b.label.padEnd(22)} ${gauge(b.used)}  ${C.dim}${b.status}, resets ${ageStr(b.resetsAt)}${C.reset}`);
    console.log();
  }

  // 4) Lucid harness memory layers + promotion gate
  const hm = await harnessMemory();
  if (hm) {
    console.log(table("Lucid memory layers", ["layer", "rows", "detail"], hm.layers, C.green));
    console.log();
    console.log(
      table(
        "Semantic promotion gate (keystone #2)",
        ["outcome", "n"],
        [
          { outcome: "promoted → semantic", n: String(hm.gate.promoted) },
          { outcome: "blocked (suspicious source)", n: String(hm.gate.blocked) },
        ],
        C.green,
      ),
    );
    if (hm.facts.length) {
      console.log();
      console.log(table("Semantic facts (most recent)", ["entity", "statement", "trust_label"], hm.facts, C.cyan));
    }
  } else {
    console.log(`${C.green}${C.bold}▸ Lucid memory layers${C.reset}`);
    console.log(`${C.dim}  No harness memory yet — agent_obs.duckdb appears once the gate runs (or a demo).`);
    console.log(`  Try:  bun run demo-P4.3   (poisoned memory is blocked from promotion)${C.reset}`);
  }

  console.log(`\n${C.dim}  refresh: re-run \`bun run memory:tui\`  ·  security view: \`bun run dashboard:tui\`${C.reset}`);
}

await main();
process.exit(0);
