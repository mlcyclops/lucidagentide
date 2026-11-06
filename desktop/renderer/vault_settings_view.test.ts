// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/vault_settings_view.test.ts - P-VAULT-UI.1 (ADR-0475): the Settings "Credential vault"
// section markup. Collapsed by default, one row per entry with Rotate and Remove, the backup/restore forms,
// metadata only (a stray `value` field on an entry is never rendered), and markup is escaped.

import { describe, expect, test } from "bun:test";
import {
  parseVaultList, passphraseStrength, sourceLabel, vaultSectionHtml, whereUsed, type VaultListView, type VaultMetaView,
} from "./vault_settings_view.ts";

const T = 1_760_000_000_000;
const meta = (over: Partial<VaultMetaView> & { ref: string }): VaultMetaView =>
  ({ label: over.ref, kind: "apikey", source: "typed", addedAt: T, updatedAt: T, ...over });
const view = (entries: VaultMetaView[]): VaultListView =>
  ({ status: { state: "ok", custody: "dpapi", entries: entries.length, crypto: { module: "windows-cng", fips: true } }, entries });

describe("section", () => {
  test("is collapsed by default and opens only when asked; it uses the shared set-card toggle", () => {
    const closed = vaultSectionHtml(view([]), false);
    expect(closed).toContain('class="set-sec set-coll"');
    expect(closed).not.toContain("set-coll open");
    expect(closed).toContain('data-setcard="vault"');
    expect(closed).toContain('data-sec="vault"');
    expect(vaultSectionHtml(view([]), true)).toContain('class="set-sec set-coll open"');
  });

  test("one row per entry with Rotate and Remove, plus the backup and restore forms", () => {
    const h = vaultSectionHtml(view([
      meta({ ref: "key:ANTHROPIC_API_KEY", label: "Anthropic", envName: "ANTHROPIC_API_KEY", last4: "9xQz" }),
      meta({ ref: "git_pat_github_com", label: "GitHub PAT", kind: "pat", source: "migrated-safestorage" }),
    ]), true);
    expect(h.match(/data-vault-rotate=/g)?.length).toBe(2);
    expect(h.match(/data-vault-remove=/g)?.length).toBe(2);
    expect(h).toContain('data-vault-rotate="key:ANTHROPIC_API_KEY"');
    expect(h).toContain("\u2022\u2022\u2022\u20229xQz");
    expect(h).toContain("Migrated (OS vault)");
    expect(h).toContain("Git host \u00b7 github_com");
    expect(h).toContain('id="vaultBkPass"');
    expect(h).toContain('id="vaultBkPass2"');
    expect(h).toContain("data-vault-backup");
    expect(h).toContain('id="vaultRsFile"');
    expect(h).toContain('id="vaultRsPass"');
    expect(h).toContain("data-vault-restore");
    expect(h).toContain("FIPS 140 validated");
    expect(h).toContain("2 secrets");
    for (const id of ["vaultBkPass", "vaultBkPass2", "vaultRsPass"]) expect(h).toMatch(new RegExp(`id="${id}" class="prov-key" type="password"`));
  });

  test("renders metadata only and escapes it", () => {
    const leaky = { ...meta({ ref: "secret:x", label: "<img src=x onerror=alert(1)>" }), value: "sk-SHOULD-NEVER-RENDER-0001" };
    const parsed = parseVaultList({ status: { state: "ok", entries: 1 }, entries: [leaky] });
    expect(parsed).not.toBeNull();
    const h = vaultSectionHtml(parsed, true);
    expect(h).not.toContain("SHOULD-NEVER-RENDER");
    expect(JSON.stringify(parsed)).not.toContain("SHOULD-NEVER-RENDER");
    expect(h).not.toContain("<img");
    expect(h).toContain("&lt;img");
  });

  test("an unreadable vault and a failed load say so instead of listing", () => {
    const bad = vaultSectionHtml({ status: { state: "unreadable", entries: 0 }, entries: [] }, true);
    expect(bad).toContain("unreadable");
    const failed = vaultSectionHtml(null, false, "the engine could not be reached");
    expect(failed).toContain("the engine could not be reached");
    expect(failed).not.toContain("data-vault-backup");
  });
});

describe("labels", () => {
  test("where used follows the ref conventions", () => {
    expect(whereUsed(meta({ ref: "key:OPENAI_API_KEY" }))).toBe("Provider key \u00b7 OPENAI_API_KEY");
    expect(whereUsed(meta({ ref: "mcp:docs" }))).toBe("MCP server \u00b7 docs");
    expect(whereUsed(meta({ ref: "git_pat" }))).toBe("Git \u00b7 all hosts");
    expect(whereUsed(meta({ ref: "ws:0123456789abcdef:DB_URL", envName: "DB_URL", scope: { workspace: "C:\\code\\shop-api" } }))).toBe("Workspace shop-api \u00b7 DB_URL");
    expect(whereUsed(meta({ ref: "figma_pat" }))).toBe("Figma");
    expect(whereUsed(meta({ ref: "secret:prod_jwt" }))).toBe("Stored credential");
    expect(sourceLabel("env-import")).toBe(".env import");
    expect(sourceLabel("agent-request")).toBe("Agent request");
    expect(sourceLabel("restore")).toBe("Restore");
  });

  test("passphrase strength: short is 0, length and variety raise it", () => {
    expect(passphraseStrength("").score).toBe(0);
    expect(passphraseStrength("abc123").score).toBe(0);
    expect(passphraseStrength("aaaaaaaaaaaaaaaaaaaaaa").score).toBe(1);
    expect(passphraseStrength("abcdefghij").score).toBe(1);
    expect(passphraseStrength("correct horse battery staple").score).toBe(4);
    expect(passphraseStrength("Tr0ub4dor&3xyz").score).toBeGreaterThanOrEqual(3);
  });

  test("parseVaultList refuses a payload of the wrong shape", () => {
    expect(parseVaultList(null)).toBeNull();
    expect(parseVaultList({ entries: [] })).toBeNull();
    expect(parseVaultList({ status: { state: "ok" }, entries: [{ label: "no ref" }] })).toBeNull();
  });
});
