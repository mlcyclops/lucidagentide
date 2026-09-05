// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/pack_cta.ts - P-KGMARKET.5 (ADR-0333): the Role KG Packs call to action, and the
// sign-in round trip a purchase has to SURVIVE.
//
// Two defects, one module, because they are the same defect at two points of the same funnel.
//
// 1. DISCOVERY. The storefront existed and nothing pointed at it. Reaching it meant knowing to type
//    "Browse Role KG Packs" into the command palette, so the only commercial surface in the product was
//    the one surface with no button. The KG header is where it belongs: a user looking at their knowledge
//    graph is exactly the user who wants more of it.
//
// 2. THE ROUND TRIP. Clicking "Get pack" while signed out opened the browser and then told the user to
//    "click the pack again". That is the checkout asking the user to remember the checkout. Worse, the
//    toast never said WHY an account was needed, so the request read as a data grab rather than as the
//    licence lookup it is.
//
// The interesting constraint is that `lucid://auth` is SHARED. The same deep link finishes a LUCID Remote
// sign-in and a Google Drive authorisation. So "resume the purchase on sign-in" must not mean "any future
// sign-in, forever, starts a Stripe checkout for a pack somebody once clicked". Hence the expiry below: a
// pending checkout is a short-lived statement of intent, not a standing order.

import { icon } from "./icons.ts";

/** The header button's hover tip (`title|body`, the shared data-tip format). Kept here rather than inline
 *  in app.ts so the button's copy is testable and cannot drift from the storefront it opens. */
export const PACKS_TIP =
  "Role KG Packs|Curated, signed knowledge graphs for a role: import one and the agent answers from it. "
  + "Every pack is verified for origin and re-scanned before anything installs.";

/** The KG-header button. `kg-packs` carries the glow (styles.css); the label is deliberately one short word
 *  so invariant 11 holds even when the KG panel is dragged narrow. */
export function kgPacksBtnHtml(): string {
  return `<button class="btn-mini kg-packs" id="kgPacks" data-tip="${PACKS_TIP}">${icon("market", 13)} Packs</button>`;
}

/** What the user was buying when they were sent to the browser to sign in. */
export interface PendingCheckout {
  packId: string;
  packName: string;
  /** `Date.now()` at the moment the browser was opened. */
  startedAt: number;
}

/** How long a click stays a pending purchase. Long enough for a real sign-in with a password manager and a
 *  second factor; far too short to still be pending the next time the user authorises Google Drive. */
export const PENDING_CHECKOUT_MAX_AGE_MS = 15 * 60_000;

/** May this pending checkout be resumed by the sign-in that just landed?
 *
 *  Every refusal here is a way an auto-resume could be worse than the bug it fixes, because the deep link
 *  is shared with LUCID Remote and Drive: a stale intent would open a payment page nobody asked for. */
export function shouldResumeCheckout(p: PendingCheckout | null | undefined, now: number): boolean {
  if (!p) return false;
  if (!p.packId.trim()) return false; // no pack id, nothing to resume into
  const started = Number(p.startedAt);
  const at = Number(now);
  if (!Number.isFinite(started) || !Number.isFinite(at)) return false;
  const age = at - started;
  if (age < 0) return false; // a clock that moved backwards is not evidence of intent
  return age <= PENDING_CHECKOUT_MAX_AGE_MS;
}

/** Where the user is in the sign-in round trip.
 *  - `pending`: the browser is open and we are holding their place.
 *  - `resumed`: the deep link came back in time and we are finishing the job.
 *  - `blocked`: sign-in could not start at all (unconfigured build, no sign-in URL). */
export type PackSignInState = "pending" | "resumed" | "blocked";

/** The sentence that was missing. An account is not a gate for its own sake: it is where the licence lives,
 *  which is also the answer to "why should I sign in to buy a file". */
export const LICENCE_RATIONALE =
  "Your account holds the pack licence, so it installs on every machine you sign in to.";

/** Context-aware toast copy for each point in the round trip. Names the PACK, because "Sign in" with no
 *  object is what made the old prompt read like an unrelated account wall. */
export function packSignInCopy(state: PackSignInState, packName: string, reason?: string): { title: string; desc: string } {
  const name = packName.trim() || "this pack";
  if (state === "pending") {
    return {
      title: `Finish signing in for ${name}`,
      desc: `${LICENCE_RATIONALE} Come back when you are done and this picks up on its own, no need to find the row again.`,
    };
  }
  if (state === "resumed") {
    return { title: `Signed in, picking up ${name}`, desc: "Resuming right where you left off." };
  }
  const why = reason?.trim();
  return {
    title: `Sign in to get ${name}`,
    desc: why ? `${LICENCE_RATIONALE} Sign-in is unavailable in this build: ${why}.` : LICENCE_RATIONALE,
  };
}
