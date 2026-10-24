// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_kgbio_1.ts
//
// Increment P-KGBIO.1 (ADR-0454): unlock the knowledge graph with Windows Hello (face camera, fingerprint, PIN)
// or Touch ID (a Secure Enclave key), as protectors in the store's Lucid Vault Protector Spec v1 file (the
// Hub's protectors.json format). Runs against a REAL encrypted store in a temp dir. By default the OS verifier
// is a scripted stand-in (CI has no TPM or enclave). LUCID_DEMO_REAL_HELLO=1 on Windows uses the real Windows
// Hello provider; LUCID_DEMO_REAL_SEP=1 on macOS uses bin/lucid-sep (`bun run compile-sep`) and must run in the
// logged-in desktop session. Either shows two prompts: enrollment's proof and the unlock.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { PersonalStore } from "../../harness/personal/store.ts";
import { readProtectors } from "../../harness/personal/protectors.ts";
import { DeviceUnlockError, helperSepRunner, KgDeviceUnlock, macSecureEnclaveProvider, windowsHelloProvider, type DeviceKeyProvider } from "../kg_device_unlock.ts";
import { lockPersonal, personalStatus, unlockPersonal, unlockPersonalWithKey } from "../personal.ts";

const fail = (msg: string): never => { console.error(`FAIL: ${msg}`); process.exit(1); };
const ok = (msg: string): void => console.log(`   ${msg} ✓`);
const codeOf = async (run: () => Promise<unknown>): Promise<string> => {
  try { await run(); return "no-throw"; } catch (e) { return e instanceof DeviceUnlockError ? e.code : "other"; }
};

const dir = mkdtempSync(join(tmpdir(), "demo-kgbio-"));
process.env.LUCID_PERSONAL_DIR = dir; // personal.ts resolves its store paths per call, so this relocates them
process.env.LUCID_GUI_SETTINGS_FILE = join(dir, "gui.json");
const storePath = join(dir, "lucid-personal.kg.enc");
const protectorsPath = () => join(dir, "lucid-personal.kg.protectors.json");
const realHello = process.env.LUCID_DEMO_REAL_HELLO === "1" && process.platform === "win32";
const realSep = process.env.LUCID_DEMO_REAL_SEP === "1" && process.platform === "darwin";
const real = realHello ? windowsHelloProvider()
  : realSep ? macSecureEnclaveProvider(helperSepRunner(() => join(import.meta.dir, "..", "..", "bin", "lucid-sep")))
  : null;
let prompts = 0;
const scripted: DeviceKeyProvider = {
  type: "hello", label: "Windows Hello",
  available: async () => true,
  create: async (id) => { prompts++; return { kek: createHash("sha256").update(id).digest(), fields: { challenge: "AAAA", key_name: `demo-${id}` } }; },
  open: async (entry) => { prompts++; return createHash("sha256").update(entry.id).digest(); },
  destroy: async () => {},
};
const provider = real ?? scripted;
const du = new KgDeviceUnlock({ provider, protectorsPath });

try {
  console.log(`== P-KGBIO.1 device unlock as Protector Spec v1 entries (${realHello ? "REAL Windows Hello" : realSep ? "REAL Touch ID / Secure Enclave" : "scripted verifier"}) ==`);
  // A store from before this increment: the passphrase envelope only.
  const s = PersonalStore.createWithPassphrase(storePath, "correct-horse-battery");
  s.addFact({ entityId: s.upsertEntity("dark mode", "user:preference", "trusted"), statement: "prefers dark mode", trustLabel: "trusted" });
  s.save(); s.lock();
  const storeBytes = readFileSync(storePath, "utf8");
  if (!unlockPersonal("correct-horse-battery").ok) fail("legacy unlock failed");
  if (readProtectors(protectorsPath())?.protectors.map((e) => e.type).join() !== "password") fail("migration did not write the password protector");
  if (readFileSync(storePath, "utf8") !== storeBytes) fail("migration rewrote the store");
  ok("an existing store migrates on its next unlock: a protector file with the password protector, zero re-encryption");

  if (await codeOf(() => du.enroll("wrong-passphrase")) !== "wrong-passphrase" || prompts !== 0) fail("a wrong passphrase must be refused before any OS prompt");
  ok("turning it on needs the passphrase: a wrong one is refused before any OS prompt");

  (await du.enroll("correct-horse-battery")).fill(0);
  if (readProtectors(protectorsPath())?.protectors.map((e) => e.type).join() !== `password,${provider.type}`) fail(`enroll did not add the ${provider.type} protector`);
  ok(`enrolled with one OS check: a ${provider.type} protector beside the password one, each its own AAD-bound wrap`);

  lockPersonal();
  const vmk = await du.unlock();
  if (!unlockPersonalWithKey(vmk.toString("base64")).ok || !personalStatus().unlocked) fail("the engine did not unlock with the released key");
  ok("unlock: one OS check -> the engine opens the graph (no passphrase typed)");

  lockPersonal();
  if (!unlockPersonal("correct-horse-battery").ok) fail("the password protector stopped working");
  ok("the password protector still opens the store");

  await du.forget();
  if (readProtectors(protectorsPath())?.protectors.map((e) => e.type).join() !== "password" || (await du.status()).enrolled) fail(`turning it off left the ${provider.type} protector`);
  ok(`turning it off removes the ${provider.type} protector (and its OS key); the password one stays`);

  writeFileSync(protectorsPath(), JSON.stringify({ version: 2, vmk_check: "x", protectors: [] }));
  lockPersonal();
  if (unlockPersonal("correct-horse-battery").ok) fail("a newer-version protector file must not fall back to the envelope");
  ok("fail closed: an unknown protector-file version refuses the unlock instead of falling back");
  console.log("demo-P-KGBIO.1 OK");
} finally {
  lockPersonal();
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
