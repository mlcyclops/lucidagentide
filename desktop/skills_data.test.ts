// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/skills_data.test.ts — P-SKILL.4 (ADR-0097): the directory's server side, exercised against
// omp's REAL discoverSkills on a temp workspace. The security keystones:
//   • a re-scan with a DEAD scanner ⇒ quarantined + recorded (invariant #3, keystone #2);
//   • remove is CONFINED to project/user and REFUSES an immutable (.agents) skill;
//   • listSkills classifies roots + attaches the recorded verdict as trust.
// recordBlock is injected (a spy) so unit runs never touch the real ~/.omp/lucid-blocks.jsonl.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GateDecision } from "../harness/security/gate.ts";
import { inspectSkill, listSkills, removeSkill, rescanSkill, type SkillInfo } from "./skills_data.ts";
import { _resetScanVerdictsForTest, scanVerdicts } from "./skills_scan_log.ts";

const skillMd = (name: string) =>
  `---\nname: ${name}\ndescription: A test skill that triages a thing when you need it done clearly.\n---\n\n# ${name}\n\nDo the thing.\n`;
const byName = (rows: SkillInfo[], n: string) => rows.find((r) => r.name === n);
const noRecord = () => {}; // swallow recordBlock in unit runs
const decision = (over: Partial<GateDecision>): GateDecision =>
  ({ block: false, reason: "clean", trustLabel: "trusted", findings: [], failClosed: false, ...over });

let ws: string;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "lucid-skilldir-"));
  mkdirSync(join(ws, ".omp", "skills", "sk-test-alpha"), { recursive: true });
  writeFileSync(join(ws, ".omp", "skills", "sk-test-alpha", "SKILL.md"), skillMd("sk-test-alpha"));
  mkdirSync(join(ws, ".agents", "skills", "sk-test-bravo"), { recursive: true });
  writeFileSync(join(ws, ".agents", "skills", "sk-test-bravo", "SKILL.md"), skillMd("sk-test-bravo"));
  process.env.LUCID_SKILL_SCAN_PATH = join(ws, "scans.jsonl");
  _resetScanVerdictsForTest();
});
afterEach(() => {
  delete process.env.LUCID_SKILL_SCAN_PATH;
  _resetScanVerdictsForTest();
  rmSync(ws, { recursive: true, force: true });
});

describe("listSkills — classify + trust + removable", () => {
  test("a .omp/skills skill is project/untrusted/removable with a /skill: invocation", async () => {
    const alpha = byName(await listSkills(ws), "sk-test-alpha");
    expect(alpha).toBeTruthy();
    expect(alpha!.root).toBe("project");
    expect(alpha!.trust).toBe("untrusted");
    expect(alpha!.removable).toBe(true);
    expect(alpha!.invocation).toBe("/skill:sk-test-alpha");
  });
  test("a .agents/skills skill is agents/trusted/immutable", async () => {
    const bravo = byName(await listSkills(ws), "sk-test-bravo");
    expect(bravo).toBeTruthy();
    expect(bravo!.root).toBe("agents");
    expect(bravo!.trust).toBe("trusted");
    expect(bravo!.removable).toBe(false);
  });
});

describe("rescanSkill — fail-closed + verdict recording", () => {
  test("a DEAD scanner ⇒ quarantined, recorded, block emitted (never 'safe')", async () => {
    let blocked = 0;
    const r = await rescanSkill("sk-test-alpha", ws, async () => { throw new Error("sidecar dead"); }, () => { blocked++; });
    expect(r.ok).toBe(true);
    expect(r.trust).toBe("quarantined");
    expect(r.blocked).toBe(true);
    expect(blocked).toBe(1);
    expect(scanVerdicts()["project:sk-test-alpha"]!.trust).toBe("quarantined");
  });

  test("a CLEAN scan records trusted → listSkills reflects it", async () => {
    const r = await rescanSkill("sk-test-alpha", ws, async () => decision({}), noRecord);
    expect(r.trust).toBe("trusted");
    expect(r.blocked).toBe(false);
    const alpha = byName(await listSkills(ws), "sk-test-alpha");
    expect(alpha!.trust).toBe("trusted");
    expect(alpha!.scanned?.trust).toBe("trusted");
  });

  test("a FLAGGED scan records the flag + a block → listSkills shows it (locks it off in the directory)", async () => {
    let blocked = 0;
    const flagged = decision({ block: true, reason: "quarantined: 1 finding", trustLabel: "quarantined", findings: [{ type: "zero-width", codepoint: "U+200B", index: 0, severity: "high" }] });
    await rescanSkill("sk-test-alpha", ws, async () => flagged, () => { blocked++; });
    expect(blocked).toBe(1);
    const alpha = byName(await listSkills(ws), "sk-test-alpha");
    expect(alpha!.trust).toBe("quarantined");
    expect(alpha!.scanned?.findings).toBe(1);
  });

  test("a missing skill is not-found (no verdict recorded)", async () => {
    const r = await rescanSkill("sk-nope", ws, async () => decision({}), noRecord);
    expect(r.found).toBe(false);
    expect(r.ok).toBe(false);
  });
});

describe("removeSkill — confined to project/user roots", () => {
  test("removes a project skill's folder", async () => {
    expect(existsSync(join(ws, ".omp", "skills", "sk-test-alpha"))).toBe(true);
    const r = await removeSkill("sk-test-alpha", ws);
    expect(r.ok).toBe(true);
    expect(r.removed).toBe(true);
    expect(existsSync(join(ws, ".omp", "skills", "sk-test-alpha"))).toBe(false);
  });

  test("REFUSES an immutable .agents skill and leaves it on disk", async () => {
    const r = await removeSkill("sk-test-bravo", ws);
    expect(r.ok).toBe(false);
    expect(r.root).toBe("agents");
    expect(existsSync(join(ws, ".agents", "skills", "sk-test-bravo"))).toBe(true);
  });

  test("a missing skill is not-found (never throws)", async () => {
    const r = await removeSkill("sk-nope", ws);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("not found");
  });
});

describe("inspectSkill — reads the body as data", () => {
  test("returns the SKILL.md body + root/trust for a discovered skill", async () => {
    const v = await inspectSkill("sk-test-alpha", ws);
    expect(v.ok).toBe(true);
    expect(v.root).toBe("project");
    expect(v.trust).toBe("untrusted");
    expect(v.body).toContain("Do the thing.");
  });
  test("a missing skill fails soft (ok:false, no throw)", async () => {
    const v = await inspectSkill("sk-nope", ws);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("not found");
  });
});
