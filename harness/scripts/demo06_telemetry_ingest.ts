// harness/scripts/demo06_telemetry_ingest.ts
//
// P3.2: run a task that emits telemetry to JSONL, ingest it into DuckDB
// (idempotently, keyed by stable event_id), then run sample SQL queries proving
// security events are queryable and replayable.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type } from "arktype";
import { Snowflake } from "@oh-my-pi/pi-utils";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent";
import { Db } from "../memory/db.ts";
import { ingestArtifact } from "../memory/ingest.ts";
import { recordApproval } from "../security/approvals.ts";
import { ScannerClient } from "../security/scanner_client.ts";
import { makeQuarantineExtension } from "../hooks/quarantine_hook.ts";
import { createEchoSession } from "../testing/echo.ts";
import { Telemetry, fileSink } from "../telemetry/events.ts";
import { ingestTelemetryJsonl } from "../telemetry/ingest_jsonl.ts";
import {
  approvalsByAction,
  blockedToolCalls,
  eventCountsByType,
  findingsByType,
  runTimeline,
} from "../telemetry/queries.ts";

const fail = (m: string): never => {
  console.error(`FAIL: ${m}`);
  process.exit(1);
};

const ZWSP = String.fromCodePoint(0x200b);
const CYR_E = String.fromCodePoint(0x0435);
const POISON = `${CYR_E}dit${ZWSP}_file`;

const dir = mkdtempSync(join(tmpdir(), "demo06-"));
const jsonl = join(dir, "telemetry", "events.jsonl");
const db = await Db.open(join(dir, "agent_obs.duckdb"));
const scanner = new ScannerClient();
scanner.start();

const runId = Snowflake.next();
const sessionId = Snowflake.next();
const tel = new Telemetry({ runId, sessionId, sink: fileSink(jsonl) });

try {
  // ── run a "task": ingest content + a blocked tool call + an approval ───────
  const ing = await ingestArtifact(db, scanner, { runId, sourceType: "import", sourcePath: "pr#7", rawContent: POISON }, { telemetry: tel });
  await ingestArtifact(db, scanner, { runId, sourceType: "paste", rawContent: "a normal note" }, { telemetry: tel });
  await recordApproval(db, { artifactId: ing.artifactId, action: "deny", decidedBy: "nick", rationale: "homoglyph" }, tel);

  // one blocked tool call (emits tool_call_blocked)
  const toolState = { executed: false };
  const recordTool = {
    name: "record_note",
    label: "Record",
    description: "persist a note",
    parameters: type({ note: "string" }),
    async execute() {
      toolState.executed = true;
      return { content: [{ type: "text", text: "ok" }] };
    },
  } as unknown as CustomTool;
  const ext = makeQuarantineExtension({ scanner, telemetry: tel });
  const sess = await createEchoSession({
    customTools: [recordTool],
    extensions: [ext],
    responses: [
      { content: [{ type: "toolCall", name: "record_note", arguments: { note: POISON } }] },
      { content: ["ack"] },
    ],
  });
  await sess.session.prompt("go");
  sess.cleanup();
  if (toolState.executed) fail("tool should have been blocked");

  // ── ingest the JSONL into DuckDB ───────────────────────────────────────────
  const stats = await ingestTelemetryJsonl(db, jsonl);
  console.log(`ingested: processed=${stats.processed} inserted=${stats.inserted} skipped=${stats.skipped}`);
  if (stats.inserted === 0) fail("expected events to be ingested");

  // idempotency: re-ingest the same file -> zero new rows
  const again = await ingestTelemetryJsonl(db, jsonl);
  console.log(`re-ingest: inserted=${again.inserted} duplicates=${again.duplicates} (idempotent)`);
  if (again.inserted !== 0) fail("re-ingestion must insert zero new rows");

  // ── sample SQL queries ─────────────────────────────────────────────────────
  console.log("\n-- event counts by type --");
  for (const r of await eventCountsByType(db, runId)) console.log(`  ${String(r.event).padEnd(22)} ${r.n}`);

  console.log("-- findings by type --");
  for (const r of await findingsByType(db)) console.log(`  ${String(r.finding_type).padEnd(24)} ${r.severity} x${r.n}`);

  console.log("-- blocked tool calls --");
  const blocked = await blockedToolCalls(db);
  for (const r of blocked) console.log(`  tool=${r.tool} trust=${r.trust_label}`);

  console.log("-- approvals by action --");
  for (const r of await approvalsByAction(db)) console.log(`  ${r.action} x${r.n}`);

  console.log("-- run timeline (replay) --");
  const timeline = await runTimeline(db, runId);
  console.log(`  ${timeline.length} events for run ${runId}`);

  if (blocked.length < 1) fail("expected a blocked tool call in telemetry");
  if ((await findingsByType(db)).length < 1) fail("expected finding rows");

  console.log("\ndemo06_telemetry_ingest OK");
} finally {
  scanner.stop();
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
