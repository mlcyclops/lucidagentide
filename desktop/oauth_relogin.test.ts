// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-AUTH.RELOGIN1 (ADR-0640): a lost sign-in is told apart from a deliberate sign-out and a fresh install,
// and the model it displaced comes back once the user logs in again.

import { describe, expect, test } from "bun:test";
import { LUCID_INACTIVE_CAUSE } from "./account_policy.ts";
import type { ProviderAuth, ProviderAuthSnapshot } from "./auth_status.ts";
import { annotateRelogin, clearDisplaced, EMPTY_OAUTH_MEMORY, forgetOauth, observeOauth, reloginNeed, type VaultRowLite } from "./oauth_relogin.ts";

const prov = (id: string, oauthId: string, oauthActive: boolean): ProviderAuth =>
  ({ id, name: id, env: "", oauthId, canOauth: true, oauthActive, keySet: false });
const snapshot = (claudeActive: boolean): ProviderAuthSnapshot => ({
  gateway: [], others: [],
  majors: [prov("anthropic", "anthropic", claudeActive), prov("openai", "openai-codex", true)],
  vault: { custody: "dpapi", state: "ok" },
});
const row = (provider: string, disabled_cause: string | null): VaultRowLite => ({ provider, credential_type: "oauth", disabled_cause });
const codex = row("openai-codex", null);

describe("reloginNeed", () => {
  test("omp disabling the row after a definitive refresh failure is an expired sign-in, cause kept", () => {
    const need = reloginNeed("anthropic", [row("anthropic", "auth-broker refresh failed: Error: invalid_grant")], EMPTY_OAUTH_MEMORY);
    expect(need).toEqual({ reason: "expired", detail: "auth-broker refresh failed: Error: invalid_grant" });
  });
  test("a sign-out the user asked for never prompts", () => {
    const seen = { seen: ["anthropic"], displaced: {} };
    expect(reloginNeed("anthropic", [row("anthropic", "deleted by user")], seen)).toBeUndefined();
    expect(reloginNeed("anthropic", [row("anthropic", LUCID_INACTIVE_CAUSE)], seen)).toBeUndefined();
    // a refresh failure on an old row does not override a deliberate sign-out on the same provider
    expect(reloginNeed("anthropic", [row("anthropic", "auth-broker refresh failed: revoked"), row("anthropic", "deleted by user")], seen)).toBeUndefined();
  });
  test("a vanished row is missing only if LUCID saw it signed in; a fresh install is quiet", () => {
    expect(reloginNeed("anthropic", [], { seen: ["anthropic"], displaced: {} })).toEqual({ reason: "missing" });
    expect(reloginNeed("anthropic", [], EMPTY_OAUTH_MEMORY)).toBeUndefined();
  });
  test("any active row means signed in, whatever older rows say", () => {
    expect(reloginNeed("anthropic", [row("anthropic", "auth-broker refresh failed: invalid_grant"), row("anthropic", null)], EMPTY_OAUTH_MEMORY)).toBeUndefined();
  });
});

describe("observeOauth", () => {
  test("remembers sign-ins, then records the model a lost one displaced", () => {
    const m1 = observeOauth(snapshot(true), [row("anthropic", null), codex], EMPTY_OAUTH_MEMORY, ["", ""]);
    expect(m1.seen).toEqual(["anthropic", "openai-codex"]);
    // Claude's row disappears (provider-side upgrade). The user was on Opus: that is what to go back to.
    const m2 = observeOauth(snapshot(false), [codex], m1, ["anthropic/claude-opus-5-5", "anthropic/claude-opus-5-5"]);
    expect(m2.displaced).toEqual({ anthropic: "anthropic/claude-opus-5-5" });
    // The fallback later lands in lastModel / chosen; the recorded model is not overwritten.
    const m3 = observeOauth(snapshot(false), [codex], m2, ["openai-codex/gpt-6.1-terra", "openai-codex/gpt-6.1-terra"]);
    expect(m3).toBe(m2);
  });
  test("a model on another provider is not recorded as displaced", () => {
    const m = observeOauth(snapshot(false), [codex], { seen: ["anthropic", "openai-codex"], displaced: {} }, ["openai-codex/gpt-6.1-terra", ""]);
    expect(m.displaced).toEqual({});
  });
  test("a deliberate sign-out seen in the vault forgets the provider and its displaced model", () => {
    const m = observeOauth(snapshot(false), [row("anthropic", "deleted by user"), codex], { seen: ["anthropic", "openai-codex"], displaced: { anthropic: "anthropic/claude-opus-5-5" } }, ["", ""]);
    expect(m).toEqual({ seen: ["openai-codex"], displaced: {} });
  });
  test("returns the same object when nothing changed, so the engine skips the settings write", () => {
    const m = { seen: ["anthropic", "openai-codex"], displaced: {} };
    expect(observeOauth(snapshot(true), [row("anthropic", null), codex], m, ["", ""])).toBe(m);
  });
});

describe("annotateRelogin", () => {
  test("flags the lost sign-in, and offers the displaced model once it is back", () => {
    const mem = { seen: ["anthropic", "openai-codex"], displaced: { anthropic: "anthropic/claude-opus-5-5" } };
    const lost = annotateRelogin(snapshot(false), [codex], mem).majors[0]!;
    expect(lost.relogin).toEqual({ reason: "missing" });
    const back = annotateRelogin(snapshot(true), [row("anthropic", null), codex], mem).majors[0]!;
    expect(back.relogin).toBeUndefined();
    expect(back.restoreModel).toBe("anthropic/claude-opus-5-5");
    expect(annotateRelogin(snapshot(true), [row("anthropic", null), codex], clearDisplaced(mem, "anthropic")).majors[0]!.restoreModel).toBeUndefined();
  });
  test("LUCID's own Disconnect forgets the provider, so the vanished row stays quiet", () => {
    const mem = forgetOauth({ seen: ["anthropic", "openai-codex"], displaced: { anthropic: "anthropic/claude-opus-5-5" } }, ["anthropic"]);
    expect(annotateRelogin(snapshot(false), [codex], mem).majors[0]!.relogin).toBeUndefined();
  });
});
