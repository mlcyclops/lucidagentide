// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/bench/devset/tasks.ts - P-BENCH.2a (ADR-0591): a fixed long-context dev set, with reference answers.
//
// Four LUCID-shaped jobs, each at three input lengths, each in two variants: 24 tasks.
//   needle  one keyed value in a long build log, among look-alikes for other keys
//   count   how many lines of a test run failed
//   track   the final value of a setting after thousands of ordered changes, some through another's name
//   rank    which files mention an error most, from a grep dump
// These are the paper's four long-context skills (retrieve, aggregate, track state, rank) in the shape a
// coding agent meets them: as the output of a tool.
//
// THE DATA IS GENERATED, NOT STORED. A 512,000 character fixture per task would put megabytes of filler in
// the repository. Each haystack is built from a fixed seed, so every run on every machine gets the same
// bytes, and `manifest.json` beside this file records each haystack's hash and answer: a change to the
// generator that moves either one fails a test instead of quietly changing what a score means.
//
// The lengths straddle omp's window. At 8,000 characters a model is shown the whole result. At 64,000 and
// 512,000 it is shown a head and a tail, and every answer is placed in the part it is not shown.
//
// Pure: no I/O, no clock, no randomness that is not seeded.

export const DEVSET_VERSION = "1";
export const DEVSET_LENGTHS = [8_000, 64_000, 512_000] as const;
export const DEVSET_FAMILIES = ["needle", "count", "track", "rank"] as const;
export type TaskFamily = (typeof DEVSET_FAMILIES)[number];
export type Scoring = "exact" | "ndcg";

export interface DevTask {
  /** `<family>-<length>-<variant>`, stable across versions of the generator. */
  id: string;
  family: TaskFamily;
  length: number;
  variant: "a" | "b";
  question: string;
  /** What the tool returns. */
  haystack: string;
  scoring: Scoring;
  /** The reference answer (exact), or the ideal ranking (ndcg). */
  answer: string;
  /** ndcg only: how relevant each candidate is. Anything not listed is 0. */
  relevance?: Record<string, number>;
}

/** A small seeded generator (mulberry32). The same seed gives the same sequence everywhere. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
const int = (r: () => number, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));

/** Lines of filler until the text is at least `length` characters. */
function fill(length: number, line: (i: number) => string): string[] {
  const out: string[] = [];
  for (let size = 0, i = 1; size < length; i++) { const l = line(i); out.push(l); size += l.length + 1; }
  return out;
}
/** `n` line indexes spread through the middle 30 percent, in order. omp shows a model the first and last
 *  20,000 characters of a stored result, so at 64,000 characters the hidden part is roughly 31 to 69 percent
 *  of the text. Staying between 35 and 65 percent keeps every answer out of view at both longer lengths. */
function middle(total: number, n: number): number[] {
  const from = Math.floor(total * 0.35);
  const span = Math.floor(total * 0.3);
  return Array.from({ length: n }, (_, k) => from + Math.floor(((k + 0.5) * span) / n));
}
const clock = (i: number): string => `${String(8 + Math.floor(i / 3600) % 12).padStart(2, "0")}:${String(Math.floor(i / 60) % 60).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}`;

const SERVICES = ["billing-api", "auth-gateway", "search-indexer", "mail-relay", "report-builder", "asset-cdn", "audit-log", "rate-limiter"];
const MODULES = ["core", "net", "ui", "store", "sync", "parse", "render", "crypto", "queue", "cache"];

function needleTask(length: number, variant: "a" | "b"): DevTask {
  const r = seeded(length * 31 + (variant === "a" ? 1 : 2));
  const lines = fill(length, (i) => `[${clock(i)}] build step ${i}: compiled module ${pick(r, MODULES)}-${int(r, 1, 400)} in ${int(r, 3, 900)}ms (ok)`);
  const at = middle(lines.length, SERVICES.length);
  const revs = SERVICES.map(() => `r${int(r, 1000, 9999)}`);
  SERVICES.forEach((svc, k) => { lines[at[k]!] = `[${clock(at[k]!)}] deploy: token for service ${svc} rotated to revision ${revs[k]}`; });
  const k = variant === "a" ? 2 : 5;
  return {
    id: `needle-${length}-${variant}`, family: "needle", length, variant, scoring: "exact", haystack: lines.join("\n"), answer: revs[k]!,
    question: `In the build log, what revision was the deploy token for service ${SERVICES[k]} rotated to? Answer with the revision only, for example r1234.`,
  };
}

function countTask(length: number, variant: "a" | "b"): DevTask {
  const r = seeded(length * 37 + (variant === "a" ? 3 : 4));
  const lines = fill(length, (i) => `ok   test_${pick(r, MODULES)}_${i} (${int(r, 1, 80)}ms)`);
  // Failures only in the middle, so the part a model is shown holds none of them at the longer lengths.
  const failures = variant === "a" ? 7 : 13;
  for (const i of middle(lines.length, failures)) lines[i] = `FAIL test_${pick(r, MODULES)}_${i + 1} (assertion at line ${int(r, 10, 400)})`;
  return {
    id: `count-${length}-${variant}`, family: "count", length, variant, scoring: "exact", haystack: lines.join("\n"), answer: String(failures),
    question: "In the test run, how many lines start with FAIL? Answer with the number only.",
  };
}

