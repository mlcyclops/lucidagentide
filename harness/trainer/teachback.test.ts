// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/trainer/teachback.test.ts - P-TRAINER.4 (ADR-0254): confirmation IS the approval;
// keystone #2 runs verbatim underneath.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { Db } from "../memory/db.ts";
import { ingestArtifact } from "../memory/ingest.ts";
import { promoteFactGated } from "../memory/promotion_gate.ts";
import type { ScannerClient } from "../security/scanner_client.ts";
import { Telemetry, type TelemetryEvent } from "../telemetry/events.ts";
import { reciteUnit, runTeachback } from "./teachback.ts";
import { TrainerStore } from "./store.ts";
import { WMO_OBJECTIVES } from "./wmo_pack.ts";

const dir = mkdtempSync(join(tmpdir(), "trainer-teachback-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const cleanScanner = { scan: async () => ({ findings: [], scanner_version: "fake" }) } as unknown as ScannerClient;
const ZWSP = String.fromCodePoint(0x200b);
const poisonScanner = {
  scan: async (t: string) => ({
    findings: t.includes(ZWSP) ? [{ type: "zero-width", codepoint: "U+200B", index: t.indexOf(ZWSP), severity: "high" }] : [],
    scanner_version: "fake",
  }),
} as unknown as ScannerClient;

async function fixture(name: string) {
  const memoryDb = await Db.open(join(dir, `${name}-obs.duckdb`));
  const store = await TrainerStore.open(join(dir, `${name}-kb.duckdb`));
  await store.addObjectives(WMO_OBJECTIVES);
  const events: TelemetryEvent[] = [];
  const tel = new Telemetry({ runId: Snowflake.next(), sessionId: Snowflake.next(), sink: (e) => events.push(e) });
  return { memoryDb, store, events, tel };
}

async function capturedUnit(memoryDb: Db, store: TrainerStore, scanner: ScannerClient, tel: Telemetry, span: string) {
  const ingest = await ingestArtifact(memoryDb, scanner, { runId: "run-tb", sourceType: "trainer_capture", rawContent: span }, { telemetry: tel });
  const unitId = await store.addUnit({
    objectiveId: "wmo-2.1",
    kind: "procedure",
    title: "Routine wire release",
    bodyMd: "Verify, enter, release.",
    structure: { steps: ["Client asks", "Adviser calls back", "Ops enters the wire", "Custodian releases"], trigger: "", resolution: "" },
    trustLabel: ingest.trustLabel,
    completeness: 80,
    sourceArtifactId: ingest.artifactId,
  });
  return { unitId, artifactId: ingest.artifactId };
}

describe("reciteUnit", () => {
  test("recites procedures as numbered steps and edge cases as trigger/resolution", async () => {
    const { memoryDb, store, tel } = await fixture("recite");
    try {
      const { unitId } = await capturedUnit(memoryDb, store, cleanScanner, tel, "clean span");
      const unit = await store.getUnit(unitId);
      const lines = reciteUnit(unit!);
      expect(lines[0]).toContain("confirm, correct, or reject");
      expect(lines).toContain("Step 2: Adviser calls back");
    } finally {
      memoryDb.close();
      store.close();
    }
  });
});

describe("runTeachback", () => {
  test("confirmed: approval recorded, gate promotes with provenance, unit confirmed", async () => {
    const { memoryDb, store, events, tel } = await fixture("confirm");
    try {
      const { unitId, artifactId } = await capturedUnit(memoryDb, store, cleanScanner, tel, "clean span");
      const out = await runTeachback({ memoryDb, store, unitId, verdict: "confirmed", decidedBy: "ops lead", telemetry: tel });
      expect(out.refused).toBe(false);
      expect(out.promotion?.promoted).toBe(true);

      // the approval row exists with the EXISTING action
      const approval = await memoryDb.get("SELECT action FROM approval_events WHERE approval_id=$1", [out.approvalId!]);
      expect(String(approval?.action)).toBe("promotion_approve");

      // the semantic fact carries the artifact provenance chain
      const fact = await memoryDb.get("SELECT source_artifact_id FROM semantic_facts WHERE fact_id=$1", [out.promotion!.factId!]);
      expect(String(fact?.source_artifact_id)).toBe(artifactId);

      const unit = await store.getUnit(unitId);
      expect(unit?.confirmed_at).not.toBeNull();
      expect(events.some((e) => e.event === "trainer_unit_confirmed")).toBe(true);
    } finally {
      memoryDb.close();
      store.close();
    }
  });

  test("a quarantined-source unit is REFUSED the one-click confirm, and the gate still blocks it", async () => {
    const { memoryDb, store, tel } = await fixture("refuse");
    try {
      const { unitId, artifactId } = await capturedUnit(memoryDb, store, poisonScanner, tel, `poisoned${ZWSP} span`);
      const unit = await store.getUnit(unitId);
      expect(unit?.trust_label).toBe("quarantined");

      const out = await runTeachback({ memoryDb, store, unitId, verdict: "confirmed", decidedBy: "ops lead", telemetry: tel });
      expect(out.refused).toBe(true);
      expect(out.approvalId).toBeUndefined();

      // and keystone #2 independently blocks a direct promotion attempt (no approval was written)
      const gate = await promoteFactGated(memoryDb, {
        entityName: "Routine wire release",
        statement: "should not land",
        trustLabel: "untrusted",
        sourceArtifactId: artifactId,
      });
      expect(gate.blocked).toBe(true);
    } finally {
      memoryDb.close();
      store.close();
    }
  });

  test("corrected: successor minted, original tombstoned, successor re-earns confirmation", async () => {
    const { memoryDb, store, tel } = await fixture("correct");
    try {
      const { unitId, artifactId } = await capturedUnit(memoryDb, store, cleanScanner, tel, "clean span");
      const out = await runTeachback({
        memoryDb,
        store,
        unitId,
        verdict: "corrected",
        decidedBy: "ops lead",
        replacement: {
          objectiveId: "wmo-2.1",
          kind: "procedure",
          title: "Routine wire release (corrected)",
          bodyMd: "Verify on a KNOWN number, enter, release.",
          structure: { steps: ["Client asks", "Adviser calls back on a known number", "Ops enters the wire", "Custodian releases"], trigger: "", resolution: "" },
          trustLabel: "untrusted",
          completeness: 90,
          sourceArtifactId: artifactId,
        },
        telemetry: tel,
      });
      expect(out.successorUnitId).toBeDefined();
      expect((await store.getUnit(unitId))?.superseded_by).toBe(out.successorUnitId!);
      const successor = await store.getUnit(out.successorUnitId!);
      expect(successor?.confirmed_at).toBeNull(); // re-earns its own confirmation

      // grading the superseded original again is an error - grade the live successor
      await expect(runTeachback({ memoryDb, store, unitId, verdict: "confirmed", decidedBy: "x" })).rejects.toThrow(/superseded/);
    } finally {
      memoryDb.close();
      store.close();
    }
  });

  test("rejected: tombstoned out of the live set, event emitted", async () => {
    const { memoryDb, store, events, tel } = await fixture("reject");
    try {
      const { unitId } = await capturedUnit(memoryDb, store, cleanScanner, tel, "clean span");
      const out = await runTeachback({ memoryDb, store, unitId, verdict: "rejected", decidedBy: "ops lead", notes: "not our process", telemetry: tel });
      expect((await store.getUnit(unitId))?.superseded_by).toBe(out.teachbackId);
      expect(await store.listLiveUnits("wmo-2.1")).toEqual([]);
      expect(events.some((e) => e.event === "trainer_unit_rejected")).toBe(true);
    } finally {
      memoryDb.close();
      store.close();
    }
  });
});
