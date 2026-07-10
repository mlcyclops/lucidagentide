// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_kgpack_4.ts — P-KGPACK.4 (ADR-0205): .lkgpack author + gated import, end to end.
//
// Proves against real DuckDB files + the REAL Unicode scanner + REAL Ed25519 signing:
//   1. a KG exports to a signed .lkgpack and imports back as a READ-ONLY, untrusted KG with pages intact;
//   2. a TAMPERED pack db is refused at the integrity stage (nothing installs);
//   3. a pack carrying a Trojan-Source page is BLOCKED by the re-scan (fail-closed, nothing installs);
//   4. a signed pack verifies against the trusted key but is refused when no trusted key matches (origin).

import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { LKGPACK_DB_FILE } from "../../harness/kb/pack.ts";
import { exportKgPack, importKgPack } from "../kb_pack.ts";
import { kbStore, createKg, listKgs, stopKb, _resetKbStoreForTest } from "../kb_store.ts";

function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(`ASSERT FAILED: ${msg}`); }

const dir = mkdtempSync(join(tmpdir(), "kgpack4-"));
process.env.LUCID_KB_DB_PATH = join(dir, "kb_graph.duckdb");
process.env.LUCID_KG_REGISTRY_PATH = join(dir, "kg_registry.json");
process.env.LUCID_SKILL_SCAN_PATH = join(dir, "scans.jsonl");

const AT = "2026-07-10T00:00:00.000Z";
const kp = generateKeyPairSync("ed25519");
const other = generateKeyPairSync("ed25519");
const sign = (c: Buffer) => ({ signature: edSign(null, c, kp.privateKey).toString("base64"), keyId: "techlead187" });
const trusted = [{ id: "techlead187", key: kp.publicKey }];

async function seed(name: string, bodies: string[]): Promise<string> {
  const kg = createKg({ name });
  const store = await kbStore(kg.kg_id);
  for (let i = 0; i < bodies.length; i++) await store.addPage({ kind: "concept", slug: `p-${i}`, title: `P${i}`, bodyMd: bodies[i]!, trustLabel: "untrusted", classification: "U" });
  return kg.kg_id;
}

try {
  _resetKbStoreForTest();

  console.log("== [1/4] export a signed pack, then import it (real scanner) ==");
  const srcKg = await seed("GovCon Contracts Officer", ["FAR Part 15 negotiated procurement.", "CPARS performance reporting."]);
  const exp = await exportKgPack(srcKg, join(dir, "out"), { author: "TechLead 187 LLC", version: "1.0.0", role: "Contracts Officer", createdAt: AT, sign });
  assert(exp.ok && exp.signed && exp.pages === 2, `signed export of 2 pages (got ${JSON.stringify(exp)})`);
  const imp = await importKgPack(exp.path!, { trusted });
  assert(imp.ok && imp.stage === "ok" && imp.signed && imp.pages === 2, `signed import ok (got ${JSON.stringify(imp)})`);
  const installed = listKgs().find((k) => k.kg_id === imp.kgId)!;
  assert(installed.read_only && installed.source_kind === "pack", "installed read-only as a pack");
  assert((await (await kbStore(imp.kgId!)).pageCount()) === 2, "the db came across (2 pages)");
  console.log(`   "${imp.kgName}" installed read-only · signed by ${imp.keyId} · ${imp.pages} pages`);

  console.log("== [2/4] a TAMPERED pack db is refused at integrity ==");
  const exp2 = await exportKgPack(srcKg, join(dir, "out2"), { createdAt: AT });
  const dbFile = join(exp2.path!, LKGPACK_DB_FILE);
  const buf = readFileSync(dbFile); buf[Math.floor(buf.length / 2)] ^= 0xff; writeFileSync(dbFile, buf);
  const before = listKgs().length;
  const bad = await importKgPack(exp2.path!, { trusted });
  assert(!bad.ok && bad.stage === "integrity" && listKgs().length === before, `tamper refused at integrity (got ${JSON.stringify(bad)})`);
  console.log(`   refused: ${bad.error}; nothing installed`);

  console.log("== [3/4] a pack with a Trojan-Source page is BLOCKED by the re-scan ==");
  const evilKg = await seed("Poisoned Pack", ["A perfectly clean page.", "Hidden override Miti\u202egate\u200b in this body."]);
  const exp3 = await exportKgPack(evilKg, join(dir, "out3"), { createdAt: AT });
  const before3 = listKgs().length;
  const blocked = await importKgPack(exp3.path!, { trusted });
  assert(!blocked.ok && blocked.stage === "scan" && listKgs().length === before3, `poisoned pack blocked at scan (got ${JSON.stringify(blocked)})`);
  console.log(`   blocked at re-scan: ${blocked.error}; nothing installed (fail-closed)`);

  console.log("== [4/4] a signed pack is refused when no trusted key matches (origin) ==");
  const wrong = await importKgPack(exp.path!, { trusted: [{ id: "someone-else", key: other.publicKey }] });
  assert(!wrong.ok && wrong.stage === "signature", `untrusted-key signed pack refused (got ${JSON.stringify(wrong)})`);
  console.log(`   refused: ${wrong.error}`);

  console.log("== demo-P-KGPACK.4 OK ==");
} finally {
  await stopKb();
  delete process.env.LUCID_KB_DB_PATH;
  delete process.env.LUCID_KG_REGISTRY_PATH;
  rmSync(dir, { recursive: true, force: true });
}
