// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/market/entitlement.ts — P-KGMARKET.1 (ADR-0206): the pure, fail-closed entitlement decision.
//
// This is the SECURITY-relevant core of the pack paywall: given who is signed in and what entitlement the
// backend reports, decide what the user may do with a pack RIGHT NOW. It is the PAYMENT gate — one of three
// independent gates (payment = access, signature = origin, scanner = safety); it never substitutes for the
// P-KGPACK.4 import gate that still verifies + re-scans a pulled pack. Pure (no I/O, no fetch) so the
// decision is exhaustively testable; the Firebase/Stripe transport is a separate provider (P-KGMARKET.2).
//
// FAIL-CLOSED by construction: not signed in ⇒ `signin`; missing/expired/unknown entitlement ⇒ `checkout`;
// ONLY an active, unexpired entitlement ⇒ `pull`. Absence of information is never treated as ownership.

export type PackLicensing = "one-time" | "subscription";
export type EntitlementState = "active" | "expired" | "none";
export type PurchaseMethod = "card" | "gpc" | "po" | "subscription";

/** What the backend reports for (this user, this pack). `expiresAt` is set for subscriptions/seat licenses;
 *  a one-time purchase has none. All fields are advisory — the decision below re-checks expiry fail-closed. */
export interface Entitlement {
  packId: string;
  state: EntitlementState;
  method?: PurchaseMethod;
  expiresAt?: string;   // ISO; when present and in the past, the entitlement is treated as lapsed
}

export interface AuthState { signedIn: boolean; email?: string }

/** What the user may do with a pack now. `signin` = must authenticate; `checkout` = buy it; `pull` = owned,
 *  fetch it (then it STILL goes through the P-KGPACK.4 verify + re-scan on import). */
export type PackAction = "signin" | "checkout" | "pull";

/** True only for an active, unexpired entitlement. A lapsed subscription (expiresAt in the past) is NOT
 *  entitled even if the state field still says "active" (defense-in-depth against a stale/forged record). */
export function isEntitled(ent: Entitlement | null | undefined, nowIso: string): boolean {
  if (!ent || ent.state !== "active") return false;
  if (ent.expiresAt && ent.expiresAt <= nowIso) return false;
  return true;
}

/** The fail-closed decision. `nowIso` is injected so the rule is deterministic + testable. */
export function decidePackAction(auth: AuthState | null | undefined, ent: Entitlement | null | undefined, nowIso: string): PackAction {
  if (!auth?.signedIn) return "signin";
  return isEntitled(ent, nowIso) ? "pull" : "checkout";
}

/** A one-line, user-facing label for a row's primary action given the decision. Pure. */
export function packActionLabel(action: PackAction): string {
  return action === "pull" ? "Install" : action === "signin" ? "Sign in to buy" : "Get pack";
}
