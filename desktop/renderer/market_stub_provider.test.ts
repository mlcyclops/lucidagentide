// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/market_stub_provider.test.ts — P-KGMARKET.4 part 2 (ADR-0206): the DEV stub provider is
// fail-closed when signed out (no entitlement, no grant, no URL) and, once signed in, grants on checkout so
// the offline decide-path advances signin → checkout → pull. Pins the ledger + the download resolver.

import { describe, expect, test } from "bun:test";
import { makeStubMarketProvider, memoryLedger } from "./market_stub_provider.ts";
import { decidePackAction, type AuthState } from "../../harness/market/entitlement.ts";

const NOW = "2026-07-10T00:00:00.000Z";

describe("makeStubMarketProvider", () => {
  test("signed OUT: nothing entitled, checkout grants nothing, no download (fail-closed)", async () => {
    const ledger = memoryLedger();
    const p = makeStubMarketProvider({ getUser: () => ({ signedIn: false }), ledger });
    expect(await p.entitlement("kgp-cleared")).toBeNull();
    expect(await p.checkoutUrl("kgp-cleared", "one-time")).toBeNull();
    expect(ledger.owned()).toEqual([]);            // no grant while signed out
    expect(await p.downloadUrl("kgp-cleared")).toBeNull();
  });

  test("signed in: checkout grants, then entitled → the decision advances signin → checkout → pull", async () => {
    let user: AuthState = { signedIn: false };
    const ledger = memoryLedger();
    const p = makeStubMarketProvider({ getUser: () => user, ledger, downloadUrlFor: (id) => `file:///tmp/${id}.lkgpack.zip` });

    // signed out ⇒ signin
    expect(decidePackAction(await p.auth(), await p.entitlement("kgp-cleared"), NOW)).toBe("signin");

    // sign in ⇒ not owned yet ⇒ checkout
    user = { signedIn: true, email: "dev@lucid.local" };
    expect(decidePackAction(await p.auth(), await p.entitlement("kgp-cleared"), NOW)).toBe("checkout");

    // buy (dev: instant grant) ⇒ owned ⇒ pull, and a download URL is now available
    await p.checkoutUrl("kgp-cleared", "one-time");
    expect(ledger.has("kgp-cleared")).toBe(true);
    expect(decidePackAction(await p.auth(), await p.entitlement("kgp-cleared"), NOW)).toBe("pull");
    expect(await p.downloadUrl("kgp-cleared")).toBe("file:///tmp/kgp-cleared.lkgpack.zip");
  });

  test("a seeded/owned pack is entitled the moment the user signs in (no checkout needed)", async () => {
    let user: AuthState = { signedIn: false };
    const p = makeStubMarketProvider({ getUser: () => user, ledger: memoryLedger(["kgp-owned"]) });
    expect(await p.entitlement("kgp-owned")).toBeNull();       // still gated on sign-in
    user = { signedIn: true };
    expect((await p.entitlement("kgp-owned"))?.state).toBe("active");
  });

  test("revoke removes entitlement (defense-in-depth on the ledger)", async () => {
    const ledger = memoryLedger(["kgp-x"]);
    const p = makeStubMarketProvider({ getUser: () => ({ signedIn: true }), ledger });
    expect((await p.entitlement("kgp-x"))?.state).toBe("active");
    ledger.revoke("kgp-x");
    expect(await p.entitlement("kgp-x")).toBeNull();
  });
});
