// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/market_gate.test.ts — P-KGMARKET.1 (ADR-0206): the entitlement provider seam. Pins: the
// default is the FAIL-CLOSED null provider (not signed in, nothing entitled, no URLs), a registered provider
// takes over, and clearing the registration falls back to null — so an unconfigured build can never pull.

import { afterEach, describe, expect, test } from "bun:test";
import { getMarketProvider, nullProvider, registerMarketProvider, type EntitlementProvider } from "./market_gate.ts";
import { decidePackAction } from "../../harness/market/entitlement.ts";

afterEach(() => registerMarketProvider(null)); // never leak a provider between tests

describe("market_gate provider seam", () => {
  test("the default provider is fail-closed (nullProvider)", async () => {
    expect(getMarketProvider()).toBe(nullProvider);
    expect(nullProvider.configured()).toBe(false);
    expect(await nullProvider.auth()).toEqual({ signedIn: false });
    expect(await nullProvider.entitlement("p1")).toBeNull();
    expect(await nullProvider.checkoutUrl("p1", "one-time")).toBeNull();
    expect(await nullProvider.downloadUrl("p1")).toBeNull();
  });

  test("an unconfigured build decides `signin` for every pack (never pull)", async () => {
    const auth = await getMarketProvider().auth();
    expect(decidePackAction(auth, await getMarketProvider().entitlement("p1"), "2026-07-10T00:00:00.000Z")).toBe("signin");
  });

  test("a registered provider takes over, and clearing it falls back to null", async () => {
    const fake: EntitlementProvider = {
      configured: () => true,
      auth: async () => ({ signedIn: true, email: "a@b.com" }),
      entitlement: async () => ({ packId: "p1", state: "active" }),
      checkoutUrl: async () => "https://checkout.example/p1",
      downloadUrl: async () => "https://signed.example/p1.lkgpack",
    };
    registerMarketProvider(fake);
    expect(getMarketProvider()).toBe(fake);
    expect(getMarketProvider().configured()).toBe(true);
    expect(decidePackAction(await fake.auth(), await fake.entitlement("p1"), "2026-07-10T00:00:00.000Z")).toBe("pull");

    registerMarketProvider(null);
    expect(getMarketProvider()).toBe(nullProvider);
  });
});
