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
import { createECDH, createHash, hkdfSync, randomBytes, type ECDH } from "node:crypto";
import { PersonalStore } from "../harness/personal/store.ts";
import { readProtectors, unlockWithPassword } from "../harness/personal/protectors.ts";
import {
  DeviceUnlockError, helloError, HELLO_MARK, KgDeviceUnlock, macSecureEnclaveProvider, parseBridgeReply, SEP_MARK, sepError, windowsHelloProvider,
  type DeviceKeyProvider, type DeviceUnlockCode,
} from "./kg_device_unlock.ts";
import { changePersonalPassphrase, lockPersonal, personalStatus, setupPersonal, unlockPersonal, unlockPersonalWithKey } from "./personal.ts";

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

// ── P-KGPASS.1 (ADR-0455): a passphrase change re-wraps the password protector and the envelope ──
test("changing the main passphrase revokes the old one everywhere and keeps Windows Hello working", async () => {
  const f = fakeProvider();
  const du = new KgDeviceUnlock({ provider: f.p, protectorsPath });
  (await du.enroll(PASS)).fill(0);
  const helloBefore = JSON.stringify(doc()!.protectors.find((e) => e.type === "hello"));
  expect(changePersonalPassphrase("main", PASS, "a-new-passphrase").ok).toBe(false); // locked: refused
  expect(unlockPersonal(PASS).ok).toBe(true);
  expect(changePersonalPassphrase("main", "wrong-current", "a-new-passphrase").error).toContain("wrong");
  expect(changePersonalPassphrase("main", PASS, "short").ok).toBe(false);
  expect(changePersonalPassphrase("main", PASS, "a-new-passphrase").ok).toBe(true);
  expect(JSON.stringify(doc()!.protectors.find((e) => e.type === "hello"))).toBe(helloBefore); // device entry untouched
  lockPersonal();
  expect(unlockPersonal(PASS).ok).toBe(false);
  expect(() => PersonalStore.openWithPassphrase(storePath(), PASS)).toThrow(); // the envelope revoked it too
  expect(PersonalStore.openWithPassphrase(storePath(), "a-new-passphrase").graph().facts.length).toBe(0); // older builds: new one
  expect(unlockPersonalWithKey((await du.unlock()).toString("base64")).ok).toBe(true);
});

test("a never-migrated store changes its envelope and then migrates under the new passphrase", () => {
  for (const p of [storePath(), protectorsPath()]) rmSync(p, { force: true });
  legacyStore();
  expect(unlockPersonal(PASS).ok).toBe(true);
  rmSync(protectorsPath()); // as if the migration write had failed
  expect(changePersonalPassphrase("main", PASS, "a-new-passphrase").ok).toBe(true);
  expect(unlockWithPassword(doc()!, "a-new-passphrase").length).toBe(32);
  lockPersonal();
  expect(unlockPersonal(PASS).ok).toBe(false);
  expect(unlockPersonal("a-new-passphrase").ok).toBe(true);
});

// ── Windows Hello bridge (the PowerShell half runs only on a real machine; see the demo) ──
test("bridge reply: the marker line wins over host noise; no marker reads as failure", () => {
  expect(parseBridgeReply(HELLO_MARK, `WARNING: noise\r\n${HELLO_MARK}{"ok":true,"signature":"c2ln"}\r\n`)).toEqual({ ok: true, signature: "c2ln" });
  expect(parseBridgeReply(HELLO_MARK, "", "Cannot invoke method. Method invocation is supported only on core types in this language mode.").status).toBe("ConstrainedLanguage");
  expect(parseBridgeReply(SEP_MARK, `${HELLO_MARK}{"ok":true}`).ok).toBe(false); // another bridge's marker is not an answer
  expect(parseBridgeReply(HELLO_MARK, "garbage").ok).toBe(false);
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
  const { kek, fields } = await p.create("0123456789abcdef", { companion: false });
  expect(seen[0]).toMatchObject({ LUCID_HELLO_OP: "create", LUCID_HELLO_KEY: "LucidVault-ide-0123456789abcdef", LUCID_HELLO_CHALLENGE: fields.challenge });
  expect(Buffer.from(fields.challenge!, "base64").length).toBe(32);
  expect(kek.equals(Buffer.from(hkdfSync("sha256", Buffer.from(sig, "base64"), Buffer.alloc(0), "lucid-vmk-v1|hello", 32)))).toBe(true);
  const entry = { id: "0123456789abcdef", type: "hello" as const, created: "", label: "", wrapped_vmk: "", nonce: "", ...fields };
  expect((await p.open(entry)).equals(kek)).toBe(true);
  expect(seen[1]?.LUCID_HELLO_OP).toBe("sign");
});

