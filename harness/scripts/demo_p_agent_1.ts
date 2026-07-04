// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_p_agent_1.ts
//
// P-AGENT.1 (ADR-0129): the Agent Spec is the single source of truth for a Builder-authored agent. This demo
// proves the two fail-closed properties the Agent Builder is built on:
//   1. a valid v1 DAG spec round-trips through DuckDB (migration 0010) save → load unchanged;
//   2. a malformed spec (here: a cycle — v1 is a DAG) is REFUSED by the store and never persisted.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../memory/db.ts";
import { saveSpec, loadSpec, listSpecs } from "../agent/store.ts";
import { newSpecId, validateSpec, SPEC_VERSION, type AgentSpec } from "../agent/spec.ts";

const fail = (m: string): never => {
  console.error(`FAIL: ${m}`);
  process.exit(1);
};

const now = 1_700_000_000_000;

const good: AgentSpec = {
  spec_id: newSpecId(),
  spec_version: SPEC_VERSION,
  name: "researcher",
  description: "plan → search → summarize",
  mode: "built-agent",
  tools: ["web_search"],
  egress: ["*.example.com"],
  selfEdit: "individual",
  nodes: [
    { id: "a", kind: "prompt", label: "Plan", prompt: "Plan the research" },
    { id: "b", kind: "tool", label: "Search", tool: "web_search" },
    { id: "c", kind: "prompt", label: "Summarize", prompt: "Summarize findings" },
  ],
  edges: [
    { id: "e1", from: "a", to: "b" },
    { id: "e2", from: "b", to: "c" },
  ],
  created_at: now,
  updated_at: now,
};

// Same spec but with a back-edge c → a: a cycle, which v1 (a DAG) must reject.
const cyclic: AgentSpec = { ...good, spec_id: newSpecId(), edges: [...good.edges, { id: "e3", from: "c", to: "a" }] };

const dir = mkdtempSync(join(tmpdir(), "demo-p-agent-1-"));
const db = await Db.open(join(dir, "agent_obs.duckdb"));

try {
  console.log(`migration 0010 applied: versions include 10 -> ${(await db.appliedVersions()).includes(10)}`);

  // ── 1. valid DAG round-trips ────────────────────────────────────────────────
  const v = validateSpec(good);
  console.log(`\n1. valid spec -> ok=${v.ok} (${good.nodes.length} nodes, ${good.edges.length} edges)`);
  if (!v.ok) fail(`valid spec was rejected: ${v.errors.join("; ")}`);
  await saveSpec(db, good);
  const loaded = await loadSpec(db, good.spec_id);
  const same = JSON.stringify(loaded) === JSON.stringify(good);
  console.log(`   save → load round-trip identical: ${same}`);
  if (!same) fail("round-trip did not preserve the spec exactly");

  // ── 2. cyclic spec is refused fail-closed ───────────────────────────────────
  const cv = validateSpec(cyclic);
  console.log(`\n2. cyclic spec -> ok=${cv.ok} reason="${cv.errors[0] ?? ""}"`);
  if (cv.ok) fail("a cyclic workflow must be rejected (v1 is a DAG)");
  let refused = false;
  try {
    await saveSpec(db, cyclic);
  } catch {
    refused = true;
  }
  console.log(`   store refused to persist the invalid spec: ${refused}`);
  if (!refused) fail("the store must refuse an invalid spec (fail-closed)");

  // ── 3. only the valid spec is stored ────────────────────────────────────────
  const list = await listSpecs(db);
  console.log(`\n3. stored specs: ${list.length} (${list.map((s) => s.name).join(", ")})`);
  if (list.length !== 1) fail(`expected exactly 1 stored spec, got ${list.length}`);

  console.log("\ndemo_p_agent_1 OK — valid DAG persists, invalid spec is refused fail-closed");
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
