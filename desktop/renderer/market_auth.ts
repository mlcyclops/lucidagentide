// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/market_auth.ts — P-KGMARKET.4 part 2 (ADR-0206): the sign-in token store.
//
// This is the concrete `auth` the FirebaseMarketProvider (P-KGMARKET.3) needs: getUser() + getIdToken().
// The chosen flow (ADR-0206) is HOSTED sign-in: the app opens the system browser to a sign-in page on
// lucid-agent.web.app; after Firebase Auth it redirects to `lucid://auth?token=<idToken>&email=...&exp=...`,
// which the Electron main process captures and hands here via `applyCallback`. A dev `signInStub` mints a
// LOCAL token so the whole flow is exercisable offline / against stubs (never used in production).
//
// Pure + injectable (storage + clock) so it is fully testable. FAIL-CLOSED: an expired or absent token means
// signed-out / no id token → the entitlement decision falls to signin/checkout, never a pull.

import type { AuthState } from "../../harness/market/entitlement.ts";

export interface TokenRecord { idToken: string; email?: string; expiresAt: number } // expiresAt = epoch ms
export interface AuthStorage { get(): string | null; set(v: string): void; remove(): void }

/** Parse a `lucid://auth?token=...&email=...&exp=<epochSeconds>` deep link. `null` if it isn't a valid,
 *  token-bearing callback. `exp` is optional (defaults to +1h). */
export function parseAuthCallback(url: string, nowMs: number): TokenRecord | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== "lucid:") return null;
  const action = (u.host || u.pathname.replace(/^\/+/, "")).toLowerCase();
  if (action !== "auth") return null;
  const idToken = u.searchParams.get("token");
  if (!idToken) return null;
  const email = u.searchParams.get("email") || undefined;
  const expSec = Number(u.searchParams.get("exp"));
  const expiresAt = Number.isFinite(expSec) && expSec > 0 ? expSec * 1000 : nowMs + 3600_000;
  return { idToken, email, expiresAt };
}

/** localStorage-backed storage (the app default). Injectable so tests use a plain object. */
export function localAuthStorage(key = "lucid.market.auth"): AuthStorage {
  return {
    get: () => { try { return globalThis.localStorage?.getItem(key) ?? null; } catch { return null; } },
    set: (v) => { try { globalThis.localStorage?.setItem(key, v); } catch { /* ignore */ } },
    remove: () => { try { globalThis.localStorage?.removeItem(key); } catch { /* ignore */ } },
  };
}

export class MarketAuth {
  private cached: TokenRecord | null | undefined; // undefined = not yet loaded
  constructor(private storage: AuthStorage, private now: () => number = () => Date.now()) {}

  private load(): TokenRecord | null {
    if (this.cached !== undefined) return this.cached;
    const raw = this.storage.get();
    try { this.cached = raw ? (JSON.parse(raw) as TokenRecord) : null; } catch { this.cached = null; }
    return this.cached;
  }
  private save(rec: TokenRecord | null): void {
    this.cached = rec;
    if (rec) this.storage.set(JSON.stringify(rec)); else this.storage.remove();
  }

  /** Apply a `lucid://auth` deep link → persist the token. Returns true on a valid callback. */
  applyCallback(url: string): boolean {
    const rec = parseAuthCallback(url, this.now());
    if (!rec) return false;
    this.save(rec);
    return true;
  }

  /** DEV / offline sign-in: a LOCAL stub token (not a real Firebase token) so the flow runs without a
   *  deployed backend. Only ever called in stub mode. */
  signInStub(email: string, ttlSec = 3600): void {
    this.save({ idToken: `stub-token.${email}.${this.now()}`, email, expiresAt: this.now() + ttlSec * 1000 });
  }

  signOut(): void { this.save(null); }

  /** The signed-in state for the provider's auth() (expired token ⇒ signed out). */
  getUser(): AuthState {
    const rec = this.load();
    if (!rec || rec.expiresAt <= this.now()) return { signedIn: false };
    return { signedIn: true, email: rec.email };
  }

  /** A fresh ID token for the callable Authorization header, or null when signed out / expired (fail-closed). */
  async getIdToken(): Promise<string | null> {
    const rec = this.load();
    if (!rec || rec.expiresAt <= this.now()) return null;
    return rec.idToken;
  }
}
