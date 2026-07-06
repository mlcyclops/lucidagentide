// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_pskillreg1.ts
//
// P-SKILLREG.1 (ADR-0098): the enterprise Agent Skills registry READER seam. Proves the fail-closed
// install pipeline end to end with REAL Ed25519 signatures + the REAL Unicode scanner:
//   [1] a SIGNED + CLEAN artifact installs and appears as an `untrusted` `registry` directory row
//       (keystone #2 — verified + scanned, but NEVER auto-promoted to trusted);
//   [2] an UNSIGNED artifact — and one signed by an UNTRUSTED key — are BLOCKED at the signature stage;
//   [3] a SIGNED but POISONED artifact (hidden bidi/zero-width) is BLOCKED at the scan gate.
// Every rejection writes NOTHING (invariant #3). The registry SERVER + Terraform runbooks are private IP.
//
// Run with: bun run harness/scripts/demo_pskillreg1.ts

import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installRegistrySkill, stopRegistryScanner, type TrustedRegistryKey } from "../../desktop/skills_registry.ts";
import { listSkills, stopSkillDirScanner } from "../../desktop/skills_data.ts";
import { _resetScanVerdictsForTest } from "../../desktop/skills_scan_log.ts";

function fail(m: string): never { stopRegistryScanner(); stopSkillDirScanner(); console.error(`FAIL: ${m}`); process.exit(1); }

const kp = generateKeyPairSync("ed25519");
const untrustedKp = generateKeyPairSync("ed25519");
const trusted: TrustedRegistryKey[] = [{ id: "acme-registry", key: kp.publicKey }];
const sign = (content: string, key = kp.privateKey) => edSign(null, Buffer.from(content, "utf8"), key).toString("base64");

const CLEAN = `---\nname: registry-triage\ndescription: A signed registry skill that triages an incident when you need it done clearly and fast.\n---\n\n# registry-triage\n\n1. Pull signals. 2. One hypothesis. 3. Mitigate. 4. Write it up.\n`;
// Same skill, poisoned with a Trojan-Source bidi override (U+202E) + zero-width space (U+200B).
const POISONED = CLEAN.replace("name: registry-triage", "name: registry-evil").replace("Mitigate", "Miti\u202egate\u200b");

const ws = mkdtempSync(join(tmpdir(), "lucid-demo-pskillreg1-"));
process.env.LUCID_SKILL_SCAN_PATH = join(ws, "scans.jsonl");
_resetScanVerdictsForTest();
const dir = (slug: string) => join(ws, ".omp", "skills", slug);

try {
  console.log("== [1/3] a SIGNED + CLEAN artifact verifies, scans clean, and installs as an UNTRUSTED registry row ==");
  const ok = await installRegistrySkill({ name: "registry-triage", version: "1.2.0", content: CLEAN, signature: sign(CLEAN), keyId: "acme-registry", registryRef: "harbor.acme.internal/skills/registry-triage:1.2.0" }, ws, { trusted });
  if (!ok.ok || !ok.installed || ok.trust !== "untrusted") fail(`clean signed skill should install untrusted; got ${JSON.stringify(ok)}`);
  if (!existsSync(join(dir("registry-triage"), "SKILL.md"))) fail("installed SKILL.md missing on disk");
  const row = (await listSkills(ws)).find((s) => s.name === "registry-triage");
  if (!row || row.root !== "registry" || row.trust !== "untrusted" || !row.removable) fail(`directory should show it as registry/untrusted/removable; got ${JSON.stringify(row)}`);
  console.log(`   installed registry-triage → stage=${ok.stage} trust=${ok.trust} signedBy=${ok.keyId}  ·  directory row root=${row.root} (keystone #2: not auto-trusted)`);

  console.log("\n== [2/3] an UNSIGNED artifact — and one signed by an UNTRUSTED key — are BLOCKED at the signature stage ==");
  const unsigned = await installRegistrySkill({ name: "registry-nosig", content: CLEAN, signature: "" }, ws, { trusted });
  if (unsigned.ok || unsigned.stage !== "signature") fail(`unsigned artifact must block at signature; got ${JSON.stringify(unsigned)}`);
  if (existsSync(dir("registry-nosig"))) fail("unsigned skill must not touch disk");
  const wrongKey = await installRegistrySkill({ name: "registry-wrongkey", content: CLEAN, signature: sign(CLEAN, untrustedKp.privateKey) }, ws, { trusted });
  if (wrongKey.ok || wrongKey.stage !== "signature") fail(`untrusted-key artifact must block at signature; got ${JSON.stringify(wrongKey)}`);
  if (existsSync(dir("registry-wrongkey"))) fail("untrusted-key skill must not touch disk");
  console.log(`   unsigned → blocked: ${unsigned.reason}  ·  untrusted key → blocked: ${wrongKey.reason}`);

  console.log("\n== [3/3] a SIGNED but POISONED artifact is BLOCKED at the REAL scan gate (fail-closed) ==");
  const poisoned = await installRegistrySkill({ name: "registry-evil", content: POISONED, signature: sign(POISONED), keyId: "acme-registry" }, ws, { trusted });
  if (poisoned.ok || poisoned.stage !== "scan") fail(`poisoned artifact must block at the scan gate; got ${JSON.stringify(poisoned)}`);
  if (existsSync(dir("registry-evil"))) fail("poisoned skill must not touch disk");
  console.log(`   registry-evil (validly signed, hidden bidi/zero-width) → blocked at scan: ${poisoned.reason}`);

  stopRegistryScanner(); stopSkillDirScanner();
  console.log("\nPASS: registry reader — signature-verified + scan-gated install, fail-closed on unsigned/untrusted-key/poisoned, installs untrusted (never auto-trusted).");
} catch (e) {
  fail(`unexpected error: ${String((e as Error)?.stack ?? e)}`);
} finally {
  stopRegistryScanner(); stopSkillDirScanner();
  rmSync(ws, { recursive: true, force: true });
}
process.exit(0);
