// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_kgpack_1.ts — P-KGPACK.1 (ADR-0205): named, swappable KGs, file-per-KG.
//
// Proves end-to-end against real DuckDB files + a real JSON registry:
//   1. today's combined kb_graph.duckdb is ADOPTED as the default "My Knowledge" KG (zero data loss),
//   2. new KGs are ISOLATED files (a page in one is invisible from another),
//   3. rename touches only the label, and switching the active KG re-points a no-arg store lookup.
// No scanner needed — this increment is the registry + resolver; ingest gating is a later increment.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KbGraphStore } from "../../harness/kb/store.ts";
import {
  _resetKbStoreForTest, kbStore, stopKb,
  listKgs, activeKgId, createKg, renameKg, setActiveKg,
} from "../kb_store.ts";

function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(`ASSERT FAILED: ${msg}`); }

const dir = mkdtempSync(join(tmpdir(), "kgpack1-"));
process.env.LUCID_KB_DB_PATH = join(dir, "kb_graph.duckdb");
process.env.LUCID_KG_REGISTRY_PATH = join(dir, "kg_registry.json");

try {
  console.log("== [1/4] seed a pre-existing combined KB, then adopt it as the default KG ==");
  const legacy = await KbGraphStore.open(join(dir, "kb_graph.duckdb"));
  await legacy.addPage({ kind: "summary", slug: "legacy", title: "Legacy", bodyMd: "carried forward", trustLabel: "untrusted", classification: "U" });
  legacy.close();
  _resetKbStoreForTest();

  const dflt = await kbStore(); // active default resolves to that same file
  assert((await dflt.pageCount()) === 1, "default KG adopted the pre-existing page");
  assert(listKgs().length === 1 && listKgs()[0]!.name === "My Knowledge", "default 'My Knowledge' auto-registered");
  console.log(`   default KG "${listKgs()[0]!.name}" adopted ${listKgs()[0]!.db_path} (1 page carried forward)`);

  console.log("== [2/4] create two role KGs — each its own file ==");
  const be = createKg({ name: "Backend Engineer" });
  const ds = createKg({ name: "Data Scientist" });
  assert(listKgs().length === 3, "three KGs registered");
  assert(be.db_path !== ds.db_path, "each KG is a distinct file");
  console.log(`   ${be.name} -> ${be.db_path}`);
  console.log(`   ${ds.name} -> ${ds.db_path}`);

  console.log("== [3/4] write into each; prove isolation ==");
  await (await kbStore(be.kg_id)).addPage({ kind: "concept", slug: "api", title: "API design", bodyMd: "x", trustLabel: "untrusted", classification: "U" });
  const dsStore = await kbStore(ds.kg_id);
  await dsStore.addPage({ kind: "concept", slug: "ml", title: "ML", bodyMd: "y", trustLabel: "untrusted", classification: "U" });
  await dsStore.addPage({ kind: "entity", slug: "pandas", title: "pandas", bodyMd: "z", trustLabel: "untrusted", classification: "U" });

  const beN = await (await kbStore(be.kg_id)).pageCount();
  const dsN = await (await kbStore(ds.kg_id)).pageCount();
  const dfN = await (await kbStore()).pageCount();
  assert(beN === 1, `Backend Engineer isolated to its 1 page (got ${beN})`);
  assert(dsN === 2, `Data Scientist isolated to its 2 pages (got ${dsN})`);
  assert(dfN === 1, `default KG untouched at 1 page (got ${dfN})`);
  console.log(`   pages -> Backend Engineer: ${beN} · Data Scientist: ${dsN} · My Knowledge: ${dfN} (isolated)`);

  console.log("== [4/4] rename + switch the active KG ==");
  const renamed = renameKg(be.kg_id, "Senior Backend Engineer");
  assert(renamed.kg_id === be.kg_id && renamed.db_path === be.db_path, "rename kept id + file");
  assert(listKgs().find((k) => k.kg_id === be.kg_id)!.name === "Senior Backend Engineer", "label updated");

  setActiveKg(ds.kg_id);
  assert(activeKgId() === ds.kg_id, "active pointer moved to Data Scientist");
  assert((await (await kbStore()).pageCount()) === 2, "no-arg store now resolves to Data Scientist");
  console.log(`   renamed BE -> "${renamed.name}"; active KG is now "${ds.name}" (no-arg lookup sees its 2 pages)`);

  console.log("== demo-P-KGPACK.1 OK ==");
} finally {
  await stopKb();
  delete process.env.LUCID_KB_DB_PATH;
  delete process.env.LUCID_KG_REGISTRY_PATH;
  rmSync(dir, { recursive: true, force: true });
}
