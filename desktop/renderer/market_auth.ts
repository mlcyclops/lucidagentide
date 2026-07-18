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

// expiresAt = epoch ms. P-REMOTE.10b: `driveToken` is a Google `drive.file` OAuth access token (~1h, opaque)
// from the /signin `?drive=1` consent; `driveExpiresAt` = its epoch-ms expiry. Present only after the user
// authorizes Google Drive; preserved across an idToken refresh (the two tokens expire independently).
export interface TokenRecord { idToken: string; email?: string; expiresAt: number; refreshToken?: string; driveToken?: string; driveExpiresAt?: number }
export interface AuthStorage { get(): string | null; set(v: string): void; remove(): void }

/** Parse a `lucid://auth?token=...&email=...&exp=<epochSeconds>&refresh=<refreshToken>` deep link. `null` if
 *  it isn't a valid, token-bearing callback. `exp` is optional (defaults to +1h); `refresh` is optional but,
 *  when the hosted /signin page supplies it, lets {@link MarketAuth.freshIdToken} renew silently past +1h
 *  (P-REMOTE.2b) — the desktop relay reconnects hourly and needs a live token each time. */
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
  const refreshToken = u.searchParams.get("refresh") || undefined;
  // P-REMOTE.10b: an optional Google drive.file access token (from /signin `?drive=1`). Opaque + ~1h; handed
  // over the same lucid:// channel as the idToken (authlink.safeRedirectBase guarantees a lucid:// target).
  const driveToken = u.searchParams.get("drive_token") || undefined;
  const driveExpSec = Number(u.searchParams.get("drive_exp"));
  const driveExpiresAt = driveToken ? (Number.isFinite(driveExpSec) && driveExpSec > 0 ? driveExpSec * 1000 : nowMs + 3600_000) : undefined;
  return { idToken, email, expiresAt, refreshToken, ...(driveToken ? { driveToken, driveExpiresAt } : {}) };
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

  /** The stored token's epoch-ms expiry, or 0 when signed out. Used to push the expiry to the relay token
   *  cache alongside a freshly-renewed token (P-REMOTE.2c). */
  currentExpiresAt(): number {
    return this.load()?.expiresAt ?? 0;
  }

  /** P-REMOTE.10b: the stored Google `drive.file` access token while it has more than `skewMs` left, else null
   *  (the UI then re-runs the Drive consent). Access tokens are ~1h + opaque; we do NOT refresh them here (that
   *  would need Google's token endpoint + a Drive-scoped refresh token) - re-consent is simpler and fail-closed. */
  freshDriveToken(skewMs = 60_000): string | null {
    const rec = this.load();
    if (!rec?.driveToken || !rec.driveExpiresAt) return null;
    return rec.driveExpiresAt - skewMs > this.now() ? rec.driveToken : null;
  }

  /** A fresh ID token for the callable Authorization header, or null when signed out / expired (fail-closed). */
  async getIdToken(): Promise<string | null> {
    const rec = this.load();
    if (!rec || rec.expiresAt <= this.now()) return null;
    return rec.idToken;
  }

  /** P-REMOTE.2b: a token guaranteed live for the NEXT window — returns the stored ID token while it has more
   *  than `skewMs` left, else EXCHANGES the refresh token for a new one via Google's securetoken endpoint
   *  (`securetoken.googleapis.com/v1/token`, grant_type=refresh_token) and re-persists it. The desktop relay
   *  connection calls this on every (hourly) reconnect so it always presents a valid Firebase ID token.
   *  FAIL-CLOSED to null: signed out, no refresh token, a non-2xx response, or any error yields null (which
   *  the relay treats as "sign in again", never an unauthenticated connect). */
  async freshIdToken(opts: { apiKey: string; fetchImpl?: typeof fetch; skewMs?: number }): Promise<string | null> {
    const rec = this.load();
    if (!rec) return null;
    const skew = opts.skewMs ?? 60_000;
    const now = this.now();
    if (rec.expiresAt - skew > now) return rec.idToken; // still comfortably valid
    if (!rec.refreshToken || !opts.apiKey) return null; // cannot renew → fail-closed
    const fetchImpl = opts.fetchImpl ?? fetch;
    try {
      const res = await fetchImpl(`https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(opts.apiKey)}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(rec.refreshToken)}`,
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { id_token?: string; refresh_token?: string; expires_in?: string };
      if (!data.id_token) return null;
      const ttlSec = Number(data.expires_in) || 3600;
      const updated: TokenRecord = {
        idToken: data.id_token,
        email: rec.email,
        expiresAt: now + ttlSec * 1000,
        refreshToken: data.refresh_token || rec.refreshToken,
        // P-REMOTE.10b: the Google drive.file token expires independently of the Firebase idToken - keep it.
        ...(rec.driveToken ? { driveToken: rec.driveToken, driveExpiresAt: rec.driveExpiresAt } : {}),
      };
      this.save(updated);
      return updated.idToken;
    } catch {
      return null;
    }
  }
}
