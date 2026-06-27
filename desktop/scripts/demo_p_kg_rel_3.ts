// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_kg_rel_3.ts
//
// Increment P-KG-REL.3 — remove a relationship (issue/ADR-0082). You could CREATE edges (P-KG-REL.1/.2) but
// never delete one. The node panel now lists a node's relationships with a remove (×) button. Two proofs:
//   A. removeEdgeOptimistic: the edge vanishes from the live graph instantly, input untouched (rollback-safe).
//   B. store.removeLink: the removal persists through the encrypted store; only the targeted edge goes.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PersonalStore } from "../../harness/personal/store.ts";
import { randomKey } from "../../harness/personal/crypto.ts";
import type { PersonalGraphData } from "../renderer/bridge.ts";
import { removeEdgeOptimistic } from "../renderer/kg_ops.ts";

const fail = (msg: string): never => { console.error(`FAIL: ${msg}`); process.exit(1); };
const ok = (msg: string): void => console.log(`   ${msg} ✓`);

console.log("== [1/2] #ADR-0082 optimistic edge removal (instant + rollback-safe) ==");
const data: PersonalGraphData = { nodes: [], facts: [], edges: [
  { from: "a", to: "b", relation: "related" }, { from: "a", to: "b", relation: "deploys with" },
] };
const after = removeEdgeOptimistic(data, "a", "b", "related");
if (after.edges.length !== 1 || after.edges[0]!.relation !== "deploys with") fail("only the matching edge should be removed");
if (data.edges.length !== 2) fail("input must not be mutated (rollback-safe)");
if (removeEdgeOptimistic(data, "a", "b", "nope") !== data) fail("a non-matching removal must be a no-op");
ok('removed exactly a→b "related"; the other edge + the input array are untouched');

console.log("== [2/2] #ADR-0082 removal persists through the encrypted store ==");
const dir = mkdtempSync(join(tmpdir(), "demo-pkgrel3-"));
try {
  const path = join(dir, "p.enc");
  const s = PersonalStore.createWithPassphrase(path, "correct horse battery staple");
  const a = s.upsertEntity("Rust", "user:preference", "trusted");
  const b = s.upsertEntity("Kubernetes", "user:skill", "trusted");
  s.addFact({ entityId: a, statement: "likes Rust", trustLabel: "trusted" });
  s.addFact({ entityId: b, statement: "uses Kubernetes", trustLabel: "trusted" });
  s.addLink(a, b, "related");
  s.addLink(a, b, "deploys with");
  const removed = s.removeLink(a, b, "related"); // exactly what unrelateEntities does
  if (removed !== 1) fail(`expected to remove 1 link, removed ${removed}`);
  s.save();

  const links = PersonalStore.openWithPassphrase(path, "correct horse battery staple").graph().links;
  if (links.length !== 1 || links[0]!.relation !== "deploys with") fail("the wrong link survived (or removal didn't persist)");
  ok('removeLink deleted a→b "related" and persisted; a→b "deploys with" survived');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log("demo-P-KG-REL.3 OK");
process.exit(0);
