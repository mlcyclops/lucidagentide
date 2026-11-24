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

import type { AuthState, Entitlement, GovAccessRequest, GovAccessStatus, PackLicensing } from "../../harness/market/entitlement.ts";

/** P-WORLDS.STORE1: extra checkout input. `picks` is the Sponsor world pack's choice of exactly 6 worlds the
 *  buyer does not own yet (the backend refuses anything else); every other pack takes none. */
export interface CheckoutOptions { picks?: readonly string[] }

/** P-WORLDS.STORE1: spending one Sponsor world credit on a world. `remaining` is the credits left after it;
 *  `error` is the backend's own reason (no Sponsor pack, already owned, credits lapsed or used up). */
export type RedeemResult = { ok: true; remaining: number } | { ok: false; error: string };

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
  checkoutUrl(packId: string, licensing: PackLicensing, opts?: CheckoutOptions): Promise<string | null>;
  /** P-WORLDS.STORE1: unlock a `world-*` id with one Sponsor world credit (no payment, no checkout page). */
  redeemWorldCredit(packId: string): Promise<RedeemResult>;
  /** A short-lived signed URL to the .lkgpack / .lplugin package, issued ONLY when entitled; null otherwise. */
  downloadUrl(packId: string): Promise<string | null>;
  /** P-PLUGINS.5 (ADR-0465): the signed-in user's government-access record; "none" when unknown. */
  govAccess(): Promise<GovAccessStatus>;
  /** P-PLUGINS.5: file a government-access request; the resulting status, or null when it could not be sent. */
  requestGovAccess(req: GovAccessRequest): Promise<GovAccessStatus | null>;
}

/** The fail-closed default: no identity, no entitlement, no URLs, no government access. */
export const nullProvider: EntitlementProvider = {
  configured: () => false,
  auth: async () => ({ signedIn: false }),
  entitlement: async () => null,
  checkoutUrl: async () => null,
  redeemWorldCredit: async () => ({ ok: false, error: "The LUCID store is not set up in this build." }),
  downloadUrl: async () => null,
  govAccess: async () => "none",
  requestGovAccess: async () => null,
};

let registered: EntitlementProvider | null = null;

/** Inject the private Firebase-backed provider (or null to clear). Called by the add-on at boot. */
export function registerMarketProvider(p: EntitlementProvider | null): void { registered = p; }

/** The active provider — the registered one, or the fail-closed null provider. */
export function getMarketProvider(): EntitlementProvider { return registered ?? nullProvider; }
