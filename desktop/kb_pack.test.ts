// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/kb_pack.test.ts — P-KGPACK.4 (ADR-0205): export → gated import round-trip. Pins: a KG exports to a
// .lkgpack and imports back as a READ-ONLY, untrusted KG with its pages intact; a tampered db is refused at
// integrity; a poisoned page blocks the WHOLE import (nothing registered); a dead scanner fails closed; and
// a signed pack verifies only against a trusted key. The scanner is injected (fast, deterministic).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import type { GateDecision } from "../harness/security/gate.ts";
import { LKGPACK_DB_FILE } from "../harness/kb/pack.ts";
import { exportKgPack, importKgPack } from "./kb_pack.ts";
import { _resetKbStoreForTest, kbStore, createKg, listKgs, stopKb } from "./kb_store.ts";

const CLEAN: GateDecision = { block: false, reason: "clean", trustLabel: "trusted", findings: [], failClosed: false };
const cleanDecide = async (): Promise<GateDecision> => CLEAN;
const poisonDecide = async (t: string): Promise<GateDecision> => (/POISON/.test(t)
  ? { block: true, reason: "zero-width", trustLabel: "quarantined", findings: [{}], failClosed: false } as unknown as GateDecision
  : CLEAN);
const deadDecide = async (): Promise<GateDecision> => { throw new Error("sidecar dead"); };

const AT = "2026-07-10T00:00:00.000Z";

async function seedKg(name: string, bodies: string[]): Promise<string> {
  const kg = createKg({ name });
  const store = await kbStore(kg.kg_id);
  for (let i = 0; i < bodies.length; i++) await store.addPage({ kind: "concept", slug: `p-${i}`, title: `P${i}`, bodyMd: bodies[i]!, trustLabel: "untrusted", classification: "U" });
  return kg.kg_id;
}

describe("kb_pack — export → gated import", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "kb-pack-")); process.env.LUCID_KB_DB_PATH = join(dir, "kb_graph.duckdb"); process.env.LUCID_KG_REGISTRY_PATH = join(dir, "kg_registry.json"); _resetKbStoreForTest(); });
  afterEach(async () => { await stopKb(); delete process.env.LUCID_KB_DB_PATH; delete process.env.LUCID_KG_REGISTRY_PATH; rmSync(dir, { recursive: true, force: true }); });

  test("a KG round-trips: export → import as a read-only, untrusted KG with its pages intact", async () => {
    const kgId = await seedKg("Source KG", ["alpha page", "beta page"]);
    const exp = await exportKgPack(kgId, join(dir, "out"), { author: "TechLead 187 LLC", version: "1.0.0", createdAt: AT });
    expect(exp.ok).toBe(true);
    expect(exp.signed).toBe(false);
    expect(exp.pages).toBe(2);

    const before = listKgs().length;
    const imp = await importKgPack(exp.path!, { decide: cleanDecide, trusted: [] });
    expect(imp.ok).toBe(true);
    expect(imp.stage).toBe("ok");
    expect(imp.pages).toBe(2);
    expect(listKgs().length).toBe(before + 1);
    const installed = listKgs().find((k) => k.kg_id === imp.kgId)!;
    expect(installed.read_only).toBe(true);       // packs install read-only
    expect(installed.source_kind).toBe("pack");
    expect(await (await kbStore(imp.kgId!)).pageCount()).toBe(2); // the db came across
  });

  test("a tampered db is refused at the integrity stage", async () => {
    const kgId = await seedKg("Source KG", ["alpha"]);
    const exp = await exportKgPack(kgId, join(dir, "out"), { createdAt: AT });
    const dbFile = join(exp.path!, LKGPACK_DB_FILE);
    const buf = readFileSync(dbFile); buf[Math.floor(buf.length / 2)] ^= 0xff; writeFileSync(dbFile, buf); // flip a byte
    const before = listKgs().length;
    const imp = await importKgPack(exp.path!, { decide: cleanDecide, trusted: [] });
    expect(imp.ok).toBe(false);
    expect(imp.stage).toBe("integrity");
    expect(listKgs().length).toBe(before); // nothing registered
  });

  test("a poisoned page blocks the WHOLE import (nothing registered)", async () => {
    const kgId = await seedKg("Source KG", ["clean page", "hides POISON here"]);
    const exp = await exportKgPack(kgId, join(dir, "out"), { createdAt: AT });
    const before = listKgs().length;
    const blocks: unknown[] = [];
    const imp = await importKgPack(exp.path!, { decide: poisonDecide, trusted: [], record: (b) => blocks.push(b) });
    expect(imp.ok).toBe(false);
    expect(imp.stage).toBe("scan");
    expect(blocks).toHaveLength(1);
    expect(listKgs().length).toBe(before);
  });

  test("a dead scanner fails closed (no install)", async () => {
    const kgId = await seedKg("Source KG", ["alpha"]);
    const exp = await exportKgPack(kgId, join(dir, "out"), { createdAt: AT });
    const imp = await importKgPack(exp.path!, { decide: deadDecide, trusted: [] });
    expect(imp.ok).toBe(false);
    expect(imp.stage).toBe("scan");
  });

  test("a signed pack verifies only against a trusted key", async () => {
    const kp = generateKeyPairSync("ed25519");
    const other = generateKeyPairSync("ed25519");
    const sign = (canonical: Buffer) => ({ signature: edSign(null, canonical, kp.privateKey).toString("base64"), keyId: "techlead187" });
    const kgId = await seedKg("Signed KG", ["alpha"]);
    const exp = await exportKgPack(kgId, join(dir, "out"), { createdAt: AT, sign });
    expect(exp.signed).toBe(true);

    // trusted → signed:true
    const good = await importKgPack(exp.path!, { decide: cleanDecide, trusted: [{ id: "techlead187", key: kp.publicKey }] });
    expect(good.ok).toBe(true);
    expect(good.signed).toBe(true);
    expect(good.keyId).toBe("techlead187");

    // a signature that can't be verified (only an untrusted key configured) → refused
    const bad = await importKgPack(exp.path!, { decide: cleanDecide, trusted: [{ id: "someone-else", key: other.publicKey }] });
    expect(bad.ok).toBe(false);
    expect(bad.stage).toBe("signature");
  });
});
