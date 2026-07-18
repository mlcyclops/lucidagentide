// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/market_boot.ts — P-KGMARKET.4 part 2 (ADR-0206): the marketplace sign-in ORCHESTRATION.
//
// One place that decides WHICH entitlement provider is live and drives the hosted sign-in handshake:
//   • mode "firebase" — a real build: the Firebase provider (P-KGMARKET.3) is registered, its auth wired to a
//     `MarketAuth` token store (P-KGMARKET.4 part 2). `beginSignIn()` opens the hosted sign-in page in the
//     system browser; after Firebase Auth it redirects to `lucid://auth?token=...`, which the Electron main
//     process captures and hands to `handleAuthCallback()`.
//   • mode "stub" — dev / offline ("against stubs"): the stub provider (this increment) is registered and
//     `beginSignIn()` mints a LOCAL token via `MarketAuth.signInStub`, so the flow runs with no backend.
//   • mode "off" — public build with no config: the fail-closed nullProvider stays; the storefront is a hint.
//
// The mode decision + the sign-in URL construction are PURE (below) and unit-tested; the imperative init keeps
// only the singletons + the platform calls (localStorage, opening a browser), which are dependency-injected so
// the whole module is testable without Electron.

import { registerMarketProvider } from "./market_gate.ts";
import { registerFirebaseMarketProvider } from "./firebase_market_provider.ts";
import { makeStubMarketProvider, memoryLedger, type StubLedger } from "./market_stub_provider.ts";
import { MarketAuth, localAuthStorage, type AuthStorage } from "./market_auth.ts";
import type { AuthState } from "../../harness/market/entitlement.ts";

export type MarketMode = "firebase" | "stub" | "off";

export interface MarketBootConfig {
  /** Explicit mode. When absent it is inferred: a `functionsBaseUrl` ⇒ "firebase", else "off". */
  mode?: MarketMode;
  /** The deployed Cloud Functions base (the Firebase provider needs it). */
  functionsBaseUrl?: string;
  /** The hosted sign-in page (e.g. https://lucid-agent.web.app/signin). Required for firebase sign-in. */
  signInUrl?: string;
  /** P-REMOTE.2c: PUBLIC Firebase web apiKey for silent ID-token refresh (securetoken exchange) so the desktop
   *  relay reconnect stays authenticated past +1h. Public (identifies the project); absent -> no refresh. */
  firebaseApiKey?: string;
}

/** Pure: the effective mode. An explicit `mode` wins (but "firebase" without a base falls back to "off");
 *  otherwise a usable `functionsBaseUrl` implies "firebase", and everything else is "off" (fail-closed). */
export function chooseMarketMode(cfg: MarketBootConfig | null | undefined): MarketMode {
  if (!cfg) return "off";
  if (cfg.mode === "stub") return "stub";
  if (cfg.mode === "firebase" || (!cfg.mode && cfg.functionsBaseUrl)) return cfg.functionsBaseUrl ? "firebase" : "off";
  if (cfg.mode === "off") return "off";
  return cfg.functionsBaseUrl ? "firebase" : "off";
}

/** Pure: the hosted sign-in URL — the deep-link redirect target + optional login hint, added as query params
 *  so the sign-in page bounces back to `lucid://auth?token=...` when done. Returns "" if there is no base. */
export function buildSignInUrl(signInUrl: string | undefined, email?: string, redirect = "lucid://auth", drive = false): string {
  if (!signInUrl) return "";
  try {
    const u = new URL(signInUrl);
    u.searchParams.set("redirect_uri", redirect);
    if (email) u.searchParams.set("login_hint", email);
    if (drive) u.searchParams.set("drive", "1"); // P-REMOTE.10b: also request the Google drive.file scope
    return u.toString();
  } catch { return ""; }
}

export interface BeginSignInResult {
  /** True when a browser sign-in page was opened (firebase) and we now await the deep-link callback. */
  opened: boolean;
  /** True when sign-in completed synchronously (stub mode mints a local token immediately). */
  signedIn: boolean;
  /** Present when nothing could be done (e.g. mode "off", or firebase with no signInUrl). */
  reason?: string;
}

export interface MarketBootDeps {
  /** Token-store backing (defaults to localStorage). */
  storage?: AuthStorage;
  /** Opens the hosted sign-in page (defaults to window.open in a new tab). */
  openExternal?: (url: string) => void;
  /** Clock (defaults to Date.now) — injected so tests are deterministic. */
  now?: () => number;
  /** Stub-mode ledger + download resolver (dev only). */
  stubLedger?: StubLedger;
  stubDownloadUrlFor?: (packId: string) => string | null;
}

// ── Singletons (one per renderer) ──────────────────────────────────────────────────────────────────
let auth: MarketAuth | null = null;
let mode: MarketMode = "off";
let signInBase = "";
let firebaseApiKey = ""; // P-REMOTE.2c: public Firebase web key for silent ID-token refresh (may be empty)
let openExternalFn: (url: string) => void = (url) => { try { window.open(url, "_blank", "noopener"); } catch { /* no window */ } };

