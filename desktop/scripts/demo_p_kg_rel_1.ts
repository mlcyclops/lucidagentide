// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_kg_rel_1.ts
//
// Increment P-KG-REL.1 — manual relationship authoring (issue #109, ADR-0075). The graph was read-only;
// now the user can assert their own relationships (drag a node onto another, or multi-select + Relate).
// Two proofs:
//   A. STORE: a user-authored edge lands in the encrypted graph, persists across reopen, and carries NO
//      trust label (it's first-party — it never passes the scanner as instructions).
//   B. INTERACTION: the pure cores the renderer wires to — hit-testing the drop target, the ordered
//      multi-select pick set, chaining picks into pairs, and the optimistic (rollback-safe) edge add.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PersonalStore } from "../../harness/personal/store.ts";
import type { PersonalGraphData } from "../renderer/bridge.ts";
import { addEdgeOptimistic, chainPairs, nodeAtPoint, togglePick } from "../renderer/kg_ops.ts";

const fail = (msg: string): never => { console.error(`FAIL: ${msg}`); process.exit(1); };
const ok = (msg: string): void => console.log(`   ${msg} ✓`);

// ── A. the authored edge lands in the store + persists ───────────────────────
console.log("== [1/2] #109 a user-authored edge lands in the encrypted graph ==");
const dir = mkdtempSync(join(tmpdir(), "demo-pkgrel-"));
const path = join(dir, "personal.json");
try {
  const s = PersonalStore.createWithPassphrase(path, "correct horse battery staple");
  const a = s.upsertEntity("Rust", "user:preference", "trusted");
  const b = s.upsertEntity("Vim", "user:behavior", "trusted");
  s.addFact({ entityId: a, statement: "likes Rust", trustLabel: "trusted" });
  s.addFact({ entityId: b, statement: "uses Vim", trustLabel: "trusted" });
  const linkId = s.addLink(a, b, "related"); // <- exactly what relateEntities() does
  if (!linkId) fail("addLink returned no id");
  s.save();

  const reopened = PersonalStore.openWithPassphrase(path, "correct horse battery staple").graph();
  const link = reopened.links.find((l) => l.from_entity_id === a && l.to_entity_id === b);
  if (!link) fail("the authored edge did not persist");
  if (link!.relation !== "related") fail(`relation should be "related", got ${link!.relation}`);
  if ("trust_label" in (link as object)) fail("a link must NOT carry a trust label (first-party, not scanner-graded)");
  ok('authored edge a→b "related" persisted across reopen; links carry no trust label (first-party)');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// ── B. the interaction cores ─────────────────────────────────────────────────
console.log("== [2/2] #109 drag-to-relate + multi-select interaction logic ==");
const hit = [{ id: "a", x: 0, y: 0, r: 10 }, { id: "b", x: 100, y: 0, r: 8 }];
if (nodeAtPoint(hit, 2, 2) !== "a") fail("drop target hit-test failed");
if (nodeAtPoint(hit, 2, 2, "a") !== null) fail("a node must not be relatable to itself");
if (nodeAtPoint(hit, 50, 0) !== null) fail("empty space should hit nothing");
ok("drag-to-relate drop target hit-tested (and self-relate blocked)");

let picks: string[] = [];
for (const id of ["a", "b", "c", "b"]) picks = togglePick(picks, id); // b toggled off
if (JSON.stringify(picks) !== JSON.stringify(["a", "c"])) fail(`pick set wrong: ${JSON.stringify(picks)}`);
const pairs = chainPairs(["a", "b", "c"]);
if (JSON.stringify(pairs) !== JSON.stringify([["a", "b"], ["b", "c"]])) fail("chain pairing wrong");
ok("multi-select picks toggle in order; chained A,B,C → A→B, B→C");

const data: PersonalGraphData = { nodes: [], edges: [{ from: "a", to: "b", relation: "related" }], facts: [] };
const added = addEdgeOptimistic(data, "b", "c", "related");
if (added.edges.length !== 2 || data.edges.length !== 1) fail("optimistic add must not mutate the input");
if (addEdgeOptimistic(data, "a", "b", "related") !== data) fail("identical edge must dedup to a no-op");
ok("optimistic edge add is instant, dedups, and rollback-safe (input untouched)");

console.log("demo-P-KG-REL.1 OK");
process.exit(0);
