// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/market_auth.ts - P-KGMARKET.4 part 2 (ADR-0206), P-MARKET.AUTH2 (ADR-0684): the store sign-in.
//
// This is the concrete `auth` the FirebaseMarketProvider (P-KGMARKET.3) needs: getUser() + getIdToken().
// The flow (ADR-0206) is HOSTED sign-in: the app opens the system browser to a sign-in page on lucid-agent.web.app;
// after Firebase Auth it redirects to `lucid://auth?token=<idToken>&email=...&exp=...&refresh=<refreshToken>`, which
// the Electron main process captures and hands here via `applyCallback`. A dev `signInStub` mints a LOCAL token so
// the flow runs offline / against stubs (never used in production).
//
// ADR-0684: the record is held by a CUSTODY, not here. In the app that is the engine (engineCustody over the
// /api/market/auth routes, market_auth_store.ts): the engine vault keeps it under the install, so a port-rolled
// origin, a restart and an update all find it, and the refresh token never comes back to the renderer. MarketAuth
// keeps only the AuthView in memory. A record an older version left in localStorage (`lucid.market.auth`) moves into
// the custody once at boot and is then deleted.
//
// Signed in = a live ID token OR a refresh token to renew it. getIdToken() renews through the custody when the ID
// token has less than REFRESH_SKEW_MS left; only Google refusing the refresh token itself signs the user out. An
// offline or failed renewal keeps the user signed in (the caller gets null for this call and retries after RETRY_MS),
// and world receipts (viz_worlds.ts) keep owned worlds usable meanwhile. FAIL-CLOSED where it matters: no record,
// or a refused refresh token, means signed out and no ID token, so the entitlement decision falls to signin.

import type { AuthState } from "../../harness/market/entitlement.ts";
import { parseTokenRecord, REFRESH_SKEW_MS, renewRecord, viewOf, type AuthView, type RenewReply, type TokenRecord } from "../market_token.ts";

/** A synchronous string slot: the legacy localStorage record, and storageCustody's backing (tests, stub, no engine). */
export interface AuthStorage { get(): string | null; set(v: string): void; remove(): void }

/** Where the sign-in record lives. load/put/clear throw when the custody cannot be reached or refuses. */
export interface AuthCustody {
  load(): Promise<AuthView | null>;
  put(rec: TokenRecord): Promise<void>;
  clear(): Promise<void>;
  /** Renew when the ID token is within `skewMs` of expiry; the reply's view is what the custody holds after it. */
  renew(o: { apiKey: string; skewMs: number }): Promise<RenewReply>;
}

/** The engine routes as bridge.ts exposes them; null means the engine did not answer (or refused). */
export interface MarketAuthApi {
  marketAuthGet(): Promise<{ view: AuthView | null } | null>;
  marketAuthPut(record: TokenRecord): Promise<boolean>;
  marketAuthClear(): Promise<boolean>;
  marketAuthRenew(o: { apiKey: string; skewMs: number }): Promise<RenewReply | null>;
}

/** The record an older version kept in this origin's localStorage (moved into the custody at boot). */
export const LEGACY_AUTH_KEY = "lucid.market.auth";
/** After a renewal the custody could not complete, wait this long before asking it again. */
export const RETRY_MS = 30_000;

/** Parse a `lucid://auth?token=...&email=...&exp=<epochSeconds>&refresh=<refreshToken>` deep link. `null` if it
 *  isn't a valid, token-bearing callback. `exp` is optional (defaults to +1h); `refresh` is optional but, when the
 *  hosted /signin page supplies it (it does), lets the custody renew silently past +1h. */
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

/** A localStorage slot (only the legacy record now: the app's custody is the engine). */
export function localAuthStorage(key = LEGACY_AUTH_KEY): AuthStorage {
  return {
    get: () => { try { return globalThis.localStorage?.getItem(key) ?? null; } catch { return null; } },
    set: (v) => { try { globalThis.localStorage?.setItem(key, v); } catch { /* ignore */ } },
    remove: () => { try { globalThis.localStorage?.removeItem(key); } catch { /* ignore */ } },
  };
}

