// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_kgpack_3.ts — P-KGPACK.3 (ADR-0205): seed a named KG from a folder, gated.
//
// Proves end-to-end against real DuckDB files + the REAL Unicode scanner (the compile MODEL is injected, as
// in the route):
//   1. an Obsidian markdown vault → one document per note, batch-compiled into a NAMED KG; a note carrying a
//      Trojan-Source override is QUARANTINED (never compiled) while the clean notes still compile;
//   2. a ChatGPT/Claude export → one document per conversation, compiled into a DIFFERENT named KG;
//   3. the two KGs are ISOLATED files and the default "My Knowledge" KG is untouched.

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestSourcesIntoKg } from "../../harness/kb/batch_ingest.ts";
import { readKbSources } from "../kb_sources.ts";
import { kbScanner, kbStore, createKg, listKgs, stopKb, _resetKbStoreForTest } from "../kb_store.ts";

function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(`ASSERT FAILED: ${msg}`); }

const dir = mkdtempSync(join(tmpdir(), "kgpack3-"));
process.env.LUCID_KB_DB_PATH = join(dir, "kb_graph.duckdb");
process.env.LUCID_KG_REGISTRY_PATH = join(dir, "kg_registry.json");
process.env.LUCID_SKILL_SCAN_PATH = join(dir, "scans.jsonl");

// Injected compile model (two clean pages + a link per document) — the real one is backend.complete.
const model = async (): Promise<string> => JSON.stringify({
  pages: [
    { kind: "summary", slug: "summary", title: "Summary", body_md: "The note becomes a graph of pages." },
    { kind: "concept", slug: "concept", title: "Concept", body_md: "A concept synthesized from the note." },
  ],
  links: [{ from: "summary", to: "concept", relation: "explains" }],
});
const POISON = "This note hides a Trojan-Source override Miti\u202egate\u200b in its body.";

try {
  _resetKbStoreForTest();

  console.log("== [1/3] an Obsidian vault seeds a named KG; a poisoned note is quarantined ==");
  const vault = join(dir, "vault"); mkdirSync(join(vault, "sub"), { recursive: true });
  writeFileSync(join(vault, "Deploys.md"), "# Deploys\nHow releases ship through CI.");
  writeFileSync(join(vault, "sub", "Runbook.md"), "# Runbook\nOn-call steps for an incident.");
  writeFileSync(join(vault, "Tainted.md"), POISON);
  const vaultSrc = readKbSources(vault);
  assert(vaultSrc.ok && vaultSrc.scan.kind === "obsidian" && vaultSrc.scan.docs.length === 3, "vault read as 3 markdown docs");
  if (!vaultSrc.ok) throw new Error("unreachable");

  const notesKg = createKg({ name: "Obsidian Notes", sourceKind: "obsidian" });
  const vaultRes = await ingestSourcesIntoKg({ store: await kbStore(notesKg.kg_id), scanner: kbScanner(), complete: model, docs: vaultSrc.scan.docs });
  assert(vaultRes.documents === 3, "all 3 docs attempted");
  assert(vaultRes.documentsQuarantined === 1, `exactly the poisoned note quarantined (got ${vaultRes.documentsQuarantined})`);
  assert(vaultRes.pagesCompiled === 4, `2 clean notes → 4 pages (got ${vaultRes.pagesCompiled})`);
  console.log(`   "Obsidian Notes": ${vaultRes.pagesCompiled} pages from ${vaultRes.documents - vaultRes.documentsQuarantined} clean notes · ${vaultRes.documentsQuarantined} quarantined (fail-closed)`);

  console.log("== [2/3] a chat export seeds a DIFFERENT named KG ==");
  const chat = join(dir, "chat"); mkdirSync(chat, { recursive: true });
  writeFileSync(join(chat, "conversations.json"), JSON.stringify([
    { name: "Kickoff", chat_messages: [{ sender: "human", text: "How do we scope the migration?" }, { sender: "assistant", text: "Start with an inventory." }] },
    { name: "Retro", chat_messages: [{ sender: "human", text: "What went well?" }] },
  ]));
  const chatSrc = readKbSources(chat);
  assert(chatSrc.ok && chatSrc.scan.kind === "chat" && chatSrc.scan.vendor === "anthropic", "chat export detected (anthropic)");
  if (!chatSrc.ok) throw new Error("unreachable");
  const roleKg = createKg({ name: "Migration Lead", sourceKind: "chat" });
  const chatRes = await ingestSourcesIntoKg({ store: await kbStore(roleKg.kg_id), scanner: kbScanner(), complete: model, docs: chatSrc.scan.docs });
  assert(chatRes.documents === 2 && chatRes.pagesCompiled === 4, `2 conversations → 4 pages (got ${chatRes.pagesCompiled})`);
  console.log(`   "Migration Lead": ${chatRes.pagesCompiled} pages from ${chatRes.documents} conversations`);

  console.log("== [3/3] the KGs are isolated; the default KG is untouched ==");
  const notesN = await (await kbStore(notesKg.kg_id)).pageCount();
  const roleN = await (await kbStore(roleKg.kg_id)).pageCount();
  const defaultN = await (await kbStore()).pageCount();
  assert(notesN === 4 && roleN === 4 && defaultN === 0, `isolation: notes=${notesN} role=${roleN} default=${defaultN}`);
  assert(listKgs().length === 3, "registry holds default + the two seeded KGs");
  console.log(`   pages -> Obsidian Notes: ${notesN} · Migration Lead: ${roleN} · My Knowledge: ${defaultN} (isolated)`);

  console.log("== demo-P-KGPACK.3 OK ==");
} finally {
  await stopKb();
  delete process.env.LUCID_KB_DB_PATH;
  delete process.env.LUCID_KG_REGISTRY_PATH;
  rmSync(dir, { recursive: true, force: true });
}
