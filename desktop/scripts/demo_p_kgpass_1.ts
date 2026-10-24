// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_kgpass_1.ts
//
// Increment P-KGPASS.1 (ADR-0455): change the knowledge graph's passphrase (main store and the isolated CUI
// store). A re-wrap: the data key is unchanged; on the main store the Protector Spec v1 password entry and the
// store envelope are both re-wrapped, so the old passphrase opens neither, and a Windows Hello / Touch ID
// protector keeps working (it is never touched). Real encrypted stores in a temp dir; the OS verifier is a
// scripted stand-in.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { CUI_STORE_VERSION, PersonalStore } from "../../harness/personal/store.ts";
import { KgDeviceUnlock, type DeviceKeyProvider } from "../kg_device_unlock.ts";
import { changePersonalPassphrase, enablePersonal, lockPersonal, setScope, unlockCui, unlockPersonal } from "../personal.ts";

const fail = (msg: string): never => { console.error(`FAIL: ${msg}`); process.exit(1); };
const ok = (msg: string): void => console.log(`   ${msg} ✓`);

const dir = mkdtempSync(join(tmpdir(), "demo-kgpass-"));
process.env.LUCID_PERSONAL_DIR = dir; // personal.ts resolves its store paths per call, so this relocates them
process.env.LUCID_GUI_SETTINGS_FILE = join(dir, "gui.json");
const storePath = () => join(dir, "lucid-personal.kg.enc");
const scripted: DeviceKeyProvider = {
  type: "hello", label: "Windows Hello",
  available: async () => true,
  create: async (id) => ({ kek: createHash("sha256").update(id).digest(), fields: { challenge: "AAAA", key_name: `demo-${id}` } }),
  open: async (entry) => createHash("sha256").update(entry.id).digest(),
  destroy: async () => {},
};
const du = new KgDeviceUnlock({ provider: scripted, protectorsPath: () => join(dir, "lucid-personal.kg.protectors.json") });

try {
  console.log("== P-KGPASS.1 change the knowledge graph passphrase ==");
  enablePersonal(true);
  const s = PersonalStore.createWithPassphrase(storePath(), "old-main-passphrase");
  s.addFact({ entityId: s.upsertEntity("dark mode", "user:preference", "trusted"), statement: "prefers dark mode", trustLabel: "trusted" });
  s.save(); s.lock();
  if (!unlockPersonal("old-main-passphrase").ok) fail("setup unlock failed"); // writes the protector file (ADR-0454)
  (await du.enroll("old-main-passphrase")).fill(0);
  lockPersonal();

  if (changePersonalPassphrase("main", "old-main-passphrase", "new-main-passphrase").ok) fail("a locked store must refuse");
  if (!unlockPersonal("old-main-passphrase").ok) fail("setup unlock failed");
  if (changePersonalPassphrase("main", "not-it", "new-main-passphrase").ok) fail("a wrong current passphrase must be refused");
  if (changePersonalPassphrase("main", "old-main-passphrase", "short").ok) fail("a short new passphrase must be refused");
  ok("refused while locked, with a wrong current passphrase, and with a new one under 8 characters");

  if (!changePersonalPassphrase("main", "old-main-passphrase", "new-main-passphrase").ok) fail("change failed");
  lockPersonal();
  if (unlockPersonal("old-main-passphrase").ok) fail("the OLD passphrase still opens the store");
  if (!unlockPersonal("new-main-passphrase").ok) fail("the NEW passphrase does not open the store");
  try { PersonalStore.openWithPassphrase(storePath(), "old-main-passphrase"); fail("the store envelope still opens with the OLD passphrase"); } catch { /* revoked */ }
  ok("changed: the new passphrase opens the store; the old one opens neither the protector file nor the envelope");

  const g = PersonalStore.openWithPassphrase(storePath(), "new-main-passphrase").graph();
  if (g.facts[0]?.statement !== "prefers dark mode") fail("data lost across the change");
  ok("the graph is intact (the data key never changed: a re-wrap, not a re-key)");

  if (!(await du.status()).enrolled) fail("the hello protector was lost in the passphrase change");
  (await du.unlock()).fill(0);
  ok("the Windows Hello protector still unlocks after the change (it was never touched)");

  const cuiPath = join(dir, "lucid-cui.kg.enc");
  PersonalStore.createWithPassphrase(cuiPath, "old-cui-passphrase", { version: CUI_STORE_VERSION }).lock();
  setScope("cui");
  if (!unlockCui("old-cui-passphrase").ok) fail("CUI setup unlock failed");
  if (!changePersonalPassphrase("cui", "old-cui-passphrase", "new-cui-passphrase").ok) fail("CUI change failed");
  try { PersonalStore.openWithPassphrase(cuiPath, "old-cui-passphrase", { version: CUI_STORE_VERSION }); fail("the old CUI passphrase still opens"); } catch { /* revoked */ }
  PersonalStore.openWithPassphrase(cuiPath, "new-cui-passphrase", { version: CUI_STORE_VERSION });
  PersonalStore.openWithPassphrase(storePath(), "new-main-passphrase");
  ok("the CUI store changes its OWN passphrase; the main store's is untouched (ADR-0014)");
  console.log("demo-P-KGPASS.1 OK");
} finally {
  lockPersonal();
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
