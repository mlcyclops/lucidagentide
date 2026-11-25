// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-SETUX.1 (ADR-0615): the Settings window's category map, deep-link resolver and search.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseSettingsCat, parseSettingsLayout, resolveSettingsTarget, searchSettings, sectionsOf,
  SETTINGS_CATEGORIES, SETTINGS_SECTIONS,
} from "./settings_nav.ts";
import { VAULT_DEST_SEC } from "./vault_dest_card.ts";
import { VAULT_ENV_SEC } from "./vault_env_view.ts";
import { VAULT_SEC } from "./vault_settings_view.ts";

const secIds = SETTINGS_SECTIONS.map((s) => s.sec as string);
const catIds = SETTINGS_CATEGORIES.map((c) => c.id as string);

describe("the category map", () => {
  test("every section id is unique and sits in exactly one known category", () => {
    expect(new Set(secIds).size).toBe(secIds.length);
    expect(new Set(catIds).size).toBe(catIds.length);
    for (const s of SETTINGS_SECTIONS) expect(catIds).toContain(s.cat);
    const placed = SETTINGS_CATEGORIES.flatMap((c) => sectionsOf(c.id));
    expect(placed.sort()).toEqual([...secIds].sort());
  });

  test("every category has at least one card, and Overview comes first", () => {
    for (const c of SETTINGS_CATEGORIES) expect(sectionsOf(c.id).length).toBeGreaterThan(0);
    expect(catIds[0]).toBe("overview");
  });

  test("the vault cards owned by other modules use the ids listed here", () => {
    for (const id of [VAULT_SEC, VAULT_DEST_SEC, VAULT_ENV_SEC]) expect(secIds).toContain(id);
  });

  test("every card name app.ts emits is a known section (no card can fall outside a category)", () => {
    const app = readFileSync(join(import.meta.dir, "app.ts"), "utf8");
    const emitted = new Set<string>();
    for (const m of app.matchAll(/set(?:Card|Skel)\(\s*"([A-Za-z]+)"/g)) emitted.add(m[1]!);
    for (const m of app.matchAll(/data-sec="([A-Za-z]+)"/g)) emitted.add(m[1]!);
    expect(emitted.size).toBeGreaterThan(20);
    for (const name of emitted) expect(secIds).toContain(name);
  });
});

describe("resolveSettingsTarget", () => {
  test("a card resolves to its category and the card", () => {
    expect(resolveSettingsTarget("workspace")).toEqual({ cat: "workspace", sec: "workspace" });
    expect(resolveSettingsTarget("asksage")).toEqual({ cat: "models", sec: "asksage" });
    expect(resolveSettingsTarget("mcp")).toEqual({ cat: "connectors", sec: "mcp" });
    expect(resolveSettingsTarget(VAULT_ENV_SEC)).toEqual({ cat: "security", sec: VAULT_ENV_SEC });
    expect(resolveSettingsTarget("embeddings")).toEqual({ cat: "knowledge", sec: "embeddings" });
  });
  test("a category resolves to itself; anything else lands on the Overview", () => {
    expect(resolveSettingsTarget("voice")).toEqual({ cat: "voice", sec: "voice" }); // the card wins over the same-named category
    expect(resolveSettingsTarget("appearance")).toEqual({ cat: "appearance", sec: "appearance" });
    expect(resolveSettingsTarget("security")).toEqual({ cat: "security", sec: null });
    expect(resolveSettingsTarget("nope")).toEqual({ cat: "overview", sec: null });
    expect(resolveSettingsTarget("")).toEqual({ cat: "overview", sec: null });
  });
});

describe("searchSettings", () => {
  const ids = (q: string) => searchSettings(q).map((s) => s.sec as string);
  test("finds a section by its title, case-insensitively, title matches first", () => {
    expect(ids("semantic")[0]).toBe("embeddings");
    expect(ids("THEME")[0]).toBe("theme");
    expect(ids("mcp").slice(0, 2).sort()).toEqual(["mcp", "mcpQuick"]);
  });
  test("finds a section by keyword, and every word must match", () => {
    expect(ids("ollama")).toEqual(expect.arrayContaining(["localProviders", "embeddings"]));
    expect(ids("dotenv")).toEqual([VAULT_ENV_SEC]);
    expect(ids("elevenlabs")).toContain("voice");
    expect(ids("ollama vllm")).toEqual(["localProviders"]);
    expect(ids("flyout")).toEqual(["settingsLayout"]);
  });
  test("an empty query lists nothing, and unlisted strips never appear", () => {
    expect(ids("")).toEqual([]);
    expect(ids("   ")).toEqual([]);
    expect(ids("monthly tokens")).not.toContain("asksageQuota");
  });
});

describe("stored preferences", () => {
  test("the layout defaults to the window; only 'panel' opts out", () => {
    expect(parseSettingsLayout(null)).toBe("window");
    expect(parseSettingsLayout("window")).toBe("window");
    expect(parseSettingsLayout("panel")).toBe("panel");
    expect(parseSettingsLayout("sideways")).toBe("window");
  });
  test("a remembered category is used only when it still exists", () => {
    expect(parseSettingsCat("connectors")).toBe("connectors");
    expect(parseSettingsCat("gone")).toBeNull();
    expect(parseSettingsCat(null)).toBeNull();
  });
});
