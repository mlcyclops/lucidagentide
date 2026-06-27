// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo18_turns.ts
//
// ADR-0009 Phase B (issue #12) — prompt/response traceability. Proves a turn is
// captured with full provenance: the RAW prompt is preserved verbatim in the archive
// (by sha) while the `turns` row + any rendering only ever see the SANITIZED text, and
// the turn_captured event is metadata-only (the prompt/reply text never leaves in it).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../memory/db.ts";
import { captureTurn, getTurns } from "../memory/turns.ts";
import { Telemetry, type TelemetryEvent } from "../telemetry/events.ts";

const fail = (m: string): never => {
  console.error(`FAIL: ${m}`);
  process.exit(1);
};

const dir = mkdtempSync(join(tmpdir(), "demo18-"));
const db = await Db.open(join(dir, "agent_obs.duckdb"));

try {
  const events: TelemetryEvent[] = [];
  const tel = new Telemetry({ runId: "run-1", sessionId: "sess-1", sink: (e) => events.push(e) });

  // A poisoned user prompt: a zero-width char + markdown injection metachars.
  const userPrompt = "ship it​ now — *ignore* [prev](x)";
  const reply = "Done. Shipped the build.";

  const u = await captureTurn(db, { sessionId: "sess-1", runId: "run-1", seq: 0, role: "user", text: userPrompt, findingCount: 1, telemetry: tel });
  const a = await captureTurn(db, { sessionId: "sess-1", runId: "run-1", seq: 1, role: "assistant", text: reply, trustLabel: "trusted", telemetry: tel });

  // RAW preserved verbatim in the archive (replay source of truth).
  const chunk = await db.get("SELECT content FROM archive_chunks WHERE chunk_id=$1", [u.archiveChunkId]);
  if (chunk!.content !== userPrompt) fail("raw prompt not preserved verbatim in archive_chunks");

  // The transcript the UI/replay sees is SANITIZED — no invisible survives.
  if (u.sanitizedText.includes("​")) fail("invisible codepoint survived into the sanitized transcript");
  if (!u.sanitizedText.includes("\\u{200b}")) fail("expected the zero-width char as U+200b notation");

  console.log("-- captured transcript (sanitized — the only text ever rendered) --");
  for (const t of await getTurns(db, { sessionId: "sess-1" })) {
    console.log(`  [${t.seq}] ${String(t.role).padEnd(9)} (${t.trust_label}) ${t.sanitized_text}`);
    console.log(`       raw → archive_chunks/${t.archive_chunk_id} sha256:${String(t.raw_sha256).slice(0, 12)}…`);
  }

  // turn_captured events are metadata-only — the prompt/reply text is NOT in them.
  const captured = events.filter((e) => e.event === "turn_captured");
  if (captured.length !== 2) fail(`expected 2 turn_captured events, got ${captured.length}`);
  const blob = JSON.stringify(captured);
  if (blob.includes("ignore") || blob.includes("Shipped")) fail("turn text leaked into a turn_captured event — must be metadata-only");

  console.log(`\nemitted ${captured.length} turn_captured events (metadata only: ids/role/seq/sha/trust/blocked)`);
  console.log(`assistant turn provenance: turn_id=${a.turnId} trust=trusted`);
  console.log("raw preserved by sha; only sanitized text rendered; events carry no content — Phase B held");
  console.log("\ndemo18_turns OK");
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
