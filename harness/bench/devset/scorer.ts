// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/bench/devset/scorer.ts - P-BENCH.2a (ADR-0591): turn a model's reply into a score from 0 to 100.
//
// A reply is scored on its LAST line of the form `ANSWER: ...`. A reply with no such line scores 0: a model
// that will not commit to an answer has not answered. Exact tasks are right or wrong. Ranking tasks are
// scored by NDCG at 10, which rewards putting the most relevant files first and gives partial credit.
//
// Pure: no I/O.

import type { DevTask, TaskFamily } from "./tasks.ts";

/** PURE: the answer a reply commits to, or null. */
export function extractAnswer(reply: string): string | null {
  let found: string | null = null;
  for (const line of reply.split(/\r?\n/)) {
    const m = /^\s*(?:\*\*)?ANSWER:?(?:\*\*)?\s*:?\s*(.*)$/i.exec(line);
    if (m && m[1]!.trim() !== "") found = m[1]!;
  }
  return found === null ? null : clean(found);
}

/** Strip what models wrap an answer in: quotes, backticks, bold marks, a trailing period. */
function clean(s: string): string {
  return s.trim().replace(/^[`"'*\s]+|[`"'*\s]+$/g, "").replace(/\.$/, "").trim();
}

/** PURE: two exact answers compared: case-insensitive, and a number may carry thousands separators. */
export function exactMatch(given: string, reference: string): boolean {
  const norm = (s: string): string => { const t = clean(s).toLowerCase(); return /^[\d,]+$/.test(t) ? t.replace(/,/g, "") : t; };
  return norm(given) === norm(reference);
}

/** PURE: a ranking answer as a list: split on commas, semicolons and new lines, duplicates dropped. */
export function parseRanking(given: string): string[] {
  const out: string[] = [];
  for (const part of given.split(/[,;\n]+/)) {
    const item = clean(part.replace(/^\s*\d+[.)]\s*/, ""));
    if (item && !out.includes(item)) out.push(item);
  }
  return out;
}

/** PURE: NDCG at 10 for a ranking against graded relevance, from 0 to 1. */
export function ndcgAt10(ranked: readonly string[], relevance: Readonly<Record<string, number>>): number {
  const dcg = (gains: readonly number[]): number => gains.slice(0, 10).reduce((sum, g, i) => sum + (2 ** g - 1) / Math.log2(i + 2), 0);
  const ideal = dcg(Object.values(relevance).sort((a, b) => b - a));
  if (ideal === 0) return 0;
  return dcg(ranked.map((id) => relevance[id] ?? 0)) / ideal;
}

/** PURE: a reply's score on a task, from 0 to 100. */
export function scoreReply(task: Pick<DevTask, "scoring" | "answer" | "relevance">, reply: string): number {
  const given = extractAnswer(reply);
  if (given === null) return 0;
  if (task.scoring === "exact") return exactMatch(given, task.answer) ? 100 : 0;
  return Math.round(ndcgAt10(parseRanking(given), task.relevance ?? {}) * 1000) / 10;
}

export interface TaskResult {
  id: string;
  family: TaskFamily;
  length: number;
  score: number;
  /** The reply's committed answer, for the record. */
  given: string | null;
  /** Characters of tool results the model was handed while working. */
  contextChars: number;
  /** The tools it called, in order. */
  tools: string[];
  /** Set when the run failed instead of answering. */
  error?: string;
}

export interface Summary {
  overall: number;
  byLength: Record<string, number>;
  byFamily: Record<string, number>;
  /** family -> length -> mean score. */
  grid: Record<string, Record<string, number>>;
  tasks: number;
  errors: number;
  /** Mean characters of tool results per task. */
  meanContextChars: number;
}

const mean = (xs: readonly number[]): number => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : 0);

/** PURE: mean scores overall, per input length, per family, and for each family at each length. */
export function summarize(results: readonly TaskResult[]): Summary {
  const group = (key: (r: TaskResult) => string): Record<string, number> => {
    const buckets = new Map<string, number[]>();
    for (const r of results) { const k = key(r); buckets.set(k, [...(buckets.get(k) ?? []), r.score]); }
    return Object.fromEntries([...buckets.entries()].map(([k, v]) => [k, mean(v)]));
  };
  const grid: Record<string, Record<string, number>> = {};
  for (const family of new Set(results.map((r) => r.family))) {
    const rows = results.filter((r) => r.family === family);
    grid[family] = Object.fromEntries([...new Set(rows.map((r) => r.length))].map((len) => [String(len), mean(rows.filter((r) => r.length === len).map((r) => r.score))]));
  }
  return {
    overall: mean(results.map((r) => r.score)),
    byLength: group((r) => String(r.length)),
    byFamily: group((r) => r.family),
    grid,
    tasks: results.length,
    errors: results.filter((r) => r.error !== undefined).length,
    meanContextChars: Math.round(mean(results.map((r) => r.contextChars))),
  };
}

/** PURE: a summary as a small text table: one row per family, one column per length. */
export function summaryTable(label: string, s: Summary): string {
  const lengths = Object.keys(s.byLength).sort((a, b) => Number(a) - Number(b));
  const col = (v: string): string => v.padStart(9);
  const rows = [`${label}`, `${"".padEnd(8)}${lengths.map((l) => col(`${Number(l).toLocaleString("en-US")}`)).join("")}${col("all")}`];
  for (const family of Object.keys(s.grid)) rows.push(`${family.padEnd(8)}${lengths.map((l) => col(String(s.grid[family]![l] ?? "-"))).join("")}${col(String(s.byFamily[family]))}`);
  rows.push(`${"all".padEnd(8)}${lengths.map((l) => col(String(s.byLength[l]))).join("")}${col(String(s.overall))}`);
  rows.push(`${s.tasks} tasks, ${s.errors} failed to run, ${s.meanContextChars.toLocaleString("en-US")} characters of tool results per task on average`);
  return rows.join("\n");
}
