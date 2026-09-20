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
import { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, statSync, writeFileSync, copyFileSync, rmSync, type Stats } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { DEFAULT_POLICY, type GateDecision, scanAndDecide } from "../harness/security/gate.ts";
import { ScannerClient, sidecarDir } from "../harness/security/scanner_client.ts";
import { resolvedRepo } from "./repo_root.ts";
import { KbGraphStore } from "../harness/kb/store.ts";
import {
  buildManifest, sha256Bytes, verifyPackManifest, LKGPACK_DB_FILE, LKGPACK_MANIFEST,
  type PackManifest, type TrustedPackKey,
} from "../harness/kb/pack.ts";
import { zipEntries } from "../harness/kb/zip.ts";
import { readZipEntriesMatching } from "../harness/personal/unzip.ts";
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

export interface PackExportResult { ok: boolean; error?: string; path?: string; zipPath?: string; signed?: boolean; pages?: number }

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
  const slug = slugify(entry.name);
  const packDir = join(destDir, `${slug}.lkgpack`);
  const manifestJson = JSON.stringify(manifest, null, 2);
  const zipPath = join(destDir, `${slug}.lkgpack.zip`);
  try {
    // The directory (for local inspection) AND a single-file .lkgpack.zip (the uploadable/downloadable object
    // the entitlement backend signs). Both hold the same manifest + db; the zip's entries are flat (no prefix).
    mkdirSync(packDir, { recursive: true });
    writeFileSync(join(packDir, LKGPACK_DB_FILE), db);
    writeFileSync(join(packDir, LKGPACK_MANIFEST), manifestJson);
    writeFileSync(zipPath, zipEntries([
      { name: LKGPACK_MANIFEST, data: Buffer.from(manifestJson, "utf8") },
      { name: LKGPACK_DB_FILE, data: db },
    ]));
  } catch (e) { return { ok: false, error: `write failed: ${(e as Error).message}` }; }
  return { ok: true, path: packDir, zipPath, signed: !!manifest.signature, pages };
}

export interface PackImportResult {
  ok: boolean; error?: string;
  // P-PACKSCAN.1 (ADR-0368): `scanner` is DISTINCT from `scan`. `scan` means the pack's own content was
  // refused (a finding, a real block) and is the user's pack being untrustworthy. `scanner` means LUCID
  // could not run its scanner at all, which is OUR fault, not the pack's, and the two must never share a
  // message: the old behavior reported a missing sidecar directory as `page "x" flagged`, which reads as
  // "your pack is malicious" and sent the operator hunting through a pack that was perfectly valid.
  stage?: "manifest" | "integrity" | "signature" | "scan" | "scanner" | "write" | "ok";
  kgId?: string; kgName?: string; signed?: boolean; keyId?: string; pages?: number; findings?: number;
  /** Where the full diagnostic for THIS attempt was written, so a failure can point at one file the
   *  user can send. Always set on failure, even when writing the log itself partly failed. */
  logPath?: string;
}

/** Is this block reason the scanner being unreachable rather than the content being bad?
 *
 *  The gate fail-closes a dead scanner into a BLOCK carrying its own reason text, so this is a string
 *  test by necessity. Kept deliberately broad across the phrasings `scanner_client.ts` can produce
 *  (`scanner not running`, `scanner stdin not writable`, `scan timeout after Nms`, `malformed scan
 *  response`, `write to scanner failed`) plus the gate's own `fail-closed: scan unavailable` prefix.
 *  A false NEGATIVE here is safe: the pack is still refused, the message is just less helpful. A false
 *  POSITIVE would mislabel a real finding as an environment fault, so every pattern names a mechanism
 *  and none of them match a Unicode finding's reason. */
export function isScannerUnavailable(reason: string | undefined): boolean {
  if (!reason) return false;
  const r = reason.toLowerCase();
  return r.includes("scan unavailable")
    || r.includes("scanner not running")
    || r.includes("scanner stdin not writable")
    || r.includes("write to scanner failed")
    || r.includes("malformed scan response")
    || /scan timeout after \d+ms/.test(r);
}

/** The one file a user is pointed at when a pack will not load (P-PACKSCAN.1).
 *
 *  Lives beside the other `lucid-*` diagnostics in the data root so a support bundle already collects
 *  it. Append-only JSONL, one object per attempt, so a user who tried four times sends one file that
 *  shows all four. Nothing secret goes in: the pack path, the manifest's own metadata, the stage, the
 *  error, and the environment facts that actually decide whether the scanner can run. */
export function packLogPath(): string {
  return process.env.LUCID_PACK_LOG_PATH
    || join(process.env.LUCID_DATA_ROOT || join(homedir(), ".omp"), "lucid-kbpack.jsonl");
}