// ── macOS Secure Enclave bridge: a fake enclave doing real P-256 ECDH, the private half kept "inside" it ──
function fakeEnclave(opts: { watch?: boolean } = {}) {
  const keys = new Map<string, ECDH>();
  const state = { prompts: 0, deny: null as string | null, skew: false, createdWithWatch: [] as boolean[] };
  const reply = (o: object) => ({ stdout: `noise\n${SEP_MARK}${JSON.stringify(o)}\n`, stderr: "" });
  const run = async (env: Record<string, string>) => {
    if (env.LUCID_SEP_OP === "available") return reply({ ok: true, available: true, watch: opts.watch === true });
    if (env.LUCID_SEP_OP === "create") {
      state.createdWithWatch.push(env.LUCID_SEP_WATCH === "1");
      const k = createECDH("prime256v1"); k.generateKeys();
      const handle = randomBytes(24).toString("base64");
      keys.set(handle, k);
      return reply({ ok: true, se_key: handle, public_key: k.getPublicKey("base64") });
    }
    state.prompts++;
    if (state.deny) return reply({ ok: false, status: state.deny });
    const k = keys.get(env.LUCID_SEP_KEY ?? "");
    if (!k) return reply({ ok: false, status: "invalid-key" }); // e.g. the fingerprints changed
    const shared = k.computeSecret(Buffer.from(env.LUCID_SEP_PEER ?? "", "base64"));
    if (state.skew) shared[0]! ^= 1;
    return reply({ ok: true, shared: shared.toString("base64") });
  };
  return { run, keys, state };
}

test("sep provider: KEK = HKDF(ECDH with the enclave key); one Touch ID match at enrollment proves it", async () => {
  const enclave = fakeEnclave();
  const p = macSecureEnclaveProvider(enclave.run);
  const { kek, fields } = await p.create("id", { companion: false });
  expect(enclave.state.prompts).toBe(1); // the enrollment proof
  const ecdh = enclave.keys.get(fields.se_key!)!.computeSecret(Buffer.from(fields.eph_pub!, "base64"));
  expect(kek.equals(Buffer.from(hkdfSync("sha256", ecdh, Buffer.alloc(0), "lucid-vmk-v1|sep", 32)))).toBe(true);
  const entry = { id: "id", type: "sep" as const, created: "", label: "", wrapped_vmk: "", nonce: "", ...fields };
  expect((await p.open(entry)).equals(kek)).toBe(true);
  expect(enclave.state.prompts).toBe(2);
});

test("sep provider: cancel, a dead key and a wrong enclave answer each fail the way the UI expects", async () => {
  const enclave = fakeEnclave();
  const p = macSecureEnclaveProvider(enclave.run);
  const { fields } = await p.create("id", { companion: false });
  const entry = { id: "id", type: "sep" as const, created: "", label: "", wrapped_vmk: "", nonce: "", ...fields };
  enclave.state.deny = "cancelled";
  expect(await codeOf(() => p.open(entry))).toBe("cancelled");
  expect(await codeOf(() => p.create("id2", { companion: false }))).toBe("cancelled"); // a cancelled enrollment proof enrolls nothing
  enclave.state.deny = null;
  enclave.keys.clear();
  expect(await codeOf(() => p.open(entry))).toBe("not-enrolled");
  enclave.state.skew = true;
  expect(await codeOf(() => p.create("id3", { companion: false }))).toBe("failed");
  expect(sepError({ ok: false, status: "lockout" }).code).toBe("failed");
  expect(sepError({ ok: false, status: "not-available" }).code).toBe("unsupported");
  expect(await macSecureEnclaveProvider(async () => ({ stdout: "", stderr: "spawn ENOENT" })).available()).toBe(false); // missing helper
});

test("sep end to end: Touch ID enrolls beside the password protector and unlocks the engine", async () => {
  const enclave = fakeEnclave();
  const du = new KgDeviceUnlock({ provider: macSecureEnclaveProvider(enclave.run), protectorsPath });
  (await du.enroll(PASS)).fill(0);
  expect(doc()!.protectors.map((e) => e.type)).toEqual(["password", "sep"]);
  expect(await du.status()).toMatchObject({ provider: "sep", label: "Touch ID", enrolled: true, autoUnlock: true });
  expect(unlockPersonalWithKey((await du.unlock()).toString("base64")).ok).toBe(true);
});

test("apple watch is opt-in at enrollment, refused when no watch is set up, and named in the status", async () => {
  const noWatch = new KgDeviceUnlock({ provider: macSecureEnclaveProvider(fakeEnclave().run), protectorsPath });
  expect((await noWatch.status()).companionAvailable).toBe(false);
  expect(await codeOf(() => noWatch.enroll(PASS, { companion: true }))).toBe("unsupported");

  const enclave = fakeEnclave({ watch: true });
  const du = new KgDeviceUnlock({ provider: macSecureEnclaveProvider(enclave.run), protectorsPath });
  (await du.enroll(PASS)).fill(0); // default: Touch ID only
  expect(enclave.state.createdWithWatch).toEqual([false]);
  expect(await du.status()).toMatchObject({ companionAvailable: true, companion: false, label: "Touch ID" });

  (await du.enroll(PASS, { companion: true })).fill(0); // turning it on again with the watch allowed
  expect(enclave.state.createdWithWatch).toEqual([false, true]);
  const entry = doc()!.protectors.find((e) => e.type === "sep")!;
  expect(entry).toMatchObject({ companion: true, label: "Touch ID or Apple Watch" });
  expect(await du.status()).toMatchObject({ enrolled: true, companion: true, label: "Touch ID or Apple Watch" });
  expect(unlockPersonalWithKey((await du.unlock()).toString("base64")).ok).toBe(true);
});
