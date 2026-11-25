// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/market_auth_routes.ts - P-MARKET.AUTH2 (ADR-0684): the renderer's door to the engine custody of the LUCID
// store sign-in and the world receipts (market_auth_store.ts). dev.ts chains this after the vault routes:
//   const ma = await handleMarketAuthRoutes(req, p, { uiToken: TOKEN }); if (ma) return ma;
//
//   GET  /api/market/auth                                -> { view: AuthView | null }
//   POST /api/market/auth          { record }            -> { signedIn, email?, expiresAt, renewable }
//   POST /api/market/auth/renew    { apiKey, skewMs?, force? } -> { status, view }
//   POST /api/market/auth/clear    {}                    -> { signedIn: false }
//   GET  /api/market/receipts                            -> { receipts: { [worldId]: at } }
//   POST /api/market/receipts      { set?, drop? }       -> { count }
//
// UI token only, header only: no path is in dev.ts AGENT_ROUTES or QUERY_TOKEN_ROUTES, and this module re-checks the
// header token itself, so an agent or a `?t=` link never reaches them. The refresh token comes IN on the POST and never
// goes out: replies carry the AuthView (the short-lived ID and Drive tokens the renderer presents itself) or less, the
// POST reply carries no token at all, and refusals are fixed text. Nothing here logs a token. Shape: `{ ok: true, data }`
// or `{ ok: false, error }`, like vault_routes.ts.

import {
  clearMarketAuth, marketAuthView, readReceipts, renewMarketAuth, setMarketAuth, writeReceipts,
} from "./market_auth_store.ts";
import { parseTokenRecord, REFRESH_SKEW_MS } from "./market_token.ts";
import { tokenValid } from "./origin_guard.ts";

export const MARKET_AUTH_ROUTES: readonly string[] = ["/api/market/auth", "/api/market/auth/renew", "/api/market/auth/clear", "/api/market/receipts"];
const MAX_BODY = 64 * 1024;
/** The renewal window a caller may ask for: up to an hour (a Firebase ID token's whole life). */
const MAX_SKEW_MS = 3600_000;

export interface MarketAuthRouteCtx {
  /** The engine's UI token (dev.ts TOKEN). */
  uiToken: string;
  /** Tests: the securetoken fetch and the clock. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const reply = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const ok = (data: unknown): Response => reply(200, { ok: true, data });
const fail = (status: number, error: string): Response => reply(status, { ok: false, error });

async function jsonBody(req: Request): Promise<Record<string, unknown> | null> {
  const text = await req.text().catch(() => "");
  if (!text || text.length > MAX_BODY) return null;
  try {
    const raw: unknown = JSON.parse(text);
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Dispatch the market custody routes. Null for any other path. */
export async function handleMarketAuthRoutes(req: Request, p: string, ctx: MarketAuthRouteCtx): Promise<Response | null> {
  if (!MARKET_AUTH_ROUTES.includes(p)) return null;
  if (!tokenValid(req.headers.get("x-lucid-token"), ctx.uiToken)) return fail(403, "forbidden");
  const getOk = p === "/api/market/auth" || p === "/api/market/receipts";
  if (req.method === "GET" && getOk) {
    if (p === "/api/market/auth") return ok({ view: marketAuthView() });
    return ok({ receipts: readReceipts() });
  }
  if (req.method !== "POST") return fail(405, "method not allowed");
  const b = await jsonBody(req);
  if (!b) return fail(400, "a JSON body is required");

  if (p === "/api/market/auth") {
    const rec = parseTokenRecord(b.record);
    if (!rec) return fail(400, "not a sign-in record");
    try { setMarketAuth(rec); } catch { return fail(500, "the engine vault did not keep the sign-in"); }
    return ok({ signedIn: true, ...(rec.email ? { email: rec.email } : {}), expiresAt: rec.expiresAt, renewable: !!rec.refreshToken });
  }
  if (p === "/api/market/auth/renew") {
    const apiKey = typeof b.apiKey === "string" && b.apiKey.length <= 200 ? b.apiKey : "";
    const skewMs = typeof b.skewMs === "number" && Number.isFinite(b.skewMs) ? Math.min(Math.max(b.skewMs, 0), MAX_SKEW_MS) : REFRESH_SKEW_MS;
    try {
      return ok(await renewMarketAuth({ apiKey, skewMs, force: b.force === true, fetchImpl: ctx.fetchImpl, now: ctx.now?.() }));
    } catch {
      return fail(500, "the engine vault did not keep the renewed sign-in");
    }
  }
  if (p === "/api/market/auth/clear") {
    try { clearMarketAuth(); } catch { return fail(500, "the engine vault could not be read"); }
    return ok({ signedIn: false });
  }
  const set = b.set && typeof b.set === "object" && !Array.isArray(b.set) ? (b.set as Record<string, unknown>) : undefined;
  const drop = Array.isArray(b.drop) ? b.drop : undefined;
  if (!set && !drop) return fail(400, "nothing to change");
  try { return ok({ count: writeReceipts({ set, drop }) }); } catch { return fail(500, "the engine vault did not keep the receipts"); }
}
