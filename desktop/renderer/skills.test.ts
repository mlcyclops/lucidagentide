// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/skills.test.ts — P-SKILL.4 (ADR-0097): the renderer half of skill governance (the
// localStorage-backed enable/disable). Over-tests the keystone: a flagged skill can NEVER be enabled,
// and a disabled BUILT-IN never surfaces in the picker (bundledSkillsByUsage). Uses a Map-backed
// localStorage stub since bun's test env has none.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { bundledSkillsByUsage, INSTALLED_SKILLS, installedSkills, isSkillEnabled, setSkillEnabled } from "./skills.ts";
import { skillKey } from "../skills_gov.ts";
import { BUILD_FLAVORS } from "../build_flavor.ts";

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

describe("bundledSkillsByUsage: a disabled built-in never surfaces", () => {
  test("every built-in this build ships is present by default", () => {
    for (const creatorBuild of [false, true]) {
      expect(bundledSkillsByUsage(creatorBuild).length).toBe(installedSkills(creatorBuild).length);
    }
  });
  test("disabling one built-in drops exactly it from the picker list", () => {
    const victim = INSTALLED_SKILLS[0]!.command;
    setSkillEnabled(skillKey("bundled", victim), "trusted", false);
    const listed = bundledSkillsByUsage(false).map((s) => s.command);
    expect(listed).not.toContain(victim);
    expect(listed.length).toBe(installedSkills(false).length - 1);
  });
});

// CREATOR-EXPLAINER (ADR-0460): the explainer skills ship built in to the Creator build only.
// CREATOR-CURRICULUM (ADR-0467) adds the three curriculum crafts under the same rules.
const CREATOR_ONLY = [
  "explainer-studio", "explainer-assets-gpu",
  "curriculum-guide-mirror", "curriculum-to-explainers", "notebooklm-podcast-studio",
] as const;
const commands = (creatorBuild: boolean) => installedSkills(creatorBuild).map((s) => s.command);

describe("installedSkills: flavor-gated built-ins (ADR-0460)", () => {
  test("the explainer skills are built in to Creator and absent from the standard Agent build", () => {
    for (const c of CREATOR_ONLY) {
      expect(commands(true)).toContain(c);
      expect(commands(false)).not.toContain(c);
      expect(bundledSkillsByUsage(true).map((s) => s.command)).toContain(c);
      expect(bundledSkillsByUsage(false).map((s) => s.command)).not.toContain(c);
    }
  });
  test("flavor-neutral built-ins ship in both builds, in curated order", () => {
    const neutral = INSTALLED_SKILLS.filter((s) => !s.flavors).map((s) => s.command);
    expect(commands(false)).toEqual(neutral);
    expect(commands(true).filter((c) => neutral.includes(c))).toEqual(neutral);
    expect(commands(true).length).toBe(neutral.length + CREATOR_ONLY.length);
  });
  test("every flavor flag names a real flavor and commands stay unique kebab ids", () => {
    for (const s of INSTALLED_SKILLS) {
      for (const f of s.flavors ?? []) expect(BUILD_FLAVORS).toContain(f);
      expect(s.command).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }
    expect(new Set(INSTALLED_SKILLS.map((s) => s.command)).size).toBe(INSTALLED_SKILLS.length);
  });
});

// The house text rules: no em or en dash (CLAUDE.md writing style) and no hidden unicode (the set
// creator_dgx_vision.ts untrustedText drops: C0/C1 controls, zero-width, bidi, word joiners, BOM, plus soft
// hyphen and tag characters). A bundled prompt bypasses the scanner, so it must be clean by construction.
const DASH = /[\u2013\u2014]/;
const HIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]|[\u{E0000}-\u{E007F}]/u;
const PROMPT_CAP = 8000; // dev.ts /api/skill keeps only the first 8000 characters of a prompt

describe("built-in text passes the em-dash and hidden-unicode rules", () => {
  test("every built-in name, description, and prompt", () => {
    for (const s of INSTALLED_SKILLS) {
      for (const text of [s.name, s.description, s.systemPrompt]) {
        expect(DASH.test(text)).toBe(false);
        expect(HIDDEN.test(text)).toBe(false);
      }
    }
  });
  test("every built-in prompt fits the delivery cap, so nothing is silently truncated", () => {
    for (const s of INSTALLED_SKILLS) expect(s.systemPrompt.length).toBeLessThanOrEqual(PROMPT_CAP);
  });
  test("the guards themselves catch what they claim to", () => {
    expect(DASH.test("a \u2014 b")).toBe(true);
    for (const ch of ["\u200b", "\u202e", "\u2066", "\ufeff", "\u00ad", "\u{E0041}", "\u0007"]) expect(HIDDEN.test(`x${ch}y`)).toBe(true);
    expect(HIDDEN.test("plain text\twith a tab\nand a newline")).toBe(false);
  });
});

// The long-form skill under .agents/skills/<command>/ is the reviewed source the bundled prompt distills.
const SKILLS_ROOT = join(import.meta.dir, "..", "..", ".agents", "skills");
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)]));
}

describe("each Creator built-in pairs with its first-party .agents skill", () => {
  for (const c of CREATOR_ONLY) {
    test(`${c}: SKILL.md frontmatter, references, evals, provenance, and clean text`, () => {
      const dir = join(SKILLS_ROOT, c);
      const body = readFileSync(join(dir, "SKILL.md"), "utf8");
      expect(body.startsWith("---\n") || body.startsWith("---\r\n")).toBe(true);
      expect(body).toMatch(new RegExp(`^name: ${c}\\r?$`, "m"));
      expect(body).toMatch(/^description: .{80,}/m);
      for (const ref of body.match(/references\/[a-z0-9-]+\.md/g) ?? []) expect(statSync(join(dir, ref)).isFile()).toBe(true);
      const evals = JSON.parse(readFileSync(join(dir, "evals", "evals.json"), "utf8")) as { skill_name: string; evals: unknown[] };
      expect(evals.skill_name).toBe(c);
      expect(evals.evals.length).toBeGreaterThanOrEqual(3);
      expect(readFileSync(join(SKILLS_ROOT, "SOURCES.md"), "utf8")).toContain(`\`${c}\``);
      for (const f of filesUnder(dir)) {
        const text = readFileSync(f, "utf8");
        expect({ f, dash: DASH.test(text) }).toEqual({ f, dash: false });
        expect({ f, hidden: HIDDEN.test(text) }).toEqual({ f, hidden: false });
      }
    });
  }
});
