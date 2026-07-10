// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/kb_pack.ts — P-KGPACK.4 (ADR-0205): author (export) + gated import of .lkgpack KG Packs.
//
// A KG Pack is a portable KG SKU: a `<slug>.lkgpack/` directory holding the KG's `kb_graph.duckdb` +
// `manifest.json` (see harness/kb/pack.ts). This module is the fs/scanner/registry orchestration:
//   - EXPORT: flush the KG's db, hash it, build (optionally SIGN) the manifest, write the pack directory.
//   - IMPORT (fail-closed, mirrors installRegistrySkill / P-SKILLREG.1):
//       (1) integrity — the db's sha256 MUST match the manifest;
//       (2) signature — when PRESENT it must verify against a trusted key, else REFUSE (a forged/broken sig);
//           ABSENT ⇒ unsigned community pack, allowed (the scanner is the safety gate, not the signature);
//       (3) SCAN — re-scan EVERY page fail-closed; any finding or a dead scanner BLOCKS the whole import;
//       (4) install — register a NEW read-only KG + copy the clean db in. Trust stays `untrusted`
//           (keystone #2: a pack is never auto-trusted; a signature proves ORIGIN, not SAFETY).
// Signing is a PRIVATE-authoring concern: the public repo verifies + can build UNSIGNED packs; the real
// TechLead 187 signing key lives in the private add-on repo (same public-seam / private-IP split as
// P-SKILLREG.1 / ADR-0068/0069). Keys/signers come from env (managed config), fail-soft to unsigned.

import { createPrivateKey, createPublicKey, sign as edSign, type KeyObject } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { DEFAULT_POLICY, type GateDecision, scanAndDecide } from "../harness/security/gate.ts";
import { ScannerClient } from "../harness/security/scanner_client.ts";
import { KbGraphStore } from "../harness/kb/store.ts";
import {
  buildManifest, sha256Bytes, verifyPackManifest, LKGPACK_DB_FILE, LKGPACK_MANIFEST,
  type PackManifest, type TrustedPackKey,
} from "../harness/kb/pack.ts";
import { kbScanner, kbStore, kgEntry, closeKg, createKg } from "./kb_store.ts";
import { recordBlock } from "./security_log.ts";

const PACK_KEYS_ENV = "LUCID_KG_PACK_KEYS";
const DEFAULT_PACK_KEYS_PATH = join(homedir(), ".omp", "lucid-pack-keys.json");

/** Load the trusted pack-signing PUBLIC keys ({ id, spki } base64 DER SPKI). Fail-soft to [] (⇒ any signed
 *  pack fails its signature check; unsigned packs still import through the scanner). */
export function loadPackKeys(): TrustedPackKey[] {
  let raw = process.env[PACK_KEYS_ENV] ?? "";
  if (!raw) { try { raw = readFileSync(process.env.LUCID_KG_PACK_KEYS_PATH || DEFAULT_PACK_KEYS_PATH, "utf8"); } catch { return []; } }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const out: TrustedPackKey[] = [];
  for (const e of parsed) {
    if (!e || typeof e !== "object") continue;
    const id = "id" in e ? (e as Record<string, unknown>).id : undefined;
    const spki = "spki" in e ? (e as Record<string, unknown>).spki : undefined;
    if (typeof id !== "string" || typeof spki !== "string") continue;
    try { out.push({ id, key: createPublicKey({ key: Buffer.from(spki, "base64"), type: "spki", format: "der" }) }); }
    catch { /* a malformed key entry is skipped — never a partial-trust bypass */ }
  }
  return out;
}

/** The private authoring signer, when a signing key is configured (env, managed by the private repo).
 *  Absent ⇒ export produces an UNSIGNED pack. */
function packSigner(): ((canonical: Buffer) => { signature: string; keyId?: string }) | undefined {
  const raw = process.env.LUCID_KG_PACK_SIGNING_KEY;
  if (!raw) return undefined;
  let key: KeyObject;
  try { key = createPrivateKey({ key: Buffer.from(raw, "base64"), type: "pkcs8", format: "der" }); } catch { return undefined; }
  const keyId = process.env.LUCID_KG_PACK_SIGNING_KEY_ID || "";
  return (canonical) => ({ signature: edSign(null, canonical, key).toString("base64"), keyId });
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "kg";
}

export interface PackExportResult { ok: boolean; error?: string; path?: string; signed?: boolean; pages?: number }

/** Export a KG as a `<slug>.lkgpack/` directory under `destDir`. Signs the manifest if a signing key is
 *  configured; otherwise the pack is unsigned. `createdAt` is injected so the result is deterministic in tests. */
