// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/vault_backup.ts
//
// P-VAULT-UI.1 (ADR-0475): the encrypted `.lucidvault` backup of the engine vault. Engine-only (Bun).
//
// Envelope (JSON, every binary field base64):
//   { v: 1, kdf: { algo: "PBKDF2-HMAC-SHA256", iter: 600000, salt }, alg: "A256GCM", iv, tag, ct }
// The key is PBKDF2-HMAC-SHA256(passphrase, salt, iter, 32 bytes); `ct` is AES-256-GCM over the JSON
// `{ entries: VaultExportEntry[], exportedAt }`, with the header (v, kdf, alg) as AAD so no header field
// can be edited without the tag failing. Every primitive goes through Contract A (fips_crypto.ts, P-FIPS.1):
// the OS FIPS 140 module where one is usable, a FipsRequiredError when policy requires one and none is.
//
// The plaintext exists only inside these functions: the derived key and the decrypted bytes are zeroed
// before returning, nothing is logged, and a restore that fails to authenticate (wrong passphrase or any
// tampering) throws BEFORE anything is written. The envelope is ciphertext, so it may leave the engine.

import { aesGcmDecrypt, aesGcmEncrypt, CryptoAuthError, pbkdf2Sha256, randomBytes } from "../harness/crypto/fips_crypto.ts";
import { vaultExportEntries, vaultImportEntries, type VaultExportEntry } from "./vault_store.ts";

export const BACKUP_FILE_EXT = ".lucidvault";
export const BACKUP_KDF_ALGO = "PBKDF2-HMAC-SHA256";
/** OWASP 2023 guidance for PBKDF2-HMAC-SHA256; written into every new backup. */
export const BACKUP_KDF_ITER = 600_000;
/** What a restore accepts from a file header: a floor so a weakened file is refused, a ceiling so a
 *  crafted file cannot pin the engine on a billion-round derivation. */
const MIN_ITER = 100_000;
const MAX_ITER = 10_000_000;
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
/** A passphrase shorter than this is refused for a NEW backup (restore accepts whatever made the file). */
export const BACKUP_MIN_PASSPHRASE = 10;

export interface VaultBackupEnvelope {
  v: 1;
  kdf: { algo: typeof BACKUP_KDF_ALGO; iter: number; salt: string };
  alg: "A256GCM";
  iv: string;
  tag: string;
  ct: string;
}

/** A refusal the UI can show as is. `code`: `weak-passphrase` (backup), `not-a-backup` (the file is not a
 *  well-formed envelope), `auth` (wrong passphrase or the file was altered), `malformed` (it decrypted
 *  but the content is not a vault export). Never carries a value. */
export class VaultBackupError extends Error {
  constructor(readonly code: "weak-passphrase" | "not-a-backup" | "auth" | "malformed", message: string) {
    super(message);
    this.name = "VaultBackupError";
  }
}

const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
function b64(v: unknown, len?: number): Buffer {
  if (typeof v !== "string" || !B64_RE.test(v)) throw new VaultBackupError("not-a-backup", "this is not a LUCID vault backup");
  const out = Buffer.from(v, "base64");
  if (len !== undefined && out.length !== len) throw new VaultBackupError("not-a-backup", "this is not a LUCID vault backup");
  return out;
}

/** Shape check of a decrypted entry; vaultImportEntries re-validates kind and ref before any write. */
function isExportEntry(e: unknown): e is VaultExportEntry {
  return !!e && typeof e === "object" && "ref" in e && typeof e.ref === "string" && "value" in e && typeof e.value === "string";
}

/** The authenticated header: any edit to v, kdf or alg changes the AAD and fails the tag. */
const aadOf = (iter: number, salt: string): Buffer =>
  Buffer.from(JSON.stringify({ v: 1, kdf: { algo: BACKUP_KDF_ALGO, iter, salt }, alg: "A256GCM" }), "utf8");

function deriveKey(passphrase: string, salt: Buffer, iter: number): Buffer {
  const pw = Buffer.from(passphrase, "utf8");
  try { return pbkdf2Sha256(pw, salt, iter, KEY_LEN); } finally { pw.fill(0); }
}

/** Seal entries under a passphrase (always BACKUP_KDF_ITER rounds). */
export function sealVaultBackup(entries: VaultExportEntry[], passphrase: string): VaultBackupEnvelope {
  if (typeof passphrase !== "string" || [...passphrase].length < BACKUP_MIN_PASSPHRASE) {
    throw new VaultBackupError("weak-passphrase", `use a passphrase of at least ${BACKUP_MIN_PASSPHRASE} characters`);
  }
  const iter = BACKUP_KDF_ITER;
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const saltB64 = salt.toString("base64");
  const key = deriveKey(passphrase, salt, iter);
  const pt = Buffer.from(JSON.stringify({ entries, exportedAt: Date.now() }), "utf8");
  try {
    const { ct, tag } = aesGcmEncrypt(key, iv, pt, aadOf(iter, saltB64));
    return { v: 1, kdf: { algo: BACKUP_KDF_ALGO, iter, salt: saltB64 }, alg: "A256GCM", iv: iv.toString("base64"), tag: tag.toString("base64"), ct: ct.toString("base64") };
  } finally {
    key.fill(0);
    pt.fill(0);
  }
}

