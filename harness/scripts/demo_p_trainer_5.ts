// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_p_trainer_5.ts - P-TRAINER.5/.6 (ADR-0253/0255): the extraction pack + the
// closed flywheel. Runs the WHOLE loop in one sitting: interview (planner) -> distill (fail-closed)
// -> teach back (confirm = promote) -> generate a trainee quiz FROM confirmed units -> a trainee
// miss becomes the next extraction target. Then proves the pack surface: a signed manifest carrying
// the coverage_map that verifies, and refuses when tampered.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, sign } from "node:crypto";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { Db } from "../memory/db.ts";
import type { ScannerClient } from "../security/scanner_client.ts";
import { Telemetry, type TelemetryEvent } from "../telemetry/events.ts";
import { buildManifest, sha256Bytes, verifyPackManifest, type TrustedPackKey } from "../kb/pack.ts";
import { type UnitForCoverage, coverageScore } from "../trainer/coverage.ts";
import { distillSpan } from "../trainer/distiller.ts";
import { nextQuestion, recordAnswer, startSession, withUnits } from "../trainer/planner.ts";
import { extractionTargetsFromMisses, quizFromUnits } from "../trainer/quizgen.ts";
import { runTeachback } from "../trainer/teachback.ts";
import { TrainerStore } from "../trainer/store.ts";
import { WMO_OBJECTIVES, WMO_PACK_ID } from "../trainer/wmo_pack.ts";

const fail = (m: string): never => {
  console.error(`FAIL: ${m}`);
  process.exit(1);
};

const scanner = { scan: async () => ({ findings: [], scanner_version: "demo" }) } as unknown as ScannerClient;
const EXPERT_ANSWER =
  "The client calls, the adviser verifies on a known number, ops enters the wire, a principal approves it, and the custodian releases before the cutoff.";
const model = async () =>
  JSON.stringify({
    kind: "procedure",
    title: "Routine wire release",
    body_md: "The verified, principal-approved wire path.",
    steps: ["Client asks", "Adviser verifies on a known number", "Ops enters the wire", "A principal approves", "Custodian releases before cutoff"],
    trigger: "",
    resolution: "",
    completeness: 85,
  });

const dir = mkdtempSync(join(tmpdir(), "demo-trainer5-"));
const memoryDb = await Db.open(join(dir, "agent_obs.duckdb"));
const store = await TrainerStore.open(join(dir, "kb_graph.duckdb"));
const events: TelemetryEvent[] = [];
const tel = new Telemetry({ runId: Snowflake.next(), sessionId: Snowflake.next(), sink: (e) => events.push(e) });

try {
  await store.addObjectives(WMO_OBJECTIVES);
  const sessionId = await store.startSession(WMO_PACK_ID, "ops lead");
  tel.emit("trainer_session_started", { session_ref: sessionId, pack_id: WMO_PACK_ID });

  // EXTRACT: the planner asks, the expert answers.
  let planner = startSession(WMO_OBJECTIVES, await store.coverageInputs(WMO_PACK_ID));
  const q = nextQuestion(planner, 0);
  if (!q.question) fail("planner had nothing to ask");
  const question = q.question!;
  tel.emit("trainer_question_asked", { objective_id: question.objectiveId, kind: question.kind });
  console.log(`LUCID (${question.kind}): ${question.text}`);
  console.log(`EXPERT: ${EXPERT_ANSWER}`);
  planner = recordAnswer(q.state, EXPERT_ANSWER);

  // DISTILL: fail-closed capture with provenance.
  const captured = await distillSpan({
    memoryDb, store, scanner, complete: model,
    runId: "run-demo5", sessionId, objectiveId: question.objectiveId, span: EXPERT_ANSWER, telemetry: tel,
  });
  if (!captured.stored) fail(`capture failed: ${captured.reason}`);

  // VERIFY: teach back, expert confirms, the gate promotes.
  const tb = await runTeachback({ memoryDb, store, unitId: captured.unitId!, verdict: "confirmed", decidedBy: "ops lead", telemetry: tel });
  if (!tb.promotion?.promoted) fail("confirmation must promote");
  const before = coverageScore(WMO_OBJECTIVES, new Map<string, readonly UnitForCoverage[]>());
  planner = withUnits(planner, await store.coverageInputs(WMO_PACK_ID));
  const after = coverageScore(WMO_OBJECTIVES, planner.unitsByObjective);
  if (!(after > before)) fail("confirmed capture must move coverage");
  console.log(`teach-back confirmed: coverage ${before} -> ${after} percent`);

  // TRAIN: quiz generated FROM the confirmed unit; a miss becomes the next extraction target.
  const quiz = quizFromUnits(await store.listConfirmedUnits(WMO_PACK_ID), 42);
  if (quiz.length === 0) fail("confirmed procedure must yield a trainee item");
  if (quiz.some((i) => i.sourceUnitId !== captured.unitId)) fail("trainee item lost its source citation");
  console.log(`TRAINEE: ${quiz[0]!.question}`);
  const missed = [{ item: quiz[0]!, chosen: (quiz[0]!.correctAnswer + 1) % 4 }];
  const targets = extractionTargetsFromMisses(missed);
  if (!targets.includes(quiz[0]!.objectiveId)) fail("a trainee miss must re-open the objective as an extraction target");
  console.log(`trainee missed -> extraction target re-opened: ${targets.join(", ")}`);

  await store.endSession(sessionId, { asked: 1, captured: 1, confirmed: 1 });

  // THE PACK: a signed manifest carrying the coverage_map; tamper -> refuse.
  const db = Buffer.from("stand-in for the exported kb_graph.duckdb bytes");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const trusted: TrustedPackKey[] = [{ id: "demo-key", key: publicKey }];
  const manifest = buildManifest({
    kg: { name: "WMO extraction", role: WMO_PACK_ID },
    author: "TechLead 187 LLC",
    version: "1.0.0",
    createdAt: new Date().toISOString(),
    dbSha256: sha256Bytes(db),
    pageCount: 0,
    coverageMap: { pack_id: WMO_PACK_ID, objectives: WMO_OBJECTIVES.map((o) => ({ id: o.objectiveId, domain: o.domain, title: o.title, weight: o.weight })) },
    sign: (canonical) => ({ signature: sign(null, canonical, privateKey).toString("base64"), keyId: "demo-key" }),
  });
  const ok = verifyPackManifest(manifest, sha256Bytes(db), trusted);
  if (!ok.ok || !ok.signed) fail(`pack manifest must verify signed: ${ok.reason}`);
  const tampered = verifyPackManifest({ ...manifest, coverage_map: { ...manifest.coverage_map!, pack_id: "stolen" } }, sha256Bytes(db), trusted);
  if (tampered.ok) fail("a tampered coverage_map must break the signature");
  tel.emit("trainer_pack_exported", { pack_id: WMO_PACK_ID, objectives: WMO_OBJECTIVES.length, signed: true });
  console.log(`pack manifest: signed + verified; tampered coverage_map refused (${tampered.stage})`);

  const emitted = new Set(events.map((e) => e.event));
  for (const required of ["trainer_session_started", "trainer_question_asked", "trainer_unit_captured", "trainer_unit_confirmed", "trainer_pack_exported"]) {
    if (!emitted.has(required as never)) fail(`missing lifecycle event: ${required}`);
  }
  console.log("PASS: the full flywheel - extract -> distill -> confirm-promote -> trainee quiz -> miss re-opens extraction - plus the signed extraction pack.");
} finally {
  memoryDb.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
}
