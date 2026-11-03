// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/crypto/fips_crypto.test.ts: the FIPS crypto provider (ADR-0473, P-FIPS.1).
// The active module (Windows CNG on this kind of host) must pass its known-answer tests, produce output
// byte-identical to node:crypto (the no-migration proof), reject any tampering, report its FIPS claim by
// the documented rule, and fail closed when FIPS is required and no validated module is usable.
// Existing personal-kg.v1 blobs sealed by the old node:crypto code must open through it unchanged.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createCipheriv, createDecipheriv, createHash, createHmac, pbkdf2Sync } from "node:crypto";
import { release } from "node:os";
import { managedRequireFips, mergeManaged, parseRegistryPolicy } from "../../desktop/managed_config.ts";
import { decrypt, deriveKey, encrypt, KDF_ITERS, KEY_LEN, type Sealed } from "../personal/crypto.ts";
import {
  _forceModuleForTest, aesGcmDecrypt, aesGcmEncrypt, CryptoAuthError, cryptoInfo, cryptoSelfTest, fipsRequired,
  FipsRequiredError, hmacSha256, pbkdf2Sha256, randomBytes, sha256, windowsCngClaim,
} from "./fips_crypto.ts";

const savedRequired = process.env.LUCID_FIPS_REQUIRED;
beforeAll(() => { delete process.env.LUCID_FIPS_REQUIRED; _forceModuleForTest(null); });
afterAll(() => {
  if (savedRequired === undefined) delete process.env.LUCID_FIPS_REQUIRED; else process.env.LUCID_FIPS_REQUIRED = savedRequired;
  _forceModuleForTest(null);
});

/** Deterministic test bytes: SHA-256(label || counter) blocks, so every run feeds identical inputs. */
function det(label: string, n: number): Buffer {
  const out = Buffer.alloc(n);
  for (let i = 0, off = 0; off < n; i++, off += 32) createHash("sha256").update(`${label}:${i}`).digest().copy(out, off);
  return out;
}

const nodeGcm = (key: Buffer, iv: Buffer, pt: Buffer, aad?: Buffer): { ct: Buffer; tag: Buffer } => {
  const c = createCipheriv("aes-256-gcm", key, iv);
  if (aad) c.setAAD(aad);
  const ct = Buffer.concat([c.update(pt), c.final()]);
  return { ct, tag: c.getAuthTag() };
};
const nodeGcmOpen = (key: Buffer, iv: Buffer, ct: Buffer, tag: Buffer, aad?: Buffer): Buffer => {
  const d = createDecipheriv("aes-256-gcm", key, iv);
  if (aad) d.setAAD(aad);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
};

const isWin = process.platform === "win32";
const isBun = typeof Bun !== "undefined";

describe("module selection and self-test", () => {
  test("the power-on known-answer tests pass on the active module", () => {
    const kats = cryptoSelfTest();
    expect(kats.length).toBeGreaterThanOrEqual(7);
    expect(kats.filter((k) => !k.ok)).toEqual([]);
  });

  test.skipIf(!isWin || !isBun)("on Windows under Bun the operations run in CNG, and the FIPS claim follows the ADR-0473 rule", () => {
    const info = cryptoInfo();
    expect(info.module).toBe("windows-cng");
    expect(info.required).toBe(false);
    expect(typeof info.osFipsPolicy === "boolean").toBe(true); // reg.exe answered on a real host
    expect(info.detail).toContain(release());
    if (info.osFipsPolicy === true) expect(info.fips).toBe(true);
    const build = Number(release().split(".")[2]);
    // Only Windows 11 22H2 (22621) and Server 2022 (20348) are claimed without the policy.
    if (build !== 22621 && build !== 20348) expect(info.fips).toBe(info.osFipsPolicy === true);
  });

  test("windowsCngClaim: policy on, or a listed auto-self-test build at its patch level; nothing else", () => {
    expect(windowsCngClaim(true, 19045, 6456).fips).toBe(true);           // Windows 10 22H2, policy on
    expect(windowsCngClaim(false, 19045, 6456).fips).toBe(false);         // Windows 10 22H2, policy off: unlisted
    expect(windowsCngClaim(null, 19045, 6456).fips).toBe(false);          // policy unknown: never claimed
    expect(windowsCngClaim(false, 19043, 2364).fips).toBe(false);         // listed Windows 10 21H1, self-tests need the policy
    expect(windowsCngClaim(false, 22621, 3447).fips).toBe(true);          // Windows 11 22H2 with KB5036893
    expect(windowsCngClaim(false, 22621, 3446).fips).toBe(false);         // ... before it
    expect(windowsCngClaim(false, 22621, null).fips).toBe(false);         // patch level unknown
    expect(windowsCngClaim(false, 20348, 2402).fips).toBe(true);          // Server 2022 with KB5036909
    expect(windowsCngClaim(false, 26100, 7171).fips).toBe(false);         // Windows 11 24H2: not a listed release
    expect(windowsCngClaim(false, 26100, 7171).basis).toContain("not claimed");
    expect(windowsCngClaim(true, 26100, 7171).basis).toContain("not a Microsoft-listed");
  });
});