/** A plain in-memory slot (a custody that lasts as long as the page). */
export function memoryAuthStorage(): AuthStorage {
  let v: string | null = null;
  return { get: () => v, set: (x) => { v = x; }, remove: () => { v = null; } };
}

function readSlot(storage: AuthStorage): TokenRecord | null {
  const raw = storage.get();
  if (!raw) return null;
  try { return parseTokenRecord(JSON.parse(raw)); } catch { return null; }
}

/** The app's custody: the engine vault, through the UI-token-only /api/market/auth routes. */
export function engineCustody(api: MarketAuthApi): AuthCustody {
  return {
    load: async () => {
      const r = await api.marketAuthGet();
      if (!r) throw new Error("the LUCID engine did not answer");
      return r.view;
    },
    put: async (rec) => { if (!(await api.marketAuthPut(rec))) throw new Error("the LUCID engine did not keep the sign-in"); },
    clear: async () => { if (!(await api.marketAuthClear())) throw new Error("the LUCID engine did not clear the sign-in"); },
    renew: async (o) => (await api.marketAuthRenew(o)) ?? { status: "unavailable", view: null },
  };
}

/** A custody over a synchronous slot, renewing with the same rule as the engine (tests, the dev stub, no engine). */
export function storageCustody(storage: AuthStorage, opts: { fetchImpl?: typeof fetch; now?: () => number } = {}): AuthCustody {
  return {
    load: async () => { const rec = readSlot(storage); return rec ? viewOf(rec) : null; },
    put: async (rec) => storage.set(JSON.stringify(rec)),
    clear: async () => storage.remove(),
    renew: async (o) => {
      const rec = readSlot(storage);
      if (!rec) return { status: "signed-out", view: null };
      const r = await renewRecord(rec, { apiKey: o.apiKey, skewMs: o.skewMs, fetchImpl: opts.fetchImpl ?? fetch, now: (opts.now ?? Date.now)() });
      if (r.status === "signed-out") { storage.remove(); return { status: "signed-out", view: null }; }
      if (r.status === "ok" && r.changed) storage.set(JSON.stringify(r.rec));
      return { status: r.status, view: viewOf(r.rec) };
    },
  };
}

export interface MarketAuthOptions {
  /** The PUBLIC Firebase web key the custody renews with (market_config.firebaseApiKey). */
  apiKey?: string;
  /** The legacy localStorage record to move into the custody once (the app passes localAuthStorage()). */
  legacy?: AuthStorage;
}

export class MarketAuth {
  private view: AuthView | null = null;
  /** Bumped by every local sign-in / sign-out, so a slower load or renewal never overwrites it. */
  private gen = 0;
  private readonly loaded: Promise<void>;
  private writes: Promise<void> = Promise.resolve();
  private renewing: Promise<string | null> | null = null;
  private retryAt = 0;

  constructor(private custody: AuthCustody, private now: () => number = () => Date.now(), private opts: MarketAuthOptions = {}) {
    this.loaded = this.load();
  }

  /** Read the custody, moving a legacy localStorage record into it when the custody holds none. An unreachable
   *  custody falls back to the legacy record for this session and keeps it for the next launch. */
  private async load(): Promise<void> {
    const gen = this.gen;
    let held: AuthView | null = null;
    let reached = true;
    try { held = await this.custody.load(); } catch { reached = false; }
    const legacy = this.opts.legacy ? readSlot(this.opts.legacy) : null;
    if (this.opts.legacy && !legacy) this.opts.legacy.remove(); // nothing usable there
    if (legacy && reached && !held && gen === this.gen) {
      const put = this.writes.then(() => this.custody.put(legacy));
      this.writes = put.catch(() => {});
      try { await put; this.opts.legacy?.remove(); } catch { /* the custody refused: keep the copy for next time */ }
      held = viewOf(legacy);
    } else if (legacy && reached && held) {
      this.opts.legacy?.remove(); // the custody's copy wins
    } else if (legacy && !reached) {
      held = viewOf(legacy);
    }
    if (gen === this.gen) this.view = held;
  }

