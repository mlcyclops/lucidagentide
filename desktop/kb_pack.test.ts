// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/kb_pack.test.ts — P-KGPACK.4 (ADR-0205): export → gated import round-trip. Pins: a KG exports to a
// .lkgpack and imports back as a READ-ONLY, untrusted KG with its pages intact; a tampered db is refused at
// integrity; a poisoned page blocks the WHOLE import (nothing registered); a dead scanner fails closed; and
// a signed pack verifies only against a trusted key. The scanner is injected (fast, deterministic).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import type { GateDecision } from "../harness/security/gate.ts";
import { LKGPACK_DB_FILE } from "../harness/kb/pack.ts";
import { exportKgPack, importKgPack, importPackFromPath, isScannerUnavailable, packLogPath } from "./kb_pack.ts";
import { _resetKbStoreForTest, kbStore, createKg, listKgs, stopKb } from "./kb_store.ts";

const CLEAN: GateDecision = { block: false, reason: "clean", trustLabel: "trusted", findings: [], failClosed: false };
const cleanDecide = async (): Promise<GateDecision> => CLEAN;
const poisonDecide = async (t: string): Promise<GateDecision> => (/POISON/.test(t)
  ? { block: true, reason: "zero-width", trustLabel: "quarantined", findings: [{}], failClosed: false } as unknown as GateDecision
  : CLEAN);
const deadDecide = async (): Promise<GateDecision> => { throw new Error("sidecar dead"); };
/** Blocks EVERY page as a content finding, for exercising the log on a guaranteed `scan` refusal. */
const poisonDecideAlways = async (): Promise<GateDecision> => ({
  block: true, reason: "zero-width", trustLabel: "quarantined", findings: [{}], failClosed: false,
} as unknown as GateDecision);

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
    // P-PACKSCAN.1 (ADR-0368): was "scan". A THROWING decider is the scanner being unreachable, which
    // is now reported as its own stage so the user is not told their pack is malicious. Still refused.
    expect(imp.stage).toBe("scanner");
    expect(listKgs().filter((k) => k.read_only).length).toBe(0);
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

// P-PACKSCAN.1 (ADR-0368): a BROKEN SCANNER and a POISONED PACK must not look the same.
//
// The shipped behaviour reported a missing sidecar directory as `page "doc-01-summary" flagged:
// fail-closed: scan unavailable (scanner not running)`, i.e. it accused a valid 189-page pack of
// carrying an attack. The pack was fine; the packaged engine could not find its own scanner. Both cases
// still REFUSE (invariant 3 is untouched); only the stage, the message, and whose problem it is differ.
describe("kb_pack - a dead scanner is our fault, not the pack's", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kb-pack-diag-"));
    process.env.LUCID_KB_DB_PATH = join(dir, "kb_graph.duckdb");
    process.env.LUCID_KG_REGISTRY_PATH = join(dir, "kg_registry.json");
    process.env.LUCID_PACK_LOG_PATH = join(dir, "lucid-kbpack.jsonl");
    _resetKbStoreForTest();
  });
  afterEach(async () => {
    await stopKb();
    delete process.env.LUCID_KB_DB_PATH;
    delete process.env.LUCID_KG_REGISTRY_PATH;
    delete process.env.LUCID_PACK_LOG_PATH;
    rmSync(dir, { recursive: true, force: true });
  });

  test("an UNREACHABLE scanner reports stage 'scanner', never 'scan'", async () => {
    // The gate fail-closes a dead scanner into a BLOCK decision carrying its own reason, so this arrives
    // looking exactly like a content finding. If it is not classified, the user is told their pack is bad.
    const kgId = await seedKg("Clean KG", ["nothing wrong with this page"]);
    const exp = await exportKgPack(kgId, join(dir, "out"), { createdAt: AT });
    const blockedByDeadScanner = async (): Promise<GateDecision> => ({
      block: true, reason: "fail-closed: scan unavailable (scanner not running)",
      trustLabel: "quarantined", findings: [], failClosed: true,
    } as unknown as GateDecision);

    const r = await importKgPack(exp.path!, { decide: blockedByDeadScanner });
    expect(r.ok).toBe(false);              // still refused: invariant 3 is untouched
    expect(r.stage).toBe("scanner");       // but it is OUR fault and says so
    expect(r.error).toContain("scanner unavailable");
    expect(r.error).not.toContain("flagged"); // never accuse the pack
    expect(listKgs().find((k) => k.name === "Clean KG" && k.read_only)).toBeUndefined();
  });

  test("a POISONED page still reports stage 'scan', so the two stay distinguishable", async () => {
    const kgId = await seedKg("Bad KG", ["POISON here"]);
    const exp = await exportKgPack(kgId, join(dir, "out"), { createdAt: AT });
    const r = await importKgPack(exp.path!, { decide: poisonDecide });
    expect(r.ok).toBe(false);
    expect(r.stage).toBe("scan");
    expect(r.error).toContain("flagged");
  });

  test("isScannerUnavailable matches every mechanism reason and NO content finding", () => {
    // The negatives are the load-bearing half: a false positive would relabel a real attack as a
    // LUCID bug and tell the user to just restart, which is the one outcome that must never happen.
    for (const r of [
      "fail-closed: scan unavailable (scanner not running)",
      "scanner not running",
      "scanner stdin not writable",
      "write to scanner failed",
      "malformed scan response",
      "scan timeout after 5000ms",
    ]) expect(isScannerUnavailable(r), r).toBe(true);
    for (const r of [
      "zero-width",
      "mixed-script-homoglyph",
      "bidi control character U+202E",
      "page carries a Trojan-Source override",
      undefined,
      "",
    ]) expect(isScannerUnavailable(r), String(r)).toBe(false);
  });

  test("a failed import writes ONE support log line and hands back its path", async () => {
    const kgId = await seedKg("Log KG", ["a page"]);
    const exp = await exportKgPack(kgId, join(dir, "out"), { createdAt: AT });
    // importPackFromPath is the outermost entry point, so it owns the logging.
    const r = await importPackFromPath(exp.zipPath!, { decide: poisonDecideAlways });
    expect(r.ok).toBe(false);
    expect(r.logPath).toBe(packLogPath());

    const lines = readFileSync(packLogPath(), "utf8").trim().split("\n");
    expect(lines.length).toBe(1); // one user action, one line
    const e = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(e.ok).toBe(false);
    expect(e.stage).toBe("scan");
    expect(e.source).toBe(exp.zipPath);
    // The env block is the whole point: it answers "could this install scan at all" without a repro.
    const env = e.env as Record<string, unknown>;
    expect(typeof env.scannerDir).toBe("string");
    expect(typeof env.scannerDirExists).toBe("boolean");
    expect(typeof env.repoProven).toBe("boolean");
    expect(env.platform).toBe(`${process.platform}-${process.arch}`);
  });

  test("a SUCCESSFUL import writes no failure log and returns no logPath", async () => {
    // Otherwise the file a user is told to send fills with noise from imports that worked.
    const kgId = await seedKg("Good KG", ["a page"]);
    const exp = await exportKgPack(kgId, join(dir, "out"), { createdAt: AT });
    const r = await importPackFromPath(exp.zipPath!, { decide: cleanDecide });
    expect(r.ok).toBe(true);
    expect(r.logPath).toBeUndefined();
    expect(existsSync(packLogPath())).toBe(false);
  });
});
