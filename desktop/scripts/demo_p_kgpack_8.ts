// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-KGPACK.8: real zip export/import through the scanner, bounded metadata visualization,
// and full compiled retrieval outside the snapshot without replacing the existing KG.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { retrieveKnowledge } from "../../harness/kb/retrieve.ts";
import { exportKgPack, importPackFromPath } from "../kb_pack.ts";
import { activeKgId, createKg, kbScanner, kbStore, listKgs, setActiveKg, stopKb } from "../kb_store.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

const dir = mkdtempSync(join(tmpdir(), "kgpack8-"));
const keys = ["LUCID_KB_DB_PATH", "LUCID_KG_REGISTRY_PATH", "LUCID_SKILL_SCAN_PATH", "LUCID_KG_PACK_SIGNING_KEY"] as const;
const previous = keys.map((key) => process.env[key]);

try {
  await stopKb();
  process.env.LUCID_KB_DB_PATH = join(dir, "kb_graph.duckdb");
  process.env.LUCID_KG_REGISTRY_PATH = join(dir, "kg_registry.json");
  process.env.LUCID_SKILL_SCAN_PATH = join(dir, "scans.jsonl");
  delete process.env.LUCID_KG_PACK_SIGNING_KEY;

  console.log("== [1/4] preserve an existing KG and author a dense pack ==");
  const oldStore = await kbStore();
  const oldId = activeKgId();
  assert(oldId, "default KG has an identity");
  const oldPageId = await oldStore.addPage({ kind: "concept", slug: "existing", title: "Existing knowledge", bodyMd: "Existing user knowledge stays intact.", trustLabel: "untrusted", classification: "U" });
  const oldPage = await oldStore.getPage(oldPageId);
  assert(oldPage, "existing page can be read");

  const source = createKg({ name: "Bounded graph pack" });
  const author = await kbStore(source.kg_id);
  const ids: string[] = [];
  const pageCount = 125;
  for (let i = 0; i < pageCount; i++) {
    ids.push(await author.addPage({ kind: "concept", slug: `concept-${i}`, title: `Concept ${i}`, bodyMd: `Reference knowledge for lookupmarker${i}. Full page body ${i}.`, trustLabel: "untrusted", classification: "U" }));
  }
  const hub = ids[pageCount - 1]!;
  for (const id of ids.slice(0, -1)) await author.addLink({ fromPageId: hub, toPageId: id, relation: "mentions" });
  for (let i = 0; i < 21; i++) {
    for (let j = i + 1; j < 21; j++) await author.addLink({ fromPageId: ids[i]!, toPageId: ids[j]!, relation: "related" });
  }
  const linkCount = pageCount - 1 + 21 * 20 / 2;
  setActiveKg(oldId);
  const exported = await exportKgPack(source.kg_id, join(dir, "out"), { createdAt: "2026-09-06T00:00:00.000Z" });
  assert(exported.ok && exported.zipPath && !exported.signed && exported.pages === pageCount, `unsigned complete zip export: ${JSON.stringify(exported)}`);

  console.log("== [2/4] import the zip through the actual ScannerClient ==");
  const beforeImport = listKgs().length;
  const imported = await importPackFromPath(exported.zipPath, { scanner: kbScanner(), trusted: [] });
  assert(imported.ok && imported.stage === "ok" && imported.kgId && !imported.signed && imported.pages === pageCount, `real scanner import: ${JSON.stringify(imported)}`);
  assert(imported.findings === 0, "every imported body passed the real scanner without findings");
  const installed = listKgs().find((kg) => kg.kg_id === imported.kgId);
  assert(installed?.read_only && installed.source_kind === "pack", "installed KG is a read-only pack");
  assert(listKgs().length === beforeImport + 1 && imported.kgId !== source.kg_id && imported.kgId !== oldId, "import adds a new KG identity");
  const store = await kbStore(imported.kgId);
  const pages = await store.listPages();
  assert(pages.length === pageCount && pages.every((page) => page.trust_label === "untrusted"), "all imported pages retain untrusted labels");

  console.log("== [3/4] visualize bounded metadata and retrieve an omitted full page ==");
  const snapshot = await store.graphSnapshot();
  assert(snapshot.pages.length === 100 && snapshot.links.length === 200, "dense graph is capped at 100 nodes and 200 links");
  assert(snapshot.totalPages === pageCount && snapshot.totalLinks === linkCount, "snapshot reports complete graph totals");
  assert(snapshot.pages.every((page) => !Object.hasOwn(page, "body_md")), "snapshot transports no page bodies");
  const selected = new Set(snapshot.pages.map((page) => page.page_id));
  assert(snapshot.links.every((link) => selected.has(link.from_page_id) && selected.has(link.to_page_id)), "all drawn links are internal to selected nodes");
  // JSON.stringify is ALSO the serializability proof: raw TIMESTAMP values carry bigint micros and
  // would throw here. The snapshot must stringify clean without dev.ts's bigint replacer.
  assert(JSON.stringify(await store.graphSnapshot()) === JSON.stringify(snapshot), "unchanged graph yields a deterministic, JSON-serializable snapshot");
  const omitted = pages.find((page) => !selected.has(page.page_id));
  assert(omitted, "full store contains pages outside the drawn snapshot");
  assert((await store.getPage(omitted.page_id))?.body_md === omitted.body_md, "omitted full page remains readable by explicit imported KG identity");
  const index = ids.indexOf(omitted.page_id);
  assert(index >= 0, "import preserves original page identity");
  const retrieved = await retrieveKnowledge({ query: `lookupmarker${index}`, mode: "compiled", k: 1, compiled: { store } });
  assert(retrieved.items.length === 1 && retrieved.items[0]?.citation === `page:${omitted.slug}` && retrieved.items[0]?.text === omitted.body_md && retrieved.items[0]?.trustLabel === "untrusted", "compiled retrieval returns the complete omitted page with its trust label");
  assert((await store.listLinks()).length === linkCount, "full edge access is unaffected by visualization limits");
  assert(await store.getPage("missing-page") === undefined, "unknown page remains absent");
  console.log(`   imported ${pageCount} pages/${linkCount} links; drew ${snapshot.pages.length}/${snapshot.links.length}; retrieved ${omitted.slug}`);

  console.log("== [4/4] verify old KG and reopen the imported KG without restart ==");
  assert(listKgs().some((kg) => kg.kg_id === oldId), "existing KG remains registered");
  assert(activeKgId() === oldId, "pack import does not silently replace the active KG");
  const oldAfter = await (await kbStore(oldId)).getPage(oldPageId);
  assert(oldAfter?.body_md === oldPage.body_md && oldAfter.title === oldPage.title && oldAfter.trust_label === oldPage.trust_label, "existing knowledge remains unchanged");
  setActiveKg(imported.kgId);
  assert((await (await kbStore()).graphSnapshot()).totalPages === pageCount, "new KG is immediately selectable without restarting");
  setActiveKg(oldId);
  assert(await (await kbStore()).pageCount() === 1, "switching back restores the old graph");
  assert((await (await kbStore(imported.kgId)).getPage(omitted.page_id))?.body_md === omitted.body_md, "explicit page lookup stays attached to imported KG after active selection changes");
  console.log("== demo-P-KGPACK.8 OK ==");
} finally {
  try { await stopKb(); }
  finally {
    for (let i = 0; i < keys.length; i++) {
      if (previous[i] === undefined) delete process.env[keys[i]!];
      else process.env[keys[i]!] = previous[i]!;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}
