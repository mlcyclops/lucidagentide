// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/bench/benchmark.ts
//
// Benchmark suite + prompt-version comparison (P7.2). Cache behavior is computed
// from the prompt assembler's prefix hash, tying the metric back to Increment 2:
// a byte-stable prefix repeats its hash → cache hits; volatile-in-prefix yields a
// unique hash per request → cache misses. Security outcomes are recorded too, so
// prompt/compaction changes can be compared against cache AND security results.

import { createHash } from "node:crypto";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { assemblePrompt, FROZEN_PREFIX } from "../prompt/assembler.ts";
import type { Db, Row } from "../memory/db.ts";

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}
/** Coarse token estimate (~4 chars/token). Stand-in for a real tokenizer. */
function estTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

export interface BenchRequest {
  task: string;
  /** Env/git/date — volatile context that CORRECTLY belongs in the tail. */
  volatile?: string;
  source?: string;
  mode?: string;
  findings?: number;
  blocked?: boolean;
}

export interface BuiltPrompt {
  prefix: string;
  tail: string;
}
export type PrefixBuilder = (req: BenchRequest) => BuiltPrompt;

/** CORRECT discipline: the frozen prefix is constant; volatile goes in the tail. */
export const stablePrefixBuilder: PrefixBuilder = (req) => {
  const a = assemblePrompt({ task: req.task, sessionState: req.volatile ? { info: req.volatile } : undefined });
  return { prefix: a.prefix, tail: a.tail };
};

/** ANTI-PATTERN: volatile context jammed into the prefix — busts the KV cache. */
export const volatilePrefixBuilder: PrefixBuilder = (req) => ({
  prefix: `${FROZEN_PREFIX}\n<volatile>${req.volatile ?? req.task}</volatile>`,
  tail: `<task>${req.task}</task>`,
});

export interface BenchOptions {
  suite: string;
  version: string;
  model: string;
  prefixBuilder?: PrefixBuilder;
}

export interface BenchSummary {
  suite: string;
  version: string;
  model: string;
  requests: number;
  hits: number;
  hitRate: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Run a benchmark: assemble each request, classify cache hit/miss by prefix
 *  hash, and record a bench_runs row per request. */
export async function runBenchmark(db: Db, requests: BenchRequest[], opts: BenchOptions): Promise<BenchSummary> {
  const builder = opts.prefixBuilder ?? stablePrefixBuilder;
  const seen = new Set<string>();
  const now = new Date().toISOString();
  let hits = 0;
  let cacheRead = 0;
  let cacheWrite = 0;

  for (const req of requests) {
    const built = builder(req);
    const prefixHash = sha256(built.prefix);
    const prefixTokens = estTokens(built.prefix);
    const tailTokens = estTokens(built.tail);
    const cacheHit = seen.has(prefixHash);
    if (cacheHit) {
      hits++;
      cacheRead += prefixTokens;
    } else {
      seen.add(prefixHash);
      cacheWrite += prefixTokens;
    }
    await db.run(
      `INSERT INTO bench_runs
         (bench_id, suite, prompt_prefix_version, prefix_hash, model, source, mode,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cache_hit, findings, blocked, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        Snowflake.next(),
        opts.suite,
        opts.version,
        prefixHash,
        opts.model,
        req.source ?? null,
        req.mode ?? null,
        prefixTokens + tailTokens,
        50,
        cacheHit ? prefixTokens : 0,
        cacheHit ? 0 : prefixTokens,
        cacheHit,
        req.findings ?? 0,
        req.blocked ?? false,
        now,
      ],
    );
  }
  return {
    suite: opts.suite,
    version: opts.version,
    model: opts.model,
    requests: requests.length,
    hits,
    hitRate: requests.length ? hits / requests.length : 0,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
  };
}

/** Cache-hit rate + token split per prompt-prefix version (the Increment-2 proof). */
export function cacheByPrefixVersion(db: Db): Promise<Row[]> {
  return db.all(
    `SELECT prompt_prefix_version, model,
            count(*)::INT AS requests,
            sum(CASE WHEN cache_hit THEN 1 ELSE 0 END)::INT AS hits,
            round(avg(CASE WHEN cache_hit THEN 1.0 ELSE 0.0 END), 3) AS hit_rate,
            sum(cache_read_tokens)::INT AS cache_read_tokens,
            sum(cache_write_tokens)::INT AS cache_write_tokens
     FROM bench_runs
     GROUP BY prompt_prefix_version, model
     ORDER BY prompt_prefix_version, model`,
  );
}

/** Compare security outcomes by a dimension (source / mode / model). */
export function outcomesByDimension(db: Db, dim: "source" | "mode" | "model"): Promise<Row[]> {
  if (dim !== "source" && dim !== "mode" && dim !== "model") throw new Error(`bad dimension: ${dim}`);
  return db.all(
    `SELECT ${dim} AS dimension,
            count(*)::INT AS requests,
            sum(findings)::INT AS findings,
            sum(CASE WHEN blocked THEN 1 ELSE 0 END)::INT AS blocked
     FROM bench_runs
     GROUP BY ${dim}
     ORDER BY requests DESC, dimension`,
  );
}
