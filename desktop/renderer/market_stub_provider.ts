// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/market_stub_provider.ts — P-KGMARKET.4 part 2 (ADR-0206): a DEV / OFFLINE entitlement
// provider so the whole sign-in → own → pull flow is exercisable WITHOUT a deployed Firebase/Stripe backend
// ("against stubs"). It implements the same `EntitlementProvider` seam as the real Firebase provider
// (P-KGMARKET.3), backed by an injected sign-in view (MarketAuth.getUser) plus a local "owned packs" ledger.
//
// NEVER shipped as the live provider in a real build: it is registered only when boot config says mode:"stub"
// (a developer opt-in). In dev, "checkout" grants the pack INSTANTLY (there is no real payment), which lets a
// demo prove the offline path end to end. It is still FAIL-CLOSED where it matters: signed out ⇒ nothing is
// entitled and nothing is granted, exactly like production. The download itself, when wired, still flows
// through the P-KGPACK.4 verify + re-scan import gate — a stub grants access, not trust.

import type { AuthState, Entitlement, PackLicensing } from "../../harness/market/entitlement.ts";
import type { EntitlementProvider } from "./market_gate.ts";

/** A tiny "which packs does this user own" ledger. In-memory by default; a real dev build could persist it. */
export interface StubLedger {
  owned(): string[];
  has(packId: string): boolean;
  grant(packId: string): void;
  revoke(packId: string): void;
}

/** An in-memory ledger, optionally seeded with already-owned pack ids. */
export function memoryLedger(seed: string[] = []): StubLedger {
  const set = new Set(seed);
  return {
    owned: () => [...set],
    has: (id) => set.has(id),
    grant: (id) => { if (id) set.add(id); },
    revoke: (id) => set.delete(id),
  };
}

export interface StubProviderOpts {
  /** Current sign-in state — normally `() => marketAuth.getUser()`. */
  getUser: () => AuthState;
  /** The owned-packs ledger (defaults to an empty in-memory one). */
  ledger?: StubLedger;
  /** Where a signed download would come from. Given the pack id, returns a URL the install path can fetch
   *  (e.g. a `file://` / http URL to a locally-exported `.lkgpack.zip`). Absent ⇒ no download in stub mode. */
  downloadUrlFor?: (packId: string) => string | null;
}

/** Build the DEV stub provider. Signed out ⇒ nothing entitled / no grant / no URL (fail-closed, same as prod).
 *  Signed in ⇒ `checkoutUrl` instantly grants the pack (dev has no real payment) and `entitlement` then reports
 *  it active, so `decidePackAction` advances signin → checkout → pull without any network. */
export function makeStubMarketProvider(opts: StubProviderOpts): EntitlementProvider {
  const ledger = opts.ledger ?? memoryLedger();
  const signedIn = () => opts.getUser().signedIn === true;
  return {
    configured: () => true,
    auth: async () => opts.getUser(),
    entitlement: async (packId: string): Promise<Entitlement | null> =>
      signedIn() && ledger.has(packId) ? { packId, state: "active", method: "card" } : null,
    checkoutUrl: async (packId: string, _licensing: PackLicensing): Promise<string | null> => {
      if (!signedIn()) return null;      // must be signed in to buy — fail-closed
      ledger.grant(packId);              // DEV: a purchase completes instantly (no real Stripe)
      return null;                       // no external checkout page in stub mode
    },
    downloadUrl: async (packId: string): Promise<string | null> =>
      signedIn() && ledger.has(packId) ? (opts.downloadUrlFor?.(packId) ?? null) : null,
  };
}