describe("byte-identical to node:crypto (the no-migration proof)", () => {
  const key = det("gcm-key", 32);
  const iv = det("gcm-iv", 12);
  const lengths = [0, 1, 15, 16, 17, 31, 32, 33, 63, 64, 65, 100, 1000, 4101, 65_539];
  const aads: Array<Buffer | undefined> = [undefined, Buffer.alloc(0), det("aad", 1), det("aad", 13), det("aad", 16), det("aad", 20), det("aad", 71)];

  test("AES-256-GCM ciphertext and tag, with and without AAD, across lengths (0 and non-multiples of 16)", () => {
    for (const n of lengths) {
      const pt = det(`pt-${n}`, n);
      for (const aad of aads) {
        const mine = aesGcmEncrypt(key, iv, pt, aad);
        const ref = nodeGcm(key, iv, pt, aad);
        expect(mine.ct.length).toBe(n);
        expect(mine.tag.length).toBe(16);
        expect(mine.ct.equals(ref.ct)).toBe(true);
        expect(mine.tag.equals(ref.tag)).toBe(true);
        // Each direction opens the other's output.
        expect(aesGcmDecrypt(key, iv, ref.ct, ref.tag, aad).equals(pt)).toBe(true);
        expect(nodeGcmOpen(key, iv, mine.ct, mine.tag, aad).equals(pt)).toBe(true);
      }
    }
  });

  test("PBKDF2-HMAC-SHA256 across password, salt, iteration and output lengths", () => {
    const cases: Array<[number, number, number, number]> = [
      [0, 16, 1, 32], [1, 16, 2, 32], [8, 16, 1000, 32], [24, 36, 4096, 40], [64, 16, 3, 64], [65, 32, 5, 100], [13, 0, 7, 17], [200, 64, 2, 1],
    ];
    for (const [pwLen, saltLen, iters, keyLen] of cases) {
      const pw = det(`pw-${pwLen}`, pwLen);
      const salt = det(`salt-${saltLen}`, saltLen);
      const mine = pbkdf2Sha256(pw, salt, iters, keyLen);
      expect(mine.length).toBe(keyLen);
      expect(mine.equals(pbkdf2Sync(pw, salt, iters, keyLen, "sha256"))).toBe(true);
    }
  });

  test("SHA-256 across lengths around the 64-byte block", () => {
    for (const n of [0, 1, 55, 56, 63, 64, 65, 1000, 1 << 20]) {
      const data = det(`sha-${n}`, n);
      expect(sha256(data).equals(createHash("sha256").update(data).digest())).toBe(true);
    }
  });

  test("HMAC-SHA256 across key lengths (empty, short, block, longer than a block) and data lengths", () => {
    for (const kl of [0, 1, 32, 64, 65, 200]) {
      for (const dl of [0, 1, 100]) {
        const k = det(`hk-${kl}`, kl);
        const d = det(`hd-${dl}`, dl);
        expect(hmacSha256(k, d).equals(createHmac("sha256", k).update(d).digest())).toBe(true);
      }
    }
  });

  test("randomBytes returns the requested length and distinct draws", () => {
    expect(randomBytes(0).length).toBe(0);
    expect(randomBytes(1).length).toBe(1);
    const a = randomBytes(1000), b = randomBytes(1000);
    expect(a.length).toBe(1000);
    expect(a.equals(b)).toBe(false);
  });
});

