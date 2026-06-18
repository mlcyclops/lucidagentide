// harness/bench/benchmark.test.ts

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../memory/db.ts";
import {
  cacheByPrefixVersion,
  outcomesByDimension,
  runBenchmark,
  stablePrefixBuilder,
  volatilePrefixBuilder,
  type BenchRequest,
} from "./benchmark.ts";

let dir: string;
let db: Db;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "bench-test-"));
  db = await Db.open(join(dir, "t.duckdb"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const reqs: BenchRequest[] = Array.from({ length: 5 }, (_, i) => ({
  task: `t${i}`,
  volatile: `date=${i}`, // varies every request
  source: i % 2 === 0 ? "api" : "comment",
  findings: i === 2 ? 1 : 0,
  blocked: i === 2,
}));

test("a byte-stable prefix caches: only the first request misses", async () => {
  const s = await runBenchmark(db, reqs, { suite: "x", version: "1", model: "m", prefixBuilder: stablePrefixBuilder });
  expect(s.requests).toBe(5);
  expect(s.hits).toBe(4); // 5 requests, 1 unique prefix -> 4 hits
  expect(s.hitRate).toBeCloseTo(0.8);
  expect(s.cacheReadTokens).toBeGreaterThan(0);
});

test("ANTI-PATTERN: volatile-in-prefix busts the cache every request", async () => {
  const s = await runBenchmark(db, reqs, { suite: "x", version: "1v", model: "m", prefixBuilder: volatilePrefixBuilder });
  expect(s.hits).toBe(0);
  expect(s.hitRate).toBe(0);
  expect(s.cacheReadTokens).toBe(0); // never reuses a prefix
});

test("cacheByPrefixVersion reports hit rate per version", async () => {
  await runBenchmark(db, reqs, { suite: "x", version: "1", model: "m", prefixBuilder: stablePrefixBuilder });
  await runBenchmark(db, reqs, { suite: "x", version: "1v", model: "m", prefixBuilder: volatilePrefixBuilder });
  const rows = await cacheByPrefixVersion(db);
  const v1 = rows.find((r) => r.prompt_prefix_version === "1");
  const v1v = rows.find((r) => r.prompt_prefix_version === "1v");
  expect(Number(v1?.hit_rate)).toBeCloseTo(0.8);
  expect(Number(v1v?.hit_rate)).toBe(0);
});

test("outcomesByDimension aggregates findings/blocked by dimension", async () => {
  await runBenchmark(db, reqs, { suite: "x", version: "1", model: "m" });
  const bySource = await outcomesByDimension(db, "source");
  const total = bySource.reduce((n, r) => n + Number(r.findings), 0);
  expect(total).toBe(1); // one request had a finding
  const blocked = bySource.reduce((n, r) => n + Number(r.blocked), 0);
  expect(blocked).toBe(1);
});

test("outcomesByDimension rejects an unknown dimension", async () => {
  // @ts-expect-error — invalid dimension
  expect(() => outcomesByDimension(db, "drop_table")).toThrow();
});
