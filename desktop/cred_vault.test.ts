// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/cred_vault.test.ts — P-NETWL.1 (ADR-0106): the OS-encrypted credential vault. The load-bearing
// assertion is FAIL-CLOSED: with OS encryption unavailable, storing a secret THROWS and NOTHING is written -
// there is no plaintext fallback. Also: the on-disk blob is opaque (never the plaintext), and decrypt is a
// roundtrip.

import { describe, expect, test } from "bun:test";
import {
  deleteCredential, deriveLast4, isValidRef, listCredentials, readCredential, rotateCredential,
  rotationLabel, rotationStatus, storeCredential, type SafeStorageLike, type VaultIo,
} from "./cred_vault.ts";

// A fake safeStorage: reversible but genuinely OBSCURING (base64), so the blob never literally contains the
// plaintext - mirroring how a real OS keystore produces opaque ciphertext.
const fakeSafe = (available = true): SafeStorageLike => ({
  isEncryptionAvailable: () => available,
  encryptString: (s) => Buffer.from("v1:" + Buffer.from(s, "utf8").toString("base64"), "utf8"),
  decryptString: (b) => { const t = b.toString("utf8"); if (!t.startsWith("v1:")) throw new Error("bad"); return Buffer.from(t.slice(3), "base64").toString("utf8"); },
});

// An in-memory VaultIo.
function memIo(): VaultIo & { files: Map<string, Buffer> } {
  const files = new Map<string, Buffer>();
  return {
    files,
    ensureDir: () => {},
    writeFile: (p, data) => { files.set(p, Buffer.from(data)); },
    readFile: (p) => { const b = files.get(p); if (!b) throw new Error("ENOENT"); return b; },
    exists: (p) => files.has(p),
    remove: (p) => { files.delete(p); },
    list: (dir) => [...files.keys()].filter((k) => k.startsWith(dir + "/")).map((k) => k.slice(dir.length + 1)),
  };
}

const DIR = "/vault";

describe("deriveLast4 (P-KEYS.1) — identify a key, never reveal it", () => {
  test("returns at most the last 4 chars; trailing whitespace ignored; short secret as-is", () => {
    expect(deriveLast4("sk-live-abcdEF99")).toBe("EF99");
    expect(deriveLast4("abcdef")).toBe("cdef");
    expect(deriveLast4("token-value\n\n")).toBe("alue");
    expect(deriveLast4("ab")).toBe("ab");   // shorter than 4 (never a real secret) → as-is
    expect(deriveLast4("")).toBe("");
    expect(deriveLast4("wxyz").length).toBeLessThanOrEqual(4);
  });
  test("PEM uses the base64 body's last 4 (armor + whitespace stripped), so it IDs the key not the header", () => {
    const pem = "-----BEGIN PRIVATE KEY-----\nMIIBVAIBADANBg==\n-----END PRIVATE KEY-----\n";
    expect(deriveLast4(pem, "pem")).toBe("Bg==");
  });
});

describe("isValidRef", () => {
  test("accepts safe handles, rejects traversal / bad chars / empty", () => {
    expect(isValidRef("cred_jwt_abc-123")).toBe(true);
    expect(isValidRef("../escape")).toBe(false);
    expect(isValidRef("a/b")).toBe(false);
    expect(isValidRef("has space")).toBe(false);
    expect(isValidRef("")).toBe(false);
  });
});

describe("storeCredential — fail-closed when OS encryption is unavailable", () => {
  test("throws and writes NOTHING (no plaintext fallback)", () => {
    const io = memIo();
    expect(() => storeCredential(fakeSafe(false), io, DIR, { ref: "r1", kind: "jwt", secret: "S3CRET" }))
      .toThrow("os-encryption-unavailable");
    expect(io.files.size).toBe(0);
  });
});

describe("storeCredential / readCredential — happy path", () => {
  test("the on-disk blob is opaque (never the plaintext) and decrypt roundtrips", () => {
    const io = memIo();
    const ss = fakeSafe(true);
    const meta = storeCredential(ss, io, DIR, { ref: "r1", kind: "jwt", secret: "S3CRET", label: "prod" });
    expect(meta).toMatchObject({ ref: "r1", kind: "jwt", label: "prod" });
    const blob = io.files.get(`${DIR}/r1.bin`)!.toString("utf8");
    expect(blob).not.toContain("S3CRET");     // never plaintext at rest
    expect(readCredential(ss, io, DIR, "r1")).toBe("S3CRET"); // main-side decrypt roundtrips
  });
  test("mints a valid ref when none is supplied", () => {
    const io = memIo();
    const meta = storeCredential(fakeSafe(true), io, DIR, { kind: "apikey", secret: "k" });
    expect(isValidRef(meta.ref)).toBe(true);
    expect(meta.ref.startsWith("cred_apikey_")).toBe(true);
  });
  test("rejects an invalid ref and an empty secret", () => {
    const io = memIo();
    expect(() => storeCredential(fakeSafe(true), io, DIR, { ref: "../x", kind: "jwt", secret: "s" })).toThrow("invalid-ref");
    expect(() => storeCredential(fakeSafe(true), io, DIR, { ref: "ok", kind: "jwt", secret: "" })).toThrow("empty-secret");
  });
});

describe("readCredential — fail-closed reads", () => {
  test("unknown ref, invalid ref, and unavailable encryption all → null", () => {
    const io = memIo();
    storeCredential(fakeSafe(true), io, DIR, { ref: "r1", kind: "jwt", secret: "s" });
    expect(readCredential(fakeSafe(true), io, DIR, "nope")).toBeNull();
    expect(readCredential(fakeSafe(true), io, DIR, "../escape")).toBeNull();
    expect(readCredential(fakeSafe(false), io, DIR, "r1")).toBeNull(); // no decrypt when unavailable
  });
});