describe("authentication failures throw", () => {
  const key = det("auth-key", 32);
  const iv = det("auth-iv", 12);
  const pt = det("auth-pt", 77);
  const aad = det("auth-aad", 9);
  const sealed = aesGcmEncrypt(key, iv, pt, aad);

  test("a flipped bit in any tag byte is rejected", () => {
    for (let i = 0; i < 16; i++) {
      const tag = Buffer.from(sealed.tag);
      tag[i] = tag[i]! ^ 0x80;
      expect(() => aesGcmDecrypt(key, iv, sealed.ct, tag, aad)).toThrow(CryptoAuthError);
    }
  });

  test("tampered ciphertext, wrong AAD, missing AAD and a wrong key are rejected", () => {
    const ct = Buffer.from(sealed.ct);
    ct[40] = ct[40]! ^ 0x01;
    expect(() => aesGcmDecrypt(key, iv, ct, sealed.tag, aad)).toThrow(CryptoAuthError);
    expect(() => aesGcmDecrypt(key, iv, sealed.ct, sealed.tag, det("other-aad", 9))).toThrow(CryptoAuthError);
    expect(() => aesGcmDecrypt(key, iv, sealed.ct, sealed.tag)).toThrow(CryptoAuthError);
    expect(() => aesGcmDecrypt(det("wrong-key", 32), iv, sealed.ct, sealed.tag, aad)).toThrow(CryptoAuthError);
    const empty = aesGcmEncrypt(key, iv, Buffer.alloc(0));
    const t = Buffer.from(empty.tag);
    t[15] = t[15]! ^ 0x01;
    expect(() => aesGcmDecrypt(key, iv, Buffer.alloc(0), t)).toThrow(CryptoAuthError);
  });

  test("bad key, iv and tag lengths are refused before any module call", () => {
    expect(() => aesGcmEncrypt(det("k16", 16), iv, pt)).toThrow(RangeError);
    expect(() => aesGcmEncrypt(key, det("iv16", 16), pt)).toThrow(RangeError);
    expect(() => aesGcmDecrypt(key, iv, sealed.ct, sealed.tag.subarray(0, 12), aad)).toThrow(RangeError);
    expect(() => pbkdf2Sha256(Buffer.from("x"), Buffer.alloc(16), 0, 32)).toThrow(RangeError);
  });
});

