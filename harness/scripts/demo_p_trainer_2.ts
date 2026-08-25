// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_p_trainer_2.ts - P-TRAINER.2 (ADR-0253): migration 0012 applies to
// kb_graph.duckdb; the coverage map installs with stable ids; units are append-only; the trainer_*
// event names are contract-valid (and a typo'd one raises).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isEventName } from "../contracts.ts";
import { Telemetry } from "../telemetry/events.ts";
import { TrainerStore } from "../trainer/store.ts";
import { WMO_OBJECTIVES, WMO_PACK_ID, wmoDueDiligenceSeed } from "../trainer/wmo_pack.ts";

const fail = (m: string): never => {
  console.error(`FAIL: ${m}`);
  process.exit(1);
};

const dir = mkdtempSync(join(tmpdir(), "demo-trainer2-"));
const store = await TrainerStore.open(join(dir, "kb_graph.duckdb"));
try {
  const added = await store.addObjectives(WMO_OBJECTIVES);
  if (added !== WMO_OBJECTIVES.length) fail(`expected ${WMO_OBJECTIVES.length} objectives, added ${added}`);
  if ((await store.addObjectives(WMO_OBJECTIVES)) !== 0) fail("re-install must be a no-op (stable ids)");
  console.log(`coverage map installed: ${added} objectives across ${new Set(WMO_OBJECTIVES.map((o) => o.domain)).size} domains`);

  const unitId = await store.addUnit(wmoDueDiligenceSeed());
  const successor = await store.supersedeUnit(unitId, { ...wmoDueDiligenceSeed(), title: "v2" });
  const old = await store.getUnit(unitId);
  if (old?.superseded_by !== successor) fail("supersession must tombstone the original");
  const live = await store.listLiveUnits("wmo-7.1");
  if (live.length !== 1 || live[0]?.unit_id !== successor) fail("live set must contain only the successor");
  console.log(`append-only proven: ${unitId} -> superseded by ${successor}`);

  for (const name of [
    "trainer_session_started",
    "trainer_question_asked",
    "trainer_unit_captured",
    "trainer_teachback_run",
    "trainer_unit_confirmed",
    "trainer_unit_rejected",
    "trainer_pack_exported",
  ]) {
    if (!isEventName(name)) fail(`event not in the frozen contract: ${name}`);
  }
  const tel = new Telemetry({ runId: "run-demo", sessionId: "sess-demo", sink: () => {} });
  let threw = false;
  try {
    tel.emit("trainer_unit_capturd" as never);
  } catch {
    threw = true;
  }
  if (!threw) fail("a typo'd trainer event must raise (invariant #8)");
  console.log("PASS: migration 0012 applied, stable ids held, append-only held, trainer events contract-valid.");
} finally {
  store.close();
  rmSync(dir, { recursive: true, force: true });
}
