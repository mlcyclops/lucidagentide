// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/kb_pack_install.test.ts — P-KGMARKET.4 (ADR-0206): the download -> unzip -> gated-install path.
// A KG exports to a single `.lkgpack.zip`; installPackFromUrl fetches it (injected fetch), unzips, and runs
// the SAME P-KGPACK.4 gate: a clean pack installs read-only; a download error / non-zip fails at manifest;
// a poisoned page blocks the whole install (nothing registered). A purchase grants access, not trust.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GateDecision } from "../harness/security/gate.ts";
import { exportKgPack, installPackFromUrl } from "./kb_pack.ts";
import { _resetKbStoreForTest, kbStore, createKg, listKgs, stopKb } from "./kb_store.ts";

const CLEAN: GateDecision = { block: false, reason: "clean", trustLabel: "trusted", findings: [], failClosed: false };
const cleanDecide = async (): Promise<GateDecision> => CLEAN;
const poisonDecide = async (t: string): Promise<GateDecision> => (/POISON/.test(t)
  ? { block: true, reason: "zero-width", trustLabel: "quarantined", findings: [{}], failClosed: false } as unknown as GateDecision
  : CLEAN);
const AT = "2026-07-10T00:00:00.000Z";

const fetchBytes = (bytes: Buffer, ok = true, status = 200): typeof fetch =>
  (async () => ({ ok, status, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) })) as unknown as typeof fetch;

async function seedKg(name: string, bodies: string[]): Promise<string> {
  const kg = createKg({ name });
  const store = await kbStore(kg.kg_id);
  for (let i = 0; i < bodies.length; i++) await store.addPage({ kind: "concept", slug: `p-${i}`, title: `P${i}`, bodyMd: bodies[i]!, trustLabel: "untrusted", classification: "U" });
  return kg.kg_id;
}

describe("installPackFromUrl — download → unzip → gated install", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "kb-install-")); process.env.LUCID_KB_DB_PATH = join(dir, "kb_graph.duckdb"); process.env.LUCID_KG_REGISTRY_PATH = join(dir, "kg_registry.json"); _resetKbStoreForTest(); });
  afterEach(async () => { await stopKb(); delete process.env.LUCID_KB_DB_PATH; delete process.env.LUCID_KG_REGISTRY_PATH; rmSync(dir, { recursive: true, force: true }); });

  test("a clean pack downloads + unzips + installs as a read-only KG with pages intact", async () => {
    const kgId = await seedKg("Downloaded Pack", ["alpha page", "beta page"]);
    const exp = await exportKgPack(kgId, join(dir, "out"), { author: "TechLead 187 LLC", createdAt: AT });
    expect(exp.ok && exp.zipPath).toBeTruthy();
    const zip = readFileSync(exp.zipPath!);

    const before = listKgs().length;
    const r = await installPackFromUrl("https://signed.example/p.lkgpack.zip", { fetchImpl: fetchBytes(zip), decide: cleanDecide, trusted: [] });
    expect(r.ok).toBe(true);
    expect(r.pages).toBe(2);
    expect(listKgs().length).toBe(before + 1);
    const installed = listKgs().find((k) => k.kg_id === r.kgId)!;
    expect(installed.read_only).toBe(true);
    expect(installed.source_kind).toBe("pack");
    expect(await (await kbStore(r.kgId!)).pageCount()).toBe(2);
  });

  test("a failed download is refused at the manifest stage", async () => {
    const r = await installPackFromUrl("https://x/p.zip", { fetchImpl: fetchBytes(Buffer.alloc(0), false, 403), decide: cleanDecide });
    expect(r.ok).toBe(false);
    expect(r.stage).toBe("manifest");
  });

  test("non-zip bytes are refused at the manifest stage", async () => {
    const r = await installPackFromUrl("https://x/p.zip", { fetchImpl: fetchBytes(Buffer.from("definitely not a zip archive")), decide: cleanDecide });
    expect(r.ok).toBe(false);
    expect(r.stage).toBe("manifest");
  });

  test("a poisoned page blocks the whole install (nothing registered) - purchase grants access, not trust", async () => {
    const kgId = await seedKg("Poisoned Download", ["clean page", "hides POISON here"]);
    const exp = await exportKgPack(kgId, join(dir, "out"), { createdAt: AT });
    const zip = readFileSync(exp.zipPath!);
    const before = listKgs().length;
    const r = await installPackFromUrl("https://x/p.zip", { fetchImpl: fetchBytes(zip), decide: poisonDecide, trusted: [] });
    expect(r.ok).toBe(false);
    expect(r.stage).toBe("scan");
    expect(listKgs().length).toBe(before); // the gate ran through the download path
  });
});
