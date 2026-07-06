// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_pskillreg2.ts
//
// P-SKILLREG.2 (ADR-0102): the skill PUBLISH seam. Proves the write<->read round trip end to end:
//   [1] a codified skill is SIGNED (local Ed25519 key) + PUBLISHED to the Local Skills Registry;
//   [2] a declared REMOTE target with no registered publisher is a clean NO-OP (never a throw);
//   [3] the published artifact is loaded back and INSTALLED through the P-SKILLREG.1 reader (real
//       signature-verify + real scan gate) — appearing in the directory as an untrusted `registry` row.
// Remote publishers (cloud OCI / custom git) are private add-on IP; only the local publisher ships here.
//
// Run with: bun run harness/scripts/demo_pskillreg2.ts

import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSkillArtifact, LocalRegistryPublisher, loadFromLocalRegistry, PublishDispatcher } from "../../desktop/skill_publish.ts";
import { installRegistrySkill, stopRegistryScanner, type TrustedRegistryKey } from "../../desktop/skills_registry.ts";
import { listSkills, stopSkillDirScanner } from "../../desktop/skills_data.ts";
import { _resetScanVerdictsForTest } from "../../desktop/skills_scan_log.ts";

function fail(m: string): never { stopRegistryScanner(); stopSkillDirScanner(); console.error(`FAIL: ${m}`); process.exit(1); }

// The workstation's local signing key; the reader trusts its public half (self-trusted local registry).
const kp = generateKeyPairSync("ed25519");
const sign = (content: string) => ({ signature: edSign(null, Buffer.from(content, "utf8"), kp.privateKey).toString("base64"), keyId: "local-workstation" });
const trusted: TrustedRegistryKey[] = [{ id: "local-workstation", key: kp.publicKey }];

const CONTENT = `---\nname: incident-triage\ndescription: Triage a prod incident - signals, one hypothesis, mitigate, write-up. Not for planned changes.\n---\n\n# Incident Triage\n\n1. Pull the error rate + recent deploys.\n2. Form ONE hypothesis.\n3. Mitigate (rollback), then root-cause.\n`;

const registryRoot = mkdtempSync(join(tmpdir(), "lucid-demo-pskillreg2-reg-"));
const ws = mkdtempSync(join(tmpdir(), "lucid-demo-pskillreg2-ws-"));
process.env.LUCID_SKILL_SCAN_PATH = join(ws, "scans.jsonl");
_resetScanVerdictsForTest();

try {
  console.log("== [1/3] SIGN + PUBLISH a codified skill to the Local Skills Registry ==");
  const artifact = buildSkillArtifact({ name: "incident-triage", version: "1.3.0", content: CONTENT }, sign);
  const local = new LocalRegistryPublisher(registryRoot);
  const receipt = await local.publish(artifact);
  if (!receipt.ok || !receipt.signed) fail(`local publish should succeed + be signed; got ${JSON.stringify(receipt)}`);
  if (!existsSync(join(registryRoot, "incident-triage", "1.3.0", "SKILL.md"))) fail("published artifact missing in the local registry");
  console.log(`   published incident-triage@1.3.0 -> ${receipt.location}  ·  signed=${receipt.signed} digest=${artifact.digest.slice(0, 12)}\u2026`);

  console.log("\n== [2/3] a declared REMOTE target with no registered publisher is a clean NO-OP ==");
  const dispatcher = new PublishDispatcher();
  dispatcher.setPublishers([local]); // public repo: local only (no remote impls)
  const receipts = await dispatcher.publish(artifact, ["local", "acme-ecr"]);
  const remote = receipts.find((r) => r.publisher === "acme-ecr");
  if (!remote || remote.ok || !remote.reason?.includes("no publisher")) fail(`remote target must be a clean no-op; got ${JSON.stringify(remote)}`);
  if (!receipts.find((r) => r.publisher === "local")?.ok) fail("the local target should still publish");
  console.log(`   local -> ok  ·  acme-ecr -> no-op: ${remote.reason}`);

  console.log("\n== [3/3] load it back + INSTALL through the P-SKILLREG.1 reader -> a `registry` directory row ==");
  const loaded = loadFromLocalRegistry("incident-triage", "1.3.0", registryRoot);
  if (!loaded) fail("could not load the published artifact back");
  const install = await installRegistrySkill(loaded, ws, { trusted });
  if (!install.ok || !install.installed || install.trust !== "untrusted") fail(`reader should install it untrusted; got ${JSON.stringify(install)}`);
  const row = (await listSkills(ws)).find((s) => s.name === "incident-triage");
  if (!row || row.root !== "registry" || row.trust !== "untrusted") fail(`directory should show a registry/untrusted row; got ${JSON.stringify(row)}`);
  console.log(`   loaded local:${loaded.registryRef}  ·  installed -> stage=${install.stage} trust=${install.trust}  ·  directory row root=${row.root}`);

  stopRegistryScanner(); stopSkillDirScanner();
  console.log("\nPASS: publish seam - local publisher signs + stores, remote is a fail-safe no-op, and the published artifact round-trips through the reader into a registry row.");
} catch (e) {
  fail(`unexpected error: ${String((e as Error)?.stack ?? e)}`);
} finally {
  stopRegistryScanner(); stopSkillDirScanner();
  rmSync(registryRoot, { recursive: true, force: true });
  rmSync(ws, { recursive: true, force: true });
}
process.exit(0);
