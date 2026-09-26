// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// The model-picker cold-start warm-poll state machine (config_warm.ts). The load-bearing property is
// that a DELIBERATE load re-arms the retry budget: the fresh-macOS-install bug was a slow cold boot
// exhausting a lifetime counter so the post-OAuth refresh (cold omp again) never retried and the
// just-connected models never showed. That regression is pinned here.

import { describe, expect, it } from "bun:test";
import { CONFIG_WARM_MAX_TRIES, warmStep } from "./config_warm.ts";

describe("warmStep", () => {
  it("adopts and resets the budget when live models are present", () => {
    expect(warmStep(3, true, false)).toEqual({ action: "adopt", tries: 0 });
    expect(warmStep(0, true, true)).toEqual({ action: "adopt", tries: 0 });
    expect(warmStep(CONFIG_WARM_MAX_TRIES, true, false)).toEqual({ action: "adopt", tries: 0 });
  });

  it("re-polls while the per-cycle budget remains, counting up each pass", () => {
    let tries = 0;
    for (let i = 1; i <= CONFIG_WARM_MAX_TRIES; i++) {
      const r = warmStep(tries, false, i === 1); // first pass starts the cycle; rest are continuations
      expect(r.action).toBe("repoll");
      expect(r.tries).toBe(i);
      tries = r.tries;
    }
  });

  it("gives up once the budget is spent (wedged session -> stop the spinner)", () => {
    const r = warmStep(CONFIG_WARM_MAX_TRIES, false, false);
    expect(r.action).toBe("giveup");
    expect(r.tries).toBe(CONFIG_WARM_MAX_TRIES);
  });

  it("re-arms the budget on a new cycle AFTER a prior give-up (the post-OAuth path)", () => {
    // Cold boot burns the whole budget without omp ever getting ready (slow first macOS spawn).
    let tries = 0;
    let newCycle = true;
    for (let i = 0; i < CONFIG_WARM_MAX_TRIES; i++) {
      tries = warmStep(tries, false, newCycle).tries;
      newCycle = false; // subsequent passes are re-poll continuations
    }
    // Budget is spent: a continuation now gives up.
    expect(warmStep(tries, false, false)).toEqual({ action: "giveup", tries: CONFIG_WARM_MAX_TRIES });

    // OAuth connect kicks a NEW deliberate cycle. omp is still cold (no models yet) but we MUST retry,
    // not stay stuck on "giveup" as the old lifetime counter did.
    const reArmed = warmStep(tries, false, true);
    expect(reArmed.action).toBe("repoll");
    expect(reArmed.tries).toBe(1);

    // ...and once the respawned omp finally reports its models, we adopt.
    expect(warmStep(reArmed.tries, true, false)).toEqual({ action: "adopt", tries: 0 });
  });

  it("opening the picker while warming re-arms rather than compounding the count", () => {
    // A cycle in progress at tries=4...
    let tries = warmStep(3, false, false).tries;
    expect(tries).toBe(4);
    // ...the user opens the picker (deliberate) -> budget re-arms to a single fresh retry.
    expect(warmStep(tries, false, true)).toEqual({ action: "repoll", tries: 1 });
  });
});
