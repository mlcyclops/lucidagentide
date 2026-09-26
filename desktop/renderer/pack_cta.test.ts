// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/pack_cta.test.ts - P-KGMARKET.5. Weighted toward the REFUSALS, because the failure mode
// of an auto-resume is worse than the bug it fixes: `lucid://auth` is shared with LUCID Remote sign-in and
// Google Drive authorisation, so a resume that fires on the wrong callback opens a payment page nobody
// asked for.

import { describe, expect, test } from "bun:test";
import {
  LICENCE_RATIONALE, PACKS_TIP, PENDING_CHECKOUT_MAX_AGE_MS,
  kgPacksBtnHtml, packSignInCopy, shouldResumeCheckout, type PendingCheckout,
} from "./pack_cta.ts";

const pend = (over: Partial<PendingCheckout> = {}): PendingCheckout =>
  ({ packId: "backend-engineer", packName: "Backend Engineer", startedAt: 1_000_000, ...over });

describe("kgPacksBtnHtml", () => {
  test("carries the id app.ts wires, the glow class, and a ONE-WORD label", () => {
    const html = kgPacksBtnHtml();
    expect(html).toContain(`id="kgPacks"`);
    expect(html).toContain("btn-mini kg-packs");
    // Invariant 11: this button sits in a flex header inside an overflow:hidden panel that the user can
    // drag narrow. A two-word label is the thing that starts wrapping first.
    const label = /<\/svg>\s*([^<]*)</.exec(html)?.[1]?.trim() ?? "";
    expect(label).toBe("Packs");
    expect(label.split(/\s+/)).toHaveLength(1);
  });

  test("the tip is a title|body pair and explains the verification, not just the price", () => {
    expect(PACKS_TIP.split("|")).toHaveLength(2);
    expect(PACKS_TIP).toContain("re-scanned");
  });

  test("no double quote can break out of the data-tip attribute", () => {
    expect(PACKS_TIP).not.toContain('"');
    expect(kgPacksBtnHtml()).toContain(`data-tip="${PACKS_TIP}"`);
  });
});

describe("shouldResumeCheckout", () => {
  test("a fresh pending purchase resumes", () => {
    expect(shouldResumeCheckout(pend(), 1_000_000 + 30_000)).toBe(true);
  });

  test("nothing pending never resumes", () => {
    expect(shouldResumeCheckout(null, 1_000_000)).toBe(false);
    expect(shouldResumeCheckout(undefined, 1_000_000)).toBe(false);
  });

  test("THE REFUSAL: a stale intent must not turn an unrelated sign-in into a checkout", () => {
    // The user clicked a pack this morning, abandoned it, and this afternoon authorises Google Drive.
    // That callback must not resume a purchase.
    expect(shouldResumeCheckout(pend(), 1_000_000 + PENDING_CHECKOUT_MAX_AGE_MS + 1)).toBe(false);
    expect(shouldResumeCheckout(pend(), 1_000_000 + 86_400_000)).toBe(false);
  });

  test("the boundary is inclusive, so a slow but honest sign-in still lands", () => {
    expect(shouldResumeCheckout(pend(), 1_000_000 + PENDING_CHECKOUT_MAX_AGE_MS)).toBe(true);
  });

  test("a clock that moved backwards is not evidence of intent", () => {
    expect(shouldResumeCheckout(pend(), 999_999)).toBe(false);
  });

  test("garbage timestamps refuse rather than resolving to now", () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(shouldResumeCheckout(pend({ startedAt: bad }), 1_000_000)).toBe(false);
      expect(shouldResumeCheckout(pend(), bad)).toBe(false);
    }
  });

  test("a pending record with no pack id has nothing to resume into", () => {
    expect(shouldResumeCheckout(pend({ packId: "" }), 1_000_000 + 1_000)).toBe(false);
    expect(shouldResumeCheckout(pend({ packId: "   " }), 1_000_000 + 1_000)).toBe(false);
  });
});

describe("packSignInCopy", () => {
  test("every state names the pack, because 'Sign in' with no object reads as an account wall", () => {
    for (const state of ["pending", "resumed", "blocked"] as const) {
      const c = packSignInCopy(state, "Backend Engineer");
      expect(c.title).toContain("Backend Engineer");
      expect(c.title.length).toBeGreaterThan(0);
      expect(c.desc.length).toBeGreaterThan(0);
    }
  });

  test("pending promises the resume instead of asking for a second click", () => {
    const c = packSignInCopy("pending", "Backend Engineer");
    expect(c.desc).toContain(LICENCE_RATIONALE);
    expect(c.desc).toContain("picks up on its own");
    // The exact instruction this increment removes. It must not survive anywhere in the copy.
    expect(c.desc).not.toContain("click the pack again");
  });

  test("blocked explains WHY an account is needed even when sign-in cannot start", () => {
    const c = packSignInCopy("blocked", "Backend Engineer", "no sign-in URL configured");
    expect(c.desc).toContain(LICENCE_RATIONALE);
    expect(c.desc).toContain("no sign-in URL configured");
  });

  test("blocked with no reason still carries the rationale and invents no detail", () => {
    const c = packSignInCopy("blocked", "Backend Engineer");
    expect(c.desc).toBe(LICENCE_RATIONALE);
    expect(c.desc).not.toContain("unavailable");
    expect(packSignInCopy("blocked", "Backend Engineer", "   ").desc).toBe(LICENCE_RATIONALE);
  });

  test("a missing pack name degrades to a phrase that still reads, never to an empty gap", () => {
    for (const name of ["", "   "]) {
      const c = packSignInCopy("pending", name);
      expect(c.title).toBe("Finish signing in for this pack");
      expect(c.title).not.toContain("  ");
    }
  });

  test("no em dashes anywhere in the user-facing copy", () => {
    const all = [PACKS_TIP, LICENCE_RATIONALE, kgPacksBtnHtml()];
    for (const state of ["pending", "resumed", "blocked"] as const) {
      const c = packSignInCopy(state, "Backend Engineer", "some reason");
      all.push(c.title, c.desc);
    }
    for (const s of all) expect(s).not.toContain("\u2014");
  });
});
