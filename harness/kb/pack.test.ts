// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/kb/pack.test.ts — P-KGPACK.4 (ADR-0205): the pure pack manifest + verify. Pins the TRUST MODEL:
// integrity (db hash must match), signature-as-ORIGIN (present-but-invalid is REFUSED, absent is "unsigned"
// but allowed), the canonical signed payload ignores the signature/key_id fields, and a malformed manifest
// or a missing trusted key both fail closed.

import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { buildManifest, canonicalManifestBytes, sha256Bytes, verifyPackManifest, type PackManifest, type TrustedPackKey } from "./pack.ts";

const kp = generateKeyPairSync("ed25519");
const other = generateKeyPairSync("ed25519");
const trusted: TrustedPackKey[] = [{ id: "techlead187", key: kp.publicKey }];
const signer = (canonical: Buffer) => ({ signature: edSign(null, canonical, kp.privateKey).toString("base64"), keyId: "techlead187" });

const base = { kg: { name: "GovCon Contracts Officer", role: "Contracts Officer" }, author: "TechLead 187 LLC", version: "1.0.0", createdAt: "2026-07-10T00:00:00.000Z", dbSha256: sha256Bytes(Buffer.from("the db bytes")), pageCount: 12 };

describe("sha256Bytes + canonicalManifestBytes", () => {
  test("the canonical payload ignores signature/key_id (so signing is stable)", () => {
    const m = buildManifest(base);
    const before = canonicalManifestBytes(m).toString("utf8");
    const withSig: PackManifest = { ...m, signature: "AAAA", key_id: "x" };
    expect(canonicalManifestBytes(withSig).toString("utf8")).toBe(before); // sig/key_id excluded from the payload
  });
});

describe("buildManifest", () => {
  test("unsigned by default; signs when a signer is supplied", () => {
    const unsigned = buildManifest(base);
    expect(unsigned.signature).toBeUndefined();
    expect(unsigned.format).toBe("lkgpack/1");
    const signed = buildManifest({ ...base, sign: signer });
    expect(signed.signature).toBeTruthy();
    expect(signed.key_id).toBe("techlead187");
  });
});

describe("verifyPackManifest", () => {
  test("an unsigned pack with a matching hash is OK but not `signed`", () => {
    const m = buildManifest(base);
    const v = verifyPackManifest(m, base.dbSha256, trusted);
    expect(v.ok).toBe(true);
    expect(v.signed).toBe(false);
    expect(v.stage).toBe("ok");
  });

  test("a signed pack verifies against the trusted key (signed:true)", () => {
    const m = buildManifest({ ...base, sign: signer });
    const v = verifyPackManifest(m, base.dbSha256, trusted);
    expect(v.ok).toBe(true);
    expect(v.signed).toBe(true);
    expect(v.keyId).toBe("techlead187");
  });

  test("a db-hash mismatch is refused at the integrity stage (tamper/corruption)", () => {
    const m = buildManifest({ ...base, sign: signer });
    const v = verifyPackManifest(m, sha256Bytes(Buffer.from("DIFFERENT bytes")), trusted);
    expect(v.ok).toBe(false);
    expect(v.stage).toBe("integrity");
  });

  test("a PRESENT-but-invalid signature is REFUSED (a forged/wrong-key sig is worse than none)", () => {
    const m = buildManifest({ ...base, sign: signer });
    // hash matches, but the only trusted key is a DIFFERENT keypair → signature can't verify
    const v = verifyPackManifest(m, base.dbSha256, [{ id: "someone-else", key: other.publicKey }]);
    expect(v.ok).toBe(false);
    expect(v.stage).toBe("signature");
  });

  test("a signed pack with NO trusted keys configured is refused (fail-closed)", () => {
    const m = buildManifest({ ...base, sign: signer });
    const v = verifyPackManifest(m, base.dbSha256, []);
    expect(v.ok).toBe(false);
    expect(v.stage).toBe("signature");
  });

  test("a tampered signed payload no longer verifies", () => {
    const m = buildManifest({ ...base, sign: signer });
    const tampered: PackManifest = { ...m, kg: { ...m.kg, name: "Injected Name" } }; // changes the canonical payload
    const v = verifyPackManifest(tampered, base.dbSha256, trusted);
    expect(v.ok).toBe(false);
    expect(v.stage).toBe("signature");
  });

  test("a malformed / wrong-format manifest is refused at the manifest stage", () => {
    expect(verifyPackManifest({ ...buildManifest(base), format: "nope" }, base.dbSha256, trusted).stage).toBe("manifest");
    expect(verifyPackManifest({ ...buildManifest(base), kg: { name: "" } }, base.dbSha256, trusted).stage).toBe("manifest");
  });
});
