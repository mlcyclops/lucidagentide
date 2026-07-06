// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/skills_registry.test.ts — P-SKILLREG.1 (ADR-0098): the registry reader. Over-tests the
// fail-closed keystones: an UNSIGNED / bad-signature / no-trusted-keys / scan-flagged / dead-scanner
// artifact is BLOCKED and writes NOTHING; a signed+clean one installs as an UNTRUSTED `registry` row
// (keystone #2 — never auto-trusted); a hostile resource path can't traverse out of the skill dir.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GateDecision } from "../harness/security/gate.ts";
import { installRegistrySkill, type TrustedRegistryKey, verifyArtifactSignature } from "./skills_registry.ts";
import { listSkills, removeSkill } from "./skills_data.ts";
import { _resetScanVerdictsForTest } from "./skills_scan_log.ts";

const kp = generateKeyPairSync("ed25519");
const otherKp = generateKeyPairSync("ed25519");
const trusted: TrustedRegistryKey[] = [{ id: "test-key", key: kp.publicKey }];
const signB64 = (content: string, key = kp.privateKey) => edSign(null, Buffer.from(content, "utf8"), key).toString("base64");

const SKILL = `---\nname: reg-skill\ndescription: A registry-installed skill that does a governed thing clearly and well.\n---\n\n# reg-skill\n\nDo the governed thing.\n`;
const okDecide = async (): Promise<GateDecision> => ({ block: false, reason: "clean", trustLabel: "trusted", findings: [], failClosed: false });
const artifact = (over: Record<string, unknown> = {}) => ({ name: "reg-skill", version: "1.0.0", content: SKILL, signature: signB64(SKILL), keyId: "test-key", registryRef: "harbor.example/skills/reg-skill:1.0.0", ...over });
const skillDir = (ws: string) => join(ws, ".omp", "skills", "reg-skill");

let ws: string;
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), "lucid-reg-")); process.env.LUCID_SKILL_SCAN_PATH = join(ws, "scans.jsonl"); _resetScanVerdictsForTest(); });
afterEach(() => { delete process.env.LUCID_SKILL_SCAN_PATH; _resetScanVerdictsForTest(); rmSync(ws, { recursive: true, force: true }); });

describe("verifyArtifactSignature — fail-closed Ed25519", () => {
  test("a real signature over the content verifies against the trusted key", () => {
    expect(verifyArtifactSignature(SKILL, signB64(SKILL), trusted)).toMatchObject({ ok: true, keyId: "test-key" });
  });
  test("unsigned ⇒ rejected", () => {
    expect(verifyArtifactSignature(SKILL, "", trusted)).toMatchObject({ ok: false, reason: "unsigned artifact" });
  });
  test("NO trusted keys configured ⇒ rejected (fail-closed by absence)", () => {
    expect(verifyArtifactSignature(SKILL, signB64(SKILL), []).ok).toBe(false);
  });
  test("tampered content ⇒ signature no longer matches", () => {
    expect(verifyArtifactSignature(SKILL + "\n# injected", signB64(SKILL), trusted).ok).toBe(false);
  });
  test("signed by an UNtrusted key ⇒ rejected", () => {
    expect(verifyArtifactSignature(SKILL, signB64(SKILL, otherKp.privateKey), trusted).ok).toBe(false);
  });
});

