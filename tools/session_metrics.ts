// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// tools/session_metrics.ts
//
// DuckDB-FREE session / context / KV-cache / spend metrics, read from omp session .jsonl (+ the sqlite
// rate-limit budget). Extracted from memory_data.ts (which imports + RE-EXPORTS everything here, so it
// stays the single source of truth) so the fail-closed `lucid` launcher can compute `lucid stats`
// WITHOUT loading the DuckDB native addon that memory_data pulls in for its harness / AI-LOC views.
// (P-NVIM.3, ADR-0155)

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { Database as Sqlite } from "bun:sqlite";

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
export const shortModelId = (m: string): string => m.replace(/^anthropic\//, "").replace(/^asksage-[a-z]+\//, "");
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
// P-PERF.3: the sessions dir grows without bound (thousands of .jsonl files). Re-walking + re-stat-ing them all
// on every memory-snapshot poll is a multi-second SYNCHRONOUS block that stalls the server event loop — and the
// model's reply streaming with it. Cache the walk (short TTL) and the per-transcript parse (by mtime) so repeat
// polls are cheap; a new session/turn shows within the TTL / on the next mtime change.
const _SESS_SCAN_TTL = 15_000;
let _sessScan: { root: string; at: number; files: { p: string; mtime: number }[] } | null = null;
function scanSessions(root: string): { p: string; mtime: number }[] {
  if (_sessScan && _sessScan.root === root && Date.now() - _sessScan.at < _SESS_SCAN_TTL) return _sessScan.files;
  const files: { p: string; mtime: number }[] = [];
  if (existsSync(root)) for (const d of readdirSync(root)) {
    const dir = join(root, d);
    try { if (!statSync(dir).isDirectory()) continue; for (const f of readdirSync(dir)) if (f.endsWith(".jsonl")) files.push({ p: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }); }
    catch { /* skip unreadable dir */ }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  _sessScan = { root, at: Date.now(), files };
  return files;
}
const _parseCache = new Map<string, { mtime: number; s: Session }>();

export function findSession(explicit?: string): string | undefined {
  if (explicit) return existsSync(explicit) ? explicit : undefined;
  const root = join(homedir(), ".omp", "agent", "sessions");
  if (!existsSync(root)) return undefined;
  const cwd = process.cwd();
  const files = scanSessions(root); // P-PERF.3: TTL-cached walk
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

/** Resolve an omp session id (Snowflake) to its on-disk `.jsonl` transcript, if present. Session
 *  files are named `<timestamp>_<sessionId>.jsonl`, so we match the id within the filename and return
 *  the most-recently-modified hit. This lets the live UI anchor the memory snapshot to the ACTIVE chat
 *  session rather than falling back to `findSession`'s cwd match — which picks by `process.cwd()` (the
 *  app's dir) while chats actually run in the user's selected workspace, so the fallback can lock onto
 *  a stale, empty session and show "0 turns" with empty gauges. */
export function sessionPathById(id: string | null | undefined): string | undefined {
  if (!id) return undefined;
  const root = join(homedir(), ".omp", "agent", "sessions");
  if (!existsSync(root)) return undefined;
  const matches = scanSessions(root).filter((x) => x.p.includes(id)); // P-PERF.3: reuse the cached walk (already newest-first)
  return matches[0]?.p;
}

export function parseSession(path: string): Session {
  // P-PERF.3: re-parse a (possibly large) transcript only when it actually changed — repeat polls reuse the parse.
  let mtime = 0; try { mtime = statSync(path).mtimeMs; } catch { /* fall through to a parse attempt */ }
  const hit = _parseCache.get(path);
  if (hit && mtime && hit.mtime === mtime) return hit.s;
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
  if (mtime) { _parseCache.set(path, { mtime, s }); if (_parseCache.size > 24) _parseCache.delete([..._parseCache.keys()][0]!); }
  return s;
}
// ── rate-limit budget (omp agent.db) ──────────────────────────────────────────
export interface Budget {
  label: string;
  used: number;
  status: string;
  resetsAt: number | null;
}
// P-PERF.3: this opens omp's agent.db and runs a correlated subquery over usage_history EVERY call — measured
// at ~2s as that table grows, and it's on the memory-snapshot poll path, so it blocked model streaming. Budgets
// only change once per turn, so cache the result for a short TTL. omp still updates within the TTL.
let _rlCache: { at: number; data: Budget[] | null } | null = null;
const _RL_TTL_MS = 8_000;
export function rateLimits(): Budget[] | null {
  if (_rlCache && Date.now() - _rlCache.at < _RL_TTL_MS) return _rlCache.data;
  const stamp = (data: Budget[] | null): Budget[] | null => { _rlCache = { at: Date.now(), data }; return data; };
  const p = join(homedir(), ".omp", "agent", "agent.db");
  if (!existsSync(p)) return stamp(null);
  try {
    const db = new Sqlite(p, { readonly: true });
    try {
      return stamp(db
        .query(
          `select label, used_fraction as used, status, resets_at as resetsAt
           from usage_history u
           where recorded_at = (select max(recorded_at) from usage_history u2 where u2.label = u.label)
           order by used_fraction desc`,
        )
        .all() as Budget[]);
    } finally {
      db.close();
    }
  } catch {
    return stamp(null);
  }
}

// ── lean session stats (P-NVIM.3, ADR-0155) ──────────────────────────────────
// The GUI Memory-inspector numbers (spend + KV-cache % + context-fill) for the current / most-recent omp
// session, computed from the session .jsonl ONLY (no DuckDB, no omp subprocess) so `lucid stats` can be
// polled cheaply from an editor statusline.
export interface SessionStats {
  path: string;
  model: string;
  turns: number;
  window: number;
  current: number;
  peak: number;
  contextFill: number;
  /** Per-turn context occupancy (input+cacheRead+cacheWrite per turn) — feeds the editor sparkline. */
  prompts: number[];
  cache: { read: number; write: number; fresh: number; hit: number };
  cost: number;
  started: string;
}

export function sessionStats(sessionArg?: string): SessionStats | null {
  const sp = findSession(sessionArg);
  if (!sp) return null;
  const s = parseSession(sp);
  const win = ctxWindow(s.model);
  const prompts = s.turns.map((t) => t.prompt);
  const read = s.turns.reduce((a, t) => a + t.cacheRead, 0);
  const write = s.turns.reduce((a, t) => a + t.cacheWrite, 0);
  const fresh = s.turns.reduce((a, t) => a + t.input, 0);
  const cost = s.turns.reduce((a, t) => a + t.cost, 0);
  const hit = read + write + fresh > 0 ? read / (read + write + fresh) : 0;
  const current = prompts.at(-1) ?? 0;
  return {
    path: sp.replace(homedir(), "~"),
    model: s.model,
    turns: s.turns.length,
    window: win,
    current,
    peak: prompts.length ? Math.max(...prompts) : 0,
    contextFill: win > 0 ? current / win : 0,
    prompts,
    cache: { read, write, fresh, hit },
    cost,
    started: s.started,
  };
}

const pct = (x: number): string => `${Math.round(x * 100)}%`;
const ktok = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n));

/** Human-readable one-screen summary for `lucid stats` (no --json). */
export function formatStats(s: SessionStats | null, budgets?: Budget[] | null): string {
  if (!s) return "lucid: no omp session found yet (start one with `lucid`).\n";
  const lines = [
    "Lucid session metrics",
    `  model    ${s.model}   ·   turns ${s.turns}`,
    `  spend    $${s.cost.toFixed(4)}`,
    `  cache    ${pct(s.cache.hit)} hit  (read ${ktok(s.cache.read)} · write ${ktok(s.cache.write)} · fresh ${ktok(s.cache.fresh)})`,
    `  context  ${pct(s.contextFill)}  (${ktok(s.current)} / ${ktok(s.window)}, peak ${ktok(s.peak)})`,
  ];
  if (budgets && budgets.length) lines.push(`  budgets  ${budgets.map((b) => `${b.label} ${pct(b.used)}`).join(" · ")}`);
  lines.push(`  session  ${s.path}`);
  return lines.join("\n") + "\n";
}
