// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/kg_device_unlock.test.ts - P-KGBIO.1 (ADR-0454): Windows Hello / Touch ID unlock of the knowledge
// graph. A fake provider stands in for the TPM / Keychain; the store is real (temp dir), so a released DEK is
// proven by actually opening the encrypted graph. Isolation: LUCID_PERSONAL_DIR points at the temp dir.

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, hkdfSync } from "node:crypto";
import { PersonalStore } from "../harness/personal/store.ts";
import {
  dekFromPassphrase, DeviceUnlockError, helloError, HELLO_MARK, KgDeviceUnlock, macTouchIdProvider, parseHelloReply, windowsHelloProvider,
  type DeviceKeyProvider, type DeviceUnlockCode,
} from "./kg_device_unlock.ts";
import { lockPersonal, personalStatus, unlockPersonalWithKey } from "./personal.ts";

const PASS = "correct-horse-battery";
let dir = "";
const saved = process.env.LUCID_PERSONAL_DIR;
const storePath = () => join(dir, "lucid-personal.kg.enc");
const recordPath = () => join(dir, "lucid-personal.kg.device.json");
const io = {
  read: (p: string) => { try { return readFileSync(p, "utf8"); } catch { return null; } },
  write: (p: string, t: string) => writeFileSync(p, t),
  remove: (p: string) => rmSync(p, { force: true }),
};

/** A fake OS verifier: the KEK is a hash of an enrollment nonce, released only when `allow` says so. */
function fakeProvider(opts: { available?: boolean } = {}) {
  const calls = { create: 0, open: 0, destroy: 0 };
  let deny: DeviceUnlockCode | null = null;
  const kekOf = (nonce: string) => createHash("sha256").update(nonce).digest();
  const p: DeviceKeyProvider = {
    kind: "windows-hello", label: "Windows Hello",
    available: async () => opts.available ?? true,
    create: async () => { calls.create++; const nonce = String(Math.random()); return { kek: kekOf(nonce), params: { nonce } }; },
    open: async (params) => { calls.open++; if (deny) throw new DeviceUnlockError(deny, "denied"); return kekOf(params.nonce ?? ""); },
    destroy: async () => { calls.destroy++; },
  };
  return { p, calls, refuse: (code: DeviceUnlockCode | null) => { deny = code; } };
}
const codeOf = async (run: () => Promise<unknown>): Promise<string> => {
  try { await run(); return "no-throw"; } catch (e) { return e instanceof DeviceUnlockError ? e.code : `other:${String(e)}`; }
};
function newStore(passphrase = PASS): void {
  rmSync(storePath(), { force: true });
  const s = PersonalStore.createWithPassphrase(storePath(), passphrase);
  s.addFact({ entityId: s.upsertEntity("dark mode", "user:preference", "trusted"), statement: "prefers dark mode", trustLabel: "trusted" });
  s.save(); s.lock();
}

beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "lucid-kgbio-")); process.env.LUCID_PERSONAL_DIR = dir; });
afterAll(() => {
  lockPersonal();
  if (saved === undefined) delete process.env.LUCID_PERSONAL_DIR; else process.env.LUCID_PERSONAL_DIR = saved;
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => { lockPersonal(); rmSync(recordPath(), { force: true }); newStore(); });

test("a passphrase store opened with its DEK keeps the passphrase envelope on save", () => {
  const { dek } = dekFromPassphrase(io.read(storePath()), PASS);
  const s = PersonalStore.openWithKey(storePath(), dek);
  s.addFact({ entityId: s.upsertEntity("k", "user:goal", "trusted"), statement: "ship P-KGBIO.1", trustLabel: "trusted" });
  s.save();
  expect(PersonalStore.openWithPassphrase(storePath(), PASS).graph().facts.length).toBe(2);
});

test("enroll refuses a wrong passphrase before any OS prompt and writes nothing", async () => {
  const f = fakeProvider();
  const du = new KgDeviceUnlock({ provider: f.p, io, storePath, recordPath });
  expect(await codeOf(() => du.enroll("not-the-passphrase"))).toBe("wrong-passphrase");
  expect(f.calls.create).toBe(0);
  expect(io.read(recordPath())).toBeNull();
  expect((await du.status()).enrolled).toBe(false);
});

test("enroll then unlock releases the DEK that opens the real store; the record holds no usable key", async () => {
  const f = fakeProvider();
  const du = new KgDeviceUnlock({ provider: f.p, io, storePath, recordPath });
  const enrolled = await du.enroll(PASS);
  expect(await du.status()).toMatchObject({ supported: true, enrolled: true, autoUnlock: true, stale: false, label: "Windows Hello" });
  const dek = await du.unlock();
  expect(dek.equals(enrolled)).toBe(true);
  expect(PersonalStore.openWithKey(storePath(), dek).graph().facts[0]?.statement).toBe("prefers dark mode");
  expect(io.read(recordPath())).not.toContain(enrolled.toString("base64"));
});

test("a re-created store makes the record stale and unlock never prompts", async () => {
  const f = fakeProvider();
  const du = new KgDeviceUnlock({ provider: f.p, io, storePath, recordPath });
  await du.enroll(PASS);
  newStore("a-different-passphrase");
  expect(await du.status()).toMatchObject({ enrolled: false, stale: true, autoUnlock: false });
  expect(await codeOf(() => du.unlock())).toBe("stale");
  expect(f.calls.open).toBe(0);
});

test("re-enrolling after the store changed destroys the old OS key first", async () => {
  const f = fakeProvider();
  const du = new KgDeviceUnlock({ provider: f.p, io, storePath, recordPath });
  await du.enroll(PASS);
  newStore("a-different-passphrase");
  await du.enroll("a-different-passphrase");
  expect(f.calls.destroy).toBe(1);
  expect((await du.status()).enrolled).toBe(true);
});

test("an OS cancel surfaces as cancelled; a tampered record as stale", async () => {
  const f = fakeProvider();
  const du = new KgDeviceUnlock({ provider: f.p, io, storePath, recordPath });
  await du.enroll(PASS);
  f.refuse("cancelled");
  expect(await codeOf(() => du.unlock())).toBe("cancelled");
  f.refuse(null);
  const rec = JSON.parse(io.read(recordPath())!);
  io.write(recordPath(), JSON.stringify({ ...rec, params: { nonce: "someone-else" } }));
  expect(await codeOf(() => du.unlock())).toBe("stale");
});

test("auto-unlock toggles; forget removes the OS key and the record, passphrase unaffected", async () => {
  const f = fakeProvider();
  const du = new KgDeviceUnlock({ provider: f.p, io, storePath, recordPath });
  expect(du.setAutoUnlock(false)).toBe(false); // nothing enrolled
  await du.enroll(PASS, { autoUnlock: false });
  expect((await du.status()).autoUnlock).toBe(false);
  expect(du.setAutoUnlock(true)).toBe(true);
  expect((await du.status()).autoUnlock).toBe(true);
  await du.forget();
  expect(f.calls.destroy).toBe(1);
  expect(await du.status()).toMatchObject({ enrolled: false, stale: false });
  expect(await codeOf(() => du.unlock())).toBe("not-enrolled");
  expect(PersonalStore.openWithPassphrase(storePath(), PASS).graph().facts.length).toBe(1);
});

test("no provider or an unavailable one: unsupported, never a prompt", async () => {
  expect(await codeOf(() => new KgDeviceUnlock({ provider: null, io, storePath, recordPath }).enroll(PASS))).toBe("unsupported");
  const f = fakeProvider({ available: false });
  const du = new KgDeviceUnlock({ provider: f.p, io, storePath, recordPath });
  expect(await codeOf(() => du.enroll(PASS))).toBe("unsupported");
  expect((await du.status()).supported).toBe(false);
});

test("the engine unlocks the main store with the released DEK, and only that DEK", async () => {
  const du = new KgDeviceUnlock({ provider: fakeProvider().p, io, storePath, recordPath });
  const dek = await du.enroll(PASS);
  expect(unlockPersonalWithKey(Buffer.alloc(31).toString("base64")).ok).toBe(false);
  expect(unlockPersonalWithKey(Buffer.alloc(32, 7).toString("base64")).ok).toBe(false);
  expect(personalStatus().unlocked).toBe(false);
  expect(unlockPersonalWithKey(dek.toString("base64")).ok).toBe(true);
  expect(personalStatus().unlocked).toBe(true);
});

// ── Windows Hello bridge (the PowerShell half runs only on a real machine; see the demo) ──
test("hello reply: the marker line wins over host noise; no marker reads as failure", () => {
  expect(parseHelloReply(`WARNING: noise\r\n${HELLO_MARK}{"ok":true,"signature":"c2ln"}\r\n`)).toEqual({ ok: true, signature: "c2ln" });
  expect(parseHelloReply("", "Cannot invoke method. Method invocation is supported only on core types in this language mode.").status).toBe("ConstrainedLanguage");
  expect(parseHelloReply("garbage").ok).toBe(false);
});

test("hello statuses map to what the UI does with them", () => {
  expect(helloError({ ok: false, status: "UserCanceled" }).code).toBe("cancelled");
  expect(helloError({ ok: false, status: "NotFound" }).code).toBe("not-enrolled");
  expect(helloError({ ok: false, status: "ConstrainedLanguage" }).code).toBe("unsupported");
  expect(helloError({ ok: false, status: "SecurityDeviceLocked" }).code).toBe("failed");
});

test("windows provider: the KEK is HKDF(signature, salt), so the same Hello signature reopens it", async () => {
  const seen: Record<string, string>[] = [];
  const sig = Buffer.from("deterministic-rsa-pkcs1-signature").toString("base64");
  const p = windowsHelloProvider(async (env) => { seen.push(env); return { stdout: `${HELLO_MARK}${JSON.stringify({ ok: true, signature: sig })}\n`, stderr: "" }; });
  const { kek, params } = await p.create("0123456789abcdef");
  expect(seen[0]).toMatchObject({ LUCID_HELLO_OP: "create", LUCID_HELLO_KEY: "LUCID Knowledge Graph 0123456789ab", LUCID_HELLO_CHALLENGE: params.challenge });
  expect(kek.equals(Buffer.from(hkdfSync("sha256", Buffer.from(sig, "base64"), Buffer.from(params.salt!, "base64"), "lucid-kg-device.v1/windows-hello", 32)))).toBe(true);
  expect((await p.open(params)).equals(kek)).toBe(true);
  expect(seen[1]?.LUCID_HELLO_OP).toBe("sign");
});

test("touch id provider: the sealed KEK is released only after the prompt succeeds", async () => {
  let allow = true;
  const seal = { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(`sealed:${s}`), decryptString: (b: Buffer) => b.toString().slice(7) };
  const p = macTouchIdProvider({ canPromptTouchID: () => true, promptTouchID: async () => { if (!allow) throw new Error("User canceled"); } }, seal);
  const { kek, params } = await p.create("id");
  expect((await p.open(params)).equals(kek)).toBe(true);
  allow = false;
  expect(await codeOf(() => p.open(params))).toBe("cancelled");
});