/** Register the right provider for `cfg` and prime the sign-in singletons. Idempotent (re-callable). Returns
 *  the effective mode. Everything platform-specific is injectable via `deps` so this runs headless in tests. */
export function initMarket(cfg: MarketBootConfig | null | undefined, deps: MarketBootDeps = {}): MarketMode {
  mode = chooseMarketMode(cfg);
  signInBase = cfg?.signInUrl ?? "";
  firebaseApiKey = cfg?.firebaseApiKey ?? "";
  if (deps.openExternal) openExternalFn = deps.openExternal;
  auth = new MarketAuth(deps.storage ?? localAuthStorage(), deps.now ?? (() => Date.now()));

  const authView = { getUser: () => auth!.getUser(), getIdToken: () => auth!.getIdToken() };
  if (mode === "firebase") {
    registerFirebaseMarketProvider({ functionsBaseUrl: cfg!.functionsBaseUrl!, auth: authView });
  } else if (mode === "stub") {
    registerMarketProvider(makeStubMarketProvider({
      getUser: () => auth!.getUser(),
      ledger: deps.stubLedger ?? memoryLedger(),
      downloadUrlFor: deps.stubDownloadUrlFor,
    }));
  } else {
    registerMarketProvider(null); // "off" ⇒ fail-closed nullProvider
  }
  return mode;
}

/** The signed-in state (fail-closed to signed-out before init). */
export function marketUser(): AuthState { return auth?.getUser() ?? { signedIn: false }; }

/** Kick off sign-in for the active mode. Firebase opens the hosted page (then the deep link calls
 *  handleAuthCallback); stub mints a local token immediately; off is a no-op. */
export function beginSignIn(email?: string): BeginSignInResult {
  if (!auth || mode === "off") return { opened: false, signedIn: false, reason: "marketplace sign-in is not configured" };
  if (mode === "stub") { auth.signInStub(email ?? "dev@lucid.local"); return { opened: false, signedIn: true }; }
  const url = buildSignInUrl(signInBase, email);
  if (!url) return { opened: false, signedIn: false, reason: "no sign-in URL configured" };
  openExternalFn(url);
  return { opened: true, signedIn: false };
}

/** P-REMOTE.10b: like beginSignIn but also requests the Google `drive.file` scope, so the /signin page returns
 *  a drive.file access token on the `lucid://auth` deep link. Drives the Share dock's "Authorize Google Drive". */
export function beginDriveSignIn(email?: string): BeginSignInResult {
  if (!auth || mode === "off") return { opened: false, signedIn: false, reason: "marketplace sign-in is not configured" };
  if (mode === "stub") { auth.signInStub(email ?? "dev@lucid.local"); return { opened: false, signedIn: true }; }
  const url = buildSignInUrl(signInBase, email, "lucid://auth", true);
  if (!url) return { opened: false, signedIn: false, reason: "no sign-in URL configured" };
  openExternalFn(url);
  return { opened: true, signedIn: false };
}

/** P-REMOTE.10b: the current live Google drive.file access token, or null (\u2192 run beginDriveSignIn to re-consent). */
export function freshDriveToken(skewMs = 60_000): string | null { return auth?.freshDriveToken(skewMs) ?? null; }

/** Apply a `lucid://auth?token=...` deep link forwarded from the Electron main process. Returns true when it
 *  was a valid callback that signed the user in. */
export function handleAuthCallback(url: string): boolean { return auth?.applyCallback(url) ?? false; }

/** Read the boot config the host injected (Electron main / an add-on / a dev global), or `{}` (⇒ "off", so a
 *  plain public build keeps the fail-closed nullProvider and the storefront stays a hint). */
export function readMarketBootConfig(): MarketBootConfig {
  try {
    const g = (globalThis as unknown as { __LUCID_MARKET__?: MarketBootConfig }).__LUCID_MARKET__;
    return g && typeof g === "object" ? g : {};
  } catch { return {}; }
}

/** Sign the user out (clears the stored token). */
export function marketSignOut(): void { auth?.signOut(); }

/** P-REMOTE.2c: a fresh Firebase credential (token + expiry) for the desktop relay's token push, silently
 *  renewed via the securetoken exchange when near expiry (needs the public apiKey; without it, only the
 *  still-valid stored token is returned). Null when signed out or unrenewable (fail-closed). */
export async function marketFreshCredential(): Promise<{ idToken: string; expiresAt: number } | null> {
  if (!auth) return null;
  const idToken = await auth.freshIdToken({ apiKey: firebaseApiKey });
  if (!idToken) return null;
  return { idToken, expiresAt: auth.currentExpiresAt() };
}

/** Test-only: drop the singletons so a fresh init starts clean. */
export function __resetMarketBootForTest(): void { auth = null; mode = "off"; signInBase = ""; registerMarketProvider(null); }
