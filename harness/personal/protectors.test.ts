// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/personal/protectors.test.ts - P-KGBIO.1 (ADR-0454): the Lucid Vault Protector Spec v1 file.
// HUB_FILE below was written by the Hub's own src/vault_protectors.py (LUCIDMeetingHub main, 2026-10-23), so
// these tests fail the moment this implementation drifts from the format the Hub reads and writes.

import { expect, test } from "bun:test";
import { deriveKey } from "./crypto.ts";
import {
  createProtectors, newEntry, parseProtectors, ProtectorError, rewrapPassword, unlockWithPassword, unwrapEntry, withProtector, withoutProtector,
  type ProtectorDoc,
} from "./protectors.ts";

const HUB_VMK = Buffer.from("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff", "hex");
const HUB_FILE = `{
  "version": 1,
  "vmk_check": "gAAAAABq2taxi9OS9-PSziVV-dyzwSUVM_MYEHoXC1pVVLRH_W9Y-Pch7o1qXDI38lpBRjRbf2rRcd2nZw8UwjbykMPLMS9rKg==",
  "protectors": [
    {
      "id": "01326f81d7f7681d",
      "type": "password",
      "created": "2026-10-23T03:38:25Z",
      "label": "Password",
      "kdf": { "alg": "pbkdf2-sha256", "iterations": 600000, "salt": "uBmRdma3qT2CMHRLo51Ua+eTM9kXEXQtMzHBczHogwE=" },
      "wrapped_vmk": "l6isi5hh6aaWtO8PGE/4TL6KfeO6Nj4sWbD6WXHbBwI9GMtDLH+2bnfDIjIgnPIx",
      "nonce": "7T1qFo2dqBU6IO1C"
    }
  ]
}`;
const codeOf = (run: () => unknown): string => {
  try { run(); return "no-throw"; } catch (e) { return e instanceof ProtectorError ? e.code : `other:${String(e)}`; }
};
const mutate = (f: (d: Record<string, any>) => void): string => { const d = JSON.parse(HUB_FILE); f(d); return JSON.stringify(d); };

test("a file written by the Hub opens with its password and refuses a wrong one", () => {
  const doc = parseProtectors(HUB_FILE);
  expect(unlockWithPassword(doc, "correct-horse-battery").equals(HUB_VMK)).toBe(true);
  expect(codeOf(() => unlockWithPassword(doc, "wrong-password"))).toBe("auth");
});

test("a wrap is bound to its entry: the password blob pasted into another entry does not unwrap", () => {
  const doc = parseProtectors(HUB_FILE);
  const pw = doc.protectors[0]!;
  const kek = deriveKey("correct-horse-battery", Buffer.from(pw.kdf!.salt, "base64"), pw.kdf!.iterations);
  const moved = { ...pw, id: "ffffffffffffffff", type: "hello" as const, kdf: undefined, challenge: "AAAA", key_name: "k" };
  expect(codeOf(() => unwrapEntry(doc, moved, kek))).toBe("auth");
  expect(unwrapEntry(doc, pw, kek).equals(HUB_VMK)).toBe(true);
});

test("the vmk_check proves the key: an entry from another vault is refused before any data opens", () => {
  const other = createProtectors(Buffer.alloc(32, 9), "correct-horse-battery");
  const crossed: ProtectorDoc = { ...parseProtectors(HUB_FILE), protectors: other.protectors };
  expect(codeOf(() => unlockWithPassword(crossed, "correct-horse-battery"))).toBe("format");
});

test("fail closed on every malformed or unknown shape", () => {
  expect(codeOf(() => parseProtectors("not json"))).toBe("format");
  expect(codeOf(() => parseProtectors(mutate((d) => { d.version = 2; })))).toBe("version");
  expect(codeOf(() => parseProtectors(mutate((d) => { d.protectors[0].type = "piv"; })))).toBe("unsupported"); // CAC: not built yet
  expect(codeOf(() => parseProtectors(mutate((d) => { delete d.vmk_check; })))).toBe("format");
  expect(codeOf(() => parseProtectors(mutate((d) => { d.protectors = []; })))).toBe("format");
  expect(codeOf(() => parseProtectors(mutate((d) => { d.protectors.push({ ...d.protectors[0] }); })))).toBe("format"); // duplicate id
  expect(codeOf(() => parseProtectors(mutate((d) => { d.protectors.push({ ...d.protectors[0], id: "aa" }); })))).toBe("format"); // two passwords
  expect(codeOf(() => parseProtectors(mutate((d) => { d.protectors[0].kdf.iterations = 50_000_000; })))).toBe("format");
  expect(codeOf(() => parseProtectors(mutate((d) => { d.protectors[0].nonce = "%%%"; })))).toBe("format");
  expect(codeOf(() => parseProtectors(mutate((d) => { d.protectors.push({ id: "bb", type: "hello", created: "x", label: "Hello", wrapped_vmk: "AAAA", nonce: "AAAA" }); })))).toBe("format"); // hello without challenge
});

test("a password change re-wraps the same VMK: the old password stops, other protectors keep working", () => {
  const vmk = Buffer.alloc(32, 5);
  const deviceKek = Buffer.alloc(32, 7);
  const doc = withProtector(createProtectors(vmk, "old-password"), newEntry(deviceKek, vmk, "hello", "Windows Hello", { challenge: "AAAA", key_name: "k" }));
  const pwId = doc.protectors[0]!.id;
  const next = rewrapPassword(doc, vmk, "new-password");
  expect(codeOf(() => unlockWithPassword(next, "old-password"))).toBe("auth");
  expect(unlockWithPassword(next, "new-password").equals(vmk)).toBe(true);
  expect(next.protectors.find((e) => e.type === "password")!.id).toBe(pwId);
  expect(unwrapEntry(next, next.protectors.find((e) => e.type === "hello")!, deviceKek).equals(vmk)).toBe(true);
});

test("the password protector is irremovable; a device type has at most one entry", () => {
  const vmk = Buffer.alloc(32, 5);
  const doc = createProtectors(vmk, "a-password");
  expect(codeOf(() => withProtector(doc, newEntry(Buffer.alloc(32, 1), vmk, "password", "Password")))).toBe("format");
  const once = withProtector(doc, newEntry(Buffer.alloc(32, 1), vmk, "hello", "Windows Hello", { challenge: "AAAA", key_name: "a" }));
  const twice = withProtector(once, newEntry(Buffer.alloc(32, 2), vmk, "hello", "Windows Hello", { challenge: "AAAA", key_name: "b" }));
  expect(twice.protectors.filter((e) => e.type === "hello").map((e) => e.key_name)).toEqual(["b"]);
  expect(withoutProtector(twice, "hello").protectors.map((e) => e.type)).toEqual(["password"]);
  expect(parseProtectors(JSON.stringify(twice)).protectors.length).toBe(2);
});
