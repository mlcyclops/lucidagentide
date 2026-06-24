// harness/scripts/demo_pskill1.ts
//
// P-SKILL.1 (ADR-0045): gated drag-and-drop import of project skills. Proves the security property:
// a CLEAN skill .md is scanned + written to <workspace>/.omp/skills/<slug>/SKILL.md, while a POISONED
// one (hidden bidi/zero-width Unicode) is BLOCKED at the gate and never written. The gate is now
// authoritative for IMPORTED project skills — which omp's native loader would otherwise bypass.
//
// Run with: bun run harness/scripts/demo_pskill1.ts

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { importSkill, stopSkillScanner } from "../../desktop/skills_import.ts";

const fail = (m: string): never => { stopSkillScanner(); console.error(`FAIL: ${m}`); process.exit(1); };

// Under home so the skills-root path confinement (pathWithin) admits it on every platform.
const ws = mkdtempSync(join(homedir(), ".lucid-demo-pskill1-"));
const skillPath = (slug: string) => join(ws, ".omp", "skills", slug, "SKILL.md");

const CLEAN = `---
name: incident-triage
description: Triage a production incident — gather signals, form a hypothesis, mitigate, then write it up.
---

# Incident Triage

1. Pull the error rate, latency, and recent deploys.
2. Form ONE hypothesis; test it before acting.
3. Mitigate (rollback/feature-flag) before root-causing.
4. Write a short timeline: what broke, why, what's next.
`;

// A DISTINCT skill (its own name → its own slug) carrying a Trojan-Source bidi override (U+202E) +
// a zero-width space (U+200B) hidden in the body — never-legitimate control characters the scanner
// flags HIGH (DEFAULT_POLICY blocks at high).
const POISONED = CLEAN.replace("name: incident-triage", "name: incident-triage-evil").replace("Mitigate", "Miti‮gate​");

try {
  console.log("== [1/3] a CLEAN skill scans clean and is written under .omp/skills/ ==");
  const ok = await importSkill("incident-triage.md", CLEAN, ws);
  if (!ok.ok || !ok.written) fail(`clean skill should import; got ${JSON.stringify(ok)}`);
  if (!existsSync(skillPath(ok.name))) fail(`clean skill file missing at ${skillPath(ok.name)}`);
  if (readFileSync(skillPath(ok.name), "utf8") !== CLEAN) fail("written content should match the dropped file byte-for-byte");
  console.log(`   wrote ${ok.path}  ·  trust=${ok.trustLabel}  ·  findings=${ok.findings}`);

  console.log("\n== [2/3] a POISONED skill (hidden bidi/zero-width) is BLOCKED and never written ==");
  const bad = await importSkill("incident-triage-evil.md", POISONED, ws);
  if (bad.ok || bad.written) fail(`poisoned skill must NOT be written; got ${JSON.stringify(bad)}`);
  if (!bad.blocked) fail("poisoned skill should be blocked (held for review)");
  if (existsSync(skillPath(bad.name))) fail("poisoned skill must NOT touch disk");
  console.log(`   blocked: ${bad.reason}  ·  trust=${bad.trustLabel}  ·  findings=${bad.findings}`);

  console.log("\n== [3/3] the gate decides — not the filename ==");
  console.log("   clean → on disk for omp to discover; poisoned → quarantined to the Security panel, off disk.");

  stopSkillScanner();
  console.log("\nPASS: gated skill import — clean writes, poisoned blocks, fail-closed at the gate.");
} finally {
  rmSync(ws, { recursive: true, force: true });
}
process.exit(0);
