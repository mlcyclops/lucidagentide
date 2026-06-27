// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/personal/crypto.ts — FIPS-approved encryption primitives for the
// personalization store (ADR-0010, P9.1).
//
// All algorithms are FIPS-approved: AES-256-GCM (authenticated — the GCM tag makes
// tampering detectable), PBKDF2-HMAC-SHA256 for passphrase → key derivation. The
// runtime is Bun/BoringSSL, so there is no FIPS *mode* in-process; true FIPS-140-3
// validation is an OS/module + deployment concern (see ADR-0010). We commit to the
// approved algorithms + OS-keystore key custody; this module is the algorithm layer.

import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from "node:crypto";

export const KEY_LEN = 32; // AES-256
const IV_LEN = 12; //  96-bit GCM nonce (the standard, never reused with the same key)
export const SALT_LEN = 16;
export const KDF_ITERS = 600_000; // PBKDF2-HMAC-SHA256 work factor

/** A GCM-sealed blob: nonce, auth tag, and ciphertext, all base64. */
export interface Sealed {
  iv: string;
  tag: string;
  ct: string;
}

/** Fresh 256-bit data-encryption key (DEK). */
export const randomKey = (): Buffer => randomBytes(KEY_LEN);
/** Fresh PBKDF2 salt. */
export const randomSalt = (): Buffer => randomBytes(SALT_LEN);

/** Derive a 256-bit key-encryption key (KEK) from a passphrase. FIPS-approved KDF. */
export function deriveKey(passphrase: string, salt: Buffer, iters: number = KDF_ITERS): Buffer {
  return pbkdf2Sync(Buffer.from(passphrase, "utf8"), salt, iters, KEY_LEN, "sha256");
}

/** AES-256-GCM encrypt. A random nonce is generated per call (never reuse a nonce). */
export function encrypt(plaintext: string | Buffer, key: Buffer): Sealed {
  if (key.length !== KEY_LEN) throw new Error(`bad key length ${key.length}, want ${KEY_LEN}`);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const pt = typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext;
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ct: ct.toString("base64") };
}

/** AES-256-GCM decrypt. THROWS on a wrong key or any tampering (GCM auth failure) —
 *  callers must treat the throw as "could not decrypt", never as empty/safe. */
export function decrypt(sealed: Sealed, key: Buffer): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"));
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(sealed.ct, "base64")), decipher.final()]);
}
