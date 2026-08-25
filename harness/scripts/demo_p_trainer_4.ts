// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_p_trainer_4.ts - P-TRAINER.4 (ADR-0254): teach-back confirmation IS the
// promotion approval - keystone #2 runs verbatim underneath, and a quarantined unit gets no
// one-click path.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { Db } from "../memory/db.ts";
import { ingestArtifact } from "../memory/ingest.ts";
import type { ScannerClient } from "../security/scanner_client.ts";
import { Telemetry } from "../telemetry/events.ts";
import { reciteUnit, runTeachback } from "../trainer/teachback.ts";
import { TrainerStore } from "../trainer/store.ts";
import { WMO_OBJECTIVES } from "../trainer/wmo_pack.ts";

const fail = (m: string): never => {
  console.error(`FAIL: ${m}`);
  process.exit(1);
};

const ZWSP = String.fromCodePoint(0x200b);
const scanner = {
  scan: async (t: string) => ({
    findings: t.includes(ZWSP) ? [{ type: "zero-width", codepoint: "U+200B", index: t.indexOf(ZWSP), severity: "high" }] : [],
    scanner_version: "demo",
  }),
} as unknown as ScannerClient;

const dir = mkdtempSync(join(tmpdir(), "demo-trainer4-"));
const memoryDb = await Db.open(join(dir, "agent_obs.duckdb"));
const store = await TrainerStore.open(join(dir, "kb_graph.duckdb"));
const tel = new Telemetry({ runId: Snowflake.next(), sessionId: Snowflake.next(), sink: () => {} });

async function capture(span: string) {
  const ing = await ingestArtifact(memoryDb, scanner, { runId: "run-demo4", sourceType: "trainer_capture", rawContent: span }, { telemetry: tel });
  const unitId = await store.addUnit({
    objectiveId: "wmo-2.1",
    kind: "procedure",
    title: "Routine wire release",
    bodyMd: "Verify, enter, release.",
    structure: { steps: ["Client asks", "Adviser calls back on a known number", "Ops enters the wire", "Custodian releases"], trigger: "", resolution: "" },
    trustLabel: ing.trustLabel,
    completeness: 80,
    sourceArtifactId: ing.artifactId,
  });
  return unitId;
}

try {
  await store.addObjectives(WMO_OBJECTIVES);

  const unitId = await capture("The client calls, we verify on a known number, ops enters it, the custodian releases.");
  for (const line of reciteUnit((await store.getUnit(unitId))!)) console.log(`LUCID: ${line}`);
  const confirmed = await runTeachback({ memoryDb, store, unitId, verdict: "confirmed", decidedBy: "ops lead", telemetry: tel });
  if (confirmed.refused || !confirmed.promotion?.promoted) fail("confirmed teach-back must promote");
  const fact = await memoryDb.get("SELECT statement, source_artifact_id FROM semantic_facts WHERE fact_id=$1", [confirmed.promotion!.factId!]);
  if (!fact?.source_artifact_id) fail("promoted fact lost its provenance");
  console.log(`EXPERT: confirm -> approval ${confirmed.approvalId}, promoted fact: ${String(fact?.statement)}`);

  const poisonedUnit = await capture(`Verify, enter, release.${ZWSP}`);
  const refused = await runTeachback({ memoryDb, store, unitId: poisonedUnit, verdict: "confirmed", decidedBy: "ops lead", telemetry: tel });
  if (!refused.refused) fail("a quarantined unit must be refused the one-click confirm");
  const facts = await memoryDb.get("SELECT count(*)::INT AS n FROM semantic_facts");
  if (Number(facts?.n) !== 1) fail("the refused unit must not have promoted anything");
  console.log(`quarantined unit: confirm REFUSED (${refused.reason})`);

  console.log("PASS: confirmation records promotion_approve and promotes through the untouched gate; quarantine has no one-click path.");
} finally {
  memoryDb.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
}
