// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/firebase_market_provider.ts — P-KGMARKET.3 (ADR-0206): the marketplace entitlement
// provider — a thin client over the PRIVATE Firebase callable functions (createCheckout / getEntitlement /
// getPackDownload, ADR-A023 in the add-on repo). Implements the P-KGMARKET.1 `EntitlementProvider` seam.
//
// No secrets + no Firebase SDK: a Firebase web config is public, and the security is enforced SERVER-side
// (Firestore/Storage rules + the callables). We call the callables over plain fetch using the documented
// protocol, so the app takes no heavyweight dependency. AUTH is INJECTED (getUser + getIdToken) so the
// sign-in mechanism (Firebase Auth / a browser OAuth flow) is a separate, swappable concern — this provider
// is pure request/response and fully testable. It is registered into `market_gate` ONLY when a config is
// supplied (managed config); with none, the fail-closed nullProvider stays and the storefront is a hint.

import type { AuthState, Entitlement, PackLicensing } from "../../harness/market/entitlement.ts";
import { registerMarketProvider, type EntitlementProvider } from "./market_gate.ts";

export interface FirebaseMarketConfig {
  /** e.g. https://us-central1-lucid-agent.cloudfunctions.net (the deployed functions base). */
  functionsBaseUrl: string;
  auth: {
    /** Current signed-in state (from Firebase Auth, injected by the host). */
    getUser: () => AuthState;
    /** A fresh Firebase ID token for the callable Authorization header, or null when signed out. */
    getIdToken: () => Promise<string | null>;
  };
}

/** Firebase callable protocol: POST { data } with `Authorization: Bearer <idToken>`; reply { result } | { error }. */
async function callable<T>(baseUrl: string, name: string, token: string | null, data: unknown): Promise<T> {
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ data }),
  });
  const json = (await res.json().catch(() => ({}))) as { result?: T; error?: { message?: string } };
  if (!res.ok || json?.error) throw new Error(json?.error?.message || `callable ${name} failed (${res.status})`);
  return json.result as T;
}

/** Build a Firebase-backed provider. Every call needs a signed-in ID token; a missing token or any error
 *  resolves to "not entitled / no URL", and the fail-closed decision core (decidePackAction) re-checks. */
export function makeFirebaseMarketProvider(cfg: FirebaseMarketConfig): EntitlementProvider {
  const { functionsBaseUrl: base, auth } = cfg;
  return {
    configured: () => true,
    auth: async () => auth.getUser(),
    entitlement: async (packId: string) => {
      const token = await auth.getIdToken();
      if (!token) return null;
      try { return await callable<Entitlement | null>(base, "getEntitlement", token, { packId }); }
      catch { return null; }
    },
    checkoutUrl: async (packId: string, _licensing: PackLicensing) => {
      const token = await auth.getIdToken();
      if (!token) return null;
      try { return (await callable<{ url: string }>(base, "createCheckout", token, { packId }))?.url ?? null; }
      catch { return null; }
    },
    downloadUrl: async (packId: string) => {
      const token = await auth.getIdToken();
      if (!token) return null;
      try { return (await callable<{ url: string }>(base, "getPackDownload", token, { packId }))?.url ?? null; }
      catch { return null; }
    },
  };
}

/** Construct + register the Firebase provider from managed config. Returns false (staying on the fail-closed
 *  nullProvider) when no usable config is supplied — so an un-provisioned build never enables a broken flow. */
export function registerFirebaseMarketProvider(cfg: FirebaseMarketConfig | null | undefined): boolean {
  if (!cfg?.functionsBaseUrl || !cfg.auth?.getUser || !cfg.auth?.getIdToken) return false;
  registerMarketProvider(makeFirebaseMarketProvider(cfg));
  return true;
}
