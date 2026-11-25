// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/market_auth_store.ts - P-MARKET.AUTH2 (ADR-0684): engine custody of the LUCID store sign-in and the
// world receipts.
//
// Before this, the sign-in record (ID token, refresh token, email) and the world receipts lived in the renderer's
// localStorage, which is per ORIGIN: a launch whose port rolled (ADR-0458) opened an empty store, so the user was
// signed out and every premium world showed "Get". Both now live in the engine vault (vault_store.ts, ADR-0474),
// which sits beside the settings file under the user's home, not under the renderer origin or the install folder,
// so a port roll, a restart and an app update all find them:
//   market:auth      the TokenRecord as JSON (kind oauth). The refresh token goes in through setMarketAuth and never
//                    comes back out: readers get viewOf() (market_token.ts), and renewal runs here.
//   market:receipts  { [worldId]: atEpochMs } as JSON (kind json): when an entitlement was last seen active.
// Every vault write throws on failure (fail-closed, never a plaintext fallback); the routes turn that into a 500 and
// the renderer keeps its in-memory copy for the session.

import { parseTokenRecord, renewRecord, viewOf, type AuthView, type RenewReply, type TokenRecord } from "./market_token.ts";
import { vaultDelete, vaultGet, vaultPut } from "./vault_store.ts";

export const MARKET_AUTH_REF = "market:auth";
export const MARKET_RECEIPTS_REF = "market:receipts";
/** World package ids (`world-christmas`): a bounded charset, so a receipt key is never markup or a path. */
const RECEIPT_ID_RE = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const MAX_RECEIPTS = 500;

/** The held record (null when none, or the vault holds something that is not one). */
export function readMarketAuth(): TokenRecord | null {
  const raw = vaultGet(MARKET_AUTH_REF);
  if (!raw) return null;
  try { return parseTokenRecord(JSON.parse(raw)); } catch { return null; }
}

/** Hold `rec` (a lucid://auth sign-in, a migrated localStorage record, a renewal). Throws when the vault refuses. */
export function setMarketAuth(rec: TokenRecord): void {
  vaultPut({ ref: MARKET_AUTH_REF, value: JSON.stringify(rec), kind: "oauth", label: "LUCID store sign-in", source: "typed" });
}

/** Forget the sign-in (Sign out, or Google refused the refresh token). Receipts stay: they are the offline grace. */
export function clearMarketAuth(): void {
  vaultDelete(MARKET_AUTH_REF);
}

/** What the renderer may hold, or null when signed out. */
export function marketAuthView(): AuthView | null {
  const rec = readMarketAuth();
  return rec ? viewOf(rec) : null;
}

export interface RenewOptions { apiKey: string; skewMs?: number; force?: boolean; fetchImpl?: typeof fetch; now?: number }

let renewing: Promise<RenewReply> | null = null;

async function renewOnce(o: RenewOptions): Promise<RenewReply> {
  const rec = readMarketAuth();
  if (!rec) return { status: "signed-out", view: null };
  const r = await renewRecord(rec, { apiKey: o.apiKey, fetchImpl: o.fetchImpl ?? fetch, now: o.now ?? Date.now(), skewMs: o.skewMs, force: o.force });
  // A sign-in that landed while Google answered is newer than this renewal: leave it and report it.
  const current = readMarketAuth();
  if (current?.refreshToken !== rec.refreshToken || current?.idToken !== rec.idToken) {
    return current ? { status: "ok", view: viewOf(current) } : { status: "signed-out", view: null };
  }
  if (r.status === "signed-out") {
    try { clearMarketAuth(); } catch { /* an unreadable vault: the dead record is refused again next time */ }
    return { status: "signed-out", view: null };
  }
  if (r.status === "unavailable") return { status: "unavailable", view: viewOf(r.rec) };
  // A vault that refuses the renewed record leaves the held one, whose refresh token still renews next time.
  if (r.changed) try { setMarketAuth(r.rec); } catch { /* the session still gets the live token */ }
  return { status: "ok", view: viewOf(r.rec) };
}

/** Renew the held ID token when it is within the skew window. One renewal at a time: concurrent callers (several
 *  worlds checked at once, two windows) share it, so a rolled refresh token is never raced. */
export function renewMarketAuth(o: RenewOptions): Promise<RenewReply> {
  if (!renewing) renewing = renewOnce(o).finally(() => { renewing = null; });
  return renewing;
}

/** Every held receipt (`{ [worldId]: at }`); empty when none or unreadable. */
export function readReceipts(): Record<string, number> {
  const raw = vaultGet(MARKET_RECEIPTS_REF);
  if (!raw) return {};
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return {}; }
  const out: Record<string, number> = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [id, at] of Object.entries(v)) if (RECEIPT_ID_RE.test(id) && typeof at === "number" && Number.isFinite(at) && at > 0) out[id] = at;
  return out;
}

/** Merge receipt changes in one vault write: `set` stamps (a newer stamp wins), `drop` removes. Malformed ids and
 *  times are skipped; the oldest go first beyond MAX_RECEIPTS. Returns the count held. Throws when the vault refuses. */
export function writeReceipts(patch: { set?: Record<string, unknown>; drop?: readonly unknown[] }): number {
  const all = readReceipts();
  for (const [id, at] of Object.entries(patch.set ?? {})) {
    if (!RECEIPT_ID_RE.test(id) || typeof at !== "number" || !Number.isFinite(at) || at <= 0) continue;
    const prev = all[id];
    if (prev === undefined || prev < at) all[id] = at;
  }
  for (const id of patch.drop ?? []) if (typeof id === "string") delete all[id];
  const kept = Object.entries(all).sort((a, b) => b[1] - a[1]).slice(0, MAX_RECEIPTS);
  if (!kept.length) { vaultDelete(MARKET_RECEIPTS_REF); return 0; }
  vaultPut({ ref: MARKET_RECEIPTS_REF, value: JSON.stringify(Object.fromEntries(kept)), kind: "json", label: "LUCID store world receipts", source: "typed" });
  return kept.length;
}
