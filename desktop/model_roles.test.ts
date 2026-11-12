// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-MODEL.8 (ADR-0448): which model omp's heavy roles resolve to, through omp's REAL Settings loader and
// role resolver (the functions the child runs), not a string match on the overlay text.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { formatModelStringWithRouting, resolveRoleChain } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { GEMINI_HEAVY_MODEL, GEMINI_HEAVY_ROLES, heavyRoleModel, modelRolesOverlayYaml } from "./model_roles.ts";

const FLASH = "google/gemini-3.8-flash";
const allowAll = () => true;

describe("heavyRoleModel", () => {
  test("a direct Gemini session hands the heavy roles to Argon", () => {
    expect(heavyRoleModel({ chatModel: FLASH, locked: false, allowed: allowAll })).toBe(GEMINI_HEAVY_MODEL);
  });
  test("no heavy roles for a non-Gemini session, an OAuth Gemini route, or before omp named a model", () => {
    for (const chatModel of ["anthropic/claude-opus-5-5", "openai-codex/gpt-6-sol", "google-antigravity/gemini-3.8-flash",
                             "asksage-google/google-gemini-3.5-flash-gov", "google/claude-sonnet-5-5", ""]) {
      expect(heavyRoleModel({ chatModel, locked: false, allowed: allowAll })).toBeNull();
    }
  });
  test("lockdown and an org policy that denies Argon both keep omp's defaults", () => {
    expect(heavyRoleModel({ chatModel: FLASH, locked: true, allowed: allowAll })).toBeNull();
    expect(heavyRoleModel({ chatModel: FLASH, locked: false, allowed: (m) => m !== GEMINI_HEAVY_MODEL })).toBeNull();
  });
});

describe("modelRolesOverlayYaml through omp's resolver", () => {
  const mk = (id: string) => ({ provider: "google", id, name: id, api: "google-generative-ai", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_048_576, maxTokens: 32_768 });
  const withArgon = [mk("gemini-3.8-flash"), mk("gemini-4-argon")];
  async function resolve(yaml: string, role: string, pool: unknown[]): Promise<string[]> {
    const dir = mkdtempSync(join(tmpdir(), "lucid-roles-"));
    try {
      const f = join(dir, "roles.yml");
      writeFileSync(f, yaml);
      // The session model is the `default` role omp's `@default` fallback resolves to.
      const base = join(dir, "base.yml");
      writeFileSync(base, `modelRoles:\n  default: ${JSON.stringify(FLASH)}\n`);
      const s = await Settings.loadReadOnly({ agentDir: dir, cwd: dir, configFiles: [base, f] });
      return resolveRoleChain(role, s, pool as never).map((c) => formatModelStringWithRouting(c.model));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("every heavy role resolves to Argon first, then the session's Flash", async () => {
    for (const role of GEMINI_HEAVY_ROLES) {
      expect(await resolve(modelRolesOverlayYaml(GEMINI_HEAVY_MODEL), role, withArgon)).toEqual([GEMINI_HEAVY_MODEL, FLASH]);
    }
  });
  test("a key without Argon access degrades to Flash instead of resolving nothing", async () => {
    expect(await resolve(modelRolesOverlayYaml(GEMINI_HEAVY_MODEL), "task", [mk("gemini-3.8-flash")])).toEqual([FLASH]);
  });
  test("the empty overlay leaves the roles unset, so nothing resolves to Argon", async () => {
    for (const role of GEMINI_HEAVY_ROLES) {
      expect(await resolve(modelRolesOverlayYaml(null), role, withArgon)).not.toContain(GEMINI_HEAVY_MODEL);
    }
  });
});
