// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/trainer/store.test.ts - P-TRAINER.2 (ADR-0253): migration 0012 + append-only units.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TrainerStore } from "./store.ts";
import { WMO_OBJECTIVES, WMO_PACK_ID, wmoDueDiligenceSeed } from "./wmo_pack.ts";
import { objectiveLevel } from "./coverage.ts";

const dir = mkdtempSync(join(tmpdir(), "trainer-store-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("TrainerStore", () => {
  test("opens kb_graph.duckdb (0011 + 0012 apply) and round-trips the WMO coverage map", async () => {
    const store = await TrainerStore.open(join(dir, "kb_graph.duckdb"));
    try {
      const added = await store.addObjectives(WMO_OBJECTIVES);
      expect(added).toBe(WMO_OBJECTIVES.length);
      // re-install is a no-op (stable ids, invariant #9)
      expect(await store.addObjectives(WMO_OBJECTIVES)).toBe(0);

      const objectives = await store.listObjectives(WMO_PACK_ID);
      expect(objectives.length).toBe(WMO_OBJECTIVES.length);
      const wire = objectives.find((o) => o.objectiveId === "wmo-2.1");
      expect(wire?.domain).toBe("Money movement");
      expect(wire?.elicitation.scenarios.length).toBeGreaterThan(0);
      expect(wire?.elicitation.edgeProbes.length).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });

  test("append-only: supersession chains, tombstones, and the confirmed inventory", async () => {
    const store = await TrainerStore.open(join(dir, "kb2.duckdb"));
    try {
      await store.addObjectives(WMO_OBJECTIVES);
      const seed = wmoDueDiligenceSeed();
      const unitId = await store.addUnit(seed);

      // correction mints a successor and tombstones the old row - never edits in place
      const successorId = await store.supersedeUnit(unitId, { ...seed, title: "Corrected checklist" });
      const old = await store.getUnit(unitId);
      expect(old?.superseded_by).toBe(successorId);
      await expect(store.supersedeUnit(unitId, seed)).rejects.toThrow(/already superseded/);

      // live set excludes the superseded original
      const live = await store.listLiveUnits(seed.objectiveId);
      expect(live.map((u) => u.unit_id)).toEqual([successorId]);

      // confirmed inventory is empty until a confirmation lands
      expect(await store.listConfirmedUnits(WMO_PACK_ID)).toEqual([]);
      await store.confirmUnit(successorId, "expert");
      const confirmed = await store.listConfirmedUnits(WMO_PACK_ID);
      expect(confirmed.map((u) => u.unit_id)).toEqual([successorId]);

      // rubric inputs derive from live units
      const forCoverage = await store.unitsForCoverage(seed.objectiveId);
      expect(forCoverage.length).toBe(1);
      expect(forCoverage[0]?.confirmed).toBe(true);
      expect(objectiveLevel(forCoverage)).toBe(1); // a checklist alone is an outline, not a stepped procedure
    } finally {
      store.close();
    }
  });

  test("sessions and the teach-back trail persist", async () => {
    const store = await TrainerStore.open(join(dir, "kb3.duckdb"));
    try {
      await store.addObjectives(WMO_OBJECTIVES);
      const sessionId = await store.startSession(WMO_PACK_ID, "ops lead");
      const unitId = await store.addUnit({ ...wmoDueDiligenceSeed(), sourceSessionId: sessionId });
      const tbId = await store.addTeachback({ unitId, verdict: "rejected", notes: "not how we do it" });
      await store.tombstoneUnit(unitId, tbId);
      expect((await store.getUnit(unitId))?.superseded_by).toBe(tbId);
      await store.endSession(sessionId, { asked: 3 });
    } finally {
      store.close();
    }
  });

  test("unknown unit kind is refused (closed set)", async () => {
    const store = await TrainerStore.open(join(dir, "kb4.duckdb"));
    try {
      await store.addObjectives(WMO_OBJECTIVES);
      await expect(
        store.addUnit({ ...wmoDueDiligenceSeed(), kind: "vibe" as never }),
      ).rejects.toThrow(/unknown unit kind/);
    } finally {
      store.close();
    }
  });
});
