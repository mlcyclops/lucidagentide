// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo01_contracts.ts
//
// Increment 1: boundary contracts. Two proofs:
//   A. Telemetry: emit() writes typed JSONL events, stamps stable ids, and
//      RAISES on an off-enum event name (invariant #8).
//   B. ToolResult round-trips through result_adapter in BOTH directions, with
//      the load-bearing fields preserved.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Snowflake } from "@oh-my-pi/pi-utils";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { ToolResult } from "../contracts.ts";
import { Telemetry, UnknownEventError } from "../telemetry/events.ts";
import { fromOmpResult, toOmpResult } from "../tools/result_adapter.ts";

const fail = (msg: string): never => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

// ── A. Telemetry events → JSONL ─────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), "demo01-"));
const jsonl = join(dir, "telemetry", "events.jsonl");

const runId = Snowflake.next();
const sessionId = Snowflake.next();
const artifactId = Snowflake.next();
console.log(`run_id=${runId} session_id=${sessionId}`);

const tel = new Telemetry({ runId, sessionId, sink: jsonl });
tel.emit("run_started", { mode: "general" });
tel.emit("content_ingested", { artifact_id: artifactId, source_type: "paste" });
tel.emit("content_scanned", { artifact_id: artifactId, verdict: "clean", scanner_version: "0.1.0" });
tel.emit("run_finished", { ok: true });

const lines = readFileSync(jsonl, "utf8").trim().split("\n");
console.log(`A. emitted ${lines.length} events to ${jsonl}`);
if (lines.length !== 4) fail(`expected 4 JSONL lines, got ${lines.length}`);

for (const line of lines) {
  const ev = JSON.parse(line);
  if (!ev.run_id || !ev.session_id || !ev.event || !ev.ts) {
    fail(`event missing required envelope field: ${line}`);
  }
}
const ingest = JSON.parse(lines[1]!);
if (ingest.artifact_id !== artifactId) fail("artifact_id not carried on in-scope event");
console.log(`   every event carries ts/run_id/session_id; artifact_id present where in scope`);

// unknown event name must raise
let raised = false;
try {
  // @ts-expect-error — deliberately off-enum to prove the guard fires
  tel.emit("totally_made_up_event", {});
} catch (e) {
  raised = e instanceof UnknownEventError;
}
if (!raised) fail("unknown event name did NOT raise");
console.log(`   off-enum event name raised UnknownEventError ✓`);

// ── B. ToolResult round-trips both ways ─────────────────────────────────────
// PRD → omp → PRD: tool_name/success/summary/duration survive.
const prd: ToolResult = {
  tool_name: "read",
  success: true,
  summary: "file contents here",
  payload: { lines: 3 },
  duration_ms: 12,
};
const back = fromOmpResult(prd.tool_name, toOmpResult(prd), prd.duration_ms);
if (
  back.tool_name !== prd.tool_name ||
  back.success !== prd.success ||
  back.summary !== prd.summary ||
  back.duration_ms !== prd.duration_ms
) {
  fail(`PRD→omp→PRD lost a field: ${JSON.stringify(back)}`);
}
console.log(`B. PRD→omp→PRD preserved tool_name/success/summary/duration ✓`);

// omp → PRD → omp: text content + isError survive.
const omp: AgentToolResult = {
  content: [{ type: "text", text: "boom" }],
  isError: true,
};
const omp2 = toOmpResult(fromOmpResult("bash", omp, 5));
const text2 = omp2.content.find((c) => c.type === "text");
if (!text2 || !("text" in text2) || text2.text !== "boom" || omp2.isError !== true) {
  fail(`omp→PRD→omp lost text or isError: ${JSON.stringify(omp2)}`);
}
console.log(`   omp→PRD→omp preserved text content + isError ✓`);

rmSync(dir, { recursive: true, force: true });
console.log("demo01_contracts OK");
process.exit(0);
