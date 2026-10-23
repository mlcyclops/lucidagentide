// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/kg_device_unlock.test.ts - P-KGBIO.1 (ADR-0454): Windows Hello / Touch ID as protectors in the main
// store's Protector Spec v1 file, and the engine's protector-first unlock with the legacy migration. A fake
// provider stands in for the TPM / Keychain; the store is real (temp dir), so every released key is proven by
// opening the encrypted graph. Isolation: LUCID_PERSONAL_DIR and LUCID_GUI_SETTINGS_FILE point at the temp dir.

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, hkdfSync } from "node:crypto";
import { PersonalStore } from "../harness/personal/store.ts";
import { readProtectors, unlockWithPassword } from "../harness/personal/protectors.ts";
import {
  DeviceUnlockError, helloError, HELLO_MARK, KgDeviceUnlock, macTouchIdProvider, parseHelloReply, windowsHelloProvider,
  type DeviceKeyProvider, type DeviceUnlockCode,
} from "./kg_device_unlock.ts";
import { lockPersonal, personalStatus, setupPersonal, unlockPersonal, unlockPersonalWithKey } from "./personal.ts";

const PASS = "correct-horse-battery";
let dir = "";
const saved = { personal: process.env.LUCID_PERSONAL_DIR, settings: process.env.LUCID_GUI_SETTINGS_FILE };
const storePath = () => join(dir, "lucid-personal.kg.enc");
const protectorsPath = () => join(dir, "lucid-personal.kg.protectors.json");

