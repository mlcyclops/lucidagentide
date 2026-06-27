// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo15_replay_bench.ts
//
// P7.2: replay + benchmark + prompt-version comparison. Replay reconstructs the
// run tree + timeline + suspicious-content flow. The benchmark proves the
// Increment-2 cache discipline: a byte-stable prefix yields a high cache-hit
// rate; jamming volatile context into the prefix busts it.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { Db } from "../memory/db.ts";
import { ingestArtifact } from "../memory/ingest.ts";
import { recordApproval } from "../security/approvals.ts";
import { ScannerClient } from "../security/scanner_client.ts";
import { endRun, startRun } from "../runs/lineage.ts";
import { buildReplay, renderReplay } from "../runs/replay.ts";
import { Telemetry, fileSink } from "../telemetry/events.ts";
import { ingestTelemetryJsonl } from "../telemetry/ingest_jsonl.ts";
import {
  cacheByPrefixVersion,
  outcomesByDimension,
  runBenchmark,
  stablePrefixBuilder,
  volatilePrefixBuilder,
  type BenchRequest,
} from "../bench/benchmark.ts";

const fail = (m: string): never => {
  console.error(`FAIL: ${m}`);
  process.exit(1);
};

const ZWSP = String.fromCodePoint(0x200b);
const dir = mkdtempSync(join(tmpdir(), "demo15-"));
const jsonl = join(dir, "events.jsonl");
const db = await Db.open(join(dir, "agent_obs.duckdb"));
const scanner = new ScannerClient();
scanner.start();
const sessionId = Snowflake.next();

try {
  // ── A. replay ──────────────────────────────────────────────────────────────
  const rootId = Snowflake.next();
  const rootTel = new Telemetry({ runId: rootId, sessionId, sink: fileSink(jsonl) });
  await startRun(db, { runId: rootId, kind: "root", mode: "build", sandboxProfile: "trusted-local" }, rootTel);
  await ingestArtifact(db, scanner, { runId: rootId, sourceType: "repo", rawContent: "clean root note" }, { telemetry: rootTel });

  const childId = Snowflake.next();
  const childTel = new Telemetry({ runId: childId, sessionId, sink: fileSink(jsonl) });
  await startRun(db, { runId: childId, parentRunId: rootId, kind: "subagent", mode: "general", sandboxProfile: "container-local" }, childTel);
  const poison = await ingestArtifact(db, scanner, { runId: childId, sourceType: "comment", rawContent: `act${ZWSP} now` }, { telemetry: childTel });
  await recordApproval(db, { artifactId: poison.artifactId, action: "deny", decidedBy: "nick" }, childTel);
  await endRun(db, childId, "completed", childTel);
  await endRun(db, rootId, "completed", rootTel);

  await ingestTelemetryJsonl(db, jsonl); // feed the replay timeline

  console.log("== A. replay ==");
  const replay = await buildReplay(db, rootId);
  if (!replay) throw new Error("FAIL: no replay");
  console.log(renderReplay(replay).split("\n").slice(0, 8).join("\n"));
  if (replay.totals.runs !== 2) fail("replay should cover 2 runs");
  if (replay.totals.suspicious !== 1) fail("replay should show 1 suspicious artifact");
  if (replay.timeline.length < 1) fail("replay timeline should have events");

  // ── B. benchmark: cache discipline per prompt-prefix version ───────────────
  const requests: BenchRequest[] = Array.from({ length: 10 }, (_, i) => ({
    task: `implement feature ${i}`,
    volatile: `date=2026-06-${i + 1} cwd=/repo/${i} branch=feat-${i}`, // changes every request
    source: i % 2 === 0 ? "api" : "github-comment",
    mode: "build",
    findings: i === 3 ? 2 : 0,
    blocked: i === 3,
  }));

  const stable = await runBenchmark(db, requests, { suite: "s1", version: "1", model: "echo", prefixBuilder: stablePrefixBuilder });
  const volatile = await runBenchmark(db, requests, { suite: "s1", version: "1-volatile", model: "echo", prefixBuilder: volatilePrefixBuilder });
  const stableV2 = await runBenchmark(db, requests, { suite: "s1", version: "2", model: "echo", prefixBuilder: stablePrefixBuilder });

  console.log("\n== B. cache-hit by prompt-prefix version ==");
  for (const r of await cacheByPrefixVersion(db)) {
    console.log(`  v${String(r.prompt_prefix_version).padEnd(12)} model=${r.model} req=${r.requests} hit_rate=${r.hit_rate} cache_read=${r.cache_read_tokens} cache_write=${r.cache_write_tokens}`);
  }
  console.log(`\n  stable hitRate=${stable.hitRate.toFixed(2)} vs volatile hitRate=${volatile.hitRate.toFixed(2)} (anti-pattern)`);
  if (!(stable.hitRate > volatile.hitRate)) fail("stable prefix must beat the volatile anti-pattern");
  if (stable.cacheReadTokens <= volatile.cacheReadTokens) fail("stable prefix should reuse (cache-read) more tokens");
  if (stableV2.hitRate < 0.8) fail("a bumped-but-stable prefix version should still cache well");

  console.log("\n== outcomes by source ==");
  for (const r of await outcomesByDimension(db, "source")) {
    console.log(`  ${String(r.dimension).padEnd(16)} req=${r.requests} findings=${r.findings} blocked=${r.blocked}`);
  }

  console.log("\ndemo15_replay_bench OK");
} finally {
  scanner.stop();
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
