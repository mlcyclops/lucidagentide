// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_kgmarket_1.ts — P-KGMARKET.1 (ADR-0206): the fail-closed entitlement gate.
//
// The PAYMENT gate decides access; it never substitutes for the P-KGPACK.4 import gate (signature + re-scan).
// This exercises the pure decision core across states + the fail-closed provider seam (an unconfigured public
// build has NO provider, so nothing is ever pulled without entitlement). The real Firebase/Stripe provider is
// private (P-KGMARKET.2), injected via registerMarketProvider.

import { decidePackAction, isEntitled, packActionLabel, type Entitlement } from "../../harness/market/entitlement.ts";
import { getMarketProvider, nullProvider, registerMarketProvider, type EntitlementProvider } from "../renderer/market_gate.ts";

function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(`ASSERT FAILED: ${msg}`); }
const NOW = "2026-07-10T00:00:00.000Z";
const ent = (o: Partial<Entitlement> = {}): Entitlement => ({ packId: "p1", state: "active", ...o });

console.log("== [1/3] the decision is fail-closed ==");
assert(decidePackAction({ signedIn: false }, ent(), NOW) === "signin", "not signed in → signin (even if 'entitled')");
assert(decidePackAction({ signedIn: true }, null, NOW) === "checkout", "signed in + no entitlement → checkout");
assert(decidePackAction({ signedIn: true }, ent(), NOW) === "pull", "signed in + active → pull");
assert(decidePackAction({ signedIn: true }, ent({ expiresAt: "2025-01-01T00:00:00.000Z" }), NOW) === "checkout", "lapsed subscription → checkout");
console.log("   signin / checkout / pull decided correctly; a lapsed or missing entitlement never yields pull");

console.log("== [2/3] an UNCONFIGURED public build can never pull ==");
assert(getMarketProvider() === nullProvider, "default provider is the fail-closed null provider");
assert(nullProvider.configured() === false, "null provider is not configured");
assert(!isEntitled(await nullProvider.entitlement("p1"), NOW), "null provider reports no entitlement");
assert((await nullProvider.downloadUrl("p1")) === null, "null provider issues no download URL");
console.log("   no provider ⇒ no identity, no entitlement, no download URL (storefront degrades to a product-page link)");

console.log("== [3/3] a registered provider takes over, and clearing falls back to null ==");
const fake: EntitlementProvider = {
  configured: () => true,
  auth: async () => ({ signedIn: true, email: "buyer@example.com" }),
  entitlement: async () => ent({ method: "gpc" }),
  checkoutUrl: async () => "https://checkout.example/p1",
  downloadUrl: async () => "https://signed.example/p1.lkgpack",
};
registerMarketProvider(fake);
assert(getMarketProvider() === fake && getMarketProvider().configured(), "registered provider is active");
assert(decidePackAction(await fake.auth(), await fake.entitlement("p1"), NOW) === "pull", "an entitled buyer → pull");
assert(packActionLabel("pull") === "Install", "pull labels as Install");
registerMarketProvider(null);
assert(getMarketProvider() === nullProvider, "clearing falls back to fail-closed null");
console.log("   provider injection works; the seam always defaults fail-closed");

console.log("== demo-P-KGMARKET.1 OK ==");