/** A fake OS verifier: the KEK is a hash of a per-entry nonce, released only while not refused. */
function fakeProvider(opts: { available?: boolean } = {}) {
  const calls = { create: 0, open: 0, destroyed: [] as string[] };
  let deny: DeviceUnlockCode | null = null;
  const kekOf = (nonce: string) => createHash("sha256").update(nonce).digest();
  const p: DeviceKeyProvider = {
    type: "hello", label: "Windows Hello",
    available: async () => opts.available ?? true,
    create: async (id) => { calls.create++; return { kek: kekOf(id), fields: { challenge: "AAAA", key_name: `k-${id}` } }; },
    open: async (entry) => { calls.open++; if (deny) throw new DeviceUnlockError(deny, "denied"); return kekOf(entry.id); },
    destroy: async (entry) => { calls.destroyed.push(String(entry.key_name)); },
  };
  return { p, calls, refuse: (code: DeviceUnlockCode | null) => { deny = code; } };
}
const codeOf = async (run: () => Promise<unknown>): Promise<string> => {
  try { await run(); return "no-throw"; } catch (e) { return e instanceof DeviceUnlockError ? e.code : `other:${String(e)}`; }
};
const doc = () => readProtectors(protectorsPath());
/** A pre-ADR-0454 store: the passphrase envelope only, no protector file. */
function legacyStore(passphrase = PASS): void {
  const s = PersonalStore.createWithPassphrase(storePath(), passphrase);
  s.addFact({ entityId: s.upsertEntity("dark mode", "user:preference", "trusted"), statement: "prefers dark mode", trustLabel: "trusted" });
  s.save(); s.lock();
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lucid-kgbio-"));
  process.env.LUCID_PERSONAL_DIR = dir;
  process.env.LUCID_GUI_SETTINGS_FILE = join(dir, "gui.json");
});
afterAll(() => {
  lockPersonal();
  for (const [k, v] of [["LUCID_PERSONAL_DIR", saved.personal], ["LUCID_GUI_SETTINGS_FILE", saved.settings]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  lockPersonal();
  for (const p of [storePath(), protectorsPath()]) rmSync(p, { force: true });
  expect(setupPersonal(PASS).ok).toBe(true);
  lockPersonal();
});

// ── the engine: protector-first unlock, legacy migration ──
test("setup writes a protector file whose password unwraps the store key", () => {
  const d = doc()!;
  expect(d.protectors.map((e) => e.type)).toEqual(["password"]);
  expect(PersonalStore.openWithKey(storePath(), unlockWithPassword(d, PASS)).graph().facts.length).toBe(0);
  expect(unlockPersonal("wrong-passphrase").ok).toBe(false);
  expect(unlockPersonal(PASS).ok).toBe(true);
});

test("a legacy store migrates on its first unlock with zero re-encryption, and still opens on its envelope", () => {
  for (const p of [storePath(), protectorsPath()]) rmSync(p, { force: true });
  legacyStore();
  const before = readFileSync(storePath(), "utf8");
  expect(unlockPersonal(PASS).ok).toBe(true);
  expect(readFileSync(storePath(), "utf8")).toBe(before); // the store file was not rewritten
  expect(PersonalStore.openWithKey(storePath(), unlockWithPassword(doc()!, PASS)).graph().facts[0]?.statement).toBe("prefers dark mode");
  expect(PersonalStore.openWithPassphrase(storePath(), PASS).graph().facts.length).toBe(1); // an older build still opens it
});

test("a malformed protector file is fatal: no quiet fall back to the envelope", () => {
  writeFileSync(protectorsPath(), JSON.stringify({ version: 2, vmk_check: "x", protectors: [] }));
  const r = unlockPersonal(PASS);
  expect(r.ok).toBe(false);
  expect(r.error).toContain("unusable");
  expect(personalStatus().unlocked).toBe(false);
});

test("a fresh setup replaces an orphaned protector file, and its device entry with it", async () => {
  const f = fakeProvider();
  await new KgDeviceUnlock({ provider: f.p, protectorsPath }).enroll(PASS);
  rmSync(storePath());
  expect(setupPersonal("a-new-passphrase").ok).toBe(true);
  expect(doc()!.protectors.map((e) => e.type)).toEqual(["password"]);
});

// ── device protectors ──
test("enroll refuses a wrong passphrase before any OS prompt and leaves the file as it was", async () => {
  const f = fakeProvider();
  const before = readFileSync(protectorsPath(), "utf8");
  expect(await codeOf(() => new KgDeviceUnlock({ provider: f.p, protectorsPath }).enroll("not-the-passphrase"))).toBe("wrong-passphrase");
  expect(f.calls.create).toBe(0);
  expect(readFileSync(protectorsPath(), "utf8")).toBe(before);
});

test("enroll adds a hello entry; one OS check then releases the key the engine opens the store with", async () => {
  const f = fakeProvider();
  const du = new KgDeviceUnlock({ provider: f.p, protectorsPath });
  (await du.enroll(PASS)).fill(0);
  expect(doc()!.protectors.map((e) => e.type)).toEqual(["password", "hello"]);
  expect(await du.status()).toMatchObject({ supported: true, enrolled: true, autoUnlock: true, problem: null, label: "Windows Hello" });
  const vmk = await du.unlock();
  expect(unlockPersonalWithKey(Buffer.alloc(31).toString("base64")).ok).toBe(false);
  expect(unlockPersonalWithKey(Buffer.alloc(32, 7).toString("base64")).ok).toBe(false);
  expect(unlockPersonalWithKey(vmk.toString("base64")).ok).toBe(true);
  expect(personalStatus().unlocked).toBe(true);
  lockPersonal();
  expect(unlockPersonal(PASS).ok).toBe(true); // the password protector still works
});

test("re-enrolling replaces the entry and only then destroys the previous OS key", async () => {
  const f = fakeProvider();
  const du = new KgDeviceUnlock({ provider: f.p, protectorsPath });
  await du.enroll(PASS);
  const first = String(doc()!.protectors.find((e) => e.type === "hello")!.key_name);
  await du.enroll(PASS);
  const second = String(doc()!.protectors.find((e) => e.type === "hello")!.key_name);
  expect(second).not.toBe(first);
  expect(f.calls.destroyed).toEqual([first]);
  expect(doc()!.protectors.filter((e) => e.type === "hello").length).toBe(1);
});

test("an OS cancel surfaces as cancelled; a swapped blob as mismatch", async () => {
  const f = fakeProvider();
  const du = new KgDeviceUnlock({ provider: f.p, protectorsPath });
  await du.enroll(PASS);
  f.refuse("cancelled");
  expect(await codeOf(() => du.unlock())).toBe("cancelled");
  f.refuse(null);
  const d = JSON.parse(readFileSync(protectorsPath(), "utf8"));
  const pw = d.protectors.find((e: { type: string }) => e.type === "password");
  const hello = d.protectors.find((e: { type: string }) => e.type === "hello");
  Object.assign(hello, { wrapped_vmk: pw.wrapped_vmk, nonce: pw.nonce });
  writeFileSync(protectorsPath(), JSON.stringify(d));
  expect(await codeOf(() => du.unlock())).toBe("mismatch");
});

test("auto-unlock toggles; forget drops the entry and the OS key, the password is unaffected", async () => {
  const f = fakeProvider();
  const du = new KgDeviceUnlock({ provider: f.p, protectorsPath });
  expect(du.setAutoUnlock(false)).toBe(false); // nothing enrolled
  await du.enroll(PASS, { autoUnlock: false });
  expect((await du.status()).autoUnlock).toBe(false);
  expect(du.setAutoUnlock(true)).toBe(true);
  expect((await du.status()).autoUnlock).toBe(true);
  await du.forget();
  expect(f.calls.destroyed.length).toBe(1);
  expect(await du.status()).toMatchObject({ enrolled: false });
  expect(await codeOf(() => du.unlock())).toBe("not-enrolled");
  expect(unlockPersonal(PASS).ok).toBe(true);
});

test("no provider, an unavailable one, or an unusable file: nothing is offered and nothing prompts", async () => {
  expect(await codeOf(() => new KgDeviceUnlock({ provider: null, protectorsPath }).enroll(PASS))).toBe("unsupported");
  const off = fakeProvider({ available: false });
  expect(await codeOf(() => new KgDeviceUnlock({ provider: off.p, protectorsPath }).enroll(PASS))).toBe("unsupported");
  const f = fakeProvider();
  writeFileSync(protectorsPath(), "{}");
  const du = new KgDeviceUnlock({ provider: f.p, protectorsPath });
  expect((await du.status()).problem).toContain("unusable");
  expect(await codeOf(() => du.unlock())).toBe("failed");
  expect(f.calls.open).toBe(0);
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

test("windows provider: one Hello key per entry; KEK = HKDF(signature) so the same signature reopens it", async () => {
  const seen: Record<string, string>[] = [];
  const sig = Buffer.from("deterministic-rsa-pkcs1-signature").toString("base64");
  const p = windowsHelloProvider(async (env) => { seen.push(env); return { stdout: `${HELLO_MARK}${JSON.stringify({ ok: true, signature: sig })}\n`, stderr: "" }; });
  const { kek, fields } = await p.create("0123456789abcdef");
  expect(seen[0]).toMatchObject({ LUCID_HELLO_OP: "create", LUCID_HELLO_KEY: "LucidVault-ide-0123456789abcdef", LUCID_HELLO_CHALLENGE: fields.challenge });
  expect(Buffer.from(fields.challenge!, "base64").length).toBe(32);
  expect(kek.equals(Buffer.from(hkdfSync("sha256", Buffer.from(sig, "base64"), Buffer.alloc(0), "lucid-vmk-v1|hello", 32)))).toBe(true);
  const entry = { id: "0123456789abcdef", type: "hello" as const, created: "", label: "", wrapped_vmk: "", nonce: "", ...fields };
  expect((await p.open(entry)).equals(kek)).toBe(true);
  expect(seen[1]?.LUCID_HELLO_OP).toBe("sign");
});

test("touch id provider: the sealed KEK is released only after the prompt succeeds", async () => {
  let allow = true;
  const seal = { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(`sealed:${s}`), decryptString: (b: Buffer) => b.toString().slice(7) };
  const p = macTouchIdProvider({ canPromptTouchID: () => true, promptTouchID: async () => { if (!allow) throw new Error("User canceled"); } }, seal);
  const { kek, fields } = await p.create("id");
  const entry = { id: "id", type: "keychain-touchid" as const, created: "", label: "", wrapped_vmk: "", nonce: "", ...fields };
  expect((await p.open(entry)).equals(kek)).toBe(true);
  allow = false;
  expect(await codeOf(() => p.open(entry))).toBe("cancelled");
});