export async function exportKgPack(kgId: string, destDir: string, meta: {
  author?: string; version?: string; role?: string; description?: string; createdAt: string;
  sign?: (canonical: Buffer) => { signature: string; keyId?: string };
}): Promise<PackExportResult> {
  const entry = kgEntry(kgId);
  if (!entry) return { ok: false, error: "unknown knowledge graph" };
  const pages = await (await kbStore(kgId)).pageCount();
  await closeKg(kgId); // checkpoint the WAL into the file BEFORE we read its bytes
  let db: Buffer;
  try { db = readFileSync(entry.db_path); } catch (e) { return { ok: false, error: `can't read the KG db: ${(e as Error).message}` }; }
  const manifest = buildManifest({
    kg: { name: entry.name, role: meta.role, description: meta.description },
    author: meta.author?.trim() || "LUCID user",
    version: meta.version?.trim() || "1.0.0",
    createdAt: meta.createdAt,
    dbSha256: sha256Bytes(db),
    pageCount: pages,
    sign: meta.sign ?? packSigner(),
  });
  const packDir = join(destDir, `${slugify(entry.name)}.lkgpack`);
  try {
    mkdirSync(packDir, { recursive: true });
    writeFileSync(join(packDir, LKGPACK_DB_FILE), db);
    writeFileSync(join(packDir, LKGPACK_MANIFEST), JSON.stringify(manifest, null, 2));
  } catch (e) { return { ok: false, error: `write failed: ${(e as Error).message}` }; }
  return { ok: true, path: packDir, signed: !!manifest.signature, pages };
}

export interface PackImportResult {
  ok: boolean; error?: string;
  stage?: "manifest" | "integrity" | "signature" | "scan" | "write" | "ok";
  kgId?: string; kgName?: string; signed?: boolean; keyId?: string; pages?: number; findings?: number;
}

/** Verify (integrity + origin) → re-scan every page fail-closed → register a read-only KG + copy the db in.
 *  Nothing is registered unless every stage passes; a block records to the Security panel. */
export async function importKgPack(packDir: string, opts: {
  scanner?: ScannerClient;
  trusted?: TrustedPackKey[];
  decide?: (text: string) => Promise<GateDecision>;
  record?: (b: { tool: string; severity?: string; findings?: string; reason: string }) => void;
} = {}): Promise<PackImportResult> {
  const record = opts.record ?? recordBlock;

  // (1) read the manifest + db (TOCTOU-safe: read directly, classify by the error).
  let manifest: PackManifest;
  try { manifest = JSON.parse(readFileSync(join(packDir, LKGPACK_MANIFEST), "utf8")) as PackManifest; }
  catch { return { ok: false, stage: "manifest", error: "no readable manifest.json in that pack" }; }
  const dbPath = join(packDir, manifest.db_file || LKGPACK_DB_FILE);
  let db: Buffer;
  try { db = readFileSync(dbPath); } catch { return { ok: false, stage: "manifest", error: "the pack's db file is missing" }; }

  // (2) integrity + signature (ORIGIN). A tampered db or a present-but-invalid signature is refused.
  const v = verifyPackManifest(manifest, sha256Bytes(db), opts.trusted ?? loadPackKeys());
  if (!v.ok) {
    record({ tool: "kb_pack_import", severity: "high", findings: v.stage, reason: `KG pack rejected — ${v.reason}` });
    return { ok: false, stage: v.stage, error: v.reason };
  }

  // (3) SAFETY: re-scan every page fail-closed. Any finding OR a dead scanner blocks the WHOLE import.
  const scanner = opts.scanner ?? kbScanner();
  const decide = opts.decide ?? ((t: string) => scanAndDecide(scanner, t, DEFAULT_POLICY));
  let tmp: KbGraphStore;
  try { tmp = await KbGraphStore.open(dbPath); }
  catch (e) { return { ok: false, stage: "scan", error: `pack db is not a valid KG store: ${(e as Error).message}` }; }
  let findings = 0, pageCount = 0;
  try {
    const pages = await tmp.listPages();
    pageCount = pages.length;
    for (const pg of pages) {
      let d: GateDecision;
      try { d = await decide(pg.body_md); }
      catch (e) {
        record({ tool: "kb_pack_import", severity: "high", findings: "scanner-unavailable", reason: `KG pack "${manifest.kg.name}" blocked — scanner unavailable` });
        return { ok: false, stage: "scan", error: `scanner unavailable: ${(e as Error).message}` };
      }
      findings += d.findings.length;
      if (d.block) {
        record({ tool: "kb_pack_import", severity: "high", findings: String(d.findings.length), reason: `KG pack "${manifest.kg.name}" blocked at the gate — page "${pg.slug}": ${d.reason}` });
        return { ok: false, stage: "scan", findings, error: `page "${pg.slug}" flagged: ${d.reason}` };
      }
    }
  } finally { tmp.close(); }

  // (4) install: a NEW read-only KG + the clean db copied in. Never auto-trusted (keystone #2).
  const provenance = `pack·${manifest.author}·v${manifest.version}·${v.signed ? `signed·${v.keyId ?? "trusted"}` : "unsigned"}`;
  const entry = createKg({ name: manifest.kg.name, sourceKind: "pack", readOnly: true, provenance });
  try { copyFileSync(dbPath, entry.db_path); }
  catch (e) { return { ok: false, stage: "write", error: `install failed: ${(e as Error).message}` }; }
  return { ok: true, stage: "ok", kgId: entry.kg_id, kgName: entry.name, signed: v.signed, keyId: v.keyId, pages: pageCount, findings };
}
