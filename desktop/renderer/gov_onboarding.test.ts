// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/gov_onboarding.test.ts - P-GOVCUI.1: the pure Government/CUI onboarding decision + setup plan.

import { describe, expect, it } from "bun:test";
import {
  CIV_ASKSAGE_BASE, ASKSAGE_TOKEN_STEPS, decideGovOnboarding, planGovSetup,
} from "./gov_onboarding.ts";

describe("decideGovOnboarding (P-GOVCUI.1)", () => {
  it("asks when the user has NOT answered and no org policy forces gov routing", () => {
    expect(decideGovOnboarding({ decided: false, managedGovLocked: false })).toBe("ask");
  });
  it("never asks twice - a prior answer (either way) skips the step", () => {
    expect(decideGovOnboarding({ decided: true, managedGovLocked: false })).toBe("skip");
    // a prior answer wins even if the org later locks routing (the backend already enforces it)
    expect(decideGovOnboarding({ decided: true, managedGovLocked: true })).toBe("skip");
  });
  it("auto-enables (records the CUI posture, no question) when an org already forces gov-gateway-only routing", () => {
    expect(decideGovOnboarding({ decided: false, managedGovLocked: true })).toBe("auto-enable");
  });
});

describe("planGovSetup (P-GOVCUI.1)", () => {
  it("with a key: saves the key, persists the endpoint, and ENABLES lockdown", () => {
    expect(planGovSetup({ key: "  sk-gov-123 ", base: CIV_ASKSAGE_BASE })).toEqual({
      key: "sk-gov-123", baseUrl: CIV_ASKSAGE_BASE, enableLockdown: true,
    });
  });
  it("without a key (\"I'll add it later\"): still persists the prefilled CIV endpoint but NEVER flips lockdown", () => {
    // enabling lockdown with no gateway key would leave no gov model to route to -> the backend fail-closes
    // (blocks every turn). So a key-less setup records intent + endpoint only.
    const p = planGovSetup({ key: "   ", base: "" });
    expect(p).toEqual({ key: null, baseUrl: CIV_ASKSAGE_BASE, enableLockdown: false });
  });
  it("defaults an empty endpoint to the CIV (government) routing base, and keeps a custom one", () => {
    expect(planGovSetup({ key: "k", base: "" }).baseUrl).toBe(CIV_ASKSAGE_BASE);
    expect(planGovSetup({ key: "k", base: " https://api.civ.asksage.ai/server/ " }).baseUrl).toBe("https://api.civ.asksage.ai/server/");
  });
});

describe("constants (P-GOVCUI.1)", () => {
  it("prefills the CIV (government) endpoint, not the commercial one", () => {
    expect(CIV_ASKSAGE_BASE).toContain("api.civ.asksage.ai");
    expect(CIV_ASKSAGE_BASE).not.toContain("//api.asksage.ai"); // commercial endpoint must not be the CUI default
  });
  it("gives a novice concrete, ordered token steps ending at the paste field", () => {
    expect(ASKSAGE_TOKEN_STEPS.length).toBeGreaterThanOrEqual(3);
    expect(ASKSAGE_TOKEN_STEPS.join(" ")).toContain("Account"); // Settings -> Account tab
    expect(ASKSAGE_TOKEN_STEPS.join(" ")).toContain("API Key"); // Manage your API Keys
  });
});
