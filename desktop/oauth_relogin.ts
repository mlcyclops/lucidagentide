// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/oauth_relogin.ts - P-AUTH.RELOGIN1 (ADR-0640): notice a sign-in that USED to work and no longer does.
//
// A subscription login (Claude, ChatGPT, Gemini, ...) lives in omp's vault as an `auth_credentials` row. Two
// things take it away without the user asking:
//   - omp's refresher hits a DEFINITIVE refresh failure (invalid_grant, revoked, 401) and soft-disables the
//     row with a cause like "auth-broker refresh failed: ..." (vendor ai/src/auth-broker/refresher.ts). The
//     provider's models then drop out of the picker "after a while", with no message anywhere.
//   - the row is gone entirely (a provider-side app upgrade that revokes old grants, a vault reset). Nothing
//     in the vault says it was ever there, so LUCID keeps its own memory: every provider it has SEEN signed in.
//
// A deliberate sign-out is never a re-login prompt: LUCID's own Disconnect / Sign out forget the provider, omp's
// `logout` leaves "deleted by user", and an account switch parks rows under LUCID_INACTIVE_CAUSE.
//
// The model the user was on when the provider went away is remembered as `displaced`, so signing back in can
// put them back on it instead of leaving the composer on whatever the fallback picked (the "stuck on Terra
// 6.1 after I signed back into Claude" report).

import { LUCID_INACTIVE_CAUSE } from "./account_policy.ts";
import type { ProviderAuthSnapshot, VaultRow } from "./auth_status.ts";

/** The vault columns the re-login check reads. */
export type VaultRowLite = Pick<VaultRow, "provider" | "credential_type" | "disabled_cause">;

/** What LUCID remembers across launches (settings_store `oauthMemory`). */
export interface OauthMemory {
  /** oauthIds LUCID has seen with an active OAuth credential. */
  seen: string[];
  /** oauthId -> the model the user was on when that provider's sign-in was lost. */
  displaced: Record<string, string>;
}

export type ReloginReason = "expired" | "missing";
export interface ReloginNeed { reason: ReloginReason; detail?: string }

export const EMPTY_OAUTH_MEMORY: OauthMemory = { seen: [], displaced: {} };

// omp's isDefinitiveOAuthFailure vocabulary plus the two cause prefixes it writes on a failed refresh.
const FAILURE_CAUSE_RE = /refresh failed|invalid_grant|invalid_token|revoked|unauthori[sz]ed|expired/i;
// Causes that mean the user (or LUCID on the user's behalf) took the login away on purpose.
const INTENTIONAL_CAUSE_RE = /deleted by user|logged out|logout/i;

const isIntentional = (cause: string): boolean => cause === LUCID_INACTIVE_CAUSE || INTENTIONAL_CAUSE_RE.test(cause);

/** The omp provider prefix of a model id (`anthropic/claude-opus-5-5` -> `anthropic`). OAuth providers file
 *  their models under the same id their credential uses, so this is the oauthId for a subscription model. */
export function modelProvider(model: string): string {
  const i = model.indexOf("/");
  return i > 0 ? model.slice(0, i) : "";
}

/** Does `oauthId` need the user to sign in again? Undefined when it is signed in, was signed out on purpose,
 *  or was never signed in here. */
export function reloginNeed(oauthId: string, rows: readonly VaultRowLite[], memory: OauthMemory): ReloginNeed | undefined {
  if (!oauthId) return undefined;
  const mine = rows.filter((r) => r.provider === oauthId && r.credential_type === "oauth");
  if (mine.some((r) => !r.disabled_cause)) return undefined; // signed in
  const causes = mine.map((r) => r.disabled_cause!).filter(Boolean);
  if (causes.some(isIntentional)) return undefined; // logged out, deleted, or parked behind another account
  const failed = causes.find((c) => FAILURE_CAUSE_RE.test(c));
  if (failed) return { reason: "expired", detail: failed.slice(0, 240) };
  if (memory.seen.includes(oauthId)) return { reason: "missing" };
  return undefined;
}

/**
 * The memory after observing the vault once. A provider signed in now is remembered as seen; a provider that
 * was taken away on purpose is forgotten; a provider that newly needs a re-login records the model the user is
 * on (`current`, first of chosen / last) as displaced, if that model runs on it and nothing is recorded yet.
 * Returns the SAME object when nothing changed, so the caller can skip the settings write.
 */
export function observeOauth(auth: ProviderAuthSnapshot, rows: readonly VaultRowLite[], memory: OauthMemory, current: readonly string[]): OauthMemory {
  const seen = new Set(memory.seen);
  const displaced = { ...memory.displaced };
  let changed = false;
  for (const p of [...auth.gateway, ...auth.majors, ...auth.others]) {
    const id = p.oauthId;
    if (!p.canOauth || !id) continue;
    const mine = rows.filter((r) => r.provider === id && r.credential_type === "oauth");
    if (mine.some((r) => !r.disabled_cause)) {
      if (!seen.has(id)) { seen.add(id); changed = true; }
      continue;
    }
    if (mine.some((r) => r.disabled_cause && isIntentional(r.disabled_cause))) {
      if (seen.delete(id)) changed = true;
      if (id in displaced) { delete displaced[id]; changed = true; }
      continue;
    }
    if (reloginNeed(id, rows, memory) && !(id in displaced)) {
      const model = current.find((m) => m && modelProvider(m) === id);
      if (model) { displaced[id] = model; changed = true; }
    }
  }
  return changed ? { seen: [...seen].sort(), displaced } : memory;
}

/** Forget a provider the user signed out of on purpose (LUCID's Disconnect, Sign out of all, account removal). */
export function forgetOauth(memory: OauthMemory, oauthIds: readonly string[]): OauthMemory {
  const drop = new Set(oauthIds);
  if (!memory.seen.some((id) => drop.has(id)) && !Object.keys(memory.displaced).some((id) => drop.has(id))) return memory;
  return {
    seen: memory.seen.filter((id) => !drop.has(id)),
    displaced: Object.fromEntries(Object.entries(memory.displaced).filter(([id]) => !drop.has(id))),
  };
}

/** The memory after the renderer restored (or declined) the displaced model for `oauthId`. */
export function clearDisplaced(memory: OauthMemory, oauthId: string): OauthMemory {
  if (!(oauthId in memory.displaced)) return memory;
  const displaced = { ...memory.displaced };
  delete displaced[oauthId];
  return { ...memory, displaced };
}

/** Stamp each OAuth row with `relogin` (needs a sign-in) or `restoreModel` (signed back in, with a model to
 *  go back to). Mutates and returns `auth`. */
export function annotateRelogin(auth: ProviderAuthSnapshot, rows: readonly VaultRowLite[], memory: OauthMemory): ProviderAuthSnapshot {
  for (const p of [...auth.gateway, ...auth.majors, ...auth.others]) {
    if (!p.canOauth || !p.oauthId) continue;
    const need = p.oauthActive ? undefined : reloginNeed(p.oauthId, rows, memory);
    if (need) p.relogin = need;
    const restore = memory.displaced[p.oauthId];
    if (restore) p.restoreModel = restore;
  }
  return auth;
}
