// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/enter_submit.test.ts - P-KGMARKET.5. The interesting assertions are the ones that prove
// Enter does NOTHING: `#setBody` is one delegated listener over the whole Settings panel, so a rule that
// guessed which button to press would let Enter in a provider API-key row fire an action the user never
// aimed at.

import { describe, expect, test } from "bun:test";
import { ENTER_SUBMIT, enterSubmitTarget } from "./enter_submit.ts";

/** A screen where every listed button is rendered. */
const all = (): ((id: string) => boolean) => () => true;
/** A screen where only these ids are rendered. */
const only = (...ids: string[]): ((id: string) => boolean) => (id) => ids.includes(id);

describe("enterSubmitTarget", () => {
  test("an unconfigured store submits Create; a locked store submits Unlock", () => {
    expect(enterSubmitTarget("personalPass", only("personalSetup"))).toBe("personalSetup");
    expect(enterSubmitTarget("personalPass", only("personalUnlock"))).toBe("personalUnlock");
    expect(enterSubmitTarget("cuiPass", only("cuiSetup"))).toBe("cuiSetup");
    expect(enterSubmitTarget("cuiPass", only("cuiUnlock"))).toBe("cuiUnlock");
  });

  test("preference order decides if both are somehow on screen", () => {
    // Not a state the markup produces, but the resolver must be deterministic rather than incidental.
    expect(enterSubmitTarget("personalPass", all())).toBe("personalSetup");
    expect(enterSubmitTarget("cuiPass", all())).toBe("cuiSetup");
  });

  test("THE REFUSAL: an input that is not on the allowlist is inert", () => {
    // These are real ids elsewhere in #setBody. Enter in any of them must not press anything.
    for (const id of ["provKey", "prov-key", "apiKey", "kgSearch", "personalPassword", "pass"]) {
      expect(enterSubmitTarget(id, all())).toBeNull();
    }
  });

  test("a listed field whose buttons are absent is inert, not a fallback", () => {
    expect(enterSubmitTarget("personalPass", only("cuiUnlock"))).toBeNull();
    expect(enterSubmitTarget("personalPass", () => false)).toBeNull();
  });

  test("an input with no id is inert", () => {
    expect(enterSubmitTarget("", all())).toBeNull();
  });

  test("a throwing presence probe is treated as absent, never as a crash", () => {
    expect(enterSubmitTarget("personalPass", () => { throw new Error("detached"); })).toBeNull();
  });

  test("a truthy non-boolean probe result does not authorize a click", () => {
    const sloppy = ((id: string) => (id === "personalUnlock" ? "yes" : false)) as unknown as (id: string) => boolean;
    expect(enterSubmitTarget("personalPass", sloppy)).toBeNull();
  });

  test("the table stays an allowlist of PASSPHRASE fields only", () => {
    // A future edit that adds a destructive button here would give Enter a way to fire it. Pin the shape.
    expect(Object.keys(ENTER_SUBMIT).toSorted()).toEqual(["cuiPass", "personalPass"]);
    for (const ids of Object.values(ENTER_SUBMIT)) {
      expect(ids.length).toBe(2);
      for (const id of ids) expect(id).toMatch(/(Setup|Unlock)$/);
    }
  });
});
