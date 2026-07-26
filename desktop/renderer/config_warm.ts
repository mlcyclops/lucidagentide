// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/config_warm.ts: the model-picker cold-start warm-poll decision (pure).
//
// The live model config lags omp's session warm-up. On a fresh install the FIRST omp spawn is the
// slowest it will ever be (macOS Gatekeeper first-run scan of the notarized bundle + every embedded
// binary, first bun resolution, the ACP handshake, session/new), and again right after an OAuth
// connect the broker respawns omp COLD. getConfig() caps its wait and returns whatever it has, so the
// renderer re-polls loadConfig() until the live list lands, then STOPS after a bounded budget so a
// wedged session doesn't spin "updating..." forever.
//
// The load-bearing rule: the retry budget is PER WARM CYCLE, not per process. A "deliberate" load
// (boot, OAuth connect, provider-key change, opening the picker while it's still warming, manual
// refresh) RE-ARMS the budget; only the internal re-poll continuation spends it. Before this module
// the budget was a lifetime counter reset only on success, so a slow cold boot that exhausted it left
// every LATER load unable to retry. Crucially the post-OAuth refresh runs against a freshly-respawned
// (cold) omp: it saw an empty list, found the budget already spent, scheduled no retry, and the
// just-connected provider's models never appeared until a manual "Refresh models". Keeping this a
// pure, DOM-free state machine lets the re-arm behavior be unit-tested here; app.ts owns the timer,
// the bridge call, and the picker render.

/** Empty-config polls to attempt PER WARM CYCLE before giving up (session likely wedged). */
export const CONFIG_WARM_MAX_TRIES = 6;
/** Delay between re-polls within a cycle (ms). */
export const CONFIG_WARM_POLL_MS = 1500;

export type WarmAction =
  | "adopt" // live models present -> adopt the live config, budget reset to 0
  | "repoll" // still warming, budget remains -> schedule another poll
  | "giveup"; // budget spent -> stop the spinner, keep whatever list we have

export interface WarmResult {
  action: WarmAction;
  /** The tries counter to carry forward into the next pass of THIS cycle. */
  tries: number;
}

/**
 * Decide what one loadConfig() pass should do.
 *
 * @param tries         retries already spent in the current cycle.
 * @param hasLiveModels omp returned a config whose `model` option actually has choices.
 * @param newCycle      this is a deliberate load (RE-ARM the budget), not a re-poll continuation.
 * @param maxTries      per-cycle retry budget (injected for tests).
 */
export function warmStep(
  tries: number,
  hasLiveModels: boolean,
  newCycle: boolean,
  maxTries = CONFIG_WARM_MAX_TRIES,
): WarmResult {
  const spent = newCycle ? 0 : tries; // a new cycle re-arms the budget
  if (hasLiveModels) return { action: "adopt", tries: 0 };
  if (spent < maxTries) return { action: "repoll", tries: spent + 1 };
  return { action: "giveup", tries: spent };
}
