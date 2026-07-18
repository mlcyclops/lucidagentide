// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/market_config.ts — ADR-0223 (completes P-KGMARKET, ADR-0206): the KG-pack marketplace boot config the
// renderer reads via `__LUCID_MARKET__` (market_boot.ts). WITHOUT it the storefront's "Get pack" just opens the
// product web page (the fail-closed "off" hint); WITH it, "Get pack" runs the real Stripe Checkout → entitlement
// → signed-download flow through the private first-party Firebase functions (project `lucid-agent`, us-central1).
//
// The endpoints here are PUBLIC URLs — the Stripe secret keys and the pack files live SERVER-SIDE (Secret
// Manager + a private Storage bucket), so shipping these in the app leaks nothing (the same way KG_PACKS_URL is
// already hardcoded in the renderer). This module is pure + testable; the preload exposes its result.

export interface MarketBootConfig { mode?: "firebase" | "stub" | "off"; functionsBaseUrl?: string; signInUrl?: string; firebaseApiKey?: string }

// First-party defaults: the deployed `lucid-agent` Cloud Functions base + the hosted sign-in page that bounces
// back to `lucid://auth?token=...` (captured by the Electron main deep-link handler).
const DEFAULT_FUNCTIONS_URL = "https://us-central1-lucid-agent.cloudfunctions.net";
const DEFAULT_SIGNIN_URL = "https://lucid-agent.web.app/signin";

/** Build the marketplace boot config from env overrides + the first-party defaults. PURE.
 *  - `LUCID_MARKET_MODE=off`   → disabled (packs open the storefront web page — the pre-wiring behavior).
 *  - `LUCID_MARKET_MODE=stub`  → the local dev stub (no backend, for testing the flow offline).
 *  - otherwise (default)       → firebase mode, pointing at the official endpoints; override the URLs with
 *                                `LUCID_MARKET_FUNCTIONS_URL` / `LUCID_MARKET_SIGNIN_URL`.
 *  Graceful even before the backend is deployed: an unreachable `createCheckout` resolves to no URL, and
 *  `getPackFlow` falls back to opening the storefront page. */
export function marketBootConfig(env: Record<string, string | undefined> = process.env): MarketBootConfig {
  const mode = (env.LUCID_MARKET_MODE ?? "").trim().toLowerCase();
  if (mode === "off") return { mode: "off" };
  if (mode === "stub") return { mode: "stub" };
  return {
    mode: "firebase",
    functionsBaseUrl: (env.LUCID_MARKET_FUNCTIONS_URL || DEFAULT_FUNCTIONS_URL).replace(/\/+$/, ""),
    signInUrl: env.LUCID_MARKET_SIGNIN_URL || DEFAULT_SIGNIN_URL,
    // P-REMOTE.2c: the PUBLIC Firebase web apiKey lets the renderer silently renew the ID token (securetoken
    // refresh) for the gated relay past +1h. Public by design (identifies the project, not a credential);
    // absent -> fail-closed to no-refresh (re-sign-in needed). Set via LUCID_FIREBASE_API_KEY for a provisioned build.
    firebaseApiKey: env.LUCID_FIREBASE_API_KEY || undefined,
  };
}
