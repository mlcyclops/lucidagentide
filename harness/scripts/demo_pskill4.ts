// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_pskill4.ts
//
// P-SKILL.4 (ADR-0097): the Agent Skill directory + management menu. Proves the governance layer end to
// end against omp's REAL discovery + the REAL Unicode scanner:
//   [1] the directory classifies each discovered skill to a source ROOT + trust + removable flag
//       (a .omp/skills skill = project/untrusted/removable; a .agents/skills skill = agents/trusted/immutable);
//   [2] a RE-SCAN runs the fail-closed gate: a clean skill → trusted, a poisoned one (hidden bidi/zero-width)
//       → quarantined + recorded; and a flagged skill becomes NON-ENABLEABLE (keystone #2);
//   [3] REMOVE is confined: it deletes a project skill's folder but REFUSES an immutable .agents skill.
//
// Run with: bun run harness/scripts/demo_pskill4.ts

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { effectiveEnabled } from "../../desktop/skills_gov.ts";
import { inspectSkill, listSkills, removeSkill, rescanSkill, stopSkillDirScanner } from "../../desktop/skills_data.ts";
import { _resetScanVerdictsForTest } from "../../desktop/skills_scan_log.ts";

function fail(m: string): never { stopSkillDirScanner(); console.error(`FAIL: ${m}`); process.exit(1); }
const skillMd = (name: string, body: string) =>
  `---\nname: ${name}\ndescription: A directory demo skill that triages a thing when you need it done clearly.\n---\n\n# ${name}\n\n${body}\n`;

const ws = mkdtempSync(join(tmpdir(), "lucid-demo-pskill4-"));
// Isolate the scan-verdict ledger so the demo never touches the real ~/.omp file.
process.env.LUCID_SKILL_SCAN_PATH = join(ws, "scans.jsonl");
_resetScanVerdictsForTest();

const proj = (slug: string) => join(ws, ".omp", "skills", slug);
const write = (dir: string, name: string, body: string) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "SKILL.md"), skillMd(name, body)); };

// A clean project skill, a clean curated (.agents) skill, and a POISONED project skill carrying a
// Trojan-Source bidi override (U+202E) + a zero-width space (U+200B) hidden in the body.
write(proj("directory-clean"), "directory-clean", "1. Pull signals. 2. Form one hypothesis. 3. Mitigate. 4. Write it up.");
write(join(ws, ".agents", "skills", "curated-note"), "curated-note", "Curated, vendor-trusted guidance.");
write(proj("directory-evil"), "directory-evil", "Miti\u202egate\u200b the incident before root-causing.");

try {
  console.log("== [1/3] the directory classifies each skill's root + trust + removability ==");
  const rows = await listSkills(ws);
  const clean = rows.find((r) => r.name === "directory-clean");
  const curated = rows.find((r) => r.name === "curated-note");
  if (!clean || !curated) fail(`demo skills not discovered (clean=${!!clean} curated=${!!curated})`);
  if (clean.root !== "project" || clean.trust !== "untrusted" || !clean.removable) fail(`project skill misclassified: ${JSON.stringify(clean)}`);
  if (curated.root !== "agents" || curated.trust !== "trusted" || curated.removable) fail(`.agents skill misclassified: ${JSON.stringify(curated)}`);
  console.log(`   directory-clean → root=${clean.root} trust=${clean.trust} removable=${clean.removable} inv=${clean.invocation}`);
  console.log(`   curated-note    → root=${curated.root} trust=${curated.trust} removable=${curated.removable} (immutable)`);

  console.log("\n== [2/3] re-scan through the REAL fail-closed gate — clean stays trusted, poisoned quarantines ==");
  const okScan = await rescanSkill("directory-clean", ws);
  if (okScan.trust !== "trusted" || okScan.blocked) fail(`clean skill should scan trusted; got ${JSON.stringify(okScan)}`);
  const badScan = await rescanSkill("directory-evil", ws);
  if (badScan.trust !== "quarantined" || !badScan.blocked) fail(`poisoned skill must quarantine at the gate; got ${JSON.stringify(badScan)}`);
  // The flagged skill is now recorded quarantined AND non-enableable — it can never become active guidance.
  const evilRow = (await listSkills(ws)).find((r) => r.name === "directory-evil");
  if (evilRow?.trust !== "quarantined") fail(`the directory should show directory-evil as quarantined; got ${JSON.stringify(evilRow)}`);
  if (effectiveEnabled(true, "quarantined") !== false) fail("a quarantined skill must be NON-enableable even with an on-override");
  console.log(`   directory-clean re-scan → trust=${okScan.trust}  ·  directory-evil re-scan → trust=${badScan.trust} (blocked, locked off)`);

  // Inspect renders the body as data (never executed) — confirm it reads back.
  const seen = await inspectSkill("directory-clean", ws);
  if (!seen.ok || !seen.body?.includes("Mitigate")) fail(`inspect should read the clean skill body; got ${JSON.stringify(seen).slice(0, 120)}`);

  console.log("\n== [3/3] remove is confined to the roots we own — project deletes, .agents is refused ==");
  const refused = await removeSkill("curated-note", ws);
  if (refused.ok || refused.root !== "agents") fail(`an immutable .agents skill must NOT be removable; got ${JSON.stringify(refused)}`);
  if (!existsSync(join(ws, ".agents", "skills", "curated-note"))) fail("the refused .agents skill must stay on disk");
  const removed = await removeSkill("directory-clean", ws);
  if (!removed.ok || !removed.removed) fail(`a project skill should be removable; got ${JSON.stringify(removed)}`);
  if (existsSync(proj("directory-clean"))) fail("the removed project skill folder must be gone from disk");
  console.log(`   remove curated-note (agents) → refused: ${refused.reason}`);
  console.log(`   remove directory-clean (project) → deleted ${proj("directory-clean").replace(ws, "<ws>")}`);

  stopSkillDirScanner();
  console.log("\nPASS: skill directory — roots/trust classified, re-scan is fail-closed + locks flagged skills, remove is confined.");
} catch (e) {
  fail(`unexpected error: ${String((e as Error)?.stack ?? e)}`);
} finally {
  stopSkillDirScanner();
  rmSync(ws, { recursive: true, force: true });
}
process.exit(0);
