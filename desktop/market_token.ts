// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/market_token.ts - P-MARKET.AUTH2 (ADR-0684): the LUCID store sign-in record and its silent renewal.
//
// Shared by the engine custody (market_auth_store.ts, which holds the record in the engine vault under the install,
// not the renderer origin) and the renderer's MarketAuth (renderer/market_auth.ts, which only ever holds the
// AuthView: the record WITHOUT its refresh token). Pure: no Node, no DOM; fetch and the clock are injected.
//
// Renewal outcomes are three, and only one of them signs anyone out:
//   ok          the ID token is live (renewed here, or still outside the skew window);
//   signed-out  Google refused the refresh token itself (revoked, expired, the user disabled or deleted), or there
//               is no refresh token and the ID token has lapsed;
//   unavailable anything else (offline, a 5xx, a quota or API key problem, no API key to renew with). The record is
//               kept and the user stays signed in; the caller retries later.

export interface TokenRecord { idToken: string; email?: string; expiresAt: number; refreshToken?: string; driveToken?: string; driveExpiresAt?: number }

/** What the renderer holds: the record without its refresh token, plus whether one exists. */
export interface AuthView { idToken: string; email?: string; expiresAt: number; renewable: boolean; driveToken?: string; driveExpiresAt?: number }

export type RenewStatus = "ok" | "signed-out" | "unavailable";
/** A custody's answer to a renewal: the view after it (null when signed out). */
export interface RenewReply { status: RenewStatus; view: AuthView | null }
export type RenewResult = { status: "ok"; rec: TokenRecord; changed: boolean } | { status: "signed-out" } | { status: "unavailable"; rec: TokenRecord };

/** Renew when the ID token has less than this left: every entitlement, checkout and worlds call asks with it. */
export const REFRESH_SKEW_MS = 5 * 60_000;
/** Google's refresh-token refusals that mean the sign-in itself is over (securetoken `error.message`). */
const DEFINITIVE: Record<string, true> = { INVALID_REFRESH_TOKEN: true, TOKEN_EXPIRED: true, USER_DISABLED: true, USER_NOT_FOUND: true };
const MAX_TOKEN = 8192;
const RENEW_TIMEOUT_MS = 8_000;

const str = (v: unknown, max = MAX_TOKEN): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const time = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/** A stored or posted record, checked field by field (bounded strings, finite times); null for anything else. */
export function parseTokenRecord(v: unknown): TokenRecord | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const { idToken, expiresAt, email, refreshToken, driveToken, driveExpiresAt } = v as Record<string, unknown>;
  if (!str(idToken) || !time(expiresAt)) return null;
  if (email !== undefined && !str(email, 320)) return null;
  if (refreshToken !== undefined && !str(refreshToken)) return null;
  return {
    idToken, expiresAt,
    ...(str(email, 320) ? { email } : {}),
    ...(str(refreshToken) ? { refreshToken } : {}),
    ...(str(driveToken) && time(driveExpiresAt) ? { driveToken, driveExpiresAt } : {}),
  };
}

/** The renderer's view of a record: never the refresh token. */
export function viewOf(rec: TokenRecord): AuthView {
  return {
    idToken: rec.idToken, expiresAt: rec.expiresAt, renewable: !!rec.refreshToken,
    ...(rec.email ? { email: rec.email } : {}),
    ...(rec.driveToken ? { driveToken: rec.driveToken, driveExpiresAt: rec.driveExpiresAt } : {}),
  };
}

/** The first word of a securetoken error message ("INVALID_REFRESH_TOKEN", "TOKEN_EXPIRED : ..."), or "". */
async function errorCode(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { error?: { message?: unknown } };
    return typeof j?.error?.message === "string" ? j.error.message.trim().split(/[\s:]/)[0] ?? "" : "";
  } catch { return ""; }
}

/** Renew `rec` when its ID token is within `skewMs` of expiry (always with `force`), via Google's securetoken
 *  endpoint (`securetoken.googleapis.com/v1/token`, grant_type=refresh_token), the one network call here. The drive
 *  token expires independently and is carried over. See the header for the three outcomes. */
export async function renewRecord(rec: TokenRecord, o: { apiKey: string; fetchImpl: typeof fetch; now: number; skewMs?: number; force?: boolean }): Promise<RenewResult> {
  const skew = o.skewMs ?? REFRESH_SKEW_MS;
  if (!o.force && rec.expiresAt - skew > o.now) return { status: "ok", rec, changed: false };
  if (!rec.refreshToken) return rec.expiresAt > o.now ? { status: "ok", rec, changed: false } : { status: "signed-out" };
  if (!o.apiKey) return { status: "unavailable", rec };
  let res: Response;
  try {
    res = await o.fetchImpl(`https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(o.apiKey)}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(rec.refreshToken)}`,
      signal: AbortSignal.timeout(RENEW_TIMEOUT_MS), // a hung network is "unavailable", never a stuck caller
    });
  } catch {
    return { status: "unavailable", rec }; // offline: never a sign-out
  }
  if (!res.ok) return res.status === 400 && DEFINITIVE[await errorCode(res)] === true ? { status: "signed-out" } : { status: "unavailable", rec };
  let data: { id_token?: unknown; refresh_token?: unknown; expires_in?: unknown } | null;
  try { data = (await res.json()) as typeof data; } catch { return { status: "unavailable", rec }; }
  const idToken = data?.id_token;
  const rolled = data?.refresh_token;
  if (!str(idToken)) return { status: "unavailable", rec };
  const ttlSec = Number(data?.expires_in) > 0 ? Number(data?.expires_in) : 3600;
  const next: TokenRecord = { ...rec, idToken, expiresAt: o.now + ttlSec * 1000, refreshToken: str(rolled) ? rolled : rec.refreshToken };
  return { status: "ok", rec: next, changed: true };
}