  /** The custody has been read (the providers wait for it before answering who is signed in). */
  ready(): Promise<void> { return this.loaded; }
  /** Every queued custody write has landed or failed. */
  settled(): Promise<void> { return this.writes; }

  private set(rec: TokenRecord | null): void {
    this.gen++;
    this.view = rec ? viewOf(rec) : null;
    this.retryAt = 0;
    this.writes = this.writes.then(() => (rec ? this.custody.put(rec) : this.custody.clear())).catch(() => { /* held in memory for this session */ });
  }

  /** Apply a `lucid://auth` deep link: hand the record to the custody. Returns true on a valid callback. */
  applyCallback(url: string): boolean {
    const rec = parseAuthCallback(url, this.now());
    if (!rec) return false;
    this.set(rec);
    return true;
  }

  /** DEV / offline sign-in: a LOCAL stub token (not a real Firebase token) so the flow runs without a deployed
   *  backend. Only ever called in stub mode. */
  signInStub(email: string, ttlSec = 3600): void {
    this.set({ idToken: `stub-token.${email}.${this.now()}`, email, expiresAt: this.now() + ttlSec * 1000 });
  }

  signOut(): void { this.set(null); }

  /** Signed in while the ID token is live or a refresh token can renew it. */
  getUser(): AuthState {
    const v = this.view;
    if (!v || !(v.renewable || v.expiresAt > this.now())) return { signedIn: false };
    return { signedIn: true, email: v.email };
  }

  /** The held ID token's epoch-ms expiry, or 0 when signed out (pushed to the relay token cache, P-REMOTE.2c). */
  currentExpiresAt(): number {
    return this.view?.expiresAt ?? 0;
  }

  /** P-REMOTE.10b: the held Google `drive.file` access token while it has more than `skewMs` left, else null (the
   *  UI then re-runs the Drive consent). Access tokens are ~1h + opaque; they are not refreshed here. */
  freshDriveToken(skewMs = 60_000): string | null {
    const v = this.view;
    if (!v?.driveToken || !v.driveExpiresAt) return null;
    return v.driveExpiresAt - skewMs > this.now() ? v.driveToken : null;
  }

  /** A live ID token for the callable Authorization header and the relay: the held one while it has more than
   *  `skewMs` left, else a renewed one. Null when signed out, or when a renewal could not complete and the held
   *  token has lapsed (the user stays signed in; the next call after RETRY_MS asks again). */
  async getIdToken(skewMs = REFRESH_SKEW_MS): Promise<string | null> {
    await this.loaded;
    const v = this.view;
    if (!v) return null;
    const now = this.now();
    if (v.expiresAt - skewMs > now) return v.idToken;
    if (!v.renewable || now < this.retryAt) return v.expiresAt > now ? v.idToken : null;
    if (!this.renewing) this.renewing = this.renew(skewMs).finally(() => { this.renewing = null; });
    return this.renewing;
  }

  /** Background renewal (a timer, window focus, coming back online): renews only inside the skew window. */
  async keepFresh(): Promise<void> {
    await this.getIdToken();
  }

  private async renew(skewMs: number): Promise<string | null> {
    await this.writes; // the custody must hold the record this view came from
    const gen = this.gen;
    let r: RenewReply;
    try { r = await this.custody.renew({ apiKey: this.opts.apiKey ?? "", skewMs }); } catch { r = { status: "unavailable", view: null }; }
    if (gen === this.gen) {
      if (r.status === "signed-out") this.view = null;
      else if (r.view) this.view = r.view;
      this.retryAt = r.status === "unavailable" ? this.now() + RETRY_MS : 0;
    }
    const v = this.view;
    return v && v.expiresAt > this.now() ? v.idToken : null;
  }
}
