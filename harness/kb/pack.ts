// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/kb/pack.ts — P-KGPACK.4 (ADR-0205): the .lkgpack pack format (pure manifest + verify).
//
// A KG Pack is a portable, self-contained KG: a `kb_graph.duckdb` plus a `manifest.json`. This module is the
// pure, testable core - the manifest shape, the canonical signed payload, and verification. The fs/scanner/
// registry orchestration (export a KG, gated import) lives in desktop/kb_pack.ts.
//
// TRUST MODEL (keystone #2, invariant #3). A signature proves ORIGIN, never SAFETY:
//   - integrity: the db's sha256 MUST match the manifest (tamper/corruption detection);
//   - signature (optional): when PRESENT it must verify against a trusted key, else the pack is REFUSED (a
//     broken/forged signature is worse than none); when ABSENT the pack is "unsigned" - allowed, because the
//     SCANNER (run by the importer, fail-closed) is the safety gate, not the signature.
// The importer re-scans every page regardless, and stores the KG read-only + untrusted (never auto-trusted).

import { createHash, verify, type KeyObject } from "node:crypto";

export const LKGPACK_FORMAT = "lkgpack/1";
export const LKGPACK_DB_FILE = "kb_graph.duckdb";
export const LKGPACK_MANIFEST = "manifest.json";

/** A trusted pack-signing key: an id + the imported Ed25519 public key. */
export interface TrustedPackKey { id: string; key: KeyObject }

export interface PackKgMeta { name: string; role?: string; description?: string }

export interface PackManifest {
  format: string;          // "lkgpack/1"
  kg: PackKgMeta;
  author: string;
  version: string;
  created_at: string;
  db_file: string;         // "kb_graph.duckdb"
  db_sha256: string;       // hex sha256 of the db bytes — the integrity anchor
  page_count: number;
  key_id?: string;         // hint: which key signed it
  signature?: string;      // base64 Ed25519 over canonicalManifestBytes()
}

/** hex sha256 of raw bytes (the db file's identity). */
export function sha256Bytes(buf: Buffer | Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Deterministic JSON with recursively-sorted keys — a stable byte payload independent of construction order.
 *  Mirrors JSON.stringify's undefined handling EXACTLY (objects drop undefined-valued keys, arrays coerce
 *  undefined → null) so the sign-time payload equals the payload re-derived after a JSON round-trip to disk
 *  (a divergence there silently breaks every signature). */
function stableStringify(v: unknown): string {
  if (v === null || v === undefined || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return "[" + v.map((x) => stableStringify(x === undefined ? null : x)).join(",") + "]";
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(o[k])).join(",") + "}";
}

/** The SIGNED payload: the manifest WITHOUT its signature/key_id, canonicalised. Because it includes
 *  db_sha256, a valid signature binds the author to the exact db bytes. */
export function canonicalManifestBytes(m: PackManifest): Buffer {
  const { signature: _s, key_id: _k, ...rest } = m;
  return Buffer.from(stableStringify(rest), "utf8");
}

/** Build a manifest for a KG's db. If `sign` is supplied (the private authoring key), the pack is signed;
 *  otherwise it is an unsigned (community) pack. Pure. */
export function buildManifest(input: {
  kg: PackKgMeta; author: string; version: string; createdAt: string;
  dbSha256: string; pageCount: number;
  sign?: (canonical: Buffer) => { signature: string; keyId?: string };
}): PackManifest {
  const m: PackManifest = {
    format: LKGPACK_FORMAT, kg: input.kg, author: input.author, version: input.version,
    created_at: input.createdAt, db_file: LKGPACK_DB_FILE, db_sha256: input.dbSha256, page_count: input.pageCount,
  };
  if (input.sign) { const s = input.sign(canonicalManifestBytes(m)); m.signature = s.signature; if (s.keyId) m.key_id = s.keyId; }
  return m;
}

/** Verify an Ed25519 signature over `content` against trusted keys. FAIL-CLOSED: empty sig / no keys / no
 *  match ⇒ ok:false. Self-contained (harness must not import the desktop registry). */
function verifySig(content: string, sigB64: string, trusted: TrustedPackKey[]): { ok: boolean; keyId?: string; reason: string } {
  if (!sigB64) return { ok: false, reason: "unsigned" };
  if (!trusted.length) return { ok: false, reason: "no trusted pack keys configured" };
  let sig: Buffer;
  try { sig = Buffer.from(sigB64, "base64"); } catch { return { ok: false, reason: "malformed signature" }; }
  const data = Buffer.from(content, "utf8");
  for (const k of trusted) {
    try { if (verify(null, data, k.key, sig)) return { ok: true, keyId: k.id, reason: "verified" }; }
    catch { /* wrong key type / bad sig for this key — try the next */ }
  }
  return { ok: false, reason: "signature does not match any trusted pack key" };
}

export interface PackVerifyResult {
  ok: boolean;
  stage: "manifest" | "integrity" | "signature" | "ok";
  signed: boolean;         // a signature was present AND verified against a trusted key
  keyId?: string;
  reason: string;
}

/**
 * Verify a pack manifest against the db bytes' ACTUAL sha256 and the trusted keys. This is the ORIGIN +
 * INTEGRITY gate; the SAFETY gate (re-scanning pages) is the importer's job and runs regardless of the
 * outcome here. Pure.
 */
export function verifyPackManifest(m: PackManifest, actualDbSha256: string, trusted: TrustedPackKey[]): PackVerifyResult {
  if (!m || m.format !== LKGPACK_FORMAT) return { ok: false, stage: "manifest", signed: false, reason: "unrecognized pack format" };
  if (!m.db_file || !m.db_sha256 || !m.kg?.name?.trim()) return { ok: false, stage: "manifest", signed: false, reason: "incomplete manifest" };
  if (m.db_sha256.toLowerCase() !== actualDbSha256.toLowerCase()) {
    return { ok: false, stage: "integrity", signed: false, reason: "db hash mismatch — the pack is tampered or corrupt" };
  }
  if (m.signature) {
    const v = verifySig(canonicalManifestBytes(m).toString("utf8"), m.signature, trusted);
    // A PRESENT-but-invalid signature is a forgery/tamper signal → REFUSE (fail-closed).
    if (!v.ok) return { ok: false, stage: "signature", signed: false, reason: `signature present but invalid — ${v.reason}` };
    return { ok: true, stage: "ok", signed: true, keyId: v.keyId, reason: "signature verified" };
  }
  // No signature → unsigned community pack; integrity is fine, the scanner is the safety gate.
  return { ok: true, stage: "ok", signed: false, reason: "unsigned (integrity ok)" };
}