describe("fail closed when FIPS is required", () => {
  afterAll(() => { delete process.env.LUCID_FIPS_REQUIRED; _forceModuleForTest(null); });

  test("required + no usable validated module: every operation throws FipsRequiredError, cryptoInfo stays honest", () => {
    _forceModuleForTest("bun-boringssl");
    process.env.LUCID_FIPS_REQUIRED = "1";
    expect(fipsRequired()).toBe(true);
    const info = cryptoInfo();
    expect(info).toMatchObject({ module: "bun-boringssl", fips: false, required: true });
    const key = det("fc-key", 32), iv = det("fc-iv", 12);
    expect(() => randomBytes(16)).toThrow(FipsRequiredError);
    expect(() => randomBytes(0)).toThrow(FipsRequiredError);
    expect(() => aesGcmEncrypt(key, iv, Buffer.from("x"))).toThrow(FipsRequiredError);
    expect(() => aesGcmDecrypt(key, iv, Buffer.from("x"), Buffer.alloc(16))).toThrow(FipsRequiredError);
    expect(() => pbkdf2Sha256(Buffer.from("pw"), Buffer.alloc(16), 1, 32)).toThrow(FipsRequiredError);
    expect(() => sha256(Buffer.from("abc"))).toThrow(FipsRequiredError);
    expect(() => hmacSha256(Buffer.from("k"), Buffer.from("d"))).toThrow(FipsRequiredError);
    expect(() => cryptoSelfTest()).toThrow(FipsRequiredError);
    // The personal store has no plaintext path around it either.
    expect(() => encrypt("secret", Buffer.alloc(KEY_LEN))).toThrow(FipsRequiredError);
  });

  test("not required + no native module: node:crypto fallback works and reports fips:false", () => {
    _forceModuleForTest("bun-boringssl");
    delete process.env.LUCID_FIPS_REQUIRED;
    const info = cryptoInfo();
    if (info.required) return; // a managed policy on this host requires FIPS: covered by the test above
    expect(info).toMatchObject({ module: "bun-boringssl", fips: false, required: false });
    const key = det("fb-key", 32), iv = det("fb-iv", 12), pt = det("fb-pt", 33);
    expect(aesGcmEncrypt(key, iv, pt).ct.equals(nodeGcm(key, iv, pt).ct)).toBe(true);
  });

  test("required + the real native module: operations proceed only when its FIPS claim holds", () => {
    _forceModuleForTest(null);
    process.env.LUCID_FIPS_REQUIRED = "1";
    const info = cryptoInfo();
    expect(info.required).toBe(true);
    const op = () => sha256(Buffer.from("abc"));
    if (info.fips) expect(op().toString("hex")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    else expect(op).toThrow(FipsRequiredError);
  });
});

describe("managed policy security.crypto.requireFips", () => {
  test("GPO value CryptoRequireFips and the JSON policy shape parse; only a literal true requires", () => {
    const on = parseRegistryPolicy("HKEY_LOCAL_MACHINE\\Software\\Policies\\LucidAgentIDE\r\n    CryptoRequireFips    REG_DWORD    0x1\r\n");
    expect(on?.security?.crypto).toEqual({ requireFips: true });
    expect(managedRequireFips(on)).toBe(true);
    const off = parseRegistryPolicy("k\r\n    CryptoRequireFips    REG_DWORD    0x0\r\n");
    expect(managedRequireFips(off)).toBe(false);
    expect(managedRequireFips({ security: { crypto: { requireFips: true } } })).toBe(true);
    expect(managedRequireFips({ security: { crypto: { requireFips: "true" as unknown as boolean } } })).toBe(false);
    expect(managedRequireFips(null)).toBe(false);
  });

  test("a policy file knob merges over the registry without dropping requireFips", () => {
    const reg = parseRegistryPolicy("k\r\n    CryptoRequireFips    REG_DWORD    0x1\r\n");
    const merged = mergeManaged(reg, { security: { exec: { lock: true } } });
    expect(managedRequireFips(merged)).toBe(true);
    expect(merged?.security?.exec?.lock).toBe(true);
  });
});

describe("personal-kg.v1: existing stores open unchanged through the provider", () => {
  // The pre-ADR-0473 implementation of harness/personal/crypto.ts, verbatim in behavior (node:crypto).
  const legacyEncrypt = (plaintext: string, key: Buffer, iv: Buffer): Sealed => {
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
    return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ct: ct.toString("base64") };
  };
  const legacyDecrypt = (sealed: Sealed, key: Buffer): Buffer => {
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"));
    d.setAuthTag(Buffer.from(sealed.tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(sealed.ct, "base64")), d.final()]);
  };

  beforeAll(() => { delete process.env.LUCID_FIPS_REQUIRED; _forceModuleForTest(null); });

  test.skipIf(!isWin || !isBun)("the provider under test is the native module, not the node:crypto fallback", () => {
    expect(cryptoInfo().module).toBe("windows-cng");
  });

  test("a blob sealed by the old node:crypto code opens through the new provider, and vice versa", () => {
    const salt = det("kg-salt", 16);
    const legacyKek = pbkdf2Sync(Buffer.from("correct horse battery staple", "utf8"), salt, 1000, KEY_LEN, "sha256");
    expect(deriveKey("correct horse battery staple", salt, 1000).equals(legacyKek)).toBe(true);
    const dek = det("kg-dek", KEY_LEN);
    for (const text of ["", "x", "{\"nodes\":[],\"edges\":[]}", "ü".repeat(1000)]) {
      const old = legacyEncrypt(text, dek, det(`kg-iv-${text.length}`, 12));
      expect(decrypt(old, dek).toString("utf8")).toBe(text);
      expect(legacyDecrypt(encrypt(text, dek), dek).toString("utf8")).toBe(text);
    }
    const tampered = legacyEncrypt("secret graph", dek, det("kg-iv-t", 12));
    const tag = Buffer.from(tampered.tag, "base64");
    tag[0] = tag[0]! ^ 0x01;
    expect(() => decrypt({ ...tampered, tag: tag.toString("base64") }, dek)).toThrow(CryptoAuthError);
  });

  test("the production work factor derives the same KEK as the old pbkdf2Sync path", () => {
    const salt = det("kg-salt-prod", 16);
    expect(deriveKey("passphrase", salt).equals(pbkdf2Sync(Buffer.from("passphrase", "utf8"), salt, KDF_ITERS, KEY_LEN, "sha256"))).toBe(true);
  }, 30_000);
});