/** Parse a backup file (the JSON text or the already-parsed object) into a checked envelope. */
export function parseVaultBackup(file: unknown): VaultBackupEnvelope {
  let raw: unknown = file;
  if (typeof file === "string") {
    try { raw = JSON.parse(file); } catch { throw new VaultBackupError("not-a-backup", "this is not a LUCID vault backup"); }
  }
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  const kdf = o?.kdf && typeof o.kdf === "object" ? (o.kdf as Record<string, unknown>) : null;
  if (!o || !kdf || o.v !== 1 || o.alg !== "A256GCM" || kdf.algo !== BACKUP_KDF_ALGO) {
    throw new VaultBackupError("not-a-backup", "this is not a LUCID vault backup (or it was made by a newer LUCID)");
  }
  const iter = kdf.iter;
  if (typeof iter !== "number" || !Number.isInteger(iter) || iter < MIN_ITER || iter > MAX_ITER) {
    throw new VaultBackupError("not-a-backup", "the backup's key-derivation settings are outside the accepted range");
  }
  const { salt } = kdf;
  const { iv, tag, ct } = o;
  if (typeof salt !== "string" || typeof iv !== "string" || typeof tag !== "string" || typeof ct !== "string") {
    throw new VaultBackupError("not-a-backup", "this is not a LUCID vault backup");
  }
  b64(salt, SALT_LEN);
  b64(iv, IV_LEN);
  b64(tag, TAG_LEN);
  b64(ct);
  return { v: 1, kdf: { algo: BACKUP_KDF_ALGO, iter, salt }, alg: "A256GCM", iv, tag, ct };
}

/** Decrypt and check a backup. Throws VaultBackupError("auth") on a wrong passphrase or any tampering
 *  (header or body), ("not-a-backup") on a malformed envelope, ("malformed") on unexpected content. */
export function openVaultBackup(file: unknown, passphrase: string): VaultExportEntry[] {
  const env = parseVaultBackup(file);
  if (typeof passphrase !== "string" || !passphrase) throw new VaultBackupError("auth", "the passphrase is wrong or the backup file was altered");
  const key = deriveKey(passphrase, b64(env.kdf.salt), env.kdf.iter);
  let pt: Buffer;
  try {
    pt = aesGcmDecrypt(key, b64(env.iv), b64(env.ct), b64(env.tag), aadOf(env.kdf.iter, env.kdf.salt));
  } catch (e) {
    if (e instanceof CryptoAuthError) throw new VaultBackupError("auth", "the passphrase is wrong or the backup file was altered");
    throw e; // FipsRequiredError and friends: a refusal, surfaced as is
  } finally {
    key.fill(0);
  }
  try {
    const body: unknown = JSON.parse(pt.toString("utf8"));
    if (!body || typeof body !== "object" || !("entries" in body) || !Array.isArray(body.entries)) throw new Error("no entries");
    const entries: unknown[] = body.entries;
    if (!entries.every(isExportEntry)) throw new Error("bad entry");
    return entries;
  } catch {
    throw new VaultBackupError("malformed", "the backup decrypted but does not contain a vault export");
  } finally {
    pt.fill(0);
  }
}

/** Back up the whole engine vault. Throws when the vault is unreadable (never an empty backup by accident). */
export function createVaultBackup(passphrase: string): { envelope: VaultBackupEnvelope; count: number } {
  const entries = vaultExportEntries();
  try {
    return { envelope: sealVaultBackup(entries, passphrase), count: entries.length };
  } finally {
    for (const e of entries) e.value = "";
  }
}

/** Restore a backup into the engine vault, newer-wins (vault_store.vaultImportEntries). Authentication and
 *  shape checks happen before the single locked write, so a wrong passphrase writes nothing. */
export function restoreVaultBackup(file: unknown, passphrase: string): { added: number; updated: number; skipped: number; refs: string[] } {
  const entries = openVaultBackup(file, passphrase);
  try {
    const counts = vaultImportEntries(entries, "newer-wins");
    return { ...counts, refs: entries.map((e) => e.ref) };
  } finally {
    for (const e of entries) e.value = "";
  }
}

/** `lucid-vault-YYYYMMDD-HHMM.lucidvault` (local time): the suggested file name. */
export function backupFileName(at = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `lucid-vault-${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}${BACKUP_FILE_EXT}`;
}
