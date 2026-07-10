// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/market/entitlement.test.ts — P-KGMARKET.1 (ADR-0206): the fail-closed entitlement decision. This
// is the PAYMENT gate's core, so it is over-tested: not-signed-in always gates to signin; ONLY an active,
// unexpired entitlement yields `pull`; a lapsed subscription (expiresAt past) or a stale "active" record is
// treated as NOT entitled; anything missing/unknown falls to `checkout`. Absence is never ownership.

import { describe, expect, test } from "bun:test";
import { decidePackAction, isEntitled, packActionLabel, type Entitlement } from "./entitlement.ts";

const NOW = "2026-07-10T00:00:00.000Z";
const IN = { signedIn: true, email: "buyer@example.com" };
const OUT = { signedIn: false };
const ent = (over: Partial<Entitlement> = {}): Entitlement => ({ packId: "p1", state: "active", ...over });

describe("decidePackAction — fail-closed", () => {
  test("not signed in ⇒ signin, regardless of any entitlement", () => {
    expect(decidePackAction(OUT, null, NOW)).toBe("signin");
    expect(decidePackAction(OUT, ent(), NOW)).toBe("signin");
    expect(decidePackAction(null, ent(), NOW)).toBe("signin");
  });

  test("signed in + active one-time entitlement ⇒ pull", () => {
    expect(decidePackAction(IN, ent(), NOW)).toBe("pull");
  });

  test("signed in + active subscription still in date ⇒ pull", () => {
    expect(decidePackAction(IN, ent({ expiresAt: "2027-01-01T00:00:00.000Z", method: "subscription" }), NOW)).toBe("pull");
  });

  test("signed in + LAPSED subscription (expiresAt in the past) ⇒ checkout (fail-closed on expiry)", () => {
    expect(decidePackAction(IN, ent({ expiresAt: "2025-01-01T00:00:00.000Z", method: "subscription" }), NOW)).toBe("checkout");
  });

  test("signed in + no / expired / none entitlement ⇒ checkout", () => {
    expect(decidePackAction(IN, null, NOW)).toBe("checkout");
    expect(decidePackAction(IN, ent({ state: "expired" }), NOW)).toBe("checkout");
    expect(decidePackAction(IN, ent({ state: "none" }), NOW)).toBe("checkout");
  });
});

describe("isEntitled", () => {
  test("only active + unexpired counts", () => {
    expect(isEntitled(null, NOW)).toBe(false);
    expect(isEntitled(ent(), NOW)).toBe(true);
    expect(isEntitled(ent({ state: "expired" }), NOW)).toBe(false);
    expect(isEntitled(ent({ expiresAt: "2025-01-01T00:00:00.000Z" }), NOW)).toBe(false);
    expect(isEntitled(ent({ expiresAt: "2027-01-01T00:00:00.000Z" }), NOW)).toBe(true);
  });
  test("expiry exactly at now is treated as lapsed (<=)", () => {
    expect(isEntitled(ent({ expiresAt: NOW }), NOW)).toBe(false);
  });
});

describe("packActionLabel", () => {
  test("labels the primary action", () => {
    expect(packActionLabel("pull")).toBe("Install");
    expect(packActionLabel("signin")).toBe("Sign in to buy");
    expect(packActionLabel("checkout")).toBe("Get pack");
  });
});