describe("installRegistrySkill — every rejection writes nothing", () => {
  test("unsigned ⇒ blocked at the signature stage, nothing on disk", async () => {
    let blocked = 0;
    const r = await installRegistrySkill(artifact({ signature: "" }), ws, { trusted, decide: okDecide, record: () => { blocked++; } });
    expect(r.ok).toBe(false);
    expect(r.stage).toBe("signature");
    expect(blocked).toBe(1);
    expect(existsSync(skillDir(ws))).toBe(false);
  });
  test("bad signature ⇒ blocked, nothing on disk", async () => {
    const r = await installRegistrySkill(artifact({ signature: signB64("some other content") }), ws, { trusted, decide: okDecide, record: () => {} });
    expect(r.ok).toBe(false);
    expect(r.stage).toBe("signature");
    expect(existsSync(skillDir(ws))).toBe(false);
  });
  test("no trusted keys ⇒ blocked, nothing on disk", async () => {
    const r = await installRegistrySkill(artifact(), ws, { trusted: [], decide: okDecide, record: () => {} });
    expect(r.ok).toBe(false);
    expect(r.stage).toBe("signature");
    expect(existsSync(skillDir(ws))).toBe(false);
  });
  test("scan-flagged ⇒ blocked at the scan stage, nothing on disk", async () => {
    let blocked = 0;
    const flag = async (): Promise<GateDecision> => ({ block: true, reason: "quarantined: 1 finding", trustLabel: "quarantined", findings: [{ type: "zero-width", codepoint: "U+200B", index: 0, severity: "high" }], failClosed: false });
    const r = await installRegistrySkill(artifact(), ws, { trusted, decide: flag, record: () => { blocked++; } });
    expect(r.ok).toBe(false);
    expect(r.stage).toBe("scan");
    expect(r.trust).toBe("quarantined");
    expect(blocked).toBe(1);
    expect(existsSync(skillDir(ws))).toBe(false);
  });
  test("dead scanner ⇒ quarantined block, nothing on disk (fail-closed)", async () => {
    const r = await installRegistrySkill(artifact(), ws, { trusted, decide: async () => { throw new Error("sidecar dead"); }, record: () => {} });
    expect(r.ok).toBe(false);
    expect(r.stage).toBe("scan");
    expect(r.trust).toBe("quarantined");
    expect(existsSync(skillDir(ws))).toBe(false);
  });
  test("an invalid name never touches disk", async () => {
    const r = await installRegistrySkill(artifact({ name: "Not A Slug" }), ws, { trusted, decide: okDecide, record: () => {} });
    expect(r.ok).toBe(false);
    expect(r.stage).toBe("validate");
  });
});

describe("installRegistrySkill — a signed + clean artifact installs (untrusted)", () => {
  test("writes SKILL.md + marker; returns UNtrusted (keystone #2, never auto-promoted)", async () => {
    const r = await installRegistrySkill(artifact(), ws, { trusted, decide: okDecide, record: () => {} });
    expect(r).toMatchObject({ ok: true, installed: true, stage: "done", trust: "untrusted", keyId: "test-key" });
    expect(existsSync(join(skillDir(ws), "SKILL.md"))).toBe(true);
    expect(existsSync(join(skillDir(ws), ".lucid-registry.json"))).toBe(true);
  });
  test("a hostile resource path can't traverse out of the skill dir; a safe one lands inside", async () => {
    const r = await installRegistrySkill(
      artifact({ resources: [{ path: "../escape.txt", content: "x" }, { path: "scripts/help.sh", content: "echo hi" }] }),
      ws, { trusted, decide: okDecide, record: () => {} },
    );
    expect(r.ok).toBe(true);
    expect(existsSync(join(ws, ".omp", "skills", "escape.txt"))).toBe(false); // traversal refused
    expect(existsSync(join(skillDir(ws), "scripts", "help.sh"))).toBe(true); // confined resource written
  });
});

describe("directory integration — an installed skill appears as a Registry row and uninstalls", () => {
  test("listSkills classifies it registry/untrusted/removable; removeSkill uninstalls it", async () => {
    await installRegistrySkill(artifact(), ws, { trusted, decide: okDecide, record: () => {} });
    const row = (await listSkills(ws)).find((s) => s.name === "reg-skill");
    expect(row).toBeTruthy();
    expect(row!.root).toBe("registry");
    expect(row!.trust).toBe("untrusted");
    expect(row!.removable).toBe(true);

    const rm = await removeSkill("reg-skill", ws);
    expect(rm.ok).toBe(true);
    expect(rm.root).toBe("registry");
    expect(existsSync(skillDir(ws))).toBe(false);
  });
});
