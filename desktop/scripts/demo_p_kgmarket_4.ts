// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_kgmarket_4.ts — P-KGMARKET.4 (ADR-0206): the download -> unzip -> gated-install path.
//
// Proves against real DuckDB files + the REAL Unicode scanner that a purchased pack, delivered as a signed
// URL to a single `.lkgpack.zip`, installs through the SAME gate as a local import:
//   1. a KG exports to a `.lkgpack.zip`; installPackFromUrl (fed the file as if downloaded) verifies +
//      re-scans + installs it READ-ONLY, pages intact;
//   2. a pack whose page carries a Trojan-Source override is BLOCKED at the re-scan (nothing installs).
// A purchase grants ACCESS; the signature + scanner still prove origin + safety.

import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportKgPack, installPackFromUrl } from "../kb_pack.ts";
import { kbStore, createKg, listKgs, stopKb, _resetKbStoreForTest } from "../kb_store.ts";

function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(`ASSERT FAILED: ${msg}`); }

const dir = mkdtempSync(join(tmpdir(), "kgmarket4-"));
process.env.LUCID_KB_DB_PATH = join(dir, "kb_graph.duckdb");
process.env.LUCID_KG_REGISTRY_PATH = join(dir, "kg_registry.json");
process.env.LUCID_SKILL_SCAN_PATH = join(dir, "scans.jsonl");

const AT = "2026-07-10T00:00:00.000Z";
const POISON = "This page hides a Trojan-Source override Miti\u202egate\u200b in its body.";

// Simulate the entitlement backend's signed download: hand back the local .lkgpack.zip bytes.
const fetchFromFile = (zipPath: string): typeof fetch =>
  (async () => { const b = readFileSync(zipPath); return { ok: true, status: 200, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }; }) as unknown as typeof fetch;

async function seed(name: string, bodies: string[]): Promise<string> {
  const kg = createKg({ name });
  const store = await kbStore(kg.kg_id);
  for (let i = 0; i < bodies.length; i++) await store.addPage({ kind: "concept", slug: `p-${i}`, title: `P${i}`, bodyMd: bodies[i]!, trustLabel: "untrusted", classification: "U" });
  return kg.kg_id;
}

try {
  _resetKbStoreForTest();

  console.log("== [1/2] a purchased pack: export -> .lkgpack.zip -> download -> gated install (real scanner) ==");
  const srcKg = await seed("GovCon Contracts Officer", ["FAR Part 15 negotiated procurement.", "CPARS performance reporting."]);
  const exp = await exportKgPack(srcKg, join(dir, "out"), { author: "TechLead 187 LLC", version: "1.0.0", createdAt: AT });
  assert(exp.ok && exp.zipPath, `export produced a .lkgpack.zip (got ${JSON.stringify(exp)})`);
  const r = await installPackFromUrl("https://signed.example/govcon.lkgpack.zip", { fetchImpl: fetchFromFile(exp.zipPath!) });
  assert(r.ok && r.stage === "ok" && r.pages === 2, `installed (got ${JSON.stringify(r)})`);
  const installed = listKgs().find((k) => k.kg_id === r.kgId)!;
  assert(installed.read_only && installed.source_kind === "pack", "installed read-only as a pack");
  assert((await (await kbStore(r.kgId!)).pageCount()) === 2, "the db came across (2 pages)");
  console.log(`   downloaded + installed "${r.kgName}" · ${r.pages} pages · read-only · ${r.signed ? "signed" : "unsigned"}`);

  console.log("== [2/2] a Trojan-Source pack is BLOCKED at the re-scan (nothing installs) ==");
  const evilKg = await seed("Poisoned Pack", ["A perfectly clean page.", POISON]);
  const exp2 = await exportKgPack(evilKg, join(dir, "out2"), { createdAt: AT });
  const before = listKgs().length;
  const blocked = await installPackFromUrl("https://signed.example/evil.lkgpack.zip", { fetchImpl: fetchFromFile(exp2.zipPath!) });
  assert(!blocked.ok && blocked.stage === "scan" && listKgs().length === before, `poisoned pack blocked at scan (got ${JSON.stringify(blocked)})`);
  console.log(`   blocked at re-scan: ${blocked.error}; nothing installed (fail-closed) - a purchase grants access, not trust`);

  console.log("== demo-P-KGMARKET.4 OK ==");
} finally {
  await stopKb();
  delete process.env.LUCID_KB_DB_PATH;
  delete process.env.LUCID_KG_REGISTRY_PATH;
  rmSync(dir, { recursive: true, force: true });
}