/** Append one attempt to the pack log and return the path. Never throws: a diagnostic that breaks the
 *  thing it is diagnosing is worse than no diagnostic, so a write failure is swallowed and the caller
 *  still gets a path to name. */
export function logPackAttempt(entry: {
  source: string;
  result: PackImportResult;
  manifest?: Pick<PackManifest, "format" | "author" | "version" | "page_count"> & { name?: string };
  startedAt?: number;
}): string {
  const path = packLogPath();
  const sidecar = sidecarDir();
  const line = {
    at: new Date().toISOString(),
    ms: entry.startedAt ? Date.now() - entry.startedAt : undefined,
    source: entry.source,
    ok: entry.result.ok,
    stage: entry.result.stage,
    error: entry.result.error,
    pages: entry.result.pages,
    findings: entry.result.findings,
    signed: entry.result.signed,
    kgName: entry.result.kgName,
    pack: entry.manifest,
    // The environment facts that decide whether a re-scan can happen at all. This block is the reason
    // the log exists: ADR-0368 was a wrong `scannerDir`, and nothing on screen or on disk said so.
    env: {
      appVersion: process.env.LUCID_APP_VERSION,
      platform: `${process.platform}-${process.arch}`,
      scannerDir: sidecar,
      scannerDirExists: existsSync(sidecar),
      scannerServerExists: existsSync(join(sidecar, "server.py")),
      scannerPython: process.env.SCANNER_PYTHON,
      scannerPythonExists: process.env.SCANNER_PYTHON ? existsSync(process.env.SCANNER_PYTHON) : false,
      scannerDirFromEnv: !!(process.env.LUCID_SCANNER_DIR ?? "").trim(),
      repoRoot: resolvedRepo().root,
      repoProven: resolvedRepo().proven,
    },
  };
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(line) + "\n", "utf8");
  } catch { /* a diagnostic must never break the operation it describes */ }
  return path;
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
        return { ok: false, stage: "scanner", error: `scanner unavailable: ${(e as Error).message}` };
      }
      findings += d.findings.length;
      if (d.block) {
        // The gate catches ScanUnavailableError itself and fail-closes into a BLOCK decision, so an
        // environment fault arrives here looking exactly like a content finding. Read the reason to tell
        // them apart, or a broken install is permanently indistinguishable from a poisoned pack.
        if (isScannerUnavailable(d.reason)) {
          record({ tool: "kb_pack_import", severity: "high", findings: "scanner-unavailable", reason: `KG pack "${manifest.kg.name}" blocked — scanner unavailable` });
          return { ok: false, stage: "scanner", error: `scanner unavailable: ${d.reason}` };
        }
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

/** P-KGMARKET.4 (ADR-0206): download a `.lkgpack.zip` from a URL, unzip its manifest + db to a temp
 *  `.lkgpack` dir, and run the SAME `importKgPack` gate (verify + re-scan fail-closed → read-only install).
 *  The URL is the short-lived signed Storage URL the entitlement backend mints (getPackDownload) - a purchase
 *  grants ACCESS; the import still proves ORIGIN + SAFETY. `fetchImpl` is injected for tests. */
export async function installPackFromUrl(url: string, opts: {
  fetchImpl?: typeof fetch;
  scanner?: ScannerClient; trusted?: TrustedPackKey[];
  decide?: (text: string) => Promise<GateDecision>;
  record?: (b: { tool: string; severity?: string; findings?: string; reason: string }) => void;
} = {}): Promise<PackImportResult> {
  // A PURCHASED pack that will not install is the case where a user most needs something to send, so
  // this path logs too. The url is recorded WITHOUT its query string: an entitlement download url is a
  // short-lived signed url whose signature is a credential, and a support log is a file people email.
  const startedAt = Date.now();
  const source = url ? `${url.split("?")[0]} (signed download)` : "(no url)";
  const done = (result: PackImportResult): PackImportResult =>
    result.ok ? result : { ...result, logPath: logPackAttempt({ source, result, startedAt }) };

  if (!url) return done({ ok: false, stage: "manifest", error: "no download url" });
  const f = opts.fetchImpl ?? fetch;
  let bytes: Buffer;
  try {
    const res = await f(url);
    if (!res.ok) return done({ ok: false, stage: "manifest", error: `download failed (${res.status})` });
    bytes = Buffer.from(await res.arrayBuffer());
  } catch (e) { return done({ ok: false, stage: "manifest", error: `download failed: ${(e as Error).message}` }); }

  return done(await importPackBytes(bytes, opts));
}

/** The ONE place a `.lkgpack.zip` becomes an importable pack directory: extract manifest + db (matched by
 *  BASENAME, so any folder prefix inside the zip is fine) into a temp `.lkgpack`, run the P-KGPACK.4 gate,
 *  then delete the temp copy. Shared by the entitled download and by a hand-picked local zip so those two
 *  routes can never drift apart on what counts as a valid pack. */
export async function importPackBytes(bytes: Buffer, opts: Parameters<typeof importKgPack>[1] = {}): Promise<PackImportResult> {
  let extracted: { name: string; data: Buffer }[];
  try { extracted = readZipEntriesMatching(bytes, (base) => base === LKGPACK_MANIFEST || base === LKGPACK_DB_FILE); }
  catch (e) { return { ok: false, stage: "manifest", error: `not a valid .lkgpack.zip: ${(e as Error).message}` }; }
  const man = extracted.find((e) => e.name === LKGPACK_MANIFEST);
  const dbf = extracted.find((e) => e.name === LKGPACK_DB_FILE);
  if (!man || !dbf) return { ok: false, stage: "manifest", error: `that zip is missing ${LKGPACK_MANIFEST} or ${LKGPACK_DB_FILE}` };

  const tmp = mkdtempSync(join(tmpdir(), "lkgpack-"));
  const packDir = join(tmp, "pack.lkgpack");
  try {
    mkdirSync(packDir, { recursive: true });
    writeFileSync(join(packDir, LKGPACK_MANIFEST), man.data);
    writeFileSync(join(packDir, LKGPACK_DB_FILE), dbf.data);
    return await importKgPack(packDir, opts); // the P-KGPACK.4 gate copies the clean db out before we return
  } catch (e) {
    return { ok: false, stage: "write", error: `install failed: ${(e as Error).message}` };
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/** What the user actually picked. The storefront delivers a `.lkgpack.zip`, but the import picker was a
 *  FOLDER dialog, so the zip was invisible and the only way through was to guess that unzipping was
 *  required, with nothing in the UI saying so. Both are accepted now, plus the `manifest.json` INSIDE an
 *  unzipped pack: on Windows a single dialog cannot offer files and folders at once, so the file dialog
 *  filters on `zip` + `json` and a picked manifest resolves to its parent. */
export type PackInput =
  | { kind: "dir"; packDir: string }
  | { kind: "zip"; file: string }
  | { kind: "reject"; reason: string };

/** PURE-ish (one stat + one 4-byte read): classify a picked path. Never opens a store. */
export function classifyPackInput(p: string): PackInput {
  let st: Stats;
  try { st = statSync(p); }
  catch { return { kind: "reject", reason: "that path no longer exists - pick the .lkgpack.zip you downloaded" }; }
  if (st.isDirectory()) return { kind: "dir", packDir: p };
  if (basename(p) === LKGPACK_MANIFEST) return { kind: "dir", packDir: dirname(p) };
  // Trust the MAGIC, not the extension: a renamed download is still a pack, and a .zip that is not one
  // gets a clear message instead of a confusing failure three stages later.
  let head = Buffer.alloc(0);
  try {
    const fd = openSync(p, "r");
    try { const buf = Buffer.alloc(4); head = buf.subarray(0, readSync(fd, buf, 0, 4, 0)); } finally { closeSync(fd); }
  } catch { return { kind: "reject", reason: "that file could not be read" }; }
  if (head.length === 4 && head[0] === 0x50 && head[1] === 0x4b) return { kind: "zip", file: p };
  return { kind: "reject", reason: "that is not a KG pack - pick the .lkgpack.zip you downloaded, or the manifest.json inside an unzipped pack" };
}

/** Import whatever the user picked: an unzipped `.lkgpack` folder, its `manifest.json`, or the downloaded
 *  `.lkgpack.zip`. The zip path reuses installPackFromUrl's extraction, so there is ONE unzip in the code
 *  base and the gate (integrity, origin, fail-closed re-scan) is identical for every route. */
export async function importPackFromPath(p: string, opts: Parameters<typeof importKgPack>[1] = {}): Promise<PackImportResult> {
  // Every attempt is logged, success or failure, at the OUTERMOST entry point so there is exactly one
  // append per user action no matter which inner path ran (P-PACKSCAN.1). A failure carries the log path
  // back so the UI can point the user at one file to send instead of asking them to describe a stack.
  const startedAt = Date.now();
  const done = (result: PackImportResult): PackImportResult =>
    result.ok ? result : { ...result, logPath: logPackAttempt({ source: p, result, startedAt }) };

  const input = classifyPackInput(p);
  if (input.kind === "reject") return done({ ok: false, stage: "manifest", error: input.reason });
  if (input.kind === "dir") return done(await importKgPack(input.packDir, opts));
  let bytes: Buffer;
  try { bytes = readFileSync(input.file); }
  catch (e) { return done({ ok: false, stage: "manifest", error: `could not read that file: ${(e as Error).message}` }); }
  return done(await importPackBytes(bytes, opts));
}
