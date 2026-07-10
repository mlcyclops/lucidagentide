// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/market_gate.ts — P-KGMARKET.1 (ADR-0206): the entitlement PROVIDER seam (public).
//
// PUBLIC-SEAM ONLY. The public repo ships this interface + a FAIL-CLOSED null provider; the real provider —
// Firebase Auth + the Cloud Functions that create Stripe Checkout sessions and mint short-lived signed pack
// download URLs — is PRIVATE add-on IP (P-KGMARKET.2), injected at runtime via `registerMarketProvider`
// (same injection pattern as the skills publisher's setPublishers). Until a provider is registered,
// `getMarketProvider()` returns `nullProvider`: not signed in, nothing entitled, no checkout/download URL —
// so "Get pack" degrades to opening the product page and NOTHING is ever pulled without entitlement.

import type { AuthState, Entitlement, PackLicensing } from "../../harness/market/entitlement.ts";

/** The transport the storefront calls. A registered provider talks to the private Firebase functions; the
 *  default null provider answers fail-closed. All methods are best-effort — a thrown/absent answer is treated
 *  as "not entitled" by the caller (the decision core re-checks). */
export interface EntitlementProvider {
  /** True once a real provider (Firebase config present) is registered. */
  configured(): boolean;
  /** Who is signed in (Firebase Auth). */
  auth(): Promise<AuthState>;
  /** The (user, pack) entitlement per the backend, or null if none/unknown. */
  entitlement(packId: string): Promise<Entitlement | null>;
  /** A Stripe Checkout URL to open for this pack + licensing, or null if unavailable. */
  checkoutUrl(packId: string, licensing: PackLicensing): Promise<string | null>;
  /** A short-lived signed URL to the .lkgpack, issued ONLY when entitled; null otherwise. */
  downloadUrl(packId: string): Promise<string | null>;
}

/** The fail-closed default: no identity, no entitlement, no URLs. */
export const nullProvider: EntitlementProvider = {
  configured: () => false,
  auth: async () => ({ signedIn: false }),
  entitlement: async () => null,
  checkoutUrl: async () => null,
  downloadUrl: async () => null,
};

let registered: EntitlementProvider | null = null;

/** Inject the private Firebase-backed provider (or null to clear). Called by the add-on at boot. */
export function registerMarketProvider(p: EntitlementProvider | null): void { registered = p; }

/** The active provider — the registered one, or the fail-closed null provider. */
export function getMarketProvider(): EntitlementProvider { return registered ?? nullProvider; }
