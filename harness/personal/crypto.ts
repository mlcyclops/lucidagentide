// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/personal/crypto.ts: FIPS-approved encryption primitives for the
// personalization store (ADR-0010, P9.1).
//
// All algorithms are FIPS-approved: AES-256-GCM (authenticated: the GCM tag makes
// tampering detectable), PBKDF2-HMAC-SHA256 for passphrase to key derivation. Since
// ADR-0473 (P-FIPS.1) the operations run in the OS's FIPS 140-validated module when one
// is usable (Windows CNG, Apple corecrypto, OpenSSL 3 with its FIPS provider) through
// harness/crypto/fips_crypto.ts, and fail closed when policy requires one and none is.
// The output is byte-identical to the previous node:crypto implementation, so the
// frozen on-disk format (personal-kg.v1) is unchanged and existing stores open as-is.

import { aesGcmDecrypt, aesGcmEncrypt, pbkdf2Sha256, randomBytes } from "../crypto/fips_crypto.ts";

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
  return pbkdf2Sha256(Buffer.from(passphrase, "utf8"), salt, iters, KEY_LEN);
}

/** AES-256-GCM encrypt. A random nonce is generated per call (never reuse a nonce). */
export function encrypt(plaintext: string | Buffer, key: Buffer): Sealed {
  if (key.length !== KEY_LEN) throw new Error(`bad key length ${key.length}, want ${KEY_LEN}`);
  const iv = randomBytes(IV_LEN);
  const pt = typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext;
  const { ct, tag } = aesGcmEncrypt(key, iv, pt);
  return { iv: iv.toString("base64"), tag: tag.toString("base64"), ct: ct.toString("base64") };
}

/** AES-256-GCM decrypt. THROWS on a wrong key or any tampering (GCM auth failure);
 *  callers must treat the throw as "could not decrypt", never as empty/safe. */
export function decrypt(sealed: Sealed, key: Buffer): Buffer {
  return aesGcmDecrypt(key, Buffer.from(sealed.iv, "base64"), Buffer.from(sealed.ct, "base64"), Buffer.from(sealed.tag, "base64"));
}