describe("rotateCredential (P-KEYS.2) — replace in place, fail-closed", () => {
  test("re-encrypts under the SAME ref, bumps rotatedAt + last4, preserves createdAt/label/kind/interval", () => {
    const io = memIo(); const ss = fakeSafe(true);
    storeCredential(ss, io, DIR, { ref: "k1", kind: "jwt", secret: "old-secret-AAAA", label: "prod", createdAt: 1000, rotationIntervalDays: 30 });
    const m = rotateCredential(ss, io, DIR, { ref: "k1", secret: "new-secret-BBBB", rotatedAt: 5000 });
    expect(m).not.toBeNull();
    expect(m!).toMatchObject({ ref: "k1", kind: "jwt", label: "prod", createdAt: 1000, rotatedAt: 5000, last4: "BBBB", rotationIntervalDays: 30 });
    expect(readCredential(ss, io, DIR, "k1")).toBe("new-secret-BBBB"); // decrypts to the NEW secret
    expect(io.files.get(`${DIR}/k1.bin`)!.toString("utf8")).not.toContain("old-secret"); // old ciphertext overwritten
  });
  test("unknown ref → null, nothing written", () => {
    const io = memIo();
    expect(rotateCredential(fakeSafe(true), io, DIR, { ref: "nope", secret: "x", rotatedAt: 1 })).toBeNull();
    expect(io.files.size).toBe(0);
  });
  test("fail-closed: encryption unavailable → throws and the OLD secret is left intact", () => {
    const io = memIo();
    storeCredential(fakeSafe(true), io, DIR, { ref: "k1", kind: "apikey", secret: "keep-me-OLD", createdAt: 1 });
    expect(() => rotateCredential(fakeSafe(false), io, DIR, { ref: "k1", secret: "new", rotatedAt: 2 })).toThrow("os-encryption-unavailable");
    expect(readCredential(fakeSafe(true), io, DIR, "k1")).toBe("keep-me-OLD"); // untouched
  });
  test("empty new secret → throws", () => {
    const io = memIo();
    storeCredential(fakeSafe(true), io, DIR, { ref: "k1", kind: "jwt", secret: "old", createdAt: 1 });
    expect(() => rotateCredential(fakeSafe(true), io, DIR, { ref: "k1", secret: "", rotatedAt: 2 })).toThrow("empty-secret");
  });
});

describe("rotationStatus / rotationLabel (P-KEYS.2)", () => {
  const DAY = 86_400_000;
  test("age / overdue / due / expiry math", () => {
    const now = 100 * DAY;
    expect(rotationStatus({ rotatedAt: 60 * DAY, rotationIntervalDays: 30 }, now)).toMatchObject({ ageDays: 40, overdue: true });
    expect(rotationStatus({ rotatedAt: 95 * DAY, rotationIntervalDays: 30 }, now)).toMatchObject({ ageDays: 5, overdue: false, dueInDays: 25 });
    expect(rotationStatus({ rotatedAt: 99 * DAY, expiresAt: 90 * DAY }, now).expired).toBe(true);
    expect(rotationStatus({ createdAt: 98 * DAY }, now)).toMatchObject({ ageDays: 2, overdue: false }); // rotatedAt falls back to createdAt
  });
  test("label — worst state wins", () => {
    expect(rotationLabel({ overdue: false, expired: true })).toMatchObject({ text: "expired", tone: "danger" });
    expect(rotationLabel({ overdue: true, expired: false })).toMatchObject({ text: "rotation due", tone: "danger" });
    expect(rotationLabel({ overdue: false, expired: false, expiresInDays: 3 }).tone).toBe("warn");
    expect(rotationLabel({ overdue: false, expired: false, dueInDays: 2 }).tone).toBe("warn");
    expect(rotationLabel({ overdue: false, expired: false, ageDays: 12 })).toMatchObject({ text: "rotated 12d ago", tone: "ok" });
  });
});

describe("listCredentials / deleteCredential", () => {
  test("list returns metadata only (incl. last4); delete removes blob + meta", () => {
    const io = memIo();
    const ss = fakeSafe(true);
    storeCredential(ss, io, DIR, { ref: "a", kind: "jwt", secret: "jwt-body-AAAA", label: "one" });
    storeCredential(ss, io, DIR, { ref: "b", kind: "pem", secret: "pem-body-BBBB" });
    const list = listCredentials(io, DIR).sort((x, y) => x.ref.localeCompare(y.ref));
    expect(list.map((m) => m.ref)).toEqual(["a", "b"]);
    expect(list[0]).toMatchObject({ ref: "a", kind: "jwt", label: "one", last4: "AAAA" }); // last4 surfaced
    expect(JSON.stringify(list)).not.toContain("jwt-body"); // the FULL secret never leaks - only last4
    expect(deleteCredential(io, DIR, "a")).toBe(true);
    expect(io.files.has(`${DIR}/a.bin`)).toBe(false);
    expect(io.files.has(`${DIR}/a.meta.json`)).toBe(false);
    expect(deleteCredential(io, DIR, "a")).toBe(false); // already gone
    expect(listCredentials(io, DIR).map((m) => m.ref)).toEqual(["b"]);
  });
  test("list on an empty/absent dir is []", () => {
    expect(listCredentials(memIo(), DIR)).toEqual([]);
  });
});
