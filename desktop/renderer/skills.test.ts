// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/skills.test.ts — P-SKILL.4 (ADR-0097): the renderer half of skill governance (the
// localStorage-backed enable/disable). Over-tests the keystone: a flagged skill can NEVER be enabled,
// and a disabled BUILT-IN never surfaces in the picker (bundledSkillsByUsage). Uses a Map-backed
// localStorage stub since bun's test env has none.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { bundledSkillsByUsage, INSTALLED_SKILLS, isSkillEnabled, setSkillEnabled } from "./skills.ts";
import { skillKey } from "../skills_gov.ts";

const store = new Map<string, string>();
const stub: Storage = {
  getItem: (k) => (store.has(k) ? store.get(k)! : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
  clear: () => store.clear(),
  key: (i) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};

beforeEach(() => { store.clear(); (globalThis as unknown as { localStorage: Storage }).localStorage = stub; });
afterEach(() => { store.clear(); });

describe("isSkillEnabled — the shared delivery decision", () => {
  test("enableable trust defaults ON with no stored override", () => {
    expect(isSkillEnabled("bundled:code-review", "trusted")).toBe(true);
    expect(isSkillEnabled("project:foo", "untrusted")).toBe(true);
  });
  test("flagged trust is OFF regardless of storage (keystone #2)", () => {
    expect(isSkillEnabled("project:bad", "suspicious")).toBe(false);
    expect(isSkillEnabled("project:bad", "quarantined")).toBe(false);
  });
});

describe("setSkillEnabled — persist + fail-closed on flagged", () => {
  test("disabling then re-enabling round-trips through the store", () => {
    const key = "bundled:refactor";
    expect(setSkillEnabled(key, "trusted", false)).toBe(false);
    expect(isSkillEnabled(key, "trusted")).toBe(false);
    expect(setSkillEnabled(key, "trusted", true)).toBe(true);
    expect(isSkillEnabled(key, "trusted")).toBe(true);
  });
  test("re-enabling clears the override so the stored map stays minimal", () => {
    const key = "project:x";
    setSkillEnabled(key, "untrusted", false);
    expect(JSON.parse(store.get("lucid.skill-enabled")!)).toHaveProperty(key, false);
    setSkillEnabled(key, "untrusted", true);
    expect(JSON.parse(store.get("lucid.skill-enabled")!)).not.toHaveProperty(key);
  });
  test("trying to ENABLE a flagged skill is refused and never persisted", () => {
    const key = "project:evil";
    expect(setSkillEnabled(key, "quarantined", true)).toBe(false);
    expect(isSkillEnabled(key, "quarantined")).toBe(false);
    expect(store.has("lucid.skill-enabled")).toBe(false); // nothing written
  });
});

describe("bundledSkillsByUsage — a disabled built-in never surfaces", () => {
  test("all built-ins are present by default", () => {
    expect(bundledSkillsByUsage().length).toBe(INSTALLED_SKILLS.length);
  });
  test("disabling one built-in drops exactly it from the picker list", () => {
    const victim = INSTALLED_SKILLS[0]!.command;
    setSkillEnabled(skillKey("bundled", victim), "trusted", false);
    const listed = bundledSkillsByUsage().map((s) => s.command);
    expect(listed).not.toContain(victim);
    expect(listed.length).toBe(INSTALLED_SKILLS.length - 1);
  });
});
