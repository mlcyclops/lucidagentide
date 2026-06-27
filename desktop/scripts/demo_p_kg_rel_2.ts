// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_kg_rel_2.ts
//
// Increment P-KG-REL.2 — custom relation labels for manual relate (issue #122, ADR-0078). P-KG-REL.1
// always used "related"; now the Relate bar has an optional label input. Proof:
//   A. resolveRelationLabel: the UI default — a typed label wins, blank falls back to "related".
//   B. a custom label round-trips through the encrypted store (what the UI feeds via relateEntities).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PersonalStore } from "../../harness/personal/store.ts";
import { randomKey } from "../../harness/personal/crypto.ts";
import { resolveRelationLabel } from "../renderer/kg_ops.ts";

const fail = (msg: string): never => { console.error(`FAIL: ${msg}`); process.exit(1); };
const ok = (msg: string): void => console.log(`   ${msg} ✓`);

console.log("== [1/2] #122 label resolution (typed wins, blank → 'related') ==");
if (resolveRelationLabel("deploys with") !== "deploys with") fail("a typed label must be used verbatim");
if (resolveRelationLabel("  used for ") !== "used for") fail("label should be trimmed");
if (resolveRelationLabel("") !== "related" || resolveRelationLabel(null) !== "related") fail("blank must default to 'related'");
ok('typed labels are used (trimmed); blank/whitespace default to "related"');

console.log("== [2/2] #122 a custom label round-trips through the encrypted store ==");
const dir = mkdtempSync(join(tmpdir(), "demo-pkgrel2-"));
try {
  const path = join(dir, "p.enc");
  const s = PersonalStore.createWithPassphrase(path, "correct horse battery staple");
  const a = s.upsertEntity("Rust", "user:preference", "trusted");
  const b = s.upsertEntity("Kubernetes", "user:skill", "trusted");
  s.addFact({ entityId: a, statement: "likes Rust", trustLabel: "trusted" });
  s.addFact({ entityId: b, statement: "uses Kubernetes", trustLabel: "trusted" });
  s.addLink(a, b, resolveRelationLabel("deploys with")); // exactly what the UI feeds
  s.save();

  const link = PersonalStore.openWithPassphrase(path, "correct horse battery staple").graph().links.find((l) => l.from_entity_id === a && l.to_entity_id === b);
  if (!link) fail("the authored edge did not persist");
  if (link!.relation !== "deploys with") fail(`relation should be "deploys with", got ${link!.relation}`);
  ok('a→b "deploys with" persisted across reopen (custom label, not the "related" default)');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log("demo-P-KG-REL.2 OK");
process.exit(0);
