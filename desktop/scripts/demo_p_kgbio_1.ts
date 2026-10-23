// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_kgbio_1.ts
//
// Increment P-KGBIO.1 (ADR-0454): unlock the knowledge graph with Windows Hello (face camera, fingerprint,
// PIN) or Touch ID / Apple Watch instead of typing the passphrase every launch. Runs against a REAL encrypted
// store in a temp dir. By default the OS verifier is a scripted stand-in (CI has no TPM); with
// LUCID_DEMO_REAL_HELLO=1 on Windows it uses the real Windows Hello provider and shows two prompts.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { CUI_STORE_VERSION, PersonalStore } from "../../harness/personal/store.ts";
import { dekFromPassphrase, DeviceUnlockError, KgDeviceUnlock, windowsHelloProvider, type DeviceKeyProvider } from "../kg_device_unlock.ts";
import { lockPersonal, personalStatus, unlockPersonalWithKey } from "../personal.ts";

const fail = (msg: string): never => { console.error(`FAIL: ${msg}`); process.exit(1); };
const ok = (msg: string): void => console.log(`   ${msg} ✓`);
const codeOf = async (run: () => Promise<unknown>): Promise<string> => {
  try { await run(); return "no-throw"; } catch (e) { return e instanceof DeviceUnlockError ? e.code : "other"; }
};

const dir = mkdtempSync(join(tmpdir(), "demo-kgbio-"));
process.env.LUCID_PERSONAL_DIR = dir; // personal.ts resolves its store path per call, so this relocates it
const storePath = () => join(dir, "lucid-personal.kg.enc");
const recordPath = () => join(dir, "lucid-personal.kg.device.json");
const io = {
  read: (p: string) => { try { return readFileSync(p, "utf8"); } catch { return null; } },
  write: (p: string, t: string) => writeFileSync(p, t),
  remove: (p: string) => rmSync(p, { force: true }),
};
const real = process.env.LUCID_DEMO_REAL_HELLO === "1" && process.platform === "win32";
let prompts = 0;
const scripted: DeviceKeyProvider = {
  kind: "windows-hello", label: "Windows Hello",
  available: async () => true,
  create: async () => { prompts++; const nonce = String(Date.now()); return { kek: createHash("sha256").update(nonce).digest(), params: { nonce } }; },
  open: async (p) => { prompts++; return createHash("sha256").update(p.nonce ?? "").digest(); },
  destroy: async () => {},
};
const du = new KgDeviceUnlock({ provider: real ? windowsHelloProvider() : scripted, io, storePath, recordPath });

try {
  console.log(`== P-KGBIO.1 device unlock (${real ? "REAL Windows Hello" : "scripted verifier"}) ==`);
  const s = PersonalStore.createWithPassphrase(storePath(), "correct-horse-battery");
  s.addFact({ entityId: s.upsertEntity("dark mode", "user:preference", "trusted"), statement: "prefers dark mode", trustLabel: "trusted" });
  s.save(); s.lock();

  if (await codeOf(() => du.enroll("wrong-passphrase")) !== "wrong-passphrase" || prompts !== 0) fail("a wrong passphrase must be refused before any OS prompt");
  ok("turning it on needs the passphrase: a wrong one is refused before any OS prompt");

  const enrolled = await du.enroll("correct-horse-battery");
  if (!(await du.status()).enrolled) fail("enroll did not persist");
  if (io.read(recordPath())!.includes(enrolled.toString("base64"))) fail("the record must not hold the plain key");
  ok("enrolled with one OS check; the record on disk holds only an OS-sealed copy of the key");

  const dek = await du.unlock();
  if (!dek.equals(enrolled)) fail("unlock released a different key");
  lockPersonal();
  if (!unlockPersonalWithKey(dek.toString("base64")).ok || !personalStatus().unlocked) fail("the engine did not unlock with the released key");
  ok("unlock: one OS check -> the engine opens the graph (no passphrase typed)");

  lockPersonal();
  if (!PersonalStore.openWithPassphrase(storePath(), "correct-horse-battery").graph().facts.length) fail("passphrase stopped working");
  ok("the passphrase still opens the store");

  const cuiPath = join(dir, "lucid-cui.kg.enc");
  PersonalStore.createWithPassphrase(cuiPath, "cui-passphrase-xyz", { version: CUI_STORE_VERSION }).lock();
  try { dekFromPassphrase(io.read(cuiPath), "cui-passphrase-xyz"); fail("a CUI store must never be device-enrolled"); } catch (e) { if (!(e instanceof DeviceUnlockError)) throw e; }
  ok("the CUI store is out of scope (ADR-0014): it can never be enrolled");

  rmSync(storePath()); PersonalStore.createWithPassphrase(storePath(), "another-passphrase").lock();
  const before = prompts;
  if (await codeOf(() => du.unlock()) !== "stale" || prompts !== before) fail("a re-created store must be stale without a prompt");
  ok("a re-created store is detected as stale WITHOUT prompting");

  await du.forget();
  if ((await du.status()).enrolled || io.read(recordPath()) !== null) fail("forget left state behind");
  ok("turning it off removes the OS key and the record");
  console.log("demo-P-KGBIO.1 OK");
} finally {
  lockPersonal();
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
