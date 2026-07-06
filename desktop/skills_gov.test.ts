// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/skills_gov.test.ts — P-SKILL.4 (ADR-0097): the PURE governance rules. Over-tests the
// keystone-#2 / invariant-#3 property: a flagged (suspicious/quarantined) skill is NEVER enableable and
// a stale "on" override can never resurrect it. Also pins the trust/root/remove/readiness mapping.

import { describe, expect, test } from "bun:test";
import {
  effectiveEnabled,
  isSkillRoot,
  readinessChecklist,
  rootRemovable,
  rootTrust,
  skillKey,
  trustEnableable,
} from "./skills_gov.ts";

describe("trustEnableable — flagged trust can never be enabled", () => {
  test("trusted + untrusted are enableable; suspicious + quarantined are not", () => {
    expect(trustEnableable("trusted")).toBe(true);
    expect(trustEnableable("untrusted")).toBe(true);
    expect(trustEnableable("suspicious")).toBe(false);
    expect(trustEnableable("quarantined")).toBe(false);
  });
});

describe("effectiveEnabled — the ONE active-or-not decision (fail-closed)", () => {
  test("enableable trust defaults ON when there is no override", () => {
    expect(effectiveEnabled(undefined, "trusted")).toBe(true);
    expect(effectiveEnabled(undefined, "untrusted")).toBe(true);
  });
  test("an explicit OFF override disables an otherwise-on skill", () => {
    expect(effectiveEnabled(false, "trusted")).toBe(false);
    expect(effectiveEnabled(false, "untrusted")).toBe(false);
  });
  test("a flagged skill is FORCED off even with a stale on-override (keystone #2)", () => {
    expect(effectiveEnabled(true, "suspicious")).toBe(false);
    expect(effectiveEnabled(true, "quarantined")).toBe(false);
    expect(effectiveEnabled(undefined, "suspicious")).toBe(false);
    expect(effectiveEnabled(undefined, "quarantined")).toBe(false);
  });
});

describe("rootTrust — frozen curated roots vs recorded verdict", () => {
  test("bundled + agents are always trusted regardless of any verdict", () => {
    expect(rootTrust("bundled")).toBe("trusted");
    expect(rootTrust("agents")).toBe("trusted");
    expect(rootTrust("bundled", "quarantined")).toBe("trusted"); // curated roots ignore a stray verdict
  });
  test("project/user/plugin ride their scan verdict; unscanned ⇒ untrusted", () => {
    expect(rootTrust("project")).toBe("untrusted");
    expect(rootTrust("user")).toBe("untrusted");
    expect(rootTrust("plugin")).toBe("untrusted");
    expect(rootTrust("project", "suspicious")).toBe("suspicious");
    expect(rootTrust("project", "trusted")).toBe("trusted");
    expect(rootTrust("user", "quarantined")).toBe("quarantined");
  });
});

describe("rootRemovable — only dirs we own", () => {
  test("project + user + registry (a local install) are removable; curated/plugin are immutable", () => {
    expect(rootRemovable("project")).toBe(true);
    expect(rootRemovable("user")).toBe(true);
    expect(rootRemovable("registry")).toBe(true); // P-SKILLREG.1: an installed registry skill can be uninstalled
    expect(rootRemovable("bundled")).toBe(false);
    expect(rootRemovable("agents")).toBe(false);
    expect(rootRemovable("plugin")).toBe(false);
  });
});

describe("skillKey + isSkillRoot", () => {
  test("key is <root>:<name>", () => {
    expect(skillKey("project", "incident-triage")).toBe("project:incident-triage");
    expect(skillKey("bundled", "code-review")).toBe("bundled:code-review");
  });
  test("isSkillRoot guards the closed set", () => {
    expect(isSkillRoot("project")).toBe(true);
    expect(isSkillRoot("bundled")).toBe(true);
    expect(isSkillRoot("nope")).toBe(false);
    expect(isSkillRoot(null)).toBe(false);
  });
});

describe("readinessChecklist — advisory deployment bar", () => {
  test("a clean, well-described, trusted skill passes every metadata check", () => {
    const items = readinessChecklist({ name: "incident-triage", description: "Triage a production incident — gather signals, form a hypothesis, mitigate, then write it up.", trust: "trusted" });
    expect(items.every((i) => i.ok)).toBe(true);
    expect(items).toHaveLength(3); // no body ⇒ no secret check
  });
  test("bad kebab name, thin description, and unscanned trust each fail", () => {
    const items = readinessChecklist({ name: "Not Kebab", description: "short", trust: "untrusted" });
    const byLabel = Object.fromEntries(items.map((i) => [i.label, i.ok]));
    expect(byLabel["Name is a valid kebab-case id"]).toBe(false);
    expect(byLabel["Description says what it does & when to use it"]).toBe(false);
    expect(byLabel["Security scan is clean"]).toBe(false);
  });
  test("a body enables the secret check — a hard-coded key fails it", () => {
    const clean = readinessChecklist({ name: "x", description: "d".repeat(30), trust: "trusted", body: "# how to do the thing\nrun the steps" });
    expect(clean.find((i) => i.label.startsWith("No hard-coded secrets"))!.ok).toBe(true);
    const leaky = readinessChecklist({ name: "x", description: "d".repeat(30), trust: "trusted", body: "export AWS_KEY=AKIAIOSFODNN7EXAMPLE" });
    expect(leaky.find((i) => i.label.startsWith("No hard-coded secrets"))!.ok).toBe(false);
  });
});