const KEYS = ["primary", "replica", "region", "pool-size", "timeout", "log-level", "feature-x", "feature-y", "owner", "tier", "quota", "window"];

function trackTask(length: number, variant: "a" | "b"): DevTask {
  const r = seeded(length * 41 + (variant === "a" ? 5 : 6));
  const state = new Map<string, string>();
  const lines = fill(length, (i) => {
    const key = pick(r, KEYS);
    const value = `v${int(r, 100, 99999)}`;
    state.set(key, value);
    return `[${clock(i)}] config change ${i}: set ${key} = ${value} (by operator ${int(r, 1, 40)})`;
  });
  // Variant b asks for a key that was last set THROUGH another key's name, in the middle of the log.
  let target = "timeout";
  if (variant === "b") {
    const at = middle(lines.length, 3)[1]!;
    // Replay up to that line to know what `primary` held at that moment.
    const then = new Map<string, string>();
    for (let i = 0; i < at; i++) { const m = /set ([\w-]+) = (\S+)/.exec(lines[i]!); if (m) then.set(m[1]!, m[2]!); }
    lines[at] = `[${clock(at)}] config change ${at + 1}: set mirror = primary (by operator 7)`;
    state.set("mirror", then.get("primary") ?? "primary");
    target = "mirror";
  } else {
    // Make sure the last change to the target is in the middle, not in the tail a model is shown.
    const at = middle(lines.length, 5)[3]!;
    for (let i = at + 1; i < lines.length; i++) if (lines[i]!.includes(" set timeout = ")) lines[i] = lines[i]!.replace(" set timeout = ", " set window = ");
    lines[at] = `[${clock(at)}] config change ${at + 1}: set timeout = v${int(r, 100, 99999)} (by operator 3)`;
    const replay = new Map<string, string>();
    for (const l of lines) { const m = /set ([\w-]+) = (\S+)/.exec(l); if (m) replay.set(m[1]!, m[2]!); }
    state.set("timeout", replay.get("timeout")!);
  }
  return {
    id: `track-${length}-${variant}`, family: "track", length, variant, scoring: "exact", haystack: lines.join("\n"), answer: state.get(target)!,
    question: `The log lists configuration changes in order. A change of the form "set a = b", where b is the name of another key, gives a the value b holds at that moment. After every change is applied, what is the value of ${target}? Answer with the value only, for example v12345.`,
  };
}

const FILES = ["src/auth/session.ts", "src/auth/token.ts", "src/net/client.ts", "src/net/retry.ts", "src/ui/login.tsx", "src/store/cache.ts", "src/sync/worker.ts", "src/queue/jobs.ts", "src/crypto/sign.ts", "src/parse/config.ts", "src/render/page.tsx", "src/core/boot.ts"];
const ERRORS = ["E_TOKEN_EXPIRED", "E_RATE_LIMITED", "E_BAD_SIGNATURE", "E_TIMEOUT"];

function rankTask(length: number, variant: "a" | "b"): DevTask {
  const r = seeded(length * 43 + (variant === "a" ? 7 : 8));
  const error = variant === "a" ? ERRORS[0]! : ERRORS[2]!;
  const others = ERRORS.filter((e) => e !== error);
  const lines = fill(length, (i) => `${pick(r, FILES)}:${int(r, 1, 900)}: handles ${pick(r, others)} in ${pick(r, MODULES)} path ${i}`);
  // Five files mention the error, a different number of times each. All mentions sit in the middle.
  const order = variant === "a" ? [1, 0, 3, 4, 8] : [8, 2, 1, 6, 9];
  const counts = [9, 6, 4, 2, 1];
  const slots = middle(lines.length, counts.reduce((a, b) => a + b, 0));
  const relevance: Record<string, number> = {};
  let s = 0;
  order.forEach((f, k) => {
    relevance[FILES[f]!] = counts[k]!;
    for (let c = 0; c < counts[k]!; c++, s++) lines[slots[s]!] = `${FILES[f]}:${int(r, 1, 900)}: throws ${error} when the ${pick(r, MODULES)} check fails`;
  });
  return {
    id: `rank-${length}-${variant}`, family: "rank", length, variant, scoring: "ndcg", haystack: lines.join("\n"), relevance,
    answer: order.map((f) => FILES[f]).join(", "),
    question: `The search results list one match per line as path:line: text. Which files mention ${error} most often? Rank them, most mentions first. Answer with up to five paths separated by commas.`,
  };
}

const BUILD: Record<TaskFamily, (length: number, variant: "a" | "b") => DevTask> = { needle: needleTask, count: countTask, track: trackTask, rank: rankTask };

/** PURE: the whole dev set, in a fixed order. `lengths` narrows it (a quick run uses the two short ones). */
export function buildDevset(lengths: readonly number[] = DEVSET_LENGTHS): DevTask[] {
  const out: DevTask[] = [];
  for (const family of DEVSET_FAMILIES) for (const length of lengths) for (const variant of ["a", "b"] as const) out.push(BUILD[family](length, variant));
  return out;
}

/** PURE: one task by id, or undefined. */
export function devTask(id: string): DevTask | undefined {
  const m = /^(needle|count|track|rank)-(\d+)-(a|b)$/.exec(id);
  return m ? BUILD[m[1] as TaskFamily](Number(m[2]), m[3] as "a" | "b") : undefined;
}
